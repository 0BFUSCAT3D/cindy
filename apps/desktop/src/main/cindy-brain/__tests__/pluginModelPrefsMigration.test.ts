/**
 * pluginModelPrefsMigration.test.ts — 旧布局 → 升级后:插件详情「Cindy 能力」的
 * 逐项钉档(ghost-cindy-prefs.json `overrides`)一次性迁移到插件唯一的「模型」
 * 字段(ghost-errand-prefs.json `errand`)。真实落盘,不 mock 存储层。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ root: '', id: 'owner-a' }));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(owner.root, owner.id, ...parts),
  activeOwnerScopeKey: () => owner.id,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

const cindy = await import('../cindyPrefsStore.js');
const task = await import('../pluginTaskPrefsStore.js');

const CINDY_FILE = 'ghost-cindy-prefs.json';
const TASK_FILE = 'ghost-errand-prefs.json';

function writeJson(file: string, value: unknown): void {
  const target = path.join(owner.root, owner.id, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

function readJson(file: string): unknown {
  const target = path.join(owner.root, owner.id, file);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : undefined;
}

beforeEach(() => {
  owner.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-model-migration-'));
  owner.id = 'owner-a';
  cindy.__testing.resetStore();
  task.__testing.resetLegacyPinMigration();
  task.setPluginTaskPreferencesResolver(() => true);
});

afterEach(() => {
  task.setPluginTaskPreferencesResolver(() => true);
  fs.rmSync(owner.root, { recursive: true, force: true });
});

describe('per-plugin Host configuration opt-out', () => {
  it('ignores all saved defaults for the opted-out instance while another instance stays unchanged', () => {
    const saved = { agentKind: 'codex', model: 'saved', providerId: 'source', effort: 'high', fastMode: true,
      permissionMode: 'auto', workingDir: path.join(owner.root, 'project') };
    writeJson(TASK_FILE, { errand: { '_root__ping': saved, '_ns__acme__ping': saved }, sessions: { '_root__ping': 'existing-task' } });
    task.setPluginTaskPreferencesResolver(id => id !== '_root__ping');
    expect(task.readPluginTaskConfig('_root__ping')).toEqual({});
    expect(task.readPluginTaskPermissionMode('_root__ping')).toBeNull();
    expect(task.readPluginTaskConfig('_ns__acme__ping')).toEqual(saved);
    expect(task.readPluginTaskPermissionMode('_ns__acme__ping')).toBe('auto');
    expect(() => task.writePluginTaskConfig('_root__ping', { model: 'replacement' })).toThrow('PLUGIN_TASK_PREFERENCES_DISABLED');
    expect(() => task.writePluginTaskConfig('_root__ping', null)).toThrow('PLUGIN_TASK_PREFERENCES_DISABLED');
    expect(task.readGhostErrandSessionId('_root__ping')).toBe('existing-task');
    expect(readJson(TASK_FILE)).toMatchObject({ errand: { '_root__ping': saved } });
    task.setPluginTaskPreferencesResolver(() => true);
    expect(task.readPluginTaskConfig('_root__ping')).toEqual(saved);
  });

  it('does not create preference files or run legacy migration when the instance opts out', () => {
    const legacy = { overrides: { ping: { 'text.oneshot': 'cat:xd:codex:old' } } };
    writeJson(CINDY_FILE, legacy);
    task.setPluginTaskPreferencesResolver(id => id !== 'ping');
    expect(task.readPluginTaskConfig('ping')).toEqual({});
    expect(() => task.writePluginTaskConfig('ping', { permissionMode: 'auto' })).toThrow('PLUGIN_TASK_PREFERENCES_DISABLED');
    expect(readJson(TASK_FILE)).toBeUndefined();
    expect(readJson(CINDY_FILE)).toEqual(legacy);
  });
});

describe('legacy per-ability pins → plugin model preference', () => {
  it('migrates catalog pins, drops profile keys and media overrides, keeps other keys', () => {
    // 旧布局:快问快答目录钉 / 轻量档位键 / 媒体与向量覆盖 / 并发上限 / 未知键。
    writeJson(CINDY_FILE, {
      overrides: {
        writer: { 'text.oneshot': 'cat:openai:codex:gpt-5.5', 'image.generate': 'gpt-image-2' },
        claude: { 'text.oneshot': 'cat:my%3Arelay:claude-code:claude/sonnet:latest' },
        profile: { 'text.oneshot': 'codex-gpt-5.4-mini' },
        broken: { 'text.oneshot': 'cat:broken' },
        art: { 'image.edit': 'media:xd:gpt-image-2', 'embed.text': 'emb-1' },
        chosen: { 'text.oneshot': 'cat:xd:codex:gpt-5.5' },
      },
      inflightLimits: { writer: 2 },
      futureKey: { keep: true },
    });
    writeJson(TASK_FILE, {
      errand: {
        writer: { permissionMode: 'acceptEdits', workingDir: '/project', effort: 'high', fastMode: true },
        chosen: { agentKind: 'pi', providerId: 'local', model: 'qwen', permissionMode: 'auto' },
      },
      sessions: { writer: 'session-1' },
    });

    expect(task.readPluginTaskConfig('writer')).toEqual({
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.5',
      permissionMode: 'acceptEdits',
      workingDir: '/project',
    });
    expect(task.readPluginTaskConfig('claude')).toEqual({
      agentKind: 'cc',
      providerId: 'my:relay',
      model: 'claude/sonnet:latest',
    });
    // 用户已为任务显式选过模型:不覆盖。
    expect(task.readPluginTaskConfig('chosen')).toEqual({
      agentKind: 'pi', providerId: 'local', model: 'qwen', permissionMode: 'auto',
    });
    // 轻量档位键、解码失败与媒体/向量覆盖直接丢弃 = 跟随系统默认。
    expect(task.readPluginTaskConfig('profile')).toEqual({});
    expect(task.readPluginTaskConfig('broken')).toEqual({});
    expect(task.readPluginTaskConfig('art')).toEqual({});
    expect(task.readGhostErrandSessionId('writer')).toBe('session-1');

    // 旧文件删掉 overrides,其它键原样保留;旧版本读到缺键 = 无覆盖。
    expect(readJson(CINDY_FILE)).toEqual({ inflightLimits: { writer: 2 }, futureKey: { keep: true } });
    expect(cindy.readGhostCindyInflightLimit('writer')).toBe(2);
    expect(cindy.readLegacyOneshotPins()).toBeNull();
  });

  it('is idempotent and never re-applies a pin after the user changes the model', () => {
    writeJson(CINDY_FILE, { overrides: { writer: { 'text.oneshot': 'cat:xd:codex:gpt-5.5' } } });
    expect(task.readPluginTaskConfig('writer')).toMatchObject({ model: 'gpt-5.5' });
    // 迁移后旧文件已无内容可留,整份删除。
    expect(readJson(CINDY_FILE)).toBeUndefined();
    task.writePluginTaskConfig('writer', null);
    task.__testing.resetLegacyPinMigration();
    expect(task.readPluginTaskConfig('writer')).toEqual({});
  });

  it('runs on first write too, before the written config is computed', () => {
    writeJson(CINDY_FILE, { overrides: { writer: { 'text.oneshot': 'cat:xd:codex:gpt-5.5' } } });
    expect(task.writePluginTaskConfig('other', { permissionMode: 'auto' })).toEqual({ permissionMode: 'auto' });
    expect(readJson(TASK_FILE)).toMatchObject({
      errand: {
        writer: { agentKind: 'codex', providerId: 'xd', model: 'gpt-5.5' },
        other: { permissionMode: 'auto' },
      },
    });
  });

  it('migrates each owner scope separately', () => {
    writeJson(CINDY_FILE, { overrides: { writer: { 'text.oneshot': 'cat:xd:codex:gpt-5.5' } } });
    expect(task.readPluginTaskConfig('writer')).toMatchObject({ model: 'gpt-5.5' });
    owner.id = 'owner-b';
    writeJson(CINDY_FILE, { overrides: { writer: { 'text.oneshot': 'cat:openai:codex:gpt-5.4' } } });
    expect(task.readPluginTaskConfig('writer')).toMatchObject({ providerId: 'openai', model: 'gpt-5.4' });
  });

  it('leaves an unreadable legacy file untouched and reads current config', () => {
    const target = path.join(owner.root, owner.id, CINDY_FILE);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not json');
    writeJson(TASK_FILE, { errand: { writer: { permissionMode: 'auto' } } });
    expect(task.readPluginTaskConfig('writer')).toEqual({ permissionMode: 'auto' });
    expect(fs.readFileSync(target, 'utf8')).toBe('{not json');
  });
});
