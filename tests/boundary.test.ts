// The import boundary (MERGE-PLAN.md, phase 1). Everything in packages/core and packages/cold runs on the cold machine, so
// none of it may reach for the network itself, nor import the hot side. tsc already refuses a cold import of a hot module
// (rootDirs, packages/cold/tsconfig.json); this also catches network modules and calls, and the wnight packages.
//
// What it cannot see: the wallet SDK that cold-transfer builds on contains network clients. cold-transfer gives it stub
// endpoints (coldEndpoints in config.ts), and README section 5 runs the cold scripts with no network (unshare -rn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)); // dist-test/tests/ -> the repository
const coldSide = ['packages/core/src', 'packages/cold/src'];

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.ts$/.test(n) ? [p] : [];
  });

/** Module specifiers a file imports or re-exports, static or dynamic. */
const specifiers = (code: string): string[] =>
  [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]);

/** The code without comments, so a comment that names fetch or WebSocket is not a finding. */
const withoutComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const forbiddenModule = (s: string): boolean =>
  /^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads)(\/|$)/.test(s) ||
  /^(ws|undici|node-fetch|axios)(\/|$)/.test(s) ||
  /^@midnightntwrk\/(wallet-sdk\/(indexer-client|node-client|prover-client)|wallet-sdk-(indexer-client|node-client|prover-client)|midnight-js)/.test(s) ||
  /(^|\/)(hot|wnight-cli|contract)\/src\//.test(s);

const files = coldSide.flatMap((d) => sources(join(root, d)));

test('the boundary test sees the cold side', () => {
  const names = files.map((f) => relative(root, f));
  for (const f of ['packages/core/src/config.ts', 'packages/cold/src/cold-transfer.ts', 'packages/cold/src/coldpage/ui.ts']) {
    assert.ok(names.includes(f), `${f} not found`);
  }
});

test('core and cold import no network module and nothing from hot, wnight-cli or contract', () => {
  const found = files.flatMap((f) =>
    specifiers(readFileSync(f, 'utf8'))
      .filter(forbiddenModule)
      .map((s) => `${relative(root, f)}: ${s}`),
  );
  assert.deepEqual(found, []);
});

test('core and cold make no network call of their own', () => {
  const found = files.flatMap((f) => {
    const code = withoutComments(readFileSync(f, 'utf8'));
    return [/\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bXMLHttpRequest\b/, /\bnew\s+EventSource\b/, /\bsendBeacon\b/]
      .filter((re) => re.test(code))
      .map((re) => `${relative(root, f)}: ${re.source}`);
  });
  assert.deepEqual(found, []);
});

test('the checks would catch a violation', () => {
  assert.ok(forbiddenModule('node:https') && forbiddenModule('http') && forbiddenModule('ws'));
  assert.ok(forbiddenModule('@midnightntwrk/wallet-sdk/indexer-client/effect'));
  assert.ok(forbiddenModule('@midnightntwrk/midnight-js-contracts') && forbiddenModule('../../hot/src/wallet.js'));
  assert.ok(!forbiddenModule('@midnightntwrk/wallet-sdk') && !forbiddenModule('node:fs') && !forbiddenModule('./hex.js'));
  assert.deepEqual(specifiers("import a from 'x';\nexport { b } from \"y\";\nconst c = await import('z');\nimport 'side';"), ['x', 'y', 'z', 'side']);
  assert.ok(!/\bfetch\s*\(/.test(withoutComments('// fetch(url)\n/* fetch(x) */ const a = 1;')));
});

// The cold bundle (README section 5) installs the root package.json's dependencies. wnight's online packages live in
// packages/wnight-cli and packages/contract and must stay there, or they would land on the cold machine.
test('the root dependencies, which are the cold bundle, hold no wnight package', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const leaked = Object.keys(pkg.dependencies).filter((n) =>
    /^@midnightntwrk\/(midnight-js|compact|testkit|dapp-connector)|^pino|^@cold-crossing\/|^dotenv|^ws$/.test(n),
  );
  assert.deepEqual(leaked, []);
});

// The cold bundle installs from packages/cold/bundle/ (README section 5), because the root lockfile also holds wnight's
// tree. These keep the two in step: the same dependencies, versions that the root lockfile also has, and none of the
// Docker and SSH packages that wnight's test kit brings into the root tree.
type Lock = { name: string; packages: Record<string, { version?: string; name?: string; dependencies?: Record<string, string> }> };
const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
const lockName = (path: string, e: { name?: string }): string => e.name ?? path.replace(/^.*node_modules\//, '');

test('the cold bundle manifest has the root dependencies, and its lockfile matches it', () => {
  const rootPkg = readJson<{ dependencies: Record<string, string> }>('package.json');
  const cold = readJson<{ name: string; type: string; dependencies: Record<string, string>; workspaces?: unknown }>('packages/cold/bundle/package.json');
  assert.deepEqual(cold.dependencies, rootPkg.dependencies);
  assert.equal(cold.type, 'module'); // dist/*.js load as ES modules on the cold machine
  assert.equal(cold.workspaces, undefined);
  const lock = readJson<Lock>('packages/cold/bundle/package-lock.json');
  assert.equal(lock.name, cold.name);
  assert.deepEqual(lock.packages['']?.dependencies, cold.dependencies);
});

test('the cold bundle lockfile uses only versions the root lockfile has, and no Docker or SSH client', () => {
  const rootLock = readJson<Lock>('package-lock.json');
  const have = new Set(Object.entries(rootLock.packages).map(([p, e]) => `${lockName(p, e)}@${e.version}`));
  const cold = readJson<Lock>('packages/cold/bundle/package-lock.json');
  const entries = Object.entries(cold.packages).filter(([p]) => p !== '');
  assert.ok(entries.length > 100, 'cold lockfile looks empty');
  assert.deepEqual(entries.map(([p, e]) => `${lockName(p, e)}@${e.version}`).filter((nv) => !have.has(nv)), []);
  const unwanted = /(^|\/)(testcontainers|dockerode|docker-modem|docker-compose|ssh2|ssh-remote-port-forward|cpu-features|@midnight-ntwrk\/testkit-js|pino)$/;
  assert.deepEqual(entries.map(([p]) => p).filter((p) => unwanted.test(p)), []);
});
