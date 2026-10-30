---
title: "A / B / C 三段式提示词与记忆架构 · 设计文档"
subtitle: "v1.0 · 落地于 TauriTavern 2.4.0 Agent 模式（参考实现：扩展 abc R05 + Profile abc-test / abc-compress）"
date: "2026-10-30"
---

# 0. 版本说明

| 版本 | 日期 | 性质 |
|---|---|---|
| v0.1 | 2026-10-24 | 技术设想：抽象结构，未定项以选项列出 |
| v0.2 | 2026-10-24 | 落地设计：v0.1 未定项全部定案；三轮真机验证 |
| v0.2 r1 | 2026-10-24 | 按测试方审阅意见修订 |
| v0.3 | 2026-10-26 | 并入实验 B（批量约束进 Profile）、D（流式诊断）、A（压缩独立化） |
| v0.3.1 | 2026-10-28 | 仅改 §9.2：自足版 `agentSystemPrompt` 证据等级「建议」→【实测】 |
| **v1.0** | **2026-10-30** | **删除变量层全部章节**（R03 剥离）；压缩提示搬进 Profile（R04）；证据可守（R05）；口径按 R03/R04 真机结果重写；判据文件清单入附录 |

**证据等级**（全文统一使用）：

- 【实测·R03】【实测·R04】Honor P50 Pro（JAD-AL50 / Android 12 / TauriTavern 2.4.0）真机，真实模型，核对了原始文件（聊天 jsonl、runs、事件链）。轮次见 §10。
- 【源码】对照 TauriTavern 源码确认，未单独真机测试。
- 【mock】沙盒模拟或 Node 逻辑测试。
- 【推断】基于证据的判断，尚未直接验证。
- 【实测·测试方】真机测试方复核原始文件得出。

测试环境：网关模型名 `claude-fable-5-1`，实际响应模型 `gemini-3.8-flash-high`（经 `claude_messages` 代理）。

> 命名提醒：本文的 **A / B / C** 指架构三段（提示词 / 本轮产出 / 压缩记忆），与路线实验编号「实验 A / B / D」无关。

# 1. 目的与范围

在 TauriTavern 的 Agent 模式下，把**提示词组装（A）**、**本轮产出（B）**、**历史压缩（C）**拆成独立载体，使：

- 每轮提示词整体重组，不继承上一轮文本；
- 模型看到的旧历史是压缩后的叙述，而非逐楼原文；
- 用户界面仍保留完整正文；
- **压缩不占用正文回合**：由独立的后台运行完成，不落楼【实测·R02/04】。

**v1.0 范围缩减（R03 裁定）**：变量守卫 / schema / KV / 锁 / `state_propose` **整体剥离**，代码归档在 `ext/archive/v0.4-r03-var/`。本扩展**不读写、不校验、不裁决**任何卡变量；卡要求的格式（变量块、占位符、JSON）在正文里**原样放行**。变量与 UI 美化交第三方插件，接口以 I1（隔离）为界。

不在本文范围：App 本体修改、网关与传输层、具体角色卡的变量设计。

# 2. 系统构成

```
 ┌──────────────────── 扩展 abc（WebView 内，常驻） ────────────────────┐
 │  recall（查已压缩原文）        chronicle_commit（仅压缩 run 可调）    │
 │      │                              │                                │
 │      ▼                              ▼                                │
 │  0–cursor 楼原文            暂存（按 runId 隔离）→ compLog + cursor   │
 │                             + /hide 对齐 + ab_hidden 标记 + 证据环形  │
 │  setExtensionPrompt 注入：记忆层 C（+ 协议，可关）                    │
 └──────────────┬──────────────────────────────────────┬───────────────┘
                │ 每轮冻结进快照                        │ 主 run 终态后、范围达标时
                ▼                                       ▼
  主 run（Profile abc-test，foreground）    压缩 run（Profile abc-compress，background）
    A = 预设 + 卡/世界书 + 注入层            手工 snapshot：2 条消息
        + 可见楼层 + 本轮输入                （system = 压缩 Profile 的 agentSystemPrompt
    单次回复：write_file → commit → finish    + user = 已有记忆层 + 第 from–to 楼原文）
    → B = 正文消息（落楼）                    第 1 次：chronicle_commit
                                              第 2 次：workspace_finish
                                              → 不落楼（tools.deny 掉 workspace.commit）
```

