export const energyNames = {Grass:'草', Fire:'火', Water:'水', Lightning:'雷', Psychic:'超', Fighting:'鬥', Darkness:'惡', Metal:'鋼'};
export const ENERGY_TYPE_KEYS = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
export const typeNames = {...energyNames, Colorless:'無色', Dragon:'龍', Fairy:'妖精', Trainer:'訓練家'};
export const titleCase = value => String(value || '').toLowerCase().replace(/^./, s => s.toUpperCase());

export function packAttackEnergyCost(costArr = []) {
  let packed = 0;
  const cnts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const sym of Array.isArray(costArr) ? costArr : []) {
    const k = String(sym || '').toLowerCase();
    const idx = ENERGY_TYPE_KEYS.findIndex((e) => e.toLowerCase() === k);
    if (idx >= 0 && cnts[idx] < 15) cnts[idx]++;
  }
  for (let t = 0; t < 8; t++) packed |= (cnts[t] & 0xf) << (t * 4);
  return packed | 0;
}

export function encodeDeckEnergyMask(energyList = [], fallbackCards = []) {
  let mask = 0;
  for (const e of Array.isArray(energyList) ? energyList : []) {
    const k = titleCase(e);
    const idx = ENERGY_TYPE_KEYS.indexOf(k);
    if (idx >= 0) mask |= (1 << idx);
  }
  if (mask !== 0) return mask & 0xff;
  // Auto-infer from deck's colored attack requirements (or Pokémon types) when deck.energy is omitted
  const score = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of Array.isArray(fallbackCards) ? fallbackCards : []) {
    if (!c) continue;
    const e1 = (c.v3Tpl && c.v3Tpl.length >= 26) ? (c.v3Tpl[23] >>> 0) : ((c.a1Ecost || 0) >>> 0);
    const e2 = (c.v3Tpl && c.v3Tpl.length >= 26) ? (c.v3Tpl[24] >>> 0) : ((c.a2Ecost || 0) >>> 0);
    for (let t = 0; t < 8; t++) {
      const n = ((e1 >>> (t * 4)) & 0xf) + ((e2 >>> (t * 4)) & 0xf);
      if (n > 0) score[t] += n * 4;
    }
    const tc = c.typeCode;
    if (c.isPokemon && tc >= 0 && tc < 8) score[tc] += 1;
  }
  const ranked = score
    .map((s, t) => ({ t, s }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  for (const r of ranked) mask |= (1 << r.t);
  return (mask || 0x02) & 0xff; // Fallback Fire if pure Colorless
}

// 檢查牌組內是否有寶可夢的招式需要未加入能量區的屬性（排除可由牌組內自產特性／訓練家補足的屬性）
export function findDeckEnergyMismatches(deck, cardsById) {
  if (!deck || !Array.isArray(deck.cards) || !cardsById?.get) return [];
  const zoneSet = new Set((deck.energy || []).map((e) => titleCase(e)).filter((k) => Object.hasOwn(energyNames, k)));
  const selfProduced = new Set();
  for (const entry of deck.cards) {
    const card = cardsById.get(entry.id);
    if (!card) continue;
    const tpl = getCardV3Template(card.id);
    if (tpl && tpl.length >= 26) {
      const effEtypes = tpl[25] >>> 0;
      const abOp = tpl[17] & 0xff;
      const trnKind = tpl[19] & 0xff;
      const trnSub = (tpl[19] >>> 8) & 0xff;
      const abTrnEt = effEtypes & 0xff;
      // Self/ally Energy Zone generators (e.g. Magneton [L], Giratina ex [P], Gardevoir [P], Zeraora [L], Charmeleon [R], Misty [W], Brock [F], Kiawe [R], Fantina [P], Rika [F], Electric Generator [L])
      if ((abOp === 3 || abOp === 4 || (abOp === 5 && (tpl[18] | 0) === 1) || (abOp === 9 && (tpl[18] | 0) === 5) || (abOp === 13 && (((tpl[18] >>> 8) & 0xff) === 2))) && abTrnEt < 8) {
        selfProduced.add(ENERGY_TYPE_KEYS[abTrnEt]);
      }
      if (trnKind === 6 && (trnSub === 5 || trnSub === 6 || trnSub === 12 || trnSub === 13) && abTrnEt < 8) {
        selfProduced.add(ENERGY_TYPE_KEYS[abTrnEt]);
      }
      for (const shift of [8, 16]) {
        const aOp1 = (shift === 8 ? tpl[9] : tpl[14]) & 0xff;
        const aOp2 = ((shift === 8 ? tpl[9] : tpl[14]) >>> 8) & 0xff;
        if (aOp1 === 13 || aOp2 === 13) {
          const et = (effEtypes >>> shift) & 0xff;
          if (et < 8) selfProduced.add(ENERGY_TYPE_KEYS[et]);
          else if (et === 250) { selfProduced.add('Fire'); selfProduced.add('Water'); selfProduced.add('Lightning'); }
          else if (et === 251) { selfProduced.add('Water'); selfProduced.add('Lightning'); }
        }
      }
    }
  }
  const issues = [];
  const seen = new Set();
  for (const entry of deck.cards) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const card = cardsById.get(entry.id);
    if (!card || card.type !== 'pokemon' || !Array.isArray(card.attacks)) continue;
    for (const atk of card.attacks) {
      const missing = [];
      for (const sym of Array.isArray(atk.cost) ? atk.cost : []) {
        const k = titleCase(sym);
        if (!Object.hasOwn(energyNames, k)) continue;
        if (!zoneSet.has(k) && !missing.includes(k)) missing.push(k);
      }
      if (missing.length > 0) {
        const uncovered = missing.filter((k) => !selfProduced.has(k));
        if (uncovered.length > 0) {
          issues.push({
            cardId: card.id,
            cardName: card.name,
            attackName: atk.name || '招式',
            missingTypes: uncovered
          });
        }
      }
    }
  }
  return issues;
}
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

let CARD_MECHANICS_DB = null;

export function setCardMechanicsDb(db) {
  CARD_MECHANICS_DB = db && db.cards && Array.isArray(db.templates) ? db : null;
}

export function getCardMechanicsDb() {
  return CARD_MECHANICS_DB;
}

export function getCardV3Template(cardId) {
  if (!CARD_MECHANICS_DB || !cardId) return null;
  const idx = CARD_MECHANICS_DB.cards[cardId];
  return idx != null ? CARD_MECHANICS_DB.templates[idx] : null;
}

function estAtkPowerV3(dmg, op1, val1) {
  let d = dmg | 0;
  const b0 = val1 & 0xff;
  const b1 = (val1 >> 8) & 0xff;
  const b2 = (val1 >> 16) & 0xff;
  if (op1 === 3) {
    d = b0 === 3 ? d + Math.floor(b1 / 2) : b0 === 4 ? 35 : Math.floor(d / 2);
  } else if (op1 === 4) {
    if (b2 & 32) d += Math.floor((b1 * 3) / 2);
    else if (b2 & 8) d = b1 * 2;
    else if (b2 & 6) d = Math.floor((b1 * 3) / 2);
    else d = b0 === 99 ? b1 : Math.floor((b1 * b0) / 2);
  } else if (op1 === 5) {
    if (b0 === 97) d += 45;
    else if (b0 === 98) d += Math.floor(b1 / 4);
    else if (b0 === 99) d += b1;
    else if (b2 === 2 || b2 === 3) d += b1 * 2;
    else d += Math.floor((b1 * b0) / 2);
  } else if (op1 === 6) {
    if (b0 === 26) d = b1 * 3;
    else if (b0 === 31 || b0 === 32) d += 50;
    else if (b0 === 33) d = Math.max(20, d - 30);
    else if (b0 === 2 || b0 === 5) d += b1 * 4;
    else d += b1 * 2;
  } else if (op1 === 7) {
    if (b0 === 3) d = Math.max(20, d - Math.floor(b1 / 3));
    else d += Math.floor(b1 / 2);
  } else if (op1 === 8) {
    if (b0 === 2 || b0 === 3 || b0 === 4) d = b1;
    else if (b0 === 6) d = b1 * 3;
    else if (b0 === 8) d = b1 * (b2 === 99 ? 3 : Math.max(1, b2));
    else if (b0 === 10) d = Math.floor((b1 * Math.max(1, b2)) / 2);
    else if (b0 === 11 || b0 === 14) d = b1 * 2;
    else if (b0 === 12) d = b2 === 1 ? 140 : b1;
    else d += Math.floor(b1 / 2);
  } else if (op1 === 19) {
    if (b0 === 8) d += b1;
  } else if (op1 === 20) {
    d = b0 === 1 ? 150 : b0 === 6 ? 80 : 60;
  }
  return d;
}

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

