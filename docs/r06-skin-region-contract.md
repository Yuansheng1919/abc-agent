# 皮肤引擎的「区域展开」契约（真机实测）

> 对象：`mvu-skin-kit`（皮肤渲染引擎）+ 任意声明 `mvu_skin` 的卡
> 方法：读引擎源码（`src/core.js` 310 行 + `src/index.js` 704 行）＋ 真机运行时 `stat_data` 与渲染自诊断对账
> 脱敏：不含卡名、角色名、剧情内容；实体名统一为 `ENTITY_A` / `ENTITY_B`

---

## 0. 结论先行

`mvu_skin` 的「区域」= **卡片里声明的一个 `path`**。引擎取该 path 的值，按**值的形状**决定怎么展开。

**区域要能出内容，必须同时满足三个前提：**

| # | 前提 | 不满足时 |
|---|---|---|
| ① | `path` 在运行时数据里存在 | **整块空白**（连标题骨架都没有内容） |
| ② | 取到的值是 **对象** 或 **数组** | **整块空白**——标量无法展开，只能进 `now` / `hud` |
| ③ | 若是数组且元素是对象，元素里必须有 `text_key` 指定的字段 | **每行渲染成 `—`**（有行、无内容，最像 bug 的状态） |

**三者全部静默**：不抛异常、不写控制台、不留占位。这是「UI 不跟着变」最常见的三种成因，且症状完全相同。

---

## 1. 渲染管线

```
buildView(decl, stat)
  ├─ hud          ← decl.hud.items[]           (path + icon + map + format)
  ├─ background   ← decl.background            (location_path + daypart_path → 文件名模板)
  ├─ left         ← decl.left                  (静态图标 + label)
  ├─ right        ← decl.right.entities[]      (实体侧栏)
  └─ entities{id} ← decl.entities[id]
       ├─ name      ← name_path
       ├─ portrait  ← by_path + file 模板 + moods 白名单
       ├─ rings     ← rings[].path + range
       ├─ now       ← now[].path + icon          ← 标量区
       ├─ outfit    ← outfit.path + slots[].key
       └─ drawers   ← drawers[].path             ← 容器区（本文重点）
```

**变量名不参与任何决策。** 全库无 `startsWith` / 前缀扫描 / 对 `stat` 的键遍历；`Object.keys` 只用于枚举 `GLYPHS` 图标表和 `entities` 声明键。

---

## 2. `buildListItems()`：抽屉的唯一入口，四个出口

```js
function buildListItems(drawer, stat, maps) {
  const raw = getPath(stat, drawer.path);
  const list = listOf(raw);
  if (!list) {                                  // 非数组
    if (isPlainObj(raw)) {                      // ② 对象 → 全展开
      return Object.keys(raw).map((k) => String(k) + T.KV_SEP + toText(raw[k]));
    }
    return [];                                  // ③ 标量 / 缺失 → 空白
  }
  ...filter → limit → map/text_key              // ④ 数组 → 逐项
}
```

| 取到的值 | 出口 | 结果 |
|---|---|---|
| 数组 | ④ | 逐项渲染，支持 `filter` / `limit` / `text_key` / `map` |
| **纯对象** | **②** | **全部键各占一行** |
| `[数组, 字符串]` 二元组 | ④（`listOf()` 解包出 `x[0]`） | 按数组渲染 |
| `undefined` / `null` / 数字 / 字符串 / 布尔 | ③ | **空白** |

---

## 3. 全展开（② 分支）的精确行为

表达式：`String(k) + T.KV_SEP + toText(raw[k])`

| 维度 | 行为 |
|---|---|
| 分隔符 | 固定全角冒号 `：`（`i18n.js` 的 `KV_SEP`） |
| 行序 | `Object.keys()` 顺序 = JSON 插入顺序，不可配置、不排序 |
| `map` | **失效**——此处调用 `toText(raw[k])` 未传 `map` |
| 值的值是嵌套对象 | `JSON.stringify` 原样入界面（会出现 `{"a":1}` 字面量） |
| 值是数组 | 用 `、` 连接（`LIST_SEP`） |
| 是空串 / null / undefined | 显示 `—`（`DASH`） |
| `limit` | **失效**——只在数组分支生效，对象分支**无条件全展开** |
| `filter` | **失效**——同上 |
| 图标 | **不参与**——该分支只产出纯文本行 |
| 递归 | **不递归**，只展开第一层 |
| `title` | 仍生效（`buildDrawers()` 调用前已取） |

