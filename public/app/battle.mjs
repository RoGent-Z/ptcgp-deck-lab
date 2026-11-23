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
import { probeWebGPU } from '../battle/gpu-sim.mjs';

export function getOpponentEliteWeights(oppId, fallbackWeights) {
  const w = state.top10Elite?.teams?.[oppId]?.weights;
  return Array.isArray(w) && w.length === 22 ? w : fallbackWeights;
}

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 探測三層加速引擎：WebGPU 顯存計算 + FastSim 定點數 WASM（多核記憶體並行 + 一致回放）+ DeckGym 覆蓋率校驗
export async function probeEngine() {
  if (state.runtimeFn && state.fastSimFn) {
    return { ready: true, runtime: state.runtimeFn, fastSim: state.fastSimFn, gpuSim: state.gpuSim };
  }
  try {
    const [modRes, wasmRes, fastModRes, fastWasmRes, gpuEngine] = await Promise.all([
      import('../battle/runtime.mjs'),
      fetch('battle/deckgym.wasm'),
      import('../battle/fastsim-runtime.mjs'),
      fetch('battle/fastsim.wasm'),
      probeWebGPU().catch(() => null)
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
    state.gpuSim = gpuEngine || null;
    state.gpuReady = Boolean(gpuEngine?.ready);
    state.gpuAdapterName = gpuEngine?.adapterName || '';
    state.engineReady = true;
    state.engineError = '';
    ensureStrategyLexicon().catch(() => null);
    return { ready: true, runtime: fn, fastSim: fastFn, gpuSim: state.gpuSim };
  } catch (err) {
    state.engineReady = false;
    state.engineError = `對戰模擬引擎尚未載入（${err?.message || 'WASM 初始化失敗'}）。`;
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

export function renderGameStrip(opponentId, events = [], playable = false, gamesPerOpp = 500, actionName = 'replay-game', rangeStart = 0, rangeCount = null, totalAll = null, secondStart = null) {
  const count = rangeCount ?? gamesPerOpp;
  const totalLabel = totalAll ?? gamesPerOpp;
  const half = Math.floor(count / 2);
  const overallHalf = Math.floor(totalLabel / 2);
  const secondBase = secondStart ?? (rangeStart + half);
  const is500 = count >= 200;
  const byIndex = new Map();
  for (const e of events) byIndex.set(e.index, e);

  const makeHalf = (baseIdx, halfCount) => {
    let cells = '';
    for (let k = 0; k < halfCount; k++) {
      const idx = baseIdx + k;
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
    ${makeHalf(rangeStart, half)}
    <span class="strip-gap ${is500 ? 'is-500' : ''}" aria-hidden="true"></span>
    ${makeHalf(secondBase, count - half)}
  </div>`;
}

// 精簡版策略詞條庫與啟用詞條橫幅
function renderStrategyLexiconBanner(run, deck, lineup) {
  const idxDoc = state.strategyIndex;
  const totalLex = idxDoc?.totalEntries || state.strategyLexicon?.totalEntries || 13500;
  const matched = run?.matchedStrategies
    || (state.strategyLexicon && deck ? matchDeckStrategies(deck, lineup, state.strategyLexicon, state.modelInfo?.weights || []) : null);
  const activeCnt = matched?.matchedCount || 0;
  const topChips = (matched?.topActiveStrategies || []).slice(0, 6).map((s) =>
    `<span class="card-prior-chip" title="${esc(s.rule)}">
      <b>[${esc(s.catLabel)}] ${esc(s.title)}</b> <small>${(s.wr * 100).toFixed(1)}%</small>
    </span>`
  ).join('');

  return `
    <div class="lexicon-banner">
      <div class="strategy-synth-head">
        <div>
          <strong>策略詞條庫（${totalLex.toLocaleString('zh-TW')} 條${activeCnt > 0 ? ` · 本牌組啟用 ${activeCnt} 條` : ''}）</strong>
        </div>
        <button class="btn btn-outline" type="button" data-action="open-strategy-lexicon">瀏覽詞條庫</button>
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

function formatPerfBadge(perf) {
  if (!perf || !(perf.gamesPerSec > 0)) return '';
  const rate = Math.round(perf.gamesPerSec).toLocaleString('zh-TW');
  if (perf.mode === 'gpu') {
    return `<span class="strategy-perf-pill">GPU 顯存加速 · ${rate} 局/秒</span>`;
  }
  return `<span class="strategy-perf-pill">${perf.workers || 1} 核記憶體並行 · ${rate} 局/秒</span>`;
}

function renderWinningStrategyBanner(run, summary) {
  const ws = run.winningStrategy || null;
  const expCount = run.exploreStats?.completed ?? ws?.exploreTotal ?? 0;
  const expTarget = EXPLORE_TOTAL_GAMES;
  const expPct = Math.min(100, (expCount / expTarget) * 100).toFixed(1);
  const perfBadge = formatPerfBadge(run._livePerf);

  if (!expCount && !ws) {
    return `
      <div class="strategy-synth-banner is-pending">
        <div class="strategy-synth-head">
          <strong>第 1 階段 · 10 億局策略探索 → 第 2 階段 · 500 萬局實測</strong>
          <span>待啟動</span>
        </div>
      </div>
    `;
  }

  const expWins = ws?.exploreWins ?? run.exploreStats?.wins ?? 0;
  const expWr = expCount ? ((expWins / expCount) * 100).toFixed(2) + '%' : '—';
  const testWrNum = summary?.equalWinRate;
  const baseExpWrNum = ws?.exploreWinRate ?? (expCount ? expWins / expCount : null);
  const gainPct = testWrNum != null && baseExpWrNum != null && summary.total > 0
    ? (testWrNum - baseExpWrNum) * 100
    : null;
  const gainBadge = gainPct != null
    ? `<span class="strategy-gain-pill ${gainPct >= 0 ? 'is-pos' : 'is-neg'}">實測 ${(testWrNum * 100).toFixed(2)}%（${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%）</span>`
    : perfBadge;

  const topTags = (ws?.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip" title="基準 ${a.base} → 最佳化 ${a.synthesized}">
      <b>${esc(a.labelZh)}</b> <small>${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(3)}</small>
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
          <strong>第 1 階段 · 策略探索（${expCount.toLocaleString('zh-TW')} / ${expTarget.toLocaleString('zh-TW')} 局 · ${expPct}% · 勝率 ${expWr}）</strong>
        </div>
        <div class="strategy-head-badges">${gainBadge}${gainPct != null && perfBadge ? perfBadge : ''}</div>
      </div>
      <div class="progress-track is-slim" aria-label="第一階段探索進度 ${expCount} / ${expTarget}">
        <i style="width:${expPct}%"></i>
      </div>
      ${topTags ? `<div class="card-prior-chips">${topTags}</div>` : ''}
      ${allRows ? `
        <details class="strategy-weights-details">
          <summary>展開 22 維獲勝策略權重對照表</summary>
          <div class="bench-table-wrap">
            <table class="bench-table">
              <thead><tr><th>戰術特徵</th><th>基準權重</th><th>最佳化權重</th><th>變化量</th></tr></thead>
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
  let distinct = 0;
  const highlights = [];
  for (const item of deck.cards) {
    const info = priorsDoc.byCardId[item.id];
    const card = state.cardsById?.get ? state.cardsById.get(item.id) : null;
    if (info) {
      distinct++;
      highlights.push({
        id: item.id,
        name: card?.name || item.id,
        count: item.count,
        games: info.g,
        scoreRate: info.sr
      });
    }
  }
  if (!distinct) return '';
  highlights.sort((a, b) => b.scoreRate - a.scoreRate);
  const topChips = highlights.slice(0, 6).map((c) =>
    `<span class="card-prior-chip" title="單卡實測 ${c.games} 局 · 得分率 ${(c.scoreRate * 100).toFixed(1)}%">
      <b>${esc(c.name)}</b> ×${c.count} <small>${(c.scoreRate * 100).toFixed(1)}%</small>
    </span>`
  ).join('');

  return `
    <div class="card-prior-banner">
      <div class="card-prior-head">
        <strong>單卡評分先驗</strong>
        <span>已載入本牌組 ${distinct} 種卡牌實戰權重</span>
      </div>
      <div class="card-prior-chips">${topChips}</div>
    </div>
  `;
}

function buildSampleEventsFromCompact(oppId, rec, gamesPerOpp = GAMES_PER_OPPONENT) {
  const half = Math.floor(gamesPerOpp / 2);
  if (rec?.sampleOutcomesStr && rec.sampleOutcomesStr.length > 0) {
    const s = rec.sampleOutcomesStr;
    const out = [];
    const n1 = Math.min(250, s.length);
    for (let i = 0; i < n1; i++) {
      const ch = s[i];
      out.push({ opponentId: oppId, index: i, first: 0, outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw' });
    }
    for (let i = 250; i < Math.min(500, s.length); i++) {
      const ch = s[i];
      out.push({ opponentId: oppId, index: half + (i - 250), first: 1, outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw' });
    }
    return out;
  }
  if (!rec?.outcomesStr) return [];
  const str = rec.outcomesStr;
  const out = [];
  for (let i = 0; i < Math.min(250, str.length); i++) {
    const ch = str[i];
    out.push({ opponentId: oppId, index: i, first: 0, outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw' });
  }
  for (let i = 0; i < 250; i++) {
    const srcIdx = half + i;
    if (srcIdx >= str.length) break;
    const ch = str[srcIdx];
    out.push({ opponentId: oppId, index: srcIdx, first: 1, outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw' });
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
    const oppEliteInfo = state.top10Elite?.teams?.[opp.id];
    const oppExpText = oppExp && oppExp.games > 0
      ? `探索 ${oppExp.games.toLocaleString('zh-TW')} 局 (${(oppExp.winRate * 100).toFixed(1)}%)`
      : '待探索';

    rowsHtml += `
      <div class="battle-row" data-opp-row="${esc(opp.id)}">
        <div class="battle-opp-info">
          <div class="battle-opp-head">
            <span class="rank-num">#${item.rank}</span>
            ${item.isSubstitute ? `<span class="pill-sub">遞補 #${item.rank}</span>` : ''}
            ${oppEliteInfo ? `<span class="pill-sub" title="前十互博訓練 ${Number(oppEliteInfo.gamesTrained || 10000000).toLocaleString('zh-TW')} 局專屬最佳策略">千萬局最佳化</span>` : ''}
            <span class="tokens-inline">${tokens}</span>
            ${oppSprites}
            <strong class="battle-opp-name">${esc(opp.name)}</strong>
          </div>
          <div class="battle-opp-meta">
            <span>佔比 ${metaShare}</span>
            <span>賽事 ${metaRate}</span>
            <span>${esc(oppExpText)}</span>
            <span>先攻 ${agg1.wins.toLocaleString('zh-TW')}-${agg1.losses.toLocaleString('zh-TW')}-${agg1.draws.toLocaleString('zh-TW')} (${f1Pct})</span>
            <span>後攻 ${agg2.wins.toLocaleString('zh-TW')}-${agg2.losses.toLocaleString('zh-TW')}-${agg2.draws.toLocaleString('zh-TW')} (${f2Pct})</span>
          </div>
          <div class="battle-opp-actions">
            ${!run.isDemo && options.canReplay ? `<button class="mini" type="button" data-action="run-single-opponent-deep" data-opp="${esc(opp.id)}">單組 10 億探索 + 500 萬實測</button>` : ''}
            ${aggAll.total > 0 && options.canReplay ? `<button class="mini" type="button" data-action="replay-game" data-opp="${esc(opp.id)}" data-idx="0">檢視完整流程 (1–${aggAll.total.toLocaleString('zh-TW')}局)</button>` : ''}
          </div>
        </div>
        <div class="battle-strip-col">
          ${renderGameStrip(opp.id, stripEvents, Boolean(options.canReplay), 500, 'replay-game', 0, 500, gamesPerOpp, hasCompact ? FIRST_SEAT_GAMES : 250)}
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
      ${run.isDemo ? '<div class="status-note is-warn">預覽模式展示點陣（非真實引擎對局）。</div>' : ''}
      ${subCount > 0 ? `<div class="status-note">含 ${subCount} 個遞補對手。</div>` : ''}
      ${renderDeckCardPriorsBar(currentDeck)}
      ${renderStrategyLexiconBanner(run, currentDeck, lineup)}
      ${renderWinningStrategyBanner(run, summary)}
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">${summary.complete ? `第 2 階段 · 正式綜合勝率（5,000,000 局實測 · 對陣前十千萬局最佳化策略）` : `第 2 階段 · 實測中（${summary.total.toLocaleString('zh-TW')} / ${totalTarget.toLocaleString('zh-TW')} 局）`}</span>
          <strong class="report-kpi-num">${overallRate}</strong>
          <span class="report-kpi-ci">95% 信賴區間 ${summary.equalCI95} · 積分率 ${scoreRateText} · 模型 ${esc(run.modelVersion === 'selfplay-cem-v3' ? '1B5M全量模型' : (run.modelVersion || '—'))}</span>
        </div>
        <div class="report-totals">
          <div class="tot-box is-win"><b>${summary.wins.toLocaleString('zh-TW')}</b><span>勝</span></div>
          <div class="tot-box is-draw"><b>${summary.draws.toLocaleString('zh-TW')}</b><span>和</span></div>
          <div class="tot-box is-loss"><b>${summary.losses.toLocaleString('zh-TW')}</b><span>敗</span></div>
        </div>
      </div>
      <div class="composite-kpi-grid" aria-label="模擬綜合勝率多維度指標">
        <div class="comp-card is-accent">
          <span class="comp-label">環境加權綜合勝率</span>
          <strong class="comp-val">${weightedRate}</strong>
          <small class="comp-sub">依前十占比（${(summary.top10TotalShare * 100).toFixed(1)}%）加權${weightedDeltaText ? ` · ${weightedDeltaText}` : ''}</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">先攻勝率（250 萬局）</span>
          <strong class="comp-val">${firstRate}</strong>
          <small class="comp-sub">${summary.first.wins.toLocaleString('zh-TW')}勝 ${summary.first.draws.toLocaleString('zh-TW')}和 ${summary.first.losses.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">後攻勝率（250 萬局）</span>
          <strong class="comp-val">${secondRate}</strong>
          <small class="comp-sub">${summary.second.wins.toLocaleString('zh-TW')}勝 ${summary.second.draws.toLocaleString('zh-TW')}和 ${summary.second.losses.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">優劣勢與平均回合</span>
          <strong class="comp-val is-sm">${avgTurnsText}</strong>
          <small class="comp-sub">最優：${esc(bestText)}<br>苦戰：${esc(worstText)}</small>
        </div>
      </div>
      <div class="progress-track" aria-label="第二階段 5,000,000 局實測進度 ${summary.total} / ${totalTarget}">
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

function expandCardObjs20(deckLike) {
  const out = [];
  for (const item of deckLike?.cards || []) {
    const card = state.cardsById?.get ? state.cardsById.get(item.id) : null;
    const cnt = Math.max(1, Number(item.count || 1));
    for (let k = 0; k < cnt; k++) {
      if (out.length < 20) out.push(card || { id: item.id, name: item.id });
    }
  }
  while (out.length < 20 && out.length > 0) out.push(out[0]);
  return out;
}

function formatFastSimStepZh(step, myCards20, oppCards20) {
  const actorCards = step.actor === 0 ? myCards20 : oppCards20;
  const card = step.cardIdx >= 0 && step.cardIdx < actorCards.length ? actorCards[step.cardIdx] : null;
  const cName = card?.name || '寶可夢';
  switch (step.kind) {
    case 1:
      return `開局將「${cName}」放置於戰鬥場`;
    case 2:
      return `開局將「${cName}」放置於${slotLabelZh(step.aux1)}`;
    case 3:
      return `從牌庫抽取 1 張卡牌（「${cName}」）`;
    case 4:
      return `將「${cName}」放置於${slotLabelZh(step.aux1)}`;
    case 5:
      return `將${slotLabelZh(step.aux1)}的寶可夢進化為「${cName}」`;
    case 6: {
      const tk = step.aux1;
      const val = step.aux2;
      if (tk === 1) return `施放訓練家卡「${cName}」（檢索／抽取 ${Math.max(1, Math.min(2, val))} 張卡牌）`;
      if (tk === 2) return `施放恢復訓練家卡「${cName}」（為戰鬥場恢復 ${val} 點體力）`;
      if (tk === 3) return val === 3 ? `施放干擾訓練家卡「${cName}」（壓縮對手手牌）` : `施放干擾訓練家卡「${cName}」（強制替換對手戰鬥場寶可夢）`;
      if (tk === 4) return `施放增傷訓練家卡「${cName}」（本回合招式傷害 +${val}）`;
      if (tk === 5) return val > 0 ? `為戰鬥場裝備道具「${cName}」（最大體力 +20）` : `為戰鬥場裝備道具「${cName}」（反擊傷害 20）`;
      if (tk === 6) return val === 99 ? `施放「${cName}」（基礎寶可夢直接跳階進化為二階）` : val >= 2 ? `施放「${cName}」（額外補充 1 顆能量）` : `施放機動訓練家卡「${cName}」`;
      if (tk === 7) return `發動競技場卡「${cName}」（招式傷害 +10）`;
      return `施放訓練家卡「${cName}」`;
    }
    case 7: {
      const abName = card?.abilities?.[0]?.name ? `「${card.abilities[0].name}」` : '';
      return `發動${slotLabelZh(step.aux1)}「${cName}」的特性${abName}`;
    }
    case 8:
      return `從能量區為${slotLabelZh(step.aux1)}「${cName}」附著 1 顆能量（目前 ${step.aux2} 顆）`;
    case 9: {
      const newCard = step.aux2 >= 0 && step.aux2 < actorCards.length ? actorCards[step.aux2] : null;
      const newName = newCard?.name || `${slotLabelZh(step.aux1)}寶可夢`;
      return `戰鬥場「${cName}」撤退，換上${slotLabelZh(step.aux1)}「${newName}」`;
    }
    case 10: {
      const atkName = card?.attacks?.[0]?.name ? `「${card.attacks[0].name}」` : '主力招式';
      const weakBonus = step.aux2 & 0xff;
      const ko = (step.aux2 >> 8) & 1;
      const extra = `${weakBonus > 0 ? '，觸發屬性弱點 +20' : ''}${ko ? '，擊倒對手戰鬥場寶可夢！' : ''}`;
      return `「${cName}」發動招式${atkName}，造成 ${step.aux1} 點傷害${extra}`;
    }
    case 11:
      return '結束回合';
    case 12:
      return `回合間檢查：${playerSideZh(step.actor)}戰鬥場「${cName}」因異常狀態受到 ${step.aux1} 點傷害${step.aux2 ? '並氣絕！' : ''}`;
    default:
      return '執行對局動作';
  }
}

function formatFastBoardSide(side, deckCards20) {
  if (!side || side.cardIdx < 0) return '空場（等待替補）';
  const card = deckCards20[side.cardIdx];
  const name = card?.name || '寶可夢';
  const toolTag = side.tool === 1 ? '·斗蓬' : side.tool === 2 ? '·頭盔' : '';
  return `<b>${esc(name)}</b>（體力 ${side.hp}/${side.maxHp} · ${side.energy}能${toolTag} · 備戰 ${side.bench} 隻 · 手牌 ${side.hand} 張 · 牌庫 ${side.deck} 張）`;
}

export function buildFullGameFlowModal({
  opp,
  oppId,
  idx,
  run,
  deck,
  weights,
  customGamesPerOpp = null,
  customWeights = null,
  customEnemyWeights = null,
  customSeedPrefix = null,
  customSeedBase = null,
  customMyFastDeck = null,
  customOppFastDeck = null,
  replayAction = 'replay-game'
}) {
  const gamesPerOpp = customGamesPerOpp || GAMES_PER_OPPONENT;
  const half = Math.floor(gamesPerOpp / 2);
  const seedBase = customSeedBase ?? (
    customSeedPrefix
      ? fnv1a32(`${customSeedPrefix}:${oppId}`)
      : fnv1a32(`${run?.runId || 'demo'}:test5m:${oppId}`)
  );
  const first = idx < half ? 0 : 1;
  const sideText = first === 0
    ? `我方先攻（先攻第 ${(idx + 1).toLocaleString('zh-TW')}/${half.toLocaleString('zh-TW')} 局）`
    : `我方後攻（後攻第 ${(idx - half + 1).toLocaleString('zh-TW')}/${half.toLocaleString('zh-TW')} 局）`;
  const prevIdx = (idx - 1 + gamesPerOpp) % gamesPerOpp;
  const nextIdx = (idx + 1) % gamesPerOpp;

  if (!state.engineReady || !state.fastSimFn || !opp?.representative || !deck) {
    return `
      <div class="flow-modal">
        <div class="flow-nav-bar">
          <span>第 <b>${(idx + 1).toLocaleString('zh-TW')}</b> / ${gamesPerOpp.toLocaleString('zh-TW')} 局 · ${esc(sideText)} · 隨機種子 <code>${seedBase}</code></span>
        </div>
        <p class="desc">對戰模擬引擎尚未就緒，暫無法重播此局完整流程。</p>
      </div>
    `;
  }

  const playerWeights = customWeights
    || run?.winningStrategy?.byOpponent?.[oppId]?.weights
    || run?.winningStrategy?.weights
    || weights;
  const enemyWeights = customEnemyWeights || getOpponentEliteWeights(oppId, weights);
  const hasOppElite = Boolean(state.top10Elite?.teams?.[oppId]);

  let myBonus = run?.matchedStrategies?.cardBonusById || null;
  let oppBonus = run?.matchedStrategies?.oppCardBonusById?.[oppId] || null;
  if (!myBonus && state.strategyLexicon) {
    myBonus = matchDeckStrategies(deck, [{ rank: 1, entry: opp }], state.strategyLexicon, weights).cardBonusById;
  }
  if (!oppBonus && state.strategyLexicon) {
    oppBonus = matchDeckStrategies(opp.representative, [], state.strategyLexicon, enemyWeights).cardBonusById;
  }
  const myFastDeck = customMyFastDeck || expandDeckForFastSim(deck, myBonus || {});
  const oppFastDeck = customOppFastDeck || expandDeckForFastSim(opp.representative, oppBonus || {});

  const replayRes = state.fastSimFn({
    op: 'replay_game',
    deck: myFastDeck,
    enemy: oppFastDeck,
    weights: playerWeights,
    enemy_weights: enemyWeights,
    game_idx: idx,
    total_per_opp: gamesPerOpp,
    seed_base: seedBase
  });

  const myCards20 = expandCardObjs20(deck);
  const oppCards20 = expandCardObjs20(opp.representative);
  const steps = Array.isArray(replayRes?.steps) ? replayRes.steps : [];
  const outcomeLabel = { win: '我方獲勝', loss: '對手獲勝', draw: '平局（達 30 回合上限）' }[replayRes.outcome] || '對局結束';
  const outcomeCls = `is-${replayRes.outcome || 'draw'}`;
  const finalPts = Array.isArray(replayRes?.points) ? `${replayRes.points[0]} : ${replayRes.points[1]}` : '—';

  const enrichedSteps = steps.map((s, i) => ({ ...s, _seq: i + 1 }));
  const setupSteps = enrichedSteps.filter((s) => s.turn === 0);
  const combatSteps = enrichedSteps.filter((s) => s.turn > 0);
  const byTurn = new Map();
  for (const s of combatSteps) {
    if (!byTurn.has(s.turn)) byTurn.set(s.turn, []);
    byTurn.get(s.turn).push(s);
  }

  const renderStepRow = (s) => {
    const actorBadge = s.actor === 0
      ? '<span class="flow-actor is-me">我方（十億局獲勝策略）</span>'
      : `<span class="flow-actor is-opp">對手（${hasOppElite ? '千萬局互博最佳策略' : '環境策略'}）</span>`;
    const actionZh = formatFastSimStepZh(s, myCards20, oppCards20);
    const b0 = s.board?.[0];
    const b1 = s.board?.[1];
    const boardHtml = b0 && b1
      ? `<div class="flow-board-snap">
          <span>我方戰鬥場：${formatFastBoardSide(b0, myCards20)}</span>
          <span>對手戰鬥場：${formatFastBoardSide(b1, oppCards20)}</span>
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
          <span>共 <b>${replayRes.turns || 0}</b> 回合 / <b>${steps.length}</b> 步完整動作 · 隨機種子 <code>${seedBase}</code></span>
        </div>
        <div class="flow-nav-btns">
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${prevIdx}">◀ 上一局（第 ${(prevIdx + 1).toLocaleString('zh-TW')} 局）</button>
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${nextIdx}">下一局（第 ${(nextIdx + 1).toLocaleString('zh-TW')} 局） ▶</button>
        </div>
      </div>

      <div class="flow-stage-card">
        <h3>階段一 · 對局配置</h3>
        <p class="sub">我方：<b>${esc(deck.name)}</b>（${esc(translateEnergyListZh(deck.energy))} · 十億局獲勝策略）　對陣　對手：<b>${esc(opp.name)}</b>（${esc(translateEnergyListZh(opp.representative.energy))} · ${hasOppElite ? '千萬局互博最佳策略' : '環境策略'}）</p>
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
        <p class="sub">最終判定：<b>${esc(outcomeLabel)}</b> · 最終得分 <b>${esc(finalPts)}</b> · 全場累計執行 <b>${steps.length}</b> 個合法對局動作，已與點陣勝負結果完全一致重現。</p>
      </div>
    </div>
  `;
}

function sampleArrayToStr(arr500) {
  let out = '';
  for (let i = 0; i < 500; i++) {
    const c = arr500[i];
    out += c === 1 ? 'W' : c === 0 ? 'L' : 'D';
  }
  return out;
}

// 單一對手卡組專項「先 1,000,000,000 (1B) 探索 → 後 5,000,000 (5M) 實測」（GPU 顯存加速 + 多核記憶體備援）
export async function executeSingleOpponentDeep({ opp, deck, baseWeights, onProgress, signal }) {
  const { ready, fastSim, gpuSim, error } = await probeEngine();
  if (!ready) throw Error(error);
  const lexicon = await ensureStrategyLexicon();
  const oppEliteWeights = getOpponentEliteWeights(opp.id, baseWeights);
  const matched = matchDeckStrategies(deck, [{ rank: 1, entry: opp }], lexicon, baseWeights);
  const oppMatched = matchDeckStrategies(opp.representative, [], lexicon, oppEliteWeights);

  const myFastDeck = expandDeckForFastSim(deck, matched.cardBonusById);
  const oppFastDeck = expandDeckForFastSim(opp.representative, oppMatched.cardBonusById);
  const candidates = buildExplorationCandidates(matched.lexiconSeedWeights, `single1b:${deck.id}:${opp.id}`, EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats([opp.id], candidates.length);
  const seedBase = fnv1a32(`single1b-exp:${deck.id}:${opp.id}`);

  const useGpu = Boolean(gpuSim?.ready);
  const tExp0 = performance.now();
  let workersUsed = useGpu ? 0 : 1;

  if (useGpu) {
    gpuSim.uploadExploreContext({
      deck: myFastDeck,
      enemies: [{ id: opp.id, cards: oppFastDeck }],
      enemyWeightsList: [oppEliteWeights],
      candidates
    });
    const pairsPerOpp = Math.floor(DEEP_EXPLORE_GAMES / candidates.length);
    let pairSlice = 25000; // 25,000 * 40 = 1,000,000 games warm-up dispatch
    let lastTick = 0;
    for (let startPair = 0; startPair < pairsPerOpp; ) {
      if (signal?.aborted) return null;
      const countPairs = Math.min(pairSlice, pairsPerOpp - startPair);
      const dt0 = performance.now();
      const res = await gpuSim.runExplorePairSlice({
        nOpps: 1,
        nCands: candidates.length,
        gamesPerOpp: DEEP_EXPLORE_GAMES,
        startPair,
        pairCount: countPairs,
        seedBase,
        enemyIds: [opp.id]
      });
      const dtMs = Math.max(5, performance.now() - dt0);
      mergeExploreChunkStats(stats, res);
      startPair += countPairs;
      pairSlice = Math.max(10000, Math.min(500000, Math.round(countPairs * (240 / dtMs))));
      const now = performance.now();
      if (now - lastTick >= 100 || startPair >= pairsPerOpp) {
        lastTick = now;
        onProgress?.({
          phase: 'explore',
          done: stats.completed,
          total: DEEP_EXPLORE_GAMES,
          wins: stats.wins,
          gamesPerSec: stats.completed / Math.max(0.05, (now - tExp0) / 1000),
          mode: 'gpu',
          adapter: gpuSim.adapterName
        });
      }
    }
  } else {
    const exploreChunkSize = 500000;
    const exploreTasks = [];
    for (let start = 0; start < DEEP_EXPLORE_GAMES; start += exploreChunkSize) {
      exploreTasks.push({
        start,
        request: {
          op: 'explore_10m_chunk',
          deck: myFastDeck,
          enemies: [{ id: opp.id, cards: oppFastDeck }],
          candidates,
          enemy_weights: oppEliteWeights,
          enemy_weights_list: [oppEliteWeights],
          games_per_opponent: DEEP_EXPLORE_GAMES,
          start_game: start,
          count: Math.min(exploreChunkSize, DEEP_EXPLORE_GAMES - start),
          seed_base: seedBase
        }
      });
    }
    let lastTick = 0;
    workersUsed = await runFastTasks(exploreTasks, {
      fastSim,
      signal,
      onResult: (res) => {
        mergeExploreChunkStats(stats, res);
        const now = performance.now();
        if (now - lastTick >= 100 || stats.completed >= DEEP_EXPLORE_GAMES) {
          lastTick = now;
          onProgress?.({
            phase: 'explore',
            done: stats.completed,
            total: DEEP_EXPLORE_GAMES,
            wins: stats.wins,
            gamesPerSec: stats.completed / Math.max(0.05, (now - tExp0) / 1000),
            mode: 'cpu',
            workers: fastWorkerPool?.size || 1
          });
        }
      }
    });
  }
  if (signal?.aborted) return null;

  const strategy = synthesizeWinningStrategyFromStats(stats, baseWeights, candidates);
  const winningWeights = strategy.byOpponent[opp.id]?.weights || strategy.weights;

  // 第二階段：5,000,000 (5M) 局正式實測（先攻 2,500,000 + 後攻 2,500,000）
  const testCount = DEEP_GAMES_PER_OPPONENT;
  const seedPrefix = `single5m-test:${deck.id}`;
  const testSeedBase = fnv1a32(`${seedPrefix}:${opp.id}`);
  const agg = { total: 0, wins: 0, draws: 0, losses: 0, firstWins: 0, firstDraws: 0, firstLosses: 0, secondWins: 0, secondDraws: 0, secondLosses: 0, turnsSum: 0 };
  const tTest0 = performance.now();

  if (useGpu) {
    const res = await gpuSim.runTestOpponent({
      deck: myFastDeck,
      enemy: oppFastDeck,
      playerWeights: winningWeights,
      enemyWeights: oppEliteWeights,
      totalPerOpp: testCount,
      seedBase: testSeedBase,
      onBatch: (_delta, curAgg) => {
        if (signal?.aborted) return false;
        const elapsedSec = Math.max(0.05, (performance.now() - tTest0) / 1000);
        onProgress?.({
          phase: 'test',
          done: curAgg.total,
          total: testCount,
          gamesPerSec: curAgg.total / elapsedSec,
          mode: 'gpu',
          adapter: gpuSim.adapterName
        });
        return true;
      }
    });
    if (signal?.aborted || res.aborted) return null;
    Object.assign(agg, {
      total: res.total, wins: res.wins, draws: res.draws, losses: res.losses,
      firstWins: res.firstWins, firstDraws: res.firstDraws, firstLosses: res.firstLosses,
      secondWins: res.secondWins, secondDraws: res.secondDraws, secondLosses: res.secondLosses,
      turnsSum: res.turnsSum
    });
  } else {
    const testChunkSize = 50000;
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
          enemy_weights: oppEliteWeights,
          start_idx: start,
          count: Math.min(testChunkSize, testCount - start),
          total_per_opp: testCount,
          seed_base: testSeedBase
        }
      });
    }
    await runFastTasks(testTasks, {
      fastSim,
      signal,
      onResult: (res) => {
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
          mode: 'cpu',
          workers: workersUsed
        });
      }
    });
    if (signal?.aborted) return null;
  }

  return {
    opp,
    deck,
    baseWeights,
    oppEliteWeights,
    winningWeights,
    matched,
    strategy,
    agg,
    seedPrefix,
    testSeedBase,
    myFastDeck,
    oppFastDeck,
    mode: useGpu ? 'gpu' : 'cpu',
    adapterName: useGpu ? gpuSim.adapterName : '',
    workersUsed
  };
}

export function renderSingleOpponentDeepProgress({ opp, phase, done, total, wins, gamesPerSec, workers, mode, adapter }) {
  const pct = Math.min(100, (done / Math.max(1, total)) * 100).toFixed(1);
  const isExplore = phase === 'explore';
  const hwLabel = mode === 'gpu'
    ? `GPU 顯存加速${adapter ? `（${esc(adapter)}）` : ''}`
    : `${workers || 1} 核記憶體並行`;
  return `
    <div class="flow-modal">
      <div class="strategy-synth-banner is-running">
        <div class="strategy-synth-head">
          <div>
            <strong>${isExplore ? `第 1 階段 · 對陣「${esc(opp.name)}」10 億局探索` : `第 2 階段 · 500 萬局實測`}</strong>
            <p class="sub">${done.toLocaleString('zh-TW')} / ${total.toLocaleString('zh-TW')} 局（${pct}%）${isExplore && wins != null ? ` · 勝 ${wins.toLocaleString('zh-TW')}` : ''} · ${hwLabel} · <b>${Math.round(gamesPerSec || 0).toLocaleString('zh-TW')}</b> 局/秒</p>
          </div>
          <button class="btn btn-outline" type="button" data-action="cancel-single-deep">中止</button>
        </div>
        <div class="progress-track">
          <i style="width:${pct}%"></i>
        </div>
      </div>
    </div>
  `;
}

export function renderSingleOpponentDeepModal(deepResult, activeReplayIdx = 0) {
  const { opp, deck, baseWeights, oppEliteWeights, winningWeights, strategy, agg, seedPrefix, testSeedBase, myFastDeck, oppFastDeck } = deepResult;
  const testWr = agg.total ? ((agg.wins / agg.total) * 100).toFixed(2) + '%' : '—';
  const expWr = ((strategy.exploreWinRate || 0) * 100).toFixed(2) + '%';
  const deltaPct = agg.total
    ? ((agg.wins / agg.total - (strategy.exploreWinRate || 0)) * 100).toFixed(2)
    : '0.00';
  const topChips = (strategy.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip"><b>${esc(a.labelZh)}</b> <small>${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(3)}</small></span>`
  ).join('');

  // 10 個快速區段分頁（每頁 500 格，涵蓋先攻 1..2,500,000 與後攻 2,500,001..5,000,000，按需即時產生不佔記憶體）
  const pageSize = 500;
  const segmentStarts = [0, 500000, 1000000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000, 4500000];
  let pageStart = Math.floor(activeReplayIdx / pageSize) * pageSize;
  pageStart = Math.min(DEEP_GAMES_PER_OPPONENT - pageSize, Math.max(0, pageStart));

  const pageEvents = [];
  if (state.fastSimFn) {
    const sliceRes = state.fastSimFn({
      op: 'test_50k_chunk',
      deck: myFastDeck,
      enemy: oppFastDeck,
      opponent_id: opp.id,
      weights: winningWeights,
      enemy_weights: oppEliteWeights || baseWeights,
      start_idx: pageStart,
      count: pageSize,
      total_per_opp: DEEP_GAMES_PER_OPPONENT,
      seed_base: testSeedBase
    });
    for (let k = 0; k < sliceRes.outcomes.length; k++) {
      const idx = pageStart + k;
      const code = sliceRes.outcomes[k];
      pageEvents.push({
        opponentId: opp.id,
        index: idx,
        first: idx < DEEP_GAMES_PER_OPPONENT / 2 ? 0 : 1,
        outcome: code === 1 ? 'win' : code === 0 ? 'loss' : 'draw',
        turns: sliceRes.turns[k] || 0
      });
    }
  }

  const pageTabs = segmentStarts.map((s, p) => {
    const active = activeReplayIdx >= s && activeReplayIdx < s + 500000;
    const side = p < 5 ? '先' : '後';
    return `<button class="mini ${active ? 'is-active' : ''}" type="button" data-action="replay-single-deep" data-opp="${esc(opp.id)}" data-idx="${s}">${side} ${(s / 10000).toFixed(0)}萬+</button>`;
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
    customEnemyWeights: oppEliteWeights || baseWeights,
    customSeedPrefix: seedPrefix,
    customSeedBase: testSeedBase,
    customMyFastDeck: myFastDeck,
    customOppFastDeck: oppFastDeck,
    replayAction: 'replay-single-deep'
  });

  return `
    <div class="flow-modal">
      <div class="strategy-synth-banner is-complete">
        <div class="strategy-synth-head">
          <div>
            <strong>第 1 階段 · 10 億局探索（勝率 ${expWr}）</strong>
          </div>
          <span class="strategy-gain-pill ${Number(deltaPct) >= 0 ? 'is-pos' : 'is-neg'}">500 萬局實測 ${testWr}（${Number(deltaPct) >= 0 ? '+' : ''}${deltaPct}%）</span>
        </div>
        <div class="card-prior-chips">${topChips}</div>
      </div>

      <div class="flow-stage-card">
        <h3>第 2 階段 · 5,000,000 局實測（${agg.wins.toLocaleString('zh-TW')}勝 ${agg.draws.toLocaleString('zh-TW')}和 ${agg.losses.toLocaleString('zh-TW')}敗 · ${testWr} · CI ${interval(agg.wins, agg.total)}）</h3>
        <p class="sub">先攻 250 萬局 ${((agg.firstWins / Math.max(1, f1Total)) * 100).toFixed(2)}% · 後攻 250 萬局 ${((agg.secondWins / Math.max(1, f2Total)) * 100).toFixed(2)}% — 點擊任一格檢視回放：</p>
        <div class="deep-page-tabs">${pageTabs}</div>
        ${renderGameStrip(opp.id, pageEvents, true, pageSize, 'replay-single-deep', pageStart, pageSize, DEEP_GAMES_PER_OPPONENT)}
      </div>

      ${flowHtml}
    </div>
  `;
}

// 執行兩階段十億級真實勝率推演（WebGPU 顯存加速為主，多執行緒記憶體 WASM 為備援；前十對手均採千萬局互博最佳策略）：
// 第 1 階段：1,000,000,000 (1B) 局策略探索（10 對手 × 100,000,000 局）
// 第 2 階段：5,000,000 (5M) 局正式實測（10 對手 × 500,000 局，每對手先攻 250,000 + 後攻 250,000）
export async function executeBattleBatch({ run, deck, lineup, weights, onTick, signal }) {
  const { ready, fastSim, gpuSim, error } = await probeEngine();
  if (!ready) throw Error(error);

  const lexicon = await ensureStrategyLexicon();
  const enemyWeightsList = lineup.map((item) => getOpponentEliteWeights(item.entry.id, weights));
  const matched = matchDeckStrategies(deck, lineup, lexicon, weights);
  const myFastDeck = expandDeckForFastSim(deck, matched.cardBonusById);
  const oppCardBonusById = {};
  const fastEnemies = lineup.map((item, idx) => {
    const oppM = matchDeckStrategies(item.entry.representative, [], lexicon, enemyWeightsList[idx]);
    oppCardBonusById[item.entry.id] = oppM.cardBonusById;
    return {
      id: item.entry.id,
      cards: expandDeckForFastSim(item.entry.representative, oppM.cardBonusById)
    };
  });
  run.matchedStrategies = {
    totalLexiconCount: matched.totalLexiconCount,
    matchedCount: matched.matchedCount,
    cardMatchedCount: matched.cardMatchedCount,
    macroMatchedCount: matched.macroMatchedCount,
    cardBonusById: matched.cardBonusById,
    oppCardBonusById,
    topActiveStrategies: matched.topActiveStrategies,
    matchedIds: matched.matchedIds
  };
  const oppIds = fastEnemies.map((e) => e.id);
  const candidates = buildExplorationCandidates(
    matched.lexiconSeedWeights,
    `batch1b:${deck.id}:${run.season || 'C1'}`,
    EXPLORE_CANDIDATE_COUNT
  );

  if (!run.compactResults) run.compactResults = {};
  if (!run.exploreStats || run.exploreStats.byCandidate?.length !== candidates.length || run.exploreStats.byOpponent?.length !== oppIds.length) {
    run.exploreStats = createEmptyExploreStats(oppIds, candidates.length);
  }
  delete run.exploreEvents;

  const useGpu = Boolean(gpuSim?.ready);
  const exploreSeedBase = fnv1a32(`${run.runId}:exp1b`);

  // ============================================================================
  // 第一階段：1,000,000,000 (1B) 局策略探索
  // ============================================================================
  if ((run.exploreStats.completed || 0) < EXPLORE_TOTAL_GAMES) {
    const t0 = performance.now();
    const baseDone = run.exploreStats.completed || 0;
    let lastUiTick = 0;

    if (useGpu) {
      gpuSim.uploadExploreContext({
        deck: myFastDeck,
        enemies: fastEnemies,
        enemyWeightsList,
        candidates
      });
      const pairsPerOpp = Math.floor(EXPLORE_GAMES_PER_OPPONENT / candidates.length);
      let startPair = Number(run.exploreStats.nextPairStart || 0);
      let pairSlice = 2500; // 2,500 * 10 * 40 = 1,000,000 局熱身批次，隨後依顯卡速率動態調優
      let batchesSinceSave = 0;

      while (startPair < pairsPerOpp) {
        if (signal?.aborted) break;
        const countPairs = Math.min(pairSlice, pairsPerOpp - startPair);
        const dt0 = performance.now();
        const res = await gpuSim.runExplorePairSlice({
          nOpps: fastEnemies.length,
          nCands: candidates.length,
          gamesPerOpp: EXPLORE_GAMES_PER_OPPONENT,
          startPair,
          pairCount: countPairs,
          seedBase: exploreSeedBase,
          enemyIds: oppIds
        });
        const dtMs = Math.max(5, performance.now() - dt0);
        mergeExploreChunkStats(run.exploreStats, res);
        startPair += countPairs;
        run.exploreStats.nextPairStart = startPair;
        run.winningStrategy = synthesizeWinningStrategyFromStats(run.exploreStats, weights, candidates);
        pairSlice = Math.max(1000, Math.min(200000, Math.round(countPairs * (240 / dtMs))));

        const now = performance.now();
        const deltaGames = (run.exploreStats.completed || 0) - baseDone;
        run._livePerf = {
          mode: 'gpu',
          adapter: gpuSim.adapterName,
          gamesPerSec: deltaGames / Math.max(0.05, (now - t0) / 1000),
          phase: 'explore'
        };
        batchesSinceSave++;
        if (batchesSinceSave >= 8 || startPair >= pairsPerOpp) {
          batchesSinceSave = 0;
          await saveRunRecord(run);
        }
        if (now - lastUiTick >= 120 || startPair >= pairsPerOpp) {
          lastUiTick = now;
          onTick(run);
        }
      }
    } else {
      const completedChunks = new Set(run.exploreStats.completedChunks || []);
      const exploreChunkSize = 500000;
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
            enemy_weights_list: enemyWeightsList,
            games_per_opponent: EXPLORE_GAMES_PER_OPPONENT,
            start_game: start,
            count: Math.min(exploreChunkSize, EXPLORE_TOTAL_GAMES - start),
            seed_base: exploreSeedBase
          }
        });
      }
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
          run._livePerf = {
            mode: 'cpu',
            workers: fastWorkerPool?.size || 1,
            gamesPerSec: deltaGames / Math.max(0.05, (now - t0) / 1000),
            phase: 'explore'
          };
          if (chunksSinceSave >= 16 || run.exploreStats.completed >= EXPLORE_TOTAL_GAMES) {
            chunksSinceSave = 0;
            await saveRunRecord(run);
          }
          if (now - lastUiTick >= 120 || run.exploreStats.completed >= EXPLORE_TOTAL_GAMES) {
            lastUiTick = now;
            onTick(run);
          }
        }
      });
    }

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
  // 第二階段：5,000,000 (5M) 局正式實測（10 對手 × 500,000 局，每對手均用千萬局互博最佳策略）
  // ============================================================================
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const halfPerOpp = FIRST_SEAT_GAMES;
  const tTest0 = performance.now();
  let testDone = Object.values(run.compactResults).reduce((s, r) => s + (r?.total || 0), 0);
  const baseTestDone = testDone;
  let lastUiTick = 0;

  if (useGpu) {
    for (let o = 0; o < lineup.length; o++) {
      if (signal?.aborted) break;
      const opp = lineup[o].entry;
      const existing = run.compactResults[opp.id];
      if (existing && existing.total >= gamesPerOpp) continue;
      const oppStrategyWeights = run.winningStrategy?.byOpponent?.[opp.id]?.weights
        || run.winningStrategy?.weights
        || weights;
      const seedBase = fnv1a32(`${run.runId}:test5m:${opp.id}`);

      const res = await gpuSim.runTestOpponent({
        deck: myFastDeck,
        enemy: fastEnemies[o].cards,
        playerWeights: oppStrategyWeights,
        enemyWeights: enemyWeightsList[o],
        totalPerOpp: gamesPerOpp,
        seedBase,
        onBatch: (delta) => {
          if (signal?.aborted) return false;
          testDone += delta;
          const now = performance.now();
          run._livePerf = {
            mode: 'gpu',
            adapter: gpuSim.adapterName,
            gamesPerSec: (testDone - baseTestDone) / Math.max(0.05, (now - tTest0) / 1000),
            phase: 'test'
          };
          return true;
        }
      });
      if (signal?.aborted || res.aborted) break;

      run.compactResults[opp.id] = {
        total: res.total,
        wins: res.wins,
        draws: res.draws,
        losses: res.losses,
        firstWins: res.firstWins,
        firstDraws: res.firstDraws,
        firstLosses: res.firstLosses,
        secondWins: res.secondWins,
        secondDraws: res.secondDraws,
        secondLosses: res.secondLosses,
        turnsSum: res.turnsSum,
        sampleOutcomesStr: sampleArrayToStr(res.sampleOutcomes)
      };
      const now = performance.now();
      if (now - lastUiTick >= 80 || o === lineup.length - 1) {
        lastUiTick = now;
        onTick(run);
      }
    }
  } else {
    const testChunkSize = 50000;
    const testTasks = [];
    for (let o = 0; o < lineup.length; o++) {
      const opp = lineup[o].entry;
      const existing = run.compactResults[opp.id];
      if (existing && existing.total >= gamesPerOpp) continue;
      const oppStrategyWeights = run.winningStrategy?.byOpponent?.[opp.id]?.weights
        || run.winningStrategy?.weights
        || weights;
      const seedBase = fnv1a32(`${run.runId}:test5m:${opp.id}`);
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
            enemy_weights: enemyWeightsList[o],
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
              sample: new Uint8Array(500)
            };
            oppBuffers.set(oppId, buf);
          }
          const start = res.startIdx ?? task.start;
          const len = res.outcomes.length;
          if (start < 250) {
            const end1 = Math.min(250, start + len);
            for (let idx = start; idx < end1; idx++) buf.sample[idx] = res.outcomes[idx - start];
          }
          if (start + len > halfPerOpp && start < halfPerOpp + 250) {
            const s2 = Math.max(halfPerOpp, start);
            const e2 = Math.min(halfPerOpp + 250, start + len);
            for (let idx = s2; idx < e2; idx++) buf.sample[250 + (idx - halfPerOpp)] = res.outcomes[idx - start];
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
            sampleOutcomesStr: sampleArrayToStr(buf.sample)
          };
          testDone += res.completed;
          const now = performance.now();
          run._livePerf = {
            mode: 'cpu',
            workers: fastWorkerPool?.size || 1,
            gamesPerSec: (testDone - baseTestDone) / Math.max(0.05, (now - tTest0) / 1000),
            phase: 'test'
          };
          if (now - lastUiTick >= 100 || testDone >= TOTAL_BATCH_GAMES) {
            lastUiTick = now;
            onTick(run);
          }
        }
      });
    }
  }

  delete run._livePerf;
  await saveRunRecord(run);
  onTick(run);
  return run;
}

