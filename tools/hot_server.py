#!/usr/bin/env python3
"""HOT (online) machine: a local web page in front of the hot scripts.

    python3 tools/hot_server.py [--dir .] [--port 8765] [--node node] [--dist DIR]

Start it in the terminal where you normally run the hot scripts, with the same environment (MIDNIGHT_NETWORK,
BLOCKFROST_PROJECT_ID, SPONSOR_MNEMONIC and so on, set with `read -rs`). Open the URL it prints: it carries a
one-time token after the #. The page receives cold-public.json and tx.hex from the cold machine (camera, dropped
file or paste), shows the snapshot as QR codes, and submits after you type SUBMIT.

All the Midnight work is done by the existing scripts in dist/ (hot-watch, sponsor-sync, sponsor-submit,
hot-inspect), started with fixed arguments in --dir. sponsor-sync can be started early, so that step 4 only catches
up. The scripts inherit this process's environment and read the secrets themselves, as
they do from a terminal. This server only checks WHETHER the sponsor secret and the Blockfrost token are set; it
never copies, logs or sends them, and no request can change a script's arguments or environment.

Only 127.0.0.1 can connect. Every API call needs the token, and requests whose Host or Origin is not this server
are refused, so other web pages open in the same browser cannot drive it.
"""
import argparse
import codecs
import hashlib
import http.server
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
NETWORKS = ("undeployed", "preview", "preprod", "mainnet")

PUBLIC = "cold-public.json"
SNAPSHOT = "cold-unshielded.snapshot.json"
TX = "tx.hex"
FILES = (PUBLIC, SNAPSHOT, TX)

MAX_REQUEST = 64_000  # cold-public.json and tx.hex are a few kilobytes
MAX_SNAPSHOT = 4 * 1024 * 1024  # the same limit the QR tools use
MAX_LOG = 2_000_000
PROMPT = "Type SUBMIT to continue:"  # the end of sponsor-submit's question

STATE_RE = re.compile(r"wallet-state-(mn_addr_[a-z]+1[02-9ac-hj-np-z]{20,120})\.json")  # a sponsor's saved sync state
ADDRESS_RE = re.compile(r"mn_addr(_[a-z]+)?1[02-9ac-hj-np-z]{20,120}")
HEX_RE = re.compile(r"(?:[0-9a-f]{2})+")
KEY_HEX_RE = re.compile(r"[0-9a-f]{64}")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")  # keeps tab and newline; drops the terminal bell


class Refuse(Exception):
    """A request we will not carry out; the message is shown on the page."""


def address_prefix(network):
    return "mn_addr1" if network == "mainnet" else "mn_addr_%s1" % network


def check_cold_public(text, network):
    """Accept only the file cold-export-public and the cold page write, for this network. Returns the text to save."""
    try:
        d = json.loads(text)
    except ValueError:
        raise Refuse("This is not JSON, so it is not a cold-public.json.")
    if not isinstance(d, dict) or set(d) != {"sdk", "network", "address", "publicKey"}:
        raise Refuse("This is not a cold-public.json (expected exactly: sdk, network, address, publicKey).")
    if d["sdk"] != 2:
        raise Refuse('This cold-public.json is not for wallet SDK 2 (no "sdk": 2). Export it again on the cold machine.')
    if d["network"] != network:
        raise Refuse('This cold-public.json is for network "%s", but this server runs on "%s".' % (d["network"], network))
    pk = d["publicKey"]
    if not isinstance(pk, dict) or set(pk) != {"publicKey", "addressHex", "address"}:
        raise Refuse("This is not a cold-public.json (publicKey must hold publicKey, addressHex and address).")
    address = d["address"]
    if not isinstance(address, str) or not ADDRESS_RE.fullmatch(address) or not address.startswith(address_prefix(network)):
        raise Refuse("The address in it is not an unshielded %s address." % network)
    if pk["address"] != address:
        raise Refuse("The two addresses in it differ.")
    key = pk["publicKey"]  # the ledger's verifying key: {"tag": "schnorr", "value": 64 hex}
    if (not isinstance(key, dict) or set(key) != {"tag", "value"} or key["tag"] != "schnorr"
            or not isinstance(key["value"], str) or not KEY_HEX_RE.fullmatch(key["value"])):
        raise Refuse("The public key in it is not a schnorr key of 64 hex characters.")
    if not isinstance(pk["addressHex"], str) or not KEY_HEX_RE.fullmatch(pk["addressHex"]):
        raise Refuse("addressHex in it is not 64 hex characters.")
    # Written back in the cold side's own layout, so the file is the same whichever way it arrived.
    return json.dumps({"sdk": 2, "network": network, "address": address,
                       "publicKey": {"publicKey": {"tag": "schnorr", "value": key["value"]},
                                     "addressHex": pk["addressHex"], "address": address}},
                      indent=2)


