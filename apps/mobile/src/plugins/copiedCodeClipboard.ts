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

/** Copy a device code and remember enough to clear it later only if it is still ours. */
export async function copyCode(code: string): Promise<CopiedCode> {
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
  // iOS asks for paste permission when the contents are read, so compare the
  // change count there. Android has no such prompt; compare the contents.
  const owned =
    Platform.OS === "ios"
      ? copied.version !== undefined && (await iosVersion()) === copied.version
      : (await Clipboard.getStringAsync().catch(() => "")) === copied.code;
  if (owned) await Clipboard.setStringAsync("").catch(() => {});
}
