# 内置 OpenCLI 配方

来源：<https://github.com/jackwener/opencli>，Apache-2.0。
固定版本及逐文件 SHA-256 在 [UPSTREAM.json](UPSTREAM.json)；上游原始依赖声明保存在
[package.upstream.json](package.upstream.json)。本包为 Cindy 私有 workspace，不发布到 npm。

## 全量来源与 Cindy 默认目录

上游 `fe5f1d96aff01c32fd84f86b52af922bfe6ca93f`（2.0.2）：

- 170 个站点/应用，1,223 条命令（916 read、307 write）。
- 1,112 个命令模块，所有生产共享代码、JSON 和其他资源一并引入；不引入上游测试。
- 上游快照完整保留，但默认目录独立选择：排除 Z-Library 2 条、Slock 44 条、Claude.ai 9 条和 Spotify 11 条，
  剩余 1,157 条命令、25 个上游别名。原因记录在 [selection.json](cindy/selection.json)，
  同步会沿用此选择，排除条目不进入模块导入表和可执行目录。
- Cindy 原有 56 个 ID：47 个转到新版适配器，7 个保留原流程，两个爬虫练习站移至
  `packages/lizi-mcps/src/browser/recipe-examples`，不再出现在默认列表。
  逐项记录见 [legacy-coverage.json](cindy/legacy-coverage.json)。
- Cindy 独立增加 App Store 搜索、Google Play 搜索、TapTap 中国站游戏详情、Steam 玩家评价、
  Open Library 书目查询和 Crossref 文献/DOI 查询，共 6 个配方，位于
  `packages/lizi-mcps/src/browser/cindy-recipes`。共 1,242 个可发现 ID、172 份指南；这个数包含别名和兼容入口。
- 兼容入口保持输入名，输出改为新版结构化结果；用户本地覆盖层仍优先于内置层。

通过 `browser(action="siteguide")` 查询精简完整目录；传 `site`（域名或上游站点名）
取得参数类型、默认值及访问分类；执行使用 `recipeId="opencli:<site>/<command>"`。
完整的上游来源列表见 [cli-manifest.json](cli-manifest.json)，它不等于 Cindy 默认清单。

## Cindy 适配

`cindy/` 是宿主集成代码。原始文件的必要修改集中记录在 [patches.json](cindy/patches.json)，
同步时逐项精确匹配；上游变化导致补丁失效会报错。`UPSTREAM.json` 同时保存被改文件的
原始摘要及实际落地摘要。不要直接修改 `src/` 或 `clis/` 而不登记补丁。

- 浏览器操作使用 Cindy 当前任务、profile 和目标页；不启动 OpenCLI daemon/扩展。
- CDP 对象和节点沿用一次配方调用的连接；网络响应按上游格式捕获、读取后清空，结束时
  释放监听和连接。导航、上传仍走 Cindy 原有校验路径；代输入后的页面读取限制仍生效。
- 通用执行器不自动重放操作。Instagram reel 移除独立 daemon 和整次发布重试。
- Claude.ai 站点不进入默认目录，Claude 订阅沿用内置 Claude Code CLI 登录与使用。
- Spotify 暂不进入默认目录：客户端密钥的明文文件配置尚未接入宿主加密凭据库；
  保留完整来源，不增加新的凭据配置流程。小宇宙的新令牌只写宿主加密凭据库，
  既有配置只在显式执行时读取，不删除旧配置或新增明文令牌文件。
- 文章 stdout 输出改为 MCP 返回值；
  Readability 脚本随构建打包，避免安装包运行时查找源码文件。
- 主进程使用静态入口加载所选命令及其执行依赖，不在运行期动态导入模块；导入不执行命令。
- 适配器直接读取文件和分片上传也须通过宿主文件代理，复用原有上传目录、敏感文件和
  realpath 校验；无会话目录或宿主文件代理时拒绝读取。ChatGPT 后端请求只发送自身域的 Cookie。
- 图片、音频和下载成果的默认路径与目录参数元数据均使用任务内相对路径；
  诊断截图及跟踪文件按调用隔离，结束后清理，兼容 Windows。
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
可选能力（例如 Midjourney 社交视频/GIF 的浏览器下载完成事件）仍受 Cindy 后端能力限制，
会明确报错。普通文件/API 下载不依赖该可选能力。不要为测试写命令对真实账号执行发布、
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
