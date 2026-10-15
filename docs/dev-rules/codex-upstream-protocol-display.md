# Codex 上游协议的外层显示

Issue #6015。只记录这次验证过的显示事实，不改变请求协议语义。

## 根因

Codex 页签上方的说明写死为 settings.providers.custom.protocol.codexDesc，里面始终写着使用 OpenAI Responses。内部协议按钮读取已保存的 wireProtocol，所以重开后按钮可以是 Chat Completions，外层说明仍是 Responses。保存链路没有把 Chat 丢回去。

## 采用的显示来源

非模板的 Codex 页签，外层说明改为当前上游协议，文案键与内部按钮相同，来自 customProviderCodexWireProtocolOption(wireProtocol).labelKey。未保存过的默认值仍是 Responses。模板连接仍显示模板名，不在这里改协议选择器。

## 验证

2026-10-15，worktree .cindy-worktrees/issue-6015，基线 bae229a5a。

pnpm --filter desktop exec vitest run src/renderer/components/settings/__tests__/CustomProviderDialogAccessibility.test.tsx

64 项通过。其中 keeps the outer Codex summary on the saved upstream protocol 覆盖了：保存为 Chat 后重开，外层与按钮都是 Chat；切回 Responses 后两边都是 Responses；再切回 Chat 后仍一致；新建 Codex 默认仍是 Responses。

## 未验证

2026-10-15 在隔离开发版 Cindy-dev2-issue6015 里打开 Electron。新建供应商后切到 Codex：默认外层和按钮都是 OpenAI Responses（原生）。改成 Chat Completions 后外层立刻变成 Chat Completions（Cindy 桥接）。保存、回到供应商列表、再编辑连接，两边仍是 Chat。再改回 Responses 并保存重开，两边都是 Responses。没有发真实上游请求，没有改模型级显式覆盖。Windows 未测。
