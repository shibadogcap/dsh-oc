*[English](FEATURES.md) · [日本語](FEATURES.ja.md) · 中文*
# dsh-oc 功能支持矩阵

> 状态图例：✅ 已支持；🟡 部分支持/有限制；❌ 未实现或仅 stub。
> 本文件是功能状态入口；路由/协议细节见 [PROTOCOL.md](PROTOCOL.zh.md)。
> 运行 `pnpm run features:update` 可刷新文末“自动追踪”部分，手动状态矩阵保留。

## 当前状态与下一阶段

> 本表是用户可见能力的事实入口；已支持能力见下方矩阵，尚未发布的工作记录在
> [CHANGELOG.md](CHANGELOG.zh.md) 的 `Unreleased`。后续计划见 [ROADMAP.md](ROADMAP.zh.md)。

## 1. 模型

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Provider / 模型目录展示 | ✅ | `GET /api/provider`、`GET /api/model`、`src/bridge/convert/model.ts` | `tests/convert/model.spec.ts`、`scripts/e2e-api.sh` | `f30b156` |
| 默认 build agent 携带可用模型 | ✅ | `GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| 模型选择器回写 dsh（`/api/session/:id/model`） | ✅ | `POST /api/session/:sessionID/model`（body 携带 model） | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本提交 |
| Reasoning effort / variant 展示与切换 | ✅ | `Model.variants`、`ModelV2Info.variants`、session model `variant` | `tests/convert/model.spec.ts`、`tests/bridge-router.spec.ts`、`scripts/e2e-api.sh`、TUI `ctrl+t` | 本提交 |
| dsh agent preset 展示与切换（minimal 等） | ✅ | `GET /api/agent`、`POST /api/session/:sessionID/agent`、`POST /api/session/:id/command` `/preset` | `tests/bridge-router.spec.ts`；隔离 profile 无 minimal 时仅 build | 本提交 |
| Tab/`/preset` 切换 agent 随 prompt 生效 | ✅ | prompt 体 `agent` 应用到会话；已产生回复的会话被 dsh 锁定（409）时，首次提交后显示一次锁定提示；最终切换卡片带完成时间及实际模型/variant，不会持续 QUEUED | `tests/bridge-router.spec.ts`、真实 TUI 与用户手动验证 | `v0.2.0-rc.2` |
| 模型/Provider 错误映射 | ✅ | `src/bridge/errors.ts`、`src/bridge/rpc.ts` | `tests/bridge-router.spec.ts`（404/409/400/501） | `f30b156` |

## 2. 会话

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 会话列表 / 状态 | ✅ | `GET /api/session`、`POST /api/session/:id/wait` | `tests/bridge-router.spec.ts`、`e2e-api.sh` | `f30b156` |
| 会话列表标题回退 | ✅ | 持久标题 → 项目目录 basename → session id（对齐 dsh 客户端展示逻辑） | `tests/convert/session.spec.ts` | 本提交 |
| 会话列表真实标题补读 | ✅ | dsh `session.list` 不携带 title 投影；bridge 按会话补读 history tail 投影并缓存，列表显示真实标题（≤40 全量同步、大列表后台补温 24，不阻塞列表） | `tests/bridge-router.spec.ts`、`scripts/e2e-tui-turn.sh` | 本提交 |
| 会话搜索（v2 `?search=`）与 limit/目录过滤 | ✅ | `src/bridge/router.ts` `/api/session` 经 `session.search` | `tests/bridge-router.spec.ts` | 本提交 |
| 会话列表分页（v2 `cursor` next/previous + order） | ✅ | `src/bridge/router.ts` `/api/session` offset 游标 | `tests/bridge-router.spec.ts` | 本提交 |
| 新建 / 重命名 / 历史 / 消息 | ✅ | `POST /api/session`、`PATCH /api/session/:id`、`GET /api/session/:id/message` 等 | `tests/bridge-router.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| Prompt | ✅ | `POST /api/session/:sessionID/prompt`（body `text` 或 `parts`） | `e2e-api.sh`、`e2e-tui-turn.sh` | `f30b156` |
| `!` Shell mode（用户命令） | ✅ | 官方 TUI `!` → `POST /api/session/:id/shell`；经 Agent `runMaintenance` 独占 idle 后启动 OS shell，映射 user/assistant/tool 卡片，并经非唤醒 `Agent.inject()` 将用户手动命令/输出注入下一次模型 prompt | `tests/bridge-router.spec.ts`、`scripts/e2e-tui-shell.sh`、用户手动 TUI | `v0.2.0-rc.2` |
| `--mini` prompt 提交 | ✅ | `POST /api/session/:sessionID/prompt`（slash/模型/agent 处理） | `tests/bridge-router.spec.ts`、`e2e-tui-mini.sh` | 本提交 |
| Abort / cancel | ✅ | `POST /api/session/:id/interrupt` | `e2e-api.sh` | `f30b156` |
| Fork（`parentID`） | ✅ | `POST /api/session/:id/fork`，messageID→atSeq | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本提交 |
| 会话回退（revert） | ✅ | `POST /api/session/:sessionID/revert/stage`、`DELETE /api/session/:sessionID/revert`、`POST /api/session/:sessionID/revert/commit`；边界排他（边界消息及其后一并丢弃），stage 时按回合回滚文件并回报 diff，commit 以切点 fork dsh 会话且 opencode 会话 id 跟随 fork（别名），下一条 prompt 自动提交；会话记录带 `revert` 字段；SSE `session.revert.staged` / `.cleared` / `.committed` | `tests/contract/revert.spec.ts`、`tests/rewind/rewind.spec.ts` | 本提交 |
| 会话回退的已知限制 | 🟡 | dsh 表达不了空 fork（切点在第一条消息之前时返回 400 `cannot cut before the first message`）；文件 diff 是首尾改动行之间的一个粗 hunk（与 bridge 自身的文件改动 diff 同形），不是完整 LCS diff | `docs/PROTOCOL.md` 4.3 节 | 本提交 |
| Todo 投影 | ✅ | SSE `todo.updated`（2.x 无独立 todo GET 路由） | `tests/convert/todo.spec.ts`、`tests/bridge-router.spec.ts` | `f30b156` |
| Diff / produced-files / Modified Files | ✅ | `GET /api/session/:id/diff`、`session.diff` + Snapshot/Patch part | `tests/bridge-router.spec.ts`、`e2e-tui-tools.sh` | 本提交 |
| SSE 会话/消息事件 | ✅ | `GET /api/event`（首帧 `server.connected`）、`src/bridge/events.ts` | `tests/bridge-events.spec.ts`、`e2e-api.sh`、`e2e-tui-stream.sh` | `f30b156` |
| SSE 文本 delta 成对重复 | 🟡 | 已知行为：dsh 对同一文本同时下发 `assistant/chunk` 与 packed `text-chunks`，且新 mux 订阅会重放；bridge 的 delta 可能成对重复，TUI 以 `message.updated` 全量文本渲染、实测无重复显示 | `docs/PROTOCOL.md` | 本提交 |
| Agent/流错误 → `session.error` | ✅ | `stream/error` 与 `host/agent-error` 映射 | `tests/bridge-events.spec.ts` | 本提交 |
| SSE mux/host 短暂错误自动重连（指数退避） | ✅ | `src/bridge/router.ts` `startSse` 重订阅（默认 250ms 起、最多 3 次） | `tests/bridge-events.spec.ts` | 本提交 |
| 重连 approval/question 重放去重 | ✅ | `MuxEventTranslator` `replayGuard`（按 SSE 连接） | `tests/bridge-events.spec.ts` | 本提交 |
| 重连后 todo/goal 投影状态保留 | ✅ | `sharedState` 跨 translator 重建共享 | `tests/bridge-events.spec.ts` | 本提交 |

