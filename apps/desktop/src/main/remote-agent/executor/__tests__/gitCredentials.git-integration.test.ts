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
import { GitCredentialHistory } from '../gitCredentials';

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

const GIT_ENV_KEYS = ['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const savedEnv = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-git-credentials-')));
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
