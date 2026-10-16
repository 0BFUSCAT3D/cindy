import { headerValue } from './headers.js';

/**
 * Only the first-party Messages endpoint is known to support gzip request bodies
 * (also targeted by Claude Code's native gzip transport). An Anthropic-compatible
 * API shape does not imply support. No probes, retries, or provider-name guesses.
 */
export function shouldCompressRequest(
  target: { protocol: string; hostname: string; port: number },
  method: string,
  pathname: string,
  headers: Readonly<Record<string, string>>,
  bytes: number,
): boolean {
  return target.protocol === 'https:' && target.hostname === 'api.anthropic.com' && target.port === 443
    && method === 'POST' && pathname === '/v1/messages'
    && bytes >= 64 * 1024
    && headerValue(headers, 'content-type').split(';', 1)[0].trim().toLowerCase() === 'application/json'
    && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-encoding');
}