def check_tx_hex(text):
    """Only a plain hex string is accepted. Saved exactly as received, so its SHA-256 matches the sender's."""
    body = text[:-1] if text.endswith("\n") else text
    if not HEX_RE.fullmatch(body):
        raise Refuse("This is not a tx.hex: it must be one line of lowercase hex.")
    return text


def clean(text):
    return CONTROL_RE.sub("", ANSI_RE.sub("", text.replace("\r\n", "\n").replace("\r", "\n")))


class Job:
    """One running script. Its output is collected by a thread; its standard input is how SUBMIT is typed."""

    def __init__(self, kind, argv, cwd, env, extra=None):
        self.kind = kind
        self.extra = extra or {}
        self.lock = threading.Lock()
        self.log = ""
        self.dropped = 0  # characters removed from the front of a very long log
        self.answered = None  # None, "SUBMIT" or "cancel"
        self.proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, bufsize=0)
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            chunk = os.read(self.proc.stdout.fileno(), 4096)
            if not chunk:
                break
            text = clean(decoder.decode(chunk))
            with self.lock:
                self.log += text
                if len(self.log) > MAX_LOG:
                    cut = len(self.log) - MAX_LOG
                    self.log = self.log[cut:]
                    self.dropped += cut
        self.proc.wait()

    def running(self):
        return self.proc.poll() is None

    def at_prompt(self):
        with self.lock:
            return self.running() and self.answered is None and self.log[-200:].rstrip().endswith(PROMPT)

    def answer(self, line, label):
        with self.lock:
            if self.answered is not None:
                raise Refuse("This question was already answered.")
            self.answered = label
        try:
            self.proc.stdin.write(line.encode())
            self.proc.stdin.close()
        except OSError:
            raise Refuse("The script has already ended.")

    def view(self, since=0):
        prompt = self.at_prompt()
        with self.lock:
            start = max(0, since - self.dropped)
            return {"kind": self.kind, "running": self.running(), "rc": self.proc.poll(), "prompt": prompt,
                    "answered": self.answered, "log": self.log[start:], "next": self.dropped + len(self.log),
                    "dryRun": bool(self.extra.get("dryRun")), "txSha": self.extra.get("txSha")}

    def stop(self):
        if self.running():
            self.proc.terminate()