组件只有四件：**扩展 abc**（`index.js` + `manifest.json`）、**主 Profile** `abc-test`、**压缩 Profile** `abc-compress`、**聊天元数据** `chat_metadata.abc`。没有第五个存储。

# 3. A：提示词

## 3.1 主 run

运行开始时冻结提示词快照；扩展注入的块自动进入快照【mock】【实测·R01】：

| 注入块 | 内容 | 何时为空 |
|---|---|---|
| `abc_protocol` | 产出纪律（三件套同回复、正文只写故事、不编原话） | `CFG.injectProtocol=false` |
| `abc_memory` | 记忆层 C，注明覆盖第 0–cursor 楼、原文可 `recall` | 尚未压缩过 |

> v0.3.1 的 `abc_state`（守卫裁定值）与 `abc_flag`（压缩标志）**已删除**：变量层剥离（R03），压缩改独立运行（v0.3）。

**系统前言**：Profile 设了 `instructions.agentSystemPrompt` 时，`materialize_agent_system_prompt` 直接返回该文本，**整段替换**内置前言【源码 `system_prompt.rs:16-18`】。因此正式模板必须自足。

**现行定稿**（R03，真机 5/5 + R04 6/6 复现）：**982 字符 / md5 `2f2a9fc2015fdb887cbe3c3a56c2cc22`**，见 `profiles/abc-test.json`。要点只有三条：

1. 三件套 `workspace_write_file` → `workspace.commit` → `workspace_finish` **必须在同一条回复里，按此顺序**（拆轮是 R03 之前失败的唯一主因：旧文案 "in an earlier reply" 导致 4 轮 2 不中）；
2. 正文写 `output/main.md`，卡要求的格式原样写进正文，系统不校验、不改写、不剥除；
3. 只写故事，不写工具名/运行日志/系统说明。

**历史部分**：隐藏楼层（`is_system`）不进入 Agent 快照，A 中历史 = 未压缩的可见楼层【实测·R03】。比对时用**该 run 开始时**的 cursor。

## 3.2 压缩 run

扩展用 `startRunWithPromptSnapshot` 传入手工 snapshot：**恰好 2 条消息**（system + user），system 标 `providerMetadata.promptComponent = "agentSystemPrompt"`，不经内置前言组装【源码 `prompt_snapshot.rs:63`】。

**v1.0 的关键变化（R04）**：压缩提示不再内联在扩展里，而是**读压缩 Profile 的 `instructions.agentSystemPrompt`**（读不到才用等价的静态兜底）。

| 项 | 值 | 依据 |
|---|---|---|
| 提示文本 | **796 字符 / md5 `8110b13b18c8fabb1d36866719f3c5b9`**，与范围无关 | 【实测·R04】3 次压缩全同 |
| `messages` 条数 | **恒 2**（system + user） | 【实测·R04】3/3 |
| 动态部分（已有记忆层、范围、原文） | **全部在 user 段** | 【实测·R04】user md5 三次互不相同 |
| `preset.mode` | `currentPromptSnapshot`（继承当前聊天预设，**没有 none**） | 【源码 `types.d.ts`】【实测·R04】 |

> R04 唯一的已知风险「`currentPromptSnapshot` 会把聊天预设灌进压缩 run」**已被真机否证**：三次压缩 `messages` 都是 2 条、system 段与 Profile 逐字相等。回退方案（预设导出成资产 + 改回 `ref`）不需要启用。

# 4. B：本轮产出

- 模型写 `output/main.md`，`workspace.commit` 后成为聊天消息【实测·R03】。
- **单次回复完成三件套**：`index.js` 侧只做顺序校验（`M3`），不强制拆分轮次。
- 正文**不含**系统文本/工具名（M6b 机读），但**可以含**卡要求的变量块、占位符、JSON——原样放行（v1.0 起不再改写）。
- 「提交成功」以 `chat_commit_recorded` 为准，不用 `MESSAGE_RECEIVED`【实测·R01】。
- 落楼正文与 `output/main.md` 的关系：严格相等，或只在落楼一侧多一个前端尾部占位 `<StatusPlaceHolderImpl/>`（I2 双模判定）。

