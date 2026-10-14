# MCP Apps 本地协议验证记录

验证日期：2026-10-14（Asia/Shanghai，日期由系统时钟取得）。

结论：官方 SDK 申请表与独立 JSON-RPC 数据看板通过同一个生产 Host 接入，
无需按业务调整 Cindy。官方 `2026-01-26` 稳定协议及 Cindy 已声明能力的本地回归通过。
本记录是本仓的互操作与沙箱验证结果，不是上游颁发的兼容认证，也不代表实现全部可选能力。

## 环境与复跑

| 项目         | 实际环境                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 系统         | Windows，PowerShell                                                                                                  |
| Node.js      | 24.19.0                                                                                                              |
| Electron     | 42.11.12                                                                                                             |
| MCP Apps SDK | `@modelcontextprotocol/ext-apps@1.7.5`                                                                               |
| MCP SDK      | `@modelcontextprotocol/sdk@1.29.0`                                                                                   |
| 协议基准     | [官方 2026-01-26 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) |

从仓库根目录运行：

```powershell
pnpm.cmd --filter desktop test:mcp-apps:conformance
```

本次退出码为 0：9 个测试文件、86 项测试通过；随后两个真实 Electron 集成检查分别输出
`MCP_APPS_SANDBOX_VERDICT=passed` 和 `MCP_APPS_RAW_SANDBOX_VERDICT=passed`。
`pnpm.cmd --filter desktop typecheck` 与 MCP Apps 代码及三个模拟/验证脚本的定向 ESLint 也通过。

| 测试文件                      | 通过数量 | 主要覆盖                                                           |
| ----------------------------- | -------: | ------------------------------------------------------------------ |
| `interop.test.ts`             |       16 | 官方 App SDK、HTTP/SSE、初始化顺序、加载期间完成/撤销、模型 facade |
| `conformance.test.ts`         |       16 | 独立 JSON-RPC App、编码/metadata 组合、分页、通知、取消、能力协商  |
| `operations.test.ts`          |       11 | 任务与调用者绑定、输入校验、远程操作边界                           |
| `ipc.test.ts`                 |        6 | 卡片持久化、清空与账号竞态、权限路由、公开错误                     |
| `protocol.test.ts`            |       18 | 标准 metadata、可见性、资源格式/大小、CSP 域声明与同源 base URI 默认值 |
| `sandboxProtocol.test.ts`     |        7 | 不同 origin、账号隔离、权限拒绝、供片撤销、嵌套导航与 Escape       |
| `remoteAuthorization.test.ts` |        5 | 真实 Session instance 路由、冻结装配名单、远程发现与执行授权       |
| `connection.test.ts`          |        3 | 首次失败及断线后独立重连、关闭竞态、不重放已发送工具               |
| `openLifecycle.test.ts`       |        4 | 加载超时、打开前取消、晚到 View 回收、调用者与任务隔离             |

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

| 协议项               | 本次验证                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展与 MIME          | Client 声明 `io.modelcontextprotocol/ui`；读取 `text/html;profile=mcp-app`；两种服务器与传输均可发现 UI                                                                                              |
| 工具发现与可见性     | 支持 `_meta.ui.resourceUri` 和旧键；默认 model+app；模型看不到 App-only 工具，View 不能调用 model-only 工具；工具分页不会漏项                                                                        |
| HTML 资源            | text/blob 两种编码；优先 read metadata，缺失时从分页 resources/list 查找；拒绝错误 URI/MIME、非法 base64 和超过 4 MiB 的资源                                                                         |
| 初始化、版本与 ping  | `ui/initialize` 协商 `2026-01-26`；未知请求版本返回实际支持版本；initialized 前不发输入/结果、拒绝工具调用；拒绝重复初始化；ping 正常                                                                |
| 输入、结果与模型隔离 | initialized 后按输入、结果顺序交付；text/image/audio、嵌入文本/二进制资源、resource_link、structuredContent 与 `_meta` 完整保留给 View；模型 facade 去掉结果根 `_meta`；加载期间完成或取消仍正确交付 |
| App 工具调用         | 只连接产生卡片的 server；按任务授权；拒绝授权时服务器不执行；保留工具 `isError` 与 View metadata；不重放写操作                                                                                       |
| 资源与列表变更       | resources/read/list/templates、prompts/list；resources/list 游标可继续分页；tools/resources/prompts 的 list_changed 到达 App，刷新后工具定义更新                                                     |
| 连接生命周期         | 超过 Host 额度的闲置 facade 不登记连接；首次请求登记，后续请求复用连接 ID，代理关闭后释放；回归见 `interop.test.ts`                                                                                   |
| 消息与模型上下文     | `ui/message` 支持稳定单块与数组形状、text/resource_link；上下文支持 text/structuredContent，后一次替换旧值；发送接受后仅消费本次快照，失败或原生命令保留，更新与发送重叠时不丢新值；单独更新不启动轮次；未声明模态明确失败 |
| 打开链接             | `ui/open-link` 转交查看端 controller；成功/失败均有 RPC 结果；拒绝 javascript 与含凭证的 URL；不让 App 自身导航离开资源                                                                              |
| 显示与尺寸           | inline/fullscreen 协商；App 限制仅 inline 时返回 inline；pip 请求返回实际支持模式；host-context-changed 同步模式；真实浏览器按 size-changed 改变 iframe 高度                                         |
| 环境与主题           | locale、时区、容器尺寸、安全区域和工具信息可读；Host context 可增量更新；真实 Electron 内两种 App 的 Light/Dark 背景随 CSS variables 切换                                                            |
| sandbox 隔离         | 标准 sandbox-ready 与生产 proxy 供片；App 无 preload、require、process；不能读取不同 origin 的父文档；供片绑定当前账号                                                                               |
| CSP 域声明           | 真实浏览器中 connect/resource/frame/baseUri 声明域可用；未声明 fetch 和嵌套导航均被阻断，禁止域 HTTP 请求计数为 0                                                                                    |
| 系统权限             | Host permissions 为空；真实 Permissions Policy 拒绝 camera、microphone、geolocation、clipboard-write；Electron request/check 两道守卫拒绝 App 及其外部后代 frame 的系统权限，真实 App 的通知权限请求返回 denied |
| 取消与销毁           | `notifications/cancelled` 传到正在执行的 server 工具，且执行次数为 1；`ui/resource-teardown` 完成握手后释放；供片变为 404；清空、删 server 或账号切换后旧 View 不可用                                |
| 未支持能力           | 不声明 sampling、downloadFile；相应请求与未知方法返回 `-32601`；不声明的图像/音频消息或上下文明确拒绝，不静默丢内容                                                                                  |

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
Mobile 真机、真实 SSH 主机、真实 GM endpoint 仍待端到端验收。
本地模拟与自动验证不修改用户 MCP 设置，不连接生产业务接口。
