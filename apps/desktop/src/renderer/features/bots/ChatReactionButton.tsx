import { useEffect, useLayoutEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupMessageView, ChatReactor } from '../../../shared/botGroupChat';

type Reaction = NonNullable<BotGroupMessageView['reactions']>[number];
type Loaded = { summary: string; reactors: ChatReactor[] | null };

const key = (name: string) => `bots.groupChat.server.${name}`;
// Keys that scroll a long list while the badge keeps keyboard focus; Enter/Space still toggle.
const scrollKeys: Record<string, (el: HTMLElement) => number> = {
  ArrowDown: () => 40, ArrowUp: () => -40,
  PageDown: el => Math.max(40, el.clientHeight - 24), PageUp: el => -Math.max(40, el.clientHeight - 24),
  End: el => el.scrollHeight, Home: el => -el.scrollHeight,
};

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
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  // State, not a ref: the portalled list mounts a render after the tooltip opens.
  const [namesEl, setNamesEl] = useState<HTMLSpanElement | null>(null);
  // The authoritative summary changes on every add/remove, local or remote.
  const summary = `${reaction.count}:${reaction.me}`;
  // The pointer may move from the badge into an open list to scroll it; that still counts as looking.
  const looking = !!groupId && (hovered || focused || open);
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
  // A long list scrolls inside the viewport-bounded tooltip instead of running off-screen. The
  // 160px floor makes a cramped side overflow so the tooltip flips rather than shrinking to a line.
  // Re-measure when positioning applies the height bound after the tooltip mounts.
  useLayoutEffect(() => {
    const el = namesEl;
    if (!el) { setOverflowing(false); return; }
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [namesEl, list?.names]);
  const scroll = (event: KeyboardEvent<HTMLButtonElement>) => {
    const el = namesEl, by = scrollKeys[event.key];
    if (!el || !by || el.scrollHeight <= el.clientHeight) return;
    event.preventDefault();
    el.scrollBy({ top: by(el) });
  };
  const badge = (
    <Button variant={reaction.me ? 'primary' : 'secondary'} size="sm" compact
      disabled={disabled} aria-pressed={reaction.me} aria-label={label}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onKeyDown={scroll} onClick={onToggle}>
      <span>{reaction.emoji}</span><span>{reaction.count}</span>
    </Button>
  );
  if (!groupId) return badge;
  // The shared tooltip, made hoverable so the pointer can reach and scroll a long list.
  return (
    <Tooltip.Provider disableHoverableContent={false}>
      <Tooltip.Root onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>{badge}</Tooltip.Trigger>
        {/* aria-label keeps Radix from rendering the list a second time as the hidden tooltip text,
          so the scroll region and its ref exist once; screen readers still get every name. */}
        <Tooltip.Content aria-label={[label, list?.names, status].filter(Boolean).join('\n')} className="flex max-h-[min(320px,max(160px,var(--radix-tooltip-content-available-height)))] max-w-[min(320px,var(--radix-tooltip-content-available-width))] flex-col gap-0.5 break-words">
          <span className="shrink-0 text-12 opacity-70">{label}</span>
          {list?.names && <span ref={setNamesEl} data-testid="reactor-names" className="min-h-0 overflow-y-auto overscroll-contain">{list.names}</span>}
          {status && <span className="shrink-0 opacity-70">{status}</span>}
          {overflowing && <span className="shrink-0 text-12 opacity-70">{t(key('reactorsScrollHint'))}</span>}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