# 5. C：压缩记忆

## 5.1 存储

- 当前值：`chat_metadata.abc = { chronicle, cursor, compLog, debug, compEvidence }`（v0.3.1 的 `state` / `pending` / `pendingMem` 已废弃，见 §11）。
- `compLog = [{ to, chronicle, fp, t }]`（上限 50）：每次压缩生效登记一项，`fp` 为第 0–to 楼指纹（`send_date` + 正文的哈希）。
- `compEvidence`（**R05 新增**，上限 10）：每次压缩一条，`{ mainRunId, from, to, cursorAtStart, sysChars, msgs, preset, source, outcome, runId, appliedTo, appliedCursor, clamped }`。`outcome` 走 `pending → started → applied | discarded`。**独立于 `debug`**，不占 debug 名额。
- 楼层快照：提交成功的楼层写 `extra.abc_mem = { chronicle, cursor }`（兼容 v0.2 数据模型，不再是唯一事实来源）。
- 楼层隐藏标记：`extra.abc_hidden`（`reconcileHidden` 写）。

## 5.2 游标与触发

cursor 初值 −1。**cursor 之后可见楼层 ≥ `triggerUncompressed`(10) 时触发**，待压缩范围 = 去掉最近 `keepRecent`(6) 条后的部分【实测·R02/03/04】。

**节奏请按可见条数记，不要按轮数记**：一次用户消息增 2 楼（用户 + 回复），所以「可见 8」的聊天 **1 轮后**就满 10 触发压缩；压缩后可见回落到 6，再 2 轮又满。每次压缩 `to = 当时楼层数 − 7`。

## 5.3 发起（主 run 到 `run_completed` 后）

1. **归属校验**：`watchRun` 订阅时记下主 run 所属聊天（ownerKey）；`run_completed` 到达时与 400 ms 后各比对一次当前聊天，不一致即放弃本次触发【实测·R03】。
2. **启动时刻定格**：范围 `p`、`chatKey`、第 0–to 楼指纹 `fp`、`chatRef`。
3. `agent.startRunWithPromptSnapshot({ chatRef, profileId: 'abc-compress', presentation: 'background', options: { presentation: 'background', stream: false }, promptSnapshot })`：
   - `messages`：见 §3.2；
   - `generationParameters`：从主 run `input/prompt_snapshot.json` 整份复制，强制 `stream: false`；
   - `contextPolicy`：须与压缩 Profile 的 `context` 逐字段相等（否则 `agent.context_policy_mismatch`）；
   - 不带 `frozenRunInputSnapshot`、不带历史工具与 recall。
4. 同一时刻只允许一个压缩 run（`COMP.running`）。

> **硬规则：后台 run 必须显式传发起时的 `chatRef`。** 不传时 `agent.js:228` 取「调用那一刻的当前聊天」，而发起前有两次 `await`，用户切走即绑错聊天【源码】【实测·测试方】。

## 5.4 写入（`chronicle_commit`）

压缩 run 调 `chronicle_commit({chronicle})`，**整体重写**记忆层。扩展校验【实测·R02/04】：

1. 调用者必须是登记过的压缩 run，主 run 调用一律 `ok:false`；
2. 当前聊天与第 0–to 楼指纹未变，否则当场驳回；
3. 必含「事件」「状态」「未收线索」三段；
4. 可选「关键原话」≤3 条（`CFG.maxQuotes`），须逐字（忽略空白）出现在启动时登记的范围原文或已有记忆层中；
5. 通过后按 runId 暂存，不立即生效。

## 5.5 生效与丢弃

仅当 `run_completed`、有暂存、聊天未切换、指纹未变时 `applyCompress`：写 chronicle / cursor → 隐藏对齐 → 登记 compLog → 兼容写回最近一条楼层快照 → 保存【实测·R02/04】。

