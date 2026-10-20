import type { MakerAgentKindWire } from './agentKindConversion';

/** Only model preferences; native checkpoints and permission settings keep their own lifecycle. */
export interface ScheduledModelBaseline {
  scopeId: string;
  agentKind: MakerAgentKindWire;
  model: string;
  providerId: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
  fastMode: boolean;
}

export function parseScheduledModelBaseline(value: unknown): ScheduledModelBaseline | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as ScheduledModelBaseline;
    if (!parsed || typeof parsed.scopeId !== 'string' ||
      !['claude-code', 'codex', 'pi'].includes(parsed.agentKind) ||
      typeof parsed.model !== 'string' || !parsed.model ||
      (parsed.providerId !== null && typeof parsed.providerId !== 'string') ||
      (parsed.effort !== null && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(parsed.effort)) ||
      typeof parsed.fastMode !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}
