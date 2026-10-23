import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CustomMcpConfig } from '@cindy/maker-core';

/** One task-owned upstream connection, exposed through the existing local MCP
 * bridge on all harnesses. Upstream credentials never enter child configuration. */
export function customMcpFactory(config: CustomMcpConfig, token: string | null, isCurrent: () => boolean) {
  let client: Client | undefined, pending: Promise<Client> | undefined, closed = false;
  const guard = () => { if(closed || !isCurrent()) throw new Error('MCP_CONFIGURATION_CHANGED'); };
  async function connection() {
    guard();
    if(!pending)pending=(async()=>{
      const headers={...config.headers};
      if(token&&!Object.keys(headers).some(key=>key.toLowerCase()==='authorization'))headers.authorization=`Bearer ${token}`;
      const transport=config.transport==='sse'
        ? new SSEClientTransport(new URL(config.url),{requestInit:{headers}})
        : new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers}});
      const current=new Client({name:'Cindy',version:'1.0.0'},{capabilities:{}});client=current;
      try{await current.connect(transport);guard();return current;}
      catch(error){await current.close().catch(()=>{});pending=undefined;throw error;}
    })();
    return pending;
  }
  const factory=()=>{
    guard();const server=new McpServer({name:config.id,version:'1.0.0'},{capabilities:{tools:{},resources:{},prompts:{}}});
    server.server.setRequestHandler(ListToolsRequestSchema,async request=>{const peer=await connection();const result=await peer.listTools(request.params);guard();return result;});
    server.server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{const peer=await connection();guard();const result=await peer.callTool(request.params,undefined,{signal:extra.signal});guard();return result;});
    server.server.setRequestHandler(ListResourcesRequestSchema,async request=>{const peer=await connection();const result=await peer.listResources(request.params);guard();return result;});
    server.server.setRequestHandler(ReadResourceRequestSchema,async(request,extra)=>{const peer=await connection();const result=await peer.readResource(request.params,{signal:extra.signal});guard();return result;});
    server.server.setRequestHandler(ListPromptsRequestSchema,async request=>{const peer=await connection();const result=await peer.listPrompts(request.params);guard();return result;});
    server.server.setRequestHandler(GetPromptRequestSchema,async(request,extra)=>{const peer=await connection();const result=await peer.getPrompt(request.params,{signal:extra.signal});guard();return result;});
    return server;
  };
  return {factory,async close(){closed=true;await client?.close();}};
}
