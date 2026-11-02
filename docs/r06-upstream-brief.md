# R06 接手引导（给上游 Agent / 接手者）

> 这份文件是入口。读完它，你就知道该看哪个文件、哪些已经做完、你下一步该动哪里。
> 上一轮入口：`HANDOFF.md` → `docs/tech-notes.md`。本文件不替代它们，只补 R06 增量。

---

## 30 秒现状

- `v1.0.0` = 开发线 `0.5.0-r03` 代码，二者仅 `EXT_VERSION` 一行不同（已在真机独立复核）。
- 上一轮交接把四个真问题（P1 轮询 / P2 并发 / P3 标签污染 / P4 压缩慢）留在「未做」。
- R06 在真机上做完了一轮实测，**结论有三条会改变你对这个项目的认知**：

1. **P3 的前置条件一直成立，但 15/15 次压缩未复发。** 正文 40/41 个助手楼层都带 `<UpdateVariable>` / `<JSONPatch>` / `<StatusPlaceHolderImpl/>`，`rangeText()` 零过滤，可 `chronicle` 从未被污染。所以 P3 不是「已发生的事故」，是「依赖模型自觉的潜伏风险」。修它仍然值得，但优先级低于你原本可能以为的。
2. **「压缩失败率高」是误判。** 观测到的 6/10 失败全部来自网关 `503 system disk overloaded`，与 abc 无关。任何压缩可靠性结论，必须先声明网关状态。
3. **`debug` 窗口的瓶颈不是轮询噪声，是压缩周期本身**（每次压缩固定追加 8 条，占窗口 56%）。长局（300 轮 = 600 楼）下旧上限 300 只能保住约 83 楼。
4. **皮肤侧的问题基本不是引擎缺陷，是声明与数据形状不匹配。** 引擎的「区域」= 一个 path，按值的形状展开（对象全展开 / 数组逐项 / 标量空白 / 缺字段空白），**三者全部静默无报错**。这次实测的一张卡里 36 个声明路径有 11 个无数据源，且其中「把标量放进抽屉」这一失效形式无法靠改指字段修复。详见 `docs/r06-skin-region-contract.md`。

---

## 读的顺序

1. `docs/r06-device-findings.md` ← **先读这个**。全部数据、证据路径、问题归属表都在里面。
2. `docs/r06-skin-region-contract.md` ← 皮肤引擎「区域展开」契约。**本次最具复用价值的结论**：三前提、四出口、三处静默失败、形状→区域对应表。
3. `docs/r06-region-proposal.md` ← 引擎侧能力补强提案（前缀过滤 + 图标随值变），带最小改动代码与验收标准。
4. `docs/r06-patch.diff` ← 本轮 abc 扩展的代码改动，可直接审阅 / `git apply`。
5. `docs/tech-notes.md` ← 上一轮的四个问题清单，注意 §3 的文档与代码不一致处仍待修。
6. `HANDOFF.md` ← 工作约定与不变量 I1–I6。

---

## 本轮已经做了什么（可复核，不要重做）

| 项 | 内容 | 复核方式 |
|---|---|---|
| 观测层补丁 | `DBG_MAX` 300→3000；高频事件按 `(evt\|reason)` 单槽归并；`compEvidence` 上限 10→60 | `git apply --check docs/r06-patch.diff`；改动仅 28 增 4 删，不触碰正文链路（B）与压缩决策链路（C） |
| 真机验证 | 已部署到一台 Android 12 真机，`node --check` 通过，设备侧 md5 一致 | 见 §「怎么验」 |
| P3 定量 | 15 次压缩零污染的实测口径与扫描方法 | findings §3 |
| 压缩失败归因 | 拿到网关 503 响应原文与磁盘读数 | findings §2.6 |
| 皮肤类卡实测 | 36 个皮肤路径中 11 个无数据源，附对账方法 | findings §4（填补 `HANDOFF.md` 缺口 3） |
| md5 校验坑 | Windows `autocrlf` 导致同文件两个 md5 | findings §6 |

**未采纳的改动**：卡内容修复（`地图种子` 实体、值域夹紧、`moods` 对齐、`minDepth`）属于使用方的卡，不在本仓库范围，只在 findings §4 记录方法与结论。

---

## 你下一步该做什么（按优先级，含判定标准）

### P0. 采纳观测层补丁并复验

