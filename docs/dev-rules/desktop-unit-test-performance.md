# Desktop 单测性能基准

> **读取时机**：调整 Desktop Vitest worker、测试分池或根级单测资源配额前

## 可复现命令

`benchmark:desktop-workers` 复用 `test-workspaces.config.mjs` 中 Desktop unit tier 的
完整排除规则，不会混入 DB、migration、guard 或 `*.bench.ts`。

```bash
pnpm benchmark:desktop-workers -- --workers 1,2,4,8 --runs 1 --output <report.json>
```

报告包含机器信息、墙钟、文件数、测试数、文件耗时 P50/P95/P99 和最慢文件。调整 worker
或分池前后必须使用同一 checkout、同一机器和同一测试范围比较；单次数据需同时保留稳定性
结果，不得只挑最快的一次。

## 2026-10-16 CI 关键路径与分片调整

数据来自 main 上两次成功的 client-ci（run 38819825618、38805666371，当时为 2 个分片）：

| Job | 总耗时 | 主要组成 |
| --- | --- | --- |
| Windows 分片 1/2 | 34.1–34.2 分钟 | 准备约 3；runner 自测 3.1–3.2；Desktop unit 20.9（1,253 秒）；Mobile 2.5；其余包 3.4；伴侣 DB 回归 0.9 |
| Windows 分片 2/2 | 21.9–25.7 分钟 | Desktop unit 16.9（1,013 秒） |
| Linux 分片 | 13.8–23.9 分钟 | Desktop unit 547–890 秒 |
| verify-checks | 7.7–8.4 分钟 | Desktop typecheck 3.4–3.8 |

- 关键路径是 Windows 分片 1，比分片 2 多 8–12 分钟：约 4 分钟来自只在分片 1 执行的 runner 自测和
  DB 回归，其余来自 Vitest 按文件路径哈希均分（不看耗时）造成的 Desktop 不均衡。
- 每个分片里 runner 先独占跑 Desktop，再独占跑 Mobile，最后并发跑其余包；Desktop 在 4 vCPU 的
  `windows-latest` 上用 4 个 worker。
- 初始删除候选只有约 7 秒 worker time；独立审查随后恢复了必要契约（见下文），最终删除范围
  更小。清理的目标是维护成本，不能把 CI 提速归因于减少测试条数。

2026-10-16 调整：Windows 与 Linux unit 都从 2 个分片改为 4 个；Windows runner 自测和伴侣 DB 回归
移到独立并行 job `windows-runner-checks`，由原必需检查 `Windows unit tests` 一并阻断。本仓是公开仓，
标准 runner 不计费。按上表估算，Windows 每片约为准备 3 分钟 + Desktop 9–11 分钟 + Mobile 与其余包
2–3 分钟，整条 CI 约 17–20 分钟。

首次四分片实测：PR #6196、head `433248f7ff` 的 client-ci run `38856774589` 全部通过。
Windows 四片为 809／1,006／812／661 秒，关键路径 16 分 46 秒，较原 34.1–34.2 分钟减少约 51%；
Linux 四片为 783／539／691／718 秒；独立 Windows runner/DB job 387 秒。此轮先于审查恢复必要
契约与同步主干，最终合并版本的 CI 还须单独核验，不能用这次结果代替。

Vitest 每片切 `ceil(文件数 / 分片数)` 个文件，分片多于 2 个时，文件少的包末尾分片可能为空（6 个文件
分 4 片是 2、2、2、0）。runner 原来只在「文件数少于分片数」时补 `--passWithNoTests`，本机 4/4 分片因此
有 6 个包报 `NO_TESTS_REQUIRED`；现已按 Vitest 的切分方式判断空分片。

审查恢复到 92 个 Desktop guard 文件后，Windows CI 暴露了另一个启动边界：逐项传递
exclude 会超过 `vitest.cmd` 的 8,191 字符限制，Desktop 尚未收集测试便退出。runner 和
`benchmark:desktop-workers` 现共用 Windows 的直接 Node 启动器，保留完整参数和工具 PATH；
Linux 及 package script 的启动方式不变。回归测试通过真实 runner 传入超过 8,191 字符的
排除列表并执行已有小型测试，同时验证空格、中文、引号与 shell 特殊字符原样到达子进程。

