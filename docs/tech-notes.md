# 技术说明与接手引导（v1.0.0 已知问题）

> 写给**没有任何历史上下文**的接手者（人或 AI）。读完本页 + `README.md` + `HANDOFF.md` 即可开工，不需要查私有仓库或旧对话。
> 结论先行：**v1.0.0 能跑，但不是成品。** 它是在"草草收尾"决定下发布的，下列问题是真实存在的，不要假设它们已被解决。

---

## 0. 一分钟背景

- 宿主：TauriTavern 2.4.0 安卓版的 Agent 模式（commit `fff9af03…`）。Agent 每轮以"run"执行，用工具写 `output/main.md` → `workspace.commit` 落楼 → `workspace.finish` 结束。
- 本项目 = 1 个前端扩展（`ext/abc/index.js`，跑在 WebView 里）+ 2 份 Profile：
  - `abc-test`：主 run，写正文。
  - `abc-compress`：后台 run，把旧楼层压成「事件 / 状态 / 未收线索」写进 `chat_metadata.abc.chronicle`，并隐藏已压缩楼层。
- 扩展**不拦截**模型请求，只做三件事：注入提示块、监听 run 事件、在主 run 结束后发起压缩 run。

## 1. 架构上的根本问题（不是 bug，是设计债）

### P1 主 run 靠轮询发现（最脆弱的一环）
- 变量工具剥离后，主 run 不再调用任何扩展工具，扩展**拿不到 runId**。
- 现做法：`setInterval` 每 `CFG.discoverMs`（2 s）调 `api.agent.listRuns({chatRef, limit:5})`，取新出现的非 background run 再 `subscribe`。见 `index.js` 尾部 `discoverOnce()`。
- 后果：
  - 页面不可见（切后台）时停轮询 → 这段时间结束的 run 可能漏掉，**压缩不触发**（不丢数据，只是延后到下一轮）。
  - 2 s 内跑完的 run 可能在订阅前就已终结 → 漏 `chat_commit_recorded` → 该楼层**没有 `extra.abc_mem` 快照**。恢复逻辑会回退到上一条快照 + compLog，一般能自愈，但未做压测。
  - 同时 5 个以上 run 时会漏（`limit:5`）。
- 正确方向：宿主若提供"run 创建"事件，或 Profile 级 hook，应替换轮询。没有之前，**不要把 discoverMs 调大**。

### P2 宿主没有同聊天并发闸门
- 扩展直调 `startRunWithPromptSnapshot` 起后台压缩 run，绕过了前端"一次只跑一个 run"的保护。
- 已有缓解：`COMP.running` 单例、按 runId 暂存、第 0–to 楼指纹校验、`chatRef` 显式传递。
- 残余风险：压缩 run 与下一轮主 run 重叠时，楼层 `extra` 是"后到者胜"。**未做冲突测试。**

### P3 "正文原样放行" 与 "记忆层干净" 互相冲突
- 设计边界 I2 规定：卡要求的 `<UpdateVariable>` / `<JSONPatch>` / `<StatusPlaceHolderImpl/>` 等块原样落楼，Agent 不碰。
- 但压缩 run 读的是楼层原文，这些块会被模型**写进 chronicle**（R04 实测）。v1.0 **未处理**。
- 可选方案（二选一，需登记 md5）：
  1. `buildCompressMessages()` 里在拼范围原文前剥掉标签块（只影响压缩输入，不改楼层，不违反 I1/I2）——推荐；
  2. 在 `abc-compress` 提示里明写"忽略标签块"——更弱，依赖模型。

### P4 压缩慢且吃同一模型
- 压缩 run 复制主 run 的 `generationParameters`，后台 22–51 s，大头是思考。慢网/限流下未测。
- 可改为压缩用轻量模型，但 `contextPolicy` 必须与 Profile 的 `context` 逐字段相等，否则宿主报 `agent.context_policy_mismatch`。

## 2. 未验证的部分（不要当成"通过"）

