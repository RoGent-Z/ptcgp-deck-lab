export const energyNames = {Grass:'草', Fire:'火', Water:'水', Lightning:'雷', Psychic:'超', Fighting:'鬥', Darkness:'惡', Metal:'鋼'};
export const typeNames = {...energyNames, Colorless:'無色', Dragon:'龍', Fairy:'妖精', Trainer:'訓練家'};
export const titleCase = value => String(value || '').toLowerCase().replace(/^./, s => s.toUpperCase());
export const normalizeFeaturedPokemon = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const slug = String(item || '').trim().toLowerCase();
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= 3) break;
  }
  return out;
};
export const freshDeck = () => ({id:crypto.randomUUID(),name:'未命名牌組',cards:[],energy:[],featuredPokemon:[],customOrder:false,updatedAt:new Date().toISOString()});
export function readDeckFile(text) {
  if (text.length>250000) throw Error('牌表檔案過大');
  const input=JSON.parse(text), obj=input.deck || input;
  if (!obj || typeof obj.name!=='string' || !obj.name.trim() || obj.name.length>150 || !Array.isArray(obj.cards) || !Array.isArray(obj.energy) || obj.cards.length>150) throw Error('牌表格式錯誤，請匯入本站匯出的 JSON 牌表');
  const counts=new Map();
  for(const entry of obj.cards){
    if(!entry || typeof entry.id!=='string' || !/^[A-Z0-9a-z-]{1,22}$/.test(entry.id) || !Number.isInteger(entry.count) || entry.count<1 || entry.count>99) throw Error('卡號或張數無效');
    counts.set(entry.id,(counts.get(entry.id)||0)+entry.count);
    if(counts.get(entry.id)>99) throw Error('重複紀錄的合計張數超出範圍');
  }
  const energy=[...new Set(obj.energy.map(titleCase))];
  if(energy.length>3 || energy.some(k=>!Object.hasOwn(energyNames,k))) throw Error('能量區設定無效');
  const res={name:obj.name.trim(),cards:[...counts].map(([id,count])=>({id,count})),energy};
  if(Array.isArray(obj.featuredPokemon)){
    const fp=normalizeFeaturedPokemon(obj.featuredPokemon);
    if(fp.length) res.featuredPokemon=fp;
  }
  if(obj.customOrder) res.customOrder=true;
  return res;
}
export function validateDeck(deck, byId) {
  const issues=[], names=new Map();
  let amount=0, basics=0;
  for(const {id,count} of deck.cards){
    amount+=count; const card=byId.get(id);
    if(!card){issues.push('無法辨識卡號 '+id);continue;}
    if(card.legal===false || card.playable===false) issues.push(card.name+' 不適用於目前標準賽制');
    const name=card.limitName || card.nameEn || card.name;
    names.set(name,{name:card.name,count:(names.get(name)?.count||0)+count});
    if(card.type==='pokemon' && card.stage==='basic') basics+=count;
  }
  if(amount!==20) issues.unshift('需要 20 張卡，目前 '+amount+' 張');
  if(!basics) issues.push('至少需要 1 張基礎寶可夢');
  for(const entry of names.values()) if(entry.count>2) issues.push(entry.name+' 同名合計 '+entry.count+' 張，上限 2 張');
  if(!deck.energy.length || deck.energy.length>3 || deck.energy.some(k=>!Object.hasOwn(energyNames,titleCase(k)))) issues.push('請選擇 1–3 種能量');
  return issues;
}
export function normalizeSearch(text, map={}) {
  return Array.from(String(text||'').normalize('NFKC').toLowerCase()).map(ch=>map[ch]||ch).join('').replace(/[\s·•・－-]/g,'');
}
export const EXPLORE_TOTAL_GAMES = 1000000000;
export const EXPLORE_GAMES_PER_OPPONENT = 100000000;
export const EXPLORE_CANDIDATE_COUNT = 40;
export const GAMES_PER_OPPONENT = 500000;
export const FIRST_SEAT_GAMES = 250000;
export const TOTAL_BATCH_GAMES = 5000000;
export const DEEP_EXPLORE_GAMES = 1000000000;
export const DEEP_GAMES_PER_OPPONENT = 5000000;

export const FULL_MODEL_PROFILE = Object.freeze({
  id: '1b5m',
  label: '1B5M全量模型',
  exploreLabel: '10 億局',
  testLabel: '500 萬局',
  exploreTotalGames: 1000000000,
  exploreGamesPerOpponent: 100000000,
  gamesPerOpponent: 500000,
  firstSeatGames: 250000,
  totalBatchGames: 5000000,
  deepExploreGames: 1000000000,
  deepGamesPerOpponent: 5000000
});

export const LITE_MODEL_PROFILE = Object.freeze({
  id: '1m5q',
  label: '1M5Q轻量模型',
  exploreLabel: '100 萬局',
  testLabel: '5,000 局',
  exploreTotalGames: 1000000,
  exploreGamesPerOpponent: 100000,
  gamesPerOpponent: 500,
  firstSeatGames: 250,
  totalBatchGames: 5000,
  deepExploreGames: 1000000,
  deepGamesPerOpponent: 5000
});

export function resolveModelSimProfile(modelOrRun) {
  const sp = modelOrRun?.simProfile || modelOrRun?.metaEntry?.simProfile;
  if (sp && Number(sp.exploreTotalGames) > 0 && Number(sp.totalBatchGames) > 0) {
    return {
      ...FULL_MODEL_PROFILE,
      ...sp,
      firstSeatGames: sp.firstSeatGames ?? Math.floor(sp.gamesPerOpponent / 2)
    };
  }
  const tag = String(modelOrRun?.id || modelOrRun?.modelId || modelOrRun?.version || modelOrRun?.modelVersion || '').toLowerCase();
  if (tag.includes('1m5q') || tag.includes('lite')) return { ...LITE_MODEL_PROFILE };
  return { ...FULL_MODEL_PROFILE };
}

export function isAndroidOrMobileEnv() {
  if (typeof window !== 'undefined' && (window.Capacitor?.isNativePlatform?.() || typeof window.PocketLabNative !== 'undefined')) return true;
  if (typeof navigator !== 'undefined' && /Android|Mobile/i.test(navigator.userAgent || '')) return true;
  return false;
}

export const FEATURE_NAMES_22 = [
  'endTurn', 'noop', 'place', 'activePower', 'evolve', 'evolutionPower',
  'abilityOrStadium', 'trainer', 'drawAtLowHand', 'attack', 'baseDamage',
  'estimatedKnockout', 'attackEffect', 'attach', 'attachActive', 'energyDemand',
  'attachTargetPower', 'retreat', 'protectEndangeredActive', 'activationTarget',
  'toolOrHeal', 'targetedDamage'
];

