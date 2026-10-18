import { describe, expect, it } from "vitest";
import {
  HTML_ANSWER_MAX_HEIGHT,
  htmlAnswerDocument,
  htmlAnswerHeight,
  prepareHtmlAnswer,
} from "../htmlAnswer";

// Unit: full documents must survive answer delivery; snippets and unfinished streams stay code.
describe("HTML answer presentation", () => {
  const html = "<!doctype html><html><body><h1>Answer</h1></body></html>";
  it("recognizes complete raw or fenced documents without changing their source", () => {
    expect(htmlAnswerDocument(html)).toBe(html);
    expect(htmlAnswerDocument("```html\n" + html + "\n```")).toBe(html);
    expect(htmlAnswerDocument("```html\n<div>example</div>\n```")).toBeNull();
    expect(htmlAnswerDocument("<html><body>unfinished")).toBeNull();
  });
  it("only accepts finite size notifications and bounds the view without accepting commands", () => {
    expect(
      htmlAnswerHeight({ type: "cindy-html-answer-size", height: 500 }),
    ).toBe(500);
    expect(htmlAnswerHeight({ type: "cindy-html-answer-size", height: 4800 })).toBe(4800);
    expect(
      htmlAnswerHeight({ type: "cindy-html-answer-size", height: 1e9 }),
    ).toBe(HTML_ANSWER_MAX_HEIGHT);
    expect(
      htmlAnswerHeight({ type: "cindy-html-answer-size", height: NaN }),
    ).toBeNull();
    expect(htmlAnswerHeight({ type: "run-tool", height: 100 })).toBeNull();
    expect(
      prepareHtmlAnswer(html, {
        background: "</script>",
        foreground: "inherit",
        dark: false,
      }),
    ).toContain('"background":"\\u003c/script>"');
  });
});
