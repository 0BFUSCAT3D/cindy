// Value: PR #7047's new CLI must not capture another checkout or leak known
// identities. Existing whoami/restart tests do not cover screenshot selection,
// masking or its transactional cleanup. Minimal failures: two matching instances,
// a mismatched listener PID, a one-letter name inside UI text, a rejected capture.
// Tier: unit; pure functions and in-memory CDP, no processes/network/filesystem.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parseArgs, parseMask, captureClip, screenshot } from '../desktop-screenshot.mjs';
import { assertPortOwner, parseListeners, readLinuxListeners, selectInstance } from '../desktop-screenshot/instances.mjs';
import { identifyDesktopProcesses } from '../desktop-whoami.mjs';
import { collectIdentities, createReplacer } from '../desktop-screenshot/masking.mjs';

const root = path.resolve('checkout-a');
const a = { pid: 11, rootDir: root, userDataDir: path.resolve('CindyGlobal-dev2-alpha'), ready: true, ports: [19401] };
const b = { ...a, pid: 22, rootDir: path.resolve('checkout-b'), userDataDir: path.resolve('CindyGlobal-dev2-beta'), ports: [19402] };

test('default selection stays in this checkout; explicit selectors disambiguate', () => {
  assert.equal(selectInstance([a, b], {}, root).pid, 11);
  assert.equal(selectInstance([a, b], { port: 19402 }, root).pid, 22);
  assert.equal(selectInstance([a, b], { sandbox: 'beta' }, root).pid, 22);
  assert.equal(selectInstance([a, b], { worktree: b.rootDir }, root).pid, 22);
  assert.throws(() => selectInstance([a, { ...b, rootDir: root }], {}, root), /多个/);
  assert.throws(() => selectInstance([b], {}, root), /没有匹配/);
  assert.throws(() => selectInstance([{ ...a, ports: [] }], {}, root), /没有可用的 CDP/);
  assert.throws(() => selectInstance([{ ...a, ready: false }], {}, root), /尚未就绪/);
  assert.throws(() => selectInstance([a, b], { port: 19402, worktree: root }, root), /没有匹配/);
});

test('port ownership requires a single exact PID; parse macOS and Windows listener reports', () => {
  const selected = { ...a, port: 19401 };
  assertPortOwner(selected, [{ pid: 11, port: 19401 }]);
  for (const listeners of [[], [{ pid: 22, port: 19401 }], [{ pid: 11, port: 19401 }, { pid: 22, port: 19401 }]]) assert.throws(() => assertPortOwner(selected, listeners), /不属于/);
  assert.deepEqual(parseListeners('p11\nf5\nn127.0.0.1:19401\np22\nn[::1]:19402\nn*:19403\n', 'darwin'), [{ pid: 11, port: 19401 }, { pid: 22, port: 19402 }, { pid: 22, port: 19403 }]);
  assert.deepEqual(parseListeners('{"OwningProcess":11,"LocalPort":19401}', 'win32'), [{ pid: 11, port: 19401 }]);
});

test('Linux port ownership reads procfs without optional system commands', () => {
  const io = {
    readFileSync(file) {
      return 'sl local_address rem_address st tx_queue rx tr tm retr uid timeout inode\n'
        + (file.endsWith('tcp6') ? '0: 00000000000000000000000001000000:4BCA 00000000:0 0A 0:0 0:0 0 1000 0 102\n'
          : '0: 0100007F:4BC9 00000000:0 0A 0:0 0:0 0 1000 0 101\n1: 0100007F:4BCC 00000000:0 01 0:0 0:0 0 1000 0 103\n');
    },
    readdirSync(file) { if (file === '/proc') return ['net', '11', '22', '33']; if (file.includes('/33/')) throw Error('exited'); return ['0', '1', '2']; },
    readlinkSync(file) { if (file.endsWith('/0')) return '/dev/null'; return file.includes('/11/') ? 'socket:[101]' : 'socket:[102]'; },
  };
  assert.deepEqual(readLinuxListeners(io), [{ pid: 11, port: 19401 }, { pid: 22, port: 19402 }]);
  assertPortOwner({ ...a, port: 19401 }, readLinuxListeners(io));
});

test('arguments reject invalid input without echoing sensitive values', () => {
  const o = parseArgs(['--', '--port=19401', '--mask', 'Private=Example=literal', '--mask', 'Other=', '--keep', 'Public', '--selector', 'main', '--padding', '8']);
  assert.equal(o.port, 19401);
  assert.deepEqual(o.masks.map(r => r.replacement), ['Example=literal', '']);
  assert.deepEqual(o.keep, ['Public']);
  for (const args of [['--port', '0'], ['--port', '65536'], ['--padding', '-1'], ['--mask'], ['--no-mask', '--keep', 'private'], ['--private-person']]) {
    assert.throws(() => parseArgs(args), error => !error.message.includes('private-person'));
  }
  assert.throws(() => parseMask('private@example.test'), error => !error.message.includes('@'));
});

