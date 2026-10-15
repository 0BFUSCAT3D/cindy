/**
 * An independent task a teammate started from this group (bot-group-chat.md §10).
 *
 * My own teammate's task: the live task link (status icon, click to open), read from the
 * delegation row on this computer. Someone else's teammate: the card as it was posted —
 * title and state — because that task runs on their computer.
 */
import { ListTodo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BotGroupTaskCardView } from '../../../shared/botGroupChat';
import { BotSessionTaskLink } from './BotSessionTaskLink';

export function BotGroupTaskCard({ task, owned }: { task: BotGroupTaskCardView; owned: boolean }) {
  const { t } = useTranslation();
  const state = t(`bots.groupChat.task.state.${task.state}`);
  return (
    <div
      data-testid="bot-group-task"
      data-state={task.state}
      className="my-1 flex min-w-0 max-w-[520px] items-start gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2"
    >
      <ListTodo size={14} aria-hidden className="mt-[5px] shrink-0 text-[var(--text-tertiary)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {owned ? (
          <BotSessionTaskLink card={task.meta} sessionId={task.meta.parentSessionId ?? undefined} />
        ) : (
          <span className="truncate text-14 leading-6 text-[var(--text-primary)]">{task.title}</span>
        )}
        <span className="min-w-0 break-words text-12 leading-5 text-[var(--text-tertiary)]">
          {task.state === 'waiting' && task.summary ? `${state} · ${task.summary}` : state}
        </span>
      </div>
    </div>
  );
}
