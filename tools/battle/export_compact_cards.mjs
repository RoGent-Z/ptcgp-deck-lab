import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPokemonCategories } from '../../public/app/core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'v4-eval');

const TYPE_CODES = {
  grass: 0, fire: 1, water: 2, lightning: 3, psychic: 4,
  fighting: 5, darkness: 6, metal: 7, dragon: 8, colorless: 9
};

export function encodeCompactCard(card, idx = 0, strategyBonus = 0) {
  const name = `${card.name || ''} ${card.nameEn || ''}`;
  const isFossil = card.subtype === 'fossil' || /化石|Fossil/i.test(name);
  const isPokemon = card.type === 'pokemon' || isFossil ? 1 : 0;
  const stage = card.stage === 'stage2' ? 2 : card.stage === 'stage1' ? 1 : 0;
  const primaryType = (card.types?.[0] || 'colorless').toLowerCase();
  const typeCode = TYPE_CODES[primaryType] ?? 9;
  const weakCode = card.weakness ? (TYPE_CODES[String(card.weakness).toLowerCase()] ?? 255) : 255;
  const hp = isFossil ? 40 : (Number(card.hp) || (isPokemon ? 60 : 0));
  const retreat = isFossil ? 4 : Math.min(4, Math.max(0, Number(card.retreat ?? 1)));

  const cats = card.type === 'pokemon' ? getPokemonCategories(card) : [];
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
      trainerKind = 7;
      effectVal = 10;
    } else if (card.subtype === 'tool') {
      trainerKind = 5;
      effectVal = /斗蓬|斗篷|Cape|HP\+20|HP\+30/i.test(eff) ? 20 : /頭盔|Helmet|20點傷害/i.test(eff) ? -20 : 10;
    } else if (/奇異糖果|神奇糖果|Rare Candy/i.test(eff)) {
      trainerKind = 6;
      effectVal = 99; // Rare Candy marker
    } else if (/大木博士|精靈球|模仿少女|奇樹|通訊|Research|Poké Ball|Copycat|Iono|Communication|抽.*張|抽出/i.test(eff)) {
      trainerKind = 1;
      effectVal = /大木|Research/i.test(eff) ? 2 : 1;
    } else if (/傷藥|莉佳|珠貝|莉莉艾|寶可夢中心|Potion|Erika|Irida|Lillie|Center Lady|恢復/i.test(eff)) {
      trainerKind = 2;
      const m = eff.match(/(\d+)\s*HP|恢復\s*(\d+)/i);
      effectVal = m ? Math.min(80, Number(m[1] || m[2]) || 30) : 30;
    } else if (/娜姿|赤日|古茲馬|夥星|紅牌|Sabrina|Cyrus|Guzma|Mars|Red Card|互換|放回牌庫/i.test(eff)) {
      trainerKind = 3;
      effectVal = /赤日|Cyrus/i.test(eff) ? 2 : /夥星|紅牌|Mars|Red Card/i.test(eff) ? 3 : 1;
    } else if (/坂木|赤紅|夏伯|竹蘭|Giovanni|Red\b|Blaine|Cynthia|\+\d+點/i.test(eff)) {
      trainerKind = 4;
      effectVal = /赤紅|Red\b/i.test(eff) ? 20 : 10;
    } else if (/速度強化|葉子|小光|小霞|小剛|火焰貼片|X Speed|Leaf|Dawn|Misty|Brock|Flame Patch|撤退|能量/i.test(eff)) {
      trainerKind = 6;
      effectVal = /能量|Energy|Misty|Brock|Dawn|Patch/i.test(eff) ? 2 : 1;
    } else {
      trainerKind = 1;
      effectVal = 1;
    }
  }

  return {
    idx,
    id: card.id,
    isPokemon,
    stage,
    typeCode,
    weakCode,
    hp,
    retreat,
    prize,
    atkCost: bestCost,
    atkDmg: bestDmg,
    atkFlags,
    abFlags,
    trainerKind,
    effectVal,
    strategyBonus
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('export_compact_cards.mjs')) {
  await mkdir(OUT_DIR, { recursive: true });
  const cards = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'cards.json'), 'utf8'));
  const meta = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'meta.top.json'), 'utf8'));
  const v3 = JSON.parse(await readFile(path.join(ROOT, 'public', 'battle', 'models', 'v3.json'), 'utf8'));

  const idToIdx = new Map();
  const cardLines = [];
  for (let i = 0; i < cards.length; i++) {
    const enc = encodeCompactCard(cards[i], i, 0);
    idToIdx.set(cards[i].id, i);
    cardLines.push([
      enc.idx, enc.id, enc.isPokemon, enc.stage, enc.typeCode, enc.weakCode,
      enc.hp, enc.retreat, enc.prize, enc.atkCost, enc.atkDmg, enc.atkFlags,
      enc.abFlags, enc.trainerKind, enc.effectVal
    ].join('\t'));
  }
  await writeFile(path.join(OUT_DIR, 'cards.tsv'), cardLines.join('\n') + '\n', 'utf8');

  const top10 = meta.entries.slice(0, 10);
  const deckLines = [];
  for (const entry of top10) {
    const idxs = [];
    for (const c of entry.representative.cards) {
      const ci = idToIdx.get(c.id);
      if (ci == null) throw Error(`Missing card ${c.id}`);
      for (let k = 0; k < c.count; k++) idxs.push(ci);
    }
    deckLines.push(`${entry.id}\t${idxs.join(',')}`);
  }
  await writeFile(path.join(OUT_DIR, 'meta_decks.tsv'), deckLines.join('\n') + '\n', 'utf8');
  await writeFile(path.join(OUT_DIR, 'v3_weights.txt'), v3.weights.join(',') + '\n', 'utf8');
  console.log(`Exported ${cards.length} compact cards and ${top10.length} meta decks to ${OUT_DIR}`);
}
