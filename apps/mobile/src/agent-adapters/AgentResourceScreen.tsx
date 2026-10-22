import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useTranslation } from "react-i18next";
import {
  resolveRemoteText,
  type RemoteActionDescriptor,
  type RemoteResource,
  type RemoteText,
} from "@cindy/device-link";
import {
  AGENT_ADAPTER_COLLECTION as collectionId,
  AGENT_ADAPTER_KIND as kind,
  agentAdapterCopy as copy,
} from "@cindy/maker-shared/agent-adapters";
import { useAuth } from "@/auth/AuthContext";
import { Text, TextInput } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getRemoteResource,
  invokeRemoteResourceAction,
} from "@/device-link/remoteResources";
import {
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
} from "@/platform/chrome";
import { ContextSheetSelectRow } from "@/session/ContextSheet";
import { goBackGuarded } from "@/utils/backGuard";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme/tokens";

export function AgentResourceScreen() {
  const { accountGeneration } = useAuth();
  const params = useLocalSearchParams<{
    deviceId: string;
    deviceName: string;
    resourceId: string;
  }>();
  return (
    <AgentResourceContent
      key={accountGeneration + ":" + params.deviceId + ":" + params.resourceId}
      deviceId={params.deviceId}
      deviceName={params.deviceName || params.deviceId}
      resourceId={params.resourceId}
    />
  );
}
function AgentResourceContent({
  deviceId,
  deviceName,
  resourceId,
}: {
  deviceId: string;
  deviceName: string;
  resourceId: string;
}) {
  const { invoke, openLink, status, connectionEpoch } = useDeviceLink();
  const { i18n } = useTranslation(),
    router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const label = (text: RemoteText) => resolveRemoteText(text, i18n.language);
  const [resource, setResource] = useState<RemoteResource | null>(null);
  const [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const locked = useRef(false),
    mounted = useRef(true),
    focused = useRef(false);
  const epoch = useRef(connectionEpoch);
  epoch.current = connectionEpoch;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const select = (id: string) =>
    router.replace({
      pathname: "/resources/[collectionId]/[resourceId]",
      params: {
        collectionId,
        resourceId: id,
        resourceKind: kind,
        deviceId,
        deviceName,
      },
    });
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      let disposed = false,
        timer: ReturnType<typeof setTimeout> | undefined,
        inFlight = false,
        delay = 2000,
        failedSince = 0;
      const read = async () => {
        if (disposed || inFlight || AppState.currentState !== "active") return;
        if (status !== "online") {
          setFailed(true);
          return;
        }
        inFlight = true;
        try {
          await openLink(deviceId);
          if (disposed) return;
          const next = await getRemoteResource(
            invoke,
            { deviceId, deviceName },
            { collectionId, kind, id: resourceId },
            i18n.language,
            ["form"],
          );
          if (!disposed) {
            setResource(next);
            setFailed(false);
          }
          failedSince = 0;
          delay = resourceId === "catalog" ? 10_000 : 2000;
        } catch {
          if (!disposed) setFailed(true);
          failedSince ||= Date.now();
          delay = Math.min(delay * 2, 10_000);
        } finally {
          inFlight = false;
          if (!disposed && (!failedSince || Date.now() - failedSince < 120_000))
            timer = setTimeout(() => {
              void read();
            }, delay);
        }
      };
      const visibility = AppState.addEventListener("change", (state) => {
        clearTimeout(timer);
        if (state === "active") void read();
      });
      void read();
      return () => {
        disposed = true;
        focused.current = false;
        clearTimeout(timer);
        visibility.remove();
      };
    }, [
      connectionEpoch,
      deviceId,
      deviceName,
      resourceId,
      i18n.language,
      invoke,
      openLink,
      refresh,
      status,
    ]),
  );
  const action = async (actionId: string, input: Record<string, unknown>) => {
    if (locked.current || !focused.current || status !== "online" || failed)
      return false;
    locked.current = true;
    setBusy(true);
    const generation = connectionEpoch;
    try {
      const response = await invokeRemoteResourceAction(
        invoke,
        { deviceId, deviceName },
        {
          collectionId,
          resourceRef: { collectionId, kind, id: resourceId },
          actionId,
          input,
        },
        i18n.language,
      );
      if (!mounted.current || !focused.current || epoch.current !== generation)
        return false;
      const effect = response.effects.find((e) => e.kind === "navigate");
      if (
        effect?.kind === "navigate" &&
        effect.target.kind === "resource" &&
        effect.target.ref.collectionId === collectionId &&
        effect.target.ref.kind === kind
      )
        select(effect.target.ref.id);
      setRefresh((n) => n + 1);
      return true;
    } catch {
      if (mounted.current) setFailed(true);
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.screen}>
      <SimpleStackHeader
        title={label(copy.title)}
        subtitle={deviceName}
        onBack={() =>
          resourceId === "catalog" ? goBackGuarded(router) : select("catalog")
        }
      />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <MainWindowActionButton
          action={{
            label: label(copy.refresh),
            onPress: () => setRefresh((n) => n + 1),
          }}
        />
        {failed && (
          <Text accessibilityRole="alert" style={styles.hint}>
            {label(copy.error)}
          </Text>
        )}
        {resource && (
          <>
            <Text style={styles.title}>{label(resource.display.title)}</Text>
            {resource.display.status && (
              <Text style={styles.hint}>
                {label(resource.display.status.label)}
              </Text>
            )}
            {resource.display.subtitle && (
              <Text style={styles.hint}>
                {label(resource.display.subtitle)}
              </Text>
            )}
            {resource.blocks?.map((block) => (
              <Text
                key={block.id}
                selectable
                style={block.id === "output" ? styles.body : styles.hint}
              >
                {block.fallbackMarkdown}
              </Text>
            ))}
            {resource.actions?.map((item) => (
              <AgentResourceAction
                key={item.id}
                descriptor={item}
                disabled={busy || failed || status !== "online"}
                label={label}
                submit={(input) => action(item.id, input)}
              />
            ))}
            {resource.links
              .filter((link) => link.rel === "item")
              .map(
                (link) =>
                  link.target.kind === "resource" && (
                    <MainWindowActionButton
                      key={link.target.ref.id}
                      action={{
                        label: link.label
                          ? label(link.label)
                          : link.target.ref.id,
                        onPress: () => {
                          if (link.target.kind === "resource")
                            select(link.target.ref.id);
                        },
                      }}
                    />
                  ),
              )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
export function AgentResourceAction({
  descriptor,
  disabled,
  label,
  submit,
}: {
  descriptor: RemoteActionDescriptor;
  disabled: boolean;
  label: (text: RemoteText) => string;
  submit: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const styles = useThemedStyles(makeStyles),
    { colors } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const locked = useRef(false),
    receipt = useRef<{ fingerprint: string; id: string } | null>(null);
  const fields = descriptor.fields ?? [];
  const ready = fields.every(
    (field) =>
      !field.required ||
      (values[field.id]?.trim() &&
        (field.kind !== "select" ||
          field.options?.some((option) => option.value === values[field.id]))),
  );
  const blocked = disabled || descriptor.disabled || !ready;
  const send = async () => {
    if (locked.current || blocked) return;
    locked.current = true;
    try {
      const fingerprint = JSON.stringify(values);
      if (receipt.current?.fingerprint !== fingerprint)
        receipt.current = { fingerprint, id: randomUUID() };
      if (await submit({ ...values, requestId: receipt.current.id })) {
        receipt.current = null;
        setValues({});
      }
    } finally {
      locked.current = false;
    }
  };
  return (
    <View style={styles.form}>
      {fields.map((field) => (
        <View key={field.id} style={styles.form}>
          <Text style={styles.label}>{label(field.label)}</Text>
          {field.kind === "select" ? (
            <ContextSheetSelectRow
              label={label(copy.choose)}
              value={values[field.id] ?? ""}
              disabled={disabled || descriptor.disabled}
              options={(field.options ?? []).map((option) => ({
                id: option.value,
                label: label(option.label),
              }))}
              onChange={(value) =>
                setValues((previous) => ({ ...previous, [field.id]: value }))
              }
            />
          ) : (
            <TextInput
              accessibilityLabel={label(field.label)}
              style={styles.input}
              multiline
              maxLength={32_000}
              placeholderTextColor={colors.textPlaceholder}
              editable={!disabled && !descriptor.disabled}
              value={values[field.id] ?? ""}
              onChangeText={(value) =>
                setValues((previous) => ({ ...previous, [field.id]: value }))
              }
            />
          )}
        </View>
      ))}
      <MainWindowActionButton
        action={{
          label: label(descriptor.label),
          disabled: blocked,
          onPress: () => {
            void send();
          },
        }}
      />
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface },
    content: { padding: spacing.xl, gap: spacing.lg },
    form: { gap: spacing.sm },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
    },
    body: {
      color: colors.textPrimary,
      fontSize: typeScale.bodyLarge,
      lineHeight: lineHeight.bodyLarge,
      fontWeight: fontWeight.regular,
    },
    hint: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    label: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    input: {
      color: colors.textPrimary,
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.control,
      padding: spacing.md,
      minHeight: 100,
      textAlignVertical: "top",
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
    },
  });
