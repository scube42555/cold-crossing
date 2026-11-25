// Builds dist/prover-lab.html: the prover lab EXPERIMENT (src/proverlab/). One self-contained page with the ledger 9 and
// zkir v2 WebAssembly modules inlined; it loads nothing and can reach nothing (connect-src 'none'). Key files are picked
// by the person and checked against the SDK's pinned SHA-256s, which are inlined here at build time.
// Separate from build-cold-page.mjs on purpose: building the lab never changes dist/cold-page.html.
//   npx tsc && node scripts/build-prover-lab.mjs      (npm run build:prover-lab)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { pins, pinsSource, zkirDir } from './prover-lab-pins.mjs';

// The ledger: found and started exactly as build-cold-page.mjs does (kept in step by hand; see that file for why).
const findLedgerDir = () => {
  let dir = dirname(fileURLToPath(import.meta.resolve('@midnightntwrk/wallet-sdk')));
  for (;;) {
    const candidate = join(dir, 'node_modules', '@midnightntwrk', 'ledger-v9');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find @midnightntwrk/ledger-v9. Run npm ci first.');
    dir = parent;
  }
};

/** A loader that instantiates a wasm-bindgen module from inlined bytes (no fetch) and returns its glue. */
const wasmLoader = ({ dir, glueFile, wasmFile, exportName, withMemory }) => {
  const glue = join(dir, glueFile);
  const wasmPath = join(dir, wasmFile);
  const GLUE_MODULE = `./${glueFile}`;
  const bytes = readFileSync(wasmPath);
  const wanted = [...new Set(WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((i) => i.module))];
  const snippetFiles = new Map();
  const snippetsRoot = join(dir, 'snippets');
  if (existsSync(snippetsRoot)) {
    for (const d of readdirSync(snippetsRoot)) for (const f of readdirSync(join(snippetsRoot, d))) snippetFiles.set(`./snippets/${d}/${f}`, join(snippetsRoot, d, f));
  }
  for (const name of wanted) {
    if (name !== GLUE_MODULE && !snippetFiles.has(name)) throw new Error(`${wasmFile} imports "${name}", which this build does not know how to provide.`);
  }
  const source = [
    `import * as glue from ${JSON.stringify(glue)};`,
    `import wasmBytes from ${JSON.stringify(wasmPath)};`,
    `const imports = { ${JSON.stringify(GLUE_MODULE)}: glue };`,
    ...wanted
      .filter((n) => n !== GLUE_MODULE)
      .map((n, i) => `import * as snippet${i} from ${JSON.stringify(snippetFiles.get(n))}; imports[${JSON.stringify(n)}] = snippet${i};`),
    `export const ${exportName} = async () => {`,
    '  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);',
    '  glue.__wbg_set_wasm(instance.exports);',
    '  instance.exports.__wbindgen_start();',
    withMemory ? '  return { zkir: glue, memory: () => instance.exports.memory };' : '  return glue;',
    '};',
  ].join('\n');
  return { source, glue, bytes };
};

const ledgerDir = findLedgerDir();
const ledger = wasmLoader({ dir: ledgerDir, glueFile: 'midnight_ledger_wasm_v9_bg.js', wasmFile: 'midnight_ledger_wasm_v9_bg.wasm', exportName: 'loadLedger' });
const zkir = wasmLoader({ dir: zkirDir, glueFile: 'midnight_zkir_wasm_bg.js', wasmFile: 'midnight_zkir_wasm_bg.wasm', exportName: 'loadZkir', withMemory: true });
const version = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

const virtualPlugin = {
  name: 'prover-lab-inline',
  setup(b) {
    b.onResolve({ filter: /^virtual:(ledger-v9|zkir-v2)$/ }, (a) => ({ path: a.path, namespace: 'wasm-loader' }));
    b.onLoad({ filter: /.*/, namespace: 'wasm-loader' }, (a) =>
      a.path === 'virtual:ledger-v9'
        ? { contents: ledger.source, resolveDir: ledgerDir, loader: 'js' }
        : { contents: zkir.source, resolveDir: zkirDir, loader: 'js' },
    );
    // The ledger's snippets import the package's own entry as "#self"; in the page that is its glue.
    b.onResolve({ filter: /^#self$/ }, () => ({ path: ledger.glue }));
  },
};

const result = await build({
  entryPoints: ['src/proverlab/ui.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  loader: { '.wasm': 'binary' },
  plugins: [virtualPlugin],
  define: { __PINS__: JSON.stringify(pins), __PINS_SOURCE__: JSON.stringify(pinsSource) },
  minify: false,
  legalComments: 'inline',
  charset: 'ascii',
  write: false,
  metafile: true,
  logLevel: 'warning',
});
const bundle = result.outputFiles[0].text;
if (/<\/script/i.test(bundle)) throw new Error('The bundle contains a script end tag; cannot inline it.');
if (bundle.includes('<!--')) throw new Error('The bundle contains "<!--"; cannot inline it safely.');

const template = readFileSync('prover-lab/prover-lab.template.html', 'utf8');
if (template.split('/*BUNDLE*/').length !== 2) throw new Error('Template marker /*BUNDLE*/ must appear exactly once.');
const page = template.replace('/*BUNDLE*/', () => bundle);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/prover-lab.html', page);

const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(input);
  if (m) packages.add(m[1]);
}
const out = Buffer.from(page);
console.log(
  `Wrote dist/prover-lab.html (${out.length} bytes; ledger-v9 ${version(ledgerDir)} ${ledger.bytes.length} B wasm, zkir-v2 ${version(zkirDir)} ${zkir.bytes.length} B wasm)`,
);
console.log(`Key pins: ${pinsSource}`);
console.log(`Packages inlined: ${[...packages].sort().join(', ')}`);
console.log(`sha256 ${createHash('sha256').update(out).digest('hex')}`);