同轮审查补齐了 workspace `process.cwd()` 源码路径、本地 timeout 包装和常量时长检测，
并修正 `afterEach` 不应追溯影响首例的假时钟判断。源码读取按各自绑定区分用途：
送入 Function／VM 执行的生产回调继续留在 unit；同一读取还用于源码文字断言时仍须分层，
无关的执行不能豁免它。device-link client 的四处 ≥100ms 等待改用假时钟，288 条原有
用例整份通过，约 17.2 秒；未通过新增基线或删除结果断言来放行。

### 2026-10-16 实验与落地

本机 Windows、32 CPU、Desktop 8 worker。隔离方式三组用同一分片（869 个文件）连续对照：

| 实验 | 结果 | 结论 |
| --- | --- | --- |
| 基线：forks + 逐文件隔离 | 108.3 秒，0 失败 | — |
| `--no-isolate` | 83.0 秒（−23%），150 个文件／1,283 条用例失败 | 不采用：测试之间互相污染状态。**不要在真实 checkout 里用 `--no-isolate` 跑 Desktop 单测**：这次实验中 git／HOME 的 mock 泄漏，某个 worktree 测试在真实仓库对 `apps/desktop` 执行了 checkout，把未提交改动全部还原，还生成了 `apps/desktop/unused-test-home/` |
| `--pool=vmForks` | 80.0 秒（−26%），41 个文件失败 | 不采用：要逐个修复 VM 上下文差异 |
| `codexProxyHost.test.ts`：逐用例 `vi.resetModules()` 改为生产 `disposeCodexProxy()` 加启动注入复位 | 105 秒 → 6.7 秒，285/285；3 个随机顺序全过 | 已落地。原版在随机种子 1 下就失败（logger mock 跨用例累计），一并修复 |
| `maker-core` 用 1／2／4 个 worker | 248／125／65 秒，全过 | 已落地：独占运行、用满 worker，排在 Mobile 之后 |
| 单测分片 checkout 不拉全部历史 | 静态确认单测不读仓库历史 | 已落地，CI 每片约省 0.5 分钟（待 CI 实测） |
| 声明 jsdom 但没用 DOM 的文件 | 仅约 20 个，约 10 秒 worker 时间 | 不单独处理，写进性能预算 |

每片的 worker 时间里，收集（导入模块）约 325–350 秒，执行测试 250–480 秒，环境初始化 105–127 秒，
准备约 46 秒；后三项主要来自逐文件隔离。整体切换隔离方式会破坏正确性，所以改为逐个修掉开销最大的
文件，并用 `pnpm check:test-hygiene` 阻止新增逐用例重置、真实等待和普通单测读源码文本（存量计数
只减不增，见 engineering-conventions.md §3.2「性能预算」）。修完 `codexProxyHost` 后，最慢的
单个文件从 138 秒降到约 32 秒，不再由一个文件决定分片下限。

优化后按 CI 方式（runner、4 分片、Windows tar、无 `XDT_*`）完整重跑：门禁、`test:runner`、guard、typecheck
全部通过；4 个分片只有 `taskWorkspace.test.ts` 1 条 symlink 能力失败。各片 `maker-core` 从 71／21／54／108 秒
降到 34／5／27／55 秒；含 `codexProxyHost` 的 Desktop 分片从 144 秒降到 117 秒。代码没动的 Desktop 分片同时
慢了约 20%，说明本机（同时运行其他重负载程序）整片墙钟有 ±20% 的波动，收益以上表的同机连续对照为准，
这是初始实现的本机对照；最终合并版本以 PR CI 的完整复跑为准。

后续候选（每项都要在同一 runner、同一分片配置下实测后才能声称收益）：

- 按历史耗时分配分片（自定义 Vitest sequencer），拉平哈希均分造成的不均衡。
- 把 Windows checkout 与临时目录放到 Dev Drive（ReFS），降低大量小文件 IO 的开销。
- 基线中逐用例重置最多的 `newMakerDraft.test.ts`（54 处）、`modelVisibilityPrefs.test.ts`（18 处）、
  `pi-package-store-security.test.ts`（17 处）按 `codexProxyHost` 的方式改；真实 I/O 重的
  `llamaCppService`、`proxy-auth`、`updateService` 评估是否迁到专用 tier。
- PR 阶段只跑受影响的 workspace、合并队列跑全量：需要先修改上面「PR 门禁完整覆盖」的规则，由维护者决定。

## 2026-10-15 测试审计结果

对 499 个候选文件逐一审计：

