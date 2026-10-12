# 插件调用统计：客户端实施记录

2026-10-12，基于客户端 `fa3fc88d37d205ea993a67d85612fa9a5436fae5`，在隔离任务分支本地实施。
原方案见 [plugin-usage-statistics-plan.md](plugin-usage-statistics-plan.md)。原交接文档保持原样，SHA256 为
`bbc7a3dd07d530ff2d443dfa6752c328a4106c85df15200e8c3040c26b4c0184`。

## 本次完成

- 账户 SQLite 的历史身份与调用事件两张表；Drizzle 增量迁移 `0126_dazzling_pyro.sql`。
- 在 `GhostPipeDispatcher` 校验通过、`sendToGhost` 成功返回后异步记录，使用现有 callId 去重。
  失败、超时和明确取消保存独立 outcome。调试调用明确排除；参数和结果正文不进入统计。
- 安装落位后、市场账本提交后、启动和稳定账户切换时验证并绑定来源。派发热路径使用已绑定的
  身份快照，不读取插件文件。普通升级与回滚保留本地连续安装的主体；本地卸载重装分开，
  可验证市场来源重装延续。禁用、卸载及任务删除保留历史事件。
- 主进程短队列与每步 owner/clientEpoch 核验；切号和退出在关闭数据库前有界排空。
  清除以一个 worker 事务递增持久代际并删除明细，旧句柄不重放，迟到结果只 UPDATE。
- 安装详情中的单个个人卡片：最近使用、滚动 168 小时调用数、三个参与任务、刷新和确认清除。
  最近任务先过滤删除，再去重排序 LIMIT 3，标题实时读取。跳转复用现有伙伴/普通/Orca 任务入口。
  卡片以账户代际为 key，避免切号后保留旧账户的显示结果。
- 未安装详情在版本后展示带图标的共享安装/使用指标及口径说明；公共与企业插件只使用服务端
  已授权响应，custom/public 标记不扩大共享范围。缺失统计时整段隐藏（含分隔点），真实字符串
  `"0"` 才显示 0；使用次数采用用户选定的 `Tally5` 计数刻度图标。Light/Dark 均走语义 token，五种语言同步。

## 服务端依赖与协议

现有 `PluginDownload` 是获取下载地址次数，不是安装回执。没有重新使用已关闭的
#2310/#2337 分支。初次个人记录实施未修改服务端；后续累计下载接入见下节。

现有 v2 列表和详情可选扩展 `usageStatistics`，不提升 `PLUGIN_API_SCHEMA_VERSION`：

```json
{
  "usageStatistics": {
    "installationCount": "12",
    "usageCount": "345",
    "usageCountLast7Days": "67",
    "asOf": "2026-10-12T00:00:00.000Z"
  }
}
```

计数是非负十进制字符串；非法或缺失的可选统计隐藏，不让整个市场响应失败。
安装次数必须来自成功安装回执：普通升级不增加，成功重装新增，卸载不倒扣。
使用次数为已接收的派发事件。企业响应必须沿原有 visibilityAudience/部门/角色授权过滤。
服务端仍需实现成功安装回执、幂等调用批量接收和授权聚合查询，接口建议见原方案第 12 节。

**客户端本次不上报。** 事件 `report_target` 为 NULL、`report_state` 为 `not-applicable`；没有
outbox 文件、定时发送器、联网重试或对历史个人记录的补传。预留列不等于已完成发送能力。
服务端完成并明确上线范围后，再单独实现上传和 ACK/重试/来源隔离验收。
没有可靠插件级 token 来源，本次不显示 token 估算。

## 已验证

- Desktop 15 个定向测试文件，共 408 项通过：派发资格与结果、身份、重复 callId、清除交错、
  真实 SQLite 双连接、inline/file worker、inproc DbClient、账户与退出边界、市场回归、卡片和跳转。
  本地升级/回滚/重装的版本快照另按最新用例复核。
- 协议包 127 项测试通过；Desktop 与协议包类型检查通过。
- 迁移校验六步通过；迁移回放 14 项通过。原来三项末尾序号断言已增加 0126，并检查新表存在，
  未更改任何历史 migration。
- 新模块与组件 ESLint、i18n 完整性、术语检查以及 `git diff --check` 通过。扩大到全部修改文件的
  ESLint 仍有 25 条既有错误：bootstrap 6 条、cindy-brain/index 11 条、WorkerThreadTransport 8 条。
  对三个文件分别用相同 ESLint 配置检查原 HEAD 内容，并按规则、消息与源码行对比，新增错误为 0。
