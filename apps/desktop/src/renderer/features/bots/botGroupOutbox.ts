/**
 * 群聊发件箱：用户点发送后立即在时间线末尾显示自己的消息，不等 main / 服务器回执。
 *
 * 只是 renderer 内存里的展示状态，不持久化，也不替代 main 的幂等与服务器的权威时间线：
 * - 每条消息保存 composer 交来的完整发送输入（`BotGroupSendInput`，附件除外——附件在
 *   入队时就开始烧录标注，提交时序列化），提交与重试都原样发出，这里不挑字段；新增发送字段只需
 *   composer 放进 `input`，显示、回执与重试自动带上。
 * - `input.clientId` 是身份，失败重试沿用同一个 clientId，main 与服务器据此去重，
 *   所以这里绝不自动重发。
 * - 同一个群的提交按发出顺序一条一条交给 main，保持用户看到的先后。
 * - 回执带回的 `messageId` 是替换依据：时间线读到这条消息就收起临时气泡；回执之后开始的
 *   一次重读即使没读到（被挤出最新一页），也说明它已进历史，同样收起。
 * - 推送重读可能先于回执到达。此时只对正在提交的那一条（同群同时最多一条）做显示上的
 *   去重：基线之后出现、未被任何回执认领、正文与附件数一致的自己的消息视为它，回执到达后
 *   仍以 messageId 为准。
 * - 附件：临时消息从输入的附件生成列表；带手绘标注的图片烧录完成后改用烧录后的本地预览
 *   （同一份烧录结果也用于提交与重试，不重复烧录；放回输入框的仍是带笔迹的原件）。真实消息到了
 *   而服务器副本还没下载好（没有 url / path，或旧版干脆还没出现在列表里）时，按同一 messageId
 *   把本地预览接到真实消息上，直到副本可用（见 `mergeBotGroupLocalAttachments`）。
 * - 离开输入框的附件不再受草稿保护：发件箱条目持有的图片地址（含标注原图与烧录副本）登记进
 *   存储清理的保护清单，条目移除时同步撤下；已确认消息的本地预览不登记——发送时 main 已在群的
 *   `bot-group-attachment` 引用下固定这些图片。尚未进入消息的暂存文件按归属回收：还没开始提交的条目
 *   （排队中、已失败）归发件箱，群被删除（含不在当前页的群：列表里消失且读取确认已不存在）或
 *   切换账号时立即回收；已开始提交的条目归它的那次请求，条目在烧录期间被丢弃就不再发出并回收，
 *   已交给 main 的等结果——成功（已进入消息）不碰，失败才回收。main 的发送在 IPC 返回前读完
 *   全部本地文件，失败时不留任何引用暂存路径的本地记录（服务端只引用已上传的副本）。
 * - 失败时交还输入框（输入框空着才交还，见 `registerBotGroupComposer`），否则留在时间线上
 *   显示没发出去，可重试或编辑；失败时输入框不在（切群、分享模式），回来注册输入框时同样交还。
 * - 切换到另一个账号时整体清空，旧账号的迟到回执一律丢弃；同账号的 generation 修复、认证边界
 *   短暂发布的 null、退出后重新登录同一账号都不清空。群被删除时丢弃该群的条目。
 */
import { useCallback, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isAnnotationBurnInError, materializeAnnotatedAttachmentsForSend } from '@/lib/annotationBurnIn';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';
import { setBotGroupOutboxAttachmentUrls } from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import type {
  BotGroupAttachment,
  BotGroupMessageView,
  BotGroupSendInput,
  BotGroupSendResult,
} from '../../../shared/botGroupChat';
import { toBotGroupAttachmentInputs } from './botGroupAttachments';
import type { BotGroupTrackedMention } from './botGroupMentions';
import { botGroupErrorKey } from './botGroupPresentation';
import { botGroupApi, getBotGroupListSnapshot, subscribeBotGroups } from './botGroupStore';

