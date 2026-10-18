import { useMemo, useState } from "react";
import { View } from "react-native";
import { useTheme } from "@/theme";
import { HTML_ANSWER_MAX_HEIGHT, prepareHtmlAnswer } from "@cindy/maker-shared/html-answer";
import { HtmlFileReader } from "./HtmlFileReader";

export function HtmlAnswerPreview({
  html,
  active = true,
}: {
  html: string;
  active?: boolean;
}) {
  const { colors, mode } = useTheme();
  const [height, setHeight] = useState(1);
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
    <View testID="message.htmlAnswer" style={{ alignSelf: "stretch", height }}>
      {active ? (
        <HtmlFileReader html={documentHtml} onContentHeight={setHeight}
          scrollEnabled={height >= HTML_ANSWER_MAX_HEIGHT} />
      ) : null}
    </View>
  );
}
