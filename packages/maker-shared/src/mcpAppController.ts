import { MCP_APPS_INVOKE, type McpAppDocument, type McpAppHostEvent } from './mcpApps.js';

export type AppRpc = {
  jsonrpc: '2.0';
  method?: string;
  id?: string | number;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};
export type AppInvoker = (sessionId: string, input: Record<string, unknown>) => Promise<unknown>;

/** The UI is a transport only; official negotiation, schemas and permissions live on the Host. */
export class McpAppController {
  document?: McpAppDocument;
  private after = 0;
  private stopped = false;
  private closing = false;
  private teardownId?: string;
  private ready = false;
  private outbound: AppRpc[] = [];
  private initializeId?: string | number;
  private startupTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly invoke: AppInvoker,
    readonly sessionId: string,
    readonly clientId: string,
    private readonly post: (message: AppRpc) => void,
    private readonly onState: (message: AppRpc) => void,
    private readonly onError: (error: unknown) => void,
    private readonly openLink?: (url: string) => Promise<void>,
  ) {}

  async open(context: Record<string, unknown>): Promise<McpAppDocument | undefined> {
    this.startupTimer = setTimeout(
      () => this.fail(new Error('MCP_APP_INITIALIZATION_TIMEOUT')),
      45_000,
    );
    const document = (await this.invoke(this.sessionId, {
      op: 'open',
      clientId: this.clientId,
      context,
    })) as McpAppDocument;
    this.document = document;
    if (this.closing) {
      await this.invoke(this.sessionId, { op: 'teardown', viewId: document.viewId });
      return;
    }
    void this.poll();
    return document;
  }

  sandboxReady(resourceUrl?: string): void {
    if (!this.document || this.ready || this.closing) return;
    this.ready = true;
    this.post({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: resourceUrl
        ? { html: this.document.html, resourceUrl }
        : { html: this.document.html },
    });
    this.outbound.splice(0).forEach((message) => this.post(message));
  }

  receive(message: AppRpc): void {
    if (this.stopped || !this.document || !message || message.jsonrpc !== '2.0') return;
    if (this.teardownId !== undefined && message.id === this.teardownId) return;
    if (message.method?.startsWith('ui/notifications/sandbox-')) return;
    if (this.closing && message.method) return;
    if (message.method === 'ui/initialize') this.initializeId = message.id;
    if (message.method === 'ui/notifications/initialized') {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.onState(message);
    void this.invoke(this.sessionId, {
      op: 'message',
      viewId: this.document.viewId,
      message,
    }).catch((error) => this.fail(error));
  }

  async context(context: Record<string, unknown>): Promise<void> {
    if (this.document && !this.closing)
      await this.invoke(this.sessionId, { op: 'context', viewId: this.document.viewId, context });
  }
  async displayMode(mode: 'inline' | 'fullscreen' | 'pip'): Promise<void> {
    if (this.document && !this.closing)
      await this.invoke(this.sessionId, { op: 'display-mode', viewId: this.document.viewId, mode });
  }
  private fail(error: unknown): void {
    if (this.closing) return;
    this.onError(error);
    this.prepareNativeClose();
    void this.close().catch(() => {});
  }

  private async poll(): Promise<void> {
    let failedAt = 0;
    let delay = 500;
    try {
      while (!this.stopped && this.document) {
        let events: Array<McpAppHostEvent<AppRpc>>;
        try {
          events = (await this.invoke(this.sessionId, {
            op: 'poll',
            viewId: this.document.viewId,
            after: this.after,
          })) as typeof events;
          if (!Array.isArray(events)) throw new Error('MCP_APP_INVALID_POLL');
          failedAt = 0;
          delay = 500;
        } catch (error) {
          if (this.closing) return;
          if (/MCP_APP_|CHANNEL_NOT_ALLOWED|NOT_FOUND/.test(String(error))) throw error;
          failedAt ||= Date.now();
          if (Date.now() - failedAt >= 30_000) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(5_000, delay * 2);
          continue;
        }
        if (this.stopped) return;
        for (const event of events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= this.after) continue;
          this.after = event.seq;
          if (event.openLink) {
            void (async () => {
              let success = false;
              try {
                if (this.openLink && !this.closing) {
                  await this.openLink(event.openLink.url);
                  success = true;
                }
              } catch {
                /* Report the failed link action to the Host so its RPC can finish. */
              }
              if (!this.stopped && this.document)
                await this.invoke(this.sessionId, {
                  op: 'link-result',
                  viewId: this.document.viewId,
                  linkId: event.openLink.id,
                  success,
                });
            })().catch((error) => this.fail(error));
            continue;
          }
          if (
            this.initializeId !== undefined &&
            event.message.id === this.initializeId &&
            event.message.error
          )
            throw new Error('MCP_APP_INITIALIZATION_FAILED');
          this.onState(event.message);
          if (this.ready) this.post(event.message);
          else this.outbound.push(event.message);
        }
        // Broken/legacy hosts must not cause a hot empty-poll loop.
        if (!events.length && !this.stopped)
          await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** For platforms that cannot retain their native view during asynchronous disposal. */
  prepareNativeClose(): void {
    if (!this.ready || this.teardownId) return;
    this.teardownId = `cindy-teardown:${Date.now()}:${this.clientId}`;
    this.post({ jsonrpc: '2.0', id: this.teardownId, method: 'ui/resource-teardown', params: {} });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    if (!this.document) return;
    try {
      await this.invoke(this.sessionId, {
        op: 'teardown',
        viewId: this.document.viewId,
        alreadyNotified: !!this.teardownId,
      });
    } finally {
      this.stopped = true;
      this.outbound = [];
    }
  }
}
export function mcpAppFailureKey(error: unknown): 'mcpApps.updateRequired' | 'mcpApps.loadFailed' {
  return /CHANNEL_NOT_ALLOWED|UNKNOWN_CHANNEL|CHANNEL_NOT_FOUND/.test(String(error))
    ? 'mcpApps.updateRequired'
    : 'mcpApps.loadFailed';
}
export { MCP_APPS_INVOKE };
