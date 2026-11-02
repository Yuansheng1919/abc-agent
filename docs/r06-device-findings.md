# R06 真机实测报告（2026-11-03）

> 对象：abc-agent v1.0.0（代码等价开发线 `0.5.0-r03`，二者仅 `EXT_VERSION` 一行不同）
> 环境：Android 12 真机；TauriTavern 2.4.0（commit `fff9af03…`）；扩展 `abc` 0.5.0-r03
> 证据来源：聊天 `chat_metadata.abc` / 设备端 Rust 日志 / LLM 调用记录 / 卡文件本体
> 脱敏：卡名、角色名、聊天正文、网关地址、设备标识均已替换为占位符；不含任何剧情内容

本报告对应 `tech-notes.md` §4.3 建议顺序中的第 1 项（P3）与 `HANDOFF.md` 缺口 1/3/5，并新增两处 `tech-notes.md` 未记录的缺陷。

---

## 0. 问题归属：哪些是原有的

**关键结论：本次发现的问题全部不是由本次改动产生的。** 分三类：

| 归属 | 项 | 说明 |
|---|---|---|
| **A. 上游原有**（本仓库代码/宿主行为） | 6 项 | `debug` 窗口溢出、`compEvidence` 上限未文档化、R05 去重不彻底、压缩耗时与 `prompt_snapshot` 读取成本、P1 轮询、P3 前置条件长期成立 |
| **B. 卡内容原有**（不在本仓库范围内） | 6 项 | 见 §4。卡文件早于本次介入存在，问题随时间累积暴露 |
| **C. 本次改动引入并已修复** | 2 项 | 见 §5，逐条记录，含修复后的 md5 |
| **D. 本次推翻的既有判断** | 1 项 | 见 §3（P3 的真实状态） |

---

## 1. 取数方法（可复现）

扩展不拦截模型请求，且 App 的 WebView 远程调试未开启（无 `webview_devtools_remote_<pid>` socket，`__abc.read.state()` 不可达）。因此唯一可靠入口是扩展自己写的 `chat_metadata`——源码注释即写明「调试只落 chat_metadata（不上屏），adb pull 聊天 jsonl 即可取」。

```
adb pull "/sdcard/Android/data/<PKG>/data/default-user/chats/<CHAT>/<FILE>.jsonl"
```

jsonl 第 0 行为 `chat_metadata`，其 `abc` 子树即全部观测数据：`chronicle` / `cursor` / `compLog` / `debug` / `compEvidence`。楼层证据在每行的 `variables` 与 `extra.abc_mem`。

设备侧补充来源：
- `logs/tauritavern.log.<date>`：Rust 层日志，`frontend:` 前缀的行为前端抛出的异常
- `logs/llm-api-<id>.meta.json`：单次调用的请求/响应元数据（含 `errorMessage` 原文）
- `default-user/tauritavern-settings.json`：宿主配置（`dev.llm_api_keep` / `chat_backups` / `request_proxy`）

---

## 2. 上游原有缺陷（附真机数据）

### 2.1 `debug` 环形窗口在 83 楼顶满（`DBG_MAX = 300`）

实测该聊天 **83 楼时 `debug` 恰好 300/300**，密度 **3.61 条/楼**（`300 ÷ 3.61 ≈ 83`）。构成：

| 来源 | 条数 | 占比 |
|---|---|---|
| 压缩周期（`compress_start` / `gp_from_main_snapshot` / `compress_snapshot_built` / `compress_run_started` / `chronicle_commit` / `chronicle_staged` / `compress_run_terminal` / `compress_applied`，每次 8 条） | 168 | **56%** |
| `main_run_completed` | 50 | 17% |
| 跳过类（`compress_skip` 27 + `discover_skip_not_main` 27 + `finalize_skip_replayed` 13） | 67 | 22% |
| 其它 | 15 | 5% |

**主因不是轮询噪声，而是压缩周期本身**：压缩约每 4 楼触发一次（`compLog.to` 序列 `4,8,12,16,20,24,28,32,36,40,52,64,68,72,76`），一次固定追加 8 条。

长局换算：**一轮 = 用户句 + 助手句 = 2 楼**，故 300 轮 = 600 楼，旧上限仅能保住最近约 83 楼；溢出后最旧的诊断证据被静默丢弃，且不可恢复。

### 2.2 `compEvidence` 上限为 10，`tech-notes.md` 未记录

