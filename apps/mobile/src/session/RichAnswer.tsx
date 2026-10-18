import {
  Mail,
  CalendarDays,
  Folder,
  ChartColumn,
  Check,
  Info,
  Clock,
  MapPin,
  Coffee,
  Image,
  Users,
  Star,
} from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Fragment,
  useMemo,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  View,
  AppState,
  Pressable,
  Switch,
  StyleSheet,
  type GestureResponderEvent,
} from "react-native";
import { Text, TextInput } from "@/components/AppText";
import Svg, { Polyline, Line, Circle, Text as SvgText } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/AuthContext";
import {
  useTheme,
  useThemedStyles,
  spacing,
  radius,
  textStyles,
  fontWeight,
  iconSize,
  iconStroke,
  type ThemeColors,
} from "@/theme";
import {
  RichAnswerStream,
  RichInteractionMemory,
  richAction,
  richChart,
  richLinePlot,
  richResolvedValues,
  richCalculationUnavailable,
  richLabel,
  richMarkdown,
  richNumber,
  richOptions,
  richRange,
  richString,
  type RichNode,
  type RichValue,
} from "@cindy/maker-shared/rich-answer";

const answerIcons = {
  mail: Mail,
  calendar: CalendarDays,
  folder: Folder,
  chart: ChartColumn,
  check: Check,
  info: Info,
  clock: Clock,
  location: MapPin,
  coffee: Coffee,
  image: Image,
  users: Users,
  star: Star,
};

