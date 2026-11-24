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

export const GTG_MODEL_PROFILE = Object.freeze({
  id: 'gtg-elite-lite',
  mode: 'gtg',
  label: 'GTG精英轻量模型',
  exploreLabel: '100 萬局/輪',
  testLabel: '收斂實測',
  roundGamesPerOpponent: 1000000,
  evalGamesPerOpponent: 20000,
  evalGamesPerOpponentCpu: 5000,
  convergenceTolerance: 0.001,
  maxRounds: 12,
  candidateCount: 20,
  exploreTotalGames: 10000000,
  exploreGamesPerOpponent: 1000000,
  gamesPerOpponent: 20000,
  firstSeatGames: 10000,
  totalBatchGames: 200000,
  deepExploreGames: 1000000,
  deepGamesPerOpponent: 20000
});

export function resolveModelSimProfile(modelOrRun) {
  const sp = modelOrRun?.simProfile || modelOrRun?.metaEntry?.simProfile;
  const tag = String(sp?.id || modelOrRun?.id || modelOrRun?.modelId || modelOrRun?.version || modelOrRun?.modelVersion || '').toLowerCase();
  if (sp && (sp.mode === 'gtg' || tag.includes('gtg'))) {
    return {
      ...GTG_MODEL_PROFILE,
      ...sp,
      mode: 'gtg',
      firstSeatGames: sp.firstSeatGames ?? Math.floor((sp.gamesPerOpponent || GTG_MODEL_PROFILE.gamesPerOpponent) / 2)
    };
  }
  if (sp && Number(sp.exploreTotalGames) > 0 && Number(sp.totalBatchGames) > 0) {
    return {
      ...FULL_MODEL_PROFILE,
      ...sp,
      firstSeatGames: sp.firstSeatGames ?? Math.floor(sp.gamesPerOpponent / 2)
    };
  }
  if (tag.includes('gtg')) return { ...GTG_MODEL_PROFILE };
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

// 產生探索階段候選策略集（保留原模型於 index 0，並展開多維度戰術變體；支援退火縮放 radiusScale）
export function buildExplorationCandidates(baseWeights, seedLabel = 'explore', candidateCount = 25, radiusScale = 1.0) {
  const base = Array.isArray(baseWeights) && baseWeights.length === 22
    ? baseWeights.map(Number)
    : Array(22).fill(0);
  const rScale = Math.max(0.05, Number(radiusScale) || 1.0);
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
      return roundW(val + (tpl.deltas[fname] || 0) * rScale);
    });
    list.push(w);
  }

  while (list.length < candidateCount) {
    const w = base.map((val, idx) => {
      const u1 = Math.max(1e-9, rand());
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const scale = (idx <= 1 ? 0.12 : 0.28) * rScale;
      return roundW(val + z * scale);
    });
    list.push(w);
  }
  return list;
}

// 雙邊同步對弈阻尼融合（避免博弈震盪並平滑收斂至納許均衡）
export function dampBlendWeights(prevWeights = [], learnedWeights = [], alpha = 0.55) {
  const a = Math.max(0.05, Math.min(1, Number(alpha) || 0.55));
  const out = new Array(22);
  for (let k = 0; k < 22; k++) {
    const p = Number(prevWeights[k] || 0);
    const l = Number(learnedWeights[k] ?? p);
    out[k] = roundW(a * l + (1 - a) * p);
  }
  return out;
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

const EVO_FAMILY_MAP_CACHE = new WeakMap();

function normEvoKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getEvoParentMap(cardsById) {
  if (!cardsById || typeof cardsById.values !== 'function') return null;
  let map = EVO_FAMILY_MAP_CACHE.get(cardsById);
  if (map) return map;
  map = new Map();
  for (const c of cardsById.values()) {
    if (!c || (c.type !== 'pokemon' && c.subtype !== 'fossil')) continue;
    const from = normEvoKey(c.evolvesFrom);
    if (!from) continue;
    const keys = [normEvoKey(c.limitName), normEvoKey(c.nameEn), normEvoKey(c.name)];
    for (const k of keys) {
      if (k && !map.has(k)) map.set(k, from);
    }
  }
  EVO_FAMILY_MAP_CACHE.set(cardsById, map);
  return map;
}

export function resolveEvolutionGroup(card, cardsById = null) {
  if (!card) return 0;
  const isFossil = card.subtype === 'fossil' || /化石|Fossil/i.test(`${card.name || ''} ${card.nameEn || ''}`);
  if (card.type !== 'pokemon' && !isFossil) return 0;
  const stage = card.stage === 'stage2' ? 2 : card.stage === 'stage1' ? 1 : 0;
  const parentMap = getEvoParentMap(cardsById);
  let cur = normEvoKey(card.limitName || card.nameEn || card.name);
  if (stage > 0 && card.evolvesFrom) {
    cur = normEvoKey(card.evolvesFrom);
    if (parentMap) {
      for (let hop = 0; hop < 4; hop++) {
        const next = parentMap.get(cur);
        if (!next || next === cur) break;
        cur = next;
      }
    } else if (stage === 2) {
      // 無全卡圖鑑上下文時，2階進化無法回溯至基礎名，退回兼容模式 0
      return 0;
    }
  }
  if (!cur) return 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < cur.length; i++) {
    h ^= cur.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 65534) + 1;
}