test('longest matching is stable, short names have Unicode boundaries, email ignores case', () => {
  const r = createReplacer([
    { source: 'Alice', replacement: '用户 A', category: 'person' },
    { source: 'Alice Smith', replacement: '用户 B', category: 'person' },
    { source: 'A', replacement: '用户 C', category: 'person' },
    { source: '小王', replacement: '用户 D', category: 'person' },
    { source: 'Alice@private.test', replacement: 'user-a@example.com', category: 'email' },
  ]);
  assert.equal(r.replace('Alice Smith / Alice, Alice! A / API 小王 / 小王子 alice@PRIVATE.test'), '用户 B / 用户 A, 用户 A! 用户 C / API 用户 D / 小王子 user-a@example.com');
  assert.equal(r.count('API 小王子'), 0);
  assert.equal(r.count('ALICE@private.test'), 1);
});

test('keep exempts whole rules; explicit mappings override automatic sources without cascading', () => {
  const r = createReplacer([
    { source: 'Long Name', replacement: 'Other Name', category: 'person' },
    { source: 'Other Name', replacement: 'Person B', category: 'person' },
    { source: 'Secret', replacement: 'Person C', category: 'person' },
    { source: 'Secret', replacement: 'Explicit', category: 'custom' },
  ], ['Long Name']);
  assert.equal(r.replace('Long Name / Other Name / Secret'), 'Long Name / Person B / Explicit');
  assert.equal(createReplacer([{ source: 'Alice', replacement: 'Bob', category: 'person' }, { source: 'Bob', replacement: 'Charlie', category: 'person' }]).replace('Alice'), 'Bob');
});

test('newly displayed emails, home paths and invitation links receive stable examples', () => {
  const r = createReplacer([]);
  assert.equal(r.replace('x@private.test'), r.replace('X@PRIVATE.test'));
  assert.equal(r.count(r.replace('x@private.test')), 0);
  for (const value of ['/Users/private/project', 'C:\\Users\\private\\project', 'https://relay.example.test/provider-share/join#secret', 'cindy://shared-task/join?invitation=secret']) {
    const masked = r.replace(value);
    assert.notEqual(masked, value);
    assert.equal(r.count(masked), 0);
  }
  assert.equal(createReplacer([], ['x@private.test']).replace('x@private.test'), 'x@private.test');
});

function fixtureApi() {
  return {
    authListAccounts: async () => ({ accounts: [{ displayName: 'Owner', email: 'owner@private.test', avatarUrl: 'https://example.test/avatar', isCurrent: true }] }),
    deviceLink: { listDevices: async () => ({ devices: [{ name: 'Private Laptop', deviceId: 'device-private' }] }) },
    providerShare: { command: async c => c.action === 'owned' ? { shares: [{ shareId: 'share-private', members: [{ displayName: 'Guest' }], requests: [] }] } : { received: [{ shareId: 'received-private', owner: { displayName: 'Sharer' }, deviceName: 'Remote Laptop' }] } },
    sharedTask: { account: async c => c.action === 'get' ? { memberLabels: [{ displayName: 'Member' }] } : [{ sharedTaskId: 'shared-private' }] },
  };
}
test('collector uses account/device/share/member projections and rejects failed collection', async () => {
  const api = fixtureApi();
  const result = await collectIdentities(api, { home: '/home/private', username: 'private', hostname: 'Private Host' });
  for (const source of ['Owner', 'Guest', 'Sharer', 'Member', 'Private Laptop', 'share-private', '/home/private']) assert.ok(result.entries.some(e => e.source === source));
  assert.equal(result.avatars.length, 1);
  api.deviceLink.listDevices = async () => { throw new Error('network'); };
  await assert.rejects(collectIdentities(api, { home: '', username: '' }));
});

test('logged-out mock does not call cloud APIs; account change fails closed', async () => {
  const api = { authListAccounts: async () => ({ accounts: [] }) };
  assert.equal((await collectIdentities(api, { home: '', username: '' })).loggedIn, false);
  let calls = 0;
  api.authListAccounts = async () => ({ accounts: calls++ ? [{ displayName: 'New' }] : [] });
  await assert.rejects(collectIdentities(api, { home: '', username: '' }), /account-changed/);
});