export type BotGroupOutboxStatus = 'sending' | 'sent' | 'failed';

/** The send as main receives it; attachments are prepared from `files` (see `prepared`). */
export type BotGroupOutboxSendInput = Omit<BotGroupSendInput, 'attachments'>;

/** What the composer hands over when the user presses send. */
export interface BotGroupOutboxDraft {
  /** Sent unchanged on every (re)try; `groupId` and `clientId` identify the entry. */
  input: BotGroupOutboxSendInput;
  /** Same-attempt identity from `botGroupSendSignature`: a changed field means a new clientId. */
  signature: string;
  /** The composer text as typed, put back on failure. */
  draft: string;
  /** Composer-only state put back with the draft (which typed @ picked which teammate). */
  tracked: readonly BotGroupTrackedMention[];
  files: readonly AttachedFile[];
  /** Scope for burning drawn annotations into images (see botGroupAttachmentScope). */
  attachmentScope: string;
}

/**
 * Identity of one send attempt: every field of the input except the clientId, plus the
 * attachments. A failed send may reuse its clientId only while this is unchanged.
 */
export function botGroupSendSignature(input: BotGroupOutboxSendInput, attachmentSignature: string): string {
  return JSON.stringify([{ ...input, clientId: undefined }, attachmentSignature]);
}

export interface BotGroupOutboxEntry extends BotGroupOutboxDraft {
  status: BotGroupOutboxStatus;
  createdAt: number;
  /** The attachments as the timeline shows them (the burned-in copies once `prepared`). */
  attachments: readonly BotGroupAttachment[];
  /** `files` with drawn annotations burned in; reused by every (re)try. */
  prepared?: readonly AttachedFile[];
  /** From the receipt. */
  messageId?: string;
  /** Order of the receipt against timeline reads (see `beginBotGroupTimelineRead`). */
  receiptTick?: number;
  /** Highest timeline sequence known when this entry's request started; set only while in flight. */
  baseline?: number;
  /** i18n key explaining a failure. */
  errorKey?: string;
}

/** The mounted composer of a group: takes a failed message back into the input when it is empty. */
export interface BotGroupComposerHandle {
  restore: (entry: BotGroupOutboxEntry) => boolean;
  notifyFailed: (errorKey: string) => void;
}

interface GroupOutbox {
  entries: readonly BotGroupOutboxEntry[];
  chain: Promise<void>;
  /** Recent receipt ids: a re-read can never mistake them for the message still in flight. */
  claimed: string[];
  latestSequence: number;
  /** Local attachment previews of confirmed messages, by messageId, until the server copy is usable. */
  previews: ReadonlyMap<string, readonly BotGroupAttachment[]>;
}

const CLAIMED_LIMIT = 64;
const NO_PREVIEWS: ReadonlyMap<string, readonly BotGroupAttachment[]> = new Map();
const EMPTY: readonly BotGroupOutboxEntry[] = [];

/**
 * The account the outbox holds messages for: the last non-null data owner. Only a different
 * account replaces it — not a same-owner generation repair, not the null an auth boundary
 * publishes for a moment, not signing back in to the same account.
 */
let account = getDataOwnerGeneration().dataOwnerId;

function accountChanged(): boolean {
  const current = getDataOwnerGeneration().dataOwnerId;
  return current !== null && current !== account;
}
let generation = 0;
let tick = 0;
const groups = new Map<string, GroupOutbox>();
const composers = new Map<string, BotGroupComposerHandle>();
const listeners = new Set<() => void>();
/** One burn-in per message, shared by the bubble and its submission. */
const preparing = new Map<string, Promise<readonly AttachedFile[]>>();

/**
 * Media only this outbox still refers to; storage cleanup must not sweep it. Previews of
 * confirmed messages are not listed: the send pinned those images under the group's
 * `bot-group-attachment` reference in main.
 */
