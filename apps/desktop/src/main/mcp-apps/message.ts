import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

/** Main-only card authorization; neither the View nor persisted queue can mint it. */
export const MCP_APP_MESSAGE_GUARD = Symbol('MCP_APP_MESSAGE_GUARD');
export type McpAppMessageGuard = () => Promise<void>;

/** Convert protocol content into the existing, attachment-aware Cindy user input. */
export function appMessageBlocks(
  content: unknown[],
): Array<{ type: string; [key: string]: unknown }> {
  return (content as ContentBlock[]).map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'resource_link':
        return { type: 'text', text: `${block.name}: ${block.uri}` };
      case 'resource':
        if ('text' in block.resource) return { type: 'text', text: block.resource.text };
        throw new Error('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
      default:
        throw new Error('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
    }
  });
}

/** Keep the authored body for history, but escape native commands in model input. */
export function appMessageInput(content: unknown[]) {
  const authored = appMessageBlocks(content);
  const persistedContent = authored.map((block) => String(block.text)).join('\n');
  const blocks = authored.map((block) => ({
    ...block,
    text: String(block.text).replace(/^(\s*)\//, '$1\\/'),
  }));
  return { blocks, text: blocks.map((block) => block.text).join('\n'), persistedContent };
}