// 精準解析單一招式的真實基礎傷害與追加效果操作碼（覆蓋全卡庫 588 種招式效果，供 WASM/WebGPU 雙引擎實戰逐項執行）
export function encodeAttackForFastSim(atk) {
  if (!atk) return { cost: 255, dmg: 0, op: 0, val: 0 };
  const cost = Math.max(0, Math.min(5, (atk.cost || []).length));
  const rawDmgStr = String(atk.damage || '').trim();
  const parsedNum = parseInt(rawDmgStr.replace(/[^0-9]/g, ''), 10) || 0;
  const eff = String(atk.effect || '').trim();

  if (!eff) {
    return { cost, dmg: parsedNum, op: 0, val: 0 };
  }

  // 28. 直接氣絕／丟棄／HP減半（猛雷鼓、吼叫尾、穿著熊、大牙狸）
  if (/擲\s*2\s*次硬幣.*全部為正面.*氣絕|擲\s*2\s*次硬幣.*全部為正面.*昏厥|flip 2 coins.*both.*Knock Out/i.test(eff)) {
    return { cost, dmg: 0, op: 28, val: 3 };
  }
  if (/將對手的戰鬥寶可夢(?:氣絕|昏厥)|Knock Out your opponent's Active/i.test(eff)) {
    return { cost, dmg: 0, op: 28, val: 1 };
  }
  if (/將對手的戰鬥寶可夢丟棄|discard your opponent's Active Pok[eé]mon/i.test(eff)) {
    return { cost, dmg: 0, op: 28, val: 2 };
  }
  if (/剩餘HP變為一半|remaining HP.*in half/i.test(eff)) {
    return { cost, dmg: 0, op: 28, val: 4 };
  }

  // 27. 上場後首次攻擊加傷並麻痺（鐵包袱ex）
  if (/上場後首次使用招式|first time this Pok[eé]mon has used an attack/i.test(eff)) {
    const m = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (2 << 8) | Math.min(255, Number(m?.[1] || m?.[2] || 20)) };
  }

  // 10. 備戰／場上寶可夢數量動態倍率／加傷（水君ex、超級七夕青鳥ex、皮卡丘ex、不良蛙、毒骷蛙）
  if (/場上寶可夢的數量擲硬幣|flip a coin for each of your Pok[eé]mon/i.test(eff)) {
    const perM = eff.match(/[×x]\s*(\d+)|(\d+)\s*damage/i);
    return { cost, dmg: 0, op: 10, val: (3 << 8) | Math.min(255, Number(perM?.[1] || perM?.[2] || parsedNum || 20)) };
  }
  if (/備戰寶可夢的數量|備戰區.*寶可夢的數量|benched Pok[eé]mon/i.test(eff) && !/受到.*傷害|damage to.*benched/i.test(eff)) {
    const perM = eff.match(/[×x]\s*(\d+)|(\d+)\s*(?:more )?damage for each/i);
    const perUnit = Math.min(255, Number(perM?.[1] || perM?.[2] || parsedNum || 20));
    const isBoth = /雙方/.test(eff);
    const isOpp = !isBoth && /對手/.test(eff);
    const mode = isBoth ? 2 : isOpp ? 1 : 0;
    const base = rawDmgStr.includes('×') ? 0 : parsedNum;
    return { cost, dmg: base, op: 10, val: (mode << 8) | perUnit };
  }

  // 13. 額外附有指定能量數觸發加傷（炎帝ex、水箭龜ex、西獅海壬ex）
  if (/額外附有|extra.*energy/i.test(eff)) {
    const reqM = eff.match(/額外附有\s*(\d+)|(\d+)\s*extra/i);
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    const extraNeed = Math.max(1, Math.min(5, Number(reqM?.[1] || reqM?.[2] || 1)));
    const bonus = Math.min(255, Number(addM?.[1] || addM?.[2] || 40));
    return { cost, dmg: parsedNum, op: 13, val: (extraNeed << 8) | bonus };
  }

  // 11. 自身能量數量動態加傷／擲硬幣（密勒頓ex、超級超夢Yex）
  if (/這隻寶可夢身上.*能量.*數量|這隻寶可夢身上每附有|for each.*Energy attached to this Pok[eé]mon/i.test(eff)) {
    const perM = eff.match(/[×x]\s*(\d+)|增加\s*(\d+)|(\d+)\s*(?:more )?damage/i);
    const perUnit = Math.min(255, Number(perM?.[1] || perM?.[2] || perM?.[3] || parsedNum || 20));
    if (/擲.*硬幣|flip a coin/i.test(eff)) {
      return { cost, dmg: 0, op: 11, val: 1000 + perUnit };
    }
    const base = rawDmgStr.includes('×') ? 0 : parsedNum;
    return { cost, dmg: base, op: 11, val: perUnit };
  }

  // 12. 對手能量數量動態加傷（愛管侍ex、夢幻、太陽伊布全場能量、卡璞蝶蝶狙擊能量）
  if (/對手的所有寶可夢身上的能量的數量|for each Energy attached to all of your opponent/i.test(eff)) {
    const perM = eff.match(/[×x]\s*(\d+)|(\d+)\s*damage/i);
    const base = rawDmgStr.includes('×') ? 0 : parsedNum;
    return { cost, dmg: base, op: 12, val: (1 << 8) | Math.min(255, Number(perM?.[1] || perM?.[2] || parsedNum || 20)) };
  }
  if (/對手的1隻寶可夢受到該寶可夢身上的能量的數量|to 1 of your opponent.*for each Energy/i.test(eff)) {
    const perM = eff.match(/[×x]\s*(\d+)|(\d+)\s*damage/i);
    return { cost, dmg: 0, op: 12, val: (2 << 8) | Math.min(255, Number(perM?.[1] || perM?.[2] || 20)) };
  }
  if (/對手的戰鬥寶可夢身上.*能量.*數量|for each.*Energy attached to your opponent's Active/i.test(eff)) {
    const perM = eff.match(/[×x]\s*(\d+)|增加\s*(\d+)|(\d+)\s*(?:more )?damage/i);
    const perUnit = Math.min(255, Number(perM?.[1] || perM?.[2] || perM?.[3] || 20));
    const base = rawDmgStr.includes('×') ? 0 : parsedNum;
    return { cost, dmg: base, op: 12, val: perUnit };
  }

  // 17. 真實備戰狙擊／全場擴散／隨機選中（古劍豹ex、胡帕ex、帕路奇亞ex、三海地鼠ex、快龍流星群、花巖怪、狙射樹梟ex）
  const randSpread = eff.match(/隨機(?:選擇對手的1隻寶可夢|被選擇)\s*(\d+)\s*次[^。]*?(?:受到(?:被選擇的次數\s*[×x]\s*)?)(\d+)\s*點傷害|chosen at random\s*(\d+)\s*times[^.]*do\s*(\d+)\s*damage/i);
  if (randSpread) {
    const times = Math.max(1, Math.min(5, Number(randSpread[1] || randSpread[3] || 3)));
    const perHit = Math.min(255, Number(randSpread[2] || randSpread[4] || 50));
    return { cost, dmg: 0, op: 17, val: ((times + 2) << 8) | perHit };
  }
  const allOpp = eff.match(/對手的所有寶可夢受到\s*(\d+)\s*點傷害|does\s+(\d+)\s+damage to each of your opponent's Pok[eé]mon/i);
  if (allOpp) {
    return { cost, dmg: 0, op: 17, val: (9 << 8) | Math.min(255, Number(allOpp[1] || allOpp[2] || 10)) };
  }
  const dmgSnipe = eff.match(/對手有受到傷害的1隻寶可夢受到\s*(\d+)\s*點傷害|to 1 of your opponent's Pok[eé]mon that has damage/i);
  if (dmgSnipe) {
    return { cost, dmg: 0, op: 17, val: (10 << 8) | Math.min(255, Number(dmgSnipe[1] || 100)) };
  }
  const allBench = eff.match(/對手的(?:所有|全部).*?備戰寶可夢.*?受到\s*(\d+)\s*點傷害|also does\s*(\d+)\s*damage to each of your opponent's Benched/i);
  if (allBench) {
    return { cost, dmg: parsedNum, op: 17, val: (1 << 8) | Math.min(255, Number(allBench[1] || allBench[2] || 20)) };
  }
  const oneBench = eff.match(/對手的1隻備戰寶可夢.*?受到\s*(\d+)\s*點傷害|also does\s*(\d+)\s*damage to 1 of your opponent's Benched/i);
  if (oneBench) {
    return { cost, dmg: parsedNum, op: 17, val: (0 << 8) | Math.min(255, Number(oneBench[1] || oneBench[2] || 20)) };
  }
  const pureSnipe = eff.match(/對手的(?:1隻|任1隻)寶可夢受到\s*(\d+)\s*點傷害|does\s+(\d+)\s+damage\s+to\s+1\s+of\s+your\s+opponent's\s+Pok[eé]mon/i);
  if (pureSnipe && parsedNum === 0) {
    const discAll = /將這隻寶可夢身上的.*能量全部丟棄|discard all.*Energy from this/i.test(eff);
    const mode = discAll ? 8 : 2;
    return { cost, dmg: 0, op: 17, val: (mode << 8) | Math.min(255, Number(pureSnipe[1] || pureSnipe[2] || 50)) };
  }

  // 21. 下回合對手失敗擲幣（自爆磁怪）、無法使用招式（多刺菊石獸/六尾）、降低傷害（叫聲）
  if (/在下個對手的回合.*對手擲.*硬幣|during your opponent's next turn.*flip a coin/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 21, val: 99 };
  }
  if (/受到這個招式的寶可夢無法使用招式|Defending Pok[eé]mon can't attack/i.test(eff)) {
    const isCoin = /擲1次硬幣|flip a coin/i.test(eff);
    return { cost, dmg: parsedNum, op: 21, val: isCoin ? 97 : 98 };
  }
  const weakenOpp = eff.match(/受到這個招式的寶可夢使用招式(?:造成)?的傷害\s*[-−]\s*(\d+)|Defending Pok[eé]mon do\s*[-−](\d+)\s*damage/i);
  if (weakenOpp) {
    return { cost, dmg: parsedNum, op: 21, val: Math.min(96, Number(weakenOpp[1] || weakenOpp[2] || 20)) };
  }

  // 20. 反擊護盾（超級勾魂眼ex、阿羅拉穿山王）、免疫傷害（飛翔/守住）、自身減傷護盾
  const counterM = eff.match(/(?:因攻擊而受到傷害|受到招式的傷害時)[^。]*?(?:對攻擊的寶可夢造成|使用招式的寶可夢受到)\s*(\d+)\s*點傷害/i);
  if (counterM) {
    return { cost, dmg: parsedNum, op: 20, val: 100 + Math.min(100, Number(counterM[1] || 40)) };
  }
  if (/不會受到招式的傷害|prevent all damage from/i.test(eff)) {
    const alsoFail = /若為反面.*這(?:個招|個|招)式失敗|if tails, this attack does nothing/i.test(eff);
    return { cost, dmg: parsedNum, op: 20, val: alsoFail ? 98 : 99 };
  }
  const selfShield = eff.match(/這隻寶可夢受到招式的傷害\s*[-−]\s*(\d+)|this Pok[eé]mon takes\s*[-−](\d+)\s*damage/i);
  if (selfShield) {
    return { cost, dmg: parsedNum, op: 20, val: Math.min(97, Number(selfShield[1] || selfShield[2] || 20)) };
  }

  // 15. 自身反傷（超級噴火龍Yex 50、胡帕ex 20）或己方備戰傷害（閃電鳥 30）
  const recoilM = eff.match(/這隻寶可夢也受到\s*(\d+)\s*點傷害|also does\s*(\d+)\s*damage to itself/i);
  if (recoilM) {
    const rec = Math.min(200, Number(recoilM[1] || recoilM[2] || 20));
    const finalRec = /若為反面|if tails/i.test(eff) ? Math.round(rec * 0.5) : rec;
    return { cost, dmg: parsedNum, op: 15, val: finalRec };
  }
  const selfBenchDmg = eff.match(/自己的(?:1隻)?(?:備戰)?寶可夢也受到\s*(\d+)\s*點傷害/i);
  if (selfBenchDmg) {
    return { cost, dmg: parsedNum, op: 15, val: 1000 + Math.min(100, Number(selfBenchDmg[1] || 20)) };
  }

  // 16. 自身棄能（騎拉帝納ex 棄2、老翁龍 棄1、烈焰猴ex/三首惡龍 棄全部、暴鯉龍ex 雙方隨機棄1）
  const selfDisc = eff.match(/將這隻寶可夢身上的(?:(?:\[[^\]]+\])?能量全部|所有|隨機\s*(\d+)?\s*個|(\d+)\s*個).*能量丟棄|將這隻寶可夢身上的(?:\[[^\]]+\])?能量全部丟棄|discard\s+(\d+|a|an|all)\s+.*energy\s+from\s+this/i);
  if (selfDisc) {
    const isAll = /全部|所有|all/i.test(selfDisc[0]);
    const nDisc = isAll ? 99 : Math.max(1, Math.min(4, Number(selfDisc[1] || selfDisc[2] || selfDisc[3] || 1)));
    return { cost, dmg: parsedNum, op: 16, val: nDisc };
  }
  if (/從雙方的.*寶可夢身上.*能量.*隨機(?:各)?丟棄/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 16, val: 100 };
  }

  // 24. 丟棄對手戰鬥寶可夢能量
  if (/對手的戰鬥寶可夢.*能量丟棄|discard.*energy.*opponent's Active/i.test(eff)) {
    const mode = /直到出現反面|until you get tails/i.test(eff) ? 3 : /擲1次硬幣|flip a coin/i.test(eff) ? 2 : 1;
    return { cost, dmg: parsedNum, op: 24, val: mode };
  }

  // 23. 物品鎖（鈴鐺響）、支援者鎖（可達鴨/耿鬼）、丟棄支援者（超級阿勃梭魯ex）、丟棄道具（姆克兒）、強制換人、禁撤退、吹回牌庫
  if (/無法從手牌使出物品卡|can't play any Item cards/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 3 };
  }
  if (/無法從手牌使出支援者卡|can't play any Supporter cards/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 5 };
  }
  if (/支援者卡.*丟棄|discard.*Supporter/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 4 };
  }
  if (/對手的戰鬥寶可夢身上的.*寶可夢道具.*丟棄|discard a Pok[eé]mon Tool/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 6 };
  }
  if (/將對手的戰鬥寶可夢放回(?:牌庫|手牌)|shuffle.*opponent's Active/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 8 };
  }
  if (/對手.*手牌.*放回(?:對手的)?牌庫/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 7 };
  }
  if (/無法撤退|can't retreat/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 23, val: 1 };
  }
  if (/對手的(?:(?:1隻)?備戰寶可夢|戰鬥寶可夢與備戰寶可夢).*互換|switch.*opponent's.*Active/i.test(eff)) {
    const m = eff.match(/造成\s*(\d+)\s*點傷害|does\s*(\d+)\s*damage/i);
    return { cost, dmg: parsedNum || Number(m?.[1] || m?.[2] || 0), op: 23, val: 2 };
  }

  // 26. 下回合自身無法使用招式 / 下回合自身招式增傷（波克基斯 +60）
  if (/下個自己的回合.*無法使用|can't attack during your next turn/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 26, val: 1 };
  }
  const nextBoostM = eff.match(/下個自己的回合[^。]*傷害\s*\+\s*(\d+)/);
  if (nextBoostM) {
    return { cost, dmg: parsedNum, op: 26, val: Math.max(10, Math.min(120, Number(nextBoostM[1] || 60))) };
  }

  // 8. 多重硬幣乘法（擲 N 次硬幣 × 傷害，或直到反面）
  if (rawDmgStr.includes('×') || (/擲\s*\d+\s*次硬幣.*正面出現的次數\s*[×x]|flip\s+\d+\s+coins.*for each heads/i.test(eff) && !/增加|more damage/i.test(eff))) {
    if (/直到出現反面|until you get tails/i.test(eff)) {
      const perM = eff.match(/[×x]\s*(\d+)|(\d+)\s*damage/i);
      return { cost, dmg: Number(perM?.[1] || perM?.[2] || parsedNum || 30), op: 8, val: 99 };
    }
    const nM = eff.match(/擲\s*(\d+)\s*次硬幣|flip\s+(\d+)\s+coins/i);
    const perM = eff.match(/[×x]\s*(\d+)|(\d+)\s*damage for each heads/i);
    if (nM) {
      return { cost, dmg: Number(perM?.[1] || perM?.[2] || parsedNum || 20), op: 8, val: Math.max(1, Math.min(12, Number(nM[1] || nM[2]))) };
    }
  }

  // 9. 擲硬幣追加傷害（含「擲2次硬幣，增加正面出現的次數×20點傷害」、「直到出現反面，增加×40點傷害」）
  if (/擲.*硬幣|flip a coin|flip \d+ coins/i.test(eff) && /增加|more damage/i.test(eff)) {
    const addM = eff.match(/增加(?:正面出現的次數\s*[×x]\s*)?\s*(\d+)|(\d+)\s*more damage/i);
    const bonus = Math.min(255, Number(addM?.[1] || addM?.[2] || 30));
    if (/直到出現反面|until you get tails/i.test(eff)) {
      return { cost, dmg: parsedNum, op: 9, val: (99 << 8) | bonus };
    }
    const nM = eff.match(/擲\s*(\d+)\s*次硬幣|flip\s+(\d+)\s+coins/i);
    const nCoins = nM ? Math.min(8, Number(nM[1] || nM[2])) : 1;
    return { cost, dmg: parsedNum, op: 9, val: (nCoins << 8) | bonus };
  }

  // 7. 擲硬幣反面招式失敗（修復「這個招式失敗」匹配！）
  if (/若為反面[^。]*這(?:個招|個|招)式失敗|if tails, this attack does nothing/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 7, val: 1 };
  }

  // 14. 受傷條件加減傷（對手受傷加傷／自身受傷加傷如熾焰咆哮虎ex／自身受傷減傷如雷吉鐸拉戈／自身受傷等量加傷如雷吉奇卡斯）
  if (/增加與這隻寶可夢已受到的傷害相同數值的傷害|more damage for each damage/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 14, val: 3 << 8 };
  }
  if (/對手的戰鬥寶可夢.*受到傷害|opponent's Active Pok[eé]mon has damage/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 14, val: (0 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 50)) };
  }
  if (/這隻寶可夢(?:有|已)?受到傷害|if this Pok[eé]mon has damage/i.test(eff)) {
    const subM = eff.match(/[-−]\s*(\d+)\s*點|[-−](\d+)\s*damage/i);
    if (subM) return { cost, dmg: parsedNum, op: 14, val: (2 << 8) | Math.min(255, Number(subM[1] || subM[2] || 100)) };
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 14, val: (1 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 50)) };
  }

  // 27. 狀態／ex／基礎／道具／報復／支援者／高血／特性／切換／進化 實時條件加傷
  if (/若對手的戰鬥寶可夢處於(?:中毒|灼傷|睡眠|麻痺|混亂|特殊狀態)|is (?:Poisoned|Burned|Asleep|Paralyzed|Confused)|affected by a Special Condition/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (0 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 60)) };
  }
  if (/若對手的戰鬥寶可夢為.*寶可夢ex|opponent's Active Pok[eé]mon is a Pok[eé]mon ex/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (1 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 50)) };
  }
  if (/若對手的戰鬥寶可夢為基礎寶可夢|opponent's Active Pok[eé]mon is a Basic/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (3 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 50)) };
  }
  if (/若這隻寶可夢身上附有.*寶可夢道具|if this Pok[eé]mon has a Pok[eé]mon Tool/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (4 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 30)) };
  }
  if (/若對手的戰鬥寶可夢身上附有.*寶可夢道具|if your opponent's Active.*Pok[eé]mon Tool/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (5 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 30)) };
  }
  if (/上個對手的回合.*昏厥了.*增加|Knocked Out by damage.*last turn/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (6 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 60)) };
  }
  if (/從手牌使出了支援者卡.*增加|played a Supporter card.*this turn/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (7 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 50)) };
  }
  if (/剩餘HP比這隻寶可夢的剩餘HP多|more remaining HP/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (8 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 50)) };
  }
  if (/若對手的戰鬥寶可夢擁有特性|opponent's Active.*has an Ability/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (9 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 40)) };
  }
  if (/從備戰區將這隻寶可夢放置於戰鬥場.*增加|moved from your Bench to the Active Spot this turn/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (10 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 60)) };
  }
  if (/若進化成這隻寶可夢.*增加|if this Pok[eé]mon evolved.*this turn/i.test(eff)) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    return { cost, dmg: parsedNum, op: 27, val: (11 << 8) | Math.min(255, Number(addM?.[1] || addM?.[2] || 20)) };
  }

  // 6 / 1~5. 真實異常狀態（精準區分中毒/灼傷/睡眠/麻痺/混亂與擲硬幣異常狀態）
  const hasCoin = /擲1次硬幣|flip a coin/i.test(eff);
  let statusMask = 0;
  if (/中毒|Poisoned/i.test(eff)) statusMask |= 1;
  if (/灼傷|Burned/i.test(eff)) statusMask |= 2;
  if (/睡眠|Asleep/i.test(eff)) statusMask |= 4;
  if (/麻痺|Paralyzed/i.test(eff)) statusMask |= 8;
  if (/混亂|Confused/i.test(eff)) statusMask |= 16;
  if (statusMask !== 0) {
    if (hasCoin) return { cost, dmg: parsedNum, op: 6, val: statusMask };
    if (statusMask & 8) return { cost, dmg: parsedNum, op: 4, val: 1 };
    if (statusMask & 4) return { cost, dmg: parsedNum, op: 3, val: 1 };
    if (statusMask & 16) return { cost, dmg: parsedNum, op: 5, val: 1 };
    if (statusMask & 2) return { cost, dmg: parsedNum, op: 2, val: 1 };
    return { cost, dmg: parsedNum, op: 1, val: /20點|20 damage/.test(eff) ? 20 : 10 };
  }

  // 18. 招式自癒／吸血
  if (/恢復對對手的戰鬥寶可夢造成的傷害相同數值的HP|heal.*equal to the damage/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 18, val: 999 };
  }
  const healM = eff.match(/恢復\s*(\d+)\s*HP|heal\s+(\d+)\s+damage/i);
  if (healM && !/對手的戰鬥寶可夢恢復/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 18, val: Math.min(120, Number(healM[1] || healM[2] || 20)) };
  }

  // 19. 招式附能（給自己或備戰，修復「附給」匹配如瑪納霏！）
  if (/能量區.*附(?:於|給)|attach.*energy.*from your Energy Zone/i.test(eff)) {
    const toBench = /備戰寶可夢|Benched/i.test(eff);
    const twoBench = toBench && /2隻|2 of your Benched/i.test(eff);
    return { cost, dmg: parsedNum, op: 19, val: twoBench ? 3 : toBench ? 2 : 1 };
  }

  // 22. 攻擊後換下場（與自己備戰寶可夢互換）
  if (/這隻寶可夢與備戰(?:區.*)?寶可夢互換|switch this Pok[eé]mon with 1 of your Benched/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 22, val: 1 };
  }

  // 25. 招式抽卡／檢索／呼叫夥伴／模仿洗牌（聒噪鳥）
  if (/將自己的手牌全部放回牌庫.*抽出與對手的手牌張數相同/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 25, val: 4 };
  }
  if (/放置於備戰區|onto your Bench/i.test(eff) && /牌庫|deck/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 25, val: 3 };
  }
  if (/牌庫.*(?:寶可夢|進化而來的卡).*加入手牌|Pok[eé]mon from your deck into your hand/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 25, val: 2 };
  }
  if (/抽出\s*\d+\s*張|draw a card|draw \d+ cards/i.test(eff)) {
    return { cost, dmg: parsedNum, op: 25, val: 1 };
  }

  // 剩餘特化條件加傷（如屬性/卡名特定條件）：估算穩健期望值
  if (rawDmgStr.includes('+')) {
    const addM = eff.match(/增加\s*(\d+)|(\d+)\s*more damage/i);
    const add = Number(addM?.[1] || addM?.[2] || 0);
    if (add > 0) return { cost, dmg: parsedNum + Math.round(add * 0.45), op: 0, val: 0 };
  }
  return { cost, dmg: parsedNum, op: 0, val: 0 };
}

