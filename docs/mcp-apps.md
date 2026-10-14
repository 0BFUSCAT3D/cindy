# MCP Apps 接入与验证

Cindy 实现通用 MCP Apps Host。业务服务器按官方协议提供工具与 HTML 资源，
可以使用官方 MCP Apps SDK，也可以自行实现标准消息；无需修改 Cindy 前端，
也无需把页面做成 Cindy `.cindy` 插件。
基准为 [官方 `2026-01-26` 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)，
Host 与 View 互操作使用 `@modelcontextprotocol/ext-apps@1.7.5`，MCP SDK 保持现有 1.x。

## 协议兼容矩阵

| 官方协议项                | Cindy 行为                                                                                                                        | 验证                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Client extension / MIME   | 声明 `io.modelcontextprotocol/ui` 与 `text/html;profile=mcp-app`                                                                  | HTTP、SSE 官方 SDK 互操作        |
| 工具发现                  | 解析 `_meta.ui.resourceUri`，兼容 `ui/resourceUri`；读取 `ui://` 资源                                                             | metadata / URI 单测              |
| 工具可见性                | 默认 model+app；App-only 不给模型，model-only 不给 View                                                                           | 官方 SDK 互操作、远程授权回归    |
| 资源读取                  | `resources/read` 支持 text、base64 blob；优先读取内容 metadata，缺失时查 resources/list                                           | 资源 / MIME / 大小 / base64 单测 |
| 初始化                    | 官方 AppBridge 协商版本、Host/App capabilities、Host context                                                                      | 独立官方 App SDK                 |
| iframe proxy              | Host、外层 proxy、View 相互隔离；保留标准 sandbox-ready 通知与完整 HTML；桌面通过不同 custom origins 提供同一 HTML 和 CSP headers | 真实 Electron 集成               |
| 工具输入 / 结果           | initialized 后先给完整 arguments，再给完整 ContentBlock、structuredContent 和 View-only `_meta`；模型结果去掉根 `_meta`           | 初始化 / 顺序 / 结果互操作       |
| 工具输入片段              | 可选；当前在工具调用时发送完整输入，无 partial 通知                                                                               | 完整输入顺序测试                 |
| 取消 / 销毁               | 标准 cancelled 与 resource-teardown；等待响应，有界退出，撤销本地供片                                                             | 官方 SDK 与 Electron 集成        |
| App 调工具                | 只连接产生该卡片的 MCP server；复用任务权限卡；审批后再次核对归属、清空与配置                                                     | 可见性 / owner / 撤销 / IPC 回归 |
| MCP 资源与通知            | 转发 resources/read/list/templates、工具列表、prompts/list 与 list_changed；不开放任意 server 或 endpoint                         | 官方 SDK、连接和操作测试         |
| `ui/open-link`            | 仅 http/https，无内嵌凭证；在当前查看设备的系统浏览器打开，失败返回 RPC 错误                                                      | controller / Host / URL 单测     |
| `ui/message`              | 支持 text、resourceLink；保留 user role 和真实 App 来源，复用发送与排队，不作为主人授权                                           | 官方 SDK 互操作、来源与发送回归  |
| `ui/update-model-context` | 支持 text、structuredContent；按 View 替换最新值，不启动模型；下次发送附加外部应用上下文，不进入 system prompt                    | 官方 SDK、发送链回归             |
| 显示模式 / 尺寸           | Desktop inline+fullscreen，Mobile inline；返回实际模式；size-changed 调整高度；Host context 同步模式变化                          | 互操作、controller 生命周期      |
| 主题 / 环境               | Light/Dark、CSS variables、locale、时区、尺寸和设备能力通过 Host context 传递                                                     | Electron 中主题切换、类型检查    |
| CSP / 权限                | 按 connect/resource/frame/baseUri domains 构建 CSP；默认拒绝未声明网络；权限声明为空，拒绝摄像头、麦克风、定位和剪贴板            | 注入单测、真实 Electron 阻域     |

“符合标准”包含如实协商可选能力，并不表示 Host 宣称支持所有可选能力。当前不声明
sampling、downloadFile、pip、图像/音频 `ui/message` 或图像/音频模型上下文。App 必须先检查
Host capabilities；不支持的调用明确失败，不静默丢内容。工具结果本身仍完整交给 View。
后续标准新增版本需要升级并重新验证 SDK；使用上述稳定协议的新 App 不需要业务特例。

桌面允许 App 内的嵌套 iframe 加载该资源声明的 `frameDomains`，并核对所属 App 和当前账号。
这项授权只适用于资源的后代 frame；App 自身和外层 proxy 仍保持原导航边界。
未声明域、不同协议、其他 App 的供片地址和本地文件不会因此获得访问权限。

## 接入

在 Cindy 设置中添加普通自定义 MCP，选择 Streamable HTTP 或 SSE 地址及所需认证。
凭证留在 Main 的现有密钥存储中，不进入 iframe。Claude Code、Codex、Pi 都通过同一
Host facade 调用自定义 MCP；支持 Apps 的工具执行时生成独立卡片，历史卡片可重新连接。
不支持 UI 扩展的普通 MCP 保持文本工具使用方式。