`tech-notes.md` §2 只记了 `compLog` 上限 50、`debug` 上限 300。实际 `compEvidence` 同样有硬上限 **10**（`index.js` 内 `splice`），导致 `tech-notes.md` §4.4 所说「每次压缩一条，`outcome` 应走 `pending → started → applied | discarded`」在实际排查时只剩最近 10 次。

### 2.3 R05 去重只解决「同 runId」，跨 runId 仍占槽

`discover_skip_not_main` 按 `runId + profileId` 去重，但每个新 runId 仍各占一条。实测 27 条中多数来自不同 runId 的压缩 run，属于结构性的必然增长，而非异常。

### 2.4 压缩耗时与 `generationParameters` 的取法成本

`readMainGenerationParameters()` 通过读取主 run 的 `input/prompt_snapshot.json` 拿 `generationParameters`。实测该文件随楼层线性增长：

| 采样时点 | 大小 | 约对应楼层 |
|---|---|---|
| 起始 | 577,938 B | ≈ 2 楼 |
| 中段 | 624,038 B | ≈ 26 楼 |
| 后段 | 659,891 B | ≈ 78 楼 |
| 末段 | 695,295 B | ≈ 80 楼 |

**约 +1.5 KB/楼**；为取一个 `generationParameters` 对象而读取并 `JSON.parse` 整份快照。压缩 run 自身的 `prompt_snapshot` 仅 10–39 KB（`buildCompressMessages` 只构造 2 条消息），说明这份读取纯属必要成本之外的负担。

压缩实测耗时 **40.3 s / 47.2 s / 60.0 s**（三次成功周期），超出 `tech-notes.md` §1-P4 记录的 22–51 s 区间，且使用的是与主 run 相同的高思考档模型。

### 2.5 P1 轮询空转的具体量级

`discover_skip_not_main` 的累计 `count` 在观测窗口内从 229 涨到 304——即约 **300 次轮询扫描才遇到 1 次需要处理的主 run**。这与 `tech-notes.md` §1-P1 一致，本次只补充量级。

### 2.6 压缩「失败率高」的真实根因在网关，不在 abc

观测窗口内 `compEvidence` 10 条中有 6 条 `discarded`、`discardReason = run_failed`，表面看是压缩链路不可靠。拉 `llm-api-*.meta.json` 得到响应原文：

```
status 503: system disk overloaded (current: 98.9%, threshold: 95%)
```

三次失败时刻的磁盘读数分别为 **99.5% / 97.9% / 98.9%**，是网关主机的磁盘保护阈值（95%）被击穿，请求在 1.1–2.2 s 内被快速拒绝。同期随后恢复正常（同端点 `POST /v1/messages` 含 848 KB 请求体 + `stream: true` 返回 200 并可正常流式输出）。

**方法论结论：任何「压缩可靠性」结论必须先声明网关状态，否则测的是上游而非 abc。** 建议把这一点写进 `tech-notes.md` §2 的未验证清单。

---

## 3. 推翻一条既有判断：P3 的前置条件一直成立

`tech-notes.md` §1-P3 描述 `<UpdateVariable>` / `<JSONPatch>` / `<StatusPlaceHolderImpl/>` 会被原样落楼。本次首次对**正文**做扫描（此前易误查 `chronicle`/`compLog` 字段）：

| 标签 | 出现的 assistant 楼层 |
|---|---|
| `<UpdateVariable>` / `</UpdateVariable>` | **40 / 41** |
| `<JSONPatch>` / `</JSONPatch>` / `<Analysis>` | 40 / 41 |
| `<StatusPlaceHolderImpl/>` | **41 / 41** |

而压缩输入侧确认**零过滤**：

```js
function rangeText(from, to) { return ctx().chat.slice(from, to + 1).map(x => x.mes || '').join('\n'); }
```

即压缩 run 拿到的原文必然带全套标签。

**但实测 15 次压缩、15 条 `compLog`、`chronicle` 全部零污染**（`<UpdateVariable` / `<JSONPatch` / `<Analysis` / `<StatusPlaceHolderImpl` / `{{get` / `{{set` 命中均为 0）。

修正后的定级：**P3 是「代码缺陷成立 + 前置条件成立 + 15/15 未复发」**，从「已发生」降为「依赖模型自觉的潜伏风险」。仍建议按 `tech-notes.md` §4.3-1 在 `buildCompressMessages()` 处补只读过滤——因为当前的安全性完全来自模型没有主动复述标签，换指令或换模型即可能失效。

