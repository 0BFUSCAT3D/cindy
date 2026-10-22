import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUploadFiles, resolveRecipeOutputPath } from '../rsb-webview-upload-policy.js';

let tempRoot = '';
let allowedRoot = '';
let outsideRoot = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-upload-test-'));
  allowedRoot = path.join(tempRoot, 'workspace');
  outsideRoot = path.join(tempRoot, 'outside');
  await fs.mkdir(allowedRoot);
  await fs.mkdir(outsideRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('resolveUploadFiles', () => {
  // #6826: output paths need not exist yet. Existing upload-only cases cannot
  // detect writes via missing children, symlink parents or absent SSH roots.
  // Real host resolver, unit tier; smallest failure is one outside output path.
  it('resolves missing task outputs and rejects outside, sensitive and remote-only paths', async () => {
    expect(resolveRecipeOutputPath(path.join('new', 'report.txt'), [allowedRoot]))
      .toBe(path.join(await fs.realpath(allowedRoot), 'new', 'report.txt'));
    for (const candidate of [path.join(outsideRoot, 'new', 'report.txt'), path.join(allowedRoot, '.git', 'config'), path.join(allowedRoot, '.env')]) {
      expect(() => resolveRecipeOutputPath(candidate, [allowedRoot])).toThrow();
    }
    expect(() => resolveRecipeOutputPath('report.txt', [])).toThrow('local session directory');
    const link = path.join(allowedRoot, 'linked-output');
    await fs.symlink(outsideRoot, link, 'junction');
    expect(() => resolveRecipeOutputPath(path.join(link, 'new', 'report.txt'), [allowedRoot]))
      .toThrow('inside the current session directory');
    const broken = path.join(allowedRoot, 'broken-output');
    await fs.symlink(path.join(outsideRoot, 'missing'), broken, 'junction');
    expect(() => resolveRecipeOutputPath(path.join(broken, 'report.txt'), [allowedRoot])).toThrow();
  });

  it('accepts ordinary files inside an allowed root', async () => {
    const file = path.join(allowedRoot, 'report.txt');
    await fs.writeFile(file, 'hello');

    await expect(resolveUploadFiles([file], [allowedRoot])).resolves.toEqual([
      await fs.realpath(file),
    ]);
  });

  it('rejects files outside the session roots and sensitive names', async () => {
    const outside = path.join(outsideRoot, 'outside.txt');
    const secret = path.join(allowedRoot, '.env.local');
    await fs.writeFile(outside, 'outside');
    await fs.writeFile(secret, 'TOKEN=not-real');

    await expect(resolveUploadFiles([outside], [allowedRoot])).rejects.toThrow(
      'inside the current session directory',
    );
    await expect(resolveUploadFiles([secret], [allowedRoot])).rejects.toThrow(
      'blocked for sensitive file',
    );
  });

  it('resolves links before checking containment', async () => {
    const outside = path.join(outsideRoot, 'linked.txt');
    const linkDir = path.join(allowedRoot, 'linked-outside');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outsideRoot, linkDir, 'junction');

    await expect(
      resolveUploadFiles([path.join(linkDir, 'linked.txt')], [allowedRoot]),
    ).rejects.toThrow('inside the current session directory');
  });
});
