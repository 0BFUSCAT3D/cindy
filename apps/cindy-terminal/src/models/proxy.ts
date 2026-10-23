import { randomBytes } from 'node:crypto';
import { createAnthropicCompatProxy, type ProxyHandle, type LocalRequestHandler } from '@cindy/anthropic-compat-proxy';
import { createResponsesHandler } from '@cindy/anthropic-responses-bridge';
import { createResponsesAnthropicHandler } from '@cindy/responses-anthropic-bridge';
import { createResponsesChatHandler } from '@cindy/responses-chat-bridge';
import type { AgentKind, ResolvedRoute } from '@cindy/model-providers';

/** A per-task credential boundary. Native CLIs only receive an expiring loopback
 * capability; the user's upstream key and custom headers stay in this process. */
export async function createProviderProxy(route: ResolvedRoute, kind: AgentKind, key: string | null, extraHeaders: Record<string, string>, authorize?: (model: string) => Promise<boolean>) {
  const token = randomBytes(32).toString('base64url');
  const handles: ProxyHandle[] = [];
  let closed = false;
  const protocol = route.routing.wireProtocol ?? (kind === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
  const modelIds = new Set((route.provider.models[kind] ?? []).filter(model => !model.disabled).map(model => model.id));
  const headers = () => ({ ...(key ? protocol === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` } : {}), ...extraHeaders });
  const denied: LocalRequestHandler = async ({ res }) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'permission_error', message: 'Provider capability is unavailable' } })); };
  async function proxy(upstream: string, handler?: LocalRequestHandler, secret = token) {
    const handle = await createAnthropicCompatProxy({ upstream, transformRequest: [], routingTransform: async (body, ctx) => {
      const credential = ctx.headers.authorization ?? ctx.headers['x-api-key'];
      const model = body && typeof body === 'object' ? (body as { model?: unknown }).model : undefined;
      if (closed || credential !== secret && credential !== `Bearer ${secret}` || typeof model !== 'string' || !modelIds.has(model)) return { localHandler: denied };
      if (authorize && !await authorize(model)) return { localHandler: denied };
      if (closed) return { localHandler: denied };
      return handler ? { localHandler: handler, dispatchGenerationValid: () => !closed } : { headerOverride: headers(), headerDelete: [protocol === 'anthropic-messages' ? 'authorization' : 'x-api-key', 'x-cindy-guest-route'], dispatchGenerationValid: () => !closed };
    } });
    handles.push(handle);
    return handle;
  }
  try {
    const nativeProtocol = kind === 'claude-code' ? 'anthropic-messages' : kind === 'codex' ? 'openai-responses' : protocol;
    let upstream = route.routing.upstream!;
    let handler: LocalRequestHandler | undefined;
    if (nativeProtocol === 'openai-responses' && protocol === 'anthropic-messages') {
      const bridge = createResponsesAnthropicHandler({ upstreamBase: upstream, buildHeaders: async () => headers() });
      handler = args => bridge.handle(args);
    } else if (nativeProtocol === 'openai-responses' && protocol === 'openai-chat') {
      const bridge = createResponsesChatHandler({ upstreamBase: upstream, buildHeaders: async () => headers() });
      handler = args => bridge.handle({ ...args, requestHeaders: args.ctx.headers });
    } else if (nativeProtocol === 'anthropic-messages' && protocol !== 'anthropic-messages') {
      let bridgeHeaders = headers;
      if (protocol === 'openai-chat') {
        const bridge = createResponsesChatHandler({ upstreamBase: upstream, buildHeaders: async () => headers() });
        const internal = await proxy(upstream, args => bridge.handle({ ...args, requestHeaders: args.ctx.headers }));
        upstream = internal.url;
        bridgeHeaders = () => ({ authorization: `Bearer ${token}` });
      }
      const bridge = createResponsesHandler({ providers: [{ prefix: '', upstreamBase: upstream, buildHeaders: async () => bridgeHeaders(), maxOutputTokensSupported: true, supportsReasoning: () => Boolean(route.model.efforts?.length), supportedReasoningEfforts: () => route.model.efforts ?? [] }] });
      handler = args => bridge.handle({ ...args, prefs: {} });
    }
    const main = await proxy(upstream, handler);
    return { url: main.url, token, close: async () => { closed = true; await Promise.all(handles.map(handle => handle.dispose())); } };
  } catch (error) { closed = true; await Promise.all(handles.map(handle => handle.dispose())); throw error; }
}