SSH 远端使用既有认证桥和 Session instance 路由；只暴露实际配置的自定义 server，
仍拒绝无关的本机 MCP。伙伴的自定义 server 还需出现在冻结的工具装配名单里。
设备互联和手机端只负责显示与转发，不下放凭证。远程调用授权已做 loopback 回归；
尚未验证真实 SSH 主机与真机 Mobile 的端到端行为。

资源上限为 4 MiB；每个远程查看端最多同时打开 4 个 View，本地查看端 16 个。
Desktop 卡片仅在可见时打开，离屏或窗口隐藏时释放 View，重新可见后重新加载。
单次模型上下文 128 KB，每个任务总计 512 KB。Host 资源加载最多 90 秒，远程打开
请求等待 120 秒；文档到达后再给 App 45 秒初始化。控制端取消或丢失打开回执时，
使用可选 `openId` 和 `cancel-open` 回收该次加载或晚到 View，不影响其他查看端。
旧 v1 Host 不支持取消操作时仍由既有空闲租约回收，收到晚到回执时控制端主动销毁。
连接暂时中断只重试读取轮询，最多 30 秒；后续独立请求可重新建立 MCP 连接，
已发出的工具调用和消息不自动重放。
工具在页面加载期间完成或取消也会在初始化后正确交付；任务在加载期间被清空、
服务器被撤销时，Host 会拒绝展示并清理 View。

## 本地模拟申请表

```powershell
pnpm.cmd --filter desktop mcp-apps:mock
```

脚本输出随机 loopback 端口的 HTTP 与 SSE 地址。把其中一个地址手动添加为自定义 MCP，
让模型调用 `draft_form` 即可显示表单。模拟服务器使用官方 registerAppTool、registerAppResource
和独立 App SDK，页面无需联网下载代码。脚本不修改用户设置。

1. AI 给 title/body 初值。
2. 用户核对修改，`ui/update-model-context` 只更新下一轮上下文。
3. 点击创建后调用 App-only `create_application`，返回内存申请编号和 `sent:false`。
4. 点击“请 AI 继续修改”才发送消息并启动后续模型轮次。

这验证了于浩博讨论中的“AI 预填 → 用户核对 → 创建申请”流程。模拟创建不发送真实站内信，
不连接业务生产接口；真实 GM App 尚需业务服务器提供标准工具与资源。

## 独立实现的数据看板

```powershell
pnpm.cmd --filter desktop mcp-apps:mock --raw
```

同样输出随机 loopback HTTP/SSE 地址；添加为普通自定义 MCP 后调用 `open_metrics`。
看板的 View 只使用标准 JSON-RPC/postMessage，不依赖 Cindy API 或官方 View SDK；
服务器使用普通 MCP SDK 的低层 handler，不使用 MCP Apps 注册 helper。
它与申请表复用同一生产 Host，覆盖分页发现、blob HTML、resources/list metadata、
App-only 刷新、完整工具结果、模型上下文、消息、显示模式和尺寸通知。
测试还使用 text HTML、read-level metadata 和旧 `ui/resourceUri` 组合验证兼容读取。

## 一键协议验证

```powershell
pnpm.cmd --filter desktop test:mcp-apps:conformance
```

顺序运行协议、连接、授权与 IPC 回归，再分别启动真实 Electron 沙箱加载官方 SDK 申请表
和独立 JSON-RPC 看板。HTTP/SSE、text/blob、metadata 来源、分页与变更通知、取消、
销毁、显示、主题和 CSP 都纳入覆盖。当前结果为 86 项回归和两种 App 的沙箱检查通过，
逐项证据与边界见 [本地协议验证记录](./mcp-apps-validation.md)。

## 检查入口

```powershell
pnpm.cmd --filter desktop exec vitest run src/main/mcp-apps/__tests__ --maxWorkers=2
pnpm.cmd --filter @cindy/maker-shared exec vitest run
pnpm.cmd --filter desktop test:mcp-apps:sandbox
pnpm.cmd --filter desktop typecheck
pnpm.cmd --filter mobile typecheck
pnpm.cmd --filter @cindy/maker-shared build
pnpm.cmd --filter @cindy/device-link build
pnpm.cmd check:i18n
pnpm.cmd check:i18n-glossary
```

Electron 检查启动独立隐藏测试窗口与唯一临时 profile，加载生产 Host/proxy 和两个 App，
验证预填、修改、创建/刷新、Light/Dark、跨 origin、无 preload、声明的 connect/resource/frame/baseUri
域可用、未声明域无网络请求、导航阻断、销毁和 owner 切换。测试结束关闭自身进程并清理
唯一临时目录，不启动、重启或修改当前 Cindy。
这是独立页面沙箱集成证据，不等同于完整 Cindy 卡片的 Light/Dark 实机目检；Mobile 真机
与真实 SSH 主机仍需验收。
