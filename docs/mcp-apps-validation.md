# MCP Apps 本地协议验证记录

验证日期：2026-10-15（Asia/Shanghai，日期由系统时钟取得）。

结论：官方 SDK 申请表与独立 JSON-RPC 数据看板通过同一个生产 Host 接入，
无需按业务调整 Cindy。官方 `2026-01-26` 稳定协议及 Cindy 已声明能力的本地回归通过。
本记录是本仓的互操作与沙箱验证结果，不是上游颁发的兼容认证，也不代表实现全部可选能力。

## 环境与复跑

| 项目         | 实际环境                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 系统         | Windows，PowerShell                                                                                                  |
| Node.js      | 22.22.2                                                                                                              |
| Electron     | 42.11.12                                                                                                             |
| MCP Apps SDK | `@modelcontextprotocol/ext-apps@1.7.5`                                                                               |
| MCP SDK      | `@modelcontextprotocol/sdk@1.29.0`                                                                                   |
| 协议基准     | [官方 2026-01-26 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) |

从仓库根目录运行：

```powershell
pnpm.cmd --filter desktop test:mcp-apps:conformance
```

单测阶段最新结果为 11 个测试文件、127 项测试通过，退出码为 0。
前序两个真实 Electron 集成检查均以退出码 0 结束，分别输出
`MCP_APPS_SANDBOX_VERDICT=passed` 和 `MCP_APPS_RAW_SANDBOX_VERDICT=passed`。
`pnpm.cmd --filter desktop typecheck` 与本轮修改代码、测试及模拟/验证脚本的定向 ESLint 也通过。
前序自定义 MCP provider、Codex HTTP bridge 与 Pi 环境接入的 66 项回归通过；
本轮重跑自定义 provider/registry、Codex 与 Pi 环境的 62 项回归通过。
已有卡片大小回归：完整卡片按 UTF-8 JSON 字节限制为 1 MiB，超大结果在写入前
变成标准有界错误；官方 View SDK 的实时/远程重开均能读取，模型仍收到原结果。
恰好达到上限、超出一字节、多字节文本、View-only metadata 和输入/结果合计均纳入验证。
本轮新增 14 项回归：远程完整文档和事件数组使用 4 MiB 减 64 KiB 的 UTF-8 JSON
预算，覆盖多字节、引号/控制字符转义、真实 device-link invoke-result 分片编码、
超限 View 不占额度、消费后字节回收及另一控制端继续工作；普通 MCP 的 HTTP/SSE
补全、进行中的进度、订阅/退订、日志级别/通知、task 方法/状态通知和扩展请求均透传。
无上游能力时不虚报，撤权拦住迟到结果和新请求，取消只传给原请求、不重放。
普通工具调用另新增 9 项撤权竞态回归：在连接获取、工具执行、App 结果保存的等待期间，
分别切换账号、删除服务器和修改配置；等待后重新核验 owner/config，拒绝执行或向模型
返回迟到结果，已经执行的调用不重放。9 项均在修复前复现失败，修复后通过；
见 `serverProxy.test.ts`。本次撤权修复重跑完整 MCP Apps 单测、Desktop 类型检查与
定向 ESLint，未重跑前序沙箱与真机验证。

| 测试文件                      | 通过数量 | 主要覆盖                                                                                  |
| ----------------------------- | -------: | ----------------------------------------------------------------------------------------- |
| `interop.test.ts`             |       25 | 官方 App SDK、HTTP/SSE、上游 instructions、初始化失败回复、加载期间完成/撤销、模型 facade |
| `conformance.test.ts`         |       18 | 独立 JSON-RPC App、编码/metadata 组合、分页、通知、取消、能力协商                         |
| `operations.test.ts`          |       11 | 任务与调用者绑定、输入校验、远程操作边界                                                  |
| `ipc.test.ts`                 |        6 | 卡片持久化、清空与账号竞态、权限路由、公开错误                                            |
| `protocol.test.ts`            |       22 | 标准 metadata、可见性、资源格式/大小、CSP 域声明与同源 base URI 默认值                    |
| `sandboxProtocol.test.ts`     |       10 | 不同 origin、账号隔离、权限拒绝、Renderer 生命周期回收、嵌套导航与 Escape                 |
| `remoteAuthorization.test.ts` |        5 | 真实 Session instance 路由、冻结装配名单、远程发现与执行授权                              |
| `connection.test.ts`          |        3 | 首次失败及断线后独立重连、关闭竞态、不重放已发送工具                                      |
| `openLifecycle.test.ts`       |        4 | 加载超时、打开前取消、晚到 View 回收、调用者与任务隔离                                    |
| `wireBudget.test.ts` | 7 | 完整文档/事件 UTF-8 JSON 大小、转义、device-link 编码、额度回收与控制端隔离 |
| `serverProxy.test.ts` | 16 | 普通 MCP 能力、补全/进度、订阅/日志、task/扩展、取消和三个等待阶段的撤权竞态 |