同时确认修复成本极低：`rangeText` 是单点函数，加一层正则剥离不影响落楼正文，不触碰 I1/I2。

---

## 4. 皮肤类卡（填补 `HANDOFF.md` 缺口 3「重美化 / 皮肤类卡：缺测试素材」）

测试素材为一张带 MVU 皮肤（`mvu_skin` 声明 + `maps` / `entities` / `hud` / `regex_scripts`）的卡。以下问题均为**卡内容原有**，不属于本仓库代码，但对使用方有普遍性。

### 4.1 皮肤声明的 36 个变量路径中 11 个在卡 schema 中不存在

按皮肤声明逐个解析运行时 `stat_data`：**25 个可取到值，11 个取不到**。取不到的路径对应面板**永久为空**，与楼层数量、游玩时长无关：

| 缺失路径 | 受影响 UI |
|---|---|
| `世界.天气` | HUD 的一个槽位 |
| `今日` | 主角抽屉「今天」 |
| `CHARA_A/CHARA_B.已知喜好` | 两个抽屉「喜欢的东西」（卡中实际字段名为 `喜好.地点`） |
| `CHARA_A/CHARA_B.占有欲` | 两个环形指标 |
| `CHARA_A/CHARA_B.收到的礼物` | 两个抽屉 |
| `CHARA_A/CHARA_B.衣柜` | 衣橱面板 |
| `约定` | 约定抽屉（带 `和谁` 过滤的表格） |

其中 3 个属于**纯指错字段、数据本已存在**，改指向即可修复且零成本（见 `docs/r06-patch-card.md`）。

### 4.2 规则悬空引用：`地图种子` 条目不存在

卡的变量更新规则写着「地点: 必须是地点表里的 key（**见地图种子条目**）」，但 `character_book` 内并无该条目。模型手上没有合法值域表，实测出现**中文名与 key 混写**：

```
LS_A.loc = "home.living"    ← 合法 key
LS_A.loc = "某中文地点名"            ← 中文名，皮肤无此映射
```

而背景拼路径的写法是 `bg/{location}_{dayornight}.webp`，中文值必然拼出不存在文件。

补充：`maps.locations` 本身也不完整——`bg/` 素材目录中存在 `home.kitchen` / `home.entrance` / `home.toilet` 三张背景图，但 `maps` 中没有对应 key；同时 `[initvar]` 引用了 `maps` 里没有的 `home.kitchen` / `town.cake`。**值域表、素材、初始化数据三者互不一致。**

### 4.3 数值字段无夹紧

规则对 0–100 字段只写「0~100，单楼最多 ±X」，无强制动作。实测同一聊天内：

| 楼层 | STA（守卫独占） | DESIRE | AFFECTION |
|---|---|---|---|
| 0 | 100 | 10 | 20 |
| ≈63 | 10 | 245 | 110 |
| ≈82 | **−140** | **294** | 100 |

后果之一：环形指标按 `[0,100]` 映射后会把负值钳到 0%，于是 `STA` 环**从某层起永久停在 0%**，看起来就是「UI 永远不动」。

### 4.4 心情词表与素材不一致

规则列 8 个合法取值；皮肤 `moods` 表另列 6 个，二者交集只有 3 个。而素材目录实际存在 7 张 `head_<词>.webp`，正好等于规则 8 词减去一个回落词。

即：**皮肤 `moods` 里有 3 个词没有任何素材，另有 4 个有素材的词不在表内。** 在另一条同卡的年轻聊天中实测到 `MOOD = 低落`（属于旧 `moods` 表、无素材）→ 立绘必然回落默认图。

### 4.5 显示层隐藏正则 `minDepth = 4`

卡内嵌 `regex_scripts` 用于在显示层隐藏变量块，配置为 `markdownOnly: true`、`placement: [2]`、**`minDepth: 4`**、`maxDepth: null`。

宿主深度自消息末尾反向计数，`minDepth = 4` 意味着**最新 4 条消息不参与处理**。表现：消息刚生成时裸漏，被顶到深度 ≥5 后变干净，下一条又裸漏——观感即「修好过又反弹」。

同时发现宿主全局存在**同名第二份**同功能正则（`minDepth: 0`，配置正确）但 `disabled: true`。两份并存且一份休眠，是此类「反弹」的第二个入口：卡被替换或白名单丢失时，休眠的那份若不接管，隐藏会整体失效。