function protectHeldMedia(): void {
  const urls: string[] = [];
  const add = (file: { url?: string | null; annotationSourceUrl?: string }) => {
    if (file.url) urls.push(file.url);
    if (file.annotationSourceUrl) urls.push(file.annotationSourceUrl);
  };
  for (const group of groups.values()) {
    for (const entry of group.entries) {
      entry.files.forEach(add);
      entry.prepared?.forEach(add);
    }
  }
  setBotGroupOutboxAttachmentUrls(urls);
}

function emit(): void {
  protectHeldMedia();
  for (const listener of listeners) listener();
}

/** Staged copies only a message that never reached a message still points at. */
function releaseStaged(files: readonly AttachedFile[]): void {
  if (files.length > 0) cleanupStagedChatAttachmentFiles(files);
}

/** Entries whose `submit` has started: that request owns their files until it settles. */
const submitting = new Set<string>();
const entryKey = (groupId: string, clientId: string) => `${groupId}\n${clientId}`;

/** Drop entries the outbox still owns; a request in progress settles its own (see `submit`). */
function releaseUnsubmitted(groupId: string, entries: readonly BotGroupOutboxEntry[]): void {
  for (const entry of entries) {
    if (entry.status !== 'sent' && !submitting.has(entryKey(groupId, entry.input.clientId))) releaseStaged(entry.files);
  }
}

function ensureOwner(): void {
  if (!accountChanged()) return;
  const previous = account;
  account = getDataOwnerGeneration().dataOwnerId;
  // Nothing was held for another account yet: whatever is here was written for this one.
  if (previous === null) return;
  generation += 1;
  // The previous account's queued and failed sends go with it; one being submitted settles itself.
  for (const [groupId, group] of groups) releaseUnsubmitted(groupId, group.entries);
  groups.clear();
  preparing.clear();
  protectHeldMedia();
}

function groupOf(groupId: string): GroupOutbox {
  ensureOwner();
  watchGroupList();
  let group = groups.get(groupId);
  if (!group) {
    group = { entries: EMPTY, chain: Promise.resolve(), claimed: [], latestSequence: 0, previews: NO_PREVIEWS };
    groups.set(groupId, group);
  }
  return group;
}

function update(groupId: string, clientId: string, patch: Partial<BotGroupOutboxEntry>): BotGroupOutboxEntry | null {
  const group = groups.get(groupId);
  const index = group?.entries.findIndex((entry) => entry.input.clientId === clientId) ?? -1;
  if (!group || index < 0) return null;
  const next = { ...group.entries[index]!, ...patch };
  group.entries = group.entries.map((entry, at) => (at === index ? next : entry));
  emit();
  return next;
}

function remove(groupId: string, clientId: string): void {
  const group = groups.get(groupId);
  if (!group || !group.entries.some((entry) => entry.input.clientId === clientId)) return;
  group.entries = group.entries.filter((entry) => entry.input.clientId !== clientId);
  emit();
}

function displayAttachments(files: readonly AttachedFile[]): BotGroupAttachment[] {
  return toBotGroupAttachmentInputs(files).map((file) => ({
    id: file.id,
    name: file.name,
    category: file.category,
    mimeType: file.mimeType,
    size: file.size ?? 0,
    url: file.url ?? null,
    path: file.path || null,
    ...(file.annotated ? { annotated: true } : {}),
  }));
}

/** Show the message at once and queue it behind the group's earlier sends. */
export function enqueueBotGroupSend(draft: BotGroupOutboxDraft): void {
  const { groupId, clientId } = draft.input;
  const group = groupOf(groupId);
  const entry: BotGroupOutboxEntry = {
    ...draft,
    input: { ...draft.input },
    files: [...draft.files],
    tracked: [...draft.tracked],
    attachments: displayAttachments(draft.files),
    status: 'sending',
    createdAt: Date.now(),
  };
  group.entries = [...group.entries.filter((existing) => existing.input.clientId !== clientId), entry];
  emit();
  schedule(groupId, clientId);
  // Burn annotations in now, not when the message's turn comes: the bubble shows the result.
  if (entry.files.length > 0) void prepare(groupId, clientId).catch(() => undefined);
}

