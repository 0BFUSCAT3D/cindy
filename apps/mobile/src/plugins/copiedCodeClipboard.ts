import { Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";

export interface CopiedCode {
  code: string;
  /** iOS change count right after our write; absent when ownership is unproven. */
  version?: string;
}

const iosVersion = () =>
  remotePresentation?.clipboardVersion?.().catch(() => undefined) ??
  Promise.resolve(undefined);

// Our own copies run one at a time, so their writes never fall between
// another copy's version reads.
let copying: Promise<unknown> = Promise.resolve();

/** Copy a device code and remember enough to clear it later only if it is still ours. */
export function copyCode(code: string): Promise<CopiedCode> {
  const result = copying.then(() => writeCode(code));
  copying = result.catch(() => {});
  return result;
}

async function writeCode(code: string): Promise<CopiedCode> {
  if (Platform.OS !== "ios") {
    await Clipboard.setStringAsync(code);
    return { code };
  }
  const before = await iosVersion();
  await Clipboard.setStringAsync(code);
  const after = await iosVersion();
  // A single increment proves no other write landed between ours and the read.
  const owned =
    before !== undefined &&
    after !== undefined &&
    Number(after) === Number(before) + 1;
  return owned ? { code, version: after } : { code };
}

/** Clear the clipboard only while it still holds the copied code. */
export async function clearCopiedCode(copied: CopiedCode): Promise<void> {
  if (Platform.OS === "ios") {
    // Reading the contents would trigger the iOS paste prompt. The native
    // write compares the change count and clears in one main-queue step.
    if (copied.version !== undefined)
      await remotePresentation
        ?.syncClipboard?.(JSON.stringify({ text: "" }), copied.version)
        .catch(() => {});
    return;
  }
  // Android has no paste prompt; compare the contents.
  if ((await Clipboard.getStringAsync().catch(() => "")) === copied.code)
    await Clipboard.setStringAsync("").catch(() => {});
}
