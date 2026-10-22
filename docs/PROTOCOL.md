# OpenCode TUI 协议探针与兼容矩阵

> 本文件是 `PLAN.md` 的配套文档。执行 P0 前必须先读本文件。
> 功能状态入口：先读 [FEATURES.md](FEATURES.md)，再回到本文件核对路由/协议细节。
> 探针基准：`@opencode/cli@2.1.0`（GitHub Release `v2.1.0`，commit `4643e65`）。

## 0.2.0-rc.4 实现基线

当前 prerelease 面向 dsh `>=0.1.5-rc.2`。下文早期表格中保留的 `apiProxy` 字样是历史
设计来源；当前实现已完成 PR #1/#2/#3 的语义重整合，不再依赖
`@deepseek-ai/dsh-host-apiproxy`：

RC.2 包含 Issue #4 的 `POST /api/session/:id/shell`；RC.3 补齐官方 TUI prompt 顶层
`variant` 的 reasoning effort 同步；RC.4 适配 dsh 0.1.5 的 host ABI 与 assistant
流式模型（见 §11）。

- Session/list/history/prompt/cancel/model/fork/rename 直连
  `sessionController`；agent/preset、goal、skill 分别直连对应 host services。
- SSE 由 `session/event`、`agent/assistant-stream`、
  `sessionController.control`、approval/question answerer 事件翻译组成；不再消费旧
  `apiProxy.events.mux()` envelope。
- `POST /api/session/:id/wait` 使用 dsh `api-session/status` 的内存 authoritative map，
  冷启动最多一次 `session.list` seed，避免 TUI 等待轮询触发全库 I/O。
- SSE 客户端支持有界 `Last-Event-ID` ring 回放；游标淘汰时只回放当前
  status/control snapshot，不扫描 history。

---

## 1. 协议基线：OpenCode 2.1.0 单代实现

dsh-oc bridge 只实现 **OpenCode 2.1.0** 一套 HTTP 协议：

- 官方 client（`@opencode/client@2.1.0`）调用的一切都在 `/api/*` 下。
- OpenCode 1.x 的 `/session`、`/config`、`/provider`、`/global/event` 等前缀路由已全部删除，
  仓库不再依赖 `@opencode-ai/sdk@1.18.18` 的类型；`src/bridge/convert/wire.ts` 用本地结构类型
  描述 SSE 通道仍在使用的 1.x 形状投影。
- `node scripts/check-client-routes.mjs` 以官方 client chunk 为准，校验 bridge 注册的路由集合
  覆盖全部客户端路由（`missing: 0`）。

---

## 2. 探针方法（可复现）

### 2.1 准备

```bash
# 安装官方二进制
npm pack @opencode/cli@2.1.0
# 或者直接解包 node_modules/@opencode/cli/bin/opencode.exe

# clone opencode 源码用于对照
git clone --depth 50 https://github.com/anomalyco/opencode.git ../opencode
git -C ../opencode checkout 4643e65
```

### 2.2 记录 TUI 启动请求

```bash
# 1. 启动真实 opencode server（只用于录协议，不是 dsh-oc 运行时）
DEEPSEEK_API_KEY=test \
OPENCODE_CONFIG_CONTENT='{"provider":{"deepseek":{"options":{"baseURL":"http://127.0.0.1:19876","apiKey":"test-key"}}},"enabled_providers":["deepseek"],"model":"deepseek/deepseek-chat","autoupdate":false,"share":"disabled"}' \
opencode serve --port 4097

# 2. 启动日志代理：19877 -> 127.0.0.1:4097，打印 method/url/headers/status
node tools/log-proxy.mjs

# 3. PTY 中启动 TUI（2.x 用全局 --server 指向 bridge；--mini 走 mini 子命令）
script -qec "opencode --server http://127.0.0.1:19877" /dev/null
script -qec "opencode mini --server http://127.0.0.1:19877" /dev/null

# 4. 抓取 /api/event SSE 与各响应 body，存为 tests/fixtures/opencode/
```

### 2.3 抓取 schema

权威 schema 来源：

- `../opencode/packages/sdk/openapi.json`
- `../opencode/packages/sdk/js/src/v2/gen/types.gen.ts`（生成后）
- npm 包 `@opencode/client@2.1.0` 的 `dist/promise/generated/types.d.ts`

---

## 3. 实测启动路由清单（P0 必须全部响应）

`opencode --server` 启动阶段真实请求（记录于 2026-08-15，TTY 环境；1.x 前缀路由已删除）：

```text
GET /experimental/capabilities
GET /experimental/console
GET /api/event                           # SSE 长连接
GET /api/location
GET /api/agent
GET /api/integration
GET /api/model
GET /api/provider
GET /api/reference
GET /api/command
GET /api/skill
GET /lsp
GET /mcp
GET /experimental/resource
GET /formatter
GET /experimental/workspace
GET /experimental/workspace/status
GET /api/model?location[directory]=...
GET /api/provider?location[directory]=...
GET /api/reference
GET /api/integration?location[directory]=...
```

> 不同目录/工作区模式下还会重复请求 `/api/model`、`/api/provider` 若干次。实现必须幂等。

---

## 4. 路由分类

图例：

- **MAP**：必须翻译到 dsh 服务。
- **STUB**：返回 schema-valid 空数据。
- **LATER**：首版可 501/空，但记录在测试中。

### 4.1 非 `/api` 路由

OpenCode 1.x 的前缀路由（`/session`、`/config`、`/provider`、`/agent`、`/command`、
`/skill`、`/permission`、`/question`、`/vcs`、`/global/event` …）已全部删除。下面只剩
TUI 启动期探测用的 stub 与生命周期端点。