/** The message's files with annotations burned in, once; a failure is retried by the next call. */
function prepare(groupId: string, clientId: string): Promise<readonly AttachedFile[]> {
  const entry = groups.get(groupId)?.entries.find((candidate) => candidate.input.clientId === clientId);
  if (!entry) return Promise.reject(new Error('OUTBOX_ENTRY_GONE'));
  if (entry.prepared) return Promise.resolve(entry.prepared);
  if (entry.files.length === 0) return Promise.resolve([]);
  const key = `${groupId}\n${clientId}`;
  const existing = preparing.get(key);
  if (existing) return existing;
  const requestGeneration = generation;
  const pending = materializeAnnotatedAttachmentsForSend(entry.files, entry.attachmentScope, { burnFailure: 'abort' })
    .then((files) => {
      const prepared = files ?? [];
      if (requestGeneration === generation) {
        update(groupId, clientId, { prepared, attachments: displayAttachments(prepared) });
      }
      return prepared;
    })
    .finally(() => {
      if (preparing.get(key) === pending) preparing.delete(key);
    });
  preparing.set(key, pending);
  return pending;
}

/** 重试 on a message that did not go out: the same clientId, so main returns any copy it already has. */
export function retryBotGroupSend(groupId: string, clientId: string): void {
  ensureOwner();
  const entry = groups.get(groupId)?.entries.find((candidate) => candidate.input.clientId === clientId);
  if (!entry || entry.status !== 'failed') return;
  update(groupId, clientId, { status: 'sending', errorKey: undefined });
  schedule(groupId, clientId);
}

/** 编辑: hand a message that did not go out back to the composer. False when the input is busy. */
export function editBotGroupSend(groupId: string, clientId: string): boolean {
  ensureOwner();
  const entry = groups.get(groupId)?.entries.find((candidate) => candidate.input.clientId === clientId);
  const composer = composers.get(groupId);
  if (!entry || entry.status !== 'failed' || !composer?.restore(entry)) return false;
  remove(groupId, clientId);
  return true;
}

function schedule(groupId: string, clientId: string): void {
  const group = groupOf(groupId);
  const requestGeneration = generation;
  // Kept by the request itself: after an account switch the entry is gone but its files are not.
  const files = group.entries.find((entry) => entry.input.clientId === clientId)?.files ?? [];
  group.chain = group.chain.then(() => submit(groupId, clientId, requestGeneration, files)).catch(() => undefined);
}

async function submit(
  groupId: string,
  clientId: string,
  requestGeneration: number,
  files: readonly AttachedFile[],
): Promise<void> {
  const isCurrent = () => requestGeneration === generation && !accountChanged();
  // Dropped before its turn (account switch, deleted group): whoever dropped it released its files.
  if (!isCurrent()) return;
  const group = groups.get(groupId);
  const entry = group?.entries.find((candidate) => candidate.input.clientId === clientId);
  if (!group || !entry || entry.status !== 'sending') return;
  // From here this request owns the files. Still the outbox's message: same account, still listed.
  const owned = () =>
    isCurrent() && (groups.get(groupId)?.entries.some((candidate) => candidate.input.clientId === clientId) ?? false);
  const key = entryKey(groupId, clientId);
  submitting.add(key);
  try {
    await submitOwned(group, entry, owned, files);
  } finally {
    submitting.delete(key);
  }
}

