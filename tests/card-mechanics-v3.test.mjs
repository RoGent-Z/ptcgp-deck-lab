import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { instantiateFastSim } from '../public/battle/fastsim-runtime.mjs';
import { encodeCardForFastSim, encodeDeckEnergyMask, findDeckEnergyMismatches, packAttackEnergyCost, setCardMechanicsDb } from '../public/app/core.mjs';
import { areDecksIdentical } from '../public/app/battle.mjs';

const cardsAll = JSON.parse(await readFile(new URL('../public/data/cards.json', import.meta.url), 'utf8'));
const cardById = new Map(cardsAll.map((c) => [c.id, c]));
const mechanicsDb = JSON.parse(await readFile(new URL('../public/data/card-mechanics.json', import.meta.url), 'utf8'));
setCardMechanicsDb(mechanicsDb);
const fastSim = await instantiateFastSim(await readFile(new URL('../public/battle/fastsim.wasm', import.meta.url)));
const v3Model = JSON.parse(await readFile(new URL('../public/battle/models/v3.json', import.meta.url), 'utf8'));
const W = v3Model.weights;

function enc(id) {
  const c = cardById.get(id);
  assert.ok(c, `Card ${id} must exist in cards.json`);
  const e = encodeCardForFastSim(c, 0, cardById);
  assert.ok(Array.isArray(e.v3Tpl) && e.v3Tpl.length === 26, `Card ${id} must have 26-int v3Tpl`);
  return e;
}

// Helper: clone a Stage 1/2 card's exact v3Tpl as stage=0 for deterministic Turn-2 mechanical isolation
function asBasicClone(id, overrides = {}) {
  const base = enc(id);
  const tpl = [...base.v3Tpl];
  tpl[1] = (tpl[1] & ~0xff) | 0; // stage = 0
  if (overrides.hp != null) tpl[5] = overrides.hp;
  if (overrides.a1Cost != null) {
    tpl[7] = (tpl[7] & ~0xff) | (overrides.a1Cost & 0xff);
    if (overrides.a1Ecost == null) tpl[23] = 0; // clear colored req when isolating at synthetic low cost
  }
  if (overrides.a2Cost != null) {
    tpl[12] = (tpl[12] & ~0xff) | (overrides.a2Cost & 0xff);
    if (overrides.a2Ecost == null) tpl[24] = 0;
  }
  if (overrides.a1Ecost != null) tpl[23] = overrides.a1Ecost;
  if (overrides.a2Ecost != null) tpl[24] = overrides.a2Ecost;
  if (overrides.deckEnergyMask != null) {
    return { ...base, stage: 0, hp: tpl[5], a1Cost: tpl[7] & 0xff, a2Cost: tpl[12] & 0xff, a1Ecost: tpl[23], a2Ecost: tpl[24], deckEnergyMask: overrides.deckEnergyMask, v3Tpl: tpl };
  }
  return { ...base, stage: 0, hp: tpl[5], a1Cost: tpl[7] & 0xff, a2Cost: tpl[12] & 0xff, a1Ecost: tpl[23], a2Ecost: tpl[24], v3Tpl: tpl };
}

function withEnergyMask(cards, energyList) {
  const mask = encodeDeckEnergyMask(energyList);
  return cards.map((c) => ({ ...c, deckEnergyMask: mask }));
}

test('Exact-Mechanics v4: all 4,577 cards compiled with 0 unimplemented effects, typed costs, and clean cards.json text', () => {
  assert.equal(cardsAll.length, 4577);
  assert.equal(mechanicsDb.version, 4);
  assert.equal(mechanicsDb.totalCards, 4577);
  assert.equal(mechanicsDb.coverage.unimplemented, 0);
  assert.ok(mechanicsDb.coverage.uniqueAttackEffects >= 588);
  assert.ok(mechanicsDb.coverage.uniqueAbilityEffects >= 164);
  assert.ok(mechanicsDb.coverage.uniqueTrainers >= 177);

  for (const c of cardsAll) {
    const idx = mechanicsDb.cards[c.id];
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < mechanicsDb.templates.length, `Missing v4 template for ${c.id}`);
    const tpl = mechanicsDb.templates[idx];
    assert.equal(tpl.length, 26, `Invalid template length for ${c.id}`);

    // Verify clean Chinese text (zero garbled MT / missing-number regressions)
    const texts = [
      c.effect || '',
      ...(c.attacks || []).map((a) => a.effect || ''),
      ...(c.abilities || []).map((a) => a.effect || '')
    ];
    for (const t of texts) {
      assert.ok(!/基礎\|基礎/.test(t), `Garbled text in ${c.id}: ${t}`);
      assert.ok(!/抽出張卡/.test(t), `Missing number in ${c.id}: ${t}`);
      assert.ok(!/對手的神奇寶貝|翻轉硬幣|你的這個回合/.test(t), `MT artifact in ${c.id}: ${t}`);
    }
  }
});

