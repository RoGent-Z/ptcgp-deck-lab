import {
  aggregate,
  computeCompositeWinRate,
  FIRST_SEAT_GAMES,
  GAMES_PER_OPPONENT,
  interval,
  isEngineImplementedStatus,
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

export function renderGameStrip(opponentId, events = [], playable = false, gamesPerOpp = GAMES_PER_OPPONENT) {
  const half = Math.floor(gamesPerOpp / 2);
  const byIndex = new Map();
  for (const e of events) byIndex.set(e.index, e);
  const makeHalf = (start, end, sideLabel) => {
    let cells = '';
    for (let i = start; i < end; i++) {
      const ev = byIndex.get(i);
      const cls = ev ? `is-${ev.outcome}` : 'is-pending';
      const resName = ev ? ({ win: '勝', loss: '敗', draw: '和' }[ev.outcome] || ev.outcome) : '未執行';
      const numInSide = (i - start) + 1;
      const title = `第 ${i + 1}/500 局（${sideLabel}第 ${numInSide} 局）· ${resName}${ev?.turns ? ` · ${ev.turns} 回合` : ''} — 點擊檢視完整流程`;
      if (playable && ev) {
        cells += `<button class="dot-cell is-500 ${cls}" type="button" data-action="replay-game" data-opp="${esc(opponentId)}" data-idx="${i}" aria-label="${esc(title)}" title="${esc(title)}"></button>`;
      } else {
        cells += `<span class="dot-cell is-500 ${cls}" aria-label="${esc(title)}" title="${esc(title)}"></span>`;
      }
    }
    return `<div class="strip-half is-250">${cells}</div>`;
  };
  return `<div class="game-strip is-500" role="group" aria-label="${gamesPerOpp} 局勝負點陣（左 ${half} 先攻，右 ${half} 後攻）">
    ${makeHalf(0, half, '先攻')}
    <span class="strip-gap is-500" aria-hidden="true"></span>
    ${makeHalf(half, gamesPerOpp, '後攻')}
  </div>`;
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
            <span>先攻250局 ${agg1.wins}-${agg1.losses}-${agg1.draws} (${f1Pct})</span>
            <span>後攻250局 ${agg2.wins}-${agg2.losses}-${agg2.draws} (${f2Pct})</span>
          </div>
          <div class="battle-opp-actions">
            ${aggAll.total < gamesPerOpp && !run.isDemo ? `<button class="mini" type="button" data-action="run-single-opponent" data-opp="${esc(opp.id)}">模擬此對手 500 局 (${aggAll.total}/500)</button>` : ''}
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
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">${summary.complete ? `正式綜合模擬勝率（每對手 ${gamesPerOpp} 局 · 10×${gamesPerOpp} 共 ${totalTarget.toLocaleString('zh-TW')} 局）` : `進行中綜合勝率（已完成 ${summary.total.toLocaleString('zh-TW')} / ${totalTarget.toLocaleString('zh-TW')} 局 · 每對手 ${gamesPerOpp} 局）`}</span>
          <strong class="report-kpi-num">${overallRate}</strong>
          <span class="report-kpi-ci">95% Wilson 信賴區間 ${summary.equalCI95} · 和局計半積分率 ${scoreRateText} · 模型：${esc(run.modelVersion || '未標註')}</span>
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
          <span class="comp-label">先攻綜合勝率（每對手 ${half} 局）</span>
          <strong class="comp-val">${firstRate}</strong>
          <small class="comp-sub">${summary.first.wins}勝 ${summary.first.draws}和 ${summary.first.losses}敗（共 ${summary.first.total} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">後攻綜合勝率（每對手 ${half} 局）</span>
          <strong class="comp-val">${secondRate}</strong>
          <small class="comp-sub">${summary.second.wins}勝 ${summary.second.draws}和 ${summary.second.losses}敗（共 ${summary.second.total} 局）</small>
        </div>
        <div class="comp-card">
          <span class="comp-label">對陣優劣與平均回合</span>
          <strong class="comp-val is-sm">${avgTurnsText}</strong>
          <small class="comp-sub">最優：${esc(bestText)}<br>苦戰：${esc(worstText)}</small>
        </div>
      </div>
      <div class="progress-track" aria-label="模擬進度 ${summary.total} / ${totalTarget}">
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

export function buildFullGameFlowModal({ opp, oppId, idx, run, deck, weights }) {
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  const ev = run?.events?.find((e) => e.opponentId === oppId && e.index === idx);
  const seed = ev?.seed ?? fnv1a32(`${run?.runId || 'demo'}:${oppId}:${idx}`);
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

  const replayRes = state.runtimeFn({
    op: 'game',
    deck: { cards: deck.cards, energy: deck.energy },
    enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
    weights,
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
      ? '<span class="flow-actor is-me">我方</span>'
      : '<span class="flow-actor is-opp">對手</span>';
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
          <button class="btn btn-outline" type="button" data-action="replay-game" data-opp="${esc(oppId)}" data-idx="${prevIdx}">◀ 上一局 (#${prevIdx + 1})</button>
          <button class="btn btn-outline" type="button" data-action="replay-game" data-opp="${esc(oppId)}" data-idx="${nextIdx}">下一局 (#${nextIdx + 1}) ▶</button>
        </div>
      </div>

      <div class="flow-stage-card">
        <h3>階段一 · 對局雙方牌表與模型配置</h3>
        <p class="sub">我方：<b>${esc(deck.name)}</b>（${(deck.energy || []).join('/')}） vs 對手：<b>${esc(opp.name)}</b>（${(opp.representative.energy || []).join('/')}） · 決策模型：<code>${esc(run?.modelVersion || state.modelInfo?.version || 'selfplay-cem-v3')}</code></p>
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

// 執行真實對戰模擬佇列（每對手 500 局，支援全 10 對手 5,000 局或單一對手 500 局及中斷續跑）
export async function executeBattleBatch({ run, deck, lineup, weights, onTick, signal, onlyOpponentId = null }) {
  const { ready, runtime, error } = await probeEngine();
  if (!ready) throw Error(error);

  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
  const deckPayload = { cards: deck.cards, energy: deck.energy };
  const existing = new Set((run.events || []).map((e) => `${e.opponentId}#${e.index}`));
  const pending = [];

  for (const item of lineup) {
    const opp = item.entry;
    if (onlyOpponentId && opp.id !== onlyOpponentId) continue;
    for (let index = 0; index < gamesPerOpp; index++) {
      const key = `${opp.id}#${index}`;
      if (existing.has(key)) continue;
      pending.push({
        opp,
        index,
        first: index < half ? 0 : 1,
        seed: fnv1a32(`${run.runId}:${opp.id}:${index}`)
      });
    }
  }

  const chunkSize = 50;
  for (let offset = 0; offset < pending.length; offset += chunkSize) {
    if (signal.aborted) return run;
    const chunk = pending.slice(offset, offset + chunkSize);
    const gamesReq = chunk.map((item) => ({
      op: 'game',
      deck: deckPayload,
      enemy: { cards: item.opp.representative.cards, energy: item.opp.representative.energy },
      weights,
      seed: item.seed,
      first: item.first,
      replay: false
    }));

    const batchRes = runtime({ op: 'batch', games: gamesReq });
    if (batchRes?.error) throw Error(`批次模擬失敗：${batchRes.error}`);
    const results = batchRes?.results || [];
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const res = results[i];
      if (!res || res.error) {
        throw Error(`${item.opp.name} 第 ${item.index + 1} 局出錯：${res?.error || '未知結果'}`);
      }
      run.events.push({
        opponentId: item.opp.id,
        index: item.index,
        first: item.first,
        seed: item.seed,
        outcome: res.outcome,
        turns: res.turns
      });
      existing.add(`${item.opp.id}#${item.index}`);
    }

    await saveRunRecord(run);
    onTick(run);
    await new Promise((r) => setTimeout(r, 0));
  }

  await saveRunRecord(run);
  onTick(run);
  return run;
}

// 僅在 ?fixture=1 下用於 UI 樣式驗收的演示點陣生成器（每對手 500 局，共 5,000 局）
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const gamesPerOpp = GAMES_PER_OPPONENT;
  const half = FIRST_SEAT_GAMES;
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
      const outcome = r < (0.48 + firstBonus) ? 'win' : r < 0.94 ? 'loss' : 'draw';
      run.events.push({
        opponentId: opp.id,
        index,
        first: index < half ? 0 : 1,
        seed,
        outcome,
        turns: 6 + (seed % 11)
      });
      existing.add(key);
      if (run.events.length % 250 === 0 || run.events.length === TOTAL_BATCH_GAMES) {
        onTick(run);
        await new Promise((r) => setTimeout(r, 12));
      }
    }
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}
