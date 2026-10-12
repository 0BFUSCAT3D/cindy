/**
 * 供应商分享的受邀者任务：git 查看内容的命令在本机核实仓库读不到凭证类文件时不弹卡(gitCredentials.ts)。
 * 用真实的 git 仓库验证扫描范围(历史、reflog、stash、暂存区)与各种照旧弹卡的情况。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shareCredentialGitReads } from '../../credentials';
import { RemoteExecutor } from '../executor';
import { ExecutorGate, type ExecutorAction } from '../gate';
import { GitCredentialHistory } from '../gitCredentials';
import { ExecutorWorkspace } from '../workspace';

// Windows 上每次 spawn git 要数百毫秒。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 60_000 });

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function write(file: string, content = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(message: string, ...files: string[]): void {
  for (const file of files) write(file);
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', message);
}

/** 按分享任务的判定取出要核实的 git 调用，再交给本机核实。 */
async function provesSafe(history: GitCredentialHistory, command: string, cwd = repo): Promise<boolean> {
  const reads = shareCredentialGitReads(command, [repo], { cwd, platform: process.platform });
  expect(reads, command).not.toBeNull();
  return history.provesSafe(command, reads ?? []);
}

async function requiresCredentialConfirmation(history: GitCredentialHistory, command: string): Promise<void> {
  const workspace = new ExecutorWorkspace({ workingDir: repo });
  const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
  const confirm = vi.fn(async () => false);
  const executor = new RemoteExecutor({
    workspace,
    gate,
    rgPath: 'rg',
    tempDir: path.join(root, 'executor'),
    confirm,
    gitCredentials: history,
  });
  const action: ExecutorAction = { kind: 'exec', command, cwd: repo };
  try {
    expect(gate.authorize(action).ok, command).toBe(false);
    expect(await executor.confirm(action), command).toBe(false);
    expect(confirm, command).toHaveBeenCalledExactlyOnceWith(action);
    expect(gate.authorize(action).ok, command).toBe(false);
  } finally {
    await executor.close();
  }
}

