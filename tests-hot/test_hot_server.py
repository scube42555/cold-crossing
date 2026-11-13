"""Tests for tools/hot_server.py. Run: npm run test:server  (python3 -m unittest discover -s tests-hot)

No wallet and no network: the scripts are the stand-ins in tests-hot/fake-dist, which ask the same question as
sponsor-submit. Needs Node on the PATH to run them. The sponsor "secret" set here is a made-up marker.
"""
import http.client
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))
import hot_server  # noqa: E402

FAKE_DIST = os.path.join(HERE, "fake-dist")
MARKER = "marker-not-a-real-phrase-7f3a"
ADDRESS = "mn_addr_preprod1" + "q" * 52
PUBLIC = {"sdk": 2, "network": "preprod", "address": ADDRESS,
          "publicKey": {"publicKey": {"tag": "schnorr", "value": "ab" * 32}, "addressHex": "cd" * 32, "address": ADDRESS}}
TX = "0a1b2c" * 40


class ChecksTest(unittest.TestCase):
    def test_cold_public_accepted_and_rewritten_in_the_cold_layout(self):
        out = hot_server.check_cold_public(json.dumps(PUBLIC), "preprod")
        self.assertEqual(out, json.dumps(PUBLIC, indent=2))

    def test_cold_public_refusals(self):
        def bad(change, network="preprod"):
            d = json.loads(json.dumps(PUBLIC))
            change(d)
            with self.assertRaises(hot_server.Refuse):
                hot_server.check_cold_public(json.dumps(d), network)

        bad(lambda d: None, network="preview")  # made for another network
        bad(lambda d: d.update(network="mainnet"))
        bad(lambda d: d.update(sdk=1))
        bad(lambda d: d.update(extra=1))
        bad(lambda d: d.pop("publicKey"))
        bad(lambda d: d.update(address="mn_addr1" + "q" * 52))  # a mainnet address in a preprod file
        bad(lambda d: d["publicKey"].update(address="mn_addr_preprod1" + "p" * 52))
        bad(lambda d: d["publicKey"].update(publicKey="ab" * 32))  # a bare string, not the ledger's key object
        bad(lambda d: d["publicKey"]["publicKey"].update(value="zz" * 32))
        bad(lambda d: d["publicKey"]["publicKey"].update(tag="ecdsa"))
        bad(lambda d: d["publicKey"]["publicKey"].update(secret="x"))
        bad(lambda d: d["publicKey"].update(secret="x"))
        for text in ("", "[]", "not json", '"text"'):
            with self.assertRaises(hot_server.Refuse):
                hot_server.check_cold_public(text, "preprod")

    def test_tx_hex(self):
        self.assertEqual(hot_server.check_tx_hex(TX), TX)
        self.assertEqual(hot_server.check_tx_hex(TX + "\n"), TX + "\n")  # kept as received, so the SHA-256 matches
        for text in ("", "abc", "0A1B", "zz", TX + "\n\n", " " + TX, TX + "; rm -rf"):
            with self.assertRaises(hot_server.Refuse):
                hot_server.check_tx_hex(text)

    def test_clean_strips_colours_bells_and_carriage_returns(self):
        self.assertEqual(hot_server.clean("\x07\x1b[32mok\x1b[0m\r\nnext\ttab"), "ok\nnext\ttab")


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.page = os.path.join(self.dir, "page.html")
        with open(self.page, "w") as f:
            f.write("<!doctype html><title>test page</title>")
        self.saved_env = dict(os.environ)
        os.environ["SPONSOR_MNEMONIC"] = MARKER
        os.environ.pop("BLOCKFROST_PROJECT_ID", None)
        os.environ.pop("FAKE_WATCH_MS", None)
        self.hot = hot_server.Hot(self.dir, "preprod", "node", FAKE_DIST)
        self.srv, self.token = hot_server.make_server(self.hot, 0, self.page)
        self.port = self.srv.server_address[1]
        # Port 0 let the system choose; the handler must check against the real one.
        self.srv.RequestHandlerClass = hot_server.make_handler(self.hot, self.token, self.port, self.page)
        import threading
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.hot.close()
        self.srv.shutdown()
        self.srv.server_close()
        os.environ.clear()
        os.environ.update(self.saved_env)
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        base = {"Host": "127.0.0.1:%d" % self.port, "Origin": "http://127.0.0.1:%d" % self.port,
                "X-Hot-Token": self.token, "Content-Type": "application/json"}
        base.update(headers or {})
        base = {k: v for k, v in base.items() if v is not None}
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.putrequest(method, path, skip_host=True)
        data = json.dumps(body if body is not None else {}).encode() if method == "POST" else b""
        for k, v in base.items():
            conn.putheader(k, v)
        conn.putheader("Content-Length", str(len(data)))
        conn.endheaders(data)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res, raw

    def api(self, name, body=None, expect=200):
        res, raw = self.request("POST", "/api/" + name, body)
        self.assertEqual(res.status, expect, raw)
        return json.loads(raw)

    def wait_job(self, test, what, seconds=20):
        end = time.time() + seconds
        while time.time() < end:
            job = self.api("job", {"since": 0})["job"]
            if test(job):
                return job
            time.sleep(0.05)
        self.fail("timed out waiting for " + what)

    def put_files(self):
        self.api("put", {"name": "cold-public.json", "text": json.dumps(PUBLIC)})
        self.api("put", {"name": "tx.hex", "text": TX})

    # ---------- who may talk to it

    def test_page_is_served_with_a_policy_that_allows_only_this_server(self):
        res, raw = self.request("GET", "/")
        self.assertEqual(res.status, 200)
        self.assertIn(b"test page", raw)
        csp = res.getheader("Content-Security-Policy")
        self.assertIn("default-src 'none'", csp)
        self.assertIn("connect-src 'self'", csp)
        self.assertEqual(self.request("GET", "/other")[0].status, 404)

    def test_other_hosts_origins_and_tokens_are_refused(self):
        for headers in ({"Host": "evil.example:%d" % self.port}, {"Host": "127.0.0.1"},
                        {"Origin": "http://evil.example"}, {"Origin": None}, {"Origin": "null"},
                        {"X-Hot-Token": "0" * 32}, {"X-Hot-Token": None}):
            res, raw = self.request("POST", "/api/state", {}, headers)
            self.assertEqual(res.status, 403, headers)
        self.assertEqual(self.request("GET", "/", headers={"Host": "evil.example"})[0].status, 403)
        self.assertEqual(self.request("POST", "/api/nothing", {})[0].status, 404)
        # localhost is the same machine and is accepted
        ok = {"Host": "localhost:%d" % self.port, "Origin": "http://localhost:%d" % self.port}
        self.assertEqual(self.request("POST", "/api/state", {}, ok)[0].status, 200)

    def test_bad_bodies_are_refused(self):
        for raw_body in (b"[1,2]", b"not json"):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
            conn.request("POST", "/api/state", raw_body, {"Origin": "http://127.0.0.1:%d" % self.port,
                                                           "X-Hot-Token": self.token})
            self.assertEqual(conn.getresponse().status, 400)
            conn.close()
        self.api("put", {"name": "tx.hex", "text": "ab" * 40000}, expect=400)

    # ---------- state and files

    def test_state_says_whether_secrets_are_set_and_never_what_they_are(self):
        res, raw = self.request("POST", "/api/state", {})
        state = json.loads(raw)
        self.assertEqual(state["network"], "preprod")
        self.assertEqual(state["env"], {"sponsorSecret": True, "blockfrost": False, "needsBlockfrost": True,
                                        "proofServerSet": bool(os.environ.get("PROOF_SERVER_URL")),
                                        "allowMainnet": os.environ.get("ALLOW_MAINNET") == "1"})
        self.assertNotIn(MARKER.encode(), raw)
        self.assertTrue(state["built"])
        self.assertEqual(state["files"], {"cold-public.json": None, "cold-unshielded.snapshot.json": None, "tx.hex": None})

    def test_put_checks_and_writes_private_files(self):
        self.api("put", {"name": "cold-public.json", "text": json.dumps(dict(PUBLIC, network="preview"))}, expect=400)
        self.api("put", {"name": "tx.hex", "text": "not hex"}, expect=400)
        for name in ("cold-unshielded.snapshot.json", "../x", "wallet-state-a.json", ".env", None):
            self.api("put", {"name": name, "text": TX}, expect=400)
        self.assertEqual(os.listdir(self.dir), ["page.html"])
        self.put_files()
        with open(os.path.join(self.dir, "tx.hex")) as f:
            self.assertEqual(f.read(), TX)
        self.assertEqual(os.stat(os.path.join(self.dir, "tx.hex")).st_mode & 0o777, 0o600)
        got = self.api("get", {"name": "tx.hex"})
        self.assertEqual(got["text"], TX)
        self.api("get", {"name": "cold-unshielded.snapshot.json"}, expect=400)  # not there yet
        self.api("get", {"name": "wallet-state-a.json"}, expect=400)
        self.api("get", {"name": "../tools/hot_server.py"}, expect=400)

    def test_inspect_runs_the_inspect_script_with_fixed_file_names(self):
        out = self.api("inspect", {"argv": ["--evil"], "name": "other.json"})
        self.assertEqual(out["argv"], ["cold-public.json", "cold-unshielded.snapshot.json", "tx.hex"])
        self.assertEqual(out["network"], "preprod")

    # ---------- scripts

    def test_watch_runs_hot_watch_with_fixed_arguments(self):
        self.api("run", {"job": "watch"}, expect=400)  # no cold-public.json yet
        self.put_files()
        self.api("run", {"job": "watch", "argv": ["--no-probe"], "env": {"X": "1"}})
        job = self.wait_job(lambda j: not j["running"], "hot-watch to end")
        self.assertEqual(job["rc"], 0)
        self.assertIn('ARGS ["cold-public.json","cold-unshielded.snapshot.json"]', job["log"])
        self.assertIn("Network: preprod", job["log"])
        self.assertIn(ADDRESS, job["log"])

    def test_only_one_script_at_a_time_and_no_file_changes_meanwhile(self):
        self.put_files()
        self.hot.env["FAKE_WATCH_MS"] = "5000"
        self.api("run", {"job": "watch"})
        self.api("run", {"job": "watch"}, expect=400)
        self.api("run", {"job": "submit"}, expect=400)
        self.api("put", {"name": "tx.hex", "text": TX}, expect=400)
        self.api("confirm", {"confirm": "SUBMIT"}, expect=400)  # that script asks nothing
        self.api("cancel")
        job = self.wait_job(lambda j: not j["running"], "hot-watch to stop")
        self.assertNotEqual(job["rc"], 0)
        self.api("cancel", expect=400)
        self.api("run", {"job": "unknown"}, expect=400)

    def test_submit_waits_for_a_typed_submit_bound_to_the_tx_it_started_with(self):
        self.api("run", {"job": "submit"}, expect=400)  # no tx.hex yet
        self.put_files()
        started = self.api("run", {"job": "submit"})
        self.assertFalse(started["dryRun"])
        job = self.wait_job(lambda j: j["prompt"], "the SUBMIT question")
        self.assertIn('ARGS ["tx.hex"]', job["log"])
        self.assertIn("Sponsor secret in the environment: yes", job["log"])  # inherited, not sent by anyone
        self.assertNotIn(MARKER, json.dumps(job))
        self.assertIn("Synced in 1 s.\n", job["log"])  # colour codes, the bell and \r are gone
        self.assertTrue(job["log"].rstrip().endswith("Type SUBMIT to continue:"))
        sha = job["txSha"]
        self.assertEqual(len(sha), 64)
        for confirm in ("", "submit", "SUBMIT ", "YES", None):
            self.api("confirm", {"confirm": confirm, "txSha": sha}, expect=400)
        self.api("confirm", {"confirm": "SUBMIT", "txSha": "0" * 64}, expect=400)
        self.api("confirm", {"confirm": "SUBMIT"}, expect=400)
        self.assertTrue(self.api("job", {"since": 0})["job"]["prompt"])  # still waiting: nothing was typed for it
        self.hot.job.proc.poll()
        self.api("confirm", {"confirm": "SUBMIT", "txSha": sha})
        self.api("confirm", {"confirm": "SUBMIT", "txSha": sha}, expect=400)  # once only
        job = self.wait_job(lambda j: not j["running"], "sponsor-submit to end")
        self.assertEqual(job["rc"], 0)
        self.assertEqual(job["answered"], "SUBMIT")
        self.assertIn("Submitted transaction " + "ab" * 32, job["log"])

    def test_cancel_at_the_question_answers_no(self):
        self.put_files()
        self.api("run", {"job": "submit", "dryRun": True})
        job = self.wait_job(lambda j: j["prompt"], "the SUBMIT question")
        self.assertIn('ARGS ["tx.hex","--dry-run"]', job["log"])
        self.assertIn("(dry run, no submission)", job["log"])
        self.api("cancel")
        job = self.wait_job(lambda j: not j["running"], "sponsor-submit to end")
        self.assertEqual(job["rc"], 1)
        self.assertIn("Cancelled. Nothing was balanced or locked.", job["log"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "fake-submitted")))

    def test_dry_run_must_be_asked_for_exactly(self):
        self.put_files()
        started = self.api("run", {"job": "submit", "dryRun": "false"})  # not the boolean true: a real run
        self.assertFalse(started["dryRun"])
        self.api("cancel")

    def test_no_cancel_once_submit_was_given(self):
        self.put_files()
        self.hot.env["FAKE_SUBMIT_MS"] = "1500"
        self.api("run", {"job": "submit"})
        job = self.wait_job(lambda j: j["prompt"], "the SUBMIT question")
        self.api("confirm", {"confirm": "SUBMIT", "txSha": job["txSha"]})
        self.api("cancel", expect=400)
        job = self.wait_job(lambda j: not j["running"], "sponsor-submit to end")
        self.assertEqual(job["rc"], 0)

    def test_log_is_read_in_pieces(self):
        self.put_files()
        self.api("run", {"job": "watch"})
        job = self.wait_job(lambda j: not j["running"], "hot-watch to end")
        rest = self.api("job", {"since": 10})["job"]
        self.assertEqual(rest["log"], job["log"][10:])
        self.assertEqual(self.api("job", {"since": job["next"]})["job"]["log"], "")
        self.api("job", {"since": -1}, expect=400)

    def test_settings_that_would_move_the_files_are_not_passed_on(self):
        os.environ["SNAPSHOT_FILE"] = "/tmp/elsewhere.json"
        os.environ["MIDNIGHT_NETWORK"] = "preview"
        hot = hot_server.Hot(self.dir, "preprod", "node", FAKE_DIST)
        self.assertNotIn("SNAPSHOT_FILE", hot.env)
        self.assertEqual(hot.env["MIDNIGHT_NETWORK"], "preprod")
        self.assertEqual(hot.env["SPONSOR_MNEMONIC"], MARKER)


if __name__ == "__main__":
    unittest.main()
