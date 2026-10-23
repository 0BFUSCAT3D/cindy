import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createXdtHelperMcpServer, type XdtHelperMcpDeps } from '../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js';
import type { AgentKind, McpProvider, PiExtraSpawnConfig } from '@cindy/maker-core';

/** Each task owns the server, token and captured context. Closing or changing
 * accounts revokes old tools even if a native child retained its environment. */
export async function createTaskTools(options: {
  sessionId: string; workingDir: string; agentKind: AgentKind;
  helper: XdtHelperMcpDeps; isCurrent(): boolean;
}) {
  let closed = false;
  const assertCurrent = () => { if (closed || !options.isCurrent()) throw new Error('TASK_TOOLS_REVOKED'); };
  const context = { sessionId: options.sessionId, workingDir: options.workingDir, agentKind: options.agentKind };
  const factories: Record<string, () => McpServer> = {
    cindy_helper: () => createXdtHelperMcpServer({ ...options.helper, authorizeCall: async input => {
      assertCurrent();
      const result = await options.helper.authorizeCall?.(input);
      if (result && !result.ok) return result;
      return { ok: true, run: async operation => { assertCurrent(); const value = await operation(); assertCurrent(); return value; } };
    } }, context),
  };
  const token = randomBytes(32).toString('hex');
  const envKey = `CINDY_TERMINAL_MCP_${randomBytes(8).toString('hex').toUpperCase()}`;
  const transports = new Map<string, { name: string; transport: StreamableHTTPServerTransport; server: McpServer }>();
  const inProcess = new Set<McpServer>();
  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    try {
      assertCurrent();
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const name = new URL(req.url ?? '/', 'http://localhost').pathname.slice(5);
      if (!req.url?.startsWith('/mcp/') || !factories[name]) { res.writeHead(404).end(); return; }
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(data);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      assertCurrent();
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string') {
        const active = transports.get(sessionId);
        if (!active || active.name !== name) { res.writeHead(404).end(); return; }
        await active.transport.handleRequest(req, res, body); return;
      }
      if (!isInitializeRequest(body)) { res.writeHead(400).end(); return; }
      if (transports.size >= 16) { res.writeHead(429).end(); return; }
      const instance = factories[name]();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => { transports.set(id, { name, transport, server: instance }); } });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await instance.connect(transport);
      try { await transport.handleRequest(req, res, body); }
      catch (error) { await instance.close(); throw error; }
    } catch {
      if (!res.headersSent) res.writeHead(closed ? 410 : 400);
      if (!res.writableEnded) res.end();
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const port = (server.address() as AddressInfo).port;
  const url = (name: string) => `http://127.0.0.1:${port}/mcp/${name}`;
  const providers: McpProvider[] = Object.keys(factories).map(name => ({
    name,
    capability: { title: name === 'cindy_helper' ? 'Cindy tasks' : 'Cindy documents', description: name === 'cindy_helper' ? 'Read and manage tasks on this computer' : 'Read spreadsheet files in this task', source: 'builtin', ...(name === 'cindy_helper' ? { discovery: { tool: 'list_tools' } } : {}) },
    toClaudeSdkConfig: () => { assertCurrent(); const instance = factories[name](); inProcess.add(instance); return { type: 'sdk', name, instance }; },
    toCodexMcpConfig: () => { assertCurrent(); return { type: 'http', url: url(name), bearerTokenEnvVar: envKey }; },
    getExtraEnv: () => ({ [envKey]: token }),
  }));
  return {
    providers,
    codexArgs: providers.flatMap(provider => ['-c', `mcp_servers.${provider.name}.url=${JSON.stringify(url(provider.name))}`, '-c', `mcp_servers.${provider.name}.bearer_token_env_var=${JSON.stringify(envKey)}`, '-c', `mcp_servers.${provider.name}.tool_timeout_sec=600`]),
    env: { [envKey]: token },
    pi: (): PiExtraSpawnConfig => { assertCurrent(); return { mcpBridge: { token, servers: providers.map(provider => ({ name: provider.name, url: url(provider.name) })) } }; },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...transports.values()].map(active => active.server.close().catch(() => undefined)));
      await Promise.all([...inProcess].map(instance => instance.close().catch(() => undefined)));
      transports.clear(); inProcess.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
