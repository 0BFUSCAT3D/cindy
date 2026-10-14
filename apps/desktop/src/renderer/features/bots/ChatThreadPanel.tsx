import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, CornerDownRight, MessageSquareShare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { ShareMessageCheckbox } from '@/components/chat/ShareMessageCheckbox';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { SHARE_SESSION_ATTR, SHARE_MESSAGE_ATTR } from '@/lib/shareConversationImage';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGroupDetail, BotGroupExecutionFailureView, BotGroupMention, BotGroupMessageView } from '../../../shared/botGroupChat';
import { isBotGroupRuntimeFailureCode } from '../../../shared/botGroupChat';
import { resolveBotGroupMentions } from './botGroupMentions';
import { refreshBotGroups } from './botGroupStore';
import { mergeBotGroupMessages, projectBotGroupExecutionFailures } from './botGroupPresentation';
import { BotAvatar } from './BotAvatar';
import { BotGroupRuntimeFailureNotice } from './BotGroupRuntimeFailureNotice';
import { BotGroupThreadShareQuote, botGroupThreadShareLabel, findThreadMessageElement, flashThreadTarget } from './BotGroupThreadViews';
import { ChatMessageActions, chatErrorKey } from './ChatServerControls';
const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;
/** Earlier pages read while looking for a reply opened from the main chat. */
const FOCUS_PAGE_LIMIT = 5;

/** Shares of this thread's replies that the main chat has loaded. */
export type BotGroupSharedReplies = ReadonlyMap<string, { messageId: string; bySelf: boolean }>;

/**
 * Replies that reached a thread while their main-chat copy did not, per group and thread.
 * Kept outside the panel so switching threads and coming back still offers the retry.
 * Server groups keep their IDs across accounts, so the queue belongs to one data owner.
 */
const unpostedStore = { owner: getDataOwnerGeneration(), replies: new Map<string, ReadonlySet<string>>() };
function unpostedReplies() {
  const owner = getDataOwnerGeneration();
  if (unpostedStore.owner !== owner) { unpostedStore.owner = owner; unpostedStore.replies.clear(); }
  return unpostedStore.replies;
}

export function animateThreadPanelWidth(panel: HTMLElement, from: string, to: string): Animation | null {
  const style = getComputedStyle(panel);
  const token = style.getPropertyValue('--motion-base').trim();
  const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
  if (!panel.animate || !Number.isFinite(duration) || duration <= 0) return null;
  return panel.animate([{ width: from }, { width: to }], {
    duration, easing: style.getPropertyValue('--motion-ease-move').trim() || 'linear', fill: 'forwards',
  });
}

