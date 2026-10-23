/**
 * API Key 供应商账户接口的 renderer 侧视图判定（与 main 侧认领规则同口径，见
 * maker-host/provider-account-usage.ts 的 INTEGRATIONS）。
 *
 * 依据官方接入端点而不是 provider 名字：内置预设与从模板创建的自定义连接都按
 * baseUrl 识别；走代理 / 自定义域名的连接不算（key 属于代理，main 侧也不会认领）。
 */

import type { ProviderView } from '@cindy/model-providers';

const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
const ZHIPU_ANTHROPIC_BASE = 'https://open.bigmodel.cn/api/anthropic';
const ZHIPU_CODING_PREFIX = 'https://open.bigmodel.cn/api/coding/';

function routingUpstreams(provider: ProviderView | undefined | null): string[] {
  return Object.values(provider?.routing ?? {}).map(
    (route) => (route as { upstream?: string } | undefined)?.upstream ?? '',
  );
}

/** 任一 runtime 是否指向官方 DeepSeek 端点。 */
export function hasDeepSeekOfficialRouteView(provider: ProviderView | undefined | null): boolean {
  return routingUpstreams(provider).some((upstream) => {
    if (!upstream) return false;
    try {
      const url = new URL(upstream);
      return url.protocol === 'https:' && url.origin === DEEPSEEK_ORIGIN;
    } catch {
      return false;
    }
  });
}

/** 是否智谱 GLM Coding Plan 接入（/api/anthropic 或 /api/coding/*）；按量付费不算。 */
export function isZhipuCodingPlanProviderView(provider: ProviderView | undefined | null): boolean {
  if (!provider) return false;
  if (provider.id === 'zhipu-coding-plan-cn') return true;
  return routingUpstreams(provider).some(
    (upstream) =>
      upstream === ZHIPU_ANTHROPIC_BASE || upstream.startsWith(ZHIPU_CODING_PREFIX),
  );
}
