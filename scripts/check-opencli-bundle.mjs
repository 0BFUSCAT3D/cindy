// Check production CJS bundling, then load every command without executing it.
import { mkdtemp, rm, symlink, readdir, readFile } from "node:fs/promises";
import { gzipSync } from 'node:zlib';
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "cindy-recipes-bundle-"));
try {
  await symlink(
    path.join(root, "node_modules"),
    path.join(output, "node_modules"),
    "dir",
  );
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [{
      name: 'assert-static-recipe-entry',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk' && output.dynamicImports.length) {
            throw new Error(`Recipe bundle retained runtime imports: ${output.fileName}`);
          }
        }
      },
    }],
    ssr: { noExternal: true },
    build: {
      ssr: "packages/opencli-vendor/cindy/index.ts",
      outDir: output,
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        external: ['ws', 'bufferutil', 'utf-8-validate'],
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          chunkFileNames: "[name]-[hash].cjs",
          manualChunks(id) {
            if (id.includes("/packages/opencli-vendor/"))
              return id.endsWith("/cli-manifest.json") || id.endsWith('/cindy/catalog.ts') || id.endsWith('/cindy/selection.json')
                ? "browser-recipe-catalog"
                : "browser-recipes";
          },
        },
      },
    },
  });
  const require = createRequire(import.meta.url);
  const { catalog, loadAdapter } = require(path.join(output, "index.cjs"));
  for (const entry of catalog) await loadAdapter(`${entry.site}/${entry.name}`);
  const chunks = [];
  for (const name of await readdir(output)) {
    if (!name.endsWith('.cjs')) continue;
    const bytes = await readFile(path.join(output, name));
    chunks.push({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
  }
  console.log(JSON.stringify({ ok: true, bundledCommands: catalog.length, chunks,
    bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    note: 'Isolated adapter build, including reachable dependencies; not the complete installer delta or Cindy JSON recipes.' }));
} finally {
  await rm(output, { recursive: true, force: true });
}
