import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildUtilityRequestPlan,
  compatHasReasoningOff,
  compatMarksNoReasoning,
  nextUtilityRequestStep,
  rememberUtilityStep,
  rememberedUtilityStepIndex,
  resetUtilityReasoningMemory,
  utilityReasoningDeclaration,
  utilityRequestStepKey,
} from '../utilityReasoningPlan.js';

const keys = (steps: ReturnType<typeof buildUtilityRequestPlan>) => steps.map(utilityRequestStepKey);

describe('utilityReasoningDeclaration', () => {
  it('sorts declared efforts from least to most thinking', () => {
    expect(utilityReasoningDeclaration('custom', 'codex', { efforts: ['max', 'low', 'high'] })).toEqual({
      kind: 'declared',
      efforts: ['low', 'high', 'max'],
    });
  });

  it('treats an explicit empty list as declared-empty and a missing one as unknown', () => {
    expect(utilityReasoningDeclaration('anthropic', 'claude-code', { efforts: [] })).toEqual({ kind: 'empty' });
    expect(utilityReasoningDeclaration('custom', 'codex', { efforts: [], effortsUnknown: true })).toEqual({ kind: 'unknown' });
    expect(utilityReasoningDeclaration('custom', 'codex', undefined)).toEqual({ kind: 'unknown' });
  });

  it('only trusts an empty Cindy AI list that the Gateway actually sent', () => {
    expect(utilityReasoningDeclaration('xd', 'codex', { efforts: [] })).toEqual({ kind: 'unknown' });
    expect(utilityReasoningDeclaration('xd', 'codex', { efforts: [], discoveredMetadata: { efforts: [] } }))
      .toEqual({ kind: 'empty' });
  });

  it('does not read a custom Pi placeholder list as declared-empty', () => {
    expect(utilityReasoningDeclaration('custom-pi', 'pi', { efforts: [] })).toEqual({ kind: 'unknown' });
    expect(utilityReasoningDeclaration('custom-pi', 'pi', { efforts: [], reasoning: false })).toEqual({ kind: 'empty' });
  });
});

describe('buildUtilityRequestPlan', () => {
  const declared = { kind: 'declared' as const, efforts: ['low', 'medium', 'high'] };

  it('starts Responses at the lowest effort because it has no off value', () => {
    expect(keys(buildUtilityRequestPlan({ wire: 'responses', mode: { kind: 'ladder', declaration: declared } })))
      .toEqual(['responses|effort:low', 'responses|effort:medium']);
  });

  it('tries off first on Chat and Messages', () => {
    expect(keys(buildUtilityRequestPlan({ wire: 'chat-completions', mode: { kind: 'ladder', declaration: declared } })))
      .toEqual(['chat-completions|off', 'chat-completions|effort:low', 'chat-completions|effort:medium']);
    expect(keys(buildUtilityRequestPlan({ wire: 'anthropic-messages', mode: { kind: 'ladder', declaration: declared } })))
      .toEqual(['anthropic-messages|off', 'anthropic-messages|effort:low', 'anthropic-messages|effort:medium']);
  });

  it('continues a native Responses plan on Chat from the same effort, skipping Chat off', () => {
    expect(keys(buildUtilityRequestPlan({
      wire: 'responses',
      mode: { kind: 'ladder', declaration: declared },
      chatFallback: true,
    }))).toEqual([
      'responses|effort:low',
      'responses|effort:medium',
      'chat-completions|effort:low',
      'chat-completions|effort:medium',
    ]);
  });

  it('never adds the minimal body to a declared ladder', () => {
    expect(keys(buildUtilityRequestPlan({
      wire: 'chat-completions',
      mode: { kind: 'ladder', declaration: declared },
      minimalBodyFallback: true,
    }))).not.toContain('chat-completions|omit|minimal');
  });

  it('walks an unknown model from off to low to the minimal body', () => {
    expect(keys(buildUtilityRequestPlan({
      wire: 'chat-completions',
      mode: { kind: 'ladder', declaration: { kind: 'unknown' } },
      minimalBodyFallback: true,
    }))).toEqual(['chat-completions|off', 'chat-completions|effort:low', 'chat-completions|omit|minimal']);
  });

  it('sends nothing for a declared-empty model', () => {
    expect(keys(buildUtilityRequestPlan({
      wire: 'responses',
      mode: { kind: 'ladder', declaration: { kind: 'empty' } },
      chatFallback: true,
    }))).toEqual(['responses|omit', 'chat-completions|omit']);
  });

  it('keeps an explicit caller effort and carries it to the Chat fallback', () => {
    expect(keys(buildUtilityRequestPlan({
      wire: 'anthropic-messages',
      mode: { kind: 'fixed', rung: { kind: 'effort', effort: 'low' } },
      chatFallback: true,
    }))).toEqual(['anthropic-messages|omit', 'chat-completions|effort:low']);
  });
});

