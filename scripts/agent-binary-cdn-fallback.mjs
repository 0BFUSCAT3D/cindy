/**
 * agent-binary-cdn-fallback — 当上游（downloads.claude.ai / api.github.com）慢或失败时，
 * 从公司 CDN/OSS 兜底下载 claude / codex / ripgrep 二进制。
 *
 * 背景：release 时已把 claude/codex 以 .gz 上传到 CDN（国内访问快）；ripgrep 也可按相同
 * 裸二进制 .gz 约定预置到 CDN。CDN 上的 .gz gunzip 后与上游裸二进制字节一致，所以兜底无正确性损失。
 *
 * CDN 约定同步自 apps/desktop/scripts/release-{claude-code,codex,ripgrep}.mjs：
 *   .gz  : ${CDN_BASE}/<pathPrefix>/<version>/<platformKey>/<binaryName>.gz
 *          (claude → claude-code, codex → codex, ripgrep → ripgrep;
 *           binaryName = win32 ? '<base>.exe' : '<base>')
 *   清单 : ${CDN_BASE}/manifest-<platformKey>-canary.json (404 回退 stable manifest-<platformKey>.json)
 *          字段 claudeCode / codex / ripgrep = { version, file, sha256(.gz 的), size, binarySha256(裸二进制的) }
 *
 * 校验信任链与正式版运行时（apps/desktop/src/main/agent-binaries/factory.ts）一致：
 *   下载的 .gz 校验 sha256 → gunzip → 解压后二进制校验 binarySha256。两层校验都必须存在并
 *   通过；manifest 缺失、版本不匹配或 checksum 非法时 fail closed，不下载也不落地可执行文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

import { fetchJsonWithTimeout, downloadToFileWithTimeout, createDownloadProgressLogger } from '../tools/shared/fetch-with-timeout.mjs';
import { loadEndpointManifestBaseUrl } from './shared/client-endpoint-build-env.mjs';

/** 每次调用读 env，便于 home→office 切换与测试注入（语义对齐 manifestService.getBaseUrl）。 */
function getCdnBase() {
  return (
    process.env.XDT_CDN_BASE_URL?.trim().replace(/\/+$/, '') ||
    loadEndpointManifestBaseUrl({ authRegion: process.env.CINDY_AUTH_REGION })
  );
}

// kind → CDN 路径前缀 / 二进制基名 / manifest 顶层字段
const KIND_CDN = {
  claude: { pathPrefix: 'claude-code', base: 'claude', manifestField: 'claudeCode' },
  codex: { pathPrefix: 'codex', base: 'codex', manifestField: 'codex' },
  ripgrep: { pathPrefix: 'ripgrep', base: 'rg', manifestField: 'ripgrep' },
};

