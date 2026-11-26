import {
  aggregate,
  buildExplorationCandidates,
  buildLegalReplacementCandidates,
  computeCompositeWinRate,
  computeCompositeWinRateFromCompact,
  createEmptyExploreStats,
  dampBlendWeights,
  DEEP_EXPLORE_GAMES,
  DEEP_GAMES_PER_OPPONENT,
  encodeCardForFastSim,
  energyNames,
  EXPLORE_CANDIDATE_COUNT,
  EXPLORE_GAMES_PER_OPPONENT,
  EXPLORE_TOTAL_GAMES,
  FIRST_SEAT_GAMES,
  GAMES_PER_OPPONENT,
  getCardV3Template,
  interval,
  isAndroidOrMobileEnv,
  isCardCompatibleWithDeck,
  isEngineImplementedStatus,
  lookupPairwiseStrategy,
  matchDeckStrategies,
  mergeExploreChunkStats,
  replaceDeckCardOnce,
  resolveModelSimProfile,
  synthesizeWinningStrategyFromStats,
  TOTAL_BATCH_GAMES,
  validOutcomes
} from './core.mjs';
import { cardPrimaryTypes, esc, renderCardImgTag, renderEnergyToken, renderPokemonSprites, resolveFeaturedPokemon } from './cardface.mjs';
import { ensurePairwiseStrategies, ensureStrategyLexicon, saveRunRecord, state } from './data.mjs';
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

// 探測加速引擎：桌面端啟用 WebGPU 顯存 + FastSim WASM + DeckGym；Android/行動端僅載入 165KB FastSim WASM（避免天璣/安卓15 WebView GPU 崩潰與冷啟動 OOM）
let engineProbePromise = null;
export async function probeEngine() {
  if (state.fastSimFn && state.engineReady) {
    return { ready: true, runtime: state.runtimeFn, fastSim: state.fastSimFn, gpuSim: state.gpuSim };
  }
  if (engineProbePromise) return engineProbePromise;
  engineProbePromise = (async () => {
    try {
      const mobile = isAndroidOrMobileEnv();
      const [fastModRes, fastWasmRes, gpuEngine] = await Promise.all([
        import('../battle/fastsim-runtime.mjs'),
        fetch('battle/fastsim.wasm'),
        mobile ? Promise.resolve(null) : probeWebGPU().catch(() => null)
      ]);
      if (!fastWasmRes.ok) throw Error(`未找到 fastsim.wasm (${fastWasmRes.status})`);
      const fastBytes = await fastWasmRes.arrayBuffer();
      const fastCompiled = await WebAssembly.compile(fastBytes);
      const fastFn = await fastModRes.instantiateFastSim(fastCompiled);

      state.fastSimModule = fastCompiled;
      state.fastSimFn = fastFn;
      state.fastSimReady = true;
      state.gpuSim = gpuEngine || null;
      state.gpuReady = Boolean(gpuEngine?.ready);
      state.gpuAdapterName = gpuEngine?.adapterName || '';
      state.engineReady = true;
      state.engineError = '';

      if (!mobile) {
        // 桌面端背景補充載入 DeckGym 覆蓋率引擎與詞條庫，不阻塞啟動
        Promise.all([import('../battle/runtime.mjs'), fetch('battle/deckgym.wasm')])
          .then(async ([modRes, wasmRes]) => {
            if (!wasmRes.ok) return;
            const bytes = await wasmRes.arrayBuffer();
            const compiled = await WebAssembly.compile(bytes);
            const fn = await modRes.instantiateBattle(compiled);
            state.wasmModule = compiled;
            state.wasmBytes = bytes;
            state.runtimeFn = fn;
          })
          .catch(() => null);
        ensureStrategyLexicon().catch(() => null);
        ensurePairwiseStrategies().catch(() => null);
      }
      return { ready: true, runtime: state.runtimeFn, fastSim: fastFn, gpuSim: state.gpuSim };
    } catch (err) {
      state.engineReady = false;
      state.engineError = `對戰模擬引擎尚未載入（${err?.message || 'WASM 初始化失敗'}）。`;
      return { ready: false, error: state.engineError };
    } finally {
      engineProbePromise = null;
    }
  })();
  return engineProbePromise;
}

// 多執行緒 FastSim Web Worker 並行池（行動端上限 4 核以節省記憶體、桌面端上限 16 核）
let fastWorkerPool = null;
let fastWorkerPoolPromise = null;

async function spawnFastWorkerPool() {
  if (typeof Worker === 'undefined') return null;
  const hw = Number(globalThis.navigator?.hardwareConcurrency || 4);
  const maxWorkers = isAndroidOrMobileEnv() ? 4 : 16;
  const count = Math.max(2, Math.min(maxWorkers, hw));
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

// 延遲載入完整規則對戰引擎（deckgym.wasm，僅在使用者啟動 AI 優化或桌面端背景載入時觸發，不影響行動端冷啟動）
let deckGymInitPromise = null;
export async function ensureDeckGymRuntime() {
  if (state.runtimeFn && state.wasmModule) return state.runtimeFn;
  if (deckGymInitPromise) return deckGymInitPromise;
  deckGymInitPromise = (async () => {
    const [modRes, wasmRes] = await Promise.all([
      import('../battle/runtime.mjs'),
      fetch('battle/deckgym.wasm')
    ]);
    if (!wasmRes.ok) throw Error(`無法載入完整規則對戰引擎 (${wasmRes.status})`);
    const bytes = await wasmRes.arrayBuffer();
    const compiled = await WebAssembly.compile(bytes);
    const fn = await modRes.instantiateBattle(compiled);
    state.wasmModule = compiled;
    state.wasmBytes = bytes;
    state.runtimeFn = fn;
    return fn;
  })().finally(() => {
    deckGymInitPromise = null;
  });
  return deckGymInitPromise;
}

// 多執行緒完整規則 Web Worker 並行池（行動端上限 4 核、桌面端上限 12 核）
let deckGymWorkerPool = null;
let deckGymWorkerPoolPromise = null;

async function spawnDeckGymWorkerPool() {
  if (typeof Worker === 'undefined') return null;
  const hw = Number(globalThis.navigator?.hardwareConcurrency || 4);
  const maxWorkers = isAndroidOrMobileEnv() ? 4 : 12;
  const count = Math.max(2, Math.min(maxWorkers, hw));
  const workerUrl = new URL('../battle/worker.mjs', import.meta.url);
  const wasmUrl = new URL('../battle/deckgym.wasm', import.meta.url).href;

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
      else reject(Error(ev.data.error || `DeckGym Worker #${idx} init failed`));
    };
    const onErr = (err) => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      reject(Error(err?.message || `DeckGym Worker #${idx} error`));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    try {
      if (state.wasmModule) {
        w.postMessage({ type: 'init', id, module: state.wasmModule });
      } else {
        w.postMessage({ type: 'init', id, wasmUrl });
      }
    } catch {
      w.postMessage({ type: 'init', id, wasmUrl });
    }
  });

  try {
    const initialized = await Promise.all(Array.from({ length: count }, (_, i) => initOne(i)));
    workers.push(...initialized);
  } catch (err) {
    for (const w of workers) {
      try { w.terminate(); } catch {}
    }
    console.warn('[battle] DeckGym worker pool fallback to main thread:', err?.message || err);
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
          w.postMessage({ type: 'run', id, request: task.request });
        };
        step();
      });

      await Promise.all(workers.map((w) => runOnWorker(w)));
      if (firstError) throw firstError;
    }
  };
}

async function getDeckGymWorkerPool() {
  if (deckGymWorkerPool) return deckGymWorkerPool;
  if (!deckGymWorkerPoolPromise) {
    deckGymWorkerPoolPromise = spawnDeckGymWorkerPool().then((pool) => {
      deckGymWorkerPool = pool;
      return pool;
    });
  }
  return deckGymWorkerPoolPromise;
}

async function runDeckGymTasks(tasks, { runtimeFn, signal, onResult }) {
  const pool = await getDeckGymWorkerPool();
  if (pool) {
    await pool.runTasks(tasks, { signal, onResult });
    return pool.size;
  }
  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) break;
    const res = runtimeFn(tasks[i].request);
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
    const enc = encodeCardForFastSim(card, bonus, state.cardsById);
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

// 精簡版策略詞條庫與啟用詞條橫幅（整合 13,500 單卡詞條 + 10,472,176 雙卡千局協同詞條）
function renderStrategyLexiconBanner(run, deck, lineup) {
  const idxDoc = state.strategyIndex;
  const pairTotal = state.pairwiseStrategies?.totalPairwiseEntries || idxDoc?.pairwiseEntries || 10472176;
  const singleTotal = state.strategyLexicon?.totalEntries || idxDoc?.singleCardEntries || 13500;
  const totalLex = idxDoc?.totalEntries || (singleTotal + pairTotal);
  const matched = run?.matchedStrategies
    || ((state.strategyLexicon || state.pairwiseStrategies) && deck
      ? matchDeckStrategies(deck, lineup, state.strategyLexicon, state.modelInfo?.weights || [], state.pairwiseStrategies, state.cardsById)
      : null);
  const activeCnt = matched?.matchedCount || 0;
  const pairActiveCnt = matched?.pairMatchedCount || 0;
  const topChips = (matched?.topActiveStrategies || []).slice(0, 6).map((s) =>
    `<span class="card-prior-chip" title="${esc(s.rule)}">
      <b>[${esc(s.catLabel)}] ${esc(s.title)}</b> <small>${(s.wr * 100).toFixed(1)}%</small>
    </span>`
  ).join('');

  return `
    <div class="lexicon-banner">
      <div class="strategy-synth-head">
        <div>
          <strong>策略詞條庫（${totalLex.toLocaleString('zh-TW')} 條${activeCnt > 0 ? ` · 本牌組啟用 ${activeCnt} 條${pairActiveCnt > 0 ? `（含 ${pairActiveCnt} 條雙卡協同）` : ''}` : ''}）</strong>
        </div>
        <button class="btn btn-outline" type="button" data-action="open-strategy-lexicon">瀏覽 1,048 萬詞條庫</button>
      </div>
      ${topChips ? `<div class="card-prior-chips">${topChips}</div>` : ''}
    </div>
  `;
}

function queryLivePairwiseEntries({ pairwiseDb, cardsList = [], cardsById = new Map(), deck = null, activePairs = [], q = '' }) {
  if (!pairwiseDb?.matrix) return [];
  const raw = String(q || '').trim();
  const norm = (s) => String(s || '').toLowerCase();

  // 1. 若輸入包含空白或「+ / ×」，視為雙卡即時查表（從 10,472,176 條二進位矩陣 O(1) 檢索）
  const parts = raw ? raw.split(/[\s+×xX,，、]+/).filter(Boolean) : [];
  if (parts.length >= 2) {
    const findMatches = (term) => {
      const t = norm(term);
      const out = [];
      const seen = new Set();
      for (const c of cardsList) {
        if (!c?.id) continue;
        const hit = norm(c.id).includes(t) || norm(c.name).includes(t) || norm(c.nameEn).includes(t);
        if (hit) {
          const lk = c.limitName || c.name;
          if (!seen.has(lk)) {
            seen.add(lk);
            out.push(c);
            if (out.length >= 8) break;
          }
        }
      }
      return out;
    };
    const listA = findMatches(parts[0]);
    const listB = findMatches(parts[1]);
    const rows = [];
    const seenPair = new Set();
    for (const a of listA) {
      for (const b of listB) {
        const ps = lookupPairwiseStrategy(pairwiseDb, a.id, b.id, cardsById);
        if (!ps || seenPair.has(ps.id)) continue;
        seenPair.add(ps.id);
        rows.push(ps);
        if (rows.length >= 40) break;
      }
      if (rows.length >= 40) break;
    }
    return rows.sort((a, b) => (b.delta * 2 + b.wr) - (a.delta * 2 + a.wr));
  }

  // 2. 單詞搜尋：先匹配牌組內雙卡與熱門雙卡，再從全卡庫即時生成該卡與牌組／環境核心卡的實測配對
  if (parts.length === 1) {
    const t = norm(parts[0]);
    const out = [];
    const seen = new Set();
    for (const ps of activePairs) {
      if (norm(ps.title).includes(t) || norm(ps.cardA).includes(t) || norm(ps.cardB).includes(t) || norm(ps.rule).includes(t)) {
        seen.add(ps.id);
        out.push(ps);
      }
    }
    const anchor = cardsList.find((c) => norm(c.id) === t || norm(c.name) === t)
      || cardsList.find((c) => norm(c.name).includes(t) || norm(c.id).includes(t) || norm(c.nameEn).includes(t));
    if (anchor) {
      const partnerIds = [];
      for (const item of deck?.cards || []) {
        if (item?.id && !partnerIds.includes(item.id)) partnerIds.push(item.id);
      }
      for (const tc of pairwiseDb.meta?.topDiscoveredCombos || []) {
        if (tc.cardA && !partnerIds.includes(tc.cardA)) partnerIds.push(tc.cardA);
        if (tc.cardB && !partnerIds.includes(tc.cardB)) partnerIds.push(tc.cardB);
        if (partnerIds.length >= 48) break;
      }
      for (const pid of partnerIds) {
        const ps = lookupPairwiseStrategy(pairwiseDb, anchor.id, pid, cardsById);
        if (!ps || seen.has(ps.id)) continue;
        seen.add(ps.id);
        out.push(ps);
        if (out.length >= 40) break;
      }
    }
    return out.sort((a, b) => (b.delta * 2 + b.wr) - (a.delta * 2 + a.wr));
  }

  // 3. 無搜尋詞：優先呈現目前牌組啟用的雙卡協同，並接續全卡庫前 50 強雙卡實測組合
  const merged = [...activePairs];
  const seen = new Set(merged.map((x) => x.id));
  for (const tc of pairwiseDb.meta?.topDiscoveredCombos || []) {
    const ps = lookupPairwiseStrategy(pairwiseDb, tc.cardA, tc.cardB, cardsById);
    if (!ps || seen.has(ps.id)) continue;
    seen.add(ps.id);
    merged.push(ps);
  }
  return merged;
}

