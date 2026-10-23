import { createHash, randomUUID } from "node:crypto";
import {
  parseClaudeCliLoginStatus,
  type ClaudeCliLoginStatus,
} from "@cindy/model-providers/provider-auth/claude-cli-status";
import { runNative, claudeNativeEnv } from "../engines/native.js";

/** Claude subscription credentials belong exclusively to the original CLI.
 * This host stores only which Cindy owner may use that CLI's reported login. */
export class TerminalClaudeLogin {
  private closed = false;
  private readonly tickets = new Map<string, number>();
  private cached?: { at: number; value: ClaudeCliLoginStatus };
  private pending?: Promise<ClaudeCliLoginStatus>;
  private generation = 0;
  constructor(
    private readonly options: {
      owner: string;
      readBinding(): string | null;
      writeBinding(value: string | null): void;
      binary(): Promise<string | null>;
      assertCurrent(): void;
      changed(): void;
      run?: typeof runNative;
    },
  ) {}
  private current() {
    if (this.closed) throw new Error("OWNER_CHANGED");
    this.options.assertCurrent();
  }
  private binding(): { owner: string; identity: string } | null {
    this.current();
    const raw = this.options.readBinding();
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value &&
      typeof value.owner === "string" &&
      typeof value.identity === "string"
      ? value
      : null;
  }
  private identity(status: ClaudeCliLoginStatus) {
    return createHash("sha256")
      .update(status.email?.trim().toLowerCase() ?? "native-cli-login")
      .digest("hex");
  }
  private async status(force = false): Promise<ClaudeCliLoginStatus> {
    this.current();
    if (this.pending) return this.pending;
    if (!force && this.cached && Date.now() - this.cached.at < 15_000)
      return this.cached.value;
    this.pending = (async () => {
      const binary = await this.options.binary();
      this.current();
      if (!binary) return { loggedIn: false };
      const env = claudeNativeEnv();
      const result = await (this.options.run ?? runNative)(
        binary,
        ["auth", "status", "--json"],
        { env },
      );
      this.current();
      const value =
        result.code === 0
          ? (parseClaudeCliLoginStatus(result.stdout) ?? { loggedIn: false })
          : { loggedIn: false };
      this.cached = { at: Date.now(), value };
      return value;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async state() {
    const binding = this.binding();
    if (binding?.owner !== this.options.owner) return { authenticated: false };
    const status = await this.status();
    this.current();
    const current = this.binding();
    return {
      authenticated:
        current?.owner === this.options.owner &&
        current.identity === this.identity(status) &&
        status.loggedIn,
      authSource: "oauth" as const,
    };
  }
  async begin() {
    this.current();
    const generation = ++this.generation;
    const status = await this.status(true);
    this.current();
    if (generation !== this.generation) throw new Error("PROVIDER_LOGIN_STALE");
    // Revoke the old Cindy grant before an interactive native login can change
    // the shared CLI account. Its credentials remain untouched.
    this.options.writeBinding(null);
    this.options.changed();
    const id = randomUUID();
    this.tickets.clear();
    this.tickets.set(id, Date.now() + 20 * 60_000);
    return { id, needsLogin: !status.loggedIn };
  }
  async finish(id: string) {
    this.current();
    const expires = this.tickets.get(id);
    this.tickets.delete(id);
    if (!expires || expires <= Date.now())
      throw new Error("PROVIDER_LOGIN_STALE");
    const generation = this.generation;
    const status = await this.status(true);
    this.current();
    if (generation !== this.generation) throw new Error("PROVIDER_LOGIN_STALE");
    if (!status.loggedIn) throw new Error("NATIVE_SUBSCRIPTION_LOGIN_REQUIRED");
    this.options.writeBinding(
      JSON.stringify({
        owner: this.options.owner,
        identity: this.identity(status),
      }),
    );
    this.options.changed();
    return { authenticated: true };
  }
  disconnect() {
    this.current();
    this.generation++;
    this.tickets.clear();
    this.cached = undefined;
    if (this.binding()?.owner === this.options.owner)
      this.options.writeBinding(null);
    this.options.changed();
    return { authenticated: false };
  }
  async close() {
    this.closed = true;
    this.generation++;
    this.tickets.clear();
    await this.pending?.catch(() => {});
  }
}