| 路由 | 分类 | dsh 数据源 / stub 形状 |
|---|---|---|
| `GET /lsp` | STUB | `[]` |
| `GET /mcp` | STUB | `{}` |
| `GET /formatter` | STUB | `[]` |
| `GET /experimental/resource` | STUB | `[]` |
| `GET /experimental/console` | STUB | `{ consoleManagedProviders: [], switchableOrgCount: 0 }` |
| `GET /experimental/capabilities` | MAP | `{ backgroundSubagents: true }`（dsh 后台子代理真实可用） |
| `POST /experimental/session/{id}/background` | MAP | no-op 成功 `true`（dsh 会话服务端常驻） |
| `GET /experimental/workspace` | STUB | `[]` |
| `GET /experimental/workspace/status` | STUB | 空状态 |
| 其他未列路由 | LATER | 501 或 schema-valid 空响应 |

> **Web UI 回落**：bridge 持有官方 Web UI 时（见 4.4 节），匹配不到任何路由的
> `GET` / `HEAD` 请求由 Web UI 兜底；没有 Web UI 时仍是 501。

### 用户 `!` Shell mode

官方 OpenCode 在输入框按 `!` 进入 shell mode，提交时发送
`POST /api/session/{id}/shell`。请求体必须包含非空 `command`；`agent` 可选，缺省时用
session 当前 agent。`agent` 必须是当前 session 的 agent（若指定），且必须是可用 preset；
空值、不匹配或不可用 agent 返回 400。该路由成功时返回 204，可见卡片走 SSE。

工作目录只通过 query `directory` 传入（不是 `cwd`，也不是 body 的 `workdir`）：
已记录的 session cwd 优先；只有冷启动尚未记录 session cwd 时才使用该 query 值，
相对 query 路径相对 bridge cwd 解析，绝对路径直接使用；无 query 时回退 bridge
cwd。`--dir` 改变 bridge cwd，但不会覆盖已记录的 session cwd。

dsh-oc 通过 dsh Agent 的 `runMaintenance` 取得真实 idle ownership；随后以当前 OS
用户身份启动 shell，因为用户显式输入 `!` 才是此路径的授权边界。POSIX 仅在
`$SHELL` 是绝对路径时使用它，否则回退 `/bin/sh`；Windows 使用 `ComSpec`，缺失
时回退 `cmd.exe`。该路径不宣称 dsh model-tool approval 或 sandbox 保护，也不伪造
dsh turn/tool 持久事件。SSE 先发布 running tool part，完成后发布 completed/error
tool part、authoritative idle status 与恰好一次 `session.idle`。
stdout/stderr 每路最多保留 1 MiB；超过后继续读取并在输出中写入截断标记，不会因
输出量超过阈值主动 kill 子进程。
该 shell path 只在子进程结束后发布保留输出，不提供实时 stdout/stderr 流。

`POST /api/session/{id}/interrupt` 会先中止该 bridge/session 登记的精确 shell
子进程/进程组，随后仍调用 dsh `session.cancel`；不会按进程名搜索或结束其他进程。
POSIX 终止自有 process group；Windows 终止自有 PID 的 `taskkill /T` 树，并不把
Windows shell 伪装成 dsh `pwsh` sandbox。

这里刻意不调用 `ctx.tools.execute({ agent, name: 'bash' })`：dsh-tools 在 PTC
presentation 下会把 model-direct root bash 判为 `UNKNOWN_TOOL`，而其 nested
parent token 只能由真实 `run_code` transport 创建，bridge 不能伪造；同时
dsh-user-approval 的 `approval.request()` 要求 open turn，shell maintenance
本身不是 model turn。因此没有一个合法的 user-shell host seam 可以同时声称
model-tool approval/sandbox 语义，bridge 采用上游同等的显式用户授权 + 精确子进程
归属，并在缺少 `Agent.runMaintenance` ABI 时明确报错。

该请求不属于模型 agent-loop 的 turn/step，因此不能伪造 dsh `tool/call` /
`tool/result` 持久事件；完成卡片只保存在每 session 有界的 bridge 内存 command-result
store（最近 20 条），不会写入 dsh durable history。它会注入
`GET /api/session/{id}/message` 的 hydration；不会注入
`/api/session/{id}/history`、`/context` 或单条 `/message/{messageID}`，这些接口只
返回 durable dsh history。命令完成后，bridge 通过 dsh Agent 的 `inject()` 追加一条
非唤醒的 plugin context（`plugin: dsh-oc`、`form: notice`），内容明确标注为“用户手动
执行的命令”以及 stdout/stderr、截断标记和退出状态；模型注入有独立的 UTF-8 预算：
命令最多 16 KiB、stdout/stderr 各最多 64 KiB，完整 context 文本最多约 144 KiB；TUI
工具卡仍保留每路 1 MiB 的显示预算。shell 输出会发送给当前配置的模型，命令或输出
可能含 token、密码、个人数据等敏感信息，使用者必须先确认再执行 `!`。若注入失败，
shell 卡仍会 completed，但输出会追加 `[dsh-oc] ... was not added to model context`。
该 context 首先持久化为合法的 dsh `agent/inbox/spliced`（`next-step` pending）事件，
只有在后续 step claim 后才进入该 step 的 model request；注入本身不会唤醒 Agent、不会
打开新的 turn，也不会自动触发模型回复。对同一 session，下一次真实 prompt 保证能看到
该 context（除非 session 被清理）；重启/恢复会重建尚未 claim 的 inbox。claim 后如发生
compaction，dsh 可能摘要或丢弃逐字原文，因此不保证压缩后仍逐字长期保留。
若 Agent 已有 turn/maintenance，接口返回 409；若 session 不存在返回 404；缺少/非法
`agent` 或空 command 返回 400。

### 4.2 v2 `/api` 路由

