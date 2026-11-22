import {
  aggregate,
  buildExplorationCandidates,
  computeCompositeWinRate,
  createEmptyExploreStats,
  DEEP_EXPLORE_GAMES,
  DEEP_GAMES_PER_OPPONENT,
  EXPLORE_CANDIDATE_COUNT,
  EXPLORE_GAMES_PER_OPPONENT,
  EXPLORE_TOTAL_GAMES,
  FIRST_SEAT_GAMES,
  GAMES_PER_OPPONENT,
  interval,
  isEngineImplementedStatus,
  mergeExploreChunkStats,
  synthesizeWinningStrategyFromStats,
  TOTAL_BATCH_GAMES,
  validOutcomes
} from './core.mjs';
import { esc, renderEnergyToken, renderPokemonSprites, resolveFeaturedPokemon } from './cardface.mjs';
import { saveRunRecord, state } from './data.mjs';

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 嘗試探測 M3 規則引擎 WASM 與運行器（主執行緒供即時覆蓋率與單局四階段回放）
export async function probeEngine() {
  if (state.runtimeFn) return { ready: true, runtime: state.runtimeFn };
  try {
    const [modRes, wasmRes] = await Promise.all([
      import('../battle/runtime.mjs'),
      fetch('battle/deckgym.wasm')
    ]);
    if (!wasmRes.ok) throw Error(`未找到 deckgym.wasm (${wasmRes.status})`);
    const bytes = await wasmRes.arrayBuffer();
    const compiled = await WebAssembly.compile(bytes);
    const fn = await modRes.instantiateBattle(compiled);
    state.wasmModule = compiled;
    state.wasmBytes = bytes;
    state.runtimeFn = fn;
    state.engineReady = true;
    state.engineError = '';
    return { ready: true, runtime: fn };
  } catch (err) {
    state.engineReady = false;
    state.engineError = `對戰模擬引擎尚未載入（${err?.message || 'WASM 初始化失敗'}），目前可瀏覽賽事前十牌組清單。`;
    return { ready: false, error: state.engineError };
  }
}

// 多執行緒 Web Worker 並行池：用於高效執行 100,000 局探索與 5,000 局正式對局測試
let sharedWorkerPool = null;
let sharedWorkerPoolPromise = null;

async function spawnWorkerPool() {
  if (typeof Worker === 'undefined') return null;
  const hw = Number(globalThis.navigator?.hardwareConcurrency || 4);
  const count = Math.max(2, Math.min(16, hw));
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
      else reject(Error(ev.data.error || `Worker #${idx} init failed`));
    };
    const onErr = (err) => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      reject(Error(err?.message || `Worker #${idx} error`));
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
    console.warn('[battle] Worker pool fallback to main thread:', err?.message || err);
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

async function getWorkerPool() {
  if (sharedWorkerPool) return sharedWorkerPool;
  if (!sharedWorkerPoolPromise) {
    sharedWorkerPoolPromise = spawnWorkerPool().then((pool) => {
      sharedWorkerPool = pool;
      return pool;
    });
  }
  return sharedWorkerPoolPromise;
}

async function runTasksWithPoolOrFallback(tasks, { runtime, signal, onResult }) {
  const pool = await getWorkerPool();
  if (pool) {
    await pool.runTasks(tasks, { signal, onResult });
    return pool.size;
  }
  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) break;
    const res = runtime(tasks[i].request);
    if (res?.error) throw Error(res.error);
    await onResult?.(res, tasks[i], i);
    await new Promise((r) => setTimeout(r, 0));
  }
  return 1;
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
      selected.push({
        rank,
        isSubstitute: rank > 10,
        entry
      });
    }
    if (selected.length >= 10 && rank >= 10) break;
  }
  return { selected, skipped };
}

