# Magpie 产品覆盖对照与 Cindy 原生 Agent 接入清单

> 核验日期：2026-10-20。用户要求：Magpie 支持的产品，原则上全部纳入 Cindy 的覆盖目标。
> 本文记录覆盖范围与缺口，不代表这些产品均已接入或验收。实现与回归进度见
> [Agent Adapter 实现计划](agent-adapters-implementation-plan.md)。

## 1. 核验来源与统计口径

本次固定核验 `yetone/magpie` 的 main 提交
`75e769a9f9b419f805b925f147146eff179111b9`，不混用不同版本的清单：

- [README 的 Supported agents](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/README.md#supported-agents)：63 个产品条目。
- [源码 builtins](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/internal/agent/agents.go#L90)：63 个内置配置适配项，与 README 数量一致；另可派生 WSL、profile 和插件条目。
- [配置参考](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/docs/reference.md#agents)：逐项说明修改哪些配置、模型列表或导入入口。
- [订阅来源登记](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/internal/provider/provider.go#L1067)：`accountIDs` 登记 19 类账户来源，另有插件扩展；不等于 19 个独立 Agent。

这两种支持要分别核对：

1. **客户端接入模型网关**：Magpie 为客户端配置模型、endpoint、模型目录或导入链接。
2. **订阅作为模型来源**：Magpie 将部分产品的账号用于模型请求、账号池和路由，部分已交给插件。

它们都不能直接证明某产品已有可供 Cindy 编排的 Agent 执行接口。63 项里包含 Cindy 本身、
IDE、桌面应用、CLI 和其他 Agent 的界面；同一底层运行时不能重复计算为多个已验收 Agent。
这也不是 Magpie 所有社区插件的穷尽清单。

## 2. Cindy 的覆盖与验收口径

- 63 项全部保留在跟踪清单里；Cindy 自身记录为互操作，不创建递归的 Cindy 适配器。
- 订阅来源中的额外产品、用户单独要求的 Kiro 与“飞书工作”也保留，不因未列入 README 而漏掉。
- 优先使用官方 ACP、SDK/RPC、headless 流或官方桌面扩展接口；实际工作由该产品的原生 Agent 执行。
- 原生登录与凭证归原生 Agent；配置兼容或模型网关接通，不算原生执行验收通过。
- Magpie 中读取/刷新订阅凭证、以订阅直连模型端点的实现不移植；维持用户已确定的凭证边界。
- 同名不同产品/区域分别记录：WorkBuddy 桌面端不等于 CodeBuddy CLI，Cursor Private Inference
  不等于 Cursor CLI；国内外版本的登录与运行结果不能互相代替。
- 未核实官方执行接口时记“待核验”，不凭产品名猜命令，也不提前断言一定可接或永不支持。
- 每项至少验收发现、官方登录、原生回复、文件/命令工具、权限允许与拒绝、取消、关闭、再次启动；
  远程与手机控制在真实设备上验收。没有能力的项目须明确说明，不能以其他 Agent 代跑补足。
- 多 profile/多账号、跨重启恢复、SSH、自动安装分别验收，不能由一次本机文本回复推定支持。

## 3. 完整 63 项清单

“配置”描述 Magpie 当前连接客户端的方式；“待核验”表示 Cindy 尚未完成该产品官方原生执行
入口调查及实现。旧引擎已有支持不等于已迁入新的适配器目录，首批文本验收也不等于发布验收。

| # | Magpie 产品条目 | Magpie 的客户端接入范围 | Cindy 当前状态 / 下一步 |
| --- | --- | --- | --- |
| 1 | Claude Code | 模型、供应商与配置 | 旧原生引擎已有；复用旧链路，统一目录映射待做 |
| 2 | Claude Desktop | 第三方模型网关配置 | 待核验独立桌面 Agent 入口，不以 Claude Code 代替 |
| 3 | Claude Science | 带网关环境启动原生 daemon | 待核验官方执行接口 |
| 4 | Codex | 模型、供应商、推理档位配置 | 旧原生引擎已有；统一目录映射待做 |
| 5 | Gemini CLI | 登录类型与模型配置 | 官方 ACP 已接、已安装 0.64.0；握手通过，官方 Google 登录拒绝此客户端的个人版使用，待可用官方账号方式 |
| 6 | Antigravity CLI | 模型配置及带网关环境的启动命令 | 官方 ACP 已接；登录/启动通过，模型受地区限制 |
| 7 | OpenCode | 模型与供应商配置 | 官方 ACP 已接；本机文本/取消/再次启动通过 |
| 8 | OpenChamber | 自身默认模型与 OpenCode 配置 | 待核验；区分界面与底层 OpenCode |
| 9 | MiMo Code | 模型与供应商配置 | 官方 ACP 已接、0.1.15 已安装；未配置时原生空结束已由 Cindy 明确报错，真实模型调用未验 |
| 10 | DevEco Code | 模型与供应商配置 | 官方 ACP 已接、0.2.4 已安装；创建通过，未配置首条请求污染 stdout 后被关闭，错误已验证，真实调用未验 |
| 11 | Pi | 模型与供应商配置 | 旧原生引擎已有；统一目录映射待做 |
| 12 | oh-my-pi | 模型配置及 profiles | 独立官方 ACP 已接、18.12.3 已安装；创建通过，未配置首条请求明确失败，真实调用未验 |
| 13 | StepCode | 模型配置 | 官方 JSONL RPC 已接、0.1.5 已安装；创建通过，未登录首条请求明确失败，真实调用未验 |
| 14 | MothX | 模型与思考档位配置 | 官方 ACP 已接、1.3.105-pre-3 已安装；采用原生 agent 权限模式，未登录创建返回 needs-auth，真实调用未验 |
| 15 | Aside | 首个账户的模型与角色配置 | 待核验官方原生协议及多 profile 边界 |
| 16 | OmO | 模型配置 | 已安装官方 5.1.40；原生启动自动复制旧 Pi 状态，暂停接线，详见 §10 |
| 17 | Prime Agent | 模型与思考档位配置 | 官方 ACP 已接、0.10.0 已安装；未配置请求明确失败，双会话关闭隔离通过；无客户端权限回调 |
| 18 | Goose | 模型与供应商配置 | 官方 ACP 已接、已安装 1.55.0；真实握手通过，待原生 provider 配置 |
| 19 | Cursor CLI | 模型配置 | 官方 ACP 已接；本机文本/取消/再次启动通过 |
| 20 | Cursor Private Inference | 模型 endpoint 环境 | 待核验独立产品模式，不以 Cursor CLI 代替 |
| 21 | Zed | 自定义模型供应商与模型目录 | 待核验 Zed 自身 Agent 的执行接口 |
| 22 | VS Code Chat | Chat 自定义 endpoint 与模型目录 | 待核验 Chat/扩展执行接口 |
| 23 | VS Code Insiders | 同上，独立配置目录 | 单独核验，不能用稳定版结果代替 |
| 24 | VSCodium Chat | Chat 功能及自定义模型配置 | 待核验 Chat/扩展能力与账号条件 |
| 25 | JetBrains Air | 在 Air 中添加使用网关的 OpenCode ACP | 待核验 Air 自身能力，不重复计算 OpenCode |
| 26 | Copilot (JetBrains) | Copilot BYOK 模型目录 | 待核验 IDE 扩展执行接口；不等于 Copilot CLI |
| 27 | Copilot CLI | 模型配置 | 官方 ACP 已接；1.0.100 文本、多轮续发与取消通过；工具完整通过一次，后续复验未执行文件操作，稳定性待补验 |
| 28 | Crush | 大/小模型配置 | 官方 0.98.1 HTTP/SSE 已接；独占原生服务、会话、审批和取消代码通过；实机未配置的 agent/init 返回 500，真实模型调用未验 |
| 29 | DeepSeek Harness | 模型、推理档位与供应商配置 | 官方 ACP profile 已接、0.2.1-rc.2 已安装；创建通过，未配置首条请求明确失败，真实调用未验 |
| 30 | Reasonix Studio | Executor/Plan 模型配置 | 官方 Reasonix CLI ACP 已接、2.46.0 已安装；未登录创建 needs-auth；Studio 图形宿主另记 |
| 31 | Command Code | 模型与供应商配置 | 官方 ACP 已接、1.84.0 已安装；未登录创建 needs-auth，真实调用未验 |
| 32 | fx | 模型与供应商配置 | 官方 ACP 已接、0.0.14 已安装；原生非标准认证错误精确映射 needs-auth，真实调用未验 |
| 33 | Devin | 模型配置 | 官方本机 CLI ACP 已接、3000.11.92 已安装；创建通过，未登录首条请求返回 needs-auth，真实调用未验；云端接口未接 |
| 34 | Hermes Agent | 模型与 profile 配置 | 官方 ACP 已接、0.19.0 已安装；依赖检查通过，未配置创建明确失败；首轮冷启动超时另记，真实调用未验 |
| 35 | Mister Morph | 模型与推理档位配置 | 官方 Runtime REST API 已核验，含任务停止与审批；需专用服务连接与授权适配，未接线 |
| 36 | Kimi Code | 模型与供应商配置 | 已接官方新版 Kimi Code 2.2.0 ACP；海外版官方登录、创建与再次启动通过，模型请求被官方 403 订阅套餐要求拒绝 |
| 37 | jcode | 模型与供应商配置 | 官方 ACP 已接、0.99.0 已安装；未登录请求 needs-auth，双会话关闭隔离通过；无客户端权限回调 |
| 38 | Qwen Code | 模型与供应商配置 | 官方 ACP 已接、已安装 0.25.3；握手通过，原生终端已选国际版 Coding Plan，待用户直接填写 Key 完成配置 |
| 39 | Muse Code | 模型 endpoint 配置 | 官方 MSP 已接、1.4.11-R6667.1 已安装；创建通过，未登录原生 failed 正确报错，真实调用未验 |
| 40 | Empryo | 默认模型与供应商配置 | 官方 soulforge headless NDJSON 已核验，但自动批准工具且无交互审批；未接线 |
| 41 | MiniMax Code | 自定义模型供应商配置 | 官方 ACP 已接、0.6.12 已安装；未登录创建返回 needs-auth，真实模型调用未验 |
| 42 | Droid | Factory BYOK 模型目录 | 官方 ACP daemon 已接线，安装 0.245.0；真实未登录启动返回 needs-auth，模型调用未验 |
| 43 | Cline | CLI 的兼容供应商与模型配置 | 官方 ACP 已接、已安装 3.0.73；官方账号登录、回复、取消、文件/命令、允许/拒绝与再次启动通过 |
| 44 | Qoder | CLI 自定义模型，需对应 BYOK 权益 | 官方 ACP 已接线，安装 1.1.75；真实未登录启动返回 needs-auth，模型调用未验 |
| 45 | Qoder CN | 中国大陆版独立配置与账号 | 独立官方 ACP 已接线，安装 1.1.74；真实未登录启动返回 needs-auth，模型调用未验 |
| 46 | Grok Build | 模型与推理档位配置 | 官方 ACP 已接、1.0.64 已安装；未登录创建返回 needs-auth，真实模型调用未验 |
| 47 | Grok App | 自定义模型供应商与模型目录 | 待核验桌面 Agent 入口，不以 Grok Build 代替 |
| 48 | ZCode | 自定义模型目录 | 待核验官方原生协议 |
| 49 | WorkBuddy | 桌面端自定义模型目录 | 已核验公开助理文档：支持 IM 遥控，尚未找到公开 ACP/SDK 执行入口，未接线 |
| 50 | WorkBuddy AI | 国际版独立自定义模型目录 | 已核验国际版助理文档：支持 IM 遥控，尚未找到公开 ACP/SDK 执行入口，未接线 |
| 51 | CodeBuddy Code | CLI 的模型目录与会话模型 | 官方 ACP 已接；中国版基础验收通过，海外账号受限暂停 |
| 52 | Pencil | 自定义模型目录 | 待核验设计工具/原生 Agent 官方入口 |
| 53 | OpenPencil | 自定义 builtin_agents 模型目录 | 官方 op CLI/HTTP MCP 已核验，为画布工具控制；尚未核实内置 Agent 的执行入口，未接线 |
| 54 | Raycast | AI Custom Providers | 待核验官方自动化/Agent 接口及权益 |
| 55 | T3 Code | 基于 Claude Code 的供应商实例 | 待核验界面/运行时边界，不重复计算 Claude Code |
| 56 | OpenHanako | 主要 Agent 默认模型与供应商目录 | 官方 Server-first CLI/HTTP/WebSocket 已核验；需独立会话与服务授权适配，未接线 |
| 57 | AtomCode | 模型与供应商账户配置 | 官方 5.2.3 隐藏 ACP 已接；实机握手/创建通过，未配置首条请求 -32603 → protocol-error，真实模型调用未验 |
| 58 | Snow CLI | 模型 profile 配置 | 官方 ACP 已接、0.9.11 已安装；未配置首条请求明确失败，真实调用未验 |
| 59 | Alma | 本地 API 配置默认模型与供应商 | Magpie 仅配置本地 provider API；官方执行接口尚未核实，未接线 |
| 60 | Cindy | 供应商导入链接 | 自身互操作；保留旧供应商入口，不创建自调用适配器 |
| 61 | Lody | 供应商导入链接与原生确认 | 待核验官方执行入口；导入兼容不算 Agent 接入 |
| 62 | Ante | 模型与供应商目录 | 官方 ACP 已接、Ante 0.2.13 + ante-acp 0.2.0 已安装；未配置首条请求明确失败，真实调用未验 |
| 63 | AstrBot | 模型与 provider 配置 | 待核验官方 Agent/插件执行接口 |

## 4. 订阅来源另行覆盖

Magpie 源码登记的 19 类账户来源为：Antigravity、Claude、Codex/ChatGPT、Command Code Plan、
GitHub Copilot、Cursor、Devin、Factory/Droid、Gemini Code Assist、Grok、Kiro、MiMo App、
ChatGPT API、Qoder、Qoder CN、WorkBuddy、WorkBuddy AI、ZCode、Zed。

这里的名称沿用 Magpie；MiMo App 不等于 MiMo Code，ChatGPT API 也不是一个独立 Agent。
内置登记、迁移后插件与任意社区插件分别记录，不能把旧代码仍在仓库等同于仍由旧代码执行。

- Kiro 已经通过 Cindy 的官方 CLI/ACP 本机基础验收，继续保留在范围内。
- WorkBuddy/WorkBuddy AI 的模型来源已由 `@magpie-community/opencode-workbuddy-auth` 承担，
  Kiro 也有对应插件迁移路径；Cindy 不照搬这些插件的消费订阅凭证处理。
- MiMo App、ChatGPT API 等没有对应已核验 Agent 入口的来源，继续调查官方可用方式；
  不能为了覆盖来源名称而伪造 Agent Adapter 或改写旧 API 供应商凭证边界。

依据：[订阅参考](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/docs/reference.md#signed-in-agents-as-providers)、
[WorkBuddy 来源](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/internal/provider/workbuddy.go)、
[Kiro 来源](https://github.com/yetone/magpie/blob/75e769a9f9b419f805b925f147146eff179111b9/internal/provider/kiro.go)。

## 5. 对下一步实施的影响

1. 将本表作为扩展基线，继续核验 WorkBuddy 两个桌面版本的官方执行接口；补齐权限、
   Copilot 工具稳定性、CodeBuddy 取消后续发和真实双设备验收。
2. 第二批六个官方 ACP 入口已接线，Cline 已完成本机验收；Gemini 待可用官方账号方式，
   Goose、Qwen 待原生配置，Kimi 待订阅权益可用后补验。第三批已接 Droid、Qoder 两版；第四批见 §8。
3. 其余 63 项中的产品都保留逐项记录；只支持模型配置的产品先核验真正的执行接口。
   同一协议复用传输层，各产品分别声明能力；不用未经核验的启动命令批量填满注册表。
4. 每次扩展维持默认关闭和旧链路隔离。每项明确记录：官方依据、安装/登录方式、运行位置、
   可观察能力、单测/实机结果、剩余限制；不能用清单条数替代完成真实工作的验收。

后续追上新的 Magpie 提交时更新快照和差异；每次变化都重新核验接入语义，不自动安装或启用
新产品。本文的 63/19 是此次源码快照，不是“所有 Agent 永久可用”的承诺。

2026-10-20 用户调整推进条件：部分产品没有账号，代码接入验证通过后即可继续下一批。
账号／套餐／地区限制不阻塞其他产品实现；真实模型回复、工具执行和取消仍单独记账，
不能用协议模拟或握手代替。继续保持默认关闭、原生账号边界与旧链路隔离。

## 6. 2026-10-20 第二批实现与实机核验

新增 6 个原生适配器，注册表合计 11 个，均由已有默认关闭开关控制。Cindy 没有写入启用值，
没有启动/替换宿主应用，也没有修改旧供应商路由。安装是本次用户授权的人工验收操作，
不代表产品内已经提供自动安装。

| 原生产品 | 经核验的执行命令 | 官方依据 | 本轮结果 |
| --- | --- | --- | --- |
| Gemini CLI 0.64.0 | gemini --acp | [官方注册表](https://github.com/agentclientprotocol/registry/blob/main/gemini/agent.json)及安装版 --help | ACP v1 握手通过；用户所选 Google 账号在官方登录中被以该客户端不再支持个人版拒绝，生产入口复验创建返回 needs-auth（3.32 秒）；回复、取消、工具和再次启动尚未验收通过 |
| Copilot CLI 1.0.100 | copilot --acp | [官方注册表](https://github.com/agentclientprotocol/registry/blob/main/github-copilot-cli/agent.json)及安装版 --help | 原生已有登录；完整工具验收首次通过（25.41 秒），后续两次工具阶段未执行文件操作；独立多轮/取消后续发与基础 smoke 再次通过，工具稳定性尚未通过 |
| Goose 1.55.0 | goose acp | [官方源码](https://github.com/block/goose/blob/main/crates/goose-cli/src/cli.rs)、[注册表](https://github.com/agentclientprotocol/registry/blob/main/goose/agent.json) | SHA-256 校验后安装；握手通过，原生创建报 provider 未配置（-32603）；Cindy 仅暴露 protocol-error，未转发原始诊断 |
| Kimi Code 2.2.0 | kimi acp | [新版官方文档](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)、[README](https://github.com/MoonshotAI/kimi-code) | 官方安装器 SHA-256 校验；global 原生设备登录已确认成功，随后新进程创建通过；模型请求原生返回 403 / subscription / upgrade plan，经 ACP -32000 投影为 needs-auth，回复、工具与取消未验收通过 |
| Qwen Code 0.25.3 | qwen --acp | [官方注册表](https://github.com/agentclientprotocol/registry/blob/main/qwen-code/agent.json)、安装版 --help 及随包 auth.md | 握手通过，ACP 鉴权方法 ID 为 openai（不代表只能用 OpenAI 服务）；用户选阿里云国际版 Coding Plan，原生终端停在 Key 填写步骤；真实回复、取消、工具和再次启动待配置后验收 |
| Cline 3.0.73 | cline --acp | [官方 CLI 文档](https://github.com/cline/cline/blob/main/apps/cli/README.md)及安装版 --help | 官方账号设备授权成功；回复、协作取消、拒绝写入、单次允许读写、命令与关闭通过（23.05 秒），独立新进程创建/关闭通过（1.44 秒） |

Kimi 的旧 Python 项目已归档；ACP 注册表当时仍指向旧 1.52.0，故以维护中的官方新版为准，
没有安装旧版或迁移任何凭证。npm 的四项安装先因本机 Node 25 与依赖 engines 不兼容而失败，
改用已安装的 Node 22.22.3 完成安装和实机验收，未更改用户默认 Node。npm 程序安装在
`~/.local`，Kimi 在官方 `~/.kimi-code/bin`，Goose 在 `~/.local/bin`；仓库依赖未改变。

Windows 的 npm 安装由宿主查找 `node.exe`，将经核验的厂商 Node 入口作为独立 argv 调用，
不执行 `.cmd`/`.bat`，不使用 Electron 充当 Node。覆盖带空格/`&` 的路径、缺 Node 时不可发现、
环境中的密钥和 Node 注入变量不跨边界；Windows 实机仍待验收。

WorkBuddy 两版公开文档分别确认了
[中国版 IM 助理](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Assistant)与
[国际版 IM 助理](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Assistant)。
这些入口需要绑定对应的 IM 平台，尚不能当成可创建任意工作区、多任务的通用 ACP/SDK。
未找到公开接口不代表永久不可接；后续继续核验官方扩展/自动化方案，当前未注册虚假的 WorkBuddy 适配器。

工具与权限新增验收：Kiro（复验 19.16 秒）、Cline 的拒绝写入（文件未生成）、单次允许、随机内容读取/复制
与原生命令均通过。Copilot 曾完整通过，但后续两次未发起文件审批且未创建目标文件；独立探针确认发送给
原生进程的各轮输入不同，取消前后新文本均能准确回复，故不能将工具失败定性为取消后的通道失效，工具稳定性
继续记未通过。Cursor、OpenCode 的实际文件与命令通过，但当前原生配置未对工作区写入发起审批，拒绝项记未验证，
对应 smoke 保持非零退出；不改其全局权限配置。CodeBuddy 2.170.0 在取消后连续新消息返回 cancelled 且无文本，
已复现；适配器将非用户取消明确报告为 unexpected-cancellation 并沿原失败路径回收，不能将其标为正常完成。
CodeBuddy 后续复验另出现首条回复 60 秒超时，未放宽验收超时或将其算通过。

Cline 旧设备码过期后重新生成，按用户授权在本机官方页面核对新码并点击确认，网页与原生 CLI 均确认成功；
没有读取登录库、复制 Cookie 或提取 token。Kimi 不需要再次网页登录，剩余阻塞为官方模型请求要求可用的订阅
套餐；未改区域或凭证来源。这些结果均不替代 Windows、真实双设备或全量发布验收。

### Gemini / Qwen 原生配置补验

- Gemini CLI 0.64.0：按用户选择在官方 Google 页面完成账号选择和登录确认，原生界面返回
  “This client is no longer supported for Gemini Code Assist for individuals”。Google 提示迁移
  Antigravity；本次没有自动迁移或借用其他 Agent 的凭证。原生登录界面正常退出不代表认证成功，
  随后的生产 smoke 仍以 `needs-auth` 非零退出。用户已选择暂记官方阻塞，未继续改用其他认证方式。
- Qwen Code 0.25.3：安装包官方文档 `bundled/qc-helper/docs/configuration/auth.md` 明确
  Qwen OAuth 免费登录已于 2026-04-15 停用，当前使用 TUI `/auth` 配置；旧 help 保留
  `qwen-oauth` 参数不等于可继续登录。按用户明确选择，原生界面已进入 Alibaba ModelStudio
  → Coding Plan → Singapore (International)，等待用户直接填写官方 Coding Plan Key。
  不读取该输入框或凭证文件，不把 Key 交给 Cindy；当前没有真实运行通过的结论。
- 两项均沿用原生 CLI 既有认证选择，不强制调用 `authenticate` 切换方法。Gemini 官方认证
  切换可能清理原缓存凭证，适配器不能为了重试擅自执行。
- 共享的五语简介、空状态和认证失败提示已补齐账号／模型配置与账号资格说明，避免将上述
  官方限制一概引导为重复登录；Desktop 与 Mobile 使用同一份文案，实验开关仍默认关闭。
  相关 24 项测试、共享包／Desktop／Mobile 类型检查和语言门禁通过，Agent 页五语双主题
  窄屏 50/50 场景通过并目检修改状态。代码与界面检查不替代两项尚未完成的原生运行验收。

## 7. 第三批：代码接入与账号验收分开推进

新增 Factory Droid、Qoder CLI、Qoder CLI CN，共 14 个原生适配器。仍由同一默认关闭开关
控制，只有执行电脑安装对应官方 CLI 才进入目录；沿用原生登录，没有新增凭证读取或导入。

| Agent | 官方执行入口 | macOS 原生检查 | 真实模型调用 |
| --- | --- | --- | --- |
| Factory Droid 0.245.0 | droid exec --output-format acp-daemon | 发现通过；创建返回 needs-auth，6.70 秒后回收退出 | 无账号，未验收 |
| Qoder CLI 1.1.75 | qodercli --acp（同时识别 qoder） | 发现通过；创建返回 needs-auth，1.78 秒后回收退出 | 无账号，未验收 |
| Qoder CLI CN 1.1.74 | qoderclicn --acp（同时识别 qodercn） | 发现通过；创建返回 needs-auth，3.84 秒后回收退出 | 无账号，未验收 |

官方依据：[Droid ACP 注册表](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/agent.json)、
[Factory 原生 CLI](https://docs.factory.com/droid-cli/cli-reference.md)、
[Qoder ACP](https://docs.qoder.com/cli/acp.md)、[Qoder 安装](https://docs.qoder.com/cli/installation.md)、
[Qoder CLI CN ACP](https://docs.qoder.cn/cli/acp.md)、
[Qoder CLI CN 安装](https://docs.qoder.cn/cli/installation.md)。

- Qoder 两版由官方安装器核验 SHA-256 后安装，执行入口分别为 ~/.local/bin/qodercli 与
  ~/.local/bin/qoderclicn；用户使用的 qoder/qodercn 可能是 shell function，Cindy 直接执行
  原生文件，不运行 shell function、不在两个版本间回退。安装器维护各自原生目录及 shell 入口。
- Droid 使用官方安装器指向的原生二进制与 SHA-256 摘要，校验后独占创建新的执行入口；
  没有执行安装器中的全局 pkill，也没有替换已有程序或更改仓库依赖。
- Windows 继续支持原生 .exe；Qoder 两版兼容官方 npm Node 入口，并分别使用
  @qoder-ai/qodercli/bundle/qodercli.js 与 @qodercn-ai/qoderclicn/bundle/qoderclicn.js。
  Droid 的 npm shim 安装后可能被优化为原生文件，因此没有将它当成固定 Node 脚本强行执行；
  当前 Windows 使用官方原生 .exe，Windows 实机仍未验收。
- Qoder 官方 npm 1.1.74 的 ACP 实现在客户端未宣告文件能力时保留原生文件实现；Cindy
  继续不宣告尚未实现的 fs/terminal 能力、不强制权限绕过模式。此源码核验不代替工具实测。
- 生产发现／启动入口的三个命令映射及 Qoder 版本隔离用例先失败后通过。当前适配器文件
  32 项、全体适配器与旧 providerRoute 合计 147 项回归通过（1.94 秒）；单文件独立运行
  0.35 秒。Desktop typecheck、改动文件 lint、test-hygiene 和 10 项文档门禁通过；
  三次原生探针结束后未发现遗留进程。模拟取消、权限与回收沿用公共 ACP
  和运行服务的回归；三项真实模型回复、工具执行与运行中取消仍明确记为未验。

## 8. 第四批：8 个官方原生入口与无账号检查

2026-10-20 新增 Devin、MiniMax Code、Grok Build、MiMo Code、oh-my-pi、MothX、DeepSeek
Harness、Hermes Agent，注册表共 **22 个**。沿用既有默认关闭开关和本机／Device Link
资源入口；没有启用实验开关、改变旧供应商配置或提取订阅凭证。缺账号不阻塞其他接入。

| Agent / 安装版 | 经核验的原生命令 | 本机未配置检查 | 真实模型调用 |
| --- | --- | --- | --- |
| Devin 3000.11.92 | devin acp | 发现、创建、关闭通过（3.29 秒）；首条请求 needs-auth，0.11 秒回收 | 未验收 |
| MiniMax Code 0.6.12 | mcode acp | 创建 needs-auth，2.23 秒回收 | 未验收 |
| Grok Build 1.0.64 | grok agent stdio | 创建 needs-auth，4.46 秒回收 | 未验收 |
| MiMo Code 0.1.15 | mimo acp | 创建通过；原生首条请求无文本／工具事件却返回 end_turn；专属空结果检查后返回 protocol-error，2.14 秒回收 | 未验收；不能将空结束算成功 |
| oh-my-pi 18.12.3 | omp acp | 创建、关闭通过（首次 13.45 秒）；未配置首条请求 protocol-error，0.42 秒回收 | 未验收，不继承旧 Pi 结论 |
| MothX 1.3.105-pre-3 | mothx acp --mode agent | 创建 needs-auth，1.72 秒回收 | 未验收 |
| DeepSeek Harness 0.2.1-rc.2 | dsh --profile acp | 创建、关闭通过（2.83 秒）；未配置首条请求 protocol-error，0.83 秒回收 | 未验收 |
| Hermes Agent 0.19.0 | hermes acp | 原生 --check 通过；首次冷启动 30 秒超时；随后握手通过、创建返回原生 -32603，经 Cindy 投影 protocol-error，6.34 秒回收 | 未验收；冷启动稳定性待补验 |

这些是缺原生账号／模型配置的检查，不是 8 个真实模型成功记录。部分原生 CLI 使用
-32603 表达配置失败，Cindy 保留 protocol-error，不将所有内部错误猜成未登录，也不
展示原始诊断或自动切换账号。假进程协议测试与真实原生探针分别记账。

官方执行与安装依据：

- [Devin ACP](https://docs.devin.ai/cli/acp.md)、[官方 npm 安装说明](https://github.com/CognitionAI/devin-cli)。
- [MiniMax ACP 注册表](https://github.com/agentclientprotocol/registry/blob/main/minimax-code/agent.json)、官方 npm 包 @minimax-ai/code 的 bin/engines。
- [Grok ACP 注册表](https://github.com/agentclientprotocol/registry/blob/main/grok-build/agent.json)、官方 @xai-official/grok 1.0.64 启动器源码。
- [MiMo ACP 实现](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/cli/src/cli/cmd/acp.ts)、[官方安装](https://mimo.xiaomi.com/install)。
- [oh-my-pi ACP](https://github.com/can1357/oh-my-pi#four-entry-points-interactive-one-shot-rpc-and-acp)、[18.12.3 官方发布与摘要](https://github.com/can1357/oh-my-pi/releases/tag/v18.12.3)。
- [MothX ACP](https://github.com/oschina/mothx/blob/master/docs/en/acp.md)、[官方安装器](https://github.com/oschina/mothx/blob/master/install.sh)。
- [DeepSeek Harness ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、官方 @deepseek-ai/dsh 的 CLI profile 入口。
- [Hermes ACP 入口](https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/entry.py)、[官方 Python 包声明](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml)。

安装和兼容边界：

- npm 程序安装在 ~/.local；MiMo 使用官方原生安装器的 --no-modify-path，位于
  ~/.mimocode/bin；oh-my-pi 使用官方 GitHub 二进制与 SHA-256 摘要，独占创建 ~/.local/bin/omp。
  Hermes 使用 uv tool 的独立 Python 3.13 环境安装官方 hermes-agent[acp]==0.19.0。
  没有更改仓库依赖、默认 Node、Cindy profile 或用户登录文件，没有要求新账号。
- MothX 与 DSH 的官方 npm latest 分别为 pre/rc 版，版本已明确记录。
  MothX 默认 ACP 模式为 yolo；Cindy 显式使用官方 agent 模式以保留原生权限请求，不改全局配置。
- Windows 的六个新增 npm 入口通过独立 node.exe 启动并经模拟平台路径测试。Grok 的
  bin/grok 可被安装器替换为原生文件，因此使用仍为 JavaScript 的 grok-bootstrap.js。
  oh-my-pi 的 npm 包需要 Bun，Windows 使用官方原生 .exe，不将 Bun 入口交给 Node。
  Hermes 支持 PATH 上的 Python console-script .exe。Windows 实机尚未验收。
- MiMo 的空结束问题可从 0.1.15 ACP prompt 实现复现：内层失败未转为协议异常。
  rejectEmptyTurn 只对 MiMo 的普通模型输入启用；文本／工具事件与主动取消可正常结束。
  原生 slash command（如 /compact）允许无输出结束，避免把控制命令误判为模型失败。
  回归覆盖上一轮有回复而下一轮无输出、控制命令、其他适配器原行为；不猜账号原因、不重发请求。
- 通用回归覆盖 -32000/-32603 在创建与首条请求阶段的错误、诊断隔离、清理后再次启动；
  新命令与 MiMo 空结果回归均先失败后通过。真实回复、文件／命令、权限与运行中取消
  尚未验收，不能由无账号检查推定。

本批最终定向回归：适配器、运行服务、host、默认关闭与旧 providerRoute 共 5 文件、
170 项通过（1.75 秒）；codebuddy.test.ts 单文件 55 项通过（Vitest 0.49 秒，
命令墙钟 1.40 秒）。Desktop typecheck、改动代码 ESLint、test-hygiene（368 文件）
和 10 项文档门禁通过；已复核本批 diff、已跟踪及本批未跟踪文件的 whitespace。
MiMo 控制命令兼容用例先失败后通过；修复后真实生产入口复验创建通过，未配置的普通
模型请求在 2.61 秒内返回 protocol-error 并清理，仍不计为真实模型调用通过。
本批探针已退出，未发现上述原生进程遗留；本批唯一临时诊断目录已清理，保留官方安装。

第四批结束时的待办（Prime/jcode/Muse 已由第五批接入，见 §9）：已核实 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/crates/pa-cli/src/print_runtime.rs)
的 --mode acp 会启动／复用独立 supervisor，只有 --no-session 才使用客户端所属会话；
需验证关闭只结束本次工作而保留其他会话，尚未直接套用本批进程适配器。
[Crush](https://github.com/charmbracelet/crush/tree/main/internal/cmd) 的 run/server/session、
[jcode SDK](https://github.com/1jehuang/jcode/tree/main/sdk/typescript) 与
[Muse SDK](https://github.com/meta-models/muse-code-sdk) 是后续需分别核验的执行合同，不能
仅靠注册一个猜测的 ACP 命令计入支持。其他未核实条目保留原状态，不因本批完成而标记全部覆盖。

## 9. 第五批：8 个 ACP 与 Step RPC、Muse MSP

2026-10-20 新增 **10 个**适配器，注册表从 22 增至 **32 个**。这是原生执行入口数量，
不是 Magpie 63 个产品全部完成，也不是 32 个账号真实调用全部通过。实验开关保持默认关闭；
没有修改真实 Cindy profile、旧供应商路由、Device Link wire 或仓库依赖。

| Agent / 官方安装版 | Cindy 启动命令 | 本轮原生未配置检查 | 真实模型验收 |
| --- | --- | --- | --- |
| Prime Agent 0.10.0 | prime-agent --mode acp --no-session | 创建通过；首条请求 -32603 → protocol-error；关闭 A 后 B 仍返回原生配置错误，未被关闭 | 未验 |
| jcode 0.99.0 | jcode acp | 创建通过；首条请求 needs-auth；关闭 A 后 B 仍返回 needs-auth，未被关闭 | 未验 |
| fx 0.0.14 | fx acp | initialize 的 -32600 缺登录文案，精确映射 needs-auth；复验 0.16 秒 | 未验 |
| Snow CLI 0.9.11 | snow --acp | 创建通过；未配置请求 -32603 → protocol-error | 未验 |
| Command Code 1.84.0 | command-code acp | 创建 needs-auth，0.58 秒 | 未验 |
| Ante 0.2.13 / ante-acp 0.2.0 | ante acp | 创建通过；首条请求 protocol-error，18.14 秒 | 未验 |
| Reasonix 2.46.0 | reasonix acp | 创建 needs-auth，0.06 秒；CLI 不等同 Studio 图形宿主验收 | 未验 |
| DevEco Code 0.2.4 | deveco acp | 创建通过；未配置请求输出非 JSON 到 ACP stdout，Cindy 关闭受污染连接并报 closed；随后原生还曾输出 -32603，不转发诊断 | 未验；上游输出流问题未修复 |
| Step Code 0.1.5 | step --mode rpc --no-session | 官方 JSONL RPC 创建通过（0.92 秒）；未登录 prompt 的 success:false → protocol-error | 未验 |
| Muse Code 1.4.11-R6667.1 | muse serve | 官方 MSP 创建通过（0.23 秒）；未登录 turn/completed terminal:failed → protocol-error；诊断分类命中 auth/login/key | 未验 |

### 执行合同与边界

- 新统一工厂按 ACP、Step JSONL RPC、Muse MSP 选择会话驱动。发现、环境过滤、进程归属与
  关闭继续共用生产基础设施；旧 CodeBuddy/ACP 入口保留兼容。Desktop host 与手动 smoke
  都调用同一工厂，没有给某个 Agent 另建模型请求或账号池。
- Step 的 prompt ACK、agent_end 都不代表最终完成，必须等 agent_settled；重试中间错误
  不提前结束。confirm/select 通过已有权限表单回答，生成的“是/否”由查看端五语资源投影；
  原生选项标签原样保留。input/editor 尚未支持，明确拒绝并关闭，不让用户等待隐藏问题。
- Muse 发送协议要求的 UUIDv7 commandId，等待 turn/completed，区分 completed/failed/cancelled；
  仅接受本会话、本轮 item。流式 delta 与最终完整快照去重。approval/requested 和
  approval/request 只产生一个请求，后者仍回空 ACK；选择走 approval/decide 并携带当前
  requirementId。approval/updated 没有 turnId，仅可按已知本轮 approvalId 归属；旧阶段答复失效。
  自由文本 userInput 暂未接通，明确失败，不静默等待。未宣告额外实验能力或 userShell。
- Prime 采用 --no-session 的客户端所属工作，关闭先给 stdin EOF 最多 2 秒，再回收自己进程组；
  不调用 shutdown，不停止共享 daemon。Muse 也采用有界 EOF drain；其他原生入口保持原关闭行为。
  Prime、jcode 没有客户端权限回调，能力声明不宣称 permissions。
- fx 仅按官方 0.0.14 的完整固定错误文案 + -32600 映射 needs-auth；其它产品、code 或文案
  不受影响。一般 -32603、MSP -32000、未配置失败保持 protocol-error，不猜账号原因。
- Step 仅在官方 ~/.stepcode/bin 发现，防止误执行同名 Smallstep 证书工具。手动 smoke 的
  显式绝对 executable 可以覆盖发现位置，产品 UI/远程请求不接受任意启动命令。
- Windows 的 Snow、Command Code、DevEco npm 入口通过独立 node.exe 启动；DevEco postinstall
  复制的是 bin/deveco.exe，bin/deveco 仍为官方 JS launcher。没有使用系统 cmd 名称、shell
  或 Electron 作为 Node。Windows 与真实跨设备尚未验收。

### 官方依据与安装

- [Prime ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/crates/pa-cli/src/print_runtime.rs)、
  [jcode ACP](https://github.com/1jehuang/jcode/blob/master/src/cli/acp.rs)、[fx ACP](https://fx.sh/docs/using-fx/acp)。
- [Snow ACP](https://github.com/MayDay-wpf/snow-cli/blob/main/source/utils/acp/acpManager.ts)、
  [Command Code ACP](https://commandcode.ai/docs/acp)、[Ante ACP](https://github.com/AntigmaLabs/ante/blob/main/ante-acp/README.md)。
- [Reasonix ACP](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/docs/ACP.md)、
  [DevEco ACP](https://gitcode.com/openharmony-sig/deveco-code/blob/develop/packages/opencode/src/cli/cmd/acp.ts)。
- [Step RPC](https://github.com/stepfun-ai/Step-Code/blob/main/packages/coding-agent/docs/rpc.md)、
  [官方发行清单](https://static-openapi.stepfun.com/stepcode/latest.json)。
- [Muse SDK / 协议及 conformance traces](https://github.com/meta-models/muse-code-sdk)、
  [官方文档](https://dev.meta.ai/docs/muse-code)、[公开发行 channel](https://api.meta.ai/muse-code/channels/muse-stable)。
  另外用安装版本的 muse schema 离线导出核对合同；实机暴露的大写 clientInfo.name 拒绝已修正为 cindy，
  并保留先失败后通过的回归，未把初始化失败误判为未登录。

官方二进制均按公开摘要校验后安装；npm 使用官方包。安装位于 ~/.local/bin、~/.local 的 npm
prefix、Step 的 ~/.stepcode/bin；不更改 shell 配置、默认 Node 或原生账号。Step 安装归档中
示例依赖的越界软链只在临时解包时跳过，没有把它们写出目标目录；实际运行资源完整保留。
Muse 直接安装经官方 manifest SHA-256 校验的本机二进制，没有使用同名第三方 npm wrapper。
这些是用户明确授权的人工验收安装，不代表 Cindy 已提供自动安装产品流程。

### 验证结果

第五批代码验证：最终分批覆盖适配器、运行服务、host、默认关闭、旧 providerRoute、实验页面
共 7 文件、213 个不同用例；其中旧路由 84 项。主矩阵先跑 212 项（3.23 秒），补充终态权限
失效回归后，两个受影响文件 33 项再次通过（0.80 秒）。新协议文件 22 项，使用内存进程／管道，
没有真实等待或账号依赖，所在定向组总耗时小于 1 秒。Mobile 共享文案术语 4 项通过。
Desktop typecheck、maker-shared build、手动 smoke 独立 strict typecheck、改动代码 ESLint、
i18n 结构／术语、test-hygiene 与 10 项文档门禁通过；i18n 既有警告未计为新增故障。
使用等效定向选测，没有重跑整仓测试或把前序供应商组／分享回归写成本批结果。
已复核本轮快照 diff、Git diff 和 24 个本批相关文本文件的 whitespace。没有提交／推送或
重启 Cindy，未重新要求缺账号产品登录。

## 10. 剩余入口的具体缺口

这些缺口与“用户没有账号”不同：尚未完成原生执行连接，不能用未登录模拟把它们计为已接入。

| 产品 | 已核验入口 / 当前限制 | 需要完成的工作 |
| --- | --- | --- |
| OmO 5.1.40 | 官方 native CLI 已安装；仅运行 --help 就自动复制 ~/.pi/agent 到 ~/.omo/agent；源码确认启动迁移发生在 help/RPC 之前，可能触及项目旧目录 | 暂停接线；需官方不自动迁移其他 Agent 状态的启动入口。未读、未删除迁移目录，不伪造迁移标记 |
| Mister Morph | [Runtime REST OpenAPI](https://github.com/quailyquaily/mistermorph/blob/master/docs/runtime-api.full.openapi.yaml) 有 tasks、stop、approvals；console serve 同时启动配置中的 managed_runtimes（可能包含用户的 IM bot），ACP adapters 是客户端 | 尚需独立服务连接、控制面授权和工作区/任务隔离；不能直接把 console serve 当作无副作用的单会话进程启动 |
| OpenHanako | [官方 server-first CLI](https://github.com/liliMozi/openhanako/blob/main/cli/chat.ts) 使用 HTTP/WebSocket；同一 HANA_HOME 原生互斥，现有服务发现依赖 server-info.json 的控制面 token；HANA_TOKEN 可显式注入，但另建 HANA_HOME 会成为另一套原生 profile | 尚需独立服务连接/授权流程及 sessionId + sessionPath + streamId 隔离；不静默读取既有控制面凭据、不复制原生 profile 或抢占桌面服务 |
| Empryo | [官方 headless](https://github.com/proxysoul/Empryo/blob/main/mintlify-docs/recipes/headless.mdx) 是 soulforge NDJSON，自动批准工具且没有交互审批 | 需完整核验执行与权限合同后设计独立适配，不默认强制自动批准 |
| OpenPencil / Pencil | [OpenPencil 官方 op CLI](https://github.com/ZSeven-W/openpencil/blob/main/crates/op-cli/src/usage.txt) 暴露画布 HTTP MCP；op-acp 是外部 Agent 客户端 | 画布工具可由原生 Agent 使用，但尚未核实内置设计 Agent 的可编排入口；不重复计为新 Agent |
| Alma / Lody / Aside / ZCode / AstrBot | Magpie 中的模型配置或导入兼容不是执行协议；Alma 已知 /api/providers 为配置接口；本轮 Alma/Lody 文档读取被 403 拒绝 | 继续核验官方执行/扩展 API、取消与授权合同；不安装不明同名程序 |
| WorkBuddy 两版 | 官方公开助理文档提供 IM 遥控，未核实可创建任意工作区任务的公共 SDK/ACP | 需独立官方桌面/助理入口；不以 CodeBuddy CLI 或订阅转换插件代替 |
| Claude Desktop/Science、Cursor Private Inference、Zed、VS Code 三版、JetBrains Air/Copilot、Grok App、Raycast | 桌面/IDE/权益模式；尚未核实独立原生执行接口 | 各自核验官方扩展与执行入口，不能替换底层模型配置后宣布接入 |
| OpenChamber / T3 Code | 基于已有原生运行时的界面 | 明确独立能力与控制合同；不把 OpenCode/Claude Code 的同次验收重复计数 |
| Claude Code / Codex / Pi | 旧原生引擎继续可用 | 新目录映射还未完成；保持旧凭证与路由合同，不借扩展批次重写 |

第五批覆盖 §9 的 10 项，第六批再接入 §11 的 Crush 与 AtomCode。表中剩余服务型适配与桌面入口仍是未完成工作，不是永久不支持的结论，也不能归因为用户没有账号。

## 11. 第六批：Crush HTTP/SSE 与 AtomCode ACP

2026-10-20 再新增 2 个入口，注册表从 32 增至 **34 个**（31 个 ACP、Step RPC、Muse MSP、
Crush HTTP/SSE）。与第五批合计本轮接入 12 个。仍默认关闭，没有更改 Cindy profile、旧供应商
路由或 Device Link wire；没有新增模型直连、抽取订阅凭证或要求用户提供账号。

| Agent / 官方安装版 | 原生入口 | 本机缺配置检查 | 真实模型调用 |
| --- | --- | --- | --- |
| Crush 0.98.1 | crush server --host 私有 socket --data-dir 独占临时目录 | health、工作区、会话、事件订阅、current-session 通过；agent/init 返回原生 500 → protocol-error（诊断仅分类为 agent/missing），1.94 秒内退出并清理；不猜为 needs-auth | 未验 |
| AtomCode 5.2.3 (d8918f0) | atomcode acp | 官方隐藏子命令存在；ACP v1 握手及创建通过（0.715 秒），未配置首条请求 -32603 → protocol-error；未细分账号原因 | 未验 |

Crush 的执行与故障范围：

- 每次启动专属前台原生进程，使用 owner-only 临时目录内的 Unix socket；Windows 使用唯一
  named pipe。没有 TCP 监听或连接用户默认 Crush 服务。原生进程只在选中电脑运行；手机和
  远程控制继续复用已有资源投影，SSH 未因此新增支持。
- 原生模型配置仍由 Crush 自己读取。Cindy 不调用 config/providers 接口，工作区创建响应中
  附带的 config/env 不保留到会话或投影。原生 stdout/stderr 均不进入 UI/日志。
- 用独立原生 data_dir 避免争用用户现有工作区数据库；关闭、失败、取消启动后，先回收自己
  的进程，再尽力清理自有临时目录。不调用共享 server 的 shutdown，不删除用户原生目录。
  本阶段不承诺跨重启恢复。
- 先订阅 SSE，再设置 current-session；真实 0.98.1 暴露的反序 409 已修复，并以生产入口
  测试先红后绿。初始化显式 interactive:true，工作区 yolo:false，审批由既有多端表单回传。
- HTTP 接受回执不是完成，等待匹配 session_id + run_id 的 run_complete；文本快照去重，
  工具状态映射。取消等待接受回执，防止迟到取消作用于下一轮。只认当前轮权限；不处理的
  原生自由文本/批量问题明确失败并关闭，不悬挂或替用户编造答案。
- SSE 损坏/超限/断开只关闭自己的适配器进程，不重试模型请求、不重连 Device Link relay。
  两实例隔离、旧 run_id、允许/拒绝、取消后继续、诊断隔离、清理均有生产入口模拟验证。
  超时和先于 ACK 到达的终态错误保留原始错误类别，不被清理时的 closed 覆盖。

AtomCode 的入口核验修正：README 只列出非交互 -p 和 daemon；进一步阅读
[官方 CLI 源码](https://atomgit.com/atomgit_atomcode/atomcode/blob/main/crates/atomcode-cli/src/main.rs)
确认另有隐藏的 Acp 子命令，并在实际安装版运行 atomcode acp --help 和完整握手验证。
该入口明确启用原生交互审批，不需要 -p、daemon、自动批准开关或修改用户 provider 配置。
Windows 通过官方 npm 的 bin/atomcode.js 加独立 node.exe 启动，发现/命令路径已有模拟回归。

Crush 二进制来自官方 v0.98.1 Darwin arm64 release，并按发行 SHA-256 校验；AtomCode 来自
官方 npm @atomgit.com/atomcode@5.2.3（原生可选包由 npm integrity 校验）。均独立安装到
~/.local，未改仓库依赖、shell 配置、默认 Node 或运行中的 Cindy。

验证：8 文件 **229 项通过**（2.04 秒），包含新 Crush 14 项、旧 providerRoute 84 项，
以及 ACP、Step/Muse、运行服务、host、默认关闭、实验页面；Crush 单文件 0.32 秒级。
Desktop typecheck、smoke 脚本 strict typecheck、代码 ESLint、test-hygiene（368 文件）、
10 项文档门禁、Git diff --check 与 24 个适配器/台账文件的 whitespace 检查通过。
没有重复整仓测试或把模拟审批、取消、双实例检查写成真实模型/跨设备验收。
最终标题字段按官方 JSON 合同调整后，Crush 14 项单文件再次通过（0.309 秒）。
本轮未提交、推送或重启 Cindy；原生安装保留，唯一临时调查目录已清理，未发现本轮
Crush/AtomCode 原生进程或 Crush 自有临时目录遗留。
