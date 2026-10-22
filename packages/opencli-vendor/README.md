# 内置 OpenCLI 配方

来源：<https://github.com/jackwener/opencli>，Apache-2.0。
固定版本及逐文件 SHA-256 在 [UPSTREAM.json](UPSTREAM.json)；上游原始依赖声明保存在
[package.upstream.json](package.upstream.json)。本包为 Cindy 私有 workspace，不发布到 npm。

## 全量来源与 Cindy 默认目录

上游 `fe5f1d96aff01c32fd84f86b52af922bfe6ca93f`（2.0.2）：

- 170 个站点/应用，1,223 条命令（916 read、307 write）。
- 1,112 个命令模块，所有生产共享代码、JSON 和其他资源一并引入；不引入上游测试。
- 上游快照完整保留，但默认目录独立选择：排除 Z-Library、Slock、Claude.ai、Spotify、ONES、
  小宇宙适配器、PaperReview、Quark 和 Kimi 共 121 条，另暂缓 17 条直接落盘命令，
  剩余 1,085 条命令、25 个上游别名。原因记录在 [selection.json](cindy/selection.json)，
  同步会沿用此选择，排除条目不进入模块导入表和可执行目录。
- Cindy 原有 56 个 ID：47 个转到新版适配器，7 个保留原流程，两个爬虫练习站移至
  `packages/lizi-mcps/src/browser/recipe-examples`，不再出现在默认列表。
  逐项记录见 [legacy-coverage.json](cindy/legacy-coverage.json)。
- Cindy 独立增加 App Store 搜索、Google Play 搜索、TapTap 中国站游戏详情、Steam 玩家评价、
  Open Library 书目查询和 Crossref 文献/DOI 查询，共 6 个配方，位于
  `packages/lizi-mcps/src/browser/cindy-recipes`。共 1,170 个可发现 ID、168 份指南；这个数包含别名和兼容入口。
- 兼容入口保持输入名，输出改为新版结构化结果；用户本地覆盖层仍优先于内置层。

通过 `browser(action="siteguide")` 查询精简完整目录；传 `site`（域名或上游站点名）
取得参数类型、默认值及访问分类；执行使用 `recipeId="opencli:<site>/<command>"`。
完整的上游来源列表见 [cli-manifest.json](cli-manifest.json)，它不等于 Cindy 默认清单。

## Cindy 适配

`cindy/` 是宿主集成代码。原始文件的必要修改集中记录在 [patches.json](cindy/patches.json)，
同步时逐项精确匹配；上游变化导致补丁失效会报错。`UPSTREAM.json` 同时保存被改文件的
原始摘要及实际落地摘要。不要直接修改 `src/` 或 `clis/` 而不登记补丁。

- 浏览器操作使用 Cindy 当前任务、profile 和目标页；不启动 OpenCLI daemon/扩展。
- CDP 对象和节点沿用一次配方调用的连接；网络响应按上游格式捕获，读取只清空已完成响应，未完成请求保留至结束事件；结束时
  释放监听和连接。导航、上传仍走 Cindy 原有校验路径；代输入后的页面读取限制仍生效。
- 通用执行器不自动重放操作。Instagram reel 移除独立 daemon 和整次发布重试。
- Claude.ai 站点不进入默认目录，Claude 订阅沿用内置 Claude Code CLI 登录与使用。
- Spotify 暂不进入默认目录：客户端密钥的明文文件配置尚未接入宿主加密凭据库。
- 小宇宙适配器暂不进入默认目录：缺少安全配置入口；原有免登录公开播客配方保留。
  共享凭据读取仅查宿主加密凭据库，缺失时返回空值，不回退读取或迁移旧明文文件。
- PaperReview 与 Quark 暂不进入默认目录：现有提交/查询/反馈、分享目录/转存入口
  会把可复用能力令牌放入模型结果或参数。完整来源保留，不增加配置或句柄存储机制。
- ONES 暂不进入默认目录：密码参数和令牌打印不符合宿主代输入及凭据边界。
  登录继续使用已有的通用代输入流程，不新增站点专用配置。
- Kimi 暂不进入默认目录：存储读取与 Cookie 诊断会把任意存储值或授权材料预览返回模型。
  完整来源保留，不新增秘密键猜测或凭据脱敏机制。
- 文章 stdout 输出改为 MCP 返回值；
  Readability 脚本随构建打包，避免安装包运行时查找源码文件。
- 主进程使用静态入口加载所选命令及其执行依赖，不在运行期动态导入模块；导入不执行命令。
- 适配器直接读取文件和分片上传也须通过宿主文件代理，复用原有上传目录、敏感文件和
  realpath 校验；文件检查复用同一代理的描述符，命名导入与别名导入均按任务解析。
  无会话目录或宿主文件代理时拒绝读取。ChatGPT 后端请求只发送自身域的 Cookie。