// 依實卡招式文本精準估算期望傷害（正確處理 × 倍率、+ 加傷、純效果狙擊、對手反面干擾與棄能/反傷機制旗標）
export function computeExpectedAttackDamage(atk) {
  const rawDmgStr = String(atk?.damage || '0').trim();
  let dmgNum = parseInt(rawDmgStr.replace(/[^0-9]/g, ''), 10) || 0;
  const cost = Math.max(0, Math.min(5, (atk?.cost || []).length));
  const eff = String(atk?.effect || '');

  // 1. 空數值純效果傷害（如古劍豹ex「對手的1隻寶可夢受到130點傷害」）
  if (dmgNum === 0 && eff.length > 0) {
    const effDmg = eff.match(/對手的(?:1隻|任1隻|戰鬥|所有).*?寶可夢.*?受到\s*(\d+)\s*點傷害|does\s+(\d+)\s+damage\s+to/i);
    if (effDmg) dmgNum = Number(effDmg[1] || effDmg[2] || 0);
  }

  // 2. 倍率型招式（×）：區分備戰數量倍率、能量倍率、多硬幣與單硬幣
  if (rawDmgStr.includes('×') || rawDmgStr.includes('x')) {
    if (/雙方.*備戰寶可夢|both players.*benched/i.test(eff)) {
      dmgNum = Math.round(dmgNum * 4.5); // 如水君ex 20×雙方備戰 -> 約 90
    } else if (/備戰寶可夢|benched Pok[eé]mon/i.test(eff)) {
      dmgNum = Math.round(dmgNum * 2.5);
    } else if (/能量.*數量|energy attached/i.test(eff)) {
      dmgNum = Math.round(dmgNum * Math.max(2.5, cost + 1));
    } else {
      const multiCoin = eff.match(/擲\s*(\d+)\s*次硬幣|flip\s+(\d+)\s+coins/i);
      if (multiCoin) {
        const nCoins = Math.max(1, Number(multiCoin[1] || multiCoin[2] || 2));
        dmgNum = Math.round(dmgNum * nCoins * 0.5);
      } else if (/直到出現反面|until you get tails/i.test(eff)) {
        dmgNum = Math.round(dmgNum * 1.0);
      } else {
        dmgNum = Math.round(dmgNum * 1.5);
      }
    }
  } else if (rawDmgStr.includes('+')) {
    // 3. 加成型招式（+）：備戰加傷、能量加傷、額外附能、條件加傷、硬幣加傷
    const benchScale = eff.match(/備戰寶可夢的數量\s*[×x]\s*(\d+)/i);
    const energyScale = eff.match(/每(?:有|附有)[^，。,.]{0,12}能量.{0,24}?(\d+)\s*點|(\d+)\s*more damage for each.*energy/i);
    const flatBonus = eff.match(/增加\s*(\d+)\s*點傷害|造成\s*(\d+)\s*點額外傷害|\+\s*(\d+)\s*點傷害|(\d+)\s*more damage/i);
    if (benchScale) {
      const perUnit = Number(benchScale[1] || 20);
      const mult = /雙方/.test(eff) ? 4.2 : 2.5; // 如超級七夕青鳥ex 40 + 2.5*30 = 115
      dmgNum += Math.round(perUnit * mult);
    } else if (energyScale) {
      const perUnit = Number(energyScale[1] || energyScale[2] || 20);
      dmgNum += Math.round(perUnit * Math.max(3, cost + 1)); // 如密勒頓ex 20 + 4*20 = 100
    } else if (flatBonus) {
      const add = Number(flatBonus[1] || flatBonus[2] || flatBonus[3] || flatBonus[4] || 0);
      if (/額外附有|extra.*energy/i.test(eff)) {
        dmgNum += Math.round(add * 0.55); // 如炎帝ex 60 + 60*0.55 = 93
      } else if (/擲.*硬幣|flip a coin/i.test(eff)) {
        dmgNum += Math.round(add * 0.5);
      } else {
        dmgNum += Math.round(add * 0.65); // 如月亮伊布 30 + 50*0.65 = 63
      }
    }
  }

  // 4. 僅針對「攻擊方自己擲反面失敗」折減；絕不誤傷「下回合讓對手擲反面失敗」的防禦干擾技（如自爆磁怪）
  const isOpponentMissDebuff = /在下個對手的回合.*對手擲.*硬幣|during your opponent's next turn.*flip a coin/i.test(eff);
  if (!isOpponentMissDebuff && /擲1次硬幣[，,。]?\s*若為反面[，,]?\s*(?:則)?這[個招]式失敗|flip a coin\.?\s*if tails,\s*this attack does nothing/i.test(eff)) {
    dmgNum = Math.round(dmgNum * 0.5);
  }
  if (isOpponentMissDebuff) {
    // 對手下回合 50% 機率攻擊落空，等效提升實戰壓制力
    dmgNum = Math.round(dmgNum * 1.15);
  }

  // 5. 冷卻、真實棄能與真實自傷（保留滿額傷害斷點，並以引擎旗標在對局內真實扣血/棄能）
  if (/下個自己的回合.*無法使用|can't attack during your next turn/i.test(eff)) {
    dmgNum = Math.round(dmgNum * 0.72);
  }
  let discardEnergy = 0;
  const discardMatch = eff.match(/將這隻寶可夢身上的(?:所有|隨機\s*(\d+)?\s*個|(\d+)個).*能量丟棄|discard\s+(\d+|all)\s+.*energy/i);
  if (discardMatch) {
    discardEnergy = /所有|all/i.test(discardMatch[0]) ? 2 : Math.min(2, Math.max(1, Number(discardMatch[1] || discardMatch[2] || discardMatch[3] || 1)));
  }
  let heavyRecoil = false;
  const recoilMatch = eff.match(/這隻寶可夢也受到\s*(\d+)\s*點傷害|also does\s*(\d+)\s*damage to itself/i);
  if (recoilMatch) {
    const recoil = Number(recoilMatch[1] || recoilMatch[2] || 0);
    if (recoil >= 40) {
      heavyRecoil = true; // 如超級噴火龍Yex 250 傷自傷 50：引擎實戰真實自扣 50 HP
    } else if (recoil >= 10) {
      dmgNum = Math.max(10, dmgNum - Math.round(recoil * 0.4));
    }
  }
  return { dmgNum, isOpponentMissDebuff, discardEnergy, heavyRecoil };
}