export const FEATURE_LABELS_ZH = {
  endTurn: '結束回合控制',
  noop: '等待與保留動作',
  place: '基礎寶可夢鋪場',
  activePower: '戰鬥場戰力優先',
  evolve: '進化節奏推進',
  evolutionPower: '高戰力主力進化',
  abilityOrStadium: '特性與競技場發動',
  trainer: '訓練家卡施放',
  drawAtLowHand: '低手牌濾牌抽濾',
  attack: '積極進攻傾向',
  baseDamage: '高基礎傷害優先',
  estimatedKnockout: '精確擊倒 (KO) 判斷',
  attackEffect: '招式附加效果利用',
  attach: '能量區附能節奏',
  attachActive: '戰鬥場優先附能',
  energyDemand: '招式能量缺口補足',
  attachTargetPower: '高輸出主力養能',
  retreat: '主動撤退傾向',
  protectEndangeredActive: '殘血主力撤退保護',
  activationTarget: '技能目標價值評估',
  toolOrHeal: '道具裝備與回血續航',
  targetedDamage: '後排狙擊與點傷追擊'
};

function hashSeed32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededRandom(label) {
  let st = hashSeed32(String(label));
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let x = Math.imul(st ^ (st >>> 15), 1 | st);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function roundW(v) {
  return Math.round(Math.max(-8, Math.min(8, v)) * 1e6) / 1e6;
}

// 產生探索階段候選策略集（保留原模型於 index 0，並展開多維度戰術變體）
export function buildExplorationCandidates(baseWeights, seedLabel = 'explore', candidateCount = 25) {
  const base = Array.isArray(baseWeights) && baseWeights.length === 22
    ? baseWeights.map(Number)
    : Array(22).fill(0);
  const rand = seededRandom(seedLabel);
  const list = [[...base]];

  // 預設 6 組針對不同牌組型態的定向戰術強化模板
  const templates = [
    { name: '快攻搶分型', deltas: { place: 0.35, activePower: 0.3, attack: 0.4, baseDamage: 0.35, estimatedKnockout: 0.45, attachActive: 0.3 } },
    { name: '進化養成型', deltas: { evolve: 0.5, evolutionPower: 0.45, drawAtLowHand: 0.35, energyDemand: 0.35, attachTargetPower: 0.3, protectEndangeredActive: 0.3 } },
    { name: '特性與狙擊控制型', deltas: { abilityOrStadium: 0.45, targetedDamage: 0.5, activationTarget: 0.35, trainer: 0.3, estimatedKnockout: 0.35 } },
    { name: '續航聯防反擊型', deltas: { protectEndangeredActive: 0.55, toolOrHeal: 0.45, retreat: 0.25, energyDemand: 0.3, evolutionPower: 0.3 } },
    { name: '高速濾牌展開型', deltas: { trainer: 0.45, drawAtLowHand: 0.5, place: 0.4, attach: 0.35, evolve: 0.35 } },
    { name: '高傷終結爆發型', deltas: { estimatedKnockout: 0.6, baseDamage: 0.45, attachTargetPower: 0.4, attackEffect: 0.3 } }
  ];

  for (const tpl of templates) {
    if (list.length >= candidateCount) break;
    const w = base.map((val, idx) => {
      const fname = FEATURE_NAMES_22[idx];
      return roundW(val + (tpl.deltas[fname] || 0));
    });
    list.push(w);
  }

  while (list.length < candidateCount) {
    const w = base.map((val, idx) => {
      const u1 = Math.max(1e-9, rand());
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const scale = idx <= 1 ? 0.12 : 0.28;
      return roundW(val + z * scale);
    });
    list.push(w);
  }
  return list;
}

// 從 1,000 次探索對局中篩選「勝利的對局」綜合提煉為獲勝策略
export function synthesizeWinningStrategy(exploreEvents = [], baseWeights = [], candidates = []) {
  const base = Array.isArray(baseWeights) && baseWeights.length === 22
    ? baseWeights.map(Number)
    : Array(22).fill(0);
  const total = exploreEvents.length;
  const winGames = exploreEvents.filter((e) => e.outcome === 'win');
  const drawGames = exploreEvents.filter((e) => e.outcome === 'draw');
  const lossGames = exploreEvents.filter((e) => e.outcome === 'loss');

  // 統計各候選策略在 1,000 局探索對局中的實測表現
  const candStats = new Map();
  for (const ev of exploreEvents) {
    const cid = ev.candidateIdx ?? 0;
    const cur = candStats.get(cid) || { cid, games: 0, wins: 0, draws: 0 };
    cur.games++;
    if (ev.outcome === 'win') cur.wins++;
    else if (ev.outcome === 'draw') cur.draws++;
    candStats.set(cid, cur);
  }
  const rankedCands = [...candStats.values()]
    .map((s) => ({ ...s, winRate: s.wins / Math.max(1, s.games), scoreRate: (s.wins + 0.5 * s.draws) / Math.max(1, s.games) }))
    .sort((a, b) => b.scoreRate - a.scoreRate || b.winRate - a.winRate);

  const topEliteIds = new Set(rankedCands.slice(0, Math.min(3, Math.max(1, rankedCands.length))).map((s) => s.cid));
  const maxGlobalScore = rankedCands[0]?.scoreRate ?? 0.5;
  const baseCandStat = candStats.get(0);
  const baseExploreWinRate = baseCandStat && baseCandStat.games > 0
    ? baseCandStat.wins / baseCandStat.games
    : (total ? winGames.length / total : 0);

  const synthesizeFromSubset = (subsetAll, useGlobalElites = false) => {
    const allWins = subsetAll.filter((e) => e.outcome === 'win');
    const subsetLosses = subsetAll.filter((e) => e.outcome === 'loss');
    if (!allWins.length) return [...base];

    const subCandStats = new Map();
    for (const ev of subsetAll) {
      const cid = ev.candidateIdx ?? 0;
      const cur = subCandStats.get(cid) || { cid, games: 0, wins: 0, draws: 0 };
      cur.games++;
      if (ev.outcome === 'win') cur.wins++;
      else if (ev.outcome === 'draw') cur.draws++;
      subCandStats.set(cid, cur);
    }
    const subRanked = [...subCandStats.values()]
      .map((s) => ({ ...s, scoreRate: (s.wins + 0.5 * s.draws) / Math.max(1, s.games) }))
      .sort((a, b) => b.scoreRate - a.scoreRate);
    const localElites = useGlobalElites
      ? topEliteIds
      : new Set(subRanked.slice(0, Math.min(3, Math.max(1, subRanked.length))).map((s) => s.cid));
    const maxScore = subRanked[0]?.scoreRate ?? maxGlobalScore;

    // 優先取高勝率精英候選的勝利對局；若無則取全部勝利對局
    const eliteWins = allWins.filter((e) => localElites.has(e.candidateIdx ?? 0));
    const selectedWins = eliteWins.length > 0 ? eliteWins : allWins;

    const accumW = Array(22).fill(0);
    let weightSum = 0;
    const winAdv = Array(22).fill(0);
    let winAdvCount = 0;
    const lossAdv = Array(22).fill(0);
    let lossAdvCount = 0;

    for (const ev of selectedWins) {
      const cid = ev.candidateIdx ?? 0;
      const cw = ev.candidateWeights || candidates[cid] || base;
      const st = subCandStats.get(cid) || candStats.get(cid) || { games: 1, wins: 1, draws: 0 };
      const sr = (st.wins + 0.5 * st.draws) / Math.max(1, st.games);
      const importance = Math.exp(18 * (sr - maxScore));
      for (let k = 0; k < 22; k++) {
        accumW[k] += (cw[k] ?? base[k]) * importance;
      }
      weightSum += importance;
      if (Array.isArray(ev.featureAdvantage) && ev.featureAdvantage.length === 22) {
        for (let k = 0; k < 22; k++) winAdv[k] += Number(ev.featureAdvantage[k] || 0);
        winAdvCount++;
      }
    }

    for (const ev of subsetLosses) {
      if (Array.isArray(ev.featureAdvantage) && ev.featureAdvantage.length === 22) {
        for (let k = 0; k < 22; k++) lossAdv[k] += Number(ev.featureAdvantage[k] || 0);
        lossAdvCount++;
      }
    }

    return base.map((bVal, k) => {
      const meanWinW = weightSum > 0 ? accumW[k] / weightSum : bVal;
      const wAdv = winAdvCount > 0 ? winAdv[k] / winAdvCount : 0;
      const lAdv = lossAdvCount > 0 ? lossAdv[k] / lossAdvCount : 0;
      const contrast = (wAdv - lAdv) * 0.28;
      return roundW(meanWinW + contrast);
    });
  };

  const overallWeights = synthesizeFromSubset(exploreEvents, true);
  const eliteWinCount = winGames.filter((e) => topEliteIds.has(e.candidateIdx ?? 0)).length || winGames.length;
  const byOpponent = {};
  const oppGroups = new Map();
  for (const ev of exploreEvents) {
    if (!ev.opponentId) continue;
    if (!oppGroups.has(ev.opponentId)) oppGroups.set(ev.opponentId, []);
    oppGroups.get(ev.opponentId).push(ev);
  }
  for (const [oppId, list] of oppGroups.entries()) {
    const oppWins = list.filter((e) => e.outcome === 'win').length;
    const oppDraws = list.filter((e) => e.outcome === 'draw').length;
    const oppSynth = synthesizeFromSubset(list, false);
    const blended = oppSynth.map((v, k) => roundW(0.55 * v + 0.45 * overallWeights[k]));
    byOpponent[oppId] = {
      games: list.length,
      wins: oppWins,
      draws: oppDraws,
      losses: list.length - oppWins - oppDraws,
      winRate: list.length ? oppWins / list.length : 0,
      weights: blended
    };
  }

  const adjustments = FEATURE_NAMES_22.map((name, idx) => {
    const b = base[idx] || 0;
    const s = overallWeights[idx] || 0;
    return {
      index: idx,
      name,
      labelZh: FEATURE_LABELS_ZH[name] || name,
      base: b,
      synthesized: s,
      delta: roundW(s - b)
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    exploreTotal: total,
    exploreWins: winGames.length,
    exploreDraws: drawGames.length,
    exploreLosses: lossGames.length,
    eliteWinsSelected: eliteWinCount,
    exploreWinRate: total ? winGames.length / total : 0,
    baseExploreWinRate,
    bestCandidateWinRate: rankedCands[0]?.winRate ?? 0,
    exploreScoreRate: total ? (winGames.length + 0.5 * drawGames.length) / total : 0,
    weights: overallWeights,
    byOpponent,
    topAdjustments: adjustments.slice(0, 6),
    allAdjustments: adjustments
  };
}

// 100,000 局探索充分統計量（可跨多執行緒 Worker 分塊累加，記憶體與 IndexedDB 僅佔 ~20KB）
export function createEmptyExploreStats(opponentIds = [], candidateCount = EXPLORE_CANDIDATE_COUNT) {
  return {
    completed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    turnsSum: 0,
    completedChunks: [],
    byCandidate: Array.from({ length: candidateCount }, () => ({
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      winFeatSum: Array(22).fill(0),
      winFeatCount: 0,
      lossFeatSum: Array(22).fill(0),
      lossFeatCount: 0
    })),
    byOpponent: opponentIds.map((id) => ({
      id,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      byCandidate: Array.from({ length: candidateCount }, () => ({
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0
      })),
      winFeatSum: Array(22).fill(0),
      winFeatCount: 0,
      lossFeatSum: Array(22).fill(0),
      lossFeatCount: 0
    }))
  };
}

export function mergeExploreChunkStats(acc, chunk) {
  if (!acc || !chunk) return acc;
  acc.completed += chunk.completed || 0;
  acc.wins += chunk.wins || 0;
  acc.draws += chunk.draws || 0;
  acc.losses += chunk.losses || 0;
  acc.turnsSum += chunk.turnsSum || 0;
  if (Number.isInteger(chunk.startGame) && !acc.completedChunks.includes(chunk.startGame)) {
    acc.completedChunks.push(chunk.startGame);
  }
  const cList = chunk.byCandidate || [];
  for (let c = 0; c < Math.min(acc.byCandidate.length, cList.length); c++) {
    const dst = acc.byCandidate[c];
    const src = cList[c];
    dst.games += src.games || 0;
    dst.wins += src.wins || 0;
    dst.draws += src.draws || 0;
    dst.losses += src.losses || 0;
    dst.winFeatCount += src.winFeatCount || 0;
    dst.lossFeatCount += src.lossFeatCount || 0;
    for (let k = 0; k < 22; k++) {
      dst.winFeatSum[k] += src.winFeatSum?.[k] || 0;
      dst.lossFeatSum[k] += src.lossFeatSum?.[k] || 0;
    }
  }
  const oppById = new Map(acc.byOpponent.map((o) => [o.id, o]));
  for (const srcOpp of chunk.byOpponent || []) {
    const dstOpp = oppById.get(srcOpp.id);
    if (!dstOpp) continue;
    dstOpp.games += srcOpp.games || 0;
    dstOpp.wins += srcOpp.wins || 0;
    dstOpp.draws += srcOpp.draws || 0;
    dstOpp.losses += srcOpp.losses || 0;
    dstOpp.winFeatCount += srcOpp.winFeatCount || 0;
    dstOpp.lossFeatCount += srcOpp.lossFeatCount || 0;
    for (let k = 0; k < 22; k++) {
      dstOpp.winFeatSum[k] += srcOpp.winFeatSum?.[k] || 0;
      dstOpp.lossFeatSum[k] += srcOpp.lossFeatSum?.[k] || 0;
    }
    const sc = srcOpp.byCandidate || [];
    for (let c = 0; c < Math.min(dstOpp.byCandidate.length, sc.length); c++) {
      dstOpp.byCandidate[c].games += sc[c].games || 0;
      dstOpp.byCandidate[c].wins += sc[c].wins || 0;
      dstOpp.byCandidate[c].draws += sc[c].draws || 0;
      dstOpp.byCandidate[c].losses += sc[c].losses || 0;
    }
  }
  return acc;
}

// 從 100,000 局充分統計量中提取「勝利對局」綜合歸納出 22 維獲勝策略（全局 + 單對手專屬）
export function synthesizeWinningStrategyFromStats(stats, baseWeights = [], candidates = []) {
  const base = Array.isArray(baseWeights) && baseWeights.length === 22
    ? baseWeights.map(Number)
    : Array(22).fill(0);
  const total = stats?.completed || 0;
  const totalWins = stats?.wins || 0;
  const totalDraws = stats?.draws || 0;
  const totalLosses = stats?.losses || 0;
  const candStats = (stats?.byCandidate || []).map((s, cid) => ({
    cid,
    games: s.games || 0,
    wins: s.wins || 0,
    draws: s.draws || 0,
    losses: s.losses || 0,
    winRate: s.games ? s.wins / s.games : 0,
    scoreRate: s.games ? (s.wins + 0.5 * s.draws) / s.games : 0,
    winFeatSum: s.winFeatSum || Array(22).fill(0),
    winFeatCount: s.winFeatCount || 0,
    lossFeatSum: s.lossFeatSum || Array(22).fill(0),
    lossFeatCount: s.lossFeatCount || 0
  }));
  const activeCands = candStats.filter((s) => s.games > 0);
  const rankedCands = [...activeCands].sort((a, b) => b.scoreRate - a.scoreRate || b.winRate - a.winRate);
  const eliteCount = Math.min(3, Math.max(1, rankedCands.length));
  const globalElites = rankedCands.slice(0, eliteCount);
  const maxGlobalScore = rankedCands[0]?.scoreRate ?? 0.5;
  const baseCandStat = candStats[0];
  const baseExploreWinRate = baseCandStat && baseCandStat.games > 0
    ? baseCandStat.wins / baseCandStat.games
    : (total ? totalWins / total : 0);

  // 全局勝局綜合權重（取 Top-3 高勝率精英候選之勝利對局加權 + 勝/敗實測決策特徵對比）
  const computeWeights = (candRows, featWinSum, featWinCnt, featLossSum, featLossCnt) => {
    const valid = candRows.filter((r) => r.games > 0);
    if (!valid.length) return [...base];
    const sorted = [...valid].sort((a, b) => b.scoreRate - a.scoreRate || b.winRate - a.winRate);
    const elites = sorted.slice(0, Math.min(3, sorted.length));
    const maxSr = sorted[0]?.scoreRate ?? 0.5;
    const chosen = elites.some((e) => e.wins > 0) ? elites : sorted;

    const accumW = Array(22).fill(0);
    let wSum = 0;
    for (const c of chosen) {
      if (c.wins <= 0) continue;
      const cw = candidates[c.cid] || base;
      // 每個勝利對局依所屬候選的精英勝率權重貢獻
      const imp = c.wins * Math.exp(22 * (c.scoreRate - maxSr));
      for (let k = 0; k < 22; k++) accumW[k] += (cw[k] ?? base[k]) * imp;
      wSum += imp;
    }
    return base.map((bVal, k) => {
      const meanWinW = wSum > 0 ? accumW[k] / wSum : bVal;
      const wAdv = featWinCnt > 0 ? featWinSum[k] / featWinCnt : 0;
      const lAdv = featLossCnt > 0 ? featLossSum[k] / featLossCnt : 0;
      const contrast = (wAdv - lAdv) * 0.28;
      return roundW(meanWinW + contrast);
    });
  };

  const gWinFeat = Array(22).fill(0);
  let gWinCnt = 0;
  const gLossFeat = Array(22).fill(0);
  let gLossCnt = 0;
  let eliteWinCount = 0;
  for (const e of globalElites) {
    eliteWinCount += e.wins;
    gWinCnt += e.winFeatCount;
    for (let k = 0; k < 22; k++) gWinFeat[k] += e.winFeatSum[k];
  }
  for (const s of activeCands) {
    gLossCnt += s.lossFeatCount;
    for (let k = 0; k < 22; k++) gLossFeat[k] += s.lossFeatSum[k];
  }
  if (eliteWinCount === 0) eliteWinCount = totalWins;

  const overallWeights = computeWeights(activeCands, gWinFeat, gWinCnt, gLossFeat, gLossCnt);

  const byOpponent = {};
  for (const opp of stats?.byOpponent || []) {
    const oppCands = (opp.byCandidate || []).map((s, cid) => ({
      cid,
      games: s.games || 0,
      wins: s.wins || 0,
      draws: s.draws || 0,
      losses: s.losses || 0,
      winRate: s.games ? s.wins / s.games : 0,
      scoreRate: s.games ? (s.wins + 0.5 * s.draws) / s.games : 0
    }));
    const oppSpecific = computeWeights(
      oppCands,
      opp.winFeatSum || Array(22).fill(0),
      opp.winFeatCount || 0,
      opp.lossFeatSum || Array(22).fill(0),
      opp.lossFeatCount || 0
    );
    // 單對手探索達 10,000 局（每候選 500 局），對位信號極穩定，以 65% 對位專屬 + 35% 全局穩健融合
    const blended = oppSpecific.map((v, k) => roundW(0.65 * v + 0.35 * overallWeights[k]));
    byOpponent[opp.id] = {
      games: opp.games || 0,
      wins: opp.wins || 0,
      draws: opp.draws || 0,
      losses: opp.losses || 0,
      winRate: opp.games ? opp.wins / opp.games : 0,
      weights: blended
    };
  }

  const adjustments = FEATURE_NAMES_22.map((name, idx) => {
    const b = base[idx] || 0;
    const s = overallWeights[idx] || 0;
    return {
      index: idx,
      name,
      labelZh: FEATURE_LABELS_ZH[name] || name,
      base: b,
      synthesized: s,
      delta: roundW(s - b)
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    exploreTotal: total,
    exploreWins: totalWins,
    exploreDraws: totalDraws,
    exploreLosses: totalLosses,
    eliteWinsSelected: eliteWinCount,
    exploreWinRate: total ? totalWins / total : 0,
    baseExploreWinRate,
    bestCandidateWinRate: rankedCands[0]?.winRate ?? 0,
    exploreScoreRate: total ? (totalWins + 0.5 * totalDraws) / total : 0,
    weights: overallWeights,
    byOpponent,
    topAdjustments: adjustments.slice(0, 6),
    allAdjustments: adjustments
  };
}

const FASTSIM_TYPE_CODES = {
  grass: 0, fire: 1, water: 2, lightning: 3, psychic: 4,
  fighting: 5, darkness: 6, metal: 7, dragon: 8, colorless: 9
};

export function encodeCardForFastSim(card, strategyBonus = 0) {
  if (!card) {
    return {
      isPokemon: 1, stage: 0, typeCode: 9, weakCode: 255, hp: 60, retreat: 1,
      prize: 1, atkCost: 1, atkDmg: 20, atkFlags: 0, abFlags: 0,
      trainerKind: 0, effectVal: 0, strategyBonus: Number(strategyBonus || 0)
    };
  }
  const name = `${card.name || ''} ${card.nameEn || ''}`;
  const isFossil = card.subtype === 'fossil' || /化石|Fossil/i.test(name);
  const isPokemon = card.type === 'pokemon' || isFossil ? 1 : 0;
  const stage = card.stage === 'stage2' ? 2 : card.stage === 'stage1' ? 1 : 0;
  const primaryType = (card.types?.[0] || 'colorless').toLowerCase();
  const typeCode = FASTSIM_TYPE_CODES[primaryType] ?? 9;
  const weakCode = card.weakness ? (FASTSIM_TYPE_CODES[String(card.weakness).toLowerCase()] ?? 255) : 255;
  const hp = isFossil ? 40 : (Number(card.hp) || (isPokemon ? 60 : 0));
  const retreat = isFossil ? 4 : Math.min(4, Math.max(0, Number(card.retreat ?? 1)));
  const cats = card.type === 'pokemon' ? (card._pokeCats || getPokemonCategories(card)) : [];
  const isMega = cats.includes('mega');
  const isEx = cats.includes('ex') || isMega;
  const prize = isMega ? 3 : isEx ? 2 : 1;

  let bestDmg = 0;
  let bestCost = 1;
  let atkFlags = 0;
  for (const atk of card.attacks || []) {
    const dmgNum = parseInt(String(atk.damage || '0').replace(/[^0-9]/g, ''), 10) || 0;
    const cost = Math.max(1, Math.min(5, (atk.cost || []).length || 1));
    const eff = String(atk.effect || '');
    if (dmgNum > bestDmg || (dmgNum === bestDmg && cost < bestCost)) {
      bestDmg = dmgNum;
      bestCost = cost;
    }
    if (eff.length > 0) atkFlags |= 1;
    if (/備戰|bench/i.test(eff) && /傷害|damage/i.test(eff)) atkFlags |= 2;
    if (/中毒|灼傷|睡眠|麻痺|混亂|poison|burn|asleep|paralyz|confus/i.test(eff)) atkFlags |= 4;
    if (/恢復|heal/i.test(eff)) atkFlags |= 8;
    if (/能量區.*附|附於.*能量|attach.*energy/i.test(eff)) atkFlags |= 16;
  }
  if (isPokemon && bestDmg === 0) bestDmg = isFossil ? 0 : 20;

  let abFlags = 0;
  for (const ab of card.abilities || []) {
    abFlags |= 1;
    const eff = String(ab.effect || '');
    if (/抽.*張|draw/i.test(eff)) abFlags |= 2;
    if (/能量區|附於|attach.*energy/i.test(eff)) abFlags |= 4;
    if (/恢復|heal/i.test(eff)) abFlags |= 8;
    if (/傷害|damage/i.test(eff)) abFlags |= 16;
  }

  let trainerKind = 0;
  let effectVal = 0;
  if (!isPokemon) {
    const eff = `${card.name || ''} ${card.nameEn || ''} ${card.effect || ''}`;
    if (card.subtype === 'stadium') {
      trainerKind = 7; effectVal = 10;
    } else if (card.subtype === 'tool') {
      trainerKind = 5;
      effectVal = /斗蓬|斗篷|Cape|HP\+20|HP\+30/i.test(eff) ? 20 : /頭盔|Helmet|20點傷害/i.test(eff) ? -20 : 10;
    } else if (/奇異糖果|神奇糖果|Rare Candy/i.test(eff)) {
      trainerKind = 6; effectVal = 99;
    } else if (/大木博士|精靈球|模仿少女|奇樹|通訊|Research|Poké Ball|Copycat|Iono|Communication|抽.*張|抽出/i.test(eff)) {
      trainerKind = 1; effectVal = /大木|Research/i.test(eff) ? 2 : 1;
    } else if (/傷藥|莉佳|珠貝|莉莉艾|寶可夢中心|Potion|Erika|Irida|Lillie|Center Lady|恢復/i.test(eff)) {
      trainerKind = 2;
      const m = eff.match(/(\d+)\s*HP|恢復\s*(\d+)/i);
      effectVal = m ? Math.min(80, Number(m[1] || m[2]) || 30) : 30;
    } else if (/娜姿|赤日|古茲馬|夥星|紅牌|Sabrina|Cyrus|Guzma|Mars|Red Card|互換|放回牌庫/i.test(eff)) {
      trainerKind = 3;
      effectVal = /赤日|Cyrus/i.test(eff) ? 2 : /夥星|紅牌|Mars|Red Card/i.test(eff) ? 3 : 1;
    } else if (/坂木|赤紅|夏伯|竹蘭|Giovanni|Red\b|Blaine|Cynthia|\+\d+點/i.test(eff)) {
      trainerKind = 4; effectVal = /赤紅|Red\b/i.test(eff) ? 20 : 10;
    } else if (/速度強化|葉子|小光|小霞|小剛|火焰貼片|X Speed|Leaf|Dawn|Misty|Brock|Flame Patch|撤退|能量/i.test(eff)) {
      trainerKind = 6; effectVal = /能量|Energy|Misty|Brock|Dawn|Patch/i.test(eff) ? 2 : 1;
    } else {
      trainerKind = 1; effectVal = 1;
    }
  }

  return {
    isPokemon, stage, typeCode, weakCode, hp, retreat, prize,
    atkCost: bestCost, atkDmg: bestDmg, atkFlags, abFlags,
    trainerKind, effectVal, strategyBonus: Number(strategyBonus || 0)
  };
}

// 索引 13,500 條策略詞條庫，並為當前牌組 + 對手陣容精準匹配與加權應用策略詞條
function ensureLexiconIndex(lexicon) {
  if (!lexicon?.entries) return null;
  if (lexicon._idx) return lexicon._idx;
  const byCardId = new Map();
  const macro = [];
  for (let i = 0; i < lexicon.entries.length; i++) {
    const r = lexicon.entries[i];
    const cardId = r[2];
    if (cardId) {
      let arr = byCardId.get(cardId);
      if (!arr) { arr = []; byCardId.set(cardId, arr); }
      arr.push(r);
    } else {
      macro.push(r);
    }
  }
  lexicon._idx = { byCardId, macro };
  return lexicon._idx;
}

export function matchDeckStrategies(deck, lineup = [], lexicon = null, baseWeights = []) {
  const base = Array.isArray(baseWeights) && baseWeights.length === 22
    ? baseWeights.map(Number)
    : Array(22).fill(0);
  const idx = ensureLexiconIndex(lexicon);
  if (!idx || !deck?.cards?.length) {
    return {
      totalLexiconCount: lexicon?.totalEntries || 0,
      matchedCount: 0,
      cardMatchedCount: 0,
      macroMatchedCount: 0,
      cardBonusById: {},
      lexiconSeedWeights: [...base],
      topActiveStrategies: [],
      matchedIds: []
    };
  }

  const matched = [];
  const cardBonusSum = new Map();
  const cardBonusCnt = new Map();
  const wAccum = Array(22).fill(0);
  const wHits = Array(22).fill(0);
  const seenCardIds = new Set();

  // 1. 匹配本牌組內每一張寶可夢卡與訓練家卡對應的所有策略詞條
  for (const item of deck.cards) {
    if (!item?.id || seenCardIds.has(item.id)) continue;
    seenCardIds.add(item.id);
    const list = idx.byCardId.get(item.id) || [];
    for (const r of list) {
      matched.push(r);
      const b = Number(r[12] || 0);
      cardBonusSum.set(item.id, (cardBonusSum.get(item.id) || 0) + b);
      cardBonusCnt.set(item.id, (cardBonusCnt.get(item.id) || 0) + 1);
      const wi = r[10] || [];
      const wv = r[11] || [];
      for (let k = 0; k < wi.length; k++) {
        const fi = wi[k];
        if (fi >= 0 && fi < 22) {
          wAccum[fi] += Number(wv[k] || 0) * (item.count || 1);
          wHits[fi] += (item.count || 1);
        }
      }
    }
  }
  const cardMatchedCount = matched.length;

  // 2. 匹配對陣前十對手與通用環境攻略詞條
  const oppIdSet = new Set((lineup || []).map((x) => x.entry?.id || x.id).filter(Boolean));
  let macroMatchedCount = 0;
  for (const r of idx.macro) {
    const target = String(r[3] || '');
    const oppPrefix = target.includes(':') ? target.split(':')[0] : '';
    const isRelevant = !oppPrefix || oppIdSet.has(oppPrefix);
    if (!isRelevant) continue;
    matched.push(r);
    macroMatchedCount++;
    const wi = r[10] || [];
    const wv = r[11] || [];
    for (let k = 0; k < wi.length; k++) {
      const fi = wi[k];
      if (fi >= 0 && fi < 22) {
        wAccum[fi] += Number(wv[k] || 0) * 0.45;
        wHits[fi] += 0.45;
      }
    }
  }

  const cardBonusById = {};
  for (const [cid, sum] of cardBonusSum.entries()) {
    cardBonusById[cid] = roundW(sum / Math.max(1, cardBonusCnt.get(cid) || 1));
  }

  // 將匹配策略詞條的 22 維戰術方向平滑融合至基礎模型作為千萬局推演種子權重
  const lexiconSeedWeights = base.map((b, k) => {
    const avgShift = wHits[k] > 0 ? wAccum[k] / wHits[k] : 0;
    return roundW(b + Math.max(-0.45, Math.min(0.45, avgShift * 0.55)));
  });

  const catLabels = lexicon.catLabelsZh || {};
  const cats = lexicon.cats || [];
  const sorted = [...matched].sort((a, b) => (Number(b[8] || 0) + Number(b[7] || 0) * 0.2) - (Number(a[8] || 0) + Number(a[7] || 0) * 0.2));
  const topActiveStrategies = sorted.slice(0, 12).map((r) => ({
    id: r[0],
    cat: cats[r[1]] || 'matchup_macro',
    catLabel: catLabels[cats[r[1]]] || '策略詞條',
    cardId: r[2],
    target: r[3],
    title: r[4],
    rule: r[5],
    games: r[6],
    wr: r[7],
    delta: r[8]
  }));

  return {
    totalLexiconCount: lexicon.totalEntries || lexicon.entries.length,
    matchedCount: matched.length,
    cardMatchedCount,
    macroMatchedCount,
    cardBonusById,
    lexiconSeedWeights,
    topActiveStrategies,
    matchedIds: matched.map((r) => r[0])
  };
}

export function computeCompositeWinRateFromCompact(compactResults = {}, lineup = [], gamesPerOpponent = GAMES_PER_OPPONENT) {
  let wins = 0, draws = 0, losses = 0, total = 0;
  let fWins = 0, fDraws = 0, fLosses = 0, fTotal = 0;
  let sWins = 0, sDraws = 0, sLosses = 0, sTotal = 0;
  let turnsSum = 0;
  let top10TotalShare = 0, completedShare = 0, weightedWinSum = 0, weightedScoreSum = 0;
  const byOpponent = [];

  for (const item of lineup) {
    const entry = item.entry || item;
    const share = Number(entry?.share || 0);
    if (share > 0) top10TotalShare += share;
    const rec = compactResults?.[entry.id];
    const t = rec?.total || 0;
    const w = rec?.wins || 0;
    const d = rec?.draws || 0;
    const l = rec?.losses || 0;
    wins += w; draws += d; losses += l; total += t;
    fWins += rec?.firstWins || 0; fDraws += rec?.firstDraws || 0; fLosses += rec?.firstLosses || 0;
    fTotal += (rec?.firstWins || 0) + (rec?.firstDraws || 0) + (rec?.firstLosses || 0);
    sWins += rec?.secondWins || 0; sDraws += rec?.secondDraws || 0; sLosses += rec?.secondLosses || 0;
    sTotal += (rec?.secondWins || 0) + (rec?.secondDraws || 0) + (rec?.secondLosses || 0);
    turnsSum += rec?.turnsSum || 0;
    if (t > 0) {
      const wr = w / t;
      const sr = (w + 0.5 * d) / t;
      if (share > 0) {
        completedShare += share;
        weightedWinSum += wr * share;
        weightedScoreSum += sr * share;
      }
      byOpponent.push({
        id: entry.id,
        name: entry.name,
        rank: item.rank,
        share,
        wins: w,
        draws: d,
        losses: l,
        total: t,
        winRate: wr,
        scoreRate: sr
      });
    }
  }

  const ranked = [...byOpponent].sort((a, b) => b.winRate - a.winRate || b.scoreRate - a.scoreRate);
  return {
    wins,
    draws,
    losses,
    total,
    targetTotal: lineup.length * gamesPerOpponent,
    complete: lineup.length === 10 && total === lineup.length * gamesPerOpponent,
    equalWinRate: total ? wins / total : null,
    equalScoreRate: total ? (wins + 0.5 * draws) / total : null,
    equalCI95: interval(wins, total),
    weightedWinRate: completedShare > 0 ? weightedWinSum / completedShare : null,
    weightedScoreRate: completedShare > 0 ? weightedScoreSum / completedShare : null,
    top10TotalShare,
    completedShare,
    first: { wins: fWins, draws: fDraws, losses: fLosses, total: fTotal, winRate: fTotal ? fWins / fTotal : null },
    second: { wins: sWins, draws: sDraws, losses: sLosses, total: sTotal, winRate: sTotal ? sWins / sTotal : null },
    avgTurns: total > 0 && turnsSum > 0 ? turnsSum / total : null,
    byOpponent,
    bestMatchups: ranked.slice(0, 2),
    worstMatchups: [...ranked].reverse().slice(0, 2)
  };
}

export function validOutcomes(events, ids, gamesPerOpponent = GAMES_PER_OPPONENT) {
  const allowed = new Set(ids), repeated = new Set(), valid = [];
  for (const event of events) {
    const key = event.opponentId + '#' + event.index;
    if (!allowed.has(event.opponentId) || !Number.isInteger(event.index) || event.index < 0 || event.index >= gamesPerOpponent || !['win', 'loss', 'draw'].includes(event.outcome) || repeated.has(key)) continue;
    repeated.add(key);
    valid.push(event);
  }
  return valid;
}
export const resultsFor = (events, id) => events.filter(e => e.opponentId === id);
export function aggregate(events) {
  const tally = { wins: 0, draws: 0, losses: 0, total: events.length };
  for (const e of events) tally[{ win: 'wins', draw: 'draws', loss: 'losses' }[e.outcome]]++;
  return tally;
}
export function summarizeBatch(events, ids, gamesPerOpponent = GAMES_PER_OPPONENT) {
  const clean = validOutcomes(events, ids, gamesPerOpponent);
  return { ...aggregate(clean), complete: ids.length === 10 && clean.length === 10 * gamesPerOpponent };
}
export function isEngineImplementedStatus(status) {
  return status === 'Fully implemented' || status === 'Implemented' || status === 'Complete' || status === 'ok';
}
export function computeCompositeWinRate(events, lineup = [], gamesPerOpponent = GAMES_PER_OPPONENT) {
  const oppIds = lineup.map((x) => x.entry?.id || x.id).filter(Boolean);
  const clean = validOutcomes(events || [], oppIds, gamesPerOpponent);
  const overall = aggregate(clean);
  const half = Math.floor(gamesPerOpponent / 2);
  const firstEvents = clean.filter((e) => (e.first != null ? e.first === 0 : e.index < half));
  const secondEvents = clean.filter((e) => (e.first != null ? e.first === 1 : e.index >= half));
  const firstTally = aggregate(firstEvents);
  const secondTally = aggregate(secondEvents);

  let turnSum = 0, turnCount = 0;
  for (const e of clean) {
    if (Number.isFinite(e.turns) && e.turns > 0) {
      turnSum += e.turns;
      turnCount++;
    }
  }

  let top10TotalShare = 0;
  let completedShare = 0;
  let weightedWinSum = 0;
  let weightedScoreSum = 0;
  const byOpponent = [];

  for (const item of lineup) {
    const entry = item.entry || item;
    const share = Number(entry?.share || 0);
    if (share > 0) top10TotalShare += share;
    const oppEvents = resultsFor(clean, entry.id);
    const tally = aggregate(oppEvents);
    if (tally.total > 0) {
      const winRate = tally.wins / tally.total;
      const scoreRate = (tally.wins + 0.5 * tally.draws) / tally.total;
      if (share > 0) {
        completedShare += share;
        weightedWinSum += winRate * share;
        weightedScoreSum += scoreRate * share;
      }
      byOpponent.push({
        id: entry.id,
        name: entry.name,
        rank: item.rank,
        share,
        ...tally,
        winRate,
        scoreRate
      });
    }
  }

  const completedWithGames = byOpponent.filter((x) => x.total >= 10);
  const sortedByWr = [...completedWithGames].sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

  return {
    ...overall,
    gamesPerOpponent,
    totalTargetGames: oppIds.length * gamesPerOpponent,
    complete: oppIds.length === 10 && clean.length === 10 * gamesPerOpponent,
    equalWinRate: overall.total ? overall.wins / overall.total : null,
    equalScoreRate: overall.total ? (overall.wins + 0.5 * overall.draws) / overall.total : null,
    equalCI95: interval(overall.wins, overall.total),
    weightedWinRate: completedShare > 0 ? weightedWinSum / completedShare : null,
    weightedScoreRate: completedShare > 0 ? weightedScoreSum / completedShare : null,
    completedShare,
    top10TotalShare,
    first: { ...firstTally, winRate: firstTally.total ? firstTally.wins / firstTally.total : null },
    second: { ...secondTally, winRate: secondTally.total ? secondTally.wins / secondTally.total : null },
    avgTurns: turnCount ? turnSum / turnCount : null,
    bestMatchups: sortedByWr.slice(0, 2),
    worstMatchups: [...sortedByWr].reverse().slice(0, 2)
  };
}
export function interval(w,n){
  if(!n)return '—'; const z=1.95996398454, p=w/n, a=1+z*z/n;
  const middle=(p+z*z/(2*n))/a, half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/a;
  return (100*Math.max(0,middle-half)).toFixed(1)+'–'+(100*Math.min(1,middle+half)).toFixed(1)+'%';
}
export function deckFingerprint(deck) {
  return JSON.stringify([deck.cards.map(x=>[x.id,x.count]).sort((a,b)=>a[0].localeCompare(b[0])),[...deck.energy].map(titleCase).sort()]);
}
export function getCardOwnedCount(cardId, collection, cardsById = null, matchVariants = false) {
  const map = collection || {};
  const exact = Math.max(0, Number(map[cardId] || 0));
  if (!matchVariants || !cardsById?.get) return exact;
  const card = cardsById.get(cardId);
  const key = card?.limitName || card?.nameEn || card?.name;
  if (!key) return exact;
  let total = 0;
  for (const [id, rawCount] of Object.entries(map)) {
    const cnt = Number(rawCount || 0);
    if (cnt <= 0) continue;
    const c = cardsById.get(id);
    if (c && (c.limitName || c.nameEn || c.name) === key) total += cnt;
  }
  return Math.max(exact, total);
}
export function evaluateDeckOwnership(deck, collection, cardsById) {
  const byNameOwned = new Map();
  for (const [id, raw] of Object.entries(collection || {})) {
    const cnt = Number(raw || 0);
    if (cnt <= 0) continue;
    const card = cardsById?.get ? cardsById.get(id) : null;
    const key = card ? (card.limitName || card.nameEn || card.name) : id;
    byNameOwned.set(key, (byNameOwned.get(key) || 0) + cnt);
  }
  const remainingPool = new Map(byNameOwned);
  const entries = [];
  let totalNeeded = 0, totalMissing = 0, unownedDistinct = 0;
  for (const item of deck?.cards || []) {
    if (!item?.id || item.count <= 0) continue;
    const card = cardsById?.get ? cardsById.get(item.id) : null;
    const key = card ? (card.limitName || card.nameEn || card.name) : item.id;
    const exactOwned = Math.max(0, Number(collection?.[item.id] || 0));
    const poolAvail = remainingPool.get(key) || 0;
    const usedOwned = Math.min(item.count, poolAvail);
    remainingPool.set(key, Math.max(0, poolAvail - usedOwned));
    const missing = Math.max(0, item.count - usedOwned);
    totalNeeded += item.count;
    totalMissing += missing;
    if (usedOwned === 0) unownedDistinct++;
    entries.push({
      id: item.id,
      count: item.count,
      exactOwned,
      ownedForSlot: usedOwned,
      totalOwnedByName: byNameOwned.get(key) || 0,
      missing
    });
  }
  return {
    totalNeeded,
    totalOwned: totalNeeded - totalMissing,
    totalMissing,
    unownedDistinct,
    byEntryIndex: entries
  };
}

export const POKEMON_CATEGORY_GROUPS = [
  {
    id: 'rules',
    group: '規則與版本',
    combine: 'all',
    options: [
      { id: 'ex', label: '寶可夢 ex', searchTerms: 'ex 寶可夢ex' },
      { id: 'mega', label: '超級進化', searchTerms: '超級進化 mega 超級' },
      { id: 'dual_type', label: '雙屬性', searchTerms: '雙屬性 雙色' },
      { id: 'shiny', label: '異色', searchTerms: '異色 閃光' }
    ]
  },
  {
    id: 'theme',
    group: '主題與陣營',
    combine: 'any',
    options: [
      { id: 'ultra_beast', label: '究極異獸', searchTerms: '究極異獸 异兽 ultrabeast ub' },
      { id: 'ancient', label: '古代寶可夢', searchTerms: '古代 古代寶可夢 悖謬 ancient' },
      { id: 'future', label: '未來寶可夢', searchTerms: '未來 未來寶可夢 悖謬 future' },
      { id: 'team_rocket', label: '火箭隊', searchTerms: '火箭隊 火箭隊的' }
    ]
  },
  {
    id: 'region',
    group: '地區形態',
    combine: 'any',
    options: [
      { id: 'alola', label: '阿羅拉', searchTerms: '阿羅拉 alolan' },
      { id: 'galar', label: '伽勒爾', searchTerms: '伽勒爾 galarian' },
      { id: 'hisui', label: '洗翠', searchTerms: '洗翠 hisuian' },
      { id: 'paldea', label: '帕底亞', searchTerms: '帕底亞 paldean' }
    ]
  },
  {
    id: 'trait',
    group: '對戰特徵',
    combine: 'all',
    options: [
      { id: 'has_ability', label: '持有特性', searchTerms: '特性 持有特性 ability' },
      { id: 'fossil_evo', label: '化石進化', searchTerms: '化石 化石進化' }
    ]
  }
];

export const POKEMON_CATEGORY_OPTIONS = POKEMON_CATEGORY_GROUPS.flatMap((g) => g.options);
const POKE_CATEGORY_BY_ID = new Map(POKEMON_CATEGORY_OPTIONS.map((o) => [o.id, o]));
const POKE_CATEGORY_GROUP_BY_ID = new Map(
  POKEMON_CATEGORY_GROUPS.flatMap((g) => g.options.map((o) => [o.id, g.id]))
);

const ULTRA_BEAST_NAMES = new Set([
  'Nihilego', 'Buzzwole', 'Pheromosa', 'Xurkitree', 'Celesteela',
  'Kartana', 'Guzzlord', 'Poipole', 'Naganadel', 'Stakataka', 'Blacephalon',
  'Necrozma', 'Dawn Wings Necrozma', 'Dusk Mane Necrozma', 'Ultra Necrozma'
]);

const ANCIENT_PARADOX_BASES = new Set([
  'Great Tusk', 'Scream Tail', 'Brute Bonnet', 'Flutter Mane',
  'Slither Wing', 'Sandy Shocks', 'Roaring Moon', 'Walking Wake',
  'Gouging Fire', 'Raging Bolt', 'Koraidon'
]);

const FUTURE_PARADOX_BASES = new Set([
  'Iron Treads', 'Iron Bundle', 'Iron Hands', 'Iron Jugulis',
  'Iron Moth', 'Iron Thorns', 'Iron Valiant', 'Iron Leaves',
  'Iron Boulder', 'Iron Crown', 'Miraidon'
]);

const FOSSIL_EVO_BASES = new Set([
  'Omanyte', 'Omastar', 'Kabuto', 'Kabutops', 'Aerodactyl',
  'Lileep', 'Cradily', 'Anorith', 'Armaldo',
  'Cranidos', 'Rampardos', 'Shieldon', 'Bastiodon',
  'Tirtouga', 'Carracosta', 'Archen', 'Archeops',
  'Tyrunt', 'Tyrantrum', 'Amaura', 'Aurorus'
]);

function stripExSuffix(nameEn) {
  return String(nameEn || '').replace(/\s+ex$/i, '').trim();
}

export function getPokemonCategories(card) {
  if (!card || card.type === 'trainer') return [];
  const cats = [];
  const name = String(card.name || '').trim();
  const nameEn = String(card.limitName || card.nameEn || '').trim();
  const baseEn = stripExSuffix(nameEn);
  const existingTags = new Set(Array.isArray(card.tags) ? card.tags : []);

  const isMega = existingTags.has('mega') || nameEn.startsWith('Mega ') || name.startsWith('超級');
  const isEx = existingTags.has('ex') || /\sex$/i.test(nameEn) || name.endsWith('ex');

  if (isEx) cats.push('ex');
  if (isMega) cats.push('mega');
  if (Array.isArray(card.types) && card.types.length > 1) cats.push('dual_type');
  if (card.rarity === '✦' || card.rarity === '✦✦' || card.rarityCode === 'S' || card.rarityCode === 'SSR') {
    cats.push('shiny');
  }

  if (existingTags.has('ultra_beast') || ULTRA_BEAST_NAMES.has(baseEn)) {
    cats.push('ultra_beast');
  }
  if (existingTags.has('ancient') || ANCIENT_PARADOX_BASES.has(baseEn)) {
    cats.push('ancient');
  }
  if (existingTags.has('future') || FUTURE_PARADOX_BASES.has(baseEn)) {
    cats.push('future');
  }
  if (existingTags.has('team_rocket') || name.startsWith('火箭隊的') || /^Team Rocket['’]s\s/i.test(nameEn)) {
    cats.push('team_rocket');
  }

  if (existingTags.has('alola') || name.includes('阿羅拉') || /\bAlolan\b/i.test(nameEn)) cats.push('alola');
  if (existingTags.has('galar') || name.includes('伽勒爾') || /\bGalarian\b/i.test(nameEn)) cats.push('galar');
  if (existingTags.has('hisui') || name.includes('洗翠') || /\bHisuian\b/i.test(nameEn)) cats.push('hisui');
  if (existingTags.has('paldea') || name.includes('帕底亞') || /\bPaldean\b/i.test(nameEn)) cats.push('paldea');

  if (Array.isArray(card.abilities) && card.abilities.length > 0) {
    cats.push('has_ability');
  }
  if (
    existingTags.has('fossil_evo') ||
    /Fossil|Old Amber/i.test(String(card.evolvesFrom || '')) ||
    FOSSIL_EVO_BASES.has(baseEn)
  ) {
    cats.push('fossil_evo');
  }
  return cats;
}

export function matchesPokemonCategoryFilter(card, includeIds = [], excludeIds = []) {
  const inc = Array.isArray(includeIds) ? includeIds.filter(Boolean) : [];
  const exc = Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : [];
  if (!inc.length && !exc.length) return true;
  if (!card || card.type === 'trainer') return false;

  const cats = card._pokeCats || getPokemonCategories(card);
  for (const id of exc) {
    if (cats.includes(id)) return false;
  }
  if (!inc.length) return true;

  const bucketed = new Map();
  for (const id of inc) {
    const grp = POKE_CATEGORY_GROUP_BY_ID.get(id) || 'other';
    if (!bucketed.has(grp)) bucketed.set(grp, []);
    bucketed.get(grp).push(id);
  }
  for (const g of POKEMON_CATEGORY_GROUPS) {
    const selected = bucketed.get(g.id);
    if (!selected?.length) continue;
    if (g.combine === 'any') {
      if (!selected.some((id) => cats.includes(id))) return false;
    } else {
      if (!selected.every((id) => cats.includes(id))) return false;
    }
  }
  return true;
}

export function getPokemonCategoryLabel(id) {
  return POKE_CATEGORY_BY_ID.get(id)?.label || id;
}

export function getPokemonCategorySearchTerms(id) {
  return POKE_CATEGORY_BY_ID.get(id)?.searchTerms || '';
}