- 独立 `--isolated=@worktree` Global 开发版启动返回 `DESKTOP_DEV_VERDICT=ready`。
  安装仅在这个沙箱中的本地验收插件，主进程正常 IPC 查询读取真实 SQLite 的空历史；调试工具
  成功执行前后正式调用数均为 0；实际确认清除后记录起点更新。个人卡片与公开市场缺失统计的
  Light/Dark 真实页面截图另存本地验收目录，不把示意数据写入截图或生产数据库。

## 未验证或未实施

- 没有执行真实模型发起 MCP 调用、产生非零记录并点击参与任务的完整端到端流程；这些边界
  当前由真实派发器、数据库与组件定向测试覆盖，不能将其表述为模型端到端验收完成。
- 共享回执/统计没有服务端联调，未实现上传。Mobile 没有新增统计页面；个人数据属于实际执行
  插件的 Desktop 宿主，不合并其他电脑的数据。
- 异步数据库写入在崩溃、磁盘故障或绑定尚未就绪时可能漏记，未承诺计费级 exactly-once。
- 普通退出、切号和企业下架沿原有生命周期；未扩展账户删除系统，未声称注销已物理擦除数据库。
- 本次仅本地交付；没有 push、创建 PR、合并或部署。插件基座变更仍需指定维护者 Approve 才能合并。

## 2026-10-12 展示修订

- 根据用户反馈，市场头部无统计数据时隐藏整段指标和分隔点；已有明确的 0 仍正常显示。
  用户选择 `Tally5` 替换快速模式已使用的 `Zap`。不改变个人卡片的空记录呈现。
- 两个相关组件测试文件共 12 项通过，Desktop 类型检查、相关文件 ESLint 和 diff 检查通过。
- 在本 worktree 独立 Electron 开发版中通过前端热更新查看真实 TapTap Maker 详情，Light/Dark
  均已目检无统计时的头部；截图位于 `apps/desktop/logs/plugin-usage-acceptance/shared-usage-followup/`。
  服务端当前未提供统计，带数字与新图标的真实市场状态尚未实机验证；没有伪造市场数字。

## 2026-10-12 接入累计下载

用户要求接入 Platform 已有的累计数字。实际核对服务端 main `8e0ae149` 和 release 后，
确认后台统计为下载地址签发次数：`downloadStatistics.requestCount`（累计）和
`downloadStatistics.last7DaysRequestCount`（滚动 168 小时）。客户端头部只显示累计“下载”，
使用 `ArrowDownToLine`，提示说明包括更新、重装和重新请求地址的重试，不代表安装成功。

- 客户端沿 `PluginMarketApi` → v2 协议解析 → 市场服务投影 → 详情组件传递同名字段。
  精确字符串用 BigInt 格式化，无 Number 精度损失；缺失或无效字段隐藏，明确的 0 正常显示。
  不合成成功安装或使用次数；个人/custom 插件不展示共享下载数。
- 服务端独立本地分支 `/Users/huangxiaowen/Developer/cindy-server` 的
  `feat/plugin-client-download-statistics`，给 `/api/plugins` 列表和详情加可选字段，
  复用已有 `pluginDownloadStatistics` 批量聚合，不新增表、上报或 Platform 凭证。
  企业统计在原可见性/部门/角色门禁通过后查询；统计读取失败省略字段，不伪造 0。
- 服务端契约与客户端一致，schemaVersion 仍为 2；旧服务不发字段时客户端继续正常工作。
  两仓均只在本地实现，未推送、创建 PR 或部署。线上数字显示仍取决于服务端发布此扩展。

验证：客户端协议包 128 项、三个受影响 Desktop 测试文件 192 项通过；服务端协议包
145 项、plugin-server 609 项通过（41 项数据库集成测试未配置安全数据库而跳过）。
两仓协议类型检查、plugin-server 与 Desktop 类型检查、相关 ESLint、五语完整性、术语与 diff 检查通过。
独立 Global Electron 沙箱启动返回 `DESKTOP_DEV_VERDICT=ready`，当前代码下真实 TapTap Maker
详情的缺失指标隐藏在 Light/Dark 均已目检，截图在
`apps/desktop/logs/plugin-usage-acceptance/cumulative-download/market-{light,dark}.png`。
线上服务尚未返回下载统计，带数字的生产数据联调未完成，不将测试中的 123 当成实际累计数。
本次未运行客户端整仓全量测试；按影响面完成协议包与市场/详情定向验证，完整门禁待后续 PR CI。