## 3. 工具

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Tool call / result 四态映射 | ✅ | `src/bridge/convert/tool.ts`、`src/bridge/events.ts` | `tests/convert/tool.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| 工具参数流式（`tool-call-delta` → input.started/delta/ended + v1 ToolPart 增量） | ✅ | `src/bridge/events.ts` `startToolInput`/`queueToolDelta`/`flushToolDelta` | `tests/bridge-events.spec.ts`、`scripts/e2e-api.sh` | 本提交 |
| 排队 prompt 可见（`session/queue` 初始化 + `agent/inbox/spliced` 增量 → QUEUED 消息） | ✅ | `src/bridge/events.ts` `queuedMessageEvents`、`src/bridge/state.ts` inbox 投影 | `tests/bridge-events.spec.ts`、`scripts/e2e-tui-queue.sh` | 本提交 |
| v2 tool 生命周期（called/progress/success/failed） | ✅ | `src/bridge/events.ts` `endToolInput`/`completeToolInputImmediately` | `tests/bridge-events.spec.ts`、`scripts/e2e-api.sh` | 本提交 |
| 高频 chunk 节流/批处理 | ✅ | `MuxEventTranslator` `toolFlushMs` + 合并 pending delta | `tests/bridge-events.spec.ts`（fake timer） | 本提交 |
| `!` shell 实时输出 progress | 🟡 | shell path 只在子进程结束后发布保留 stdout/stderr；每路 1MiB 上限，超出继续 drain 并标记截断 | `docs/PROTOCOL.md`、`tests/bridge-router.spec.ts` | `v0.2.0-rc.2` |
| 工具执行由 dsh 后端完成 | ✅ | 模型工具走 dsh tool 注册表；`!` shell 走用户授权的 OS 子进程并由 Agent maintenance 管理 | `e2e-api.sh`（bash 工具）、`tests/bridge-router.spec.ts` | `v0.2.0-rc.2` |
| read/write/edit 文件变化展示 | ✅ | tool result → ToolPart metadata/diff + `session.diff` + Modified Files | `tests/convert/tool.spec.ts`、`e2e-tui-tools.sh` | 本提交 |
| dsh 多种编辑模式映射（view/create/str_replace/insert/undo_edit） | ✅ | `src/bridge/convert/tool.ts` 映射为 read/edit 卡片并保留 mode | `tests/convert/tool.spec.ts`、`e2e-tui-tools.sh` | 本提交 |
| 文本附件/文件 part | ✅ | `src/bridge/router.ts` `filePartToContent`：data URL 文本/图片、cwd 内本地文件；cwd 外与二进制 400 | `tests/bridge-router.spec.ts`、`scripts/e2e-api.sh` | 本提交 |
| dsh profile 中以 `mcp-client` 配置的 MCP 服务器 | ✅ | `/api/mcp` 返回已把工具注册为 `mcp__<server>__<tool>` 的服务器 | `tests/bridge-mcp.spec.ts` | — |
| git 状态（分支、变更、diff） | ✅ | `src/bridge/vcs.ts` 只读读取 git；working 含未跟踪文件，branch/committed 使用 merge base | `tests/bridge-vcs.spec.ts` | — |
| integration 对话框的 provider 条目 | ✅ | `/api/integration` 返回有可用凭据的 provider；连接操作返回 400 | `tests/bridge-integration.spec.ts` | — |
| 默认 shell 设置 | ✅ | `PATCH /api/experimental/config` 保存到 `$DSH_HOME/opencode/config/opencode.json`；`GET /api/config/shell` 返回可选项 | `tests/bridge-config.spec.ts` | — |
| LSP / formatter 等外围工具 | ❌ | `src/bridge/stubs.ts` 返回 schema-valid 空数据 | `e2e-api.sh` 路由矩阵 | `f30b156` |

## 4. 权限

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Permission ask / once / reject | ✅ | `GET /api/permission/request`、`POST /api/session/{id}/permission/{rid}/reply`、`POST /api/permission/{rid}/reply` | `tests/convert/permission.spec.ts`、`e2e-api.sh` | `f30b156` |
| “Always” 会话内记忆（同会话同工具自动放行） | ✅ | `src/bridge/state.ts` `savedPermissions` + SSE 自动 approve | `tests/bridge-events.spec.ts`、`e2e-api.sh` | 本提交 |
| Saved permissions 查询/删除 | ✅ | `GET /api/permission/saved` + `DELETE /api/permission/saved/{id}`（`sessionID:toolName`），授权不跨会话泄漏 | `tests/bridge-events.spec.ts`、`scripts/e2e-api-permission.sh` | 本提交 |
| SDK v2 权限/提问 request 别名 | ✅ | `GET /api/permission/request`、`GET /api/question/request`、`GET /api/session/{id}/permission/{rid}` | `tests/bridge-router.spec.ts`、`scripts/e2e-api-permission.sh` | 本提交 |
| TUI 权限/提问键盘交互 | ✅ | 选项 Down 高亮移动、question Esc 取消、permission Esc=reject（standard 直接拒绝，mini 先弹确认层） | `scripts/e2e-tui-permission.sh`、`scripts/e2e-tui-permission-ext.sh` | 本提交 |

## 5. 子代理

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 主 agent（build）展示 | ✅ | `GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| Background subagents | ✅ | `GET /experimental/capabilities` 返回 `{ backgroundSubagents: true }`；`POST /experimental/session/{id}/background` no-op 成功（dsh 会话服务端常驻、`subagent` 默认后台） | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本提交 |
| 子代理会话树 / parent-child 渲染 | ✅ | `Session.parentID`、child cwd/parent 继承、child 历史复用 | `tests/convert/session.spec.ts`、`e2e-api.sh` fork lineage | 本提交 |
| 原生 OpenCode Task 子代理卡片 | ✅ | dsh `subagent*` → `tool: task`，child `sessionId` metadata 与 parent lineage 保留 | `tests/bridge-events.spec.ts`、`tests/bridge-router.spec.ts`、`scripts/e2e-tui-subagent.sh` | `v0.2.0-rc.1` |

