import {
  acquireSchemaMigrationReaderLease,
  acquireSchemaMigrationWriterLease,
} from '../../schemaMigrationLease';
import fs from 'node:fs';

const [dbFilePath, kind, mode] = process.argv.slice(2);
if (!dbFilePath || (kind !== 'reader' && kind !== 'writer')) {
  throw new Error('usage: schemaLeaseChild <db-path> <reader|writer>');
}

async function main() {
  if (mode === 'compete') {
    await new Promise<void>((resolve) => {
      process.once('message', () => resolve());
      process.send?.({ type: 'prepared' });
    });
  }
  if (mode === 'crash-after-gate-publish') {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === `${dbFilePath}.schema-transition`) process.exit(17);
    };
  }
  if (mode === 'crash-during-gate-release') {
    const rmdir = fs.rmdirSync;
    fs.rmdirSync = (directory) => {
      if (directory === `${dbFilePath}.schema-transition`) process.exit(17);
      rmdir(directory);
    };
  }
  if (mode === 'crash-before-publish' || mode === 'crash-after-publish') {
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (to === `${dbFilePath}.schema-writer.lock`) {
        if (mode === 'crash-after-publish') link(from, to);
        process.exit(17);
      }
      link(from, to);
    };
  }
  const result =
    kind === 'reader'
      ? await acquireSchemaMigrationReaderLease(dbFilePath)
      : await acquireSchemaMigrationWriterLease(dbFilePath);
  if (!result.acquired) {
    process.send?.({ type: 'failed', reason: result.reason });
    process.exit(2);
  }

  process.send?.({ type: 'ready', kind });
  process.on('message', (message) => {
    if (message !== 'release') return;
    result.lease.release();
    process.exit(0);
  });
  setInterval(() => undefined, 60_000);
}
void main();
