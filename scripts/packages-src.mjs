// The source of dist/ is split over packages/core, packages/cold and packages/hot, and tsc merges them into one dist/
// (tsconfig rootDirs). esbuild does not know rootDirs, so this plugin does the same for the page builds: a relative
// import that is not in the importing package is looked up at the same place in packages/core/src.
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDirs = ['core', 'cold', 'hot'].map((p) => resolve(root, 'packages', p, 'src'));
const core = srcDirs[0];

export const packagesSrc = {
  name: 'packages-src',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (a) => {
      const own = srcDirs.find((d) => a.resolveDir === d || a.resolveDir.startsWith(d + '/'));
      if (!own || own === core) return undefined;
      const target = resolve(a.resolveDir, a.path.replace(/\.js$/, '.ts'));
      if (existsSync(target)) return undefined;
      const inCore = resolve(core, relative(own, target));
      if (!inCore.startsWith(core + '/') || !existsSync(inCore)) return undefined;
      return { path: inCore };
    });
  },
};

export const entry = (pkg, file) => relative(process.cwd(), resolve(root, 'packages', pkg, 'src', file));