test('Exact-Mechanics v3: compound attacks preserve BOTH effects (zero dropped secondary effects)', () => {
  // 1. Palkia ex (A2-049): 150 dmg + 20 all opp bench (op1=8) + discard 3 energy (op2=10)
  const palkia = enc('A2-049');
  assert.equal(palkia.a2Dmg, 150);
  assert.equal(palkia.a2Op1, 8);
  assert.equal(palkia.a2Val1 & 0xff, 1); // all opp bench
  assert.equal((palkia.a2Val1 >> 8) & 0xff, 20);
  assert.equal(palkia.a2Op2, 10);
  assert.equal(palkia.a2Val2 & 0xff, 3);

  // 2. Mega Blaziken ex (B1-036): 120 dmg + discard 1 [R] (op1=10) + Burn (op2=1, SM_BURN=4)
  const mBlaziken = enc('B1-036');
  assert.equal(mBlaziken.a1Dmg, 120);
  assert.equal(mBlaziken.a1Op1, 10);
  assert.equal(mBlaziken.a1Val1 & 0xff, 1);
  assert.equal(mBlaziken.a1Op2, 1);
  assert.equal(mBlaziken.a1Val2 & 0xff, 4); // SM_BURN = 4

  // 3. Mega Sceptile ex (B3-008): 130 dmg + discard 1 [G] (op1=10) + Poison (op2=1, SM_POISON=1)
  const mSceptile = enc('B3-008');
  assert.equal(mSceptile.a1Dmg, 130);
  assert.equal(mSceptile.a1Op1, 10);
  assert.equal(mSceptile.a1Val1 & 0xff, 1);
  assert.equal(mSceptile.a1Op2, 1);
  assert.equal(mSceptile.a1Val2 & 0xff, 1); // SM_POISON = 1

  // 4. Chien-Pao ex (B2a-037): 130 pure snipe (op1=8) + discard ALL energy (op2=10, val=99)
  const chienPao = enc('B2a-037');
  assert.equal(chienPao.a2Op1, 8);
  assert.equal((chienPao.a2Val1 >> 8) & 0xff, 130);
  assert.equal(chienPao.a2Op2, 10);
  assert.equal(chienPao.a2Val2 & 0xff, 99);

  // 5. Dewgong (C1-033): 60 damage to 2 of opponent's Pokémon (op1=8, mode=14, dmg=60)
  const dewgong = enc('C1-033');
  assert.equal(dewgong.a1Op1, 8);
  assert.equal(dewgong.a1Val1 & 0xff, 14);
  assert.equal((dewgong.a1Val1 >> 8) & 0xff, 60);

  // 6. Mega Kangaskhan ex (B2-127): Double attack (op1=19, mode=8, secondHit=40)
  const mKang = enc('B2-127');
  assert.equal(mKang.a1Op1, 19);
  assert.equal(mKang.a1Val1 & 0xff, 8);

  // 7. Rampardos (A2-089): 130 dmg + 50 recoil ONLY if KO (AF_ONLY_IF_KO_RECOIL = 1<<12)
  const rampardos = enc('A2-089');
  assert.equal(rampardos.a1Dmg, 130);
  assert.equal(rampardos.a1Op1, 9);
  assert.equal(rampardos.a1Val1 & 0xff, 50);
  assert.ok((((rampardos.v3Tpl[7] >>> 8) & 0xffff) & (1 << 12)) !== 0, 'Rampardos must set AF_ONLY_IF_KO_RECOIL');

  // 8. Reversed / previously broken cards verified exact
  const snorlax = enc('A2a-063');
  assert.equal(snorlax.a1Op1, 2); // Self status (Sleep), NOT op1=1 (opponent status)!
  assert.equal(snorlax.a1Val1 & 0xff, 1);

  const clodsire = enc('A2b-048');
  assert.equal(clodsire.a1Op1, 7); // Conditional +60 if opponent Poisoned, NOT inflicting Poison!
  assert.equal(clodsire.a1Val1 & 0xff, 8);
  assert.equal((clodsire.a1Val1 >> 8) & 0xff, 60);

  const guzzlord = enc('A3a-043');
  assert.equal(guzzlord.a1Op1, 11); // Discard opp energy until tails!
  assert.equal(guzzlord.a1Val1 & 0xff, 3);

  const moltres = enc('A1-047');
  assert.equal(moltres.a1Op1, 13); // Flip 3 coins -> attach to bench (mode=3)
  assert.equal((moltres.a1Val1 >> 8) & 0xff, 3);

  const c1Mew = enc('C1-057');
  assert.equal(c1Mew.a1Op1, 13);
  assert.equal((c1Mew.a1Val1 >> 8) & 0xff, 3);

  const zardA2b = enc('A2b-010');
  assert.equal(zardA2b.a1Op1, 13); // Stoke attaches 3 energy to self!
  assert.equal(zardA2b.a1Val1 & 0xff, 3);
  assert.equal((zardA2b.a1Val1 >> 8) & 0xff, 0);

  // 9. Abilities & Trainers exact mappings
  assert.equal(enc('A2b-035').abOp, 3);
  assert.equal(enc('A2b-035').abVal, 4); // Giratina ex: +1 energy & END TURN
  assert.equal(enc('P-A-037').abOp, 7);
  assert.equal(enc('P-A-037').abVal, 120); // Cresselia ex: heal 20 on attach (NOT Darkrai chip!)
  assert.equal(enc('A3a-031').abOp, 17);
  assert.equal(enc('A3a-031').abVal, 6); // Claydol: blocks ALL healing
  assert.equal(enc('B2-097').abOp, 17);
  assert.equal(enc('B2-097').abVal, 7); // Alolan Muk: Basic Pokémon have no Abilities
  assert.equal(enc('A1a-046').abOp, 15);
  assert.equal(enc('A1a-046').abVal, 3); // Aerodactyl ex: Active evo lock

  assert.equal(enc('C1-124').trainerKind, 5);
  assert.equal(enc('C1-124').effectVal, 17); // Light Ball (Pikachu ex +30)
  assert.equal(enc('B1-219').trainerKind, 5);
  assert.equal(enc('B1-219').effectVal, 11); // Heavy Helmet (retreat>=3 -20 dmg, NOT Rocky Helmet)
  assert.equal(enc('B2-147').trainerKind, 5);
  assert.equal(enc('B2-147').effectVal, 14); // Protective Poncho (bench immunity)
  assert.equal(enc('B2-148').trainerKind, 5);
  assert.equal(enc('B2-148').effectVal, 13); // Metal Core Barrier ([M] -50 for 1 turn)
  assert.equal(enc('A3-148').trainerKind, 2);
  assert.equal(enc('A3-148').trainerSub, 16); // Acerola: move 40 dmg (NOT bounce!)
  assert.equal(enc('A2a-072').trainerKind, 2);
  assert.equal(enc('A2a-072').trainerSub, 3); // Irida: heal 40 ALL own mons with energy
  assert.equal(enc('P-A-008').trainerKind, 8); // Pokédex: info peek (NOT free draw!)
});