补充：该正则只隐藏变量块，`<StatusPlaceHolderImpl/>` 由别的扩展消费，**不可一并隐藏**，否则会断掉其锚点。

---

## 5. 本次改动引入并已修复的回归（逐条记录）

诚实记录，两处均已修复并复验。

### 5.1 值域表按 `maps` 原样生成，导致排除有素材的地点

首次新增「地图种子」条目时直接取 `maps.locations`（15 key）。但 `bg/` 素材里存在 `home.kitchen` / `home.entrance` / `home.toilet` 三张图，不在 `maps` 中——等于**把有背景图的厨房/玄关/卫生间在规则层禁掉了**。已修正为 19 key，并同步 `maps` 与规则中的数量表述。

### 5.2 `DBG_MAX` 首版定容错误

首版按「300 轮 = 300 个主 run」估为 1500。但一轮 = 2 楼，密度按楼计：600 楼 × 2.80 条/楼 ≈ 1680 > 1500，约 **267 轮即再次溢出**。已改为 3000。

口径修正后的容量（按楼仿真，含真实事件构成）：

| 轮数 | 楼层 | 旧上限 300 | 新上限 3000 + 单槽 |
|---|---|---|---|
| 100 | 200 | 溢出 | 549 条，未溢出 |
| 300 | 600 | 溢出 | 1642 条，未溢出 |
| 500 | 1000 | 溢出 | 2735 条，未溢出 |
| 700 | 1400 | 溢出 | 3000 条，顶满 |

体积：3000 条约 140 KB，只写 `chat_metadata`（jsonl 第 0 行），不进楼层。

---

## 6. md5 校验的坑（影响 `HANDOFF.md` 与 `tech-notes.md` §4.1 的可执行性）

`tech-notes.md` §4.1 要求 `md5sum ext/abc/index.js ext/abc/manifest.json profiles/*.json` 与 README 表格一致。但 **Windows 下 `core.autocrlf` 会在 checkout 时把 LF 换成 CRLF**，同一文件的两个 md5 互不相等：

| 形态 | 大小 | md5 |
|---|---|---|
| 仓库 LF blob（`git cat-file blob HEAD:ext/abc/index.js`） | 34,893 B | `ba45351134d7d314fe3c6990ffe07bfa` |
| Windows checkout（CRLF） | 35,476 B | `550815cdf354a482644a1605efeec054` |

差值 583 B ≈ 行数 584 × 1。**建议在校验说明中注明「md5 一律基于 LF blob 计算」**，否则接手者在 Windows 上必然得到「校验不通过」的假差异。

---

## 7. 建议

**对上游（abc 扩展）**
1. 采纳 `docs/r06-patch.diff`：`DBG_MAX = 3000` + 高频事件按 `(evt|reason)` 单槽归并 + `compEvidence` 上限 60。
2. 补文档：`compEvidence` 上限 10（或按上条改后的 60）。
3. 可选优化：把压缩周期的 8 条合并为 3–4 条（`start+scheduled` / `committed+staged` / `terminal+applied`），可再省约 50% 窗口，且不损失关键因果链。
4. `rangeText()` 处补只读标签过滤（`tech-notes.md` §4.3-1），把 P3 从「依赖模型自觉」改为「代码保证」。
5. 在 `tech-notes.md` §2 未验证清单中补一句：**压缩可靠性实验必须同时记录网关可用状态**。

**对卡作者（不在本仓库范围）**
1. 新增实体化的「地点表」条目，与 `maps.locations` 及 `bg/` 素材三方对齐。
2. 0–100 字段改为硬区间 + 越界时输出 `replace` 夹紧。
3. 皮肤 `moods` 与素材文件名对齐。
4. 显示层隐藏正则 `minDepth` 置 0 / `maxDepth` 置空；并清除或启用休眠的同名全局副本。
5. 对「皮肤声明路径 vs 卡 schema」做一次机械化对账——本次 11/36 的失配率说明这类卡应把对账纳入发布前检查。

**对外部使用者**
- 若心智模型是「UI 不跟着剧情变」，先分清三件事：变量没写对（值域/路径）、皮肤没指对（字段名）、素材没对上（文件名）。三者症状相同、修法完全不同。本文 §4 给出了区分方法：把皮肤声明的**全部**路径对运行时 `stat_data` 逐条解析，缺失项即为「永久不动的格子」。
