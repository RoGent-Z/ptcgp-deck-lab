/**
 * High-Throughput All-Pairs 1,000-Game GPU Simulator (NVIDIA Blackwell WebGPU).
 *
 * Evaluates EVERY unordered pair of all 4,577 PTCG Pocket cards:
 *   - Total catalog cards: 4,577
 *   - Total unordered card pairs C(4577, 2): 10,472,176 pairs (> 10M strategy entries!)
 *   - Distinct functional cards (exact rules): 2,566
 *   - Distinct functional pairs C(2566, 2) + 2566: 3,293,461 functional pairs
 *   - Simulated games per functional pair: 1,000 games
 *       (10 Top-10 Meta opponents x 100 games = 250 games x 4 tactical regimes, 50/50 first/second)
 *   - Total real GPU-simulated games: 3,293,461,000 (~3.29 BILLION games!)
 *
 * GPU Optimizations:
 *   - 16-byte packed vec4<u32> cards (4x smaller than 64B struct -> fits ALL 10 enemy decks + player deck in shared memory!)
 *   - Zero global memory card reads during gameplay (100% workgroup shared memory L1 speed)
 *   - Warp-coherent opponent assignment (lid / 25 -> minimal divergence)
 *   - Standardized balanced 16-card core shell for all pairs -> true apples-to-apples synergy delta
 *   - 32,768 pairs (32.77M games) per GPU dispatch, 101 dispatches total for 3.29B games!
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeCardForFastSim } from '../../public/app/core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DRY_RUN_PAIRS = process.argv.includes('--dry-run') ? 32768 : 0;

const TYPE_BITS = {
  grass: 1 << 0, fire: 1 << 1, water: 1 << 2, lightning: 1 << 3,
  psychic: 1 << 4, fighting: 1 << 5, darkness: 1 << 6, metal: 1 << 7,
  dragon: 1 << 8, colorless: 1 << 9
};

const TYPE_REGEX = [
  ['grass', /\[\s*草\s*\]|草屬性|草能量|(?<![\u4e00-\u9fff])草寶可夢|Grass\s+Pok[eé]mon|Grass\s+Energy/i],
  ['fire', /\[\s*火\s*\]|火屬性|火能量|(?<![\u4e00-\u9fff])火寶可夢|Fire\s+Pok[eé]mon|Fire\s+Energy/i],
  ['water', /\[\s*水\s*\]|水屬性|水能量|(?<![\u4e00-\u9fff])水寶可夢|Water\s+Pok[eé]mon|Water\s+Energy/i],
  ['lightning', /\[\s*雷\s*\]|雷屬性|雷能量|(?<![\u4e00-\u9fff])雷寶可夢|Lightning\s+Pok[eé]mon|Lightning\s+Energy/i],
  ['psychic', /\[\s*超\s*\]|超屬性|超能量|(?<![\u4e00-\u9fff])超寶可夢|Psychic\s+Pok[eé]mon|Psychic\s+Energy/i],
  ['fighting', /\[\s*鬥\s*\]|鬥屬性|鬥能量|Fighting\s+Pok[eé]mon|Fighting\s+Energy/i],
  ['darkness', /\[\s*惡\s*\]|惡屬性|惡能量|(?<![\u4e00-\u9fff])惡寶可夢|Darkness\s+Pok[eé]mon|Darkness\s+Energy/i],
  ['metal', /\[\s*鋼\s*\]|鋼屬性|鋼能量|(?<![\u4e00-\u9fff])鋼寶可夢|Metal\s+Pok[eé]mon|Metal\s+Energy/i]
];

function normKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getTrainerTypeMask(card) {
  if (!card || card.type !== 'trainer') return 0;
  const eff = String(card.effect || '');
  const isOppOnly = /將對手的.*寶可夢身上的.*\[[草火水雷超鬥惡鋼]\]能量/.test(eff)
    && !/自己的.*\[[草火水雷超鬥惡鋼]\]/.test(eff);
  if (isOppOnly) return 0;
  let mask = 0;
  for (const [tk, rx] of TYPE_REGEX) {
    if (rx.test(eff)) mask |= TYPE_BITS[tk];
  }
  return mask;
}

function getTrainerStageMask(card) {
  if (!card || card.type !== 'trainer') return 0;
  const eff = String(card.effect || '');
  const nm = `${card.name || ''} ${card.nameEn || ''}`;
  if (/神奇糖果|奇異糖果|Rare Candy/i.test(nm)) return 8;
  if (/2階進化寶可夢|Stage 2/i.test(eff)) return 4;
  if (/1階進化寶可夢|Stage 1/i.test(eff)) return 2;
  if (/基礎寶可夢|Basic Pok/i.test(eff)) return 1;
  return 0;
}

function getPokemonAttackTypeMask(card) {
  if (!card || card.type !== 'pokemon') return 0;
  let mask = 0;
  for (const atk of card.attacks || []) {
    for (const sym of atk.cost || []) {
      const k = String(sym || '').toLowerCase();
      if (k && k !== 'colorless' && TYPE_BITS[k]) mask |= TYPE_BITS[k];
    }
  }
  return mask;
}

// Pack a card into compact 4 x u32 (16 bytes!) for ultra-fast shared memory access on GPU:
// w0: isPoke(1) | stage(2) | type(4) | weak(4) | prize(2) | retreat(3) | atkCost(3) | atkFlags(5) | abFlags(5) | trnKind(3)
// w1: hp(12) | atkDmg(12) | effValSigned8(8)   (effVal encoded as clamp(effVal + 128, 0, 255))
// w2: bonusQ10Signed16(16) | metaBits(16)       (bonusQ = clamp(round(bonus*1024) + 32768, 0, 65535); metaBits = typeMask(10) | stageMask(4)<<10)
// w3: selfNameId(16) | evolvesFromId(16)
function packCardVec4(enc, { typeMask = 0, stageMask = 0, selfId = 0, evoId = 0 } = {}) {
  const isPoke = enc.isPokemon ? 1 : 0;
  const stage = Math.max(0, Math.min(3, enc.stage | 0));
  const typeCode = Math.max(0, Math.min(15, enc.typeCode | 0));
  const weakCode = enc.weakCode >= 0 && enc.weakCode <= 10 ? (enc.weakCode | 0) : 15;
  const prize = Math.max(1, Math.min(3, enc.prize | 0));
  const retreat = Math.max(0, Math.min(7, enc.retreat | 0));
  const atkCost = Math.max(1, Math.min(7, enc.atkCost | 0));
  const atkFlags = (enc.atkFlags | 0) & 0x1f;
  const abFlags = (enc.abFlags | 0) & 0x1f;
  const trnKind = Math.max(0, Math.min(7, enc.trainerKind | 0));

  const w0 = (
    (isPoke)
    | (stage << 1)
    | (typeCode << 3)
    | (weakCode << 7)
    | (prize << 11)
    | (retreat << 13)
    | (atkCost << 16)
    | (atkFlags << 19)
    | (abFlags << 24)
    | (trnKind << 29)
  ) >>> 0;

  const hp = Math.max(0, Math.min(4095, enc.hp | 0));
  const dmg = Math.max(0, Math.min(4095, enc.atkDmg | 0));
  const effU8 = Math.max(0, Math.min(255, (enc.effectVal | 0) + 128));
  const w1 = ((hp) | (dmg << 12) | (effU8 << 24)) >>> 0;

  const bonusQ = Math.max(-30000, Math.min(30000, Math.round(Number(enc.strategyBonus || 0) * 1024)));
  const bonusU16 = (bonusQ + 32768) & 0xffff;
  const metaBits = ((typeMask & 0x3ff) | ((stageMask & 0xf) << 10)) & 0xffff;
  const w2 = ((bonusU16) | (metaBits << 16)) >>> 0;

  const w3 = ((selfId & 0xffff) | ((evoId & 0xffff) << 16)) >>> 0;
  return [w0, w1, w2, w3];
}

// ---------------------------------------------------------------------------
// 1. Load catalog, meta decks, v3 weights, top10 elite weights
// ---------------------------------------------------------------------------
console.log('[pairwise-10m] Loading catalog, meta decks, and weights...');
const cards = JSON.parse(readFileSync(path.join(ROOT, 'public/data/cards.json'), 'utf8'));
const meta = JSON.parse(readFileSync(path.join(ROOT, 'public/data/meta.json'), 'utf8'));
const v3 = JSON.parse(readFileSync(path.join(ROOT, 'public/battle/models/v3.json'), 'utf8'));
const top10Elite = JSON.parse(readFileSync(path.join(ROOT, 'public/battle/models/top10-elite.json'), 'utf8'));
const cardPriors = JSON.parse(readFileSync(path.join(ROOT, 'public/battle/models/card-priors.json'), 'utf8'));
const cardsById = new Map(cards.map((c) => [c.id, c]));

const totalCards = cards.length;
const totalCardPairs = (totalCards * (totalCards - 1)) / 2;

const groupMap = new Map();
const funcCards = [];
const groupOf = new Uint16Array(totalCards);
const cardIds = new Array(totalCards);

for (let i = 0; i < totalCards; i++) {
  const c = cards[i];
  cardIds[i] = c.id;
  const fKey = JSON.stringify([
    c.type, c.subtype || '', c.stage || '', c.limitName || c.nameEn || c.name,
    c.hp || 0, c.types || [], c.weakness || '', c.retreat ?? '',
    (c.attacks || []).map((a) => [a.nameEn || a.name, a.cost || [], a.damage || '', a.effect || '']),
    (c.abilities || []).map((a) => [a.nameEn || a.name, a.effect || '']),
    c.effect || ''
  ]);
  let g = groupMap.get(fKey);
  if (g === undefined) {
    g = funcCards.length;
    groupMap.set(fKey, g);
    funcCards.push({ g, card: c, memberIds: [c.id] });
  } else {
    funcCards[g].memberIds.push(c.id);
  }
  groupOf[i] = g;
}

const G = funcCards.length;
const totalFuncPairs = (G * (G + 1)) / 2;
console.log(`[pairwise-10m] Total cards: ${totalCards} -> C(N,2) = ${totalCardPairs.toLocaleString()} pairs`);
console.log(`[pairwise-10m] Functional groups: ${G} -> functional pairs (incl. 2x self-pairs) = ${totalFuncPairs.toLocaleString()}`);

const nameToId = new Map();
const getNameId = (s) => {
  const k = normKey(s);
  if (!k) return 0;
  let id = nameToId.get(k);
  if (!id) {
    id = nameToId.size + 1;
    nameToId.set(k, id);
  }
  return id;
};

const funcCardsU32 = new Uint32Array(G * 4);
for (let g = 0; g < G; g++) {
  const c = funcCards[g].card;
  const priorBonus = Number(cardPriors?.byCardId?.[c.id]?.p || 0);
  const enc = encodeCardForFastSim(c, priorBonus);
  const typeMask = c.type === 'trainer' ? getTrainerTypeMask(c) : getPokemonAttackTypeMask(c);
  const stageMask = c.type === 'trainer' ? getTrainerStageMask(c) : 0;
  const selfId = getNameId(c.limitName || c.nameEn || c.name);
  const evoId = c.evolvesFrom ? getNameId(c.evolvesFrom) : 0;
  funcCardsU32.set(packCardVec4(enc, { typeMask, stageMask, selfId, evoId }), g * 4);
}

// Standardized balanced neutral 20-card host shell (identical for EVERY pair so solo[u] vs pair(u,v) is 100% apples-to-apples!)
// Slots 0..1: Reliable colorless Basic starters (HP 70, 1-energy 30 dmg)
// Slots 2..5: Pair injection slots for Pokémon (2x u, 2x v) or standard Basic/Stage1 fillers
// Slots 6..9: Balanced Stage 1 + Stage 2 colorless support line
// Slots 10..13: Core universal draw (2x Research, 2x Poké Ball)
// Slots 14..17: Pair injection slots for Trainers (2x u, 2x v) or universal Staples (Sabrina, Cape)
// Slots 18..19: Universal utility (Potion, X Speed)
const hostShellCards = [
  // 0..1 Basic Colorless starter
  { isPokemon: 1, stage: 0, typeCode: 9, weakCode: 5, hp: 70, retreat: 1, prize: 1, atkCost: 1, atkDmg: 30, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.05 },
  { isPokemon: 1, stage: 0, typeCode: 9, weakCode: 5, hp: 70, retreat: 1, prize: 1, atkCost: 1, atkDmg: 30, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.05 },
  // 2..3 Default Pokémon slot U
  { isPokemon: 1, stage: 0, typeCode: 9, weakCode: 5, hp: 80, retreat: 1, prize: 1, atkCost: 2, atkDmg: 50, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.04 },
  { isPokemon: 1, stage: 0, typeCode: 9, weakCode: 5, hp: 80, retreat: 1, prize: 1, atkCost: 2, atkDmg: 50, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.04 },
  // 4..5 Default Pokémon slot V
  { isPokemon: 1, stage: 1, typeCode: 9, weakCode: 5, hp: 100, retreat: 1, prize: 1, atkCost: 2, atkDmg: 70, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.05 },
  { isPokemon: 1, stage: 1, typeCode: 9, weakCode: 5, hp: 100, retreat: 1, prize: 1, atkCost: 2, atkDmg: 70, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.05 },
  // 6..9 Balanced evolution finishers
  { isPokemon: 1, stage: 1, typeCode: 9, weakCode: 5, hp: 110, retreat: 2, prize: 1, atkCost: 2, atkDmg: 80, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.05 },
  { isPokemon: 1, stage: 1, typeCode: 9, weakCode: 5, hp: 110, retreat: 2, prize: 1, atkCost: 2, atkDmg: 80, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.05 },
  { isPokemon: 1, stage: 2, typeCode: 9, weakCode: 5, hp: 150, retreat: 2, prize: 2, atkCost: 3, atkDmg: 120, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.08 },
  { isPokemon: 1, stage: 2, typeCode: 9, weakCode: 5, hp: 150, retreat: 2, prize: 2, atkCost: 3, atkDmg: 120, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0.08 },
  // 10..13 Research + Poké Ball
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 1, effectVal: 2, strategyBonus: 0.15 },
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 1, effectVal: 2, strategyBonus: 0.15 },
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 1, effectVal: 1, strategyBonus: 0.12 },
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 1, effectVal: 1, strategyBonus: 0.12 },
  // 14..15 Default Trainer slot U
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 5, effectVal: 20, strategyBonus: 0.10 },
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 5, effectVal: 20, strategyBonus: 0.10 },
  // 16..17 Default Trainer slot V
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 3, effectVal: 1, strategyBonus: 0.10 },
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 3, effectVal: 1, strategyBonus: 0.10 },
  // 18..19 Heal + Retreat
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 2, effectVal: 30, strategyBonus: 0.08 },
  { isPokemon: 0, stage: 0, typeCode: 9, weakCode: 15, hp: 0, retreat: 0, prize: 1, atkCost: 1, atkDmg: 0, atkFlags: 0, abFlags: 0, trainerKind: 6, effectVal: 1, strategyBonus: 0.08 }
];

// Pack 11 decks (0..9 = Top-10 Meta opponents, 10 = standardized balanced host shell) -> 11 * 20 * 4 u32 = 3.52 KB total!
const top10 = meta.entries.filter((e) => e.representative?.cards?.length).slice(0, 10);
const metaDecksU32 = new Uint32Array(11 * 20 * 4);
const enemyWeightsI32 = new Int32Array(10 * 22);
const baseW = v3.weights;

for (let oi = 0; oi < 10; oi++) {
  const rep = top10[oi].representative;
  const expanded = [];
  for (const entry of rep.cards) {
    const c = cardsById.get(entry.id);
    const b = Number(cardPriors?.byCardId?.[entry.id]?.p || 0);
    const enc = encodeCardForFastSim(c, b);
    const v4 = packCardVec4(enc);
    for (let k = 0; k < (entry.count || 1); k++) {
      if (expanded.length < 20) expanded.push(v4);
    }
  }
  while (expanded.length < 20) expanded.push(expanded[0]);
  for (let k = 0; k < 20; k++) {
    metaDecksU32.set(expanded[k], (oi * 20 + k) * 4);
  }
  const ew = top10Elite.teams?.[top10[oi].id]?.weights || baseW;
  for (let f = 0; f < 22; f++) {
    enemyWeightsI32[oi * 22 + f] = Math.round(ew[f] * 1024);
  }
}
for (let k = 0; k < 20; k++) {
  metaDecksU32.set(packCardVec4(hostShellCards[k]), (10 * 20 + k) * 4);
}

const regimesF32 = Array.from({ length: 4 }, () => [...baseW]);
regimesF32[0][2] += 0.45; regimesF32[0][3] += 0.35; regimesF32[0][9] += 0.45; regimesF32[0][10] += 0.40; regimesF32[0][11] += 0.55; regimesF32[0][14] += 0.35;
regimesF32[1][6] += 0.45; regimesF32[1][7] += 0.45; regimesF32[1][8] += 0.50; regimesF32[1][19] += 0.45; regimesF32[1][18] += 0.40;
regimesF32[2][4] += 0.55; regimesF32[2][5] += 0.50; regimesF32[2][15] += 0.40; regimesF32[2][16] += 0.40; regimesF32[2][20] += 0.55; regimesF32[2][18] += 0.45;
regimesF32[3][11] += 0.60; regimesF32[3][12] += 0.35; regimesF32[3][21] += 0.65; regimesF32[3][19] += 0.40; regimesF32[3][17] += 0.25;

const regimesI32 = new Int32Array(4 * 22);
for (let r = 0; r < 4; r++) {
  for (let f = 0; f < 22; f++) {
    regimesI32[r * 22 + f] = Math.round(regimesF32[r][f] * 1024);
  }
}

// ---------------------------------------------------------------------------
// 2. Ultra-Fast Shared-Memory WGSL Kernel (16B packed cards, ALL decks in shared memory!)
// ---------------------------------------------------------------------------
const WGSL_PAIRWISE = /* wgsl */ `
const FEATURES: u32 = 22u;

struct Params {
  pair_count: u32,
  batch_offset: u32,
  func_count: u32,
  seed_base: u32,
};

struct Slot {
  occ: i32,
  ci: u32,
  hp: i32,
  max_hp: i32,
  energy: i32,
  tool: i32,
  status: i32,
  turn_placed: i32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> func_cards: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> meta_decks: array<vec4<u32>>; // 10 enemies (0..199) + host shell (200..219)
@group(0) @binding(3) var<storage, read> regime_weights: array<i32>;
@group(0) @binding(4) var<storage, read> enemy_weights: array<i32>;
@group(0) @binding(5) var<storage, read> pair_uv: array<u32>;
@group(0) @binding(6) var<storage, read_write> out_results: array<u32>;

// ALL 10 enemy decks (200 cards) + player deck (20 cards) cached right in 3.5 KB workgroup shared memory!
var<workgroup> wg_player: array<vec4<u32>, 20>;
var<workgroup> wg_enemies: array<vec4<u32>, 200>;
var<workgroup> wg_rw: array<i32, 88>;
var<workgroup> wg_ew: array<i32, 220>;
var<workgroup> wg_pair_tag: u32;
var<workgroup> wg_r0: array<u32, 256>;
var<workgroup> wg_r1: array<u32, 256>;
var<workgroup> wg_r2: array<u32, 256>;
var<workgroup> wg_r3: array<u32, 256>;
var<workgroup> wg_dr: array<u32, 256>;

// Fast inline bitfield unpackers
fn c_is_poke(c: vec4<u32>) -> i32 { return i32(c.x & 1u); }
fn c_stage(c: vec4<u32>) -> i32 { return i32((c.x >> 1u) & 3u); }
fn c_type(c: vec4<u32>) -> i32 { return i32((c.x >> 3u) & 15u); }
fn c_weak(c: vec4<u32>) -> i32 { return i32((c.x >> 7u) & 15u); }
fn c_prize(c: vec4<u32>) -> i32 { return max(1, i32((c.x >> 11u) & 3u)); }
fn c_retreat(c: vec4<u32>) -> i32 { return i32((c.x >> 13u) & 7u); }
fn c_atk_cost(c: vec4<u32>) -> i32 { return max(1, i32((c.x >> 16u) & 7u)); }
fn c_atk_flags(c: vec4<u32>) -> i32 { return i32((c.x >> 19u) & 31u); }
fn c_ab_flags(c: vec4<u32>) -> i32 { return i32((c.x >> 24u) & 31u); }
fn c_trn_kind(c: vec4<u32>) -> i32 { return i32((c.x >> 29u) & 7u); }
fn c_hp(c: vec4<u32>) -> i32 { return i32(c.y & 4095u); }
fn c_dmg(c: vec4<u32>) -> i32 { return i32((c.y >> 12u) & 4095u); }
fn c_eff(c: vec4<u32>) -> i32 { return i32((c.y >> 24u) & 255u) - 128; }
fn c_bonus(c: vec4<u32>) -> i32 { return i32(c.z & 65535u) - 32768; }
fn c_meta(c: vec4<u32>) -> u32 { return (c.z >> 16u) & 65535u; }

fn get_card(opp_base: u32, ci: u32) -> vec4<u32> {
  if (ci < 20u) { return wg_player[ci]; }
  return wg_enemies[opp_base + (ci - 20u)];
}

fn get_w(cur: u32, r_base: u32, e_base: u32, f: u32) -> i32 {
  if (cur == 0u) { return wg_rw[r_base + f]; }
  return wg_ew[e_base + f];
}

fn rng_next(state: ptr<function, u32>) -> u32 {
  var x = *state + 0x9e3779b9u;
  *state = x;
  var z = (x ^ (x >> 16u)) * 0x85ebca6bu;
  z = (z ^ (z >> 13u)) * 0xc2b2ae35u;
  return z ^ (z >> 16u);
}

fn simulate_game(seed: u32, first_player: u32, regime: u32, opp_idx: u32) -> u32 {
  let opp_base = opp_idx * 20u;
  let r_base = regime * 22u;
  let e_base = opp_idx * 22u;

  var rng = seed ^ 0x6c62272eu;
  var lib0: array<u32, 20>;
  var lib1: array<u32, 20>;
  for (var i = 0u; i < 20u; i = i + 1u) {
    lib0[i] = i;
    lib1[i] = 20u + i;
  }
  var lib_len = vec2<u32>(20u, 20u);
  var hand0: array<u32, 12>;
  var hand1: array<u32, 12>;
  var hand_len = vec2<u32>(0u, 0u);
  var b0: array<Slot, 4>;
  var b1: array<Slot, 4>;
  for (var s = 0u; s < 4u; s = s + 1u) {
    b0[s] = Slot(0, 0u, 0, 0, 0, 0, 0, 0);
    b1[s] = Slot(0, 0u, 0, 0, 0, 0, 0, 0);
  }
  var points = vec2<i32>(0, 0);

  // Player 0 shuffle & opening
  for (var i = 19u; i >= 1u; i = i - 1u) {
    let j = rng_next(&rng) % (i + 1u);
    let t = lib0[i]; lib0[i] = lib0[j]; lib0[j] = t;
  }
  var bp0 = 20u;
  for (var i = 0u; i < 20u; i = i + 1u) {
    let c = wg_player[lib0[i]];
    if (c_is_poke(c) == 1 && c_stage(c) == 0) { bp0 = i; break; }
  }
  if (bp0 < 20u && bp0 >= 5u) { let t = lib0[0]; lib0[0] = lib0[bp0]; lib0[bp0] = t; }
  for (var i = 0u; i < 5u; i = i + 1u) {
    lib_len[0] = lib_len[0] - 1u;
    hand0[hand_len[0]] = lib0[lib_len[0]];
    hand_len[0] = hand_len[0] + 1u;
  }
  var pa0 = false;
  var idx0 = 0u;
  loop {
    if (idx0 >= hand_len[0]) { break; }
    let ci = hand0[idx0];
    let c = wg_player[ci];
    if (c_is_poke(c) == 1 && c_stage(c) == 0) {
      let hp = c_hp(c);
      if (!pa0) {
        b0[0] = Slot(1, ci, hp, hp, 0, 0, 0, 0);
        pa0 = true;
        hand_len[0] = hand_len[0] - 1u;
        hand0[idx0] = hand0[hand_len[0]];
        continue;
      } else {
        var pb = false;
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (b0[s].occ == 0) { b0[s] = Slot(1, ci, hp, hp, 0, 0, 0, 0); pb = true; break; }
        }
        if (pb) {
          hand_len[0] = hand_len[0] - 1u;
          hand0[idx0] = hand0[hand_len[0]];
          continue;
        }
      }
    }
    idx0 = idx0 + 1u;
  }
  if (!pa0) {
    let hp = max(60, c_hp(wg_player[0u]));
    b0[0] = Slot(1, 0u, hp, hp, 0, 0, 0, 0);
  }

  // Player 1 shuffle & opening
  for (var i = 19u; i >= 1u; i = i - 1u) {
    let j = rng_next(&rng) % (i + 1u);
    let t = lib1[i]; lib1[i] = lib1[j]; lib1[j] = t;
  }
  var bp1 = 20u;
  for (var i = 0u; i < 20u; i = i + 1u) {
    let c = wg_enemies[opp_base + (lib1[i] - 20u)];
    if (c_is_poke(c) == 1 && c_stage(c) == 0) { bp1 = i; break; }
  }
  if (bp1 < 20u && bp1 >= 5u) { let t = lib1[0]; lib1[0] = lib1[bp1]; lib1[bp1] = t; }
  for (var i = 0u; i < 5u; i = i + 1u) {
    lib_len[1] = lib_len[1] - 1u;
    hand1[hand_len[1]] = lib1[lib_len[1]];
    hand_len[1] = hand_len[1] + 1u;
  }
  var pa1 = false;
  var idx1 = 0u;
  loop {
    if (idx1 >= hand_len[1]) { break; }
    let ci = hand1[idx1];
    let c = wg_enemies[opp_base + (ci - 20u)];
    if (c_is_poke(c) == 1 && c_stage(c) == 0) {
      let hp = c_hp(c);
      if (!pa1) {
        b1[0] = Slot(1, ci, hp, hp, 0, 0, 0, 0);
        pa1 = true;
        hand_len[1] = hand_len[1] - 1u;
        hand1[idx1] = hand1[hand_len[1]];
        continue;
      } else {
        var pb = false;
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (b1[s].occ == 0) { b1[s] = Slot(1, ci, hp, hp, 0, 0, 0, 0); pb = true; break; }
        }
        if (pb) {
          hand_len[1] = hand_len[1] - 1u;
          hand1[idx1] = hand1[hand_len[1]];
          continue;
        }
      }
    }
    idx1 = idx1 + 1u;
  }
  if (!pa1) {
    let hp = max(60, c_hp(wg_enemies[opp_base]));
    b1[0] = Slot(1, 20u, hp, hp, 0, 0, 0, 0);
  }

  var cur = first_player;
  for (var turn = 1u; turn <= 20u; turn = turn + 1u) {
    let foe = 1u - cur;
    var my_b: array<Slot, 4>;
    var fo_b: array<Slot, 4>;
    var my_h: array<u32, 12>;
    if (cur == 0u) { my_b = b0; fo_b = b1; my_h = hand0; }
    else { my_b = b1; fo_b = b0; my_h = hand1; }
    var my_hl = hand_len[cur];
    var fo_hl = hand_len[foe];
    var my_ll = lib_len[cur];

    if (my_ll > 0u && my_hl < 12u) {
      my_ll = my_ll - 1u;
      if (cur == 0u) { my_h[my_hl] = lib0[my_ll]; } else { my_h[my_hl] = lib1[my_ll]; }
      my_hl = my_hl + 1u;
    }

    var energy_attached = (turn == 1u);
    var supporter_used = false;
    var retreated = false;
    var ability_used = false;
    var dmg_boost = 0;

    for (var step = 0u; step < 5u; step = step + 1u) {
      var best_kind = 0u;
      var best_a = 0u;
      var best_b = 0u;
      var best_score = get_w(cur, r_base, e_base, 0u);

      // Hand scan: Place basic / Evolve / Trainer in ONE single pass!
      for (var hi = 0u; hi < my_hl; hi = hi + 1u) {
        let c = get_card(opp_base, my_h[hi]);
        if (c_is_poke(c) == 1) {
          let st = c_stage(c);
          let dmg = c_dmg(c);
          let bq = c_bonus(c);
          if (st == 0) {
            for (var s = 1u; s < 4u; s = s + 1u) {
              if (my_b[s].occ == 0) {
                let sc = get_w(cur, r_base, e_base, 2u) + (((dmg * get_w(cur, r_base, e_base, 3u)) * 15) / 10000) + ((bq * 35) / 100);
                if (sc > best_score) { best_score = sc; best_kind = 1u; best_a = hi; best_b = s; }
                break;
              }
            }
          } else if (turn >= 2u && st < 3) {
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (my_b[s].occ == 1 && c_stage(get_card(opp_base, my_b[s].ci)) + 1 == st && my_b[s].turn_placed < i32(turn)) {
                let pd = select(dmg >> 1u, dmg, s == 0u);
                let sc = get_w(cur, r_base, e_base, 4u) + ((pd * get_w(cur, r_base, e_base, 5u)) / 100) + ((bq * 45) / 100);
                if (sc > best_score) { best_score = sc; best_kind = 2u; best_a = hi; best_b = s; }
              }
            }
          }
        } else {
          let tk = c_trn_kind(c);
          if (tk > 0) {
            let is_sup = (tk == 2 || tk == 3 || tk == 4);
            if (!(is_sup && supporter_used)) {
              var sc = get_w(cur, r_base, e_base, 7u) + ((c_bonus(c) * 40) / 100);
              var valid = true;
              if (tk == 1) {
                sc = sc + ((5 * get_w(cur, r_base, e_base, 8u)) / (5 + i32(my_hl)));
              } else if (tk == 2) {
                let missing = my_b[0].max_hp - my_b[0].hp;
                if (missing <= 0) { valid = false; }
                else { sc = sc + (get_w(cur, r_base, e_base, 20u) * min(missing, c_eff(c))) / 50; }
              } else if (tk == 3) {
                sc = sc + ((get_w(cur, r_base, e_base, 19u) * 45) + (get_w(cur, r_base, e_base, 21u) * 25)) / 100;
              } else if (tk == 4) {
                sc = sc + ((get_w(cur, r_base, e_base, 10u) * 35) + (get_w(cur, r_base, e_base, 11u) * 25)) / 100;
              } else if (tk == 5) {
                if (my_b[0].tool != 0) { valid = false; }
                else { sc = sc + get_w(cur, r_base, e_base, 20u); }
              } else if (tk == 6) {
                sc = sc + ((get_w(cur, r_base, e_base, 13u) * 45) + (get_w(cur, r_base, e_base, 15u) * 35)) / 100;
              } else {
                sc = sc + get_w(cur, r_base, e_base, 6u);
              }
              if (valid && sc > best_score) { best_score = sc; best_kind = 3u; best_a = hi; }
            }
          }
        }
      }

      // Board scan: Ability + Energy attach in ONE pass
      for (var s = 0u; s < 4u; s = s + 1u) {
        if (my_b[s].occ == 1) {
          let scard = get_card(opp_base, my_b[s].ci);
          let bq = c_bonus(scard);
          if (!ability_used && c_ab_flags(scard) != 0) {
            let sn = select(0, (get_w(cur, r_base, e_base, 21u) * 35) / 100, (c_ab_flags(scard) & 16) != 0);
            let sc = get_w(cur, r_base, e_base, 6u) + sn + ((bq * 35) / 100);
            if (sc > best_score) { best_score = sc; best_kind = 4u; best_a = s; }
          }
          if (!energy_attached) {
            let need = select(0, get_w(cur, r_base, e_base, 15u), my_b[s].energy < c_atk_cost(scard));
            let sc = get_w(cur, r_base, e_base, 13u)
              + select(0, get_w(cur, r_base, e_base, 14u), s == 0u)
              + need
              + ((c_dmg(scard) * get_w(cur, r_base, e_base, 16u)) / 100)
              + ((bq * 25) / 100);
            if (sc > best_score) { best_score = sc; best_kind = 5u; best_a = s; }
          }
        }
      }

      // Retreat
      let act_card = get_card(opp_base, my_b[0].ci);
      if (!retreated && my_b[0].occ == 1 && (my_b[0].status & 4) == 0 && my_b[0].energy >= c_retreat(act_card)) {
        let fo_dmg = select(0, c_dmg(get_card(opp_base, fo_b[0].ci)), fo_b[0].occ == 1);
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (my_b[s].occ == 1) {
            let endg = select(0, get_w(cur, r_base, e_base, 18u), my_b[0].hp <= fo_dmg && my_b[s].hp > my_b[0].hp);
            let sc = get_w(cur, r_base, e_base, 17u) + endg;
            if (sc > best_score) { best_score = sc; best_kind = 6u; best_a = s; }
          }
        }
      }

      // Attack
      if (turn >= 2u && my_b[0].occ == 1 && (my_b[0].status & 4) == 0) {
        let dmg = c_dmg(act_card);
        if (my_b[0].energy >= c_atk_cost(act_card) && dmg > 0) {
          let fo_card = get_card(opp_base, fo_b[0].ci);
          let weak_b = select(0, 20, fo_b[0].occ == 1 && c_weak(fo_card) == c_type(act_card));
          let tdmg = dmg + dmg_boost + weak_b;
          let ko = select(0, get_w(cur, r_base, e_base, 11u), fo_b[0].occ == 1 && tdmg >= fo_b[0].hp);
          let af = c_atk_flags(act_card);
          let eff = select(0, get_w(cur, r_base, e_base, 12u), (af & 1) != 0);
          let sn = select(0, get_w(cur, r_base, e_base, 21u) >> 1u, (af & 2) != 0);
          let sc = get_w(cur, r_base, e_base, 9u) + ((tdmg * get_w(cur, r_base, e_base, 10u)) / 100) + ko + eff + sn + ((c_bonus(act_card) * 40) / 100);
          if (sc > best_score) { best_kind = 7u; }
        }
      }

      if (best_kind == 0u) {
        break;
      } else if (best_kind == 1u) {
        let ci = my_h[best_a];
        let hp = c_hp(get_card(opp_base, ci));
        my_b[best_b] = Slot(1, ci, hp, hp, 0, 0, 0, i32(turn));
        my_hl = my_hl - 1u;
        my_h[best_a] = my_h[my_hl];
      } else if (best_kind == 2u) {
        let ci = my_h[best_a];
        let hp = c_hp(get_card(opp_base, ci));
        let taken = max(0, my_b[best_b].max_hp - my_b[best_b].hp);
        let bhp = select(0, 20, my_b[best_b].tool == 1);
        my_b[best_b].ci = ci;
        my_b[best_b].max_hp = hp + bhp;
        my_b[best_b].hp = max(10, my_b[best_b].max_hp - taken);
        my_b[best_b].status = 0;
        my_b[best_b].turn_placed = i32(turn);
        my_hl = my_hl - 1u;
        my_h[best_a] = my_h[my_hl];
      } else if (best_kind == 3u) {
        let c = get_card(opp_base, my_h[best_a]);
        let tk = c_trn_kind(c);
        let ev = c_eff(c);
        my_hl = my_hl - 1u;
        my_h[best_a] = my_h[my_hl];
        if (tk == 2 || tk == 3 || tk == 4) { supporter_used = true; }
        if (tk == 1) {
          let draws = u32(clamp(ev, 1, 2));
          for (var d = 0u; d < draws; d = d + 1u) {
            if (my_ll > 0u && my_hl < 12u) {
              my_ll = my_ll - 1u;
              if (cur == 0u) { my_h[my_hl] = lib0[my_ll]; } else { my_h[my_hl] = lib1[my_ll]; }
              my_hl = my_hl + 1u;
            }
          }
        } else if (tk == 2) {
          my_b[0].hp = min(my_b[0].max_hp, my_b[0].hp + ev);
        } else if (tk == 3) {
          if (ev == 3) {
            if (fo_hl > 3u) { fo_hl = 3u; }
          } else {
            var pick = 4u;
            for (var s = 1u; s < 4u; s = s + 1u) {
              if (fo_b[s].occ == 1) {
                if (ev == 2 && fo_b[s].hp < fo_b[s].max_hp) { pick = s; break; }
                if (pick == 4u || fo_b[s].hp < fo_b[pick].hp) { pick = s; }
              }
            }
            if (pick < 4u) { let tmp = fo_b[0]; fo_b[0] = fo_b[pick]; fo_b[pick] = tmp; }
          }
        } else if (tk == 4) {
          dmg_boost = dmg_boost + ev;
        } else if (tk == 5) {
          if (ev > 0) {
            my_b[0].tool = 1; my_b[0].max_hp = my_b[0].max_hp + 20; my_b[0].hp = my_b[0].hp + 20;
          } else {
            my_b[0].tool = 2;
          }
        } else if (tk == 6) {
          if (ev == 99 && turn >= 2u) {
            for (var hi2 = 0u; hi2 < my_hl; hi2 = hi2 + 1u) {
              let ev_ci = my_h[hi2];
              let evc = get_card(opp_base, ev_ci);
              if (c_is_poke(evc) == 1 && c_stage(evc) == 2) {
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (my_b[s].occ == 1 && c_stage(get_card(opp_base, my_b[s].ci)) == 0 && my_b[s].turn_placed < i32(turn)) {
                    let tk_dmg = max(0, my_b[s].max_hp - my_b[s].hp);
                    my_b[s].ci = ev_ci;
                    my_b[s].max_hp = c_hp(evc) + select(0, 20, my_b[s].tool == 1);
                    my_b[s].hp = max(10, my_b[s].max_hp - tk_dmg);
                    my_b[s].status = 0;
                    my_b[s].turn_placed = i32(turn);
                    my_hl = my_hl - 1u;
                    my_h[hi2] = my_h[my_hl];
                    break;
                  }
                }
                break;
              }
            }
          } else if (ev >= 2) {
            my_b[0].energy = my_b[0].energy + 1;
          }
        } else {
          dmg_boost = dmg_boost + max(0, ev);
        }
      } else if (best_kind == 4u) {
        ability_used = true;
        let ab = c_ab_flags(get_card(opp_base, my_b[best_a].ci));
        if ((ab & 2) != 0 && my_ll > 0u && my_hl < 12u) {
          my_ll = my_ll - 1u;
          if (cur == 0u) { my_h[my_hl] = lib0[my_ll]; } else { my_h[my_hl] = lib1[my_ll]; }
          my_hl = my_hl + 1u;
        }
        if ((ab & 4) != 0) { my_b[0].energy = my_b[0].energy + 1; }
        if ((ab & 8) != 0) { my_b[0].hp = min(my_b[0].max_hp, my_b[0].hp + 20); }
        if ((ab & 16) != 0) {
          var ts = 0u;
          for (var s = 1u; s < 4u; s = s + 1u) { if (fo_b[s].occ == 1) { ts = s; break; } }
          if (fo_b[ts].occ == 1) {
            fo_b[ts].hp = fo_b[ts].hp - 20;
            if (fo_b[ts].hp <= 0) {
              points[cur] = points[cur] + c_prize(get_card(opp_base, fo_b[ts].ci));
              fo_b[ts].occ = 0;
              if (ts == 0u) {
                for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (fo_b[ns].occ == 1) { let tmp = fo_b[0]; fo_b[0] = fo_b[ns]; fo_b[ns] = tmp; break; } }
              }
              if (points[cur] >= 3 || fo_b[0].occ == 0) { return select(0u, 1u, cur == 0u); }
            }
          }
        }
      } else if (best_kind == 5u) {
        energy_attached = true;
        my_b[best_a].energy = my_b[best_a].energy + 1;
      } else if (best_kind == 6u) {
        retreated = true;
        my_b[0].energy = max(0, my_b[0].energy - c_retreat(act_card));
        my_b[0].status = 0;
        let tmp = my_b[0]; my_b[0] = my_b[best_a]; my_b[best_a] = tmp;
      } else if (best_kind == 7u) {
        let fo_card = get_card(opp_base, fo_b[0].ci);
        let weak_b = select(0, 20, fo_b[0].occ == 1 && c_weak(fo_card) == c_type(act_card));
        let tdmg = c_dmg(act_card) + dmg_boost + weak_b;
        if (fo_b[0].occ == 1) {
          fo_b[0].hp = fo_b[0].hp - tdmg;
          if (fo_b[0].tool == 2) { my_b[0].hp = my_b[0].hp - 20; }
          let af = c_atk_flags(act_card);
          if ((af & 2) != 0) {
            for (var s = 1u; s < 4u; s = s + 1u) {
              if (fo_b[s].occ == 1) {
                fo_b[s].hp = fo_b[s].hp - 20;
                if (fo_b[s].hp <= 0) { points[cur] = points[cur] + c_prize(get_card(opp_base, fo_b[s].ci)); fo_b[s].occ = 0; }
                break;
              }
            }
          }
          if ((af & 4) != 0) { fo_b[0].status = fo_b[0].status | 1; }
          if ((af & 8) != 0) { my_b[0].hp = min(my_b[0].max_hp, my_b[0].hp + 20); }
          if ((af & 16) != 0) { my_b[0].energy = my_b[0].energy + 1; }

          if (fo_b[0].hp <= 0) {
            points[cur] = points[cur] + c_prize(fo_card);
            fo_b[0].occ = 0;
            for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (fo_b[ns].occ == 1) { let tmp = fo_b[0]; fo_b[0] = fo_b[ns]; fo_b[ns] = tmp; break; } }
          }
          if (my_b[0].hp <= 0) {
            points[foe] = points[foe] + c_prize(act_card);
            my_b[0].occ = 0;
            for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (my_b[ns].occ == 1) { let tmp = my_b[0]; my_b[0] = my_b[ns]; my_b[ns] = tmp; break; } }
          }
          let cw = (points[cur] >= 3 || fo_b[0].occ == 0);
          let fw = (points[foe] >= 3 || my_b[0].occ == 0);
          if (cw && fw) { return 2u; }
          if (cw) { return select(0u, 1u, cur == 0u); }
          if (fw) { return select(0u, 1u, foe == 0u); }
        }
        break;
      }
    }

    if (cur == 0u) { b0 = my_b; b1 = fo_b; hand0 = my_h; }
    else { b1 = my_b; b0 = fo_b; hand1 = my_h; }
    hand_len[cur] = my_hl;
    hand_len[foe] = fo_hl;
    lib_len[cur] = my_ll;

    if (b0[0].occ == 1 && (b0[0].status & 1) != 0) {
      b0[0].hp = b0[0].hp - 10;
      if (b0[0].hp <= 0) {
        points[1] = points[1] + c_prize(wg_player[b0[0].ci]);
        b0[0].occ = 0;
        for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (b0[ns].occ == 1) { let tmp = b0[0]; b0[0] = b0[ns]; b0[ns] = tmp; break; } }
        if (points[1] >= 3 || b0[0].occ == 0) { return 0u; }
      }
    }
    if (b1[0].occ == 1 && (b1[0].status & 1) != 0) {
      b1[0].hp = b1[0].hp - 10;
      if (b1[0].hp <= 0) {
        points[0] = points[0] + c_prize(wg_enemies[opp_base + (b1[0].ci - 20u)]);
        b1[0].occ = 0;
        for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (b1[ns].occ == 1) { let tmp = b1[0]; b1[0] = b1[ns]; b1[ns] = tmp; break; } }
        if (points[0] >= 3 || b1[0].occ == 0) { return 1u; }
      }
    }
    cur = foe;
  }
  return 2u;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) local_id: vec3<u32>) {
  let local_pair = wg_id.x;
  if (local_pair >= params.pair_count) { return; }
  let lid = local_id.x;

  // Cooperative load of ALL 10 enemy decks (200 vec4) + host shell (20 vec4) + weights into workgroup shared memory!
  if (lid < 200u) {
    wg_enemies[lid] = meta_decks[lid];
  } else if (lid < 220u) {
    wg_player[lid - 200u] = meta_decks[lid];
  }
  if (lid < 88u) {
    wg_rw[lid] = regime_weights[lid];
  }
  if (lid < 220u) {
    wg_ew[lid] = enemy_weights[lid];
  }
  workgroupBarrier();

  if (lid == 0u) {
    let uv = pair_uv[local_pair];
    let u = uv >> 16u;
    let v = uv & 0xffffu;
    var cu = func_cards[u];
    var cv = func_cards[v];

    let u_self = cu.w & 0xffffu;
    let u_evo = cu.w >> 16u;
    let v_self = cv.w & 0xffffu;
    let v_evo = cv.w >> 16u;

    let u_meta = c_meta(cu);
    let v_meta = c_meta(cv);
    let u_tmask = u_meta & 0x3ffu;
    let v_tmask = v_meta & 0x3ffu;
    let u_smask = (u_meta >> 10u) & 0xfu;
    let v_smask = (v_meta >> 10u) & 0xfu;

    let u_poke = c_is_poke(cu);
    let v_poke = c_is_poke(cv);
    var tag: u32 = 0u;
    var bonus_boost: i32 = 0;

    let direct_evo = (u_self != 0u && u_self == v_evo) || (v_self != 0u && v_self == u_evo);
    let candy_s2 = ((u_smask & 8u) != 0u && v_poke == 1 && c_stage(cv) == 2)
      || ((v_smask & 8u) != 0u && u_poke == 1 && c_stage(cu) == 2);

    if (direct_evo || candy_s2) {
      tag = 2u;
      bonus_boost = 180;
    } else if (u_poke == 1 && v_poke == 1) {
      let ut = c_type(cu);
      let vt = c_type(cv);
      let same_type = (ut == vt) || (ut == 9) || (vt == 9);
      let cost_conflict = (u_tmask != 0u) && (v_tmask != 0u) && ((u_tmask & v_tmask) == 0u);
      if (cost_conflict) {
        tag = 3u;
        let uc = min(7u, u32(c_atk_cost(cu) + 1));
        let vc = min(7u, u32(c_atk_cost(cv) + 1));
        cu.x = (cu.x & ~(7u << 16u)) | (uc << 16u);
        cv.x = (cv.x & ~(7u << 16u)) | (vc << 16u);
      } else if (same_type) {
        tag = 1u;
        bonus_boost = 95;
      }
    } else if (u_poke != v_poke) {
      var poke = cv;
      var trn = cu;
      var trn_tmask = u_tmask;
      var trn_smask = u_smask;
      if (u_poke == 1) {
        poke = cu; trn = cv; trn_tmask = v_tmask; trn_smask = v_smask;
      }
      let pt = c_type(poke);
      let poke_bit = select(0u, 1u << u32(pt), pt >= 0 && pt < 10);
      var mismatch = false;
      if (trn_tmask != 0u && (trn_tmask & poke_bit) == 0u) { mismatch = true; }
      if ((trn_smask & 4u) != 0u && c_stage(poke) != 2) { mismatch = true; }
      if ((trn_smask & 2u) != 0u && c_stage(poke) != 1) { mismatch = true; }

      if (mismatch) {
        tag = 3u;
        // Disable incompatible Trainer (trn_kind = 0)
        if (u_poke == 0) { cu.x = cu.x & ~(7u << 29u); }
        else { cv.x = cv.x & ~(7u << 29u); }
      } else if (c_trn_kind(trn) == 5) {
        tag = 2u;
        bonus_boost = 110;
      } else if (trn_tmask != 0u && (trn_tmask & poke_bit) != 0u) {
        tag = 1u;
        bonus_boost = 140;
      } else if ((trn_smask & 4u) != 0u && c_stage(poke) == 2) {
        tag = 2u;
        bonus_boost = 150;
      }
    } else {
      if (u_tmask != 0u && v_tmask != 0u && (u_tmask & v_tmask) == 0u) {
        tag = 3u;
        cu.x = cu.x & ~(7u << 29u);
        cv.x = cv.x & ~(7u << 29u);
      } else if (u_tmask != 0u && (u_tmask & v_tmask) != 0u) {
        tag = 1u;
        bonus_boost = 80;
      }
    }

    if (bonus_boost != 0) {
      let bu = clamp(c_bonus(cu) + bonus_boost, -30000, 30000) + 32768;
      let bv = clamp(c_bonus(cv) + bonus_boost, -30000, 30000) + 32768;
      cu.z = (cu.z & 0xffff0000u) | (u32(bu) & 0xffffu);
      cv.z = (cv.z & 0xffff0000u) | (u32(bv) & 0xffffu);
    }

    let slot_u0 = select(14u, 2u, u_poke == 1);
    let slot_u1 = select(15u, 3u, u_poke == 1);
    wg_player[slot_u0] = cu;
    wg_player[slot_u1] = cu;
    if (u != v) {
      let slot_v0 = select(16u, 4u, v_poke == 1);
      let slot_v1 = select(17u, 5u, v_poke == 1);
      wg_player[slot_v0] = cv;
      wg_player[slot_v1] = cv;
    }
    wg_pair_tag = tag;
  }
  workgroupBarrier();

  // Threads 0..249: lid / 25 -> warp-coherent opponent 0..9 (100 games per Top-10 opponent = 1,000 games/pair!)
  var w0 = 0u;
  var w1 = 0u;
  var w2 = 0u;
  var w3 = 0u;
  var dr = 0u;

  if (lid < 250u) {
    let opp_idx = lid / 25u;
    let first = lid & 1u;
    let g_idx = params.batch_offset + local_pair;
    let base_seed = params.seed_base ^ (g_idx * 2654435761u) ^ (lid * 2246822519u);

    let o0 = simulate_game(base_seed ^ 0x11111111u, first, 0u, opp_idx);
    if (o0 == 1u) { w0 = 1u; } else if (o0 == 2u) { dr = dr + 1u; }

    let o1 = simulate_game(base_seed ^ 0x22222222u, first, 1u, opp_idx);
    if (o1 == 1u) { w1 = 1u; } else if (o1 == 2u) { dr = dr + 1u; }

    let o2 = simulate_game(base_seed ^ 0x33333333u, first, 2u, opp_idx);
    if (o2 == 1u) { w2 = 1u; } else if (o2 == 2u) { dr = dr + 1u; }

    let o3 = simulate_game(base_seed ^ 0x44444444u, first, 3u, opp_idx);
    if (o3 == 1u) { w3 = 1u; } else if (o3 == 2u) { dr = dr + 1u; }
  }

  wg_r0[lid] = w0;
  wg_r1[lid] = w1;
  wg_r2[lid] = w2;
  wg_r3[lid] = w3;
  wg_dr[lid] = dr;
  workgroupBarrier();

  for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
    if (lid < stride) {
      wg_r0[lid] = wg_r0[lid] + wg_r0[lid + stride];
      wg_r1[lid] = wg_r1[lid] + wg_r1[lid + stride];
      wg_r2[lid] = wg_r2[lid] + wg_r2[lid + stride];
      wg_r3[lid] = wg_r3[lid] + wg_r3[lid + stride];
      wg_dr[lid] = wg_dr[lid] + wg_dr[lid + stride];
    }
    workgroupBarrier();
  }

  if (lid == 0u) {
    let packed_wins = (wg_r0[0] & 0xffu)
      | ((wg_r1[0] & 0xffu) << 8u)
      | ((wg_r2[0] & 0xffu) << 16u)
      | ((wg_r3[0] & 0xffu) << 24u);
    let packed_meta = (wg_dr[0] & 0xffffu) | ((wg_pair_tag & 0x3u) << 16u);
    out_results[local_pair * 2u] = packed_wins;
    out_results[local_pair * 2u + 1u] = packed_meta;
  }
}
`;