// 10,485,676 條策略詞條互動檢索彈窗（13,500 單卡詞條 + 10,472,176 全卡兩兩千局實測協同詞條）
export function buildStrategyLexiconModal({ lexicon, pairwiseDb = null, indexDoc, matchedIdSet = null, activePairs = [], deck = null, q = '', cat = 'all', onlyMatched = false, page = 1 }) {
  if (!lexicon?.entries?.length && !pairwiseDb?.matrix) {
    return `<div class="empty-box is-dashed">正在載入 1,048 萬條策略詞條庫…</div>`;
  }
  const cats = lexicon?.cats || [];
  const catLabels = lexicon?.catLabelsZh || {};
  const srcs = lexicon?.srcs || [];
  const needle = String(q || '').trim().toLowerCase();
  const singleTotal = lexicon?.entries?.length || 13500;
  const pairTotal = pairwiseDb?.totalPairwiseEntries || indexDoc?.pairwiseEntries || 10472176;
  const grandTotal = singleTotal + pairTotal;

  const isPairMode = cat === 'pairwise_synergy';

  const catPills = [
    `<button class="mini ${cat === 'all' && !onlyMatched ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="all" data-matched="0">單卡與環境 (${singleTotal.toLocaleString('zh-TW')})</button>`,
    `<button class="mini ${isPairMode ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="pairwise_synergy" data-matched="0">全卡兩兩千局協同 (${pairTotal.toLocaleString('zh-TW')})</button>`,
    (matchedIdSet?.size || activePairs?.length)
      ? `<button class="mini ${onlyMatched ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="all" data-matched="1">本牌組啟用 (${(matchedIdSet?.size || 0) + (activePairs?.length || 0)})</button>`
      : '',
    ...cats.map((cid, i) => {
      const cnt = indexDoc?.categories?.[i]?.count ?? '';
      return `<button class="mini ${cat === cid && !onlyMatched ? 'is-active' : ''}" type="button" data-action="strategy-lex-filter" data-cat="${esc(cid)}" data-matched="0">${esc(catLabels[cid] || cid)}${cnt ? ` (${cnt.toLocaleString('zh-TW')})` : ''}</button>`;
    })
  ].join('');

  const guidesHtml = (indexDoc?.webGuides || []).map((g) =>
    `<li><b>${esc(g.title)}</b>（${esc(g.site)}）— ${esc(g.focus)}</li>`
  ).join('');

  let rowsHtml = '';
  let totalFiltered = 0;
  let curPage = 1;
  let totalPages = 1;

  if (isPairMode) {
    const pairRows = queryLivePairwiseEntries({
      pairwiseDb,
      cardsList: state.cards || [],
      cardsById: state.cardsById,
      deck,
      activePairs,
      q
    });
    const perPage = 40;
    totalFiltered = pairRows.length;
    totalPages = Math.max(1, Math.ceil(totalFiltered / perPage));
    curPage = Math.min(Math.max(1, page), totalPages);
    const slice = pairRows.slice((curPage - 1) * perPage, curPage * perPage);
    rowsHtml = slice.map((ps) => `
      <tr>
        <td><code>${esc(ps.cardA)} × ${esc(ps.cardB)}</code>${activePairs.some((a) => a.id === ps.id) ? ' <span class="pill-sub">本牌組</span>' : ''}</td>
        <td><span class="lex-cat-tag">${esc(ps.archetypeLabel)}</span></td>
        <td><b>${esc(ps.title)}</b><div class="sub">${esc(ps.rule)}</div><small class="muted">來源：全卡庫 4,577 卡兩兩配對 1,000 局 GPU 實測（共 10,472,176 條雙卡詞條）</small></td>
        <td class="num">${Number(ps.games).toLocaleString('zh-TW')} 局</td>
        <td class="num"><strong>${(Number(ps.wr) * 100).toFixed(1)}%</strong><br><small>${Number(ps.delta) >= 0 ? '+' : ''}${(Number(ps.delta) * 100).toFixed(1)}%</small></td>
      </tr>
    `).join('');
  } else {
    let list = lexicon?.entries || [];
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
    totalFiltered = list.length;
    totalPages = Math.max(1, Math.ceil(totalFiltered / perPage));
    curPage = Math.min(Math.max(1, page), totalPages);
    const slice = list.slice((curPage - 1) * perPage, curPage * perPage);
    const pairPrefixRows = (onlyMatched && curPage === 1 && !needle && activePairs.length > 0)
      ? activePairs.slice(0, 12).map((ps) => `
        <tr>
          <td><code>${esc(ps.cardA)} × ${esc(ps.cardB)}</code> <span class="pill-sub">雙卡已啟用</span></td>
          <td><span class="lex-cat-tag">${esc(ps.archetypeLabel)}</span></td>
          <td><b>${esc(ps.title)}</b><div class="sub">${esc(ps.rule)}</div><small class="muted">來源：全卡兩兩千局實測雙卡協同詞條庫（10,472,176 條）</small></td>
          <td class="num">${Number(ps.games).toLocaleString('zh-TW')} 局</td>
          <td class="num"><strong>${(Number(ps.wr) * 100).toFixed(1)}%</strong><br><small>${Number(ps.delta) >= 0 ? '+' : ''}${(Number(ps.delta) * 100).toFixed(1)}%</small></td>
        </tr>
      `).join('')
      : '';
    rowsHtml = pairPrefixRows + slice.map((r) => `
      <tr>
        <td><code>${esc(r[0])}</code>${matchedIdSet?.has(r[0]) ? ' <span class="pill-sub">已啟用</span>' : ''}</td>
        <td><span class="lex-cat-tag">${esc(catLabels[cats[r[1]]] || cats[r[1]])}</span></td>
        <td><b>${esc(r[4])}</b><div class="sub">${esc(r[5])}</div><small class="muted">來源：${esc(srcs[r[9]] || '')}</small></td>
        <td class="num">${Number(r[6]).toLocaleString('zh-TW')} 局</td>
        <td class="num"><strong>${(Number(r[7]) * 100).toFixed(1)}%</strong><br><small>${Number(r[8]) >= 0 ? '+' : ''}${(Number(r[8]) * 100).toFixed(1)}%</small></td>
      </tr>
    `).join('');
  }

  return `
    <div class="flow-modal">
      <div class="lex-toolbar">
        <input id="lex-search-input" class="deck-name-input" type="search" value="${esc(q)}" placeholder="${isPairMode ? '輸入兩張卡名即時查詢千局配對（例：噴火龍 莉莉艾、水君 戟脊龍）…' : '搜尋寶可夢名、卡號（如 B1a-014）、娜姿、赤日、大斗蓬、神奇糖果…'}" autocomplete="off">
        <div class="deep-page-tabs">${catPills}</div>
      </div>

      ${guidesHtml ? `
        <details class="strategy-weights-details">
          <summary>展開檢視策略來源（含 32.9 億局全卡兩兩千局實測 + 5 份頂尖競技攻略）</summary>
          <ul class="lex-guide-list">
            <li><b>全卡庫 4,577 張卡牌兩兩配對千局實測（10,472,176 條雙卡協同詞條）</b> — 涵蓋全部 3,293,461 組獨立功能卡對 × 1,000 局（32.93 億局實戰），即時查表並注入勝率模擬權重。</li>
            ${guidesHtml}
          </ul>
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
        <span class="pager-num">第 ${curPage} / ${totalPages} 頁 · 顯示 ${totalFiltered.toLocaleString('zh-TW')} 條（總詞條庫 ${grandTotal.toLocaleString('zh-TW')} 條）</span>
        <button class="btn btn-outline" type="button" data-action="strategy-lex-page" data-page="${curPage + 1}" ${curPage >= totalPages ? 'disabled' : ''}>下一頁</button>
      </div>
    </div>
  `;
}

function renderWinningStrategyBanner(run, summary) {
  const profile = resolveModelSimProfile(run);
  if (summary?.complete) return '';

  if (profile.mode === 'gtg') {
    const doneOpps = Number(run?.gtgMeta?.opponentsDone || 0);
    const totalOpps = Math.max(1, Number(run?.gtgMeta?.totalOpponents || 10));
    const curRound = Number(run?.gtgMeta?.currentRound || 0);
    const subFrac = Math.max(0, Math.min(0.99, Number(run?.gtgMeta?.currentOppFrac || 0)));
    const pct = Math.min(99.9, ((doneOpps + subFrac) / totalOpps) * 100).toFixed(1);
    const roundText = curRound > 0 ? ` · 第 ${curRound} 次迭代` : '';
    return `
      <div class="strategy-synth-banner is-running">
        <div class="strategy-synth-head">
          <strong>正在分析對戰勝率（已完成 ${doneOpps} / ${totalOpps} 組對手${roundText} · ${pct}%）…</strong>
        </div>
        <div class="progress-track is-slim">
          <i style="width:${pct}%"></i>
        </div>
      </div>
    `;
  }

  const ws = run.winningStrategy || null;
  const expCount = run.exploreStats?.completed ?? ws?.exploreTotal ?? 0;
  const expTarget = profile.exploreTotalGames;
  const totalTarget = profile.totalBatchGames;
  const testDone = summary?.total || 0;

  if (expCount < expTarget) {
    const expPct = Math.min(100, (expCount / Math.max(1, expTarget)) * 100).toFixed(1);
    return `
      <div class="strategy-synth-banner is-running">
        <div class="strategy-synth-head">
          <strong>正在分析對戰模擬（${expPct}%）…</strong>
        </div>
        <div class="progress-track is-slim">
          <i style="width:${expPct}%"></i>
        </div>
      </div>
    `;
  }

  if (testDone < totalTarget) {
    const testPct = Math.min(100, (testDone / Math.max(1, totalTarget)) * 100).toFixed(1);
    return `
      <div class="strategy-synth-banner is-running">
        <div class="strategy-synth-head">
          <strong>正在彙整各對陣勝率（${testPct}%）…</strong>
        </div>
        <div class="progress-track is-slim">
          <i style="width:${testPct}%"></i>
        </div>
      </div>
    `;
  }
  return '';
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
  const profile = resolveModelSimProfile(run);
  const gamesPerOpp = Number(run?.gamesPerOppActual) || profile.gamesPerOpponent;
  const firstSeatPerOpp = Math.floor(gamesPerOpp / 2);
  const totalTarget = lineup.length * gamesPerOpp;
  const halfTotalTarget = lineup.length * firstSeatPerOpp;
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

    const oppGtgRounds = Number(run?.gtgMeta?.byOpponent?.[opp.id]?.rounds || 0);

    rowsHtml += `
      <div class="battle-row" data-opp-row="${esc(opp.id)}">
        <div class="battle-opp-info">
          <div class="battle-opp-head">
            <span class="rank-num">#${item.rank}</span>
            ${item.isSubstitute ? `<span class="pill-sub">遞補 #${item.rank}</span>` : ''}
            ${oppGtgRounds > 0 ? `<span class="pill-sub">迭代 ${oppGtgRounds} 次</span>` : ''}
            <span class="tokens-inline">${tokens}</span>
            ${oppSprites}
            <strong class="battle-opp-name">${esc(opp.name)}</strong>
          </div>
          <div class="battle-opp-meta">
            <span>環境佔比 ${metaShare}</span>
            <span>賽事勝率 ${metaRate}</span>
            <span>先攻 ${f1Pct}</span>
            <span>後攻 ${f2Pct}</span>
            ${oppGtgRounds > 0 ? `<span>迭代 ${oppGtgRounds} 次</span>` : ''}
          </div>
          <div class="battle-opp-actions">
            ${!run.isDemo && options.canReplay ? `<button class="mini" type="button" data-action="run-single-opponent-deep" data-opp="${esc(opp.id)}">單獨深度測試</button>` : ''}
            ${aggAll.total > 0 && options.canReplay ? `<button class="mini" type="button" data-action="replay-game" data-opp="${esc(opp.id)}" data-idx="0">檢視對局回放</button>` : ''}
          </div>
        </div>
        <div class="battle-strip-col">
          ${renderGameStrip(opp.id, stripEvents, Boolean(options.canReplay), 500, 'replay-game', 0, 500, gamesPerOpp, hasCompact ? firstSeatPerOpp : 250)}
        </div>
        <div class="battle-opp-stat">
          <strong class="num-lg">${winPct}</strong>
          <span>${aggAll.wins.toLocaleString('zh-TW')}勝 ${aggAll.draws.toLocaleString('zh-TW')}和 ${aggAll.losses.toLocaleString('zh-TW')}敗</span>
        </div>
      </div>
    `;
  }

  const gtgOppRecords = Object.values(run?.gtgMeta?.byOpponent || {}).filter((x) => x?.done);
  const gtgTotalRounds = gtgOppRecords.reduce((s, x) => s + Number(x.rounds || 0), 0);
  const gtgRoundSummary = profile.mode === 'gtg' && gtgTotalRounds > 0
    ? ` · 累計迭代 ${gtgTotalRounds} 次（平均 ${(gtgTotalRounds / Math.max(1, gtgOppRecords.length)).toFixed(1)} 次/組）`
    : '';

  return `
    <div class="report-shell ${run.isDemo ? 'is-demo' : ''}">
      ${run.isDemo ? '<div class="status-note is-warn">預覽模式展示點陣。</div>' : ''}
      ${subCount > 0 ? `<div class="status-note">含 ${subCount} 個遞補對手。</div>` : ''}
      ${renderWinningStrategyBanner(run, summary)}
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">${summary.complete ? '綜合實戰勝率' : '勝率模擬中…'}</span>
          <strong class="report-kpi-num">${overallRate}</strong>
          <span class="report-kpi-ci">共 ${summary.total.toLocaleString('zh-TW')} 局${gtgRoundSummary} · ${esc(profile.label || '')}</span>
        </div>
        <div class="report-totals">
          <div class="tot-box is-win"><b>${summary.wins.toLocaleString('zh-TW')}</b><span>勝</span></div>
          <div class="tot-box is-draw"><b>${summary.draws.toLocaleString('zh-TW')}</b><span>和</span></div>
          <div class="tot-box is-loss"><b>${summary.losses.toLocaleString('zh-TW')}</b><span>敗</span></div>
        </div>
      </div>
      <div class="composite-kpi-grid" aria-label="模擬綜合勝率指標">
        <div class="comp-card is-accent">
          <span class="comp-label">環境加權勝率</span>
          <strong class="comp-val">${weightedRate}</strong>
          <small class="comp-sub">依前十熱門佔比（${(summary.top10TotalShare * 100).toFixed(1)}%）計算</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">先攻勝率</span>
          <strong class="comp-val">${firstRate}</strong>
          <small class="comp-sub">${summary.first.wins.toLocaleString('zh-TW')}勝 ${summary.first.draws.toLocaleString('zh-TW')}和 ${summary.first.losses.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">後攻勝率</span>
          <strong class="comp-val">${secondRate}</strong>
          <small class="comp-sub">${summary.second.wins.toLocaleString('zh-TW')}勝 ${summary.second.draws.toLocaleString('zh-TW')}和 ${summary.second.losses.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">優劣勢與平均回合</span>
          <strong class="comp-val is-sm">${avgTurnsText}</strong>
          <small class="comp-sub">優勢：${esc(bestText)}<br>劣勢：${esc(worstText)}</small>
        </div>
      </div>
      ${!summary.complete ? `<div class="progress-track"><i style="width:${Math.min(100, (summary.total / Math.max(1, totalTarget)) * 100).toFixed(1)}%"></i></div>` : ''}
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
      return step.aux1 === 2
        ? `競技場效果：從牌庫抽取 1 張卡牌（「${cName}」）`
        : `從牌庫抽取 1 張卡牌（「${cName}」）`;
    case 4:
      return `將「${cName}」放置於${slotLabelZh(step.aux1)}`;
    case 5: {
      const trig = step.aux2;
      const trigMap = {
        1: '，觸發進化特性（為戰鬥場額外附著 1 顆能量）',
        2: '，觸發進化特性（從牌庫抽出 2 張卡）',
        3: '，觸發進化特性（從牌庫召喚同類分身至備戰區）',
        4: '，觸發進化特性（對對手戰鬥場造成傷害）',
        5: '，觸發進化特性（重洗對手手牌）',
        6: '，觸發進化特性（對對手場上寶可夢造成傷害）',
        7: '，觸發進化特性（恢復己方寶可夢體力）',
        8: '，觸發進化特性（對對手戰鬥場施加異常狀態）',
        9: '，觸發進化特性（破壞對手能量）',
        10: '，觸發進化特性（將對手戰鬥寶可夢強制替換）'
      };
      return `將${slotLabelZh(step.aux1)}的寶可夢進化為「${cName}」${trigMap[trig] || ''}`;
    }
    case 6: {
      const tk = step.aux1;
      const val = step.aux2;
      const tpl = getCardV3Template(card?.id);
      const sub = tpl ? ((tpl[19] >>> 8) & 0xff) : 0;
      if (tk === 1) {
        if (sub === 2) return `施放物品卡「${cName}」（從牌庫檢索 1 張基礎寶可夢加入手牌）`;
        if (sub === 3) return `施放支援者卡「${cName}」（重洗手牌並抽出與對手相同張數）`;
        if (sub === 4) return `施放支援者卡「${cName}」（雙方重洗手牌並抽回原張數）`;
        if (sub === 5) return `施放訓練家卡「${cName}」（與牌庫交換寶可夢卡）`;
        if (sub === 6) return `施放支援者卡「${cName}」（檢索最多 2 張體力 50 以下的基礎寶可夢）`;
        if (sub === 7) return `施放支援者卡「${cName}」（從牌庫檢索 1 張 2 階進化寶可夢）`;
        if (sub === 8) return `施放支援者卡「${cName}」（從牌庫檢索 1 張超級進化寶可夢ex）`;
        if (sub === 9) return `施放支援者卡「${cName}」（檢視牌庫上方並選擇 1 張加入手牌）`;
        if (sub === 10 || sub === 11) return `施放訓練家卡「${cName}」（擲硬幣檢索物品／道具卡）`;
        if (sub === 12) return `施放支援者卡「${cName}」（依場上超級進化數量抽卡）`;
        if (sub === 13) return `施放訓練家卡「${cName}」（從牌庫檢索競技場卡加入手牌）`;
        if (sub >= 14 && sub <= 19) return `施放訓練家卡「${cName}」（檢索指定卡牌加入手牌）`;
        if (sub === 20) return `施放訓練家卡「${cName}」（從棄牌區回收寶可夢加入手牌）`;
        if (sub === 21) return `施放物品卡「${cName}」（複製對手牌庫 1 張物品卡）`;
        if (sub === 22) return `施放物品卡「${cName}」（將 2 張手牌洗回牌庫並抽 1 張卡）`;
        return `施放訓練家卡「${cName}」（從牌庫抽出 ${Math.max(1, Math.min(3, val || 1))} 張卡牌）`;
      }
      if (tk === 2) {
        if (sub === 3) return `施放恢復卡「${cName}」（為所有附有水能量的寶可夢各恢復 40 點體力）`;
        if (sub === 6) return `施放物品卡「${cName}」（解除戰鬥場全部異常狀態）`;
        if (sub === 7) return `施放物品卡「${cName}」（恢復戰鬥場 10 點體力並解除異常狀態）`;
        if (sub === 8) return `施放物品卡「${cName}」（恢復戰鬥場 20 點體力，正面時放回手牌）`;
        if (sub === 9) return `施放物品卡「${cName}」（擲硬幣恢復戰鬥場 ${Math.max(0, val)} 點體力）`;
        if (sub === 12) return `施放支援者卡「${cName}」（完全恢復體力並棄置全部能量）`;
        if (sub === 15) return `施放物品卡「${cName}」（為伊布進化型恢復體力或強化招式傷害 +10）`;
        if (sub === 16) return `施放支援者卡「${cName}」（將己方受傷點數最多 40 點轉移至對手戰鬥場）`;
        const h = Math.max(10, val & 0xff);
        return `施放恢復卡「${cName}」（恢復 ${h} 點體力${sub === 5 || sub === 13 ? '並解除異常狀態' : ''}）`;
      }
      if (tk === 3) {
        if (sub === 1) return `施放干擾卡「${cName}」（對手將戰鬥寶可夢與備戰互換）`;
        if (sub === 2) return `施放干擾卡「${cName}」（拉出對手受傷的備戰寶可夢至戰鬥場）`;
        if (sub === 3) return `施放干擾卡「${cName}」（指定對手備戰寶可夢換上戰鬥場）`;
        if (sub === 4) return `施放物品卡「${cName}」（驅離對手戰鬥場的基礎寶可夢）`;
        if (sub === 5) return `施放干擾卡「${cName}」（對手重洗手牌並改抽 3 張）`;
        if (sub === 6) return `施放干擾卡「${cName}」（對手重洗手牌並依剩餘所需分數抽牌）`;
        if (sub === 7) return `施放物品卡「${cName}」（壓縮對手手牌至 4 張）`;
        if (sub === 8) return `施放支援者卡「${cName}」（將對手手牌 1 張支援者放回牌庫）`;
        if (sub === 9) return `施放干擾卡「${cName}」（將對手隨機 1 張手牌放回牌庫）`;
        if (sub === 10) return `施放干擾卡「${cName}」（丟棄場上寶可夢道具）`;
        if (sub === 11) return `施放物品卡「${cName}」（移除場上道具或競技場）`;
        if (sub === 12 || sub === 13 || sub === 14) return `施放干擾卡「${cName}」（破壞對手寶可夢能量）`;
        if (sub === 15) return `施放干擾卡「${cName}」（令戰鬥寶可夢混亂）`;
        if (sub === 16) return `施放物品卡「${cName}」（增加對手撤退費用）`;
        if (sub === 17 || sub === 18) return `施放干擾卡「${cName}」（強制將對手基礎寶可夢放上備戰區）`;
        if (sub === 19) return `施放干擾卡「${cName}」（移動對手能量至戰鬥場）`;
        if (sub === 20) return `施放支援者卡「${cName}」（將己方戰鬥寶可夢收回並替補上場）`;
        return `施放干擾卡「${cName}」`;
      }
      if (tk === 4) {
        if (sub === 10) return `施放支援者卡「${cName}」（本回合下一次擲硬幣必定正面）`;
        if (sub === 11) return `施放支援者卡「${cName}」（本回合擊倒對手戰鬥寶可夢額外多拿 1 分）`;
        if (sub === 12) return `施放支援者卡「${cName}」（下回合若被擊倒以剩餘 10 體力存活）`;
        if (sub === 13) return `施放支援者卡「${cName}」（龍星群額外增加命中次數）`;
        if (sub >= 6 && sub <= 9) return `施放防禦卡「${cName}」（下回合受到招式傷害 -${val || 20}）`;
        if (sub === 2 || sub === 3) return `施放增傷卡「${cName}」（本回合對寶可夢ex 招式傷害 +${val || 20}）`;
        return `施放增傷卡「${cName}」（本回合招式傷害 +${val || 10}）`;
      }
      if (tk === 5) {
        const toolDesc = {
          1: '最大體力 +20',
          2: '草屬性最大體力 +30',
          3: '1 階進化最大體力 +30',
          4: '古代寶可夢最大體力 +40',
          5: '受擊反彈 20 點傷害',
          6: '受擊令攻擊者中毒',
          7: '基礎寶可夢撤退費用 -1',
          8: '水屬性撤退費用 -1',
          9: '2 階進化撤退費用 -2',
          10: '基礎寶可夢受招式傷害 -20',
          11: '高撤退費用寶可夢受傷害 -20',
          12: '鋼屬性受傷害 -10 並防禦異常狀態',
          13: '鋼屬性下回合受傷害 -50',
          14: '備戰區免疫對手招式與特性傷害',
          15: '防禦對手招式附加效果',
          16: '未來寶可夢招式傷害 +20',
          17: '皮卡丘ex 招式傷害 +30',
          18: '究極異獸依已得分數提升傷害',
          19: '惡屬性回合結束對對手造成 10 點傷害',
          20: '回合結束恢復 10 點體力',
          21: '體力低於一半時恢復 30 點體力',
          22: '自動解除異常狀態',
          23: '昏厥時補牌至 5 張',
          24: '擊倒對手時抽 1 張卡',
          25: '昏厥時轉移最多 2 顆雷能量至備戰區',
          26: '受擊時令對手隨機洗回 1 張手牌',
          27: '昏厥時將寶可夢收回手牌'
        };
        return `裝備寶可夢道具「${cName}」（${toolDesc[val] || '裝備生效'}）`;
      }
      if (tk === 6) {
        if (sub === 1) return `施放「${cName}」（基礎寶可夢跳過 1 階直接進化為 2 階）`;
        if (sub === 2) return `施放「${cName}」（直接從牌庫進化寶可夢）`;
        if (sub === 3) return `施放「${cName}」（本回合撤退費用 -${val || 1}）`;
        if (sub === 4) return `施放支援者卡「${cName}」（免費將戰鬥寶可夢與備戰互換）`;
        if (sub === 5) return `施放支援者卡「${cName}」（擲硬幣獲得 ${Math.max(0, val)} 顆水能量）`;
        if (sub === 13) return `施放支援者卡「${cName}」（附著 2 顆火能量並結束回合）`;
        if (sub === 14 || sub === 15) return `施放「${cName}」（將備戰區能量轉移至戰鬥場）`;
        if (sub === 16) return `施放支援者卡「${cName}」（本回合指定寶可夢招式能耗 -2）`;
        return `施放充能卡「${cName}」（額外補充能量）`;
      }
      if (tk === 7) {
        const stadDesc = {
          1: '可重抽能量區能量',
          2: '雙方 1 階進化招式傷害 +10',
          3: '雙方基礎寶可夢最大體力 +20',
          4: '雙方無色寶可夢撤退費用 -2',
          5: '雙方鬥屬性對寶可夢ex 傷害 +20',
          6: '非超級進化弱點傷害改為 2 倍',
          7: '雙方回合結束為附有能量的寶可夢恢復 20 點體力',
          8: '雙方回合結束手牌補至 3 張',
          9: '雙方每回合額外檢索 1 張寶可夢',
          10: '雙方每回合額外檢索 1 張基礎草寶可夢',
          11: '超能量附著時強化效果',
          12: '雙方手牌與檢索場地生效',
          13: '場地效果生效',
          14: '場地效果生效'
        };
        return `展開競技場卡「${cName}」（${stadDesc[val] || '場地生效'}）`;
      }
      return `施放訓練家卡「${cName}」`;
    }
    case 7: {
      const abName = card?.abilities?.[0]?.name ? `「${card.abilities[0].name}」` : '';
      const abOp = step.aux2 & 0xff;
      const abVal = (step.aux2 >> 8) & 0xff;
      let det = '';
      if (abOp === 2) det = '（檢索 1 張寶可夢加入手牌）';
      else if (abOp === 3) {
        if (abVal === 4) det = '（為自身額外充能 1 顆並結束回合）';
        else if (abVal === 3) det = '（自身充能 2 顆並承受 30 點傷害）';
        else if (abVal === 2) det = '（自身充能 1 顆並承受 20 點傷害）';
        else det = '（為自身額外充能 1 顆）';
      } else if (abOp === 4) det = '（為戰鬥場額外充能 1 顆）';
      else if (abOp === 6) det = `（換上戰鬥場並吸收場上 ${abVal} 顆能量）`;
      else if (abOp === 7) det = '（強制對手更換戰鬥寶可夢）';
      else if (abOp === 8) det = `（狙擊對手寶可夢造成 ${abVal} 點傷害）`;
      else if (abOp === 9) det = `（附能觸發，對對手戰鬥場造成 ${abVal} 點傷害）`;
      else if (abOp === 12) det = '（棄置 1 顆能量，本回合招式傷害 +50）';
      else if (abOp === 14 || abOp === 15) det = `（恢復 ${abVal || 20} 點體力）`;
      else if (abOp === 16) det = (abVal >= 2 && abVal <= 4) ? '（轉移場上能量）' : '（免費與備戰寶可夢互換）';
      else if (abOp === 19) {
        if (abVal >= 1 && abVal <= 5) det = '（強制替換對手戰鬥寶可夢）';
        else if (abVal >= 6 && abVal <= 10 || abVal === 19) det = '（補充手牌／檢索卡牌）';
        else if (abVal === 11 || abVal === 14) det = '（令對手戰鬥寶可夢中毒）';
        else if (abVal === 12) det = '（令對手戰鬥寶可夢灼傷）';
        else if (abVal === 13) det = '（令對手戰鬥寶可夢睡眠）';
        else if (abVal === 15) det = '（令對手戰鬥寶可夢混亂）';
        else if (abVal === 16) det = '（令對手戰鬥寶可夢陷入異常狀態）';
        else if (abVal === 17) det = '（棄置對手牌庫頂 1 張卡）';
        else if (abVal === 18) det = '（破壞對手戰鬥場寶可夢道具）';
      } else if (abOp === 22) det = `（電磁牆觸發，對附能目標造成 ${abVal} 點傷害）`;
      return `發動${slotLabelZh(step.aux1)}「${cName}」的特性${abName}${det}`;
    }
    case 8:
      return `從能量區為${slotLabelZh(step.aux1)}「${cName}」附著 1 顆能量（目前 ${step.aux2} 顆）`;
    case 9: {
      const newCard = step.aux2 >= 0 && step.aux2 < actorCards.length ? actorCards[step.aux2] : null;
      const newName = newCard?.name || `${slotLabelZh(step.aux1)}寶可夢`;
      return `戰鬥場「${cName}」撤退，換上${slotLabelZh(step.aux1)}「${newName}」`;
    }
    case 10: {
      const weakBonus = step.aux2 & 0x3f;
      const ko = (step.aux2 >> 6) & 1;
      const atkIdx = (step.aux2 >> 7) & 1;
      const missed = (step.aux2 >> 8) & 1;
      const effTag = (step.aux2 >> 9) & 0x3f;
      const effNum = (step.aux2 >> 15) & 0x3ff;
      const atkObj = card?.attacks?.[atkIdx] || card?.attacks?.[0];
      const atkName = atkObj?.name ? `「${atkObj.name}」` : '招式';

      if (missed) {
        if (effTag === 27) return `「${cName}」因混亂擲硬幣為反面，招式${atkName}發動失敗`;
        if (effTag === 28) return `「${cName}」受干擾擲硬幣為反面，招式${atkName}發動失敗`;
        if (effTag === 29) return `「${cName}」發動招式${atkName}，但傷害被對手護盾／特性無效化`;
        return `「${cName}」發動招式${atkName}擲硬幣為反面，招式失敗`;
      }

      const notes = [];
      if (weakBonus > 0) notes.push('屬性弱點 +20');
      if (effTag === 1) notes.push('令對手中毒');
      else if (effTag === 2) notes.push('令對手灼傷');
      else if (effTag === 3) notes.push('令對手睡眠');
      else if (effTag === 4) notes.push('令對手麻痺');
      else if (effTag === 5) notes.push('令對手混亂');
      else if (effTag === 6) notes.push(`同時波及對手場上／備戰造成 ${effNum} 點傷害`);
      else if (effTag === 7) notes.push(`自身承受 ${effNum} 點反作用傷害`);
      else if (effTag === 8 && effNum > 0) notes.push(`棄置自身 ${effNum} 顆能量`);
      else if (effTag === 9 && effNum > 0) notes.push(`恢復自身 ${effNum} 點體力`);
      else if (effTag === 10 && effNum > 0) notes.push(`額外附著 ${effNum} 顆能量`);
      else if (effTag === 11) notes.push(effNum === 99 ? '下回合免疫招式傷害' : `獲得下回合防護／反擊效果 (${effNum})`);
      else if (effTag === 12) notes.push(effNum === 99 ? '下回合對手出招須擲硬幣判定' : effNum === 98 ? '下回合對手無法攻擊' : `降低對手下回合攻擊傷害 -${effNum}`);
      else if (effTag === 13) notes.push('攻擊後換回備戰區');
      else if (effTag === 14) notes.push('下回合對手無法撤退');
      else if (effTag === 15) notes.push('強制對手更換戰鬥寶可夢');
      else if (effTag === 16) notes.push('封鎖對手下回合使用物品卡');
      else if (effTag === 17) notes.push('棄置對手手牌 1 張支援者卡');
      else if (effTag === 18) notes.push('封鎖對手下回合使用支援者卡');
      else if (effTag === 19 && effNum > 0) notes.push(`破壞對手 ${effNum} 顆能量`);
      else if (effTag === 20) notes.push('補充手牌／備戰');
      else if (effTag === 21) notes.push('下回合自身無法使用招式');
      else if (effTag === 22) notes.push('破壞對手寶可夢道具');
      else if (effTag === 23) notes.push('干擾對手牌面／手牌');
      else if (effTag === 24) notes.push(`擲硬幣正面 ${effNum} 次`);
      else if (effTag === 25) notes.push('觸發特殊擊倒／減半效果');
      else if (effTag === 26 && effNum > 0) notes.push(`遭對手反擊承受 ${effNum} 點傷害`);
      if (ko) notes.push('擊倒對手戰鬥場寶可夢！');

      const dmgPart = step.aux1 > 0 ? `造成 ${step.aux1} 點傷害` : '觸發追加效果';
      return `「${cName}」發動招式${atkName}，${dmgPart}${notes.length ? `（${notes.join('；')}）` : ''}`;
    }
    case 11:
      return '結束回合';
    case 12: {
      const reason = step.aux2 & 0xf;
      const ko = (step.aux2 >> 4) & 1;
      const cured = (step.aux2 >> 5) & 1;
      const side = playerSideZh(step.actor);
      if (reason === 1) return `回合間檢查：${side}戰鬥場「${cName}」因中毒受到 ${step.aux1} 點傷害${ko ? '並昏厥！' : ''}`;
      if (reason === 2) return `回合間檢查：${side}戰鬥場「${cName}」因灼傷受到 20 點傷害${ko ? '並昏厥！' : cured ? '（硬幣正面，灼傷解除）' : '（持續灼傷）'}`;
      if (reason === 3) return `回合間檢查：${side}戰鬥場「${cName}」睡眠判定${cured ? '為正面，甦醒了！' : '為反面，仍在睡眠中'}`;
      if (reason === 4) return `回合結束：${side}戰鬥場「${cName}」的麻痺狀態解除`;
      if (reason === 5) return `回合結束：道具「耍詐針」對${side}戰鬥場「${cName}」造成 10 點傷害${ko ? '並昏厥！' : ''}`;
      if (reason === 6) return `回合間檢查：特性「夢魘」對睡眠中的${side}「${cName}」造成 ${step.aux1} 點傷害${ko ? '並昏厥！' : ''}`;
      if (reason === 7) return `回合間檢查：特性「冰雪場地」對${side}戰鬥場「${cName}」造成 10 點傷害${ko ? '並昏厥！' : ''}`;
      if (reason === 8) return `回合結束：${side}戰鬥場「${cName}」恢復 ${step.aux1} 點體力`;
      if (reason === 9) return `回合結束：「${cName}」觸發特性抽 1 張卡`;
      if (reason === 10) return `首回合結束：「${cName}」觸發特性額外附著 1 顆能量`;
      return `回合間檢查：${side}戰鬥場「${cName}」受到 ${step.aux1} 點傷害${ko ? '並昏厥！' : ''}`;
    }
    default:
      return '執行對局動作';
  }
}

function formatFastBoardSide(side, deckCards20) {
  if (!side || side.cardIdx < 0) return '空場（等待替補）';
  const card = deckCards20[side.cardIdx];
  const name = card?.name || '寶可夢';
  const toolId = side.tool & 0xff;
  const stMask = (side.tool >> 8) & 0xff;
  const toolNames = {
    1: '大斗篷', 2: '葉子斗篷', 3: '優雅斗篷', 4: '驅勁古代',
    5: '凹凸頭盔', 6: '毒針', 7: '小氣球', 8: '水上小艇', 9: '充氣浮圈',
    10: '進化奇石', 11: '重磅頭盔', 12: '鋼鐵圍裙', 13: '金屬核心護盾',
    14: '防護斗篷', 15: '淨化面紗', 16: '驅勁未來', 17: '電氣球',
    18: '異獸結晶', 19: '耍詐針', 20: '吃剩的東西', 21: '文柚果',
    22: '木子果', 23: '幸運蛋', 24: '幸運連指手套', 25: '導電線',
    26: '暗黑吊墜', 27: '救援圍巾'
  };
  const toolTag = toolNames[toolId] ? `·${toolNames[toolId]}` : '';
  const stList = [];
  if (stMask & 0x43) stList.push('中毒');
  if (stMask & 0x04) stList.push('灼傷');
  if (stMask & 0x88) stList.push('睡眠');
  if (stMask & 0x10) stList.push('麻痺');
  if (stMask & 0x20) stList.push('混亂');
  const stTag = stList.length ? `·${stList.join('/')}` : '';
  return `<b>${esc(name)}</b>（體力 ${side.hp}/${side.maxHp} · ${side.energy}能${toolTag}${stTag} · 備戰 ${side.bench} 隻 · 手牌 ${side.hand} 張 · 牌庫 ${side.deck} 張）`;
}

export function buildFullGameFlowModal({
  opp,
  oppId,
  idx,
  run,
  deck,
  weights,
  customSimProfile = null,
  customGamesPerOpp = null,
  customWeights = null,
  customEnemyWeights = null,
  customSeedPrefix = null,
  customSeedBase = null,
  customMyFastDeck = null,
  customOppFastDeck = null,
  replayAction = 'replay-game'
}) {
  const profile = resolveModelSimProfile(customSimProfile || run);
  const gamesPerOpp = customGamesPerOpp || Number(run?.gamesPerOppActual) || profile.gamesPerOpponent;
  const half = Math.floor(gamesPerOpp / 2);
  const testSeedTag = profile.id === '1m5q' ? 'test5q' : 'test5m';
  const seedBase = customSeedBase ?? run?.testSeedBaseByOpp?.[oppId] ?? (
    customSeedPrefix
      ? fnv1a32(`${customSeedPrefix}:${oppId}`)
      : fnv1a32(`${run?.runId || 'demo'}:${testSeedTag}:${oppId}`)
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
          <span>第 <b>${(idx + 1).toLocaleString('zh-TW')}</b> / ${gamesPerOpp.toLocaleString('zh-TW')} 局 · ${esc(sideText)}</span>
        </div>
        <p class="desc">對戰模擬載入中，暫無法重播此局。</p>
      </div>
    `;
  }

  const playerWeights = customWeights
    || run?.winningStrategy?.byOpponent?.[oppId]?.weights
    || run?.winningStrategy?.weights
    || weights;
  const enemyWeights = customEnemyWeights
    || run?.convergedEnemyWeights?.[oppId]
    || getOpponentEliteWeights(oppId, weights);
  const hasOppElite = Boolean(state.top10Elite?.teams?.[oppId]);

  let myBonus = run?.matchedStrategies?.myCardBonusByOpp?.[oppId] || run?.matchedStrategies?.cardBonusById || null;
  let oppBonus = run?.matchedStrategies?.oppCardBonusById?.[oppId] || null;
  if (!myBonus && (state.strategyLexicon || state.pairwiseStrategies)) {
    myBonus = matchDeckStrategies(deck, [{ rank: 1, entry: opp }], state.strategyLexicon, weights, state.pairwiseStrategies, state.cardsById).cardBonusById;
  }
  if (!oppBonus && (state.strategyLexicon || state.pairwiseStrategies)) {
    oppBonus = matchDeckStrategies(opp.representative, [], state.strategyLexicon, enemyWeights, state.pairwiseStrategies, state.cardsById).cardBonusById;
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
      ? '<span class="flow-actor is-me">我方</span>'
      : '<span class="flow-actor is-opp">對手</span>';
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
          <span>共 ${tSteps.length} 步 · 回合結束比數 ${endPts}</span>
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
          <span>共 <b>${replayRes.turns || 0}</b> 回合</span>
        </div>
        <div class="flow-nav-btns">
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${prevIdx}">◀ 上一局</button>
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${nextIdx}">下一局 ▶</button>
        </div>
      </div>

      <div class="flow-stage-card">
        <h3>對局資訊</h3>
        <p class="sub">我方：<b>${esc(deck.name)}</b>（${esc(translateEnergyListZh(deck.energy))}）　對陣　對手：<b>${esc(opp.name)}</b>（${esc(translateEnergyListZh(opp.representative.energy))}）</p>
      </div>

      <div class="flow-stage-card">
        <h3>開局準備</h3>
        ${setupHtml}
      </div>

      <div class="flow-stage-card">
        <h3>逐回合對戰過程（第 1 回合 → 第 ${replayRes.turns || 0} 回合）</h3>
        <div class="flow-turns-scroll">${turnsHtml || '<p class="sub">無回合紀錄</p>'}</div>
      </div>

      <div class="flow-stage-card is-end">
        <h3>終局結果</h3>
        <p class="sub"><b>${esc(outcomeLabel)}</b> · 最終得分 <b>${esc(finalPts)}</b></p>
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

// 比對兩副牌組是否完全相同（忽略排序，精準比對卡號與張數）
export function areDecksIdentical(deckA, deckB) {
  const mapA = new Map();
  const mapB = new Map();
  for (const item of deckA?.cards || []) {
    if (!item?.id || !item.count) continue;
    mapA.set(item.id, (mapA.get(item.id) || 0) + Number(item.count));
  }
  for (const item of deckB?.cards || []) {
    if (!item?.id || !item.count) continue;
    mapB.set(item.id, (mapB.get(item.id) || 0) + Number(item.count));
  }
  if (mapA.size === 0 || mapA.size !== mapB.size) return false;
  for (const [id, cnt] of mapA) {
    if (mapB.get(id) !== cnt) return false;
  }
  return true;
}

// 計算兩副 20 張牌組相異的卡牌張數（0 代表完全相同的鏡像）
export function countDeckDifferences(deckA, deckB) {
  const mapA = new Map();
  const mapB = new Map();
  for (const item of deckA?.cards || []) {
    if (!item?.id || !item.count) continue;
    mapA.set(item.id, (mapA.get(item.id) || 0) + Number(item.count));
  }
  for (const item of deckB?.cards || []) {
    if (!item?.id || !item.count) continue;
    mapB.set(item.id, (mapB.get(item.id) || 0) + Number(item.count));
  }
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);
  let diffSum = 0;
  for (const id of allIds) {
    diffSum += Math.abs((mapA.get(id) || 0) - (mapB.get(id) || 0));
  }
  return Math.ceil(diffSum / 2);
}

// ============================================================================
// GTG 精英輕量模型：對單一對手進行雙邊同步 1M 局對弈迭代，直到勝率變化 < 0.1% 收斂
// ============================================================================
export async function runGtgDuelConvergence({
  opp,
  myFastDeck,
  oppFastDeck,
  initPlayerWeights,
  initEnemyWeights,
  symmetricMirror = false,
  roundGames = 1000000,
  evalGames = 20000,
  candCount = 20,
  tol = 0.001,
  maxRounds = 12,
  seedPrefix = 'gtg',
  fastSim,
  gpuSim = null,
  signal = null,
  onRoundProgress = null
}) {
  const useGpu = Boolean(gpuSim?.ready);
  const halfRoundGames = Math.max(candCount * 2, Math.floor(roundGames / 2)); // 500,000 + 500,000 = 1,000,000 局/輪
  const evalSeedBase = fnv1a32(`${seedPrefix}:eval:${opp.id}`);

  // 輔助：在固定同隨機種子（CRN）下，以 (wPlayer, wEnemy) 實測 evalGames 局並回傳勝率與前 500 局樣本點陣
  async function evalHeadToHead(wPlayer, wEnemy) {
    if (useGpu) {
      const res = await gpuSim.runTestOpponent({
        deck: myFastDeck,
        enemy: oppFastDeck,
        playerWeights: wPlayer,
        enemyWeights: wEnemy,
        totalPerOpp: evalGames,
        seedBase: evalSeedBase
      });
      if (signal?.aborted || res?.aborted) return null;
      return {
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
        sampleOutcomesStr: sampleArrayToStr(res.sampleOutcomes),
        winRate: res.total ? res.wins / res.total : 0
      };
    }

    const halfEval = Math.floor(evalGames / 2);
    const chunkSize = Math.min(5000, Math.max(500, Math.floor(evalGames / 8)));
    const tasks = [];
    for (let start = 0; start < evalGames; start += chunkSize) {
      tasks.push({
        start,
        request: {
          op: 'test_50k_chunk',
          deck: myFastDeck,
          enemy: oppFastDeck,
          opponent_id: opp.id,
          weights: wPlayer,
          enemy_weights: wEnemy,
          start_idx: start,
          count: Math.min(chunkSize, evalGames - start),
          total_per_opp: evalGames,
          seed_base: evalSeedBase
        }
      });
    }
    const agg = {
      total: 0, wins: 0, draws: 0, losses: 0,
      firstWins: 0, firstDraws: 0, firstLosses: 0,
      secondWins: 0, secondDraws: 0, secondLosses: 0,
      turnsSum: 0
    };
    const sampleArr = new Uint8Array(500);
    await runFastTasks(tasks, {
      fastSim,
      signal,
      onResult: (res, task) => {
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
        for (let k = 0; k < res.outcomes.length; k++) {
          const gi = task.start + k;
          if (gi < 250) sampleArr[gi] = res.outcomes[k];
          else if (gi >= halfEval && gi < halfEval + 250) sampleArr[250 + (gi - halfEval)] = res.outcomes[k];
        }
      }
    });
    if (signal?.aborted) return null;
    return {
      ...agg,
      sampleOutcomesStr: sampleArrayToStr(sampleArr),
      winRate: agg.total ? agg.wins / agg.total : 0
    };
  }

  // 輔助：快速同種子配對驗證單側候選策略對抗凍結對手的真實勝率（嚴格防止學歪或退步）
  async function scoreSideAgainstFrozen(sideDeck, foeDeck, candW, frozenFoeW, checkSeedBase) {
    const checkGames = useGpu ? 2000 : Math.min(1000, evalGames);
    if (useGpu) {
      const res = await gpuSim.runTestOpponent({
        deck: sideDeck,
        enemy: foeDeck,
        playerWeights: candW,
        enemyWeights: frozenFoeW,
        totalPerOpp: checkGames,
        seedBase: checkSeedBase
      });
      if (signal?.aborted || res?.aborted) return null;
      return res.total ? (res.wins + 0.5 * res.draws) / res.total : 0;
    }
    const res = fastSim({
      op: 'test_50k_chunk',
      deck: sideDeck,
      enemy: foeDeck,
      opponent_id: opp.id,
      weights: candW,
      enemy_weights: frozenFoeW,
      start_idx: 0,
      count: checkGames,
      total_per_opp: checkGames,
      seed_base: checkSeedBase
    });
    return res.completed ? (res.wins + 0.5 * res.draws) / res.completed : 0;
  }

  // 輔助：單側從 500,000 局對弈中學習己方獲勝局並提煉新策略（含單調最佳回應保護，確保對面與我方絕不退步）
  async function learnOneSide(sideDeck, foeDeck, baseW, frozenFoeW, cands, seedLabel, sideId, alpha) {
    const stats = createEmptyExploreStats([sideId], cands.length);
    const seedBase = fnv1a32(seedLabel);
    if (useGpu) {
      gpuSim.uploadExploreContext({
        deck: sideDeck,
        enemies: [{ id: sideId, cards: foeDeck }],
        enemyWeightsList: [frozenFoeW],
        candidates: cands
      });
      const pairsPerOpp = Math.floor(halfRoundGames / cands.length);
      let pairSlice = Math.min(25000, pairsPerOpp);
      for (let startPair = 0; startPair < pairsPerOpp; ) {
        if (signal?.aborted) return null;
        const countPairs = Math.min(pairSlice, pairsPerOpp - startPair);
        const res = await gpuSim.runExplorePairSlice({
          nOpps: 1,
          nCands: cands.length,
          gamesPerOpp: halfRoundGames,
          startPair,
          pairCount: countPairs,
          seedBase,
          enemyIds: [sideId]
        });
        mergeExploreChunkStats(stats, res);
        startPair += countPairs;
      }
    } else {
      const chunkSize = Math.min(100000, Math.max(20000, Math.floor(halfRoundGames / 12)));
      const tasks = [];
      for (let start = 0; start < halfRoundGames; start += chunkSize) {
        tasks.push({
          start,
          request: {
            op: 'explore_10m_chunk',
            deck: sideDeck,
            enemies: [{ id: sideId, cards: foeDeck }],
            candidates: cands,
            enemy_weights: frozenFoeW,
            enemy_weights_list: [frozenFoeW],
            games_per_opponent: halfRoundGames,
            start_game: start,
            count: Math.min(chunkSize, halfRoundGames - start),
            seed_base: seedBase
          }
        });
      }
      await runFastTasks(tasks, {
        fastSim,
        signal,
        onResult: (res) => { mergeExploreChunkStats(stats, res); }
      });
      if (signal?.aborted) return null;
    }

    // 找出本輪 50 萬局中勝率最高的單一候選策略 + 勝局綜合提煉策略，再與原策略做同種子實測擇優
    const byC = stats.byCandidate || [];
    let bestCid = 0;
    let bestSr = -1;
    for (let i = 0; i < byC.length; i++) {
      const g = byC[i]?.games || 0;
      if (g <= 0) continue;
      const sr = ((byC[i].wins || 0) + 0.5 * (byC[i].draws || 0)) / g;
      if (sr > bestSr) { bestSr = sr; bestCid = i; }
    }
    const synth = synthesizeWinningStrategyFromStats(stats, baseW, cands);
    const rawSynthW = synth.byOpponent?.[sideId]?.weights || synth.weights;
    const blendedSynthW = dampBlendWeights(baseW, rawSynthW, alpha);
    const blendedBestW = bestCid > 0 ? dampBlendWeights(baseW, cands[bestCid], Math.min(0.85, alpha + 0.15)) : baseW;

    const checkSeed = fnv1a32(`${seedLabel}:guard`);
    const srBase = await scoreSideAgainstFrozen(sideDeck, foeDeck, baseW, frozenFoeW, checkSeed);
    if (srBase == null || signal?.aborted) return null;
    const srSynth = await scoreSideAgainstFrozen(sideDeck, foeDeck, blendedSynthW, frozenFoeW, checkSeed);
    if (srSynth == null || signal?.aborted) return null;
    let chosenW = srSynth > srBase ? blendedSynthW : baseW;
    let chosenSr = Math.max(srBase, srSynth);

    if (bestCid > 0) {
      const srBest = await scoreSideAgainstFrozen(sideDeck, foeDeck, blendedBestW, frozenFoeW, checkSeed);
      if (srBest == null || signal?.aborted) return null;
      if (srBest > chosenSr) {
        chosenW = blendedBestW;
        chosenSr = srBest;
      }
      const srPureBest = await scoreSideAgainstFrozen(sideDeck, foeDeck, cands[bestCid], frozenFoeW, checkSeed);
      if (srPureBest == null || signal?.aborted) return null;
      if (srPureBest > chosenSr) {
        chosenW = cands[bestCid];
        chosenSr = srPureBest;
      }
    }
    return { weights: chosenW, improved: chosenSr > srBase, gain: chosenSr - srBase };
  }

  let wP = [...initPlayerWeights];
  let wE = symmetricMirror ? [...initPlayerWeights] : [...initEnemyWeights];

  // 第 0 輪基準勝率（初始專屬策略對陣）
  let prevEval = await evalHeadToHead(wP, wE);
  if (!prevEval || signal?.aborted) return null;
  let prevWr = prevEval.winRate;
  const makeHistEntry = (round, ev, delta, gamesThisRound, playerGain, enemyGain) => ({
    round,
    winRate: ev.winRate,
    oppWinRate: ev.total ? ev.losses / ev.total : 0,
    drawRate: ev.total ? ev.draws / ev.total : 0,
    scoreRate: ev.total ? (ev.wins + 0.5 * ev.draws) / ev.total : 0,
    delta,
    gamesThisRound,
    playerGain,
    enemyGain
  });
  const history = [makeHistEntry(0, prevEval, null, 0, 0, 0)];
  let converged = false;
  let totalCoEvoGames = 0;

  onRoundProgress?.({
    round: 0,
    maxRounds,
    winRate: prevWr,
    oppWinRate: history[0].oppWinRate,
    delta: null,
    frac: 0.08,
    history: [...history]
  });

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) return null;
    const radiusScale = Math.max(0.18, Math.pow(0.78, round - 1));
    const alpha = Math.max(0.32, 0.62 * Math.pow(0.88, round - 1));

    let resP;
    let resE;
    if (symmetricMirror) {
      // 完全相同牌組（鏡像對局）：雙方以同一套對稱候選集合同步學習，數學上嚴格保持 wP === wE，杜絕隨機種子偏斜
      const mCands = buildExplorationCandidates(wP, `${seedPrefix}:m:${opp.id}:r${round}`, candCount, radiusScale);
      resP = await learnOneSide(myFastDeck, oppFastDeck, wP, wE, mCands, `${seedPrefix}:gm:${opp.id}:r${round}`, opp.id, alpha);
      if (!resP || signal?.aborted) return null;
      resE = { weights: [...resP.weights], improved: resP.improved, gain: resP.gain };
      totalCoEvoGames += halfRoundGames * 2;
      onRoundProgress?.({
        round,
        maxRounds,
        winRate: prevWr,
        oppWinRate: history[history.length - 1].oppWinRate,
        delta: null,
        frac: Math.min(0.95, (round - 0.3) / Math.max(3, Math.min(maxRounds, 6))),
        history: [...history]
      });
    } else {
      const pCands = buildExplorationCandidates(wP, `${seedPrefix}:p:${opp.id}:r${round}`, candCount, radiusScale);
      const eCands = buildExplorationCandidates(wE, `${seedPrefix}:e:${opp.id}:r${round}`, candCount, radiusScale);

      // 雙邊同步基於「本輪開始前的凍結策略」各自對弈 50 萬局（合計 100 萬局/輪），同時學習各自獲勝局並單調擇優
      resP = await learnOneSide(myFastDeck, oppFastDeck, wP, wE, pCands, `${seedPrefix}:gp:${opp.id}:r${round}`, opp.id, alpha);
      if (!resP || signal?.aborted) return null;
      onRoundProgress?.({
        round,
        maxRounds,
        winRate: prevWr,
        oppWinRate: history[history.length - 1].oppWinRate,
        delta: null,
        frac: Math.min(0.95, (round - 0.5) / Math.max(3, Math.min(maxRounds, 6))),
        history: [...history]
      });

      resE = await learnOneSide(oppFastDeck, myFastDeck, wE, wP, eCands, `${seedPrefix}:ge:${opp.id}:r${round}`, `player:${opp.id}`, alpha);
      if (!resE || signal?.aborted) return null;
      totalCoEvoGames += halfRoundGames * 2;
    }

    // 雙方同時採用驗證更強的新策略
    wP = resP.weights;
    wE = resE.weights;

    // 以新策略同種子實測本輪勝率，並計算與上次勝率之差
    const curEval = await evalHeadToHead(wP, wE);
    if (!curEval || signal?.aborted) return null;
    const curWr = curEval.winRate;
    const delta = Math.abs(curWr - prevWr);
    const entry = makeHistEntry(round, curEval, delta, halfRoundGames * 2, resP.gain, resE.gain);
    history.push(entry);

    prevEval = curEval;
    prevWr = curWr;
    onRoundProgress?.({
      round,
      maxRounds,
      winRate: curWr,
      oppWinRate: entry.oppWinRate,
      delta,
      frac: Math.min(0.98, round / Math.max(3, Math.min(maxRounds, 6))),
      history: [...history]
    });

    // 至少完成 2 輪雙邊博弈迭代（避免第 1 輪雙方同步大幅加分互相抵銷造成偽收斂），
    // 或當雙方均無法再找到任何更優策略時即判定達均衡收斂
    const bothSettled = !resP.improved && !resE.improved;
    if ((round >= 2 && delta < tol) || bothSettled) {
      converged = true;
      break;
    }
  }

  return {
    converged,
    rounds: history.length - 1,
    totalCoEvoGames,
    finalEval: prevEval,
    finalPlayerWeights: wP,
    finalEnemyWeights: wE,
    evalSeedBase,
    history
  };
}

// 自己的兩副牌組之間進行 GTG 雙邊同步博弈互打（對稱起跑、各自學習、直到勝率差 < 0.1% 收斂）
export async function executeCustomDeckGtgDuel({
  deckA,
  deckB,
  baseWeights,
  simProfile = null,
  onProgress = null,
  signal = null
}) {
  const { ready, fastSim, gpuSim, error } = await probeEngine();
  if (!ready) throw Error(error);

  const profile = resolveModelSimProfile(simProfile || { id: 'gtg-elite-lite' });
  const [lexicon, pairwiseDb] = await Promise.all([
    ensureStrategyLexicon(),
    ensurePairwiseStrategies()
  ]);

  const isMirror = areDecksIdentical(deckA, deckB);
  const diffCount = countDeckDifferences(deckA, deckB);

  // 雙邊採用完全一致的起始基準策略，確保兩副自訂牌組絕對公平對弈
  const matchedA = matchDeckStrategies(deckA, [], lexicon, baseWeights, pairwiseDb, state.cardsById);
  const matchedB = isMirror
    ? matchedA
    : matchDeckStrategies(deckB, [], lexicon, baseWeights, pairwiseDb, state.cardsById);

  const myFastDeck = expandDeckForFastSim(deckA, matchedA.cardBonusById);
  const oppFastDeck = expandDeckForFastSim(deckB, matchedB.cardBonusById);
  const useGpu = Boolean(gpuSim?.ready);
  const evalGames = useGpu
    ? (profile.evalGamesPerOpponent || 20000)
    : (profile.evalGamesPerOpponentCpu || 5000);
  const roundGames = useGpu
    ? (profile.roundGamesPerOpponent || 1000000)
    : Math.min(profile.roundGamesPerOpponent || 1000000, 160000);

  const oppWrapper = {
    id: deckB.id,
    name: deckB.name,
    representative: {
      cards: deckB.cards,
      energy: deckB.energy || [],
      featuredPokemon: deckB.featuredPokemon || []
    }
  };
  const seedPrefix = `custom-gtg:${deckA.id}:${deckB.id}`;

  const gtg = await runGtgDuelConvergence({
    opp: oppWrapper,
    myFastDeck,
    oppFastDeck,
    initPlayerWeights: matchedA.lexiconSeedWeights,
    initEnemyWeights: matchedB.lexiconSeedWeights,
    symmetricMirror: isMirror,
    roundGames,
    evalGames,
    candCount: profile.candidateCount || 20,
    tol: profile.convergenceTolerance ?? 0.001,
    maxRounds: profile.maxRounds || 12,
    seedPrefix,
    fastSim,
    gpuSim,
    signal,
    onRoundProgress: (info) => {
      onProgress?.({
        round: info.round,
        maxRounds: info.maxRounds,
        winRate: info.winRate,
        oppWinRate: info.oppWinRate,
        delta: info.delta,
        frac: info.frac,
        history: info.history || []
      });
    }
  });
  if (!gtg || signal?.aborted) return null;

  const gtgProfile = {
    ...profile,
    mode: 'gtg',
    label: profile.label || 'GTG精英轻量模型',
    gamesPerOpponent: evalGames,
    deepGamesPerOpponent: evalGames,
    firstSeatGames: Math.floor(evalGames / 2)
  };

  return {
    deckA,
    deckB,
    opp: oppWrapper,
    isMirror,
    diffCount,
    profile: gtgProfile,
    baseWeights,
    playerWeights: gtg.finalPlayerWeights,
    enemyWeights: gtg.finalEnemyWeights,
    rounds: gtg.rounds,
    converged: gtg.converged,
    history: gtg.history || [],
    agg: gtg.finalEval,
    evalGames,
    seedPrefix: `${seedPrefix}:eval`,
    testSeedBase: gtg.evalSeedBase,
    myFastDeck,
    oppFastDeck,
    completedAt: new Date().toISOString()
  };
}

// 渲染自訂牌組 GTG 互打進度與完整勝率報告（極簡零技術術語）
export function renderCustomDuelReport(duelResult, progress = null, options = {}) {
  if (progress?.running) {
    const pct = Math.min(99.9, Math.max(2, Number(progress.frac || 0) * 100)).toFixed(1);
    const roundText = progress.round > 0 ? ` · 第 ${progress.round} 次迭代` : '';
    const liveHist = Array.isArray(progress.history) ? progress.history : [];
    const latest = liveHist[liveHist.length - 1];
    const liveSub = latest
      ? `最新試算：我方 ${(latest.winRate * 100).toFixed(2)}% ／ 對手 ${(latest.oppWinRate * 100).toFixed(2)}%`
      : '正在準備雙方牌組對陣…';
    return `
      <div class="report-shell">
        <div class="strategy-synth-banner is-running">
          <div class="strategy-synth-head">
            <div>
              <strong>正在進行 GTG 互打模擬（${esc(progress.deckAName || '我方')} vs ${esc(progress.deckBName || '對手')}${roundText} · ${pct}%）…</strong>
              <p class="sub">${liveSub}</p>
            </div>
            <button class="btn btn-outline" type="button" data-action="cancel-custom-duel">取消</button>
          </div>
          <div class="progress-track is-slim">
            <i style="width:${pct}%"></i>
          </div>
        </div>
      </div>
    `;
  }

  if (!duelResult?.agg) {
    return `<div class="empty-box is-dashed"><strong>尚無互打測試紀錄</strong><p>在上方選擇我方與對手兩副牌組，點擊「開始 GTG 互打」即可查看雙方實戰勝率、先後攻表現、迭代次數與對局回放。</p></div>`;
  }

  const { deckA, deckB, opp, isMirror, diffCount, rounds, converged, history, agg, evalGames } = duelResult;
  const total = Math.max(1, Number(agg.total || 0));
  const myWr = ((agg.wins / total) * 100).toFixed(2) + '%';
  const oppWr = ((agg.losses / total) * 100).toFixed(2) + '%';
  const myScorePct = (((agg.wins + 0.5 * agg.draws) / total) * 100).toFixed(2) + '%';
  const f1Tot = Math.max(1, agg.firstWins + agg.firstDraws + agg.firstLosses);
  const f2Tot = Math.max(1, agg.secondWins + agg.secondDraws + agg.secondLosses);
  const f1Pct = ((agg.firstWins / f1Tot) * 100).toFixed(2) + '%';
  const f2Pct = ((agg.secondWins / f2Tot) * 100).toFixed(2) + '%';
  const avgTurns = agg.turnsSum ? (agg.turnsSum / total).toFixed(1) + ' 回合' : '—';
  const convLabel = converged ? '已達收斂均衡' : '已達最大迭代';
  const halfGames = Math.floor((evalGames || total) / 2);
  const stripEvents = buildSampleEventsFromCompact(opp.id, agg, evalGames || total);

  const histRows = (history || []).map((h) => {
    const label = h.round === 0 ? '第 0 次（初始）' : `第 ${h.round} 次迭代`;
    const pPct = (h.winRate * 100).toFixed(2) + '%';
    const ePct = (Number(h.oppWinRate ?? (1 - h.winRate)) * 100).toFixed(2) + '%';
    const dPct = (Number(h.drawRate || 0) * 100).toFixed(2) + '%';
    const deltaStr = h.delta == null ? '—' : `${(h.delta * 100).toFixed(2)}%`;
    return `<tr><td>${label}</td><td class="num">${pPct}</td><td class="num">${ePct}</td><td class="num">${dPct}</td><td class="num">${deltaStr}</td></tr>`;
  }).join('');

  return `
    <div class="report-shell">
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">我方實戰勝率 · ${esc(deckA.name)}</span>
          <strong class="report-kpi-num">${myWr}</strong>
          <span class="report-kpi-ci">共 ${agg.total.toLocaleString('zh-TW')} 局 · 迭代 ${rounds} 次 · GTG精英轻量模型${isMirror ? ' · 相同牌組鏡像' : ` · 相異卡牌 ${diffCount} 張`}</span>
        </div>
        <div class="report-totals">
          <div class="tot-box is-win"><b>${agg.wins.toLocaleString('zh-TW')}</b><span>我方勝</span></div>
          <div class="tot-box is-draw"><b>${agg.draws.toLocaleString('zh-TW')}</b><span>和</span></div>
          <div class="tot-box is-loss"><b>${agg.losses.toLocaleString('zh-TW')}</b><span>對手勝</span></div>
        </div>
      </div>

      <div class="composite-kpi-grid" aria-label="自訂牌組互打指標">
        <div class="comp-card is-accent">
          <span class="comp-label">對手勝率 · ${esc(deckB.name)}</span>
          <strong class="comp-val">${oppWr}</strong>
          <small class="comp-sub">${agg.losses.toLocaleString('zh-TW')}勝 ${agg.draws.toLocaleString('zh-TW')}和 ${agg.wins.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">我方先攻勝率</span>
          <strong class="comp-val">${f1Pct}</strong>
          <small class="comp-sub">${agg.firstWins.toLocaleString('zh-TW')}勝 ${agg.firstDraws.toLocaleString('zh-TW')}和 ${agg.firstLosses.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">我方後攻勝率</span>
          <strong class="comp-val">${f2Pct}</strong>
          <small class="comp-sub">${agg.secondWins.toLocaleString('zh-TW')}勝 ${agg.secondDraws.toLocaleString('zh-TW')}和 ${agg.secondLosses.toLocaleString('zh-TW')}敗</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">平均回合與收斂</span>
          <strong class="comp-val is-sm">${avgTurns}</strong>
          <small class="comp-sub">迭代 ${rounds} 次 · ${convLabel}<br>含和局折算得分率：${myScorePct}</small>
        </div>
      </div>

      <div class="battle-row duel-replay-row">
        <div class="battle-opp-info">
          <div class="battle-opp-head">
            <span class="pill-sub">迭代 ${rounds} 次</span>
            <strong class="battle-opp-name">${esc(deckA.name)} vs ${esc(deckB.name)}</strong>
          </div>
          <div class="battle-opp-meta">
            <span>點擊右側任一格可直接查看該局完整中文回放</span>
          </div>
          <div class="battle-opp-actions">
            ${options.canReplay ? `<button class="mini" type="button" data-action="replay-custom-duel" data-idx="0">檢視對局回放</button>` : ''}
          </div>
        </div>
        <div class="battle-strip-col">
          ${renderGameStrip(opp.id, stripEvents, Boolean(options.canReplay), 500, 'replay-custom-duel', 0, 500, evalGames || total, halfGames)}
        </div>
      </div>

      ${histRows ? `
        <div class="duel-history-block">
          <h3>GTG 迭代收斂歷程（共 ${rounds} 次迭代）</h3>
          <div class="bench-table-wrap">
            <table class="bench-table">
              <thead>
                <tr><th>迭代輪次</th><th class="num">我方勝率</th><th class="num">對手勝率</th><th class="num">和局率</th><th class="num">與上次差值</th></tr>
              </thead>
              <tbody>${histRows}</tbody>
            </table>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// 單一對手卡組專項執行器（支援 1B5M / 1M5Q / GTG 精英輕量模型）
export async function executeSingleOpponentDeep({ opp, deck, baseWeights, simProfile = null, onProgress, signal }) {
  const { ready, fastSim, gpuSim, error } = await probeEngine();
  if (!ready) throw Error(error);
  const profile = resolveModelSimProfile(simProfile);
  const [lexicon, pairwiseDb] = await Promise.all([
    ensureStrategyLexicon(),
    ensurePairwiseStrategies()
  ]);
  const isGtg = profile.mode === 'gtg';
  const isMirror = isGtg && areDecksIdentical(deck, opp.representative);
  const oppEliteWeights = isMirror ? baseWeights : getOpponentEliteWeights(opp.id, baseWeights);
  const matched = matchDeckStrategies(deck, isGtg ? [] : [{ rank: 1, entry: opp }], lexicon, baseWeights, pairwiseDb, state.cardsById);
  const oppMatched = matchDeckStrategies(opp.representative, [], lexicon, oppEliteWeights, pairwiseDb, state.cardsById);

  const myFastDeck = expandDeckForFastSim(deck, matched.cardBonusById);
  const oppFastDeck = expandDeckForFastSim(opp.representative, oppMatched.cardBonusById);
  const useGpu = Boolean(gpuSim?.ready);

  if (isGtg) {
    const evalGames = useGpu
      ? (profile.evalGamesPerOpponent || 20000)
      : (profile.evalGamesPerOpponentCpu || 5000);
    const gtg = await runGtgDuelConvergence({
      opp,
      myFastDeck,
      oppFastDeck,
      initPlayerWeights: matched.lexiconSeedWeights,
      initEnemyWeights: oppMatched.lexiconSeedWeights,
      symmetricMirror: isMirror,
      roundGames: profile.roundGamesPerOpponent || 1000000,
      evalGames,
      candCount: profile.candidateCount || 20,
      tol: profile.convergenceTolerance ?? 0.001,
      maxRounds: profile.maxRounds || 12,
      seedPrefix: `single-gtg:${deck.id}`,
      fastSim,
      gpuSim,
      signal,
      onRoundProgress: ({ round, frac }) => {
        onProgress?.({ phase: 'explore', round, done: Math.round(frac * 100), total: 100, profile });
      }
    });
    if (!gtg || signal?.aborted) return null;
    const gtgProfile = { ...profile, deepGamesPerOpponent: evalGames, gamesPerOpponent: evalGames, firstSeatGames: Math.floor(evalGames / 2) };
    return {
      opp,
      deck,
      profile: gtgProfile,
      baseWeights,
      oppEliteWeights: gtg.finalEnemyWeights,
      winningWeights: gtg.finalPlayerWeights,
      matched,
      strategy: { weights: gtg.finalPlayerWeights, exploreWinRate: gtg.finalEval.winRate, rounds: gtg.rounds, converged: gtg.converged },
      agg: gtg.finalEval,
      seedPrefix: `single-gtg:${deck.id}:eval`,
      testSeedBase: gtg.evalSeedBase,
      myFastDeck,
      oppFastDeck,
      mode: useGpu ? 'gpu' : 'cpu',
      adapterName: useGpu ? gpuSim.adapterName : '',
      workersUsed: useGpu ? 0 : (fastWorkerPool?.size || 1)
    };
  }

  const expTarget = profile.deepExploreGames;
  const testCount = profile.deepGamesPerOpponent;
  const candidates = buildExplorationCandidates(matched.lexiconSeedWeights, `single-${profile.id}:${deck.id}:${opp.id}`, EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats([opp.id], candidates.length);
  const seedBase = fnv1a32(`single-${profile.id}-exp:${deck.id}:${opp.id}`);

  const tExp0 = performance.now();
  let workersUsed = useGpu ? 0 : 1;

  if (useGpu) {
    gpuSim.uploadExploreContext({
      deck: myFastDeck,
      enemies: [{ id: opp.id, cards: oppFastDeck }],
      enemyWeightsList: [oppEliteWeights],
      candidates
    });
    const pairsPerOpp = Math.floor(expTarget / candidates.length);
    let pairSlice = Math.min(25000, pairsPerOpp);
    let lastTick = 0;
    for (let startPair = 0; startPair < pairsPerOpp; ) {
      if (signal?.aborted) return null;
      const countPairs = Math.min(pairSlice, pairsPerOpp - startPair);
      const dt0 = performance.now();
      const res = await gpuSim.runExplorePairSlice({
        nOpps: 1,
        nCands: candidates.length,
        gamesPerOpp: expTarget,
        startPair,
        pairCount: countPairs,
        seedBase,
        enemyIds: [opp.id]
      });
      const dtMs = Math.max(5, performance.now() - dt0);
      mergeExploreChunkStats(stats, res);
      startPair += countPairs;
      pairSlice = Math.max(5000, Math.min(500000, Math.round(countPairs * (240 / dtMs))));
      const now = performance.now();
      if (now - lastTick >= 100 || startPair >= pairsPerOpp) {
        lastTick = now;
        onProgress?.({
          phase: 'explore',
          done: stats.completed,
          total: expTarget,
          wins: stats.wins,
          gamesPerSec: stats.completed / Math.max(0.05, (now - tExp0) / 1000),
          mode: 'gpu',
          adapter: gpuSim.adapterName,
          profile
        });
      }
    }
  } else {
    const exploreChunkSize = Math.min(500000, Math.max(50000, Math.floor(expTarget / 20)));
    const exploreTasks = [];
    for (let start = 0; start < expTarget; start += exploreChunkSize) {
      exploreTasks.push({
        start,
        request: {
          op: 'explore_10m_chunk',
          deck: myFastDeck,
          enemies: [{ id: opp.id, cards: oppFastDeck }],
          candidates,
          enemy_weights: oppEliteWeights,
          enemy_weights_list: [oppEliteWeights],
          games_per_opponent: expTarget,
          start_game: start,
          count: Math.min(exploreChunkSize, expTarget - start),
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
        if (now - lastTick >= 100 || stats.completed >= expTarget) {
          lastTick = now;
          onProgress?.({
            phase: 'explore',
            done: stats.completed,
            total: expTarget,
            wins: stats.wins,
            gamesPerSec: stats.completed / Math.max(0.05, (now - tExp0) / 1000),
            mode: 'cpu',
            workers: fastWorkerPool?.size || 1,
            profile
          });
        }
      }
    });
  }
  if (signal?.aborted) return null;

  const strategy = synthesizeWinningStrategyFromStats(stats, baseWeights, candidates);
  const winningWeights = strategy.byOpponent[opp.id]?.weights || strategy.weights;

  const seedPrefix = `single-${profile.id}-test:${deck.id}`;
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
          adapter: gpuSim.adapterName,
          profile
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
    const testChunkSize = Math.min(50000, Math.max(500, Math.floor(testCount / 10)));
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
          workers: workersUsed,
          profile
        });
      }
    });
    if (signal?.aborted) return null;
  }

  return {
    opp,
    deck,
    profile,
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

export function renderSingleOpponentDeepProgress({ opp, phase, round = 0, done, total }) {
  const pct = Math.min(100, (done / Math.max(1, total)) * 100).toFixed(1);
  const roundText = round > 0 ? `（第 ${round} 次迭代）` : '';
  const label = phase === 'explore'
    ? `正在分析對陣「${esc(opp.name)}」${roundText}…`
    : `正在統計對陣「${esc(opp.name)}」勝率…`;
  return `
    <div class="flow-modal">
      <div class="strategy-synth-banner is-running">
        <div class="strategy-synth-head">
          <div>
            <strong>${label}</strong>
            <p class="sub">進度 ${pct}%</p>
          </div>
          <button class="btn btn-outline" type="button" data-action="cancel-single-deep">取消</button>
        </div>
        <div class="progress-track">
          <i style="width:${pct}%"></i>
        </div>
      </div>
    </div>
  `;
}

export function renderSingleOpponentDeepModal(deepResult, activeReplayIdx = 0) {
  const { opp, deck, profile, baseWeights, oppEliteWeights, winningWeights, strategy, agg, seedPrefix, testSeedBase, myFastDeck, oppFastDeck } = deepResult;
  const p = resolveModelSimProfile(profile);
  const testTotal = p.deepGamesPerOpponent;
  const halfTest = Math.floor(testTotal / 2);
  const testWr = agg.total ? ((agg.wins / agg.total) * 100).toFixed(2) + '%' : '—';
  const gtgRoundsText = strategy?.rounds > 0 ? ` · 迭代 ${strategy.rounds} 次` : '';

  const pageSize = 500;
  const segStep = Math.max(pageSize, Math.floor(testTotal / 10));
  const segmentStarts = Array.from({ length: 10 }, (_, idx) => idx * segStep);
  let pageStart = Math.floor(activeReplayIdx / pageSize) * pageSize;
  pageStart = Math.min(Math.max(0, testTotal - pageSize), Math.max(0, pageStart));

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
      total_per_opp: testTotal,
      seed_base: testSeedBase
    });
    for (let k = 0; k < sliceRes.outcomes.length; k++) {
      const idx = pageStart + k;
      const code = sliceRes.outcomes[k];
      pageEvents.push({
        opponentId: opp.id,
        index: idx,
        first: idx < halfTest ? 0 : 1,
        outcome: code === 1 ? 'win' : code === 0 ? 'loss' : 'draw',
        turns: sliceRes.turns[k] || 0
      });
    }
  }

  const pageTabs = segmentStarts.map((s, idx) => {
    const active = activeReplayIdx >= s && activeReplayIdx < s + segStep;
    const side = idx < 5 ? '先' : '後';
    const label = testTotal >= 100000 ? `${side} ${(s / 10000).toFixed(0)}萬+` : `${side} ${s + 1}–${s + pageSize}`;
    return `<button class="mini ${active ? 'is-active' : ''}" type="button" data-action="replay-single-deep" data-opp="${esc(opp.id)}" data-idx="${s}">${label}</button>`;
  }).join('');

  const f1Total = agg.firstWins + agg.firstDraws + agg.firstLosses;
  const f2Total = agg.secondWins + agg.secondDraws + agg.secondLosses;

  const flowHtml = buildFullGameFlowModal({
    opp,
    oppId: opp.id,
    idx: activeReplayIdx,
    run: { modelVersion: p.id === '1m5q' ? 'lite-1m5q' : 'selfplay-cem-v3', simProfile: p },
    deck,
    weights: baseWeights,
    customSimProfile: p,
    customGamesPerOpp: testTotal,
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
      <div class="flow-stage-card">
        <h3>對陣「${esc(opp.name)}」勝率：${testWr}（${agg.wins.toLocaleString('zh-TW')}勝 ${agg.draws.toLocaleString('zh-TW')}和 ${agg.losses.toLocaleString('zh-TW')}敗${gtgRoundsText}）</h3>
        <p class="sub">先攻勝率 ${((agg.firstWins / Math.max(1, f1Total)) * 100).toFixed(2)}% · 後攻勝率 ${((agg.secondWins / Math.max(1, f2Total)) * 100).toFixed(2)}% — 點擊任一格檢視回放：</p>
        <div class="deep-page-tabs">${pageTabs}</div>
        ${renderGameStrip(opp.id, pageEvents, true, pageSize, 'replay-single-deep', pageStart, pageSize, testTotal)}
      </div>

      ${flowHtml}
    </div>
  `;
}

// 執行勝率推演（支援 1B5M 全量、1M5Q 輕量與 GTG 精英輕量雙邊同步收斂模型）：
export async function executeBattleBatch({ run, deck, lineup, weights, simProfile = null, onTick, signal }) {
  const { ready, fastSim, gpuSim, error } = await probeEngine();
  if (!ready) throw Error(error);

  const profile = resolveModelSimProfile(simProfile || run);
  run.simProfile = profile;

  // ============================================================================
  // GTG 精英輕量模型：對每個對手獨立啟用專屬策略，每輪雙邊同步對弈 1M 局並各自從勝局學習，
  // 重複迭代至 |WR_t - WR_{t-1}| < 0.1% 收斂為最終勝率，最後彙總 10 組對手平均勝率
  // ============================================================================
  if (profile.mode === 'gtg') {
    const [lexicon, pairwiseDb] = await Promise.all([
      ensureStrategyLexicon(),
      ensurePairwiseStrategies()
    ]);
    const useGpu = Boolean(gpuSim?.ready);
    const evalGames = useGpu
      ? (profile.evalGamesPerOpponent || 20000)
      : (profile.evalGamesPerOpponentCpu || 5000);
    run.gamesPerOppActual = evalGames;
    if (!run.compactResults) run.compactResults = {};
    if (!run.convergedEnemyWeights) run.convergedEnemyWeights = {};
    if (!run.testSeedBaseByOpp) run.testSeedBaseByOpp = {};
    if (!run.winningStrategy) run.winningStrategy = { weights: [...weights], byOpponent: {} };
    if (!run.winningStrategy.byOpponent) run.winningStrategy.byOpponent = {};
    if (!run.gtgMeta) run.gtgMeta = { opponentsDone: 0, totalOpponents: lineup.length, currentOppFrac: 0, byOpponent: {} };
    if (!run.gtgMeta.byOpponent) run.gtgMeta.byOpponent = {};
    run.gtgMeta.totalOpponents = lineup.length;
    delete run.exploreEvents;

    const matchedAll = matchDeckStrategies(deck, lineup, lexicon, weights, pairwiseDb, state.cardsById);
    const oppCardBonusById = {};
    for (const item of lineup) {
      const ew = getOpponentEliteWeights(item.entry.id, weights);
      const om = matchDeckStrategies(item.entry.representative, [], lexicon, ew, pairwiseDb, state.cardsById);
      oppCardBonusById[item.entry.id] = om.cardBonusById;
    }
    run.matchedStrategies = {
      totalLexiconCount: matchedAll.totalLexiconCount,
      matchedCount: matchedAll.matchedCount,
      cardBonusById: matchedAll.cardBonusById,
      myCardBonusByOpp: {},
      oppCardBonusById
    };

    const doneCount = () => lineup.filter((it) => run.gtgMeta.byOpponent[it.entry.id]?.done).length;
    run.gtgMeta.opponentsDone = doneCount();
    onTick(run);

    for (let oi = 0; oi < lineup.length; oi++) {
      if (signal?.aborted) break;
      const item = lineup[oi];
      const opp = item.entry;
      if (run.gtgMeta.byOpponent[opp.id]?.done && (run.compactResults[opp.id]?.total || 0) >= evalGames) {
        continue;
      }

      // 雙邊完全對稱初始化各自專屬策略（鏡像對局採完全一致基準與對稱探索，確保同牌組嚴格公平）
      const isMirror = areDecksIdentical(deck, opp.representative);
      const myMatchupMatched = matchDeckStrategies(deck, [], lexicon, weights, pairwiseDb, state.cardsById);
      run.matchedStrategies.myCardBonusByOpp[opp.id] = myMatchupMatched.cardBonusById;
      const oppInitBase = isMirror ? weights : getOpponentEliteWeights(opp.id, weights);
      const oppMatched = matchDeckStrategies(opp.representative, [], lexicon, oppInitBase, pairwiseDb, state.cardsById);
      const myFastDeck = expandDeckForFastSim(deck, myMatchupMatched.cardBonusById);
      const oppFastDeck = expandDeckForFastSim(opp.representative, oppMatched.cardBonusById);

      const gtgRes = await runGtgDuelConvergence({
        opp,
        myFastDeck,
        oppFastDeck,
        initPlayerWeights: myMatchupMatched.lexiconSeedWeights,
        initEnemyWeights: oppMatched.lexiconSeedWeights,
        symmetricMirror: isMirror,
        roundGames: profile.roundGamesPerOpponent || 1000000,
        evalGames,
        candCount: profile.candidateCount || 20,
        tol: profile.convergenceTolerance ?? 0.001,
        maxRounds: profile.maxRounds || 12,
        seedPrefix: `${run.runId}:gtg`,
        fastSim,
        gpuSim,
        signal,
        onRoundProgress: ({ round, frac }) => {
          run.gtgMeta.currentRound = round;
          run.gtgMeta.currentOppFrac = frac;
          onTick(run);
        }
      });
      if (!gtgRes || signal?.aborted) break;

      run.compactResults[opp.id] = {
        total: gtgRes.finalEval.total,
        wins: gtgRes.finalEval.wins,
        draws: gtgRes.finalEval.draws,
        losses: gtgRes.finalEval.losses,
        firstWins: gtgRes.finalEval.firstWins,
        firstDraws: gtgRes.finalEval.firstDraws,
        firstLosses: gtgRes.finalEval.firstLosses,
        secondWins: gtgRes.finalEval.secondWins,
        secondDraws: gtgRes.finalEval.secondDraws,
        secondLosses: gtgRes.finalEval.secondLosses,
        turnsSum: gtgRes.finalEval.turnsSum,
        sampleOutcomesStr: gtgRes.finalEval.sampleOutcomesStr
      };
      run.winningStrategy.byOpponent[opp.id] = {
        weights: gtgRes.finalPlayerWeights,
        winRate: gtgRes.finalEval.winRate,
        rounds: gtgRes.rounds,
        converged: gtgRes.converged
      };
      run.convergedEnemyWeights[opp.id] = gtgRes.finalEnemyWeights;
      run.testSeedBaseByOpp[opp.id] = gtgRes.evalSeedBase;
      run.gtgMeta.byOpponent[opp.id] = {
        done: true,
        converged: gtgRes.converged,
        rounds: gtgRes.rounds,
        totalCoEvoGames: gtgRes.totalCoEvoGames,
        finalWinRate: gtgRes.finalEval.winRate,
        history: gtgRes.history
      };
      run.gtgMeta.opponentsDone = doneCount();
      run.gtgMeta.currentRound = 0;
      run.gtgMeta.currentOppFrac = 0;

      await saveRunRecord(run);
      onTick(run);
    }

    await saveRunRecord(run);
    onTick(run);
    return run;
  }

  const expTotal = profile.exploreTotalGames;
  const expPerOpp = profile.exploreGamesPerOpponent;
  const gamesPerOpp = profile.gamesPerOpponent;
  const halfPerOpp = profile.firstSeatGames;
  const totalBatch = profile.totalBatchGames;
  const exploreSeedTag = profile.id === '1m5q' ? 'exp1m' : 'exp1b';
  const testSeedTag = profile.id === '1m5q' ? 'test5q' : 'test5m';

  const [lexicon, pairwiseDb] = await Promise.all([
    ensureStrategyLexicon(),
    ensurePairwiseStrategies()
  ]);
  const enemyWeightsList = lineup.map((item) => getOpponentEliteWeights(item.entry.id, weights));
  const matched = matchDeckStrategies(deck, lineup, lexicon, weights, pairwiseDb, state.cardsById);
  const myFastDeck = expandDeckForFastSim(deck, matched.cardBonusById);
  const oppCardBonusById = {};
  const fastEnemies = lineup.map((item, idx) => {
    const oppM = matchDeckStrategies(item.entry.representative, [], lexicon, enemyWeightsList[idx], pairwiseDb, state.cardsById);
    oppCardBonusById[item.entry.id] = oppM.cardBonusById;
    return {
      id: item.entry.id,
      cards: expandDeckForFastSim(item.entry.representative, oppM.cardBonusById)
    };
  });
  run.matchedStrategies = {
    totalLexiconCount: matched.totalLexiconCount,
    singleLexiconCount: matched.singleLexiconCount,
    pairwiseLexiconCount: matched.pairwiseLexiconCount,
    matchedCount: matched.matchedCount,
    cardMatchedCount: matched.cardMatchedCount,
    macroMatchedCount: matched.macroMatchedCount,
    pairMatchedCount: matched.pairMatchedCount,
    cardBonusById: matched.cardBonusById,
    oppCardBonusById,
    topActiveStrategies: matched.topActiveStrategies,
    activePairStrategies: matched.activePairStrategies,
    matchedIds: matched.matchedIds
  };
  const oppIds = fastEnemies.map((e) => e.id);
  const candidates = buildExplorationCandidates(
    matched.lexiconSeedWeights,
    `batch-${profile.id}:${deck.id}:${run.season || 'C1'}`,
    EXPLORE_CANDIDATE_COUNT
  );

  if (!run.compactResults) run.compactResults = {};
  if (!run.exploreStats || run.exploreStats.byCandidate?.length !== candidates.length || run.exploreStats.byOpponent?.length !== oppIds.length) {
    run.exploreStats = createEmptyExploreStats(oppIds, candidates.length);
  }
  delete run.exploreEvents;

  const useGpu = Boolean(gpuSim?.ready);
  const exploreSeedBase = fnv1a32(`${run.runId}:${exploreSeedTag}`);

  // ============================================================================
  // 第一階段：策略探索（1B5M = 1,000,000,000 局；1M5Q = 1,000,000 局）
  // ============================================================================
  if ((run.exploreStats.completed || 0) < expTotal) {
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
      const pairsPerOpp = Math.floor(expPerOpp / candidates.length);
      let startPair = Number(run.exploreStats.nextPairStart || 0);
      let pairSlice = Math.min(2500, pairsPerOpp);
      let batchesSinceSave = 0;

      while (startPair < pairsPerOpp) {
        if (signal?.aborted) break;
        const countPairs = Math.min(pairSlice, pairsPerOpp - startPair);
        const dt0 = performance.now();
        const res = await gpuSim.runExplorePairSlice({
          nOpps: fastEnemies.length,
          nCands: candidates.length,
          gamesPerOpp: expPerOpp,
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
      const exploreChunkSize = Math.min(500000, Math.max(50000, Math.floor(expTotal / 20)));
      const exploreTasks = [];
      for (let start = 0; start < expTotal; start += exploreChunkSize) {
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
            games_per_opponent: expPerOpp,
            start_game: start,
            count: Math.min(exploreChunkSize, expTotal - start),
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
          if (chunksSinceSave >= 16 || run.exploreStats.completed >= expTotal) {
            chunksSinceSave = 0;
            await saveRunRecord(run);
          }
          if (now - lastUiTick >= 120 || run.exploreStats.completed >= expTotal) {
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
  // 第二階段：正式實測（1B5M = 5,000,000 局；1M5Q = 5,000 局）
  // ============================================================================
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
      const seedBase = fnv1a32(`${run.runId}:${testSeedTag}:${opp.id}`);

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
    const testChunkSize = Math.min(50000, gamesPerOpp);
    const testTasks = [];
    for (let o = 0; o < lineup.length; o++) {
      const opp = lineup[o].entry;
      const existing = run.compactResults[opp.id];
      if (existing && existing.total >= gamesPerOpp) continue;
      const oppStrategyWeights = run.winningStrategy?.byOpponent?.[opp.id]?.weights
        || run.winningStrategy?.weights
        || weights;
      const seedBase = fnv1a32(`${run.runId}:${testSeedTag}:${opp.id}`);
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
          if (now - lastUiTick >= 100 || testDone >= totalBatch) {
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
// 僅在 ?fixture=1 下用於 UI 樣式驗收的演示生成器（依模型自動切換 1B5M / 1M5Q）
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const profile = resolveModelSimProfile(run);
  run.simProfile = profile;
  const expTotal = profile.exploreTotalGames;
  const expPerOpp = profile.exploreGamesPerOpponent;
  const gamesPerOpp = profile.gamesPerOpponent;
  const halfPerOpp = profile.firstSeatGames;
  const oppIds = lineup.map((x) => x.entry.id);
  const baseW = Array(22).fill(0.5);
  const candidates = buildExplorationCandidates(baseW, `fixture-${profile.id}`, EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats(oppIds, candidates.length);
  stats.completed = expTotal;
  stats.wins = Math.round(expTotal * 0.485);
  stats.draws = Math.round(expTotal * 0.025);
  stats.losses = expTotal - stats.wins - stats.draws;
  const perCand = Math.floor(expTotal / candidates.length);
  stats.byCandidate.forEach((c, idx) => {
    c.games = perCand;
    c.wins = Math.round(perCand * (0.46 + (idx % 5) * 0.018));
    c.draws = Math.round(perCand * 0.025);
    c.losses = c.games - c.wins - c.draws;
  });
  const perOppCand = Math.floor(expPerOpp / candidates.length);
  stats.byOpponent.forEach((o, idx) => {
    o.games = expPerOpp;
    o.wins = Math.round(expPerOpp * (0.46 + (idx % 5) * 0.018));
    o.draws = Math.round(expPerOpp * 0.025);
    o.losses = o.games - o.wins - o.draws;
    o.byCandidate.forEach((bc, cIdx) => {
      bc.games = perOppCand;
      bc.wins = Math.round(perOppCand * (0.46 + (cIdx % 5) * 0.018));
      bc.draws = Math.round(perOppCand * 0.025);
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
    const fw = Math.round(halfPerOpp * 0.54), fd = Math.round(halfPerOpp * 0.04), fl = halfPerOpp - fw - fd;
    const sw = Math.round(halfPerOpp * 0.49), sd = Math.round(halfPerOpp * 0.04), sl = halfPerOpp - sw - sd;
    run.compactResults[oppId] = {
      total: gamesPerOpp, wins: fw + sw, draws: fd + sd, losses: fl + sl,
      firstWins: fw, firstDraws: fd, firstLosses: fl,
      secondWins: sw, secondDraws: sd, secondLosses: sl,
      turnsSum: gamesPerOpp * 9,
      sampleOutcomesStr: sampleStr
    };
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}

// ============================================================================
// 牌組 AI 優化（三階段：全卡庫規則相容初篩 → 完整規則多執行緒實戰模擬 → 高精度同種子複核）
// ============================================================================
function buildCompatibleMetaStapleItems({ candidates, metaEntries, targetCardId, origCard, remainingNameCounts, remainingBasics, optCtx, cardsById }) {
  const candByLimit = new Map();
  for (const item of candidates) {
    if (!item?.card || item.isOriginal) continue;
    const lk = item.card.limitName || item.card.nameEn || item.card.name;
    if (!candByLimit.has(lk)) candByLimit.set(lk, item);
  }

  const origLimitKey = origCard ? (origCard.limitName || origCard.nameEn || origCard.name) : '';
  const usageByLimit = new Map();
  for (const entry of metaEntries || []) {
    const share = Math.max(0.005, Number(entry?.share || 0.01));
    const cardsList = entry?.representative?.cards || [];
    for (const cEntry of cardsList) {
      const c = cardsById.get(cEntry.id);
      if (!c) continue;
      const lk = c.limitName || c.nameEn || c.name;
      if (lk === origLimitKey) continue;
      if ((remainingNameCounts.get(lk) || 0) >= 2) continue;
      if (remainingBasics === 0 && !(c.type === 'pokemon' && c.stage === 'basic')) continue;
      if (!isCardCompatibleWithDeck(c, optCtx)) continue;
      usageByLimit.set(lk, (usageByLimit.get(lk) || 0) + share * (Number(cEntry.count) || 1));
    }
  }

  const sortedLimits = [...usageByLimit.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lk]) => lk);

  const staples = [];
  for (const lk of sortedLimits) {
    const item = candByLimit.get(lk);
    if (item && item.card.id !== targetCardId) {
      staples.push(item);
      if (staples.length >= 16) break;
    }
  }
  return staples;
}

function countOutcomesString(outcomesStr) {
  let wins = 0;
  let draws = 0;
  let losses = 0;
  const s = String(outcomesStr || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 87) wins++; // 'W'
    else if (ch === 68) draws++; // 'D'
    else if (ch === 76) losses++; // 'L'
  }
  return { wins, draws, losses, games: wins + draws + losses };
}

async function evaluateCandidatesWithExactRules({
  deck,
  targetCardId,
  candidateItems,
  lineup,
  playerWeights,
  enemyWeightsList,
  gamesPerOpp,
  seedPrefix,
  runtimeFn,
  signal,
  onCandidateProgress
}) {
  const nCand = candidateItems.length;
  const nOpps = lineup.length;
  const aggList = candidateItems.map((item) => ({
    ...item,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    doneOpps: 0
  }));

  const tasks = [];
  for (let ci = 0; ci < nCand; ci++) {
    const item = candidateItems[ci];
    const modDeck = item.isOriginal || item.card.id === targetCardId
      ? deck
      : replaceDeckCardOnce(deck, targetCardId, item.card.id);
    const deckPayload = { cards: modDeck.cards, energy: modDeck.energy };

    for (let oi = 0; oi < nOpps; oi++) {
      const opp = lineup[oi].entry;
      tasks.push({
        ci,
        oi,
        request: {
          op: 'test_chunk',
          deck: deckPayload,
          enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
          opponent_id: opp.id,
          weights: playerWeights,
          enemy_weights: enemyWeightsList[oi],
          seed_prefix: seedPrefix,
          start_idx: 0,
          count: gamesPerOpp,
          total_per_opp: gamesPerOpp
        }
      });
    }
  }

  let finishedCandidates = 0;
  await runDeckGymTasks(tasks, {
    runtimeFn,
    signal,
    onResult: (res, task) => {
      const agg = aggList[task.ci];
      const cnt = countOutcomesString(res.outcomes);
      agg.wins += cnt.wins;
      agg.draws += cnt.draws;
      agg.losses += cnt.losses;
      agg.games += cnt.games;
      agg.doneOpps++;
      if (agg.doneOpps === nOpps) {
        finishedCandidates++;
        onCandidateProgress?.(finishedCandidates, nCand);
      }
    }
  });

  for (const agg of aggList) {
    agg.winRate = agg.games ? agg.wins / agg.games : 0;
    agg.scoreRate = agg.games ? (agg.wins + 0.5 * agg.draws) / agg.games : 0;
  }
  return aggList;
}

export async function executeDeckCardOptimize({ deck, targetCardId, lineup, onProgress, signal }) {
  const { ready, fastSim, gpuSim, error } = await probeEngine();
  if (!ready) throw Error(error || '模擬引擎尚未就緒');
  if (!lineup?.length) throw Error('尚未載入賽事環境資料');

  const liteModel = state.modelsById?.get?.('lite-1m5q')
    || state.modelsById?.get?.('v3')
    || state.modelInfo;
  const playerWeights = liteModel?.weights || Array(22).fill(0);
  const enemyWeightsList = lineup.map((item) => getOpponentEliteWeights(item.entry.id, playerWeights));

  const cardBonusById = {};
  const priorsById = state.cardPriors?.byCardId || {};
  for (const [cid, info] of Object.entries(priorsById)) {
    cardBonusById[cid] = Number(info?.p || 0);
  }

  const fastEnemies = lineup.map((item) => ({
    id: item.entry.id,
    cards: expandDeckForFastSim(item.entry.representative, cardBonusById)
  }));

  const prep = buildLegalReplacementCandidates({
    deck,
    targetCardId,
    allCards: state.cards,
    cardsById: state.cardsById,
    collection: state.collection,
    cardBonusById
  });

  const {
    baseDeck20,
    origCard,
    optCtx,
    remainingNameCounts,
    remainingBasics,
    totalCatalogCount,
    totalLegalChecked,
    incompatibleCount,
    candidates
  } = prep;

  const nOpps = fastEnemies.length;
  const mobile = isAndroidOrMobileEnv();
  const useGpu = Boolean(gpuSim?.ready);
  const screenSeedBase = fnv1a32(`opt-screen-v2:${deck.id}:${targetCardId}`);

  // 階段一：全卡庫合法與相容卡牌快速初篩（已過濾異色死牌、缺前階進化卡、條件不符訓練家）
  const screenGamesPerOpp = useGpu ? 80 : 20;
  const batchSize = useGpu ? 64 : 32;
  const scored = new Array(candidates.length);
  let checkedCards = incompatibleCount;

  onProgress?.({ stage: 'screen', done: Math.min(totalLegalChecked, checkedCards), total: totalLegalChecked });

  if (useGpu) {
    gpuSim.uploadOptimizeContext({
      baseDeck: baseDeck20,
      enemies: fastEnemies,
      playerWeights,
      enemyWeightsList
    });
    for (let start = 0; start < candidates.length; start += batchSize) {
      if (signal?.aborted) return null;
      const slice = candidates.slice(start, start + batchSize);
      const res = await gpuSim.runOptimizeBatch({
        candidateCards: slice.map((x) => x.encoded),
        nOpps,
        gamesPerOpp: screenGamesPerOpp,
        seedBase: screenSeedBase
      });
      for (let i = 0; i < slice.length; i++) {
        const r = res.results[i];
        scored[start + i] = {
          ...slice[i],
          screenWinRate: r.games ? r.wins / r.games : 0
        };
        checkedCards += slice[i].representedCount || 1;
      }
      onProgress?.({ stage: 'screen', done: Math.min(totalLegalChecked, checkedCards), total: totalLegalChecked });
    }
  } else {
    const tasks = [];
    for (let start = 0; start < candidates.length; start += batchSize) {
      const slice = candidates.slice(start, start + batchSize);
      tasks.push({
        start,
        slice,
        request: {
          op: 'optimize_batch',
          base_deck: baseDeck20,
          enemies: fastEnemies,
          player_weights: playerWeights,
          enemy_weights: playerWeights,
          enemy_weights_list: enemyWeightsList,
          candidate_cards: slice.map((x) => x.encoded),
          games_per_opp: screenGamesPerOpp,
          seed_base: screenSeedBase
        }
      });
    }
    await runFastTasks(tasks, {
      fastSim,
      signal,
      onResult: (res, task) => {
        for (let i = 0; i < task.slice.length; i++) {
          const r = res.results[i];
          scored[task.start + i] = {
            ...task.slice[i],
            screenWinRate: r.games ? r.wins / r.games : 0
          };
          checkedCards += task.slice[i].representedCount || 1;
        }
        onProgress?.({ stage: 'screen', done: Math.min(totalLegalChecked, checkedCards), total: totalLegalChecked });
      }
    });
  }
  if (signal?.aborted) return null;

  // 組合階段二候選清單：原卡 + 賽事環境相容熱門卡 + 初篩前段（均衡涵蓋訓練家與寶可夢）
  const origItem = scored[0];
  const othersRanked = scored.slice(1).filter(Boolean).sort((a, b) => b.screenWinRate - a.screenWinRate);
  const topTrainers = othersRanked.filter((x) => x.card?.type === 'trainer').slice(0, 10);
  const topPokemons = othersRanked.filter((x) => x.card?.type === 'pokemon').slice(0, 8);
  const metaStaples = buildCompatibleMetaStapleItems({
    candidates,
    metaEntries: state.meta?.entries || [],
    targetCardId,
    origCard,
    remainingNameCounts,
    remainingBasics,
    optCtx,
    cardsById: state.cardsById
  });

  const mergedPool = [];
  const seenIds = new Set();
  for (const item of [origItem, ...metaStaples.slice(0, 12), ...topTrainers, ...topPokemons]) {
    if (!item?.card?.id || seenIds.has(item.card.id)) continue;
    seenIds.add(item.card.id);
    mergedPool.push(item);
    if (mergedPool.length >= (mobile ? 20 : 28)) break;
  }

  // 階段二：載入完整規則對戰引擎並以真實卡效、能量、進化與特性規則實戰模擬
  onProgress?.({ stage: 'sim', done: 0, total: mergedPool.length });
  const runtimeFn = await ensureDeckGymRuntime();
  if (signal?.aborted) return null;

  // 確認所有候選卡皆已被完整規則引擎完整支援，剔除極少數未實裝特典卡
  const covMap = ensureCardCoverage(mergedPool.map((x) => x.card.id));
  const simPool = mergedPool.filter((x) => {
    if (x.isOriginal) return true;
    const st = covMap?.[x.card.id];
    return !st || isEngineImplementedStatus(st);
  });

  const simGamesPerOpp = mobile ? 8 : 16; // 桌面 160 局/卡、行動端 80 局/卡（完整規則先後攻各半）
  const simSeedPrefix = `opt-exact-s2:${deck.id}:${targetCardId}`;
  const stage2Results = await evaluateCandidatesWithExactRules({
    deck,
    targetCardId,
    candidateItems: simPool,
    lineup,
    playerWeights,
    enemyWeightsList,
    gamesPerOpp: simGamesPerOpp,
    seedPrefix: simSeedPrefix,
    runtimeFn,
    signal,
    onCandidateProgress: (done, total) => {
      onProgress?.({ stage: 'sim', done, total });
    }
  });
  if (signal?.aborted) return null;

  // 階段三：對前段候選卡 + 原卡進行高精度同種子完整規則複核（桌面累計 560 局/卡，行動端 280 局/卡）
  const s2Orig = stage2Results.find((x) => x.isOriginal) || stage2Results[0];
  const s2Others = stage2Results
    .filter((x) => !x.isOriginal)
    .sort((a, b) => b.scoreRate - a.scoreRate || b.winRate - a.winRate);
  const finalistKeep = mobile ? 6 : 9;
  const finalists = [s2Orig, ...s2Others.slice(0, finalistKeep)].filter(Boolean);
  const s2ById = new Map(stage2Results.map((x) => [x.card.id, x]));

  const verifyGamesPerOpp = mobile ? 20 : 40; // 桌面追加 400 局/卡（累計 560 局）；行動端追加 200 局/卡（累計 280 局）
  const verifySeedPrefix = `opt-exact-s3:${deck.id}:${targetCardId}`;
  onProgress?.({ stage: 'verify', done: 0, total: finalists.length });

  const stage3Results = await evaluateCandidatesWithExactRules({
    deck,
    targetCardId,
    candidateItems: finalists,
    lineup,
    playerWeights,
    enemyWeightsList,
    gamesPerOpp: verifyGamesPerOpp,
    seedPrefix: verifySeedPrefix,
    runtimeFn,
    signal,
    onCandidateProgress: (done, total) => {
      onProgress?.({ stage: 'verify', done, total });
    }
  });
  if (signal?.aborted) return null;

  // 合併階段二 + 階段三的完整規則實戰戰績
  const verified = stage3Results.map((r3) => {
    const r2 = s2ById.get(r3.card.id);
    const wins = r3.wins + (r2?.wins || 0);
    const draws = r3.draws + (r2?.draws || 0);
    const losses = r3.losses + (r2?.losses || 0);
    const games = r3.games + (r2?.games || 0);
    return {
      ...r3,
      wins,
      draws,
      losses,
      games,
      winRate: games ? wins / games : 0,
      scoreRate: games ? (wins + 0.5 * draws) / games : 0
    };
  });

  const baseline = verified.find((x) => x.isOriginal) || verified[0];
  const ranked = [...verified].sort((a, b) => b.winRate - a.winRate || b.scoreRate - a.scoreRate || (a.isOriginal ? -1 : 1));
  let best = ranked[0] || baseline;
  // 若最高候選卡勝率未顯著超越原卡（< +0.1%），誠實建議保留原卡
  if (best && baseline && !best.isOriginal && (best.winRate - baseline.winRate) < 0.001) {
    best = baseline;
    const origIdx = ranked.findIndex((x) => x.isOriginal);
    if (origIdx > 0) {
      ranked.splice(origIdx, 1);
      ranked.unshift(baseline);
    }
  }
  const topList = ranked.slice(0, 10);

  return {
    deckId: deck.id,
    deckName: deck.name,
    targetCardId,
    origCard,
    totalCatalogCount,
    totalLegalChecked,
    baseline,
    best,
    topList
  };
}

// 玩家友善版「牌組 AI 優化」彈窗（零技術術語，僅呈現操作與結果）
export function renderDeckOptimizerModal(optState) {
  const { deck, selectedCardId, running, progress, result } = optState;
  if (!deck) {
    return '<div class="empty-box is-dashed"><strong>請先選擇一套合法的 20 張牌組</strong></div>';
  }

  const deckEntries = (deck.cards || []).map((entry) => ({
    ...entry,
    card: state.cardsById.get(entry.id)
  })).filter((x) => x.card);

  if (running) {
    const stage = progress?.stage || 'screen';
    const isSim = stage === 'sim';
    const isVerify = stage === 'verify';
    const done = Number(progress?.done || 0);
    const total = Math.max(1, Number(progress?.total || 1));
    const pct = Math.min(100, (done / total) * 100).toFixed(1);
    const targetName = state.cardsById.get(selectedCardId)?.name || '所選卡牌';
    const stageTitle = isVerify
      ? '正在對前段推薦卡牌進行高精度實戰複核…'
      : isSim
        ? '正在進行完整規則實戰對局測試…'
        : `正在為「${esc(targetName)}」篩選全卡庫相容卡牌…`;
    const stageSub = isVerify
      ? `正在複核前 ${total} 張高勝率候選卡（${done} / ${total}）`
      : isSim
        ? `已完成 ${done} / ${total} 組候選牌組實戰模擬（${pct}%）`
        : `已檢驗 ${done.toLocaleString('zh-TW')} / ${total.toLocaleString('zh-TW')} 張符合規則的卡牌（${pct}%）`;
    return `
      <div class="opt-modal">
        <div class="opt-progress-box">
          <div class="opt-progress-head">
            <div>
              <strong>${stageTitle}</strong>
              <p class="sub">${stageSub}</p>
            </div>
            <button class="btn btn-outline" type="button" data-action="cancel-deck-optimize">取消</button>
          </div>
          <div class="progress-track">
            <i style="width:${pct}%"></i>
          </div>
        </div>
      </div>
    `;
  }

  if (result) {
    const baseWr = (result.baseline.winRate * 100).toFixed(1);
    const bestWr = (result.best.winRate * 100).toFixed(1);
    const delta = (result.best.winRate - result.baseline.winRate) * 100;
    const isSameBest = result.best.isOriginal || result.best.card.id === result.targetCardId;
    const deltaText = isSameBest
      ? '已是最佳配置'
      : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% 預估勝率`;

    const topRows = result.topList.map((item, idx) => {
      const c = item.card;
      const wr = (item.winRate * 100).toFixed(1);
      const diff = (item.winRate - result.baseline.winRate) * 100;
      const diffStr = item.isOriginal ? '目前使用' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
      const typesHtml = cardPrimaryTypes(c).map((t) => renderEnergyToken(t.key, 'sm')).join('');
      const thumb = renderCardImgTag(c, 'opt-row-thumb', false);
      return `
        <li class="opt-rank-row ${idx === 0 ? 'is-best' : ''} ${item.isOriginal ? 'is-orig' : ''}">
          <span class="rank-num">#${idx + 1}</span>
          <span class="opt-row-thumb-wrap">${thumb}</span>
          <div class="opt-row-info">
            <div class="opt-row-title">
              <strong>${esc(c.name)}</strong>
              <span class="tokens-inline">${typesHtml}</span>
              ${item.isOriginal ? '<span class="pill-sub">原卡</span>' : ''}
            </div>
            <span class="sub">${esc(c.setName || c.set || '')}</span>
          </div>
          <div class="opt-row-stat">
            <strong>${wr}%</strong>
            <small class="${diff > 0.05 ? 'is-up' : ''}">${diffStr}</small>
          </div>
          <div class="opt-row-act">
            ${item.isOriginal
              ? '<span class="muted">目前牌組</span>'
              : `<button class="mini" type="button" data-action="apply-deck-optimize" data-new-id="${esc(c.id)}" data-mode="replace">採用此卡</button>`}
          </div>
        </li>
      `;
    }).join('');

    return `
      <div class="opt-modal">
        <div class="opt-compare-card">
          <div class="opt-compare-side">
            <span class="opt-side-tag">原本卡牌</span>
            <div class="opt-card-preview">${renderCardImgTag(result.origCard, 'opt-hero-img', false)}</div>
            <strong>${esc(result.origCard?.name || '')}</strong>
            <span class="opt-wr-num">${baseWr}%</span>
          </div>
          <div class="opt-compare-mid">
            <span class="opt-arrow" aria-hidden="true">→</span>
            <span class="opt-delta-pill ${isSameBest ? 'is-same' : delta >= 0 ? 'is-pos' : 'is-neg'}">${deltaText}</span>
          </div>
          <div class="opt-compare-side is-recommend">
            <span class="opt-side-tag is-accent">AI 建議填入</span>
            <div class="opt-card-preview">${renderCardImgTag(result.best.card, 'opt-hero-img', false)}</div>
            <strong>${esc(result.best.card?.name || '')}</strong>
            <span class="opt-wr-num is-accent">${bestWr}%</span>
          </div>
        </div>

        <div class="actions opt-hero-actions">
          ${isSameBest
            ? '<button class="btn btn-primary" type="button" data-action="reset-deck-optimize">挑選其他卡牌優化</button>'
            : `<button class="btn btn-primary" type="button" data-action="apply-deck-optimize" data-new-id="${esc(result.best.card.id)}" data-mode="replace">一鍵替換並儲存</button>
               <button class="btn btn-outline" type="button" data-action="apply-deck-optimize" data-new-id="${esc(result.best.card.id)}" data-mode="copy">另存為新牌組</button>
               <button class="btn btn-outline" type="button" data-action="reset-deck-optimize">改選其他卡牌</button>`}
        </div>

        <div class="opt-rank-section">
          <h3>高勝率替換推薦（前 ${result.topList.length} 名）</h3>
          <ul class="opt-rank-list">${topRows}</ul>
          <p class="sub opt-footnote">已為您遍歷檢驗全部 ${result.totalLegalChecked.toLocaleString('zh-TW')} 張符合組牌規則的卡牌，並以完整規則實戰篩選出最佳替換建議。</p>
        </div>
      </div>
    `;
  }

  const chosenCard = selectedCardId ? state.cardsById.get(selectedCardId) : null;
  const pickCardsHtml = deckEntries.map((entry) => {
    const c = entry.card;
    const isSel = selectedCardId === c.id;
    return `
      <button
        type="button"
        class="opt-pick-card ${isSel ? 'is-selected' : ''}"
        data-action="select-optimize-card"
        data-card-id="${esc(c.id)}"
        aria-pressed="${isSel ? 'true' : 'false'}"
      >
        <div class="opt-pick-img-wrap">
          ${renderCardImgTag(c, 'opt-pick-img', false)}
          <span class="opt-pick-qty">×${entry.count}</span>
        </div>
        <span class="opt-pick-name">${esc(c.name)}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="opt-modal">
      <p class="desc opt-intro">點選下方「<b>${esc(deck.name)}</b>」中的任一張卡牌，AI 會自動替換並檢驗全卡庫所有合法卡牌的實戰勝率，選出最適合填入的建議卡。</p>
      <div class="opt-pick-grid">${pickCardsHtml}</div>
      <div class="opt-start-bar">
        <span class="sub">${chosenCard ? `已選擇欲優化卡牌：<b>${esc(chosenCard.name)}</b>` : '請先點選一張欲優化的卡牌'}</span>
        <button class="btn btn-primary" type="button" data-action="start-deck-optimize" ${chosenCard ? '' : 'disabled'}>開始 AI 優化</button>
      </div>
    </div>
  `;
}
