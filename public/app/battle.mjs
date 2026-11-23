import {
  aggregate,
  buildExplorationCandidates,
  computeCompositeWinRate,
  computeCompositeWinRateFromCompact,
  createEmptyExploreStats,
  DEEP_EXPLORE_GAMES,
  DEEP_GAMES_PER_OPPONENT,
  encodeCardForFastSim,
  energyNames,
  EXPLORE_CANDIDATE_COUNT,
  EXPLORE_GAMES_PER_OPPONENT,
  EXPLORE_TOTAL_GAMES,
  FIRST_SEAT_GAMES,
  GAMES_PER_OPPONENT,
  interval,
  isEngineImplementedStatus,
  matchDeckStrategies,
  mergeExploreChunkStats,
  synthesizeWinningStrategyFromStats,
  TOTAL_BATCH_GAMES,
  validOutcomes
} from './core.mjs';
import { esc, renderEnergyToken, renderPokemonSprites, resolveFeaturedPokemon } from './cardface.mjs';
import { ensureStrategyLexicon, saveRunRecord, state } from './data.mjs';

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 探測雙引擎：DeckGym WASM（覆蓋率校驗 + 精確規則四階段回放）+ FastSim WASM（1,000 萬局推演 + 50,000 局測試）
export async function probeEngine() {
  if (state.runtimeFn && state.fastSimFn) {
    return { ready: true, runtime: state.runtimeFn, fastSim: state.fastSimFn };
  }
  try {
    const [modRes, wasmRes, fastModRes, fastWasmRes] = await Promise.all([
      import('../battle/runtime.mjs'),
      fetch('battle/deckgym.wasm'),
      import('../battle/fastsim-runtime.mjs'),
      fetch('battle/fastsim.wasm')
    ]);
    if (!wasmRes.ok) throw Error(`未找到 deckgym.wasm (${wasmRes.status})`);
    if (!fastWasmRes.ok) throw Error(`未找到 fastsim.wasm (${fastWasmRes.status})`);
    const [bytes, fastBytes] = await Promise.all([wasmRes.arrayBuffer(), fastWasmRes.arrayBuffer()]);
    const [compiled, fastCompiled] = await Promise.all([
      WebAssembly.compile(bytes),
      WebAssembly.compile(fastBytes)
    ]);
    const [fn, fastFn] = await Promise.all([
      modRes.instantiateBattle(compiled),
      fastModRes.instantiateFastSim(fastCompiled)
    ]);
    state.wasmModule = compiled;
    state.wasmBytes = bytes;
    state.runtimeFn = fn;
    state.fastSimModule = fastCompiled;
    state.fastSimFn = fastFn;
    state.fastSimReady = true;
    state.engineReady = true;
    state.engineError = '';
    // 背景預載 13,500 條策略詞條庫
    ensureStrategyLexicon().catch(() => null);
    return { ready: true, runtime: fn, fastSim: fastFn };
  } catch (err) {
    state.engineReady = false;
    state.engineError = `對戰模擬引擎尚未載入（${err?.message || 'WASM 初始化失敗'}），目前可瀏覽賽事前十牌組清單。`;
    return { ready: false, error: state.engineError };
  }
}

// 多執行緒 FastSim Web Worker 並行池（專攻千萬級探索與五萬級正式勝率推演）
let fastWorkerPool = null;
let fastWorkerPoolPromise = null;

async function spawnFastWorkerPool() {
  if (typeof Worker === 'undefined') return null;
  const hw = Number(globalThis.navigator?.hardwareConcurrency || 4);
  const count = Math.max(2, Math.min(16, hw));
  const workerUrl = new URL('../battle/worker.mjs', import.meta.url);
  const fastWasmUrl = new URL('../battle/fastsim.wasm', import.meta.url).href;

  const workers = [];
  let seq = 1;
  const initOne = (idx) => new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(workerUrl, { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    const id = seq++;
    const onMsg = (ev) => {
      if (ev.data?.id !== id) return;
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      if (ev.data.ok) resolve(w);
      else reject(Error(ev.data.error || `FastSim Worker #${idx} init failed`));
    };
    const onErr = (err) => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      reject(Error(err?.message || `FastSim Worker #${idx} error`));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    try {
      if (state.fastSimModule) {
        w.postMessage({ type: 'init_fastsim', id, module: state.fastSimModule });
      } else {
        w.postMessage({ type: 'init_fastsim', id, wasmUrl: fastWasmUrl });
      }
    } catch {
      w.postMessage({ type: 'init_fastsim', id, wasmUrl: fastWasmUrl });
    }
  });

  try {
    const initialized = await Promise.all(Array.from({ length: count }, (_, i) => initOne(i)));
    workers.push(...initialized);
  } catch (err) {
    for (const w of workers) {
      try { w.terminate(); } catch {}
    }
    console.warn('[battle] FastSim worker pool fallback to main thread:', err?.message || err);
    return null;
  }

  return {
    size: workers.length,
    async runTasks(tasks, { signal, onResult }) {
      let nextIdx = 0;
      let firstError = null;
      const runOnWorker = (w) => new Promise((resolve) => {
        const step = () => {
          if (firstError || signal?.aborted || nextIdx >= tasks.length) {
            resolve();
            return;
          }
          const taskIdx = nextIdx++;
          const task = tasks[taskIdx];
          const id = seq++;
          const onMsg = (ev) => {
            if (ev.data?.id !== id) return;
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            if (!ev.data.ok) {
              firstError = Error(ev.data.error || 'Worker 執行失敗');
              resolve();
              return;
            }
            if (ev.data.result?.error) {
              firstError = Error(ev.data.result.error);
              resolve();
              return;
            }
            Promise.resolve(onResult?.(ev.data.result, task, taskIdx))
              .then(step)
              .catch((err) => {
                firstError = err;
                resolve();
              });
          };
          const onErr = (err) => {
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            firstError = Error(err?.message || 'Worker 異常');
            resolve();
          };
          w.addEventListener('message', onMsg);
          w.addEventListener('error', onErr);
          w.postMessage({ type: 'run_fastsim', id, request: task.request });
        };
        step();
      });

      await Promise.all(workers.map((w) => runOnWorker(w)));
      if (firstError) throw firstError;
    }
  };
}

async function getFastWorkerPool() {
  if (fastWorkerPool) return fastWorkerPool;
  if (!fastWorkerPoolPromise) {
    fastWorkerPoolPromise = spawnFastWorkerPool().then((pool) => {
      fastWorkerPool = pool;
      return pool;
    });
  }
  return fastWorkerPoolPromise;
}

async function runFastTasks(tasks, { fastSim, signal, onResult }) {
  const pool = await getFastWorkerPool();
  if (pool) {
    await pool.runTasks(tasks, { signal, onResult });
    return pool.size;
  }
  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) break;
    const res = fastSim(tasks[i].request);
    if (res?.error) throw Error(res.error);
    await onResult?.(res, tasks[i], i);
    await new Promise((r) => setTimeout(r, 0));
  }
  return 1;
}

function expandDeckForFastSim(deckLike, cardBonusById = {}) {
  const out = [];
  for (const item of deckLike?.cards || []) {
    const card = state.cardsById?.get ? state.cardsById.get(item.id) : null;
    const bonus = Number(cardBonusById[item.id] ?? 0);
    const enc = encodeCardForFastSim(card, bonus);
    const cnt = Math.max(1, Number(item.count || 1));
    for (let k = 0; k < cnt; k++) {
      if (out.length < 20) out.push(enc);
    }
  }
  while (out.length < 20 && out.length > 0) out.push(out[0]);
  return out;
}

export function ensureCardCoverage(ids = []) {
  if (!state.runtimeFn || !ids?.length) return state.coverageMap;
  if (!state.coverageMap) state.coverageMap = {};
  const missing = [...new Set(ids)].filter((id) => id && !Object.hasOwn(state.coverageMap, id));
  if (missing.length > 0) {
    const res = state.runtimeFn({ op: 'coverage', ids: missing });
    if (res?.coverage) Object.assign(state.coverageMap, res.coverage);
  }
  return state.coverageMap;
}

export function getUnsupportedCards(cards = [], coverageMap = state.coverageMap) {
  if (!coverageMap || !cards?.length) return [];
  const bad = [];
  for (const item of cards) {
    const st = coverageMap[item.id];
    if (st && !isEngineImplementedStatus(st)) {
      bad.push({ id: item.id, status: st });
    }
  }
  return bad;
}

export function resolveOpponentLineup(meta, coverageMap = null) {
  const entries = (meta?.entries || []).filter((e) => e.representative?.cards?.length);
  const selected = [];
  const skipped = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const rank = i + 1;
    let missingCards = [];
    if (coverageMap) {
      missingCards = entry.representative.cards
        .map((c) => c.id)
        .filter((id) => {
          const st = coverageMap[id];
          return st && !isEngineImplementedStatus(st);
        });
    }
    if (missingCards.length > 0) {
      skipped.push({ rank, entry, missingCards });
      continue;
    }
    if (selected.length < 10) {
      selected.push({ rank, isSubstitute: rank > 10, entry });
    }
    if (selected.length >= 10 && rank >= 10) break;
  }
  return { selected, skipped };
}

export function renderGameStrip(opponentId, events = [], playable = false, gamesPerOpp = 500, actionName = 'replay-game', rangeStart = 0, rangeCount = null, totalAll = null) {
  const count = rangeCount ?? gamesPerOpp;
  const totalLabel = totalAll ?? gamesPerOpp;
  const half = Math.floor(count / 2);
  const overallHalf = Math.floor(totalLabel / 2);
  const is500 = count >= 200;
  const byIndex = new Map();
  for (const e of events) byIndex.set(e.index, e);

  const makeHalf = (startOffset, endOffset) => {
    let cells = '';
    for (let k = startOffset; k < endOffset; k++) {
      const idx = rangeStart + k;
      const ev = byIndex.get(idx);
      const cls = ev ? `is-${ev.outcome}` : 'is-pending';
      const resName = ev ? ({ win: '勝', loss: '敗', draw: '和' }[ev.outcome] || ev.outcome) : '未執行';
      const isFirst = idx < overallHalf;
      const sideLabel = isFirst ? '先攻' : '後攻';
      const numInSide = isFirst ? idx + 1 : idx - overallHalf + 1;
      const title = `第 ${(idx + 1).toLocaleString('zh-TW')}/${totalLabel.toLocaleString('zh-TW')} 局（${sideLabel}第 ${numInSide.toLocaleString('zh-TW')} 局）· ${resName}${ev?.turns ? ` · ${ev.turns} 回合` : ''} — 點擊檢視四階段完整流程`;
      const cellCls = `dot-cell ${is500 ? 'is-500 ' : ''}${cls}`;
      if (playable && ev) {
        cells += `<button class="${cellCls}" type="button" data-action="${actionName}" data-opp="${esc(opponentId)}" data-idx="${idx}" aria-label="${esc(title)}" title="${esc(title)}"></button>`;
      } else {
        cells += `<span class="${cellCls}" aria-label="${esc(title)}" title="${esc(title)}"></span>`;
      }
    }
    return `<div class="strip-half ${is500 ? 'is-250' : ''}">${cells}</div>`;
  };
  return `<div class="game-strip ${is500 ? 'is-500' : ''}" role="group" aria-label="${count} 局勝負點陣">
    ${makeHalf(0, half)}
    <span class="strip-gap ${is500 ? 'is-500' : ''}" aria-hidden="true"></span>
    ${makeHalf(half, count)}
  </div>`;
}