## 6. 命令

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 命令列表 | ✅ | `GET /api/command` 注册 `/preset` `/goal` `/help` | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本提交 |
| `/goal` 创建/查看/切换 | ✅ | `src/bridge/router.ts` `runGoalCommand` + dsh command registry | `tests/bridge-router.spec.ts`、`scripts/e2e-api-goal.sh` | 本提交 |
| `/goal` 生命周期（complete/pause/resume/clear） | ✅ | `complete` 走 `goal.complete` RPC，其余走 registry | `tests/bridge-router.spec.ts`、`scripts/e2e-api-goal.sh` | 本提交 |
| TUI `/help` 能力摘要 | ✅ | `src/help.ts` `ocHelp` + `runHelpCommand`（不触发模型轮次） | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本提交 |
| TUI `/help` pane e2e | ✅ | `scripts/e2e-tui-command.sh` 输入 `/help` 断言摘要可见 | `bash scripts/e2e-tui-command.sh` | 本提交 |
| `/compact` / summarize | ✅ | `POST /api/session/:id/compact` | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本提交 |
| Skills 目录 | ✅ | `GET /api/skill` 经 dsh `skill.list`（按目录匹配会话；无会话返回 `[]`） | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本提交 |
| Skills 斜杠命令 | ✅ | `/command` 暴露技能名；命令路由转 `session.prompt` 的 `/name` 路径 | `tests/bridge-router.spec.ts` | 本提交 |
| 技能斜杠命令 TUI e2e | ✅ | `scripts/e2e-tui-skill.sh`（`DSH_OC_E2E_FAKE_SKILLS` 注入 + 真实键盘输入） | `bash scripts/e2e-tui-skill.sh` | 本提交 |
| References / integrations | ❌ | `GET /api/reference`、`GET /api/integration` 等返回 schema-valid `[]` | `e2e-api.sh` | `f30b156` |

