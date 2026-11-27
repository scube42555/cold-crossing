// The hot page (dist/hot-page.html), served by tools/hot_server.py on 127.0.0.1. Browser-only.
// It holds no secret and builds nothing: it moves three files (cold-public.json in, the snapshot out, tx.hex in),
// starts hot-watch and sponsor-submit through the server, shows their output, and passes on a typed SUBMIT.
// Everything received from the cold machine or from a script is untrusted text: it is only ever set as textContent.
// The QR display and camera code repeat what src/coldpage/ui.ts does, on purpose: the cold page was verified as built,
// and sharing the code would change it.
import jsqrModule from 'jsqr';
import qrcode from 'qrcode-generator';
import { DEFAULT_MAX_OUTPUT_BYTES } from '../mqr-core.js';
import { type Frame, decodeFramesWeb, encodeFramesWeb, parseFrame, payloadDigest } from '../coldpage/mqr-web.js';
import { NIGHT, amountText } from '../txinfo.js';
import { localStamp } from '../timefmt.js';

// jsqr is a CommonJS bundle: depending on the tool that reads it, the function is the module itself or its `default`.
const jsQR = jsqrModule.default ?? (jsqrModule as unknown as typeof jsqrModule.default);

// ---------------------------------------------------------------- small helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Page element #${id} is missing.`);
  return e as T;
};
const button = (id: string) => $<HTMLButtonElement>(id);
const show = (e: HTMLElement, on: boolean): void => {
  e.hidden = !on;
};
const setErr = (id: string, msg: string): void => {
  $(id).textContent = msg;
  show($(id), msg !== '');
};
const unlock = (id: string, on: boolean): void => {
  $(id).classList.toggle('locked', !on);
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const el = (tag: string, text?: string, cls?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const kvRows = (dl: HTMLElement, rows: [string, string][]): void => {
  dl.replaceChildren();
  for (const [k, v] of rows) dl.append(el('dt', k), el('dd', v));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
const MAX_INPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

// ---------------------------------------------------------------- the server

// The token is the part of the URL after the #, which browsers never send to a server on their own.
const token = location.hash.slice(1);

type FileInfo = { size: number; mtime: number } | null;
type JobView = {
  kind: 'watch' | 'submit' | 'sync';
  running: boolean;
  rc: number | null;
  prompt: boolean;
  answered: string | null;
  log: string;
  next: number;
  dryRun: boolean;
  txSha: string | null;
};
type State = {
  network: string;
  dir: string;
  files: Record<string, FileInfo>;
  env: { sponsorSecret: boolean; blockfrost: boolean; needsBlockfrost: boolean; proofServerSet: boolean; allowMainnet: boolean };
  /** Saved wallet states in the server's folder: address (from the file name) and when it was last saved. */
  sponsorStates: { address: string; mtime: number }[];
  built: boolean;
  job: JobView | null;
};
type Problem = { error: string };
type Inspect = {
  network: string;
  coldPublic: null | Problem | { address: string; network: string | null; sha: string; problem: string | null };
  snapshot:
    | null
    | Problem
    | {
        address: string;
        network: string;
        availableCount: number;
        pendingCount: number;
        balances: [string, string][];
        protocolVersion: string | null;
        writtenBy: string | null;
        bytes: number;
        sha: string;
      };
  tx:
    | null
    | Problem
    | { bytes: number; sha: string; senders: string[]; inputs: number; inputsInSnapshot: number | null; expires: string | null; expired: boolean; plan: string[] };
};

const api = async <T>(name: string, body: Record<string, unknown> = {}): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hot-Token': token },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('The server did not answer. Is tools/hot_server.py still running in its terminal?');
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`The server gave an unreadable answer (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(typeof (data as Problem)?.error === 'string' ? (data as Problem).error : `HTTP ${res.status}`);
  return data as T;
};

const FILE_PUBLIC = 'cold-public.json';
const FILE_SNAPSHOT = 'cold-unshielded.snapshot.json';
const FILE_TX = 'tx.hex';

let state: State | undefined;
let info: Inspect | undefined;
/** Set while this page follows a running script, so buttons stay off. */
let following = false;
/** The transaction id sponsor-submit printed for the tx.hex with this SHA, to keep step 5 open after a refresh of the page state. */
let submitted: { txSha: string; id: string } | undefined;
/** How the last file of each kind arrived (frames, SHA-256), shown until another one replaces it. */
let pubNote = '';
let txNote = '';

// ---------------------------------------------------------------- QR display (as on the cold page)

const svgOf = (text: string): string => {
  const qr = qrcode(0, 'M'); // type 0 picks the smallest version that fits; M is medium error correction
  qr.addData(text, 'Byte');
  qr.make();
  const n: number = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + 2 * quiet;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
};

let qrTimer: number | undefined;
const stopQr = (box: HTMLElement): void => {
  if (qrTimer !== undefined) window.clearInterval(qrTimer);
  qrTimer = undefined;
  box.replaceChildren();
};

/** Show `text` as a cycling sequence of MQR1 QR codes inside `box`, with the frames as text underneath. */
const showQr = (box: HTMLElement, kind: string, text: string, label: string): void => {
  stopQr(box);
  const payload = new TextEncoder().encode(text);
  const { frames, session } = encodeFramesWeb(kind, payload, crypto.getRandomValues(new Uint8Array(3)));
  const svgs = frames.map(svgOf); // built here from our own frames, never from received text
  const wrap = el('div', undefined, 'qrbox');
  const qr = el('div', undefined, 'qr');
  const meta = el('div', undefined, 'qrmeta');
  const status = el('p');
  meta.append(
    status,
    el('p', `${label}: MQR1 kind "${kind}", session ${session}. On the cold machine: scan with the cold page's camera, or with tools/qr_scan.py --clipboard and paste.`),
    el('p', `SHA-256: ${payloadDigest(payload)}...  (the cold page shows the same value in its snapshot checks; compare them)`, 'digest'),
    el('p', 'Frames as text:'),
    el('pre', frames.join('\n')),
  );
  wrap.append(qr, meta);
  box.append(wrap);
  let i = 0;
  const draw = (): void => {
    qr.innerHTML = svgs[i];
    status.textContent = `Frame ${i + 1} of ${frames.length}`;
  };
  draw();
  if (frames.length > 1) {
    qrTimer = window.setInterval(() => {
      i = (i + 1) % frames.length;
      draw();
    }, 700);
  }
};

// ---------------------------------------------------------------- receiving a file from the cold machine

type Receiver = { stop: () => void; clear: () => void; drop: (f: File) => void };
const receivers: Receiver[] = [];

/**
 * Paste box, file button and camera for one kind of transfer. `onText` gets the payload (after the frame checks when it
 * came as MQR1 frames) and a note saying how it arrived and its SHA-256.
 */
const makeReceiver = (box: HTMLElement, id: string, kind: 'pubkey' | 'tx', what: string, errId: string, onText: (text: string, note: string) => Promise<void>): Receiver => {
  const area = document.createElement('textarea');
  area.id = `${id}Text`;
  area.rows = 3;
  area.spellcheck = false;
  area.autocomplete = 'off';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.hidden = true;
  const fileBtn = el('button', 'Load file…') as HTMLButtonElement;
  const camBtn = el('button', 'Scan with camera', 'secondary') as HTMLButtonElement;
  const camStop = el('button', 'Stop camera', 'secondary') as HTMLButtonElement;
  const useBtn = el('button', `Use this ${what}`) as HTMLButtonElement;
  useBtn.id = `${id}Use`;
  for (const b of [fileBtn, camBtn, camStop, useBtn]) b.type = 'button';
  camStop.hidden = true;
  const camBox = el('div');
  camBox.hidden = true;
  const camStatus = el('p', '', 'qrmeta');
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  const canvas = document.createElement('canvas');
  canvas.hidden = true;
  camBox.append(camStatus, video, canvas);
  const actions = el('div', undefined, 'actions');
  actions.append(fileInput, fileBtn, camBtn, camStop);
  const label = el('label', `Or paste (${what}, or MQR1 frames of kind "${kind}")`);
  label.setAttribute('for', area.id);
  const useRow = el('div', undefined, 'actions');
  useRow.append(useBtn);
  box.append(actions, camBox, label, area, useRow);

  let stream: MediaStream | undefined;
  let scanTimer: number | undefined;
  let collect: { first: Frame; lines: Map<number, string> } | undefined;

  const stop = (): void => {
    if (scanTimer !== undefined) window.clearInterval(scanTimer);
    scanTimer = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    video.srcObject = null;
    camBox.hidden = true;
    camStop.hidden = true;
    camBtn.hidden = false;
  };

  const take = async (): Promise<void> => {
    setErr(errId, '');
    const text = area.value;
    try {
      if (text.length > 2 * MAX_INPUT_BYTES) throw new Error('The text is too large.');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length === 0) throw new Error(`Nothing to use: paste, load or scan the ${what} first.`);
      if (lines.every((l) => l.startsWith('MQR1:'))) {
        const d = decodeFramesWeb(lines, MAX_INPUT_BYTES);
        if (d.kind !== kind) throw new Error(`These frames carry "${d.kind}", not "${kind}". This box is for the ${what}.`);
        const payload = new TextDecoder('utf-8', { fatal: true }).decode(d.payload);
        await onText(payload, `Joined ${d.total} MQR1 frame(s), session ${d.session}; checksum correct. SHA-256: ${payloadDigest(d.payload)}...  (the cold page showed the same value beside its QR codes; compare them)`);
      } else {
        await onText(text, `SHA-256 of this text: ${payloadDigest(new TextEncoder().encode(text))}...`);
      }
      area.value = '';
    } catch (e) {
      setErr(errId, messageOf(e));
    }
  };

  const drop = (f: File): void => {
    setErr(errId, '');
    if (f.size > MAX_INPUT_BYTES) {
      setErr(errId, 'The file is too large (over 4 MB).');
      return;
    }
    stop();
    void f.text().then((t) => {
      area.value = t;
      return take();
    });
  };

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) drop(f);
  });
  useBtn.addEventListener('click', () => void take());
  // Pasted text (for example frames from qr_scan.py --clipboard) is checked straight away.
  area.addEventListener('paste', () =>
    window.setTimeout(() => {
      if (area.value.trim()) void take();
    }, 0),
  );

  const acceptFrame = (text: string): void => {
    if (text.length > 4000) return;
    const f = parseFrame(text);
    if (!f) return;
    if (!collect) collect = { first: f, lines: new Map() };
    const first = collect.first;
    if (f.session !== first.session || f.kind !== first.kind || f.total !== first.total || f.hash !== first.hash) return; // locked on the first transfer seen
    collect.lines.set(f.index, text.trim());
    camStatus.textContent = `Transfer ${first.session} (${first.kind}): ${collect.lines.size} of ${first.total} frames.`;
    if (collect.lines.size === first.total) {
      area.value = [...collect.lines.values()].join('\n');
      stop();
      void take();
    }
  };

  camBtn.addEventListener('click', () => {
    void (async () => {
      setErr(errId, '');
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr(errId, 'This browser cannot use a camera here. Use tools/qr_scan.py and load the .mqr file instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (e) {
        setErr(errId, `The camera could not start (${e instanceof Error ? e.name : String(e)}). Use tools/qr_scan.py and load the .mqr file instead.`);
        return;
      }
      collect = undefined;
      video.srcObject = stream;
      await video.play();
      camBox.hidden = false;
      camStop.hidden = false;
      camBtn.hidden = true;
      camStatus.textContent = 'Scanning… point the camera at the cold machine\'s QR codes.';
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      scanTimer = window.setInterval(() => {
        if (video.readyState < 2) return;
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (code?.data) acceptFrame(code.data);
      }, 150);
    })();
  });
  camStop.addEventListener('click', stop);

  const r: Receiver = {
    stop,
    clear: () => {
      area.value = '';
    },
    drop,
  };
  receivers.push(r);
  return r;
};

