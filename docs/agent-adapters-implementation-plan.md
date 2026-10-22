# Agent Adapter 与统一运行节点：实现和回归计划

> 2026-10-20：P0/P1 已完成；首批本机 + Device Link + Desktop/Mobile 实验入口已实现，默认关闭。
> 已接 34 个官方原生入口（31 个 ACP、Step RPC、Muse MSP、Crush HTTP/SSE）；代码接入与账号实测分开记账。
> 首批 Cursor、OpenCode、CodeBuddy、Kiro 已通过本机
> 真实创建、文本回复、协作取消、关闭和再次启动验收，其中 CodeBuddy 使用中国版原生登录、
> Kiro 使用 Google 原生登录。Antigravity 已安装并通过官方授权、ACP 握手、创建、关闭及新进程
> 复用登录；模型请求被 Google 以地区不可用拒绝，真实回复与取消尚未通过。
> 用户反馈 CodeBuddy 海外版账号受限，已按用户要求暂停海外版验收。
> 第二批新增 Gemini、Copilot、Goose、Kimi Code、Qwen Code、Cline；Cline 已通过本机
> 登录、文本、取消、文件/命令、权限与再次启动，Kiro 工具/权限复验通过。Copilot 文本、取消和
> 多轮通过；完整工具验收通过一次后复验失败，稳定性待补验。Kimi 海外版已登录，模型请求被官方
> 403 订阅套餐要求拒绝；Gemini 官方 Google 登录拒绝此客户端的个人版使用，待可用官方账号方式；
> Qwen 已选国际版 Coding Plan，待用户在原生终端完成 Key 配置，Goose 仍待配置。Cursor、OpenCode 工具通过
> 但权限拒绝未验证；CodeBuddy 取消后续发异常已明确报错，后续复验另出现首条回复超时。
> 真实双设备、Windows 与剩余原生权限交互尚未验收，
> 不能标记整个计划或发布回归完成。
> 本文是客户端实现与验收台账，不改变现有供应商行为。
> 服务端不在本计划的默认范围内；需要服务端协议时另行拆分并先完成客户端兼容设计。

2026-10-20 用户明确：部分产品没有账号，先确保代码接入并继续下一批。后续分开记录
「代码接入验证」与「真实模型调用验收」；官方入口、原生发现／握手、权限与进程生命周期、
默认关闭和旧链路回归可以不依赖付费账号验证。缺少账号或官方资格只影响该产品的真实调用
验收，不再要求用户反复登录，也不阻塞其他适配器实现。模拟通过不能改记为实机回复通过；
本轮不因此启用实验开关或宣布发布回归完成。

## 目标

让 Cindy 能编排本机或远程的 Cursor、WorkBuddy、OpenCode、Cline、Roo、Aider、Gemini CLI、
Qwen Code、Kimi Code、Claude Code、Codex、Pi 等 Agent，同时保留当前 Cindy provider route、
供应商组、供应商分享和现有订阅登录路径。

统一的是 Agent 实例、运行节点、工作目录、能力、状态、权限和路由；不是把所有消费订阅
凭证变成一个通用 API。

    任务
      → UnifiedRouteResolver
      → AgentInstance / OfficialApiAccount / ExistingProviderRoute
      → RuntimeNode
      → Workspace
      → Agent 原生运行时或官方 API

## 不可破坏的边界

- Agent 原生订阅由对应的官方 CLI、桌面端或官方插件自己登录和持有。
- Cindy 只保存 Agent 实例和账号的不可逆引用、能力、健康状态、用量和授权结果，不读取、
  复制、刷新或导出消费订阅 Token。
- 不提取浏览器 Cookie，不逆向内部端点，不把一个 Agent 的订阅包装成另一个 Agent 可用的
  通用 API，不用账号轮换规避配额或并发限制。
- 官方 API / OAuth 是另一种明确的 official-api 路径，不能和 agent-native 路径混用。
- Claude 订阅继续只通过官方 Claude Code CLI 使用。
- 没有官方 CLI、插件协议或 API 的产品不做逆向适配；适配器必须报告“不支持官方接入”。
- 旧任务没有显式选择新 Agent 时，统一路由必须返回现有 provider route；不能因新 Agent
  可用而改变默认行为。
- 显式选择的新 Agent 不可用时必须明确失败，不能静默回退到另一个订阅、另一个账号或旧
  provider route。

## 分阶段实现

### P0：核心契约和纯路由（已完成）

交付：

- maker-core 中新增 AgentAdapter、ProviderAdapter、RuntimeNode、Workspace、AgentInstance
  和统一路由类型。
- 纯 resolveUnifiedRoute：默认保持旧 provider route；显式目标只精确选择同类型候选。
- 路由错误码、节点/工作目录一致性检查和凭证边界检查。
- 无 Electron、无 IPC、无 UI、无凭证读取、无实际子进程。
- 通过 `@cindy/maker-core/agent-adapters` 独立子入口加载，不引入其他 Agent 的 SDK 或
  prompt 资源；原有 maker-core 根导出继续兼容。

验证：maker-core 类型检查和路由单测。该阶段不应触发 Desktop 行为回归。

### P1：Desktop 主进程的适配器注册表（六个切片已完成）

第一切片已完成：Desktop main 拥有内存中的 `AgentAdapterRegistry` 与
`RuntimeNodeDirectory`，默认 `enabled: false`；它们只做注册、在线节点筛选、发现结果投影和
节点生命周期管理，不启动 Agent、不读凭证、不新增 IPC。`maker-host` 在 Maker 生命周期内创建并在
账号边界重置；旧 provider route 不依赖这套运行时。

