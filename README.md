# abc · TauriTavern 干净 Agent 运行系统 v1.0.0

TauriTavern 2.4.0（安卓 · Agent 模式）的一个扩展 + 两份 Agent Profile。目标：让角色扮演每一轮都由 Agent 稳定产出正文，并在后台自动压缩长对话记忆；**不管换什么卡、什么模型，系统本身不变、不干扰卡。**

> 给接手的 AI / 人：先读本页，再读 `HANDOFF.md`（现状、未验项、下一步），然后读 `docs/tech-notes.md`（已知问题与接手引导）。本仓库自足，不需要任何其他上下文。

## 三段式（A / B / C）

| 段 | 做什么 | 由谁完成 |
|---|---|---|
| A 提示词 | 每轮运行时组装上下文；扩展只注入「产出纪律」与「记忆层」两块 | 扩展 `ext/abc/index.js` + `profiles/abc-test.json` |
| B 产出 | 模型在**一条回复**里依次调用 `workspace.write_file`（写 `output/main.md`）→ `workspace.commit` → `workspace.finish`，正文落楼 | 主 Profile `abc-test` |
| C 记忆 | 旧楼层压缩成「事件 / 状态 / 未收线索」三段存入 `chat_metadata.abc`，并隐藏已压缩楼层；压缩是**独立后台 run**，不占正文回合 | 扩展 + 压缩 Profile `abc-compress`（工具 `extension/abc:chronicle_commit`） |

需要回查原文时，模型用扩展工具 `extension/abc:recall`。

## 硬不变量（设计边界）

- **I1 隔离**：只写 `chat_metadata.abc.*` 与楼层 `extra.abc_*`；不写 `stat_data`、卡变量、世界书、卡文件。
- **I2 正文原样**：去掉 TT 尾部占位符后，落楼正文 = `output/main.md`。卡/世界书要求的变量块等格式原样放行，不校验、不改写、不剥除。
- **I3** 无 drift 恢复；**I4** 每轮 `chat_commit_recorded=1`、`run_completed=1`、终态 `completed`。
- **I5 压缩一致**：cursor / compLog / 隐藏楼层三边对账；压缩失败不留脏数据。
- **I6 一套系统**：扩展、Profile、提示词不随卡或模型变化。

**明确不做**：卡变量（MVU 等）的定义、校验、锁定、写回、渲染——归卡与第三方插件。旧版的变量层（`state_propose` / 守卫 / schema / KV / lock）已于 v0.5 剥离。

## 文件

| 路径 | 说明 | md5 |
|---|---|---|
| `ext/abc/index.js` | 扩展本体（v1.0.0） | `ba45351134d7d314fe3c6990ffe07bfa` |
| `ext/abc/manifest.json` | 扩展清单 | `43a5d859c7ececa2975a020f5d6ab7f8` |
| `profiles/abc-test.json` | 主 Profile：12 项工具（`chat.search`/`chat.read_messages` deny），系统提示 982 字符 md5 `2f2a9fc2015fdb887cbe3c3a56c2cc22` | `06bdaf863e69751ff486e2d475bf9430` |
| `profiles/abc-compress.json` | 压缩 Profile：3 项工具，系统提示 796 字符 md5 `8110b13b18c8fabb1d36866719f3c5b9` | `354e32198ad66a0efa85d0eec800dbaf` |
| `docs/install.md` | 安装步骤（adb 推送、备份、校验） | |
| `docs/design-v1.0.md` | 完整设计文档 | |

主 Profile 引用名为 `Agent-ABC-Test` 的 openai 预设（`preset.ref`），安装时需在酒馆里有同名预设。

## 依赖

- TauriTavern `v2.4.0`（源码 `Darkatse/TauriTavern`，commit `fff9af0333be97697be2313981699ab0ce35c236`），安卓版，开启 Agent 模式。
- 任意支持工具调用的模型（真机主要在 gemini-3.8-flash-high 上验证）。

## 验证状态

真机（Honor JAD-AL50 / Android 12）：主 run 单次调用、压缩链路、多卡通用性均已通过；**韧性（截断/超时/取消/慢网/≥200 楼）未验**，详见 `HANDOFF.md`。

文档中引用的 `rounds/…`、`upstream/…` 路径属于私有开发仓库的测试证据，未随本仓库公开。