// 渲染「13,500 條策略詞條庫與本牌組啟用詞條」面板
function renderStrategyLexiconBanner(run, deck, lineup) {
  const idxDoc = state.strategyIndex;
  const totalLex = idxDoc?.totalEntries || state.strategyLexicon?.totalEntries || 13500;
  const matched = run?.matchedStrategies
    || (state.strategyLexicon && deck ? matchDeckStrategies(deck, lineup, state.strategyLexicon, state.modelInfo?.weights || []) : null);
  const activeCnt = matched?.matchedCount || 0;
  const cardCnt = matched?.cardMatchedCount || 0;
  const macroCnt = matched?.macroMatchedCount || 0;
  const topChips = (matched?.topActiveStrategies || []).slice(0, 6).map((s) =>
    `<span class="card-prior-chip" title="${esc(s.rule)}">
      <b>[${esc(s.catLabel)}] ${esc(s.title)}</b> <small>${(s.wr * 100).toFixed(1)}% (${s.games.toLocaleString('zh-TW')}局)</small>
    </span>`
  ).join('');

  return `
    <div class="lexicon-banner">
      <div class="strategy-synth-head">
        <div>
          <strong>全卡庫與競技攻略策略詞條庫（共 ${totalLex.toLocaleString('zh-TW')} 條獨立策略詞條 · 全 ${(idxDoc?.cardsEvaluated || 4577).toLocaleString('zh-TW')} 張卡每張 ${(idxDoc?.minGamesPerCard || 2400).toLocaleString('zh-TW')} 局實測 + 5 份頂尖網路攻略）</strong>
          <p class="sub">${activeCnt > 0
            ? `已為當前牌組與前十對位自動激活 <b>${activeCnt.toLocaleString('zh-TW')}</b> 條專屬策略詞條（單卡策略 ${cardCnt} 條 + 環境對位攻略 ${macroCnt} 條），並將其 22 維權重偏置與單卡決策先驗全面注入 10,000,000 局勝利策略推演與 50,000 局勝率測試。`
            : '收錄全部 4,161 張寶可夢卡三維策略、416 張訓練家卡時機/反制策略與 185 條高階環境攻略，啟動測試時自動匹配並實時套用至對局推演。'}</p>
        </div>
        <button class="btn btn-outline" type="button" data-action="open-strategy-lexicon">瀏覽全部 ${totalLex.toLocaleString('zh-TW')} 條策略詞條庫</button>
      </div>
      ${topChips ? `<div class="card-prior-chips">${topChips}</div>` : ''}
    </div>
  `;
}

// 13,500+ 條策略詞條互動檢索彈窗
export function buildStrategyLexiconModal({ lexicon, indexDoc, matchedIdSet = null, q = '', cat = 'all', onlyMatched = false, page = 1 }) {
  if (!lexicon?.entries?.length) {
    return `<div class="empty-box is-dashed">正在載入全部策略詞條庫（13,500 條）…</div>`;
  }
  const cats = lexicon.cats || [];
  const catLabels = lexicon.catLabelsZh || {};
  const srcs = lexicon.srcs || [];
  const needle = String(q || '').trim().toLowerCase();

  let list = lexicon.entries;
  if (onlyMatched && matchedIdSet && matchedIdSet.size > 0) {
    list = list.filter((r) => matchedIdSet.has(r[0]));
  }
  if (cat && cat !== 'all') {
    const ci = cats.indexOf(cat);
    if (ci >= 0) list = list.filter((r) => r[1] === ci);
  }
  if (needle) {
    list = list.filter((r) =>
      String(r[0]).toLowerCase().includes(needle)
      || String(r[2]).toLowerCase().includes(needle)
      || String(r[3]).toLowerCase().includes(needle)
      || String(r[4]).toLowerCase().includes(needle)
      || String(r[5]).toLowerCase().includes(needle)
    );
  }

  const perPage = 40;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const curPage = Math.min(Math.max(1, page), totalPages);
  const slice = list.slice((curPage - 1) * perPage, curPage * perPage);

  const catPills = [
    `<button class="mini ${cat === 'all' && !onlyMatched ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="all" data-matched="0">全部 (${lexicon.entries.length.toLocaleString('zh-TW')})</button>`,
    matchedIdSet?.size
      ? `<button class="mini ${onlyMatched ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="all" data-matched="1">本牌組啟用 (${matchedIdSet.size})</button>`
      : '',
    ...cats.map((cid, i) => {
      const cnt = indexDoc?.categories?.[i]?.count ?? '';
      return `<button class="mini ${cat === cid && !onlyMatched ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="${esc(cid)}" data-matched="0">${esc(catLabels[cid] || cid)}${cnt ? ` (${cnt.toLocaleString('zh-TW')})` : ''}</button>`;
    })
  ].join('');

  const guidesHtml = (indexDoc?.webGuides || []).map((g) =>
    `<li><b>${esc(g.title)}</b>（${esc(g.site)}）— ${esc(g.focus)}</li>`
  ).join('');

  const rowsHtml = slice.map((r) => `
    <tr>
      <td><code>${esc(r[0])}</code>${matchedIdSet?.has(r[0]) ? ' <span class="pill-sub">已啟用</span>' : ''}</td>
      <td><span class="lex-cat-tag">${esc(catLabels[cats[r[1]]] || cats[r[1]])}</span></td>
      <td><b>${esc(r[4])}</b><div class="sub">${esc(r[5])}</div><small class="muted">來源：${esc(srcs[r[9]] || '')}</small></td>
      <td class="num">${Number(r[6]).toLocaleString('zh-TW')} 局</td>
      <td class="num"><strong>${(Number(r[7]) * 100).toFixed(1)}%</strong><br><small>${Number(r[8]) >= 0 ? '+' : ''}${(Number(r[8]) * 100).toFixed(1)}%</small></td>
    </tr>
  `).join('');

  return `
    <div class="flow-modal">
      <div class="lex-toolbar">
        <input id="lex-search-input" class="deck-name-input" type="search" value="${esc(q)}" placeholder="搜尋寶可夢名、卡號（如 B1a-014）、娜姿、赤日、大斗蓬、神奇糖果…" autocomplete="off">
        <div class="deep-page-tabs">${catPills}</div>
      </div>

      ${guidesHtml ? `
        <details class="strategy-weights-details">
          <summary>展開檢視 5 份納入詞條庫之網路頂尖競技攻略來源</summary>
          <ul class="lex-guide-list">${guidesHtml}</ul>
        </details>
      ` : ''}

      <div class="bench-table-wrap">
        <table class="bench-table lex-table">
          <thead>
            <tr><th>編號</th><th>分類</th><th>策略詞條與具體操作規則</th><th>考察局數</th><th>實測得分</th></tr>
          </thead>
          <tbody>${rowsHtml || '<tr><td colspan="5">查無符合條件的策略詞條</td></tr>'}</tbody>
        </table>
      </div>

      <div class="pager">
        <button class="btn btn-outline" type="button" data-action="strategy-lex-page" data-page="${curPage - 1}" ${curPage <= 1 ? 'disabled' : ''}>上一頁</button>
        <span class="pager-num">第 ${curPage} / ${totalPages} 頁 · 符合 ${list.length.toLocaleString('zh-TW')} 條（總庫 ${lexicon.entries.length.toLocaleString('zh-TW')} 條）</span>
        <button class="btn btn-outline" type="button" data-action="strategy-lex-page" data-page="${curPage + 1}" ${curPage >= totalPages ? 'disabled' : ''}>下一頁</button>
      </div>
    </div>
  `;
}

