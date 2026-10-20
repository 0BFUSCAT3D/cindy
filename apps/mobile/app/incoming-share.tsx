import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { goBackGuarded } from '@/utils/backGuard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { toDeviceListItems } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useAuth } from '@/auth/AuthContext';
import { discardIncomingShareBatch, incomingShareDestination, incomingShareText, selectIncomingShareDestination, useIncomingShareBatch } from '@/session/incomingShare';
import { useTeammateRoster } from '@/session/useTeammateRoster';
import { teammateResourceRoute } from '@/session/teammateNavigation';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

type Task = { deviceId: string; deviceName: string; session: RemoteSession };

/** A destination chooser, not a second sending pipeline. Nothing is sent by selecting a row. */
export default function IncomingShareScreen() {
  const batch = useIncomingShareBatch();
  const focused = useIsFocused();
  const router = useRouter();
  const navigation = useNavigation();
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { accountGeneration } = useAuth();
  const { readDeviceList, openLink, invoke, status, presenceVersion } = useDeviceLink();
  const revoked = useRevokedDevices();
  const roster = useTeammateRoster(focused && !!batch);
  const [query, setQuery] = useState('');
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!focused || !batch) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    setTasks([]); setLoading(true); setError(false);
    void readDeviceList().then(async response => {
      const devices = toDeviceListItems(response.devices, Date.now(), revoked);
      const groups: Task[][] = devices.map(() => []);
      let failed = false;
      await Promise.all(devices.map(async ({ device, canOpen }, index) => {
        const publish = (sessions: RemoteSession[]) => {
          groups[index] = sessions.filter(session => session.status === 'active' && session.source !== 'bot'
            && session.orcaRole !== 'worker').map(session => ({ deviceId: device.deviceId, deviceName: device.name, session }));
          if (current()) setTasks(groups.flat());
        };
        if (!current()) return;
        publish(remoteSessionStore.getSessions().filter(session => session.deviceLinkDeviceId === device.deviceId));
        if (!canOpen) return;
        try {
          await openLink(device.deviceId);
          const sessions = await invoke<RemoteSession[]>(device.deviceId, 'local-db:sessions:list',
            [500, 'active', { includePinned: true, fresh: true }], { preSend: () => {
              if (!current()) throw new Error('INCOMING_SHARE_PICKER_CLOSED');
            } });
          if (current()) publish(Array.isArray(sessions) ? sessions : []);
        } catch { failed = true; }
      }));
      if (current()) setError(failed);
    }).catch(() => { if (current()) setError(true); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { disposed = true; };
  }, [focused, batch?.id, accountGeneration, readDeviceList, openLink, invoke, status, presenceVersion, attempt, revoked]);
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase(i18n.language);
  const matches = (title: string) => title.normalize('NFKC').toLocaleLowerCase(i18n.language).includes(needle);
  const text = batch ? incomingShareText(batch.payloads) : '';
  const files = batch?.payloads.filter(item => item.shareType !== 'text' && item.shareType !== 'url') ?? [];
  const handoffBatchId = useRef<string | null>(null);
  const choose = (destination: string, action: () => void) => {
    if (!batch) return;
    handoffBatchId.current = batch.id;
    if (selectIncomingShareDestination(batch.id, destination)) action();
    else handoffBatchId.current = null;
  };
  // Removing the chooser during a handoff retains the batch for its composer.
  // Header/gesture cancellation still acknowledges and cleans the owned copies.
  usePreventRemove(!!batch, ({ data }) => {
    try { if (batch && handoffBatchId.current !== batch.id) discardIncomingShareBatch(batch.id); }
    catch { setDismissError(t('composer.upload.shareReceiveFailed')); return; }
    navigation.dispatch(data.action);
  });
  const back = () => goBackGuarded(router);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
    <SimpleStackHeader title={t('composer.incomingShare.title')} onBack={back} />
    {!!dismissError && <Text style={styles.note}>{dismissError}</Text>}
    {!batch ? <Text style={styles.note}>{t('composer.incomingShare.empty')}</Text> : <>
      <View style={styles.preview}>
        {!!text && <Text numberOfLines={4} style={styles.body}>{text}</Text>}
        {files.slice(0, 3).map((file, index) => <Text key={index} numberOfLines={1} style={styles.note}>
          {file.originalName || t('composer.incomingShare.file')}
        </Text>)}
        {files.length > 3 && <Text style={styles.note}>{t('composer.incomingShare.fileCount', { count: files.length })}</Text>}
        <Text style={styles.note}>{t('composer.incomingShare.hint')}</Text>
      </View>
      <TextInput value={query} onChangeText={setQuery} style={styles.search}
        placeholder={t('composer.incomingShare.search')} accessibilityLabel={t('composer.incomingShare.search')}
        placeholderTextColor={colors.textPlaceholder} autoCorrect={false} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
        <Pressable accessibilityRole="button" style={styles.row} onPress={() => choose('new', () => router.dismissTo('/sessions/new'))}>
          <Text style={styles.title}>{t('composer.incomingShare.newTask')}</Text>
        </Pressable>
        <Text style={styles.sectionLabel}>{t('composer.incomingShare.companions')}</Text>
        {roster.items.filter(row => matches(resolveRemoteText(row.item.display.title, i18n.language))).map(row => {
          const route = teammateResourceRoute(row, i18n.language);
          const conversation = row.item.links.find(link => link.rel === 'conversation')?.target;
          return <Pressable key={row.key} accessibilityRole="button" style={styles.row}
            disabled={conversation?.kind !== 'session'} onPress={() => {
              if (conversation?.kind === 'session') choose(incomingShareDestination(row.host.deviceId, conversation.sessionId), () => router.dismissTo(route));
            }}>
            <Text style={styles.title}>{resolveRemoteText(row.item.display.title, i18n.language)}</Text>
            <Text style={styles.note}>{row.host.deviceName}{conversation?.kind !== 'session' ? ` · ${t('composer.incomingShare.unavailable')}` : ''}</Text>
          </Pressable>;
        })}
        {roster.loading && <ActivityIndicator color={colors.textSecondary} />}
        {!roster.loading && !roster.items.length && <Text style={styles.note}>{t('composer.incomingShare.noCompanions')}</Text>}
        {!!roster.error && <Pressable style={styles.row} onPress={() => void roster.refresh()}><Text style={styles.note}>{t('composer.incomingShare.retry')}</Text></Pressable>}
        <Text style={styles.sectionLabel}>{t('composer.incomingShare.tasks')}</Text>
        {tasks.filter(row => matches(row.session.title)).map(row => <Pressable
          key={incomingShareDestination(row.deviceId, row.session.id)} accessibilityRole="button" style={styles.row}
          onPress={() => choose(incomingShareDestination(row.deviceId, row.session.id), () => router.dismissTo({
            pathname: '/sessions/[sessionId]', params: { deviceId: row.deviceId, deviceName: row.deviceName, sessionId: row.session.id },
          }))}>
          <Text style={styles.title}>{row.session.title}</Text><Text style={styles.note}>{row.deviceName}</Text>
        </Pressable>)}
        {loading && <ActivityIndicator color={colors.textSecondary} />}
        {!loading && !tasks.length && <Text style={styles.note}>{t('composer.incomingShare.noTasks')}</Text>}
        {error && <Pressable style={styles.row} onPress={() => setAttempt(value => value + 1)}><Text style={styles.note}>{t('composer.incomingShare.retry')}</Text></Pressable>}
      </ScrollView>
    </>}
  </SafeAreaView>;
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.surface },
  preview: { margin: spacing.md, gap: spacing.xs },
  search: { marginHorizontal: spacing.md, padding: spacing.md, borderRadius: radius.control,
    backgroundColor: c.surfaceChip, color: c.textPrimary, fontSize: typeScale.bodySmall, fontWeight: fontWeight.regular },
  list: { padding: spacing.md },
  row: { minHeight: 48, paddingVertical: spacing.md, gap: spacing.xs },
  title: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.textPrimary },
  body: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: c.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
  sectionLabel: { marginTop: spacing.md, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, color: c.textTertiary },
});