// 精準解析寶可夢特性的真實觸發時機與效果操作碼（覆蓋全卡庫 164 種特性）
export function encodeAbilityForFastSim(card) {
  const ab = card?.abilities?.[0];
  if (!ab?.effect) return { abOp: 0, abVal: 0 };
  const eff = String(ab.effect);

  // 11. 防 ex 免疫（花舞鳥 神祕守護）
  if (/不會受到.*寶可夢ex.*招式的傷害|prevent all damage.*Pok[eé]mon ex/i.test(eff)) {
    return { abOp: 11, abVal: 1 };
  }
  // 26. 畫皮首次免傷（謎擬Ｑex）、受擊擲幣閃避（波克基斯/喵喵）、毅力存活（修建老匠）
  if (/首次受到招式的傷害時.*不會受到該傷害|first time this Pok[eé]mon would be damaged/i.test(eff)) {
    return { abOp: 26, abVal: 1 };
  }
  if (/受到招式的傷害時.*擲1次硬幣.*不會受到該傷害/i.test(eff)) {
    return { abOp: 26, abVal: 2 };
  }
  if (/受到招式的傷害而昏厥時.*剩餘HP為10/i.test(eff)) {
    return { abOp: 26, abVal: 3 };
  }
  // 6. 放上備戰時換上戰鬥場並轉移場上全部能量（密勒頓ex、故勒頓ex 傳說進擊）
  if (/放置於備戰區.*互換.*能量.*改附|onto your Bench.*switch.*move all.*Energy/i.test(eff)) {
    return { abOp: 6, abVal: 1 };
  }
  // 7. 放上備戰時強制對手換人（轟鳴月）
  if (/放置於備戰區.*對手的戰鬥寶可夢.*互換|onto your Bench.*switch out your opponent/i.test(eff)) {
    return { abOp: 7, abVal: 1 };
  }
  // 5. 進化當下一次性觸發（火恐龍點火=1、仙子伊布ex抽2=2、呱頭蛙臨場分身=3、變澀蜥20傷=4、怖思壺夥星=5）
  if (/完成進化時|play this Pok[eé]mon from your hand to evolve/i.test(eff)) {
    if (/能量.*附於|Energy.*attach/i.test(eff)) return { abOp: 5, abVal: 1 };
    if (/抽出\s*2\s*張|draw 2/i.test(eff)) return { abOp: 5, abVal: 2 };
    if (/放置於備戰區|onto your Bench/i.test(eff)) return { abOp: 5, abVal: 3 };
    if (/對手的戰鬥寶可夢受到\s*20/i.test(eff)) return { abOp: 5, abVal: 4 };
    if (/獲勝所需的剩餘分數/i.test(eff)) return { abOp: 5, abVal: 5 };
  }
  // 9. 每次從能量區附能給這隻寶可夢時對對手戰鬥場造成 20/30 傷害（達克萊伊ex 20、C1 噴火龍 火焰氣場 30）
  if (/每次從自己的能量區將.*能量附於這隻寶可夢身上時|whenever you attach.*Energy from your Energy Zone to this Pok[eé]mon/i.test(eff)) {
    const dm = eff.match(/受到\s*(\d+)\s*點傷害|do\s+(\d+)\s+damage/i);
    return { abOp: 9, abVal: Math.min(60, Number(dm?.[1] || dm?.[2] || 20)) };
  }
  // 22. 戰鬥場被動：對手附能時受 20 傷害（雷伊布ex 電磁牆）
  if (/對手每次從能量區將能量附於寶可夢身上時.*受到\s*(\d+)/i.test(eff)) {
    const dm = eff.match(/受到\s*(\d+)/);
    return { abOp: 22, abVal: Math.min(40, Number(dm?.[1] || 20)) };
  }
  // 10. 回合結束時若對手戰鬥寶可夢睡眠則造成 20 傷害（達克萊伊 夢魘）
  if (/回合結束時.*對手的戰鬥寶可夢睡眠.*受到\s*(\d+)|Active Pok[eé]mon is Asleep.*do\s+(\d+)\s+damage/i.test(eff)) {
    const dm = eff.match(/受到\s*(\d+)|do\s+(\d+)\s+damage/i);
    return { abOp: 10, abVal: Math.min(60, Number(dm?.[1] || dm?.[2] || 20)) };
  }
  // 1. 戰鬥場回合結束抽 1 張（炎帝ex、水君ex 傳說脈動）
  if (/回合結束時.*在戰鬥場上.*抽|end of your turn.*Active Spot.*draw/i.test(eff)) {
    return { abOp: 1, abVal: 1 };
  }
  // 23. 回合結束／寶可夢檢查被動（冰伊布ex 10傷=1、卡比獸ex 恢復20HP=2、捷拉奧拉首回合+1能=3）
  if (/在戰鬥場上.*寶可夢檢查時.*受到\s*10/i.test(eff)) return { abOp: 23, abVal: 1 };
  if (/回合結束時.*在戰鬥場上.*恢復\s*20\s*HP/i.test(eff)) return { abOp: 23, abVal: 2 };
  if (/最初回合結束時.*能量.*附於這隻寶可夢/i.test(eff)) return { abOp: 23, abVal: 3 };
  // 2. 戰鬥場回合開始檢索 1 張寶可夢（美洛耶塔 神奇歌聲）
  if (/回合開始時.*在戰鬥場上.*加入手牌|beginning of your turn.*Active Spot.*into your hand/i.test(eff)) {
    return { abOp: 2, abVal: 1 };
  }
  // 16. 戰鬥場首回合可進化（伊布 提升進化）
  if (/就算在自己的最初回合.*也可進化|can evolve during your first turn/i.test(eff)) {
    return { abOp: 16, abVal: 1 };
  }
  // 21. 戰鬥場被動：對手無法使用支援者卡（耿鬼ex 影子咒縛）
  if (/在戰鬥場上.*對手無法從手牌使出支援者卡/i.test(eff)) {
    return { abOp: 21, abVal: 1 };
  }
  // 24. 被動：對手中毒傷害+10（虛吾伊德）
  if (/對手的戰鬥寶可夢受到中毒的傷害\s*\+\s*10/i.test(eff)) {
    return { abOp: 24, abVal: 10 };
  }
  // 27. 密林霸主（君主蛇：草能量視為2個）
  if (/視為各提供\s*2\s*個.*能量/i.test(eff)) {
    return { abOp: 27, abVal: 1 };
  }
  // 28. 對手招式能耗+1（長毛狗、黏黏寶）
  if (/對手的戰鬥寶可夢使用招式所需的能量增加\s*1/i.test(eff)) {
    return { abOp: 28, abVal: 1 };
  }
  // 8. 每回合 1 次對對手任 1 隻寶可夢造成 20/30 傷害（甲賀忍蛙 飛水手裏劍、叉字蝠）
  if (/可使用1次.*對手的(?:1隻|戰鬥)寶可夢受到\s*(\d+)|Once during your turn.*do\s+(\d+)\s+damage to 1 of your opponent/i.test(eff)) {
    const dm = eff.match(/受到\s*(\d+)|do\s+(\d+)\s+damage/i);
    return { abOp: 8, abVal: Math.min(60, Number(dm?.[1] || dm?.[2] || 20)) };
  }
  // 3 / 4. 每回合 1 次附能特性（精準區分三首惡龍 +2能受30傷、三合一磁怪 +1能、戟脊龍/哈克龍給戰鬥場）
  if (/可使用1次.*(?:能量區|棄牌區)[^。]*能量[^。]*附於|Once during your turn.*take a.*Energy.*attach/i.test(eff)) {
    const isDiscard = /棄牌區|discard pile/i.test(eff);
    const toSelf = /附於這隻寶可夢|attach it to this Pok[eé]mon/i.test(eff);
    if (toSelf && /抽出\s*2\s*個.*能量.*受\s*30\s*點傷害/.test(eff)) {
      return { abOp: 3, abVal: 3 }; // 三首惡龍：+2能且自身受30傷
    }
    return { abOp: toSelf ? 3 : 4, abVal: isDiscard ? 2 : 1 };
  }
  // 15. 每回合 1 次恢復 HP（愛管侍ex、謝米、胖可丁）
  if (/可使用1次.*恢復\s*(\d+)\s*HP|Once during your turn.*heal\s+(\d+)\s+damage/i.test(eff)) {
    const hm = eff.match(/恢復\s*(\d+)|heal\s+(\d+)/i);
    return { abOp: 15, abVal: Math.min(60, Number(hm?.[1] || hm?.[2] || 20)) };
  }
  // 17. 每回合 1 次與己方備戰免費互換（甲賀忍蛙ex 水流變幻、索爾迦雷歐ex、普隆隆姆、鐵火輝夜）
  if (/可使用1次.*(?:這隻寶可夢與戰鬥寶可夢|自己的?戰鬥場的.*寶可夢與備戰(?:區.*)?寶可夢)互換|Once during your turn.*switch.*your Active/i.test(eff)) {
    return { abOp: 17, abVal: 1 };
  }
  // 20. 每回合 1 次主動干擾／異常／檢索特性（水伊布ex、月亮伊布ex、大食花、大王燕、燈罩夜菇、雙彈瓦斯、火暴獸、引夢貘人、塗標客、超能妙喵、水晶燈火靈）
  if (/可使用1次.*有受到傷害的1隻備戰寶可夢.*互換/i.test(eff)) return { abOp: 20, abVal: 2 };
  if (/可使用1次.*對手的(?:備戰區的1隻)?基礎寶可夢.*互換/i.test(eff)) return { abOp: 20, abVal: 3 };
  if (/可使用1次.*對手的(?:戰鬥寶可夢|1隻備戰寶可夢).*互換|Once during your turn.*switch out your opponent/i.test(eff)) return { abOp: 20, abVal: 1 };
  if (/可使用1次.*從自己的牌庫隨機將1張寶可夢卡加入手牌/i.test(eff)) return { abOp: 20, abVal: 4 };
  if (/可使用1次.*將對手的戰鬥寶可夢中毒/i.test(eff)) return { abOp: 20, abVal: /擲1次硬幣/.test(eff) ? 8 : 5 };
  if (/可使用1次.*將對手的戰鬥寶可夢灼傷/i.test(eff)) return { abOp: 20, abVal: 6 };
  if (/可使用1次.*將對手的戰鬥寶可夢睡眠/i.test(eff)) return { abOp: 20, abVal: 7 };
  if (/可使用1次.*將對手的戰鬥寶可夢混亂/i.test(eff)) return { abOp: 20, abVal: 9 };
  if (/可使用1次.*將對手的牌庫上方1張卡丟棄/i.test(eff)) return { abOp: 20, abVal: 10 };
  // 14. 戰鬥場受擊反傷／反毒／昏厥反傷（赤面龍、蚊香泳士、堅果啞鈴、鬃巖狼人ex、毒藻龍ex、拳海蔘）
  if (/在戰鬥場上?受到對手的寶可夢招式的傷害而昏厥時.*受到\s*(\d+)/i.test(eff)) {
    const dm = eff.match(/受到\s*(\d+)/);
    return { abOp: 14, abVal: 100 + Math.min(80, Number(dm?.[1] || 50)) };
  }
  if (/在戰鬥場上?受到對手的寶可夢招式的傷害時.*中毒/i.test(eff)) {
    return { abOp: 14, abVal: 99 };
  }
  if (/在戰鬥場上?受到對手的寶可夢招式的傷害時.*受到\s*(\d+)|Active Spot and is damaged.*do\s+(\d+)\s+damage to the Attacking/i.test(eff)) {
    const dm = eff.match(/受到\s*(\d+)|do\s+(\d+)\s+damage/i);
    return { abOp: 14, abVal: Math.min(50, Number(dm?.[1] || dm?.[2] || 20)) };
  }
  // 12. 被動常駐減傷（美錄梅塔 -20、石居蟹 -10、倫琴貓 -20）
  if (/對手的戰鬥寶可夢使用的招式的傷害\s*[-−]\s*(\d+)/i.test(eff)) {
    const dm = eff.match(/[-−]\s*(\d+)/);
    return { abOp: 12, abVal: Math.min(50, Number(dm?.[1] || 20)) };
  }
  const redM = eff.match(/受到.*招式的傷害\s*[-−]\s*(\d+)|takes\s*[-−](\d+)\s*damage from attacks/i);
  if (redM) {
    const team = /所有|all of your/i.test(eff) ? 100 : 0;
    return { abOp: 12, abVal: team + Math.min(50, Number(redM[1] || redM[2] || 20)) };
  }
  // 13. 被動常駐招式增傷（路卡利歐 +20）
  const boostM = eff.match(/招式.*傷害\s*\+\s*(\d+)|attacks.*do\s*\+(\d+)\s*damage/i);
  if (boostM) {
    return { abOp: 13, abVal: Math.min(50, Number(boostM[1] || boostM[2] || 20)) };
  }
  // 25. 被動撤退減費／免撤退（謝米天空支援、毽子棉、騎拉帝納飄浮）
  if (/戰鬥寶可夢撤退所需的能量全部消除/i.test(eff)) return { abOp: 25, abVal: 2 };
  if (/戰鬥場的基礎寶可夢撤退所需的能量減少\s*1/i.test(eff)) return { abOp: 25, abVal: 1 };
  if (/這隻寶可夢.*撤退所需的能量全部消除/i.test(eff)) return { abOp: 25, abVal: 3 };
  // 18. 免疫異常狀態
  if (/不會陷入特殊狀態|不會睡眠|can't be affected by any Special Conditions/i.test(eff)) {
    return { abOp: 18, abVal: 1 };
  }
  // 19. 被動常駐提升最大 HP（裙兒小姐 +20、人造細胞卵每能 +30）
  if (/最大HP.*每1個\s*\+\s*30/i.test(eff)) return { abOp: 19, abVal: 99 };
  const hpM = eff.match(/最大HP\s*\+\s*(\d+)|gets\s*\+(\d+)\s*HP/i);
  if (hpM) {
    return { abOp: 19, abVal: Math.min(60, Number(hpM[1] || hpM[2] || 20)) };
  }
  return { abOp: 0, abVal: 0 };
}