第二切片已完成：运行节点目录通过惰性的只读源投影现有本机、Device Link 桌面 peer 和 SSH
连接池状态。手机 peer 会被过滤；SSH 的连接中/鉴权中/重连中状态映射为 `degraded`，
Device Link 的远程控制不可用或本机响应熔断也映射为 `degraded`。目录刷新是原子替换，节点消失
会从投影中移除；不创建新的连接、读取凭证、启动 Agent、增加 IPC 或修改 Device Link wire
协议。适配器注册表和旧 provider route 仍相互独立。

第三切片已完成：注册表接受可选的非秘密适配器元数据和能力声明，并提供只读状态投影。
状态只由 rollout 开关、运行节点快照和已完成的发现结果派生；关闭时返回 disabled，不会调用适配器、
读取登录态或暴露错误原文。旧适配器不提供元数据时使用兼容默认值；重复能力会在投影中去重。
该切片仍不启动 Agent、不增加 IPC、不改变旧 provider route。

第四切片已完成：Desktop live source 现在注入本机 host 的只读状态。Electron 尚未 ready 时本机节点
为 offline，账号边界切换或 Maker 尚未完成初始化时为 degraded，Maker 可用后为 online；节点名称
复用现有设备名。该判断不依赖 Device Link relay 在线，也不读取订阅凭证。默认开关仍为 false，关闭时
不会读取这组状态源；旧 provider route 和既有任务入口不变。

第五切片已完成：Device Link 通过主进程内的只读变化订阅驱动运行节点目录刷新。presence 的在线／离线、
远程控制可用性、响应性熔断、远端撤权、relay 断开清理和本机控制目标开关都会触发刷新；消费者仍需
重新读取已脱敏的节点快照，不接触 relay 凭证、link handle、任务数据或新的 wire／IPC channel。订阅只在
适配器运行时显式启用时注册，默认关闭时不注册、不读取 Device Link 节点源；账号边界重置会解除订阅。
旧 provider route 和既有任务入口不变。

第六切片已完成：发现结果在进入统一目录前执行 fail-closed 校验。Agent 实例必须绑定当前适配器、
当前运行节点和 `agent-owned` 凭证边界；官方 API 账号必须绑定当前适配器并使用 `official-api` 边界。
发现结果中的重复 ID、非法状态、非法能力声明、跨节点绑定或错误边界都会被丢弃并投影为通用失败，
不暴露第三方 stderr、Token 或错误对象，也不会触发旧 provider route 回退。适配器仍默认关闭，
没有新增 IPC、协议或实际 Agent 启动。

P1 后续实际适配器接入见 P2；P1 本身继续保持独立开关和旧链路隔离。

交付：

- 由 Desktop main 注入运行节点目录、工作目录解析器和适配器注册表。
- 适配器只提供发现、健康检查、启动/连接、发送、停止和事件流；不提供导出凭证的方法。
- 统一路由只作为新入口，旧 provider-route.ts 和供应商组路由保持原调用链。
- 通过配置开关关闭时，新入口完全不参与旧任务。

验证：main handler 主/错路径单测、旧 provider route 定向回归、凭证边界 guard、跨平台
进程启动和停止测试。

### P2：官方 Agent 本机垂直切片（逐项验收，保持实验态）

acp.ts 实现 ACP v1 双向 NDJSON JSON-RPC；definitions.ts 声明官方命令：

| Agent | 官方命令 | 发现方式 | 登录边界 |
| --- | --- | --- | --- |
| Cursor | cursor-agent acp（官方 agent acp 的安装别名） | PATH / ~/.local/bin | 原生 cursor_login；用户先通过 agent login 登录 |
| OpenCode | opencode acp | PATH / ~/.opencode/bin | OpenCode 自己持有 |
| CodeBuddy | codebuddy --acp | PATH | CodeBuddy 自己持有 |
| Kiro | kiro-cli acp | PATH / ~/.local/bin | Kiro CLI 自己登录和持有 |
| Google Antigravity | agy_acp_server.par（Windows 为 agy_acp_server.exe；Linux 追加 --uid=） | PATH / ~/.local/bin | 官方 ACP oauth-personal 自己登录与持有；首次可能单独打开 Google 授权页 |
| Gemini CLI | gemini --acp | PATH / ~/.local/bin；Windows 官方 npm Node 入口 | 原生 CLI 登录；不默认替用户选择 auth method |
| GitHub Copilot CLI | copilot --acp | 同上 | Copilot 自己持有 |
| Goose | goose acp | PATH / ~/.local/bin | goose configure 原生配置 |
| Kimi Code | kimi acp | PATH / ~/.kimi-code/bin | 新版 Kimi 原生设备登录；账号区域由用户选择 |
| Qwen Code | qwen --acp | PATH / ~/.local/bin；Windows 官方 npm Node 入口 | Qwen 自己配置与持有 |
| Cline | cline --acp | 同上 | cline auth 原生登录 |
| Factory Droid | droid exec --output-format acp-daemon | PATH / ~/.local/bin；Windows 原生 .exe | Droid 自己登录和持有 |
| Qoder CLI | qoder --acp / qodercli --acp | PATH / ~/.local/bin；Windows 官方 npm Node 入口 | Qoder 自己登录和持有 |
| Qoder CLI CN | qodercn --acp / qoderclicn --acp | 同上；独立官方可执行文件 | 中国大陆版原生登录，与 Qoder 分开 |