// ---------------------------------------------------------------- showing what the server has

const isProblem = (v: unknown): v is Problem => typeof v === 'object' && v !== null && typeof (v as Problem).error === 'string';

const check = (list: HTMLElement, cls: 'ok' | 'error' | 'warn' | 'info', text: string): void => {
  list.append(el('li', text, cls));
};

const DAY_S = 24 * 3600;
const ageText = (seconds: number): string =>
  seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))} min` : seconds < 2 * DAY_S ? `${(seconds / 3600).toFixed(1)} h` : `${(seconds / DAY_S).toFixed(1)} days`;

/** Sync ahead: say early whether step 4 will find a synced sponsor, so the slow sync can start now. */
const sponsorStateChecks = (list: HTMLElement, s: State): void => {
  const states = [...s.sponsorStates].sort((a, b) => b.mtime - a.mtime);
  if (states.length === 0) {
    check(list, 'warn', 'No saved sponsor wallet state in this folder: step 4 would sync the sponsor from scratch, which takes hours (and a shielded transfer expires about 50 minutes after its feed). Press "Sync the sponsor now" first.');
    return;
  }
  const now = Date.now() / 1000;
  for (const st of states) {
    const a = st.address;
    check(list, now - st.mtime > DAY_S ? 'info' : 'ok', `Saved wallet state for ${a.slice(0, 18)}...${a.slice(-8)}, last saved ${ageText(now - st.mtime)} ago.${now - st.mtime > DAY_S ? ' Step 4 catches up first; to have that done early, press "Sync the sponsor now".' : ''}`);
  }
  check(list, 'info', 'Step 4 resumes from the saved state whose address is the sponsor\'s (SPONSOR_MNEMONIC). Another address means a sync from scratch.');
};

const render = (): void => {
  if (!state) return;
  const s = state;
  $('network').textContent = s.network;
  $('dir').textContent = s.dir;

  const env = $('envChecks');
  env.replaceChildren();
  if (!s.built) check(env, 'error', 'The scripts are not built: run `npm run build` in the repository, then reload this page.');
  if (s.env.needsBlockfrost) {
    if (s.env.blockfrost) check(env, 'ok', 'BLOCKFROST_PROJECT_ID is set in the server\'s terminal (its value is not read here).');
    else check(env, 'error', `BLOCKFROST_PROJECT_ID is not set. ${s.network} needs it: stop the server, set it with read -rs, export it, start again.`);
  }
  if (s.env.sponsorSecret) check(env, 'ok', 'The sponsor wallet\'s secret is set in the server\'s terminal (its value is not read here). Needed for step 4 only.');
  else check(env, 'warn', 'SPONSOR_MNEMONIC is not set. Snapshots work without it; step 4 needs it: stop the server, set it with read -rs, export it, start again.');
  sponsorStateChecks(env, s);
  check(env, 'info', s.env.proofServerSet ? 'PROOF_SERVER_URL is set: sponsor-submit will use that proof server.' : 'Proof server: the default, http://127.0.0.1:6300. It must be running for step 4.');
  if (s.network === 'mainnet') check(env, 'warn', 'MAINNET: real funds. This page has not been run on mainnet.');

  const busy = following || (s.job?.running ?? false);
  const i = info;

  // Step 1
  const pub = i?.coldPublic ?? null;
  let pubOk = false;
  if (pub === null) {
    show($('pubNow'), false);
    $<HTMLDetailsElement>('pubDetails').open = true;
  } else if (isProblem(pub)) {
    $('pubNow').textContent = pub.error;
    $('pubNow').className = 'banner err';
    show($('pubNow'), true);
  } else {
    pubOk = pub.problem === null;
    $('pubNow').textContent = pubOk
      ? `Watching ${pub.address}  (cold-public.json, SHA-256 ${pub.sha}...). Compare the address with the one the cold page shows.${pubNote ? `  Received: ${pubNote}` : ''}`
      : `cold-public.json in the folder cannot be used: ${pub.problem}`;
    $('pubNow').className = pubOk ? 'banner info' : 'banner err';
    show($('pubNow'), true);
  }

  // Step 2
  unlock('s2', pubOk);
  button('watchBtn').disabled = !pubOk || busy || !s.built;
  button('syncBtn').disabled = busy || !s.built || !s.env.sponsorSecret;
  const snap = i?.snapshot ?? null;
  const snapList = $('snapChecks');
  snapList.replaceChildren();
  let snapOk = false;
  if (snap === null) {
    show($('snapOut'), false);
  } else if (isProblem(snap)) {
    check(snapList, 'error', snap.error);
    kvRows($('snapKv'), []);
    show($('snapOut'), true);
  } else {
    const mtime = s.files[FILE_SNAPSHOT]?.mtime;
    const forThisWallet = !isProblem(pub) && pub !== null && pub.address === snap.address;
    snapOk = snap.network === s.network && forThisWallet;
    check(snapList, snap.network === s.network ? 'ok' : 'error', snap.network === s.network ? `It is for this network (${snap.network}).` : `It is for network "${snap.network}", not "${s.network}". Take a new one.`);
    check(snapList, forThisWallet ? 'ok' : 'error', forThisWallet ? 'It is for the watched address.' : `It is for ${snap.address}, not the watched address. Take a new one.`);
    if (snap.pendingCount > 0) check(snapList, 'warn', `It lists ${snap.pendingCount} pending coin(s): a transaction may be in flight. Take another once it has landed.`);
    check(snapList, 'info', `Taken ${mtime ? localStamp(new Date(mtime * 1000)) : 'at an unknown time'} (this machine's clock). A snapshot is out of date as soon as the wallet spends.`);
    const rows: [string, string][] = [
      ['Coins', String(snap.availableCount)],
      ...snap.balances.map(([type, value]): [string, string] => [type === NIGHT ? 'NIGHT' : `Token ${type}`, amountText(type, BigInt(value))]),
      ['Protocol version', `${snap.protocolVersion ?? 'not recorded'} (written by ${snap.writtenBy ?? 'an unknown variant'})`],
      ['Size', `${snap.bytes} bytes`],
      ['SHA-256', `${snap.sha}...  (the cold page shows the same value when it reads this file)`],
    ];
    kvRows($('snapKv'), rows);
    show($('snapOut'), true);
  }
  button('snapQr').disabled = !snapOk;
  show($('snapDl'), snapOk);

  // Step 3
  unlock('s3', pubOk);
  const tx = i?.tx ?? null;
  let txOk = false;
  if (tx === null) {
    show($('txOut'), false);
  } else if (isProblem(tx)) {
    $('txBanner').textContent = tx.error;
    $('txBanner').className = 'banner err';
    $('txPlan').textContent = '';
    show($('txOut'), true);
  } else {
    const expired = tx.expires !== null && new Date(tx.expires).getTime() <= Date.now(); // by now, not when it was read
    txOk = !expired;
    const expiry = tx.expires ? localStamp(new Date(tx.expires)) : 'unknown';
    const sent = submitted !== undefined && submitted.txSha.startsWith(tx.sha);
    if (sent) txOk = false; // one submission per tx.hex from this page; a new transfer needs a new tx.hex
    $('txBanner').textContent = sent
      ? `tx.hex in the folder (SHA-256 ${tx.sha}...) was submitted as transaction ${submitted?.id ?? ''}. The plan below is compared with the newest snapshot, so once the transfer has landed its coins are reported as not in the snapshot.`
      : expired
      ? `tx.hex in the folder expired at ${expiry}. Build a new transfer on the cold machine from a fresh snapshot.`
      : `tx.hex in the folder: ${tx.bytes} bytes, SHA-256 ${tx.sha}..., expires ${expiry}.${txNote ? `  Received: ${txNote}` : ''}  This is what step 4 will submit:`;
    $('txBanner').className = expired && !sent ? 'banner err' : 'banner info';
    $('txPlan').textContent = tx.plan.join('\n');
    show($('txOut'), true);
  }

  // Step 4
  unlock('s4', txOk || submitted !== undefined);
  button('submitStart').disabled = !txOk || busy || !s.built || !s.env.sponsorSecret;

  // Step 5: open once this page has seen the transfer submitted, and as long as that tx.hex is still the one in the folder.
  const done = submitted !== undefined && !isProblem(tx) && tx !== null && submitted.txSha.startsWith(tx.sha);
  unlock('s5', done);
  button('landBtn').disabled = !done || busy;
  if (done && !isProblem(tx) && tx !== null && !isProblem(snap) && snap !== null) {
    const taken = s.files[FILE_SNAPSHOT]?.mtime;
    const when = taken ? localStamp(new Date(taken * 1000)) : 'unknown time';
    const out = $('landOut');
    if (tx.inputsInSnapshot === null) {
      out.textContent = `The snapshot (taken ${when}) is not for the sender of tx.hex, so it cannot tell whether the transfer landed.`;
      out.className = 'banner warn';
    } else if (tx.inputsInSnapshot === 0) {
      out.textContent = `Landed: none of the ${tx.inputs} coin(s) the transfer spent are in the snapshot taken ${when}. The balances in step 2 are the wallet's new ones.`;
      out.className = 'banner ok';
    } else {
      out.textContent = `Not seen yet: ${tx.inputsInSnapshot} of the ${tx.inputs} coin(s) the transfer spends are still in the snapshot taken ${when}. Wait a little and check again.`;
      out.className = 'banner info';
    }
    show(out, true);
  } else {
    show($('landOut'), false);
  }
};

