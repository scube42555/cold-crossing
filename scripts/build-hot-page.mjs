// Builds dist/hot-page.html: the page tools/hot_server.py serves on the hot machine. One file, nothing loaded from
// outside it; its only network access is this server's own API (the server sends the security policy header).
// Build-time only (esbuild is a devDependency). The page holds no ledger code: the scripts in dist/ do that work.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { entry, packagesSrc } from './packages-src.mjs';

const result = await build({
  entryPoints: [entry('hot', 'hotpage/ui.ts')],
  bundle: true,
  plugins: [packagesSrc],
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: false, // the page is read by people
  legalComments: 'inline',
  charset: 'ascii',
  write: false,
  metafile: true,
  logLevel: 'warning',
});
const bundle = result.outputFiles[0].text;

// The bundle goes inside a <script> element: nothing in it may end the element or open an HTML comment.
if (/<\/script/i.test(bundle)) throw new Error('The bundle contains a script end tag; cannot inline it.');
if (bundle.includes('<!--')) throw new Error('The bundle contains "<!--"; cannot inline it safely.');

const template = readFileSync('hot-page/hot-page.template.html', 'utf8');
if (template.split('/*BUNDLE*/').length !== 2) throw new Error('Template marker /*BUNDLE*/ must appear exactly once.');
const page = template.replace('/*BUNDLE*/', () => bundle);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/hot-page.html', page);

const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(input);
  if (m) packages.add(m[1]);
}
const bytes = Buffer.from(page);
console.log(`Wrote dist/hot-page.html (${bytes.length} bytes)`);
console.log(`Packages inlined: ${[...packages].sort().join(', ')}`);
console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