## 7. TUI

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| `opencode --server` 启动/退出/信号转发 | ✅ | `src/tui/index.ts` `startOpenCodeTui`（`--mini` → `opencode mini --server`） | `tests/tui/index.spec.ts`、`e2e-tui-boot.sh` | `f30b156` |
| TUI 参数过滤（`--session/--dir/--mini/--print-logs/...`） | ✅ | `src/tui/index.ts` `filterSupportedArgs`；`--dir` 同步写入 bridge cwd | `tests/tui/index.spec.ts`、`scripts/e2e-tui-dir.sh` | 本提交 |
| `--dir` 路径校验 | ✅ | `resolveTuiDir`：不存在/非目录时明确报错 | `tests/tui/index.spec.ts` | 本提交 |
| 数据隔离（config/data/state/cache 在 `$DSH_HOME/opencode`） | ✅ | `src/tui/index.ts` `buildChildEnv` | `tests/tui/index.spec.ts` | `f30b156` |
| 消息时间戳默认开启 | ✅ | `DSH_OC_TUI_TIMESTAMPS=1` → `kv.json` `timestamps: show` + `tui.json` 快捷键 | `tests/tui/index.spec.ts`、`scripts/e2e-tui-timestamps.sh` | 本提交 |
| 时间戳运行时切换 | ✅ | `tui.json` 绑定 `session_toggle_timestamps` / `messages_toggle_timestamps` 为 `ctrl+shift+t`，也可用 `/timestamps` | 手工 TUI 验证 | 本提交 |
| 二进制版本校验（`--version` 精确匹配 + 显式覆盖报错） | ✅ | `src/tui/binary.ts` `parseOpenCodeVersion`/`verifyOpenCodeVersion` | `tests/tui/binary.spec.ts`、`scripts/e2e-tui-version-lock.sh` | 本提交 |
| 自动更新/热更新关闭 | ✅ | `OPENCODE_DISABLE_AUTOUPDATE=1` + 隔离配置 `autoupdate: false` | `tests/tui/index.spec.ts`、`scripts/e2e-tui-offline.sh` | 本提交 |
| 后台外网行为关闭（models fetch / LSP download） | ✅ | `OPENCODE_DISABLE_MODELS_FETCH=1`、`OPENCODE_DISABLE_LSP_DOWNLOAD=1` | `tests/tui/index.spec.ts` | 本提交 |
| `dsh --profile oc --help` 能力摘要 | ✅ | `src/tui/index.ts` `ocHelp`/`helpRequested` | `tests/tui/index.spec.ts`、`scripts/e2e-tui-help.sh` | 本提交 |
| DSH OC 品牌启动 logo（替换 OpenCode 字符画） | ✅ | `tui-branding/` TUI 插件（figlet 生成，`scripts/generate-tui-branding-art.mjs`）+ `prepareOpenCodeTuiState` 注入 `tui.json` | `tests/tui/branding-art.spec.ts`、`tests/tui/index.spec.ts`、`scripts/e2e-tui-brand.sh` | 本提交 |