- 输入读取、stat 和存在性检查统一通过宿主核对身份的同一描述符；以 bigint dev/ino、
  普通文件及大小复核，读取有字节上限，拒绝和异常都关闭描述符。复制源也只返回批准字节的暂存副本；
  生产构建检查这些文件边界。上传在派发前把批准字节暂存到对应后端已有上传根下的调用目录，
  成功和失败均沿用调用 finally 清理，源文件保留；外部 Chrome 与内嵌浏览器使用相同的暂存入口。
- Desktop 不授予适配器直接写任务路径的能力，也不返回任务路径用于目录枚举；
  路径校验不能保证之后的 mkdir、write、rename 等操作不跟随被替换的链接，因此不为
  这些入口新增跨平台写入机制。17 条直接落盘命令暂缓，生成配方沿用已有链接分支，
  通用网页读取默认返回正文；发现与执行共用这些默认值，显式关闭上述模式在页面动作前拒绝。
  需要保存结果时使用已有宿主文件工具。调用内诊断、上传副本和转换结果继续可用，结束后清理。
- Instagram 图片转换、视频元数据、封面及 story 裁剪只读取批准字节的调用内副本，
  不重新打开原始源路径；临时输入及转换结果沿用同一调用目录，在成功或失败后清理。
- 抖音分片上传先批准并打开源文件，再创建远端上传；上传 ID 和进度只存于本次调用，
  不读写跨调用断点文件。初始化、分片、完成失败及成功都关闭源描述符，不自动重试。
- Midjourney 保留当前额度和批次估算，不读写历史监控快照；历史趋势字段返回空值，
  不因可选的历史存储不可用而丢掉已取得的当前额度或误报付费操作失败。
- 共享 Node 文件下载复用浏览器运行层的 SSRF fetch：首跳与每次重定向均检查协议、DNS/IP，
  连接固定在已校验的公网地址；跨 origin 移除鉴权头，正文结束或失败后释放连接。
  这条下载路径使用受保护的直连，不读取适配器的代理环境变量；需要代理的站点可沿用浏览器操作。
- 文章自动图片下载最多 20 张，每张 10 MiB，单篇累计接收 50 MiB（包含失败传输）；
  先检查响应长度，再在写入前检查实际流量。超出上限或下载失败的图片保留远程链接。
- 与配方按使用维护共用暂停状态：适配器参数预检失败不会暂停配方，执行失败才暂停；
  暂停记录可跨任务读取。修订仍须用带 guard/expect 的声明式步骤试跑成功后保存，
  不把适配器返回成功等同于通过页面与结果校验，也不自动重放写操作。

## 验证范围和运行条件

全量校验覆盖所有模块注册、ID、访问分类、可发现性、源文件摘要和生产 CJS 打包。
真实 Chrome 的隔离本地页面覆盖 evaluate、参数传递、输入、点击、连续 CDP、跨导航
网络捕获、截图及文章提取。它不代表 1,223 条命令都已在真实账号上逐一验收。
`--public-recipes` 额外通过真实浏览器执行六个 Cindy 配方的只读公开查询，核对结果身份，
而不只是判断请求成功；Crossref 同时检查关键词和 DOI 两种输入。
`RECIPE_CHECK_IDS` 可指定逗号分隔的配方 ID，仅复验发生变化的公开查询。

`check-opencli-bundle.mjs` 输出生产压缩后的独立适配器构建字节数与 gzip 字节数，
包含可达依赖，但不是完整安装包增量，也不包括 Cindy 的 JSON 配方。

站点登录、API 凭据、本机应用和下载工具等条件仍由各适配器要求；需要浏览器桥接特有的
可选能力仍受 Cindy 后端能力限制。Midjourney 下载命令与其他直接落盘命令暂缓，
生成仍可返回页面结果；完整来源不代表对应的本地写出能力已向适配器开放。不要为测试写命令对真实账号执行发布、
点赞、删除或付款。

## 下次同步

```sh
node scripts/sync-opencli-recipes.mjs /absolute/path/to/clean/opencli-checkout
node scripts/refresh-browser-recipe-aliases.mjs
pnpm install --no-frozen-lockfile
node scripts/check-opencli-recipes.mjs
node scripts/check-opencli-bundle.mjs
node scripts/verify-opencli-browser.mjs
pnpm --filter @cindy/mcps exec vitest run src/browser --maxWorkers=1
pnpm --filter @cindy/browser-control-runtime exec vitest run src/recipe-sessions.test.ts
pnpm licenses:generate
```

同步需要干净的上游 checkout，并拒绝覆盖已修改的 vendor 文件。真实浏览器检查默认使用
macOS Chrome，可用 `RECIPE_TEST_CHROME` 指定可执行文件；所有 profile 和构建测试产物
放在独立临时目录，检查结束后清理。许可证全量生成另需 Rust `cargo`。
