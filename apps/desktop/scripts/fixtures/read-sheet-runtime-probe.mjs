// Run the real synchronous packaging helpers outside the Vitest worker so
// large dependency trees cannot starve its RPC event loop on Windows.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyRuntimeDependencyTrees } from '../../forge-runtime-deps.ts';
import { prunePackagedRuntime } from '../../forge-prune-runtime.ts';
import { READ_SHEET_RUNTIME_PACKAGES } from '../../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps.ts';

const desktopRoot = fileURLToPath(new URL('../../', import.meta.url));
const workspaceRequire = createRequire(import.meta.url);
const temp = process.argv[2];
if (!temp) throw new Error('missing staging directory');

function packageDirectory(name, fromDirs) {
  const options = { paths: fromDirs ?? [desktopRoot] };
  for (const manifest of [`${name}/package.json`, `${name}/package`]) {
    try {
      return path.dirname(workspaceRequire.resolve(manifest, options));
    } catch { /* Some packages do not export their manifest. */ }
  }
  let entry;
  try {
    entry = workspaceRequire.resolve(name, options);
  } catch {
    const hoisted = path.resolve(desktopRoot, '../../node_modules', name);
    if (fs.existsSync(path.join(hoisted, 'package.json'))) return hoisted;
    throw new Error(`cannot resolve package directory: ${name}`);
  }
  let current = path.dirname(entry);
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`cannot resolve package directory: ${name}`);
}

copyRuntimeDependencyTrees(
  [...READ_SHEET_RUNTIME_PACKAGES, 'discord.js'],
  path.join(temp, 'node_modules'),
  packageDirectory,
);
process.stderr.write('runtime dependencies staged\n');
prunePackagedRuntime(temp);
process.stderr.write('runtime dependencies pruned\n');

const stagedRequire = createRequire(path.join(temp, 'probe.cjs'));
const ExcelJS = stagedRequire('exceljs');
const JSZip = stagedRequire('jszip');
const { Client, GatewayIntentBits, EmbedBuilder } = stagedRequire('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
if (new EmbedBuilder().setTitle('ok').toJSON().title !== 'ok') throw new Error('Discord builder');
await client.destroy();
const workbook = new ExcelJS.Workbook();
workbook.addWorksheet('Sheet1').addRow(['ok']);
const bytes = await workbook.xlsx.writeBuffer();
const zip = await JSZip.loadAsync(bytes);
process.stdout.write(zip.file('xl/workbook.xml') ? 'ok' : 'missing');