## 8. 分发

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 多 arch 平台矩阵（linux/darwin/windows × x64/arm64 + musl/baseline） | ✅ | `src/tui/platform.ts` | `tests/tui/platform.spec.ts`、`tests/scaffold.spec.ts` | 本提交 |
| 官方 npm 平台包优先（`@opencode/cli-<platform>-<arch>[-baseline][-musl]@2.1.0`） | ✅ | `src/tui/binary.ts` `npmPackage*`、`$DSH_HOME/opencode/packages/<key>` | `tests/tui/binary.spec.ts`（候选顺序/回退） | 本提交 |
| GitHub Release fallback 按平台独立 `sha256` 校验 | ❌ | 2.1.0 迁移已删除 `opencode-assets.json` 与该 fallback，改为只从 npm 平台包取二进制 | `tests/tui/download.spec.ts`、`tests/scaffold.spec.ts` | 本提交 |
| 代理 / 镜像 | ✅ | `src/tui/download.ts` `resolveAssetUrl` | `tests/tui/download.spec.ts` | `f30b156` |

## 9. 测试

| 功能 | 状态 | 实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 单元/转换/桥/分发测试 | ✅ | `tests/**/*.spec.ts` | `pnpm test` | `f30b156` |
| API e2e 路由矩阵 + 权限流 | ✅ | `scripts/e2e-api.sh` | `bash scripts/e2e-api.sh` | `f30b156` |
| TUI boot / turn / stream e2e | ✅ | `scripts/e2e-tui-boot.sh`、`scripts/e2e-tui-turn.sh`、`scripts/e2e-tui-stream.sh` | 对应脚本输出 `PASSED` | `f30b156` |
| TUI 时间戳 e2e | ✅ | `scripts/e2e-tui-timestamps.sh` | `bash scripts/e2e-tui-timestamps.sh` | 本提交 |
| 离线启动 / 版本锁定 e2e | ✅ | `scripts/e2e-tui-offline.sh`、`scripts/e2e-tui-version-lock.sh` | 对应脚本输出 `PASSED` | 本提交 |
| Help e2e | ✅ | `scripts/e2e-tui-help.sh` | `bash scripts/e2e-tui-help.sh` | 本提交 |
| 品牌 logo e2e | ✅ | `scripts/e2e-tui-brand.sh` | `bash scripts/e2e-tui-brand.sh` | 本提交 |
| `--dir` TUI e2e | ✅ | `scripts/e2e-tui-dir.sh` | `bash scripts/e2e-tui-dir.sh` | 本提交 |
| `--dir` 相对路径 e2e | ✅ | `scripts/e2e-tui-dir.sh` 使用相对 `sub-project` | `bash scripts/e2e-tui-dir.sh` | 本提交 |
| `--dir` 目录过滤 e2e | ✅ | `scripts/e2e-tui-dir-filter.sh`：新会话落在子目录、根会话被过滤 | `bash scripts/e2e-tui-dir-filter.sh` | 本提交 |
| `--fork --session` TUI e2e | ✅ | `scripts/e2e-tui-fork.sh` | `bash scripts/e2e-tui-fork.sh` | 本提交 |
| `--continue` TUI e2e | ✅ | `scripts/e2e-tui-continue.sh`（恢复最新会话） | `bash scripts/e2e-tui-continue.sh` | 本提交 |
| `--mini` TUI + 回复 e2e | ✅ | `scripts/e2e-tui-mini.sh`：输入 prompt、断言回复且只渲染一次 | `bash scripts/e2e-tui-mini.sh` | 本提交 |
| 退出 splash 说明（全量/`--mini`） | 🟡 | 官方二进制渲染，无法替换；会话有内容（新输入或恢复历史）时 dsh-oc 在下方补一行提示（id 为 dsh 会话 id，恢复用 `dsh --profile oc --session`） | `tests/bridge-router.spec.ts`、`scripts/e2e-tui-mini.sh` | 本提交 |
| Esc 打断/取消（全量/`--mini`） | ✅ | `turn.wait`/`turn.idle` 事件驱动 TUI 运行态；`POST /api/session/:id/interrupt` → `session.cancel` 停止在途流（全量与 mini 均按两次 Esc） | `tests/bridge-events.spec.ts`、`scripts/e2e-tui-abort.sh` | 本提交 |
| 新会话继承最近 preset | ✅ | `/preset X` 选择记录到 bridge 状态，`/new` 创建的新会话沿用该 preset（工具集随之变化） | `tests/bridge-router.spec.ts` | 本提交 |
| `--print-logs` 透传 e2e | ✅ | `scripts/e2e-tui-print-logs.sh`（fake 二进制 argv 断言） | `bash scripts/e2e-tui-print-logs.sh` | 本提交 |
| 协议探针（路由清单 + 二进制/SDK 版本校验） | ✅ | `scripts/probe-opencode.mjs`、`tests/fixtures/opencode/routes.json` | `pnpm run probe`、`tests/protocol-probe.spec.ts` | 本提交 |
| 一键自测入口 | ✅ | `scripts/check-all.sh`（typecheck+单测+探针+性能冒烟；`--e2e` 全量 e2e；`--scale N` 压测） | `bash scripts/check-all.sh` | 本提交 |
| GitHub Actions CI | ✅ | `.github/workflows/ci.yml`（自动）+ `.github/workflows/e2e.yml`（手动全量 e2e/压测） | 推送/PR 自动 + workflow_dispatch | 本提交 |
| 流式工具事件 API e2e | ✅ | `scripts/e2e-api.sh` 审批流断言 started/delta/called/success | `bash scripts/e2e-api.sh` | 本提交 |
| 功能矩阵自动追踪 | ✅ | `scripts/update-feature-matrix.mjs` | `pnpm run features:update` | 本提交 |
| 会话性能测试（生成器 + 指标 + 报告） | ✅ | `scripts/perf.mjs` + `scripts/perf-session-gen.mjs`（dsh Session API 合成日志、zstd 分帧写入） | `pnpm run perf`、`tests/perf.spec.ts` | 本提交 |
| 大会话性能验证（200/1000/5000/10000） | ✅ | `docs/perf/results-2026-08-15.md`：SSE 防抖 + list/history 短 TTL 缓存 + 上游瓶颈记录 | `pnpm run perf -- --sessions 10000` | 本提交 |
| 历史读取在途合并与派生页缓存 | ✅ | 并发调用/启动预取共享同一次 `session.list`/`session.history` RPC；full tail 与 100 条页互相派生，TUI 打开会话只扫描一次 | `tests/bridge-router.spec.ts` | 本提交 |
| perf 生成器单测（编码/round-trip/子代理场景） | ✅ | `tests/perf.spec.ts` | `pnpm test` | 本提交 |