class Hot:
    def __init__(self, directory, network, node="node", dist=None):
        self.dir = os.path.abspath(directory)
        self.network = network
        self.node = node
        self.dist = dist or os.path.join(REPO, "dist")
        self.job = None
        self.lock = threading.Lock()
        # The scripts get this process's environment unchanged, apart from settings that would make them disagree
        # with this server about the network or the file names.
        self.env = dict(os.environ, MIDNIGHT_NETWORK=network)
        for name in ("COLD_PUBLIC_FILE", "SNAPSHOT_FILE", "npm_config_dry_run"):
            self.env.pop(name, None)

    def path(self, name):
        return os.path.join(self.dir, name)

    def script(self, name):
        return os.path.join(self.dist, name + ".js")

    def busy(self):
        return self.job is not None and self.job.running()

    def file_info(self, name):
        p = self.path(name)
        if not os.path.isfile(p):
            return None
        st = os.stat(p)
        return {"size": st.st_size, "mtime": int(st.st_mtime)}

    def sponsor_states(self):
        """The saved wallet states in the folder: address (public, from the file name) and age only. Never opened."""
        out = []
        for n in sorted(os.listdir(self.dir)):
            m = STATE_RE.fullmatch(n)
            if m and os.path.isfile(self.path(n)):
                out.append({"address": m.group(1), "mtime": int(os.stat(self.path(n)).st_mtime)})
        return out

    def sha_of(self, name):
        with open(self.path(name), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    # ------------------------------------------------------------------ API

    def state(self, _body):
        set_ = lambda *names: any(os.environ.get(n, "") != "" for n in names)  # noqa: E731  (is it set; never its value)
        return {
            "network": self.network,
            "dir": self.dir,
            "files": {n: self.file_info(n) for n in FILES},
            "env": {
                "sponsorSecret": set_("SPONSOR_MNEMONIC", "SPONSOR_SEED"),
                "blockfrost": set_("BLOCKFROST_PROJECT_ID"),
                "needsBlockfrost": self.network in ("preprod", "mainnet"),
                "proofServerSet": set_("PROOF_SERVER_URL"),
                "allowMainnet": os.environ.get("ALLOW_MAINNET") == "1",
            },
            "sponsorStates": self.sponsor_states(),
            "built": all(os.path.isfile(self.script(s)) for s in ("hot-watch", "sponsor-submit", "hot-inspect", "sponsor-sync")),
            "job": self.job.view(1 << 60) if self.job else None,  # status only; the log comes from /api/job
        }

    def inspect(self, _body):
        """What the three files hold, read by dist/hot-inspect.js (no sync, no network, no secret)."""
        try:
            r = subprocess.run([self.node, self.script("hot-inspect"), PUBLIC, SNAPSHOT, TX], cwd=self.dir, env=self.env,
                               capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            raise Refuse("Could not start %s. Is Node installed and on the PATH?" % self.node)
        if r.returncode != 0:
            msg = clean(r.stderr or r.stdout).strip().splitlines()
            raise Refuse("hot-inspect failed: %s" % (msg[-1] if msg else "no output"))
        try:
            return json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise Refuse("hot-inspect printed something unexpected.")

    def put(self, body):
        name, text = body.get("name"), body.get("text")
        if not isinstance(text, str) or len(text) > MAX_REQUEST:
            raise Refuse("Missing or oversized content.")
        if self.busy():
            raise Refuse("A script is running. Wait for it to finish before replacing a file.")
        if name == PUBLIC:
            out = check_cold_public(text, self.network)
        elif name == TX:
            out = check_tx_hex(text)
        else:
            raise Refuse("Only cold-public.json and tx.hex can be sent to this server.")
        tmp = self.path(name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(out)
        os.replace(tmp, self.path(name))
        return {"saved": name, "sha": hashlib.sha256(out.encode()).hexdigest()[:16]}

    def get(self, body):
        name = body.get("name")
        if name not in FILES:
            raise Refuse("Unknown file.")
        p = self.path(name)
        if not os.path.isfile(p):
            raise Refuse("%s is not in %s yet." % (name, self.dir))
        if os.path.getsize(p) > MAX_SNAPSHOT:
            raise Refuse("%s is larger than 4 MB." % name)
        with open(p, "rb") as f:
            data = f.read()
        try:
            return {"name": name, "text": data.decode("utf-8"), "sha": hashlib.sha256(data).hexdigest()[:16]}
        except UnicodeDecodeError:
            raise Refuse("%s is not text." % name)

    def run(self, body):
        kind = body.get("job")
        with self.lock:
            if self.busy():
                raise Refuse("A script is already running (%s). Wait for it or cancel it." % self.job.kind)
            if kind == "watch":
                if not os.path.isfile(self.path(PUBLIC)):
                    raise Refuse("cold-public.json is missing: receive it from the cold machine first.")
                argv, extra = [self.node, self.script("hot-watch"), PUBLIC, SNAPSHOT], {}
            elif kind == "submit":
                if not os.path.isfile(self.path(TX)):
                    raise Refuse("tx.hex is missing: receive it from the cold machine first.")
                dry = body.get("dryRun") is True
                argv = [self.node, self.script("sponsor-submit"), TX] + (["--dry-run"] if dry else [])
                extra = {"dryRun": dry, "txSha": self.sha_of(TX)}
            elif kind == "sync":
                # Only syncs the sponsor and saves its state, so that step 4 later only catches up. Reads the sponsor
                # secret itself, from the environment it inherits, like sponsor-submit.
                if not any(os.environ.get(n, "") != "" for n in ("SPONSOR_MNEMONIC", "SPONSOR_SEED")):
                    raise Refuse("SPONSOR_MNEMONIC is not set in the server's terminal: stop the server, set it with read -rs, export it, start again.")
                argv, extra = [self.node, self.script("sponsor-sync")], {}
            else:
                raise Refuse("Unknown script.")
            if not os.path.isfile(argv[1]):
                raise Refuse("%s is missing: run `npm run build` first." % os.path.relpath(argv[1], REPO))
            try:
                self.job = Job(kind, argv, self.dir, self.env, extra)
            except FileNotFoundError:
                raise Refuse("Could not start %s. Is Node installed and on the PATH?" % self.node)
            return self.job.view()

    def job_view(self, body):
        since = body.get("since", 0)
        if not isinstance(since, int) or since < 0:
            raise Refuse("Bad request.")
        return {"job": self.job.view(since) if self.job else None}

    def confirm(self, body):
        job = self.job
        if job is None or job.kind != "submit" or not job.at_prompt():
            raise Refuse("sponsor-submit is not waiting for a confirmation.")
        if body.get("confirm") != "SUBMIT":
            raise Refuse("Type SUBMIT to confirm.")
        # The script read tx.hex when it started. The page must be confirming those bytes, not a file that arrived later.
        if body.get("txSha") != job.extra.get("txSha"):
            raise Refuse("The page is not showing the tx.hex this run started with. Cancel and start again.")
        job.answer("SUBMIT\n", "SUBMIT")
        return {"ok": True}

    def cancel(self, _body):
        job = self.job
        if job is None or not job.running():
            raise Refuse("No script is running.")
        if job.answered == "SUBMIT":
            raise Refuse("SUBMIT was already given: the transfer is being balanced and submitted. Let it finish.")
        if job.at_prompt():
            job.answer("\n", "cancel")  # sponsor-submit prints "Cancelled" and stops its wallet cleanly
        else:
            job.stop()
        return {"ok": True}

    def close(self):
        if self.job:
            self.job.stop()


def make_handler(hot, token, port, page_path):
    origins = {"http://127.0.0.1:%d" % port, "http://localhost:%d" % port}
    hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}
    routes = {"state": hot.state, "inspect": hot.inspect, "put": hot.put, "get": hot.get, "run": hot.run,
              "job": hot.job_view, "confirm": hot.confirm, "cancel": hot.cancel}
    page_csp = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
                "media-src blob: mediastream:; connect-src 'self'; form-action 'none'; base-uri 'none'; "
                "frame-ancestors 'none'")

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "hot-server"
        sys_version = ""

        def log_message(self, fmt, *a):  # keep the terminal quiet
            pass

        def send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if ctype.startswith("text/html"):
                self.send_header("Content-Security-Policy", page_csp)
            self.end_headers()
            self.wfile.write(data)

        def host_ok(self):
            return self.headers.get("Host") in hosts

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, {"error": "wrong host"})
            if urllib.parse.urlsplit(self.path).path != "/":
                return self.send(404, {"error": "not found"})
            with open(page_path, "rb") as f:
                self.send(200, f.read(), "text/html; charset=utf-8")

        def do_POST(self):
            if not self.host_ok() or self.headers.get("Origin") not in origins:
                return self.send(403, {"error": "This server only answers its own page."})
            if not secrets.compare_digest(self.headers.get("X-Hot-Token", ""), token):
                return self.send(403, {"error": "Missing or wrong token: open the URL the server printed."})
            path = urllib.parse.urlsplit(self.path).path
            fn = routes.get(path[len("/api/"):]) if path.startswith("/api/") else None
            if not fn:
                return self.send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n < 0 or n > MAX_REQUEST * 2:
                    raise Refuse("Request too large.")
                body = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(body, dict):
                    raise Refuse("Bad request.")
                self.send(200, fn(body))
            except Refuse as e:
                self.send(400, {"error": str(e)})
            except ValueError:
                self.send(400, {"error": "Bad request."})
            except subprocess.TimeoutExpired:
                self.send(500, {"error": "A command took too long and was stopped."})
            except Exception as e:  # shown on the page; this server holds no secret that could be in it
                self.send(500, {"error": "%s: %s" % (type(e).__name__, e)})

    return Handler