async function submitOwned(
  group: GroupOutbox,
  entry: BotGroupOutboxEntry,
  owned: () => boolean,
  files: readonly AttachedFile[],
): Promise<void> {
  const { groupId, clientId } = entry.input;
  update(groupId, clientId, { baseline: group.latestSequence });
  const api = botGroupApi();
  let errorKey = 'bots.groupChat.composer.sendFailed';
  try {
    if (!api) throw new Error('HOST_NOT_READY');
    // Drawn annotations are burned in first, as in a task; a failure keeps everything for a retry.
    const prepared = await prepare(groupId, clientId);
    // Dropped while annotations were burning in: it never reaches main.
    if (!owned()) {
      releaseStaged(files);
      return;
    }
    const result: BotGroupSendResult = await api.sendBotGroupMessage({
      ...entry.input,
      ...(prepared.length > 0 ? { attachments: toBotGroupAttachmentInputs(prepared) } : {}),
    });
    if (!owned()) {
      // A late answer for a dropped message: keep what went out, release what did not. Main has
      // read the files by the time it answers.
      if (!result.ok) releaseStaged(files);
      return;
    }
    if (result.ok) {
      group.claimed = [...group.claimed, result.messageId].slice(-CLAIMED_LIMIT);
      update(groupId, clientId, { status: 'sent', messageId: result.messageId, receiptTick: ++tick, baseline: undefined });
      return;
    }
    errorKey =
      result.errorCode === 'INVALID_PARAMS' && prepared.length > 0
        ? 'bots.groupChat.composer.attachmentsFailed'
        : botGroupErrorKey(result.errorCode, 'bots.groupChat.composer.sendFailed');
  } catch (error) {
    // Burn-in failed (never sent) or the call failed without an answer from main's handler.
    if (!owned()) {
      releaseStaged(files);
      return;
    }
    if (isAnnotationBurnInError(error)) errorKey = 'chat.media.annotateBurnFailedNotSent';
  }
  const failed = update(groupId, clientId, { status: 'failed', errorKey, baseline: undefined });
  if (!failed) return;
  const composer = composers.get(groupId);
  if (composer?.restore(failed)) remove(groupId, clientId);
  composer?.notifyFailed(errorKey);
}

/** Mark the start of a timeline read; pass the token to `noteBotGroupTimeline` when it lands. */
export function beginBotGroupTimelineRead(): number {
  return ++tick;
}

/**
 * A timeline read for this group succeeded. Receipts it contains, or that came back before
 * the read started, are settled: the server timeline now speaks for them.
 */
export function noteBotGroupTimeline(groupId: string, messages: readonly BotGroupMessageView[], readToken: number): void {
  const group = groupOf(groupId);
  group.latestSequence = messages.reduce((latest, message) => Math.max(latest, message.sequence), group.latestSequence);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const settled = (entry: BotGroupOutboxEntry) =>
    entry.status === 'sent' &&
    ((entry.messageId !== undefined && byId.has(entry.messageId)) || (entry.receiptTick ?? Infinity) < readToken);
  const previews = new Map(group.previews);
  let changed = false;
  // A settled message keeps its local previews until the timeline has a usable copy of each.
  for (const entry of group.entries) {
    if (settled(entry) && entry.messageId && entry.attachments.length > 0) previews.set(entry.messageId, entry.attachments);
  }
  for (const [messageId, local] of previews) {
    const message = byId.get(messageId);
    if (message && botGroupLocalAttachmentsSettled(message.attachments, local)) previews.delete(messageId);
  }
  if (previews.size !== group.previews.size || [...previews].some(([id, value]) => group.previews.get(id) !== value)) {
    group.previews = previews;
    changed = true;
  }
  if (group.entries.some(settled)) {
    group.entries = group.entries.filter((entry) => !settled(entry));
    changed = true;
  }
  if (changed) emit();
}

/** A server attachment that can be shown: an image with its address or a file on this computer. */
function isUsable(attachment: BotGroupAttachment): boolean {
  return Boolean(attachment.url || attachment.path);
}

/**
 * Pair the server's attachments of a message with the local ones it was sent with. The server
 * keeps the order they were sent in, so equal counts pair by position. An older server lists a
 * copy only once it is downloaded; then pair by name in that same order, so two files with the
 * same name never swap. Local names are the burned-in ones (see `prepared`), as on the server.
 * Returns, for each local attachment, the server copy it matches (or undefined), plus the
 * server attachments nothing local matched.
 */
