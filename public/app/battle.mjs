import { aggregate, computeCompositeWinRate, interval, isEngineImplementedStatus, validOutcomes } from './core.mjs';
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

export function renderGameStrip(opponentId, events = [], playable = false) {
  const byIndex = new Map();
  for (const e of events) byIndex.set(e.index, e);
  const makeHalf = (start, end, sideLabel) => {
    let cells = '';
    for (let i = start; i < end; i++) {
      const ev = byIndex.get(i);
      const cls = ev ? `is-${ev.outcome}` : 'is-pending';
      const resName = ev ? ({ win: '勝', loss: '敗', draw: '和' }[ev.outcome] || ev.outcome) : '未執行';
      const title = `${sideLabel}第 ${(i % 25) + 1} 局 · ${resName}${ev?.turns ? ` (${ev.turns} 回合)` : ''}`;
      if (playable && ev) {
        cells += `<button class="dot-cell ${cls}" type="button" data-action="replay-game" data-opp="${esc(opponentId)}" data-idx="${i}" aria-label="${esc(title)}" title="${esc(title)}"></button>`;
      } else {
        cells += `<span class="dot-cell ${cls}" aria-label="${esc(title)}" title="${esc(title)}"></span>`;
      }
    }
    return `<div class="strip-half">${cells}</div>`;
  };
  return `<div class="game-strip" role="group" aria-label="50 局勝負點陣（左 25 先攻，右 25 後攻）">
    ${makeHalf(0, 25, '先攻')}
    <span class="strip-gap" aria-hidden="true"></span>
    ${makeHalf(25, 50, '後攻')}
  </div>`;
}

export function renderBattleReport(run, lineup, options = {}) {
  const oppIds = lineup.map((x) => x.entry.id);
  const events = validOutcomes(run.events || [], oppIds);
  const summary = computeCompositeWinRate(events, lineup);
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

  let rowsHtml = '';
  for (const item of lineup) {
    const opp = item.entry;
    const oppEvents = events.filter((e) => e.opponentId === opp.id);
    const firstEvs = oppEvents.filter((e) => e.index < 25);
    const secondEvs = oppEvents.filter((e) => e.index >= 25);
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
            <span>先攻 ${agg1.wins}-${agg1.losses}-${agg1.draws} (${f1Pct})</span>
            <span>後攻 ${agg2.wins}-${agg2.losses}-${agg2.draws} (${f2Pct})</span>
          </div>
        </div>
        <div class="battle-strip-col">
          ${renderGameStrip(opp.id, oppEvents, Boolean(options.canReplay))}
        </div>
        <div class="battle-opp-stat">
          <strong class="num-lg">${winPct}</strong>
          <span>${aggAll.wins}勝 ${aggAll.draws}和 ${aggAll.losses}敗</span>
          <small>95% 信賴區間 ${interval(aggAll.wins, aggAll.total)}</small>
        </div>
      </div>
    `;
  }

  return `
    <div class="report-shell ${run.isDemo ? 'is-demo' : ''}">
      ${run.isDemo ? '<div class="status-note is-warn">以下為 ?fixture=1 預覽模式下的展示點陣（非真實規則引擎對局結果）。</div>' : ''}
      ${subCount > 0 ? `<div class="status-note">本次模擬含 ${subCount} 個遞補對手（部分原始前十牌表包含規則引擎尚未實裝的卡牌）。</div>` : ''}
      <div class="report-hero">
        <div class="report-kpi">
          <span class="report-kpi-label">${summary.complete ? '正式綜合模擬勝率（等權 10×50 局 · 勝場 ÷ 500）' : `進行中綜合勝率（已完成 ${summary.total} / 500 局）`}</span>
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
      <div class="progress-track" aria-label="模擬進度 ${summary.total} / 500">
        <i style="width:${(summary.total / 5).toFixed(1)}%"></i>
      </div>
      <div class="battle-matrix">${rowsHtml}</div>
    </div>
  `;
}

// 執行真實對戰模擬佇列（支援批量運算與中斷續跑）
export async function executeBattleBatch({ run, deck, lineup, weights, onTick, signal }) {
  const { ready, runtime, error } = await probeEngine();
  if (!ready) throw Error(error);

  const deckPayload = { cards: deck.cards, energy: deck.energy };
  const existing = new Set((run.events || []).map((e) => `${e.opponentId}#${e.index}`));
  const pending = [];

  for (const item of lineup) {
    const opp = item.entry;
    for (let index = 0; index < 50; index++) {
      const key = `${opp.id}#${index}`;
      if (existing.has(key)) continue;
      pending.push({
        opp,
        index,
        first: index < 25 ? 0 : 1,
        seed: fnv1a32(`${run.runId}:${opp.id}:${index}`)
      });
    }
  }

  const chunkSize = 10;
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

// 仅在 ?fixture=1 下用于 UI 样式验收的演示点阵生成器
export async function executeFixturePreviewBatch({ run, lineup, onTick, signal }) {
  const existing = new Set((run.events || []).map((e) => `${e.opponentId}#${e.index}`));
  for (const item of lineup) {
    const opp = item.entry;
    for (let index = 0; index < 50; index++) {
      if (signal.aborted) return run;
      const key = `${opp.id}#${index}`;
      if (existing.has(key)) continue;
      const seed = fnv1a32(`preview:${run.runId}:${opp.id}:${index}`);
      const r = (seed % 1000) / 1000;
      const firstBonus = index < 25 ? 0.04 : -0.04;
      const outcome = r < (0.48 + firstBonus) ? 'win' : r < 0.94 ? 'loss' : 'draw';
      run.events.push({
        opponentId: opp.id,
        index,
        first: index < 25 ? 0 : 1,
        seed,
        outcome,
        turns: 6 + (seed % 11)
      });
      existing.add(key);
      if (run.events.length % 10 === 0 || run.events.length === 500) {
        onTick(run);
        await new Promise((r) => setTimeout(r, 18));
      }
    }
  }
  await saveRunRecord(run);
  onTick(run);
  return run;
}
