import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TerminalClient } from '../contracts.js';
import type { ChannelRegistrationState } from '../im/registration.js';
import type { Locale } from './i18n.js';
import { authenticationText } from './authenticationText.js';
import { terminalText } from './input.js';

const labels = {
  en: ['Create and connect', 'Connected', 'Created · connecting', 'Connected on another device', 'Enter to return'],
  'zh-CN': ['创建并连接', '已连接', '已创建 · 连接中', '已在另一台设备连接', 'Enter 返回'],
  'zh-TW': ['建立並連線', '已連線', '已建立 · 連線中', '已在另一台裝置連線', 'Enter 返回'],
  ja: ['作成して接続', '接続済み', '作成済み · 接続中', '別のデバイスで接続中', 'Enter で戻る'],
  ko: ['만들고 연결', '연결됨', '생성됨 · 연결 중', '다른 기기에서 연결됨', 'Enter로 돌아가기'],
} satisfies Record<Locale, string[]>;

/** The local controller owns the encrypted remote exchange. Neither the
 * resource invocation nor a broadcast event carries an authorization code. */
export function ChannelRegistration({ client, device, service, locale, onDone }: {
  client: TerminalClient; device?: string; service: string; locale: Locale; onDone(): void;
}) {
  const t = authenticationText(locale), l = labels[locale];
  const [state, setState] = useState<ChannelRegistrationState>();
  const id = useRef<string | undefined>(undefined);
  const done = useRef(onDone); done.current = onDone;
  const cancel = async (requestId: string) => { await client.invoke('terminal:channel-registration', [{ command: 'cancel', id: requestId }]).catch(() => {}); };
  useEffect(() => {
    let disposed = false, timer: NodeJS.Timeout | undefined, expiresAt: number | undefined;
    const apply = (next: ChannelRegistrationState) => {
      if (disposed) return;
      setState(next);
      expiresAt = next.expiresAt;
      if (next.status === 'pending') timer = setTimeout(() => { void read(); }, 1500);
    };
    const read = async () => {
      if (expiresAt !== undefined && Date.now() >= expiresAt) { apply({ status: 'expired' }); if (id.current) void cancel(id.current); return; }
      try {
        const result = await client.invoke<{ state: ChannelRegistrationState }>('terminal:channel-registration', [{ command: 'read', id: id.current }]);
        apply(result.state);
      } catch { if (!disposed) setState({ status: 'error' }); }
    };
    void client.invoke<{ id: string; state: ChannelRegistrationState }>('terminal:channel-registration', [{ command: 'begin', service, ...(device ? { deviceId: device } : {}) }]).then(result => {
      if (disposed) { void cancel(result.id); return; }
      id.current = result.id; apply(result.state);
    }).catch(() => { if (!disposed) setState({ status: 'error' }); });
    return () => { disposed = true; clearTimeout(timer); if (id.current) void cancel(id.current); id.current = undefined; };
  }, [client, device, service]);
  useInput((_input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || key.return && state && state.status !== 'pending') done.current();
  });
  const status = state?.status;
  const failed = status === 'error' || state?.verdict === 'error';
  return <Box flexDirection="column" gap={1}>
    <Text bold>{l[0]}</Text>
    {!state && <Text>{t.loading}</Text>}
    {status === 'pending' && <>
      <Text>{t.openBrowser}</Text>
      <Text wrap="wrap">{terminalText(state?.verificationUrl ?? '')}</Text>
      <Text bold>{terminalText(state?.userCode ?? '')}</Text>
      <Text dimColor>{t.waitBrowser}</Text>
    </>}
    {status === 'success' && !failed && <Text>{state?.verdict === 'conflict' ? l[3] : state?.verdict === 'connected' ? l[1] : l[2]}</Text>}
    {status === 'expired' && <Text>{t.browserExpired}</Text>}
    {status === 'cancelled' && <Text>{t.cancelled}</Text>}
    {failed && <Text color="red">{t.failed}</Text>}
    <Text dimColor>{state && status !== 'pending' ? l[4] : `Esc · ${t.cancel}`}</Text>
  </Box>;
}