function pairLocalAttachments(server: readonly BotGroupAttachment[], local: readonly BotGroupAttachment[]) {
  if (server.length === local.length) return { pairs: [...server], extra: [] as BotGroupAttachment[] };
  const used = new Set<number>();
  let next = 0;
  const pairs: Array<BotGroupAttachment | undefined> = local.map((file) => {
    for (let at = next; at < server.length; at += 1) {
      if (server[at]!.name !== file.name) continue;
      used.add(at);
      next = at + 1;
      return server[at];
    }
    return undefined;
  });
  return { pairs, extra: server.filter((_, at) => !used.has(at)) };
}

/**
 * What a confirmed message shows: each attachment's server copy once it is usable, the local
 * preview until then (under the server's id when known), in the order the user sent them.
 */
export function mergeBotGroupLocalAttachments(
  server: readonly BotGroupAttachment[],
  local: readonly BotGroupAttachment[],
): BotGroupAttachment[] {
  const { pairs, extra } = pairLocalAttachments(server, local);
  return [
    ...local.map((file, at) => {
      const echo = pairs[at];
      if (!echo) return file;
      return isUsable(echo) ? echo : { ...file, id: echo.id };
    }),
    ...extra,
  ];
}

/** Every local attachment has a usable server copy: the preview is no longer needed. */
function botGroupLocalAttachmentsSettled(
  server: readonly BotGroupAttachment[],
  local: readonly BotGroupAttachment[],
): boolean {
  return pairLocalAttachments(server, local).pairs.every((echo) => echo !== undefined && isUsable(echo));
}

/**
 * The group was deleted: nothing of it is left to send or show. Staged copies of files that
 * never reached a message go too; the draft no longer lists them, so nothing else would.
 */
export function discardBotGroupOutbox(groupId: string): void {
  ensureOwner();
  const group = groups.get(groupId);
  if (!group) return;
  groups.delete(groupId);
  releaseUnsubmitted(groupId, group.entries);
  emit();
}

let unwatchGroupList: (() => void) | null = null;
const verifying = new Set<string>();
const retryTimers = new Set<ReturnType<typeof setTimeout>>();
/** A read that was not definite (thrown, or a failure other than NOT_FOUND) is tried again. */
export const BOT_GROUP_GONE_RETRY_MS = [5_000, 30_000, 120_000] as const;

/**
 * Groups deleted while their page is closed (or from another device) send no event this
 * outbox sees. The group list does: a group that drops out of it is read once more, and only
 * a definite NOT_FOUND discards its outbox (a legacy id still resolves). A read that fails is
 * retried a few times on its own: the event that dropped the group may never come again.
 */
function watchGroupList(): void {
  if (unwatchGroupList) return;
  unwatchGroupList = subscribeBotGroups(() => {
    for (const groupId of groups.keys()) verifyGroupGone(groupId, 0);
  });
}

function verifyGroupGone(groupId: string, attempt: number): void {
  if (verifying.has(groupId)) return;
  const group = groups.get(groupId);
  if (!group || (group.entries.length === 0 && group.previews.size === 0)) return;
  const list = getBotGroupListSnapshot();
  if (!list.loaded || list.groups.some((listed) => listed.id === groupId)) return;
  const api = botGroupApi();
  if (!api) return;
  const requestGeneration = generation;
  // A read that spans an owner change (same-account repair, an auth boundary's null) is no answer.
  const requestOwner = getDataOwnerGeneration();
  let definite = false;
  verifying.add(groupId);
  void api
    .getBotGroup(groupId)
    .then((result) => {
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      definite = result.ok || result.errorCode === 'NOT_FOUND';
      if (requestGeneration === generation && !result.ok && result.errorCode === 'NOT_FOUND') discardBotGroupOutbox(groupId);
    })
    .catch(() => undefined)
    .finally(() => {
      verifying.delete(groupId);
      const delay = BOT_GROUP_GONE_RETRY_MS[attempt];
      if (definite || delay === undefined || requestGeneration !== generation) return;
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (requestGeneration === generation) verifyGroupGone(groupId, attempt + 1);
      }, delay);
      retryTimers.add(timer);
    });
}