test('selector clips to viewport and does not change its device scale', () => {
  assert.deepEqual(captureClip({ viewportWidth: 100, viewportHeight: 80, x: -5, y: 10, width: 30, height: 40 }, 4), { x: 0, y: 6, width: 29, height: 48, scale: 1 });
  assert.throws(() => captureClip({ viewportWidth: 100, viewportHeight: 80, x: 150, y: 0, width: 20, height: 20 }), /窗口外/);
});

test('capture failure still restores, collection failure never captures, residual blocks output', async () => {
  for (const failure of ['capture', 'collection', 'residual']) {
    let restored = false, captured = false;
    const client = { evaluate: async expression => {
      if (expression.includes('__cindyDesktopScreenshotLock')) return true;
      if (expression.includes('collectIdentities')) {
        if (failure === 'collection') throw new Error('collection');
        return { rules: 1, avatars: 0, loggedIn: false };
      }
      if (expression.includes('Boolean(window[')) return failure !== 'collection';
      if (expression.includes('?.restore()')) { restored = true; return { failures: 0 }; }
      if (expression.includes('?.audit()')) return { residual: failure === 'residual' ? 1 : 0, fault: false };
      return { viewportWidth: 100, viewportHeight: 100, dpr: 2 };
    } };
    await assert.rejects(screenshot(client, parseArgs([]), {}, { capture: async () => { captured = true; throw new Error('capture'); } }));
    assert.equal(captured, failure === 'capture');
    assert.equal(restored, failure !== 'collection');
  }
});

test('whoami reads requested CDP ports from this instance renderer arguments', () => {
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'Electron');
  const app = path.join(root, 'apps', 'desktop');
  const instances = identifyDesktopProcesses([
    { pid: 11, ppid: 1, command: `${electron} .` },
    { pid: 12, ppid: 11, command: `${electron} --type=renderer --app-path=${app} --remote-debugging-port=19401` },
    { pid: 22, ppid: 1, command: `${electron} --type=renderer --remote-debugging-port=19402` },
  ], [{ rootDir: root, branch: 'test' }]);
  assert.deepEqual(instances[0].cdpPorts, [19401]);
});

test('observer rescans do not mistake generated examples for short names or local usernames', () => {
  const r = createReplacer([
    { source: 'A', replacement: '用户 A', category: 'person' },
    { source: 'user', replacement: '示例用户', category: 'username' },
    { source: 'a@private.test', replacement: 'user-1@example.com', category: 'email' },
  ]);
  const once = r.replace('A user a@private.test');
  assert.equal(r.replace(once), once);
  assert.equal(r.count(once), 0);
  assert.equal(r.count('A'), 1);
});

test('short known names match Chinese sentences but not unrelated longer words', () => {
  const r = createReplacer([{ source: '小王', replacement: '用户 A', category: 'person' },
    { source: 'A', replacement: '用户 B', category: 'person' }]);
  assert.equal(r.replace('移除小王？正在复制到小王；小王子；移除A？API'), '移除用户 A？正在复制到用户 A；小王子；移除用户 B？API');
  assert.equal(r.count('移除小王？'), 1);
});

test('explicit example text is stable when it contains the original text', () => {
  const r = createReplacer([{ source: '内部项目', replacement: '示例内部项目', category: 'custom' }]);
  const first = r.replace('内部项目');
  assert.equal(first, '示例内部项目');
  assert.equal(r.replace(first), first);
  assert.equal(r.count(first), 0);
  assert.equal(r.count('内部项目'), 1);
  const prefixed = createReplacer([{ source: '开发电脑', replacement: '电脑 A', category: 'device' },
    { source: '内部项目', replacement: '开发', category: 'custom' }]);
  assert.equal(prefixed.replace('开发电脑 / 内部项目'), '电脑 A / 开发');
  assert.equal(prefixed.count('开发电脑'), 1);
  const emailPrefix = createReplacer([{ source: '内部项目', replacement: 'contact-1@example.com', category: 'custom' }]);
  assert.equal(emailPrefix.replace('contact-1@example.com.invalid'), 'contact-1@example.com');
  assert.equal(emailPrefix.count('contact-1@example.com.invalid'), 1);
  assert.equal(emailPrefix.count('contact-1@example.com'), 0);
  assert.equal(emailPrefix.count('contact-1@example.com '.repeat(3000)), 0);
  const userDemo = createReplacer([{ source: 'demo', replacement: '示例用户', category: 'local' }]);
  const link = userDemo.replace('cindy://provider-share/join?shareId=synthetic');
  assert.equal(link, 'https://example.com/share/demo');
  assert.equal(userDemo.replace(link), link);
  assert.equal(userDemo.count(link), 0);
});