/** win32 平台二进制带 .exe 后缀（与 ensure-agent-binaries / release 脚本约定一致）。 */
function binFileFor(base, platformKey) {
  return platformKey.startsWith('win32') ? `${base}.exe` : base;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 拉 CDN manifest，返回该 kind 在期望 version 下的 asset（含 sha256 / binarySha256）。
 * manifest 拉不到、404、或 version 不匹配都返回 null，由调用方 fail closed。
 */
async function tryGetManifestAsset(manifestField, platformKey, version) {
  const cdnBase = getCdnBase();
  for (const suffix of ['-canary', '']) {
    const url = `${cdnBase}/manifest-${platformKey}${suffix}.json?t=${encodeURIComponent(version)}`;
    try {
      const manifest = await fetchJsonWithTimeout(url, {}, { totalTimeoutMs: 10_000 });
      const asset = manifest?.[manifestField];
      if (asset && asset.version === version) return asset;
    } catch {
      /* manifest 拉不到/404/解析失败：换下一个 suffix，最终返回 null */
    }
  }
  return null;
}

/**
 * 从 CDN 兜底下载 <kind> 在 <platformKey> 平台、<version> 版本的二进制到 <binPath>。
 * 成功时 binPath 落地为可执行裸二进制（与上游一致）；失败抛错（含 sha256 mismatch）。
 * 返回 { url, gzVerified, binaryVerified }。
 */
export async function downloadFromCdn({ kind, version, platformKey, binPath }) {
  const cfg = KIND_CDN[kind];
  if (!cfg) throw new Error(`CDN fallback not supported for kind: ${kind} (only claude / codex / ripgrep)`);

  const binFile = binFileFor(cfg.base, platformKey);
  const gzUrl = `${getCdnBase()}/${cfg.pathPrefix}/${version}/${platformKey}/${binFile}.gz`;

  const asset = await tryGetManifestAsset(cfg.manifestField, platformKey, version);
  const normalizeSha256 = (value) => (
    typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null
  );
  const expectedGzSha = normalizeSha256(asset?.sha256);
  const expectedBinSha = normalizeSha256(asset?.binarySha256);
  if (!expectedGzSha || !expectedBinSha) {
    throw new Error(
      `CDN manifest has no trusted checksums for ${kind} ${platformKey}@${version}; refusing unverified executable download`,
    );
  }

  const gzTmp = `${binPath}.gz.tmp`;
  const binTmp = `${binPath}.tmp`;
  fs.mkdirSync(path.dirname(binPath), { recursive: true });

  try {
    // 1. 下载 .gz：用独立的宽松超时，**不继承**上游的 XDT_AGENTBIN_* env。
    //    上游超时可被调激进（为尽早放弃上游、快回退）；CDN 是兜底最后一道，给它充分时间，
    //    否则"上游激进超时"会连带把 CDN 也误伤。
    //    total 与上游下载同口径 30min：二进制已到百 MB 级，旧 180s 在 CDN 吞吐
    //    <~600KB/s 时会掐断"慢但一直有进展"的正常下载；"连不上/死挂"仍由
    //    connect/stall 快速兜底，total 只防"无限拖"。吞吐下限显式传 0 禁用——
    //    CDN 已是最后一道，嫌它慢也没有更快的去处，掐断只会让整体失败。
    const progress = createDownloadProgressLogger(`${kind} ${platformKey} CDN`);
    try {
      await downloadToFileWithTimeout(gzUrl, gzTmp, {}, {
        connectTimeoutMs: 15_000,
        stallTimeoutMs: 20_000,
        totalTimeoutMs: 1_800_000,
        minThroughputBytesPerSec: 0,
        onProgress: progress.onProgress,
      });
    } finally {
      progress.finish();
    }

    // 2. 校验 .gz 的 sha256（与正式版运行时一致的信任链入口）
    const actualGzSha = await sha256File(gzTmp);
    if (actualGzSha !== expectedGzSha) {
      throw new Error(`CDN .gz sha256 mismatch for ${kind} ${platformKey}@${version}: expected ${expectedGzSha}, got ${actualGzSha}`);
    }

    // 3. gunzip → 裸二进制
    await pipeline(fs.createReadStream(gzTmp), createGunzip(), fs.createWriteStream(binTmp));

    // 4. 校验解压后二进制的 binarySha256
    const actualBinSha = await sha256File(binTmp);
    if (actualBinSha !== expectedBinSha) {
      throw new Error(`CDN binary sha256 mismatch for ${kind} ${platformKey}@${version}: expected ${expectedBinSha}, got ${actualBinSha}`);
    }

    // 5. 原子替换 + chmod（win32 不需要）
    fs.renameSync(binTmp, binPath);
    if (!binFile.endsWith('.exe')) {
      try { fs.chmodSync(binPath, 0o755); } catch { /* ignore */ }
    }

    return { url: gzUrl, gzVerified: true, binaryVerified: true };
  } finally {
    try { fs.rmSync(gzTmp, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(binTmp, { force: true }); } catch { /* ignore */ }
  }
}
