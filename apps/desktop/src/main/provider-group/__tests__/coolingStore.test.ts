/**
 * 组内电脑冷却的落盘(docs/product-rules/provider-groups.md §5)：写入要和所在文件当前内容合并
 * (按 provider + 成员取较晚结束时间)，不能直接用调用方那份快照覆盖——否则连续冷却两台电脑时，
 * 早开始、后拿到文件锁的写入会把已经落地的那一台冷却挤丢(greptile-apps P1, PR #5792 review)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-cooling-store-test-'));

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
  activeOwnerScopeKey: () => 'owner-test',
}));

const coolingStore = await import('../coolingStore.js');

describe('mergeCooling', () => {
  const { mergeCooling } = coolingStore.__testing;

  it('keeps both members when they are in different snapshots', () => {
    expect(mergeCooling(
      { anthropic: { 'device:mini:a': 1_000 } },
      { anthropic: { 'device:studio:a': 2_000 } },
    )).toEqual({
      anthropic: { 'device:mini:a': 1_000, 'device:studio:a': 2_000 },
    });
  });

  it('keeps the later end time for the same member instead of blindly overwriting', () => {
    // 旧快照里这一台冷却到 5000，调用方这次只带着更早算出的 3000(比如基于稍旧的内存状态)：
    // 不应该把已经落地的更晚结束时间往回改。
    expect(mergeCooling(
      { anthropic: { 'device:mini:a': 5_000 } },
      { anthropic: { 'device:mini:a': 3_000 } },
    )).toEqual({
      anthropic: { 'device:mini:a': 5_000 },
    });
    expect(mergeCooling(
      { anthropic: { 'device:mini:a': 3_000 } },
      { anthropic: { 'device:mini:a': 5_000 } },
    )).toEqual({
      anthropic: { 'device:mini:a': 5_000 },
    });
  });

  it('merges across providers too', () => {
    expect(mergeCooling(
      { anthropic: { a: 1 } },
      { openai: { b: 2 } },
    )).toEqual({ anthropic: { a: 1 }, openai: { b: 2 } });
  });
});

describe('writeProviderGroupCooling (real file)', () => {
  it('keeps an earlier cooldown instead of discarding it on the next write (greptile-apps P1)', async () => {
    // 模拟 PR 场景:两台电脑先后撞上限额。修复前的实现每次 updateAtomic 都是整份覆盖,
    // 谁最后拿到锁谁就是最终结果;修复后每次写入在锁内和当前文件内容合并,谁先谁后都不会挤丢对方。
    coolingStore.writeProviderGroupCooling({ anthropic: { 'device:studio:a': 2_000 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    coolingStore.writeProviderGroupCooling({ anthropic: { 'device:mini:a': 1_000 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(coolingStore.readProviderGroupCooling()).toEqual({
      anthropic: { 'device:studio:a': 2_000, 'device:mini:a': 1_000 },
    });
  });
});
