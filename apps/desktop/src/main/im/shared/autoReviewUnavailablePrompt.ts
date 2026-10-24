import {
  AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
  autoReviewReasonFromMetadata,
  isAutoReviewUnavailableMetadata,
  type InteractionRequest,
} from '@cindy/maker-core';

/**
 * 文本通道确认提示里的故障说明。硬编码中文，与 Desktop zh-CN 确认卡同句，
 * 不进 renderer locale（见 engineering-conventions.md §5）。
 */
export const IM_AUTO_REVIEW_UNAVAILABLE_PROMPT =
  '自动审批没完成，请确认要不要允许这次操作。';

/**
 * 确认提示里「为什么问你」的一行：审阅器故障的固定说明，或审阅器判定 ask 时给出的原因。
 * 两种都是只能放行这一次的确认（forcePrompt），渠道不应再提供「总是允许」。
 */
export function autoReviewUnavailablePromptLine(
  request: InteractionRequest,
): string | null {
  if (request.kind !== 'permission') return null;
  if (isAutoReviewUnavailableMetadata(request.metadata)) return IM_AUTO_REVIEW_UNAVAILABLE_PROMPT;
  const reason = autoReviewReasonFromMetadata(request.metadata);
  return reason ? `自动审批需要你决定：${reason}` : null;
}

/**
 * 故障降级时 description 末尾是英文兜底句（interactionRouter 可能在前面加上来源），
 * 渠道已用中文说明代替，去掉英文句避免中英重复。
 */
export function permissionPromptDescription(request: InteractionRequest): string | undefined {
  if (request.kind !== 'permission' || !request.description) return undefined;
  if (!request.description.endsWith(AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT)) return request.description;
  return request.description.slice(0, -AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT.length).trim() || undefined;
}