const refresh = async (): Promise<void> => {
  state = await api<State>('state');
  info = await api<Inspect>('inspect');
  render();
};

// ---------------------------------------------------------------- running a script and following its output

/** Follow the running script into `logEl` until it ends. `onView` sees every update (for the SUBMIT prompt). */
const follow = async (logEl: HTMLElement, onView?: (v: JobView) => void): Promise<JobView> => {
  following = true;
  render();
  show(logEl, true);
  logEl.textContent = '';
  let since = 0;
  try {
    for (;;) {
      const { job } = await api<{ job: JobView | null }>('job', { since });
      if (!job) throw new Error('The server has no script running.');
      if (job.log) {
        const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
        logEl.append(document.createTextNode(job.log));
        if (atEnd) logEl.scrollTop = logEl.scrollHeight;
      }
      since = job.next;
      onView?.(job);
      if (!job.running) return job;
      await sleep(700);
    }
  } finally {
    following = false;
  }
};

const runSync = async (): Promise<void> => {
  setErr('syncErr', '');
  show($('syncCancel'), true);
  try {
    await api('run', { job: 'sync' });
    const end = await follow($('syncLog'));
    if (end.rc !== 0) setErr('syncErr', `sponsor-sync stopped (exit code ${end.rc ?? 'none'}). Its output above says why; what it synced so far is saved.`);
  } catch (e) {
    setErr('syncErr', messageOf(e));
  } finally {
    show($('syncCancel'), false);
    await refresh().catch(() => undefined);
  }
};