describe('nextUtilityRequestStep', () => {
  const steps = buildUtilityRequestPlan({
    wire: 'anthropic-messages',
    mode: { kind: 'ladder', declaration: { kind: 'declared', efforts: ['low', 'medium'] } },
    chatFallback: true,
  });

  it('jumps from a missing native endpoint to Chat with the same reasoning step', () => {
    expect(utilityRequestStepKey(steps[nextUtilityRequestStep(steps, 1, 404)!]!))
      .toBe('chat-completions|effort:low');
  });

  it('only treats 404 as a parameter error on Cindy AI native steps', () => {
    const chat = steps.findIndex((step) => step.wire === 'chat-completions');
    expect(nextUtilityRequestStep(steps, chat, 404)).toBeNull();
  });

  it.each([401, 403, 429, 500, 502])('does not advance on HTTP %i', (status) => {
    expect(nextUtilityRequestStep(steps, 0, status)).toBeNull();
  });

  it('advances on 400 and 422 until the plan ends', () => {
    expect(nextUtilityRequestStep(steps, 0, 400)).toBe(1);
    expect(nextUtilityRequestStep(steps, 0, 422)).toBe(1);
    expect(nextUtilityRequestStep(steps, steps.length - 1, 400)).toBeNull();
  });
});

describe('remembered steps', () => {
  beforeEach(() => resetUtilityReasoningMemory());

  it('starts from the remembered step and ignores one that is no longer in the plan', () => {
    const steps = buildUtilityRequestPlan({
      wire: 'chat-completions',
      mode: { kind: 'ladder', declaration: { kind: 'declared', efforts: ['low', 'medium'] } },
    });
    rememberUtilityStep('route', steps[1]!);
    expect(rememberedUtilityStepIndex('route', steps)).toBe(1);
    expect(rememberedUtilityStepIndex('other-route', steps)).toBe(0);
    rememberUtilityStep('route', { wire: 'responses', rung: { kind: 'effort', effort: 'xhigh' } });
    expect(rememberedUtilityStepIndex('route', steps)).toBe(0);
  });

  it('never remembers the minimal body', () => {
    const steps = buildUtilityRequestPlan({
      wire: 'chat-completions',
      mode: { kind: 'ladder', declaration: { kind: 'unknown' } },
      minimalBodyFallback: true,
    });
    rememberUtilityStep('route', steps.at(-1)!);
    expect(rememberedUtilityStepIndex('route', steps)).toBe(0);
  });
});

describe('compatHasReasoningOff', () => {
  it('is true only for vendor profiles with their own off spelling', () => {
    const route = (upstreamBase: string, model: string) => ({ harness: 'codex' as const, upstreamBase, model });
    expect(compatHasReasoningOff(route('https://open.bigmodel.cn/api/paas/v4', 'glm-5'))).toBe(true);
    expect(compatHasReasoningOff(route('https://inference.baseten.co/v1', 'openai/gpt-oss-120b'))).toBe(true);
    expect(compatHasReasoningOff(route('https://api.deepseek.com', 'deepseek-v4-flash'))).toBe(false);
    expect(compatHasReasoningOff(route('https://gateway.test.invalid', 'deepseek/deepseek-v4-flash'))).toBe(false);
  });
});

describe('compatMarksNoReasoning', () => {
  it('follows the vendor profile and ignores unknown endpoints', () => {
    expect(compatMarksNoReasoning({
      wire: 'chat-completions',
      harness: 'codex',
      upstreamBase: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2.6',
    })).toBe(true);
    expect(compatMarksNoReasoning({
      wire: 'chat-completions',
      harness: 'codex',
      upstreamBase: 'https://gateway.test.invalid',
      model: 'kimi-k2.6',
    })).toBe(false);
  });
});