// ---------------------------------------------------------------------------
// 3. Build flat pair_uv list (3,293,461 pairs) and stream 32,768-pair chunks through RTX 5060
// ---------------------------------------------------------------------------
const targetPairCount = DRY_RUN_PAIRS > 0 ? Math.min(DRY_RUN_PAIRS, totalFuncPairs) : totalFuncPairs;
const allPairUV = new Uint32Array(targetPairCount);
{
  let p = 0;
  for (let u = 0; u < G && p < targetPairCount; u++) {
    for (let v = u; v < G && p < targetPairCount; v++) {
      allPairUV[p++] = ((u & 0xffff) << 16) | (v & 0xffff);
    }
  }
}

const rawResults = new Uint32Array(targetPairCount * 2);
const CHUNK_PAIRS = 65535; // 65,535 pairs x 1,000 games = 65.5M games/dispatch (~51 dispatches total for 3.29B games!)
const totalChunks = Math.ceil(targetPairCount / CHUNK_PAIRS);
let completedChunks = 0;
let gpuInfo = null;
const tRun0 = Date.now();

const clientHtml = `<!doctype html><html><body><script>
const WGSL = ${JSON.stringify(WGSL_PAIRWISE)};
const G = ${G};
const CHUNK_PAIRS = ${CHUNK_PAIRS};
const TOTAL_CHUNKS = ${totalChunks};

async function run() {
  try {
    if (!navigator.gpu) throw Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw Error('No WebGPU adapter');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(268435456, adapter.limits.maxStorageBufferBindingSize),
        maxComputeWorkgroupsPerDimension: Math.min(65535, adapter.limits.maxComputeWorkgroupsPerDimension)
      }
    });
    const info = adapter.info || {};
    await fetch('/gpu-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor: info.vendor || '', arch: info.architecture || '', desc: info.description || '' })
    });

    const [fcBuf, mdBuf, rwBuf, ewBuf] = await Promise.all([
      fetch('/bin/func-cards').then(r => r.arrayBuffer()),
      fetch('/bin/meta-decks').then(r => r.arrayBuffer()),
      fetch('/bin/regime-weights').then(r => r.arrayBuffer()),
      fetch('/bin/enemy-weights').then(r => r.arrayBuffer())
    ]);

    const mkBuf = (ab, usage) => {
      const b = device.createBuffer({ size: Math.max(16, ab.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, ab);
      return b;
    };

    const funcCardsBuf = mkBuf(fcBuf, GPUBufferUsage.STORAGE);
    const metaDecksBuf = mkBuf(mdBuf, GPUBufferUsage.STORAGE);
    const regimeWeightsBuf = mkBuf(rwBuf, GPUBufferUsage.STORAGE);
    const enemyWeightsBuf = mkBuf(ewBuf, GPUBufferUsage.STORAGE);

    const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pairUvBuf = device.createBuffer({ size: CHUNK_PAIRS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outBuf = device.createBuffer({ size: CHUNK_PAIRS * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: CHUNK_PAIRS * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const shader = device.createShaderModule({ code: WGSL });
    const infoLog = await shader.getCompilationInfo();
    const errs = infoLog.messages.filter(m => m.type === 'error');
    if (errs.length) throw Error('WGSL error: ' + errs.map(e => e.lineNum + ':' + e.message).join(' | '));

    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'main' }
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: funcCardsBuf } },
        { binding: 2, resource: { buffer: metaDecksBuf } },
        { binding: 3, resource: { buffer: regimeWeightsBuf } },
        { binding: 4, resource: { buffer: enemyWeightsBuf } },
        { binding: 5, resource: { buffer: pairUvBuf } },
        { binding: 6, resource: { buffer: outBuf } }
      ]
    });

    let pendingPost = Promise.resolve();
    let nextFetch = fetch('/chunk/0').then(async (r) => ({
      count: Number(r.headers.get('X-Pair-Count')),
      offset: Number(r.headers.get('X-Batch-Offset')),
      uvAb: await r.arrayBuffer()
    }));

    for (let chunkIdx = 0; chunkIdx < TOTAL_CHUNKS; chunkIdx++) {
      const { count, offset, uvAb } = await nextFetch;
      if (chunkIdx + 1 < TOTAL_CHUNKS) {
        nextFetch = fetch('/chunk/' + (chunkIdx + 1)).then(async (r) => ({
          count: Number(r.headers.get('X-Pair-Count')),
          offset: Number(r.headers.get('X-Batch-Offset')),
          uvAb: await r.arrayBuffer()
        }));
      }

      device.queue.writeBuffer(pairUvBuf, 0, uvAb);
      device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([count, offset, G, 0x20261124]));

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(count, 1, 1);
      pass.end();
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, count * 8);
      device.queue.submit([enc.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ, 0, count * 8);
      const slice = new Uint8Array(readBuf.getMappedRange(0, count * 8).slice(0));
      readBuf.unmap();

      await pendingPost;
      pendingPost = fetch('/result/' + chunkIdx, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice
      });
    }
    await pendingPost;

    await fetch('/complete', { method: 'POST' });
  } catch (err) {
    await fetch('/error', { method: 'POST', body: String(err?.stack || err) });
  }
}
run();
</script></body></html>`;

