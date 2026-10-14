import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

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
