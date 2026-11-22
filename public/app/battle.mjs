import {
  aggregate,
  buildExplorationCandidates,
  computeCompositeWinRate,
  DEEP_GAMES_PER_OPPONENT,
  EXPLORE_GAMES_PER_OPPONENT,
  EXPLORE_TOTAL_GAMES,
  FIRST_SEAT_GAMES,
  GAMES_PER_OPPONENT,
  interval,
  isEngineImplementedStatus,
  synthesizeWinningStrategy,
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

// 嘗試探測 M3 規則引擎 WASM 與運行器
export async function probeEngine() {
  if (state.runtimeFn) return { ready: true, runtime: state.runtimeFn };
  try {
    const [modRes, wasmRes] = await Promise.all([
      import('../battle/runtime.mjs'),
      fetch('battle/deckgym.wasm')
    ]);
    if (!wasmRes.ok) throw Error(`未找到 deckgym.wasm (${wasmRes.status})`);
    const bytes = await wasmRes.arrayBuffer();
    const fn = await modRes.instantiateBattle(bytes);
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

export function renderGameStrip(opponentId, events = [], playable = false, gamesPerOpp = GAMES_PER_OPPONENT, actionName = 'replay-game') {
  const half = Math.floor(gamesPerOpp / 2);
  const is500 = gamesPerOpp >= 200;
  const byIndex = new Map();
  for (const e of events) byIndex.set(e.index, e);
  const makeHalf = (start, end, sideLabel) => {
    let cells = '';
    for (let i = start; i < end; i++) {
      const ev = byIndex.get(i);
      const cls = ev ? `is-${ev.outcome}` : 'is-pending';
      const resName = ev ? ({ win: '勝', loss: '敗', draw: '和' }[ev.outcome] || ev.outcome) : '未執行';
      const numInSide = (i - start) + 1;
      const title = `第 ${i + 1}/${gamesPerOpp} 局（${sideLabel}第 ${numInSide} 局）· ${resName}${ev?.turns ? ` · ${ev.turns} 回合` : ''} — 點擊檢視完整流程`;
      const cellCls = `dot-cell ${is500 ? 'is-500 ' : ''}${cls}`;
      if (playable && ev) {
        cells += `<button class="${cellCls}" type="button" data-action="${actionName}" data-opp="${esc(opponentId)}" data-idx="${i}" aria-label="${esc(title)}" title="${esc(title)}"></button>`;
      } else {
        cells += `<span class="${cellCls}" aria-label="${esc(title)}" title="${esc(title)}"></span>`;
      }
    }
    return `<div class="strip-half ${is500 ? 'is-250' : ''}">${cells}</div>`;
  };
  return `<div class="game-strip ${is500 ? 'is-500' : ''}" role="group" aria-label="${gamesPerOpp} 局勝負點陣（左 ${half} 先攻，右 ${half} 後攻）">
    ${makeHalf(0, half, '先攻')}
    <span class="strip-gap ${is500 ? 'is-500' : ''}" aria-hidden="true"></span>
    ${makeHalf(half, gamesPerOpp, '後攻')}
  </div>`;
}

function renderWinningStrategyBanner(run, summary) {
  const exploreEvents = run.exploreEvents || [];
  const ws = run.winningStrategy || null;
  const expCount = exploreEvents.length;
  const expTarget = EXPLORE_TOTAL_GAMES;
  const expPct = Math.min(100, (expCount / expTarget) * 100).toFixed(1);

  if (!expCount && !ws) {
    return `
      <div class="strategy-synth-banner is-pending">
        <div class="strategy-synth-head">
          <strong>兩階段獲勝策略測試流程：第 1 階段（1,000 次探索對局提煉獲勝策略）→ 第 2 階段（500 次獲勝策略對局測試）</strong>
          <span>待啟動</span>
        </div>
      </div>
    `;
  }

  const expWins = ws?.exploreWins ?? exploreEvents.filter((e) => e.outcome === 'win').length;
  const expDraws = ws?.exploreDraws ?? exploreEvents.filter((e) => e.outcome === 'draw').length;
  const expLosses = ws?.exploreLosses ?? (expCount - expWins - expDraws);
  const expWr = expCount ? ((expWins / expCount) * 100).toFixed(1) + '%' : '—';
  const eliteWins = ws?.eliteWinsSelected || expWins;
  const testWrNum = summary?.equalWinRate;
  const baseExpWrNum = ws?.exploreWinRate ?? (expCount ? expWins / expCount : null);
  const gainPct = testWrNum != null && baseExpWrNum != null
    ? (testWrNum - baseExpWrNum) * 100
    : null;
  const gainBadge = gainPct != null
    ? `<span class="strategy-gain-pill ${gainPct >= 0 ? 'is-pos' : 'is-neg'}">第 2 階段 500 局勝率 ${(testWrNum * 100).toFixed(1)}%（較探索期 ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%）</span>`
    : '';

  const topTags = (ws?.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip" title="原始權重 ${a.base} → 勝局提煉獲勝策略權重 ${a.synthesized}">
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
          <strong>第一階段 · 1,000 次探索對局與獲勝策略提煉（已完成 ${expCount.toLocaleString('zh-TW')} / ${expTarget.toLocaleString('zh-TW')} 局）</strong>
          <p class="sub">從 ${expCount.toLocaleString('zh-TW')} 次探索對局（${expWins}勝 ${expDraws}和 ${expLosses}敗，探索勝率 <b>${expWr}</b>）中，提取 <b>${eliteWins} 場高勝率勝利對局</b>綜合歸納出本牌組專屬「獲勝策略」，並投入第二階段 500 次正式對局測試。</p>
        </div>
        ${gainBadge}
      </div>
      <div class="progress-track is-slim" aria-label="第一階段探索進度 ${expCount} / ${expTarget}">
        <i style="width:${expPct}%"></i>
      </div>
      ${topTags ? `<div class="card-prior-chips">${topTags}</div>` : ''}
      ${allRows ? `
        <details class="strategy-weights-details">
          <summary>展開檢視勝局綜合「獲勝策略」全部 22 維戰術權重對照表</summary>
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
    const oppExpText = oppExp
      ? `探索${oppExp.games}局取${oppExp.wins}勝 (${(oppExp.winRate * 100).toFixed(0)}%)`
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
            ${!run.isDemo && options.canReplay ? `<button class="mini" type="button" data-action="run-single-opponent-deep" data-opp="${esc(opp.id)}">對此卡組單獨 1,000 探索 + 500 測試</button>` : ''}
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
          <span class="report-kpi-label">${summary.complete ? `第二階段 · 採用獲勝策略正式綜合勝率（500 次對局測試 · 勝場 ÷ ${totalTarget}）` : `第二階段 · 採用獲勝策略對局測試中（已完成 ${summary.total} / ${totalTarget} 局）`}</span>
          <strong class="report-kpi-num">${overallRate}</strong>
          <span class="report-kpi-ci">95% Wilson 信賴區間 ${summary.equalCI95} · 和局計半積分率 ${scoreRateText} · 基礎模型：${esc(run.modelVersion || '未標註')}（已套用 1,000 局勝局提煉策略）</span>
        </div>
        <div class="report-totals">
          <div class="tot-box is-win"><b>${summary.wins}</b><span>勝</span></div>
          <div class="tot-box is-draw"><b>${summary.draws}</b><span>和</span></div>
          <div class="tot-box is-loss"><b>${summary.losses}</b><span>敗</span></div>
        </div>
      </div>
      <div class="composite-kpi-grid" aria-label="模擬綜合勝率多維度指標">
        <div class="comp-card is-accent">
          <span class="comp-label">環境使用率加權綜合勝率</span>
          <strong class="comp-val">${weightedRate}</strong>
          <small class="comp-sub">依前十賽場占比（合計 ${(summary.top10TotalShare * 100).toFixed(1)}%）加權${weightedDeltaText ? ` · ${weightedDeltaText}` : ''}</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">先攻綜合勝率（前 250 局）</span>
          <strong class="comp-val">${firstRate}</strong>
          <small class="comp-sub">${summary.first.wins}勝 ${summary.first.draws}和 ${summary.first.losses}敗（共 ${summary.first.total} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">後攻綜合勝率（後 250 局）</span>
          <strong class="comp-val">${secondRate}</strong>
          <small class="comp-sub">${summary.second.wins}勝 ${summary.second.draws}和 ${summary.second.losses}敗（共 ${summary.second.total} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">對陣優劣與平均回合</span>
          <strong class="comp-val is-sm">${avgTurnsText}</strong>
          <small class="comp-sub">最優：${esc(bestText)}<br>苦戰：${esc(worstText)}</small>
        </div>
      </div>
      <div class="progress-track" aria-label="第二階段 500 局正式測試進度 ${summary.total} / ${totalTarget}">
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

export function buildFullGameFlowModal({ opp, oppId, idx, run, deck, weights, customGamesPerOpp = null, customWeights = null, customSeedPrefix = null, replayAction = 'replay-game' }) {
  const gamesPerOpp = customGamesPerOpp || GAMES_PER_OPPONENT;
  const half = Math.floor(gamesPerOpp / 2);
  const ev = !customGamesPerOpp ? run?.events?.find((e) => e.opponentId === oppId && e.index === idx) : null;
  const seed = ev?.seed ?? fnv1a32(`${customSeedPrefix || run?.runId || 'demo'}:${oppId}:${idx}`);
  const first = idx < half ? 0 : 1;
  const sideText = first === 0 ? `我方先攻（先攻第 ${idx + 1}/${half} 局）` : `我方後攻（後攻第 ${idx - half + 1}/${half} 局）`;
  const prevIdx = (idx - 1 + gamesPerOpp) % gamesPerOpp;
  const nextIdx = (idx + 1) % gamesPerOpp;

  if (!state.engineReady || !state.runtimeFn || !opp?.representative || !deck) {
    return `
      <div class="flow-modal">
        <div class="flow-nav-bar">
          <span>第 <b>${idx + 1}</b> / ${gamesPerOpp} 局 · ${esc(sideText)} · 種子 <code>0x${seed.toString(16).toUpperCase()}</code></span>
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
          <span>我方戰鬥場：<b>${esc(b0.name)}</b> (HP ${b0.hp} · ${b0.energy}能 · 備戰${b0.bench} · 手牌${b0.hand})</span>
          <span>對手戰鬥場：<b>${esc(b1.name)}</b> (HP ${b1.hp} · ${b1.energy}能 · 備戰${b1.bench} · 手牌${b1.hand})</span>
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
          <span>第 <b>${idx + 1}</b> / ${gamesPerOpp} 局 · ${esc(sideText)}</span>
          <span>共 <b>${replayRes.turns || 0}</b> 回合 / <b>${steps.length}</b> 步動作 · 種子 <code>0x${seed.toString(16).toUpperCase()}</code></span>
        </div>
        <div class="flow-nav-btns">
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${prevIdx}">◀ 上一局 (#${prevIdx + 1})</button>
          <button class="btn btn-outline" type="button" data-action="${replayAction}" data-opp="${esc(oppId)}" data-idx="${nextIdx}">下一局 (#${nextIdx + 1}) ▶</button>
        </div>
      </div>

      <div class="flow-stage-card">
        <h3>階段一 · 對局雙方牌表與勝局提煉獲勝策略配置</h3>
        <p class="sub">我方：<b>${esc(deck.name)}</b>（${(deck.energy || []).join('/')} · 採用 1,000 局勝局提煉獲勝策略） vs 對手：<b>${esc(opp.name)}</b>（${(opp.representative.energy || []).join('/')} · 基準模型 <code>${esc(run?.modelVersion || state.modelInfo?.version || 'selfplay-cem-v3')}</code>）</p>
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

// 單一對手卡組專項「先 1,000 次探索對局提煉獲勝策略 → 後 500 次正式對局測試」完整執行器
export function executeSingleOpponent1000And500({ opp, deck, baseWeights }) {
  if (!state.runtimeFn) throw Error('規則引擎尚未就緒');
  const runtime = state.runtimeFn;
  const deckPayload = { cards: deck.cards, energy: deck.energy };
  const enemyPayload = { cards: opp.representative.cards, energy: opp.representative.energy };
  const candidates = buildExplorationCandidates(baseWeights, `single:${deck.id}:${opp.id}`, 10);

  // 第 1 階段：針對該對手卡組進行 1,000 次探索對局（先攻 500 + 後攻 500，10 組候選 × 100 局配對種子）
  const exploreReq = [];
  const exploreMeta = [];
  for (let i = 0; i < EXPLORE_TOTAL_GAMES; i++) {
    const candIdx = i % candidates.length;
    const pairIdx = Math.floor(i / candidates.length); // 0..99
    const first = pairIdx < 50 ? 0 : 1;
    const seed = fnv1a32(`single-exp:${deck.id}:${opp.id}:${pairIdx % 50}`);
    exploreReq.push({
      op: 'game',
      deck: deckPayload,
      enemy: enemyPayload,
      weights: candidates[candIdx],
      enemy_weights: baseWeights,
      seed,
      first,
      track_features: true
    });
    exploreMeta.push({
      opponentId: opp.id,
      index: i,
      first,
      seed,
      candidateIdx: candIdx,
      candidateWeights: candidates[candIdx]
    });
  }
  const expRes = runtime({ op: 'batch', games: exploreReq });
  if (expRes?.error) throw Error(expRes.error);
  const exploreEvents = (expRes.results || []).map((r, i) => ({
    ...exploreMeta[i],
    outcome: r.outcome,
    turns: r.turns,
    featureAdvantage: r.featureAdvantage
  }));

  // 從 1,000 局中取勝利的對局綜合提煉為針對該對手的獲勝策略
  const strategy = synthesizeWinningStrategy(exploreEvents, baseWeights, candidates);
  const winningWeights = strategy.byOpponent[opp.id]?.weights || strategy.weights;

  // 第 2 階段：後續採取該獲勝策略進行 500 次正式對局測試（先攻 250 + 後攻 250）
  const testCount = DEEP_GAMES_PER_OPPONENT;
  const half = Math.floor(testCount / 2);
  const seedPrefix = `single-test:${deck.id}:${opp.id}`;
  const testReq = [];
  for (let i = 0; i < testCount; i++) {
    const first = i < half ? 0 : 1;
    const seed = fnv1a32(`${seedPrefix}:${opp.id}:${i}`);
    testReq.push({
      op: 'game',
      deck: deckPayload,
      enemy: enemyPayload,
      weights: winningWeights,
      enemy_weights: baseWeights,
      seed,
      first,
      replay: false
    });
  }
  const testRes = runtime({ op: 'batch', games: testReq });
  if (testRes?.error) throw Error(testRes.error);
  const testEvents = (testRes.results || []).map((r, i) => ({
    opponentId: opp.id,
    index: i,
    first: i < half ? 0 : 1,
    seed: fnv1a32(`${seedPrefix}:${opp.id}:${i}`),
    outcome: r.outcome,
    turns: r.turns
  }));

  return {
    opp,
    deck,
    baseWeights,
    winningWeights,
    strategy,
    testEvents,
    seedPrefix
  };
}

export function renderSingleOpponentDeepModal(deepResult, activeReplayIdx = 0) {
  const { opp, deck, baseWeights, winningWeights, strategy, testEvents, seedPrefix } = deepResult;
  const aggAll = aggregate(testEvents);
  const agg1 = aggregate(testEvents.filter((e) => e.first === 0));
  const agg2 = aggregate(testEvents.filter((e) => e.first === 1));
  const testWr = aggAll.total ? ((aggAll.wins / aggAll.total) * 100).toFixed(1) + '%' : '—';
  const expWr = ((strategy.exploreWinRate || 0) * 100).toFixed(1) + '%';
  const deltaPct = aggAll.total
    ? ((aggAll.wins / aggAll.total - (strategy.exploreWinRate || 0)) * 100).toFixed(1)
    : '0.0';
  const topChips = (strategy.topAdjustments || []).map((a) =>
    `<span class="card-prior-chip"><b>${esc(a.labelZh)}</b> <small>${a.delta >= 0 ? '+' : ''}${a.delta.toFixed(3)}</small></span>`
  ).join('');

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
            <strong>第一階段 · 對此卡組已完成 1,000 次探索對局（篩選出 ${strategy.exploreWins} 場勝利對局，探索勝率 ${expWr}）</strong>
            <p class="sub">從 1,000 次對局的勝利對局（精英入選 ${strategy.eliteWinsSelected} 場）中綜合提煉針對「${esc(opp.name)}」的專屬獲勝策略，並執行第二階段 500 次正式對局測試。</p>
          </div>
          <span class="strategy-gain-pill ${Number(deltaPct) >= 0 ? 'is-pos' : 'is-neg'}">500 局測試勝率 ${testWr}（${Number(deltaPct) >= 0 ? '+' : ''}${deltaPct}% vs 探索期）</span>
        </div>
        <div class="card-prior-chips">${topChips}</div>
      </div>

      <div class="flow-stage-card">
        <h3>第二階段 · 採用獲勝策略進行 500 次對局測試結果（${aggAll.wins}勝 ${aggAll.draws}和 ${aggAll.losses}敗 · 勝率 ${testWr} · 95% CI ${interval(aggAll.wins, aggAll.total)}）</h3>
        <p class="sub">先攻 250 局：<b>${agg1.wins}勝 ${agg1.draws}和 ${agg1.losses}敗 (${((agg1.wins / Math.max(1, agg1.total)) * 100).toFixed(1)}%)</b> · 後攻 250 局：<b>${agg2.wins}勝 ${agg2.draws}和 ${agg2.losses}敗 (${((agg2.wins / Math.max(1, agg2.total)) * 100).toFixed(1)}%)</b> — 點擊下方 500 格點陣任意一格可切換檢視該局完整流程：</p>
        ${renderGameStrip(opp.id, testEvents, true, DEEP_GAMES_PER_OPPONENT, 'replay-single-deep')}
      </div>

      ${flowHtml}
    </div>
  `;
}

// 執行兩階段真實對戰模擬佇列：
// 第 1 階段：先採取 1,000 次對局（10 對手 × 100 局），取其中勝利的局綜合為獲勝策略
// 第 2 階段：後續採取這個獲勝策略再進行 500 次的對局測試（10 對手 × 50 局，每局皆有完整流程）
export async function executeBattleBatch({ run, deck, lineup, weights, onTick, signal }) {
  const { ready, runtime, error } = await probeEngine();
  if (!ready) throw Error(error);

  const deckPayload = { cards: deck.cards, energy: deck.energy };
  if (!Array.isArray(run.exploreEvents)) run.exploreEvents = [];
  if (!Array.isArray(run.events)) run.events = [];

  const candidates = buildExplorationCandidates(weights, `batch:${deck.id}:${run.season || 'C1'}`, 10);

  // ============================================================================
  // 第一階段：1,000 次探索對局（每個對手 100 局：先攻 50 + 後攻 50，10 組候選配對種子）
  // ============================================================================
  const existingExplore = new Set(run.exploreEvents.map((e) => `${e.opponentId}#${e.index}`));
  const pendingExplore = [];
  for (const item of lineup) {
    const opp = item.entry;
    for (let index = 0; index < EXPLORE_GAMES_PER_OPPONENT; index++) {
      const key = `${opp.id}#${index}`;
      if (existingExplore.has(key)) continue;
      const candIdx = index % candidates.length;
      const pairIdx = Math.floor(index / candidates.length); // 0..9
      const first = pairIdx < 5 ? 0 : 1;
      const seed = fnv1a32(`${run.runId}:explore:${opp.id}:${pairIdx % 5}`);
      pendingExplore.push({
        opp,
        index,
        first,
        seed,
        candIdx,
        candWeights: candidates[candIdx]
      });
    }
  }

  const exploreChunkSize = 200;
  for (let offset = 0; offset < pendingExplore.length; offset += exploreChunkSize) {
    if (signal.aborted) return run;
    const chunk = pendingExplore.slice(offset, offset + exploreChunkSize);
    const gamesReq = chunk.map((item) => ({
      op: 'game',
      deck: deckPayload,
      enemy: { cards: item.opp.representative.cards, energy: item.opp.representative.energy },
      weights: item.candWeights,
      enemy_weights: weights,
      seed: item.seed,
      first: item.first,
      track_features: true
    }));

    const batchRes = runtime({ op: 'batch', games: gamesReq });
    if (batchRes?.error) throw Error(`探索階段批次模擬失敗：${batchRes.error}`);
    const results = batchRes?.results || [];
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const res = results[i];
      if (!res || res.error) {
        throw Error(`${item.opp.name} 探索第 ${item.index + 1} 局出錯：${res?.error || '未知結果'}`);
      }
      run.exploreEvents.push({
        opponentId: item.opp.id,
        index: item.index,
        first: item.first,
        seed: item.seed,
        candidateIdx: item.candIdx,
        outcome: res.outcome,
        turns: res.turns,
        featureAdvantage: res.featureAdvantage
      });
      existingExplore.add(`${item.opp.id}#${item.index}`);
    }

    run.winningStrategy = synthesizeWinningStrategy(run.exploreEvents, weights, candidates);
    await saveRunRecord(run);
    onTick(run);
    await new Promise((r) => setTimeout(r, 0));
  }

  if (!run.winningStrategy || run.exploreEvents.length > 0) {
    run.winningStrategy = synthesizeWinningStrategy(run.exploreEvents, weights, candidates);
  }

  // ============================================================================
  // 第二階段：採用提煉出的「獲勝策略」進行 500 次正式對局測試（10 對手 × 50 局）
  // ============================================================================
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  const existingTest = new Set(run.events.map((e) => `${e.opponentId}#${e.index}`));
  const pendingTest = [];

  for (const item of lineup) {
    const opp = item.entry;
    const oppStrategyWeights = run.winningStrategy?.byOpponent?.[opp.id]?.weights
      || run.winningStrategy?.weights
      || weights;
    for (let index = 0; index < gamesPerOpp; index++) {
      const key = `${opp.id}#${index}`;
      if (existingTest.has(key)) continue;
      pendingTest.push({
        opp,
        index,
        first: index < half ? 0 : 1,
        seed: fnv1a32(`${run.runId}:${opp.id}:${index}`),
        playerWeights: oppStrategyWeights
      });
    }
  }

  const testChunkSize = 100;
  for (let offset = 0; offset < pendingTest.length; offset += testChunkSize) {
    if (signal.aborted) return run;
    const chunk = pendingTest.slice(offset, offset + testChunkSize);
    const gamesReq = chunk.map((item) => ({
      op: 'game',
      deck: deckPayload,
      enemy: { cards: item.opp.representative.cards, energy: item.opp.representative.energy },
      weights: item.playerWeights,
      enemy_weights: weights,
      seed: item.seed,
      first: item.first,
      replay: false
    }));

    const batchRes = runtime({ op: 'batch', games: gamesReq });
    if (batchRes?.error) throw Error(`獲勝策略測試階段失敗：${batchRes.error}`);
    const results = batchRes?.results || [];
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const res = results[i];
      if (!res || res.error) {
        throw Error(`${item.opp.name} 測試第 ${item.index + 1} 局出錯：${res?.error || '未知結果'}`);
      }
      run.events.push({
        opponentId: item.opp.id,
        index: item.index,
        first: item.first,
        seed: item.seed,
        outcome: res.outcome,
        turns: res.turns
      });
      existingTest.add(`${item.opp.id}#${item.index}`);
    }

    await saveRunRecord(run);
    onTick(run);
    await new Promise((r) => setTimeout(r, 0));
  }

  await saveRunRecord(run);
  onTick(run);
  return run;
}

// 僅在 ?fixture=1 下用於 UI 樣式驗收的演示點陣生成器（1,000 局探索 + 500 局測試）
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  if (!Array.isArray(run.exploreEvents)) run.exploreEvents = [];
  const baseW = Array(22).fill(0.5);
  const candidates = buildExplorationCandidates(baseW, 'fixture', 10);
  if (run.exploreEvents.length < EXPLORE_TOTAL_GAMES) {
    run.exploreEvents = [];
    for (const item of lineup) {
      const opp = item.entry;
      for (let i = 0; i < EXPLORE_GAMES_PER_OPPONENT; i++) {
        const seed = fnv1a32(`preview-exp:${run.runId}:${opp.id}:${i}`);
        const outcome = (seed % 100) < 47 ? 'win' : (seed % 100) < 93 ? 'loss' : 'draw';
        run.exploreEvents.push({
          opponentId: opp.id,
          index: i,
          first: i < 50 ? 0 : 1,
          seed,
          candidateIdx: i % 10,
          outcome,
          turns: 8
        });
      }
    }
    run.winningStrategy = synthesizeWinningStrategy(run.exploreEvents, baseW, candidates);
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
      if (run.events.length % 50 === 0 || run.events.length === TOTAL_BATCH_GAMES) {
        onTick(run);
        await new Promise((r) => setTimeout(r, 12));
      }
    }
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}
