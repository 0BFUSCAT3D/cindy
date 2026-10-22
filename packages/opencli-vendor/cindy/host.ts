import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** No filesystem effects at import time; tmpdir exists on every host platform. */
export function recipeDiagnosticPath(name: string): string {
  return join(tmpdir(), name);
}

export interface RecipeSecrets {
  read(key: string): string | null;
  write(key: string, value: string): boolean;
}

export interface RecipeFiles {
  read(file: string): Buffer;
  open(file: string): number;
}

const context = new AsyncLocalStorage<{ secrets?: RecipeSecrets; files?: RecipeFiles }>();
export function withRecipeHost<T>(
  secrets: RecipeSecrets | undefined,
  run: () => Promise<T>,
  files?: RecipeFiles,
): Promise<T> {
  return context.run({ secrets, files }, run);
}

/** Adapter bytes are available only through the host's session upload policy. */
export function readRecipeFileSync(file: string): Buffer;
export function readRecipeFileSync(file: string, encoding: BufferEncoding): string;
export function readRecipeFileSync(file: string, encoding?: BufferEncoding): Buffer | string {
  const files = context.getStore()?.files;
  if (!files) throw new Error('This recipe requires the host file broker');
  const bytes = files.read(file);
  return encoding ? bytes.toString(encoding) : bytes;
}

export function openRecipeFileSync(file: string): number {
  const files = context.getStore()?.files;
  if (!files) throw new Error('This recipe requires the host file broker');
  return files.open(file);
}

/** Legacy OpenCLI files are read only on explicit execution, never on import.
 * Refreshed tokens are written exclusively through the host's encrypted store. */
export function readSecretJSON(key: string, legacyPath: string): unknown {
  const secrets = context.getStore()?.secrets;
  if (!secrets)
    throw new Error("This recipe requires the host credential store");
  const stored = secrets.read(key);
  if (stored !== null) return JSON.parse(stored);
  try {
    return JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Existing recipe credentials could not be read");
  }
}

export function writeSecretJSON(key: string, value: unknown): void {
  const secrets = context.getStore()?.secrets;
  if (!secrets || !secrets.write(key, JSON.stringify(value))) {
    throw new Error(
      "Could not save recipe credentials in the host encrypted store",
    );
  }
}