let edgeProc = null;
const srv = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(clientHtml);
    return;
  }
  if (req.url === '/bin/func-cards') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(funcCardsU32.buffer));
    return;
  }
  if (req.url === '/bin/meta-decks') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(metaDecksU32.buffer));
    return;
  }
  if (req.url === '/bin/regime-weights') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(regimesI32.buffer));
    return;
  }
  if (req.url === '/bin/enemy-weights') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(enemyWeightsI32.buffer));
    return;
  }
  if (req.url === '/gpu-info') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      gpuInfo = JSON.parse(body || '{}');
      console.log(`[pairwise-10m] GPU locked: vendor=${gpuInfo.vendor} arch=${gpuInfo.arch}`);
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }
  if (req.url.startsWith('/chunk/')) {
    const chunkIdx = Number(req.url.slice('/chunk/'.length));
    const offset = chunkIdx * CHUNK_PAIRS;
    const count = Math.min(CHUNK_PAIRS, targetPairCount - offset);
    const sub = allPairUV.subarray(offset, offset + count);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Pair-Count': String(count),
      'X-Batch-Offset': String(offset)
    });
    res.end(Buffer.from(sub.buffer, sub.byteOffset, sub.byteLength));
    return;
  }
  if (req.url.startsWith('/result/')) {
    const chunkIdx = Number(req.url.slice('/result/'.length));
    const offset = chunkIdx * CHUNK_PAIRS;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      rawResults.set(u32, offset * 2);
      completedChunks++;
      if (completedChunks % 5 === 0 || completedChunks === totalChunks) {
        const donePairs = Math.min(targetPairCount, completedChunks * CHUNK_PAIRS);
        const sec = (Date.now() - tRun0) / 1000;
        const games = donePairs * 1000;
        console.log(`[pairwise-10m] ${completedChunks}/${totalChunks} chunks | ${donePairs.toLocaleString()} pairs | ${(games / 1e6).toFixed(1)}M games | ${sec.toFixed(1)}s (${(games / Math.max(0.1, sec) / 1e6).toFixed(2)}M games/sec)`);
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }
  if (req.url === '/error') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      console.error('[pairwise-10m] GPU ERROR:', body);
      res.writeHead(200);
      res.end('ok');
      srv.close();
      if (edgeProc) edgeProc.kill();
      process.exit(1);
    });
    return;
  }
  if (req.url === '/complete') {
    res.writeHead(200);
    res.end('ok');
    srv.close();
    if (edgeProc) edgeProc.kill();
    finalizeArtifacts();
    return;
  }
  res.writeHead(404);
  res.end();
});

