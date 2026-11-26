#!/usr/bin/env node
// Exact-Mechanics v3 Deterministic Card Compiler for Pocket Lab.
// Compiles ALL 4,577 cards directly from canonical English database.json (+ 3 SP1 Mews)
// into public/data/card-mechanics.json with STRICT 100% coverage assertions:
//   - 0 uncompiled attacks (589 / 589 unique attack effects)
//   - 0 dropped secondary effects on compound attacks (dual op1/val1 + op2/val2 + flags)
//   - 0 uncompiled abilities (164 / 164 unique abilities)
//   - 0 uncompiled trainers/tools/stadiums/fossils (177 / 177 unique trainers)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CARDS_PATH = path.join(ROOT, 'public/data/cards.json');
const DB_PATH = path.join(ROOT, 'tmp/battle-build/source/database.json');
const OUT_PATH = path.join(ROOT, 'public/data/card-mechanics.json');

const TYPE_CODE = {
  grass: 0, g: 0,
  fire: 1, r: 1,
  water: 2, w: 2,
  lightning: 3, l: 3,
  psychic: 4, p: 4,
  fighting: 5, f: 5,
  darkness: 6, d: 6,
  metal: 7, m: 7,
  dragon: 8, n: 8,
  colorless: 9, c: 9
};

// Attack flags (16-bit, packed into bits 8..23 of a_cost_flags)
export const AF = {
  IGNORE_WEAKNESS: 1 << 0,
  IGNORE_EFFECTS: 1 << 1,
  NEED_SWITCHED_IN: 1 << 2,
  DISCARD_HAND_1: 1 << 3,
  DISCARD_HAND_2: 1 << 4,
  REQUIRE_HP_OVER_60: 1 << 5,
  REQUIRE_LAKE_TRIO: 1 << 6,
  COST_1_IF_DAMAGED: 1 << 7,
  COST_1_IF_DECK_EMPTY: 1 << 8,
  FLIP_2_BOTH_TAILS_FAIL: 1 << 9,
  FLIP_3_ALL_TAILS_FAIL: 1 << 10,
  FIRST_ATTACK_ONLY_EFF: 1 << 11,
  ONLY_IF_KO_RECOIL: 1 << 12,
  ONLY_IF_STADIUM_EFF: 1 << 13,
  ONLY_IF_KO_LAST_TURN_EFF: 1 << 14,
  ONLY_IF_EVOLVED_THIS_TURN_EFF: 1 << 15
};

// Status mask constants for attack op=1
const SM_POISON = 1;
const SM_TOXIC20 = 2;
const SM_BURN = 4;
const SM_SLEEP = 8;
const SM_PARALYZE = 16;
const SM_CONFUSE = 32;
const SM_TOXIC40 = 64;
const SM_DEEP_SLEEP = 128;

export function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
}

export function nameHash16(nameEn) {
  const k = normKey(nameEn);
  if (!k) return 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 65534) + 1;
}

function packHashes(names = []) {
  const hs = names.map((n) => nameHash16(n));
  const h1 = ((hs[0] || 0) & 0xffff) | (((hs[1] || 0) & 0xffff) << 16);
  const h2 = ((hs[2] || 0) & 0xffff) | (((hs[3] || 0) & 0xffff) << 16);
  return [h1 | 0, h2 | 0];
}

function parseEnergyTypeLetter(letter) {
  if (!letter) return 255;
  const k = String(letter).replace(/[\[\]]/g, '').trim().toLowerCase();
  return TYPE_CODE[k] ?? 255;
}

const ULTRA_BEAST_NAMES = new Set([
  'nihilego', 'buzzwole', 'pheromosa', 'xurkitree', 'celesteela',
  'kartana', 'guzzlord', 'poipole', 'naganadel', 'stakataka', 'blacephalon',
  'necrozma', 'dawn wings necrozma', 'dusk mane necrozma', 'ultra necrozma'
]);
const ANCIENT_NAMES = new Set([
  'great tusk', 'scream tail', 'brute bonnet', 'flutter mane',
  'slither wing', 'sandy shocks', 'roaring moon', 'walking wake',
  'gouging fire', 'raging bolt', 'koraidon'
]);
const FUTURE_NAMES = new Set([
  'iron treads', 'iron bundle', 'iron hands', 'iron jugulis',
  'iron moth', 'iron thorns', 'iron valiant', 'iron leaves',
  'iron boulder', 'iron crown', 'miraidon'
]);

function baseStripEx(nameEn) {
  return normKey(nameEn).replace(/\s+ex$/, '').trim();
}

