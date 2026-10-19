/**
 * Internal A/B switch: set false and restart the desktop Main process to use
 * local exit rules only. No UI, persisted preference or catalog change needed.
 * Disabling this skips the model request; idle exit and local commands remain.
 */
export const SEMANTIC_VOICE_EXIT_ENABLED = true;

// Skip long utterances whole: truncation could drop a negation or a work request.
export const SEMANTIC_VOICE_EXIT_MAX_CHARACTERS = 512;