---

## 4. 形状 → 区域 对应表（设计时照这个选）

| 变量形状 | 该放哪个区域 | 原因 |
|---|---|---|
| **对象** | `drawers` | 走 ② 全展开，`键：值` 逐行 |
| **数组（标量）** | `drawers` + 可选 `map` | 走 ④，逐项 `toText(el, map)` |
| **数组（对象）** | `drawers` + 必填 `text_key`（可选 `filter`） | 缺 `text_key` → 每行 `—` |
| **标量** | `now` / `hud` | 放进 `drawers` 必然空白 |
| **缺字段** | —— | 任何区域都空白 |

---

## 5. 三处静默失败

1. **图标名不存在 → 静默不渲染**。`icon(name)` 用 `hasOwnProperty(GLYPHS, name)` 精确查表，未命中 `return null`，无警告、无回落。可用 glyph 共 **19** 个：
   `pin / daypart / weather / mood / heart / lips / heart-broken / head / torso / legs / feet / accessory / event / bolt / lock-heart / link / speech`（外加一个断心变形）
2. **`moods` 是「闸门」不是「选项列表」**。`portrait` 若值不在 `moods` 内，直接回落 `portrait.fallback`；`picture()` 另有 `onerror` 二次兜底。
3. **`map` 未命中 → 原样输出**。`toText()` 查不到映射就把原字符串显示出来，于是界面上会出现裸的机器值（如内部 key）。

---

## 6. 实测：对任意卡做「区域性体检」

**方法**：把 `mvu_skin` 声明的**全部**路径取出 → 逐个对运行时 `stat_data` 解析 → 按 §2 四出口分类 → 预测渲染结果。输出即「哪些区域活、哪些空、哪些半死」。

某张皮肤类卡的实测结果（脱敏）：

| 区域 | 分类 | 预测渲染 |
|---|---|---|
| 抽屉（对象容器） | ② 全展开 | `键A：值` / `键B：值` —— **正常** |
| 抽屉（标量数组 + `map`） | ④ | `映射值1、映射值2` —— **正常** |
| 抽屉（空数组） | ④ | 无行（合法空态） |
| 抽屉（对象数组 + `text_key` 缺失） | ④ | **`—` × N** —— 半死 |
| 抽屉 × 3（路径不存在） | ③ | **空白** |
| `hud` 6 格 | 标量 | 5 格正常；1 格指向不存在的字段 → 恒为 `—` |

**该卡 5 个可选抽屉中，1 个对象全展开、1 个数组正常、1 个半死、3 个空白；`hud` 6 格中 1 格恒占位。** 全部无报错。

---

## 7. 引擎侧已知设计缺口

1. **`icon` 是声明期常量**。图标不随变量值变化；唯一「值决定图」的两处是 `portrait`（模板文件名）与 `background`（模板文件名），其余均为「固定图标 + 变量文本」。
2. **区域只能整体展开，没有过滤能力**。想「只展开某前缀的键」无法表达。
3. **对象分支与声明参数脱节**：`limit` / `filter` / `map` 在 ② 分支全部失效，且无上限保护——指向大对象会把界面撑满。
4. **嵌套对象降级为 JSON 字面量**，而非缩进展开。

对应改造方案见 `docs/r06-region-proposal.md`。

---

## 8. 给卡作者的建议

1. **按形状配区域**：容器进 `drawers`，标量进 `now` / `hud`。标量放进抽屉是最常见的无效声明。
2. **数组元素统一带 `text_key` 字段**，否则得到一排 `—`。
3. **取值为对象时才有「键：值」全展开**；想得到整齐的两列，就把容器设计成扁平对象。
4. **发布前跑一遍 §6 的机械对账**：这次的失配率（11/36 声明路径无数据源）说明肉眼检查不可靠。