## 10. 浏览器与 Web UI

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 官方 OpenCode Web UI 与 API 同源提供 | ✅ | `src/bridge/web-ui.ts`：opencode 二进制里的 AppArchive 解到 `$DSH_HOME/opencode/web-ui/<version>/`（`DSH_OC_WEB_UI` 优先）；未匹配路由的 `GET`/`HEAD` 回落到 SPA shell，`_assets/`、`icons/` 缺失 404 | `tests/bridge-web-ui.spec.ts` | 本提交 |
| 官方 Web UI 的浏览器实测 | 🟡 | 服务已就绪、官方 2.1.0 客户端能订阅 `/api/event`；本机没有真实浏览器，交互验证未做 | 需在有浏览器的环境手工验证 | 本提交 |
| CORS 策略（对齐官方 server） | ✅ | `src/bridge/http.ts` `isAllowedCorsOrigin`/`corsHeaders`：localhost、127.0.0.1、`oc://renderer`、tauri 源、`*.opencode.ai`，加上 `DSH_OC_CORS`；回显请求 origin 并带 `Access-Control-Allow-Credentials: true` | `tests/bridge-cors.spec.ts` | 本提交 |
| 项目列表（bridge 工作目录） | ✅ | `GET /api/project`、`GET /api/project/:projectID`、`PATCH /api/project/:projectID`（`projectInfo`；PATCH 只回显不落盘） | `tests/bridge-web-ui.spec.ts` | 本提交 |
| SSE 心跳（防客户端判定流已死） | ✅ | `src/bridge/sse.ts` 每 15 秒写一帧 `: heartbeat\n\n`（官方 server 同样式） | 暂无单测覆盖 | 本提交 |
| SSE status 快照有界 | ✅ | `src/bridge/router.ts` `SESSION_STATUS_SNAPSHOT_LIMIT = 20`（运行中的会话 + 最近触碰的会话） | 暂无单测覆盖 | 本提交 |
| HTTP 请求追踪 | ✅ | `DSH_OC_HTTP_LOG=1` → stderr 逐行 `[bridge/http] <METHOD> <path>` | 手工验证 | 本提交 |