| 项 | 状态 | 风险点 |
|---|---|---|
| 截断 / 超时 / 取消 | 未跑 | 终态应只有 `failed`/`cancelled`，聊天行数与 `chat_metadata.abc` 不变——**没人确认过** |
| 慢网 | 未跑 | 轮询与压缩重叠概率上升（P1/P2） |
| ≥200 楼长对话 | 未跑 | `compLog` 上限 50、`debug` 上限 300、指纹每次全量哈希 0–to 楼（O(n)） |
| 干净设备一次装好 | 未做 | 安装文档只在开发机上走通 |
| 重美化 / 皮肤类卡 | 无素材 | 正文里大段 HTML 对 I2 判定、对压缩输入的影响未知 |
| 独立复核 | R03 之后无 | 所有"通过"都是开发方自测 |

## 3. 文档与代码不一致（以代码为准）

- `HANDOFF.md` 缺口 6 说 `window.__abc` 仍暴露内部写操作——**当前代码已是只读**：只有 `read.state()`、`read.system()`、`debug.events()`，整体 `Object.freeze`。该项可视为已完成，但未在真机复测。
- `design-v1.0.md` §7 的 M7 写"主 run 14 项工具"——实际 Profile 是 **12 项**（`chat.search`、`chat.read_messages` 已 deny）。
- `design-v1.0.md` 多处引用 `rounds/…`、`upstream/…`：这些是私有测试证据，**本仓库没有**，不要去找。
- Profile `description` 字段残留旧工具名，不影响运行。

## 4. 接手引导

### 4.1 开工前
1. `git clone https://github.com/Yuansheng1919/abc-agent`，读 `README.md` → `HANDOFF.md` → 本页 → `docs/design-v1.0.md` §5–§8。
2. 校验 md5，与 README 表格一致再动手：
   ```bash
   md5sum ext/abc/index.js ext/abc/manifest.json profiles/*.json
   ```
3. 若要真机：按 `docs/install.md`，**先备份**酒馆数据目录；主 Profile 需要名为 `Agent-ABC-Test` 的 openai 预设。

### 4.2 硬规矩（违反即视为破坏设计）
- 只写 `chat_metadata.abc.*` 与楼层 `extra.abc_*`。**不写** `stat_data`、卡变量、世界书、卡文件（I1）。
- 落楼正文 = `output/main.md`（允许只多一个尾部 `<StatusPlaceHolderImpl/>`）（I2）。
- 扩展、两份 Profile、提示词不随卡或模型变化（I6）。**任何修改都在 `HANDOFF.md` 登记前后 md5。**
- 后台 run 必须显式传发起时的 `chatRef`（否则用户切聊天会绑错）。
- 不要把变量层（`state_propose`/守卫/schema/KV/lock）加回来——这是项目主人的最终裁定。

### 4.3 建议顺序
1. **P3 剥标签**（改动小、收益确定）：在 `buildCompressMessages()` 拼原文处加一个只读过滤；用一张带 `<UpdateVariable>` 的卡跑 2 次压缩，确认 chronicle 无标签。
2. **韧性 R06**：依次做"主 run 中途取消""压缩 run 中途 `/abc-cancel`""断网重连""200 楼"，每项检查：终态、聊天行数、`readState()` 前后是否一致。
3. **P1 轮询**：调查宿主是否有 run 创建事件；没有就补"页面重新可见时立即 `discoverOnce()` + 对最近一轮做一次补订阅/补快照"。
4. 修 §3 的文档不一致，发 `v1.0.1`（新 tag，**不要改动或 force push `v1.0.0`**）。

### 4.4 自检怎么看
- 浏览器控制台：`__abc.read.state()` 看 cursor / compLog / 隐藏区间；`__abc.debug.events()` 看事件流（`compress_skip`、`discover_failed`、`run_not_completed` 是重点）。
- `chat_metadata.abc.compEvidence`：每次压缩一条，`outcome` 应走 `pending → started → applied | discarded`；停在 `started` 说明压缩 run 丢了终态事件。

## 5. 一句话总结给接手者

> 正文链路（B）基本可靠；压缩链路（C）在正常网络、前台、短对话下可靠；**发现机制（轮询）、并发、标签污染、韧性**是四个真实问题，按 4.3 的顺序处理。