- 动作：`git apply docs/r06-patch.diff`，按 I6 在 `HANDOFF.md` 登记前后 md5（**注意 findings §6：md5 必须基于 LF blob**）。
- 判定：在一条 ≥40 楼的聊天上，`chat_metadata.abc.debug` 出现带 `n` 与 `slot` 字段的条目；`compEvidence` 能超过 10 条。

### P1. 补 P3 的只读过滤（原 §4.3-1）

- 动作：在 `buildCompressMessages()` 拼 `rangeText()` 之前剥离标签块，只影响压缩输入，不改楼层（不违反 I1/I2）。
- 判定：用一张**明确要求输出 `<UpdateVariable>` 的卡**跑 2 次压缩，确认 `chronicle` 中零命中；同时确认落楼正文逐字节未变。
- 注意：`<StatusPlaceHolderImpl/>` 是否可剥，取决于它是否被下游扩展消费——实测该标签由另一个扩展读取，**剥掉会断锚点**，需单独判断。

### P2. 修 `tech-notes.md` §3 的文档不一致

- `design-v1.0.md` §7 写主 run「14 项工具」，实际 **12 项**（`chat.search` / `chat.read_messages` 已 deny）。已用一次真实请求的 `tools count=12` 复核。
- `HANDOFF.md` 缺口 6 所述「`window.__abc` 暴露写操作」在当前代码中已是只读，可标记完成（但需真机复测）。
- 另需补记：`compEvidence` 上限（`tech-notes.md` §2 漏记）。

### P3. 韧性（原 §4.3-2，仍未做）

- 项目：主 run 中途取消 / 压缩 run 中途 `/abc-cancel` / 断网重连 / 200+ 楼。
- 判定：终态只允许 `failed` 或 `cancelled`；聊天行数与 `chat_metadata.abc` 前后不变。
- **前置条件**：先确认网关可用（findings §2.6），否则测的是上游。
- 现有素材不足：实测最长的一条带 abc 数据的聊天只有 82 楼，且 145 楼/98 楼那两条老聊天在 abc 启用之前，**没有 ≥100 楼的 abc 样本**，长局测试需新起一条。

### P4. P1 轮询（原 §4.3-3）

- 先查宿主是否提供 run 创建事件；没有则补「页面重新可见时立即 `discoverOnce()` + 对最近一轮补订阅/补快照」。
- 判据：`discover_skip_not_main` 的累计计数不再单边增长到数百（当前实测约 300 次扫描才命中 1 次有效主 run）。

---

## 不要做什么（红线，违反即破坏设计）

1. 不写 `stat_data`、卡变量、世界书、卡文件（I1）。只写 `chat_metadata.abc.*` 与楼层 `extra.abc_*`。
2. 落楼正文 = `output/main.md`，最多允许一个尾部 `<StatusPlaceHolderImpl/>`（I2）。
3. 不要把变量层（`state_propose` / 守卫 / schema / KV / lock）加回来——项目主人的最终裁定。
4. 不要为了「让 UI 动起来」去改宿主设置里的全局正则或 `chat_virtualization_enabled`：前者作用于所有卡，后者会让按楼层 DOM 挂钩的皮肤失效。
5. 任何修改都在 `HANDOFF.md` 登记前后 md5（I6），且 md5 基于 LF blob。
6. 不要 `force push`，不要改动或复用 `v1.0.0` tag。

---

## 怎么验（命令模板）

```bash
# 1) 补丁可应用性
git apply --check docs/r06-patch.diff

# 2) 语法
node --check ext/abc/index.js

# 3) md5 必须以 LF blob 为准（Windows 下勿直接 md5sum 工作区文件）
git cat-file blob HEAD:ext/abc/index.js > /tmp/x.js && md5sum /tmp/x.js

# 4) 真机取数（唯一可靠入口，扩展把观测全部写在 chat_metadata）
adb pull "/sdcard/Android/data/<PKG>/data/default-user/chats/<CHAT>/<FILE>.jsonl"
#    第 0 行 .chat_metadata.abc = { chronicle, cursor, compLog, debug, compEvidence }

# 5) 宿主侧报错原文（区分 abc 缺陷与上游故障）
adb shell "tail -50 /sdcard/Android/data/<PKG>/logs/tauritavern.log.<date>"
adb pull "/sdcard/Android/data/<PKG>/logs/llm-api-<id>.meta.json"   # errorMessage 原文在此
```

---

## 一句话

本轮把「哪些是 abc 的锅、哪些不是」划清了：**上游 6 项、卡 6 项、我引入并已修 2 项**，并推翻了 P3 的定级。「压缩可靠性」这条先放着，等网关稳定再测——否则任何结论都不可信。