/**
 * The group's composer is on screen. A message that failed while it was away (another group,
 * share mode) comes back into it now, the same way as a failure seen in place.
 */
export function registerBotGroupComposer(groupId: string, handle: BotGroupComposerHandle): () => void {
  composers.set(groupId, handle);
  const failed = groups.get(groupId)?.entries.find((entry) => entry.status === 'failed');
  if (failed && handle.restore(failed)) {
    remove(groupId, failed.input.clientId);
    handle.notifyFailed(failed.errorKey ?? 'bots.groupChat.composer.sendFailed');
  }
  return () => {
    if (composers.get(groupId) === handle) composers.delete(groupId);
  };
}

export interface BotGroupOutboxProjection {
  /** Entries still shown under the timeline. */
  pending: BotGroupOutboxEntry[];
  /** Local attachment previews to lay over timeline messages, by message id. */
  localAttachments: ReadonlyMap<string, readonly BotGroupAttachment[]>;
}

/**
 * Split the outbox against the timeline. A receipt already in the timeline is no longer
 * pending; so is the one request in flight once a re-read shows an unclaimed copy of it (see
 * above). Either way the real message keeps the local attachment previews until usable.
 */
export function projectBotGroupOutbox(
  entries: readonly BotGroupOutboxEntry[],
  messages: readonly BotGroupMessageView[],
  claimed: readonly string[],
  previews: ReadonlyMap<string, readonly BotGroupAttachment[]> = NO_PREVIEWS,
): BotGroupOutboxProjection {
  const localAttachments = new Map(previews);
  if (entries.length === 0) return { pending: [], localAttachments };
  const ids = new Set(messages.map((message) => message.id));
  const claimedIds = new Set(claimed);
  const pending = entries.filter((entry) => {
    if (entry.status === 'sent') {
      if (!(entry.messageId && ids.has(entry.messageId))) return true;
      if (entry.attachments.length > 0) localAttachments.set(entry.messageId, entry.attachments);
      return false;
    }
    if (entry.status !== 'sending' || entry.baseline === undefined) return true;
    const baseline = entry.baseline;
    const copy = messages.find(
      (message) =>
        message.kind === 'message' &&
        message.authorKind === 'user' &&
        message.isSelf !== false &&
        message.sequence > baseline &&
        !claimedIds.has(message.id) &&
        message.content.trim() === entry.input.text &&
        message.attachments.length === entry.files.length,
    );
    if (!copy) return true;
    if (entry.attachments.length > 0) localAttachments.set(copy.id, entry.attachments);
    return false;
  });
  return { pending, localAttachments };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBotGroupOutbox(groupId: string): readonly BotGroupOutboxEntry[] {
  ensureOwner();
  return groups.get(groupId)?.entries ?? EMPTY;
}

export function getBotGroupOutboxClaims(groupId: string): readonly string[] {
  ensureOwner();
  return groups.get(groupId)?.claimed ?? [];
}

export function getBotGroupOutboxPreviews(groupId: string): ReadonlyMap<string, readonly BotGroupAttachment[]> {
  ensureOwner();
  return groups.get(groupId)?.previews ?? NO_PREVIEWS;
}

export function useBotGroupOutbox(groupId: string): readonly BotGroupOutboxEntry[] {
  const read = useCallback(() => getBotGroupOutbox(groupId), [groupId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test-only reset of the module state. */
export function resetBotGroupOutboxForTests(): void {
  generation += 1;
  account = getDataOwnerGeneration().dataOwnerId;
  groups.clear();
  preparing.clear();
  verifying.clear();
  submitting.clear();
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers.clear();
  unwatchGroupList?.();
  unwatchGroupList = null;
  composers.clear();
}