<!-- FEATURES:AUTO:START -->
## 自动追踪（脚本生成）

> 运行 `pnpm run features:update` 重新生成。生成时 HEAD：`37ed71d`（2026-10-22）。

### 路由注册表

来自 `src/bridge/router.ts` 与 `src/bridge/stubs.ts` 的注册路由；`for` 循环展开的 `/command`、`/skill`、`/reference`、`/integration` 及 `/api/*` 对偶路由会在路由源码中以 `register` 动态注册，此处列出已解析的字面量 + stub 路由。

| Method | Route | Kind | 来源 |
|---|---|---|---|
| `GET` | `/experimental/capabilities` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/console` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/resource` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace/status` | json | `src/bridge/stubs.ts` |
| `GET` | `/formatter` | json | `src/bridge/stubs.ts` |
| `GET` | `/lsp` | json | `src/bridge/stubs.ts` |
| `GET` | `/mcp` | json | `src/bridge/stubs.ts` |

### 测试覆盖

| 测试文件 | 用例数 | 最后更新 |
|---|---|---|
| `tests/bin.spec.ts` | 5 | 050803b chore(release): bump version to 0.1.0 for first release |
| `tests/bridge-config.spec.ts` | 4 | — |
| `tests/bridge-cors.spec.ts` | 6 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-errors.spec.ts` | 1 | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `tests/bridge-events.spec.ts` | 89 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-fs.spec.ts` | 5 | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `tests/bridge-git.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-integration.spec.ts` | 3 | — |
| `tests/bridge-mcp.spec.ts` | 3 | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `tests/bridge-model.spec.ts` | 5 | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `tests/bridge-router.spec.ts` | 138 | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `tests/bridge-vcs.spec.ts` | 6 | — |
| `tests/bridge-web-ui.spec.ts` | 9 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/client.spec.ts` | 12 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/events.spec.ts` | 19 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/revert.spec.ts` | 8 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/routes.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/goal.spec.ts` | 5 | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `tests/convert/message.spec.ts` | 9 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/model.spec.ts` | 6 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/permission.spec.ts` | 4 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/question.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/session.spec.ts` | 8 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/todo.spec.ts` | 3 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/tool.spec.ts` | 19 | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `tests/e2e/events.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/e2e/openchamber.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/e2e/revert.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/perf.spec.ts` | 5 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/protocol-probe.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/replay-corpus.spec.ts` | 2 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/rewind/rewind.spec.ts` | 12 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/scaffold.spec.ts` | 10 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/binary.spec.ts` | 18 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/branding-art.spec.ts` | 3 | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `tests/tui/download.spec.ts` | 5 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/index.spec.ts` | 39 | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `tests/tui/platform.spec.ts` | 7 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |

### 关键实现最后更新