const runWatch = async (): Promise<boolean> => {
  setErr('watchErr', '');
  stopQr($('snapQrBox'));
  show($('watchCancel'), true);
  try {
    await api('run', { job: 'watch' });
    const end = await follow($('watchLog'));
    if (end.rc !== 0) {
      setErr('watchErr', `hot-watch stopped without a snapshot (exit code ${end.rc ?? 'none'}). Its output above says why.`);
      return false;
    }
    return true;
  } catch (e) {
    setErr('watchErr', messageOf(e));
    return false;
  } finally {
    show($('watchCancel'), false);
    await refresh().catch(() => undefined);
  }
};

const followSubmit = async (): Promise<void> => {
  setErr('submitErr', '');
  show($('submitDone'), false);
  show($('submitCancel'), true);
  let txSha: string | null = null;
  try {
    const end = await follow($('submitLog'), (v) => {
      txSha = v.txSha;
      const asking = v.prompt;
      if (asking && $('promptBox').hidden) {
        $('promptText').textContent = v.dryRun
          ? 'sponsor-submit is waiting. Dry run: the sponsor wallet will balance and prove, and submit nothing. Read the plan and the fee estimate above, then type SUBMIT.'
          : 'sponsor-submit is waiting. The sponsor wallet will pay the fee and SUBMIT this transfer to the network. Read the plan and the fee estimate above, then type SUBMIT.';
        $<HTMLInputElement>('confirm').value = '';
      }
      show($('promptBox'), asking);
      show($('submitCancel'), v.running && v.answered !== 'SUBMIT');
    });
    const text = $('submitLog').textContent ?? '';
    const id = /Submitted transaction (\S+)/.exec(text)?.[1];
    if (end.rc === 0 && id && txSha) {
      submitted = { txSha, id };
      render(); // opens step 5 at once; the refresh below then brings the files' new state
      $('submitDone').textContent = `Submitted. Transaction ${id}. Now check that it landed (step 5).`;
      show($('submitDone'), true);
    } else if (end.rc === 0) {
      $('submitDone').textContent = 'Finished without submitting (dry run). Nothing was sent to the network.';
      show($('submitDone'), true);
    } else if (end.answered === 'cancel') {
      setErr('submitErr', 'Cancelled. Nothing was balanced or locked.');
    } else {
      setErr('submitErr', `sponsor-submit stopped (exit code ${end.rc ?? 'none'}) and did not report a submission. Its output above says why.`);
    }
  } catch (e) {
    setErr('submitErr', messageOf(e));
  } finally {
    show($('promptBox'), false);
    show($('submitCancel'), false);
    await refresh().catch(() => undefined);
  }
};

