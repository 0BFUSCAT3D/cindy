import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createAnthropicCompatProxy,
  type LocalRequestHandler,
} from "@cindy/anthropic-compat-proxy";
import { createResponsesHandler } from "@cindy/anthropic-responses-bridge";
import { buildChatgptBridgeHeaders } from "@cindy/model-providers/provider-auth/chatgpt-bridge-headers";
import type { AgentKind, ResolvedRoute } from "@cindy/model-providers";
import type { TerminalNativeAccounts } from "./native-accounts.js";

/** Native ChatGPT requests and the existing Messages→Responses bridge share
 * one owner-bound credential source. No native CLI sees its access token. */
export async function createChatgptProxy(options: {
  route: ResolvedRoute;
  kind: AgentKind;
  taskId: string;
  accounts: TerminalNativeAccounts;
  authorize?: (model: string) => Promise<boolean>;
  fetch?: typeof fetch;
}) {
  // Pi's native Codex transport parses a JWT-shaped API key before dispatch.
  // This is only a random loopback capability with a synthetic account claim;
  // it has no validity at OpenAI and carries none of the owner's identity.
  const token = [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "cindy-terminal-proxy",
        },
      }),
    ).toString("base64url"),
    randomBytes(32).toString("base64url"),
  ].join(".");
  const abort = new AbortController();
  let closed = false;
  const models = options.route.provider.models[options.kind] ?? [];
  const allowed = (id: string) =>
    models.find(
      (model) =>
        !model.disabled &&
        (model.id === id ||
          (options.kind === "pi" && model.id === `chatgpt/${id}`)),
    );
  const denied: LocalRequestHandler = async ({ res }) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end('{"error":{"message":"Provider authorization is unavailable"}}');
  };
  const dispatch: typeof fetch = async (url, init) => {
    if (closed) throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
    const auth = await options.accounts.credential();
    if (closed || !auth.canDispatch())
      throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(
      buildChatgptBridgeHeaders({ ...auth, sessionId: options.taskId }),
    ))
      headers.set(name, value);
    headers.delete("x-api-key");
    headers.delete("x-cindy-guest-route");
    const response = await (options.fetch ?? fetch)(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        abort.signal,
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    if (response.status === 401) options.accounts.invalidate(auth.accessToken);
    return response;
  };
  const bridge = createResponsesHandler({
    fetchImpl: dispatch,
    providers: [
      {
        prefix: "chatgpt/",
        wireProtocol: "openai-responses",
        upstreamBase: "https://chatgpt.com/backend-api/codex",
        fastServiceTier: "priority",
        supportedReasoningEfforts: (model) =>
          models.find((entry) => entry.id === `chatgpt/${model}`)?.efforts,
        buildHeaders: async () => ({}),
      },
    ],
  });
  const native: LocalRequestHandler = async (args) => {
    const { rawBody, parsedBody, ctx, res } = args;
    const pathname = new URL(ctx.url, "http://127.0.0.1").pathname;
    if (
      ctx.method !== "POST" ||
      !["/responses", "/codex/responses", "/v1/responses"].includes(pathname)
    ) {
      res.writeHead(404).end();
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown =
        parsedBody ??
        (ctx.headers["content-encoding"] === "zstd"
          ? JSON.parse(
              (
                await promisify(zstdDecompress)(rawBody, {
                  maxOutputLength: 64 * 1024 * 1024,
                })
              ).toString("utf8"),
            )
          : undefined);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end('{"error":{"message":"Invalid subscription request"}}');
      return;
    }
    const entry =
      typeof body.model === "string" ? allowed(body.model) : undefined;
    if (
      !entry ||
      !options.accounts.connected() ||
      (options.authorize && !(await options.authorize(entry.id)))
    ) {
      await denied(args);
      return;
    }
    const request = new AbortController();
    const cancel = () => request.abort();
    res.once("close", cancel);
    try {
      const response = await dispatch(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          // Pi's specialized transport already supplies the full Codex contract.
          // The UI namespace is never a model name understood by the backend.
          body: JSON.stringify({
            ...body,
            model: String(body.model)
              .replace(/^chatgpt\//, "")
              .replace(/\[1m\]$/, ""),
          }),
          signal: request.signal,
        },
      );
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (
          [
            "content-type",
            "cache-control",
            "retry-after",
            "x-request-id",
          ].includes(name) ||
          name.startsWith("x-ratelimit-") ||
          name.startsWith("openai-")
        )
          headers[name] = value;
      });
      res.writeHead(response.status, headers);
      if (response.body)
        await pipeline(
          Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0],
          ),
          res,
        );
      else res.end();
    } finally {
      res.off("close", cancel);
    }
  };
  const handle = await createAnthropicCompatProxy({
    upstream: "https://chatgpt.com/backend-api/codex",
    transformRequest: [],
    routingTransform: async (body, ctx) => {
      const credential = ctx.headers.authorization ?? ctx.headers["x-api-key"];
      const model =
        body && typeof body === "object"
          ? (body as { model?: unknown }).model
          : null;
      const entry = typeof model === "string" ? allowed(model) : undefined;
      if (
        closed ||
        (credential !== token && credential !== `Bearer ${token}`) ||
        (!entry &&
          !(
            options.kind === "pi" &&
            body === undefined &&
            ctx.headers["content-encoding"] === "zstd"
          )) ||
        !options.accounts.connected() ||
        (entry && options.authorize && !(await options.authorize(entry.id)))
      )
        return { localHandler: denied };
      return {
        localHandler:
          options.kind === "claude-code"
            ? (args) => bridge.handle({ ...args, prefs: {} })
            : native,
        dispatchGenerationValid: () => !closed && options.accounts.connected(),
      };
    },
  });
  return {
    url: handle.url,
    token,
    async close() {
      closed = true;
      abort.abort();
      await handle.dispose();
    },
  };
}