- 初始删除 81 个文件（488 条用例）；独立审查发现其中包含缺少等价覆盖的权限、竞态、远程路由
  和设计契约，已恢复 30 个完整文件，并从 `homeUsageDashboardSource.test.ts` 保留账号隔离的 3 条
  契约（含同步主干时保留的 `botChatSurface.test.ts`）。后续逐文件复核另保留分享脱敏的两条契约、
  侧栏折叠时通知订阅归属的一条契约。随后将 Mobile 混合文件逐项行为化、合并必要原生契约，
  最终相对原始基线删除 54 个文件（包含已迁入其他文件的覆盖），
  不能沿用最初的「488 条无效用例」结论。
  `FileTreeView.horizontalScroll.test.tsx` 真实挂载组件并断言可见宽度，已恢复。
  IM 启动补全、空草稿水合与语音切换、预览误发送、远程扫描旧回包、图片标注误关闭、
  Orca 隐藏／可见时的通知生命周期，改由真实生产入口或组件行为回归覆盖。
  原生源码检测包含 Swift、C/C++、Rust 等；必要的跨原生协议、权限与生命周期契约进入
  required guard，执行脚本和 JSON／二进制资源不作为源码字面量断言。
- 初始审计的 207 个 PARTIAL 文件（2,874 条用例，其中约 991 条是静态或重复接线候选）与续跑、设备链、
  账户切换、Pi、权限和竞速回归混在一起，只能在补上等价的生产入口测试后逐项替换，不能按字符串模式
  批量删除。后续识别 workspace cwd 后，逐项将这类混合文件改为真实回调、组件或脚本执行；
  跨原生／JS、权限、凭证与竞态契约合并进已有 guard，纯布局字面量和已有真实覆盖的重复项才删除。
- 最初迁移 27 个静态契约文件；审查恢复与扫描器补漏后，Desktop 和 Mobile 的跨文件安全、权限、
  主题或文案契约统一迁到各自 `guard` allowlist，由 CI 的 `pnpm test:guard` 执行。最终名单只在
  `scripts/test-workspaces.config.mjs` 维护，由 runner 从 unit 排除；
  不要在 `apps/desktop/vitest.config.ts` 的项目 exclude 里重复排除，否则 guard 层自己也收集不到这些
  文件（2026-10-16 发现 29 个 allowlist 文件实际只跑了 2 个，已修复）。
- 缺少 timing 的文件是 `src/main/cindy-brain/__tests__/pluginModelPrefsIpc.test.ts`。

本机（Windows、32 CPU）按当时的 Desktop unit tier 实跑：3,448 个文件／53,987 条测试，53,814 通过、
168 跳过，墙钟 414.5 秒。5 条失败都是当前账户无法创建目录 symlink 的 EPERM 能力探测路径
（`taskWorkspace.test.ts` 1 条、`pluginNamespaceMigration.manager.test.ts` 4 条），需要在支持 symlink 的
Windows CI 或 Developer Mode 下复验，不能 skip 或删除。本机未分片的结果不能直接和 CI 分片耗时比较。

## 2026-07-26 Windows 基线

环境：Windows x64、Node v24.15.0、32 available CPUs、63.8 GiB RAM。测试范围为
1,213 个文件、13,062 个测试。

| Workers | 结果 | 墙钟 | 相比上一档 | 相比 1 worker |
|---:|---|---:|---:|---:|
| 1 | 通过 | 710.6s | — | 1.00x |
| 2 | 通过 | 353.7s | -50.2% | 2.01x |
| 4 | 通过 | 183.5s | -48.1% | 3.87x |
| 8 | 通过 | 108.3s | -41.0% | 6.56x |

8-worker 复跑为 114.9s，说明该档在本机约为 108–115s。2-worker 首次运行曾在 116.7s
触发一次 `ERR_IPC_CHANNEL_CLOSED`，重跑 353.7s 通过；worker 数降低本身不能消除
Vitest/tinypool fork 通道的偶发退出问题。

随着 workers 增加，所有文件自身耗时之和从 247.0s（1 worker）升至 317.5s（8
workers），说明存在资源争用；但墙钟仍持续下降。综合速度、资源和实现复杂度，正式配置
采用单池最多 8 workers；低于 8 CPU 的主机按 `os.availableParallelism()` 自动下调。

## 长尾分布

8-worker 复跑中，最慢 200 个文件按路径聚合：

| 路径 | 文件数 | 文件耗时之和 |
|---|---:|---:|
| `src/main/git-review/**` | 10 | 180.7s |
| `src/main/__tests__/**` | 27 | 49.7s |
| `src/renderer/**` | 92 | 31.8s |
| `src/main/hook-control/**` | 1 | 11.9s |

最慢的单文件主要是创建真实 Git 仓库或子进程的测试：