// ---------------------------------------------------------------- wiring

const fail = (e: unknown): void => {
  $('fatal').textContent = messageOf(e);
  show($('fatal'), true);
};

const pubReceiver = makeReceiver($('pubRecv'), 'pub', 'pubkey', 'cold-public.json', 'pubErr', async (text, note) => {
  await api('put', { name: FILE_PUBLIC, text });
  pubNote = note;
  await refresh();
  $<HTMLDetailsElement>('pubDetails').open = false;
});
const txReceiver = makeReceiver($('txRecv'), 'tx', 'tx', 'tx.hex', 'txErr', async (text, note) => {
  await api('put', { name: FILE_TX, text });
  submitted = undefined;
  txNote = note;
  await refresh();
});

// Every drop is caught, so a stray drop cannot make the browser leave the page. A file goes to the section it lands on.
const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const section = (e.target as HTMLElement | null)?.closest?.('section')?.id;
  if (section === 's1') pubReceiver.drop(f);
  else if (section === 's3') txReceiver.drop(f);
});

button('watchBtn').addEventListener('click', () => void runWatch());
button('syncBtn').addEventListener('click', () => void runSync());
button('syncCancel').addEventListener('click', () => void api('cancel').catch((e) => setErr('syncErr', messageOf(e))));
button('watchCancel').addEventListener('click', () => void api('cancel').catch((e) => setErr('watchErr', messageOf(e))));