test('Live WASM Replay: Mega Blaziken ex executes BOTH energy discard AND Burn checkup damage', () => {
  const blaz = asBasicClone('B1-036', { a1Cost: 1 });
  const target = asBasicClone('A1-211', { hp: 220, a1Cost: 5 }); // High-HP punching bag
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(blaz),
    enemy: Array(20).fill(target),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10001
  });
  const atkStep = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 120);
  assert.ok(atkStep, 'Mega Blaziken ex must execute 120-dmg attack');
  assert.equal(atkStep.board[0].energy, 0, 'Mega Blaziken ex must discard 1 energy from itself');
  // Burn checkup step (kind=12, reason=2, dmg=20) MUST fire right after on opponent!
  const burnStep = rep.steps.find((s) => s.kind === 12 && s.actor === 1 && (s.aux2 & 0xf) === 2 && s.aux1 === 20);
  assert.ok(burnStep, 'Mega Blaziken ex MUST inflict Burn and trigger 20 Burn checkup damage!');
});

test('Live WASM Replay: Mega Sceptile ex executes BOTH energy discard AND Poison checkup damage', () => {
  const scep = asBasicClone('B3-008', { a1Cost: 1 });
  const target = asBasicClone('A1-211', { hp: 220, a1Cost: 5 });
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(scep),
    enemy: Array(20).fill(target),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10002
  });
  const atkStep = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 130);
  assert.ok(atkStep, 'Mega Sceptile ex must execute 130-dmg attack');
  assert.equal(atkStep.board[0].energy, 0, 'Mega Sceptile ex must discard 1 energy from itself');
  const poisonStep = rep.steps.find((s) => s.kind === 12 && s.actor === 1 && (s.aux2 & 0xf) === 1 && s.aux1 === 10);
  assert.ok(poisonStep, 'Mega Sceptile ex MUST inflict Poison and trigger 10 Poison checkup damage!');
});

test('Live WASM Replay: Palkia ex Dimensional Storm hits 150, splashes 20 to Bench, AND discards 3 energy', () => {
  const palkia = asBasicClone('A2-049', { a1Cost: 5, a2Cost: 3 }); // Force Dimensional Storm at 3 energy
  const target = asBasicClone('A1-211', { hp: 220, a1Cost: 5 });
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(palkia),
    enemy: Array(20).fill(target),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10003
  });
  const dsStep = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 150);
  assert.ok(dsStep, 'Palkia ex must execute Dimensional Storm for 150 damage');
  assert.equal(dsStep.board[0].energy, 0, 'Palkia ex MUST discard 3 energy after Dimensional Storm (not stay at 3!)');
  const effTag = (dsStep.aux2 >> 9) & 0x3f;
  assert.equal(effTag, 6, 'Palkia ex must record bench splash effect tag (6)');
});

test('Live WASM Replay: Mew ex Genome Hacking copies opponent 250-dmg attack', () => {
  const mewEx = asBasicClone('A1a-032', { a1Cost: 5, a2Cost: 1 }); // Trigger Genome Hacking quickly
  const mZardY = asBasicClone('B1a-014', { hp: 300, a1Cost: 5 }); // Opponent has 250-dmg attack
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(mewEx),
    enemy: Array(20).fill(mZardY),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10004
  });
  const copyStep = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 250);
  assert.ok(copyStep, 'Mew ex Genome Hacking MUST copy Mega Charizard Y ex 250-dmg attack!');
  // Copied Crimson Dive also deals 50 recoil to Mew ex itself!
  assert.ok(copyStep.board[0].hp <= copyStep.board[0].maxHp - 50, 'Copied attack secondary recoil (50) must also execute!');
});

