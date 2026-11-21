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
export function validOutcomes(events,ids){
  const allowed=new Set(ids), repeated=new Set(), valid=[];
  for(const event of events){
    const key=event.opponentId+'#'+event.index;
    if(!allowed.has(event.opponentId)||!Number.isInteger(event.index)||event.index<0||event.index>=50||!['win','loss','draw'].includes(event.outcome)||repeated.has(key)) continue;
    repeated.add(key); valid.push(event);
  }
  return valid;
}
export const resultsFor=(events,id)=>events.filter(e=>e.opponentId===id);
export function aggregate(events){
  const tally={wins:0,draws:0,losses:0,total:events.length};
  for(const e of events)tally[{win:'wins',draw:'draws',loss:'losses'}[e.outcome]]++;
  return tally;
}
export function summarizeBatch(events,ids){
  const clean=validOutcomes(events,ids);
  return {...aggregate(clean),complete:ids.length===10 && clean.length===500};
}
export function isEngineImplementedStatus(status) {
  return status === 'Fully implemented' || status === 'Implemented' || status === 'Complete' || status === 'ok';
}
export function computeCompositeWinRate(events, lineup = []) {
  const oppIds = lineup.map((x) => x.entry?.id || x.id).filter(Boolean);
  const clean = validOutcomes(events || [], oppIds);
  const overall = aggregate(clean);
  const firstEvents = clean.filter((e) => e.index < 25);
  const secondEvents = clean.filter((e) => e.index >= 25);
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
    complete: oppIds.length === 10 && clean.length === 500,
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