否则丢弃；丢弃时只有当前聊天就是发起聊天才落盘，不碰别的聊天。两种情况都写 `compEvidence.outcome`。

## 5.6 清理 B：隐藏窗口与对齐

`reconcileHidden()`：第 0–cursor 楼全部隐藏并打 `extra.abc_hidden`；cursor 之后带标记的放出；用户手动隐藏的不动。执行时机：记忆恢复后、压缩生效后、切换聊天时。原因：swipe 时 `swipe_info[id].extra` 复制回消息 `extra`【源码】。

## 5.7 recall

只在 0–cursor 楼原文中检索，查无时让角色表示记不清；不依赖内置 `chat.search`（未按隐藏状态过滤）【源码】。

## 5.8 记忆恢复

`restoreMem(base)`：取 base 之前最后一条楼层快照 `abc_mem`；在 compLog 中找「`to < base` 且第 0–to 楼指纹仍匹配」的最大项；两者取 cursor 较大者，再隐藏对齐【实测·R02】。压缩有效性只取决于第 0–to 楼是否原样，所以 swipe / 重生成不会回退、不会重复压缩。

# 6. 每轮时序

**主 run**（单次回复）

1. 用户发送；`GENERATION_STARTED`：从快照 + compLog 恢复记忆层，隐藏对齐，刷新注入块。
2. 运行时冻结快照（A）。
3. 一条回复内依次 `workspace_write_file` → `workspace.commit` → `workspace_finish`；需要旧原文时同一条里先 `recall`。
4. `chat_commit_recorded` → `finalize`：写记忆快照，保存。
5. `run_completed` → 归属校验通过且范围达标 → 发起压缩 run（§5.3）。

**压缩 run**（后台 22–51 s，大头是思考）

1. 第 1 次回复：`chronicle_commit`（被驳回则按 error 改正重试，最多 3 次）；
2. 第 2 次回复：`workspace_finish`；
3. 终态校验 → 生效或丢弃。

**调用次数**【实测·R03/R04】：主 run `model_completed` **恒为 1**（剥离 + 单次调用修正后 11/11）；压缩 run 均为 2 次工具调用。

# 7. 不变量

每轮都判，机读实现见附录。

| # | 不变量 | 判据 |
|---|---|---|
| I1 | 隔离 | 只写 `chat_metadata.abc.*`；`variables` 是多方共写公共黑板，只硬判 `abc_*` 前缀；`chat_metadata` 其它键逐字不变 |
| I2 | 正文原样 | 落楼正文（剥尾部占位后）= `output/main.md` 逐字（双模：严格相等 或 只剥落楼一侧） |
| I3 | 无 drift | `drift_recovery_attempted` = 0 |
| I4 | 落帐 | `chat_commit_recorded` = 1、`run_completed` = 1、终态 `completed` |
| I5 | 压缩一致 | C1–C11 全中；失败不污染（丢弃路径 cursor/compLog/隐藏楼层不变） |
| I6 | 一套系统 | 扩展 + 两份 Profile + 提示词 md5 跨轮不变 |
| M7 | 工具集 | 主 run 14 项、无 `state_propose`/`chronicle_commit` 及其调用；压缩 run 恰 3 项 |

**压缩专项（C1–C11）**

| # | 判据 |
|---|---|
| C1 | `profileId=abc-compress`、`status=completed`、`run_completed=1` |
| C2 | 不落楼：`chat_commit_recorded=0` |
| C3 | `chronicle_commit` 恰 1 次且结果 `ok / structured.ok = true` |
| C4 | 工具集恰 3 项（`workspace.finish`、`workspace.write_file`、`extension/abc:chronicle_commit`），无越界调用 |
| C5 | 输入**恰 2 条**消息（system + user，`promptComponent=agentSystemPrompt`） |
| C6 | `from = 上次 cursor+1`、`to ≥ from`、覆盖 ≥4 条、无 `compress_to_clamped`、`cursor = to`、`to = 当时楼层数−7`、压缩后可见 = 6 |
| C7 | `compLog[n].to = cursor = to` 且推进 |
| C8 | chronicle 含三段（事件 / 状态 / 未收线索），已落 compLog |
| C9 | 隐藏段 `0..to` 全 `is_system`，共 `to+1` 条 |
| **C10** | **system 段 md5 恒定 = `8110b13b…` / 796 字符**（与范围无关） |
| **C11** | `preset.mode=currentPromptSnapshot` 且没把聊天预设灌进压缩 run（证人 `messages` 恰 2） |