作者侧修复另经 Desktop 卡片可见性、MCP 目录与 SSH bridge、安全守卫定向测试验证；
Mobile 的卡片导航/HTML 注入与三个受影响消息展示测试共 39 项通过。共享 controller/
文档测试 13 项、device-link 超时与重试策略测试 31 项通过；Desktop、Mobile 与两个
共享包的类型检查、定向 ESLint、i18n 及设计台账检查通过。未用本地定向结果替代完整 CI。

## 两个独立 App

1. **申请表**：服务器使用官方 `registerAppTool`/`registerAppResource`，View 使用官方 App SDK。
   AI 预填后，用户修改并创建内存申请；更新模型上下文不启动模型轮次，明确发送消息才触发测试回调。
2. **数据看板**：View 只使用标准 JSON-RPC/postMessage；服务器使用普通 MCP SDK 低层 handler，
   不依赖 ext-apps 注册 helper。使用不同工具名和 `ui://` 资源，默认 blob HTML、list-level metadata，
   另测 text HTML、read-level metadata 与旧 `ui/resourceUri`。刷新、消息、上下文、模式和尺寸均走同一 Host。

两种服务器都提供随机 loopback Streamable HTTP 与 SSE，互操作测试覆盖两种传输；
真实 Electron 检查分别通过 Streamable HTTP 加载两种 App。
工具数据全在内存中，不连接 GM 生产接口、不创建真实申请、不发送消息给其他人。

## 协议覆盖与证据

卡片中的完整工具结果均指 1 MiB 序列化预算内的数据；超限只交付标准有界错误。

| 协议项               | 本次验证                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展与 MIME          | Client 声明 `io.modelcontextprotocol/ui`；读取 `text/html;profile=mcp-app`；两种服务器与传输均可发现 UI                                                                                                                    |
| 工具发现与可见性     | 支持 `_meta.ui.resourceUri` 和旧键；默认 model+app；模型看不到 App-only 工具，View 不能调用 model-only 工具；工具分页不会漏项                                                                                              |
| HTML 资源 | text/blob 两种编码；read/list metadata；拒绝错误 URI/MIME、非法 base64 和超过 4 MiB 的资源；远程完整文档按 UTF-8 JSON 计量，超限在保留 View 前拒绝 |
| 远程响应大小与背压 | 完整文档及 poll 事件数组最多 4 MiB 减 64 KiB，预留 invoke-result 封装；UTF-8、JSON 转义、数组括号/分隔符计入；已消费事件按相同字节回收，另一控制端继续工作；见 `wireBudget.test.ts` |
| 初始化、版本与 ping  | `ui/initialize` 协商 `2026-01-26`；未知请求版本返回实际支持版本；initialized 前不发输入/结果、拒绝工具调用；拒绝重复初始化；ping 正常                                                                                      |
| 模型 MCP 初始化 | HTTP/SSE 上游 `instructions` 和实际 capabilities 在标准 initialize 中保留；SDK 的 serverInfo 和版本协商保留；owner 变化时明确回复错误；见 `interop.test.ts` 与 `serverProxy.test.ts` |
| 模型 MCP 标准能力 | HTTP/SSE 补全、资源订阅/退订、日志级别/通知、task 方法/状态通知及扩展请求透传；任务式工具调用仍检查 model 可见性；取消不重放，迟到结果重新检查 owner/config；见 `serverProxy.test.ts` |
| 输入、结果与模型隔离 | initialized 后按输入、结果顺序交付；text/image/audio、嵌入文本/二进制资源、resource_link、structuredContent 与 `_meta` 完整保留给 View；模型 facade 去掉结果根 `_meta`；加载期间完成或取消仍正确交付                       |
| App 工具调用         | 只连接产生卡片的 server；按任务授权；拒绝授权时服务器不执行；保留工具 `isError` 与 View metadata；不重放写操作                                                                                                             |
| 资源与列表变更       | resources/read/list/templates、prompts/list；resources/list 游标可继续分页；tools/resources/prompts 的 list_changed 到达 App，刷新后工具定义更新                                                                           |
| 连接生命周期         | 超过 Host 额度的闲置 facade 不登记连接；首次请求（包括 initialize）登记，后续请求复用连接 ID，代理关闭后释放；回归见 `interop.test.ts`                                                                                     |
| 远程文档生命周期     | Renderer 重载、崩溃或销毁后，旧供片返回 404 并可重新挂载；同文档/子 frame 导航、其他 Renderer 与本地 Host 供片保留；回归见 `sandboxProtocol.test.ts`                                                                       |
| 消息与模型上下文     | `ui/message` 支持稳定单块与数组形状、text/resource_link；上下文支持 text/structuredContent，后一次替换旧值；发送接受后仅消费本次快照，失败或原生命令保留，更新与发送重叠时不丢新值；单独更新不启动轮次；未声明模态明确失败 |
| 打开链接             | `ui/open-link` 转交查看端 controller；成功/失败均有 RPC 结果；拒绝 javascript 与含凭证的 URL；不让 App 自身导航离开资源                                                                                                    |
| 显示与尺寸           | inline/fullscreen 协商；App 限制仅 inline 时返回 inline；pip 请求返回实际支持模式；host-context-changed 同步模式；真实浏览器按 size-changed 改变 iframe 高度                                                               |
| 环境与主题           | locale、时区、容器尺寸、安全区域和工具信息可读；Host context 可增量更新；真实 Electron 内两种 App 的 Light/Dark 背景随 CSS variables 切换                                                                                  |
| sandbox 隔离         | 标准 sandbox-ready 与生产 proxy 供片；App 无 preload、require、process；不能读取不同 origin 的父文档；供片绑定当前账号                                                                                                     |
| CSP 域声明           | 真实浏览器中 connect/resource/frame/baseUri 声明域可用；未声明 fetch 和嵌套导航均被阻断，禁止域 HTTP 请求计数为 0                                                                                                          |
| 系统权限             | Host permissions 为空；真实 Permissions Policy 拒绝 camera、microphone、geolocation、clipboard-write；Electron request/check 两道守卫拒绝 App 及其外部后代 frame 的系统权限，真实 App 的通知权限请求返回 denied            |
| 取消与销毁           | `notifications/cancelled` 传到正在执行的 server 工具，且执行次数为 1；`ui/resource-teardown` 完成握手后释放；供片变为 404；清空、删 server 或账号切换后旧 View 不可用                                                      |
| 未支持能力           | 不声明 sampling、downloadFile；相应请求与未知方法返回 `-32601`；不声明的图像/音频消息或上下文明确拒绝，不静默丢内容                                                                                                        |