// 精準分類全部 177 張訓練家／道具／競技場卡（杜絕小氣球+20HP、古茲馬當娜姿、虹色洞窟+10傷、可抽獎冰棒誤判等問題）
export function encodeTrainerForFastSim(card) {
  const eff = `${card.name || ''} ${card.nameEn || ''} ${card.effect || ''}`;
  const body = `${card.effect || ''}`;
  const isSupporter = card.subtype === 'supporter' ? 1 : 0;
  const isItem = card.subtype === 'item' ? 1 : 0;

  if (card.subtype === 'stadium') {
    let val = 1; // 1 = 虹色洞窟／中性場地（不再誤給 +10 傷害！）
    if (/1階進化寶可夢.*傷害\+\d+|Stage 1.*do \+10/i.test(body)) val = 2; // 訓練區（限1階進化+10）
    else if (/基礎寶可夢.*最大HP\+\d+|Basic.*gets \+20 HP/i.test(body)) val = 3; // 起始平原（基礎+20HP）
    else if (/撤退.*減少|Retreat Cost.*less/i.test(body)) val = 4; // 奇異廣場（撤退減費）
    else if (/加入手牌|抽卡直到|put a random|draws cards/i.test(body)) val = 5; // 桌台市／芳香森林／健行步道
    else if (/寶可夢ex.*傷害\+\d+|Active Pok[eé]mon ex.*\+20/i.test(body)) val = 6; // 古老鬥技場（對ex+20）
    else if (/恢復\s*20\s*HP|heal 20/i.test(body)) val = 7; // 療癒海邊（回合結束恢復20HP）
    return { trainerKind: 7, effectVal: val, isSupporter: 0, isItem: 0 };
  }

  if (card.subtype === 'tool') {
    let val = 1;
    if (/最大HP\s*\+\s*30|\+30 HP|最大HP\s*\+\s*40|\+40 HP/i.test(body)) val = 2; // 葉子斗篷／優雅斗篷(+30HP)
    else if (/大斗蓬|大斗篷|Giant Cape|最大HP\s*\+\s*20|\+20 HP/i.test(eff)) val = 1; // 大斗篷(+20HP)
    else if (/頭盔|Helmet|受到.*傷害時.*對使用招式的寶可夢.*20點|damaged by an attack.*do 20 damage to the Attacking/i.test(eff)) val = 3; // 凹凸頭盔(20反傷)
    else if (/毒針|Poison Barb|中毒/i.test(eff)) val = 4; // 毒針(反擊中毒)
    else if (/小氣球|基礎寶可夢.*撤退費用減少|Basic.*Retreat Cost/i.test(eff)) val = 5; // 小氣球(基礎-1撤退)
    else if (/氣球|小艇|Balloon|撤退.*減少|Retreat Cost.*less/i.test(eff)) val = 11; // 水上小艇／氣球(-1撤退)
    else if (/進化奇石|Eviolite|受到.*招式的傷害\s*[-−]\s*20|takes -20 damage/i.test(eff)) val = 6; // 進化奇石(基礎-20傷)
    else if (/幸運蛋|Lucky Egg|昏厥時.*手牌滿5張|Knocked Out.*draw cards until you have 5/i.test(eff)) val = 7; // 幸運蛋(昏厥補手牌至5張)
    else if (/耍詐針|回合結束時.*對手的戰鬥寶可夢受到\s*10|end of your turn.*do 10 damage/i.test(eff)) val = 8; // 耍詐針(回合末10傷)
    else if (/驅勁能量未來|力量頭帶|招式.*傷害\s*\+\s*(?:10|20)|do \+(?:10|20) damage/i.test(eff)) val = 9; // 驅勁能量未來(+20傷)
    else if (/減傷|受到.*傷害\s*[-−]\s*(?:10|50)|特殊狀態|圍裙|斗篷|Apron|Barrier|Poncho/i.test(eff)) val = 10; // 鋼鐵圍裙(-10傷防狀態)
    return { trainerKind: 5, effectVal: val, isSupporter: 0, isItem: 0 };
  }

  // 恢復系優先判定（避免「可抽獎的冰棒」因「放回手牌」被誤分類成回收支援者！）
  if (/甜甜蜜/i.test(eff)) {
    return { trainerKind: 2, effectVal: 20 | (1 << 11), isSupporter, isItem };
  }
  if (/萬靈藥|將自己的戰鬥寶可夢的特殊狀態全部恢復/i.test(eff)) {
    return { trainerKind: 2, effectVal: 1 << 8, isSupporter, isItem };
  }
  if (/瑪奧|HP全部恢復.*能量全部丟棄/i.test(eff)) {
    return { trainerKind: 2, effectVal: 90 | (1 << 12), isSupporter, isItem };
  }
  if (/傷藥|莉佳|珠貝|莉莉艾|寶可夢中心|卡露妮|冰棒|馬拉薩達|Potion|Erika|Irida|Lillie|Center Lady|Ice Pop|Malasada|恢復\d+HP/i.test(eff)) {
    const m = body.match(/(\d+)\s*HP|恢復\s*(\d+)/i);
    let healVal = m ? Math.min(90, Number(m[1] || m[2]) || 30) : 30;
    const curesStatus = /特殊狀態/i.test(body) ? 1 : 0;
    const stage2Only = /2階進化|Stage 2/i.test(body) ? 1 : 0;
    const coinReturn = /不丟棄這張.*放回手牌|into your hand instead/i.test(body) ? 1 : 0;
    if (/能量丟棄|discard.*energy/i.test(body)) healVal = Math.max(20, Math.round(healVal * 0.55));
    return { trainerKind: 2, effectVal: healVal | (curesStatus << 8) | (stage2Only << 9) | (coinReturn << 10), isSupporter, isItem };
  }

  // 能量／進化／撤退／免費換人系（trainerKind = 6）
  if (/奇異糖果|神奇糖果|Rare Candy/i.test(eff)) return { trainerKind: 6, effectVal: 99, isSupporter, isItem };
  if (/早熟精華|從該寶可夢進化而來的.*完成進化/i.test(eff)) return { trainerKind: 6, effectVal: 7, isSupporter, isItem };
  if (/葉子|\bLeaf\b|撤退所需的能量減少\s*2|Retreat Cost.*2 less/i.test(eff)) return { trainerKind: 6, effectVal: 12, isSupporter, isItem };
  if (/速度強化|X Speed|撤退所需的能量減少\s*1|撤退費用減少/i.test(eff)) return { trainerKind: 6, effectVal: 1, isSupporter, isItem };
  if (/琴音|風露|新星訓練家|將自己的?.*戰鬥寶可夢與備戰寶可夢互換/i.test(eff)) return { trainerKind: 6, effectVal: 13, isSupporter, isItem };
  if (/馬志士|雜耍藝人|備戰寶可夢.*所有.*能量改附於自己的戰鬥/i.test(eff)) return { trainerKind: 6, effectVal: 6, isSupporter, isItem };
  if (/小霞|\bMisty\b|直到出現反面.*水.*能量/i.test(eff)) return { trainerKind: 6, effectVal: 5, isSupporter, isItem };
  if (/附於2階進化|2階進化寶可夢.*能量|滿充|\bWally\b/i.test(eff)) return { trainerKind: 6, effectVal: 3, isSupporter, isItem };
  if (/棄牌(?:區|堆).*能量.*附(?:於|加)|火補丁|電次|奧琳博士|Flame Patch|Volkner/i.test(eff)) return { trainerKind: 6, effectVal: 4, isSupporter, isItem };
  if (/能量區.*附於|改附於.*能量|基因轉換器|小剛|小光|卡奇|梅麗莎|元素切換|阿馴|Brock|Dawn|Elemental Switch|Electric Generator/i.test(eff)) {
    return { trainerKind: 6, effectVal: 2, isSupporter, isItem };
  }

  // 干擾／破壞道具場地／換人／洗牌／回收（trainerKind = 3）
  if (/古茲馬|\bGuzma\b|小菊兒|對手.*寶可夢道具.*丟棄|所有.*寶可夢道具.*放回/i.test(eff)) return { trainerKind: 3, effectVal: 6, isSupporter, isItem };
  if (/場地吹風機|Field Blower|競技場.*丟棄/i.test(eff)) return { trainerKind: 3, effectVal: 7, isSupporter, isItem };
  if (/赤日|\bCyrus\b|有受到傷害的1隻備戰/i.test(eff)) return { trainerKind: 3, effectVal: 2, isSupporter, isItem };
  if (/青綠的挑釁/i.test(eff)) return { trainerKind: 3, effectVal: 3, isSupporter, isItem };
  if (/水蓮|選擇1隻對手的備戰寶可夢.*互換|選擇對手的1隻備戰寶可夢.*互換/i.test(eff)) return { trainerKind: 3, effectVal: 15, isSupporter, isItem };
  if (/除蟲噴霧|Repel|戰鬥場的基礎寶可夢與備戰寶可夢互換/i.test(eff)) return { trainerKind: 3, effectVal: 10, isSupporter, isItem };
  if (/娜姿|\bSabrina\b|對手的戰鬥.*與備戰寶可夢互換/i.test(eff)) return { trainerKind: 3, effectVal: 1, isSupporter, isItem };
  if (/夥星|\bMars\b|獲勝所需的剩餘分數/i.test(eff)) return { trainerKind: 3, effectVal: 5, isSupporter, isItem };
  if (/紅牌|Red Card|手牌全部放回牌庫.*抽出3張/i.test(eff)) return { trainerKind: 3, effectVal: 4, isSupporter, isItem };
  if (/惡搞信|手牌丟棄直到變為4張/i.test(eff)) return { trainerKind: 3, effectVal: 11, isSupporter, isItem };
  if (/小銀|選擇其中1張支援者卡放回牌庫/i.test(eff)) return { trainerKind: 3, effectVal: 12, isSupporter, isItem };
  if (/火箭隊手下|Team Rocket Grunt|擲硬幣直到出現反面.*對手.*能量丟棄/i.test(eff)) return { trainerKind: 3, effectVal: 8, isSupporter, isItem };
  if (/傑尼龜噴壺|重擊錘|聶梓|天星隊手下|對手的.*寶可夢身上.*能量.*丟棄/i.test(eff)) return { trainerKind: 3, effectVal: 14, isSupporter, isItem };
  if (/弗圖博士|阿桔|新手調查員|奇巴納|阿塞蘿拉|將自己的戰鬥場.*放回手牌|洗入你的牌庫|put 1 of your.*into your hand/i.test(eff)) {
    return { trainerKind: 3, effectVal: 9, isSupporter, isItem };
  }

  // 當回合增傷／下回合減傷／必正面系（trainerKind = 4）
  if (/一樹|擲硬幣時.*一定為正面/i.test(eff)) {
    return { trainerKind: 4, effectVal: 1 << 10, isSupporter, isItem };
  }
  const shieldSup = body.match(/受到對手的.*招式的傷害\s*[-−]\s*(\d+)/);
  if (shieldSup) {
    return { trainerKind: 4, effectVal: Math.min(100, Number(shieldSup[1] || 10)) | (1 << 9), isSupporter, isItem };
  }
  if (/坂木|赤紅|夏伯|竹蘭|可爾妮|哈烏|Giovanni|\bRed\b|Blaine|Cynthia|Korrina|Hau|招式.*傷害\s*\+\s*\d+/i.test(eff)) {
    const dm = body.match(/\+\s*(\d+)/);
    const dmgVal = dm ? Math.min(50, Number(dm[1])) : 10;
    const vsExOnly = /寶可夢ex|Pok[eé]mon ex/i.test(body) ? 1 : 0;
    return { trainerKind: 4, effectVal: dmgVal | (vsExOnly << 8), isSupporter, isItem };
  }

  // 抽牌／檢索系（trainerKind = 1）
  if (/博士的研究|Professor's Research/i.test(eff)) return { trainerKind: 1, effectVal: 2, isSupporter, isItem };
  if (/精靈球|Pok[eé] Ball/i.test(eff)) return { trainerKind: 1, effectVal: 10, isSupporter, isItem };
  if (/模仿少女|Copycat|抽出與對手的手牌張數相同/i.test(eff)) return { trainerKind: 1, effectVal: 11, isSupporter, isItem };
  if (/小遙|通訊|Communication|寶可夢卡.*放回牌庫/i.test(eff)) return { trainerKind: 1, effectVal: 12, isSupporter, isItem };
  if (/琉琪亞|Lisia|HP為50以下/i.test(eff)) return { trainerKind: 1, effectVal: 13, isSupporter, isItem };
  if (/奇樹|\bIono\b|雙方玩家各自將自己的手牌全部放回牌庫/i.test(eff)) return { trainerKind: 1, effectVal: 14, isSupporter, isItem };
  if (/小青|2 階段寶可夢|2階進化寶可夢.*加入手牌/i.test(eff)) return { trainerKind: 1, effectVal: 16, isSupporter, isItem };
  if (/希特隆|三合一磁怪.*加入手牌/i.test(eff)) return { trainerKind: 1, effectVal: 17, isSupporter, isItem };
  if (/莎莉娜|卡魯穆|查看自己的牌庫上方|從自己的牌庫隨機將2張|加入手牌/i.test(eff)) return { trainerKind: 1, effectVal: 15, isSupporter, isItem };
  return { trainerKind: 1, effectVal: 1, isSupporter, isItem };
}

// 依實卡招式文本精準估算期望傷害（供相容舊呼叫與 AI 選卡估算；對戰核心已改由 encodeAttackForFastSim 實時結算）
export function computeExpectedAttackDamage(atk) {
  const enc = encodeAttackForFastSim(atk);
  let dmgNum = enc.dmg;
  const op = enc.op;
  const val = enc.val;
  if (op === 8) dmgNum = Math.round(enc.dmg * (val === 99 ? 1.0 : val * 0.5));
  else if (op === 9) dmgNum = enc.dmg + Math.round((val & 0xff) * ((val >> 8) === 99 ? 1.0 : 0.5));
  else if (op === 10) {
    const mode = val >> 8;
    const per = val & 0xff;
    dmgNum = enc.dmg + Math.round(per * (mode === 2 ? 4.5 : 2.5));
  } else if (op === 11) {
    dmgNum = val >= 1000 ? Math.round((val - 1000) * Math.max(2, enc.cost) * 0.5) : enc.dmg + val * Math.max(3, enc.cost + 1);
  } else if (op === 12) {
    dmgNum = enc.dmg + val * 2;
  } else if (op === 13) {
    dmgNum = enc.dmg + Math.round((val & 0xff) * 0.55);
  } else if (op === 14) {
    const mode = val >> 8;
    const delta = val & 0xff;
    dmgNum = mode === 2 ? Math.max(10, enc.dmg - Math.round(delta * 0.4)) : enc.dmg + Math.round(delta * 0.55);
  } else if (op === 17) {
    const mode = val >> 8;
    const sn = val & 0xff;
    if (mode === 2) dmgNum = sn;
    else if (mode >= 3) dmgNum = (mode - 2) * sn;
    else dmgNum = enc.dmg + Math.round(sn * (mode === 1 ? 1.2 : 0.6));
  } else if (op === 7) {
    dmgNum = Math.round(enc.dmg * 0.5);
  } else if (op === 21 && val === 99) {
    dmgNum = Math.round(enc.dmg * 1.15);
  } else if (op === 26) {
    dmgNum = Math.round(enc.dmg * 0.72);
  } else if (op === 28) {
    dmgNum = val === 1 ? 160 : 60;
  }
  return {
    dmgNum,
    isOpponentMissDebuff: op === 21 && val === 99,
    discardEnergy: op === 16 ? (val >= 2 ? 2 : 1) : 0,
    heavyRecoil: op === 15 && val >= 40
  };
}

export function encodeCardForFastSim(card, strategyBonus = 0, cardsById = null) {
  if (!card) {
    return {
      isPokemon: 1, stage: 0, evoGroup: 0, isSupporter: 0, isItem: 0, isFossil: 0,
      typeCode: 9, weakCode: 255, hp: 60, retreat: 1, prize: 1,
      a1Cost: 1, a1Dmg: 20, a1Op: 0, a1Val: 0,
      a2Cost: 255, a2Dmg: 0, a2Op: 0, a2Val: 0,
      abOp: 0, abVal: 0,
      atkCost: 1, atkDmg: 20, atkFlags: 0, abFlags: 0,
      trainerKind: 0, effectVal: 0, strategyBonus: Number(strategyBonus || 0)
    };
  }
  const v3Tpl = getCardV3Template(card.id);
  if (v3Tpl) {
    const isPokemon = v3Tpl[0] | 0;
    const m = v3Tpl[1] | 0;
    const stage = m & 0xff;
    const evoGroup = (m >>> 8) & 0xffff;
    const metaHi = (m >>> 24) & 0xff;
    const isSupporter = (metaHi & 1) ? 1 : 0;
    const isItem = (metaHi & 2) ? 1 : 0;
    const isFossil = (metaHi & 4) ? 1 : 0;
    const typeCode = v3Tpl[3] & 0xff;
    const weakCode = v3Tpl[4] & 0xff;
    const hp = v3Tpl[5] | 0;
    const retreat = v3Tpl[6] & 0xff;
    const prize = Math.max(1, (v3Tpl[6] >>> 8) & 0xff);
    const a1Cost = v3Tpl[7] & 0xff;
    const a1Dmg = v3Tpl[8] | 0;
    const a1Op1 = v3Tpl[9] & 0xff;
    const a1Op2 = (v3Tpl[9] >>> 8) & 0xff;
    const a1Val1 = v3Tpl[10] | 0;
    const a1Val2 = v3Tpl[11] | 0;
    const a2Cost = v3Tpl[12] & 0xff;
    const a2Dmg = v3Tpl[13] | 0;
    const a2Op1 = v3Tpl[14] & 0xff;
    const a2Op2 = (v3Tpl[14] >>> 8) & 0xff;
    const a2Val1 = v3Tpl[15] | 0;
    const a2Val2 = v3Tpl[16] | 0;
    const abOp = v3Tpl[17] & 0xff;
    const abVal = v3Tpl[18] | 0;
    const trainerKind = v3Tpl[19] & 0xff;
    const trainerSub = (v3Tpl[19] >>> 8) & 0xff;
    const effectVal = v3Tpl[20] | 0;

    const p1 = a1Cost !== 255 ? estAtkPowerV3(a1Dmg, a1Op1, a1Val1) : 0;
    const p2 = a2Cost !== 255 ? estAtkPowerV3(a2Dmg, a2Op1, a2Val1) : 0;
    const pick2 = a2Cost !== 255 && (p2 > p1 || (p2 === p1 && a2Cost < a1Cost));
    const bestCost = pick2 ? a2Cost : a1Cost;
    const bestDmg = pick2 ? p2 : p1;
    const bestOp1 = pick2 ? a2Op1 : a1Op1;
    const bestOp2 = pick2 ? a2Op2 : a1Op2;
    const bestVal1 = pick2 ? a2Val1 : a1Val1;
    const bestVal2 = pick2 ? a2Val2 : a1Val2;

    let atkFlags = 0;
    if (bestOp1 !== 0 || bestOp2 !== 0) atkFlags |= 1;
    if (bestOp1 === 8 || bestOp2 === 8) atkFlags |= 2;
    if (bestOp1 === 1 || bestOp2 === 1) atkFlags |= 4;
    if (bestOp1 === 12 || bestOp2 === 12) atkFlags |= 8;
    if (bestOp1 === 13 || bestOp2 === 13) atkFlags |= 16;
    if ((bestOp1 === 9 && (bestVal1 & 0xff) >= 40) || (bestOp2 === 9 && (bestVal2 & 0xff) >= 40)) atkFlags |= 32;
    if ((bestOp1 === 10 && (bestVal1 & 0xff) >= 2) || (bestOp2 === 10 && (bestVal2 & 0xff) >= 2)) atkFlags |= 128;
    else if (bestOp1 === 10 || bestOp2 === 10) atkFlags |= 64;

    let abFlags = 0;
    if (abOp !== 0) abFlags |= 1;
    if (abOp === 1 || abOp === 2) abFlags |= 2;
    if (abOp === 3 || abOp === 4 || abOp === 6) abFlags |= 4;
    if (abOp === 14) abFlags |= 8;
    if (abOp === 7 || abOp === 8 || abOp === 9) abFlags |= 16;
    if (abOp === 5) abFlags |= 32;
    if (abOp === 10) abFlags |= 64;

    return {
      isPokemon, stage, evoGroup,
      isSupporter, isItem, isFossil,
      typeCode, weakCode, hp, retreat, prize,
      a1Cost, a1Dmg, a1Op: a1Op1, a1Val: a1Val1, a1Op1, a1Op2, a1Val1, a1Val2,
      a1Ecost: v3Tpl.length >= 26 ? (v3Tpl[23] | 0) : 0,
      a2Cost, a2Dmg, a2Op: a2Op1, a2Val: a2Val1, a2Op1, a2Op2, a2Val1, a2Val2,
      a2Ecost: v3Tpl.length >= 26 ? (v3Tpl[24] | 0) : 0,
      effEtypes: v3Tpl.length >= 26 ? (v3Tpl[25] | 0) : 0xffffff,
      abOp, abVal,
      atkCost: Math.max(1, bestCost === 255 ? 1 : bestCost),
      atkDmg: bestDmg,
      atkFlags, abFlags,
      trainerKind, trainerSub, effectVal,
      v3Tpl,
      strategyBonus: Number(strategyBonus || 0)
    };
  }
  const name = `${card.name || ''} ${card.nameEn || ''}`;
  const isFossil = (card.subtype === 'fossil' || /化石|Fossil/i.test(name)) ? 1 : 0;
  const isPokemon = (card.type === 'pokemon' || isFossil) ? 1 : 0;
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

  const atks = Array.isArray(card.attacks) ? card.attacks : [];
  const a1 = isPokemon && !isFossil && atks[0] ? encodeAttackForFastSim(atks[0]) : { cost: isFossil ? 255 : 1, dmg: isFossil ? 0 : 20, op: 0, val: 0 };
  const a2 = isPokemon && !isFossil && atks[1] ? encodeAttackForFastSim(atks[1]) : { cost: 255, dmg: 0, op: 0, val: 0 };

  const { abOp, abVal } = isPokemon ? encodeAbilityForFastSim(card) : { abOp: 0, abVal: 0 };
  const trn = !isPokemon ? encodeTrainerForFastSim(card) : { trainerKind: 0, effectVal: 0, isSupporter: 0, isItem: 0 };

  // 向下相容舊版欄位（供既有用例與選卡估算使用）
  const exp1 = atks[0] ? computeExpectedAttackDamage(atks[0]) : { dmgNum: a1.dmg, discardEnergy: 0, heavyRecoil: false };
  const exp2 = atks[1] ? computeExpectedAttackDamage(atks[1]) : null;
  const pick2 = Boolean(exp2 && (exp2.dmgNum > exp1.dmgNum || (exp2.dmgNum === exp1.dmgNum && a2.cost < a1.cost)));
  const bestExp = pick2 ? exp2 : exp1;
  const bestAtk = pick2 ? a2 : a1;
  let atkFlags = 0;
  if (bestAtk.op !== 0) atkFlags |= 1;
  if (bestAtk.op === 17) atkFlags |= 2;
  if ([1, 2, 3, 4, 5, 6].includes(bestAtk.op) || (bestAtk.op === 21 && bestAtk.val === 99)) atkFlags |= 4;
  if (bestAtk.op === 18) atkFlags |= 8;
  if (bestAtk.op === 19) atkFlags |= 16;
  if (bestAtk.op === 15 && bestAtk.val >= 40) atkFlags |= 32;
  if (bestAtk.op === 16 && bestAtk.val >= 2) atkFlags |= 128;
  else if (bestAtk.op === 16 && bestAtk.val === 1) atkFlags |= 64;

  let abFlags = 0;
  if (abOp !== 0) abFlags |= 1;
  if (abOp === 1 || abOp === 2) abFlags |= 2;
  if (abOp === 3 || abOp === 4 || abOp === 6) abFlags |= 4;
  if (abOp === 15) abFlags |= 8;
  if (abOp === 8 || abOp === 9 || abOp === 10) abFlags |= 16;
  if (abOp === 5) abFlags |= 32;
  if (abOp === 11) abFlags |= 64;

  return {
    isPokemon, stage, evoGroup,
    isSupporter: trn.isSupporter, isItem: trn.isItem, isFossil,
    typeCode, weakCode, hp, retreat, prize,
    a1Cost: a1.cost, a1Dmg: a1.dmg, a1Op: a1.op, a1Val: a1.val,
    a1Ecost: isPokemon && !isFossil && atks[0] ? packAttackEnergyCost(atks[0].cost) : 0,
    a2Cost: a2.cost, a2Dmg: a2.dmg, a2Op: a2.op, a2Val: a2.val,
    a2Ecost: isPokemon && !isFossil && atks[1] ? packAttackEnergyCost(atks[1].cost) : 0,
    effEtypes: 0xffffff,
    abOp, abVal,
    atkCost: Math.max(1, bestAtk.cost === 255 ? 1 : bestAtk.cost),
    atkDmg: bestExp.dmgNum,
    atkFlags, abFlags,
    trainerKind: trn.trainerKind, effectVal: trn.effectVal,
    strategyBonus: Number(strategyBonus || 0)
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
      base.a1Cost = 255; base.a1Dmg = 0; base.a1Op = 0; base.a1Val = 0;
      base.a2Cost = 255; base.a2Dmg = 0; base.a2Op = 0; base.a2Val = 0;
      base.abOp = 0; base.abVal = 0;
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
      attacks.forEach((atk, idx) => {
        const costs = Array.isArray(atk.cost) ? atk.cost : [];
        const canPay = costs.every((sym) => {
          const k = String(sym || '').toLowerCase();
          return !k || k === 'colorless' || deckEnergySet.has(k);
        });
        if (!canPay) {
          if (idx === 0) { base.a1Cost = 255; base.a1Dmg = 0; base.a1Op = 0; base.a1Val = 0; }
          if (idx === 1) { base.a2Cost = 255; base.a2Dmg = 0; base.a2Op = 0; base.a2Val = 0; }
        } else {
          const { dmgNum } = computeExpectedAttackDamage(atk);
          const costLen = Math.max(0, Math.min(5, costs.length));
          if (dmgNum > playableDmg || (dmgNum === playableDmg && costLen < playableCost)) {
            playableDmg = dmgNum;
            playableCost = costLen;
          }
        }
      });
      if (playableCost === 99) {
        base.atkDmg = 0;
        base.atkFlags = 0;
      } else {
        base.atkDmg = playableDmg;
        base.atkCost = Math.max(1, playableCost);
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
  const deckEnergyMask = encodeDeckEnergyMask(deck?.energy, baseDeck20);
  for (const c of baseDeck20) c.deckEnergyMask = deckEnergyMask;

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
    enc.deckEnergyMask = deckEnergyMask;

    // Skip functionally identical reprints of the exact same card already being replaced
    if (limitKey === origLimitKey && enc.hp === origEnc.hp && enc.a1Cost === origEnc.a1Cost && enc.a1Dmg === origEnc.a1Dmg && enc.a1Op === origEnc.a1Op && enc.a1Val === origEnc.a1Val && enc.a2Cost === origEnc.a2Cost && enc.a2Dmg === origEnc.a2Dmg && enc.abOp === origEnc.abOp && enc.abVal === origEnc.abVal && enc.trainerKind === origEnc.trainerKind && enc.effectVal === origEnc.effectVal) {
      groups.get(origGroupKey).representedCount++;
      continue;
    }

    // 依卡牌實質功能分組（訓練家直接以卡名分組，寶可夢完整區分雙招式與特性，避免不同版本的同名寶可夢被合併！）
    const fKey = card.type === 'trainer'
      ? `T|${normCardNameKey(limitKey)}`
      : [
          'P', normCardNameKey(limitKey), enc.stage, enc.typeCode, enc.weakCode,
          enc.hp, enc.retreat, enc.prize,
          enc.a1Cost, enc.a1Dmg, enc.a1Op, enc.a1Val,
          enc.a2Cost, enc.a2Dmg, enc.a2Op, enc.a2Val,
          enc.abOp, enc.abVal
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



