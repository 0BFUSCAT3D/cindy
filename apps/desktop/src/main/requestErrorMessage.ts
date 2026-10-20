import { redact } from './log-upload/redact';

/** Keep the original explanation (including nested fetch causes), not request/response objects. */
export function requestErrorMessage(error: unknown): string {
  try {
    const messages: string[] = [];
    for (let depth = 0; error != null && depth < 4; depth++) {
      if (typeof error !== 'object') {
        messages.push(String(error));
        break;
      }
      const value = error as { message?: unknown; code?: unknown; cause?: unknown };
      const message = typeof value.message === 'string' ? value.message : 'Unknown error';
      messages.push(typeof value.code === 'string' ? `${message} (${value.code})` : message);
      error = value.cause;
    }
    return redact(messages.join('\nCaused by: ') || 'Unknown error').slice(0, 8000);
  } catch {
    return '[error message unavailable]';
  }
}
