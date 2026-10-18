import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { useTheme, textStyles } from "@/theme";
import { prepareHtmlAnswer } from "@cindy/maker-shared/html-answer";
import { HtmlFileReader } from "./HtmlFileReader";

export function HtmlAnswerPreview({
  html,
  active = true,
}: {
  html: string;
  active?: boolean;
}) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const [source, setSource] = useState(false);
  const [height, setHeight] = useState(320);
  const documentHtml = useMemo(
    () =>
      prepareHtmlAnswer(html, {
        background: colors.surface,
        foreground: colors.textPrimary,
        dark: mode === "dark",
      }),
    [html, colors.surface, colors.textPrimary, mode],
  );
  return (
    <View testID="message.htmlAnswer" style={{ alignSelf: "stretch" }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setSource(!source)}
        style={{
          alignSelf: "flex-end",
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: 8,
        }}
      >
        <Text style={[textStyles.bodySmall, { color: colors.textSecondary }]}>
          {t(
            source
              ? "files.preview.browserShowPage"
              : "files.preview.browserShowSource",
          )}
        </Text>
      </Pressable>
      {source ? (
        <Text
          selectable
          style={[textStyles.bodySmall, { color: colors.textPrimary }]}
        >
          {html}
        </Text>
      ) : (
        <View style={{ height }}>
          {active ? (
            <HtmlFileReader html={documentHtml} onContentHeight={setHeight} />
          ) : null}
        </View>
      )}
    </View>
  );
}