const GIT_ENV_KEYS = ['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const savedEnv = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-git-credentials-')));
  vi.stubEnv('PATH', (process.env.PATH ?? '').split(path.delimiter).map((entry) => path.resolve(entry)).join(path.delimiter));
  // 临时目录的上层也可能是 git 仓库(比如整个用户目录)：不往上找。开发机自己的全局与系统 git 配置
  // 也不读，免得里面的令牌影响结果。
  process.env.GIT_CEILING_DIRECTORIES = root;
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@xdt.local');
  git('config', 'user.name', 'XDT Test');
  git('config', 'core.autocrlf', 'false');
  commit('init', 'src/app.ts', 'README.md', '.env.example', 'deploy/id_rsa.pub');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of GIT_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GitCredentialHistory', () => {
  it('lets content commands run in a repository that never had credential files', async () => {
    const history = new GitCredentialHistory();
    commit('more', 'src/util.ts');
    write('src/app.ts', 'changed\n');
    for (const command of ['git diff', 'git log -p', 'git show HEAD', 'git grep -n x', 'git diff --cached', 'git log -p --all | head -50']) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    // 子目录里跑也是同一个仓库。
    expect(await provesSafe(history, 'git log -p', path.join(repo, 'src'))).toBe(true);
  });

  // git grep 只看扫描结果(不按会显示的文件再核对)，用它验证扫描范围。
  it('finds credential files anywhere in history: deleted, only in the reflog, in a stash or staged', async () => {
    // 提交过又删掉。
    let history = new GitCredentialHistory();
    commit('add env', '.env');
    git('rm', '-q', '.env');
    git('commit', '-q', '--no-gpg-sign', '-m', 'drop env');
    expect(await provesSafe(history, 'git grep -n x')).toBe(false);

    // 只剩在 reflog 里。
    fs.rmSync(path.join(root, 'repo'), { recursive: true, force: true });
    fs.mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'test@xdt.local');
    git('config', 'user.name', 'XDT Test');
    commit('init', 'src/app.ts');
    history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git grep -n x')).toBe(true);
    commit('key', 'certs/server.key');
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(await provesSafe(history, 'git grep -n x')).toBe(false);

    // 在 stash 里。
    history = new GitCredentialHistory();
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    expect(await provesSafe(history, 'git grep -n x')).toBe(true);
    write('.npmrc');
    git('add', '.npmrc');
    git('stash', '-q');
    expect(await provesSafe(history, 'git grep -n x')).toBe(false);

    // 只在暂存区。
    history = new GitCredentialHistory();
    git('stash', 'drop', '-q');
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    write('.env.local');
    git('add', '.env.local');
    expect(await provesSafe(history, 'git diff --cached')).toBe(false);
  });

  it('lets commands limited to paths that never held credential files run', async () => {
    const history = new GitCredentialHistory();
    commit('fixtures', 'test/fixtures/server.key', 'src/lib/index.ts');
    for (const command of [
      'git log -p -- src/app.ts',
      'git log -p -- src',
      'git diff HEAD~1 -- src/lib README.md',
      "git grep -n x -- '*.ts'",
      'git show HEAD -- src',
      // 没写 `--` 时按会显示的文件核对。
      'git log -p src/app.ts',
    ]) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    for (const command of [
      'git log -p',
      'git log -p -- .',
      'git log -p -- test',
      "git grep -n x -- '*'",
      "git grep -n x -- 't*/fixtures'",
      'git show HEAD:src/app.ts -- src',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    // 在子目录里跑时，路径按子目录解释。
    expect(await provesSafe(history, 'git log -p -- lib', path.join(repo, 'src'))).toBe(true);
    expect(await provesSafe(history, 'git log -p -- fixtures', path.join(repo, 'test'))).toBe(false);
  });

  it('checks the files a command would show when the repository has credential files', async () => {
    const history = new GitCredentialHistory();
    // 像多数 pnpm / npm 项目一样提交了 .npmrc。
    commit('npmrc', '.npmrc');
    commit('code', 'src/util.ts');
    write('src/app.ts', 'changed\n');
    for (const command of [
      'git diff',
      'git diff HEAD',
      'git diff HEAD~1 HEAD',
      'git show HEAD',
      'git log -p -1',
      'git log -p src/app.ts',
      'git log -p -n 1 src/app.ts',
      'git log -p --author=XDT -- src',
    ]) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    for (const command of [
      'git show HEAD~1',
      'git log -p -2',
      'git log -p',
      'git log -p --graph -1',
      'git diff --stat -p',
      // 选项的取值恰好是个文件名：插入的选项可能被它当成取值，不这样核对。
      'git log -p -S README.md',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    write('.npmrc', 'changed\n');
    expect(await provesSafe(history, 'git diff')).toBe(false);
    // 直接写出文件对象时显示的是内容本身。
    git('tag', '-a', 'blob-tag', '-m', 't', git('rev-parse', 'HEAD:src/util.ts').trim());
    expect(await provesSafe(history, 'git show blob-tag')).toBe(false);
    expect(await provesSafe(history, 'git show blob-tag -- src')).toBe(false);
  });

  it('does not trust path-limited full diffs or commits outside the scanned history', async () => {
    const history = new GitCredentialHistory();
    const visible = git('rev-parse', 'HEAD').trim();
    expect(await provesSafe(history, 'git log -p')).toBe(true);

    write('.aws/credentials');
    git('add', '.aws/credentials');
    const hiddenTree = git('write-tree').trim();
    git('reset', '-q', 'HEAD', '--', '.aws/credentials');
    fs.rmSync(path.join(repo, '.aws', 'credentials'));
    const hidden = execFileSync('git', ['commit-tree', hiddenTree, '-p', visible], {
      cwd: repo,
      encoding: 'utf8',
      input: 'hidden\n',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    expect(await provesSafe(history, 'git show ' + hidden)).toBe(false);

    const fullDiffHistory = new GitCredentialHistory();
    write('README.md', 'changed\n');
    write('.aws/credentials');
    git('add', '-A');
    git('commit', '-q', '--no-gpg-sign', '-m', 'mixed');
    expect(await provesSafe(fullDiffHistory, 'git log -p -- README.md')).toBe(true);
    expect(await provesSafe(fullDiffHistory, 'git log -p --full-diff -- README.md')).toBe(false);
  });

  it('keeps confirmation for a dangling credential blob outside every scanned commit', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    write('.env', 'PRIVATE_FIXTURE=unreachable-content\n');
    const blob = git('hash-object', '-w', '.env').trim();
    fs.rmSync(path.join(repo, '.env'));
    expect(git('ls-files', '--', '.env')).toBe('');
    expect(git('rev-list', '--all', '--reflog', '--objects')).not.toContain(blob);
    expect(git('show', blob)).toContain('PRIVATE_FIXTURE=unreachable-content');
    for (const command of [
      'git show ' + blob,
      'git show ' + blob + ' -- README.md',
      'git show -s ' + blob,
      'git show --name-only ' + blob,
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent when implicit HEAD names a blob instead of a commit', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show')).toBe(true);
    write('.env', 'PRIVATE_FIXTURE=implicit-blob\n');
    const blob = git('hash-object', '-w', '.env').trim();
    git('update-ref', 'refs/tags/fixture-blob', blob);
    git('symbolic-ref', 'HEAD', 'refs/tags/fixture-blob');
    for (const args of [[], ['-s'], ['--name-only'], ['--', 'README.md']]) {
      expect(git('show', ...args)).toContain('PRIVATE_FIXTURE=implicit-blob');
      const command = 'git show ' + args.join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('does not use replaced objects to prove the original history has no credentials', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    const safe = git('rev-parse', 'HEAD').trim();
    write('.env', 'PRIVATE_FIXTURE=original-history\n');
    git('add', '.env');
    git('commit', '-q', '--no-gpg-sign', '-m', 'original credentials');
    const original = git('rev-parse', 'HEAD').trim();
    git('replace', original, safe);
    git('reset', '--mixed', '-q', 'HEAD');
    expect(git('ls-files', '--', '.env')).toBe('');
    expect(git('show', 'HEAD')).not.toContain('PRIVATE_FIXTURE=original-history');
    expect(git('--no-replace-objects', 'show', 'HEAD')).toContain('PRIVATE_FIXTURE=original-history');
    for (const command of ['git --no-replace-objects show HEAD', 'git show HEAD']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    git('replace', '-d', original);
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/custom-replace/');
    git('replace', original, safe);
    expect(await provesSafe(history, 'git --no-replace-objects show HEAD')).toBe(false);
    await requiresCredentialConfirmation(history, 'git --no-replace-objects show HEAD');
  });

  it.runIf(process.platform !== 'win32')('does not exempt a tracked template symlink to an ignored credential file', async () => {
    write('.gitignore', '.env\n');
    write('.env', 'PRIVATE_FIXTURE=symlink-target\n');
    fs.rmSync(path.join(repo, '.env.example'));
    fs.symlinkSync('.env', path.join(repo, '.env.example'));
    git('add', '.gitignore', '.env.example');
    git('commit', '-q', '--no-gpg-sign', '-m', 'template link');
    expect(git('ls-files', '--', '.env')).toBe('');
    expect(git('ls-files', '--stage', '--', '.env.example')).toMatch(/^120000 /);
    const history = new GitCredentialHistory();
    for (const command of [
      'cat .env.example',
      'cat < .env.example',
      'git diff && cat .env.example',
      'git grep -f .env.example -- README.md',
      'git blame --contents .env.example README.md',
    ]) {
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent when --bare selects a different repository in the same directory', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    const bare = path.join(root, 'bare');
    git('init', '--bare', '-q', bare);
    for (const entry of fs.readdirSync(bare)) {
      expect(fs.existsSync(path.join(repo, entry))).toBe(false);
      fs.cpSync(path.join(bare, entry), path.join(repo, entry), { recursive: true });
    }
    write('.env', 'PRIVATE_FIXTURE=bare-history\n');
    git('--bare', 'config', 'user.email', 'fixture@example.com');
    git('--bare', 'config', 'user.name', 'Fixture');
    const blob = git('--bare', 'hash-object', '-w', '.env').trim();
    const tree = execFileSync('git', ['--bare', 'mktree'], {
      cwd: repo, encoding: 'utf8', input: '100644 blob ' + blob + '\t.env\n',
    }).trim();
    const revision = git('--bare', 'commit-tree', tree, '-m', 'bare fixture').trim();
    git('--bare', 'update-ref', 'HEAD', revision);
    git('--bare', 'config', 'http.extraHeader', 'PRIVATE_FIXTURE=bare-config');
    expect(git('show', 'HEAD', '--')).not.toContain('PRIVATE_FIXTURE=bare-history');
    expect(git('--bare', 'show', 'HEAD')).toContain('PRIVATE_FIXTURE=bare-history');
    expect(git('config', '--list')).not.toContain('PRIVATE_FIXTURE=bare-config');
    expect(git('--bare', 'config', '--list')).toContain('PRIVATE_FIXTURE=bare-config');
    for (const command of ['git --bare show HEAD', 'git --bare config --list']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent for attached, abbreviated and clustered config-source flags', async () => {
    const file = path.join(root, 'alternate.config');
    fs.writeFileSync(file, '[http]\nextraHeader = PRIVATE_FIXTURE=alternate-config\n');
    const blob = git('hash-object', '-w', file).trim();
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    for (const args of [
      ['-f' + file, '--list'],
      ['-lf' + file],
      ['--fil=' + file, '--list'],
      ['--fil', file, '--list'],
      ['--blo=' + blob, '--list'],
      ['--fil', file, 'http.extraHeader'],
      ['--file', file, '--type', 'path', 'http.extraHeader'],
      ['-f' + file, '--type', 'path', 'http.extraHeader'],
      ['--blo', blob, 'http.extraHeader'],
    ]) {
      expect(git('config', ...args)).toContain('PRIVATE_FIXTURE=alternate-config');
      const command = 'git config ' + args.map((arg) => JSON.stringify(arg)).join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent for implicit config reads with value-taking options and stdin sources', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git config --type path user.name')).toBe(true);
    git('config', 'user.password', 'PRIVATE_FIXTURE=implicit-config');
    expect(git('config', '--type', 'path', 'user.password')).toContain('PRIVATE_FIXTURE=implicit-config');
    await requiresCredentialConfirmation(history, 'git config --type path user.password');
    if (process.platform === 'win32') return;
    const input = '[http]\nextraHeader = PRIVATE_FIXTURE=stdin-config\n';
    for (const args of [['--fil', '/dev/stdin', 'http.extraHeader'], ['-f/dev/stdin', '--type', 'path', 'http.extraHeader']]) {
      const output = execFileSync('git', ['config', ...args], { cwd: repo, input, encoding: 'utf8' });
      expect(output).toContain('PRIVATE_FIXTURE=stdin-config');
      const command = "printf '[http]\\nextraHeader = PRIVATE_FIXTURE=stdin-config\\n' | git config " + args.join(' ');
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('does not mistake abbreviated regexp queries for literal config keys', async () => {
    const history = new GitCredentialHistory();
    git('config', 'http.extraHeader', 'PRIVATE_FIXTURE=regexp-query');
    expect(await provesSafe(history, 'git config --get user.name')).toBe(true);
    for (const option of ['--get-r', '--get-reg']) {
      expect(git('config', option, '.*')).toContain('PRIVATE_FIXTURE=regexp-query');
      const command = 'git config ' + option + " '.*'";
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('does not exempt a git read after an earlier shell segment may change state', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git add -A && git diff --cached')).toBe(false);
    // A read-only segment before another read does not invalidate the probe.
    expect(await provesSafe(history, 'git diff && git diff --cached')).toBe(true);
  });

  it('does not exempt a git read hidden behind shell substitution or xargs', async () => {
    const history = new GitCredentialHistory();
    for (const command of [
      'git diff $(git add -A)',
      'git diff ' + String.fromCharCode(96) + 'git add -A' + String.fromCharCode(96),
      'git diff >(git add -A)',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
  });

  it('lets commands that print the git config run only while the config holds no secrets', async () => {
    const history = new GitCredentialHistory();
    const token = ['ghp_', '0123456789abcdefghijABCDEFGHIJ012345'].join('');
    const printing = ['git remote -v', 'git remote get-url origin', 'git config --list', 'git config --get remote.origin.url'];
    git('remote', 'add', 'origin', 'https://github.com/a/b.git');
    for (const command of [...printing, 'git config user.name']) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    // 远程地址里嵌着令牌：打出地址与整份配置的要问，只读别的键的不用。
    git('remote', 'set-url', 'origin', `https://me:${token}@github.com/a/b.git`);
    for (const command of printing) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    expect(await provesSafe(history, 'git config user.name')).toBe(true);
    // 令牌藏在地址改写规则的键名里、或在 http 头里。
    git('remote', 'set-url', 'origin', 'https://github.com/a/b.git');
    git('config', `url.https://${token}@github.com/.insteadOf`, 'https://github.com/');
    expect(await provesSafe(history, 'git remote -v')).toBe(false);
    git('config', '--unset', `url.https://${token}@github.com/.insteadOf`);
    git('config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic eDp5');
    expect(await provesSafe(history, 'git remote -v')).toBe(true);
    expect(await provesSafe(history, 'git config --list')).toBe(false);
    // 全局配置也算。
    git('config', '--unset', 'http.https://github.com/.extraheader');
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    git('config', '--global', 'sendemail.smtppass', 'hunter2');
    expect(await provesSafe(history, 'git config --list')).toBe(false);
    expect(await provesSafe(history, 'HOME=' + path.join(root, 'other-home') + ' git config --list')).toBe(false);
    expect(await provesSafe(history, 'XDG_CONFIG_HOME=' + path.join(root, 'other-config') + ' git remote -v')).toBe(false);
  });

  it('fails closed for path selectors that exceed the bounded matcher', async () => {
    const history = new GitCredentialHistory();
    const selector = 'a*'.repeat(20) + 'b';
    const started = Date.now();
    expect(await provesSafe(history, 'git log -p -- ' + selector)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps confirmation when env removes variables or clears the environment', async () => {
    const history = new GitCredentialHistory();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[http]\n\textraHeader = global-runtime-fixture\n');
    const systemConfig = path.join(root, 'system-gitconfig');
    fs.writeFileSync(systemConfig, '[http]\n\textraHeader = system-runtime-fixture\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'xdg'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    const removedEnv = { ...process.env };
    delete removedEnv.GIT_CONFIG_GLOBAL;
    delete removedEnv.GIT_CONFIG_NOSYSTEM;
    const output = execFileSync('git', ['config', '--list'], { cwd: repo, env: removedEnv, encoding: 'utf8' });
    expect(output).toContain('http.extraheader=global-runtime-fixture');
    expect(output).toContain('http.extraheader=system-runtime-fixture');
    for (const command of [
      'env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM git config --list',
      'env -uGIT_CONFIG_GLOBAL git config --list',
      'env --unset GIT_CONFIG_GLOBAL git config --list',
      'env --unset=GIT_CONFIG_GLOBAL git config --list',
      'env -u HOME git diff',
      'env -i git config --list',
      'env --ignore-environment git diff --cached',
      'env - git config --list',
      'exec -c git config --list',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps confirmation for explicit executables, wrappers and runtime overrides', async () => {
    const history = new GitCredentialHistory();
    const executable = path.join(repo, 'git');
    write('git', '#!/bin/sh\nprintf "runtime-mismatch\\n"\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(executable, 0o755);
      expect(execFileSync(executable, ['diff'], { cwd: repo, encoding: 'utf8' })).toBe('runtime-mismatch\n');
    }
    expect(await provesSafe(history, 'git diff')).toBe(true);
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    for (const command of [
      './git diff',
      './git config --list',
      '"' + executable + '" diff',
      '/usr/bin/git config --list',
      'git.exe diff',
      'GIT diff',
      'PATH=/other/bin git diff',
      'env PATH=/other/bin git config --list',
      'LD_PRELOAD=/other/lib.so git diff',
      'DYLD_INSERT_LIBRARIES=/other/lib.dylib git config --list',
      'command -p git diff',
      'env git config --list',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps confirmation when the inherited PATH has a relative search directory', async () => {
    const history = new GitCredentialHistory();
    const command = 'git diff';
    expect(await provesSafe(history, command)).toBe(true);
    vi.stubEnv('PATH', '.' + path.delimiter + process.env.PATH);
    expect(await provesSafe(history, command)).toBe(false);
    await requiresCredentialConfirmation(history, command);
  });

  it('keeps asking where the scan does not reach', async () => {
    const history = new GitCredentialHistory();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'a.txt'), 'a');
    for (const command of [
      'GIT_DIR=/other/.git git log -p',
      'git diff --no-index a b',
      `git diff ${path.join(outside, 'a.txt')} src/app.ts`,
      'git log -p ORIG_HEAD',
      'git grep --recurse-submodules x',
      'git log -p $(cat revs)',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    // 不在 git 仓库里。
    expect(await provesSafe(history, 'git log -p', outside)).toBe(false);
    // 认不出目录。
    expect(await history.provesSafe('git log -p', [{ sub: 'log', args: ['-p'] }])).toBe(false);
    // 带子模块。
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD').trim()},vendor/lib`);
    expect(await provesSafe(history, 'git log -p')).toBe(false);
  });

  it('does not keep the command waiting past the limit', async () => {
    const history = new GitCredentialHistory({ waitMs: 0 });
    expect(await provesSafe(history, 'git log -p')).toBe(false);
    // 扫描在后台继续；等它结束再清理(Windows 上 git 进程占着目录时删不掉)。
    await vi.waitFor(() => fs.rmSync(root, { recursive: true, force: true }), { timeout: 30_000, interval: 200 });
  });
});