C6 的「当时楼层数」在**批量事后收证**时必须重建：用「`send_date ≤ 压缩 run createdAt` 的楼层数」，不能用最终楼层数（R04 踩过，见 `rounds/R04/report.md` §8）。

# 8. 已知限制（已接受 / 待处理）

| 限制 | 表现 | 处理 | 证据 |
|---|---|---|---|
| 工具参数不分段 | 文本真流式，但工具 `input_json_delta` 每次仅 1 条，整段 `content` 一次带完 → 正文整段出现 | 来源未定（网关或上游 function_call），不归因 App | 【实测·测试方】【源码 `claude.rs:390-409`】 |
| 宿主无同聊天并发闸门 | 扩展直调 `startRunWithPromptSnapshot` 绕过前端单 run 保护 | 暂存按 runId 隔离 + 指纹校验；并发期间楼层 extra「后到者胜」 | 【源码】【实测】 |
| 准入强制 `write_file` | Chat 执行必须允许 `workspace.write_file` 并有 messageBody 产物 | 压缩 Profile 开放但规则禁止调用；全部轮次零调用 | 【源码 `readiness.rs:17-22`】【实测·R04】 |
| 压缩耗时 | 后台 22–51 s，主要是思考 | 接受；未换轻模型 | 【实测】 |
| **卡侧标签混入记忆层** | 压缩原文里含 `<UpdateVariable>` / `<JSONPatch>` / `<StatusPlaceHolderImpl/>`，被模型并入记忆层 | **v1.0 未处理**（R05/R07 待办）：并入前剥离，或在提示里明写「忽略标签块」 | 【实测·R04】§7.2 |
| **`chat.*` 工具导致多轮调用** | 主 Profile 允许 `builtin:chat.search` / `chat.read_messages` 时，模型会先翻旧消息再产出，`model_completed` 偶发 2–7（10 轮里 4 例），会挂「5 轮全中」验收 | **v1.0 已处理**：两个工具移入 `tools.deny`（工具面 14→12），两批 12 个主 run 全部 `mc=1`；回查旧原文仍走 `extension/abc:recall`。见 `rounds/R05/report.md` §10.1 | 【实测·R05】 |
| ~~模型读回已压缩区间~~ | 曾怀疑 `chat.*` 会把已隐藏的 `0–cursor` 楼读回来 | **未证实，已收回**：三例探索轮的 `tool-results` 里返回的都是可见楼层。`chat.search` 是否按 `is_system` 过滤仍存疑（旧文档说不过滤），但因两工具已 deny，不影响交付 | 【实测·R05】 |
| 取消入口 | App 无后台 run 的取消 UI | `/abc-cancel` **保留为运维钩子**（R07 裁定：R06 的「取消压缩」场景只能靠它；回调仅在压缩 run 存活窗口可达） | 【实测】 |
| 越界摘要 | 自由文本段可能写进范围之后的内容 | 只写范围原文 + 整体重写在下次合并时消除 | 【实测·R02】【推断】 |
| 提示词缓存 | Agent 请求不带 `cache_control` | 等 App 支持 | 【源码】 |
| 扩展工具依赖前台 | 工具在 WebView 内执行 | 后台 40–51 s 实测正常 | 【实测】 |
| 原话核对 | 只忽略空白，不处理标点变体 | 驳回后模型改正 | 【实测】 |
| 调试日志有损 | `debug` 环形上限会挤掉旧条目（曾 80 条 → R04 挤掉两次压缩的证据） | **R05 已缓解**：上限 `DBG_MAX=300` + discover 噪声去重 + 压缩证据另存 `compEvidence` | 【实测·R04】【实测·R05 离线】 |