const memory = new RichInteractionMemory({
  async read() {
    return AsyncStorage.getItem("cindy.richAnswer.viewState.v1");
  },
  async write(value) {
    await AsyncStorage.setItem("cindy.richAnswer.viewState.v1", value);
  },
});
type Props = {
  source: string;
  complete: boolean;
  stateKey: string;
  renderMedia?: (node: RichNode) => ReactNode;
  renderMarkdown: (source: string, id: string) => ReactNode;
};
export function RichAnswer(props: Props) {
  const { user } = useAuth();
  const key = `${user?.id ?? "signed-out"}:${props.stateKey}`;
  return <RichDocumentView {...props} key={key} stateKey={key} />;
}
function RichDocumentView({
  source,
  complete,
  stateKey,
  renderMarkdown,
  renderMedia,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const parser = useRef(new RichAnswerStream());
  const doc = useMemo(
    () => parser.current.update(source, complete),
    [source, complete],
  );
  const edited = useSyncExternalStore(memory.subscribe, () =>
    memory.get(stateKey),
  );
  useEffect(() => {
    void memory.load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void memory.flush();
    });
    return () => {
      subscription.remove();
      void memory.flush();
    };
  }, []);
  const [width, setWidth] = useState(0);
  const values = richResolvedValues(doc, edited);
  const change = (key: string, value: RichValue) => {
    memory.set(stateKey, { [key]: value });
  };
  const apply = (node: RichNode) => {
    memory.set(stateKey, richAction(node, values));
  };
  const button = (label: string, action: () => void, selected?: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={action}
      style={[styles.button, selected && styles.selected]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  const render = (id: string): ReactNode => {
    const node = doc.nodes.get(id);
    if (!node) return null;
    if (richCalculationUnavailable(node, values))
      return (
        <Text style={styles.caption}>
          {complete ? t("message.richAnswer.calculationUnavailable") : "…"}
        </Text>
      );
    const bind = richString(node, "bind", id),
      label = richString(node, "label");
    const children = node.children.map((child) => (
      <Fragment key={child}>{render(child)}</Fragment>
    ));
    if (["image", "video", "audio"].includes(node.kind) && renderMedia)
      return (
        <View style={styles.content}>
          {renderMedia(node)}
          {richString(node, "caption") ? (
            <Text style={styles.caption}>{richString(node, "caption")}</Text>
          ) : null}
        </View>
      );
    const md = richMarkdown(node);
    if (md !== null)
      return (
        <View style={styles.content}>
          {renderMarkdown(md, id)}
          {richString(node, "caption") ? (
            <Text style={styles.caption}>{richString(node, "caption")}</Text>
          ) : null}
        </View>
      );
    switch (node.kind) {
      case "text":
      case "heading":
        return (
          <Text
            selectable
            style={node.kind === "heading" ? styles.heading : styles.text}
          >
            {richLabel(node, values)}
          </Text>
        );
      case "icon": {
        const name = richString(node, "name");
        const Icon = Object.prototype.hasOwnProperty.call(answerIcons, name)
          ? answerIcons[name as keyof typeof answerIcons]
          : Info;
        return (
          <View style={styles.iconRow}>
            <Icon
              size={iconSize.action}
              strokeWidth={iconStroke.thin}
              color={colors.textPrimary}
              accessible={false}
            />
            <View style={styles.iconBody}>
              <Text style={styles.iconTitle}>{label || name}</Text>
              {richString(node, "text") ? (
                <Text style={styles.text}>{richString(node, "text")}</Text>
              ) : null}
            </View>
          </View>
        );
      }
      case "divider":
        return <View style={styles.divider} />;
      case "stack":
      case "group":
        return <View style={styles.stack}>{children}</View>;
      case "row":
      case "grid": {
        const aside = richString(node, "layout") === "aside";
        const columns =
          width <= 600 && !aside
            ? 1
            : Math.round(
                Math.max(1, Math.min(3, richNumber(node, "columns", 2))),
              );
        return (
          <View style={styles.row}>
            {node.children.map((child, index) => (
              <View
                key={child}
                style={
                  aside
                    ? {
                        flexBasis: index === 0 ? "30%" : "60%",
                        flexGrow: 1,
                        minWidth: 0,
                      }
                    : {
                        width: `${100 / columns - (columns > 1 ? 2 : 0)}%`,
                        minWidth: 0,
                      }
                }
              >
                {render(child)}
              </View>
            ))}
          </View>
        );
      }
      case "stat":
        return (
          <View style={styles.stat}>
            <Text style={styles.caption}>{label}</Text>
            <Text selectable style={styles.statValue}>
              {richLabel(node, values)}
            </Text>
          </View>
        );
      case "input":
        return (
          <View style={styles.stack}>
            <Text style={styles.text}>{label}</Text>
            <TextInput
              accessibilityLabel={label}
              value={String(values[bind] ?? "")}
              onChangeText={(v) => change(bind, v)}
              maxLength={4096}
              placeholder={richString(node, "placeholder")}
              placeholderTextColor={colors.textPlaceholder}
              style={styles.input}
            />
          </View>
        );
      case "range":
        return (
          <View>
            <View style={styles.labelRow}>
              <Text style={styles.text}>{label}</Text>
              <Text style={styles.text}>
                {richRange(node, values[bind]).value}
                {richString(node, "suffix")}
              </Text>
            </View>
            <AnswerRange
              node={node}
              value={values[bind]}
              onChange={(v) => change(bind, v)}
            />
          </View>
        );
      case "check":
        return (
          <View style={styles.labelRow}>
            <Text style={[styles.text, styles.content]}>
              {label || richString(node, "text")}
            </Text>
            <Switch
              accessibilityLabel={label}
              value={Boolean(values[bind])}
              onValueChange={(v) => change(bind, v)}
              trackColor={{
                false: colors.borderStrong,
                true: colors.textSecondary,
              }}
            />
          </View>
        );
      case "select":
        return (
          <View style={styles.stack}>
            <Text style={styles.text}>{label}</Text>
            <View style={styles.row}>
              {richOptions(node).map((option) => (
                <Fragment key={option.value}>
                  {button(
                    option.label,
                    () => change(bind, option.value),
                    values[bind] === option.value,
                  )}
                </Fragment>
              ))}
            </View>
          </View>
        );
      case "button":
        return button(label || richString(node, "text"), () => apply(node));
      case "form":
        return (
          <View style={styles.stack}>
            {children}
            {label ? button(label, () => apply(node)) : null}
          </View>
        );
      case "details":
        return (
          <View style={styles.stack}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: Boolean(values[bind]) }}
              onPress={() => change(bind, !values[bind])}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{label}</Text>
            </Pressable>
            <View style={!values[bind] ? styles.hidden : undefined}>
              {children}
            </View>
          </View>
        );
      case "tabs": {
        const selected = node.children.includes(String(values[bind]))
          ? String(values[bind])
          : node.children[0];
        return (
          <View style={styles.stack}>
            <View style={styles.row}>
              {node.children.map((child) => (
                <Fragment key={child}>
                  {button(
                    richString(doc.nodes.get(child)!, "label", child),
                    () => change(bind, child),
                    selected === child,
                  )}
                </Fragment>
              ))}
            </View>
            {node.children.map((child) => (
              <View
                key={child}
                style={selected !== child ? styles.hidden : undefined}
              >
                {render(child)}
              </View>
            ))}
          </View>
        );
      }
      case "chart": {
        const data = richChart(node, values),
          min = Math.min(0, ...data.map((item) => item.value)),
          max = Math.max(0, ...data.map((item) => item.value)),
          span = max - min || 1;
        return (
          <View style={styles.stack}>
            <Text style={styles.text}>{label}</Text>
            {richString(node, "variant") === "line" ? (
              <AnswerLineChart data={data} label={label} />
            ) : null}
            {richString(node, "variant") !== "line" &&
              data.map((item, index) => (
                <View key={index}>
                  <View style={styles.labelRow}>
                    <Text style={styles.caption}>{item.label}</Text>
                    <Text style={styles.caption}>{item.value}</Text>
                  </View>
                  {richString(node, "variant") !== "line" ? (
                    <View style={styles.track}>
                      <View
                        style={[
                          styles.bar,
                          {
                            marginLeft: `${((Math.min(0, item.value) - min) / span) * 100}%`,
                            width: `${(Math.abs(item.value) / span) * 100}%`,
                          },
                        ]}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
          </View>
        );
      }
      default:
        return null;
    }
  };
  return (
    <View
      testID="message.richAnswer"
      style={styles.stack}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {doc.roots.map((id) => (
        <Fragment key={id}>{render(id)}</Fragment>
      ))}
      {doc.issues ? (
        <Text style={styles.caption}>{t("message.richAnswer.incomplete")}</Text>
      ) : null}
    </View>
  );
}
function AnswerLineChart({
  data,
  label,
}: {
  data: { label: string; value: number }[];
  label: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(320);
  const plot = richLinePlot(data, width);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Svg
        width="100%"
        height={plot.height}
        viewBox={`0 0 ${plot.width} ${plot.height}`}
        accessible
        accessibilityLabel={`${label}. ${data.map((item) => `${item.label}: ${item.value}`).join(", ")}`}
      >
        {plot.ticks.map((tick) => (
          <Fragment key={tick.value}>
            <Line
              x1={plot.left}
              x2={plot.width - plot.right}
              y1={tick.y}
              y2={tick.y}
              stroke={colors.border}
            />
            <SvgText
              x={plot.left - 6}
              y={tick.y + 4}
              textAnchor="end"
              fontSize={textStyles.footnote.fontSize}
              fill={colors.textSecondary}
            >
              {Number(tick.value.toPrecision(3))}
            </SvgText>
          </Fragment>
        ))}
        <Polyline
          fill="none"
          stroke={colors.textPrimary}
          strokeWidth={iconStroke.regular}
          points={plot.points.map((p) => `${p.x},${p.y}`).join(" ")}
        />
        {plot.points.map((p, i) => (
          <Fragment key={i}>
            <Circle cx={p.x} cy={p.y} r={3} fill={colors.textPrimary} />
            {plot.showValues ? (
              <SvgText
                x={p.x}
                y={p.y - 10}
                textAnchor="middle"
                fontSize={textStyles.footnote.fontSize}
                fill={colors.textPrimary}
              >
                {p.value}
              </SvgText>
            ) : null}
          </Fragment>
        ))}
      </Svg>
      <View
        style={[
          plot.showValues ? styles.chartLabels : styles.stack,
          plot.showValues && {
            paddingLeft: plot.left,
            paddingRight: plot.right,
          },
        ]}
      >
        {data.map((item, i) => (
          <View
            key={i}
            style={plot.showValues ? styles.chartLabel : styles.labelRow}
          >
            <Text
              style={[
                styles.caption,
                plot.showValues && styles.chartLabelText,
              ]}
            >
              {item.label}
            </Text>
            {!plot.showValues ? (
              <Text style={styles.caption}>{item.value}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
function AnswerRange({
  node,
  value,
  onChange,
}: {
  node: RichNode;
  value: unknown;
  onChange: (value: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const range = richRange(node, value),
    usable = Math.max(1, width - 28);
  const clamp = (n: number) => Math.max(range.min, Math.min(range.max, n));
  const pick = (event: GestureResponderEvent) => {
    const ratio = Math.max(
      0,
      Math.min(1, (event.nativeEvent.locationX - 14) / usable),
    );
    onChange(
      clamp(
        range.min +
          Math.round((ratio * (range.max - range.min)) / range.step) *
            range.step,
      ),
    );
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={richString(node, "label")}
      accessibilityValue={{ min: range.min, max: range.max, now: range.value }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) =>
        onChange(
          clamp(
            range.value +
              (event.nativeEvent.actionName === "increment"
                ? range.step
                : -range.step),
          ),
        )
      }
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={pick}
      onResponderMove={pick}
      style={styles.range}
    >
      <View pointerEvents="none" style={styles.rangeTrack} />
      <View
        pointerEvents="none"
        style={[
          styles.thumb,
          {
            left:
              ((range.value - range.min) / (range.max - range.min)) * usable,
          },
        ]}
      />
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    iconRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
    },
    iconBody: { flex: 1, gap: spacing.xs, minWidth: 0 },
    iconTitle: {
      ...textStyles.bodyLarge,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    chartLabels: { flexDirection: "row" },
    chartLabel: { flex: 1, minWidth: 0 },
    chartLabelText: { textAlign: "center" },
    stack: { gap: spacing.lg, minWidth: 0 },
    content: { minWidth: 0, flexShrink: 1 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    labelRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: spacing.md,
    },
    text: {
      ...textStyles.bodyLarge,
      color: colors.textPrimary,
      fontWeight: fontWeight.regular,
      flexShrink: 1,
    },
    heading: {
      ...textStyles.subtitle,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    caption: {
      ...textStyles.footnote,
      color: colors.textSecondary,
      fontWeight: fontWeight.regular,
    },
    stat: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingVertical: spacing.md,
      gap: spacing.xs,
    },
    statValue: {
      ...textStyles.headline,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    divider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.pill,
      alignSelf: "flex-start",
    },
    selected: { borderWidth: 1, borderColor: colors.borderStrong },
    buttonText: {
      ...textStyles.body,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    input: {
      ...textStyles.body,
      color: colors.textPrimary,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.pill,
      minHeight: 44,
      paddingHorizontal: spacing.lg,
    },
    hidden: { display: "none" },
    track: {
      height: 8,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.micro,
      overflow: "hidden",
    },
    bar: { height: "100%", backgroundColor: colors.textSecondary },
    range: { height: 44, justifyContent: "center" },
    rangeTrack: {
      height: 4,
      marginHorizontal: 14,
      backgroundColor: colors.borderStrong,
      borderRadius: radius.pill,
    },
    thumb: {
      position: "absolute",
      height: 28,
      width: 28,
      borderRadius: radius.pill,
      backgroundColor: colors.textPrimary,
    },
  });