export function renderGameStrip(opponentId, events = [], playable = false, gamesPerOpp = GAMES_PER_OPPONENT, actionName = 'replay-game', rangeStart = 0, rangeCount = null, totalAll = null) {
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
      const title = `第 ${idx + 1}/${totalLabel} 局（${sideLabel}第 ${numInSide} 局）· ${resName}${ev?.turns ? ` · ${ev.turns} 回合` : ''} — 點擊檢視完整流程`;
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

function renderWinningStrategyBanner(run, summary) {
  const ws = run.winningStrategy || null;
  const expCount = run.exploreStats?.completed ?? ws?.exploreTotal ?? run.exploreEvents?.length ?? 0;
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
          <strong>兩階段獲勝策略測試流程：第 1 階段（100,000 次探索對局提煉獲勝策略）→ 第 2 階段（5,000 次獲勝策略對局測試）</strong>
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
    ? `<span class="strategy-gain-pill ${gainPct >= 0 ? 'is-pos' : 'is-neg'}">第 2 階段 ${TOTAL_BATCH_GAMES.toLocaleString('zh-TW')} 局勝率 ${(testWrNum * 100).toFixed(1)}%（較探索期 ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%）</span>`
    : perfBadge;

  const topTags = (ws?.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip" title="原始權重 ${a.base} → 10 萬局勝局提煉獲勝策略權重 ${a.synthesized}">
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
          <strong>第一階段 · 100,000 次探索對局與獲勝策略提煉（已完成 ${expCount.toLocaleString('zh-TW')} / ${expTarget.toLocaleString('zh-TW')} 局 · ${expPct}%）</strong>
          <p class="sub">從 ${expCount.toLocaleString('zh-TW')} 次探索對局（${expWins.toLocaleString('zh-TW')}勝 ${expDraws.toLocaleString('zh-TW')}和 ${expLosses.toLocaleString('zh-TW')}敗，探索勝率 <b>${expWr}</b>）中，篩選並提取 <b>${eliteWins.toLocaleString('zh-TW')} 場高勝率勝利對局</b>綜合歸納出本牌組專屬「獲勝策略」，並投入第二階段 5,000 次正式對局測試。</p>
        </div>
        <div class="strategy-head-badges">${gainBadge}${gainPct != null && perfBadge ? perfBadge : ''}</div>
      </div>
      <div class="progress-track is-slim" aria-label="第一階段探索進度 ${expCount} / ${expTarget}">
        <i style="width:${expPct}%"></i>
      </div>
      ${topTags ? `<div class="card-prior-chips">${topTags}</div>` : ''}
      ${allRows ? `
        <details class="strategy-weights-details">
          <summary>展開檢視 10 萬局勝局綜合「獲勝策略」全部 22 維戰術權重對照表</summary>
          <div class="bench-table-wrap">
            <table class="bench-table">
              <thead><tr><th>戰術特徵</th><th>基礎模型權重</th><th>勝局提煉獲勝策略權重</th><th>勝局強化幅度</th></tr></thead>
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
        <strong>參戰牌組單卡千次訓練評估（全卡池 ${priorsDoc.totalCards || 4577} 張卡 · 每張卡 ≥${priorsDoc.minGamesPerCard || 1200} 局 / ≥${priorsDoc.minDecisionsPerCard || 2400} 次決策考量）</strong>
        <span>本牌組 ${distinct} 種卡牌累計參與訓練 <b>${totalGames.toLocaleString('zh-TW')}</b> 局 · <b>${totalEvals.toLocaleString('zh-TW')}</b> 次決策評估</span>
      </div>
      <div class="card-prior-chips">${topChips}</div>
    </div>
  `;
}

export function renderBattleReport(run, lineup, options = {}) {
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  const totalTarget = lineup.length * gamesPerOpp;
  const oppIds = lineup.map((x) => x.entry.id);
  const events = validOutcomes(run.events || [], oppIds, gamesPerOpp);
  const summary = computeCompositeWinRate(events, lineup, gamesPerOpp);
  const subCount = lineup.filter((x) => x.isSubstitute).length;
  const overallRate = summary.equalWinRate != null ? (summary.equalWinRate * 100).toFixed(1) + '%' : '—';
  const scoreRateText = summary.equalScoreRate != null ? (summary.equalScoreRate * 100).toFixed(1) + '%' : '—';
  const weightedRate = summary.weightedWinRate != null ? (summary.weightedWinRate * 100).toFixed(1) + '%' : '—';
  const weightedDelta = summary.weightedWinRate != null && summary.equalWinRate != null
    ? (summary.weightedWinRate - summary.equalWinRate) * 100
    : null;
  const weightedDeltaText = weightedDelta == null
    ? ''
    : `${weightedDelta >= 0 ? '+' : ''}${weightedDelta.toFixed(1)}% vs 等權`;
  const firstRate = summary.first.winRate != null ? (summary.first.winRate * 100).toFixed(1) + '%' : '—';
  const secondRate = summary.second.winRate != null ? (summary.second.winRate * 100).toFixed(1) + '%' : '—';
  const avgTurnsText = summary.avgTurns != null ? `${summary.avgTurns.toFixed(1)} 回合` : '—';
  const bestText = summary.bestMatchups[0]
    ? `#${summary.bestMatchups[0].rank} ${summary.bestMatchups[0].name} (${(summary.bestMatchups[0].winRate * 100).toFixed(0)}%)`
    : '—';
  const worstText = summary.worstMatchups[0]
    ? `#${summary.worstMatchups[0].rank} ${summary.worstMatchups[0].name} (${(summary.worstMatchups[0].winRate * 100).toFixed(0)}%)`
    : '—';
  const currentDeck = state.decks.find((d) => d.id === run.deckId) || state.decks[0] || null;
  const ws = run.winningStrategy || null;

  let rowsHtml = '';
  for (const item of lineup) {
    const opp = item.entry;
    const oppEvents = events.filter((e) => e.opponentId === opp.id);
    const firstEvs = oppEvents.filter((e) => (e.first != null ? e.first === 0 : e.index < half));
    const secondEvs = oppEvents.filter((e) => (e.first != null ? e.first === 1 : e.index >= half));
    const aggAll = aggregate(oppEvents);
    const agg1 = aggregate(firstEvs);
    const agg2 = aggregate(secondEvs);
    const winPct = aggAll.total ? ((aggAll.wins / aggAll.total) * 100).toFixed(1) + '%' : '—';
    const f1Pct = agg1.total ? ((agg1.wins / agg1.total) * 100).toFixed(0) + '%' : '—';
    const f2Pct = agg2.total ? ((agg2.wins / agg2.total) * 100).toFixed(0) + '%' : '—';
    const metaRate = opp.winRate != null ? (opp.winRate * 100).toFixed(1) + '%' : '—';
    const metaShare = opp.share != null ? (opp.share * 100).toFixed(1) + '%' : '—';
    const tokens = (opp.representative?.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('');
    const oppSprites = renderPokemonSprites(resolveFeaturedPokemon(opp.representative, state.cardsById, state.spriteMap), 'sm');
    const firstCompletedIdx = oppEvents.length > 0 ? oppEvents[0].index : 0;
    const oppExp = ws?.byOpponent?.[opp.id];
    const oppExpText = oppExp && oppExp.games > 0
      ? `探索 ${oppExp.games.toLocaleString('zh-TW')} 局取 ${oppExp.wins.toLocaleString('zh-TW')} 勝 (${(oppExp.winRate * 100).toFixed(1)}%)`
      : '探索待執行';

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
            <span>先攻 ${agg1.wins}-${agg1.losses}-${agg1.draws} (${f1Pct})</span>
            <span>後攻 ${agg2.wins}-${agg2.losses}-${agg2.draws} (${f2Pct})</span>
          </div>
          <div class="battle-opp-actions">
            ${!run.isDemo && options.canReplay ? `<button class="mini" type="button" data-action="run-single-opponent-deep" data-opp="${esc(opp.id)}">對此卡組單獨 100,000 探索 + 5,000 測試</button>` : ''}
            ${aggAll.total > 0 && options.canReplay ? `<button class="mini" type="button" data-action="replay-game" data-opp="${esc(opp.id)}" data-idx="${firstCompletedIdx}">檢視完整對局流程 (1–${aggAll.total}局)</button>` : ''}
          </div>
        </div>
        <div class="battle-strip-col">
          ${renderGameStrip(opp.id, oppEvents, Boolean(options.canReplay), gamesPerOpp)}
        </div>
        <div class="battle-opp-stat">
          <strong class="num-lg">${winPct}</strong>
          <span>${aggAll.wins}勝 ${aggAll.draws}和 ${aggAll.losses}敗 (${aggAll.total}/${gamesPerOpp}局)</span>
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
      ${renderWinningStrategyBanner(run, summary)}
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">${summary.complete ? `第二階段 · 採用獲勝策略正式綜合勝率（5,000 次對局測試 · 勝場 ÷ ${totalTarget.toLocaleString('zh-TW')}）` : `第二階段 · 採用獲勝策略對局測試中（已完成 ${summary.total.toLocaleString('zh-TW')} / ${totalTarget.toLocaleString('zh-TW')} 局）`}</span>
          <strong class="report-kpi-num">${overallRate}</strong>
          <span class="report-kpi-ci">95% Wilson 信賴區間 ${summary.equalCI95} · 和局計半積分率 ${scoreRateText} · 基礎模型：${esc(run.modelVersion || '未標註')}（已套用 100,000 局勝局提煉策略）</span>
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
          <span class="comp-label">先攻綜合勝率（前 2,500 局）</span>
          <strong class="comp-val">${firstRate}</strong>
          <small class="comp-sub">${summary.first.wins.toLocaleString('zh-TW')}勝 ${summary.first.draws.toLocaleString('zh-TW')}和 ${summary.first.losses.toLocaleString('zh-TW')}敗（共 ${summary.first.total.toLocaleString('zh-TW')} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">後攻綜合勝率（後 2,500 局）</span>
          <strong class="comp-val">${secondRate}</strong>
          <small class="comp-sub">${summary.second.wins.toLocaleString('zh-TW')}勝 ${summary.second.draws.toLocaleString('zh-TW')}和 ${summary.second.losses.toLocaleString('zh-TW')}敗（共 ${summary.second.total.toLocaleString('zh-TW')} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">對陣優劣與平均回合</span>
          <strong class="comp-val is-sm">${avgTurnsText}</strong>
          <small class="comp-sub">最優：${esc(bestText)}<br>苦戰：${esc(worstText)}</small>
        </div>
      </div>
      <div class="progress-track" aria-label="第二階段 5,000 局正式測試進度 ${summary.total} / ${totalTarget}">
        <i style="width:${Math.min(100, (summary.total / Math.max(1, totalTarget)) * 100).toFixed(1)}%"></i>
      </div>
      <div class="battle-matrix">${rowsHtml}</div>
    </div>
  `;
}

function translateActionLabel(raw) {
  const s = String(raw || '');
  if (s === 'EndTurn') return '結束回合 (EndTurn)';
  if (s === 'Noop') return '跳過 / 保持現狀 (Noop)';
  if (s === 'UseStadium') return '發動競技場效果 (UseStadium)';
  if (s.startsWith('Place(')) return `放置基礎寶可夢至場上 · ${s}`;
  if (s.startsWith('Evolve')) return `進化場上寶可夢 · ${s}`;
  if (s.startsWith('Attach')) return `自能量區附著能量 · ${s}`;
  if (s.startsWith('Play')) return `施放訓練家卡 · ${s}`;
  if (s.startsWith('UseAbility')) return `發動寶可夢特性 · ${s}`;
  if (s.startsWith('Retreat')) return `撤退戰鬥場寶可夢 · ${s}`;
  if (s.startsWith('Attack')) return `發動招式攻擊 · ${s}`;
  if (s.startsWith('Activate') || s.startsWith('ApplyDamage') || s.startsWith('Heal')) return `選擇效果目標 · ${s}`;
  return s;
}

function formatBoardSide(b) {
  if (!b) return '空場';
  const active = b.active || (b.name ? b : null);
  const name = active?.name || '空場';
  const hp = active?.hp != null ? `${active.hp}${active.maxHp ? `/${active.maxHp}` : ''}` : '0';
  const energy = active?.energy ?? 0;
  const benchCount = Array.isArray(b.bench) ? b.bench.length : (b.bench ?? 0);
  const hand = b.hand ?? 0;
  return `<b>${esc(name)}</b> (HP ${hp} · ${energy}能 · 備戰${benchCount} · 手牌${hand})`;
}

export function buildFullGameFlowModal({ opp, oppId, idx, run, deck, weights, customGamesPerOpp = null, customWeights = null, customSeedPrefix = null, replayAction = 'replay-game' }) {
  const gamesPerOpp = customGamesPerOpp || GAMES_PER_OPPONENT;
  const half = Math.floor(gamesPerOpp / 2);
  const ev = !customGamesPerOpp ? run?.events?.find((e) => e.opponentId === oppId && e.index === idx) : null;
  const seed = ev?.seed ?? fnv1a32(`${customSeedPrefix || run?.runId || 'demo'}:${oppId}:${idx}`);
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
          <span>第 <b>${(idx + 1).toLocaleString('zh-TW')}</b> / ${gamesPerOpp.toLocaleString('zh-TW')} 局 · ${esc(sideText)} · 種子 <code>0x${seed.toString(16).toUpperCase()}</code></span>
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

  const steps = Array.isArray(replayRes?.replay) ? replayRes.replay : [];
  const outcomeLabel = { win: '我方獲勝', loss: '對手獲勝', draw: '平局（30 回合上限）' }[replayRes.outcome] || replayRes.outcome;
  const outcomeCls = `is-${replayRes.outcome || 'draw'}`;
  const finalPts = Array.isArray(replayRes?.points) ? `${replayRes.points[0]} : ${replayRes.points[1]}` : '—';

  const setupSteps = steps.filter((s) => s.turn === 0);
  const combatSteps = steps.filter((s) => s.turn > 0);
  const byTurn = new Map();
  for (const s of combatSteps) {
    if (!byTurn.has(s.turn)) byTurn.set(s.turn, []);
    byTurn.get(s.turn).push(s);
  }

  const renderStepRow = (s, stepNum) => {
    const actorBadge = s.actor === 0
      ? '<span class="flow-actor is-me">我方 (獲勝策略)</span>'
      : '<span class="flow-actor is-opp">對手 (環境策略)</span>';
    const b0 = s.board?.[0];
    const b1 = s.board?.[1];
    const boardHtml = b0 && b1
      ? `<div class="flow-board-snap">
          <span>我方戰鬥場：${formatBoardSide(b0)}</span>
          <span>對手戰鬥場：${formatBoardSide(b1)}</span>
        </div>`
      : '';
    return `
      <li class="flow-step-item">
        <div class="flow-step-main">
          <span class="flow-step-idx">#${s.step || stepNum}</span>
          ${actorBadge}
          <span class="flow-action-text">${esc(translateActionLabel(s.action))}</span>
          <span class="flow-pts-pill">比數 ${(s.points || [0, 0]).join(' : ')}</span>
        </div>
        ${boardHtml}
      </li>
    `;
  };

  const setupHtml = setupSteps.length
    ? `<ol class="flow-step-list">${setupSteps.map((s, i) => renderStepRow(s, i + 1)).join('')}</ol>`
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
          ${tSteps.map((s, i) => renderStepRow(s, i + 1)).join('')}
        </ol>
      </div>
    `;
  }

  return `
    <div class="flow-modal">
      <div class="flow-nav-bar">
        <div class="flow-nav-info">
          <span class="flow-result-badge ${outcomeCls}">${esc(outcomeLabel)} (${esc(finalPts)})</span>
          <span>第 <b>${(idx + 1).toLocaleString('zh-TW')}</b> / ${gamesPerOpp.toLocaleString('zh-TW')} 局 · ${esc(sideText)}</span>
          <span>共 <b>${replayRes.turns || 0}</b> 回合 / <b>${steps.length}</b> 步動作 · 種子 <code>0x${seed.toString(16).toUpperCase()}</code></span>
        </div>
        <div class="flow-nav-btns">
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${prevIdx}">◀ 上一局 (#${prevIdx + 1})</button>
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${nextIdx}">下一局 (#${nextIdx + 1}) ▶</button>
        </div>
      </div>

      <div class="flow-stage-card">
        <h3>階段一 · 對局雙方牌表與 10 萬局勝局提煉獲勝策略配置</h3>
        <p class="sub">我方：<b>${esc(deck.name)}</b>（${(deck.energy || []).join('/')} · 採用 100,000 局勝局提煉獲勝策略） vs 對手：<b>${esc(opp.name)}</b>（${(opp.representative.energy || []).join('/')} · 基準模型 <code>${esc(run?.modelVersion || state.modelInfo?.version || 'selfplay-cem-v3')}</code>）</p>
      </div>

      <div class="flow-stage-card">
        <h3>階段二 · 開局準備階段（第 0 回合：起始手牌放置戰鬥場與備戰區）</h3>
        ${setupHtml}
      </div>

      <div class="flow-stage-card">
        <h3>階段三 · 逐回合完整對戰流程（第 1 回合 → 第 ${replayRes.turns || 0} 回合）</h3>
        <div class="flow-turns-scroll">${turnsHtml || '<p class="sub">無回合動作紀錄</p>'}</div>
      </div>

      <div class="flow-stage-card is-end">
        <h3>階段四 · 終局結算</h3>
        <p class="sub">最終判定：<b>${esc(outcomeLabel)}</b> · 最終得分 <b>${esc(finalPts)}</b> · 累計執行 <b>${steps.length}</b> 個合法引擎動作，完整重現種子 <code>0x${seed.toString(16).toUpperCase()}</code> 決策軌跡。</p>
      </div>
    </div>
  `;
}

// 單一對手卡組專項「先 100,000 次探索對局提煉獲勝策略 → 後 5,000 次正式對局測試」多執行緒執行器
export async function executeSingleOpponentDeep({ opp, deck, baseWeights, onProgress, signal }) {
  const { ready, runtime, error } = await probeEngine();
  if (!ready) throw Error(error);

  const deckPayload = { cards: deck.cards, energy: deck.energy };
  const enemyPayload = { id: opp.id, cards: opp.representative.cards, energy: opp.representative.energy };
  const candidates = buildExplorationCandidates(baseWeights, `single100k:${deck.id}:${opp.id}`, EXPLORE_CANDIDATE_COUNT);
  const stats = createEmptyExploreStats([opp.id], candidates.length);

  // 第一階段：100,000 局探索對局（100 塊 × 1,000 局，多執行緒 Worker 並行）
  const exploreChunkSize = 1000;
  const exploreTasks = [];
  for (let start = 0; start < DEEP_EXPLORE_GAMES; start += exploreChunkSize) {
    exploreTasks.push({
      start,
      request: {
        op: 'explore_chunk',
        deck: deckPayload,
        enemies: [enemyPayload],
        candidates,
        enemy_weights: baseWeights,
        seed_prefix: `single100k-exp:${deck.id}`,
        games_per_opponent: DEEP_EXPLORE_GAMES,
        start_game: start,
        count: Math.min(exploreChunkSize, DEEP_EXPLORE_GAMES - start)
      }
    });
  }

  const tExp0 = performance.now();
  let lastTick = 0;
  const workersUsed = await runTasksWithPoolOrFallback(exploreTasks, {
    runtime,
    signal,
    onResult: (res) => {
      mergeExploreChunkStats(stats, res);
      const now = performance.now();
      if (now - lastTick >= 120 || stats.completed >= DEEP_EXPLORE_GAMES) {
        lastTick = now;
        const elapsedSec = Math.max(0.05, (now - tExp0) / 1000);
        onProgress?.({
          phase: 'explore',
          done: stats.completed,
          total: DEEP_EXPLORE_GAMES,
          wins: stats.wins,
          gamesPerSec: stats.completed / elapsedSec,
          workers: sharedWorkerPool?.size || 1
        });
      }
    }
  });
  if (signal?.aborted) return null;

  const strategy = synthesizeWinningStrategyFromStats(stats, baseWeights, candidates);
  const winningWeights = strategy.byOpponent[opp.id]?.weights || strategy.weights;

  // 第二階段：5,000 局正式測試（先攻 2,500 + 後攻 2,500，20 塊 × 250 局並行）
  const testCount = DEEP_GAMES_PER_OPPONENT;
  const half = Math.floor(testCount / 2);
  const seedPrefix = `single5k-test:${deck.id}`;
  const testChunkSize = 250;
  const testTasks = [];
  for (let start = 0; start < testCount; start += testChunkSize) {
    testTasks.push({
      start,
      request: {
        op: 'test_chunk',
        deck: deckPayload,
        enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
        opponent_id: opp.id,
        weights: winningWeights,
        enemy_weights: baseWeights,
        seed_prefix: seedPrefix,
        start_idx: start,
        count: Math.min(testChunkSize, testCount - start),
        total_per_opp: testCount
      }
    });
  }

  const testEvents = new Array(testCount);
  let testDone = 0;
  const tTest0 = performance.now();
  await runTasksWithPoolOrFallback(testTasks, {
    runtime,
    signal,
    onResult: (res) => {
      const start = res.startIdx || 0;
      const str = res.outcomes || '';
      const turnsArr = res.turns || [];
      for (let k = 0; k < str.length; k++) {
        const idx = start + k;
        const ch = str[k];
        testEvents[idx] = {
          opponentId: opp.id,
          index: idx,
          first: idx < half ? 0 : 1,
          seed: fnv1a32(`${seedPrefix}:${opp.id}:${idx}`),
          outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw',
          turns: turnsArr[k] || 0
        };
      }
      testDone += str.length;
      const elapsedSec = Math.max(0.05, (performance.now() - tTest0) / 1000);
      onProgress?.({
        phase: 'test',
        done: testDone,
        total: testCount,
        gamesPerSec: testDone / elapsedSec,
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
    strategy,
    testEvents: testEvents.filter(Boolean),
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
            <strong>${isExplore ? `第一階段 · 正在對「${esc(opp.name)}」執行 100,000 次探索對局` : `第二階段 · 已提煉獲勝策略，正在執行 5,000 次正式對局測試`}</strong>
            <p class="sub">已完成 <b>${done.toLocaleString('zh-TW')}</b> / ${total.toLocaleString('zh-TW')} 局（${pct}%）${isExplore && wins != null ? ` · 已累計 ${wins.toLocaleString('zh-TW')} 場勝利對局` : ''} · 啟用 <b>${workers || 1}</b> 執行緒並行引擎（約 <b>${Math.round(gamesPerSec || 0).toLocaleString('zh-TW')}</b> 局/秒）</p>
          </div>
          <button class="btn btn-outline" type="button" data-action="cancel-single-deep">中止測試</button>
        </div>
        <div class="progress-track">
          <i style="width:${pct}%"></i>
        </div>
      </div>
    </div>
  `;
}

export function renderSingleOpponentDeepModal(deepResult, activeReplayIdx = 0) {
  const { opp, deck, baseWeights, winningWeights, strategy, testEvents, seedPrefix } = deepResult;
  const aggAll = aggregate(testEvents);
  const agg1 = aggregate(testEvents.filter((e) => e.first === 0));
  const agg2 = aggregate(testEvents.filter((e) => e.first === 1));
  const testWr = aggAll.total ? ((aggAll.wins / aggAll.total) * 100).toFixed(2) + '%' : '—';
  const expWr = ((strategy.exploreWinRate || 0) * 100).toFixed(2) + '%';
  const deltaPct = aggAll.total
    ? ((aggAll.wins / aggAll.total - (strategy.exploreWinRate || 0)) * 100).toFixed(2)
    : '0.00';
  const topChips = (strategy.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip"><b>${esc(a.labelZh)}</b> <small>${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(3)}</small></span>`
  ).join('');

  const pageSize = 500;
  const totalPages = Math.ceil(DEEP_GAMES_PER_OPPONENT / pageSize);
  const activePage = Math.min(totalPages - 1, Math.max(0, Math.floor(activeReplayIdx / pageSize)));
  const pageStart = activePage * pageSize;
  const pageEvents = testEvents.slice(pageStart, pageStart + pageSize);

  const pageTabs = Array.from({ length: totalPages }, (_, p) => {
    const s = p * pageSize + 1;
    const e = (p + 1) * pageSize;
    const side = p < totalPages / 2 ? '先' : '後';
    return `<button class="mini ${p === activePage ? 'is-active' : ''}" type="button" data-action="replay-single-deep" data-opp="${esc(opp.id)}" data-idx="${p * pageSize}">${side} ${s.toLocaleString('zh-TW')}–${e.toLocaleString('zh-TW')}</button>`;
  }).join('');

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
            <strong>第一階段 · 對此卡組已完成 100,000 次探索對局（篩選出 ${strategy.exploreWins.toLocaleString('zh-TW')} 場勝利對局，探索勝率 ${expWr}）</strong>
            <p class="sub">從 100,000 次對局的勝利對局（精英入選 ${strategy.eliteWinsSelected.toLocaleString('zh-TW')} 場）中綜合提煉針對「${esc(opp.name)}」的專屬獲勝策略，並執行第二階段 5,000 次正式對局測試。</p>
          </div>
          <span class="strategy-gain-pill ${Number(deltaPct) >= 0 ? 'is-pos' : 'is-neg'}">5,000 局測試勝率 ${testWr}（${Number(deltaPct) >= 0 ? '+' : ''}${deltaPct}% vs 探索期）</span>
        </div>
        <div class="card-prior-chips">${topChips}</div>
      </div>

      <div class="flow-stage-card">
        <h3>第二階段 · 採用獲勝策略進行 5,000 次對局測試結果（${aggAll.wins.toLocaleString('zh-TW')}勝 ${aggAll.draws.toLocaleString('zh-TW')}和 ${aggAll.losses.toLocaleString('zh-TW')}敗 · 勝率 ${testWr} · 95% CI ${interval(aggAll.wins, aggAll.total)}）</h3>
        <p class="sub">先攻 2,500 局：<b>${agg1.wins.toLocaleString('zh-TW')}勝 ${agg1.draws.toLocaleString('zh-TW')}和 ${agg1.losses.toLocaleString('zh-TW')}敗 (${((agg1.wins / Math.max(1, agg1.total)) * 100).toFixed(1)}%)</b> · 後攻 2,500 局：<b>${agg2.wins.toLocaleString('zh-TW')}勝 ${agg2.draws.toLocaleString('zh-TW')}和 ${agg2.losses.toLocaleString('zh-TW')}敗 (${((agg2.wins / Math.max(1, agg2.total)) * 100).toFixed(1)}%)</b> — 切換下方 5,000 局分頁點陣並點擊任意一格檢視該局完整流程：</p>
        <div class="deep-page-tabs">${pageTabs}</div>
        ${renderGameStrip(opp.id, pageEvents, true, pageSize, 'replay-single-deep', pageStart, pageSize, DEEP_GAMES_PER_OPPONENT)}
      </div>

      ${flowHtml}
    </div>
  `;
}

// 執行兩階段真實對戰模擬佇列（多執行緒並行 WASM）：
// 第 1 階段：先採取 100,000 次對局（10 對手 × 10,000 局），取其中勝利的局綜合為獲勝策略
// 第 2 階段：後續採取這個獲勝策略再進行 5,000 次的對局測試（10 對手 × 500 局，每局皆有完整流程）
export async function executeBattleBatch({ run, deck, lineup, weights, onTick, signal }) {
  const { ready, runtime, error } = await probeEngine();
  if (!ready) throw Error(error);

  const deckPayload = { cards: deck.cards, energy: deck.energy };
  const enemiesPayload = lineup.map((item) => ({
    id: item.entry.id,
    cards: item.entry.representative.cards,
    energy: item.entry.representative.energy
  }));
  const oppIds = enemiesPayload.map((e) => e.id);
  const candidates = buildExplorationCandidates(weights, `batch100k:${deck.id}:${run.season || 'C1'}`, EXPLORE_CANDIDATE_COUNT);

  if (!Array.isArray(run.events)) run.events = [];
  if (!run.exploreStats || run.exploreStats.byCandidate?.length !== candidates.length || run.exploreStats.byOpponent?.length !== oppIds.length) {
    run.exploreStats = createEmptyExploreStats(oppIds, candidates.length);
  }
  // 確保舊版 exploreEvents 不再佔用 IndexedDB 空間
  delete run.exploreEvents;

  // ============================================================================
  // 第一階段：100,000 次探索對局（10 對手 × 10,000 局，20 組候選配對種子，並行分塊）
  // ============================================================================
  const completedChunks = new Set(run.exploreStats.completedChunks || []);
  const exploreChunkSize = 1000;
  const exploreTasks = [];
  for (let start = 0; start < EXPLORE_TOTAL_GAMES; start += exploreChunkSize) {
    if (completedChunks.has(start)) continue;
    exploreTasks.push({
      start,
      request: {
        op: 'explore_chunk',
        deck: deckPayload,
        enemies: enemiesPayload,
        candidates,
        enemy_weights: weights,
        seed_prefix: `${run.runId}:exp100k`,
        games_per_opponent: EXPLORE_GAMES_PER_OPPONENT,
        start_game: start,
        count: Math.min(exploreChunkSize, EXPLORE_TOTAL_GAMES - start)
      }
    });
  }

  if (exploreTasks.length > 0) {
    const t0 = performance.now();
    const baseDone = run.exploreStats.completed || 0;
    let lastUiTick = 0;
    let chunksSinceSave = 0;

    await runTasksWithPoolOrFallback(exploreTasks, {
      runtime,
      signal,
      onResult: async (res) => {
        mergeExploreChunkStats(run.exploreStats, res);
        run.winningStrategy = synthesizeWinningStrategyFromStats(run.exploreStats, weights, candidates);
        chunksSinceSave++;
        const now = performance.now();
        const deltaGames = (run.exploreStats.completed || 0) - baseDone;
        const elapsedSec = Math.max(0.05, (now - t0) / 1000);
        run._livePerf = {
          workers: sharedWorkerPool?.size || 1,
          gamesPerSec: deltaGames / elapsedSec,
          phase: 'explore'
        };
        if (chunksSinceSave >= 5 || run.exploreStats.completed >= EXPLORE_TOTAL_GAMES) {
          chunksSinceSave = 0;
          await saveRunRecord(run);
        }
        if (now - lastUiTick >= 140 || run.exploreStats.completed >= EXPLORE_TOTAL_GAMES) {
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
  // 第二階段：採用提煉出的「獲勝策略」進行 5,000 次正式對局測試（10 對手 × 500 局）
  // ============================================================================
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  const existingTest = new Set(run.events.map((e) => `${e.opponentId}#${e.index}`));
  const testChunkSize = 250;
  const testTasks = [];

  for (const item of lineup) {
    const opp = item.entry;
    const oppStrategyWeights = run.winningStrategy?.byOpponent?.[opp.id]?.weights
      || run.winningStrategy?.weights
      || weights;
    for (let start = 0; start < gamesPerOpp; start += testChunkSize) {
      const count = Math.min(testChunkSize, gamesPerOpp - start);
      let needChunk = false;
      for (let i = start; i < start + count; i++) {
        if (!existingTest.has(`${opp.id}#${i}`)) {
          needChunk = true;
          break;
        }
      }
      if (!needChunk) continue;
      testTasks.push({
        opp,
        start,
        request: {
          op: 'test_chunk',
          deck: deckPayload,
          enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
          opponent_id: opp.id,
          weights: oppStrategyWeights,
          enemy_weights: weights,
          seed_prefix: run.runId,
          start_idx: start,
          count,
          total_per_opp: gamesPerOpp
        }
      });
    }
  }

  if (testTasks.length > 0) {
    const tTest0 = performance.now();
    const baseTestDone = run.events.length;
    let lastUiTick = 0;

    await runTasksWithPoolOrFallback(testTasks, {
      runtime,
      signal,
      onResult: async (res, task) => {
        const oppId = res.opponentId || task.opp.id;
        const start = res.startIdx ?? task.start;
        const outcomes = res.outcomes || '';
        const turns = res.turns || [];
        for (let k = 0; k < outcomes.length; k++) {
          const idx = start + k;
          const key = `${oppId}#${idx}`;
          if (existingTest.has(key)) continue;
          const ch = outcomes[k];
          run.events.push({
            opponentId: oppId,
            index: idx,
            first: idx < half ? 0 : 1,
            seed: fnv1a32(`${run.runId}:${oppId}:${idx}`),
            outcome: ch === 'W' ? 'win' : ch === 'L' ? 'loss' : 'draw',
            turns: turns[k] || 0
          });
          existingTest.add(key);
        }
        const now = performance.now();
        const elapsedSec = Math.max(0.05, (now - tTest0) / 1000);
        run._livePerf = {
          workers: sharedWorkerPool?.size || 1,
          gamesPerSec: (run.events.length - baseTestDone) / elapsedSec,
          phase: 'test'
        };
        if (now - lastUiTick >= 120 || run.events.length >= TOTAL_BATCH_GAMES) {
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

// 僅在 ?fixture=1 下用於 UI 樣式驗收的演示點陣生成器（100,000 局探索 + 5,000 局測試）
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  const oppIds = lineup.map((x) => x.entry.id);
  const baseW = Array(22).fill(0.5);
  const candidates = buildExplorationCandidates(baseW, 'fixture100k', EXPLORE_CANDIDATE_COUNT);
  if (!run.exploreStats || run.exploreStats.completed < EXPLORE_TOTAL_GAMES) {
    const stats = createEmptyExploreStats(oppIds, candidates.length);
    stats.completed = EXPLORE_TOTAL_GAMES;
    stats.wins = 47200;
    stats.draws = 3600;
    stats.losses = 49200;
    stats.byCandidate.forEach((c, idx) => {
      c.games = 5000;
      c.wins = 2250 + (idx % 5) * 85;
      c.draws = 180;
      c.losses = c.games - c.wins - c.draws;
    });
    stats.byOpponent.forEach((o, idx) => {
      o.games = EXPLORE_GAMES_PER_OPPONENT;
      o.wins = 4400 + (idx % 5) * 180;
      o.draws = 360;
      o.losses = o.games - o.wins - o.draws;
      o.byCandidate.forEach((bc, cIdx) => {
        bc.games = 500;
        bc.wins = 220 + (cIdx % 5) * 9;
        bc.draws = 18;
        bc.losses = bc.games - bc.wins - bc.draws;
      });
    });
    run.exploreStats = stats;
    run.winningStrategy = synthesizeWinningStrategyFromStats(stats, baseW, candidates);
  }
  const existing = new Set((run.events || []).map((e) => `${e.opponentId}#${e.index}`));
  for (const item of lineup) {
    const opp = item.entry;
    for (let index = 0; index < gamesPerOpp; index++) {
      if (signal.aborted) return run;
      const key = `${opp.id}#${index}`;
      if (existing.has(key)) continue;
      const seed = fnv1a32(`preview:${run.runId}:${opp.id}:${index}`);
      const r = (seed % 1000) / 1000;
      const firstBonus = index < half ? 0.04 : -0.04;
      const outcome = r < (0.52 + firstBonus) ? 'win' : r < 0.94 ? 'loss' : 'draw';
      run.events.push({
        opponentId: opp.id,
        index,
        first: index < half ? 0 : 1,
        seed,
        outcome,
        turns: 6 + (seed % 11)
      });
      existing.add(key);
      if (run.events.length % 500 === 0 || run.events.length === TOTAL_BATCH_GAMES) {
        onTick(run);
        await new Promise((r) => setTimeout(r, 12));
      }
    }
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}