function ThreadMessage({ group, message, shareScope, sharing, shared, posting, onPost, onReveal, onChanged, renderAttachments }: {
  group: BotGroupDetail; message: BotGroupMessageView; shareScope: string; sharing: boolean;
  renderAttachments?: (attachments: BotGroupMessageView['attachments']) => ReactNode;
  /** Replies only: already in the main chat (by anyone), and whether the reader shared it. */
  shared?: { bySelf: boolean } | null; posting?: boolean; onPost?: () => void; onReveal?: () => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const member = group.members.find(m => m.botId === message.authorBotId);
  if (message.kind === 'notice' && isBotGroupRuntimeFailureCode(message.runtimeFailureCode)) return <BotGroupRuntimeFailureNotice name={message.authorName || member?.name || ''} code={message.runtimeFailureCode} />;
  // A share as a thread root shows the same quote as the main chat, in every state.
  const share = message.threadShare;
  // Once the reader has posted it, posting again can only meet the same share: offer the
  // jump when that share can be located, and nothing otherwise.
  const postAction = !onPost || message.deleted || message.kind !== 'message' ? undefined
    : shared?.bySelf ? onReveal && { key: 'reveal-in-main', label: t(key('thread.viewInMain')), icon: <CornerDownRight size={14} strokeWidth={2} className="shrink-0" />, onSelect: onReveal }
    : { key: 'post-to-main', label: t(key('thread.postToMain')), disabled: posting, icon: <MessageSquareShare size={14} strokeWidth={2} className="shrink-0" />, onSelect: onPost };
  return <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
    className={`relative flex min-w-0 gap-2.5 ${sharing ? 'ml-10' : ''}`}>
    {sharing && <ShareMessageCheckbox clientId={message.id} />}
    <BotAvatar bot={{ name: message.authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} size="sm" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-13 font-medium leading-7 text-[var(--text-primary)]">{message.authorName}</p>
      {share ? <>
        <p className="flex select-none items-center gap-1 text-12 text-[var(--text-tertiary)]">
          <CornerDownRight size={12} aria-hidden />{botGroupThreadShareLabel(share, t)}</p>
        <BotGroupThreadShareQuote share={share} members={group.members} attachments={renderAttachments?.(share.attachments)} />
      </> : <div className="break-words text-14 leading-relaxed text-[var(--text-primary)]">
        <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
      </div>}
      {shared && <button type="button" onClick={onReveal} disabled={!onReveal}
        className="-ml-1.5 inline-flex min-h-6 select-none items-center gap-1 rounded-full px-1.5 text-12 text-[var(--text-tertiary)] outline-none transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        <CornerDownRight size={12} aria-hidden />{t(key(shared.bySelf ? 'thread.postedBySelf' : 'thread.postedToMain'))}
      </button>}
      <ChatMessageActions groupId={group.id} shareScope={shareScope} message={message} align="left" onChanged={onChanged}
        copyText={share ? share.status === 'available' ? share.content : '' : undefined} menuActions={postAction ? [postAction] : undefined} />
    </div>
  </article>;
}

export function ChatThreadPanel({ group, rootId, focus, sharedReplies, onRevealShare, onClose, renderAttachments }: {
  group: BotGroupDetail; rootId: string;
  /** A reply to bring into view; a new nonce repeats the jump. */
  focus?: { messageId: string; nonce: number } | null;
  sharedReplies?: BotGroupSharedReplies;
  /** Scroll the main chat to a share; false when it is not loaded there. */
  onRevealShare?: (messageId: string) => boolean;
  onClose: () => void;
  /** The main chat's attachment view, reused for a shared reply at the thread root. */
  renderAttachments?: (attachments: BotGroupMessageView['attachments']) => ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const shareScope = `bot-group:${group.id}:thread:${rootId}`;
  const sharing = useShareSelectionActive(shareScope);
  const contentRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    (panel?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('header button'))?.focus();
  }, []);
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(shareScope);
    return () => { if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit(); };
  }, [shareScope]);
  const [root, setRoot] = useState<BotGroupMessageView | null>(null);
  const [executionFailures, setExecutionFailures] = useState<BotGroupExecutionFailureView[]>([]);
  const [replies, setReplies] = useState<BotGroupMessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Off by default: a reply stays in the thread unless the user asks for both.
  const [alsoSend, setAlsoSend] = useState(false);
  const unpostedKey = `${group.id}:${rootId}`;
  const [unposted, setUnpostedState] = useState<ReadonlySet<string>>(() => unpostedReplies().get(unpostedKey) ?? new Set());
  const setUnposted = (update: (previous: ReadonlySet<string>) => ReadonlySet<string>) => setUnpostedState(previous => {
    const next = update(previous);
    if (next.size) unpostedReplies().set(unpostedKey, next); else unpostedReplies().delete(unpostedKey);
    return next;
  });
  const [posting, setPosting] = useState<ReadonlySet<string>>(new Set());
  const postingRef = useRef(new Set<string>());
  /** Shares confirmed in this panel (reply → main-chat message, null when unknown). */
  const [posted, setPosted] = useState<ReadonlyMap<string, string | null>>(new Map());
  const request = useRef(0);
  const attempt = useRef<{ text: string; id: string; mentions: BotGroupMention } | null>(null);
  const sending = useRef(false);
  const load = useCallback(async (before?: number) => {
    const version = ++request.current, owner = getDataOwnerGeneration();
    const current = () => version === request.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await api().thread({ groupId: group.id, rootId, before, sourceMessageIds: replies.map(message => message.id) });
      if (!current()) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      setRoot(result.root); setError('');
      setExecutionFailures(result.executionFailures ?? []);
      setReplies(previous => mergeBotGroupMessages(previous, result.replies));
      if (before || replies.length === 0) setHasMore(result.hasMore);
    } catch { if (current()) setError(t(key('requestFailed'))); }
  }, [group.id, rootId, t, replies]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    const stop = window.electronAPI.maker.onBotGroupChanged((event, stamp) => {
      if (isDataOwnerPushCurrent(stamp) && event.groupId === group.id) void loadRef.current();
    });
    return () => { request.current++; stop(); };
  }, [group.id, rootId]);
  // A share opened this thread: find its reply, reading back a few pages if needed.
  const focusSearch = useRef<{ nonce: number; pages: number } | null>(null);
  useEffect(() => {
    if (!focus || !replies.length) return;
    if (focusSearch.current?.nonce !== focus.nonce) focusSearch.current = { nonce: focus.nonce, pages: 0 };
    const search = focusSearch.current;
    if (search.pages < 0) return;
    const target = findThreadMessageElement(contentRef.current, focus.messageId);
    if (target) { search.pages = -1; flashThreadTarget(target); return; }
    if (!hasMore || search.pages >= FOCUS_PAGE_LIMIT) { search.pages = -1; return; }
    search.pages += 1;
    void loadRef.current(replies[0]?.sequence);
  }, [focus, replies, hasMore]);

  /** One server operation per reply and person, so a retry never posts twice. */
  async function postToMain(messageId: string, fromComposer: boolean) {
    if (postingRef.current.has(messageId)) return false;
    postingRef.current.add(messageId); setPosting(new Set(postingRef.current));
    const owner = getDataOwnerGeneration();
    const failed = (code?: string) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (fromComposer) setUnposted(previous => new Set(previous).add(messageId));
      else toast.error(t(code ? chatErrorKey(code) : key('requestFailed')));
    };
    try {
      const result = await api().shareToMain({ groupId: group.id, messageId });
      if (!isDataOwnerGenerationCurrent(owner)) return false;
      if (!result.ok) { failed(result.errorCode); return false; }
      setPosted(previous => new Map(previous).set(messageId, result.messageId));
      setUnposted(previous => { const next = new Set(previous); next.delete(messageId); return next; });
      if (result.alreadyShared && !fromComposer) toast.info(t(key('thread.alreadyPosted')));
      refreshBotGroups();
      return true;
    } catch { failed(); return false; }
    finally { postingRef.current.delete(messageId); setPosting(new Set(postingRef.current)); }
  }
  async function retryUnposted() {
    for (const messageId of unposted) await postToMain(messageId, true);
  }
  async function send() {
    if (group.archived || sending.current || !text.trim()) return;
    sending.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const toMain = alsoSend;
    if (!attempt.current || attempt.current.text !== text) attempt.current = {
      text, id: crypto.randomUUID(),
      mentions: resolveBotGroupMentions(text, { members: group.members, allLabels: [t('bots.groupChat.mention.all'), '所有人', 'all', 'everyone'] }),
    };
    try {
      const result = await api().reply({ groupId: group.id, rootId, text: attempt.current.text, clientId: attempt.current.id,
        mentions: attempt.current.mentions });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      // The reply exists now; only its main-chat copy may still need a retry.
      setText(''); attempt.current = null; setAlsoSend(false);
      if (toMain) await postToMain(result.messageId, true);
      void loadRef.current(); refreshBotGroups();
    } catch { if (isDataOwnerGenerationCurrent(owner)) setError(t(key('requestFailed'))); }
    finally { sending.current = false; setBusy(false); }
  }
  const sharedState = (messageId: string) => {
    const known = sharedReplies?.get(messageId);
    if (known) return { bySelf: known.bySelf, shareId: known.messageId };
    return posted.has(messageId) ? { bySelf: true, shareId: posted.get(messageId) ?? null } : null;
  };
  /** The share may sit on an older page the main chat has not loaded. */
  const revealShare = (shareId: string) => {
    if (!onRevealShare?.(shareId)) toast.info(t(key('thread.shareNotLoaded')));
  };
  return <aside ref={panelRef} aria-labelledby={titleId}
        className="flex h-full min-w-0 w-1/2 max-w-[min(50%,28rem)] shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)] bg-[var(--surface)]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
          <h2 id={titleId} className="text-15 font-medium text-[var(--text-primary)]">{t(key('replies'))}</h2>
          <Tip text={t('bots.close')}>
            <Button variant="secondary" tone="quiet" size="md"
              className="w-8 rounded-none px-0 [&::before]:rounded-full"
              aria-label={t('bots.close')} onClick={onClose}><X size={17} aria-hidden /></Button>
          </Tip>
        </header>
        <div ref={contentRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {projectBotGroupExecutionFailures(root ? [root] : [], executionFailures).map(message => <ThreadMessage key={message.id} shareScope={shareScope} sharing={sharing} group={group} message={message}
            renderAttachments={renderAttachments} onChanged={() => void loadRef.current()} />)}
          <div className="border-t border-[var(--border-default)] pt-3 text-12 text-[var(--text-tertiary)]">{t(key('replies'))}</div>
          {hasMore && <Button variant="secondary" size="sm" onClick={() => void loadRef.current(replies[0]?.sequence)}>{t('bots.groupChat.timeline.loadEarlier')}</Button>}
          {projectBotGroupExecutionFailures(replies, executionFailures).map(message => {
            const shared = sharedState(message.id);
            return <ThreadMessage key={message.id} shareScope={shareScope} sharing={sharing} group={group} message={message}
              shared={shared} posting={posting.has(message.id)}
              onPost={group.archived ? undefined : () => void postToMain(message.id, false)}
              onReveal={shared?.shareId ? () => revealShare(shared.shareId!) : undefined}
              onChanged={() => void loadRef.current()} />;
          })}
        </div>
        {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
          getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 400} /> : <div className="space-y-3 border-t border-[var(--border-default)] p-4">
          {error && <p role="alert" className="text-13 text-[var(--error-fg)]">{error}</p>}
          {/* Kept apart from read errors: a thread refresh must not hide the retry. */}
          {unposted.size > 0 && <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-[var(--error-fg)]">
            <span className="min-w-0">{t(key('thread.alsoSendFailed'), { count: unposted.size })}</span>
            <Button variant="secondary" size="sm" compact loading={[...unposted].some(id => posting.has(id))} onClick={() => void retryUnposted()}>
              {t(key('thread.retryPost'))}</Button>
          </div>}
          <Textarea aria-label={t(key('replyPlaceholder'))} placeholder={t(key('replyPlaceholder'))} value={text} onChange={value => {
            setText(value);
            if (attempt.current?.text !== value) attempt.current = null;
          }}
            rows={3} maxLength={8000} disabled={busy || group.archived} onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); }
            }} />
          <div className="flex min-w-0 items-center justify-between gap-3">
            <button type="button" role="checkbox" aria-checked={alsoSend} disabled={busy || group.archived}
              onClick={() => setAlsoSend(value => !value)}
              className="-ml-1.5 inline-flex min-h-7 min-w-0 select-none items-center gap-2 rounded-full px-1.5 text-13 text-[var(--text-secondary)] outline-none transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50">
              <span aria-hidden className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--motion-fast)]',
                alsoSend ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]' : 'border border-[var(--border-default)]')}>
                {alsoSend ? <Check size={10} strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0 truncate">{t(key('thread.alsoSend'))}</span>
            </button>
            <Button variant="cta" size="sm" loading={busy} disabled={group.archived || !text.trim()} onClick={() => void send()}>{t(key('sendReply'))}</Button>
          </div>
        </div>}
  </aside>;
}