| 文件 | 8-worker 文件耗时 |
|---|---:|
| `git-review/__tests__/stageOps.test.ts` | 42.1s |
| `git-review/__tests__/pushOps.test.ts` | 28.6s |
| `git-review/__tests__/branchReader.test.ts` | 23.8s |
| `main/__tests__/codexFileRewindExecutor.test.ts` | 23.4s |
| `git-review/__tests__/ipc.test.ts` | 22.0s |
| `git-review/__tests__/diffReader.test.ts` | 19.5s |

因此分池优先按“真实 Git／子进程长尾”和“其余测试”隔离，而不是只按 node/jsdom 环境
机械拆分。

## 多 worktree 资源协调

Desktop 测试按成本拆成默认层与显式层：

- `standard`：普通单测，以及一条代表性的真实 Git smoke；默认 `test:unit` 只运行这一层。
- `git-integration`：文件名为 `*.git-integration.test.ts` 的完整真实 Git 覆盖，由
  `pnpm test:git-integration` 显式运行。Vitest 内部不再获取跨 worktree 资源锁。

远端 `client-ci` 以独立并行 job 在每个 PR、`main` push 和手动触发时运行完整
`git-integration` 层；本地按改动风险选测，默认入口为 `test:unit:related`。

同一仓库的多个 worktree 默认独立执行测试，不共享单任务配额。需要主动排队时，在根级
测试命令后传 `--lock`；它只协调同样选择排队的本地重型 runner，不能限制其它入口。
锁按 Git common-dir 区分 clone，只监听 `127.0.0.1`，退出后自动释放，等待上限为
15 分钟；CI 与 guard 不参与。`--no-lock` 仍接受为兼容参数，两个选项不能同时使用。
单次运行的 worker 默认值与并发限制保持不变，可按本机预算选择定向 Vitest 参数。

测试分层仍需满足：

- 两个 project 的 include/exclude 必须互补；默认层以低成本 smoke 守住主链路，完整层保留
  index、patch、hook、ref、worktree 等组合语义。
- Vitest 3.2 的 inline project 不会自动继承根 CLI 的 `--exclude`；配置必须把这些排除项
  显式传入两个 project，确保 unit、DB、migration 等 tier 的测试边界保持不变。

真实 Git 测试的 fixture 还应优先复用 `src/test/vitest/testDirectoryTemplate.ts`：每个测试
文件初始化一次不可变基准仓库，再为每个用例复制独立目录。默认层不复制完整矩阵；完整层
不得为了提速把需要验证 Git index、patch、hook 或 ref 语义的集成覆盖全部 mock 掉。

2026-07-28 在 Windows 上测得旧 `resource-intensive` 范围为 22 files、219 passed /
3 skipped，墙钟 252.07s；其中 15 个真实 Git 文件的测试耗时合计占主要长尾。该数据是拆层
前基线，后续比较必须分别报告默认 smoke 与显式完整层，不能把两者相加后宣称默认层变快。

## 分池评估

分池把 21 个 Git／子进程长尾文件放入 `git-io`，其余文件放入 `standard`；两个池并发，
且完整覆盖仍为 1,213 个文件、13,062 个测试。

| 配置 | 结果 | 总墙钟 | 说明 |
|---|---|---:|---|
| 单池 8 forks | 通过 | 108.3–114.9s | PR3 单池基线 |
| 3 forks + 5 forks | 通过 | 126.9s | standard 池成为长板 |
| 2 forks + 6 forks | 通过 | 111.6s | 与单池持平 |
| 2 threads + 6 forks | 通过 | 114.8s | standard 使用 threads 无收益 |
| 2 threads + 7 forks | 通过 | 111.1s | git-io 成为长板 |
| 3 threads + 7 forks | 连续两次通过 | 102.2–103.0s | 最快分池候选 |

另一次 `2 forks + 7 forks` 中，standard 池在 100.6s 完成，但 git-io 池触发
`ERR_IPC_CHANNEL_CLOSED`，因此不作为有效性能样本。

最快分池候选的平均墙钟为 102.6s：

- 相比现有单池 4 workers 的 183.5s，减少 80.9s（44.1%）。
- 相比单池 8 workers 的平均 111.6s，减少 9.0s（8.1%）。
- 但 worker 上限会从 8 提高到两池合计 10，并引入分区维护和双执行器复杂度。

因此分池相对单池 8 workers 的额外 8.1% 收益不足以抵消资源与维护成本，正式配置不采用
分池，保留单池最多 8 workers。