| 路由 | 分类 | dsh 数据源 / stub 形状 |
|---|---|---|
| `GET /api/location` | MAP | `{ directory: cwd }` |
| `GET /api/health` | MAP | `{ healthy: true }`（客户端探活） |
| `GET /api/project` | MAP | 裸 `Project[]`：bridge 的工作目录（`projectInfo`） |
| `GET /api/project/{projectID}` | MAP | 裸 `Project`；id 不匹配 404 |
| `PATCH /api/project/{projectID}` | MAP | 裸 `Project`（当前只回显，不落盘）；id 不匹配 404 |
| `GET /api/agent` | STUB/LATER | `[]` |
| `GET /api/integration` | STUB | `[]` |
| `GET /api/model` | MAP | `sessionController.modelCatalog` |
| `GET /api/provider` | MAP | `sessionController.modelCatalog` providers |
| `GET /api/provider/{id}` | MAP | 单 provider `{ location, data: ProviderV2Info }`；未找到 404 |
| `GET /api/reference` | STUB | `[]` |
| `GET /api/command` | MAP | 注册 `/preset`、`/goal`、`/help` |
| `GET /api/skill` | STUB/LATER | `[]` |
| `GET /api/session` | MAP | `sessionController.list`（分页 + `cursor`） |
| `GET /experimental/session` | MAP | GlobalSession 列表（搜索/目录过滤/limit 子集，复用 `convertSessionSummary`） |
| `GET /api/session/active` | MAP | 当前活动会话，仅当实际 `running` 时返回 `{ data: { [sessionId]: { type: "running" } } }`，否则 `{}` |
| `POST /api/session/{id}/wait` | MAP | 等待 agent 循环空闲：≤30s 轮询 `session.list`，空闲 204、超时 503、会话不存在 404 |
| `POST /api/session` | MAP | `sessionController.create` |
| `POST /api/session/{id}/fork` | MAP | `sessionController.fork`（client 的 `before` 是**排他**边界：只复制该消息之前的消息），返回 v2 信封 |
| `POST /api/session/{id}/compact` | MAP | dsh `/compact` command registry（SDK v2 路由，204） |
| `POST /api/session/{id}/interrupt` | MAP | `sessionController.cancel` + 中止该 session 登记的 shell 子进程（SDK v2 打断入口） |
| `GET /api/session/{id}` | MAP | history + summary；subagent child 保留 `parentID` 与 `metadata.origin`（即使 SDK v2 生成类型未声明该扩展字段） |
| `GET /api/session/{id}/message` | MAP | `sessionController.follow/page` history；`cursor.previous` 提供上一页锚点 |
| `GET /api/session/{id}/history` | MAP | v2 历史分页：`limit` + `after`（独占上界，映射 dsh `beforeSeq` 向后翻页），返回 `{ data, hasMore, next }` |
| `GET /api/session/{id}/context` | MAP | `{ data: SessionMessage[] }`（复用 v2 消息转换，无游标） |
| `GET /api/session/{id}/message/{messageID}` | MAP | `{ data: SessionMessage }` 单条查询；未找到 404 |
| `POST /api/session/{id}/prompt` | MAP | `sessionController.prompt`（`id` 可选；slash 命令经 command registry） |
| `POST /api/session/{id}/model` | MAP | v2 模型选择（含 `variant`，`reconcileModelSelection` 兜底） |
| `POST /api/session/{id}/agent` | MAP | v2 agent 切换（`switchAgentPreset` + 广播 `session.updated`） |
| `POST /api/session/{id}/revert/stage` | MAP | 记录**排他**边界 `{ messageID }`，返回 `{ data: { messageID, files? } }`；同时把边界之后的回合改过的文件就地回滚 |
| `DELETE /api/session/{id}/revert` | MAP | 清除已暂存的边界，并把 stage 时回滚的文件放回原状（204） |
| `POST /api/session/{id}/revert/commit` | MAP | 以边界消息之前一个事件为切点 fork（排他：边界消息及其之后的消息都被丢弃），opencode 会话 id 之后指向该 fork；保留已回滚的文件（204） |
| `GET /api/session/{id}/event` | MAP | 按会话过滤的 SSE 事件流（`/api/event` 子集） |
| `GET /api/session/{id}/permission` | MAP | pending approvals per session |
| `GET /api/session/{id}/permission/{rid}` | MAP | 单条 pending approval（session 不匹配 404） |
| `POST /api/session/{id}/permission/{rid}/reply` | MAP | approval answerer |
| `GET /api/session/{id}/question` | MAP | pending questions per session |
| `POST /api/session/{id}/question/{rid}/reply` | MAP | question answerer |
| `POST /api/session/{id}/question/{rid}/reject` | MAP | question answerer cancelled |
| `GET /api/permission/request` | MAP | SDK v2 全局 pending approvals 别名，`{ location, data }` |
| `GET /api/question/request` | MAP | SDK v2 全局 pending questions 别名，`{ location, data }` |
| `GET /api/permission/saved` | MAP | 内存中的 always 授权列表（`PermissionSavedInfo` + `sessionID/grantedAt`） |
| `DELETE /api/permission/saved/{id}` | MAP | 删除 `sessionID:toolName` 内存授权（不存在 404） |
| `GET /api/fs/read/{path}` | MAP | 读取工作区内文件原始字节（`*` 通配路径，越界 400，上限 5 MiB） |
| `GET /api/fs/list` | MAP | 列目录（`{ location, data: FileSystemEntry[] }`，目录优先） |
| `GET /api/fs/find` | MAP | 递归查找（query/type/limit，跳过依赖与构建目录） |
| `GET /global/health` | MAP | `{ healthy: true, version }` |
| `POST /global/dispose` / `POST /instance/dispose` | MAP | no-op 确认 `true`（dsh 拥有进程生命周期） |
| 其他未列路由 | LATER | 501 或 schema-valid 空响应 |

> `after` 为**独占上界**：返回事件 seq 严格小于 `after` 的消息页，`next`
> 为本页最旧锚点 seq（供独立客户端连续向前翻页）；`after` 非负整数否则
> 400。分页边界会切开工具回合时，跨页游标保证无漏页/重页（恢复 e2e 覆盖）。

### 4.3 会话回退（revert）

