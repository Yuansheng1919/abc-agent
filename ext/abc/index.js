// ABC 三段式原型扩展 v0.5.0-r03（干净 Agent 运行系统：A 提示词组装 / B 产出落楼 / C 压缩记忆）
// R03 剥离（upstream/20261028-R03剥离-闻讯答复.md @ 3d5b529）：去掉守卫与变量提议工具，主 run 单次调用
//   · 删：守卫判定、预设变量定义、KV 读取、聊天锁定、状态层注入、协议里的变量段
//   · 删：save() 写 chat_metadata.variables 的三行（I1：只写 chat_metadata.abc.* 与楼层 extra.abc_*）
//   · 新聊天 chat_metadata.abc 不再含 state；旧聊天的 state / extra.abc_state / compLog 只读忽略、不删
//   · 压缩链路（buildCompressMessages / maybeCompress / applyCompress）逻辑保持不变；R04 起提示文本改从压缩 Profile 读
//   · 主 run 不再有扩展工具回调可拿 runId，改用官方 listRuns 轮询发现（见文件尾部），标记「默认」
//
// 历史版本（压缩独立化 v0.3-r9 / 变量层 v0.4-r03）见 git 历史与 ext/archive/v0.4-r03-var/
(async () => {
  await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
  const EXT = 'abc';
  const ctx = () => SillyTavern.getContext();
  const CFG = {
    keepRecent: 6,            // 窗口内保留最近 6 条
    triggerUncompressed: 10,  // 未压缩可见消息达到 10 条触发
    toast: true,              // 用提示气泡显示压缩进度（正文无流式）
    injectProtocol: true,     // 产出纪律由扩展注入
    maxQuotes: 3,             // 记忆层「关键原话」最多几条
    discoverMs: 2000,         // 主 run 发现轮询间隔（ms）
    mainProfileId: 'abc-test',// Q3①：只认主 Profile 的 run（压缩 run 不得触发压缩）
    // ---- v0.3（A 实验）----
    compressIndependent: true,       // true = 压缩独立成一次 background run
    compressProfileId: 'abc-compress',
    compressModelMaxTokens: 8192,
  };

  const protocolText = () => `【ABC 产出纪律】
1. 本轮唯一的产出是正文：在一条回复里依次调用 workspace_write_file（output/main.md）、workspace_commit、workspace_finish，不要拆成多次回复。
2. 正文必须满足角色卡与世界书要求的格式；卡要求的写法（变量块、占位符、JSON）原样写进 output/main.md，系统不校验、不改写、不剥除。
3. 用户问到过去的原话或具体细节，而记忆层 C 与可见楼层里没有时，先调用 recall 查原文；查不到就让角色表示记不清，严禁编造原话。
4. 正文只写故事内容，不要写工具名、运行日志或对本系统的说明。`;


  // ---------- 存储 ----------
  function meta() {
    const m = ctx().chatMetadata;
    if (!m.abc) m.abc = { chronicle: '', cursor: -1, compLog: [] };
    if (!Array.isArray(m.abc.compLog)) m.abc.compLog = [];
    return m.abc;
  }
  async function save() {
    const md = ctx().chatMetadata; if (!md) return; meta();
    await ctx().saveMetadata(); refreshPrompts();
  }
  const toast = (msg, kind = 'info') => { if (CFG.toast && window.toastr) window.toastr[kind](msg, 'ABC', { timeOut: 4000 }); };

  // 调试只落 chat_metadata（不上屏），adb pull 聊天 jsonl 即可取
  // R05：上限 80 太小 —— 一批 6 轮里 discover 噪声就能占 69 条，把压缩证据挤出窗口（R04 真机实测）
  const DBG_MAX = 300;
  function dbg(evt, data, targetMd) {
    try {
      const m = targetMd ? (targetMd.abc || null) : meta();
      if (!m) return null;
      m.debug = Array.isArray(m.debug) ? m.debug : [];
      m.debug.push({ t: Date.now(), evt, ...(data || {}) });
      if (m.debug.length > DBG_MAX) m.debug.splice(0, m.debug.length - DBG_MAX);
      return m.debug[m.debug.length - 1];   // R05：返回已落盘的条目，供去重累计复用同一对象
    } catch (e) { console.warn('[abc] dbg failed', e); return null; }
  }

  // ---------- C：范围、快照 ----------
  function visibleRange(cursor) {
    const chat = ctx().chat; const idx = [];
    for (let i = cursor + 1; i < chat.length; i++) if (!chat[i].is_system) idx.push(i);
    return idx;
  }
  function pendingCompression() {
    const m = meta();
    const idx = visibleRange(m.cursor);
    if (idx.length < CFG.triggerUncompressed) return null;
    const take = idx.slice(0, idx.length - CFG.keepRecent);
    return take.length ? { from: take[0], to: take.at(-1) } : null;
  }
  function rangeText(from, to) { return ctx().chat.slice(from, to + 1).map(x => x.mes || '').join('\n'); }
  const norm = s => String(s).replace(/\s+/g, '');

  function latest(beforeIdx, key, fallback) {
    const chat = ctx().chat;
    for (let i = Math.min(beforeIdx, chat.length) - 1; i >= 0; i--) { const s = chat[i]?.extra?.[key]; if (s) return structuredClone(s); }
    return structuredClone(fallback);
  }
  // 让隐藏楼层与 cursor 严格一致：0..cursor 全隐藏，cursor 之后由本扩展隐藏的全部放出（双向，含 swipe 回到更晚的快照）
  function ranges(list) { const out = []; for (const i of list) { const r = out.at(-1); if (r && i === r[1] + 1) r[1] = i; else out.push([i, i]); } return out; }
  async function reconcileHidden() {
    const chat = ctx().chat; const cur = meta().cursor; const toHide = [], toShow = [];
    const legacy = !chat.some(x => x?.extra?.abc_hidden); // v0.2 及以前没有隐藏标记
    for (let i = 0; i < chat.length; i++) {
      const x = chat[i]; if (!x) continue;
      if (i <= cur) { if (!x.is_system) toHide.push(i); (x.extra ??= {}).abc_hidden = true; }
      else if (x.is_system && (x.extra?.abc_hidden || (legacy && !x.extra?.type))) { toShow.push(i); if (x.extra) delete x.extra.abc_hidden; }
    }
    for (const [a, b] of ranges(toHide)) await ctx().executeSlashCommandsWithOptions(`/hide ${a}-${b}`);
    for (const [a, b] of ranges(toShow)) await ctx().executeSlashCommandsWithOptions(`/unhide ${a}-${b}`);
    if (toHide.length || toShow.length) console.log('[abc] reconcile', { cursor: cur, hide: ranges(toHide), show: ranges(toShow) });
    return toHide.length + toShow.length;
  }
  // 记忆层随楼层快照回滚（双向），再叠加 compLog，之后对齐隐藏楼层
  async function restoreMem(beforeIdx) {
    const m = meta();
    if (ctx().chat.some(x => x?.extra?.abc_mem)) { // v0.1 旧聊天没有记忆快照：只对齐，不回滚
      const mem = latest(beforeIdx, 'abc_mem', { chronicle: '', cursor: -1 });
      m.chronicle = mem.chronicle; m.cursor = mem.cursor;
    }
    // P1-4：compLog 里找「to < beforeIdx 且第 0–to 楼未变」的最大项；与楼层快照取更大 cursor。
    // 压缩结果的有效性只取决于第 0–to 楼是否原样，与末楼是哪个 swipe 无关。
    let best = null;
    for (const e of m.compLog) {
      if (!(e.to < beforeIdx) || e.to >= ctx().chat.length) continue;
      if (floorsFingerprint(e.to) !== e.fp) continue;
      if (!best || e.to > best.to) best = e;
    }
    if (best && best.to > m.cursor) {
      m.chronicle = best.chronicle; m.cursor = best.to;
      dbg('restore_from_complog', { to: best.to, beforeIdx });
    }
    await reconcileHidden();
  }

  function refreshPrompts() {
    const c = ctx(); if (!c.chatMetadata || !chatKey()) return;
    const m = meta(); const T = c.extension_prompt_types || { IN_PROMPT: 0 };
    c.setExtensionPrompt('abc_protocol', CFG.injectProtocol ? protocolText() : '', T.IN_PROMPT, 0);
    c.setExtensionPrompt('abc_memory', m.chronicle ? `【记忆层 C · 已压缩的历史（第 0–${m.cursor} 楼，原文可用 recall 查）】\n${m.chronicle}` : '', T.IN_PROMPT, 0);
    // v0.3 起压缩独立运行：主 run 不再看到压缩标志。
    // v1.0 清理（R07）：abc_flag 的「压缩标志」文案分支已删除——compressIndependent 恒 true 时它恒为空串，
    // 是死分支；保留一次空写，避免老聊天里残留的旧槽内容被 ST 继续注入。
    c.setExtensionPrompt('abc_flag', '', T.IN_PROMPT, 0);
  }

  // ---------- 工具 ----------
  const tools = window.__TAURITAVERN__.api.agent.tools;

  await tools.register({
    extensionId: EXT, name: 'chronicle_commit', contexts: ['chat'],
    description: '提交合并后的完整记忆层文本（事件 / 状态 / 未收线索三段，可选「关键原话」段）。压缩独立运行时由压缩 Agent 调用。',
    inputSchema: { type: 'object', properties: { chronicle: { type: 'string' } }, required: ['chronicle'] },
  }, async ({ chronicle }, tctx) => {
    // P0-2：范围一律用启动时登记的那个 p，不重算 pendingCompression()
    const rec = compressRuns.get(tctx?.runId);
    if (!rec) {
      dbg('chronicle_rejected_not_compress_run', { runId: tctx?.runId ?? null });
      return { ok: false, error: '记忆层压缩已改为独立运行负责，本轮不要调用 chronicle_commit' };
    }
    const p = rec.p;
    // P0-3 前置：聊天切走或楼层已变，当场驳回，不进暂存
    if (chatKey() !== rec.chatKey) {
      dbg('chronicle_commit_chat_mismatch', { runId: tctx?.runId ?? null }, compressMd);
      return { ok: false, error: '聊天已切换，本次压缩作废' };
    }
    if (floorsFingerprint(p.to) !== rec.fp) {
      dbg('chronicle_commit_floors_changed', { runId: tctx?.runId ?? null, to: p.to }, compressMd);
      return { ok: false, error: `第 0–${p.to} 楼在压缩期间发生了变化，本次压缩作废` };
    }
    dbg('chronicle_commit', { runId: tctx?.runId ?? null, from: p.from, to: p.to, chars: String(chronicle || '').length }, compressMd);
    const text = String(chronicle);
    for (const sec of ['事件', '状态', '未收线索']) if (!text.includes(sec)) return { ok: false, error: `缺少「${sec}」段` };
    // 关键原话核对：必须逐字出现在启动时登记的范围原文或已有关键原话里
    const qi = text.indexOf('关键原话');
    if (qi >= 0) {
      const quotes = [...text.slice(qi).matchAll(/「([^」]{2,200})」/g)].map(x => x[1]);
      if (quotes.length > CFG.maxQuotes) return { ok: false, error: `关键原话最多 ${CFG.maxQuotes} 条` };
      const src = norm(rangeText(p.from, p.to) + meta().chronicle);
      const bad = quotes.filter(q => !src.includes(norm(q)));
      if (bad.length) return { ok: false, error: `以下原话在第 ${p.from}–${p.to} 楼原文里找不到，请逐字引用或删掉：${bad.map(q => `「${q}」`).join('、')}` };
    }
    // P0-1：暂存按 runId 隔离，不写进 chat_metadata（v0.2 的旧暂存键已废弃）
    compressStaged.set(tctx?.runId, { chronicle: text, from: p.from, to: p.to });
    dbg('chronicle_staged', { from: p.from, to: p.to, chars: text.length }, compressMd);
    toast(`记忆层已暂存：第 ${p.from}–${p.to} 楼`);
    return { ok: true, staged: { from: p.from, to: p.to }, note: '已暂存（按 runId 隔离）。本次压缩运行的提交判据是本运行正常结束（run_completed）。' };
  });

  await tools.register({
    extensionId: EXT, name: 'recall', contexts: ['chat'],
    description: '在已压缩（移出上下文）的楼层原文里按关键词查找，返回楼层号和原文片段。问到过去的原话或细节而记忆层没有时使用。',
    inputSchema: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' } }, required: ['keywords'] },
  }, async ({ keywords, limit }, tctx) => {
    watchRun(tctx?.runId);
    const chat = ctx().chat; const m = meta(); const kws = (keywords || []).map(String).filter(Boolean);
    if (!kws.length) return { hits: [], note: '没有关键词' };
    const hits = [];
    for (let i = 0; i <= Math.min(m.cursor, chat.length - 1); i++) {
      const mes = chat[i]?.mes || ''; const score = kws.filter(k => mes.includes(k)).length;
      if (!score) continue;
      const pos = mes.indexOf(kws.find(k => mes.includes(k)));
      hits.push({ floor: i, speaker: chat[i].is_user ? 'user' : chat[i].name, score, excerpt: mes.slice(Math.max(0, pos - 150), pos + 250) });
    }
    hits.sort((a, b) => b.score - a.score || a.floor - b.floor);
    const out = hits.slice(0, Math.min(Number(limit) || 3, 5));
    toast(`回查原文：${out.length} 条命中`);
    return out.length ? { hits: out } : { hits: [], note: '原文里没有找到，正文里让角色表示记不清，不要编造' };
  });

  // ---------- 事务：快照挂在消息上，随 swipe/删除/重生成回滚 ----------
  async function resync() {
    if (!ctx().chatMetadata || !chatKey()) return;
    await restoreMem(ctx().chat.length); await save();
  }
  const { eventSource, event_types } = ctx();
  eventSource.on(event_types.GENERATION_STARTED, async (type, opts, dry) => {
    if (dry || !ctx().chatMetadata || !chatKey()) return;
    if (COMP.running) dbg('send_during_compress', { runId: COMP.lastRunId ?? null });
    const chat = ctx().chat; const last = chat.length - 1;
    const replacing = (type === 'regenerate' || type === 'swipe') && last >= 0 && !chat[last].is_user;
    const base = replacing ? last : chat.length;
    await restoreMem(base); refreshPrompts();
  });

  const watched = new Set(); const finalizedRuns = new Set();
  // P0-2/P0-3：压缩 run 登记 runId → { p, chatKey, fp }；暂存按 runId 隔离
  const compressRuns = new Map();
  const compressStaged = new Map();
  let compressMd = null; // 压缩 run 发起聊天的 metadata 引用：dbg 一律写回这里，不跟 UI 走
  // R05：压缩证据专用环形（10 条），不占 debug 名额 —— 判压缩不该靠 debug 运气
  let curEvidence = null;
  function evidence(data) {
    try {
      const m = (compressMd?.abc) || meta();
      m.compEvidence = Array.isArray(m.compEvidence) ? m.compEvidence : [];
      m.compEvidence.push({ t: Date.now(), ...(data || {}) });
      if (m.compEvidence.length > 10) m.compEvidence.splice(0, m.compEvidence.length - 10);
      return m.compEvidence[m.compEvidence.length - 1];
    } catch (e) { console.warn('[abc] evidence failed', e); return null; }
  }
  function chatKey() { return String(ctx().chatId ?? ''); }
  function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }
  // 第 0–to 楼指纹：send_date + 正文（P0-3/P1-4 的有效性判据）
  function floorsFingerprint(to) {
    const chat = ctx().chat;
    return strHash(chat.slice(0, Math.min(to + 1, chat.length)).map(x => [x.send_date || '', x.mes || ''].join('\u0001')).join('\u0002'));
  }
  function watchRun(runId) {
    if (!runId || compressRuns.has(runId) || watched.has(runId)) return; watched.add(runId);
    const ownerKey = chatKey(); // r9 修①：订阅时锁定主 run 归属（此刻用户必然在本 run 的聊天里）
    const agent = window.__TAURITAVERN__.api.agent;
    const un = agent.subscribe(runId, async (ev) => {
      if (ev.type === 'chat_commit_recorded') await finalize(runId, Number(ev.payload.messageId));
      if (ev.type === 'run_cancelled' || ev.type === 'run_failed' || ev.type === 'run_partial_success') {
        if (!finalizedRuns.has(runId)) { refreshPrompts(); dbg('run_not_completed', { runId, type: ev.type }); }
      }
      if (ev.type === 'run_completed' && CFG.compressIndependent && !COMP.running) {
        if (compressTriggered.has(runId)) return;   // Q3②：同一 run 最多触发一次 maybeCompress
        compressTriggered.add(runId);
        // 主 run 已到终态：若还有待压缩范围，起压缩 run（Q3：不要两个 run 并存）
        // r9 修①：两处校验都用订阅时锁定的 ownerKey——事件迟到或用户切走，都不对别的聊天下手
        if (chatKey() !== ownerKey) { dbg('main_run_completed', { runId }); dbg('compress_skip', { reason: 'main_run_chat_switched', runId, ownerKey }); return; }
        dbg('main_run_completed', { runId });
        setTimeout(() => {
          if (chatKey() !== ownerKey) { dbg('compress_skip', { reason: 'main_run_chat_switched_before_start', runId, ownerKey }); return; }
          maybeCompress(runId).catch(e => dbg('compress_error', { err: String(e?.message || e) }));
        }, 400);
      }
      if (/^run_(completed|cancelled|failed|partial_success)$/.test(ev.type)) { try { (await un)?.(); } catch {} }
    }, { onError: console.error });
  }
  async function finalize(runId, idx) {
    let msg;
    for (let i = 0; i < 30 && !(msg = ctx().chat[idx]); i++) await new Promise(r => setTimeout(r, 100));
    if (!msg) { console.warn('[abc] commit message not found', idx); return; }
    msg.extra = msg.extra || {};
    // 事件重放保护：该楼层已属于本 run 且已有记忆层快照 → 不重复写
    if (msg.extra.abc_mem && msg.extra?.tauritavern?.agent?.runId === runId) { dbg('finalize_skip_replayed', { runId }); return; }
    const mem = { chronicle: meta().chronicle, cursor: meta().cursor };
    msg.extra.abc_mem = mem;
    const sw = msg.swipe_info?.[msg.swipe_id ?? 0]; if (sw) { sw.extra = sw.extra || {}; sw.extra.abc_mem = mem; }
    finalizedRuns.add(runId);
    await ctx().saveChat(); await save();
  }

  // ---------- v0.3：压缩独立运行 ----------
  const COMP = { running: false, lastRunId: null, startedAt: 0 };

  // R04：压缩提示不再写死在扩展里，改为读压缩 Profile 的 instructions.agentSystemPrompt；
  // 静态模板里不含任何楼层号，范围一律放在 user 段 → system 段 md5 恒定（I6 可守）。
  const COMPRESS_INSTRUCTION_FALLBACK = [
    '你是「记忆层压缩器」，不是叙事 Agent。本次只做一件事：把用户消息里给出的原文并入已有记忆层，然后结束。',
    '【允许的工具，只有两个】chronicle_commit({chronicle}) 只调一次；随后 workspace_finish() 结束。禁止调用其它任何工具，不要写文件，不要提交正文。',
    '【chronicle 的写法】必须含三段：「事件」「状态」「未收线索」；可选第四段「关键原话」，最多 3 条，用「」逐字引用范围内原文。',
    '【硬边界】只写已有记忆层与范围内已发生的内容；不得编造、不得写范围之后的事。',
    '【结束条件】chronicle_commit 返回 ok:true 后，同一条回复里调用 workspace_finish()。',
  ].join('\n');
  // 优先级：压缩 Profile 的 instructions → 固定兜底（两者都是静态文本，不含楼层号）
  const compressInstructionFrom = profile => {
    const t = profile?.instructions?.agentSystemPrompt;
    return (typeof t === 'string' && t.trim()) ? t : COMPRESS_INSTRUCTION_FALLBACK;
  };

  function buildCompressMessages(p, instruction) {
    const covered = meta().cursor >= 0
      ? `【已有记忆层 · 覆盖第 0–${meta().cursor} 楼】`
      : '【已有记忆层 ·（尚无已压缩楼层）】';
    const payload = [
      covered,
      meta().chronicle && meta().chronicle.trim() ? meta().chronicle : '(空，这是第一次压缩)',
      '',
      `【本次需要并入的原文 · 第 ${p.from}–${p.to} 楼】`,
      rangeText(p.from, p.to),
    ].join('\n');
    return [
      { role: 'system', parts: [{ type: 'text', text: instruction }], providerMetadata: { promptComponent: 'agentSystemPrompt' } },
      { role: 'user', parts: [{ type: 'text', text: payload }] },
    ];
  }

  async function readMainGenerationParameters(mainRunId, targetMd) {
    const agent = window.__TAURITAVERN__.api.agent;
    try {
      const file = await agent.readWorkspaceFile({ runId: mainRunId, path: 'input/prompt_snapshot.json' });
      const snap = JSON.parse(file.text);
      const gp = snap?.generationParameters;
      if (gp && typeof gp === 'object' && !Array.isArray(gp)) {
        dbg('gp_from_main_snapshot', { runId: mainRunId, chars: file.chars, model: gp.model }, targetMd);
        return { gp: { ...gp, stream: false }, source: 'main_snapshot' };
      }
      dbg('gp_main_snapshot_missing', { keys: Object.keys(snap || {}) }, targetMd);
    } catch (e) {
      dbg('gp_main_snapshot_error', { runId: mainRunId, err: String(e?.message || e) }, targetMd);
    }
    // 兜底：从当前聊天补全设置拼一份
    const s = ctx().chatCompletionSettings || {};
    const gp = {
      chat_completion_source: s.chat_completion_source || 'custom',
      custom_url: s.custom_url || '',
      custom_api_format: s.custom_api_format || 'claude_messages',
      model: s.model || s.claude_model || '',
      max_tokens: CFG.compressModelMaxTokens,
      stream: false,
      use_sysprompt: true,
      ...(s.secret_id ? { secret_id: s.secret_id } : {}),
    };
    dbg('gp_fallback', { model: gp.model, source: gp.chat_completion_source }, targetMd);
    return { gp, source: 'fallback' };
  }

  async function maybeCompress(mainRunId) {
    if (!CFG.compressIndependent || COMP.running) return;
    if (!ctx().chatMetadata) return;
    const p = pendingCompression();
    if (!p) { dbg('compress_skip', { reason: 'nothing_to_compress' }); return; }
    COMP.running = true; COMP.startedAt = Date.now();
    // r7：锁定发起聊天——chatRef 不跟 UI 走，dbg 固定写回发起聊天
    const chatRef = window.__TAURITAVERN__.api.chat.current.ref();
    compressMd = ctx().chatMetadata; // r8 修：r7 在这里误用 const 声明，遮蔽了模块级 compressMd，导致 run 后半段 dbg 又落回"当前聊天"
    // P0-2/P0-3：范围、聊天身份、指纹都在启动时刻定格
    const rec = { p, chatKey: chatKey(), fp: floorsFingerprint(p.to) };
    dbg('compress_start', { mainRunId, from: p.from, to: p.to, cursor: meta().cursor, fp: rec.fp }, compressMd);
    try {
      const { gp, source } = await readMainGenerationParameters(mainRunId, compressMd);
      const agent = window.__TAURITAVERN__.api.agent;
      const profile = await agent.profiles.load(CFG.compressProfileId);
      const cp = profile?.profile?.context || { initialChatHistoryMessages: -1, includeActivatedWorldInfo: true };
      const instruction = compressInstructionFrom(profile?.profile);   // R04：提示来自 Profile，不在扩展里
      const promptSnapshot = {
        generationParameters: gp,
        messages: buildCompressMessages(p, instruction),
        contextPolicy: {
          initialChatHistoryMessages: cp.initialChatHistoryMessages ?? -1,
          includeActivatedWorldInfo: cp.includeActivatedWorldInfo ?? true,
        },
        acceptsImages: false,
      };
      dbg('compress_snapshot_built', { source, chars: JSON.stringify(promptSnapshot).length, sysChars: instruction.length, msgs: promptSnapshot.messages.length, preset: profile?.profile?.preset?.mode ?? null }, compressMd);
      // R05：压缩证据单独留档（debug 被挤也不丢）
      curEvidence = evidence({
        mainRunId, from: p.from, to: p.to, cursorAtStart: compressMd?.abc?.cursor ?? null,
        sysChars: instruction.length, msgs: promptSnapshot.messages.length,
        preset: profile?.profile?.preset?.mode ?? null, source, outcome: 'pending',
      });
      const handle = await agent.startRunWithPromptSnapshot({
        chatRef,
        profileId: CFG.compressProfileId,
        presentation: 'background',
        options: { presentation: 'background', stream: false },
        promptSnapshot,
      });
      compressRuns.set(handle.runId, rec);
      COMP.lastRunId = handle.runId;
      dbg('compress_run_started', { runId: handle.runId, workspaceId: handle.workspaceId, status: handle.status }, compressMd);
      if (curEvidence) { curEvidence.runId = handle.runId; curEvidence.outcome = 'started'; }
      toast('压缩独立运行已启动');
      watchCompressRun(handle.runId);
    } catch (e) {
      dbg('compress_start_failed', { err: String(e?.message || e) }, compressMd);
      if (curEvidence) { curEvidence.outcome = 'start_failed'; curEvidence.error = String(e?.message || e).slice(0, 200); }
      toast(`压缩独立运行启动失败：${String(e?.message || e).slice(0, 120)}`, 'error');
      COMP.running = false; compressMd = null;
    }
  }

  function watchCompressRun(runId) {
    const agent = window.__TAURITAVERN__.api.agent;
    const rec = compressRuns.get(runId);
    const un = agent.subscribe(runId, async (ev) => {
      if (ev.type === 'chat_commit_recorded') dbg('compress_unexpected_commit', { runId, payload: ev.payload }, compressMd);
      if (!/^run_(completed|partial_success|cancelled|failed)$/.test(ev.type)) return;
      try { (await un)?.(); } catch {}
      const staged = compressStaged.get(runId); compressStaged.delete(runId);
      const rec2 = compressRuns.get(runId); compressRuns.delete(runId);
      // P0-3：归属校验——聊天没切、第 0–to 楼没变
      let mismatch = null;
      if (!rec2) mismatch = 'no_record';
      else if (String(ctx().chatId ?? '') !== rec2.chatKey) mismatch = 'chat_switched';
      else if (floorsFingerprint(rec2.p.to) !== rec2.fp) mismatch = 'floors_changed';
      const ok = ev.type === 'run_completed' && !!staged && !mismatch;
      dbg('compress_run_terminal', { runId, type: ev.type, staged: !!staged, mismatch, ms: Date.now() - COMP.startedAt }, compressMd);
      if (ok) await applyCompress(staged, rec2, runId);
      else {
        dbg('compress_discard', { runId, type: ev.type, mismatch, staged: !!staged }, compressMd);
        const evD = ((compressMd?.abc?.compEvidence) || []).filter(x => x && x.runId === runId).pop() || null;
        if (evD) { evD.outcome = 'discarded'; evD.discardReason = mismatch || ev.type; }
        toast(mismatch ? `压缩结果丢弃：${mismatch}` : '压缩运行未成功，记忆层未变', 'warning');
        // r9 修②：只在本 run 自己的聊天里落盘；切去的聊天不许被建出 abc 元数据和变量
        if (rec2 && chatKey() === rec2.chatKey) await save();
        else dbg('discard_skip_save', { reason: 'not_origin_chat', mismatch }, compressMd);
      }
      if (COMP.lastRunId === runId) { COMP.running = false; COMP.lastRunId = null; }
      else dbg('compress_stale_terminal', { runId, current: COMP.lastRunId }, compressMd);
      try { await agent.settleChatPresentation({ runId }); } catch (e) { dbg('compress_settle_failed', { runId, err: String(e?.message || e) }, compressMd); }
      compressMd = null;
      curEvidence = null;
    }, { onError: console.error });
  }

  async function applyCompress(staged, rec, runId) {
    const m = meta(); const chat = ctx().chat;
    const to = Math.min(staged.to, chat.length - 1);
    if (to !== staged.to) dbg('compress_to_clamped', { stagedTo: staged.to, chatLen: chat.length, to }, compressMd);
    m.chronicle = staged.chronicle; m.cursor = to;
    await reconcileHidden();
    // P1-4：compLog 是压缩有效性的权威记录（第 0–to 楼未变即有效，与末楼无关）
    m.compLog.push({ to, chronicle: staged.chronicle, fp: rec.fp, t: Date.now() });
    if (m.compLog.length > 50) m.compLog.splice(0, m.compLog.length - 50);
    // 楼层快照仍写（兼容 v0.2.1 数据模型），但不再是唯一事实来源
    let snapFloor = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
      if (!chat[i]?.extra?.abc_mem) continue;
      snapFloor = i;
      const mem = { chronicle: m.chronicle, cursor: m.cursor };
      chat[i].extra.abc_mem = mem;
      const sw = chat[i].swipe_info?.[chat[i].swipe_id ?? 0];
      if (sw) { sw.extra = sw.extra || {}; sw.extra.abc_mem = mem; }
      break;
    }
    dbg('compress_applied', { runId, from: staged.from, to: staged.to, cursor: m.cursor, snapFloor, compLog: m.compLog.length, chars: m.chronicle.length }, compressMd);
    // R05：证据闭环（按 runId 找条目，避免串到另一次压缩）
    const evA = (m.compEvidence || []).filter(x => x && x.runId === runId).pop() || null;
    if (evA) { evA.outcome = 'applied'; evA.appliedTo = to; evA.appliedCursor = m.cursor; evA.clamped = to !== staged.to; }
    await ctx().saveChat(); await save();
    toast(`记忆层已生效（独立运行）：第 ${staged.from}–${staged.to} 楼移出上下文`);
  }

  // /abc-cancel：**运维钩子，v1.0 保留**（R07 清点时裁定）
  // 理由：后台压缩 run 在 App 侧没有取消 UI，而 R06 的「取消压缩」场景必须由它触发；
  //       回调只在 COMP.lastRunId 非空窗口（压缩 run 存活期间）可达，其余时间走 cancel_skip 空分支。
  try {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (SlashCommandParser?.addCommandObject && SlashCommand?.fromProps) {
      SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'abc-cancel',
        callback: () => {
          const agent = window.__TAURITAVERN__.api.agent;
          const cid = COMP.lastRunId;
          if (!cid) { dbg('cancel_skip', { reason: 'no_active_compress_run' }); return ''; }
          dbg('cancel_requested', { runId: cid });
          agent.cancel(cid).catch(e => dbg('cancel_failed', { err: String(e?.message || e) }));
          return '';
        },
      }));
    }
  } catch (e) { console.warn('[abc] /abc-cancel unavailable', e); }
  // ---------- 主 run 发现（标「默认」）----------
  // R03 剥离后主 run 不再调用任何扩展工具，拿不到 runId；改用官方 API：
  // TauriTavern docs/API/Agent.md:133 listRuns({ chatRef, limit }) → { runs }（按创建时间倒序）
  const discovered = new Set();
  const compressTriggered = new Set();   // Q3②：runId → 已触发过 maybeCompress
  const skipSeen = new Map();            // R05：discover 噪声去重 key → 已落盘的 debug 条目
  let discoverArmed = false;       // 首次成功读到列表后置位；之前只当基线，不回放已终结的旧 run
  let discoverBaseline = null;
  let discoverTimer = null;
  const TERMINAL = ['completed', 'failed', 'cancelled', 'partial_success'];
  // Q3③：只在页面可见时轮询；Node/无 document 环境视为可见（离线断言用）
  const pageVisible = () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden');
  // Q3①：只认主 Profile 的 run；压缩 run 一律跳过（防递归）
  const isMainRun = r => {
    const pid = r?.profileId;
    if (pid != null && String(pid) !== CFG.mainProfileId) return false;
    if (String(r?.presentation ?? '') === 'background') return false;   // 压缩 run 走 background；不依赖 profileId 也能排除
    const id = String(r?.runId ?? '');
    if (!id || id === COMP.lastRunId || compressRuns.has(id)) return false;
    return true;
  };
  async function discoverOnce() {
    const api = window.__TAURITAVERN__?.api;
    if (!api?.agent?.listRuns || !chatKey() || !ctx().chatMetadata || !pageVisible()) return;
    try {
      const chatRef = api.chat?.current?.ref?.() ?? null;
      const page = await api.agent.listRuns(chatRef ? { chatRef, limit: 5 } : { limit: 5 });
      const runs = Array.isArray(page?.runs) ? page.runs : [];
      if (!runs.length) return;
      const newest = runs[0];
      if (!discoverArmed) {
        discoverArmed = true;
        discoverBaseline = String(newest?.runId ?? '') || null;
        // 首帧里还没终结的最新主 run，可能是装载时正在跑的那一轮 → 订阅（不会回放已落的提交事件）
        if (isMainRun(newest) && !TERMINAL.includes(String(newest?.status ?? ''))) { discovered.add(newest.runId); watchRun(newest.runId); }
        return;
      }
      for (const r of runs.slice().reverse()) {
        const id = String(r?.runId ?? ''); if (!id) continue;
        if (id === discoverBaseline) continue;
        if (discovered.has(id) || watched.has(id) || compressRuns.has(id) || compressTriggered.has(id)) continue;
        if (!isMainRun(r)) {
          // R05：轮询噪声去重——同一 runId+profile 只留 1 条 debug，重复次数记进 count
          const key = id + '|' + String(r?.profileId ?? '');
          const hit = skipSeen.get(key);
          if (hit) hit.count = (hit.count || 1) + 1;
          else {
            const e = dbg('discover_skip_not_main', { runId: id, profileId: r?.profileId ?? null, count: 1 });
            if (e) skipSeen.set(key, e);
          }
          continue;
        }
        discovered.add(id); watchRun(id);
      }
    } catch (e) { dbg('discover_failed', { err: String(e?.message || e) }); }
  }
  function startDiscover() {
    if (discoverTimer) return;
    discoverOnce();
    discoverTimer = setInterval(() => { discoverOnce(); }, CFG.discoverMs);
  }

  // ---------- 对外只读接口（Q1：整体冻结，不暴露任何写操作）----------
  const EXT_VERSION = '1.0.0';
  const deepFreeze = o => { if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; };
  // 隐藏楼层：优先读楼层上真实的 abc_hidden 标记；旧聊天没有标记时才按 cursor 推算
  function hiddenFloorList() {
    const chat = ctx().chat || [];
    const marked = [];
    for (let i = 0; i < chat.length; i++) if (chat[i]?.extra?.abc_hidden) marked.push(i);
    if (marked.length) return marked;
    const cur = Number.isInteger(ctx().chatMetadata?.abc?.cursor) ? ctx().chatMetadata.abc.cursor : -1;
    const out = [];
    for (let i = 0; i <= cur && i < chat.length; i++) if (!chat[i]?.is_system) out.push(i);
    return out;
  }
  function readState() {
    const m = ctx().chatMetadata?.abc || null;
    const cur = Number.isInteger(m?.cursor) ? m.cursor : -1;
    const compLog = Array.isArray(m?.compLog) ? m.compLog : [];
    return deepFreeze({
      cursor: cur,
      chronicleChars: String(m?.chronicle ?? '').length,
      compLogCount: compLog.length,
      compLogLastTo: compLog.length && Number.isInteger(compLog.at(-1)?.to) ? compLog.at(-1).to : null,
      hiddenRanges: ranges(hiddenFloorList()),
      warnings: [],   // 变量层剥离后暂无来源，保留键位以稳定第三方契约
    });
  }
  function readSystem() {
    return deepFreeze({ version: EXT_VERSION, compressProfileId: CFG.compressProfileId, mainProfileId: CFG.mainProfileId, discoverMs: CFG.discoverMs });
  }
  function readDebug() {
    const d = ctx().chatMetadata?.abc?.debug;
    return deepFreeze(structuredClone(Array.isArray(d) ? d : []));
  }

  eventSource.on(event_types.MESSAGE_SWIPED, resync);
  eventSource.on(event_types.MESSAGE_DELETED, resync);
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    // Q3③：换聊天重置已见集合与基线
    discoverArmed = false; discoverBaseline = null; discovered.clear(); compressTriggered.clear(); skipSeen.clear();
    await resync();
  });
  eventSource.on(event_types.MESSAGE_SENT, refreshPrompts);
  window.__abc = Object.freeze({
    apiVersion: 1,
    read: Object.freeze({ state: readState, system: readSystem }),
    debug: Object.freeze({ events: readDebug }),
  });
  refreshPrompts();
  startDiscover();
})();