test('Live WASM Replay: Dewgong C1 deals 60 damage to 2 opponent Pokémon (NOT 0 damage)', () => {
  const dewgong = asBasicClone('C1-033', { a1Cost: 1 });
  const target = asBasicClone('A1-211', { hp: 150, a1Cost: 5 });
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(dewgong),
    enemy: Array(20).fill(target),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10005
  });
  const atkStep = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 === 60);
  assert.ok(atkStep, 'Dewgong C1 must deal 60 damage to Active (not 0)');
  const effNum = (atkStep.aux2 >> 15) & 0x3ff;
  assert.equal(effNum, 120, 'Dewgong C1 must hit 2 opponent Pokémon for 60×2 = 120 total damage');
});

test('Live WASM Replay: Giratina ex Broken-Space Bellow attaches 1 energy AND immediately ends turn', () => {
  const giratina = enc('A2b-035');
  const dummy = asBasicClone('A1-211', { hp: 200, a1Cost: 5 });
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(giratina),
    enemy: Array(20).fill(dummy),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10006
  });
  const abSteps = rep.steps.filter((s) => s.kind === 7 && s.actor === 0 && (s.aux2 & 0xff) === 3);
  assert.ok(abSteps.length > 0, 'Giratina ex must use Broken-Space Bellow');
  for (const ab of abSteps) {
    const sameTurnAtk = rep.steps.find((s) => s.turn === ab.turn && s.actor === 0 && s.kind === 10);
    assert.equal(sameTurnAtk, undefined, `Giratina ex MUST NOT attack on Turn ${ab.turn} after using Broken-Space Bellow!`);
  }
});

test('Live WASM Replay: Cresselia ex heals self on attach (NEVER deals Darkrai 20 dmg to opponent)', () => {
  const cress = enc('P-A-037');
  const dummy = asBasicClone('A1-211', { hp: 200, a1Cost: 5 });
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(cress),
    enemy: Array(20).fill(dummy),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10007
  });
  // Before any attack step happens (from Turn 1 onwards), opponent HP must remain full 200!
  const firstAtkIdx = rep.steps.findIndex((s) => s.kind === 10 && s.actor === 0);
  const preAtkSteps = (firstAtkIdx >= 0 ? rep.steps.slice(0, firstAtkIdx) : rep.steps).filter((s) => s.turn >= 1);
  assert.ok(preAtkSteps.length > 0);
  for (const st of preAtkSteps) {
    assert.equal(st.board[1].hp, 200, 'Cresselia ex attach trigger must NOT damage opponent like Darkrai ex');
  }
});

test('Live WASM Replay: Snorlax A2a-063 puts ITSELF to Sleep, NEVER opponent', () => {
  const snorlax = asBasicClone('A2a-063', { a1Cost: 1 });
  const dummy = asBasicClone('A1-211', { hp: 200, a1Cost: 5 });
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(snorlax),
    enemy: Array(20).fill(dummy),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10008
  });
  const atkStep = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 100);
  assert.ok(atkStep, 'Snorlax must execute Collapse attack');
  assert.ok(((atkStep.board[0].tool >> 8) & 8) !== 0, 'Snorlax MUST put ITSELF to Sleep (ST_SLEEP=8)');
  assert.equal((atkStep.board[1].tool >> 8) & 8, 0, 'Snorlax MUST NOT put opponent to Sleep');
});

test('Live WASM Replay: Claydol blocks ALL healing (Potion heals 0)', () => {
  const claydol = asBasicClone('A3a-031', { hp: 200, a1Cost: 1 }); // Deals 50
  const target = asBasicClone('A1-211', { hp: 200, a1Cost: 5 });
  const potion = enc('P-A-001');
  const rep = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(claydol),
    enemy: [...Array(10).fill(target), ...Array(10).fill(potion)],
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10009
  });
  const potionPlayed = rep.steps.some((s) => s.kind === 6 && s.actor === 1 && s.aux1 === 2);
  assert.equal(potionPlayed, false, 'Opponent must not be able to heal with Potion while Claydol is in play');
});

test('Live WASM Replay: Alolan Muk disables Oricorio Basic Safeguard so ex Pokémon can damage it', () => {
  const palkia = asBasicClone('A2-049', { a1Cost: 1 }); // 30-dmg attack from ex
  const oricorio = enc('A3-066');
  const aMuk = asBasicClone('B2-097', { hp: 140, a1Cost: 5 });

  // Without Alolan Muk: Palkia ex cannot damage Oricorio
  const repBlocked = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(palkia),
    enemy: Array(20).fill(oricorio),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10010
  });
  const dmgWithoutMuk = repBlocked.steps.filter((s) => s.kind === 10 && s.actor === 0 && s.aux1 > 0);
  assert.equal(dmgWithoutMuk.length, 0, 'Without Alolan Muk, Oricorio Safeguard must block Palkia ex damage');

  // With Alolan Muk on board: Palkia ex bypasses Oricorio Safeguard!
  const repWithMuk = fastSim({
    op: 'replay_game',
    deck: [...Array(10).fill(palkia), ...Array(10).fill(aMuk)],
    enemy: Array(20).fill(oricorio),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10011
  });
  const dmgWithMuk = repWithMuk.steps.some((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 30);
  assert.equal(dmgWithMuk, true, 'With Alolan Muk in play, Oricorio Basic Safeguard must be negated!');
});