button('snapQr').addEventListener('click', () => {
  void (async () => {
    try {
      const { text } = await api<{ text: string }>('get', { name: FILE_SNAPSHOT });
      showQr($('snapQrBox'), 'snapshot', text, 'cold-unshielded.snapshot.json');
    } catch (e) {
      setErr('watchErr', messageOf(e));
    }
  })();
});
// The download is fetched when asked for, so it is always the file as it is on disk now.
$('snapDl').addEventListener('click', (e) => {
  const a = $<HTMLAnchorElement>('snapDl');
  if (a.dataset.ready === '1') {
    a.dataset.ready = '';
    return;
  }
  e.preventDefault();
  void (async () => {
    try {
      const { text } = await api<{ text: string }>('get', { name: FILE_SNAPSHOT });
      if (a.href.startsWith('blob:')) URL.revokeObjectURL(a.href);
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
      a.dataset.ready = '1';
      a.click();
    } catch (err) {
      setErr('watchErr', messageOf(err));
    }
  })();
});

button('submitStart').addEventListener('click', () => {
  void (async () => {
    setErr('submitErr', '');
    try {
      await api('run', { job: 'submit', dryRun: $<HTMLInputElement>('dryRun').checked });
    } catch (e) {
      setErr('submitErr', messageOf(e));
      return;
    }
    await followSubmit();
  })();
});
button('submitCancel').addEventListener('click', () => void api('cancel').catch((e) => setErr('submitErr', messageOf(e))));