OpenCode 2.1.0 的回退分三步：先 stage 记下边界，再由用户确认，最后 commit。
边界是**排他**的：被指定的那条消息以及它之后的消息，在 commit 生效时一并消失。

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/session/{id}/revert/stage` | `{ messageID, files? }` | `200 { data: { messageID, files? } }` |
| `DELETE /api/session/{id}/revert` | — | `204` |
| `POST /api/session/{id}/revert/commit` | — | `204` |

- stage：边界消息在 dsh 事件日志里的位置（`R.locateMessage`）同时定出它属于哪个
  回合。响应里的 `files` 是这次回退会影响的文件的 diff，每项是 `FileDiffInfo`
  （`file` / `patch` / `additions` / `deletions` / `status`）；请求体里的 `files`
  被忽略，diff 由 bridge 自己的文件快照算出。diff 在回滚**之前**计算，回滚之后
  文件已经是旧内容，diff 会变空。stage 随即把这些文件回滚到改动前的内容
  （`restoreFilesAfter`），工作区立刻显示回退后的状态；回滚前的当前内容被留着，
  `clear` 把文件放回原状（`undoRestore`），`commit` 保留回滚结果（`commitRestore`）。
- 文件集合按回合分组（`src/rewind/` 的 copy-on-write 快照，按 `turn/start` 归组）。
  回滚范围是边界消息所在回合**之后**的回合；边界消息是用户 prompt 时，它自己
  那一回合的文件也跟着回滚（`includeTurn: true`，因为 assistant 回复在 prompt
  之后），边界消息是 assistant 回复时不回滚本回合（`includeTurn: false`）。
- commit：dsh 的 `sessionController.fork` 复制的是**包含** `atSeq` 的事件前缀，
  而 OpenCode 的边界是排他的，所以切点取边界消息之前一个事件
  （`R.atSeqBeforeMessage`）。切点之后的消息（包含边界消息本身）不会出现在新
  会话里。
- `POST /api/session/{id}/fork` 的 `before` 同样是排他语义，走同一个切点计算
  （fork 出来的会话里没有 `before` 指的那条消息）；它不建立别名，fork 出来的是
  一个新的会话 id。
- commit 之后**会话 id 不变**：bridge 在 opencode 会话 id 与 fork 的 dsh id 之间
  记一条别名（`InteractionState.setSessionAlias`），于是
  - 之后所有 dsh 调用都被改写到 fork（`rpc()` 里的 `resolveSessionPayload`）；
  - 会话列表把 fork 以**原来的 opencode id** 发布，被替换掉的那条会话从列表里
    消失；
  - `GET /api/session/{id}` 与 `GET /api/session/{id}/message` 读到的是 fork 的
    摘要与历史；
  - fork 的 SSE 事件被改写回原来的 opencode id（`mapEventSessionId`）；
  - 会话级状态（模型、agent preset、标题、消息 id 映射）复制到 fork 上
    （`inheritSessionState`），客户端看到的消息 id 不变。
- 提交时机：和 OpenCode 一样，下一条 prompt 到达时先提交已暂存的回退
  （`POST /api/session/{id}/prompt` 先调 `commitStagedRevert`），prompt 随后落到
  改写后的会话里；`POST /api/session/{id}/revert/commit` 是同一条路径的显式入口。
- 会话记录上带已暂存的边界：`Session.Info.revert = { messageID, files? }`
  （`GET /api/session/{id}` 可见；commit 或 clear 之后消失）。
- 错误：`messageID` 缺失 → 400；消息不在历史里 → 400 `message not found for
  fork`；切点在第一条消息之前 → 400 `cannot cut before the first message`（dsh 的
  `atSeq` 必须是非负整数，表达不了空 fork）。
- 已知限制：文件 diff 是首尾改动行之间的**一个粗 hunk**（和 bridge 自己的文件
  改动 diff 同一形状），不是完整的 LCS diff；`files` 列表出现在 stage 响应与会话
  记录上，官方 TUI 会渲染它。

### 4.4 官方 Web UI（与 API 同源）

官方 `opencode serve` 把 API 和 Web UI 放在同一个源上：浏览器里的 UI 用
`location.origin` 访问 API，因此既不需要 CORS 也不需要登录。dsh-oc 的 bridge
照搬这个设置（`src/bridge/web-ui.ts`）。

- 官方 opencode 二进制把 Web UI 打成一段 `AppArchive`（opencode 源码
  `packages/cli/src/app-archive.ts`）：小端 u32 的 JSON 索引字节长度、索引本身
  （每个资产的 `[offset, length]`）、以及 brotli 压缩的资产本体。
- bridge 把这段归档解一次到 `$DSH_HOME/opencode/web-ui/<version>/`（`<version>`
  是锁定的 opencode 版本，当前 `2.1.0`），之后由 bridge 自己提供这些文件。
- 目录查找顺序：`DSH_OC_WEB_UI` 指定的目录 → `$DSH_HOME/opencode/web-ui/<version>/`。
  指定目录里没有 `index.html` 时视为未设置。
- 二进制只被**查找**，不会被 bridge 安装：TUI 插件本来就要装 opencode 二进制，
  所以 Web UI 从下一次启动起就出现。找不到二进制时不提供 Web UI，API 不受影响。
- `scripts/extract-opencode-web-ui.mjs` 可以离线把资产抽到任意目录
  （`node scripts/extract-opencode-web-ui.mjs --bin <opencode 二进制> --out <目录>`）。

路由行为（`src/bridge/http.ts` 的回落 + `src/bridge/web-ui.ts`）：

| 请求 | 响应 |
|---|---|
| 匹配到 API 路由 | API 响应（优先级最高） |
| 匹配不到任何路由的 `GET` / `HEAD` | Web UI 的 `index.html`（单页应用，未知路径也是 shell） |
| `_assets/`、`icons/` 下不存在的文件 | 404 |
| 其它方法的未匹配路由 | 501 `not implemented by oc-bridge` |

> 注意：回落不区分 `/api/` 前缀，所以未注册的 `/api/*` 路径在有 Web UI 时拿到
> 的是 SPA shell，而不是 JSON 的 404。

静态文件头：`content-type` 按扩展名给（与官方服务器同一套类型表）；
`index.html` / `sw.js` / `registerSW.js` 是 `cache-control: no-cache`，其余是
`public, max-age=31536000, immutable`；带 `x-content-type-options: nosniff`。
越出 Web UI 目录的路径不提供服务。

> **实测状态**：Web UI 能被服务，官方 OpenCode 2.1.0 客户端（Node，不是浏览器）
> 能订阅 bridge 的 `/api/event`，约 40 ms 收到 `server.connected`。本机没有真实
> 浏览器，所以**没有**在真实浏览器里做过交互验证。

### 4.5 CORS 策略

`src/bridge/http.ts` 的 `isAllowedCorsOrigin()` / `corsHeaders()` 与官方
opencode 服务器（源码 `packages/server/src/cors.ts`）保持一致：

- 始终允许 `http://localhost:<port>` 与 `http://127.0.0.1:<port>`；
- 始终允许 `oc://renderer`、tauri 的源（`tauri://localhost`、
  `http://tauri.localhost`、`https://tauri.localhost`）以及 `*.opencode.ai`；
- 另有 `DSH_OC_CORS`（逗号分隔）列出的源，对应官方服务器的 `cors` 选项，
  用于局域网上的浏览器 UI。

允许时响应回显请求自己的 `Origin`，并带：

```text
Access-Control-Allow-Origin: <请求的 origin>
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Last-Event-ID
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

不允许的源不带任何 CORS 头；`OPTIONS` 预检直接回 204。没有 `Origin` 头的请求
（非浏览器客户端）按同源处理，回 `*`。

> 旧实现一律回 `Access-Control-Allow-Origin: *`，带凭据的请求会被浏览器拒绝
> （"credentialed request requires Access-Control-Allow-Origin '<origin>'"），
> 浏览器 UI 因此完全连不上。

### 4.6 请求追踪

`DSH_OC_HTTP_LOG=1` 让 bridge 把每个 HTTP 请求打到 stderr：

```text
[bridge/http] GET /api/info
[bridge/http] GET /api/event
```

行在请求到达时写出，所以长连接（SSE）也会出现。这是在没有浏览器的环境里
确认浏览器 UI 调用模式的调试手段。

---

## 5. SSE 事件映射表

当前 dsh 0.1.2 由 Cordis `session/event`、`sessionController.control` 与
approval/question answerer 产出 host frames，oc-bridge 翻译为 opencode
`GlobalEvent`；旧版 `apiProxy.events.mux()` 仅作为历史协议来源。

| DSH mux frame | opencode GlobalEvent |
|---|---|
| `session/event: session/created` | `session.created`（properties.sessionID, info=Session） |
| `session/event: session/title` | `session.updated` |
| `session/event: turn/start` | `session.status`（busy） |
| `session/event: turn/end` | `session.status`（idle） + `session.idle` |
| `session/event: user/message` | 重建 Session 后发 `message.updated` |
| `session/event: assistant/message` | `message.updated` + `message.part.updated` |
| `session/event: assistant/chunk (tool-call-delta)` | `session.next.tool.input.started/delta/ended` + v1 ToolPart 增量（节流合并） |
| `session/event: tool/call` | `session.next.tool.called` + `progress` + `message.part.updated`（ToolPart pending；dsh `subagent*` 为 OpenCode `task`） |
| `session/event: tool/result` | `session.next.tool.success/failed` + `message.part.updated`（ToolPart completed/error；Task child `sessionId` 从 host child lineage 关联，不依赖 result meta） |
| `session/event: todo/write` | `todo.updated` |
| `session/event: goal/change` | `todo.updated`（合并 goal 为首条） |
| `session/event: approval/asked\|decided` | 持久化记录，bridge 静默（权限交互由 mux 帧 `approval/requested\|resolved` 驱动） |
| `approval/requested` | `permission.asked` |
| `approval/resolved` | `permission.replied` |
| `question/requested` | `question.asked` |
| `question/resolved` | `question.replied` / `question.rejected` |
| `session/projection: todos` | `todo.updated` |
| `session/projection: goal` | `todo.updated`（合并 goal 为首条） |
| `session/projection: produced-files` | `session.diff` |
| `session/queue`（订阅初始化） | 首次为该 session 时镜像 pending inbox → 每条用户消息 `message.updated` + `message.part.updated`（TUI 显示 QUEUED） |
| `session/event: agent/inbox/spliced` | 增量：插入用户消息 → `message.updated`；`outcome: canceled` 移除 → `message.removed`；claim（无 outcome）不删除，等 `user/message` 同 id upsert |
| `session/jobs` | 忽略 |

> **Task 子代理关联**：内置 OpenCode TUI 读取 1.18.18 形状的
> `ToolPart.state.input.description` / `subagent_type` 渲染 Task，并读取
> `ToolPart.state.metadata.sessionId` 导航 child。
> dsh `api-session/added`、`subagent/descriptor` 与 `subagent` projection 可能跨
> session 到达，bridge 按 parent pending call 做暂存，历史则按 label/FIFO
> 做 parent-local 绑定；所有 child 的 v1/v2 Session 与 `session.updated` 替换都保留
> `parentID` 与 `metadata.origin`。

> **排队消息可见性**：bridge 丢弃旧的 `session/queue` 会导致排队中的 prompt 在
> TUI 无任何反馈，用户以为发送失败而重发，队列积压后模型回复旧消息。现在
> `session/queue` 只做首次投影（全量帧无法区分 claim 与 cancel），后续由
> `agent/inbox/spliced` 增量维护；含未完成工具调用的 assistant 消息不设置
> `time.completed`，`step/end`/`turn/end` 时再补，让官方 TUI 的 QUEUED 判定
> （最后一个未完成 assistant 之后的用户消息）生效。

> **prompt 送达语义（steer）**：用户 prompt 一律以 dsh `session.prompt`
> `mode: 'steer'` 提交（等价官方 opencode“追加进会话流、运行中 loop 下一步
> 即处理”的语义）。运行中的 turn 在下一个 step 边界就能看到插入的消息，
> 而不是像 `mode: 'queue'` 那样要等整轮结束（曾导致用户在长搜索轮中插入
> 标题/纠正信息后，模型继续空转数分钟才看到，见 session e0336d8b）。
> 多条排队消息会在下一个 step 按序合并进同一次请求；QUEUED 徽标仍由 TUI
> 按时间线自行判定。

> **已知行为（文本 delta 成对重复）**：旧 dsh/dcp rc.6 对同一段流式文本同时下发
> `assistant/chunk`（text-delta）与 packed `text-chunks` 两种编码，且新 mux 订阅
> 会先重放历史再进入实时，因此 bridge 的 `message.part.delta` 可能把同一字符发送
> 两次（两种编码分块/偏移不同，无法无损合并）。内置 TUI 以最终
> `message.updated` 的全量文本为准，实测渲染正常、无重复；`e2e-tui-abort.sh` 的
> v2 段按“新 SSE 流出现 delta”检测，不依赖 delta 文本连续性。

GlobalEvent 必需字段：

```ts
{
  directory: string,
  project?: string,
  workspace?: string,
  payload: { id: string, type: ..., properties: ... }
}
```

> **流首帧契约**：2.x 客户端拒绝不以 `server.connected` 开头的事件流，因此
> `GET /api/event`（以及带 session 过滤的 `GET /api/session/{id}/event`）建连后总是
> 先发一帧 `server.connected`，再做 `Last-Event-ID` 回放与 status/control snapshot
> 重放。`server.connected` 不进入 ring，也不占用回放游标。

### 5.1 OpenCode 2.x 原生事件词汇（OpenChamber 2.5 读取）

内置 TUI 读 `payload.type` + `payload.properties`；OpenChamber 2.5 读的是
OpenCode 2.x 的原生词汇（`session.text.delta`、`session.tool.called`…），它不认
`message.updated` / `message.part.updated`。因此同一个 SSE 连接同时发布两套投影：

* `payload.properties` 保持 1.18.18 形状（TUI 路径不变）。
* `payload.data` 是 2.x 形状；SSE 顶层另外平铺 `id`/`created`/`type`/`durable`/
  `location`/`data`，2.x 客户端不必理解 1.18.18 的 wrapper 就能解析。
* 两套词汇同名的事件（`session.status`、`session.idle`、`permission.replied`）
  只需要一份事件：`data` 本身就是 2.x 形状。
* `permission.asked` 两套形状不同，同一事件的 `properties` 给 TUI、
  `data` 给 2.x 客户端。

dsh → 2.x 的映射：

| dsh 来源 | 2.x 事件 |
|---|---|
| `turn/start` | `session.execution.started` |
| `turn/end`（completed / max-tokens） | `session.execution.succeeded` |
| `turn/end`（error） | `session.execution.failed`（`error: {type, message}`） |
| `turn/end`（aborted / blocked） | `session.execution.interrupted`（`reason: user\|superseded\|shutdown`） |
| assistant step 开始 | `session.step.started`（`assistantMessageID`/`agent`/`model`） |
| assistant step 结束 | `session.step.ended`（`finish`/`cost`/`tokens`）；被打断的 step 发 `session.step.failed` |
| 文本块 | `session.text.started` / `.delta` / `.ended` |
| 推理块 | `session.reasoning.started` / `.delta` / `.ended` |
| 工具入参 | `session.tool.input.started` / `.delta` / `.ended` + `session.tool.called` |
| 工具结果 | `session.tool.success` / `session.tool.failed`（+ `session.tool.progress`） |
| 用户消息被接受 / 被投递 | `session.inbox.enqueued` / `session.inbox.delivered` |
| 会话已知 / 改名 | `session.created` / `session.renamed` |
| preset / 模型切换 | `session.agent.selected` / `session.model.selected` |
| 审批请求 / 答复 | `permission.asked` / `permission.replied` |
| 提问 / 答复 / 取消 | `form.created` / `form.replied` / `form.cancelled` |
| 压缩 | `session.compaction.started` / `.delta` / `.ended` |
| 客户端驱动的回退（stage / clear / commit） | `session.revert.staged` / `session.revert.cleared` / `session.revert.committed` |

`ordinal` 是文本块、推理块各自在 assistant message 内的序号（从 0 开始，两类分开
计数）；`assistantMessageID` 是 bridge 的 provisional assistant message id，与
1.18.18 的 `message.updated` 用的是同一个 id。

回退的三个事件没有 dsh 对应物（回退由客户端驱动），由 revert 路由直接发布：

| 事件 | `data` |
|---|---|
| `session.revert.staged` | `{ sessionID, revert: { messageID, files? } }` |
| `session.revert.cleared` | `{ sessionID }` |
| `session.revert.committed` | `{ sessionID, to }`（`to` 是边界消息 id） |

> 回退提交后，会话被切到 fork 上，fork 的事件带的是新的 dsh 会话 id；bridge 在
> 广播前把这些 id 改写回客户端认识的那个 opencode 会话 id（`mapEventSessionId`），
> 所以客户端侧看到的会话 id 全程不变。

### 5.2 心跳与 status 快照

- **心跳**：`SseHub` 每 15 秒给每个连接写一帧官方服务器同样的注释帧
  `: heartbeat\n\n`（官方实现在 `packages/server/src/handlers/event.ts`）。
  没有心跳时，安静会话的流看起来像断了：官方客户端会以 "Event stream stalled"
  断开并重连，OpenChamber 的上游读取器 20 秒就放弃，两者都会陷入重连循环。
  注释帧对所有 SSE 解析器都是透明的，但算作"收到了数据"。心跳定时器
  `unref`，不会单独吊住进程。
- **status 快照有界**：SSE 建连时 `replaySessionStatusSnapshot()` 回放
  `session.status`，告诉重连的客户端哪些会话在忙。上限是
  `SESSION_STATUS_SNAPSHOT_LIMIT = 20`：先给运行中的会话，剩下的名额按
  `sessionStatusUpdatedAt` 给最近动过的会话。旧实现把 bridge 见过的一切会话
  都报一遍，官方 Web UI 每次连接都要读几百条会话记录，初始加载永远结束不了。

---

## 6. opencode 关键类型位置

以下类型是实现 `convert/*` 的权威依据：

```text
@opencode/client/dist/promise/generated/types.d.ts:
  SessionInfo, SessionMessageInfo, SessionMessageUser,
  SessionMessageAssistant, SessionMessageAssistantText,
  SessionMessageAssistantReasoning, SessionMessageAssistantTool,
  ModelInfo, ProviderInfo, ModelRef, AgentInfo, CommandInfo,
  PermissionRequest, FormInfo, SessionStatus, FileDiffInfo
```

SSE 通道仍在发布的 1.x 形状投影（`message.updated` / `message.part.updated` /
`session.updated`）没有 2.1.0 对应类型，由 `src/bridge/convert/wire.ts` 的本地结构类型
描述：`WireMessageInfo`、`WirePart`、`WireToolPart`、`WireSessionInfo`。

dsh 类型位置：

```text
deepseek-harness/packages/core/session/src/types.ts:
  SessionEvent, SessionEventMap, SurfaceOp, UserMessage, AssistantMessage
deepseek-harness/packages/host/apiproxy/src/api/:
  sessions.ts, events.ts, llm.ts, approvals.ts, questions.ts, rpc.ts
deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:
  createApiProxy / ApiProxyService
```

---

## 7. opencode 二进制来源

`opencode-assets.json` 已随 2.1.0 迁移删除，仓库不再维护自建的 asset manifest。
2.x 的官方分发只有 npm 平台包 `@opencode/cli-<platform>-<arch>[-baseline][-musl]`，
dsh-oc 按平台惰性安装这些包来取得二进制。

```text
env DSH_OC_OPENCODE_BIN → 版本化缓存 → PATH → 官方 npm 平台包
  → profile 内 opencode-ai / @opencode/cli 包 → 下载兜底
```

- 官方 npm 平台包安装到 `$DSH_HOME/opencode/packages/<platform-key>`，候选顺序与
  官方 `postinstall.mjs` 的 platform/arch/musl/AVX2 选择一致。
- 显式 `DSH_OC_OPENCODE_BIN` 必须报告锁定版本 `2.1.0`，否则直接报错，绝不静默
  回退到 PATH 上的其它版本。
- 覆盖以下平台 key：
  - `linux-x64`、`linux-x64-baseline`、`linux-x64-musl`、`linux-x64-baseline-musl`
  - `linux-arm64`、`linux-arm64-musl`
  - `darwin-x64`、`darwin-x64-baseline`、`darwin-arm64`
  - `windows-x64`、`windows-x64-baseline`、`windows-arm64`
- manifest 缺失时下载路径只给出恢复指引（设置 `DSH_OC_OPENCODE_BIN`、安装
  `opencode-ai@2.1.0` / `@opencode/cli@2.1.0`、或手动放置可执行文件），不再静默
  失败。

### 7.1 多 arch 二进制分发

`src/tui/binary.ts` 的优先级（详细见 README 与 FEATURES.md）：

```text
env DSH_OC_OPENCODE_BIN → 版本化缓存 → PATH → 官方 npm 平台包
  → profile 内 opencode-ai / @opencode/cli 包 → npm 平台包安装兜底
```

官方 npm 平台包安装到 `$DSH_HOME/opencode/packages/<platform-key>`，候选顺序与
官方 `postinstall.mjs` 的 platform/arch/musl/AVX2 选择一致；每个平台使用各自的
平台包独立校验，不是全局单一 hash。

---

## 8. 已知协议限制（首版）

1. **`always` 权限降级**：opencode TUI 提供 `Allow always`，dsh approval 只有 `allowed-once / rejected`。首版将 `always` 映射为 `allowed-once`，并在 TUI 外日志中提示。后续若 dsh 增加持久权限预设，再改回真 `always`。
2. **TUI 启动方式**：2.x CLI 没有 `attach` 子命令，dsh-oc 以 `opencode --server <bridge-url>` 启动 TUI（`--mini` 走 `opencode mini --server <bridge-url>`）。`--dir` 由 dsh-oc 自己消费并改写 bridge cwd，不转发给 CLI。`dsh --profile oc --model X` 等参数首版打印警告并忽略；模型切换走 TUI 内模型选择器。
3. **文件附件**：`file` part 支持文本（data URL / cwd 内本地文件）与图片（data URL），映射为 dsh `text`/`image` part；PDF 等二进制附件返回 400。
4. **session diff**：无 produced-files 投影时返回 `[]`，不伪造 diff。
5. **opencode 2.1.0 单协议**：任何升级必须重新跑第 2 节探针并更新本文件。

## 9. e2e 实测实现状态（2026-08-15）

下列状态来自 `chore-release` 分支 profile-fix 之后的真实 e2e（mock LLM +
dsh 0.1.2-rc.1 + opencode 1.18.18，TUI 与 bridge 均实际跑通；2.1.0 的路由形状与
§4 表格一致）：

| 路由/能力 | 状态 | 备注 |
|---|---|---|
| §3 启动 GET 矩阵（含带 query 的 `/api/model?location[...]` 等） | 200 + JSON | 全部经 curl+jq 断言 |
| `GET /api/event` | 200 SSE | `retry: 3000` 首帧；每帧含 `directory` |
| `GET /api/agent` | MAP | 返回单个 `build` 主 agent（含 `model`），否则 TUI prompt 无法提交 |
| `POST /api/session/{id}/prompt` | MAP | opencode SDK v2 官方路由，返回 `{ data: SessionInputAdmitted }` |
| `POST /api/session/{id}/fork` | MAP | dsh fork；child session 的 `parentID` 正确 |
| `POST /api/session/{id}/compact` | MAP | TUI `/compact` 经 dsh command registry 执行 `/compact` |
| `GET /api/session` | MAP | child session 输出 `parentID`；subagent 带 `metadata.origin` 与标题标识 |
| `GET /api/model` | MAP | 返回 `{ location, data: ModelV2Info[] }`（协议对象，非裸数组） |
| `GET /api/permission/request` + `POST /api/session/{id}/permission/{rid}/reply` | MAP | 需保持至少一个 SSE 连接（与真实 TUI 一致）才能收到 mux approval 帧 |
| `goal/change` | MAP | goal 与 todos 合并（goal 首条），经 `todo.updated` 事件发布 |
| `POST /api/session/{id}/command` `/goal` | MAP | 创建/查看 goal；真实 TUI sidebar 可见（`scripts/e2e-tui-goal.sh`） |
| `DSH_PERMISSION_MODE=ask` | 不支持 | dsh 只接受 `read-only`/`workspace-write`/`danger-full-access`；approval=ask 用 `workspace-write` |
| oc profile 宿主行 | 已并入 bundle patch | `storage`/`storage-json`/`storage-domain`/`webserver` 已由 `cordis.patch.yml` 挂载；`dsh --profile oc` 直接启动（无需宿主 overlay） |
| `--print-logs` | 透传 | oc-tui 已把 `--print-logs` 传给 `opencode --server`（opencode 顶层全局选项，设置 `OPENCODE_PRINT_LOGS=1`） |
| 时间戳 | 默认开启 | `DSH_OC_TUI_TIMESTAMPS=1` 写入 `kv.json` 的 `timestamps: show` 并绑定 `ctrl+shift+t` / `/timestamps`；e2e 见 `scripts/e2e-tui-timestamps.sh` |
| tarball 安装 e2e | PASSED | `DSH_OC_E2E_ADD_SPEC=<tgz>` 下 `e2e-api.sh` / `e2e-tui-boot.sh` / `e2e-tui-turn.sh` / `e2e-tui-timestamps.sh` 全部通过；profile 安装的是 npm tarball，不再使用本地路径 |

---

## 10. 自动化协议探针

`scripts/probe-opencode.mjs` 对照 `tests/fixtures/opencode/routes.json`
（官方 2.1.0 client 的真实请求清单）检查 oc-bridge 是否注册了全部路由，并校验
opencode 二进制与 `@opencode/client` 的版本锁定：

```bash
pnpm run probe
node scripts/probe-opencode.mjs --version 2.1.0 --bin /path/to/opencode \
  --out .e2e/protocol-probe.json
```

输出：缺失路由（`FAIL missing-route` + 修复建议）、二进制/client 版本不匹配；
全绿时退出码 0 并打印 `PASSED`。升级 opencode 的流程：

1. 更新 `opencode-version.json`；
2. `pnpm install`（client 版本）后运行 `pnpm run probe`；
3. 跑 `node scripts/check-client-routes.mjs`，确认官方 client 路由 `missing: 0`；
4. 按探针结果补齐路由或 stub，并更新本文件的兼容矩阵。

另有 `node scripts/check-client-routes.mjs`：直接解析
`@opencode/client` 的 chunk，把官方 client 的路由集合与 bridge 注册的路由集合对比，
输出 `missing: 0` 才算覆盖完整。

---

## 11. dsh 0.1.5 迁移要点（0.2.0-rc.4）

dsh 0.1.5 对 dsh-oc 使用到的 host ABI 有两处破坏性变更；opencode 侧协议与
2.1.0 探针矩阵不变。

### 11.1 session-controller 的 fileUploads

`dsh-api-session-controller` 的 `static inject` 新增 `fileUploads`。官方 provider
`@deepseek-ai/dsh-client-file-upload` 是浏览器传输插件（inject `connection`），
oc-bridge 不挂载 Web transport，因此 bundle patch 在 `session-controller` 之前
插入 headless 行：

```yaml
- id: oc-file-uploads
  name: '@chiro2001/dsh-oc/file-uploads'
```

服务实现（`src/bridge/file-uploads.ts`）：
- `registerAgentResolver` / `retirePrompt` 为 no-op；
- `bindPrompt` 对无 receipt 的 prompt 返回 `{ commit(), [Symbol.dispose]() }`
  —— 0.1.5 用显式资源管理（`using`）包裹该返回值，缺 `Symbol.dispose` 会让
  prompt 以 `session/agent-busy` 失败；
- `resolve` / `uploadStream` 对真实文件回执 fail loudly（bridge 无上传路由，
  opencode 附件在 convert 层映射为 prompt content，不经过 dsh 上传）。

### 11.2 assistant 流式与历史

| 维度 | dsh 0.1.2 | dsh 0.1.5（当前） |
|---|---|---|
| 实时增量 | 持久化 `assistant/chunk` 会话事件 | 进程内 `agent/assistant-stream` 帧（`start`→`chunk`→`end`；`chunk.chunk` 仍是同一 `StreamChunk` 联合） |
| 尝试结算 | 无 | `assistant/attempt`（无 surface，忽略） |
| 历史记录 | `SessionHistoryRecord = SessionEventEntry \| SessionChunkRun`（`chunkrow/*`） | 只有 `SessionEventEntry`；`assistant/message.stream` / `assistant/attempt.stream` 内嵌 packed run + raw chunk |
| 部件时长 | block-start 事件时间 | live 帧 `time`；冷读 `assistantStreamTiming` 读 raw `block-start`/`block-end` |
| finish reason | live `finish` chunk | 同上 |
| 去重键 | `sessionId:seq` | live `${sessionId}:${attemptId}:${revision}:${index}`；历史行仍按 seq |

`src/bridge/rpc.ts#expandRecord` 把内嵌 run 还原成 0.1.2 时代翻译层本来就消费的
`text-chunks`/`reasoning-chunks`/`tool-call-chunks` 行，并追加结算事件本身；
`src/bridge/convert/message.ts` 用 `assistantStreamTiming` 合并 raw 部件边界。
因此 history v1/v2、SSE ring 回放与 golden trace 的 opencode 语义保持稳定。

### 11.3 文件工具

dsh 0.1.5 的 `str_replace_editor` 不再由 dsh-base 挂着（0.1.2 base 行、0.1.5 需
显式 opt-in）；默认 preset（`minimal`）只含持久 shell，host 层仍提供
`dsh-tool-fs` 的 `read`/`write`/`edit`。bridge 的工具名映射已覆盖
`write`/`edit`，并在新文件 `write` 的 result meta 为空 diffs 时从调用参数合成
`metadata.diff`，e2e 的 untracked write 场景改用 `write`（`str_replace_editor`
映射与单测保留给显式 opt-in 的部署）。