function pairIndex(u, v) {
  return u * G - ((u * (u - 1)) / 2) + (v - u);
}

function finalizeArtifacts() {
  const elapsedSec = (Date.now() - tRun0) / 1000;
  const totalGamesSimulated = targetPairCount * 1000;
  const gamesPerSec = Math.round(totalGamesSimulated / Math.max(0.01, elapsedSec));
  console.log(`[pairwise-10m] GPU simulation DONE: ${targetPairCount.toLocaleString()} functional pairs x 1,000 games = ${totalGamesSimulated.toLocaleString()} games in ${elapsedSec.toFixed(2)}s (${(gamesPerSec / 1e6).toFixed(2)}M games/sec)!`);

  if (DRY_RUN_PAIRS > 0) {
    for (let i = 0; i < 10; i++) {
      const uv = allPairUV[i];
      const u = uv >> 16;
      const v = uv & 0xffff;
      const pw = rawResults[i * 2];
      const pm = rawResults[i * 2 + 1];
      const w0 = pw & 0xff, w1 = (pw >> 8) & 0xff, w2 = (pw >> 16) & 0xff, w3 = (pw >> 24) & 0xff;
      const dr = pm & 0xffff;
      const tag = (pm >> 16) & 0x3;
      const totW = w0 + w1 + w2 + w3;
      console.log(`  sample (${funcCards[u].card.name} + ${funcCards[v].card.name}) -> ${totW}W/${dr}D/1000 (${(totW / 10).toFixed(1)}%) regimes=[${w0},${w1},${w2},${w3}] tag=${tag}`);
    }
    process.exit(0);
  }

  const soloWr = new Float32Array(G);
  for (let u = 0; u < G; u++) {
    const idx = pairIndex(u, u);
    const pw = rawResults[idx * 2];
    const pm = rawResults[idx * 2 + 1];
    const totW = (pw & 0xff) + ((pw >> 8) & 0xff) + ((pw >> 16) & 0xff) + ((pw >> 24) & 0xff);
    const dr = pm & 0xffff;
    soloWr[u] = (totW + 0.5 * dr) / 1000;
  }

  const headerBytes = 32;
  const groupTableBytes = Math.ceil((totalCards * 2) / 4) * 4;
  const matrixBytes = totalFuncPairs * 2;
  const totalBytes = headerBytes + groupTableBytes + matrixBytes;
  const outBin = Buffer.alloc(totalBytes);

  outBin.write('PLP1', 0, 'ascii');
  outBin.writeUInt32LE(1, 4);
  outBin.writeUInt32LE(totalCards, 8);
  outBin.writeUInt32LE(G, 12);
  outBin.writeUInt32LE(totalFuncPairs, 16);
  outBin.writeUInt32LE(totalCardPairs, 20);
  outBin.writeUInt32LE(1000, 24);
  outBin.writeUInt32LE(groupTableBytes, 28);

  for (let i = 0; i < totalCards; i++) {
    outBin.writeUInt16LE(groupOf[i], headerBytes + i * 2);
  }

  const matOff = headerBytes + groupTableBytes;
  const regimeCounts = [0, 0, 0, 0];
  const tagCounts = [0, 0, 0, 0];
  let sumWr = 0;
  let positiveSynergyCount = 0;
  const topCombos = [];

  for (let idx = 0; idx < totalFuncPairs; idx++) {
    const uv = allPairUV[idx];
    const u = uv >> 16;
    const v = uv & 0xffff;
    const pw = rawResults[idx * 2];
    const pm = rawResults[idx * 2 + 1];

    const w0 = pw & 0xff;
    const w1 = (pw >> 8) & 0xff;
    const w2 = (pw >> 16) & 0xff;
    const w3 = (pw >> 24) & 0xff;
    const dr = pm & 0xffff;
    const tag = (pm >> 16) & 0x3;

    const totW = w0 + w1 + w2 + w3;
    const wr = (totW + 0.5 * dr) / 1000;
    const baseExpected = 0.5 * (soloWr[u] + soloWr[v]);
    const synDelta = wr - baseExpected;
    sumWr += wr;
    if (synDelta > 0.01) positiveSynergyCount++;

    let bestR = 0;
    let bestW = w0;
    if (w1 > bestW) { bestW = w1; bestR = 1; }
    if (w2 > bestW) { bestW = w2; bestR = 2; }
    if (w3 > bestW) { bestW = w3; bestR = 3; }

    regimeCounts[bestR]++;
    tagCounts[tag]++;

    const wrByte = Math.max(0, Math.min(250, Math.round(wr * 250)));
    const synNibble = Math.max(0, Math.min(15, Math.round(synDelta * 200) + 8));
    const byte1 = ((synNibble & 0xf) << 4) | ((bestR & 0x3) << 2) | (tag & 0x3);

    outBin[matOff + idx * 2] = wrByte;
    outBin[matOff + idx * 2 + 1] = byte1;

    if (u !== v && tag !== 3 && wr >= 0.45 && synDelta >= 0.02) {
      if (topCombos.length < 400) {
        topCombos.push({ u, v, wr, synDelta, bestR, tag });
      } else {
        const score = wr + synDelta * 1.8;
        let minIdx = 0;
        let minScore = topCombos[0].wr + topCombos[0].synDelta * 1.8;
        for (let k = 1; k < topCombos.length; k++) {
          const sc = topCombos[k].wr + topCombos[k].synDelta * 1.8;
          if (sc < minScore) { minScore = sc; minIdx = k; }
        }
        if (score > minScore) topCombos[minIdx] = { u, v, wr, synDelta, bestR, tag };
      }
    }
  }

  topCombos.sort((a, b) => (b.wr + b.synDelta * 1.8) - (a.wr + a.synDelta * 1.8));
  const top50 = topCombos.slice(0, 50).map((x) => ({
    cardA: funcCards[x.u].card.id,
    nameA: funcCards[x.u].card.name,
    cardB: funcCards[x.v].card.id,
    nameB: funcCards[x.v].card.name,
    winRate: Math.round(x.wr * 1000) / 1000,
    synergyDelta: Math.round(x.synDelta * 1000) / 1000,
    bestRegime: x.bestR,
    archetypeTag: x.tag
  }));

  const sha256 = createHash('sha256').update(outBin).digest('hex');
  const outDir = path.join(ROOT, 'public/battle/strategies');
  const reportDir = path.join(ROOT, 'reports/battle-ml-v5-pairwise-10m');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const binPath = path.join(outDir, 'pairwise-10m.bin');
  writeFileSync(binPath, outBin);

  const metaDoc = {
    version: 'pairwise-10m-v1',
    generatedAt: new Date().toISOString(),
    binaryFile: 'battle/strategies/pairwise-10m.bin',
    binaryBytes: outBin.byteLength,
    binarySha256: sha256,
    totalCards,
    functionalCards: G,
    functionalPairsTested: totalFuncPairs,
    totalPairwiseEntries: totalCardPairs,
    gamesPerPair: 1000,
    totalGamesSimulated,
    gpuHardware: `${gpuInfo?.vendor || 'nvidia'} ${gpuInfo?.arch || 'blackwell'}`.trim(),
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    gamesPerSec,
    meanPairWinRate: Math.round((sumWr / totalFuncPairs) * 10000) / 10000,
    positiveSynergyFuncPairs: positiveSynergyCount,
    regimeLabelsZh: ['快攻搶分流', '控場干擾流', '進化續航流', '狙擊獎賞流'],
    regimeWDeltas: [
      { idx: [2, 9, 11, 14], val: [0.18, 0.20, 0.24, 0.16] },
      { idx: [6, 7, 8, 19], val: [0.18, 0.18, 0.22, 0.20] },
      { idx: [4, 5, 15, 20], val: [0.22, 0.20, 0.16, 0.22] },
      { idx: [11, 12, 19, 21], val: [0.24, 0.16, 0.18, 0.26] }
    ],
    archetypeLabelsZh: ['常規雙卡協同', '同系強聯動組合', '進化與道具核心連攜', '跨系配置風險警示'],
    archetypeRuleTemplates: [
      '「{A}」與「{B}」經 1,000 局雙卡配對實測，以「{R}」表現最佳（實測勝率 {WR}%，協同增益 {SD}），建議在節奏穩定期雙卡齊發擴大場面差。',
      '「{A}」與「{B}」形成同系核心聯動，經 1,000 局實測在「{R}」下勝率達 {WR}%（協同增益 {SD}），優先共享能量與濾牌曲線提前定型。',
      '「{A}」與「{B}」構成關鍵進化／道具連攜軸，經 1,000 局實測於「{R}」達 {WR}% 勝率（協同增益 {SD}），務必保留關鍵手牌與保底資源確保連攜落地。',
      '「{A}」與「{B}」存在跨系或發動條件衝突風險（1,000 局實測勝率 {WR}%，協同 {SD}），實戰應避免同時強行站場並優先替換為高相容組件。'
    ],
    cardIds,
    topDiscoveredCombos: top50
  };

  writeFileSync(path.join(outDir, 'pairwise-10m.json'), JSON.stringify(metaDoc));
  writeFileSync(path.join(reportDir, 'telemetry.json'), JSON.stringify({
    ...metaDoc,
    cardIds: undefined,
    regimeDistribution: regimeCounts,
    archetypeDistribution: tagCounts
  }, null, 2));

  console.log(`[pairwise-10m] Wrote ${binPath} (${(outBin.byteLength / 1024 / 1024).toFixed(2)} MB, sha256=${sha256.slice(0, 12)}...)`);
  console.log(`[pairwise-10m] Total pairwise strategy entries: ${totalCardPairs.toLocaleString()} (10.47M!)`);
  console.log(`[pairwise-10m] Top 5 discovered combos:`);
  for (const c of top50.slice(0, 5)) {
    console.log(`  - ${c.nameA} (${c.cardA}) + ${c.nameB} (${c.cardB}): WR=${(c.winRate * 100).toFixed(1)}% delta=+${(c.synergyDelta * 100).toFixed(1)}% [${metaDoc.regimeLabelsZh[c.bestRegime]}]`);
  }
  process.exit(0);
}

srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  console.log(`[pairwise-10m] Launching NVIDIA Blackwell WebGPU runner on port ${port} (${targetPairCount.toLocaleString()} pairs x 1,000 games = ${(targetPairCount * 1000).toLocaleString()} games)...`);
  edgeProc = spawn(EDGE_PATH, [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${port}/`
  ], { stdio: 'ignore' });
});
