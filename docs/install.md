# 安装说明 · 扩展 abc v1.0.0

> 目标读者：要在一台新设备上装起这套「干净 Agent 运行系统」的人。
> 全程只需要三样东西：`ext/abc/index.js`、`ext/abc/manifest.json`、两份 Profile JSON。
> 本说明所有命令都在一条真实设备上跑过（Honor JAD-AL50 / Android 12 / TauriTavern 2.4.0，2026-10-29～30）。

## 0. 需要准备

| 项 | 值 |
|---|---|
| adb | `platform-tools` 里的 `adb`，建议用绝对路径 |
| 设备序列号 | `adb devices` 里那条 **`device`**（不是 `offline`/`unauthorized`） |
| 数据根 | `/sdcard/Android/data/com.tauritavern.client/data` |
| 扩展目录 | `…/data/default-user/extensions/abc/` |
| Profile 目录 | `…/data/_tauritavern/agent-profiles/profiles/` |

> 每次 adb 调用都带 `-s <序列号>`。多台设备（含模拟器）时不带会随机命中。

## 1. 先备份（不可跳过）

改之前必须把**将被覆盖的文件**复制到设备之外，并打印 md5：

```powershell
$adb='<adb 绝对路径>'; $ser='<序列号>'
$Dev='/sdcard/Android/data/com.tauritavern.client/data'
$bk="<备份目录>\abc-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force "$bk" | Out-Null
foreach($f in @(
  "$Dev/default-user/extensions/abc/index.js",
  "$Dev/default-user/extensions/abc/manifest.json",
  "$Dev/_tauritavern/agent-profiles/profiles/abc-test.json",
  "$Dev/_tauritavern/agent-profiles/profiles/abc-compress.json")){
  & $adb -s $ser pull $f $bk 2>&1 | Out-Null
}
Get-ChildItem $bk | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm MD5).Hash.ToLower(), $_.Name }
```

**备份失败＝不许继续。**

## 2. 推送

```powershell
& $adb -s $ser push "ext\abc\index.js"         "$Dev/default-user/extensions/abc/index.js"
& $adb -s $ser push "ext\abc\manifest.json"    "$Dev/default-user/extensions/abc/manifest.json"
& $adb -s $ser push "profiles\abc-test.json"     "$Dev/_tauritavern/agent-profiles/profiles/abc-test.json"
& $adb -s $ser push "profiles\abc-compress.json" "$Dev/_tauritavern/agent-profiles/profiles/abc-compress.json"
```

带空格/中文的路径可以直接 `adb push/pull`（实测可用）；只有 `adb shell` 里的引号容易被吃。

## 3. 核 md5（不一致就停）

```powershell
& $adb -s $ser shell "md5sum $Dev/default-user/extensions/abc/index.js $Dev/default-user/extensions/abc/manifest.json $Dev/_tauritavern/agent-profiles/profiles/abc-test.json $Dev/_tauritavern/agent-profiles/profiles/abc-compress.json"
```

对照表（R05 + v0.2 兼容位清理后）：

| 文件 | md5 |
|---|---|
| `index.js` | `6fb0978c70c1154db6315e22a4d57b72`（34897 B） |
| `manifest.json` | `8f42d81f7e9ead8b95bb781f1440f7b3` |
| `abc-test.json` | `38859a60d540515b29ca69d45a03a69d` |
| `abc-compress.json` | `354e32198ad66a0efa85d0eec800dbaf` |

## 4. 重启 App

```powershell
& $adb -s $ser shell am force-stop com.tauritavern.client
& $adb -s $ser shell am start -n com.tauritavern.client/.MainActivity
```

活动名可用 `cmd package resolve-activity --brief com.tauritavern.client` 取（本机是 `.MainActivity`）。
**必须 force-stop**：扩展是 WebView 内常驻脚本，不重启不会重载。

## 5. 冒烟（5 分钟）

1. 打开目标聊天，确认聊天名（别发到别的聊天，见坑 #19）；
2. 发一条短消息；
3. 拉该 run 判一遍：

```powershell
python rounds/R03/judge.py --run rounds/R03/runs/<runId> --chat "<聊天 jsonl>"
```

全 PASS 才算装好；`M1a` 应命中 **982 字符 / `2f2a9fc2…`**。

## 6. 回滚

把 §1 备份目录里的文件 push 回原路径（`index.js` / 两份 Profile），重启 App。
**不要删聊天、不要 `pm clear`、不要卸载重装**——压缩只改 `chat_metadata.abc`，聊天内容一个字都没动。

## 7. 踩过的坑（会再踩）

| # | 坑 | 正确做法 |
|---|---|---|
| 1 | 用 `pm clear` 或「清理」脚本 | **绝对禁止**。Android 12 实测 `pm clear --cache-only` 等同全清 |
| 2 | 不重启 App 就以为装好了 | 必须 `am force-stop` 后重启 |
| 3 | `adb` 掉线时 shell 全失败但不报错 | 轮询前先 `adb get-state`，否则把「设备没了」当成「没发消息」 |
| 4 | 用 `ls` 尾元素取最新 run | 顺序不定，用 `ls -t` 或按 `run.json.createdAt` 过滤 |
| 5 | 认为压缩按「轮数」触发 | 按**可见条数**：≥10 触发、压完留 6；一次用户消息增 2 楼 |
| 6 | 认为 `preset` 有 `none` | TT 只有 `currentPromptSnapshot \| ref`，「解绑」只能改成继承当前预设 |
| 7 | 压缩提示写死在扩展里 | R04 起读压缩 Profile 的 `instructions.agentSystemPrompt`（796 / `8110b13b…`） |
| 8 | 只看 `debug` 判定压缩 | `debug` 有环形上限（现 300），另看 `chat_metadata.abc.compEvidence`、`compLog`、压缩 run 用户段里的范围 |
| 9 | 批量事后算 C6 的 `to = L−7` | `L` 要用「`send_date ≤ 压缩 run createdAt` 的楼层数」重建，不能用最终楼层数 |
| 10 | PS 5.1 读中文 `.ps1` 乱码 | 存 UTF-8 **带 BOM** |
| 11 | 后台跑 `.ps1` 被拦 | `powershell -NoProfile -ExecutionPolicy Bypass -File …` |
| 12 | `$r` 和 `$R` 撞车 | PS 变量名大小写不敏感，用 `$repo` / `$RunsDir` |

## 8. 可选：真机验收

完整剧本见 `rounds/R03/test-plan.md`（主 run）与 `rounds/R04/report.md §3`（压缩）。判据脚本见 `docs/design-v1.0.md` 附录。