// =========================================================================
// 1. ATTACK COMPILER (589 / 589 unique English effects -> op1/val1 + op2/val2 + flags)
// =========================================================================
function compileAttack(enRaw, fixedDamage, costLen, title = '') {
  const eff = String(enRaw || '').replace(/\u00a0/g, ' ').trim();
  const cost = Math.max(0, Math.min(6, Number(costLen || 0)));
  let dmg = Number(fixedDamage || 0);
  if (!eff) {
    return { cost, flags: 0, dmg, op1: 0, val1: 0, op2: 0, val2: 0, aux: 0 };
  }

  let flags = 0;
  let op1 = 0, val1 = 0;
  let op2 = 0, val2 = 0;
  let aux = 0;

  const pushOp = (op, val) => {
    if (op === 0) return;
    if (op1 === 0) { op1 = op; val1 = val; }
    else if (op2 === 0) { op2 = op; val2 = val; }
    else {
      throw Error(`Attack has >2 opcodes: (${op1}:${val1}, ${op2}:${val2}, new ${op}:${val}) for "${eff}"`);
    }
  };

  // --- A. Attack Flags (modifiers orthogonal to op1/op2) ---
  if (/isn't affected by Weakness or by any effects/i.test(eff)) {
    flags |= AF.IGNORE_WEAKNESS | AF.IGNORE_EFFECTS;
  } else {
    if (/isn't affected by Weakness/i.test(eff)) flags |= AF.IGNORE_WEAKNESS;
    if (/isn't affected by any effects on your opponent's Active/i.test(eff)) flags |= AF.IGNORE_EFFECTS;
  }
  if (/If this Pokémon didn't move from the Bench to the Active Spot this turn, this attack does nothing/i.test(eff)) {
    flags |= AF.NEED_SWITCHED_IN;
  }
  if (/Discard 2 cards from your hand\. If you can't discard 2 cards, this attack does nothing/i.test(eff)) {
    flags |= AF.DISCARD_HAND_2;
  } else if (/Discard a card from your hand\. If you can't, this attack does nothing/i.test(eff)) {
    flags |= AF.DISCARD_HAND_1;
  }
  if (/If this Pokémon's remaining HP is 60 or less, this attack does nothing/i.test(eff)) {
    flags |= AF.REQUIRE_HP_OVER_60;
  }
  if (/You can use this attack only if you have Uxie and Azelf on your Bench/i.test(eff)) {
    flags |= AF.REQUIRE_LAKE_TRIO;
  }
  if (/If this Pokémon has damage on it, this attack can be used for 1 \[L\] Energy/i.test(eff)) {
    flags |= AF.COST_1_IF_DAMAGED;
  }
  if (/If you have no cards in your deck, this attack can be used for 1 \[W\] Energy/i.test(eff)) {
    flags |= AF.COST_1_IF_DECK_EMPTY;
  }
  if (/Flip 2 coins\. If both of them are tails, this attack does nothing/i.test(eff)) {
    flags |= AF.FLIP_2_BOTH_TAILS_FAIL;
  }
  if (/If both of them are tails, this attack does nothing/i.test(eff) && /Flip 2 coins/i.test(eff)) {
    flags |= AF.FLIP_2_BOTH_TAILS_FAIL;
  }
  if (/If all of them are tails, this attack does nothing/i.test(eff) && /Flip 3 coins/i.test(eff)) {
    flags |= AF.FLIP_3_ALL_TAILS_FAIL;
  }

  // Pure flag-only attacks (done!)
  if (/^This attack's damage isn't affected by/i.test(eff)
    || /^If this Pokémon didn't move from the Bench/i.test(eff)
    || /^Discard (?:a|2) cards? from your hand\. If you can't/i.test(eff)
    || /^If this Pokémon's remaining HP is 60 or less, this attack does nothing/i.test(eff)
    || /^If this Pokémon has damage on it, this attack can be used for 1/i.test(eff)
    || /^If you have no cards in your deck, this attack can be used for 1/i.test(eff)
    || /^Flip 2 coins\. If both of them are tails, this attack does nothing\.$/i.test(eff)) {
    return { cost, flags, dmg, op1, val1, op2, val2, aux };
  }

  // --- B. Special Direct / Copy / Double-Attack / Delayed / Mixed Coin Specials ---
  let m;
  if (/This attack is used twice in a row\. The second attack does (\d+) damage/i.test(eff)) {
    const d2 = Number(eff.match(/second attack does (\d+)/i)[1]);
    pushOp(19, 8 | (d2 << 8));
    return { cost, flags, dmg, op1, val1, op2, val2, aux };
  }
  if (/Choose 1 of your opponent's Active Pokémon's attacks and use it as this attack/i.test(eff)) {
    const flip = /Flip a coin\. If heads/i.test(eff) ? 1 : 0;
    pushOp(20, 6 | (flip << 8));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Choose 1 of your opponent's Pokémon's attacks and use it as this attack/i.test(eff)) {
    pushOp(20, 6 | (2 << 8));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Choose 1 of your Benched Pokémon's attacks, except any Pokémon ex, and use it as this attack/i.test(eff)) {
    pushOp(20, 6 | (3 << 8));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/1 attack from among the Pokémon in your opponent's hand and deck is chosen at random/i.test(eff)) {
    pushOp(20, 6 | (4 << 8));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Flip a coin\. If heads, this attack does 70 damage to your opponent's Active Pokémon\. If tails, heal 30 damage from your opponent's Active/i.test(eff)) {
    pushOp(3, 4);
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if ((m = eff.match(/Flip a coin\. If heads, this attack does (\d+) more damage\. If tails, this Pokémon also does (\d+) damage to itself/i))) {
    pushOp(3, 3 | (Number(m[1]) << 8) | (Number(m[2]) << 16));
    return { cost, flags, dmg, op1, val1, op2, val2, aux };
  }
  if (/Halve your opponent's Active Pokémon's remaining HP/i.test(eff)) {
    pushOp(20, 4);
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Flip a coin\. If heads, your opponent's Active Pokémon's remaining HP is now 10/i.test(eff)) {
    pushOp(20, 5);
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Flip 2 coins\. If both of them are heads, your opponent's Active Pokémon is Knocked Out/i.test(eff)) {
    pushOp(20, 3);
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Flip 2 coins\. If both of them are heads, discard your opponent's Active Pokémon/i.test(eff)) {
    pushOp(20, 2 | (2 << 8));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Flip a coin\. If heads, discard your opponent's Active Pokémon/i.test(eff)) {
    pushOp(20, 2 | (1 << 8));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/Knock Out your opponent's Active Pokémon\./i.test(eff)) {
    pushOp(20, 1);
    if (/Discard all Energy from this Pokémon/i.test(eff)) pushOp(10, 99);
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if (/At the end of your opponent's next turn, Knock Out the Pokémon in the spot you chose/i.test(eff)) {
    pushOp(8, 12 | (0 << 8) | (1 << 16)); // delayed KO
    if (/Discard all Energy from this Pokémon/i.test(eff)) pushOp(10, 99);
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }
  if ((m = eff.match(/At the end of your opponent's next turn, do (\d+) damage to (?:the Pokémon in the spot you chose|the Defending Pokémon)/i))) {
    const anySpot = /spot you chose/i.test(eff) ? 2 : 0;
    pushOp(8, 12 | (Number(m[1]) << 8) | (anySpot << 16));
    return { cost, flags, dmg: 0, op1, val1, op2, val2, aux };
  }

  // --- C. Primary Damage / Targeting / Scaling Clauses ---

  // C1. Random spread / Bench snipe / Multi-target attacks
  if ((m = eff.match(/1 of your opponent's Pokémon is chosen at random for each \[M\] Energy attached to this Pokémon\. For each time a Pokémon was chosen, do (\d+) damage/i))) {
    pushOp(8, 8 | (Number(m[1]) << 8) | (99 << 16));
    dmg = 0;
  } else if ((m = eff.match(/1 other Pokémon \(either yours or your opponent's\) is chosen at random (\d+) times?\. (?:For each time a Pokémon was chosen, )?[Dd]o (\d+) damage/i))) {
    pushOp(8, 10 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
    dmg = 0;
  } else if ((m = eff.match(/1 of your opponent's Benched Pokémon is chosen at random (\d+) times\. For each time a Pokémon was chosen, also do (\d+) damage/i))) {
    pushOp(8, 9 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/1 of your opponent's Benched Pokémon is chosen at random\. This attack also does (\d+) damage/i))) {
    pushOp(8, 9 | (Number(m[1]) << 8) | (1 << 16));
  } else if ((m = eff.match(/1 of your opponent's Pokémon is chosen at random (\d+) times\. For each time a Pokémon was chosen, do (\d+) damage/i))) {
    pushOp(8, 8 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
    dmg = 0;
  } else if ((m = eff.match(/1 of your opponent's Pokémon is chosen at random\. Do (\d+) damage/i))) {
    pushOp(8, 8 | (Number(m[1]) << 8) | (1 << 16));
    dmg = 0;
  } else if ((m = eff.match(/Flip 3 coins\. This attack also does (\d+) damage for each heads to each of your opponent's Benched Pokémon/i))) {
    pushOp(5, 3 | (Number(m[1]) << 8) | (3 << 16));
  } else if ((m = eff.match(/If this Pokémon has at least (\d+) extra \[[A-Z]\] Energy attached, this attack also does (\d+) damage to (\d+) of your opponent's Benched/i))) {
    const mode = Number(m[3]) >= 2 ? 7 : 13; // 7=2 bench conditional, 13=1 bench conditional
    pushOp(8, mode | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/this attack does (\d+) damage to 2 of your opponent's Pokémon/i))) {
    pushOp(8, 14 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) damage to 1 of your opponent's Pokémon for each Energy attached to that Pokémon/i))) {
    pushOp(8, 11 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) damage to 1 of your opponent's Pokémon that have damage on them/i))) {
    pushOp(8, 4 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack also does (\d+) damage to 1 of your opponent's Benched Pokémon that has damage on it/i))) {
    pushOp(8, 5 | (Number(m[1]) << 8) | (1 << 16));
  } else if ((m = eff.match(/This attack also does (\d+) damage to each of your opponent's Benched Pokémon that has damage on it/i))) {
    pushOp(8, 5 | (Number(m[1]) << 8) | (0 << 16));
  } else if ((m = eff.match(/This attack also does (\d+) damage to each of your opponent's Benched Pokémon that has any Energy attached/i))) {
    pushOp(8, 5 | (Number(m[1]) << 8) | (2 << 16));
  } else if ((m = eff.match(/this attack does (\d+) damage to each of your opponent's Pokémon/i))) {
    pushOp(8, 6 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) damage to 1 of your opponent's Benched Pokémon/i))) {
    pushOp(8, 3 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) damage to 1 of your opponent's Pokémon\./i))) {
    pushOp(8, 2 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/If (Plusle|Electivire) is on your Bench, this attack also does (\d+) damage to each of your opponent's Benched/i))) {
    pushOp(8, 1 | (Number(m[2]) << 8) | (1 << 16));
    aux = nameHash16(m[1]);
  } else if ((m = eff.match(/also does (\d+) damage to each of your opponent's Benched/i))) {
    pushOp(8, 1 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/Flip a coin\. If heads, this attack also does (\d+) damage to 1 of your opponent's Benched/i))) {
    pushOp(8, 0 | (Number(m[1]) << 8) | (1 << 16));
  } else if ((m = eff.match(/also does (\d+) damage to 1 of your opponent's Benched/i))) {
    pushOp(8, 0 | (Number(m[1]) << 8));
  }

  // C2. Coin-flip multiply & coin-flip additive damage
  if ((m = eff.match(/Flip 3 coins\. For each heads, discard a \[R\] Energy from this Pokémon\. This attack does (\d+) more damage for each \[R\] Energy you discarded/i))) {
    pushOp(4, 3 | (Number(m[1]) << 8) | (32 << 16)); // mode bit 5 = Camerupt discard+add
  } else if ((m = eff.match(/Flip a coin for each (?:\[[A-Z]\] )?Energy attached to this Pokémon\. This attack does (\d+) more damage for each heads/i))) {
    pushOp(5, 0 | (Number(m[1]) << 8) | (2 << 16)); // Emboar: base + per * heads(own_energy)
  } else if ((m = eff.match(/Flip a coin for each (?:\[[A-Z]\] )?Energy attached to this Pokémon\. This attack does (\d+) damage for each heads/i))) {
    pushOp(4, 0 | (Number(m[1]) << 8) | (8 << 16)); // Celebi ex / Gholdengo / Mega Mewtwo Y ex
    dmg = 0;
  } else if ((m = eff.match(/Flip a coin for each Pokémon you have in play\. This attack does (\d+) damage for each heads/i))) {
    pushOp(4, 0 | (Number(m[1]) << 8) | (2 << 16));
    dmg = 0;
  } else if ((m = eff.match(/Flip a coin for each Tandemaus and Maushold you have in play\. This attack does (\d+) damage for each heads/i))) {
    pushOp(4, 0 | (Number(m[1]) << 8) | (4 << 16));
    dmg = 0;
  } else if (/Flip 3 coins\. If 1 of them is heads, this attack does 20 more damage\. If 2 of them are heads, this attack does 50 more damage\. If all of them are heads, this attack does 120 more damage/i.test(eff)) {
    pushOp(5, 97); // Iron Moth exact curve
  } else if ((m = eff.match(/Flip a coin until you get tails\. This attack does (\d+) more damage for each heads/i))) {
    pushOp(5, 99 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/Flip a coin until you get tails\. This attack does (\d+) damage for each heads/i))) {
    pushOp(4, 99 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/Flip (\d+) coins\. If both of them are heads, this attack does (\d+) more damage/i))) {
    pushOp(5, 98 | (Number(m[2]) << 8) | (1 << 16));
  } else if ((m = eff.match(/Flip (\d+) coins\. This attack does (\d+) more damage for each heads/i))) {
    pushOp(5, Number(m[1]) | (Number(m[2]) << 8));
  } else if ((m = eff.match(/Flip a coin\. If heads, this attack does (\d+) more damage/i))) {
    pushOp(5, 1 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/Flip (\d+) coins\. This attack does (\d+) damage for each heads/i))) {
    let cFlags = 0;
    if (/Lucky Mittens/i.test(eff)) cFlags |= 1;
    if (/Rabbit Jumping/i.test(title)) cFlags |= 16;
    pushOp(4, Number(m[1]) | (Number(m[2]) << 8) | (cFlags << 16));
    dmg = 0;
  }

  // C3. Count-based scaling (op=6)
  if ((m = eff.match(/Discard all \[R\] and \[L\] Energy from this Pokémon, and this attack does (\d+) damage for each Energy you discarded/i))) {
    pushOp(6, 26 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/Discard up to 2 Pokémon Tool cards from your hand\. This attack does (\d+) damage for each card you discarded/i))) {
    pushOp(6, 27 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/You may discard any number of your Benched \[W\] Pokémon\. This attack does (\d+) more damage for each Benched Pokémon you discarded/i))) {
    pushOp(6, 28 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/Reveal all of the Sweet Honey in your hand, and this attack does (\d+) damage for each card you revealed/i))) {
    pushOp(6, 29 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/Reveal the top (\d+) cards of your deck\. This attack does (\d+) damage for each Pokémon (?:with a Retreat Cost of 3 or more|you find there that has “Team Rocket” in its name)/i))) {
    const filt = /Team Rocket/i.test(eff) ? 1 : 0;
    pushOp(6, 30 | (Number(m[2]) << 8) | ((Number(m[1]) | (filt << 4)) << 16));
    if (!/more damage/i.test(eff)) dmg = 0;
  } else if (/This attack does more damage equal to the damage this Pokémon has on it/i.test(eff)) {
    pushOp(6, 31 | (1 << 8));
  } else if (/This attack does damage to your opponent's Active Pokémon equal to the damage this Pokémon has on it/i.test(eff)) {
    pushOp(6, 31 | (1 << 8));
    dmg = 0;
  } else if (/This attack does damage to your opponent's Active Pokémon equal to this Pokémon's remaining HP/i.test(eff)) {
    pushOp(6, 32 | (1 << 8));
    dmg = 0;
  } else if (/This attack's damage is reduced by the amount of damage this Pokémon has on it/i.test(eff)) {
    pushOp(6, 33 | (1 << 8));
  } else if ((m = eff.match(/Reveal all of your Pokémon in play and in your hand that have the Puppy Pile attack, and this attack does (\d+) damage for each/i))) {
    pushOp(6, 23 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) damage for each time your Pokémon used Sweets Relay during this game/i))) {
    pushOp(6, 22 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) more damage for each of your Benched (Nidoking|Wishiwashi)/i))) {
    const extra = m[2] === 'Wishiwashi' ? 1 : 0; // 1 = Wishiwashi or Wishiwashi ex
    pushOp(6, 24 | (Number(m[1]) << 8) | (extra << 16));
    aux = nameHash16(m[2]);
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each of your Benched \[([A-Z])\] Pokémon/i))) {
    pushOp(6, 3 | (Number(m[1]) << 8) | (parseEnergyTypeLetter(m[3]) << 16));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) more damage for each Evolution Pokémon on your Bench/i))) {
    pushOp(6, 4 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each Benched Pokémon \(both yours and your opponent's\)/i))) {
    pushOp(6, 2 | (Number(m[1]) << 8));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each of your opponent's Benched Pokémon/i))) {
    pushOp(6, 1 | (Number(m[1]) << 8));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each of your Benched Pokémon/i))) {
    pushOp(6, 0 | (Number(m[1]) << 8));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) more damage for each \[([A-Z])\] Energy attached to all of your Pokémon/i))) {
    pushOp(6, 6 | (Number(m[1]) << 8) | (parseEnergyTypeLetter(m[2]) << 16));
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each (?:\[([A-Z])\] )?Energy attached to this Pokémon/i))) {
    pushOp(6, 5 | (Number(m[1]) << 8));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each Energy attached to all of your opponent's Pokémon/i))) {
    pushOp(6, 8 | (Number(m[1]) << 8));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) (more )?damage for each Energy attached to your opponent's Active Pokémon/i))) {
    pushOp(6, 7 | (Number(m[1]) << 8));
    if (!m[2]) dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) more damage for each Energy in your opponent's Active Pokémon's Retreat Cost/i))) {
    pushOp(6, 9 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each point you have gotten/i))) {
    pushOp(6, 10 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each point your opponent has gotten/i))) {
    pushOp(6, 11 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each time your Pokémon have been Knocked Out during this game/i))) {
    pushOp(6, 12 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each point your opponent got during their last turn/i))) {
    pushOp(6, 13 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) damage for each Pokémon Tool attached to all of your Pokémon/i))) {
    pushOp(6, 14 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) damage for each card in your hand/i))) {
    pushOp(6, 15 | (Number(m[1]) << 8));
    dmg = 0;
  } else if ((m = eff.match(/This attack does (\d+) more damage for each (?:\[([A-Z])\] )?Pokémon in your discard pile/i))) {
    const tf = m[2] ? parseEnergyTypeLetter(m[2]) : 255;
    pushOp(6, 16 | (Number(m[1]) << 8) | (tf << 16));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each Item card in your discard pile/i))) {
    pushOp(6, 17 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each Supporter card in your discard pile/i))) {
    pushOp(6, 18 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each Trainer card in your opponent's deck/i))) {
    pushOp(6, 19 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each of your opponent's Pokémon in play that has an Ability/i))) {
    pushOp(6, 20 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each Special Condition affecting your opponent's Active/i))) {
    pushOp(6, 21 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/This attack does (\d+) more damage for each type of Energy attached to this Pokémon/i))) {
    pushOp(6, 25 | (Number(m[1]) << 8));
  }

  // C4. Conditional bonus/penalty damage (op=7)
  if ((m = eff.match(/If this Pokémon has at least (\d+) extra \[[A-Z]\] Energy attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 0 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/If your opponent's Active Pokémon has damage on it, this attack does (\d+) more damage/i))) {
    pushOp(7, 1 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon has damage on it, this attack does -(\d+) damage/i))) {
    pushOp(7, 3 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon has damage on it, this attack does (\d+) more damage/i))) {
    pushOp(7, 2 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon has no damage on it, this attack does (\d+) more damage/i))) {
    pushOp(7, 4 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon's remaining HP is (\d+) or less, this attack does (\d+) more damage/i))) {
    pushOp(7, 5 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/If any of your Benched Pokémon have damage on them, this attack does (\d+) more damage/i))) {
    pushOp(7, 6 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is affected by a Special Condition, this attack does (\d+) more damage/i))) {
    pushOp(7, 7 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is Poisoned, this attack does (\d+) more damage/i))) {
    pushOp(7, 8 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is Burned, this attack does (\d+) more damage/i))) {
    pushOp(7, 9 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is Asleep, this attack does (\d+) more damage/i))) {
    pushOp(7, 10 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is Confused, this attack does (\d+) more damage/i))) {
    pushOp(7, 11 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is a Pokémon ex, this attack does (\d+) more damage/i))) {
    pushOp(7, 12 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is a Basic Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 13 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is an Evolution Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 14 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon has an Ability, this attack does (\d+) more damage/i))) {
    pushOp(7, 15 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon has a Pokémon Tool attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 16 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon has a Pokémon Tool attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 17 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If any of your (?:\[([A-Z])\] )?Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does (\d+) more damage/i))) {
    pushOp(7, 18 | (Number(m[2]) << 8));
    if (/is now Paralyzed/i.test(eff)) flags |= AF.ONLY_IF_KO_LAST_TURN_EFF;
  } else if ((m = eff.match(/If you played a Supporter card from your hand during this turn, this attack does (\d+) more damage/i))) {
    pushOp(7, 19 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon has more remaining HP than this Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 20 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If your opponent's Active Pokémon has less remaining HP than this Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 21 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon moved from your Bench to the Active Spot this turn, this attack does (\d+) more damage/i))) {
    pushOp(7, 22 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon evolved(?: from [A-Za-z]+)? during this turn, this attack does (\d+) more damage/i))) {
    pushOp(7, 23 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this is the first time this Pokémon has used an attack after coming into play, this attack does (\d+) more damage/i))) {
    pushOp(7, 24 | (Number(m[1]) << 8));
    flags |= AF.FIRST_ATTACK_ONLY_EFF;
  } else if ((m = eff.match(/If a Stadium is in play, this attack does (\d+) more damage/i))) {
    pushOp(7, 25 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If the amount of Energy attached to both Active Pokémon is (\d+) or more, this attack does (\d+) more damage/i))) {
    pushOp(7, 26 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/If you have (\d+) or more \[[A-Z]\] Energy in play, this attack does (\d+) more damage/i))) {
    pushOp(7, 27 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/If this Pokémon has more Energy attached than your opponent's Active Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 28 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon and your opponent's Active Pokémon have the same amount of Energy attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 29 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon and your opponent's Active Pokémon have 1 or more of the same type of Energy attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 30 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If you have exactly 1, 3, or 5 cards in your hand, this attack does (\d+) more damage/i))) {
    pushOp(7, 31 | (Number(m[1]) << 8) | (0 << 16));
  } else if ((m = eff.match(/If you have exactly 2, 4, or 6 cards in your hand, this attack does (\d+) more damage/i))) {
    pushOp(7, 31 | (Number(m[1]) << 8) | (1 << 16));
  } else if ((m = eff.match(/If your opponent has exactly 2, 4, or 6 cards in their hand, this attack does (\d+) more damage/i))) {
    pushOp(7, 31 | (Number(m[1]) << 8) | (2 << 16));
  } else if ((m = eff.match(/If you have the same number of cards in your hand as your opponent, this attack does (\d+) more damage/i))) {
    pushOp(7, 31 | (Number(m[1]) << 8) | (3 << 16));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is a \[([A-Z])\] or \[([A-Z])\] Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 32 | (Number(m[3]) << 8) | ((parseEnergyTypeLetter(m[1]) | (parseEnergyTypeLetter(m[2]) << 4)) << 16));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is a \[([A-Z])\] Pokémon, this attack does (\d+) more damage/i))) {
    pushOp(7, 32 | (Number(m[2]) << 8) | ((parseEnergyTypeLetter(m[1]) | (15 << 4)) << 16));
  } else if ((m = eff.match(/If your opponent has any \[([A-Z])\] Pokémon in play, this attack does (\d+) more damage/i))) {
    pushOp(7, 32 | (Number(m[2]) << 8) | ((parseEnergyTypeLetter(m[1]) | (14 << 4)) << 16));
  } else if ((m = eff.match(/If (Latios|Durant|Passimian|Magmortar) is on your Bench, this attack does (\d+) more damage/i))) {
    pushOp(7, 33 | (Number(m[2]) << 8) | (0 << 16));
    aux = nameHash16(m[1]);
  } else if ((m = eff.match(/If you have any Stage 2 Pokémon on your Bench, this attack does (\d+) more damage/i))) {
    pushOp(7, 33 | (Number(m[1]) << 8) | (1 << 16));
  } else if ((m = eff.match(/If your opponent's Active Pokémon is Zangoose, this attack does (\d+) more damage/i))) {
    pushOp(7, 33 | (Number(m[1]) << 8) | (2 << 16));
    aux = nameHash16('Zangoose');
  } else if ((m = eff.match(/If your opponent's Active Pokémon has “Team Rocket” in its name, this attack does (\d+) more damage/i))) {
    pushOp(7, 33 | (Number(m[1]) << 8) | (3 << 16));
  } else if ((m = eff.match(/If you have fewer Pokémon in play than your opponent, this attack does (\d+) more damage/i))) {
    pushOp(7, 33 | (Number(m[1]) << 8) | (4 << 16));
  } else if ((m = eff.match(/If 1 of your Pokémon used Sweets Relay during your last turn, this attack does (\d+) more damage/i))) {
    pushOp(7, 34 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If you haven't gotten any points, this attack does (\d+) more damage/i))) {
    pushOp(7, 35 | (Number(m[1]) << 8) | (0 << 16));
  } else if ((m = eff.match(/If your opponent has gotten exactly 1 points?, this attack does (\d+) more damage/i))) {
    pushOp(7, 35 | (Number(m[1]) << 8) | (1 << 16));
  } else if ((m = eff.match(/You may discard 1 of your Benched Basic \[G\] Pokémon\. If you do, this attack does (\d+) more damage/i))) {
    pushOp(7, 36 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/If this Pokémon was damaged by an attack during your opponent's last turn while it was in the Active Spot, this attack does (\d+) more damage/i))) {
    pushOp(7, 37 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/Discard the top card of your deck(?:, and)?\.? [Ii]f that card is an? (Item|\[F\] Pokémon), this attack does (\d+) more damage/i))) {
    pushOp(7, 38 | (Number(m[2]) << 8) | ((/Item/i.test(m[1]) ? 0 : 1) << 16));
  } else if ((m = eff.match(/If (Quick-Grow Extract|Volbeat) is in your discard pile, this attack does (\d+) more damage/i))) {
    pushOp(7, 39 | (Number(m[2]) << 8) | ((m[1] === 'Volbeat' ? 1 : 0) << 16));
    aux = nameHash16(m[1]);
  } else if ((m = eff.match(/If (?:this Pokémon has|your Pokémon in play have) (\d+) or more different types of Energy attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 40 | (Number(m[2]) << 8) | (Number(m[1]) << 16));
  } else if ((m = eff.match(/If this Pokémon has any \[([A-Z])\] Energy attached, this attack does (\d+) more damage/i))) {
    pushOp(7, 40 | (Number(m[2]) << 8) | ((10 + parseEnergyTypeLetter(m[1])) << 16));
  }

  // --- D. Flip-to-Hit & Defensive Invuln (Fly / Protect / Dig / Chansey) ---
  if (/Flip a coin\. If tails, this attack does nothing\. If heads, during your opponent's next turn, prevent all damage/i.test(eff)) {
    pushOp(14, 0 | (8 << 8));
  } else if (/Flip a coin\. If tails, this attack does nothing\./i.test(eff)) {
    pushOp(3, 1);
  } else if (/Flip a coin\. If heads, during your opponent's next turn, prevent all damage/i.test(eff)) {
    pushOp(14, 0 | (7 << 8));
  }

  // --- E. Secondary & Post-Attack Effects (ALL checked independently so compound attacks keep BOTH!) ---

  // E1. Discard Own Energy (op=10)
  if (!/for each Energy you discarded|for each \[R\] Energy you discarded/i.test(eff)) {
    if (/Discard a \[R\], \[W\], and \[L\] Energy from this Pokémon/i.test(eff)) {
      pushOp(10, 3);
    } else if (/Discard a \[W\] and a \[L\] Energy from this Pokémon/i.test(eff)) {
      pushOp(10, 2);
    } else if (/Discard all (?:(?:\[[A-Z]\] )?Energy (?:from|attached to) this Pokémon)/i.test(eff)) {
      pushOp(10, 99);
    } else if (/Flip a coin\. If tails, discard (\d+) random Energy from this Pokémon/i.test(eff)) {
      const n = Number(eff.match(/discard (\d+) random Energy from this/i)[1]);
      pushOp(10, n | (1 << 8));
    } else if ((m = eff.match(/Discard (?:(?:Fire|Grass|Water)\s*)?(\d+|a|an)?\s*(?:random )?(?:\[[A-Z]\] )?Energy from this Pokémon/i))) {
      const n = (!m[1] || m[1] === 'a' || m[1] === 'an') ? 1 : Number(m[1]);
      pushOp(10, Math.max(1, n));
    } else if (/Discard 2 random Energy from among the Energy attached to all Pokémon \(both/i.test(eff)) {
      pushOp(10, 2 | (3 << 8));
    } else if (/Discard a random Energy from among the Energy attached to all Pokémon \(both/i.test(eff)) {
      pushOp(10, 1 | (2 << 8));
    } else if (/Discard 2 random Energy from among the Energy attached to all of your Pokémon/i.test(eff)) {
      pushOp(10, 2 | (4 << 8));
    } else if (/Discard a random Energy from both Active Pokémon/i.test(eff)) {
      pushOp(10, 1 | (5 << 8));
    }
  }

  // E2. Discard Opponent Energy (op=11)
  if (/If this Pokémon evolved from Dunsparce during this turn, discard 2 random Energy from your opponent's Active/i.test(eff)) {
    flags |= AF.ONLY_IF_EVOLVED_THIS_TURN_EFF;
    pushOp(11, 6);
  } else if (/Flip a coin until you get tails\. For each heads, discard a random Energy from your opponent's Active/i.test(eff)) {
    pushOp(11, 3);
  } else if (/Flip 3 coins\. For each heads, discard a random Energy from your opponent's Active/i.test(eff)) {
    pushOp(11, 5);
  } else if (/Flip 2 coins\. For each heads, discard a random Energy from your opponent's Active/i.test(eff)) {
    pushOp(11, 4);
  } else if (/Flip a coin\. If heads, discard a random Energy from your opponent's Active/i.test(eff)) {
    pushOp(11, 2);
  } else if (/Discard (?:a random|a \[[A-Z]\]) Energy from your opponent's Active Pokémon/i.test(eff)) {
    pushOp(11, 1);
  }

  // E3. Self / Own Bench Recoil (op=9)
  if (/This Pokémon also does 100 damage to itself and 50 damage to all Benched Pokémon \(both/i.test(eff)) {
    pushOp(9, 100 | (4 << 8));
  } else if ((m = eff.match(/Flip a coin\. If tails, this Pokémon also does (\d+) damage to itself/i))) {
    pushOp(9, Number(m[1]) | (3 << 8));
  } else if ((m = eff.match(/If your opponent's Pokémon is Knocked Out by damage from this attack, this Pokémon also does (\d+) damage to itself/i))) {
    flags |= AF.ONLY_IF_KO_RECOIL;
    pushOp(9, Number(m[1]) | (0 << 8));
  } else if ((m = eff.match(/This Pokémon also does (\d+) damage to itself/i))) {
    pushOp(9, Number(m[1]) | (0 << 8));
  } else if ((m = eff.match(/This attack also does (\d+) damage to each of your Benched Pokémon/i))) {
    pushOp(9, Number(m[1]) | (2 << 8));
  } else if ((m = eff.match(/This attack also does (\d+) damage to 1 of your Benched Pokémon/i))) {
    pushOp(9, Number(m[1]) | (1 << 8));
  } else if ((m = eff.match(/This attack also does (\d+) damage to 1 of your Pokémon\./i))) {
    pushOp(9, Number(m[1]) | (5 << 8));
  }

  // E4. Status Conditions on Self / Both / Opponent (op=1, op=2)
  if (/This Pokémon recovers from all Special Conditions/i.test(eff)) {
    pushOp(2, 5);
  } else if (/Both Active Pokémon are now Confused/i.test(eff)) {
    pushOp(2, 3);
  } else if (/Both Active Pokémon are now Asleep/i.test(eff)) {
    pushOp(2, 4);
  } else if (/Flip a coin\. If heads, your opponent's Active Pokémon is now Confused\. If tails, this Pokémon is now Confused/i.test(eff)) {
    pushOp(1, SM_CONFUSE | (3 << 8));
  } else if (/Flip a coin\. If heads, your opponent's Active Pokémon is now Paralyzed\. If tails, your opponent's Active Pokémon is now Confused/i.test(eff)) {
    pushOp(1, SM_PARALYZE | (4 << 8));
  } else if (/Choose either Poisoned or Confused\. Your opponent's Active Pokémon is now affected/i.test(eff)) {
    pushOp(1, (SM_POISON | SM_CONFUSE) | (5 << 8));
  } else if (/1 Special Condition from among Asleep, Burned, Confused, Paralyzed, and Poisoned is chosen at random/i.test(eff)) {
    pushOp(1, (SM_POISON | SM_BURN | SM_SLEEP | SM_PARALYZE | SM_CONFUSE) | (2 << 8));
  } else if (/During your opponent's next turn, if they attach Energy from their Energy Zone to the Defending Pokémon, that Pokémon will be Asleep/i.test(eff)) {
    pushOp(1, SM_SLEEP | (8 << 8));
  } else {
    if (/This Pokémon is now Asleep/i.test(eff)) pushOp(2, 1);
    if (/This Pokémon is now Confused/i.test(eff)) pushOp(2, 2);

    // Opponent status infliction (STRICTLY match opponent's Active Pokémon, NEVER "This Pokémon is now"!)
    const infM = eff.match(/your opponent's Active Pokémon is now ((?:Poisoned|Burned|Asleep|Paralyzed|Confused)(?: and (?:Poisoned|Burned|Asleep|Paralyzed|Confused))?)/i);
    if (infM) {
      let sm = 0;
      const t = infM[1];
      if (/Poisoned/i.test(t)) {
        if (/Do 40 damage to this Pokémon instead/i.test(eff)) sm |= SM_TOXIC40;
        else if (/Do 20 damage to this Pokémon instead/i.test(eff)) sm |= SM_TOXIC20;
        else sm |= SM_POISON;
      }
      if (/Burned/i.test(t)) sm |= SM_BURN;
      if (/Asleep/i.test(t)) sm |= /flips 2 coins for this Special Condition/i.test(eff) ? SM_DEEP_SLEEP : SM_SLEEP;
      if (/Paralyzed/i.test(t)) sm |= SM_PARALYZE;
      if (/Confused/i.test(t)) sm |= SM_CONFUSE;

      if (sm !== 0) {
        let mode = 0;
        if (/If at least 2 of them are heads/i.test(eff)) mode = 6;
        else if (/If at least 1 of them is heads/i.test(eff)) mode = 7;
        else if (/Flip a coin\. If heads, your opponent's Active Pokémon is now/i.test(eff)) mode = 1;
        if (/If a Stadium is in play, your opponent's Active Pokémon is now/i.test(eff)) flags |= AF.ONLY_IF_STADIUM_EFF;
        if (/If any of your Pokémon were Knocked Out.*is now Paralyzed/i.test(eff)) flags |= AF.ONLY_IF_KO_LAST_TURN_EFF;
        pushOp(1, sm | (mode << 8));
      }
    }
  }

  // E5. Heal (op=12)
  if (/Heal from this Pokémon the same amount of damage you did/i.test(eff)) {
    pushOp(12, 999);
  } else if ((m = eff.match(/If your opponent's Active Pokémon is Poisoned, heal (\d+) damage from this Pokémon/i))) {
    pushOp(12, Number(m[1]) | (6 << 12));
  } else if ((m = eff.match(/Flip a coin\. If heads, heal (\d+) damage from this Pokémon/i))) {
    pushOp(12, Number(m[1]) | (5 << 12));
  } else if ((m = eff.match(/Heal (\d+) damage from each of your Benched/i))) {
    pushOp(12, Number(m[1]) | (4 << 12));
  } else if ((m = eff.match(/Heal (\d+) damage from each of your (?:\[[A-Z]\] )?Pokémon/i))) {
    pushOp(12, Number(m[1]) | (3 << 12));
  } else if ((m = eff.match(/Heal (\d+) damage from 1 of your Benched Pokémon/i))) {
    pushOp(12, Number(m[1]) | (2 << 12));
  } else if ((m = eff.match(/Heal (\d+) damage from 1 of your Pokémon/i))) {
    pushOp(12, Number(m[1]) | (1 << 12));
  } else if ((m = eff.match(/Heal (\d+) damage from (?:this Pokémon|it)/i))) {
    if (/If a Stadium is in play/i.test(eff)) flags |= AF.ONLY_IF_STADIUM_EFF;
    pushOp(12, Number(m[1]) | (0 << 12));
  }

  // E6. Energy Ramp / Move (op=13)
  if (/You may move any amount of Energy from your Pokémon in play to your other Pokémon/i.test(eff)) {
    pushOp(13, 0 | (9 << 8));
  } else if ((m = eff.match(/Move (all|\d+)(?: random| \[[A-Z]\])? Energy from this Pokémon to (?:1 of )?your Benched Pokémon/i))) {
    const cnt = /all/i.test(m[1]) ? 99 : Number(m[1]);
    pushOp(13, cnt | (8 << 8));
  } else if (/Flip 3 coins\. Take an amount of \[[A-Z]\] Energy from your Energy Zone equal to the number of heads and attach it to your Benched/i.test(eff)) {
    pushOp(13, 3 | (3 << 8));
  } else if (/Flip 3 coins\. For each heads, produce a \[[A-Z]\] Energy from your Energy Zone and attach it to this Pokémon/i.test(eff)) {
    pushOp(13, 3 | (4 << 8));
  } else if ((m = eff.match(/Flip a coin\. If heads, take (\d+) \[[A-Z]\] Energy from your Energy Zone and attach it to 1 of your Benched/i))) {
    pushOp(13, Number(m[1]) | (6 << 8));
  } else if ((m = eff.match(/Flip a coin\. If heads, take (\d+) \[[A-Z]\] Energy from your Energy Zone and attach it to this Pokémon/i))) {
    pushOp(13, Number(m[1]) | (5 << 8));
  } else if (/Choose 2 of your Benched Pokémon\. For each of those Pokémon, take a \[[A-Z]\] Energy/i.test(eff)) {
    pushOp(13, 2 | (2 << 8));
  } else if (/Take a \[R\], \[W\], and \[L\] Energy from your Energy Zone and attach them to your Benched Basic/i.test(eff)) {
    pushOp(13, 3 | (7 << 8));
  } else if (/Take 3 \[P\] Energy from your Energy Zone and attach it to your \[P\] Pokémon in any way you like/i.test(eff)) {
    pushOp(13, 3 | (7 << 8));
  } else if (/Take a \[W\] and a \[L\] Energy from your Energy Zone and attach them to this Pokémon/i.test(eff)) {
    pushOp(13, 2 | (0 << 8));
  } else if ((m = eff.match(/Take (a|an|\d+|a random) .*?Energy.*?from your Energy Zone and attach it to (this Pokémon|1 of your Benched|Mesprit or Azelf)/i))) {
    const cnt = (m[1] === 'a' || m[1] === 'an' || /random/i.test(m[1])) ? 1 : Number(m[1]);
    const mode = /this Pokémon/i.test(m[2]) ? 0 : 1;
    pushOp(13, cnt | (mode << 8));
  }

  // E7. Defensive Shields / Counter / Vulnerability / Trap (op=14)
  if ((m = eff.match(/During your opponent's next turn, this Pokémon takes -(\d+) damage from attacks and has no Weakness/i))) {
    pushOp(14, Number(m[1]) | (1 << 8));
  } else if (/During your opponent's next turn, this Pokémon has no Weakness/i.test(eff)) {
    pushOp(14, 0 | (2 << 8));
  } else if ((m = eff.match(/During your opponent's next turn, this Pokémon takes -(\d+) damage from attacks from your opponent's Pokémon ex/i))) {
    pushOp(14, Number(m[1]) | (3 << 8));
  } else if ((m = eff.match(/Flip a coin\. If heads, during your opponent's next turn, this Pokémon takes -(\d+) damage/i))) {
    pushOp(14, Number(m[1]) | (9 << 8));
  } else if ((m = eff.match(/During your opponent's next turn, this Pokémon takes -(\d+) damage from attacks/i))) {
    pushOp(14, Number(m[1]) | (0 << 8));
  } else if ((m = eff.match(/prevent all damage done to this Pokémon by attacks if that damage is (\d+) or less/i))) {
    pushOp(14, Number(m[1]) | (4 << 8));
  } else if (/Prevent all damage done to this Pokémon by attacks from Basic Pokémon during your opponent's next turn/i.test(eff)) {
    pushOp(14, 0 | (5 << 8));
  } else if ((m = eff.match(/if this Pokémon is damaged by an attack, do (\d+) damage to the Attacking Pokémon/i))) {
    pushOp(14, Number(m[1]) | (6 << 8));
  } else if ((m = eff.match(/During your opponent's next turn, this Pokémon takes \+(\d+) damage from attacks/i))) {
    pushOp(14, Number(m[1]) | (10 << 8));
  } else if ((m = eff.match(/During your next turn, the Defending Pokémon takes \+(\d+) damage from attacks/i))) {
    pushOp(14, Number(m[1]) | (11 << 8));
  } else if (/when your opponent's Active Pokémon retreats, this attack does 40 damage to the new Active/i.test(eff)) {
    pushOp(14, 40 | (12 << 8));
  }

  // E8. Opponent Attack Disruption / Weaken / Cost Tax / Ability Strip (op=15)
  if ((m = eff.match(/attacks used by the Defending Pokémon do -(\d+) damage/i))) {
    pushOp(15, Number(m[1]) | (0 << 8));
  } else if (/If the Defending Pokémon tries to use an attack, your opponent flips a coin.*lasts until/i.test(eff)) {
    pushOp(15, 0 | (2 << 8));
  } else if (/if the Defending Pokémon tries to use an attack, your opponent flips a coin/i.test(eff)) {
    pushOp(15, 0 | (1 << 8));
  } else if (/If the Defending Pokémon is a Basic Pokémon, it can't attack during your opponent's next turn/i.test(eff)) {
    pushOp(15, 0 | (5 << 8));
  } else if (/Flip a coin\. If heads, the Defending Pokémon can't attack during your opponent's next turn/i.test(eff)) {
    pushOp(15, 0 | (4 << 8));
  } else if (/the Defending Pokémon can't attack/i.test(eff)) {
    pushOp(15, 0 | (3 << 8));
  } else if ((m = eff.match(/attacks used by the Defending Pokémon cost (\d+) \[C\] more, and its Retreat Cost is (\d+) \[C\] more/i))) {
    pushOp(15, Number(m[1]) | (7 << 8));
  } else if ((m = eff.match(/attacks used by the Defending Pokémon cost (\d+) \[C\] more/i))) {
    pushOp(15, Number(m[1]) | (6 << 8));
  } else if (/1 of your opponent's Active Pokémon's attacks is chosen at random\. During your opponent's next turn, that Pokémon can't use/i.test(eff)) {
    pushOp(15, 0 | (8 << 8));
  } else if (/The Defending Pokémon loses all Abilities/i.test(eff)) {
    pushOp(15, 0 | (9 << 8));
  } else if (/they can't take any Energy from their Energy Zone to attach to their Active Pokémon/i.test(eff)) {
    pushOp(15, 0 | (10 << 8));
  } else if (/Change the type of (?:a random Energy attached to your opponent's Active|the next Energy that will be generated for your opponent)/i.test(eff)) {
    pushOp(15, 0 | (11 << 8));
  }

  // E9. Self Switch / Shuffle Self into Deck (op=16)
  if (/(?:You may )?[Ss]huffle this Pokémon(?: and all attached cards)? into your deck/i.test(eff)) {
    pushOp(16, 1);
  } else if (/(?:You may )?[Ss]witch this Pokémon with 1 of your Benched/i.test(eff)) {
    pushOp(16, 0);
  }

  // E10. Opponent Lock / Disruption / Switch / Mill / Devolve (op=17)
  if (/the Defending Pokémon can't retreat|that Pokémon can't retreat/i.test(eff)) {
    pushOp(17, 1);
  }
  if (/Switch out your opponent's Active Pokémon to the Bench/i.test(eff)) {
    pushOp(17, 2);
  } else if ((m = eff.match(/Switch in 1 of your opponent's Benched Pokémon to the Active Spot\. If you do, this attack does (\d+) damage/i))) {
    pushOp(17, 3 | (Number(m[1]) << 8));
    dmg = 0;
  } else if (/Flip a coin\. If heads, switch in 1 of your opponent's Benched Pokémon to the Active Spot/i.test(eff)) {
    pushOp(17, 3 | (1 << 8));
  }
  if (/can't play any Item cards from their hand/i.test(eff)) pushOp(17, 4);
  if (/can't use any Supporter cards from their hand/i.test(eff)) pushOp(17, 5);
  if (/can't (?:play|use) any Trainer cards from their hand/i.test(eff)) {
    if (/first time this Pokémon has used an attack/i.test(eff)) flags |= AF.FIRST_ATTACK_ONLY_EFF;
    pushOp(17, 6);
  }
  if (/can't play any Pokémon from their hand to evolve their Pokémon/i.test(eff)) pushOp(17, 7);
  if (/Choose a Supporter card you find there and discard it/i.test(eff)) {
    const coin = /Flip a coin\. If heads/i.test(eff) ? 1 : 0;
    pushOp(17, 8 | (coin << 8));
  }
  if (/discard all Pokémon Tools from your opponent's Active|shuffle all Pokémon Tools from each of your opponent's Pokémon into their deck/i.test(eff)) {
    const allOpp = /each of your opponent's Pokémon/i.test(eff) ? 1 : 0;
    pushOp(17, 9 | (allOpp << 8));
  }
  if (/Discard a random Item card from your opponent's hand/i.test(eff)) pushOp(17, 10 | (2 << 8));
  else if (/Discard a random Pokémon Tool card from your opponent's hand/i.test(eff)) pushOp(17, 10 | (3 << 8));
  else if (/Flip a coin\. If heads, discard a random card from your opponent's hand/i.test(eff)) pushOp(17, 10 | (1 << 8));
  else if (/Discard a random card from your opponent's hand/i.test(eff)) pushOp(17, 10 | (0 << 8));

  if (/Flip 3 coins\. For each heads, a card is chosen at random from your opponent's hand.*shuffles it into their deck/i.test(eff)) {
    pushOp(17, 11 | (98 << 8));
  } else if (/Flip a coin\. If heads, (?:your opponent reveals|look at) a random card from your opponent's hand and shuffles? it into their deck/i.test(eff)) {
    pushOp(17, 11 | (99 << 8));
  } else if (/(?:reveals a random card|look at a random card|Choose a card you find there)[^.]*shuffles? it into (?:their|your opponent's) deck/i.test(eff)) {
    pushOp(17, 11 | (1 << 8));
  }
  if (/Flip a coin\. If heads, (?:your opponent shuffles their Active Pokémon into their deck|put your opponent's Active Pokémon into their hand)/i.test(eff)) {
    pushOp(17, 12);
  }
  if (/Flip a coin until you get tails\. For each heads, discard the top card of your opponent's deck/i.test(eff)) {
    pushOp(17, 13 | (99 << 8));
  } else if ((m = eff.match(/Discard the top (\d+) cards? of each player's deck/i))) {
    pushOp(17, 15 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/Discard the top (?:(\d+) cards|card) of your opponent's deck/i))) {
    pushOp(17, 13 | ((Number(m[1] || 1)) << 8));
  } else if ((m = eff.match(/^Discard the top (?:(\d+) cards|card) of your deck\.$/i))) {
    pushOp(17, 14 | ((Number(m[1] || 1)) << 8));
  }
  if (/Discard a Stadium in play|If your opponent has a Stadium in play, discard it/i.test(eff)) {
    pushOp(17, 16);
  }
  if (/devolve it by putting the highest Stage Evolution card on it into your opponent's hand/i.test(eff)) {
    pushOp(17, 17);
  }
  if (/^Your opponent reveals their hand\.$/i.test(eff)) {
    pushOp(17, 18);
  }

  // E11. Draw / Search / Bench Summon / Self-Evolve (op=18)
  if (/Shuffle your hand into your deck\. Draw a card for each card in your opponent's hand/i.test(eff)) {
    pushOp(18, 4);
  } else if (/Draw cards until you have the same number of cards in your hand as your opponent/i.test(eff)) {
    pushOp(18, 5);
  } else if (/Draw a card for each Poochyena you have in play/i.test(eff)) {
    pushOp(18, 6);
  } else if (/Draw a card\./i.test(eff)) {
    pushOp(18, 1 | (1 << 8));
  } else if (/Put a random card from your deck that evolves from this Pokémon onto this Pokémon to evolve it/i.test(eff)) {
    pushOp(18, 9);
  } else if (/Put a random Supporter card from your deck into your hand/i.test(eff)) {
    pushOp(18, 7);
  } else if (/Put a random Item card from your discard pile into your hand/i.test(eff)) {
    pushOp(18, 8);
  } else if ((m = eff.match(/Put (\d+) random .*? from your deck onto your Bench/i))) {
    pushOp(18, 3 | (Number(m[1]) << 8));
  } else if (/Put (?:a|1) random .*? from your deck into your hand/i.test(eff)) {
    pushOp(18, 2);
  }

  // E12. Next-turn Self Attack Modifiers (op=19)
  if (/Flip a coin\. If tails, during your next turn, this Pokémon can't attack/i.test(eff)) {
    pushOp(19, 3);
  } else if (/During your next turn, this Pokémon can't attack\./i.test(eff)) {
    pushOp(19, 1);
  } else if (/During your next turn, this Pokémon can't use /i.test(eff)) {
    pushOp(19, 2);
  } else if ((m = eff.match(/Until this Pokémon leaves the Active Spot, this Pokémon's .*? attack does \+(\d+) damage\. This effect stacks/i))) {
    pushOp(19, 6 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/During your next turn, attacks used by your (?:\[[A-Z]\] )?Pokémon do \+(\d+) damage/i))) {
    pushOp(19, 5 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/During your next turn, this Pokémon's .*? does -(\d+) damage/i))) {
    pushOp(19, 7 | (Number(m[1]) << 8));
  } else if ((m = eff.match(/During your next turn, this Pokémon's .*? attack does \+(\d+) damage/i))) {
    pushOp(19, 4 | (Number(m[1]) << 8));
  }

  if (op1 === 0 && op2 === 0 && flags === 0) {
    throw Error(`UNCOMPILED ATTACK EFFECT [${title}]: "${eff}"`);
  }
  return { cost, flags, dmg, op1, val1, op2, val2, aux };
}

// =========================================================================
// 2. ABILITY COMPILER (164 / 164 unique English abilities -> abOp, abCond, abVal, abAux)
// =========================================================================
function compileAbility(enRaw, title = '') {
  const eff = String(enRaw || '').replace(/\u00a0/g, ' ').trim();
  if (!eff) return { abOp: 0, abCond: 0, abVal: 0, abAux: 0 };

  let abCond = 0;
  let abAux = 0;
  if (/if this Pokémon is in the Active Spot|As long as this Pokémon is in the Active Spot/i.test(eff)) abCond = 1;
  else if (/if this Pokémon is on your Bench|As long as this Pokémon is on your Bench/i.test(eff)) abCond = 2;
  if (/If you have Arceus or Arceus ex in play/i.test(eff)) abCond = 3;
  else if (/If you have another (?:Falinks|Beldum) in play/i.test(eff)) abCond = 4;
  else if (/If you have Latias in play/i.test(eff)) abCond = 5;
  else if (/if this Pokémon has a Pokémon Tool attached/i.test(eff)) abCond = 6;
  else if (/If this Pokémon has full HP/i.test(eff)) abCond = 7;
  else if (/If this Pokémon's remaining HP is 50 or less/i.test(eff)) abCond = 8;
  else if (/If a Stadium is in play/i.test(eff)) abCond = 9;
  else if (/During your first turn, this Pokémon has no Retreat Cost/i.test(eff)) abCond = 10;
  else if (/if you have any Unown in play with an Ability other than/i.test(eff)) abCond = 11;
  else if (/If this Pokémon has any Energy attached, it has no Retreat Cost/i.test(eff)) abCond = 12;
  else if (/evolves from Poliwhirl/i.test(eff)) { abCond = 13; abAux = nameHash16('Poliwhirl'); }

  let m;

  // Dual-type Urshifu
  if (/As long as this Pokémon is in play, it is \[[A-Z]\] and \[[A-Z]\] type/i.test(eff)) {
    return { abOp: 22, abCond: 0, abVal: 1, abAux: 0 };
  }
  // 10. Oricorio ex immunity
  if (/Prevent all damage done to this Pokémon by attacks from your opponent's Pokémon ex/i.test(eff)) {
    return { abOp: 10, abCond: 0, abVal: 1, abAux: 0 };
  }
  // 21. Disguise / Dodge / Kill-Invuln
  if (/When this Pokémon is first damaged by an attack after coming into play, prevent that damage/i.test(eff)) {
    return { abOp: 21, abCond: 0, abVal: 1, abAux: 0 };
  }
  if (/If any damage is done to this Pokémon by attacks, flip a coin\. If heads, prevent that damage/i.test(eff)) {
    return { abOp: 21, abCond: 0, abVal: 2, abAux: 0 };
  }
  if (/If your opponent's Pokémon is Knocked Out by damage from this Pokémon's attacks, during your opponent's next turn, prevent all damage/i.test(eff)) {
    return { abOp: 21, abCond: 0, abVal: 3, abAux: 0 };
  }
  // 1. End of turn Active draw 1 (Entei/Suicune/Raikou)
  if (/At the end of your turn, if this Pokémon is in the Active Spot, draw a card/i.test(eff)) {
    return { abOp: 1, abCond: 1, abVal: 1, abAux: 0 };
  }
  // 2. Start of turn Active search [P] (Meloetta)
  if (/At the beginning of your turn, if this Pokémon is in the Active Spot, put a random \[P\] Pokémon/i.test(eff)) {
    return { abOp: 2, abCond: 1, abVal: 1, abAux: 0 };
  }
  // 5. On-Evolve triggers
  if (/when you play this (?:Pokémon|card) from your hand to evolve/i.test(eff)) {
    if (/take a \[R\] Energy from your Energy Zone and attach it to your Active/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 1, abAux: 0 };
    if (/draw 2 cards/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 2, abAux: 0 };
    if (/Put a random Frogadier from your deck onto your Bench/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 3, abAux: 0 };
    if (/do 20 damage to your opponent's Active/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 4, abAux: 0 };
    if (/do 30 damage to your opponent's Active/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 5, abAux: 0 };
    if (/opponent shuffle their hand into their deck\. For each remaining point/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 6, abAux: 0 };
    if (/put 2 random Pokémon Tool cards from your discard pile into your hand/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 7, abAux: 0 };
    if (/flip a coin\. If heads, your opponent's Active Pokémon is now Paralyzed/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 8, abAux: 0 };
    if (/look at the top 4 cards of your deck and put all Item cards/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 9, abAux: 0 };
    if (/discard a random Energy from your opponent's Active/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 10, abAux: 0 };
    if (/put a Supporter card from your discard pile into your hand/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 11, abAux: 0 };
    if (/heal 60 damage from 1 of your \[W\] Pokémon/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 12, abAux: 0 };
    if (/make your opponent's Active Pokémon Poisoned and Burned/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 13, abAux: 0 };
    if (/move a random Energy from your opponent's Active Pokémon to this Pokémon/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 14, abAux: 0 };
    if (/prevent all damage from—and effects of—attacks/i.test(eff)) return { abOp: 5, abCond: 0, abVal: 15, abAux: 0 };
  }
  // 6. On-Bench triggers
  if (/when you put this Pokémon from your hand onto your Bench/i.test(eff)) {
    if (/switch it with your Active.*move all of your Energy/i.test(eff)) return { abOp: 6, abCond: 0, abVal: 1, abAux: 0 };
    if (/switch out your opponent's Active Pokémon to the Bench/i.test(eff)) return { abOp: 6, abCond: 0, abVal: 2, abAux: 0 };
    if (/heal 20 damage from your Active \[G\] Pokémon/i.test(eff)) return { abOp: 6, abCond: 0, abVal: 3, abAux: 0 };
    if (/have your opponent reveal their hand/i.test(eff)) return { abOp: 6, abCond: 0, abVal: 4, abAux: 0 };
  }
  // 20. Jolteon ex opponent energy attach punish
  if (/whenever your opponent attaches an Energy from their Energy Zone to 1 of their Pokémon, do (\d+) damage/i.test(eff)) {
    return { abOp: 20, abCond: 1, abVal: Number(eff.match(/do (\d+) damage/i)[1]), abAux: 0 };
  }
  // 7. Whenever YOU attach Energy from Energy Zone to THIS Pokémon
  if (/Whenever you attach an? (?:\[[A-Z]\] )?Energy from your Energy Zone to (?:this Pokémon|it)/i.test(eff)) {
    if ((m = eff.match(/do (\d+) damage to your opponent's Active/i))) return { abOp: 7, abCond: 0, abVal: Number(m[1]), abAux: 0 };
    if ((m = eff.match(/heal (\d+) damage from this Pokémon/i))) return { abOp: 7, abCond: 0, abVal: 100 + Number(m[1]), abAux: 0 };
    if (/it is now Asleep/i.test(eff)) return { abOp: 7, abCond: 1, abVal: 200, abAux: 0 };
    if (/evolves from this Pokémon onto this Pokémon to evolve it/i.test(eff)) return { abOp: 7, abCond: 0, abVal: 201, abAux: 0 };
  }
  // 9. End-of-turn / Checkup passives
  if (/At the end of each turn, if your opponent's Active Pokémon is Asleep, do 20 damage/i.test(eff)) return { abOp: 9, abCond: 0, abVal: 1, abAux: 0 };
  if (/During Pokémon Checkup, if this Pokémon is in the Active Spot, do 10 damage to your opponent's Active/i.test(eff)) return { abOp: 9, abCond: 1, abVal: 2, abAux: 0 };
  if (/During Pokémon Checkup, if this Pokémon is in the Active Spot, do 10 damage to each of your opponent's Pokémon/i.test(eff)) return { abOp: 9, abCond: 1, abVal: 3, abAux: 0 };
  if (/At the end of your turn, if this Pokémon is in the Active Spot, heal 20 damage from it/i.test(eff)) return { abOp: 9, abCond: 1, abVal: 4, abAux: 0 };
  if (/At the end of your first turn, take a \[L\] Energy from your Energy Zone and attach it to this Pokémon/i.test(eff)) return { abOp: 9, abCond: 0, abVal: 5, abAux: 0 };
  if (/During Pokémon Checkup, heal 10 damage from each of your Pokémon/i.test(eff)) return { abOp: 9, abCond: 0, abVal: 6, abAux: 0 };
  if (/At the end of your opponent's turn, if this Pokémon is in the Active Spot, put a random card.*evolve it/i.test(eff)) return { abOp: 9, abCond: 1, abVal: 7, abAux: 0 };

  // 3. Once/turn self energy attach
  if (/Once during your turn, you may take a \[P\] Energy.*attach it to this Pokémon\. If you use this Ability, your turn ends/i.test(eff)) {
    return { abOp: 3, abCond: 0, abVal: 4, abAux: 0 }; // Giratina ex: +1 AND ENDS TURN!
  }
  if (/Once during your turn, you may take 2 \[D\] Energy.*attach it to this Pokémon\. If you do, do 30 damage/i.test(eff)) {
    return { abOp: 3, abCond: 0, abVal: 3, abAux: 0 }; // Hydreigon: +2 AND -30 HP
  }
  if (/Once during your turn, you may attach a \[R\] Energy from your discard pile to this Pokémon\. If you do, do 20 damage/i.test(eff)) {
    return { abOp: 3, abCond: 0, abVal: 2, abAux: 0 }; // Flareon ex: +1 from discard AND -20 HP
  }
  if (/Once during your turn, you may take a \[[A-Z]\] Energy from your Energy Zone and attach it to this Pokémon\./i.test(eff)) {
    return { abOp: 3, abCond: 0, abVal: 1, abAux: 0 }; // Magneton / Milotic ex
  }

  // 4. Once/turn attach energy to Active / Ally
  if (/Once during your turn, if this Pokémon is on your Bench, you may attach an Energy from your discard pile to your Active/i.test(eff)) {
    return { abOp: 4, abCond: 2, abVal: 2, abAux: 0 }; // Dragonair
  }
  if (/Once during your turn, if this Pokémon is in the Active Spot, you may take a \[G\] Energy.*attach it to 1 of your \[G\] Pokémon/i.test(eff)) {
    return { abOp: 4, abCond: 1, abVal: 3, abAux: 0 }; // Leafeon ex
  }
  if (/Once during your turn, you may take a \[[A-Z]\] Energy from your Energy Zone and attach it to the \[[A-Z]\] Pokémon in the Active Spot/i.test(eff)) {
    return { abOp: 4, abCond: 0, abVal: 1, abAux: 0 }; // Gardevoir / Baxcalibur / Pawmot
  }

  // 8. Once/turn snipe damage
  if ((m = eff.match(/Once during your turn, (?:if you have Arceus or Arceus ex in play, )?you may do (\d+) damage to (1 of your opponent's Pokémon|your opponent's Active Pokémon)/i))) {
    const activeOnly = /Active/i.test(m[2]) ? 1 : 0;
    return { abOp: 8, abCond, abVal: Number(m[1]) | (activeOnly << 8), abAux: 0 };
  }

  // 13. On-Damaged / On-KO reactions
  if (/would be Knocked Out by damage from an attack, flip a coin\. If heads, this Pokémon is not Knocked Out, and its remaining HP becomes 10/i.test(eff)) {
    return { abOp: 13, abCond: 0, abVal: 0 | (8 << 8), abAux: 0 }; // Conkeldurr Guts
  }
  if (/When this Pokémon is Knocked Out, flip a coin\. If heads, your opponent can't get any points/i.test(eff)) {
    return { abOp: 13, abCond: 0, abVal: 0 | (6 << 8), abAux: 0 }; // Dusknoir B1 / Glimmora
  }
  if (/is Knocked Out by damage from an attack.*flip a coin\. If heads, the Attacking Pokémon is Knocked Out/i.test(eff)) {
    return { abOp: 13, abCond: 1, abVal: 0 | (7 << 8), abAux: 0 }; // Galarian Cursola
  }
  if (/is Knocked Out by damage from an attack.*move all \[F\] Energy from this Pokémon to 1 of your Benched/i.test(eff)) {
    return { abOp: 13, abCond: 1, abVal: 0 | (5 << 8), abAux: 0 }; // Passimian ex
  }
  if (/is Knocked Out by damage from an attack.*do 10 damage to each of your opponent's Pokémon/i.test(eff)) {
    return { abOp: 13, abCond: 1, abVal: 10 | (4 << 8), abAux: 0 }; // Spiritomb B2
  }
  if ((m = eff.match(/is Knocked Out by damage from an attack.*do (\d+) damage to the Attacking Pokémon/i))) {
    return { abOp: 13, abCond: 1, abVal: Number(m[1]) | (3 << 8), abAux: 0 }; // Pyukumuku 50 / TR Electrode 70
  }
  if (/is damaged by an attack.*the Attacking Pokémon is now Poisoned/i.test(eff)) {
    return { abOp: 13, abCond: 1, abVal: 0 | (1 << 8), abAux: 0 }; // Dragalge ex
  }
  if (/is damaged by an attack.*take a \[W\] Energy from your Energy Zone and attach it to 1 of your Benched/i.test(eff)) {
    return { abOp: 13, abCond: 1, abVal: 0 | (2 << 8), abAux: 0 }; // Jellicent
  }
  if ((m = eff.match(/is damaged by an attack.*do (\d+) damage to the Attacking Pokémon/i))) {
    return { abOp: 13, abCond: 1, abVal: Number(m[1]) | (0 << 8), abAux: 0 }; // Druddigon / Poliwrath / Lycanroc ex
  }

  // 11. Damage Reduction & Falinks dual
  if (/If you have another Falinks in play, this Pokémon's attacks do \+20 damage.*takes -20 damage/i.test(eff)) {
    return { abOp: 11, abCond: 4, abVal: 20 | (8 << 8), abAux: 0 };
  }
  if (/As long as this Pokémon is on your Bench, prevent all damage done to this Pokémon by attacks/i.test(eff)) {
    return { abOp: 11, abCond: 2, abVal: 0 | (6 << 8), abAux: 0 }; // Wartortle
  }
  if (/Prevent all effects of attacks used by your opponent's Pokémon done to this Pokémon/i.test(eff)) {
    return { abOp: 11, abCond: 0, abVal: 0 | (7 << 8), abAux: 0 }; // Regice
  }
  if ((m = eff.match(/If any damage is done to this Pokémon by attacks, flip a coin\. If heads, this Pokémon takes -(\d+) damage/i))) {
    return { abOp: 11, abCond: 0, abVal: Number(m[1]) | (5 << 8), abAux: 0 }; // Bastiodon 100 / Hisuian Goodra 80
  }
  if ((m = eff.match(/attacks used by your opponent's Active Pokémon do -(\d+) damage/i))) {
    return { abOp: 11, abCond: 1, abVal: Number(m[1]) | (2 << 8), abAux: 0 }; // Luxray A3a
  }
  if ((m = eff.match(/takes -(\d+) damage from attacks from \[R\] or \[W\] Pokémon/i))) {
    return { abOp: 11, abCond: 0, abVal: Number(m[1]) | (3 << 8), abAux: 0 }; // Mamoswine / Piloswine
  }
  if ((m = eff.match(/takes -(\d+) damage from attacks from \[F\] Pokémon/i))) {
    return { abOp: 11, abCond: 0, abVal: Number(m[1]) | (4 << 8), abAux: 0 }; // Staraptor
  }
  if ((m = eff.match(/all of your (?:\[([A-Z])\] )?Pokémon take -(\d+) damage/i))) {
    const tf = m[1] ? parseEnergyTypeLetter(m[1]) : 255;
    return { abOp: 11, abCond, abVal: Number(m[2]) | (1 << 8) | (tf << 16), abAux: 0 }; // Melmetal C1 / Unown GUARD
  }
  if ((m = eff.match(/(?:this Pokémon|it) takes -(\d+) damage from attacks/i))) {
    return { abOp: 11, abCond, abVal: Number(m[1]) | (0 << 8), abAux: 0 };
  }

  // 12. Damage Boosts
  if (/Once during your turn, you may discard 1 \[R\] Energy from this Pokémon in order to use this Ability\. During this turn, attacks used by your \[R\] Pokémon do \+50/i.test(eff)) {
    return { abOp: 12, abCond: 0, abVal: 50 | (2 << 8), abAux: 0 }; // Skeledirge
  }
  if ((m = eff.match(/attacks used by this Pokémon do \+(\d+) damage/i))) {
    return { abOp: 12, abCond, abVal: Number(m[1]) | (1 << 8), abAux: 0 }; // Carnivine / Quaquaval
  }
  if ((m = eff.match(/Attacks used by your \[P\] Pokémon and \[M\] Pokémon do \+(\d+) damage/i))) {
    return { abOp: 12, abCond, abVal: Number(m[1]) | (3 << 8), abAux: 0 }; // Aegislash P+M
  }
  if ((m = eff.match(/Attacks used by your (?:\[([A-Z])\] )?Pokémon(?: that evolve from Poliwhirl)? do \+(\d+) damage/i))) {
    const tf = m[1] ? parseEnergyTypeLetter(m[1]) : 255;
    return { abOp: 12, abCond, abVal: Number(m[2]) | (0 << 8) | (tf << 16), abAux }; // Lucario / Unown POWER / Politoed
  }

  // 14. Once/turn Heal / Damage Move / Cure
  if (/Once during your turn, you may heal 60 damage from 1 of your Pokémon ex that has any Energy attached\. If you do, discard a random Energy/i.test(eff)) {
    return { abOp: 14, abCond: 0, abVal: 60 | (3 << 8), abAux: 0 }; // Arboliva
  }
  if (/move 30 damage that your Active Pokémon has on it to this Pokémon/i.test(eff)) {
    return { abOp: 14, abCond: 2, abVal: 30 | (4 << 8), abAux: 0 }; // Bramblin
  }
  if (/choose 1 of your Pokémon that has damage on it, and move all of its damage to this Pokémon/i.test(eff)) {
    return { abOp: 14, abCond: 0, abVal: 0 | (5 << 8), abAux: 0 }; // Dusknoir A2-072
  }
  if (/remove a random Special Condition from your Active Pokémon/i.test(eff)) {
    return { abOp: 14, abCond: 0, abVal: 0 | (6 << 8), abAux: 0 }; // Blissey B3-128
  }
  if ((m = eff.match(/heal (\d+) damage from each of your (?:\[([A-Z])\] )?Pokémon/i))) {
    const tf = m[2] ? parseEnergyTypeLetter(m[2]) : 255;
    return { abOp: 14, abCond, abVal: Number(m[1]) | (2 << 8) | (tf << 16), abAux: 0 }; // Shaymin / Butterfree / Primarina
  }
  if ((m = eff.match(/heal (\d+) damage from 1 of your Pokémon/i))) {
    return { abOp: 14, abCond, abVal: Number(m[1]) | (1 << 8), abAux: 0 }; // Espeon ex / Sylveon B3b
  }
  if ((m = eff.match(/heal (\d+) damage from your Active Pokémon/i))) {
    return { abOp: 14, abCond, abVal: Number(m[1]) | (0 << 8), abAux: 0 }; // Wigglytuff / Venusaur
  }

  // 15. Evolution / Cost / Retreat / Energy Multipliers / Rerolls
  if (/can evolve during your first turn or the turn you play it/i.test(eff)) return { abOp: 15, abCond: 1, abVal: 1, abAux: 0 };
  if (/can evolve into any Pokémon that evolves from Eevee/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 2, abAux: 0 };
  if (/Your opponent can't play any Pokémon from their hand to evolve their Active Pokémon/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 3, abAux: 0 };
  if (/Attacks used by your Future Pokémon cost 1 less/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 4 | (1 << 8), abAux: 0 };
  if (/attacks used by this Pokémon cost 1 less/i.test(eff)) return { abOp: 15, abCond, abVal: 4 | (0 << 8), abAux: 0 };
  if (/attacks used by your opponent's Active Pokémon cost 1 \[C\] more/i.test(eff)) return { abOp: 15, abCond: 1, abVal: 5, abAux: 0 };
  if (/Your opponent's Active Pokémon's Retreat Cost is 1 more/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 6, abAux: 0 };
  if (/Your Active Pokémon has no Retreat Cost/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 7 | (2 << 8), abAux: 0 };
  if (/Your Active Dondozo has no Retreat Cost/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 7 | (5 << 8), abAux: nameHash16('Dondozo') };
  if (/your Active Basic Pokémon's Retreat Cost is 1 less/i.test(eff)) return { abOp: 15, abCond: 2, abVal: 7 | (1 << 8), abAux: 0 };
  if (/your Active \[D\] Pokémon's Retreat Cost is 1 less/i.test(eff)) return { abOp: 15, abCond: 2, abVal: 7 | (3 << 8), abAux: 0 };
  if (/this Pokémon's Retreat Cost is 2 less/i.test(eff)) return { abOp: 15, abCond, abVal: 7 | (4 << 8), abAux: 0 };
  if (/has no Retreat Cost/i.test(eff)) return { abOp: 15, abCond, abVal: 7 | (0 << 8), abAux: 0 };
  if (/provides 2 \[G\] Energy/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 8, abAux: 0 };
  if (/may have up to 2 Pokémon Tool cards attached/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 9, abAux: 0 };
  if (/can use any attack from its previous Evolutions/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 10, abAux: 0 };
  if (/If you don't have Regirock, Regice, and Registeel on your Bench, this Pokémon can't attack/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 11, abAux: 0 };
  if (/ignore all results of those coin flips and begin flipping those coins again/i.test(eff)) {
    const isTrn = /Trainer cards/i.test(eff) ? 1 : 0;
    return { abOp: 15, abCond: 0, abVal: 12 | (isTrn << 8), abAux: 0 };
  }
  if (/flip 3 more coins for the Rabbit Jumping attack/i.test(eff)) return { abOp: 15, abCond: 0, abVal: 13, abAux: 0 };

  // 16. Free Switch & Energy Movement
  if (/move all \[P\] Energy from 1 of your Benched \[P\] Pokémon to your Active/i.test(eff)) return { abOp: 16, abCond: 0, abVal: 2, abAux: 0 };
  if (/move a \[W\] Energy from 1 of your Benched \[W\] Pokémon to your Active \[W\]/i.test(eff)) return { abOp: 16, abCond: 0, abVal: 3, abAux: 0 };
  if (/move all \[D\] Energy from each of your Pokémon to this Pokémon/i.test(eff)) return { abOp: 16, abCond: 0, abVal: 4, abAux: 0 };
  if (/switch (?:it with your Active|your Active .* with 1 of your Benched)/i.test(eff)) {
    const sub = /Ultra Beast/i.test(eff) ? 5 : /\[W\]/i.test(eff) ? 6 : /\[M\]/i.test(eff) ? 7 : 1;
    return { abOp: 16, abCond, abVal: sub, abAux: 0 };
  }

  // 17. Passive Immunities, Locks & Poison Boost
  if (/Each of your Pokémon that has any (?:\[([A-Z])\] )?Energy attached recovers from all Special Conditions/i.test(eff)) {
    return { abOp: 17, abCond: 0, abVal: 2, abAux: 0 };
  }
  if (/can't be affected by any Special Conditions|can't be Asleep/i.test(eff)) return { abOp: 17, abCond: 0, abVal: 1, abAux: 0 };
  if (/takes \+10 damage from being Poisoned/i.test(eff)) return { abOp: 17, abCond: 0, abVal: 3, abAux: 0 };
  if (/your opponent can't use any Supporter cards from their hand/i.test(eff)) return { abOp: 17, abCond: 1, abVal: 4, abAux: 0 };
  if (/your opponent can't play any Stadium cards from their hand/i.test(eff)) return { abOp: 17, abCond: 1, abVal: 5, abAux: 0 };
  if (/can't be healed/i.test(eff)) return { abOp: 17, abCond: 0, abVal: 6, abAux: 0 };
  if (/Basic Pokémon in play.*have no Abilities/i.test(eff)) return { abOp: 17, abCond: 0, abVal: 7, abAux: 0 };

  // 18. Max HP Boosts
  if (/gets \+30 HP for each \[[A-Z]\] Energy attached to it/i.test(eff)) return { abOp: 18, abCond: 0, abVal: 99, abAux: 0 };
  if (/Each of your \[G\] Pokémon gets \+20 HP/i.test(eff)) return { abOp: 18, abCond: 0, abVal: 20, abAux: 0 };

  // 19. Once/turn Utility & Disruption
  if (/switch in 1 of your opponent's Benched Pokémon that has damage on it/i.test(eff)) return { abOp: 19, abCond, abVal: 2, abAux: 0 };
  if (/switch in 1 of your opponent's Benched Basic Pokémon/i.test(eff)) return { abOp: 19, abCond, abVal: 3, abAux: 0 };
  if (/switch out your opponent's Active Basic Pokémon/i.test(eff)) return { abOp: 19, abCond, abVal: 4, abAux: 0 };
  if (/flip a coin\. If heads, switch in 1 of your opponent's Benched Pokémon/i.test(eff)) return { abOp: 19, abCond, abVal: 5, abAux: 0 };
  if (/switch out your opponent's Active Pokémon to the Bench/i.test(eff)) return { abOp: 19, abCond, abVal: 1, abAux: 0 };
  if (/put a random Pokémon Tool card from your deck into your hand/i.test(eff)) return { abOp: 19, abCond, abVal: 7, abAux: 0 };
  if (/put a random Pokémon from your deck into your hand/i.test(eff)) return { abOp: 19, abCond, abVal: 6, abAux: 0 };
  if (/You must discard a card from your hand in order to use this Ability\. Once during your turn, you may draw a card/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 9, abAux: 0 };
  if (/if this Pokémon is in the Active Spot, you may draw a card/i.test(eff)) return { abOp: 19, abCond: 1, abVal: 8, abAux: 0 };
  if (/Put a Sweet Honey rental card into your hand/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 10, abAux: 0 };
  if (/1 Special Condition from among Burned, Confused, and Poisoned is chosen at random/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 16, abAux: 0 };
  if (/flip a coin\. If heads, your opponent's Active Pokémon is now Asleep/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 13, abAux: 0 };
  if (/flip a coin\. If heads, your opponent's Active Pokémon is now Poisoned/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 14, abAux: 0 };
  if (/make your opponent's Active Pokémon Poisoned/i.test(eff)) return { abOp: 19, abCond, abVal: 11, abAux: 0 };
  if (/make your opponent's Active Pokémon Burned/i.test(eff)) return { abOp: 19, abCond, abVal: 12, abAux: 0 };
  if (/make your opponent's Active Pokémon Confused/i.test(eff)) return { abOp: 19, abCond, abVal: 15, abAux: 0 };
  if (/discard the top card of your opponent's deck/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 17, abAux: 0 };
  if (/discard all Pokémon Tools from your opponent's Active Pokémon\. If you do, discard this Pokémon/i.test(eff)) return { abOp: 19, abCond: 2, abVal: 18, abAux: 0 };
  if (/look at a random Supporter card from your opponent's hand\. Use the effect/i.test(eff)) return { abOp: 19, abCond: 1, abVal: 19, abAux: 0 };
  if (/look at the top card of|look at a random card from your opponent's hand/i.test(eff)) return { abOp: 19, abCond: 0, abVal: 20, abAux: 0 };

  throw Error(`UNCOMPILED ABILITY EFFECT [${title}]: "${eff}"`);
}

// =========================================================================
// 3. TRAINER / TOOL / STADIUM / FOSSIL COMPILER (177 / 177 exact!)
// =========================================================================
function compileTrainer(nameEnRaw, subtype, enRaw) {
  const nameEn = normKey(nameEnRaw);
  const eff = String(enRaw || '').replace(/\u00a0/g, ' ').trim();
  const isFossil = subtype === 'fossil' || /Play this card as if it were a 40-HP Basic \[C\] Pokémon/i.test(eff);
  if (isFossil) {
    return { isFossil: 1, kind: 0, sub: 0, cond: 0, val: 0, h1: 0, h2: 0 };
  }

  // --- ALL 28 TOOLS (kind = 5) ---
  if (subtype === 'tool') {
    const TOOL_MAP = {
      'giant cape': [1, 20, 0],
      'leaf cape': [2, 30, 0],
      'elegant cape': [3, 30, 0],
      'ancient booster energy capsule': [4, 40, 0],
      'rocky helmet': [5, 20, 0],
      'poison barb': [6, 1, 0],
      'small balloon': [7, 1, 0],
      'inflatable boat': [8, 1, 0],
      'big air balloon': [9, 99, 0],
      'eviolite': [10, 20, 0],
      'heavy helmet': [11, 20, 0],
      'steel apron': [12, 10, 0],
      'metal core barrier': [13, 50, 0],
      'protective poncho': [14, 1, 0],
      'clear veil': [15, 1, 0],
      'future booster energy capsule': [16, 20, 0],
      'light ball': [17, 30, nameHash16('Pikachu ex')],
      'beastite': [18, 10, 0],
      'deceptive needle': [19, 10, 0],
      'leftovers': [20, 10, 0],
      'sitrus berry': [21, 30, 0],
      'lum berry': [22, 1, 0],
      'lucky egg': [23, 5, 0],
      'lucky mittens': [24, 1, 0],
      'electrical cord': [25, 2, 0],
      'dark pendant': [26, 1, 0],
      'rescue scarf': [27, 1, 0],
      'memory light': [28, 1, 0]
    };
    const t = TOOL_MAP[nameEn];
    if (!t) throw Error(`UNCOMPILED TOOL: ${nameEnRaw} => ${eff}`);
    return { isFossil: 0, kind: 5, sub: t[0], cond: 0, val: t[0], h1: t[2], h2: 0 };
  }

  // --- ALL 14 STADIUMS (kind = 7) ---
  if (subtype === 'stadium') {
    const STADIUM_MAP = {
      'rainbow cave': 1,
      'training area': 2,
      'starting plains': 3,
      'peculiar plaza': 4,
      'arena of antiquity': 5,
      'bounded field': 6,
      'soothing shore': 7,
      'hiking trail': 8,
      'fragrant forest': 9,
      'mesagoza': 10,
      'abandoned station': 11,
      'arcade': 12,
      'area zero': 13,
      "kid's room": 14
    };
    const sid = STADIUM_MAP[nameEn];
    if (!sid) throw Error(`UNCOMPILED STADIUM: ${nameEnRaw} => ${eff}`);
    return { isFossil: 0, kind: 7, sub: sid, cond: 0, val: sid, h1: 0, h2: 0 };
  }

  // --- ALL ITEMS & SUPPORTERS BY EXACT CANONICAL NAME (0 collisions, 0 fallbacks!) ---
  // kind:
  //   1 = Draw / Search / Deck-Look
  //   2 = Heal / Cure / Damage-Move
  //   3 = Disruption / Switch-Opp / Hand-Disrupt / Tool-Stadium-Break / Bounce-Self / Energy-Disrupt
  //   4 = Turn Buffs (Damage Boost / Team Shield / Coin Guarantee / Extra Point / Survive / Draco+1)
  //   6 = Energy Ramp / Energy Move / Retreat Discount / Self-Switch / Evolution / Cost Reduction
  //   8 = Info-only (Hand Scope / Pokédex / Looker / Hiker / Morty / Rotom Dex) -> does NOT illegally draw!
  const mk = (kind, sub, val, names = [], cond = 0) => {
    const [h1, h2] = packHashes(names);
    return { isFossil: 0, kind, sub, cond, val, h1, h2 };
  };

  switch (nameEn) {
    // --- KIND 1: DRAW / SEARCH ---
    case "professor's research": return mk(1, 1, 2);
    case 'poké ball': return mk(1, 2, 1); // 1 random Basic
    case 'copycat': return mk(1, 3, 0); // shuffle hand, draw = opp hand
    case 'iono': return mk(1, 4, 0); // both shuffle, redraw same
    case 'pokémon communication': return mk(1, 5, 1); // swap 1 poke hand <-> deck
    case 'may': return mk(1, 5, 2); // +2 random pokes, put 2 pokes back
    case 'lisia': return mk(1, 6, 2); // 2 Basic HP<=50
    case 'juliana': return mk(1, 7, 1); // 1 Stage 2
    case 'serena': return mk(1, 8, 1); // 1 Mega ex
    case "serena's choice": return mk(1, 9, 3); // top 3 pick 1
    case 'arven': return mk(1, 10, 1); // flip: heads Item, tails Tool
    case 'order pad': return mk(1, 11, 1); // flip: heads Item
    case 'calem': return mk(1, 12, 1); // draw 1 per Mega ex in play
    case 'cabbie': return mk(1, 13, 1); // 1 Stadium
    case 'sightseer': return mk(1, 14, 4); // top 4 all Stage 1
    case 'traveling merchant': return mk(1, 15, 4); // top 4 all Tools
    case 'puppy-loving girl': return mk(1, 16, 4); // top 4 all Puppy Pile
    case 'mythical slab': return mk(1, 17, 1); // top 1 if [P] Pokémon -> hand
    case 'clemont': return mk(1, 18, 2, ['Magneton', 'Heliolisk', "Clemont's Backpack"]);
    case 'team galactic grunt': return mk(1, 18, 1, ['Glameow', 'Stunky', 'Croagunk']);
    case 'gladion': return mk(1, 18, 1, ['Type: Null', 'Silvally']);
    case 'poké mart guy': return mk(1, 18, 2, ['Super Potion', 'Max Repel', 'Full Heal']);
    case "team rocket's researcher": return mk(1, 19, 1); // flip until tails, search Team Rocket poke
    case 'celestic town elder': return mk(1, 20, 1); // 1 Basic from discard
    case 'fishing net': return mk(1, 20, 2); // 1 Basic [W] from discard
    case 'fisher': return mk(1, 20, 3); // flip 3 coins, [W] poke from discard per heads
    case "team rocket's thieving machine": return mk(1, 21, 1); // random Item from opp discard
    case 'maintenance': return mk(1, 22, 1); // shuffle 2 hand -> draw 1
    case 'penny': return mk(1, 23, 1); // copy random opp deck Supporter

    // --- KIND 2: HEAL / CURE / DAMAGE TRANSFER ---
    case 'potion': return mk(2, 1, 20);
    case 'erika': return mk(2, 2, 50, [], TYPE_CODE.g + 1); // 1 [G] poke
    case 'irida': return mk(2, 3, 40); // ALL pokes with [W] energy!
    case 'lillie': return mk(2, 4, 60); // 1 Stage 2
    case 'pokémon center lady': return mk(2, 5, 30); // 1 poke +30 & cure all status
    case 'full heal': return mk(2, 6, 0); // Active cure all status
    case 'big malasada': return mk(2, 7, 10); // Active +10 & cure 1 status
    case 'lucky ice pop': return mk(2, 8, 20); // Active +20, coin heads return to hand
    case 'sweet honey': return mk(2, 9, 20); // flip until tails * 20
    case 'super potion': return mk(2, 10, 40); // +40 & discard 1 energy (needs energy!)
    case 'diantha': return mk(2, 11, 90, [], TYPE_CODE.p + 1); // [P] w/ >=2E: +90 & discard 2E
    case 'mallow': return mk(2, 12, 999, ['Shiinotic', 'Tsareena']); // full heal & discard all energy
    case 'whitney': return mk(2, 13, 60, ['Miltank']); // +60 & cure Sleep/Paralyze/Confuse
    case 'marlon': return mk(2, 14, 70, ['Carracosta', 'Jellicent']);
    case 'eevee bag': return mk(2, 15, 20); // Choice: +10 dmg for Eevee evos OR heal 20 all Eevee evos!
    case 'acerola': return mk(2, 16, 40, ['Palossand', 'Mimikyu']); // Move 40 dmg to opp Active!

    // --- KIND 3: DISRUPTION / SWITCH OPP / HAND / TOOL / BOUNCE ---
    case 'sabrina': return mk(3, 1, 1); // opp switches Active (opp chooses)
    case 'cyrus': return mk(3, 2, 1); // pull damaged opp Bench
    case "blue's provocation": return mk(3, 3, 1, ['Venusaur', 'Charizard', 'Blastoise', 'Pidgeot']); // pull opp Bench if named in play
    case 'lana': return mk(3, 3, 1, ['Araquanid']); // pull opp Bench if Araquanid in play
    case 'repel': return mk(3, 4, 0); // switch opp Active Basic
    case 'max repel': return mk(3, 4, 2); // switch opp Active Stage 2!
    case 'red card': return mk(3, 5, 3); // opp shuffle hand draw 3
    case 'mars': return mk(3, 6, 0); // opp shuffle hand draw remaining points
    case 'nasty notice': return mk(3, 7, 4); // opp discards down to 4
    case 'silver': return mk(3, 8, 1); // shuffle 1 opp Supporter into deck
    case 'prank spinner': return mk(3, 9, 1); // shuffle 1 random card from either hand
    case 'guzma': return mk(3, 10, 1); // discard all opp Tools
    case 'elesa': return mk(3, 10, 2); // return ALL Tools (both sides) to hand
    case 'field blower': return mk(3, 11, 1); // discard 1 Tool or Stadium
    case 'team rocket grunt': return mk(3, 12, 99); // flip until tails discard opp Active energy
    case 'hitting hammer': return mk(3, 12, 2); // flip 2 both heads discard 1 opp Active energy
    case 'squirt bottle': return mk(3, 12, 1, [], TYPE_CODE.r + 1); // discard 1 [R] energy from opp Active
    case 'piers': return mk(3, 13, 2, ['Galarian Obstagoon']); // if Galarian Obstagoon -> discard 2 opp Active energy
    case 'team star grunt': return mk(3, 14, 1); // discard 1 energy from opp Pokémon w/ Ability
    case "team rocket's master plan": return mk(3, 15, 1); // Confuse opp + coin tails Confuse self
    case "team rocket's goo-zooka": return mk(3, 16, 1); // opp Active retreat +1 next turn
    case 'pokémon flute': return mk(3, 17, 1); // put Basic from opp discard onto opp Bench
    case "team rocket's boss": return mk(3, 18, 1); // put Basics from opp hand onto opp Bench
    case 'psychic': return mk(3, 19, 1); // if Active has Psychic atk -> move opp bench energy to opp Active
    case 'koga': return mk(3, 20, 1, ['Muk', 'Weezing']); // bounce Active Muk/Weezing to hand
    case 'budding expeditioner': return mk(3, 20, 1, ['Mew ex']); // bounce Active Mew ex to hand
    case 'ilima': return mk(3, 20, 2, [], TYPE_CODE.c + 1); // bounce damaged [C] to hand
    case 'parasol lady': return mk(3, 20, 3, [], TYPE_CODE.w + 1); // bounce non-ex [W] to hand
    case 'professor turo': return mk(3, 20, 4); // shuffle 1 Future Pokémon into deck

    // --- KIND 4: TURN BUFFS (DMG / SHIELD / COIN / EXTRA POINT / SURVIVE) ---
    case 'giovanni': return mk(4, 1, 10); // +10 any
    case 'red': return mk(4, 2, 20); // +20 vs ex
    case 'korrina': return mk(4, 3, 30, [], TYPE_CODE.f + 1); // [F] +30 vs ex
    case 'blaine': return mk(4, 4, 30, ['Ninetales', 'Rapidash', 'Magmar']);
    case 'cynthia': return mk(4, 4, 50, ['Garchomp', 'Togekiss']);
    case 'sophocles': return mk(4, 4, 30, ['Alolan Golem', 'Vikavolt', 'Togedemaru']);
    case 'hau': return mk(4, 4, 30, ['Decidueye ex', 'Incineroar ex', 'Primarina ex']);
    case 'nemona': return mk(4, 5, 80, ['Pawmot']); // Pawmot +80 vs ex
    case "clemont's backpack": return mk(4, 4, 20, ['Magneton', 'Heliolisk']);
    case 'lorelei': return mk(4, 4, 30, ['Dewgong', 'Cloyster', 'Lapras']);
    case 'blue': return mk(4, 6, 10); // all own -10 next turn
    case 'adaman': return mk(4, 6, 20, [], TYPE_CODE.m + 1); // all own [M] -20
    case 'beast wall': return mk(4, 7, 20); // if opp 0 pts -> all own UB -20
    case 'jasmine': return mk(4, 8, 50, ['Steelix', 'Skarmory ex']); // named -50
    case 'cheren': return mk(4, 9, 100, ['Watchog', 'Stoutland']); // named -100 vs ex
    case 'will': return mk(4, 10, 1); // next coin flip guaranteed heads
    case 'iris': return mk(4, 11, 1, ['Haxorus']); // +1 point if Haxorus KOs opp Active
    case 'hala': return mk(4, 12, 10, ['Hariyama', 'Crabominable']); // survive KO at 10 HP
    case 'drayden': return mk(4, 13, 1); // Draco Meteor +1 hit this turn

    // --- KIND 6: ENERGY / RETREAT / SWITCH / EVO / COST REDUCTION ---
    case 'rare candy': return mk(6, 1, 99); // Basic -> Stage 2
    case 'quick-grow extract': return mk(6, 2, 0, [], TYPE_CODE.g + 1); // evolve [G] from deck
    case 'wallace': return mk(6, 2, 50, [], TYPE_CODE.w + 1); // evolve [W] HP<=50 from deck
    case 'x speed': return mk(6, 3, 1); // retreat -1
    case 'leaf': return mk(6, 3, 2); // retreat -2
    case 'lyra': return mk(6, 4, 1); // switch damaged Active with Bench
    case 'skyla': return mk(6, 4, 2); // switch Stage 1 Active with Bench
    case 'rising star': return mk(6, 4, 3); // if 3+ types in play -> switch Active with Bench
    case 'misty': return mk(6, 5, 99, [], TYPE_CODE.w + 1); // flip until tails attach [W]
    case 'electric generator': return mk(6, 6, 1, [], TYPE_CODE.l + 1); // flip 1 attach [L] to Bench [L]
    case 'wally': return mk(6, 7, 1); // attach 1 [C] to Stage 2
    case 'flame patch': return mk(6, 8, 1, [], TYPE_CODE.r + 1); // 1 [R] from discard to Active [R]
    case 'lusamine': return mk(6, 9, 2); // if opp >=1 pt -> 2 from discard to UB
    case 'volkner': return mk(6, 10, 2, ['Electivire', 'Luxray']); // 2 [L] from discard to named
    case 'professor sada': return mk(6, 11, 3); // 3 from discard to Ancient
    case 'brock': return mk(6, 12, 1, ['Golem', 'Onix']); // +1 [F] from Zone to named
    case 'kiawe': return mk(6, 13, 2, ['Alolan Marowak', 'Turtonator']); // +2 [R] AND END TURN!
    case 'fantina': return mk(6, 12, 1, ['Drifblim', 'Mismagius']); // +1 [P] to each named
    case 'rika': return mk(6, 12, 2, ['Whiscash', 'Paldean Clodsire']); // +2 [F] to named
    case 'dawn': return mk(6, 14, 1); // move 1 energy Bench -> Active
    case 'elemental switch': return mk(6, 14, 2); // move 1 [R]/[W]/[L] Bench -> Active
    case 'lt. surge': return mk(6, 15, 1, ['Raichu', 'Electrode', 'Electabuzz']); // move all [L] Bench -> Active named
    case 'juggler': return mk(6, 15, 2); // if 3+ energy types -> move all Bench -> Active
    case 'genome converter y': return mk(6, 15, 1, ['Mega Mewtwo Y ex']); // move all [P] 1 Bench -> Active Mega Mewtwo Y ex
    case 'barry': return mk(6, 16, 2, ['Snorlax', 'Heracross', 'Staraptor']); // attacks cost 2 less [C] this turn!

    // --- KIND 8: PURE INFO / DECK PEEK (DOES NOT DRAW FREE CARDS!) ---
    case 'hand scope':
    case 'pokédex':
    case 'looker':
    case 'hiker':
    case 'morty':
    case 'rotom dex':
      return mk(8, 1, 0);

    default:
      throw Error(`UNCOMPILED TRAINER: ${nameEnRaw} (${subtype}) => ${eff}`);
  }
}

// =========================================================================
// MAIN BUILD PIPELINE
// =========================================================================
const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
const dbArr = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const dbById = new Map();
for (const entry of dbArr) {
  const kind = Object.keys(entry)[0];
  const o = entry[kind];
  const m = String(o.id || '').trim().replace(/\s+/g, '-').match(/^([A-Za-z0-9-]+)-(\d+)$/);
  const cid = m ? `${m[1]}-${m[2].padStart(3, '0')}` : o.id;
  dbById.set(cid, { kind, ...o });
}

// Build evolution parent map across all 4,577 cards for strict evo_group resolution
const evoParent = new Map();
for (const c of cards) {
  if (c.type !== 'pokemon' && c.subtype !== 'fossil') continue;
  const from = normKey(c.evolvesFrom);
  if (!from) continue;
  for (const k of [normKey(c.limitName), normKey(c.nameEn), normKey(c.name)]) {
    if (k && !evoParent.has(k)) evoParent.set(k, from);
  }
}
// Eevee ex evolves into anything evolving from Eevee!
function resolveEvoGroup(c) {
  const isFossil = c.subtype === 'fossil' || /fossil|old amber/i.test(String(c.nameEn || ''));
  if (c.type !== 'pokemon' && !isFossil) return 0;
  const stage = c.stage === 'stage2' ? 2 : c.stage === 'stage1' ? 1 : 0;
  let cur = normKey(c.limitName || c.nameEn || c.name);
  if (cur === 'eevee ex') cur = 'eevee';
  if (stage > 0 && c.evolvesFrom) {
    cur = normKey(c.evolvesFrom);
    for (let hop = 0; hop < 4; hop++) {
      const nxt = evoParent.get(cur);
      if (!nxt || nxt === cur) break;
      cur = nxt;
    }
  }
  return nameHash16(cur);
}

const templates = [];
const tplKeyToIdx = new Map();
const cardMap = {};

const seenAtks = new Set();
const seenAbs = new Set();
const seenTrns = new Set();

for (const c of cards) {
  const d = dbById.get(c.id);
  const nameEn = c.limitName || c.nameEn || d?.name || c.name || '';
  const baseEn = baseStripEx(nameEn);
  const nh = nameHash16(nameEn);
  const efHash = nameHash16(c.evolvesFrom || '');

  let isPokemon = c.type === 'pokemon' ? 1 : 0;
  let isFossil = 0, isSupporter = 0, isItem = 0, isTool = 0, isStadium = 0;
  let stage = 0, evoGroup = 0, typeCode = 9, type2Code = 255, weakCode = 255, hp = 0, retreat = 0, prize = 1;
  let isMega = 0, isEx = 0, isUb = 0, isAnc = 0, isFut = 0, isTr = 0;
  let hasSweets = 0, hasPuppy = 0, hasPsychic = 0, hasDraco = 0, isEeveeEvo = 0;
  let a1 = { cost: 255, flags: 0, dmg: 0, op1: 0, val1: 0, op2: 0, val2: 0, aux: 0 };
  let a2 = { cost: 255, flags: 0, dmg: 0, op1: 0, val1: 0, op2: 0, val2: 0, aux: 0 };
  let ab = { abOp: 0, abCond: 0, abVal: 0, abAux: 0 };
  let trn = { isFossil: 0, kind: 0, sub: 0, cond: 0, val: 0, h1: 0, h2: 0 };

  if (c.type === 'pokemon') {
    stage = c.stage === 'stage2' ? 2 : c.stage === 'stage1' ? 1 : 0;
    evoGroup = resolveEvoGroup(c);
    typeCode = TYPE_CODE[String(c.types?.[0] || d?.energy_type || 'colorless').toLowerCase()] ?? 9;
    type2Code = c.types?.[1] ? (TYPE_CODE[String(c.types[1]).toLowerCase()] ?? 255) : 255;
    weakCode = c.weakness ? (TYPE_CODE[String(c.weakness).toLowerCase()] ?? 255) : 255;
    hp = Number(d?.hp || c.hp || 60);
    retreat = Math.min(4, Math.max(0, Number(d?.retreat_cost?.length ?? c.retreat ?? 1)));
    isMega = /^mega\s/i.test(nameEn) || (c.tags || []).includes('mega') ? 1 : 0;
    isEx = /\sex$/i.test(nameEn) || isMega ? 1 : 0;
    prize = isMega ? 3 : isEx ? 2 : 1;
    isUb = ULTRA_BEAST_NAMES.has(baseEn) || (c.tags || []).includes('ultra_beast') ? 1 : 0;
    isAnc = ANCIENT_NAMES.has(baseEn) || (c.tags || []).includes('ancient') ? 1 : 0;
    isFut = FUTURE_NAMES.has(baseEn) || (c.tags || []).includes('future') ? 1 : 0;
    isTr = /^team rocket['’]s\s/i.test(nameEn) || (c.tags || []).includes('team_rocket') ? 1 : 0;
    isEeveeEvo = normKey(c.evolvesFrom) === 'eevee' ? 1 : 0;

    // Dual-type Urshifu secondary types
    if (d?.ability?.effect) {
      const tm = d.ability.effect.match(/it is \[([A-Z])\] and \[([A-Z])\] type/i);
      if (tm) {
        typeCode = parseEnergyTypeLetter(tm[1]);
        type2Code = parseEnergyTypeLetter(tm[2]);
      }
      ab = compileAbility(d.ability.effect, d.ability.title);
      seenAbs.add(d.ability.effect.trim());
    }

    let dbAtks = d?.attacks || [];
    // Handle SP1-028/029/030 RGB Mew (not in database.json)
    if (!d && (c.id === 'SP1-028' || c.id === 'SP1-029' || c.id === 'SP1-030')) {
      dbAtks = [{
        title: 'Psychic',
        energy_required: ['Psychic', 'Colorless'],
        fixed_damage: 30,
        effect: "This attack does 20 more damage for each Energy attached to your opponent's Active Pokémon."
      }];
    }
    dbAtks.forEach((da, i) => {
      const tLow = normKey(da.title);
      if (tLow === 'sweets relay') hasSweets = 1;
      if (tLow === 'puppy pile') hasPuppy = 1;
      if (tLow === 'psychic') hasPsychic = 1;
      if (tLow === 'draco meteor') hasDraco = 1;
      const compiled = compileAttack(da.effect, da.fixed_damage, da.energy_required?.length || 0, da.title);
      if (da.effect?.trim()) seenAtks.add(da.effect.trim());
      if (i === 0) a1 = compiled;
      else if (i === 1) a2 = compiled;
    });
  } else {
    const enEff = d?.effect || d?.text || '';
    trn = compileTrainer(nameEn, c.subtype, enEff);
    seenTrns.add(`${normKey(nameEn)}|${c.subtype}`);
    if (trn.isFossil) {
      isPokemon = 1;
      isFossil = 1;
      stage = 0;
      evoGroup = resolveEvoGroup(c);
      typeCode = 9;
      hp = 40;
      retreat = 4;
      prize = 1;
    } else {
      isSupporter = c.subtype === 'supporter' ? 1 : 0;
      isItem = c.subtype === 'item' ? 1 : 0;
      isTool = c.subtype === 'tool' ? 1 : 0;
      isStadium = c.subtype === 'stadium' ? 1 : 0;
    }
  }

  const meta = (
    (stage & 0xff)
    | ((evoGroup & 0xffff) << 8)
    | (isSupporter << 24)
    | (isItem << 25)
    | (isFossil << 26)
    | (isTool << 27)
    | (isStadium << 28)
    | (isMega << 29)
    | (isEx << 30)
    | (isUb << 31)
  ) | 0;

  const tagsExtra = (
    (isAnc << 0)
    | (isFut << 1)
    | (isTr << 2)
    | (hasSweets << 3)
    | (hasPuppy << 4)
    | (hasPsychic << 5)
    | (hasDraco << 6)
    | (isEeveeEvo << 7)
    | ((nh & 0xffff) << 8)
    | ((type2Code & 0xff) << 24)
  ) | 0;

  const retPrize = (
    (retreat & 0xff)
    | ((prize & 0xff) << 8)
    | ((efHash & 0xffff) << 16)
  ) | 0;

  const a1CostFlags = ((a1.cost & 0xff) | ((a1.flags & 0xffff) << 8)) | 0;
  const a1Ops = ((a1.op1 & 0xff) | ((a1.op2 & 0xff) << 8) | ((a1.aux & 0xffff) << 16)) | 0;
  const a2CostFlags = ((a2.cost & 0xff) | ((a2.flags & 0xffff) << 8)) | 0;
  const a2Ops = ((a2.op1 & 0xff) | ((a2.op2 & 0xff) << 8) | ((a2.aux & 0xffff) << 16)) | 0;
  const abPacked = ((ab.abOp & 0xff) | ((ab.abCond & 0xff) << 8) | ((ab.abAux & 0xffff) << 16)) | 0;
  const trnPacked = ((trn.kind & 0xff) | ((trn.sub & 0xff) << 8) | ((trn.cond & 0xffff) << 16)) | 0;

  // 23-int canonical template (slot_id=[23], bonus_q=[24] added per deck instance at runtime!)
  const tpl = [
    isPokemon, meta, tagsExtra, typeCode, weakCode, hp, retPrize,
    a1CostFlags, a1.dmg | 0, a1Ops, a1.val1 | 0, a1.val2 | 0,
    a2CostFlags, a2.dmg | 0, a2Ops, a2.val1 | 0, a2.val2 | 0,
    abPacked, ab.abVal | 0,
    trnPacked, trn.val | 0, trn.h1 | 0, trn.h2 | 0
  ];
  const key = tpl.join(',');
  let idx = tplKeyToIdx.get(key);
  if (idx === undefined) {
    idx = templates.length;
    tplKeyToIdx.set(key, idx);
    templates.push(tpl);
  }
  cardMap[c.id] = idx;
}

const outDoc = {
  version: 3,
  stride: 28,
  totalCards: cards.length,
  uniqueTemplates: templates.length,
  coverage: {
    uniqueAttackEffects: seenAtks.size,
    uniqueAbilityEffects: seenAbs.size,
    uniqueTrainers: seenTrns.size,
    unimplemented: 0
  },
  specialHashes: {
    arceus: nameHash16('Arceus'),
    arceusEx: nameHash16('Arceus ex'),
    latias: nameHash16('Latias'),
    regirock: nameHash16('Regirock'),
    regice: nameHash16('Regice'),
    registeel: nameHash16('Registeel'),
    uxie: nameHash16('Uxie'),
    azelf: nameHash16('Azelf'),
    tandemaus: nameHash16('Tandemaus'),
    maushold: nameHash16('Maushold'),
    wishiwashi: nameHash16('Wishiwashi'),
    wishiwashiEx: nameHash16('Wishiwashi ex'),
    poochyena: nameHash16('Poochyena'),
    sweetHoney: nameHash16('Sweet Honey'),
    raboot: nameHash16('Raboot'),
    unown: nameHash16('Unown')
  },
  templates,
  cards: cardMap
};

fs.writeFileSync(OUT_PATH, JSON.stringify(outDoc));
const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
console.log('Compiled Exact-Mechanics v3 successfully:', {
  totalCards: outDoc.totalCards,
  uniqueTemplates: outDoc.uniqueTemplates,
  ...outDoc.coverage,
  fileSizeKB: kb
});
