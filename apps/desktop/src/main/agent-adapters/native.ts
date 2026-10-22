import { createNativeProcessAdapter, type NativeAgentDefinition } from './acp.js';
import { connectMuse } from './muse.js';
import { connectStep } from './step.js';
import { createCrushAdapter, type CrushAdapterOptions } from './crush.js';

/** One production entry for discovery, process ownership and protocol-specific sessions. */
export function createNativeAgentAdapter(
  definition: NativeAgentDefinition,
  options: CrushAdapterOptions = {},
) {
  if (definition.protocol === 'crush-http') return createCrushAdapter(definition, options);
  return createNativeProcessAdapter(
    definition,
    options,
    definition.protocol === 'step-rpc'
      ? connectStep
      : definition.protocol === 'msp'
        ? connectMuse
        : undefined,
  );
}