# 9. 配置与部署

> 完整装法（含备份、换装、回滚）见 `docs/install.md`。

## 9.1 三个文件

| 文件 | 作用 | 现行 md5 |
|---|---|---|
| `ext/abc/index.js` | 扩展本体（R05 + v0.2 兼容位清理） | `6fb0978c70c1154db6315e22a4d57b72`（34897 B） |
| `ext/abc/manifest.json` | `0.5.0-r03`（版本号待进位 `0.5.1-r04`） | `8f42d81f7e9ead8b95bb781f1440f7b3` |
| `profiles/abc-test.json` | 主 Profile | `38859a60d540515b29ca69d45a03a69d` |
| `profiles/abc-compress.json` | 压缩 Profile | `354e32198ad66a0efa85d0eec800dbaf` |

路径：扩展 → `data/default-user/extensions/abc/`；Profile → `data/_tauritavern/agent-profiles/profiles/`。

## 9.2 主 Profile `abc-test`

- `tools.allow`：**12 项**（含 `workspace.*`、`agent.delegate/await`、`worldinfo.read_activated`、`extension/abc:recall`）。
- `tools.deny`：`extension/abc:state_propose`（已不存在）、`extension/abc:chronicle_commit`（压缩专用）、**`builtin:chat.search`、`builtin:chat.read_messages`**（v1.0 起 deny，理由见 `rounds/R05/report.md` §10.1：R07 验收要求「5 轮全中」，而允许这两个工具时实测有 4/10 轮出现 `model_completed>1`）。
- `instructions.agentSystemPrompt`：§3.1 的 982 字符文本。
- `preset`：`currentPromptSnapshot`（R04 起与压缩 Profile 同一种写法）。

## 9.3 压缩 Profile `abc-compress`

| 字段 | 值 |
|---|---|
| `tools.allow` | `builtin:workspace.finish`、`builtin:workspace.write_file`（准入要求）、`extension/abc:chronicle_commit` |
| `tools.deny` | `builtin:workspace.commit`（不落楼的保证）及 agent.delegate / await、chat.search、chat.read_messages、worldinfo.read_activated、workspace.list / search / read / apply_patch / shell、`extension/abc:recall` |
| `run` | `presentation: background`、`stream: false`、`directRunnable: true` |
| `instructions.agentSystemPrompt` | **796 字符 / `8110b13b…`**（R04 起；扩展读它，读不到才用静态兜底） |
| `output.artifacts` | 保留一个 `messageBody` 产物，`required: false` |
| `context` | `initialChatHistoryMessages: -1`、`includeActivatedWorldInfo: true`（与扩展传的 `contextPolicy` 逐字段相等） |
| `skills.visible` / delegation | 空 / 全关 |
| `preset` | `{ mode: "currentPromptSnapshot" }`（无 `ref`、无 `required`） |

## 9.4 参数（`CFG`）

| 参数 | 默认 | 含义 |
|---|---|---|
| `keepRecent` | 6 | 压缩后保留的最近可见楼层数 |
| `triggerUncompressed` | 10 | 未压缩可见楼层达到该数时触发 |
| `maxQuotes` | 3 | 关键原话最多条数 |
| `injectProtocol` | true | 由扩展注入协议 |
| `toast` | true | 显示提示（调试输出**不上屏**，只落 `chat_metadata`） |
| `discoverMs` | 2000 | 主 run 发现轮询间隔（ms） |
| `mainProfileId` | `abc-test` | 只认主 Profile 的 run |
| `compressIndependent` | true | 压缩独立运行 |
| `compressProfileId` | `abc-compress` | 压缩 run 用的 Profile |
| `compressModelMaxTokens` | 8192 | 读主 run 参数失败时兜底 |
| `DBG_MAX` | 300 | `debug` 环形上限（R05；曾 80，会挤掉压缩证据） |

**世界书**：不需要禁用任何条目（变量层剥离后，卡按原样工作）。

# 10. 验证记录

