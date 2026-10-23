import { useRef, type ReactNode } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  lineHeight,
  monoFont,
  spacing,
  typeScale,
  useTheme,
  lightColors,
  darkColors,
} from "@/theme";
import type { LayoutRect } from "@/platform/windowGeometry";
import { retroMacArtwork } from "./retroMacArtwork";
import { FoldTouchpad } from "./FoldTouchpad";

export const FOLD_DESKTOP_SKINS = [
  "classic",
  "compact",
  "edge",
  "macii",
  "powerbook",
  "thinkpad",
  "modern",
] as const;
export type FoldDesktopSkin = (typeof FOLD_DESKTOP_SKINS)[number];
export type RetroDesktopSkin = Exclude<FoldDesktopSkin, "modern">;
export function foldDesktopSkinColors(skin: FoldDesktopSkin) {
  return skin === "powerbook" || skin === "thinkpad" ? darkColors : lightColors;
}
function heritageArtwork(skin: FoldDesktopSkin) {
  return skin === "macii" || skin === "powerbook" || skin === "thinkpad"
    ? retroMacArtwork.heritage[skin]
    : null;
}
const VIEWPORTS = {
  macii: { x: 0.072, y: 0.082, width: 0.856, height: 0.73 },
  powerbook: { x: 0.08, y: 0.11, width: 0.84, height: 0.765 },
  thinkpad: { x: 0.07, y: 0.107, width: 0.86, height: 0.805 },
  classic: { x: 0.12, y: 0.155, width: 0.76, height: 0.57 },
  compact: { x: 0.052, y: 0.072, width: 0.896, height: 0.748 },
  edge: { x: 0.05, y: 0.075, width: 0.9, height: 0.85 },
};
function adjacentSkin(
  skin: FoldDesktopSkin,
  direction: number,
): FoldDesktopSkin {
  const i = FOLD_DESKTOP_SKINS.indexOf(skin);
  return FOLD_DESKTOP_SKINS[
    (i + direction + FOLD_DESKTOP_SKINS.length) % FOLD_DESKTOP_SKINS.length
  ];
}

/** The live surface fits inside the rendered CRT's black opening. */
export function retroDesktopViewport(
  region: LayoutRect,
  skin: RetroDesktopSkin = "classic",
): LayoutRect {
  const inset = VIEWPORTS[skin];
  return {
    x: region.x + region.width * inset.x,
    y: region.y + region.height * inset.y,
    width: region.width * inset.width,
    height: region.height * inset.height,
  };
}

/** Case material bleeds behind system chrome; only controls use safe geometry. */
export function FoldDesktopBackdrop({ skin }: { skin: RetroDesktopSkin }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Image
        source={
          heritageArtwork(skin)?.palm ?? retroMacArtwork.heritage.macii.palm
        }
        resizeMode="repeat"
        style={styles.artwork}
      />
    </View>
  );
}

/** A non-interactive case around the live desktop; it never replaces the viewer. */
export function FoldDesktopBezel({
  region,
  skin = "classic",
}: {
  region: LayoutRect;
  skin?: RetroDesktopSkin;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="remoteDesktop.retroBezel"
      style={[
        { position: "absolute" },
        {
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        },
      ]}
    >
      <Image
        source={
          skin === "compact" || skin === "edge"
            ? retroMacArtwork[skin]
            : (heritageArtwork(skin)?.display ?? retroMacArtwork.display)
        }
        resizeMode="stretch"
        style={styles.artwork}
      />
    </View>
  );
}

/** A dedicated swipe rail keeps skin navigation out of the remote pointer gesture. */
export function FoldDesktopSkinSwitch({
  skin,
  onChange,
}: {
  skin: FoldDesktopSkin;
  onChange(value: FoldDesktopSkin): void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const retro = skin !== "modern";
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <View
      testID="remoteDesktop.skinSwipe"
      onStartShouldSetResponderCapture={(e) => {
        start.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        return false;
      }}
      onMoveShouldSetResponderCapture={(e) => {
        if (!start.current) return false;
        const dx = e.nativeEvent.pageX - start.current.x,
          dy = e.nativeEvent.pageY - start.current.y;
        return Math.abs(dx) >= 12 && Math.abs(dx) > Math.abs(dy) * 1.5;
      }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        start.current ??= { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
      }}
      onResponderRelease={(e) => {
        const origin = start.current;
        start.current = null;
        if (!origin) return;
        const dx = e.nativeEvent.pageX - origin.x,
          dy = e.nativeEvent.pageY - origin.y;
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5)
          onChange(adjacentSkin(skin, dx < 0 ? 1 : -1));
      }}
      onResponderTerminate={() => {
        start.current = null;
      }}
      style={styles.switchRail}
    >
      <Pressable
        testID="remoteDesktop.skinSwitch"
        accessibilityRole="button"
        accessibilityLabel={t("remoteDesktop.nextSkin")}
        accessibilityValue={{ text: t(`remoteDesktop.skin_${skin}`) }}
        accessibilityHint={t("remoteDesktop.skinSwipeHint")}
        onPress={() => onChange(adjacentSkin(skin, 1))}
        style={styles.switchButton}
      >
        <Text
          style={[
            styles.legend,
            {
              color: retro
                ? foldDesktopSkinColors(skin).textSecondary
                : colors.textTertiary,
            },
          ]}
        >
          {t(`remoteDesktop.skin_${skin}`)}
          {`  ‹  ${FOLD_DESKTOP_SKINS.indexOf(skin) + 1} / ${FOLD_DESKTOP_SKINS.length}  ›`}
        </Text>
      </Pressable>
    </View>
  );
}

