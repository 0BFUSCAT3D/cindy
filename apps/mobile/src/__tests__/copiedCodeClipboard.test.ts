import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  os: "ios",
  text: "",
  count: 0,
  // Simulates another app writing between our write and the next version read.
  interleave: false,
  getString: vi.fn(async () => h.text),
  setString: vi.fn(async (value: string) => {
    h.text = value;
    h.count++;
    if (h.interleave) {
      h.interleave = false;
      h.text = "other";
      h.count++;
    }
    return true;
  }),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return h.os;
    },
  },
}));
vi.mock("expo-clipboard", () => ({
  getStringAsync: h.getString,
  setStringAsync: h.setString,
}));
vi.mock("../../modules/cindy-remote-presentation/src", () => ({
  remotePresentation: {
    clipboardVersion: async () => String(h.count),
    syncClipboard: async (json: string, version: string) => {
      if (String(h.count) !== version) throw new Error("CLIPBOARD_CHANGED");
      h.text = JSON.parse(json).text;
      h.count++;
      return String(h.count);
    },
  },
}));

import { clearCopiedCode, copyCode } from "@/plugins/copiedCodeClipboard";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { os: "ios", text: "before", count: 5, interleave: false });
});

it("clears its own iOS write by change count without reading the clipboard", async () => {
  const copied = await copyCode("CODE-1");
  expect(copied).toEqual({ code: "CODE-1", version: "6" });
  await clearCopiedCode(copied);
  expect(h.text).toBe("");
  expect(h.getString).not.toHaveBeenCalled();
});

it("keeps a later iOS copy, including one that lands before the version read", async () => {
  const later = await copyCode("CODE-1");
  await h.setString("mine");
  await clearCopiedCode(later);
  expect(h.text).toBe("mine");

  h.interleave = true;
  const raced = await copyCode("CODE-2");
  expect(raced.version).toBeUndefined();
  await clearCopiedCode(raced);
  expect(h.text).toBe("other");
  expect(h.getString).not.toHaveBeenCalled();
});

it("keeps the latest iOS copy clearable when the user taps copy twice quickly", async () => {
  const [first, second] = await Promise.all([
    copyCode("CODE-1"),
    copyCode("CODE-1"),
  ]);
  expect(first.version).toBe("6");
  expect(second.version).toBe("7");
  await clearCopiedCode(second);
  expect(h.text).toBe("");
});

it("settles copies in call order and lets a failed copy keep the earlier token", async () => {
  const settled: string[] = [];
  h.setString.mockImplementationOnce(async (value: string) => {
    h.text = value;
    h.count++;
    return true;
  });
  h.setString.mockRejectedValueOnce(new Error("write failed"));
  let token: { code: string; version?: string } | undefined;
  await Promise.allSettled([
    copyCode("CODE-1").then((copied) => {
      settled.push("first");
      token = copied;
    }),
    copyCode("CODE-1").then(
      (copied) => {
        token = copied;
      },
      () => settled.push("second-failed"),
    ),
  ]);
  expect(settled).toEqual(["first", "second-failed"]);
  expect(token?.version).toBe("6");
  await clearCopiedCode(token!);
  expect(h.text).toBe("");
});

it("compares contents on Android, so returning from the browser still clears the code", async () => {
  h.os = "android";
  const copied = await copyCode("CODE-1");
  await clearCopiedCode(copied);
  expect(h.text).toBe("");

  const replaced = await copyCode("CODE-2");
  await h.setString("mine");
  await clearCopiedCode(replaced);
  expect(h.text).toBe("mine");
});