def make_server(hot, port, page_path, token=None):
    token = token or secrets.token_hex(16)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(hot, token, port, page_path))
    srv.daemon_threads = True
    return srv, token


def main(argv=None):
    ap = argparse.ArgumentParser(description="Local web page for the hot side.")
    ap.add_argument("--dir", default=".", help="folder the hot scripts run in: cold-public.json, the snapshot, tx.hex "
                                               "and the sponsor's saved wallet state live here (default: current folder)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--node", default="node", help="path to Node 22 (default: node)")
    ap.add_argument("--dist", default=None, help="folder with the built scripts (default: dist/ of this repository; "
                                                 "the tests point it at stand-in scripts)")
    args = ap.parse_args(argv)

    network = os.environ.get("MIDNIGHT_NETWORK", "preprod")
    if network not in NETWORKS:
        sys.exit("MIDNIGHT_NETWORK must be one of %s." % ", ".join(NETWORKS))
    if network == "mainnet" and os.environ.get("ALLOW_MAINNET") != "1":
        sys.exit("Mainnet moves real funds and is untested. Set ALLOW_MAINNET=1 only after the test plan passed on preprod.")
    if not os.path.isdir(args.dir):
        sys.exit("%s is not a folder." % args.dir)
    page_path = os.path.join(REPO, "dist", "hot-page.html")
    if not os.path.isfile(page_path):
        sys.exit("dist/hot-page.html is missing: run `npm run build` first.")

    hot = Hot(args.dir, network, args.node, os.path.abspath(args.dist) if args.dist else None)
    try:
        srv, token = make_server(hot, args.port, page_path)
    except OSError as e:
        sys.exit("Could not listen on 127.0.0.1:%d (%s). Try another --port." % (args.port, e.strerror))
    with open(page_path, "rb") as f:
        page_hash = hashlib.sha256(f.read()).hexdigest()
    print("Network: %s" % network)
    print("Folder:  %s" % hot.dir)
    print("Page:    dist/hot-page.html sha256 %s" % page_hash)
    print("Open:    http://127.0.0.1:%d/#%s" % (args.port, token))
    print("Press Ctrl+C to stop. A script that is still running is stopped too.", flush=True)  # flushed: the output may be a pipe
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        hot.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
