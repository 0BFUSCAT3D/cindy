/**
 * 群的身份标记：侧栏按人数显示组合头像，顶栏与群设置用一排叠放头像。
 * 每个头像仍是 BotAvatar（同一套 `--bot-avatar-*` 色板），叠放处用和底色同色的
 * 描边隔开——与离线状态点 `border-sidebar` 的做法一致，不引入阴影或新 token。
 */
import { Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { BotGroupMemberView } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';

type AvatarMember = Pick<BotGroupMemberView, 'botId' | 'name' | 'avatar' | 'avatarColor'>;

/** 固定头像区域：双人斜向叠放，多人错位重叠，描边区分前后层次。 */
export function BotGroupSidebarAvatar({
  members,
  selected = false,
  compact = false,
}: {
  members: readonly AvatarMember[];
  selected?: boolean;
  compact?: boolean;
}) {
  const frameClass = compact ? 'h-7 w-7' : 'h-10 w-10';
  const [first, second] = members;
  if (!first) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-tertiary)]',
          frameClass,
        )}
      >
        <Users size={16} />
      </span>
    );
  }
  if (!second) return <BotAvatar bot={first} size={compact ? 'sm' : 'md'} />;
  if (members.length >= 3) {
    const positions =
      members.length === 3
        ? ['left-0 top-0', 'right-0 top-[15%]', 'bottom-0 left-[15%]']
        : ['left-0 top-0', 'right-0 top-[5%]', 'bottom-[5%] left-0', 'bottom-0 right-0'];
    return (
      <span aria-hidden className={cn('relative flex shrink-0', frameClass)}>
        {members.slice(0, 4).map((member, index) => (
          <span
            key={member.botId}
            className={cn(
              'absolute flex rounded-full',
              compact ? 'border-[1.5px]' : 'border-2',
              members.length === 3 ? 'h-[65%] w-[65%]' : 'h-[60%] w-[60%]',
              selected
                ? 'border-sidebar-item-active'
                : 'border-sidebar group-hover:border-sidebar-item-hover',
              positions[index],
            )}
          >
            <BotAvatar
              bot={member}
              size="xs"
              className={cn('h-full w-full', compact ? 'text-10' : 'text-12')}
            />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span aria-hidden className={cn('relative flex shrink-0', frameClass)}>
      <BotAvatar
        bot={first}
        size="xs"
        className={cn(
          'absolute',
          compact ? 'left-0 top-0 h-[18px] w-[18px] text-10' : 'left-0.5 top-0.5 h-6 w-6 text-12',
        )}
      />
      <span
        className={cn(
          'absolute bottom-0 right-0 flex rounded-full',
          compact ? 'border-[1.5px]' : 'border-2',
          selected
            ? 'border-sidebar-item-active'
            : 'border-sidebar group-hover:border-sidebar-item-hover',
        )}
      >
        <BotAvatar
          bot={second}
          size="xs"
          className={compact ? 'h-[18px] w-[18px] text-10' : 'h-6 w-6 text-12'}
        />
      </span>
    </span>
  );
}

/** A row of overlapped member avatars (header lockup and settings hero). */
export function BotGroupAvatarStack({
  members,
  size = 'xs',
  max = 3,
  className,
}: {
  members: readonly AvatarMember[];
  size?: 'xs' | 'md';
  max?: number;
  className?: string;
}) {
  const visible = members.slice(0, max);
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center', className)}>
      {visible.map((member, index) => (
        <span
          key={member.botId}
          className={cn(
            'flex rounded-full border-2 border-[var(--surface)]',
            index > 0 && (size === 'xs' ? '-ml-2' : '-ml-3'),
          )}
        >
          <BotAvatar bot={member} size={size} />
        </span>
      ))}
    </span>
  );
}
