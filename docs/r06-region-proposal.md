# 提案：给区域展开加「前缀过滤」与「图标随值变」

> 对象：`mvu-skin-kit`（皮肤渲染引擎）
> 依据：`docs/r06-skin-region-contract.md` §2 / §7（区域四出口、图标为声明期常量、区域无过滤能力）
> 性质：**向后兼容的增量能力**，不改变现有声明的任何行为

---

## 1. 要解决的问题

现在「区域」只有两种用法：整块声明（`path` 一个一个写死），或整容器无差别展开（对象分支 `Object.keys` 全 dump）。这带来两个限制：

| 限制 | 后果 |
|---|---|
| 区域不能过滤 | 想「只展开某前缀的键」无法表达；容器里塞了内部字段（`_sys` 之类）就会一起上屏 |
| 图标不随值变 | 同一格永远是同一个图标；想让「状态=某值 → 换成对应图标」必须预先声明 N 个格子 |

这两件事其实是同一个缺口的两个面：**区域与数据之间缺少一层「选取 + 映射」**。

---

## 2. 能力一：区域前缀过滤

### 声明侧

```json
{
  "path": "CONTAINER_X",
  "prefix": "icon_",
  "title": "状态",
  "icon_from_key": true,
  "map": "some_map"
}
```

- `prefix` 省略 → 行为与今天完全一致（整展开）
- `prefix` 存在 → 只取以该串开头的键
- `icon_from_key: true` → 把键名去掉前缀后当作 glyph 名

### 引擎侧改动（`src/core.js`，② 分支）

```js
if (isPlainObj(raw)) {
  const prefix = typeof drawer.prefix === 'string' ? drawer.prefix : '';
  return Object.keys(raw)
    .filter((k) => !prefix || k.startsWith(prefix))
    .map((k) => {
      const iconName = drawer.icon_from_key ? k.slice(prefix.length) : undefined;
      return { icon: iconName, text: toText(raw[k], maps[drawer.map]) };
    });
}
```

注意三处顺带修好的既有缺陷：
- `toText(raw[k])` 补上 `map`（当前 ② 分支不传 `map`，`map` 失效）
- 返回结构化 `{ icon, text }` 而非裸字符串，使图标能来自数据
- `limit` 一并生效（见 §4）

### 示例

```json
// 声明
{ "path": "ENTITY_A", "prefix": "icon_", "icon_from_key": true, "title": "状态" }
```

```json
// 数据
{ "icon_heart": "心动", "icon_bolt": "体力充沛", "内部字段": "不上屏" }
```

```text
// 渲染
[heart 图标] 心动
[bolt  图标] 体力充沛
```

`内部字段` 因为不带前缀被过滤掉——这正是当前整展开做不到的。

---

## 3. 能力二：图标随值变

### 声明侧

```json
{ "path": "SOME_SCALAR", "icon_path": "ICON_NAME_FIELD", "icon_map": "mood_to_icon" }
```

- `icon_path`：从变量里取 glyph 名
- `icon_map`（可选）：把取值经映射表转成 glyph 名，避免让模型直接输出引擎内部名
- 两者都省略 → 保持 `icon` 常量行为

### 引擎侧改动（`src/core.js`，`buildHud()` / `buildNow()`）

```js
function pickIcon(item, stat, maps) {
  if (typeof item.icon_path === 'string') {
    const v = valueOf(getPath(stat, item.icon_path));
    const m = item.icon_map ? maps[item.icon_map] : undefined;
    const name = m && Object.prototype.hasOwnProperty.call(m, v) ? m[v] : v;
    if (typeof name === 'string') return name;
  }
  return item.icon === undefined ? null : item.icon;
}
```

`buildHud` 与 `buildNow` 各把 `item.icon` 换成 `pickIcon(item, stat, maps)` 即可。

### 示例

```json
// 声明：心情值决定图标
{ "icon_map": "mood_to_icon", "icon_path": "ENTITY_A.mood", "path": "ENTITY_A.mood" }
```

```json
// maps.mood_to_icon
{ "平静": "mood", "开心": "heart", "害羞": "lips", "难过": "heart-broken" }
```

于是同一格：心情变了，图标跟着变，不需要预声明 8 个格子。

---

## 4. 顺带修：对象分支的参数脱节

当前 ② 分支完全忽略 `limit` / `filter` / `map`，且无上限。建议在同一处补齐：

```js
let keys = Object.keys(raw).filter((k) => !prefix || k.startsWith(prefix));
if (isPlainObj(drawer.filter)) {
  keys = keys.filter((k) => valueOf(raw[k]) === drawer.filter.equals);
}
if (typeof drawer.limit === 'number' && drawer.limit >= 0 && keys.length > drawer.limit) {
  keys = keys.slice(0, drawer.limit);     // 注意：数组分支取的是尾部 slice(-limit)，
}                                          // 对象分支建议取头部，语义不同需在文档说明
return keys.map(...);
```

> 语义分歧需明确：数组分支 `slice(items.length - limit)` 是**保留最新 N 条**；对象键无时序，建议**保留前 N 个键**，并在文档中写明两者不同。

---

## 5. 兼容性

| 声明含 | 行为 |
|---|---|
| 无 `prefix` / `icon_path` / `icon_map` | **与当前版本逐字节等价**（新增分支全部短路回旧逻辑） |
| 仅 `prefix` | 对象整展开 + 过滤 |
| 仅 `icon_path` | 图标来源改为变量 |
| 两者同时 | 过滤后的每个键可用键名当图标名 |

返回值形状从「字符串数组」变为「`{icon, text}` 数组」是**内部契约变化**，只影响 `buildDrawers()` 到 `src/index.js` 之间的数据形状，不涉及声明格式。

---

## 6. 验收标准

1. **不回归**：取一张不含新字段的既有卡，改造前后渲染出的 DOM 应逐节点一致（可用截图哈希或快照对比）。
2. **前缀过滤**：容器内混入不带前缀的键，确认不上屏。
3. **图标随值变**：改一次 `icon_path` 指向的变量值，确认图标节点变化；值不在 `icon_map` 时回落 `icon` 常量。
4. **静默失败可见化（建议顺手做）**：`icon()` 查表未命中时 `console.warn` 一次（当前是静默 `null`），便于卡作者定位错名。

---

## 7. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 扩展开销 | 每次渲染遍历容器键 | 键数量级为个位数，可忽略 |
| 声明复杂度上升 | 多两个可选字段 | 全部可选，旧卡零改动 |
| 与未来上游版本冲突 | 属第三方扩展，升级会覆盖 | 以 patch 形式维护，升级后重放；本仓库已在 `docs/r06-patch.diff` 采用同样做法 |
| 图标名来自模型输出 | 模型可能输出不存在的 glyph 名 | 用 `icon_map` 做白名单映射，不接受模型直出的图标名 |
