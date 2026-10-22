/**
 * 伙伴近况（手机）：点伙伴聊天顶栏的头像打开，与桌面 BotGlancePopover 同三块——电脑 / 待办 / 输出内容；
 * 没内容的块整块不出现。规则见 docs/product-rules/cindy-bots-runtime.md「伙伴近况」。
 * 待办行没有按钮：点一条交给对话（作为待办引用放进输入框），长按只有「删除」，可撤销。
 */
import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Check, ChevronDown, ChevronUp, Monitor } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { BotDelegationListResult } from '@cindy/maker-shared/botDelegation';
import { todoDateLabel, todoDue, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { readRemoteCollectionCache, remoteResourceConnectionState } from '@/device-link/remoteResourceAvailability';
import { iconSize, iconStroke, radius, spacing, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { ContextSheet, ContextSheetGroup, ContextSheetRow } from './ContextSheet';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import { companionGlanceOutputs } from './companionProfileData';
import type { useCompanionGlanceTodos } from './useCompanionGlanceTodos';

const TODO_PREVIEW = 5;
const OUTPUT_PREVIEW = 3;
const DUE_DOT = 6;
const CINDY_BOT_ID = 'cindy-default';

type GlanceTodoState = ReturnType<typeof useCompanionGlanceTodos>;

function dayLabel(at: number, language: string): string {
  const now = new Date();
  const date = new Date(at);
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  // Hermes has no Intl.RelativeTimeFormat; there recent days show as dates too.
  if (days >= 0 && days <= 1 && typeof Intl.RelativeTimeFormat === 'function') return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-days, 'day');
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(date);
}

export function CompanionGlanceSheet({
  visible, onClose, name, botId, deviceId, deviceName, sessionId, online, cloudHome, todos,
  onQuoteTodo, onOpenTask, onOpenCindy, onSwitchHome,
}: {
  visible: boolean;
  onClose(): void;
  name: string;
  botId: string;
  deviceId: string;
  deviceName: string;
  /** The teammate's conversation, whose delegations carry the outputs. */
  sessionId: string;
  online: boolean;
  /** A cloud companion homed on this computer: another computer is chosen in the existing switch flow. */
  cloudHome: boolean;
  todos: GlanceTodoState;
  onQuoteTodo(todo: TeammateTodo): void;
  onOpenTask(sessionId: string): void;
  onOpenCindy(hosted: HostedRemoteCollectionItem): void;
  onSwitchHome(): void;
}) {
  const { t } = useTranslation();
  return <ContextSheet visible={visible} onClose={onClose} title={t('devices.glance.open', { name })} keyboardAvoidingBehavior={undefined}
    testID="companion.glance">
    <ContextSheetGroup label={t('devices.glance.computers')}>
      <Computers botId={botId} deviceId={deviceId} deviceName={deviceName} online={online} cloudHome={cloudHome}
        onOpenCindy={onOpenCindy} onSwitchHome={onSwitchHome} />
    </ContextSheetGroup>
    <Todos todos={todos} online={online} onQuote={onQuoteTodo} />
    <Outputs botId={botId} deviceId={deviceId} sessionId={sessionId} online={online} onOpenTask={onOpenTask} />
  </ContextSheet>;
}

// ---------------------------------------------------------------- 电脑

function Computers({ botId, deviceId, deviceName, online, cloudHome, onOpenCindy, onSwitchHome }: {
  botId: string; deviceId: string; deviceName: string; online: boolean; cloudHome: boolean;
  onOpenCindy(hosted: HostedRemoteCollectionItem): void; onSwitchHome(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { user, accountGeneration } = useAuth();
  const { status, getPresenceAvailability } = useDeviceLink();
  const [showOffline, setShowOffline] = useState(false);
  const icon = <Monitor size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textSecondary} />;
  // Cindy runs a copy on each computer: the other copies come from the teammate list already read
  // on this phone (no extra discovery); other teammates only show the computer they run on.
  const copies = useMemo(() => {
    if (cloudHome || botId !== CINDY_BOT_ID) return [];
    return readRemoteCollectionCache(`${user?.id ?? ''}:${accountGeneration}`, 'teammates')
      .filter(row => row.item.ref.kind === 'bot' && row.item.ref.id === CINDY_BOT_ID && row.host.deviceId !== deviceId)
      .map(row => ({ row, online: remoteResourceConnectionState(status, getPresenceAvailability(row.host.deviceId)) === true }));
  }, [accountGeneration, botId, cloudHome, deviceId, getPresenceAvailability, status, user?.id]);
  const onlineCopies = copies.filter(copy => copy.online);
  const offlineCopies = copies.filter(copy => !copy.online);
  return <>
    <ContextSheetRow icon={icon} label={deviceName} detail={online ? t('devices.glance.runningHere') : t('devices.glance.offline')}
      trailing={<Check size={iconSize.lg} strokeWidth={iconStroke.medium} color={colors.textPrimary} />} onPress={() => undefined}
      testID="companion.glance.computer.current" />
    {onlineCopies.map(copy => <ContextSheetRow key={copy.row.key} icon={icon} label={copy.row.host.deviceName} detail={t('devices.glance.online')}
      dismissBeforePress onPress={() => onOpenCindy(copy.row)} testID={`companion.glance.computer.${copy.row.host.deviceId}`} />)}
    {offlineCopies.length > 0 ? <ContextSheetRow label={t('devices.glance.offlineCount', { count: offlineCopies.length })}
      trailing={<FoldIcon open={showOffline} />} onPress={() => setShowOffline(value => !value)} testID="companion.glance.computer.offline" /> : null}
    {showOffline ? offlineCopies.map(copy => <ContextSheetRow key={copy.row.key} icon={icon} label={copy.row.host.deviceName}
      detail={t('devices.glance.offline')} disabled onPress={() => undefined} />) : null}
    {cloudHome && online ? <ContextSheetRow label={t('devices.cloudCompanion.switchAction')} trailing="chevron" dismissBeforePress
      onPress={onSwitchHome} testID="companion.glance.computer.switch" /> : null}
  </>;
}

function FoldIcon({ open }: { open: boolean }) {
  const { colors } = useTheme();
  const Icon = open ? ChevronUp : ChevronDown;
  return <Icon size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textTertiary} />;
}

// ---------------------------------------------------------------- 待办

function sourceText(todo: TeammateTodo, t: (key: string) => string): string {
  const source = todo.sources[0];
  if (!source || source.kind === 'conversation') return t('devices.glance.source.conversation');
  const kind = t(`devices.glance.source.${source.kind}`);
  const label = source.label?.trim();
  // 来源名已含标签（「来自 GitHub」+「GitHub」）时不再重复。
  return label && !kind.toLowerCase().includes(label.toLowerCase()) ? `${kind} · ${label}` : kind;
}

function Todos({ todos, online, onQuote }: { todos: GlanceTodoState; online: boolean; onQuote(todo: TeammateTodo): void }) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [showAll, setShowAll] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [deleted, setDeleted] = useState<TeammateTodo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { open, done, doneTotal, openTotal } = todos.todos;
  if (open.length === 0 && doneTotal === 0 && !deleted) return null;

  const remove = async (todo: TeammateTodo) => {
    setError(null);
    try {
      const result = await todos.patch({ id: todo.id, expectedRevision: todo.revision, operation: 'delete' });
      setDeleted(result ?? todo);
      void todos.refresh();
    } catch {
      setError(t('devices.glance.deleteFailed'));
    }
  };
  const undo = async () => {
    const target = deleted;
    if (!target) return;
    setError(null);
    try {
      await todos.patch({ id: target.id, expectedRevision: target.revision, operation: 'restore' });
      setDeleted(null);
      void todos.refresh();
    } catch {
      setError(t('devices.glance.undoFailed'));
    }
  };
  const menu = (todo: TeammateTodo) => Alert.alert(todo.title, undefined, [
    { text: t('devices.glance.delete'), style: 'destructive', onPress: () => void remove(todo) },
    { text: t('devices.common.cancel'), style: 'cancel' },
  ]);
  const row = (todo: TeammateTodo, isDone: boolean) => {
    const due = !isDone && todoDue(todo);
    const completion = isDone ? todo.history[todo.history.length - 1]?.summary : undefined;
    return <ContextSheetRow key={todo.id} label={todo.title} detail={completion || sourceText(todo, t)}
      value={isDone ? undefined : todoDateLabel(todo, i18n.language) || undefined}
      trailing={due ? <View style={styles.dueDot} accessibilityLabel={t('devices.glance.dueUnseen')} /> : undefined}
      dismissBeforePress onPress={() => onQuote(todo)} onLongPress={online ? () => menu(todo) : undefined}
      testID={isDone ? 'companion.glance.todo.done' : 'companion.glance.todo'} />;
  };
  const visible = showAll ? open : open.slice(0, TODO_PREVIEW);
  return <ContextSheetGroup label={t('devices.glance.todos')} footer={error} footerTone="error">
    {deleted ? <ContextSheetRow label={t('devices.glance.undo')} detail={t('devices.glance.deleted')} onPress={() => void undo()}
      testID="companion.glance.todo.undo" /> : null}
    {visible.map(todo => row(todo, false))}
    {openTotal > TODO_PREVIEW ? <ContextSheetRow label={showAll ? t('devices.glance.showLess') : t('devices.glance.showMore')}
      trailing={<FoldIcon open={showAll} />} onPress={() => setShowAll(value => !value)} testID="companion.glance.todo.more" /> : null}
    {doneTotal > 0 ? <ContextSheetRow label={t('devices.glance.doneCount', { count: doneTotal })} trailing={<FoldIcon open={showDone} />}
      onPress={() => setShowDone(value => !value)} testID="companion.glance.todo.doneToggle" /> : null}
    {showDone ? done.map(todo => row(todo, true)) : null}
  </ContextSheetGroup>;
}

