/** Data-only, additive MCP Apps contract shared by Desktop and Mobile. */
export const MCP_APPS_INVOKE = 'maker:mcp-apps:v1';
export const MCP_APP_CARD = 'mcp-app';
/** Host-to-controller actions never enter the App's standard JSON-RPC transport. */
export type McpAppHostEvent<T> =
  | { seq: number; message: T; openLink?: never }
  | { seq: number; openLink: { id: string; url: string }; message?: never };
export interface McpAppRecord {
  version: 1;
  serverId: string;
  serverRevision: string;
  resourceUri: string;
  connectionId?: string;
  tool: {
    name: string;
    title?: string;
    inputSchema: { type: 'object'; [key: string]: unknown };
    [key: string]: unknown;
  };
  arguments: Record<string, unknown>;
  result?: {
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  cancelled?: string;
}
export interface McpAppDocument {
  viewId: string;
  html: string;
  csp: string;
  prefersBorder: boolean;
  policy?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
}
export function parseMcpAppRecord(content: unknown): McpAppRecord | undefined {
  if (!content || typeof content !== 'object') return;
  const value = (content as { mcpApp?: unknown }).mcpApp;
  if (!value || typeof value !== 'object') return;
  const record = value as McpAppRecord;
  return record.version === 1 &&
    typeof record.serverId === 'string' &&
    typeof record.serverRevision === 'string' &&
    typeof record.resourceUri === 'string' &&
    record.resourceUri.startsWith('ui://') &&
    typeof record.tool?.name === 'string' &&
    record.tool.inputSchema?.type === 'object' &&
    record.arguments &&
    typeof record.arguments === 'object' &&
    !Array.isArray(record.arguments) &&
    (!record.result || Array.isArray(record.result.content))
    ? record
    : undefined;
}

/** Trusted proxy. No privileged host API; relay only the actual inner window. */
export const MCP_APP_SANDBOX_SCRIPT = `
const frame=document.createElement('iframe');
frame.setAttribute('sandbox','allow-scripts');
frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
frame.style.cssText='border:0;width:100%;height:100%;display:block';
let loaded=false;
const post=message=>window.ReactNativeWebView?window.ReactNativeWebView.postMessage(JSON.stringify({key:bridgeKey,message})):window.parent.postMessage(message,'*');
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!event.isComposing&&!event.repeat&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey)
  post({jsonrpc:'2.0',method:'ui/notifications/sandbox-escape',params:{}});
});
window.addEventListener('message',event=>{
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0')return;
 if(event.source===frame.contentWindow){
  if(typeof message.method==='string'&&message.method.startsWith('ui/notifications/sandbox-'))return;
  post(message);return;
 }
 if(event.source!==window.parent&&event.source!==window)return;
 if(message.method==='ui/notifications/sandbox-resource-ready'){
  if(loaded)return;loaded=true;
  if(message.params.resourceUrl){frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.src=message.params.resourceUrl;}
  else{frame.srcdoc=message.params.html;}
  document.body.appendChild(frame);return;
 }
 frame.contentWindow?.postMessage(message,'*');
});
post({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}});
`;
export function mcpAppSandboxDocument(nativeBridgeKey = ''): string {
  const key = JSON.stringify(nativeBridgeKey).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>const bridgeKey=${key};${MCP_APP_SANDBOX_SCRIPT}</script></body></html>`;
}
/** Native WebViews cannot serve headers; CSP precedes every byte of App content. */
export function mcpAppNativeResource(html: string, csp: string): string {
  const escaped = csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escaped}">${html}`;
}
/** Native frame navigation needs its own gate; document CSP does not cover location. */
export function mcpAppFrameUrlAllowed(value: string, domains: readonly string[] = []): boolean {
  if (value === 'about:blank' || value === 'about:srcdoc') return true;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    return domains.some((domain) => {
      const wildcard = domain.includes('://*.');
      const anyPort = /:\*\/?$/.test(domain);
      const source = new URL(domain.replace('://*.', '://').replace(/:\*(\/?$)/, '$1'));
      return (
        source.protocol === url.protocol &&
        (anyPort || source.port === url.port) &&
        (wildcard ? url.hostname.endsWith('.' + source.hostname) : url.hostname === source.hostname)
      );
    });
  } catch {
    return false;
  }
}
