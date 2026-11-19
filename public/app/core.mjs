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

