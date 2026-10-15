import { chatErrorKey } from './chatError';
import { useEffect, useRef, useState } from 'react';
import { ChatInviteDialog } from './ChatInviteDialog';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MessageActionBar } from '@/components/chat/MessageActionBar';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import type { BotGroupMessageView } from '../../../shared/botGroupChat';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;
const emojiChoices = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯'];
const iconClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';
export { chatErrorKey } from './chatError';

/** Adds or removes the current actor's reaction; the caller re-reads the authoritative message. */
function useChatReaction(groupId: string | undefined, messageId: string, onChanged: (messageId: string) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function react(emoji: string, present: boolean) {
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const owner = getDataOwnerGeneration();
    try {
      const result = await api().react({ groupId, messageId, emoji, present });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) toast.error(t(chatErrorKey(result.errorCode)));
      else onChanged(messageId);
    } catch { if (isDataOwnerGenerationCurrent(owner)) toast.error(t(key('requestFailed'))); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return { busy, react };
}

interface ChatMessageActionProps {
  groupId?: string; shareScope: string; message: BotGroupMessageView; align?: 'left' | 'right';
  /** 引用回复: a new main-timeline message that quotes this one. */
  onQuote?: () => void;
  /** Opens the message's Thread (话题) — 创建话题 before anyone answered, 查看话题 after. */
  onReply?: () => void;
  /** The current actor's reaction on `messageId` changed: re-read that message's copy. */
  onChanged: (messageId: string) => void;
}

/** The reactions under a message's text; each chip toggles the current actor's reaction. */
export function ChatMessageReactions({ groupId, message, align = 'left', onChanged }: Pick<ChatMessageActionProps, 'groupId' | 'message' | 'align' | 'onChanged'>) {
  const { t } = useTranslation();
  const { busy, react } = useChatReaction(groupId, message.id, onChanged);
  if (!message.reactions?.length) return null;
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className={`mt-1 flex flex-wrap items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
      {message.reactions.map(reaction => (
        <Button key={reaction.emoji} variant={reaction.me ? 'primary' : 'secondary'} size="sm" compact
          disabled={busy || !groupId} aria-pressed={reaction.me}
          aria-label={t(key('reactionCount'), { emoji: reaction.emoji, count: reaction.count })}
          onClick={() => void react(reaction.emoji, !reaction.me)}>
          <span>{reaction.emoji}</span><span>{reaction.count}</span>
        </Button>
      ))}
    </div>
  );
}

function ChatMessageToolbar({ groupId, shareScope, message, align = 'left', onQuote, onReply, onChanged, picker, onPickerChange }: ChatMessageActionProps & {
  picker: boolean; onPickerChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, react } = useChatReaction(groupId, message.id, onChanged);
  return (
    <MessageActionBar copyText={message.content} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
      align={align} hovered simplifiedBotConversation
      onShareAsImage={() => shareSelectionStore.enter(shareScope, message.id)}
      quoteAction={onQuote ? { onClick: onQuote, label: t(key('quoteReply')) } : undefined}
      replyAction={onReply ? { onClick: onReply, count: message.replyCount,
        label: message.replyCount ? t(key('openTopic'), { count: message.replyCount }) : t(key('startTopic')) } : undefined}
      reactionAction={groupId ? { label: t(key('addReaction')), open: picker, onOpenChange: onPickerChange, disabled: busy,
        content: <div className="grid grid-cols-6 gap-1">{emojiChoices.map(emoji =>
          <button type="button" key={emoji} className={iconClass} aria-label={emoji}
            onClick={() => { onPickerChange(false); void react(emoji, !message.reactions?.some(r => r.emoji === emoji && r.me)); }}>{emoji}</button>)}</div>,
      } : undefined} />
  );
}

/**
 * The message toolbar (copy, share, 引用回复, 话题, reaction, time) floating at the top right of
 * its message, Slack-style. It shows while the message (`group/message`) is hovered, while
 * keyboard focus is inside, while its reaction picker is open, and always on touch screens.
 */
export function ChatMessageHoverActions(props: ChatMessageActionProps) {
  const [picker, setPicker] = useState(false);
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} data-bot-group-message-actions="" data-open={picker ? '' : undefined}
      className="pointer-events-none absolute -top-3.5 right-1 z-10 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-1 py-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 data-[open]:pointer-events-auto data-[open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
      <ChatMessageToolbar {...props} picker={picker} onPickerChange={setPicker} />
    </div>
  );
}

/** Reactions and the toolbar stacked under the text, always visible. */
export function ChatMessageActions(props: ChatMessageActionProps) {
  const [picker, setPicker] = useState(false);
  const align = props.align ?? (props.message.isSelf ? 'right' : 'left');
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className="mt-1 flex flex-col gap-1">
      <ChatMessageReactions {...props} align={align} />
      <ChatMessageToolbar {...props} align={align} picker={picker} onPickerChange={setPicker} />
    </div>
  );
}

function InviteControl({ groupId, onJoined }: { groupId?: string; onJoined?: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t(key(groupId ? 'invite' : 'join'));
  return <>
    <Tip text={title}><button type="button" className={iconClass} style={WINDOW_NO_DRAG_STYLE} aria-label={title} onClick={() => setOpen(true)}><UserPlus size={16} /></button></Tip>
    {open && <ChatInviteDialog groupId={groupId} onClose={() => setOpen(false)} onJoined={onJoined} />}
  </>;
}
export const ChatInviteButton = InviteControl;
export function ChatJoinButton({ onJoined }: { onJoined: (id: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let disposed = false;
    const read = () => { void window.electronAPI?.maker?.chatServer?.status().then(status => { if (!disposed) setEnabled(status.enabled); }).catch(() => undefined); };
    read(); const timer = setInterval(read, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  return enabled ? <InviteControl onJoined={onJoined} /> : null;
}