const confirmNow = async (): Promise<void> => {
  setErr('submitErr', '');
  try {
    const { job } = await api<{ job: JobView | null }>('job', { since: Number.MAX_SAFE_INTEGER });
    await api('confirm', { confirm: $<HTMLInputElement>('confirm').value, txSha: job?.txSha ?? '' });
    show($('promptBox'), false);
  } catch (e) {
    setErr('submitErr', messageOf(e));
  }
};
button('confirmBtn').addEventListener('click', () => void confirmNow());
$('confirm').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void confirmNow();
});

button('landBtn').addEventListener('click', () => {
  void (async () => {
    $('s2').scrollIntoView({ block: 'start' });
    if (await runWatch()) $('s5').scrollIntoView({ block: 'start' });
  })();
});

// Start: show the state, and if a script is already running (the page was reloaded), pick its output up again.
void (async () => {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    fail('This page needs the token from the URL the server printed (the part after #). Copy the whole URL from the terminal.');
    return;
  }
  try {
    await refresh();
    const job = state?.job;
    if (job?.running) {
      if (job.kind === 'sync') {
        show($('syncCancel'), true);
        await follow($('syncLog'));
        show($('syncCancel'), false);
        await refresh();
      } else if (job.kind === 'watch') {
        show($('watchCancel'), true);
        await follow($('watchLog'));
        show($('watchCancel'), false);
        await refresh();
      } else {
        await followSubmit();
      }
    }
  } catch (e) {
    fail(e);
  }
})();

// Keep the file list fresh while nothing is running (a file copied into the folder by hand shows up by itself).
window.setInterval(() => {
  if (following || document.hidden) return;
  void (async () => {
    try {
      const next = await api<State>('state');
      const changed = JSON.stringify(next.files) !== JSON.stringify(state?.files) || next.job?.running !== state?.job?.running;
      state = next;
      if (changed) info = await api<Inspect>('inspect');
      render();
      show($('fatal'), false);
    } catch (e) {
      fail(e);
    }
  })();
}, 4000);

void pubReceiver;
void txReceiver;