| 轮次 | tag / 提交 | 主要结论 |
|---|---|---|
| R00 基线 | `round-00` = `1cab00f` | 架构可跑通；暴露叙事超演、编造原话 |
| R01 五轮 | `round-01` = `7664d3e` | 5/5 六条全中（`model_completed=2` 时代） |
| R02 正式模板 + 压缩 | `round-02` = `5bf287d` | 压缩独立化 3/3 全中；2 次调用 95% |
| **R03 剥离** | `round-03` = `4b1e916` | **5/5 主 run + 2/2 压缩全中**；提示词改「三件套同回复」后 `model_completed` 恒 1；工具集 14 项无变量工具；I1 只 `abc` 变 |
| **R04 压缩自足** | `round-04` = `bccb74a` | **46/46**：3 次压缩（78–81 / 82–85 / 86–89）C1–C11 全中；**system 段 md5 三次恒 `8110b13b…`**、**`messages` 恒 2**；6 个主 run 按 R03 口径全中 |
| **R05 证据可守** | `5f483cf` | 离线 **18/18**（+R03 41/41、R04 18/18 回归）；`DBG_MAX=300`、discover 噪声去重、`compEvidence`；**真机待跑** |
| R05 通用性 | 待跑 | 换卡（MVU / 纯文本 / 重美化）；重美化卡本地暂无 |
| R06 韧性 | 待跑 | 截断 / 超时 / 取消 / 慢网 / ≥200 楼长对话 |
| R07 收尾 | 本文 | 设计文档 v1.0 与安装说明；v0.2 兼容位清理见 §11 |

# 11. 清理与后续

**v0.2 兼容位：已清（R07，2026-10-30）**

| 对象 | 处置 | 依据 |
|---|---|---|
| `pendingMem` | **删除**（原本只剩一句注释，零读写） | 清点：写入 0 / 读取 0 |
| `abc_flag` 的「压缩标志」文案分支 | **删除**，保留一次空写 | `compressIndependent` 恒 true → 该三元恒取空串分支，是死代码；空写用于清掉老聊天残留槽内容 |
| `/abc-cancel` | **保留**（运维钩子） | 后台压缩 run 没有 App 侧取消 UI，R06 的取消场景必须由它触发 |

清理后三条离线断言全过（R03 41/41、R04 18/18、R05 18/18），`grep` 守卫/兼容位残留 = 1 处（`abc_flag` 空写，属有意保留）。

**后续**：

1. **卡侧标签混入记忆层**（§8）：并入前剥离 `<UpdateVariable>` / `<JSONPatch>` / `<StatusPlaceHolderImpl/>`，或在压缩提示里明写「忽略标签块」——R05 起必须处理，否则换卡后记忆层质量不可控。
2. **版本进位**：`manifest.json` `0.5.0-r03` → `0.5.1-r04`（合并时做，同时重生成 `MANIFEST.txt`）。
3. **Q18 干净设备**：三选一待裁决，见 `rounds/R03/q18-data-root.md` 与 `docs/q18-decision.md`。
4. 观察项（不阻塞）：压缩 run 换轻模型缩短耗时；删除已压缩区间内楼层的路径；App 内文本流式行为。

# 附录：判据文件

| 文件 | 判什么 | 依赖 |
|---|---|---|
| `rounds/R03/judge.py` + `rounds/R03/expect.json` | 主 run：M0–M7 + I2 + I1（`--before-meta/--after-meta`） | 期望值全外置 |
| `rounds/R04/judge.py` | 压缩：C1–C11 + 跨项 X1–X6 + 主 run 回归 + I1 | 三级证据（prompt 范围 / compLog / `compress_applied`）+ `compEvidence` |
| `rounds/R03/offline-assert.cjs` | 剥离与接口收口 41 项 | 静态 + 桩 |
| `rounds/R04/offline-assert.cjs` | 压缩自足 18 项（含两次不同范围 system md5 恒定） | 静态 + 桩 |
| `rounds/R05/offline-assert.cjs` | 证据可守 18 项（`DBG_MAX` / 去重 / `compEvidence`） | 静态 + 桩（真跑轮询与压缩链路） |

*文档完。*