// 僅在 ?fixture=1 下用於 UI 樣式驗收的演示生成器（1B 探索 + 5M 實測緊湊格式）
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const oppIds = lineup.map((x) => x.entry.id);
  const baseW = Array(22).fill(0.5);
  const candidates = buildExplorationCandidates(baseW, 'fixture1b', EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats(oppIds, candidates.length);
  stats.completed = EXPLORE_TOTAL_GAMES;
  stats.wins = 485000000;
  stats.draws = 25000000;
  stats.losses = 490000000;
  stats.byCandidate.forEach((c, idx) => {
    c.games = 25000000;
    c.wins = 11500000 + (idx % 5) * 450000;
    c.draws = 625000;
    c.losses = c.games - c.wins - c.draws;
  });
  stats.byOpponent.forEach((o, idx) => {
    o.games = EXPLORE_GAMES_PER_OPPONENT;
    o.wins = 46000000 + (idx % 5) * 1800000;
    o.draws = 2500000;
    o.losses = o.games - o.wins - o.draws;
    o.byCandidate.forEach((bc, cIdx) => {
      bc.games = 2500000;
      bc.wins = 1150000 + (cIdx % 5) * 45000;
      bc.draws = 62500;
      bc.losses = bc.games - bc.wins - bc.draws;
    });
  });
  run.exploreStats = stats;
  run.winningStrategy = synthesizeWinningStrategyFromStats(stats, baseW, candidates);
  run.compactResults = {};
  for (const item of lineup) {
    if (signal.aborted) return run;
    const oppId = item.entry.id;
    let sampleStr = '';
    for (let i = 0; i < 500; i++) {
      const seed = fnv1a32(`preview:${run.runId}:${oppId}:${i}`);
      const r = (seed % 1000) / 1000;
      sampleStr += r < (i < 250 ? 0.54 : 0.49) ? 'W' : r < 0.96 ? 'L' : 'D';
    }
    const fw = 135000, fd = 10000, fl = 105000;
    const sw = 122500, sd = 10000, sl = 117500;
    run.compactResults[oppId] = {
      total: GAMES_PER_OPPONENT, wins: fw + sw, draws: fd + sd, losses: fl + sl,
      firstWins: fw, firstDraws: fd, firstLosses: fl,
      secondWins: sw, secondDraws: sd, secondLosses: sl,
      turnsSum: GAMES_PER_OPPONENT * 9,
      sampleOutcomesStr: sampleStr
    };
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}
