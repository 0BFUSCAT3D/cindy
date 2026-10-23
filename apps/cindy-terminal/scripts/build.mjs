import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(path.join(appDir,'dist'),{recursive:true});
await build({
  entryPoints:[path.join(appDir,'src/cli.tsx')],outfile:path.join(appDir,'dist/cli.js'),
  platform:'node',target:'node22',format:'esm',bundle:true,sourcemap:true,
  loader:{'.md':'text'},external:['ink','react','react/jsx-runtime','@roamhq/wrtc','better-sqlite3','sharp','node-pty','ssh2'],
  banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},
});