// ---------------------------------------------------------------- 输出内容

function Outputs({ botId, deviceId, sessionId, online, onOpenTask }: {
  botId: string; deviceId: string; sessionId: string; online: boolean; onOpenTask(sessionId: string): void;
}) {
  const { t, i18n } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const { value } = useRemoteCompanionQuery<BotDelegationListResult>(deviceId, 'maker:bot-delegations:list', [sessionId], { enabled: online && !!sessionId });
  const files = useMemo(() => companionGlanceOutputs(value, botId), [botId, value]);
  if (files.length === 0) return null;
  const visible = showAll ? files : files.slice(0, OUTPUT_PREVIEW);
  return <ContextSheetGroup label={t('devices.glance.outputs')}>
    {visible.map(file => <ContextSheetRow key={file.key} label={file.name}
      detail={t('devices.glance.outputMeta', { time: dayLabel(file.at, i18n.language), task: file.taskTitle })}
      dismissBeforePress onPress={() => onOpenTask(file.childSessionId)} testID="companion.glance.output" />)}
    {files.length > OUTPUT_PREVIEW ? <ContextSheetRow label={showAll ? t('devices.glance.showLess') : t('devices.glance.showMore')}
      trailing={<FoldIcon open={showAll} />} onPress={() => setShowAll(value => !value)} testID="companion.glance.output.more" /> : null}
  </ContextSheetGroup>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  dueDot: { width: DUE_DOT, height: DUE_DOT, borderRadius: radius.pill, backgroundColor: colors.statusError, marginLeft: spacing.xs },
});