官方依据：[Cursor](https://cursor.com/docs/cli/acp)、[OpenCode](https://opencode.ai/docs/acp/)、
[CodeBuddy](https://www.codebuddy.ai/docs/cli/acp)、[Kiro](https://kiro.dev/docs/cli/acp/)、
[Antigravity 官方编辑器接入](https://antigravity.google/docs/ide/extensions/zed/)及其
[ACP 注册表](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
（2026-10-20 核验）。早期骨架把 CodeBuddy
等同于 WorkBuddy、猜测 WorkBuddy.app 内部路径及追加 --acp-transport stdio 的描述已撤回。

- Agent 原生拥有工具、权限、项目规则与登录。Cindy 不声明未实现的 ACP fs/terminal 能力，
  不接管 Agent 的文件工具，不注入 Cindy provider key、Node 启动参数或配置目录 override。
- session/new、文本流、工具状态、计划、权限选择、取消通知与关闭均已接线。
  双向请求可重用同一数值 ID；未知请求明确拒绝。帧最大 1 MiB，启动请求有超时。
- POSIX 关闭独立进程组；Windows 使用无 shell 的 taskkill.exe /T /F 终止树。
  Windows 支持 .exe，及 Gemini/Copilot/Qwen/Cline 的官方 npm Node 入口；独立查找 node.exe，
  用 argv 启动，不执行 .cmd/.bat shim、不使用 Electron 代替 Node。Windows 实机尚未验收。
- POSIX 主进程先退出时仍检查并回收遗留工具进程组；停用与退出等待在途启动/关闭完成清理。
  ACP 帧上限按 UTF-8 字节计数，中文等多字节内容同样受 1 MiB 上限约束。
- 每次创建前重验宿主已登记工作目录；控制端只能提交 opaque id，不能自报路径、可执行文件或环境。
- 登录异常、协议错误、进程退出分别收口，鉴权超时显示检查原生登录和网络的指引，不自动换账号。

真实验证：通过执行电脑上的官方 `cursor-agent login` 打开官方页面，确认页面已有账号，
页面与 CLI 均返回成功；没有读取、复制或导出凭证。随后使用已安装的
`2026.02.13-41ac335`，经生产适配器、运行服务和资源入口完成隔离临时工作目录内的真实验收：
创建 2.61 秒；收到指定文本回复；第二条原生消息收到文本后发出取消，任务正常回到 idle；
关闭并清理，全流程 17.69 秒。两条消息使用 Cursor 自己的原生登录和模型。
随后再次创建并关闭通过（2.35 秒），直接复用原生登录，没有再次要求网页授权。

此前已安装版与临时官方新版 `2026.10.19-6bbf2c4` 都曾在 authenticate 阶段超时；本机
重新完成官方登录后已安装版通过。仅凭该现象不能判断旧凭证为何失效，也不能认定是 CLI
版本问题。对照测试未替换已安装的 Cursor，临时发行包、运行进程和工作目录均已回收。
经用户明确授权，按官方 npm 文档安装 `opencode-ai@1.19.3` 与
`@tencent-ai/codebuddy-code@2.170.0`；安装在执行电脑现有 Node 全局目录，
没有修改仓库依赖或复制凭证。手动安装不代表产品内已实现自动安装。

OpenCode 1.19.3 经同一生产入口完成真实验收：创建 0.84 秒；指定文本回复通过；
第二条消息收到文本后协作取消，正常回到 idle；关闭并清理，全流程 22.68 秒。
再次创建与关闭通过（0.84 秒）。沿用 OpenCode 原生默认配置，没有要求额外登录，
没有注入 Cindy 的模型密钥；未据此推断实际模型或账号。

CodeBuddy 2.170.0 通过原生 CLI 的 Chinese Site 入口打开官方微信扫码页，
用户完成扫码后，官方页面显示登录成功，CLI 进入主界面并正常退出。
随后经同一生产入口完成真实验收：创建 0.83 秒；指定文本回复通过；
第二条消息收到文本后协作取消，正常回到 idle；关闭并清理，全流程 8.06 秒。
再次创建与关闭通过（0.84 秒），复用原生中国版登录，没有再次要求扫码；
没有设置账号环境覆盖，也没有读取或复制凭证。登录进程与临时工作目录已回收。

以上为首批本机文本与生命周期验收；后续工具／权限结果见下方最新验证台账。

追加验收：经用户授权，用 Kiro 官方安装器安装 CLI 2.32.0（安装器核验官方 manifest 摘要）。
适配器使用该版本默认的 ACP v2 引擎；V3 需单独核验，不因同样使用 ACP 版本 1 就宣称兼容。
登录通过 `kiro-cli login --use-device-flow`，按用户选择打开官方 Google 设备授权，
不启用 client-owned auth。此前设备码过期、原生未登录时，创建阶段退出（`closed`）；
重新完成设备授权后，原生 CLI 确认 Google 登录成功并退出 0，`kiro-cli whoami` 返回 0
（只记录退出码和登录状态，不读取凭证文件）。随后经同一生产适配器、运行服务和资源入口，
在隔离临时工作目录中完成真实验收：创建 26.69 秒；收到指定文本回复；第二条消息收到文本后
协作取消，正常回到 idle；关闭并清理，全流程 31.38 秒。新进程再次创建 1.74 秒，
创建与关闭全流程 2.38 秒，直接复用原生登录，没有再次要求网页授权。
此次初次验收不改生产代码、不启用应用开关；后续工具／权限结果见最新台账，ACP V3 仍未实测。

Antigravity 追加验证：经用户授权，通过 Google 官方安装器安装 `agy` 1.4.3，
安装器完成官方 manifest SHA-512 校验，并向本机 shell profile 追加 `~/.local/bin` 的 PATH。
`agy` 的 headless 模式使用流式 JSON；Cindy 接入的是 Google 单独发布的 ACP 1.4.1 组件，
来自注册表指向的 `dl.google.com/agy-extensions/releases/macos/`，不是把 `agy` 当成 ACP CLI。
原生 ACP bundle 保留 `agy_acp_server.par` 与 `localharness_external` 的同目录布局，
手动安装在 `~/.local/share/antigravity-acp/1.4.1/`，`~/.local/bin/agy_acp_server.par`
只负责 exec 原生入口，不读取或代理凭证；这不代表已实现产品内自动安装。
适配器按官方协议选择 `oauth-personal`，Linux 按注册表追加 `--uid=`；现有适配器的参数不变。
官方原生进程已返回 ACP 协议版本 1、组件版本 1.4.1 和 Google 登录方法；
未选择鉴权方法时 `session/new` 返回 `-32000`。`agy` 已完成官方 Google 登录与首次设置，
可选的交互数据收集未开启，原生 CLI 正常退出 0；但 ACP 仍发起了自己的官方 Google 授权，
不能假定两者共用登录态。ACP 官方回调确认成功后创建通过（35.85 秒），之后新进程不再要求授权。
首次网页授权超过原先 30 秒 RPC 等待，已把 Antigravity 的 authenticate 单独设为最多 180 秒；
其余 RPC、现有适配器、取消和清理语义保持原样。手动 smoke 同步保留足够的创建等待时间。

随后经生产适配器、运行服务和资源入口，创建通过（4.09 秒），但文本返回 Google 的地区限制：
“Your current account is not eligible for Gemini Code Assist for individuals because it is not currently
available in your location.” 官方 ACP 把该提示作为文本并以 `end_turn` 收尾；它不是模型完成
指定任务的证据，smoke 因而报 `unexpected-response`，未继续把取消记为通过。没有换账号、
注入 API key 或改用其他 Agent。新进程再次创建、关闭通过（4.69 秒），复用 ACP 自己持有的登录。
真实模型回复和协作取消仍待账号获得官方可用资格后验收。

CodeBuddy 海外版通过官方 `CODEBUDDY_CONFIG_DIR` 使用独立的本机配置目录，
仅在该次原生进程内设置 `CODEBUDDY_INTERNET_ENVIRONMENT=public`，由官方 CLI 发起网页登录。
这属于手动验收环境，尚不代表 Cindy 产品内支持多 profile 选择；不会为测试开放任意环境变量透传。
两次海外登录均等待超时（`TimeoutError`），未完成海外版真实消息验收。已退出登录进程。
用户随后反馈海外账号受限，并明确要求先不处理；海外验收暂停，不再重试登录。
期间复查中国版原有默认入口，真实创建、回复、取消、
关闭均通过（10.77 秒），没有修改其默认配置。

手动原生验收入口（不进默认单测／CI，不打开应用开关）：

```bash
node --import tsx scripts/smoke-agent-adapters.mts --agent cursor
node --import tsx scripts/smoke-agent-adapters.mts --agent cursor --send
node --import tsx scripts/smoke-agent-adapters.mts --agent opencode --send
node --import tsx scripts/smoke-agent-adapters.mts --agent codebuddy --send
node --import tsx scripts/smoke-agent-adapters.mts --agent kiro --send
node --import tsx scripts/smoke-agent-adapters.mts --agent antigravity --send
node --import tsx scripts/smoke-agent-adapters.mts --agent copilot --tools
```

`--agent` 支持 definitions.ts 中的 11 个入口，默认仅发现、创建、关闭；`--send` 额外发送
两条简短原生消息并验证协作取消，会消耗该 Agent 的原生用量。执行电脑须已完成该 Agent
自己的安装与登录。可用 `--executable <绝对路径>` 指定已有 CLI 做版本对照，指定路径失效时
不会回退到其他安装。脚本只输出阶段、稳定错误码和计数，不打印原生输出或账户资料；
失败、SIGINT、SIGTERM 均等待进程回收并删除本次临时工作目录。

显式 `--tools` 在临时目录测试拒绝写入、允许后读取/复制随机内容、原生命令执行。
仅手动验收脚本会有界选择 ACP 的 allow_once；产品不自动批准。没有权限请求时拒绝项记
unverified 并保持非零退出，继续验证工具，不把原生默认允许误记成拒绝通过。
ACP 的工具 kind 与权限选项 kind 只在宿主内保存，资源表单仍投影原 id/label，不增加远程协议字段。
取消只发给当前繁忙轮次；非用户取消而返回 cancelled 时记 unexpected-cancellation，沿已有失败路径
收尾，不隐式创建新任务或重发消息。

### P3：远程 RuntimeNode（Device Link 已接线，SSH 执行未接线）

复用现有 device-link / SSH / remote-agent 生命周期，把 Agent 运行位置抽象为：本机、同账号
另一台 Cindy、SSH 主机或云端官方 Agent。远程任务的文件和命令仍绑定远端 Workspace，
不会把控制端凭证带到远端。

已实现：复用 Remote Resource v1 的 manifest/list/get/invoke，注册 agent-adapters collection；
不新增 relay 协议或放宽 allowlist。本机有用途明确的可信 renderer IPC；远程复用 server-stamped
Device Link 身份、现有远控开关和撤权表。共享任务／供应商分享访客不可调用新入口。

执行端按 (owner generation, controllerDeviceId, runId) 隔离；创建与发送均有 requestId 去重，
同 ID 不同内容拒绝。启动前后的 await 检查账号和授权，迟到进程立即关闭。
只重试读取，最迟 2 分钟停止自动重试；前台返回/手动刷新重新核对，写操作不自动重放。
单控制端 16 个活跃任务、整机 64 个；执行端 3 分钟无人读取的远程任务收尾。
目录视图续租该控制端的任务；一个控制端失联不影响另一个控制端，也不重连共享 relay。

**故障半径三问**：故障是一个资源请求或控制端失联；恢复动作只重读该资源、回收该控制端任务；
两控制端的内存回归已覆盖一端过期另一端仍运行。两台真实设备端到端仍待验收。

SSH 节点目前仅状态投影，不出现在可执行目标选择里；不把远端路径当成本机路径执行。

验收要求：现有 remote-agent、provider-group、device-link 定向回归，以及远程 Agent
端到端 smoke；验证 macOS 与 Windows 路径和子进程终止语义。已执行项见验证台账，
真实双设备、Windows 与 SSH 执行验收尚未完成。

### P4：Agent 产品适配器扩展（22 个已接线，逐项验收中）

2026-10-20 用户要求以 Magpie 支持的产品作为全面覆盖目标。已核对其 main
`75e769a9f9b419f805b925f147146eff179111b9`：README 与源码均为 63 个内置客户端配置适配项，
另登记 19 类订阅来源及插件扩展；完整清单、Cindy 状态与实施顺序见
[Magpie 产品覆盖对照](agent-adapters-magpie-coverage.md)。

63 项全部纳入跟踪，已有 Kiro、用户另提的“飞书工作”及此前候选也继续保留。Magpie 的模型
配置兼容不等于 Cindy 的原生 Agent 执行支持；WorkBuddy 桌面端、WorkBuddy AI 与 CodeBuddy
CLI 分开验收。每个适配器必须单独声明发现方式、官方授权方式、支持的事件、工作目录能力、
远程能力和不支持项，不把同一底层 Agent 的不同界面重复算成已验收。

没有官方可复现接入方式的产品只显示“暂不支持官方接入”，不通过抓 Cookie 或逆向协议补齐。

当前每个 Agent 使用执行电脑上的原生默认登录。尚未实现多原生 profile／账号选择、自动安装、
附件、原生模式/模型切换、跨重启 resume 或 Cindy MCP 注入；不能声称支持所有 Agent 或账号池。
WorkBuddy 两版公开文档已核验 IM 助理入口，仍未找到公开 ACP/SDK 执行接口；用户提及的飞书工作
及其余 Agent 仍未接入，需逐个核验官方入口。第二批安装版本、官方依据与详细结果见
[覆盖清单 §6](agent-adapters-magpie-coverage.md#6-2026-10-20-第二批实现与实机核验)。
第三批已追加 Factory Droid、Qoder CLI 与 Qoder CLI CN；不复制账号、不在两版 Qoder 之间
回退，缺少账号的真实模型验收单独留待具备条件时完成。
第四批新增 Devin、MiniMax Code、Grok Build、MiMo Code、oh-my-pi、MothX、DeepSeek Harness
和 Hermes Agent。8 个官方原生入口均已安装并做无账号／无配置探针；代码与错误路径验证
不依赖用户补齐账号，真实模型回复、工具与运行中取消分别记为未验收，详见覆盖清单 §8。

### P5：官方 API 账号池（未实施；旧供应商独立保留）

把已有官方 API 供应商映射为 official-api 候选，统一展示账号、模型、额度和健康状态。
这条路径和 agent-native 分开，API key/OAuth 仍由现有 provider credential 边界管理。
现有 ProviderGroup 与 ProviderShare 继续作为兼容路由，不改成通用账号转售层。

### P6：Desktop / Mobile 产品面（实验入口已实现，发布验收未完成）

- Desktop 先展示 Agent 实例、运行节点、工作目录和健康状态；高级信息渐进展开。
- Mobile 复用执行端目录，只做远程选择、状态和任务控制，不在手机保存 Agent 凭证。
- 所有 UI 文案走现有 i18n 和术语门禁，Light/Dark 同时实现。
- 通过灰度开关逐步开放；关闭新入口时旧任务可独立运行。

Desktop 入口：设置 → 供应商 → 外部 Agent。选择本机/另一台有远控权限的电脑、原生 Agent、
工作目录，再创建。Mobile 通过设备的 Remote Resource 入口打开同一目录与控制；不能在手机
远程打开执行电脑的实验开关。两端共用宿主 actions，权限默认不选择，不自动授权；回执不明时
保留输入和 requestId，先刷新核对。

配置属于高级 opt-in，默认 enabled: false。owners/<owner>/agent-adapters.json 只写显式
override；停用保留显式 false，恢复默认删除 override。关闭、换账号和退出只回收新适配器进程。
本轮没有在用户 profile 写入启用值，未重启或更新当前运行的 Cindy。

实验任务当前是独立的内存运行记录，未冒充旧 Maker Session，也未修改数据库 AgentKind。
最多保留 256 条运行视图、每条最近 60,000 字符；较早输出显示省略提示。重启、切账号或停用
会结束这些记录，原生 Agent 自己的记录/项目文件由它自己管理。跨重启任务历史与恢复仍待实现。

## 2026-10-20 验证台账

- 新 runtime、ACP、运行服务、host IPC、Device Link 和旧 providerRoute：定向回归通过。
- 最新适配器/界面回归 5 文件、48 用例通过（1.95 秒）；收尾补齐进程组退出、在途启动/关闭和 UTF-8
  帧上限的先红后绿用例。新增测试文件在本机单独运行预算 5 秒以内。
- 供应商组全套及分享分发/运行/调用：30 文件、664 用例通过。
- Mobile 资源读取、表单、原有伙伴资源路由、新 Agent 资源路由、字体规则：4 文件、47 用例通过
  （1.12 秒）；原生控件的 DOM 测试替身仍有非阻断属性警告，未作为实机 UI 验收。
- maker-core/maker-shared build、Desktop/Mobile typecheck、适配器 lint、test-hygiene、文档和术语门禁通过
  （最终验证以本轮交付记录为准；之后的新修改需要相应复验）。
- pnpm ui:check --changed --theme all：38/38 场景通过，已目检 Agent 页 Light/Dark。
  ProvidersSection 新入口、完整应用 router、真实手机 UI 不在该截图覆盖内。
- Agent 页另跑 360×740 / 900×800、Light/Dark 全场景：12/12 通过，两张 overview 均已目检。
  截图位于 artifacts/ui-check/agent-adapters-WGMw4R/，未提交或发布图片。
- 真实 Cursor ACP 创建、指定文本回复、协作取消与关闭通过（17.69 秒）；原生登录由官方 CLI
  与官方网页完成；再次创建并关闭通过（2.35 秒）。
- 真实 OpenCode 1.19.3 经同一生产入口完成创建、指定文本回复、协作取消与关闭（22.68 秒），
  再次创建并关闭通过（0.84 秒）。
- 真实 CodeBuddy 2.170.0 中国版原生登录后，经同一生产入口完成创建、指定文本回复、
  协作取消与关闭（8.06 秒），再次创建并关闭通过（0.84 秒）；官方网页和 CLI 均确认登录成功。
  Windows、真实双设备及原生文件工具／权限交互仍未验证。
- 本次续做：独立子入口后的适配器回归 4 文件、45 用例通过（0.56 秒）；Desktop typecheck、
  maker-core build、手动验收脚本独立 typecheck 与适配器 lint 通过。
- 原生进程中断验收：对临时新版 Cursor 的在途创建发送 SIGTERM，脚本返回 143，原生子进程
  和本次临时工作目录均无遗留。该结果只证明中断清理，不替代模型运行中的协作取消验收。
- 追加 Kiro 官方命令映射后，适配器、运行服务、host 与默认关闭回归 4 文件、46 用例通过
  （0.65 秒）；Desktop typecheck、手动验收脚本 typecheck 与改动文件 lint 通过。
  test-hygiene 通过（368 文件）。
- Kiro CLI 2.32.0 经官方 Google 设备授权确认原生登录成功后，真实创建、指定文本回复、
  协作取消与关闭通过（31.38 秒），新进程再次创建与关闭通过（2.38 秒），复用原生登录。
  此次只更新验收台账，未修改生产代码或应用开关；海外 CodeBuddy 因用户反馈账号受限而暂停，
  不计为海外版运行验收通过。
- 追加 Antigravity 官方 ACP 命令、Google 原生鉴权方法与 Linux 参数差异后，适配器、
  运行服务、host 与默认关闭回归 4 文件、48 用例通过（0.77 秒）；Desktop typecheck
  与改动文件 lint 通过。随后完成官方授权、真实创建和新进程复用登录；模型请求因官方地区
  限制被拒绝，回复与协作取消未计为验收通过。首次授权等待过短已用 35 秒虚拟延迟先红后绿
  复现并修复，另覆盖原有适配器超时及 Antigravity 最长等待后的进程回收。修复后 4 文件、
  50 用例通过（0.88 秒）；Desktop typecheck、手动 smoke 独立 typecheck 与适配器 lint
  通过。修改后的生产入口再次创建与关闭通过（4.32 秒），本次登录窗口、helper 与临时工作目录
  已回收；保留官方原生安装及登录，未启用 Cindy 实验开关。ACP 用例文件单独运行 19 项通过
  （Vitest 0.29 秒，命令墙钟约 1 秒），test-hygiene（368 文件）、文档门禁和 whitespace 检查通过。

- 第二批 6 个原生 ACP 定义与 Windows npm Node 入口已接；官方 CLI 已安装，详见覆盖清单 §6。
  保留 tool kind 和单次权限 kind，手动 smoke 新增 --tools，权限拒绝无法实测时返回非零退出。
  CodeBuddy 取消后意外 cancelled 先红后绿复现；适配器明确失败，不自动重建或重发。
- 本次最终分批复验：适配器/运行服务/host/默认关闭 4 文件、59 用例通过，界面 1 文件、
  3 用例通过。前 3 文件 0.47 秒、runtime 0.17 秒、界面 1.09 秒，各文件均在 5 秒预算内。
  Desktop typecheck、相关 main 文件 ESLint、手动 smoke 独立 typecheck 通过。
  独立脚本按仓库的 ESNext/Bundler/strict 模式检查；误用 NodeNext 时产生公共包导入与类型错误，
  更正检查选项后通过，没有为该命令改写公共包源码。
  文档门禁 10 项通过；git diff --check 与 29 个未跟踪文本文件的 whitespace 检查通过。
- 旧 providerRoute 与 runtime 定向回归 2 文件、101 用例通过（1.33 秒）；test-hygiene
  通过（368 文件）。第二批未修改旧供应商组/分享入口，沿用此前 664 用例回归证据。
- Cline 3.0.73：原生官方账号登录完成，--tools 全流程 23.05 秒通过，新进程再次创建/关闭
  1.44 秒通过。Kiro 2.32.0 --tools 复验 19.16 秒通过。
- Copilot 1.0.100：--tools 首次 25.41 秒通过，随后两次未执行文件工具，均以非零退出记录；
  独立多轮探针确认取消前后不同输入都准确回复，--send 再次通过（11.84 秒）。工具稳定性未计通过。
- Kimi Code 2.2.0：海外版设备登录成功，新进程创建通过；模型请求被官方 403 订阅要求拒绝，
  ACP 返回 -32000，Cindy 展示 needs-auth。未重复要求网页登录，未转用其他供应商。
- CodeBuddy 中国版后续复验首条回复 60 秒超时；既有文本通过记录保留，当前稳定性不能算全通过。
  CodeBuddy 海外版按用户要求继续暂停；Antigravity 的已知地区限制未重复尝试。

- Gemini CLI 0.64.0：用户所选 Google 账号完成官方页面登录确认后，官方拒绝该客户端的个人版使用；
  生产 smoke 复验发现通过，创建以 needs-auth 失败（3.32 秒）。未自动改用 Antigravity、其他账号
  或其他凭证来源；用户已选择暂记官方阻塞，真实回复、取消、工具与再次启动未验收通过。
- Qwen Code 0.25.3：已按用户选择在原生 CLI 中配置 Alibaba ModelStudio → Coding Plan →
  Singapore (International)，等待用户直接填写 Key。官方随包文档确认 Qwen OAuth 免费登录
  已于 2026-04-15 停用，故不再以过期 OAuth 路径反复登录。账号配置尚未完成，不计真实验收通过。
- 共享五语文案已补齐原生账号／模型配置和账号资格说明，覆盖新增 Agent 的不同认证前提；
  未改启动、权限、路由或默认关闭开关。
- 本轮文案收尾验证：Desktop host／页面 7 项、Mobile 原生资源入口 13 项、共享文案术语
  4 项通过。术语检查复用既有 shadowCatalogGlossary 输入集覆盖真实共享对象，补上根 JSON
  门禁的盲区；该文件单独运行 0.59 秒。maker-shared build、Desktop/Mobile typecheck、
  共享文案 lint、i18n 结构／术语门禁、test-hygiene 与 10 项文档门禁通过。
  i18n 既有空值／同文警告和 Mobile DOM 替身属性警告未计为产品故障。
- 更新后的 UI `--changed --theme all` 42/42 通过，Agent 页五语、Light/Dark、360×740
  50/50 通过；已目检修改的简介、空状态与认证失败提示，记录位于
  `artifacts/ui-check/changed-c64ors/` 与 `artifacts/ui-check/agent-adapters-0DYH7m/`。
  这些是隔离 renderer 场景，不代表 Mobile 实机、真实认证或双设备验收；ProvidersSection
  与完整 router 仍不在截图覆盖中。没有新增原生配置或改变 Mobile 指纹。

- 第三批 Factory Droid、Qoder CLI、Qoder CLI CN 已接入，共 14 个官方原生入口。
  三项真实未登录启动分别在 6.70／1.78／3.84 秒返回 needs-auth 并清理；不发模型请求，
  不要求用户补齐账号。官方命令与两版 Qoder 隔离用例先失败后通过；适配器及旧 providerRoute
  5 文件、147 用例通过（1.94 秒），Desktop typecheck 与改动文件 lint 通过。
  安装与平台边界详见覆盖清单 §7，真实模型回复／工具／运行中取消单独保留为未验收。

- 第四批 8 个入口接入后，注册表共 22 个，仍默认关闭。Devin、MiniMax、Grok、MothX
  的原生未登录错误稳定投影为 needs-auth；DSH、oh-my-pi、Hermes 的原生配置失败保留
  protocol-error，不猜测具体账号原因。Hermes 首次冷启动超时单独保留，后续握手通过。
  MiMo 未配置时空结束已转为明确错误；原生控制命令、工具输出与主动取消保持兼容。
- 本批适配器／运行服务／host／默认关闭与旧 providerRoute 5 文件、170 项通过（1.75 秒）；
  单文件 55 项通过（Vitest 0.49 秒，命令墙钟 1.40 秒）。Desktop typecheck、改动代码
  lint、test-hygiene（368 文件）、10 项文档门禁与 whitespace 检查通过。
  新命令与 MiMo 空结果／控制命令回归均先失败后通过；最终 MiMo
  生产探针创建通过，未配置普通请求返回 protocol-error（2.61 秒）并清理。
  本批没有更改旧供应商、跨端协议、UI 或用户 profile，没有把缺账号探针记成真实调用成功。

剩余验收：Kimi 在订阅权益可用后、Antigravity 在官方地区资格可用后补真实回复与取消；
Gemini 待可用官方认证方式、Goose/Qwen 待原生配置后补验；补齐 Copilot 工具稳定性、CodeBuddy 取消后续发、
Cursor/OpenCode 权限拒绝、真实两设备和 Windows；再扩展原生 profile、
历史恢复、SSH 与更多有官方接口的 Agent。上述事项完成前保持实验态与默认关闭。

## 第五批进度（2026-10-20）

- 本批新增 Prime、jcode、fx、Snow、Command Code、Ante、Reasonix、DevEco、Step Code、Muse Code，
  仍默认关闭。10 项均经真实官方 CLI 的发现、启动／握手和未登录或未配置失败路径检查；
  这些检查没有真实模型成功，不计入已通过账号验收。逐项版本、结果与官方链接见
  [覆盖台账 §9](agent-adapters-magpie-coverage.md#9-第五批8-个-acp-与-step-rpcmuse-msp)。
- 原生进程管理复用，新增协议通过统一工厂选择专用会话驱动。Step 等待 agent_settled，
  Muse 等待 turn/completed；两者都不把提交 ACK 当作完成。补齐审批双渠道去重、阶段失效、
  结束前后权限清理、旧回包隔离、关闭和取消后再次发送的代码验证。
- Prime/jcode 两个真实会话先后创建，关闭 A 后 B 仍可返回自己的原生未配置错误，证明未被
  一并关闭；这不等于已验证两个模型同时工作。Prime 不调用全局 shutdown，Muse/Prime 的
  EOF drain 都有界，旧 ACP 仍走原关闭行为。两者缺客户端权限回调的能力声明已明确。
- 新界面生成的 yes/no 通过共享资源表按查看端语言投影，五语单测通过；原生选项不改写。
  没有修改 renderer 布局、原生依赖或 Mobile fingerprint；本批未新增双模式实机目检。
- 无账号不阻塞本批代码接入。此批结束时待办包括 Crush、Mister Morph、OpenHanako、
  AtomCode；第六批已补 Crush，并确认 AtomCode 有可用的隐藏 ACP（修正此前认为只能用 daemon 的判断）。
  OmO 原生 help 自动迁移 Pi 状态后已暂停。
  其它桌面宿主尚待核实官方入口，详见[覆盖台账 §10](agent-adapters-magpie-coverage.md#10-剩余入口的具体缺口)。
  不能宣称 Magpie 63 项或整个发布计划完成。
- 最终分批定向覆盖 213 项（含旧 providerRoute 84 项），新增 Step/Muse 协议 22 项；
  最后两个受影响文件 33 项通过（0.80 秒）。Mobile 共享文案 4 项通过；Desktop typecheck、
  maker-shared build、smoke strict typecheck、代码 lint、i18n、test-hygiene、文档门禁与
  whitespace 检查通过。未执行真实模型成功、Windows、双设备和整仓发布回归；详细证据见覆盖台账。

## 第六批进度（2026-10-20）

- 新增 Crush 专用原生 HTTP/SSE 驱动、AtomCode 官方隐藏 ACP，注册表合计 34 个。仍默认
  关闭；Desktop/Mobile 通过已有实验资源入口使用，不改变旧供应商链路或账号登录。
- Crush 使用独占进程、私有 socket、独占临时 data_dir；已接收发、原生审批、取消与再次
  发送。实机验证修正了“先订阅事件再选择会话”的顺序；缺配置时初始化明确失败并清理。
- AtomCode 5.2.3 实机确认 acp 子命令、握手与创建；未配置模型请求返回 -32603，保持
  protocol-error，不把普通原生错误猜成账号未登录。没有账号不再要求登录。
- 8 文件、229 项通过，含旧 providerRoute 84 项；新增 Crush 14 项和 AtomCode 两个平台
  启动路径。Desktop/smoke 类型检查、代码 lint、test-hygiene 与 10 项文档门禁通过。
  真实模型成功、实际工具审批、Windows
  实机和跨设备未验；不因此宣告 Magpie 全清单或整个计划完成。
- Mister Morph 的 console 会启动已有配置中的 IM runtimes；OpenHanako 对同一原生 home
  互斥。两者仍需独立服务连接/授权与会话隔离流程，不能按普通 stdio CLI 接完即计数。
  其余原生入口缺口继续列在[覆盖台账 §10](agent-adapters-magpie-coverage.md#10-剩余入口的具体缺口)。

## 回归门槛

每个阶段完成后按影响面执行，不把“新增一个适配器”扩大成无依据的全仓重测：

| 影响范围 | 必跑回归 |
| --- | --- |
| P0 maker-core 契约 | pnpm --filter @cindy/maker-core build；新增路由单测 |
| main 适配器/IPC | 相关 main 单测、pnpm --filter desktop typecheck、凭证和 IPC 错误路径 |
| 旧 provider route 未改 | providerRoute.test.ts 及相关 provider route 定向测试 |
| provider group/share 或统一路由接线 | provider-group 全套 router/usage/guest/share 测试；remote-agent 连接、权限、用量、断线恢复测试 |
| Device Link / SSH | protocol-compatibility 对应测试、远程 roundtrip、重连/迟到事件/取消测试 |
| 凭证或登录边界 | credentials/auth 相关单测、敏感日志检查；不得用真实账号作为默认单测资源 |
| Mobile 目录或控制 | Mobile 定向测试和远程执行端回归；原生指纹不变时仍验证 JS 兼容 |
| 发布前 | pnpm test:unit:related，按影响追加 pnpm test:all，并记录未实测的平台 |

核心场景矩阵：

1. 不指定 Agent：旧 Cindy 任务仍选择原 provider route。
2. 指定本机 Agent：只在目标实例和匹配 Workspace 上运行。
3. 指定远程 Agent：文件、命令、事件和凭证边界都留在目标节点。
4. 目标离线、未登录、忙碌或不支持：给出稳定错误，不换订阅、不换 Agent。
5. 运行中断线、取消、重启和迟到事件：不重复执行、不恢复到错误节点。
6. 供应商组、供应商分享、额度耗尽和自动继续：旧行为保持原规则。
7. Agent 原生订阅与官方 API 账号：只能走各自的适配器边界。
8. 日志、IPC、device-link、Mobile 镜像中不出现 Token、Cookie 或完整授权文件。

## 发布和回滚

- 每个新适配器独立 feature flag 和独立版本能力声明。
- 新路由失败只影响选择了新 Agent 的任务；旧任务继续走旧入口。
- 发现凭证边界、远程权限、重复执行或旧供应商行为变化时，立即关闭该适配器开关，
  不回滚用户已有供应商配置和登录状态。
- 合并前必须 review 最终 diff；涉及协议、凭证、远程权限或 maker-core 行为时，PR 说明
  对应规则、验证命令、未验证的平台和剩余风险。
