import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import * as wire from '../../shared/pluginContributionContract.js';
import type {
  ContributionInstallationBinding,
  ContributionReleaseView,
  ContributionTransferView,
  MyPluginDetailView,
  MyPluginFilter,
  MyPluginLocalInstallation,
  MyPluginPageView,
  MyPluginReleasePageView,
  MyPluginView,
} from '../../shared/pluginContributions.js';
import {
  ghostInstallApprovalToken,
  ghostPermissionItems,
  validateGhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import {
  findInstalledGhostByInstanceId,
  installedGhostStoragePart,
} from '../../shared/pluginIdentity.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { isPassiveSharedUserDataInstance, onAuthStateChange } from '../authManager.js';
import { getGhostManager } from '../cindy-brain/index.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { onQuit } from '../lifecycle.js';
import { putLocalFile } from '../plugin-publisher/putObject.js';
import { PluginMarketLedger } from '../plugin-market/ledger.js';
import { ServerApiError } from '../serverApiClient.js';
import { isIpcError, isIpcErrorCode } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { ContributionApi } from './api.js';
import {
  assertContributionOwner,
  assertPreparedInstallation,
  assertPreparedContent,
  contributionAccountKey,
  contributionOwnerKey,
  getPreparedContribution,
  prepareInstalledContribution,
  releasePreparedContribution,
  readContributionInstallation,
} from './prepared.js';

const preparedSchema = z.object({
  preparedId: z.string(),
  instanceId: z.string(),
  pluginId: z.string().nullable(),
  ghostId: z.string(),
  name: z.string(),
  description: z.string(),
  releaseNotes: z.string().optional(),
  preflight: wire.contributionPreflight.optional(),
  version: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
});
const recordSchema = z.object({
  localId: z.string(),
  owner: z.string(),
  accountKey: z.string(),
  prepared: preparedSchema,
  key: z.string(),
  request: wire.contributionRequest,
  directory: z.string(),
  approvalToken: z.string(),
  contentSha256: z.string().optional(),
  installationDir: z.string(),
  phase: z.enum(['prepared', 'uploaded', 'committing', 'processing', 'terminal']),
  stage: z.enum(['prepared', 'uploading', 'processing', 'paused', 'complete']),
  operationId: z.string().nullable(),
  operation: wire.contributionOperation.nullable(),
  errorCode: z.string().nullable(),
});
type RecordEntry = z.infer<typeof recordSchema>;
interface Journal {
  owner: string;
  file: string;
  records: RecordEntry[];
}
const journals = new Map<string, Journal>();
const pending = new Map<
  string,
  { owner: string; controller: AbortController; task: Promise<void> }
>();
const preparedTargets = new Map<string, { owner: string; request: wire.ContributionRequest }>();
let hooked = false;

function journal(owner = contributionOwnerKey()): Journal {
  assertContributionOwner(owner);
  const existing = journals.get(owner);
  if (existing) return existing;
  const accountKey = contributionAccountKey();
  const file = ownerScopedUserDataPath(
    'plugin-contributions',
    `${crypto.createHash('sha256').update(accountKey).digest('hex').slice(0, 20)}.v1.json`,
  );
  let records: RecordEntry[] = [];
  try {
    records = z
      .array(recordSchema)
      .parse(JSON.parse(fs.readFileSync(file, 'utf8')))
      .filter((entry) => entry.accountKey === accountKey)
      .map((entry) => ({ ...entry, owner }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throwIpcError('PRECONDITION_FAILED', 'Contribution recovery journal cannot be read');
  }
  const value = { owner, file, records };
  journals.set(owner, value);
  if (!hooked) {
    hooked = true;
    const abort = () => {
      for (const run of pending.values()) run.controller.abort();
    };
    onAuthStateChange(() => {
      for (const run of pending.values()) {
        try {
          assertContributionOwner(run.owner);
        } catch {
          run.controller.abort();
        }
      }
    });
    onQuit('plugin-contributions', abort, 'sync');
  }
  return value;
}

function persist(book: Journal): void {
  assertContributionOwner(book.owner);
  assertWritableInstance();
  fs.mkdirSync(path.dirname(book.file), { recursive: true });
  const temporary = `${book.file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(book.records), { mode: 0o600 });
  fs.renameSync(temporary, book.file);
}
function view(record: RecordEntry): ContributionTransferView {
  return {
    localId: record.localId,
    prepared: record.prepared,
    stage: record.stage,
    operation: record.operation,
    errorCode: record.errorCode,
  };
}
function locate(id: string): { book: Journal; record: RecordEntry } {
  const book = journal();
  const record = book.records.find((entry) => entry.localId === id);
  if (!record) throwIpcError('NOT_FOUND', 'Contribution operation not found for this account');
  return { book, record };
}
function safeCode(error: unknown): string {
  if (isIpcError(error)) return error.code;
  if (
    error instanceof ServerApiError &&
    (wire.CONTRIBUTION_ERROR_CODES as readonly string[]).includes(error.code)
  )
    return error.code;
  return 'INTERNAL';
}
export function mapContributionError(error: unknown): never {
  if (isIpcError(error)) throw error;
  const code = safeCode(error);
  throwIpcError(isIpcErrorCode(code) ? code : 'INTERNAL', 'Community contribution request failed');
}

function assertWritableInstance(): void {
  if (isPassiveSharedUserDataInstance())
    throwIpcError('PRECONDITION_FAILED', 'Use the active Cindy instance for contribution recovery');
}

function running(record: RecordEntry): boolean {
  return pending.get(record.localId)?.owner === record.owner;
}

function assertClientPublishingTarget(plugin: Pick<wire.MyPluginSummary, 'publisherKind'>): void {
  if (plugin.publisherKind === 'official')
    throwIpcError('OFFICIAL_PLUGIN_GITHUB_REQUIRED', 'Submit official public plugins through GitHub to keep repository source complete and maintainable');
}

/** Resolve an existing public target only through a server-authorized identity, never package authorship. */
export async function prepareContribution(
  instanceId: string,
  source: 'manual' | 'ai',
  expected?: ContributionInstallationBinding,
) {
  assertWritableInstance();
  const api = new ContributionApi();
  const initial = readContributionInstallation(instanceId, expected);
  const binding = { directory: initial.ghost.dir, approvalToken: ghostInstallApprovalToken(initial.ghost.approval) };
  const targetId = initial.source.kind === 'public-market' ? initial.source.pluginId : null;
  // A downloaded package needs current publishing ACL BEFORE reading its bytes.
  if (targetId) {
    const target = await api.detail(targetId);
    assertClientPublishingTarget(target.plugin);
    if (!target.plugin.actions.canSubmit || target.plugin.pluginId !== targetId ||
      target.plugin.ghostId !== initial.ghost.manifest.id || target.plugin.namespace !== initial.ghost.namespace)
      throwIpcError('PERMISSION_DENIED', 'Publishing permission required');
    assertContributionOwner(api.owner);
    const current = readContributionInstallation(instanceId, binding);
    if (JSON.stringify(current.source) !== JSON.stringify(initial.source))
      throwIpcError('PRECONDITION_FAILED', 'Publishing source changed');
  }
  // Also bind callers without a Renderer-supplied binding across asynchronous pruning.
  const prepared = await prepareInstalledContribution(instanceId, source, binding);
  const entry = getPreparedContribution(prepared.preparedId);
  try {
    const preflight = await api.preflight({
      pluginId: targetId ?? prepared.pluginId,
      ghostId: prepared.ghostId,
      version: prepared.version,
      hasReleaseNotes: Boolean(prepared.releaseNotes?.trim()),
    });
    assertPreparedInstallation(entry);
    if (preflight.target.pluginId) {
      const target = await api.detail(preflight.target.pluginId);
      assertClientPublishingTarget(target.plugin);
      if (!target.plugin.actions.canSubmit) throwIpcError('PERMISSION_DENIED', 'Publishing permission required');
      assertPreparedInstallation(entry);
    }
    prepared.pluginId = preflight.target.pluginId;
    prepared.preflight = preflight;
    const request: wire.ContributionRequest = {
      sizeBytes: prepared.sizeBytes,
      sha256: prepared.sha256,
      source,
      target: preflight.target,
    };
    preparedTargets.set(prepared.preparedId, { owner: api.owner, request });
    return prepared;
  } catch (error) {
    await releasePreparedContribution(prepared.preparedId);
    throw error;
  }
}

export async function discardContribution(preparedId: string): Promise<void> {
  const entry = getPreparedContribution(preparedId);
  // Once submitted, the durable transfer owns these bytes until its terminal cleanup.
  if (entry.pinned) return;
  preparedTargets.delete(preparedId);
  await releasePreparedContribution(preparedId);
}

export async function submitContribution(
  preparedId: string,
  assertCaller?: () => Promise<void>,
): Promise<ContributionTransferView> {
  assertWritableInstance();
  const entry = getPreparedContribution(preparedId);
  assertPreparedInstallation(entry);
  if (!entry.summary.preflight?.actions.canSubmit) {
    const blocker = entry.summary.preflight?.blockers[0];
    const code = blocker?.code;
    throwIpcError(
      code && isIpcErrorCode(code) ? code : 'PRECONDITION_FAILED',
      blocker?.message ?? 'Refresh the publishing summary before submitting',
    );
  }
  await assertPreparedContent(entry);
  await assertCaller?.();
  assertPreparedInstallation(entry);
  const target = preparedTargets.get(preparedId);
  if (!target || target.owner !== entry.owner)
    throwIpcError('PRECONDITION_FAILED', 'Prepare this contribution again explicitly');
  const book = journal(entry.owner);
  const existing = book.records.find((item) => item.localId === preparedId || (
    item.phase !== 'terminal' &&
    item.prepared.instanceId === entry.summary.instanceId &&
    item.installationDir === entry.installationDir && item.approvalToken === entry.approvalToken &&
    JSON.stringify(item.request.target) === JSON.stringify(target.request.target) &&
    item.request.source === target.request.source &&
    (item.request.sha256 === target.request.sha256 ||
      (Boolean(entry.contentSha256) && item.contentSha256 === entry.contentSha256))
  ));
  if (existing) {
    // A normal submit of the same package reuses its pending request internally.
    // ZIP timestamps may differ, so compare the verified content fingerprint too.
    if (existing.localId !== preparedId) await discardContribution(preparedId);
    assertContributionOwner(entry.owner);
    start(book, existing, assertCaller);
    return view(existing);
  }
  if (book.records.filter((item) => item.phase !== 'terminal').length >= 16)
    throwIpcError('PRECONDITION_FAILED', 'Too many unfinished contributions');
  const record: RecordEntry = {
    localId: preparedId,
    owner: entry.owner,
    accountKey: contributionAccountKey(),
    prepared: entry.summary,
    key: entry.idempotencyKey,
    request: target.request,
    directory: entry.directory,
    approvalToken: entry.approvalToken,
    contentSha256: entry.contentSha256,
    installationDir: entry.installationDir,
    phase: 'prepared',
    stage: 'prepared',
    operationId: null,
    operation: null,
    errorCode: null,
  };
  // Persist the key and immutable request BEFORE the first remote write.
  book.records.push(record);
  persist(book);
  entry.pinned = true;
  start(book, record, assertCaller);
  return view(record);
}

function start(book: Journal, record: RecordEntry, assertCaller?: () => Promise<void>): void {
  assertContributionOwner(record.owner);
  assertWritableInstance();
  if (running(record) || record.phase === 'terminal') return;
  pending.get(record.localId)?.controller.abort();
  record.stage = record.phase === 'prepared' ? 'prepared' : 'processing';
  record.errorCode = null;
  persist(book);
  const controller = new AbortController();
  const task = run(book, record, controller, assertCaller)
    .catch((error) => {
      try {
        assertContributionOwner(record.owner);
      } catch {
        return;
      }
      record.stage = 'paused';
      record.errorCode = safeCode(error);
      // A disk error remains visible in memory; never let a detached task reject.
      try {
        persist(book);
      } catch {
        record.errorCode = 'INTERNAL';
      }
    })
    .finally(() => {
      if (pending.get(record.localId)?.task === task) pending.delete(record.localId);
    });
  pending.set(record.localId, { owner: record.owner, controller, task });
}

function isTerminal(record: RecordEntry): boolean {
  return record.phase === 'terminal';
}

async function accept(book: Journal, record: RecordEntry, operation: wire.ContributionOperation): Promise<void> {
  assertContributionOwner(record.owner);
  if (record.operationId && operation.operationId !== record.operationId)
    throwIpcError('PRECONDITION_FAILED', 'Operation identity changed');
  if (
    operation.receipt &&
    (operation.receipt.uploadedPackage.sha256 !== record.request.sha256 ||
      operation.receipt.uploadedPackage.sizeBytes !== record.request.sizeBytes ||
      operation.receipt.ghostId !== record.request.target.ghostId ||
      operation.receipt.version !== record.request.target.version ||
      (record.request.target.pluginId !== null &&
        operation.receipt.pluginId !== record.request.target.pluginId))
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Contribution receipt does not match uploaded snapshot');
  }
  record.operationId = operation.operationId;
  record.operation = operation;
  if (['succeeded', 'failed', 'expired'].includes(operation.status)) {
    const cleanupDirectory = record.directory ? managedSnapshotDirectory(record.directory) : null;
    record.phase = 'terminal';
    record.stage = 'complete';
    record.errorCode = operation.failure?.code ?? null;
    void releasePreparedContribution(record.localId);
    if (cleanupDirectory)
      void fsp.rm(cleanupDirectory, { recursive: true, force: true }).catch(() => undefined);
    record.directory = '';
    preparedTargets.delete(record.localId);
  } else if (operation.status !== 'awaiting_upload') {
    record.phase = 'processing';
    record.stage = 'processing';
  }
  persist(book);
}

function managedSnapshotDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  const temp = path.resolve(app.getPath('temp'));
  if (path.dirname(absolute) !== temp || !path.basename(absolute).startsWith('cindy-contribution-'))
    throwIpcError('PRECONDITION_FAILED', 'Invalid contribution snapshot location');
  try {
    if (
      !fs.lstatSync(absolute).isDirectory() ||
      fs.lstatSync(absolute).isSymbolicLink() ||
      path.dirname(fs.realpathSync(absolute)) !== fs.realpathSync(temp)
    )
      throwIpcError('PRECONDITION_FAILED', 'Invalid contribution snapshot directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return absolute;
}

async function run(book: Journal, record: RecordEntry, controller: AbortController, assertCaller?: () => Promise<void>): Promise<void> {
  const signal = controller.signal;
  const api = new ContributionApi(assertCaller);
  if (api.owner !== record.owner) throwIpcError('OWNER_CHANGED', 'Contribution account changed');
  const assert = () => {
    assertContributionOwner(record.owner);
    if (signal.aborted)
      throwIpcError('MUTATION_CANCELLED', 'Upload stopped; existing operation retained');
  };
  assert();
  record.errorCode = null;
  // Unknown commit outcomes are always queried before any further action.
  if (record.operationId) await accept(book, record, await api.operation(record.operationId));
  if (isTerminal(record)) return;
  const assertInstallation = () => readContributionInstallation(record.prepared.instanceId, {
    directory: record.installationDir, approvalToken: record.approvalToken,
  });
  let authorizedSource: string | null = null;
  // The API invokes this after token/discovery/refresh awaits, immediately before
  // dispatch. A stale package or a newly restricted AI task cannot pass that gap.
  const writer = new ContributionApi(async () => {
    await assertCaller?.();
    assertWritableInstance();
    assert();
    if (!authorizedSource || JSON.stringify(assertInstallation().source) !== authorizedSource)
      throwIpcError('PRECONDITION_FAILED', 'Publishing source changed');
  });
  const assertWrite = async () => {
    assert();
    const { source } = assertInstallation();
    // Reading a detail/old receipt is not a current publishing grant. Check the
    // exact target again, including recovery that already passed the PUT stage.
    const id = source.kind === 'public-market' ? source.pluginId : record.request.target.pluginId;
    if (id) {
      const target = await api.detail(id);
      assertClientPublishingTarget(target.plugin);
      if (!target.plugin.actions.canSubmit || target.plugin.pluginId !== record.request.target.pluginId)
        throwIpcError('PERMISSION_DENIED', 'Publishing permission or target changed');
    }
    await assertCaller?.();
    assert();
    if (JSON.stringify(assertInstallation().source) !== JSON.stringify(source))
      throwIpcError('PRECONDITION_FAILED', 'Publishing source changed');
    authorizedSource = JSON.stringify(source);
  };
  if (record.phase === 'prepared') {
    await assertWrite();
    const response = await writer.prepare(record.request, record.key);
    assert();
    const { upload, ...operation } = response;
    await accept(book, record, wire.contributionOperation.parse(operation));
    if (isTerminal(record)) return;
    if (response.status === 'awaiting_upload') {
      if (!upload || new Date(upload.expiresAt).getTime() <= Date.now())
        throwIpcError(
          'PRECONDITION_FAILED',
          'Original upload ticket expired; query the original operation',
        );
      // URLs remain Main-only. Redirects and credential-bearing headers are refused.
      const url = new URL(upload.putUrl);
      let localUpload = false;
      if (app.isPackaged === false && url.protocol === 'http:') {
        const endpoint = new URL(getClientEndpoint('pluginApiBaseUrl'));
        // The existing dev-local storage adapter is the only HTTP exception:
        // an explicitly configured loopback server, the same origin and path.
        localUpload =
          endpoint.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
          !endpoint.username &&
          !endpoint.password &&
          url.origin === endpoint.origin &&
          url.pathname === '/dev-local/member-upload' &&
          !url.hash;
      }
      if (
        (url.protocol !== 'https:' && !localUpload) ||
        url.username ||
        url.password ||
        Object.keys(upload.headers).some((key) =>
          /^(authorization|proxy-authorization|cookie)$/i.test(key),
        )
      )
        throwIpcError('PRECONDITION_FAILED', 'Unsafe upload ticket');
      const directory = managedSnapshotDirectory(record.directory);
      const current = findInstalledGhostByInstanceId(
        getGhostManager().list(),
        record.prepared.instanceId,
      );
      if (
        !current ||
        current.dir !== record.installationDir ||
        current.namespace !== null ||
        current.namespaceState !== 'confirmed' ||
        ghostInstallApprovalToken(current.approval) !== record.approvalToken
      )
        throwIpcError(
          'PRECONDITION_FAILED',
          'Installed plugin changed; existing operation retained',
        );
      const handle = await fsp.open(
        path.join(directory, 'plugin.cindy'),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== record.request.sizeBytes)
          throwIpcError('PRECONDITION_FAILED', 'Original package snapshot unavailable');
        const bytes = await handle.readFile();
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.request.sha256)
          throwIpcError('PRECONDITION_FAILED', 'Original package snapshot changed');
        await assertWrite();
        record.stage = 'uploading';
        persist(book);
        await putLocalFile(handle, {
          putUrl: upload.putUrl,
          headers: upload.headers,
          sizeBytes: stat.size,
          signal,
          onBytes: () => {
            // A stream callback must abort the request rather than throw out of
            // Transform._transform and take down the Main process.
            try { assert(); assertInstallation(); } catch { controller.abort(); }
          },
        });
        assert();
        record.phase = 'uploaded';
        persist(book);
      } finally {
        await handle.close();
      }
    }
  }
  await assertWrite();
  if (!record.operationId) throwIpcError('PRECONDITION_FAILED', 'Original operation not known');
  // An explicit resume first queries above, then replays commit on the SAME
  // operation. GET alone cannot reclaim a released validation/publishing lease.
  record.phase = 'committing';
  record.stage = 'processing';
  persist(book);
  await writer.commit(record.operationId);
  assert();
  record.phase = 'processing';
  persist(book);
  // Only the active upload action is followed. Human review is NEVER polled.
  for (let attempt = 0; attempt < 8; attempt++) {
    assert();
    await accept(book, record, await api.operation(record.operationId));
    if (isTerminal(record)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000));
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  record.stage = 'paused';
  persist(book);
}

export function resumeContribution(id: string, assertCaller?: () => Promise<void>) {
  const { book, record } = locate(id);
  start(book, record, assertCaller);
  return view(record);
}
export function listContributionTransfers() {
  return journal().records.map((record) => ({
    ...view(record),
    stage: record.phase !== 'terminal' && !running(record) ? ('paused' as const) : record.stage,
  }));
}
export async function contributionTransferStatus(id: string) {
  const { book, record } = locate(id);
  if (record.operationId && !running(record)) {
    assertWritableInstance();
    await accept(book, record, await new ContributionApi().operation(record.operationId));
  }
  return {
    ...view(record),
    stage: record.phase !== 'terminal' && !running(record) ? ('paused' as const) : record.stage,
  };
}
export function cancelContribution(id: string): void {
  const { record } = locate(id);
  if (running(record)) pending.get(id)?.controller.abort();
}

function releaseView(
  value: wire.SubmissionView,
  content: wire.SubmissionContent | null,
): ContributionReleaseView {
  const parsed = content ? validateGhostManifest(content.manifest) : null;
  return {
    submissionId: value.submissionId,
    releaseId: value.releaseId,
    version: value.version,
    sha256: value.revision.sha256,
    revision: value.revision.displayUpdatedAt,
    revisionState: value.revisionState,
    reviewStatus: value.reviewStatus,
    submittedAt: value.submittedAt,
    approvedAt: value.approvedAt,
    cancelledAt: value.cancelledAt,
    canCancelReview: value.actions?.canCancelReview ?? false,
    reviewedAt: value.decidedAt,
    reason: value.reason,
    source: value.source ?? value.publishSource,
    content: content
      ? {
          name: content.manifest.name,
          description: content.manifest.description ?? '',
          iconUrl: content.icon?.url ?? null,
          permissions: parsed?.ok ? ghostPermissionItems(parsed.manifest) : [],
          // Preserve the complete server projection, including capabilities unknown to
          // this client, without inventing current content for historical submissions.
          manifestView: content.manifestView,
        }
      : null,
  };
}
function localPluginInstallation(value: wire.MyPluginSummary): MyPluginLocalInstallation {
  try {
    const manager = getGhostManager();
    manager.assertContributionReadAvailable(value.ghostId);
    const related = manager.list().filter(ghost => ghost.manifest.id === value.ghostId &&
      (ghost.namespace === value.namespace || ghost.namespaceState !== 'confirmed'));
    if (related.length === 0) return { state: 'missing' };
    const matches = related.filter(ghost => {
      if (ghost.namespaceState !== 'confirmed' || ghost.namespace !== value.namespace ||
        ghost.approval.state !== 'approved' || !ghost.publishingSource ||
        ghost.publishingSource.kind === 'unavailable') return false;
      if (ghost.publishingSource.kind === 'local') return true;
      return publicInstallationMatches(value, ghost);
    });
    if (matches.length === 1) {
      const ghost = matches[0];
      return { state: 'installed', instanceId: installedGhostStoragePart(ghost),
        version: ghost.manifest.version, enabled: ghost.enabled,
        origin: ghost.publishingSource?.kind === 'public-market' ? 'public' : 'local' };
    }
    return { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

function publicInstallationMatches(value: wire.MyPluginSummary, ghost: InstalledGhost): boolean {
  const ledger = new PluginMarketLedger(ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'));
  const lookup = ledger.lookupInstallationForAuthorization({ ghostId: ghost.manifest.id, namespace: ghost.namespace });
  if (lookup.kind !== 'found') return false;
  const record = lookup.record;
  const evidence = getGhostManager().approvedInstallEvidence(installedGhostStoragePart(ghost));
  return Boolean(record.scope === 'public' && record.organizationId === null &&
    (record.source === 'market' || record.source === 'legacy-adopted') &&
    ghost.publishingSource?.kind === 'public-market' && ghost.publishingSource.pluginId === value.pluginId &&
    record.installed && record.pluginId === value.pluginId &&
    record.version === ghost.manifest.version && evidence?.packageSha256 === record.sha256);
}

function pluginView(
  value: wire.MyPluginSummary,
  content: wire.SubmissionContent | null = null,
): MyPluginView {
  const local = localPluginInstallation(value);
  return {
    pluginId: value.pluginId,
    name: value.name,
    displayAuthor: value.displayAuthor ?? null,
    authorSettings: value.authorSettings ?? null,
    publisherKind: value.publisherKind ?? null,
    iconUrl: value.icon?.url ?? null,
    updatedAt: value.updatedAt,
    market: {
      state: value.market.available
        ? 'available'
        : (value.market.unavailableReason ?? 'release_unavailable'),
      version: value.market.currentRelease?.version ?? null,
      releaseId: value.market.currentRelease?.releaseId ?? null,
      reason: null,
    },
    latestSubmission: value.latestSubmission ? releaseView(value.latestSubmission, content) : null,
    actions: { submitUpdate: value.publisherKind !== 'official' && value.actions.canSubmit, viewMarket: value.actions.canViewMarket },
    localInstallation: local,
    localInstanceId: local.state === 'installed' ? local.instanceId : null,
    localVersion: local.state === 'installed' ? local.version : null,
  };
}

export async function listMyPlugins(input: {
  query: string;
  filter: MyPluginFilter;
  cursor?: string;
}): Promise<MyPluginPageView> {
  const result = await new ContributionApi().list({
    ...input,
    filter:
      ({ needs_action: 'action_required', published: 'listed' } as Record<string, string>)[
        input.filter
      ] ?? input.filter,
  });
  return {
    queriedAt: result.queriedAt,
    plugins: result.plugins.map((item) => pluginView(item)),
    nextCursor: result.nextCursor,
  };
}
export async function myPluginDetail(
  pluginId: string,
  cursor?: string,
): Promise<MyPluginDetailView> {
  const api = new ContributionApi();
  const result = await api.detail(pluginId);
  // A later history page has its own read timestamp; never replace the detail
  // market/latest snapshot with fields reconstructed from that event stream.
  const history = cursor ? await api.history(pluginId, cursor) : null;
  return {
    plugin: pluginView(result.plugin, result.latestSubmissionContent),
    queriedAt: result.queriedAt,
    history: history?.events ?? result.history.events,
    nextCursor: history?.nextCursor ?? (history ? null : result.history.nextCursor),
  };
}

export async function setPluginAnonymity(pluginId: string, anonymous: boolean): Promise<MyPluginDetailView> {
  assertWritableInstance();
  const result = await new ContributionApi().setAnonymity(pluginId, anonymous);
  return { plugin: pluginView(result.plugin, result.latestSubmissionContent), queriedAt: result.queriedAt,
    history: result.history.events, nextCursor: result.history.nextCursor };
}

export async function myPluginSubmission(
  pluginId: string,
  submissionId: string,
): Promise<ContributionReleaseView> {
  const result = await new ContributionApi().submission(pluginId, submissionId);
  return {
    ...releaseView(result.submission, result.content),
    uploadedSha256: result.receipt.uploadedPackage.sha256,
    uploadedSizeBytes: result.receipt.uploadedPackage.sizeBytes,
  };
}

export async function myPluginReleases(
  pluginId: string,
  cursor?: string,
): Promise<MyPluginReleasePageView> {
  const result = await new ContributionApi().releases(pluginId, undefined, cursor);
  return {
    releases: result.releases.map((release) => releaseView(release, null)),
    queriedAt: result.queriedAt,
    nextCursor: result.nextCursor,
  };
}

export async function cancelPluginReview(
  pluginId: string,
  release: { releaseId: string; sha256: string; revision: string },
  assertCaller?: () => Promise<void>,
): Promise<ContributionReleaseView> {
  assertWritableInstance();
  const result = await new ContributionApi(assertCaller).cancelReview(pluginId, {
    releaseId: release.releaseId,
    sha256: release.sha256,
    displayUpdatedAt: release.revision,
  });
  return releaseView(result.submission, null);
}

export async function myPluginReviewTarget(pluginId: string, releaseId: string) {
  const api = new ContributionApi();
  const detail = await api.detail(pluginId);
  let cursor: string | undefined;
  do {
    const page = await api.releases(pluginId, undefined, cursor);
    const release = page.releases.find((entry) => entry.releaseId === releaseId);
    if (release) return { name: detail.plugin.name, release: releaseView(release, null) };
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  throwIpcError('NOT_FOUND', 'Plugin version not found');
}
