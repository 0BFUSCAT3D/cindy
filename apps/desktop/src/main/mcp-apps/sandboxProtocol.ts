import { app, protocol } from 'electron';
import { randomUUID } from 'node:crypto';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { appCsp, MCP_APPS_MAX_BYTES } from './protocol.js';
import {
  mcpAppSandboxDocument,
  mcpAppFrameUrlAllowed,
  type McpAppDocument,
} from '../../shared/mcpApps.js';

export const mcpAppSchemePrivilege = {
  scheme: 'cindy-mcp-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};
const documents = new Map<
  string,
  { document: McpAppDocument; owner: object | null; caller?: string }
>();
export function supplyMcpAppDocument(document: McpAppDocument, caller?: string): void {
  documents.set(document.viewId, { document, owner: getCurrentDbClientSnapshot(), caller });
}
export function removeMcpAppDocument(id: string): void {
  documents.delete(id);
}
export function clearMcpAppDocuments(): void {
  documents.clear();
}
export function mountRemoteAppDocument(input: unknown, caller: string): string {
  const document = input as McpAppDocument;
  if (!getCurrentDbClientSnapshot()) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
  if (
    !document ||
    typeof document.html !== 'string' ||
    Buffer.byteLength(document.html) > MCP_APPS_MAX_BYTES
  )
    throw new Error('MCP_APP_INVALID_DOCUMENT');
  if ([...documents.values()].filter((item) => item.caller === caller).length >= 16)
    throw new Error('MCP_APP_VIEW_LIMIT');
  const policy = appCsp({ csp: document.policy });
  const id = randomUUID();
  supplyMcpAppDocument({ ...document, viewId: id, csp: policy.header, policy: policy.csp }, caller);
  return id;
}
export function unmountRemoteAppDocument(id: string, caller: string): void {
  if (documents.get(id)?.caller !== caller) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
  documents.delete(id);
}
export function assertMcpAppDocumentCaller(id: string, caller: string): void {
  const entry = documents.get(id);
  if (!entry || entry.owner !== getCurrentDbClientSnapshot() || entry.caller !== caller)
    throw new Error('MCP_APP_VIEW_UNAVAILABLE');
}
export function registerMcpAppProtocol(): void {
  // CSP does not restrict a frame's own location navigation. Keep the policy-bearing
  // document in place; external navigation goes through standard ui/open-link.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-frame-navigate', (event) => {
      const source = event.frame?.url || event.initiator?.url || '';
      // A declared nested iframe is allowed to load its approved origin. Only
      // descendants of the actual App resource get this grant, never the App
      // itself or its trusted sandbox proxy.
      let nestedDomains: readonly string[] | undefined;
      for (let ancestor = event.frame?.parent; ancestor; ancestor = ancestor.parent) {
        if (!ancestor.url.startsWith('cindy-mcp-app:')) continue;
        const url = new URL(ancestor.url);
        if (!url.hostname.endsWith('-view') || url.pathname !== '/resource') continue;
        const entry = documents.get(url.hostname.slice(0, -5));
        nestedDomains =
          entry?.owner === getCurrentDbClientSnapshot()
            ? (entry.document.policy?.frameDomains ?? [])
            : [];
        break;
      }
      if (!isMcpAppFrameNavigationAllowed(source, event.url, nestedDomains)) event.preventDefault();
    });
  });
  protocol.handle('cindy-mcp-app', (request) => {
    const url = new URL(request.url);
    const id = url.hostname.replace(/-view$/, '');
    const entry = documents.get(id);
    const doc = entry?.document;
    if (!doc || entry?.owner !== getCurrentDbClientSnapshot() || request.method !== 'GET')
      return new Response(null, { status: 404 });
    const isSandbox = url.pathname === '/sandbox';
    if (
      isSandbox
        ? url.hostname !== id
        : url.pathname !== '/resource' || url.hostname !== `${id}-view`
    )
      return new Response(null, { status: 404 });
    return new Response(isSandbox ? mcpAppSandboxDocument() : doc.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': isSandbox
          ? `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src cindy-mcp-app://${id}-view; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
          : doc.csp,
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=()',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
export function isMcpAppFrameNavigationAllowed(
  source: string,
  target: string,
  nestedDomains?: readonly string[],
): boolean {
  if (nestedDomains !== undefined) return mcpAppFrameUrlAllowed(target, nestedDomains);
  if (!source.startsWith('cindy-mcp-app:')) return true;
  try {
    const from = new URL(source),
      to = new URL(target);
    if (to.protocol !== 'cindy-mcp-app:') return false;
    if (from.hostname.endsWith('-view'))
      return to.hostname === from.hostname && to.pathname === '/resource';
    return to.hostname === from.hostname + '-view' && to.pathname === '/resource';
  } catch {
    return false;
  }
}
