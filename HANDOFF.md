# 接手说明（2026-10-30）

> 已知问题的技术说明与接手步骤见 `docs/tech-notes.md`（2026-11-02）。
> **R06 增量（2026-11-03）：先读 `docs/r06-upstream-brief.md`，数据与证据见 `docs/r06-device-findings.md`。**

## 现状
- v1.0.0 = 开发线 `0.5.0-r03` 代码（R05 定稿）仅改版本号。按用户决定「草草收到 1.0」发布，未做 R06。
- 已真机通过：
  - R03 剥离：主 run 5/5，压缩 2/2
  - R04 压缩自足：46/46，压缩 system 段恒定
  - R05 多卡通用：压缩 6/6，主 run 每卡 ≥4/5
  - chat.* deny 对照：12/12 主 run 单次调用
- 测试证据均为开发方自测，未经独立复核。

## 未验 / 已知缺口
1. **韧性**：截断、超时、取消、慢网、≥200 楼长对话，均未跑。
2. **干净设备一次装好**：未做（安卓无官方换数据根入口）。
3. **重美化 / 皮肤类卡**：缺测试素材。
4. 主 run 偶发 `model_completed>1`（chat.* 放开时 10 轮里 4 轮；deny 后 12/12 正常）。
5. 主 run 发现靠官方 `listRuns` 每 2 秒轮询（删掉变量工具后无 runId 可拿），尚无事件替代。
6. Profile description 残留旧工具名（不影响运行）；`window.__abc` 仍对外暴露内部写操作（计划收紧为只读 `read.state()/read.system()`）。

## 建议下一步
- 按缺口 6 收紧 `window.__abc`（约 20 行）。
- 跑韧性：截断 / 取消时压缩与落楼都不能留脏数据（终态只允许 failed 或 cancelled，聊天行数与 `chat_metadata.abc` 不变）。
- 任何修改都要登记扩展 / Profile 的前后 md5（不变量 I6）。

## 工作约定
- 中文。
- 不让 Agent 碰卡变量（见 README「明确不做」）。

---

## R06（2026-11-03）：真机实测与观测层补丁

完整报告：`docs/r06-device-findings.md`；接手引导：`docs/r06-upstream-brief.md`。
皮肤引擎的「区域展开」契约与补强提案：`docs/r06-skin-region-contract.md` / `docs/r06-region-proposal.md`。

### 已改（I6 md5 登记，均基于 **LF blob**，Windows 工作区文件因 `autocrlf` 会差 583 B）

| 文件 | 改前 md5 / 大小 | 改后 md5 / 大小 |
|---|---|---|
| `ext/abc/index.js`（见 `docs/r06-patch.diff`，**尚未合入主干**） | `ba45351134d7d314fe3c6990ffe07bfa` / 34,893 B | `e4164a8f195293b6e32093b22f4a2d5e` / 36,309 B |
| `ext/abc/manifest.json` | `43a5d859c7ececa2975a020f5d6ab7f8` / 128 B | `b6eb56593cd91412a43af3928e9e35da` / 132 B（`version` → `0.5.1-r04`） |

补丁内容：`DBG_MAX` 300→3000；`dbg()` 对 `discover_skip_not_main` / `compress_skip` / `finalize_skip_replayed` 按 `(evt|reason)` 单槽归并；`compEvidence` 上限 10→60。纯观测层，不触碰 I1/I2 行为。

### 对上一轮结论的修订

- 缺口 3（皮肤类卡缺素材）：**已补实测**，见 findings §4。结论：36 个皮肤路径中 11 个在卡 schema 中无数据源，属卡内容问题。
- 缺口 5（P1 轮询）：量级补充——约 300 次扫描命中 1 次有效主 run。
- `tech-notes.md` §1-P3：**定级修订**。前置条件一直成立（40/41 助手楼层含标签、`rangeText()` 零过滤），但 15/15 次压缩 `chronicle` 零污染 → 从「已发生」改为「依赖模型自觉的潜伏风险」。
- `tech-notes.md` §1-P4 的 22–51 s：实测已到 **40–60 s**；且为取 `generationParameters` 需读取整份 `prompt_snapshot.json`（实测 565–695 KB，约 +1.5 KB/楼）。
- `tech-notes.md` §2 漏记：`compEvidence` 也有硬上限（原 10）。

### 新增必读注意事项

1. **压缩可靠性实验必须先声明网关状态**。本轮观测到的「6/10 压缩失败」根因是网关返回 `503 system disk overloaded`，与 abc 无关。
2. **md5 校验一律基于 LF blob**（`git cat-file blob HEAD:ext/abc/index.js`），否则 Windows 上必然出现假差异。
3. `tech-notes.md` §3 的「14 项工具」仍待修为 **12 项**（已用真实请求 `tools count=12` 复核）。