function renderWinningStrategyBanner(run, summary) {
  const ws = run.winningStrategy || null;
  const expCount = run.exploreStats?.completed ?? ws?.exploreTotal ?? 0;
  const expTarget = EXPLORE_TOTAL_GAMES;
  const expPct = Math.min(100, (expCount / expTarget) * 100).toFixed(1);
  const perf = run._livePerf || null;
  const perfBadge = perf && perf.gamesPerSec > 0
    ? `<span class="strategy-perf-pill">${perf.workers} 執行緒並行 · ${Math.round(perf.gamesPerSec).toLocaleString('zh-TW')} 局/秒</span>`
    : '';

  if (!expCount && !ws) {
    return `
      <div class="strategy-synth-banner is-pending">
        <div class="strategy-synth-head">
          <strong>兩階段千萬級勝利策略推演：第 1 階段（10,000,000 次對局推演勝利策略）→ 第 2 階段（50,000 次實際勝率推演）</strong>
          <span>待啟動</span>
        </div>
      </div>
    `;
  }

  const expWins = ws?.exploreWins ?? run.exploreStats?.wins ?? 0;
  const expDraws = ws?.exploreDraws ?? run.exploreStats?.draws ?? 0;
  const expLosses = ws?.exploreLosses ?? run.exploreStats?.losses ?? Math.max(0, expCount - expWins - expDraws);
  const expWr = expCount ? ((expWins / expCount) * 100).toFixed(2) + '%' : '—';
  const eliteWins = ws?.eliteWinsSelected || expWins;
  const testWrNum = summary?.equalWinRate;
  const baseExpWrNum = ws?.exploreWinRate ?? (expCount ? expWins / expCount : null);
  const gainPct = testWrNum != null && baseExpWrNum != null && summary.total > 0
    ? (testWrNum - baseExpWrNum) * 100
    : null;
  const gainBadge = gainPct != null
    ? `<span class="strategy-gain-pill ${gainPct >= 0 ? 'is-pos' : 'is-neg'}">第 2 階段 50,000 局勝率 ${(testWrNum * 100).toFixed(2)}%（較推演期 ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%）</span>`
    : perfBadge;

  const topTags = (ws?.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip" title="原始權重 ${a.base} → 1,000 萬局勝局提煉獲勝策略權重 ${a.synthesized}">
      <b>${esc(a.labelZh)}</b> <small>${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(3)}（→ ${a.synthesized.toFixed(2)}）</small>
    </span>`
  ).join('');

  const allRows = (ws?.allAdjustments || []).map((a) => `
    <tr>
      <td>${esc(a.labelZh)} <code>${esc(a.name)}</code></td>
      <td class="num">${a.base.toFixed(4)}</td>
      <td class="num"><strong>${a.synthesized.toFixed(4)}</strong></td>
      <td class="num">${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(4)}</td>
    </tr>
  `).join('');

  return `
    <div class="strategy-synth-banner ${expCount >= expTarget ? 'is-complete' : 'is-running'}">
      <div class="strategy-synth-head">
        <div>
          <strong>第一階段 · 10,000,000 次對局推演勝利策略（已完成 ${expCount.toLocaleString('zh-TW')} / ${expTarget.toLocaleString('zh-TW')} 局 · ${expPct}%）</strong>
          <p class="sub">結合 13,500 條策略詞條庫對前十對手執行 ${expCount.toLocaleString('zh-TW')} 次真實推演（${expWins.toLocaleString('zh-TW')}勝 ${expDraws.toLocaleString('zh-TW')}和 ${expLosses.toLocaleString('zh-TW')}敗，推演勝率 <b>${expWr}</b>），篩選 <b>${eliteWins.toLocaleString('zh-TW')} 場高勝率精英勝利對局</b>綜合提煉本牌組「獲勝策略」，並投入第二階段 50,000 次實際勝率推演。</p>
        </div>
        <div class="strategy-head-badges">${gainBadge}${gainPct != null && perfBadge ? perfBadge : ''}</div>
      </div>
      <div class="progress-track is-slim" aria-label="第一階段推演進度 ${expCount} / ${expTarget}">
        <i style="width:${expPct}%"></i>
      </div>
      ${topTags ? `<div class="card-prior-chips">${topTags}</div>` : ''}
      ${allRows ? `
        <details class="strategy-weights-details">
          <summary>展開檢視 1,000 萬局勝局綜合「獲勝策略」全部 22 維戰術權重對照表</summary>
          <div class="bench-table-wrap">
            <table class="bench-table">
              <thead><tr><th>戰術特徵</th><th>基礎模型權重</th><th>千萬局勝局提煉獲勝策略權重</th><th>勝局強化幅度</th></tr></thead>
              <tbody>${allRows}</tbody>
            </table>
          </div>
        </details>
      ` : ''}
    </div>
  `;
}

function renderDeckCardPriorsBar(deck) {
  const priorsDoc = state.cardPriors;
  if (!priorsDoc?.byCardId || !deck?.cards?.length) return '';
  let totalGames = 0;
  let totalEvals = 0;
  let distinct = 0;
  const highlights = [];
  for (const item of deck.cards) {
    const info = priorsDoc.byCardId[item.id];
    const card = state.cardsById?.get ? state.cardsById.get(item.id) : null;
    if (info) {
      distinct++;
      totalGames += Number(info.g || 0);
      totalEvals += Number(info.ev || 0);
      highlights.push({
        id: item.id,
        name: card?.name || item.id,
        count: item.count,
        games: info.g,
        evals: info.ev,
        scoreRate: info.sr,
        prior: info.p
      });
    }
  }
  if (!distinct) return '';
  highlights.sort((a, b) => b.scoreRate - a.scoreRate);
  const topChips = highlights.slice(0, 6).map((c) =>
    `<span class="card-prior-chip" title="單卡訓練參戰 ${c.games} 局 · 決策考量 ${c.evals} 次 · 綜合得分率 ${(c.scoreRate * 100).toFixed(1)}%">
      <b>${esc(c.name)}</b> ×${c.count} <small>${c.games}局 / ${c.evals}次考量 · ${(c.scoreRate * 100).toFixed(1)}%</small>
    </span>`
  ).join('');

  return `
    <div class="card-prior-banner">
      <div class="card-prior-head">
        <strong>參戰牌組單卡千次訓練評估（全卡池 ${priorsDoc.totalCards || 4577} 張卡 · 每張卡 ≥2,400 局策略考察 + ≥1,200 局主網訓練）</strong>
        <span>本牌組 ${distinct} 種卡牌累計參與評估 <b>${totalGames.toLocaleString('zh-TW')}</b> 局 · <b>${totalEvals.toLocaleString('zh-TW')}</b> 次決策評估</span>
      </div>
      <div class="card-prior-chips">${topChips}</div>
    </div>
  `;
}

function buildSampleEventsFromCompact(oppId, rec, gamesPerOpp = GAMES_PER_OPPONENT) {
  if (!rec?.outcomesStr) return [];
  const str = rec.outcomesStr;
  const half = Math.floor(gamesPerOpp / 2);
  const out = [];
  // 取前 250 局先攻 + 前 250 局後攻作為 500 格視覺點陣代表（全 5,000 局均可於回放中直接切換）
  for (let i = 0; i < Math.min(250, str.length); i++) {
    const ch = str[i];
    out.push({ opponentId: oppId, index: i, first: 0, outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw' });
  }
  for (let i = 0; i < 250; i++) {
    const srcIdx = half + i;
    if (srcIdx >= str.length) break;
    const ch = str[srcIdx];
    out.push({ opponentId: oppId, index: 250 + i, first: 1, outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw' });
  }
  return out;
}

export function renderBattleReport(run, lineup, options = {}) {
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const totalTarget = lineup.length * gamesPerOpp;
  const oppIds = lineup.map((x) => x.entry.id);
  const hasCompact = Boolean(run.compactResults && Object.keys(run.compactResults).length > 0);
  const legacyEvents = hasCompact ? [] : validOutcomes(run.events || [], oppIds, gamesPerOpp);
  const summary = hasCompact
    ? computeCompositeWinRateFromCompact(run.compactResults, lineup, gamesPerOpp)
    : computeCompositeWinRate(legacyEvents, lineup, gamesPerOpp);

  const subCount = lineup.filter((x) => x.isSubstitute).length;
  const overallRate = summary.equalWinRate != null ? (summary.equalWinRate * 100).toFixed(2) + '%' : '—';
  const scoreRateText = summary.equalScoreRate != null ? (summary.equalScoreRate * 100).toFixed(2) + '%' : '—';
  const weightedRate = summary.weightedWinRate != null ? (summary.weightedWinRate * 100).toFixed(2) + '%' : '—';
  const weightedDelta = summary.weightedWinRate != null && summary.equalWinRate != null
    ? (summary.weightedWinRate - summary.equalWinRate) * 100
    : null;
  const weightedDeltaText = weightedDelta == null
    ? ''
    : `${weightedDelta >= 0 ? '+' : ''}${weightedDelta.toFixed(2)}% vs 等權`;
  const firstRate = summary.first.winRate != null ? (summary.first.winRate * 100).toFixed(2) + '%' : '—';
  const secondRate = summary.second.winRate != null ? (summary.second.winRate * 100).toFixed(2) + '%' : '—';
  const avgTurnsText = summary.avgTurns != null ? `${summary.avgTurns.toFixed(1)} 回合` : '—';
  const bestText = summary.bestMatchups[0]
    ? `#${summary.bestMatchups[0].rank} ${summary.bestMatchups[0].name} (${(summary.bestMatchups[0].winRate * 100).toFixed(1)}%)`
    : '—';
  const worstText = summary.worstMatchups[0]
    ? `#${summary.worstMatchups[0].rank} ${summary.worstMatchups[0].name} (${(summary.worstMatchups[0].winRate * 100).toFixed(1)}%)`
    : '—';
  const currentDeck = state.decks.find((d) => d.id === run.deckId) || state.decks[0] || null;
  const ws = run.winningStrategy || null;

  let rowsHtml = '';
  for (const item of lineup) {
    const opp = item.entry;
    let aggAll, agg1, agg2, stripEvents;
    if (hasCompact) {
      const rec = run.compactResults[opp.id] || { total: 0, wins: 0, draws: 0, losses: 0, firstWins: 0, firstDraws: 0, firstLosses: 0, secondWins: 0, secondDraws: 0, secondLosses: 0 };
      aggAll = { wins: rec.wins, draws: rec.draws, losses: rec.losses, total: rec.total };
      agg1 = { wins: rec.firstWins, draws: rec.firstDraws, losses: rec.firstLosses, total: rec.firstWins + rec.firstDraws + rec.firstLosses };
      agg2 = { wins: rec.secondWins, draws: rec.secondDraws, losses: rec.secondLosses, total: rec.secondWins + rec.secondDraws + rec.secondLosses };
      stripEvents = buildSampleEventsFromCompact(opp.id, rec, gamesPerOpp);
    } else {
      const oppEvents = legacyEvents.filter((e) => e.opponentId === opp.id);
      const half = FIRST_SEAT_GAMES;
      aggAll = aggregate(oppEvents);
      agg1 = aggregate(oppEvents.filter((e) => (e.first != null ? e.first === 0 : e.index < half)));
      agg2 = aggregate(oppEvents.filter((e) => (e.first != null ? e.first === 1 : e.index >= half)));
      stripEvents = oppEvents.slice(0, 500);
    }

    const winPct = aggAll.total ? ((aggAll.wins / aggAll.total) * 100).toFixed(2) + '%' : '—';
    const f1Pct = agg1.total ? ((agg1.wins / agg1.total) * 100).toFixed(1) + '%' : '—';
    const f2Pct = agg2.total ? ((agg2.wins / agg2.total) * 100).toFixed(1) + '%' : '—';
    const metaRate = opp.winRate != null ? (opp.winRate * 100).toFixed(1) + '%' : '—';
    const metaShare = opp.share != null ? (opp.share * 100).toFixed(1) + '%' : '—';
    const tokens = (opp.representative?.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('');
    const oppSprites = renderPokemonSprites(resolveFeaturedPokemon(opp.representative, state.cardsById, state.spriteMap), 'sm');
    const oppExp = ws?.byOpponent?.[opp.id];
    const oppExpText = oppExp && oppExp.games > 0
      ? `推演 ${oppExp.games.toLocaleString('zh-TW')} 局取 ${oppExp.wins.toLocaleString('zh-TW')} 勝 (${(oppExp.winRate * 100).toFixed(1)}%)`
      : '推演待執行';

    rowsHtml += `
      <div class="battle-row" data-opp-row="${esc(opp.id)}">
        <div class="battle-opp-info">
          <div class="battle-opp-head">
            <span class="rank-num">#${item.rank}</span>
            ${item.isSubstitute ? `<span class="pill-sub">遞補 #${item.rank}</span>` : ''}
            <span class="tokens-inline">${tokens}</span>
            ${oppSprites}
            <strong class="battle-opp-name">${esc(opp.name)}</strong>
          </div>
          <div class="battle-opp-meta">
            <span>佔比 ${metaShare}</span>
            <span>賽事勝率 ${metaRate}</span>
            <span>${esc(oppExpText)}</span>
            <span>先攻 ${agg1.wins.toLocaleString('zh-TW')}-${agg1.losses.toLocaleString('zh-TW')}-${agg1.draws.toLocaleString('zh-TW')} (${f1Pct})</span>
            <span>後攻 ${agg2.wins.toLocaleString('zh-TW')}-${agg2.losses.toLocaleString('zh-TW')}-${agg2.draws.toLocaleString('zh-TW')} (${f2Pct})</span>
          </div>
          <div class="battle-opp-actions">
            ${!run.isDemo && options.canReplay ? `<button class="mini" type="button" data-action="run-single-opponent-deep" data-opp="${esc(opp.id)}">對此卡組單獨 10,000,000 推演 + 50,000 測試</button>` : ''}
            ${aggAll.total > 0 && options.canReplay ? `<button class="mini" type="button" data-action="replay-game" data-opp="${esc(opp.id)}" data-idx="0">檢視完整對局流程 (1–${aggAll.total.toLocaleString('zh-TW')}局)</button>` : ''}
          </div>
        </div>
        <div class="battle-strip-col">
          ${renderGameStrip(opp.id, stripEvents, Boolean(options.canReplay), 500, 'replay-game', 0, 500, 500)}
        </div>
        <div class="battle-opp-stat">
          <strong class="num-lg">${winPct}</strong>
          <span>${aggAll.wins.toLocaleString('zh-TW')}勝 ${aggAll.draws.toLocaleString('zh-TW')}和 ${aggAll.losses.toLocaleString('zh-TW')}敗 (${aggAll.total.toLocaleString('zh-TW')}/${gamesPerOpp.toLocaleString('zh-TW')}局)</span>
          <small>95% 信賴區間 ${interval(aggAll.wins, aggAll.total)}</small>
        </div>
      </div>
    `;
  }

  return `
    <div class="report-shell ${run.isDemo ? 'is-demo' : ''}">
      ${run.isDemo ? '<div class="status-note is-warn">以下為 ?fixture=1 預覽模式下的展示點陣（非真實規則引擎對局結果）。</div>' : ''}
      ${subCount > 0 ? `<div class="status-note">本次模擬含 ${subCount} 個遞補對手（部分原始前十牌表包含規則引擎尚未實裝的卡牌）。</div>` : ''}
      ${renderDeckCardPriorsBar(currentDeck)}
      ${renderStrategyLexiconBanner(run, currentDeck, lineup)}
      ${renderWinningStrategyBanner(run, summary)}
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">${summary.complete ? `第二階段 · 採用千萬局獲勝策略與萬條詞條庫之正式綜合勝率（50,000 次推演 · 勝場 ÷ ${totalTarget.toLocaleString('zh-TW')}）` : `第二階段 · 採用獲勝策略實際勝率推演中（已完成 ${summary.total.toLocaleString('zh-TW')} / ${totalTarget.toLocaleString('zh-TW')} 局）`}</span>
          <strong class="report-kpi-num">${overallRate}</strong>
          <span class="report-kpi-ci">95% Wilson 信賴區間 ${summary.equalCI95} · 和局計半積分率 ${scoreRateText} · 基礎模型：${esc(run.modelVersion || '未標註')}（套用 13,500 詞條庫 + 10,000,000 局勝局策略）</span>
        </div>
        <div class="report-totals">
          <div class="tot-box is-win"><b>${summary.wins.toLocaleString('zh-TW')}</b><span>勝</span></div>
          <div class="tot-box is-draw"><b>${summary.draws.toLocaleString('zh-TW')}</b><span>和</span></div>
          <div class="tot-box is-loss"><b>${summary.losses.toLocaleString('zh-TW')}</b><span>敗</span></div>
        </div>
      </div>
      <div class="composite-kpi-grid" aria-label="模擬綜合勝率多維度指標">
        <div class="comp-card is-accent">
          <span class="comp-label">環境使用率加權綜合勝率</span>
          <strong class="comp-val">${weightedRate}</strong>
          <small class="comp-sub">依前十賽場占比（合計 ${(summary.top10TotalShare * 100).toFixed(1)}%）加權${weightedDeltaText ? ` · ${weightedDeltaText}` : ''}</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">先攻綜合勝率（前 25,000 局）</span>
          <strong class="comp-val">${firstRate}</strong>
          <small class="comp-sub">${summary.first.wins.toLocaleString('zh-TW')}勝 ${summary.first.draws.toLocaleString('zh-TW')}和 ${summary.first.losses.toLocaleString('zh-TW')}敗（共 ${summary.first.total.toLocaleString('zh-TW')} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">後攻綜合勝率（後 25,000 局）</span>
          <strong class="comp-val">${secondRate}</strong>
          <small class="comp-sub">${summary.second.wins.toLocaleString('zh-TW')}勝 ${summary.second.draws.toLocaleString('zh-TW')}和 ${summary.second.losses.toLocaleString('zh-TW')}敗（共 ${summary.second.total.toLocaleString('zh-TW')} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">對陣優劣與平均回合</span>
          <strong class="comp-val is-sm">${avgTurnsText}</strong>
          <small class="comp-sub">最優：${esc(bestText)}<br>苦戰：${esc(worstText)}</small>
        </div>
      </div>
      <div class="progress-track" aria-label="第二階段 50,000 局實際勝率推演進度 ${summary.total} / ${totalTarget}">
        <i style="width:${Math.min(100, (summary.total / Math.max(1, totalTarget)) * 100).toFixed(1)}%"></i>
      </div>
      <div class="battle-matrix">${rowsHtml}</div>
    </div>
  `;
}

const ENERGY_ZH_MAP = {
  grass: '草', fire: '火', water: '水', lightning: '雷', psychic: '超',
  fighting: '鬥', darkness: '惡', metal: '鋼', dragon: '龍', colorless: '無色'
};

const STATUS_ZH_MAP = {
  poisoned: '中毒', poison: '中毒',
  burned: '灼傷', burn: '灼傷',
  asleep: '睡眠', sleep: '睡眠',
  paralyzed: '麻痺', paralysis: '麻痺',
  confused: '混亂', confusion: '混亂'
};

let cachedZhMaps = null;
let cachedZhCardsLen = -1;

function normEnKey(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function getZhLookupMaps(cardsList = state.cards) {
  const arr = Array.isArray(cardsList) ? cardsList : [];
  if (cachedZhMaps && cachedZhCardsLen === arr.length && arr === state.cards) return cachedZhMaps;
  const byEnName = new Map();
  const byCardId = new Map();
  for (const c of arr) {
    if (!c) continue;
    if (c.id) {
      byCardId.set(c.id.toUpperCase(), c);
      byCardId.set(c.id.toUpperCase().replace(/-/g, ' '), c);
      if (c.id.startsWith('PROMO-')) {
        const shortId = c.id.replace(/^PROMO-/, 'P-');
        byCardId.set(shortId.toUpperCase(), c);
        byCardId.set(shortId.toUpperCase().replace(/-/g, ' '), c);
      }
    }
    if (c.nameEn && c.name) {
      const k = normEnKey(c.nameEn);
      if (k && !byEnName.has(k)) byEnName.set(k, c);
    }
  }
  const maps = { byEnName, byCardId };
  if (arr === state.cards) {
    cachedZhMaps = maps;
    cachedZhCardsLen = arr.length;
  }
  return maps;
}

export function translateEnCardName(rawName, cardsList = state.cards) {
  const s = String(rawName || '').trim();
  if (!s) return '未知卡牌';
  const { byEnName, byCardId } = getZhLookupMaps(cardsList);

  // 先嘗試解析像 "A1 225 Sabrina" 或 "P-A 005 Poké Ball" 或 "Pokemon(A4a 010 Entei ex)"
  const wrapped = s.match(/^(?:Pokemon|Trainer)\((.+)\)$/i);
  const inner = wrapped ? wrapped[1].trim() : s;
  const idMatch = inner.match(/^([A-Za-z0-9-]+)\s+(\d{1,3})\s+(.+)$/);
  if (idMatch) {
    const setCode = idMatch[1].toUpperCase();
    const numPad = idMatch[2].padStart(3, '0');
    const c = byCardId.get(`${setCode}-${numPad}`) || byCardId.get(`${setCode} ${numPad}`);
    if (c?.name) return c.name;
    const byName = byEnName.get(normEnKey(idMatch[3]));
    if (byName?.name) return byName.name;
  }

  const direct = byEnName.get(normEnKey(inner));
  if (direct?.name) return direct.name;

  // 處理去掉前後贅詞或 ex 變體
  const noEx = inner.replace(/\s+ex$/i, '').trim();
  if (noEx !== inner) {
    const baseCard = byEnName.get(normEnKey(noEx));
    if (baseCard?.name) return `${baseCard.name}ex`;
  }
  return inner;
}

function slotLabelZh(idx) {
  const n = Number(idx);
  if (n === 0) return '戰鬥場';
  if (Number.isInteger(n) && n > 0) return `備戰區第 ${n} 格`;
  return '場上';
}

function playerSideZh(playerIdx) {
  return Number(playerIdx) === 0 ? '我方' : '對手';
}

function translateEnergyZh(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return ENERGY_ZH_MAP[key] || energyNames[raw] || '無色';
}

function translateStatusZh(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return STATUS_ZH_MAP[key] || '異常狀態';
}

function translateEnergyListZh(list) {
  if (!Array.isArray(list) || !list.length) return '無指定能量';
  return list.map((e) => `${translateEnergyZh(e)}系`).join('／');
}

function findCardForBoardSlot(boardSide, slotIdx, ctx) {
  if (!boardSide) return null;
  const rawName = Number(slotIdx) === 0
    ? boardSide.active?.name
    : boardSide.bench?.[Number(slotIdx) - 1]?.name;
  if (!rawName) return null;
  const key = normEnKey(rawName);
  return ctx?.matchCardsByEn?.get(key) || getZhLookupMaps(ctx?.cardsList).byEnName.get(key) || null;
}

export function translateActionLabel(raw, ctx = {}) {
  const s = String(raw || '').trim();
  const cardsList = ctx.cardsList || state.cards;
  const actor = ctx.actor ?? 0;
  const actorBoard = ctx.prevBoard?.[actor] || ctx.board?.[actor];

  if (s === 'EndTurn') return '結束回合';
  if (s === 'Noop') return '跳過本次可選動作';
  if (s === 'UseStadium') return '發動競技場效果';
  if (s === 'DiscardActiveStadium') return '丟棄場上的競技場卡';
  if (s === 'ApplyEeveeBagDamageBoost') return '發動伊布背包效果：本回合招式傷害增加';
  if (s === 'HealAllEeveeEvolutions') return '發動伊布背包效果：恢復場上所有伊布進化型體力';
  if (s === 'DiscardRandomOpponentActiveEnergy') return '隨機丟棄對手戰鬥場寶可夢的 1 顆能量';
  if (s === 'ShuffleOwnDeck') return '重洗己方牌庫';
  if (s === 'ShuffleRandomOwnHandCardIntoDeck') return '隨機將 1 張己方手牌洗回牌庫';

  let m;
  if ((m = s.match(/^Place\((.+),\s*(\d+)\)$/))) {
    return `將「${translateEnCardName(m[1], cardsList)}」放置於${slotLabelZh(m[2])}`;
  }
  if ((m = s.match(/^Evolve\((.+),\s*(\d+),\s*from_deck:\s*(true|false)\)$/))) {
    const fromDeck = m[3] === 'true' ? '（從牌庫檢索）' : '';
    return `將${slotLabelZh(m[2])}的寶可夢進化為「${translateEnCardName(m[1], cardsList)}」${fromDeck}`;
  }
  if ((m = s.match(/^Play\((.+)\)$/))) {
    return `施放訓練家卡「${translateEnCardName(m[1], cardsList)}」`;
  }
  if ((m = s.match(/^Attach\("(.+)",\s*(true|false)\)$/))) {
    const isTurn = m[2] === 'true';
    const parts = [];
    for (const seg of m[1].matchAll(/\((\d+),\s*([A-Za-z]+),\s*(\d+)\)/g)) {
      parts.push(`為${slotLabelZh(seg[3])}附著 ${seg[1]} 顆${translateEnergyZh(seg[2])}能量`);
    }
    const prefix = isTurn ? '從能量區' : '透過卡牌效果';
    return parts.length ? `${prefix}${parts.join('、')}` : `${prefix}附著能量`;
  }
  if ((m = s.match(/^AttachTool\((\d+),\s*(.+)\)$/))) {
    return `為${slotLabelZh(m[1])}寶可夢裝備道具「${translateEnCardName(m[2], cardsList)}」`;
  }
  if ((m = s.match(/^Attack\((.+)\)$/))) {
    const activeCard = findCardForBoardSlot(actorBoard, 0, ctx);
    const activeZh = activeCard?.name || (actorBoard?.active?.name ? translateEnCardName(actorBoard.active.name, cardsList) : '戰鬥場寶可夢');
    const attacks = activeCard?.attacks || [];
    if (attacks.length === 1) {
      const dmgTxt = attacks[0].damage ? `（傷害 ${attacks[0].damage}）` : '';
      return `「${activeZh}」發動招式「${attacks[0].name}」${dmgTxt}`;
    }
    if (attacks.length > 1) {
      const joined = attacks.map((a) => a.name).join('／');
      return `「${activeZh}」發動招式（${joined}）`;
    }
    return `「${activeZh}」發動招式攻擊`;
  }
  if ((m = s.match(/^UseAbility\((\d+)\)$/))) {
    const slot = Number(m[1]);
    const card = findCardForBoardSlot(actorBoard, slot, ctx);
    const pokeZh = card?.name ? `「${card.name}」` : '';
    const abName = card?.abilities?.[0]?.name ? `「${card.abilities[0].name}」` : '';
    return `發動${slotLabelZh(slot)}${pokeZh}的特性${abName}`;
  }
  if ((m = s.match(/^Retreat\((\d+)\)$/))) {
    return `戰鬥場寶可夢撤退，換上${slotLabelZh(m[1])}寶可夢`;
  }
  if ((m = s.match(/^Activate\((\d+),\s*(\d+)\)$/))) {
    return `將${playerSideZh(m[1])}${slotLabelZh(m[2])}寶可夢推上戰鬥場`;
  }
  if ((m = s.match(/^ApplyDamage\(attacker:\((\d+),\s*(\d+)\),\s*targets:\[(.+)\],\s*from_active:(true|false)\)$/))) {
    const targets = [];
    for (const seg of m[3].matchAll(/\((\d+),\s*(\d+),\s*(\d+)\)/g)) {
      targets.push(`對${playerSideZh(seg[2])}${slotLabelZh(seg[3])}造成 ${seg[1]} 點傷害`);
    }
    return targets.length ? targets.join('、') : '對目標造成傷害';
  }
  if ((m = s.match(/^Heal\((\d+),\s*(\d+),\s*cure:(true|false)\)$/))) {
    return `為${slotLabelZh(m[1])}寶可夢恢復 ${m[2]} 點體力${m[3] === 'true' ? '並解除異常狀態' : ''}`;
  }
  if ((m = s.match(/^HealAndCureConditions\((\d+),\s*(\d+),\s*\[(.*)\]\)$/))) {
    const conds = m[3].split(',').map((x) => x.trim()).filter(Boolean).map(translateStatusZh);
    return `為${slotLabelZh(m[1])}寶可夢恢復 ${m[2]} 點體力${conds.length ? `並解除${conds.join('、')}` : ''}`;
  }
  if ((m = s.match(/^HealAndDiscardEnergy\((\d+),\s*(\d+),\s*(.+)\)$/))) {
    return `為${slotLabelZh(m[1])}寶可夢恢復 ${m[2]} 點體力並棄置指定能量`;
  }
  if ((m = s.match(/^DrawCard\((\d+)\)$/))) {
    return `從牌庫抽取 ${m[1]} 張卡牌`;
  }
  if ((m = s.match(/^CommunicatePokemon\((.+)\)$/))) {
    return `透過寶可夢通訊將「${translateEnCardName(m[1], cardsList)}」洗回牌庫並換取隨機寶可夢`;
  }
  if ((m = s.match(/^ShufflePokemonIntoDeck\(\[(.+)\]\)$/)) || (m = s.match(/^ShuffleOwnCardsIntoDeck\(\[(.+)\]\)$/))) {
    const names = m[1].split(',').map((x) => translateEnCardName(x.trim(), cardsList)).filter(Boolean);
    return `將手牌中的「${names.join('、')}」洗回牌庫`;
  }
  if ((m = s.match(/^TakeTopDeckCardAndShuffle\((.+),\s*(\d+)\)$/))) {
    return `檢視牌庫頂 ${m[2]} 張並取得「${translateEnCardName(m[1], cardsList)}」後重洗牌庫`;
  }
  if ((m = s.match(/^AttachTypedFromDiscard\((\d+),\s*([A-Za-z]+),\s*(\d+)\)$/))) {
    return `從棄牌區將 ${m[3]} 顆${translateEnergyZh(m[2])}能量附著至${slotLabelZh(m[1])}`;
  }
  if ((m = s.match(/^AttachFromDiscard\((\d+),\s*(\d+)\)$/))) {
    return `從棄牌區隨機附著 ${m[2]} 顆能量至${slotLabelZh(m[1])}`;
  }
  if ((m = s.match(/^DiscardToolFromPokemon\((\d+),\s*(\d+),\s*(\d+)\)$/))) {
    return `移除${playerSideZh(m[1])}${slotLabelZh(m[2])}寶可夢裝備的道具`;
  }
  if ((m = s.match(/^MoveEnergy\(from:(\d+),\s*to:(\d+),\s*(\d+)x\s*([A-Za-z]+)\)$/))) {
    return `將 ${m[3]} 顆${translateEnergyZh(m[4])}能量從${slotLabelZh(m[1])}轉移至${slotLabelZh(m[2])}`;
  }
  if ((m = s.match(/^MoveEnergyAndReoffer\((\d+)\s*->\s*(\d+),\s*([A-Za-z]+),\s*(\d+)\s*left\)$/))) {
    return `將 1 顆${translateEnergyZh(m[3])}能量從${slotLabelZh(m[1])}轉移至${slotLabelZh(m[2])}（剩餘可轉移 ${m[4]} 次）`;
  }
  if ((m = s.match(/^FlipUntilTailsThenAttach\((\d+),\s*([A-Za-z]+),\s*max:(\d+)\)$/))) {
    return `擲硬幣至反面為止，為${slotLabelZh(m[1])}附著${translateEnergyZh(m[2])}能量（上限 ${m[3]} 顆）`;
  }
  if ((m = s.match(/^FlipUntilTailsThenHeal\((\d+),\s*(\d+),\s*max:(\d+)\)$/))) {
    return `擲硬幣至反面為止，每次正面為${slotLabelZh(m[1])}恢復 ${m[2]} 點體力`;
  }
  if ((m = s.match(/^MoveAllDamage\(from:(\d+),\s*to:(\d+)\)$/))) {
    return `將${slotLabelZh(m[1])}的全部傷害轉移至${slotLabelZh(m[2])}`;
  }
  if ((m = s.match(/^MoveDamageToOpponentActive\((\d+),\s*(\d+)\)$/))) {
    return `將${slotLabelZh(m[1])}的 ${m[2]} 點傷害轉移至對手戰鬥場`;
  }
  if ((m = s.match(/^ScheduleDelayedSpotKnockOut\(target:(\d+):(\d+)\)$/))) {
    return `預約延遲氣絕效果，鎖定${playerSideZh(m[1])}${slotLabelZh(m[2])}`;
  }
  if ((m = s.match(/^ScheduleDelayedSpotDamage\(target:(\d+):(\d+),\s*amount:(\d+)\)$/))) {
    return `預約延遲傷害效果，將對${playerSideZh(m[1])}${slotLabelZh(m[2])}造成 ${m[3]} 點傷害`;
  }
  if ((m = s.match(/^EvolveIntoRandomFromDeck\((\d+),\s*([A-Za-z]+)\)$/))) {
    return `從牌庫隨機將${slotLabelZh(m[1])}進化為${translateEnergyZh(m[2])}屬性寶可夢`;
  }
  if ((m = s.match(/^SwitchHandCardForRandomTool\((.+)\)$/))) {
    return `將手牌「${translateEnCardName(m[1], cardsList)}」換回牌庫並檢索隨機道具`;
  }
  if ((m = s.match(/^ShuffleOpponentSupporter\((.+)\)$/))) {
    return `將對手手牌中的支援者「${translateEnCardName(m[1], cardsList)}」洗回對手牌庫`;
  }
  if ((m = s.match(/^DiscardOpponentSupporter\((.+)\)$/))) {
    return `丟棄對手手牌中的支援者「${translateEnCardName(m[1], cardsList)}」`;
  }
  if ((m = s.match(/^PutDiscardCardInHand\((.+)\)$/))) {
    return `從棄牌區將「${translateEnCardName(m[1], cardsList)}」收回手牌`;
  }
  if ((m = s.match(/^DiscardOwnCardsThenDamage\(\[(.+)\],\s*(\d+)\s*to\s*(\d+):(\d+)\)$/))) {
    const names = m[1].split(',').map((x) => translateEnCardName(x.trim(), cardsList)).filter(Boolean);
    return `丟棄手牌「${names.join('、')}」，對${playerSideZh(m[3])}${slotLabelZh(m[4])}造成 ${m[2]} 點傷害`;
  }
  if ((m = s.match(/^DiscardOwnCards\(\[(.+)\]\)$/))) {
    const names = m[1].split(',').map((x) => translateEnCardName(x.trim(), cardsList)).filter(Boolean);
    return `丟棄手牌「${names.join('、')}」`;
  }
  if ((m = s.match(/^BenchOpponentPokemonFromHand\(\[(.+)\]\)$/))) {
    const names = m[1].split(',').map((x) => translateEnCardName(x.trim(), cardsList)).filter(Boolean);
    return `強制將對手手牌中的「${names.join('、')}」放置於對手備戰區`;
  }
  if ((m = s.match(/^BenchOpponentPokemonFromDiscard\((.+)\)$/))) {
    return `從對手棄牌區將「${translateEnCardName(m[1], cardsList)}」放置於對手備戰區`;
  }
  if ((m = s.match(/^SadaAttach\(\[(.+)\]\)$/))) {
    const parts = [];
    for (const seg of m[1].matchAll(/([A-Za-z]+)→(\d+)/g)) {
      parts.push(`為${slotLabelZh(seg[2])}附著${translateEnergyZh(seg[1])}能量`);
    }
    return parts.length ? `發動奧琳博士效果：${parts.join('、')}` : '發動奧琳博士附能效果';
  }
  if ((m = s.match(/^DiscardFossil\((\d+)\)$/))) {
    return `主動丟棄位於${slotLabelZh(m[1])}的化石卡`;
  }
  if ((m = s.match(/^DiscardOwnBenchedThenDamage\((\d+),\s*(\d+)\)$/))) {
    return `丟棄己方${slotLabelZh(m[1])}寶可夢並造成 ${m[2]} 點傷害`;
  }
  if ((m = s.match(/^DiscardOwnBenchedGroupThenDamage\(\[(.+)\],\s*(\d+)\)$/))) {
    return `丟棄己方指定備戰寶可夢並造成 ${m[2]} 點傷害`;
  }
  if ((m = s.match(/^ShuffleSelfAndAttachmentsIntoDeck\((\d+)\)$/))) {
    return `將${slotLabelZh(m[1])}寶可夢及所有附加卡洗回牌庫`;
  }
  if ((m = s.match(/^ReturnPokemonToHand\((\d+)\)$/))) {
    return `將${slotLabelZh(m[1])}寶可夢收回手牌`;
  }
  if ((m = s.match(/^ShuffleInPlayPokemonIntoDeck\((\d+)\)$/))) {
    return `將${slotLabelZh(m[1])}寶可夢洗回牌庫`;
  }
  if ((m = s.match(/^MoveRandomOpponentEnergyToActive\((\d+)\)$/))) {
    return `將對手${slotLabelZh(m[1])}的隨機 1 顆能量轉移至對手戰鬥場`;
  }
  if ((m = s.match(/^MoveOpponentActiveEnergyToSelf\((\d+)\)$/))) {
    return `將對手戰鬥場的 1 顆能量轉移至己方${slotLabelZh(m[1])}`;
  }
  if ((m = s.match(/^ApplyStatusToOpponentActive\((.+)\)$/))) {
    return `使對手戰鬥場寶可夢陷入「${translateStatusZh(m[1])}」狀態`;
  }
  if ((m = s.match(/^ApplyStatusesToOpponentActive\(\[(.+)\]\)$/))) {
    const conds = m[1].split(',').map((x) => translateStatusZh(x.trim()));
    return `使對手戰鬥場寶可夢陷入「${conds.join('、')}」狀態`;
  }
  if ((m = s.match(/^MoveActiveEnergyToBench\(to:(\d+),\s*(.+)\)$/))) {
    return `將戰鬥場寶可夢的能量轉移至${slotLabelZh(m[1])}`;
  }
  if ((m = s.match(/^MoveActiveEnergyToBenchAndReoffer\(to:(\d+),\s*([A-Za-z]+)\)$/))) {
    return `將戰鬥場的 1 顆${translateEnergyZh(m[2])}能量轉移至${slotLabelZh(m[1])}`;
  }
  if ((m = s.match(/^SwitchOpponentBenchedThenDamage\((\d+),\s*(\d+)\)$/))) {
    return `將對手${slotLabelZh(m[1])}寶可夢拖上戰鬥場並造成 ${m[2]} 點傷害`;
  }
  return '執行卡牌規則效果';
}

function formatBoardSide(b, cardsList = state.cards) {
  if (!b) return '空場';
  const active = b.active || (b.name ? b : null);
  const name = active?.name ? translateEnCardName(active.name, cardsList) : '空場';
  const hp = active?.hp != null ? `${active.hp}${active.maxHp ? `/${active.maxHp}` : ''}` : '0';
  const energy = active?.energy ?? 0;
  const benchArr = Array.isArray(b.bench) ? b.bench : [];
  const benchCount = Array.isArray(b.bench) ? b.bench.length : (b.bench ?? 0);
  const hand = b.hand ?? 0;
  const benchNames = benchArr.length
    ? `〔備戰：${benchArr.map((pc) => `${translateEnCardName(pc.name, cardsList)} ${pc.hp}/${pc.maxHp}·${pc.energy}能`).join('、')}〕`
    : '';
  return `<b>${esc(name)}</b>（體力 ${hp} · ${energy}能 · 備戰 ${benchCount} 隻 · 手牌 ${hand} 張）${benchNames ? ` <span class="muted">${esc(benchNames)}</span>` : ''}`;
}

export function buildFullGameFlowModal({ opp, oppId, idx, run, deck, weights, customGamesPerOpp = null, customWeights = null, customSeedPrefix = null, replayAction = 'replay-game' }) {
  const gamesPerOpp = customGamesPerOpp || GAMES_PER_OPPONENT;
  const half = Math.floor(gamesPerOpp / 2);
  const seed = fnv1a32(`${customSeedPrefix || run?.runId || 'demo'}:${oppId}:${idx}`);
  const first = idx < half ? 0 : 1;
  const sideText = first === 0
    ? `我方先攻（先攻第 ${(idx + 1).toLocaleString('zh-TW')}/${half.toLocaleString('zh-TW')} 局）`
    : `我方後攻（後攻第 ${(idx - half + 1).toLocaleString('zh-TW')}/${half.toLocaleString('zh-TW')} 局）`;
  const prevIdx = (idx - 1 + gamesPerOpp) % gamesPerOpp;
  const nextIdx = (idx + 1) % gamesPerOpp;

  if (!state.engineReady || !state.runtimeFn || !opp?.representative || !deck) {
    return `
      <div class="flow-modal">
        <div class="flow-nav-bar">
          <span>第 <b>${(idx + 1).toLocaleString('zh-TW')}</b> / ${gamesPerOpp.toLocaleString('zh-TW')} 局 · ${esc(sideText)} · 隨機種子 <code>${seed}</code></span>
        </div>
        <p class="desc">對戰模擬引擎尚未就緒，暫無法重播此局完整流程。</p>
      </div>
    `;
  }

  const playerWeights = customWeights
    || run?.winningStrategy?.byOpponent?.[oppId]?.weights
    || run?.winningStrategy?.weights
    || weights;

  const replayRes = state.runtimeFn({
    op: 'game',
    deck: { cards: deck.cards, energy: deck.energy },
    enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
    weights: playerWeights,
    enemy_weights: weights,
    seed,
    first,
    replay: true
  });

  // 建立本局雙方牌表精準英轉中映射（讓招式與特性 100% 精準顯示官方中文名）
  const matchCardsByEn = new Map();
  for (const item of [...(deck.cards || []), ...(opp.representative?.cards || [])]) {
    const c = state.cardsById?.get ? state.cardsById.get(item.id) : null;
    if (c?.nameEn) matchCardsByEn.set(normEnKey(c.nameEn), c);
  }

  const steps = Array.isArray(replayRes?.replay) ? replayRes.replay : [];
  const outcomeLabel = { win: '我方獲勝', loss: '對手獲勝', draw: '平局（達 30 回合上限）' }[replayRes.outcome] || '對局結束';
  const outcomeCls = `is-${replayRes.outcome || 'draw'}`;
  const finalPts = Array.isArray(replayRes?.points) ? `${replayRes.points[0]} : ${replayRes.points[1]}` : '—';

  // 記錄每一步執行前的盤面狀態，以便準確辨識發動招式／特性的當前寶可夢
  const enrichedSteps = steps.map((s, i) => ({
    ...s,
    _seq: i + 1,
    _prevBoard: i > 0 ? steps[i - 1].board : null
  }));

  const setupSteps = enrichedSteps.filter((s) => s.turn === 0);
  const combatSteps = enrichedSteps.filter((s) => s.turn > 0);
  const byTurn = new Map();
  for (const s of combatSteps) {
    if (!byTurn.has(s.turn)) byTurn.set(s.turn, []);
    byTurn.get(s.turn).push(s);
  }

  const renderStepRow = (s) => {
    const actorBadge = s.actor === 0
      ? '<span class="flow-actor is-me">我方（千萬局獲勝策略）</span>'
      : '<span class="flow-actor is-opp">對手（環境基準策略）</span>';
    const b0 = s.board?.[0];
    const b1 = s.board?.[1];
    const actionZh = translateActionLabel(s.action, {
      actor: s.actor,
      prevBoard: s._prevBoard,
      board: s.board,
      matchCardsByEn,
      cardsList: state.cards
    });
    const boardHtml = b0 && b1
      ? `<div class="flow-board-snap">
          <span>我方戰鬥場：${formatBoardSide(b0, state.cards)}</span>
          <span>對手戰鬥場：${formatBoardSide(b1, state.cards)}</span>
        </div>`
      : '';
    return `
      <li class="flow-step-item">
        <div class="flow-step-main">
          <span class="flow-step-idx">第 ${s._seq} 步</span>
          ${actorBadge}
          <span class="flow-action-text">${esc(actionZh)}</span>
          <span class="flow-pts-pill">比數 ${(s.points || [0, 0]).join(' : ')}</span>
        </div>
        ${boardHtml}
      </li>
    `;
  };

  const setupHtml = setupSteps.length
    ? `<ol class="flow-step-list">${setupSteps.map((s) => renderStepRow(s)).join('')}</ol>`
    : '<p class="sub">無開局紀錄</p>';

  let turnsHtml = '';
  for (const [turnNum, tSteps] of byTurn.entries()) {
    const turnActor = tSteps[0]?.actor === 0 ? '我方回合' : '對手回合';
    const endPts = (tSteps[tSteps.length - 1]?.points || [0, 0]).join(' : ');
    turnsHtml += `
      <div class="flow-turn-block">
        <div class="flow-turn-head">
          <strong>第 ${turnNum} 回合 · ${turnActor}</strong>
          <span>共 ${tSteps.length} 步決策 · 回合結束比數 ${endPts}</span>
        </div>
        <ol class="flow-step-list">
          ${tSteps.map((s) => renderStepRow(s)).join('')}
        </ol>
      </div>
    `;
  }

  return `
    <div class="flow-modal">
      <div class="flow-nav-bar">
        <div class="flow-nav-info">
          <span class="flow-result-badge ${outcomeCls}">${esc(outcomeLabel)}（${esc(finalPts)}）</span>
          <span>第 <b>${(idx + 1).toLocaleString('zh-TW')}</b> / ${gamesPerOpp.toLocaleString('zh-TW')} 局 · ${esc(sideText)}</span>
          <span>共 <b>${replayRes.turns || 0}</b> 回合 / <b>${steps.length}</b> 步完整動作 · 隨機種子 <code>${seed}</code></span>
        </div>
        <div class="flow-nav-btns">
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${prevIdx}">◀ 上一局（第 ${(prevIdx + 1).toLocaleString('zh-TW')} 局）</button>
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${nextIdx}">下一局（第 ${(nextIdx + 1).toLocaleString('zh-TW')} 局） ▶</button>
        </div>
      </div>

      <div class="flow-stage-card">
        <h3>階段一 · 對局雙方牌組與策略配置（精確規則引擎完整重現）</h3>
        <p class="sub">我方：<b>${esc(deck.name)}</b>（${esc(translateEnergyListZh(deck.energy))} · 套用 13,500 策略詞條庫與 10,000,000 局勝局提煉獲勝策略）　對陣　對手：<b>${esc(opp.name)}</b>（${esc(translateEnergyListZh(opp.representative.energy))} · 採用環境基準策略模型）</p>
      </div>

      <div class="flow-stage-card">
        <h3>階段二 · 開局準備階段（第 0 回合：起始手牌放置戰鬥場與備戰區）</h3>
        ${setupHtml}
      </div>

      <div class="flow-stage-card">
        <h3>階段三 · 逐回合完整對戰流程（第 1 回合 → 第 ${replayRes.turns || 0} 回合 · 完整展開全部 ${combatSteps.length} 步）</h3>
        <div class="flow-turns-scroll">${turnsHtml || '<p class="sub">無回合動作紀錄</p>'}</div>
      </div>

      <div class="flow-stage-card is-end">
        <h3>階段四 · 終局結算</h3>
        <p class="sub">最終判定：<b>${esc(outcomeLabel)}</b> · 最終得分 <b>${esc(finalPts)}</b> · 全場累計執行 <b>${steps.length}</b> 個合法對局動作，已完整呈現本局每一步操作與雙方場上變化。</p>
      </div>
    </div>
  `;
}

// 單一對手卡組專項「先 10,000,000 次對局推演勝利策略 → 後 50,000 次實際勝率推演」多執行緒執行器
export async function executeSingleOpponentDeep({ opp, deck, baseWeights, onProgress, signal }) {
  const { ready, fastSim, error } = await probeEngine();
  if (!ready) throw Error(error);
  const lexicon = await ensureStrategyLexicon();
  const matched = matchDeckStrategies(deck, [{ rank: 1, entry: opp }], lexicon, baseWeights);
  const oppMatched = matchDeckStrategies(opp.representative, [], lexicon, baseWeights);

  const myFastDeck = expandDeckForFastSim(deck, matched.cardBonusById);
  const oppFastDeck = expandDeckForFastSim(opp.representative, oppMatched.cardBonusById);
  const candidates = buildExplorationCandidates(matched.lexiconSeedWeights, `single10m:${deck.id}:${opp.id}`, EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats([opp.id], candidates.length);
  const seedBase = fnv1a32(`single10m-exp:${deck.id}:${opp.id}`);

  // 第一階段：10,000,000 局探索（100 塊 × 100,000 局，多執行緒 FastSim WASM 並行）
  const exploreChunkSize = 100000;
  const exploreTasks = [];
  for (let start = 0; start < DEEP_EXPLORE_GAMES; start += exploreChunkSize) {
    exploreTasks.push({
      start,
      request: {
        op: 'explore_10m_chunk',
        deck: myFastDeck,
        enemies: [{ id: opp.id, cards: oppFastDeck }],
        candidates,
        enemy_weights: baseWeights,
        games_per_opponent: DEEP_EXPLORE_GAMES,
        start_game: start,
        count: Math.min(exploreChunkSize, DEEP_EXPLORE_GAMES - start),
        seed_base: seedBase
      }
    });
  }

  const tExp0 = performance.now();
  let lastTick = 0;
  const workersUsed = await runFastTasks(exploreTasks, {
    fastSim,
    signal,
    onResult: (res) => {
      mergeExploreChunkStats(stats, res);
      const now = performance.now();
      if (now - lastTick >= 100 || stats.completed >= DEEP_EXPLORE_GAMES) {
        lastTick = now;
        const elapsedSec = Math.max(0.05, (now - tExp0) / 1000);
        onProgress?.({
          phase: 'explore',
          done: stats.completed,
          total: DEEP_EXPLORE_GAMES,
          wins: stats.wins,
          gamesPerSec: stats.completed / elapsedSec,
          workers: fastWorkerPool?.size || 1
        });
      }
    }
  });
  if (signal?.aborted) return null;

  const strategy = synthesizeWinningStrategyFromStats(stats, baseWeights, candidates);
  const winningWeights = strategy.byOpponent[opp.id]?.weights || strategy.weights;

  // 第二階段：50,000 局正式勝率推演（先攻 25,000 + 後攻 25,000，20 塊 × 2,500 局並行）
  const testCount = DEEP_GAMES_PER_OPPONENT;
  const seedPrefix = `single50k-test:${deck.id}`;
  const testSeedBase = fnv1a32(`${seedPrefix}:${opp.id}`);
  const testChunkSize = 2500;
  const testTasks = [];
  for (let start = 0; start < testCount; start += testChunkSize) {
    testTasks.push({
      start,
      request: {
        op: 'test_50k_chunk',
        deck: myFastDeck,
        enemy: oppFastDeck,
        opponent_id: opp.id,
        weights: winningWeights,
        enemy_weights: baseWeights,
        start_idx: start,
        count: Math.min(testChunkSize, testCount - start),
        total_per_opp: testCount,
        seed_base: testSeedBase
      }
    });
  }

  const allOutcomes = new Uint8Array(testCount);
  const allTurns = new Uint8Array(testCount);
  const agg = { total: 0, wins: 0, draws: 0, losses: 0, firstWins: 0, firstDraws: 0, firstLosses: 0, secondWins: 0, secondDraws: 0, secondLosses: 0, turnsSum: 0 };
  const tTest0 = performance.now();
  await runFastTasks(testTasks, {
    fastSim,
    signal,
    onResult: (res) => {
      const start = res.startIdx || 0;
      allOutcomes.set(res.outcomes, start);
      allTurns.set(res.turns, start);
      agg.total += res.completed;
      agg.wins += res.wins;
      agg.draws += res.draws;
      agg.losses += res.losses;
      agg.firstWins += res.firstWins;
      agg.firstDraws += res.firstDraws;
      agg.firstLosses += res.firstLosses;
      agg.secondWins += res.secondWins;
      agg.secondDraws += res.secondDraws;
      agg.secondLosses += res.secondLosses;
      agg.turnsSum += res.turnsSum;
      const elapsedSec = Math.max(0.05, (performance.now() - tTest0) / 1000);
      onProgress?.({
        phase: 'test',
        done: agg.total,
        total: testCount,
        gamesPerSec: agg.total / elapsedSec,
        workers: workersUsed
      });
    }
  });
  if (signal?.aborted) return null;

  return {
    opp,
    deck,
    baseWeights,
    winningWeights,
    matched,
    strategy,
    agg,
    allOutcomes,
    allTurns,
    seedPrefix,
    workersUsed
  };
}

export function renderSingleOpponentDeepProgress({ opp, phase, done, total, wins, gamesPerSec, workers }) {
  const pct = Math.min(100, (done / Math.max(1, total)) * 100).toFixed(1);
  const isExplore = phase === 'explore';
  return `
    <div class="flow-modal">
      <div class="strategy-synth-banner is-running">
        <div class="strategy-synth-head">
          <div>
            <strong>${isExplore ? `第一階段 · 正在對「${esc(opp.name)}」執行 10,000,000 次勝利策略推演` : `第二階段 · 已提煉千萬局獲勝策略，正在執行 50,000 次實際勝率推演`}</strong>
            <p class="sub">已完成 <b>${done.toLocaleString('zh-TW')}</b> / ${total.toLocaleString('zh-TW')} 局（${pct}%）${isExplore && wins != null ? ` · 已累計 ${wins.toLocaleString('zh-TW')} 場勝利對局` : ''} · 啟用 <b>${workers || 1}</b> 執行緒 FastSim 並行引擎（約 <b>${Math.round(gamesPerSec || 0).toLocaleString('zh-TW')}</b> 局/秒）</p>
          </div>
          <button class="btn btn-outline" type="button" data-action="cancel-single-deep">中止推演</button>
        </div>
        <div class="progress-track">
          <i style="width:${pct}%"></i>
        </div>
      </div>
    </div>
  `;
}

export function renderSingleOpponentDeepModal(deepResult, activeReplayIdx = 0) {
  const { opp, deck, baseWeights, winningWeights, matched, strategy, agg, allOutcomes, allTurns, seedPrefix } = deepResult;
  const testWr = agg.total ? ((agg.wins / agg.total) * 100).toFixed(2) + '%' : '—';
  const expWr = ((strategy.exploreWinRate || 0) * 100).toFixed(2) + '%';
  const deltaPct = agg.total
    ? ((agg.wins / agg.total - (strategy.exploreWinRate || 0)) * 100).toFixed(2)
    : '0.00';
  const topChips = (strategy.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip"><b>${esc(a.labelZh)}</b> <small>${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(3)}</small></span>`
  ).join('');

  // 10 個快速區段分頁（每頁 500 格，涵蓋先攻 1..25,000 與後攻 25,001..50,000）
  const pageSize = 500;
  const segmentStarts = [0, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000];
  let pageStart = Math.floor(activeReplayIdx / pageSize) * pageSize;
  pageStart = Math.min(DEEP_GAMES_PER_OPPONENT - pageSize, Math.max(0, pageStart));
  const pageEvents = [];
  for (let k = 0; k < pageSize; k++) {
    const idx = pageStart + k;
    const code = allOutcomes[idx];
    pageEvents.push({
      opponentId: opp.id,
      index: idx,
      first: idx < DEEP_GAMES_PER_OPPONENT / 2 ? 0 : 1,
      outcome: code === 1 ? 'win' : code === 0 ? 'loss' : 'draw',
      turns: allTurns[idx] || 0
    });
  }

  const pageTabs = segmentStarts.map((s, p) => {
    const active = activeReplayIdx >= s && activeReplayIdx < s + 5000;
    const side = p < 5 ? '先' : '後';
    return `<button class="mini ${active ? 'is-active' : ''}" type="button" data-action="replay-single-deep" data-opp="${esc(opp.id)}" data-idx="${s}">${side} ${(s + 1).toLocaleString('zh-TW')}–${(s + 500).toLocaleString('zh-TW')}</button>`;
  }).join('');

  const f1Total = agg.firstWins + agg.firstDraws + agg.firstLosses;
  const f2Total = agg.secondWins + agg.secondDraws + agg.secondLosses;

  const flowHtml = buildFullGameFlowModal({
    opp,
    oppId: opp.id,
    idx: activeReplayIdx,
    run: { modelVersion: state.modelInfo?.version || 'selfplay-cem-v3' },
    deck,
    weights: baseWeights,
    customGamesPerOpp: DEEP_GAMES_PER_OPPONENT,
    customWeights: winningWeights,
    customSeedPrefix: seedPrefix,
    replayAction: 'replay-single-deep'
  });

  return `
    <div class="flow-modal">
      <div class="strategy-synth-banner is-complete">
        <div class="strategy-synth-head">
          <div>
            <strong>第一階段 · 對此卡組已完成 10,000,000 次勝利策略推演（篩選 ${strategy.exploreWins.toLocaleString('zh-TW')} 場勝利，推演勝率 ${expWr}）</strong>
            <p class="sub">結合 <b>${matched?.matchedCount || 0}</b> 條激活策略詞條（總庫 13,500 條），從千萬局精英勝局（${strategy.eliteWinsSelected.toLocaleString('zh-TW')} 場）中綜合提煉針對「${esc(opp.name)}」的專屬獲勝策略。</p>
          </div>
          <span class="strategy-gain-pill ${Number(deltaPct) >= 0 ? 'is-pos' : 'is-neg'}">50,000 局勝率 ${testWr}（較推演期 ${Number(deltaPct) >= 0 ? '+' : ''}${deltaPct}%）</span>
        </div>
        <div class="card-prior-chips">${topChips}</div>
      </div>

      <div class="flow-stage-card">
        <h3>第二階段 · 採用獲勝策略進行 50,000 次實際勝率推演結果（${agg.wins.toLocaleString('zh-TW')}勝 ${agg.draws.toLocaleString('zh-TW')}和 ${agg.losses.toLocaleString('zh-TW')}敗 · 勝率 ${testWr} · 95% 信賴區間 ${interval(agg.wins, agg.total)}）</h3>
        <p class="sub">先攻 25,000 局：<b>${agg.firstWins.toLocaleString('zh-TW')}勝 ${agg.firstDraws.toLocaleString('zh-TW')}和 ${agg.firstLosses.toLocaleString('zh-TW')}敗 (${((agg.firstWins / Math.max(1, f1Total)) * 100).toFixed(2)}%)</b> · 後攻 25,000 局：<b>${agg.secondWins.toLocaleString('zh-TW')}勝 ${agg.secondDraws.toLocaleString('zh-TW')}和 ${agg.secondLosses.toLocaleString('zh-TW')}敗 (${((agg.secondWins / Math.max(1, f2Total)) * 100).toFixed(2)}%)</b> — 切換區段點陣點擊任意格檢視四階段回放：</p>
        <div class="deep-page-tabs">${pageTabs}</div>
        ${renderGameStrip(opp.id, pageEvents, true, pageSize, 'replay-single-deep', pageStart, pageSize, DEEP_GAMES_PER_OPPONENT)}
      </div>

      ${flowHtml}
    </div>
  `;
}

// 執行兩階段千萬級真實勝率推演佇列（多執行緒並行 FastSim WASM + 13,500 條策略詞條庫）：
// 第 1 階段：先採取 10,000,000 次對局推演勝利策略（10 對手 × 1,000,000 局）
// 第 2 階段：後續採取該獲勝策略再進行 50,000 次實際勝率推演（10 對手 × 5,000 局）
export async function executeBattleBatch({ run, deck, lineup, weights, onTick, signal }) {
  const { ready, fastSim, error } = await probeEngine();
  if (!ready) throw Error(error);

  const lexicon = await ensureStrategyLexicon();
  const matched = matchDeckStrategies(deck, lineup, lexicon, weights);
  run.matchedStrategies = {
    totalLexiconCount: matched.totalLexiconCount,
    matchedCount: matched.matchedCount,
    cardMatchedCount: matched.cardMatchedCount,
    macroMatchedCount: matched.macroMatchedCount,
    topActiveStrategies: matched.topActiveStrategies,
    matchedIds: matched.matchedIds
  };

  const myFastDeck = expandDeckForFastSim(deck, matched.cardBonusById);
  const fastEnemies = lineup.map((item) => {
    const oppM = matchDeckStrategies(item.entry.representative, [], lexicon, weights);
    return {
      id: item.entry.id,
      cards: expandDeckForFastSim(item.entry.representative, oppM.cardBonusById)
    };
  });
  const oppIds = fastEnemies.map((e) => e.id);
  const candidates = buildExplorationCandidates(
    matched.lexiconSeedWeights,
    `batch10m:${deck.id}:${run.season || 'C1'}`,
    EXPLORE_CANDIDATE_COUNT
  );

  if (!run.compactResults) run.compactResults = {};
  if (!run.exploreStats || run.exploreStats.byCandidate?.length !== candidates.length || run.exploreStats.byOpponent?.length !== oppIds.length) {
    run.exploreStats = createEmptyExploreStats(oppIds, candidates.length);
  }
  delete run.exploreEvents;

  // ============================================================================
  // 第一階段：10,000,000 次對局推演勝利策略（100 塊 × 100,000 局，多執行緒並行）
  // ============================================================================
  const completedChunks = new Set(run.exploreStats.completedChunks || []);
  const exploreChunkSize = 100000;
  const exploreSeedBase = fnv1a32(`${run.runId}:exp10m`);
  const exploreTasks = [];
  for (let start = 0; start < EXPLORE_TOTAL_GAMES; start += exploreChunkSize) {
    if (completedChunks.has(start)) continue;
    exploreTasks.push({
      start,
      request: {
        op: 'explore_10m_chunk',
        deck: myFastDeck,
        enemies: fastEnemies,
        candidates,
        enemy_weights: weights,
        games_per_opponent: EXPLORE_GAMES_PER_OPPONENT,
        start_game: start,
        count: Math.min(exploreChunkSize, EXPLORE_TOTAL_GAMES - start),
        seed_base: exploreSeedBase
      }
    });
  }

  if (exploreTasks.length > 0) {
    const t0 = performance.now();
    const baseDone = run.exploreStats.completed || 0;
    let lastUiTick = 0;
    let chunksSinceSave = 0;

    await runFastTasks(exploreTasks, {
      fastSim,
      signal,
      onResult: async (res) => {
        mergeExploreChunkStats(run.exploreStats, res);
        run.winningStrategy = synthesizeWinningStrategyFromStats(run.exploreStats, weights, candidates);
        chunksSinceSave++;
        const now = performance.now();
        const deltaGames = (run.exploreStats.completed || 0) - baseDone;
        const elapsedSec = Math.max(0.05, (now - t0) / 1000);
        run._livePerf = {
          workers: fastWorkerPool?.size || 1,
          gamesPerSec: deltaGames / elapsedSec,
          phase: 'explore'
        };
        if (chunksSinceSave >= 10 || run.exploreStats.completed >= EXPLORE_TOTAL_GAMES) {
          chunksSinceSave = 0;
          await saveRunRecord(run);
        }
        if (now - lastUiTick >= 120 || run.exploreStats.completed >= EXPLORE_TOTAL_GAMES) {
          lastUiTick = now;
          onTick(run);
        }
      }
    });

    if (signal?.aborted) {
      await saveRunRecord(run);
      onTick(run);
      return run;
    }
  }

  run.winningStrategy = synthesizeWinningStrategyFromStats(run.exploreStats, weights, candidates);
  await saveRunRecord(run);
  onTick(run);

  // ============================================================================
  // 第二階段：採用千萬局提煉出的「獲勝策略」進行 50,000 次實際勝率推演（10 對手 × 5,000 局）
  // ============================================================================
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const testChunkSize = 2500;
  const testTasks = [];

  for (let o = 0; o < lineup.length; o++) {
    const opp = lineup[o].entry;
    const existing = run.compactResults[opp.id];
    if (existing && existing.total >= gamesPerOpp) continue;
    const oppStrategyWeights = run.winningStrategy?.byOpponent?.[opp.id]?.weights
      || run.winningStrategy?.weights
      || weights;
    const seedBase = fnv1a32(`${run.runId}:test50k:${opp.id}`);
    for (let start = 0; start < gamesPerOpp; start += testChunkSize) {
      testTasks.push({
        oppId: opp.id,
        start,
        request: {
          op: 'test_50k_chunk',
          deck: myFastDeck,
          enemy: fastEnemies[o].cards,
          opponent_id: opp.id,
          weights: oppStrategyWeights,
          enemy_weights: weights,
          start_idx: start,
          count: Math.min(testChunkSize, gamesPerOpp - start),
          total_per_opp: gamesPerOpp,
          seed_base: seedBase
        }
      });
    }
  }

  if (testTasks.length > 0) {
    const oppBuffers = new Map();
    const tTest0 = performance.now();
    let testDone = Object.values(run.compactResults).reduce((s, r) => s + (r?.total || 0), 0);
    const baseTestDone = testDone;
    let lastUiTick = 0;

    await runFastTasks(testTasks, {
      fastSim,
      signal,
      onResult: async (res, task) => {
        const oppId = res.opponentId || task.oppId;
        let buf = oppBuffers.get(oppId);
        if (!buf) {
          buf = {
            total: 0, wins: 0, draws: 0, losses: 0,
            firstWins: 0, firstDraws: 0, firstLosses: 0,
            secondWins: 0, secondDraws: 0, secondLosses: 0,
            turnsSum: 0,
            chars: new Array(gamesPerOpp).fill('L')
          };
          oppBuffers.set(oppId, buf);
        }
        const start = res.startIdx ?? task.start;
        for (let k = 0; k < res.outcomes.length; k++) {
          const c = res.outcomes[k];
          buf.chars[start + k] = c === 1 ? 'W' : c === 0 ? 'L' : 'D';
        }
        buf.total += res.completed;
        buf.wins += res.wins;
        buf.draws += res.draws;
        buf.losses += res.losses;
        buf.firstWins += res.firstWins;
        buf.firstDraws += res.firstDraws;
        buf.firstLosses += res.firstLosses;
        buf.secondWins += res.secondWins;
        buf.secondDraws += res.secondDraws;
        buf.secondLosses += res.secondLosses;
        buf.turnsSum += res.turnsSum;

        run.compactResults[oppId] = {
          total: buf.total,
          wins: buf.wins,
          draws: buf.draws,
          losses: buf.losses,
          firstWins: buf.firstWins,
          firstDraws: buf.firstDraws,
          firstLosses: buf.firstLosses,
          secondWins: buf.secondWins,
          secondDraws: buf.secondDraws,
          secondLosses: buf.secondLosses,
          turnsSum: buf.turnsSum,
          outcomesStr: buf.chars.join('')
        };
        testDone += res.completed;
        const now = performance.now();
        const elapsedSec = Math.max(0.05, (now - tTest0) / 1000);
        run._livePerf = {
          workers: fastWorkerPool?.size || 1,
          gamesPerSec: (testDone - baseTestDone) / elapsedSec,
          phase: 'test'
        };
        if (now - lastUiTick >= 100 || testDone >= TOTAL_BATCH_GAMES) {
          lastUiTick = now;
          onTick(run);
        }
      }
    });
  }

  delete run._livePerf;
  await saveRunRecord(run);
  onTick(run);
  return run;
}

// 僅在 ?fixture=1 下用於 UI 樣式驗收的演示生成器（10,000,000 推演 + 50,000 測試）
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const oppIds = lineup.map((x) => x.entry.id);
  const baseW = Array(22).fill(0.5);
  const candidates = buildExplorationCandidates(baseW, 'fixture10m', EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats(oppIds, candidates.length);
  stats.completed = EXPLORE_TOTAL_GAMES;
  stats.wins = 4750000;
  stats.draws = 250000;
  stats.losses = 5000000;
  stats.byCandidate.forEach((c, idx) => {
    c.games = 250000;
    c.wins = 112000 + (idx % 5) * 4500;
    c.draws = 6250;
    c.losses = c.games - c.wins - c.draws;
  });
  stats.byOpponent.forEach((o, idx) => {
    o.games = EXPLORE_GAMES_PER_OPPONENT;
    o.wins = 450000 + (idx % 5) * 18000;
    o.draws = 25000;
    o.losses = o.games - o.wins - o.draws;
    o.byCandidate.forEach((bc, cIdx) => {
      bc.games = 25000;
      bc.wins = 11200 + (cIdx % 5) * 450;
      bc.draws = 625;
      bc.losses = bc.games - bc.wins - bc.draws;
    });
  });
  run.exploreStats = stats;
  run.winningStrategy = synthesizeWinningStrategyFromStats(stats, baseW, candidates);
  run.compactResults = {};
  for (const item of lineup) {
    if (signal.aborted) return run;
    const oppId = item.entry.id;
    let w = 0, d = 0, l = 0, fw = 0, fd = 0, fl = 0, sw = 0, sd = 0, sl = 0;
    const chars = [];
    for (let i = 0; i < GAMES_PER_OPPONENT; i++) {
      const seed = fnv1a32(`preview:${run.runId}:${oppId}:${i}`);
      const r = (seed % 1000) / 1000;
      const isFirst = i < FIRST_SEAT_GAMES;
      const ch = r < (isFirst ? 0.56 : 0.50) ? 'W' : r < 0.96 ? 'L' : 'D';
      chars.push(ch);
      if (ch === 'W') { w++; if (isFirst) fw++; else sw++; }
      else if (ch === 'D') { d++; if (isFirst) fd++; else sd++; }
      else { l++; if (isFirst) fl++; else sl++; }
    }
    run.compactResults[oppId] = {
      total: GAMES_PER_OPPONENT, wins: w, draws: d, losses: l,
      firstWins: fw, firstDraws: fd, firstLosses: fl,
      secondWins: sw, secondDraws: sd, secondLosses: sl,
      turnsSum: GAMES_PER_OPPONENT * 9,
      outcomesStr: chars.join('')
    };
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}
