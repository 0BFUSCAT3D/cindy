import { describe, expect, it } from "vitest";
import {
  USER_BUBBLE_PRESETS,
  parseUserBubblePreference,
  resolveUserBubbleColors,
} from "../userBubbleAppearance";

function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
describe("personal message bubble appearance", () => {
  it("leaves default theme values alone and rejects malformed storage values", () => {
    expect(resolveUserBubbleColors("default", "dark")).toBeNull();
    for (const value of [
      null,
      {},
      "unknown",
      "#fff",
      "#000000;url(x)",
      "#zzzzzz",
    ]) {
      expect(parseUserBubblePreference(value)).toBe("default");
    }
    expect(parseUserBubblePreference("#AbCdEf")).toBe("#abcdef");
  });
  it("keeps every preset and extreme custom color readable in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const preference of [
        ...USER_BUBBLE_PRESETS.slice(1),
        "#000000",
        "#ffffff",
        "#ff0000",
        "#00ff00",
        "#0000ff",
      ] as const) {
        const colors = resolveUserBubbleColors(preference, mode)!;
        const a = luminance(colors.background);
        const b = luminance(colors.foreground);
        expect(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });
});
