import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupMessageView, ChatReactor } from '../../../shared/botGroupChat';

type Reaction = NonNullable<BotGroupMessageView['reactions']>[number];
type Loaded = { summary: string; reactors: ChatReactor[] | null };

const key = (name: string) => `bots.groupChat.server.${name}`;

/** Self first, then current and former members by name. Actors without a member record are counted, never named. */
function reactorList(reactors: ChatReactor[], t: TFunction, language: string) {
  const collator = new Intl.Collator(language);
  const named = reactors.filter(r => r.isSelf || r.name !== null)
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || Number(a.formerMember) - Number(b.formerMember)
      || collator.compare(a.name ?? '', b.name ?? '') || a.actorId.localeCompare(b.actorId));
  const labels = named.map(r => r.isSelf ? t(key('reactorSelf'))
    : r.formerMember ? t(key('reactorFormer'), { name: r.name }) : r.name!);
  return { names: labels.length ? new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(labels) : null,
    unavailable: reactors.length - named.length };
}

/** A reaction badge. Clicking toggles the current actor's reaction; hover or keyboard focus only reads who reacted. */
export function ChatReactionButton({ groupId, messageId, reaction, disabled, onToggle }: {
  groupId?: string; messageId: string; reaction: Reaction; disabled: boolean; onToggle: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The authoritative summary changes on every add/remove, local or remote.
  const summary = `${reaction.count}:${reaction.me}`;
  const looking = !!groupId && (hovered || focused);
  // Read on hover intent, before the tooltip delay ends, and again whenever the summary
  // changes while someone is looking. A superseded read never overwrites a newer one.
  useEffect(() => {
    if (!looking || !groupId) return;
    let superseded = false;
    const owner = getDataOwnerGeneration();
    const settle = (reactors: ChatReactor[] | null) => {
      if (!superseded && isDataOwnerGenerationCurrent(owner)) setLoaded({ summary, reactors });
    };
    window.electronAPI.maker.chatServer.reactors({ groupId, messageId, emoji: reaction.emoji })
      .then(result => settle(result.ok ? result.reactors : null), () => settle(null));
    return () => { superseded = true; };
  }, [looking, groupId, messageId, reaction.emoji, summary]);
  // Names read for an older summary stay visible only while they still describe it.
  const current = loaded?.summary === summary ? loaded : null;
  const list = current?.reactors ? reactorList(current.reactors, t, i18n.language) : null;
  const status = !current ? t(key('reactorsLoading')) : !current.reactors ? t(key('reactorsFailed'))
    : list?.unavailable ? t(key('reactorsUnavailable'), { count: list.unavailable }) : null;
  const label = t(key('reactionCount'), { emoji: reaction.emoji, count: reaction.count });
  return (
    <Tip disabled={!groupId} contentClassName="max-w-[min(320px,var(--radix-tooltip-content-available-width))] break-words" text={
      <span className="flex flex-col gap-0.5">
        <span className="text-12 opacity-70">{label}</span>
        {list?.names && <span>{list.names}</span>}
        {status && <span className="opacity-70">{status}</span>}
      </span>
    }>
      <Button variant={reaction.me ? 'primary' : 'secondary'} size="sm" compact
        disabled={disabled} aria-pressed={reaction.me} aria-label={label}
        onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onClick={onToggle}>
        <span>{reaction.emoji}</span><span>{reaction.count}</span>
      </Button>
    </Tip>
  );
}