test('Live WASM Replay: Light Ball boosts Pikachu ex by +30 and does NOT boost non-Pikachu ex', () => {
  const pika = asBasicClone('A1-096', { a1Cost: 1 }); // Circle Circuit 30*bench -> with 3 bench = 90, +30 Light Ball = 120
  const lightBall = enc('C1-124');
  const target = asBasicClone('A1-211', { hp: 250, a1Cost: 5 });
  const repPika = fastSim({
    op: 'replay_game',
    deck: [...Array(12).fill(pika), ...Array(8).fill(lightBall)],
    enemy: Array(20).fill(target),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10012
  });
  const boostedHit = repPika.steps.find((s) => s.kind === 10 && s.actor === 0 && (s.board[0].tool & 0xff) === 17 && s.aux1 >= 120);
  assert.ok(boostedHit, 'Light Ball MUST boost Pikachu ex attack damage by +30 (90 -> 120 with full bench)!');

  // Non-Pikachu ex (Palkia ex) cannot even equip Light Ball!
  const palkia = asBasicClone('A2-049', { a1Cost: 1 });
  const repOther = fastSim({
    op: 'replay_game',
    deck: [...Array(12).fill(palkia), ...Array(8).fill(lightBall)],
    enemy: Array(20).fill(target),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10013
  });
  const wrongEquip = repOther.steps.some((s) => s.kind === 6 && s.aux1 === 5 && s.aux2 === 17);
  assert.equal(wrongEquip, false, 'Light Ball must ONLY equip to Pikachu ex');
});

test('Live WASM Replay: Pokédex never draws free cards & Heavy Helmet reduces damage without Rocky Helmet recoil', () => {
  const dummy = asBasicClone('A1-211', { hp: 200, a1Cost: 1 }); // Retreat 4 (>= 3), 70 dmg
  const pokedex = enc('P-A-008');
  const heavyHelmet = enc('B1-219');
  const attacker = asBasicClone('A2-049', { a1Cost: 1 }); // 30 dmg

  const rep = fastSim({
    op: 'replay_game',
    deck: [...Array(12).fill(attacker), ...Array(8).fill(pokedex)],
    enemy: [...Array(12).fill(dummy), ...Array(8).fill(heavyHelmet)],
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10014
  });
  const pokedexPlayed = rep.steps.some((s) => s.kind === 6 && s.actor === 0 && s.aux1 === 1);
  assert.equal(pokedexPlayed, false, 'Pokédex must NEVER act as a free Draw-1 card!');

  // When opponent Snorlax (retreat 4) equips Heavy Helmet (tool 11), Palkia's 30-dmg attack must be reduced to 10 AND Palkia must take 0 recoil!
  const hitHelmet = rep.steps.find((s) => s.kind === 10 && s.actor === 0 && (s.board[1].tool & 0xff) === 11);
  assert.ok(hitHelmet, 'Snorlax (retreat 4) must equip Heavy Helmet');
  assert.equal(hitHelmet.aux1, 10, 'Heavy Helmet must reduce 30 dmg by -20 to 10 dmg');
  const effTag = (hitHelmet.aux2 >> 9) & 0x3f;
  assert.notEqual(effTag, 26, 'Heavy Helmet must NOT deal Rocky Helmet 20 contact recoil!');
});

test('Live WASM Replay: Guzzlord ex Grindcore discards opponent energy (NOT energy-scaling damage)', () => {
  const guzz = asBasicClone('A3a-043', { a1Cost: 1, a2Cost: 255 });
  const target = asBasicClone('A1-211', { hp: 250, a1Cost: 5 });
  let sawEnergyDisc = false;
  for (let seed = 10020; seed < 10035; seed++) {
    const rep = fastSim({
      op: 'replay_game',
      deck: Array(20).fill(guzz),
      enemy: Array(20).fill(target),
      weights: W, enemy_weights: W,
      game_idx: 0, total_per_opp: 100, seed_base: seed
    });
    for (const s of rep.steps) {
      if (s.kind === 10 && s.actor === 0) {
        assert.equal(s.aux1, 30, 'Guzzlord ex Grindcore must deal fixed 30 damage (not scaling by opp energy!)');
        if (((s.aux2 >> 9) & 0x3f) === 19) sawEnergyDisc = true;
      }
    }
    if (sawEnergyDisc) break;
  }
  assert.equal(sawEnergyDisc, true, 'Guzzlord ex Grindcore must discard opponent Active energy on heads!');
});