| 文件 | 最后更新 |
|---|---|
| `src/bridge/config-store.ts` | — |
| `src/bridge/convert/common.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/goal.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/message.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/model.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/convert/permission.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/question.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/session.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/todo.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/tool.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/wire.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/dsh-types.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/errors.ts` | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `src/bridge/events-util.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/events.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/file-uploads.ts` | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `src/bridge/fs.ts` | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `src/bridge/git.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/http.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/index.ts` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `src/bridge/router-entry.ts` | 6928f8a feat(bridge): expose router entry and add minimal-server renderer attribution |
| `src/bridge/router.ts` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `src/bridge/routes.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/boot.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/routes/fs.ts` | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `src/bridge/routes/session-v2-extra.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/session-v2.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/routes/v2-client-compat.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/v2-shapes.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/v2-stubs.ts` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `src/bridge/routes/vcs.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/rpc.ts` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `src/bridge/shell.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/sse.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/state.ts` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `src/bridge/stubs.ts` | c281121 feat(bridge): serve real git info, status and diffs over /vcs |
| `src/bridge/vcs.ts` | — |
| `src/bridge/web-ui.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/help.ts` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `src/index.ts` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `src/rewind/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/binary.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/brand.ts` | eba383f feat(tui): print DSH OC brand before --mini launches |
| `src/tui/download.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/index.ts` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `src/tui/node-undici.d.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/platform.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/temp.ts` | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `src/types.ts` | 153f781 feat(tui): show exit hint for resumed sessions with history, not only new input |
| `scripts/audit-local-sessions.sh` | fb50dbe fix(perf): write v3 session generation filenames |
| `scripts/build-replay-corpus.mjs` | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `scripts/check-all.sh` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `scripts/check-client-routes.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/check-docs-i18n.mjs` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `scripts/cleanup-e2e-runs.sh` | ec31177 chore: add e2e run directory cleanup script |
| `scripts/cleanup-merged-branches.sh` | 2f1ab51 chore(scripts): enumerate remote merged branches for cleanup |
| `scripts/e2e-api-attachment.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api-goal.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api-permission.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-cli-bin.sh` | e1817df test(e2e): assert dsh-oc --version dual output in cli-bin suite |
| `scripts/e2e-golden-trace.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-install-rollback.sh` | dacd2a2 chore(release): prepare v0.2.0-rc.3 |
| `scripts/e2e-minimal-server-repro.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-openchamber-bootstrap.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-openchamber.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-queued-order-repro.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-real-llm.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-real-queued-order.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-consistency.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-crash.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-sse-reconnect.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-revert-flow.mjs` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `scripts/e2e-tui-abort.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-agent-lock.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-agent-tab.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-boot.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-brand.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-command.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-continue.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-dir-filter.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-dir.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-fork.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-goal-command.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-goal.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-help.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-mini.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-offline.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission-ext.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission-mini.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-preset-inherit.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-print-logs.sh` | 7561559 test(e2e): assert --log-level value passthrough to opencode child |
| `scripts/e2e-tui-queue-live.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-queue.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-shell.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-skill.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-stream.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-subagent.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-timestamps.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-tools.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-turn.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-version-lock.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/extract-opencode-web-ui.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/flake-mini-scan.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/generate-tui-branding-art.mjs` | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `scripts/minimal-oc-server.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/monitor-process-io.sh` | d94f52e fix(e2e): harden permission waits and monitor output |
| `scripts/normalize-golden-trace.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/perf-session-gen.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/perf.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/probe-opencode.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/replay-corpus-manifest.mjs` | fb50dbe fix(perf): write v3 session generation filenames |
| `scripts/replay-session-audit.sh` | 54c9c31 test(bridge): add reusable real-session replay audit script |
| `scripts/scan-release-artifact-paths.sh` | f5f016f test(release): harden CI verification |
| `scripts/update-feature-matrix.mjs` | 37ed71d feat: three-language docs, MCP visibility, fork-based usage |
| `scripts/update-local-install.sh` | db87e31 fix(release): verify local dsh-oc resolution |
| `scripts/update-opencode-assets.mjs` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
| `scripts/upgrade-lane.sh` | 81effdd feat(tui): add candidate opencode upgrade lane with golden trace diff |
| `scripts/verify-release-artifacts.sh` | 3ed10a7 fix(release): invoke tsdown directly in artifact rebuild |
<!-- FEATURES:AUTO:END -->