const ROWS = [
  [
    "Escape",
    ..."1234567890".split("").map((key) => `Digit${key}`),
    "Backspace",
  ],
  ["Tab", ..."QWERTYUIOP".split("").map((key) => `Key${key}`)],
  [..."ASDFGHJKL".split("").map((key) => `Key${key}`), "Enter"],
  [
    "ShiftLeft",
    ..."ZXCVBNM".split("").map((key) => `Key${key}`),
    "Comma",
    "Period",
    "ArrowUp",
  ],
  [
    "ControlLeft",
    "AltLeft",
    "MetaLeft",
    "Space",
    "ArrowLeft",
    "ArrowDown",
    "ArrowRight",
  ],
];

export function FoldDesktopKeys({
  renderKey,
  fill = false,
  trackpoint = false,
}: {
  renderKey(code: string): ReactNode;
  fill?: boolean;
  trackpoint?: boolean;
}) {
  return (
    <View
      testID="remoteDesktop.retroKeys"
      style={[styles.keys, fill && { flex: 1 }]}
    >
      {ROWS.map((row, index) => (
        <View key={index} style={[styles.keyRow, fill && { flex: 1 }]}>
          {row.map(renderKey)}
        </View>
      ))}
      {trackpoint && (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            left: "50%",
            top: "60%",
            width: 18,
            height: 18,
            marginLeft: -9,
            marginTop: -9,
          }}
        >
          <Image
            source={retroMacArtwork.trackpoint}
            style={styles.artwork}
            resizeMode="contain"
          />
        </View>
      )}
    </View>
  );
}

/** Hardware keeps its historical material in either theme; its palmrest is a larger invisible input surface. */
export function FoldDesktopDeck({
  renderKey,
  send,
  enabled,
  skin,
  onChange,
}: {
  renderKey(code: string): ReactNode;
  send(message: object): void;
  enabled: boolean;
  skin: RetroDesktopSkin;
  onChange(value: FoldDesktopSkin): void;
}) {
  const artwork = heritageArtwork(skin);
  if (skin !== "classic")
    return (
      <View testID="remoteDesktop.retroDeck" style={{ flex: 1 }}>
        <View style={{ height: 44 }}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Image
              source={artwork?.rail ?? retroMacArtwork.rail}
              resizeMode="stretch"
              style={styles.artwork}
            />
          </View>
          <FoldDesktopSkinSwitch skin={skin} onChange={onChange} />
        </View>
        <View style={{ flex: 4, minHeight: 244, overflow: "hidden" }}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Image
              source={artwork?.keys ?? retroMacArtwork.keys}
              resizeMode="stretch"
              style={styles.artwork}
            />
          </View>
          <ScrollView
            style={{
              flex: 1,
              marginHorizontal: artwork ? "5%" : "3.2%",
              marginVertical: 6,
            }}
            contentContainerStyle={{ flexGrow: 1 }}
            bounces={false}
          >
            <FoldDesktopKeys
              renderKey={renderKey}
              fill
              trackpoint={skin === "thinkpad"}
            />
          </ScrollView>
        </View>
        <View style={{ flex: 1, minHeight: 68 }}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Image
              source={artwork?.palm ?? retroMacArtwork.pad}
              resizeMode={artwork ? "cover" : "stretch"}
              style={styles.artwork}
            />
          </View>
          {artwork && (
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[
                StyleSheet.absoluteFill,
                { alignItems: "center", justifyContent: "center" },
              ]}
            >
              <Image
                source={artwork.control}
                resizeMode="contain"
                style={{
                  width: skin === "powerbook" ? 66 : 96,
                  height: skin === "powerbook" ? 60 : 44,
                }}
              />
            </View>
          )}
          <View testID="remoteDesktop.palmrest" style={StyleSheet.absoluteFill}>
            <FoldTouchpad send={send} enabled={enabled} bare />
          </View>
        </View>
      </View>
    );
  return (
    <View testID="remoteDesktop.retroDeck" style={{ flex: 1 }}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Image
          source={retroMacArtwork.deck}
          resizeMode="stretch"
          style={styles.artwork}
        />
      </View>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
        <FoldDesktopSkinSwitch skin={skin} onChange={onChange} />
      </View>
      <ScrollView
        style={{
          position: "absolute",
          left: "9%",
          width: "82%",
          top: "11%",
          height: "53%",
        }}
        bounces={false}
      >
        <FoldDesktopKeys renderKey={renderKey} />
      </ScrollView>
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "66%",
          bottom: 0,
        }}
      >
        <FoldTouchpad send={send} enabled={enabled} bare />
      </View>
    </View>
  );
}

export function FoldDesktopKeycap({
  skin = "classic",
}: {
  skin?: FoldDesktopSkin;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Image
        source={
          skin === "powerbook" || skin === "thinkpad"
            ? retroMacArtwork.darkKeycap
            : retroMacArtwork.keycap
        }
        resizeMode="stretch"
        style={styles.artwork}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Native Image keeps its asset's intrinsic size unless both dimensions are
  // explicit; absoluteFill alone does not constrain a bundled bitmap.
  artwork: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  legend: {
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular,
  },
  switchRail: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  switchButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
  },
  keys: {
    padding: 2,
    gap: 2,
  },
  keyRow: { flexDirection: "row", gap: 2 },
});