test('Live WASM Replay: Mega Kangaskhan ex double-hit, Protective Poncho bench shield, and Acerola damage transfer', () => {
  // 1. Mega Kangaskhan ex (B2-127): 40 + 40 = 80 total damage per attack!
  const mKang = asBasicClone('B2-127', { a1Cost: 1 });
  const dummy = asBasicClone('A1-211', { hp: 250, a1Cost: 5 });
  const repKang = fastSim({
    op: 'replay_game',
    deck: Array(20).fill(mKang),
    enemy: Array(20).fill(dummy),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10040
  });
  const doubleHit = repKang.steps.find((s) => s.kind === 10 && s.actor === 0 && s.aux1 >= 80);
  assert.ok(doubleHit, 'Mega Kangaskhan ex must execute double attack (40 + 40 = 80 total dmg)');

  // 2. Acerola (A3-148) moves damage from Mimikyu (A3-083) onto opponent Active WITHOUT bouncing Mimikyu!
  const mimikyu = asBasicClone('A3-083', { hp: 120, a1Cost: 5 });
  const acerola = enc('A3-148');
  const chipper = asBasicClone('B1-109', { hp: 200, a1Cost: 0 }); // Deals 10 dmg every turn
  const repAce = fastSim({
    op: 'replay_game',
    deck: [...Array(10).fill(mimikyu), ...Array(10).fill(acerola)],
    enemy: Array(20).fill(chipper),
    weights: W, enemy_weights: W,
    game_idx: 0, total_per_opp: 100, seed_base: 10041
  });
  const aceStep = repAce.steps.find((s) => s.kind === 6 && s.actor === 0 && s.aux1 === 2);
  assert.ok(aceStep, 'Acerola must be played on damaged Mimikyu');
  assert.ok(aceStep.board[1].hp < 200, 'Acerola must transfer Mimikyu damage onto opponent Active!');
  assert.equal(aceStep.board[0].hp, 120, 'Acerola must heal the transferred damage off Mimikyu (and NOT bounce Mimikyu to hand)');
});

test('Typed Energy Zone: Dragonite [W][L][C][C] CANNOT attack in Mono-Fire deck, CAN attack in [Water, Lightning] deck, and replay tracks exact energy types', () => {
  const dragonite = asBasicClone('A1-185'); // retains exact a1Cost=4 and a1Ecost=[W][L]
  assert.equal(dragonite.a1Cost, 4);
  assert.equal(dragonite.a1Ecost, packAttackEnergyCost(['water', 'lightning', 'colorless', 'colorless']));
  const dummy = asBasicClone('A1-211', { hp: 300, a1Cost: 5 });

  // 1. Mono-Fire Energy Zone: Dragonite never gets [W] or [L] -> 0 attacks across games!
  for (let seed = 20001; seed <= 20005; seed++) {
    const repFire = fastSim({
      op: 'replay_game',
      deck: withEnergyMask(Array(20).fill(dragonite), ['Fire']),
      enemy: withEnergyMask(Array(20).fill(dummy), ['Colorless']),
      weights: W, enemy_weights: W,
      game_idx: 0, total_per_opp: 100, seed_base: seed
    });
    const dragonAtks = repFire.steps.filter((s) => s.kind === 10 && s.actor === 0);
    assert.equal(dragonAtks.length, 0, 'Dragonite MUST NOT attack with only Fire energy!');
    const attachSteps = repFire.steps.filter((s) => s.kind === 8 && s.actor === 0);
    assert.ok(attachSteps.length > 0, 'Mono-Fire deck must still attach Fire energies');
    for (const s of attachSteps) {
      assert.equal((s.aux2 >>> 8) & 0xff, 1, 'Mono-Fire turn attachment must be Fire (etype=1)');
      assert.equal(s.board[0].energyByType[2], 0, 'Water energy count must be 0');
      assert.equal(s.board[0].energyByType[3], 0, 'Lightning energy count must be 0');
      assert.ok(s.board[0].energyByType[1] >= 1, 'Fire energy count must be >= 1');
    }
  }

  // 2. Dual-color [Water, Lightning] Energy Zone: generates both types and Dragonite attacks!
  let sawBothTypesAndAttack = false;
  for (let seed = 20010; seed <= 20025; seed++) {
    const repWL = fastSim({
      op: 'replay_game',
      deck: withEnergyMask(Array(20).fill(dragonite), ['Water', 'Lightning']),
      enemy: withEnergyMask(Array(20).fill(dummy), ['Fire']),
      weights: W, enemy_weights: W,
      game_idx: 0, total_per_opp: 100, seed_base: seed
    });
    const attachedTypes = new Set(repWL.steps.filter((s) => s.kind === 8 && s.actor === 0).map((s) => (s.aux2 >>> 8) & 0xff));
    const atkStep = repWL.steps.find((s) => s.kind === 10 && s.actor === 0);
    if (attachedTypes.has(2) && attachedTypes.has(3) && atkStep) {
      assert.ok(atkStep.board[0].energyByType[2] >= 1, 'Attacking Dragonite must have >=1 Water energy');
      assert.ok(atkStep.board[0].energyByType[3] >= 1, 'Attacking Dragonite must have >=1 Lightning energy');
      assert.ok(atkStep.board[0].energy >= 4, 'Attacking Dragonite must have >=4 total energy');
      sawBothTypesAndAttack = true;
      break;
    }
  }
  assert.equal(sawBothTypesAndAttack, true, 'Dragonite in [Water, Lightning] deck must receive both energy types and execute Draco Meteor!');
});