工具输入片段通知是可选项，当前发送零次 partial 通知并在初始化后发送完整 arguments。
工具结果的图像/音频块能完整到达 View，不代表 Host 支持图像/音频 `ui/message` 或模型上下文。
Desktop 声明 inline/fullscreen，Mobile 声明 inline；不声明 pip 或任何系统权限。

## 实测发现并修复的问题

生产导航守卫原先把 App 内声明过 `frameDomains` 的嵌套 iframe 也拦截了。
这会导致符合标准、使用外部嵌入内容的 App 无法加载该内容。

修复后沿真实 frame 的父链找到所属 App 资源，只按该资源重新校验的 `frameDomains`
授权后代 frame。App 自身和外层 sandbox 的导航限制保留；账号不匹配或供片撤销时没有授权。
真实 Electron 已确认声明域可加载、未声明域无网络请求；回归单测同时确认不同协议、
本地文件和其他 App 的供片地址仍受限。验证过程中主动访问禁止域产生的
`ERR_BLOCKED_BY_CSP` 是预期阻断证据，以最终退出码和 verdict 判断检查结果。

## 验证边界

这些结果说明：遵守上述稳定协议、使用 Cindy 已声明能力的不同 Apps 可以复用现有 Host 接入，
无需编写申请表或数据看板专用前端逻辑。它不保证未知的未来协议版本，或要求未声明可选能力的 App。
后续 SDK/协议升级需复跑同一套检查并补充新增能力覆盖。

真实浏览器检查加载生产 Host/controller/custom-scheme sandbox，但卡片存储、权限与消息使用测试回调。
尚未联调真实模型账号与完整 Cindy React 卡片，不等同于完整产品 UI 的 Light/Dark 实机目检。
大小检查只约束本版本的新卡片写入，不批量改写此前已经保存的历史记录。
上游 instructions 透传恢复模型既有的服务器说明，并在 facade 初始化时建立认证连接；
本地协议 fixture 验证字段与失败语义，未实测真实模型的缓存率、启动耗时、用量或调用准确率。
Mobile 真机、真实 SSH 主机、真实 GM endpoint 仍待端到端验收。
本地模拟与自动验证不修改用户 MCP 设置，不连接生产业务接口。
