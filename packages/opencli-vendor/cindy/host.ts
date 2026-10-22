import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

export interface RecipeSecrets {
  read(key: string): string | null;
  write(key: string, value: string): boolean;
}

const context = new AsyncLocalStorage<{ secrets?: RecipeSecrets }>();
export function withRecipeHost<T>(
  secrets: RecipeSecrets | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return context.run({ secrets }, run);
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