test('Typed Energy Mechanics: Serperior doubles ONLY [G] energy on [G] Pokémon (never [R] energy)', () => {
  // Serperior with 2-Colorless attack cost: 1 [G] doubles to 2 (can attack Turn 2), 1 [R] stays 1 (cannot attack Turn 2)
  const serpCC = asBasicClone('A1a-006', { a1Cost: 2, a1Ecost: 0 });
  const dummy = asBasicClone('A1-211', { hp: 250, a1Cost: 5 });

  // Mono-Grass: player 0 goes second (game_idx=50 -> first=1, so player 0's first turn is Turn 2!)
  const repGrass = fastSim({
    op: 'replay_game',
    deck: withEnergyMask(Array(20).fill(serpCC), ['Grass']),
    enemy: withEnergyMask(Array(20).fill(dummy), ['Fire']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20101
  });
  const grassTurn2Atk = repGrass.steps.find((s) => s.turn === 2 && s.kind === 10 && s.actor === 0);
  assert.ok(grassTurn2Atk, 'Serperior with 1 [G] energy MUST count as 2 energy and attack on Turn 2!');
  assert.equal(grassTurn2Atk.board[0].energy, 1);
  assert.equal(grassTurn2Atk.board[0].energyByType[0], 1, 'Grass energy count on Serperior must be 1');

  // Mono-Fire: 1 [R] energy on Serperior does NOT double -> CANNOT attack on Turn 2!
  const repFire = fastSim({
    op: 'replay_game',
    deck: withEnergyMask(Array(20).fill(serpCC), ['Fire']),
    enemy: withEnergyMask(Array(20).fill(dummy), ['Fire']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20101
  });
  const fireTurn2Atk = repFire.steps.find((s) => s.turn === 2 && s.kind === 10 && s.actor === 0);
  assert.equal(fireTurn2Atk, undefined, 'Serperior MUST NOT double [R] energy on a [G] Pokémon!');
});

test('Typed Energy Mechanics: Entei ex extra-energy threshold requires 4 [R] (2 [R] + 2 [W] does NOT trigger +60)', () => {
  const entei = enc('A4a-010'); // Blazing Beat: [R][R] 60+, +60 if 2 extra [R] (total 4 [R])
  const dummy = asBasicClone('A1-211', { hp: 300, a1Cost: 5 });

  // Mono-Fire: at 4 [R], deals 120!
  const repMonoFire = fastSim({
    op: 'replay_game',
    deck: withEnergyMask(Array(20).fill(entei), ['Fire']),
    enemy: withEnergyMask(Array(20).fill(dummy), ['Water']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20201
  });
  const boostedHit = repMonoFire.steps.find((s) => s.kind === 10 && s.actor === 0 && s.board[0].energyByType[1] >= 4 && s.aux1 >= 120);
  assert.ok(boostedHit, 'Entei ex with 4 [R] energy must trigger +60 -> 120 damage!');

  // Fire + Water mixed: whenever Entei ex has >=4 total energy but <4 [R] energy, damage MUST stay 60 (never 120)!
  let sawMixed4EnergyHit = false;
  for (let seed = 20210; seed <= 20245; seed++) {
    const repMix = fastSim({
      op: 'replay_game',
      deck: withEnergyMask(Array(20).fill(entei), ['Fire', 'Water']),
      enemy: withEnergyMask(Array(20).fill(dummy), ['Water']),
      weights: W, enemy_weights: W,
      game_idx: 50, total_per_opp: 100, seed_base: seed
    });
    for (const s of repMix.steps) {
      if (s.kind === 10 && s.actor === 0 && s.board[0].energy >= 4 && s.board[0].energyByType[1] < 4) {
        assert.equal(s.aux1, 60, `Entei ex with ${s.board[0].energyByType[1]} [R] and ${s.board[0].energy} total energy MUST deal 60 (not 120)!`);
        sawMixed4EnergyHit = true;
      }
    }
    if (sawMixed4EnergyHit) break;
  }
  assert.equal(sawMixed4EnergyHit, true, 'Must verify Entei ex with >=4 total energy but <4 [R] energy deals base 60');
});

test('Typed Energy Mechanics: Irida heals ONLY Pokémon with [W] energy & Darkrai ex chips ONLY on [D] attachment', () => {
  // 1. Irida (A2a-072): heals damaged Pokémon in [Water] deck, cannot heal in [Fire] deck!
  const tank = asBasicClone('A1-211', { hp: 200, a1Cost: 5 });
  const irida = enc('A2a-072');
  const chipper = asBasicClone('B1-109', { hp: 200, a1Cost: 0 }); // 10 dmg every turn

  const repWaterIrida = fastSim({
    op: 'replay_game',
    deck: withEnergyMask([...Array(10).fill(tank), ...Array(10).fill(irida)], ['Water']),
    enemy: withEnergyMask(Array(20).fill(chipper), ['Fire']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20301
  });
  const iridaWaterPlayed = repWaterIrida.steps.some((s) => s.kind === 6 && s.actor === 0 && s.aux1 === 2);
  assert.equal(iridaWaterPlayed, true, 'Irida must heal damaged Pokémon that have [W] energy attached');

  const repFireIrida = fastSim({
    op: 'replay_game',
    deck: withEnergyMask([...Array(10).fill(tank), ...Array(10).fill(irida)], ['Fire']),
    enemy: withEnergyMask(Array(20).fill(chipper), ['Fire']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20301
  });
  const iridaFirePlayed = repFireIrida.steps.some((s) => s.kind === 6 && s.actor === 0 && s.aux1 === 2);
  assert.equal(iridaFirePlayed, false, 'Irida MUST NOT heal Pokémon that only have [R] energy (no [W] energy)!');

  // 2. Darkrai ex (A2-110): Nightmare Aura chips 20 ONLY when attaching [D] energy (emits kind=7 aux2&0xff===9)!
  const darkrai = enc('A2-110');
  const repDark = fastSim({
    op: 'replay_game',
    deck: withEnergyMask(Array(20).fill(darkrai), ['Darkness']),
    enemy: withEnergyMask(Array(20).fill(tank), ['Fire']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20302
  });
  const darkTurn2Chip = repDark.steps.find((s) => s.turn === 2 && s.kind === 7 && s.actor === 0 && (s.aux2 & 0xff) === 9);
  assert.ok(darkTurn2Chip, 'Darkrai ex Nightmare Aura must fire on Turn 2 when attaching [D] energy!');
  assert.equal(darkTurn2Chip.board[1].hp, 180, 'Darkrai ex Nightmare Aura must deal 20 chip when attaching [D] energy!');

  const repFireDark = fastSim({
    op: 'replay_game',
    deck: withEnergyMask(Array(20).fill(darkrai), ['Fire']),
    enemy: withEnergyMask(Array(20).fill(tank), ['Fire']),
    weights: W, enemy_weights: W,
    game_idx: 50, total_per_opp: 100, seed_base: 20302
  });
  const fireTurn2Chip = repFireDark.steps.find((s) => s.kind === 7 && s.actor === 0 && (s.aux2 & 0xff) === 9);
  assert.equal(fireTurn2Chip, undefined, 'Darkrai ex MUST NOT trigger Nightmare Aura when attaching [R] energy!');
  const fireTurn2Attach = repFireDark.steps.find((s) => s.turn === 2 && s.kind === 8 && s.actor === 0);
  assert.ok(fireTurn2Attach, 'Darkrai ex attaches [R] energy on Turn 2 in Mono-Fire deck');
  assert.equal(fireTurn2Attach.board[1].hp, 200, 'Opponent HP must stay full 200 when attaching [R] energy!');
});

test('Deck Energy Helpers: findDeckEnergyMismatches & areDecksIdentical respect Energy Zone differences', () => {
  // Dragonite in Mono-Fire flags both Water & Lightning missing
  const m1 = findDeckEnergyMismatches({ cards: [{ id: 'A1-185', count: 2 }], energy: ['Fire'] }, cardById);
  assert.equal(m1.length, 1);
  assert.deepEqual([...m1[0].missingTypes].sort(), ['Lightning', 'Water']);

  // Dragonite in [Water, Lightning] has 0 mismatches
  const m2 = findDeckEnergyMismatches({ cards: [{ id: 'A1-185', count: 2 }], energy: ['Water', 'Lightning'] }, cardById);
  assert.equal(m2.length, 0);

  // Giratina ex in Mono-Darkness self-generates Psychic -> 0 mismatches!
  const m3 = findDeckEnergyMismatches({ cards: [{ id: 'A2b-035', count: 2 }, { id: 'A2-110', count: 2 }], energy: ['Darkness'] }, cardById);
  assert.equal(m3.length, 0);

  // Magneton (A1-098) self-generates Lightning -> no Lightning mismatch even in Mono-Fire deck!
  const m4 = findDeckEnergyMismatches({ cards: [{ id: 'A1-098', count: 2 }], energy: ['Fire'] }, cardById);
  assert.equal(m4.length, 0);

  // areDecksIdentical distinguishes identical 20 cards with different Energy Zones
  const dFire = { cards: [{ id: 'A4a-010', count: 2 }], energy: ['Fire'] };
  const dWater = { cards: [{ id: 'A4a-010', count: 2 }], energy: ['Water'] };
  const dWL1 = { cards: [{ id: 'A1-185', count: 2 }], energy: ['Water', 'Lightning'] };
  const dWL2 = { cards: [{ id: 'A1-185', count: 2 }], energy: ['Lightning', 'Water'] };
  assert.equal(areDecksIdentical(dFire, dWater), false, 'Same cards with different Energy Zone must NOT be identical');
  assert.equal(areDecksIdentical(dWL1, dWL2), true, 'Same cards with same Energy Zone in different order MUST be identical');
});