export function encodeCardForFastSim(card, strategyBonus = 0, cardsById = null) {
  if (!card) {
    return {
      isPokemon: 1, stage: 0, evoGroup: 0, typeCode: 9, weakCode: 255, hp: 60, retreat: 1,
      prize: 1, atkCost: 1, atkDmg: 20, atkFlags: 0, abFlags: 0,
      trainerKind: 0, effectVal: 0, strategyBonus: Number(strategyBonus || 0)
    };
  }
  const name = `${card.name || ''} ${card.nameEn || ''}`;
  const isFossil = card.subtype === 'fossil' || /化石|Fossil/i.test(name);
  const isPokemon = card.type === 'pokemon' || isFossil ? 1 : 0;
  const stage = card.stage === 'stage2' ? 2 : card.stage === 'stage1' ? 1 : 0;
  const evoGroup = isPokemon ? resolveEvolutionGroup(card, cardsById) : 0;
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
  let bestAtkFlags = 0;
  for (const atk of card.attacks || []) {
    const cost = Math.max(0, Math.min(5, (atk.cost || []).length));
    const eff = String(atk.effect || '');
    const { dmgNum, isOpponentMissDebuff, discardEnergy, heavyRecoil } = computeExpectedAttackDamage(atk);
    const effCost = Math.max(1, cost);
    let flags = 0;
    if (eff.length > 0) flags |= 1;
    if (/備戰|bench|對手的(?:1隻|任1隻)寶可夢受到/i.test(eff) && /傷害|damage/i.test(eff)) flags |= 2;
    if (isOpponentMissDebuff || /中毒|灼傷|睡眠|麻痺|混亂|poison|burn|asleep|paralyz|confus/i.test(eff)) flags |= 4;
    if (/恢復|heal/i.test(eff)) flags |= 8;
    if (/能量區.*附|附於.*能量|attach.*energy/i.test(eff)) flags |= 16;
    if (heavyRecoil) flags |= 32;
    if (discardEnergy >= 2) flags |= 128;
    else if (discardEnergy === 1) flags |= 64;

    if (dmgNum > bestDmg || (dmgNum === bestDmg && effCost < bestCost)) {
      bestDmg = dmgNum;
      bestCost = effCost;
      bestAtkFlags = flags;
    }
  }
  if (isPokemon && bestDmg === 0) bestDmg = isFossil ? 0 : 20;

  let abFlags = 0;
  for (const ab of card.abilities || []) {
    abFlags |= 1;
    const eff = String(ab.effect || '');
    const isOneTimeEvolve = /完成進化時|當從手牌使出這張卡.*進化|when you play this Pok[eé]mon from your hand to evolve/i.test(eff);
    if (/抽.*張|draw/i.test(eff)) abFlags |= 2;
    const isEnergyTriggerOnly = /每次從自己的能量區將.*能量附於.*時|whenever you attach.*energy.*from your energy zone/i.test(eff);
    if (!isEnergyTriggerOnly && /(?:從自己的(?:能量區|棄牌區)[^。]*能量[^。]*附於|轉移[^。]*能量|attach.*energy.*from|move.*energy)/i.test(eff)) {
      if (isOneTimeEvolve) abFlags |= 32; // 僅進化當下觸發 1 次（如火恐龍「點火」）
      else abFlags |= 4; // 每回合可發動 1 次（如三合一磁怪、哈克龍）
    }
    if (/恢復|heal/i.test(eff)) abFlags |= 8;
    if (/傷害|damage/i.test(eff) && !/不會受到/.test(eff)) abFlags |= 16;
    // 防 ex 免疫特性（如花舞鳥「神祕守護」）：引擎真實判定寶可夢 ex 攻擊無效
    if (/不會受到.*寶可夢ex.*招式的傷害|prevent all damage done to this Pok[eé]mon by attacks from.*Pok[eé]mon ex/i.test(eff)) {
      abFlags |= 64;
    }
  }

  let trainerKind = 0;
  let effectVal = 0;
  if (!isPokemon) {
    const eff = `${card.name || ''} ${card.nameEn || ''} ${card.effect || ''}`;
    const body = `${card.effect || ''}`;
    if (card.subtype === 'stadium') {
      trainerKind = 7;
      effectVal = /傷害\+\d+|\+\d+點/i.test(body) ? 10 : 5;
    } else if (card.subtype === 'tool') {
      trainerKind = 5;
      effectVal = /最大HP\+30/i.test(body) ? 25
        : /斗蓬|斗篷|Cape|HP\+20/i.test(eff) ? 20
        : /頭盔|Helmet|20點傷害/i.test(eff) ? -20
        : /撤退/i.test(body) ? 8
        : 10;
    } else if (/奇異糖果|神奇糖果|Rare Candy/i.test(eff)) {
      trainerKind = 6; effectVal = 99;
    } else if (/附於2階進化|2階進化寶可夢.*能量|滿充/i.test(eff)) {
      trainerKind = 6; effectVal = 3; // 限場上有 2 階進化寶可夢時使用
    } else if (/棄牌區.*能量附於|火補丁|電次|Flame Patch|Volkner/i.test(eff)) {
      trainerKind = 6; effectVal = 4; // 限棄牌區有能量（中後期或有寶可夢倒下）時使用
    } else if (/能量區.*附於|改附於.*能量|小霞|小剛|小光|卡奇|梅麗莎|Misty|Brock|Dawn/i.test(eff)) {
      trainerKind = 6; effectVal = 2;
    } else if (/撤退所需的能量減少|撤退費用減少|速度強化|葉子|X Speed|Leaf/i.test(eff)) {
      trainerKind = 6; effectVal = 1;
    } else if (/大木博士|博士的研究|精靈球|模仿少女|奇樹|通訊|Research|Poké Ball|Copycat|Iono|Communication|抽\d+張|加入手牌/i.test(eff)) {
      trainerKind = 1; effectVal = /大木|博士的研究|Research/i.test(eff) ? 2 : 1;
    } else if (/傷藥|莉佳|珠貝|莉莉艾|寶可夢中心|卡露妮|Potion|Erika|Irida|Lillie|Center Lady|恢復\d+HP/i.test(eff)) {
      trainerKind = 2;
      const m = body.match(/(\d+)\s*HP|恢復\s*(\d+)/i);
      let healVal = m ? Math.min(80, Number(m[1] || m[2]) || 30) : 30;
      if (/能量丟棄|discard.*energy/i.test(body)) healVal = Math.max(20, Math.round(healVal * 0.5));
      effectVal = healVal;
    } else if (/娜姿|赤日|古茲馬|夥星|紅牌|Sabrina|Cyrus|Guzma|Mars|Red Card|互換|放回牌庫/i.test(eff)) {
      trainerKind = 3;
      effectVal = /赤日|Cyrus/i.test(eff) ? 2 : /夥星|紅牌|Mars|Red Card/i.test(eff) ? 3 : 1;
    } else if (/坂木|赤紅|夏伯|竹蘭|可爾妮|哈烏|Giovanni|Red\b|Blaine|Cynthia|\+\d+點/i.test(eff)) {
      trainerKind = 4; effectVal = /赤紅|Red\b|\+20|\+30/i.test(eff) ? 20 : 10;
    } else {
      trainerKind = 1; effectVal = 1;
    }
  }

  return {
    isPokemon, stage, evoGroup, typeCode, weakCode, hp, retreat, prize,
    atkCost: bestCost, atkDmg: bestDmg, atkFlags: bestAtkFlags, abFlags,
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

export function parsePairwiseBinary(arrayBuffer, metaDoc = null) {
  if (!arrayBuffer || arrayBuffer.byteLength < 32) return null;
  const view = new DataView(arrayBuffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'PLP1') throw Error(`無效的雙卡策略庫檔頭 (${magic})`);

  const version = view.getUint32(4, true);
  const totalCards = view.getUint32(8, true);
  const functionalCards = view.getUint32(12, true);
  const functionalPairs = view.getUint32(16, true);
  const totalPairwiseEntries = view.getUint32(20, true);
  const gamesPerPair = view.getUint32(24, true);
  const groupTableBytes = view.getUint32(28, true);

  const groupOf = new Uint16Array(arrayBuffer, 32, totalCards);
  const matrixOffset = 32 + groupTableBytes;
  const matrix = new Uint8Array(arrayBuffer, matrixOffset, functionalPairs * 2);

  const cardIds = Array.isArray(metaDoc?.cardIds) ? metaDoc.cardIds : [];
  const cardIdxById = new Map();
  for (let i = 0; i < cardIds.length; i++) {
    cardIdxById.set(cardIds[i], i);
  }

  return {
    version,
    totalCards,
    functionalCards,
    functionalPairs,
    totalPairwiseEntries,
    gamesPerPair,
    groupOf,
    matrix,
    cardIds,
    cardIdxById,
    meta: metaDoc || {}
  };
}

export function lookupPairwiseStrategy(pairwiseDb, cardIdA, cardIdB, cardsById = null) {
  if (!pairwiseDb?.matrix || !pairwiseDb.cardIdxById) return null;
  const idxA = pairwiseDb.cardIdxById.get(cardIdA);
  const idxB = pairwiseDb.cardIdxById.get(cardIdB);
  if (idxA === undefined || idxB === undefined) return null;

  const G = pairwiseDb.functionalCards;
  let u = pairwiseDb.groupOf[idxA];
  let v = pairwiseDb.groupOf[idxB];
  if (u > v) { const t = u; u = v; v = t; }
  const pIdx = u * G - ((u * (u - 1)) / 2) + (v - u);
  if (pIdx < 0 || pIdx >= pairwiseDb.functionalPairs) return null;

  const wrByte = pairwiseDb.matrix[pIdx * 2];
  const byte1 = pairwiseDb.matrix[pIdx * 2 + 1];
  const wr = roundW(wrByte / 250);
  const synNibble = (byte1 >> 4) & 0xf;
  const delta = roundW((synNibble - 8) / 200);
  const bestRegime = (byte1 >> 2) & 0x3;
  const archetypeTag = byte1 & 0x3;

  const meta = pairwiseDb.meta || {};
  const regimeLabels = meta.regimeLabelsZh || ['快攻搶分流', '控場干擾流', '進化續航流', '狙擊獎賞流'];
  const archLabels = meta.archetypeLabelsZh || ['常規雙卡協同', '同系強聯動組合', '進化與道具核心連攜', '跨系配置風險警示'];
  const templates = meta.archetypeRuleTemplates || [];
  const wDeltas = meta.regimeWDeltas || [
    { idx: [2, 9, 11, 14], val: [0.18, 0.20, 0.24, 0.16] },
    { idx: [6, 7, 8, 19], val: [0.18, 0.18, 0.22, 0.20] },
    { idx: [4, 5, 15, 20], val: [0.22, 0.20, 0.16, 0.22] },
    { idx: [11, 12, 19, 21], val: [0.24, 0.16, 0.18, 0.26] }
  ];

  const cA = cardsById?.get?.(cardIdA);
  const cB = cardsById?.get?.(cardIdB);
  const nameA = cA?.name || cardIdA;
  const nameB = cB?.name || cardIdB;
  const regimeLabel = regimeLabels[bestRegime] || '綜合節奏流';
  const archetypeLabel = archLabels[archetypeTag] || '雙卡協同';
  const sdStr = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
  const tpl = templates[archetypeTag]
    || '「{A}」與「{B}」經 1,000 局雙卡實測，於「{R}」表現最佳（勝率 {WR}%，協同 {SD}）。';
  const rule = tpl
    .replace('{A}', nameA)
    .replace('{B}', nameB)
    .replace('{R}', regimeLabel)
    .replace('{WR}', (wr * 100).toFixed(1))
    .replace('{SD}', sdStr);

  const wd = wDeltas[bestRegime] || wDeltas[0];
  const scale = archetypeTag === 3 ? -0.35 : Math.max(0.2, Math.min(1.4, 0.65 + delta * 12));
  const bonus = roundW(Math.max(-0.22, Math.min(0.32, (wr - 0.5) * 0.45 + delta * 2.2)));
  const pairId = idxA <= idxB ? `PAIR:${cardIdA}+${cardIdB}` : `PAIR:${cardIdB}+${cardIdA}`;

  return {
    id: pairId,
    pairIndex: pIdx,
    cardA: cardIdA,
    cardB: cardIdB,
    nameA,
    nameB,
    cat: 'pairwise_synergy',
    catLabel: archetypeLabel,
    games: pairwiseDb.gamesPerPair || 1000,
    wr,
    delta,
    bestRegime,
    regimeLabel,
    archetypeTag,
    archetypeLabel,
    title: `${nameA} × ${nameB}（${regimeLabel}）`,
    rule,
    wIdx: wd.idx,
    wVal: wd.val.map((v) => roundW(v * scale)),
    bonus
  };
}

export function matchDeckStrategies(deck, lineup = [], lexicon = null, baseWeights = [], pairwiseDb = null, cardsById = null) {
  const base = Array.isArray(baseWeights) && baseWeights.length === 22
    ? baseWeights.map(Number)
    : Array(22).fill(0);
  const idx = ensureLexiconIndex(lexicon);
  const pairTotal = pairwiseDb?.totalPairwiseEntries || 0;
  const singleTotal = lexicon?.totalEntries || lexicon?.entries?.length || 0;
  if ((!idx && !pairwiseDb) || !deck?.cards?.length) {
    return {
      totalLexiconCount: singleTotal + pairTotal,
      singleLexiconCount: singleTotal,
      pairwiseLexiconCount: pairTotal,
      matchedCount: 0,
      cardMatchedCount: 0,
      macroMatchedCount: 0,
      pairMatchedCount: 0,
      cardBonusById: {},
      lexiconSeedWeights: [...base],
      topActiveStrategies: [],
      activePairStrategies: [],
      matchedIds: []
    };
  }

  const matched = [];
  const cardBonusSum = new Map();
  const cardBonusCnt = new Map();
  const wAccum = Array(22).fill(0);
  const wHits = Array(22).fill(0);
  const seenCardIds = new Set();
  const uniqueDeckItems = [];

  // 1. 匹配本牌組內每一張寶可夢卡與訓練家卡對應的單卡策略詞條
  for (const item of deck.cards) {
    if (!item?.id || seenCardIds.has(item.id)) continue;
    seenCardIds.add(item.id);
    uniqueDeckItems.push(item);
    const list = idx?.byCardId.get(item.id) || [];
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
  for (const r of idx?.macro || []) {
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

  // 3. 查詢 10M 級全卡兩兩千局實測雙卡協同詞條庫（本牌組內所有 C(K,2) 雙卡組合 + 滿編雙張組合）
  const activePairStrategies = [];
  if (pairwiseDb?.matrix) {
    for (let i = 0; i < uniqueDeckItems.length; i++) {
      const a = uniqueDeckItems[i];
      for (let j = i; j < uniqueDeckItems.length; j++) {
        const b = uniqueDeckItems[j];
        if (i === j && Number(a.count || 1) < 2) continue;
        const ps = lookupPairwiseStrategy(pairwiseDb, a.id, b.id, cardsById);
        if (!ps) continue;
        activePairStrategies.push(ps);
        const weightFactor = ps.archetypeTag === 2 ? 0.55 : ps.archetypeTag === 1 ? 0.45 : ps.archetypeTag === 3 ? 0.25 : 0.30;
        cardBonusSum.set(a.id, (cardBonusSum.get(a.id) || 0) + ps.bonus * weightFactor);
        cardBonusCnt.set(a.id, (cardBonusCnt.get(a.id) || 0) + weightFactor);
        if (b.id !== a.id) {
          cardBonusSum.set(b.id, (cardBonusSum.get(b.id) || 0) + ps.bonus * weightFactor);
          cardBonusCnt.set(b.id, (cardBonusCnt.get(b.id) || 0) + weightFactor);
        }
        for (let k = 0; k < ps.wIdx.length; k++) {
          const fi = ps.wIdx[k];
          if (fi >= 0 && fi < 22) {
            wAccum[fi] += Number(ps.wVal[k] || 0) * weightFactor;
            wHits[fi] += weightFactor;
          }
        }
      }
    }
    activePairStrategies.sort((x, y) => (y.delta * 2.2 + y.wr) - (x.delta * 2.2 + x.wr));
  }
  const pairMatchedCount = activePairStrategies.length;

  const cardBonusById = {};
  for (const [cid, sum] of cardBonusSum.entries()) {
    cardBonusById[cid] = roundW(sum / Math.max(0.01, cardBonusCnt.get(cid) || 1));
  }

  // 將單卡 + 雙卡協同策略的 22 維戰術方向平滑融合至基礎模型作為推演種子權重
  const lexiconSeedWeights = base.map((b, k) => {
    const avgShift = wHits[k] > 0 ? wAccum[k] / wHits[k] : 0;
    return roundW(b + Math.max(-0.45, Math.min(0.45, avgShift * 0.55)));
  });

  const catLabels = lexicon?.catLabelsZh || {};
  const cats = lexicon?.cats || [];
  const sortedSingle = [...matched].sort((a, b) => (Number(b[8] || 0) + Number(b[7] || 0) * 0.2) - (Number(a[8] || 0) + Number(a[7] || 0) * 0.2));
  const topSingle = sortedSingle.slice(0, 8).map((r) => ({
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
  const topPairs = activePairStrategies.slice(0, 8).map((ps) => ({
    id: ps.id,
    cat: ps.cat,
    catLabel: ps.catLabel,
    cardId: ps.cardA,
    cardIdB: ps.cardB,
    target: `${ps.cardA}+${ps.cardB}`,
    title: ps.title,
    rule: ps.rule,
    games: ps.games,
    wr: ps.wr,
    delta: ps.delta
  }));
  const topActiveStrategies = [...topPairs.slice(0, 6), ...topSingle.slice(0, 6)];

  return {
    totalLexiconCount: singleTotal + pairTotal,
    singleLexiconCount: singleTotal,
    pairwiseLexiconCount: pairTotal,
    matchedCount: matched.length + pairMatchedCount,
    cardMatchedCount,
    macroMatchedCount,
    pairMatchedCount,
    cardBonusById,
    lexiconSeedWeights,
    topActiveStrategies,
    activePairStrategies: activePairStrategies.slice(0, 40),
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

const TRAINER_TYPE_RESTRICTIONS = [
  ['grass', /\[\s*草\s*\]|草屬性|草能量|(?<![\u4e00-\u9fff])草寶可夢|Grass\s+Pok[eé]mon|Grass\s+Energy/i],
  ['fire', /\[\s*火\s*\]|火屬性|火能量|(?<![\u4e00-\u9fff])火寶可夢|Fire\s+Pok[eé]mon|Fire\s+Energy/i],
  ['water', /\[\s*水\s*\]|水屬性|水能量|(?<![\u4e00-\u9fff])水寶可夢|Water\s+Pok[eé]mon|Water\s+Energy/i],
  ['lightning', /\[\s*雷\s*\]|雷屬性|雷能量|(?<![\u4e00-\u9fff])雷寶可夢|Lightning\s+Pok[eé]mon|Lightning\s+Energy/i],
  ['psychic', /\[\s*超\s*\]|超屬性|超能量|(?<![\u4e00-\u9fff])超寶可夢|Psychic\s+Pok[eé]mon|Psychic\s+Energy/i],
  ['fighting', /\[\s*鬥\s*\]|鬥屬性|鬥能量|Fighting\s+Pok[eé]mon|Fighting\s+Energy/i],
  ['darkness', /\[\s*惡\s*\]|惡屬性|惡能量|(?<![\u4e00-\u9fff])惡寶可夢|Darkness\s+Pok[eé]mon|Darkness\s+Energy/i],
  ['metal', /\[\s*鋼\s*\]|鋼屬性|鋼能量|(?<![\u4e00-\u9fff])鋼寶可夢|Metal\s+Pok[eé]mon|Metal\s+Energy/i],
  ['colorless', /\[\s*無\s*\]寶可夢|無色屬性|無色寶可夢|Colorless\s+Pok[eé]mon/i]
];

const GENERIC_QUOTED_TERMS = /^(硬幣|正面|反面|能量|進化|道具|基礎|支援者|物品|競技場|手牌|牌庫|戰鬥場|備戰區|寶可夢ex|超級進化寶可夢ex|寶可夢道具|究極異獸|化石|弱點|特性|招式|傷害|分數|分)$/;

function normCardNameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function replaceDeckCardOnce(deck, oldCardId, newCardId, cardsById = null) {
  const nextCards = [];
  let removed = false;
  let merged = false;
  for (const item of deck?.cards || []) {
    if (!removed && item.id === oldCardId) {
      removed = true;
      const left = Number(item.count || 1) - 1;
      if (left > 0) nextCards.push({ id: item.id, count: left });
    } else {
      nextCards.push({ id: item.id, count: Number(item.count || 1) });
    }
  }
  for (const item of nextCards) {
    if (item.id === newCardId) {
      item.count += 1;
      merged = true;
      break;
    }
  }
  if (!merged) nextCards.push({ id: newCardId, count: 1 });
  const nextDeck = {
    ...structuredClone(deck),
    cards: nextCards,
    updatedAt: new Date().toISOString()
  };
  if (cardsById) {
    const issues = validateDeck(nextDeck, cardsById);
    if (issues.length > 0) throw Error(issues[0]);
  }
  return nextDeck;
}

export function isCardCompatibleWithDeck(card, ctx) {
  if (!card || !ctx) return true;
  const {
    deckEnergySet,
    remainingTypes,
    remainingNames,
    remainingEvolvesFromSet,
    validStage2Keys,
    hasStage1,
    hasStage2,
    hasMega,
    hasUltraBeast,
    hasAncient,
    hasFuture,
    hasTool,
    hasStadium,
    hasLowHpBasic,
    hasRareCandyTarget
  } = ctx;

  const isFossil = card.subtype === 'fossil' || /化石|Fossil/i.test(`${card.name || ''} ${card.nameEn || ''}`);
  if (isFossil) {
    const myKeys = [card.name, card.nameEn, card.limitName].map(normCardNameKey).filter(Boolean);
    return myKeys.some((k) => remainingEvolvesFromSet?.has(k));
  }

  if (card.type === 'pokemon') {
    // 1. 檢查進化鏈是否在剩餘 19 張牌中存在對應前階
    if (card.stage === 'stage1') {
      const preKey = normCardNameKey(card.evolvesFrom);
      if (!preKey || !remainingNames.has(preKey)) return false;
    } else if (card.stage === 'stage2') {
      const preKey = normCardNameKey(card.evolvesFrom);
      const myKey = normCardNameKey(card.limitName || card.nameEn || card.name);
      if ((!preKey || !remainingNames.has(preKey)) && !validStage2Keys.has(myKey)) return false;
    }

    // 2. 檢查是否至少有一個招式可用牌組設定的能量支付（0 費或全無色也算可支付）
    const attacks = Array.isArray(card.attacks) ? card.attacks : [];
    if (attacks.length > 0 && deckEnergySet?.size > 0) {
      const hasPlayableAttack = attacks.some((atk) => {
        const costs = Array.isArray(atk.cost) ? atk.cost : [];
        return costs.every((sym) => {
          const k = String(sym || '').toLowerCase();
          return !k || k === 'colorless' || deckEnergySet.has(k);
        });
      });
      if (!hasPlayableAttack) {
        // 僅當該寶可夢具備無需異色能量也能在後排發揮作用的強特性時才放行（否則無法攻擊）
        const hasEnergyFreeBenchAb = (card.abilities || []).some((ab) => {
          const ae = String(ab.effect || '');
          return /備戰區|每回合.*1次|傷害|恢復|抽.*張|撤退/i.test(ae) && !/\[[草火水雷超鬥惡鋼]\]能量/.test(ae);
        });
        if (!hasEnergyFreeBenchAb) return false;
      }
    }
    return true;
  }

  if (card.type === 'trainer') {
    const nameStr = `${card.name || ''} ${card.nameEn || ''}`;
    const eff = `${card.effect || ''}`;

    // 1. 檢查自身屬性 / 能量限制（忽略專門針對對手能量的干擾卡如「傑尼龜噴壺」）
    const isOpponentOnlyEnergyTarget = /將對手的.*寶可夢身上的.*\[[草火水雷超鬥惡鋼]\]能量/.test(eff)
      && !/自己的.*\[[草火水雷超鬥惡鋼]\]/.test(eff);
    if (!isOpponentOnlyEnergyTarget) {
      const matchedTypes = [];
      for (const [typeKey, rx] of TRAINER_TYPE_RESTRICTIONS) {
        if (rx.test(eff)) matchedTypes.push(typeKey);
      }
      if (matchedTypes.length > 0) {
        const hasMatch = matchedTypes.some((t) => remainingTypes.has(t) || deckEnergySet.has(t));
        if (!hasMatch) return false;
      }
    }

    // 2. 檢查階段與特殊類別依賴
    if (/神奇糖果|奇異糖果|Rare Candy/i.test(nameStr)) {
      if (!hasRareCandyTarget) return false;
    } else if (/2階進化寶可夢|Stage 2/i.test(eff) && !hasStage2) {
      return false;
    } else if (/1階進化寶可夢|Stage 1/i.test(eff) && !hasStage1) {
      return false;
    }

    if (/從自己的牌庫.*超級進化|自己的.*超級進化/i.test(eff) && !/除外/.test(eff) && !hasMega) {
      return false;
    }
    if (/究極異獸|Ultra Beast/i.test(eff) && !/除外/.test(eff) && !hasUltraBeast) {
      return false;
    }
    if (/古代寶可夢|Ancient\s+Pok[eé]mon/i.test(eff) && !hasAncient) {
      return false;
    }
    if (/未來寶可夢|Future\s+Pok[eé]mon/i.test(eff) && !hasFuture) {
      return false;
    }
    if (/從自己的牌庫.*「寶可夢道具」|寶可夢工具卡交換/.test(eff) && !hasTool) {
      return false;
    }
    if (/從自己的牌庫.*「競技場」/.test(eff) && !hasStadium) {
      return false;
    }
    if (/HP為50以下的基礎寶可夢/.test(eff) && !hasLowHpBasic) {
      return false;
    }

    // 3. 檢查點名特定寶可夢的專屬訓練家卡（排除卡牌自稱與通用名詞）
    const ownNames = new Set([card.name, card.nameEn, card.limitName].map(normCardNameKey).filter(Boolean));
    const quoted = [...eff.matchAll(/[「“]([^」”]{2,16})[」”]/g)]
      .map((m) => m[1].trim())
      .filter((w) => w && !GENERIC_QUOTED_TERMS.test(w) && !ownNames.has(normCardNameKey(w)));
    if (quoted.length > 0) {
      const hasAny = quoted.some((q) => {
        const nk = normCardNameKey(q);
        for (const rn of remainingNames) {
          if (rn.includes(nk) || nk.includes(rn)) return true;
        }
        if (remainingEvolvesFromSet?.has(nk)) return true;
        return false;
      });
      if (!hasAny) return false;
    }
  }
  return true;
}

export function encodeCardForOptimizer(card, strategyBonus = 0, ctx = null) {
  const base = encodeCardForFastSim(card, strategyBonus, ctx?.cardsById || null);
  if (!card || !ctx) return base;

  const { deckEnergySet } = ctx;
  if (!isCardCompatibleWithDeck(card, ctx)) {
    if (card.type === 'pokemon') {
      base.stage = 99;
      base.atkDmg = 0;
      base.atkFlags = 0;
      base.abFlags = 0;
    } else {
      base.trainerKind = 0;
      base.effectVal = 0;
    }
    base.strategyBonus = 0;
    return base;
  }

  if (card.type === 'pokemon') {
    const attacks = Array.isArray(card.attacks) ? card.attacks : [];
    if (attacks.length > 0 && deckEnergySet?.size > 0) {
      let playableDmg = 0;
      let playableCost = 99;
      for (const atk of attacks) {
        const costs = Array.isArray(atk.cost) ? atk.cost : [];
        const canPay = costs.every((sym) => {
          const k = String(sym || '').toLowerCase();
          return !k || k === 'colorless' || deckEnergySet.has(k);
        });
        if (canPay) {
          const { dmgNum } = computeExpectedAttackDamage(atk);
          const costLen = Math.max(1, Math.min(5, costs.length || 1));
          if (dmgNum > playableDmg || (dmgNum === playableDmg && costLen < playableCost)) {
            playableDmg = dmgNum;
            playableCost = costLen;
          }
        }
      }
      if (playableCost === 99) {
        base.atkDmg = 0;
        base.atkFlags = 0;
      } else {
        base.atkDmg = playableDmg;
        base.atkCost = playableCost;
      }
    }
  }
  return base;
}

function rarityPreferenceScore(card, collection = {}) {
  let score = 0;
  if (collection && Number(collection[card.id] || 0) > 0) score += 100;
  const r = String(card.rarity || '');
  if (/^◇{1,4}$/.test(r)) score += 40;
  else if (r === '★') score += 20;
  if (!String(card.id || '').startsWith('P-')) score += 10;
  return score;
}

export function buildLegalReplacementCandidates({
  deck,
  targetCardId,
  allCards = [],
  cardsById = new Map(),
  collection = {},
  cardBonusById = {}
}) {
  const remainingEntries = [];
  let removed = false;
  for (const item of deck?.cards || []) {
    if (!removed && item.id === targetCardId) {
      removed = true;
      const left = Number(item.count || 1) - 1;
      if (left > 0) remainingEntries.push({ id: item.id, count: left });
    } else {
      remainingEntries.push({ id: item.id, count: Number(item.count || 1) });
    }
  }
  if (!removed) throw Error('所選卡牌不在此牌組中');

  const remainingNameCounts = new Map();
  const remainingNames = new Set();
  const remainingEvolvesFromSet = new Set();
  const remainingTypes = new Set();
  let remainingBasics = 0;
  let hasRareCandy = false;
  let hasStage1 = false;
  let hasStage2 = false;
  let hasMega = false;
  let hasUltraBeast = false;
  let hasAncient = false;
  let hasFuture = false;
  let hasTool = false;
  let hasStadium = false;
  let hasLowHpBasic = false;

  for (const entry of remainingEntries) {
    const c = cardsById.get(entry.id);
    if (!c) continue;
    const limitKey = c.limitName || c.nameEn || c.name;
    remainingNameCounts.set(limitKey, (remainingNameCounts.get(limitKey) || 0) + entry.count);
    for (const nm of [c.name, c.nameEn, c.limitName]) {
      const nk = normCardNameKey(nm);
      if (nk) remainingNames.add(nk);
    }
    if (c.evolvesFrom) {
      const ef = normCardNameKey(c.evolvesFrom);
      if (ef) remainingEvolvesFromSet.add(ef);
    }
    if (c.type === 'pokemon') {
      if (c.stage === 'basic') {
        remainingBasics += entry.count;
        if (Number(c.hp || 999) <= 50) hasLowHpBasic = true;
      } else if (c.stage === 'stage1') {
        hasStage1 = true;
      } else if (c.stage === 'stage2') {
        hasStage2 = true;
      }
      const cats = c._pokeCats || getPokemonCategories(c);
      if (cats.includes('mega')) hasMega = true;
      if (cats.includes('ultrabeast')) hasUltraBeast = true;
      if (cats.includes('ancient') || /古代|Ancient/i.test(`${c.subtype || ''} ${(c.tags || []).join(' ')}`)) hasAncient = true;
      if (cats.includes('future') || /未來|Future/i.test(`${c.subtype || ''} ${(c.tags || []).join(' ')}`)) hasFuture = true;
      for (const t of c.types || []) remainingTypes.add(String(t || '').toLowerCase());
    } else {
      if (c.subtype === 'tool') hasTool = true;
      if (c.subtype === 'stadium') hasStadium = true;
      if (/神奇糖果|奇異糖果|Rare Candy/i.test(`${c.name || ''} ${c.nameEn || ''}`)) {
        hasRareCandy = true;
      }
    }
  }

  // 建立剩餘牌組中的基礎 -> 1階 -> 2階進化鏈索引，用於判定神奇糖果與 2 階進化卡的相容性
  const stage1FromRemainingBasics = new Set();
  for (const c of allCards) {
    if (c.type === 'pokemon' && c.stage === 'stage1' && remainingNames.has(normCardNameKey(c.evolvesFrom))) {
      for (const nm of [c.name, c.nameEn, c.limitName]) {
        const nk = normCardNameKey(nm);
        if (nk) stage1FromRemainingBasics.add(nk);
      }
    }
  }
  const allReachableStage2Keys = new Set();
  for (const c of allCards) {
    if (c.type === 'pokemon' && c.stage === 'stage2' && stage1FromRemainingBasics.has(normCardNameKey(c.evolvesFrom))) {
      const mk = normCardNameKey(c.limitName || c.nameEn || c.name);
      if (mk) allReachableStage2Keys.add(mk);
    }
  }
  const validStage2Keys = hasRareCandy ? allReachableStage2Keys : new Set();
  const hasRareCandyTarget = remainingEntries.some((entry) => {
    const c = cardsById.get(entry.id);
    if (!c || c.type !== 'pokemon' || c.stage !== 'stage2') return false;
    return allReachableStage2Keys.has(normCardNameKey(c.limitName || c.nameEn || c.name));
  });

  const deckEnergySet = new Set((deck?.energy || []).map((e) => String(e || '').toLowerCase()));
  const optCtx = {
    deckEnergySet,
    remainingTypes,
    remainingNames,
    remainingEvolvesFromSet,
    validStage2Keys,
    hasStage1,
    hasStage2,
    hasMega,
    hasUltraBeast,
    hasAncient,
    hasFuture,
    hasTool,
    hasStadium,
    hasLowHpBasic,
    hasRareCandyTarget,
    cardsById
  };

  // Build fixed 19-card base deck array for FastSim / WebGPU
  const baseCards19 = [];
  for (const entry of remainingEntries) {
    const card = cardsById.get(entry.id);
    const enc = encodeCardForFastSim(card, Number(cardBonusById[entry.id] || 0), cardsById);
    for (let k = 0; k < entry.count; k++) {
      if (baseCards19.length < 19) baseCards19.push(enc);
    }
  }
  const origCard = cardsById.get(targetCardId);
  const origEnc = encodeCardForOptimizer(origCard, Number(cardBonusById[targetCardId] || 0), optCtx);
  const baseDeck20 = [...baseCards19, origEnc];

  const groups = new Map();
  let totalLegalChecked = 0;
  let incompatibleCount = 0;

  // Always insert original card first as baseline (#0)
  const origGroupKey = `__ORIG__:${targetCardId}`;
  groups.set(origGroupKey, {
    card: origCard,
    encoded: origEnc,
    isOriginal: true,
    compatible: true,
    representedCount: 1,
    prefScore: 9999
  });

  const origLimitKey = origCard ? (origCard.limitName || origCard.nameEn || origCard.name) : '';

  for (const card of allCards) {
    if (!card || card.legal === false || card.playable === false) continue;
    const limitKey = card.limitName || card.nameEn || card.name;
    if ((remainingNameCounts.get(limitKey) || 0) >= 2) continue;
    if (remainingBasics === 0 && !(card.type === 'pokemon' && card.stage === 'basic')) continue;

    totalLegalChecked++;
    if (card.id === targetCardId) continue;

    // 過濾在當前牌組中根本無法發動效果的死牌（異色專屬訓練家、缺前階進化卡、缺能攻擊寶可夢等）
    if (!isCardCompatibleWithDeck(card, optCtx)) {
      incompatibleCount++;
      continue;
    }

    const bonus = Number(cardBonusById[card.id] || 0);
    const enc = encodeCardForOptimizer(card, bonus, optCtx);

    // Skip functionally identical reprints of the exact same card already being replaced
    if (limitKey === origLimitKey && enc.hp === origEnc.hp && enc.atkDmg === origEnc.atkDmg && enc.atkCost === origEnc.atkCost && enc.trainerKind === origEnc.trainerKind && enc.effectVal === origEnc.effectVal) {
      groups.get(origGroupKey).representedCount++;
      continue;
    }

    // 依卡牌實質功能分組（訓練家直接以卡名分組，避免同效異畫重複測試，但保留所有不同名稱的訓練家卡！）
    const fKey = card.type === 'trainer'
      ? `T|${normCardNameKey(limitKey)}`
      : [
          'P', normCardNameKey(limitKey), enc.stage, enc.typeCode, enc.weakCode,
          enc.hp, enc.retreat, enc.prize, enc.atkCost, enc.atkDmg,
          enc.atkFlags, enc.abFlags
        ].join('|');

    const pref = rarityPreferenceScore(card, collection);
    const existing = groups.get(fKey);
    if (!existing) {
      groups.set(fKey, {
        card,
        encoded: enc,
        isOriginal: false,
        compatible: true,
        representedCount: 1,
        prefScore: pref
      });
    } else {
      existing.representedCount++;
      if (pref > existing.prefScore) {
        existing.card = card;
        existing.encoded = enc;
        existing.prefScore = pref;
      }
    }
  }

  return {
    baseDeck20,
    origCard,
    optCtx,
    remainingNameCounts,
    remainingBasics,
    totalCatalogCount: allCards.length,
    totalLegalChecked,
    incompatibleCount,
    candidates: [...groups.values()]
  };
}



