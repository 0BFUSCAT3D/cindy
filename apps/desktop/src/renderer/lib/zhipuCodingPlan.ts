/**
 * 智谱 GLM Coding Plan 连接识别（renderer 侧视图判定；main 侧同口径见
 * maker-host/provider-account-usage.ts 的 isZhipuCodingPlanProvider）。
 *
 * 依据官方接入端点而不是 provider 名字：内置预设（zhipu-coding-plan-cn）与从模板创建的
 * 自定义连接（baseUrl 指向 open.bigmodel.cn/api/anthropic 或 /api/coding/*）都算；
 * 按量计费的开放平台连接（open.bigmodel.cn/api/paas/*）不算——它没有 Coding 套餐额度页。
 */

import type { ProviderView } from '@cindy/model-providers';

const ZHIPU_ANTHROPIC_BASE = 'https://open.bigmodel.cn/api/anthropic';
const ZHIPU_CODING_PREFIX = 'https://open.bigmodel.cn/api/coding/';

export function isZhipuCodingPlanProviderView(provider: ProviderView | undefined | null): boolean {
  if (!provider) return false;
  if (provider.id === 'zhipu-coding-plan-cn') return true;
  return Object.values(provider.routing ?? {}).some((route) => {
    const upstream = (route as { upstream?: string } | undefined)?.upstream;
    if (!upstream) return false;
    return upstream === ZHIPU_ANTHROPIC_BASE || upstream.startsWith(ZHIPU_CODING_PREFIX);
  });
}
