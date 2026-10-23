import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readPrivateFile, atomicPrivateWrite } from './platform.js';
import { resolveLocale } from './ui/i18n.js';

export const terminalSettingsSchema = z.object({
  deviceName: z.string().trim().min(1).max(128).optional(),
  remoteEnabled: z.boolean().optional(),
  language: z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'ko']).optional(),
  workingDir: z.string().min(1).refine(value => path.isAbsolute(value), 'Absolute path required').optional(),
}).strict();
export type TerminalSettings = z.infer<typeof terminalSettingsSchema>;
const recordSchema = z.object({ version: z.literal(1), deviceId: z.string().uuid(), overrides: terminalSettingsSchema }).strict();

export class SettingsStore {
  private data = { version: 1 as const, deviceId: randomUUID() as string, overrides: {} as TerminalSettings };
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private profileDir: string) {}
  async open() {
    const raw = await readPrivateFile(path.join(this.profileDir, 'settings.json'));
    if (raw) this.data = recordSchema.parse(JSON.parse(raw.toString()));
    else await this.persist(this.data);
  }
  get deviceId() { return this.data.deviceId; }
  snapshot() {
    return {
      defaults: { deviceName: os.hostname(), remoteEnabled: false, language: resolveLocale(), workingDir: os.homedir() },
      overrides: { ...this.data.overrides },
      effective: { deviceName: os.hostname(), remoteEnabled: false, language: resolveLocale(), workingDir: os.homedir(), ...this.data.overrides },
    };
  }
  update(patch: unknown) {
    const parsed = terminalSettingsSchema.parse(patch);
    return this.change(current => ({ ...current, ...parsed }));
  }
  reset(keys: string[]) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !Object.hasOwn(terminalSettingsSchema.shape, key))) throw new Error('INVALID_SETTING');
    return this.change(current => {
      const next = { ...current };
      for (const key of keys) delete next[key as keyof TerminalSettings];
      return next;
    });
  }
  private change(update: (current: TerminalSettings) => TerminalSettings): Promise<ReturnType<SettingsStore['snapshot']>> {
    const work = this.writes.then(async () => {
      const next = { ...this.data, overrides: update(this.data.overrides) };
      await this.persist(next); this.data = next;
      return this.snapshot();
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
  private persist(data: typeof this.data) { return atomicPrivateWrite(path.join(this.profileDir, 'settings.json'), JSON.stringify(data)); }
}
