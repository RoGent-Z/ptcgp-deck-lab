import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { instantiateBattle } from "../public/battle/runtime.mjs";
import { instantiateFastSim } from "../public/battle/fastsim-runtime.mjs";
import {
  buildExplorationCandidates,
  buildLegalReplacementCandidates,
  createEmptyExploreStats,
  encodeCardForFastSim,
  matchDeckStrategies,
  mergeExploreChunkStats,
  replaceDeckCardOnce,
  setCardMechanicsDb,
  synthesizeWinningStrategyFromStats,
  validateDeck
} from "../public/app/core.mjs";

const wasm = new URL("../public/battle/deckgym.wasm", import.meta.url);
const weights = Array(22).fill(0);
const basic = {
  cards: ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010"]
    .map(n => ({id: "A1-" + n, count: 2})),
  energy: ["Grass"]
};

test("engine validates unknown effects and rejects an illegal deck before play", async () => {
  const engine = await instantiateBattle(await readFile(wasm));
  assert.equal(engine({op: "coverage", ids: ["A1-001", "ZZ-999"]}).coverage["ZZ-999"], "Unknown card");
  assert.match(engine({op: "game", deck: {...basic, cards: []}, enemy: basic, weights, seed: 9, first: 0}).error, /20/);
});

test("seeded first and second seat games resolve by the rules and replay exactly", async () => {
  const engine = await instantiateBattle(await readFile(wasm));
  for (const first of [0, 1]) {
    const input = {op: "game", deck: basic, enemy: basic, weights, seed: 156, first, replay: true};
    const a = engine(input);
    assert.ifError(a.error ? Error(a.error) : null);
    assert.ok(["win", "loss", "draw"].includes(a.outcome));
    assert.equal(a.first, first);
    assert.equal(a.replay.find(s => s.turn === 1).actor, first);
    assert.deepEqual(engine(input), a);
  }
});

test("deployed models (1B5M全量模型, 1M5Q轻量模型, GTG精英轻量模型), top10 100M-league elite strategies, 10.48M strategy lexicon, and WASM engines execute deterministically", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/battle/models/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.defaultModelId, "v3");
  assert.equal(manifest.mobileDefaultModelId, "lite-1m5q");
  assert.equal(manifest.models.length, 3, "1B5M全量模型, 1M5Q轻量模型, and GTG精英轻量模型 should exist");
  assert.equal(manifest.models[0].id, "v3");
  assert.equal(manifest.models[0].label, "1B5M全量模型");
  assert.equal(manifest.models[0].simProfile.exploreTotalGames, 1000000000);
  assert.equal(manifest.models[0].simProfile.totalBatchGames, 5000000);
  assert.equal(manifest.models[1].id, "lite-1m5q");
  assert.equal(manifest.models[1].label, "1M5Q轻量模型");
  assert.equal(manifest.models[1].simProfile.exploreTotalGames, 1000000);
  assert.equal(manifest.models[1].simProfile.totalBatchGames, 5000);
  assert.equal(manifest.models[1].simProfile.gamesPerOpponent, 500);
  assert.equal(manifest.models[2].id, "gtg-elite-lite");
  assert.equal(manifest.models[2].label, "GTG精英轻量模型");
  assert.equal(manifest.models[2].simProfile.mode, "gtg");
  assert.equal(manifest.models[2].simProfile.roundGamesPerOpponent, 1000000);
  assert.equal(manifest.models[2].simProfile.convergenceTolerance, 0.001);
  assert.ok(manifest.strategyLexiconEntries >= 10000);
  assert.equal(manifest.top10GamesPerTeam, 10000000);
  assert.equal(manifest.top10TotalLeagueGames, 100000000);
  assert.equal(manifest.exploreTotalGames, 1000000000);
  assert.equal(manifest.gamesPerOpponent, 500000);
  assert.equal(manifest.totalBatchGames, 5000000);
  assert.equal(manifest.deepExploreGames, 1000000000);
  assert.equal(manifest.deepTestGamesPerOpponent, 5000000);

  // Ensure obsolete model files are removed
  for (const removed of ["v1.json", "v2.json", "baseline-v0.json", "current.json"]) {
    await assert.rejects(() => access(new URL(`../public/battle/models/${removed}`, import.meta.url)));
  }

  // Verify Top-10 100,000,000-game co-evolved elite strategies (10M games/team)
  const top10Elite = JSON.parse(await readFile(new URL("../public/battle/models/top10-elite.json", import.meta.url), "utf8"));
  assert.equal(top10Elite.gamesPerTeam, 10000000);
  assert.equal(top10Elite.totalLeagueGames, 100000000);
  const eliteEntries = Object.entries(top10Elite.teams || {});
  assert.equal(eliteEntries.length, 10);
  for (const [id, info] of eliteEntries) {
    assert.equal(info.gamesTrained, 10000000, `${id} expected 10M gamesTrained`);
    assert.equal(info.weights.length, 22, `${id} expected 22 weights`);
    const mirrorWr = info.vsMatrix?.[info.rank - 1];
    assert.ok(mirrorWr >= 0.45 && mirrorWr <= 0.55, `${id} mirror win rate ${mirrorWr} out of balanced range`);
  }

  // Verify 10.48M Strategy Lexicon (13,500 single/macro + 10,472,176 all-pairs 1,000-game tested)
  const lexIndex = JSON.parse(await readFile(new URL("../public/battle/strategies/index.json", import.meta.url), "utf8"));
  const lexDoc = JSON.parse(await readFile(new URL("../public/battle/strategies/lexicon.json", import.meta.url), "utf8"));
  assert.ok(lexIndex.totalEntries >= 10_000_000, `Expected >= 10,000,000 strategy entries, got ${lexIndex.totalEntries}`);
  assert.equal(lexDoc.entries.length, lexIndex.singleCardEntries);
  assert.equal(lexIndex.singleCardEntries + lexIndex.pairwiseEntries, lexIndex.totalEntries);
  assert.equal(lexIndex.cardsEvaluated, 4577);
  assert.ok(lexIndex.minGamesPerCard >= 1000);
  assert.equal(lexIndex.pairwiseGamesPerPair, 1000);
  const uniqIds = new Set(lexDoc.entries.map((r) => r[0]));
  assert.equal(uniqIds.size, lexDoc.entries.length);

  const v3 = JSON.parse(await readFile(new URL("../public/battle/models/v3.json", import.meta.url), "utf8"));
  const lite = JSON.parse(await readFile(new URL("../public/battle/models/lite-1m5q.json", import.meta.url), "utf8"));
  assert.equal(v3.weights.length, 22);
  assert.ok(v3.trainedGames >= 10_000_000, `Expected >= 10M trained games, got ${v3.trainedGames}`);
  assert.equal(v3.cardPoolEvaluated.totalDistinctCards, 4577);
  assert.ok(v3.cardPoolEvaluated.minGamesPerCard >= 1000);
  assert.equal(lite.name, "1M5Q轻量模型");
  assert.equal(lite.derivedFrom, "v3");
  assert.deepEqual(lite.weights, v3.weights);
  assert.equal(lite.simProfile.exploreTotalGames, 1000000);
  assert.equal(lite.simProfile.totalBatchGames, 5000);

  const priors = JSON.parse(await readFile(new URL("../public/battle/models/card-priors.json", import.meta.url), "utf8"));
  assert.equal(priors.totalCards, 4577);
  assert.equal(Object.keys(priors.byCardId).length, 4577);
  for (const [cid, info] of Object.entries(priors.byCardId)) {
    assert.ok(info.g >= 1000, `${cid} expected >= 1000 games, got ${info.g}`);
    assert.ok(info.ev >= 1000, `${cid} expected >= 1000 decisions, got ${info.ev}`);
  }

  const metaTop = JSON.parse(await readFile(new URL("../public/data/meta.top.json", import.meta.url), "utf8"));
  const top10 = metaTop.entries.slice(0, 10);
  const distinctIds = [...new Set(top10.flatMap((e) => e.representative.cards.map((c) => c.id)))];

  const engine = await instantiateBattle(await readFile(wasm));
  const cov = engine({ op: "coverage", ids: distinctIds });
  for (const id of distinctIds) {
    assert.equal(cov.coverage[id], "Fully implemented", id);
  }

  const batch = engine({
    op: "batch",
    games: top10.slice(0, 4).map((opp, i) => ({
      op: "game",
      deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
      enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
      weights: v3.weights,
      seed: 100 + i,
      first: i % 2,
      replay: false
    }))
  });
  assert.equal(batch.results.length, 4);
  for (const res of batch.results) {
    assert.ok(["win", "loss", "draw"].includes(res.outcome));
    assert.ok(Number.isInteger(res.turns) && res.turns > 0);
  }

  const fullFlow = engine({
    op: "game",
    deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
    enemy: { cards: top10[1].representative.cards, energy: top10[1].representative.energy },
    weights: v3.weights,
    seed: 2026,
    first: 0,
    replay: true
  });
  assert.ok(Array.isArray(fullFlow.replay) && fullFlow.replay.length > 0);
  assert.ok(Array.isArray(fullFlow.replay[0].board) && fullFlow.replay[0].board.length === 2);

  // Verify Stage 1 explore_chunk -> winning strategy synthesis -> Stage 2 test_chunk & exact replay seed parity
  const cands = buildExplorationCandidates(v3.weights, "engine-test-100k", 20);
  const expChunk = engine({
    op: "explore_chunk",
    deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
    enemies: [
      { id: top10[1].id, cards: top10[1].representative.cards, energy: top10[1].representative.energy }
    ],
    candidates: cands,
    enemy_weights: v3.weights,
    seed_prefix: "ut-exp",
    games_per_opponent: 10000,
    start_game: 0,
    count: 40
  });
  assert.equal(expChunk.completed, 40);
  assert.equal(expChunk.wins + expChunk.draws + expChunk.losses, 40);
  assert.equal(expChunk.byCandidate.length, 20);

  const acc = createEmptyExploreStats([top10[1].id], 20);
  mergeExploreChunkStats(acc, expChunk);
  const strategy = synthesizeWinningStrategyFromStats(acc, v3.weights, cands);
  assert.equal(strategy.weights.length, 22);

  const testChunk = engine({
    op: "test_chunk",
    deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
    enemy: { cards: top10[1].representative.cards, energy: top10[1].representative.energy },
    opponent_id: top10[1].id,
    weights: strategy.weights,
    enemy_weights: v3.weights,
    seed_prefix: "ut-test",
    start_idx: 0,
    count: 10,
    total_per_opp: 500
  });
  assert.equal(testChunk.outcomes.length, 10);
  assert.equal(testChunk.turns.length, 10);

  // Confirm seed parity between test_chunk game #0 and replay:true game #0
  const fnv1a32 = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  const replay0 = engine({
    op: "game",
    deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
    enemy: { cards: top10[1].representative.cards, energy: top10[1].representative.energy },
    weights: strategy.weights,
    enemy_weights: v3.weights,
    seed: fnv1a32(`ut-test:${top10[1].id}:0`),
    first: 0,
    replay: true
  });
  const expectedChar = replay0.outcome === "win" ? "W" : replay0.outcome === "loss" ? "L" : "D";
  assert.equal(testChunk.outcomes[0], expectedChar);
  assert.ok(Array.isArray(replay0.replay) && replay0.replay.length > 0);

  // Verify FastSim WASM (10M explore + 50k test engine) + 13,500 Strategy Lexicon integration + Exact-Mechanics v3 DB
  const cardMechanicsV3 = JSON.parse(await readFile(new URL("../public/data/card-mechanics.json", import.meta.url), "utf8"));
  setCardMechanicsDb(cardMechanicsV3);
  const cardsAll = JSON.parse(await readFile(new URL("../public/data/cards.json", import.meta.url), "utf8"));
  const cardById = new Map(cardsAll.map((c) => [c.id, c]));
  const matched = matchDeckStrategies(top10[0].representative, top10.map((e, i) => ({ rank: i + 1, entry: e })), lexDoc, v3.weights);
  assert.ok(matched.matchedCount >= 100, `Expected >= 100 matched strategies, got ${matched.matchedCount}`);
  const expand = (rep, bonusMap = {}) => {
    const out = [];
    for (const c of rep.cards) {
      const enc = encodeCardForFastSim(cardById.get(c.id), bonusMap[c.id] || 0);
      for (let k = 0; k < c.count; k++) out.push(enc);
    }
    return out;
  };
  const fastSim = await instantiateFastSim(await readFile(new URL("../public/battle/fastsim.wasm", import.meta.url)));
  const cands40 = buildExplorationCandidates(matched.lexiconSeedWeights, "ut-fast1b", 40);
  const opp1EliteW = top10Elite.teams[top10[1].id].weights;
  const fExp = fastSim({
    op: "explore_10m_chunk",
    deck: expand(top10[0].representative, matched.cardBonusById),
    enemies: [{ id: top10[1].id, cards: expand(top10[1].representative) }],
    candidates: cands40,
    enemy_weights: opp1EliteW,
    enemy_weights_list: [opp1EliteW],
    games_per_opponent: 100000000,
    start_game: 0,
    count: 2000,
    seed_base: 42
  });
  assert.equal(fExp.completed, 2000);
  assert.equal(fExp.wins + fExp.draws + fExp.losses, 2000);
  const fAcc = createEmptyExploreStats([top10[1].id], 40);
  mergeExploreChunkStats(fAcc, fExp);
  const fStrat = synthesizeWinningStrategyFromStats(fAcc, v3.weights, cands40);
  const fTest = fastSim({
    op: "test_50k_chunk",
    deck: expand(top10[0].representative, matched.cardBonusById),
    enemy: expand(top10[1].representative),
    opponent_id: top10[1].id,
    weights: fStrat.weights,
    enemy_weights: opp1EliteW,
    start_idx: 0,
    count: 1000,
    total_per_opp: 500000,
    seed_base: 99
  });
  assert.equal(fTest.completed, 1000);
  assert.equal(fTest.outcomes.length, 1000);
  assert.equal(fTest.wins + fTest.draws + fTest.losses, 1000);

  // Strict 100-game dot-to-replay parity test (first seat 0..49 + second seat 250000..250049)
  const fTestSecond = fastSim({
    op: "test_50k_chunk",
    deck: expand(top10[0].representative, matched.cardBonusById),
    enemy: expand(top10[1].representative),
    opponent_id: top10[1].id,
    weights: fStrat.weights,
    enemy_weights: opp1EliteW,
    start_idx: 250000,
    count: 50,
    total_per_opp: 500000,
    seed_base: 99
  });
  for (let i = 0; i < 50; i++) {
    const r1 = fastSim({
      op: "replay_game",
      deck: expand(top10[0].representative, matched.cardBonusById),
      enemy: expand(top10[1].representative),
      weights: fStrat.weights,
      enemy_weights: opp1EliteW,
      game_idx: i,
      total_per_opp: 500000,
      seed_base: 99
    });
    const exp1 = fTest.outcomes[i] === 1 ? "win" : fTest.outcomes[i] === 0 ? "loss" : "draw";
    assert.equal(r1.outcome, exp1, `First-seat game #${i} outcome mismatch`);
    assert.equal(r1.turns, fTest.turns[i], `First-seat game #${i} turns mismatch`);
    assert.equal(r1.first, 0);
    assert.ok(r1.steps.length > 0);

    const r2 = fastSim({
      op: "replay_game",
      deck: expand(top10[0].representative, matched.cardBonusById),
      enemy: expand(top10[1].representative),
      weights: fStrat.weights,
      enemy_weights: opp1EliteW,
      game_idx: 250000 + i,
      total_per_opp: 500000,
      seed_base: 99
    });
    const exp2 = fTestSecond.outcomes[i] === 1 ? "win" : fTestSecond.outcomes[i] === 0 ? "loss" : "draw";
    assert.equal(r2.outcome, exp2, `Second-seat game #${250000 + i} outcome mismatch`);
    assert.equal(r2.turns, fTestSecond.turns[i], `Second-seat game #${250000 + i} turns mismatch`);
    assert.equal(r2.first, 1);
    assert.ok(r2.steps.length > 0);
  }

  // Verify pure-Chinese replay action & card name translation (zero English action/name/HP leaks)
  const { translateActionLabel, translateEnCardName } = await import("../public/app/battle.mjs");
  const sampleActions = [
    "EndTurn",
    "Place(Corphish, 0)",
    "Place(Darkrai, 0)",
    "Place(Eevee, 1)",
    "Place(Igglybuff, 2)",
    "Evolve(Mega Charizard Y ex, 0, from_deck: false)",
    "Play(A1 225 Sabrina)",
    "Play(P-A 005 Poké Ball)",
    'Attach("(1, Fire, 0)", true)',
    "AttachTool(0, Giant Cape)",
    "Attack(Crimson Dive)",
    "UseAbility(0)",
    "Retreat(1)",
    "Heal(0, 30, cure:true)",
    "ApplyDamage(attacker:(0, 0), targets:[(30, 1, 0), (20, 1, 1)], from_active:true)"
  ];
  for (const act of sampleActions) {
    const zh = translateActionLabel(act, {
      actor: 0,
      prevBoard: [{ active: { name: "Mega Charizard Y ex" }, bench: [] }, { active: { name: "Darkrai" }, bench: [] }],
      cardsList: cardsAll
    });
    assert.ok(!/\b(Place|EndTurn|Play|Attach|Attack|Evolve|Retreat|Heal|ApplyDamage|Corphish|Darkrai|Eevee|Igglybuff|Sabrina|Giant Cape|Fire|Water|HP)\b/.test(zh), `Unexpected English in: ${zh}`);
  }
  assert.equal(translateEnCardName("Corphish", cardsAll), "龍蝦小兵");
  assert.equal(translateEnCardName("Darkrai", cardsAll), "達克萊伊");
  assert.equal(translateEnCardName("Eevee", cardsAll), "伊布");
  assert.equal(translateEnCardName("Igglybuff", cardsAll), "寶寶丁");

  // Verify Deck AI Optimizer legality + compatibility filtering across all 4,577 cards + exact-rules verification
  const { encodeCardForOptimizer, isCardCompatibleWithDeck } = await import("../public/app/core.mjs");
  const targetId = top10[0].representative.cards[0].id;
  const optPrep = buildLegalReplacementCandidates({
    deck: { id: "ut-deck", name: "Test", cards: top10[0].representative.cards, energy: top10[0].representative.energy },
    targetCardId: targetId,
    allCards: cardsAll,
    cardsById: cardById,
    collection: {},
    cardBonusById: {}
  });
  assert.equal(optPrep.totalCatalogCount, 4577);
  assert.ok(optPrep.totalLegalChecked > 4000, `Expected > 4000 legal replacement cards, got ${optPrep.totalLegalChecked}`);
  assert.ok(optPrep.incompatibleCount > 2500, `Expected off-type/orphan cards filtered out, got ${optPrep.incompatibleCount}`);
  assert.equal(optPrep.candidates[0].isOriginal, true);
  assert.equal(optPrep.candidates[0].card.id, targetId);

  // Regression: Psychic-only Diantha (B2-149 [超]), Grass-only Erika (A1-219 [草]), Water-only Misty/Irida MUST be rejected in a pure Fire deck!
  for (const offTypeId of ["B2-149", "A1-219", "A1-220", "A2a-072", "A2a-075", "B2-148"]) {
    const offCard = cardById.get(offTypeId);
    assert.equal(isCardCompatibleWithDeck(offCard, optPrep.optCtx), false, `${offTypeId} (${offCard?.name}) must be incompatible in Fire deck`);
    const encOff = encodeCardForOptimizer(offCard, 0, optPrep.optCtx);
    assert.equal(encOff.trainerKind, 0, `${offTypeId} must encode as trainerKind=0`);
    assert.ok(!optPrep.candidates.some((x) => x.card.id === offTypeId), `${offTypeId} must not appear in compatible candidates`);
  }
  // Regression: Universal staples (Sabrina/Cyrus/Leaf/Cape/Helmet) MUST stay compatible (no '戰鬥寶可夢' false-match on 鬥!)
  for (const stapleId of ["A1-225", "A2-150", "A1a-068", "A2-147", "A2-148", "B1-217"]) {
    const sc = cardById.get(stapleId);
    assert.equal(isCardCompatibleWithDeck(sc, optPrep.optCtx), true, `${stapleId} (${sc?.name}) must be compatible in Fire deck`);
  }
  // Regression: Exact-Mechanics v3 encoding checks for staples, attacks, abilities, tools, stadiums & trainers
  const encLeaf = encodeCardForFastSim(cardById.get("A1a-068"), 0, cardById);
  assert.equal(encLeaf.trainerKind, 6);
  assert.equal(encLeaf.trainerSub, 3);
  assert.equal(encLeaf.effectVal, 2);
  assert.equal(encLeaf.isSupporter, 1);
  const encXSpeed = encodeCardForFastSim(cardById.get("P-A-002"), 0, cardById);
  assert.equal(encXSpeed.trainerKind, 6);
  assert.equal(encXSpeed.trainerSub, 3);
  assert.equal(encXSpeed.effectVal, 1);
  assert.equal(encXSpeed.isItem, 1);
  const encWally = encodeCardForFastSim(cardById.get("B4-153"), 0, cardById);
  assert.equal(encWally.trainerKind, 6);
  assert.equal(encWally.trainerSub, 7);
  const encPatch = encodeCardForFastSim(cardById.get("B1-217"), 0, cardById);
  assert.equal(encPatch.trainerKind, 6);
  assert.equal(encPatch.trainerSub, 8);

  // 1. 0-cost attacks preserved (Chingling B1-109 Item-Lock & Igglybuff A4a-059 Sleep)
  const encChingling = encodeCardForFastSim(cardById.get("B1-109"), 0, cardById);
  assert.equal(encChingling.a1Cost, 0);
  assert.equal(encChingling.a1Dmg, 10);
  assert.equal(encChingling.a1Op1, 17);
  assert.equal(encChingling.a1Val1, 4); // Item lock
  const encIggly = encodeCardForFastSim(cardById.get("A4a-059"), 0, cardById);
  assert.equal(encIggly.a1Cost, 0);
  assert.equal(encIggly.a1Op1, 1);
  assert.equal(encIggly.a1Val1, 8); // Real Sleep (SM_SLEEP=8, not Poison!)
  // 2. Dual-attack Pokémon keep BOTH attacks & dual post-effects (Hoopa ex B4-103, Chien-Pao ex B2a-037)
  const encHoopa = encodeCardForFastSim(cardById.get("B4-103"), 0, cardById);
  assert.equal(encHoopa.a1Cost, 1);
  assert.equal(encHoopa.a1Dmg, 30);
  assert.equal(encHoopa.a1Op1, 8); // +20 bench snipe
  assert.equal(encHoopa.a2Cost, 3);
  assert.equal(encHoopa.a2Dmg, 100);
  assert.equal(encHoopa.a2Op1, 9); // 20 self-recoil
  assert.equal(encHoopa.a2Val1, 20);
  const encChienPao = encodeCardForFastSim(cardById.get("B2a-037"), 0, cardById);
  assert.equal(encChienPao.a1Cost, 1);
  assert.equal(encChienPao.a1Dmg, 20);
  assert.equal(encChienPao.a2Cost, 3);
  assert.equal(encChienPao.a2Op1, 8); // pure snipe 130
  assert.equal(encChienPao.a2Op2, 10); // + discard all energy!
  assert.equal((encChienPao.a2Val1 >> 8) & 0xff, 130);
  assert.equal(encChienPao.a2Val2, 99);
  // 3. Dynamic scaling attacks do NOT get fake bench snipe (Suicune ex & Mega Altaria ex)
  const encSuicune = encodeCardForFastSim(cardById.get("A4a-020"), 0, cardById);
  assert.equal(encSuicune.a1Op1, 6);
  assert.equal(encSuicune.a1Val1 & 0xff, 2); // both benches
  assert.equal((encSuicune.a1Val1 >> 8) & 0xff, 20);
  assert.equal(encSuicune.abOp, 1); // Legendary Pulse EoT draw 1
  const encAltaria = encodeCardForFastSim(cardById.get("B1-102"), 0, cardById);
  assert.equal(encAltaria.a1Dmg, 40);
  assert.equal(encAltaria.a1Op1, 6);
  assert.equal(encAltaria.a1Val1 & 0xff, 0); // own bench only
  assert.equal((encAltaria.a1Val1 >> 8) & 0xff, 30);
  // 4. Entei ex extra-energy threshold (60 + 60 if >= 2 extra fire energy)
  const encEntei = encodeCardForFastSim(cardById.get("A4a-010"), 0, cardById);
  assert.equal(encEntei.a1Cost, 2);
  assert.equal(encEntei.a1Dmg, 60);
  assert.equal(encEntei.a1Op1, 7);
  assert.equal(encEntei.a1Val1 & 0xff, 0); // extra-energy cond
  assert.equal((encEntei.a1Val1 >> 8) & 0xff, 60);
  assert.equal((encEntei.a1Val1 >> 16) & 0xff, 2);
  // 5. C1-018 Charizard Flame Aura (30 dmg on attach), Hydreigon (+2e -30hp), Greninja ex free switch
  const encC1Zard = encodeCardForFastSim(cardById.get("C1-018"), 0, cardById);
  assert.equal(encC1Zard.abOp, 7);
  assert.equal(encC1Zard.abVal, 30);
  const encHydreigon = encodeCardForFastSim(cardById.get("B1-157"), 0, cardById);
  assert.equal(encHydreigon.abOp, 3);
  assert.equal(encHydreigon.abVal, 3); // +2 energy & -30 self HP
  const encGrenEx = encodeCardForFastSim(cardById.get("B1-073"), 0, cardById);
  assert.equal(encGrenEx.abOp, 16); // Shifting Stream free switch
  // 6. Tools, Stadiums, and Trainers exact effects
  const encBalloon = encodeCardForFastSim(cardById.get("B3b-064"), 0, cardById);
  assert.equal(encBalloon.trainerKind, 5);
  assert.equal(encBalloon.effectVal, 7); // Small Balloon (Basic -1 retreat, NOT +20 HP)
  const encEviolite = encodeCardForFastSim(cardById.get("C1-123"), 0, cardById);
  assert.equal(encEviolite.trainerKind, 5);
  assert.equal(encEviolite.effectVal, 10); // Basic -20 dmg
  const encLuckyEgg = encodeCardForFastSim(cardById.get("B3-148"), 0, cardById);
  assert.equal(encLuckyEgg.trainerKind, 5);
  assert.equal(encLuckyEgg.effectVal, 23);
  const encTrickPin = encodeCardForFastSim(cardById.get("B4-148"), 0, cardById);
  assert.equal(encTrickPin.trainerKind, 5);
  assert.equal(encTrickPin.effectVal, 19);
  const encPrismCave = encodeCardForFastSim(cardById.get("B4-155"), 0, cardById);
  assert.equal(encPrismCave.trainerKind, 7);
  assert.equal(encPrismCave.effectVal, 1); // Neutral stadium
  const encTrainingArea = encodeCardForFastSim(cardById.get("B2-153"), 0, cardById);
  assert.equal(encTrainingArea.trainerKind, 7);
  assert.equal(encTrainingArea.effectVal, 2); // Stage 1 +10 dmg
  const encIcePop = encodeCardForFastSim(cardById.get("B2-145"), 0, cardById);
  assert.equal(encIcePop.trainerKind, 2);
  assert.equal(encIcePop.trainerSub, 8); // Heal 20 + coin return
  assert.equal(encIcePop.effectVal, 20);
  const encFieldBlower = encodeCardForFastSim(cardById.get("B3-147"), 0, cardById);
  assert.equal(encFieldBlower.trainerKind, 3);
  assert.equal(encFieldBlower.trainerSub, 11); // Tool/Stadium discard
  const encCopycat = encodeCardForFastSim(cardById.get("B1-225"), 0, cardById);
  assert.equal(encCopycat.trainerKind, 1);
  assert.equal(encCopycat.trainerSub, 3);
  assert.equal(encCopycat.isSupporter, 1);
  const encProfResearch = encodeCardForFastSim(cardById.get("P-A-007"), 0, cardById);
  assert.equal(encProfResearch.trainerKind, 1);
  assert.equal(encProfResearch.trainerSub, 1);
  assert.equal(encProfResearch.effectVal, 2);
  assert.equal(encProfResearch.isSupporter, 1);
  const encGuzma = encodeCardForFastSim(cardById.get("A3-151"), 0, cardById);
  assert.equal(encGuzma.trainerKind, 3);
  assert.equal(encGuzma.trainerSub, 10); // Discard opp tools!
  const encUmbreon = encodeCardForFastSim(cardById.get("C1-084"), 0, cardById);
  assert.equal(encUmbreon.a1Dmg, 30);
  assert.equal(encUmbreon.a1Op1, 7);
  assert.equal(encUmbreon.a1Val1 & 0xff, 13); // vs Basic +50
  assert.equal((encUmbreon.a1Val1 >> 8) & 0xff, 50);

  // Every candidate replacement deck MUST pass validateDeck() with zero issues!
  for (const sample of optPrep.candidates.slice(0, 30)) {
    const replaced = replaceDeckCardOnce(
      { id: "ut-deck", name: "Test", cards: top10[0].representative.cards, energy: top10[0].representative.energy },
      targetId,
      sample.card.id,
      cardById
    );
    assert.deepEqual(validateDeck(replaced, cardById), [], `Candidate ${sample.card.id} failed deck legality`);
  }
  const optRes = fastSim({
    op: "optimize_batch",
    base_deck: optPrep.baseDeck20,
    enemies: top10.map((e) => ({ id: e.id, cards: expand(e.representative) })),
    player_weights: lite.weights,
    enemy_weights: lite.weights,
    enemy_weights_list: top10.map((e) => top10Elite.teams[e.id].weights),
    candidate_cards: optPrep.candidates.slice(0, 8).map((c) => c.encoded),
    games_per_opp: 20,
    seed_base: 777
  });
  assert.equal(optRes.results.length, 8);
  for (const r of optRes.results) {
    assert.equal(r.games, 200);
    assert.equal(r.wins + r.draws + r.losses, 200);
  }

  // Verify 10.47M all-pairs 1,000-game pairwise strategy binary matrix & O(1) lookup + deck strategy fusion
  const { parsePairwiseBinary, lookupPairwiseStrategy } = await import("../public/app/core.mjs");
  const pairMeta = JSON.parse(await readFile(new URL("../public/battle/strategies/pairwise-10m.json", import.meta.url), "utf8"));
  const shardPaths = Array.isArray(pairMeta.binaryShards) && pairMeta.binaryShards.length
    ? pairMeta.binaryShards
    : [pairMeta.binaryFile || "battle/strategies/pairwise-10m.bin"];
  const shardBufs = await Promise.all(shardPaths.map((p) => readFile(new URL(`../public/${p}`, import.meta.url))));
  const pairBinBuf = Buffer.concat(shardBufs);
  const pairAb = pairBinBuf.buffer.slice(pairBinBuf.byteOffset, pairBinBuf.byteOffset + pairBinBuf.byteLength);
  const pairDb = parsePairwiseBinary(pairAb, pairMeta);
  assert.equal(pairDb.totalCards, 4577);
  assert.equal(pairDb.functionalCards, 2566);
  assert.equal(pairDb.functionalPairs, 3293461);
  assert.equal(pairDb.totalPairwiseEntries, 10472176);
  assert.equal(pairDb.gamesPerPair, 1000);
  assert.equal(pairMeta.totalGamesSimulated, 3293461000);

  const comboGood = lookupPairwiseStrategy(pairDb, "A2b-010", "A3-155", cardById); // 噴火龍ex + 莉莉艾
  assert.ok(comboGood && comboGood.games === 1000);
  assert.ok(comboGood.wr > 0.7, `Expected strong synergy WR for Charizard ex + Lillie, got ${comboGood.wr}`);
  assert.equal(comboGood.archetypeTag, 2); // 進化與道具核心連攜

  const comboClash = lookupPairwiseStrategy(pairDb, "B1a-014", "B2-149", cardById); // 超級噴火龍Yex + 卡露妮 ([超])
  assert.ok(comboClash && comboClash.games === 1000);
  assert.equal(comboClash.archetypeTag, 3); // 跨系配置風險警示

  const mergedMatched = matchDeckStrategies(
    top10[0].representative,
    top10.map((entry, idx) => ({ rank: idx + 1, entry })),
    lexDoc,
    v3.weights,
    pairDb,
    cardById
  );
  assert.equal(mergedMatched.totalLexiconCount, 13500 + 10472176);
  assert.ok(mergedMatched.pairMatchedCount >= 40, `Expected >= 40 pairwise strategies activated, got ${mergedMatched.pairMatchedCount}`);
  assert.ok(mergedMatched.activePairStrategies.length > 0);

  // Verify GTG精英轻量模型 JSON config & real dual-side simultaneous co-evolution convergence loop
  const gtgModel = JSON.parse(await readFile(new URL("../public/battle/models/gtg-elite-lite.json", import.meta.url), "utf8"));
  assert.equal(gtgModel.name, "GTG精英轻量模型");
  assert.equal(gtgModel.simProfile.mode, "gtg");
  assert.equal(gtgModel.simProfile.roundGamesPerOpponent, 1000000);
  assert.equal(gtgModel.simProfile.convergenceTolerance, 0.001);

  // Verify scaling/debuff/mechanics Meta cards & evolution-family isolation in FastSim encoding
  const { resolveEvolutionGroup } = await import("../public/app/core.mjs");
  assert.ok(encodeCardForFastSim(cardById.get("A4a-020"), 0, cardById).atkDmg >= 80, "Suicune ex (20x bench) must not be crippled");
  assert.ok(encodeCardForFastSim(cardById.get("B1-102"), 0, cardById).atkDmg >= 100, "Mega Altaria ex (40+ bench) must not be crippled");
  assert.ok(encodeCardForFastSim(cardById.get("B3a-019"), 0, cardById).atkDmg >= 90, "Miraidon ex (20+ energy) must not be crippled");
  assert.ok(encodeCardForFastSim(cardById.get("B1a-026"), 0, cardById).atkDmg >= 90, "Magnezone opponent-debuff must not halve its own damage");
  assert.ok(encodeCardForFastSim(cardById.get("B2a-037"), 0, cardById).atkDmg >= 85, "Chien-Pao ex effect-text 130 snipe must be parsed");

  const encCharmeleon = encodeCardForFastSim(cardById.get("B2b-008"), 0, cardById);
  assert.ok((encCharmeleon.abFlags & 32) !== 0 && (encCharmeleon.abFlags & 4) === 0, "Charmeleon ignition must be one-time on-evolve, not repeatable every turn");
  const encOricorio = encodeCardForFastSim(cardById.get("A3-066"), 0, cardById);
  assert.equal(encOricorio.hp, 70);
  assert.ok((encOricorio.abFlags & 64) !== 0, "Oricorio Safeguard must set ex-immunity bit 64");
  const encDarkrai = encodeCardForFastSim(cardById.get("A2-110"), 0, cardById);
  assert.ok((encDarkrai.abFlags & 16) !== 0 && (encDarkrai.abFlags & 4) === 0, "Darkrai ex trigger must snipe 20, NOT free energy ramp");
  const encMegaZard = encodeCardForFastSim(cardById.get("B1a-014"), 0, cardById);
  assert.equal(encMegaZard.atkDmg, 250);
  assert.ok((encMegaZard.atkFlags & 32) !== 0, "Mega Charizard Y ex must apply real 50 self-recoil");
  const encGiratina = encodeCardForFastSim(cardById.get("C1-101"), 0, cardById);
  assert.equal(encGiratina.atkDmg, 140);
  assert.ok((encGiratina.atkFlags & 128) !== 0, "Giratina ex must preserve 140 OHKO breakpoint and discard 2 energy");

  // Evolution-family isolation prevents Dragonair from overwriting Giratina ex, and connects Frigibax -> Baxcalibur for Rare Candy
  assert.equal(resolveEvolutionGroup(cardById.get("B4-117"), cardById), resolveEvolutionGroup(cardById.get("C1-098"), cardById));
  assert.notEqual(resolveEvolutionGroup(cardById.get("B4-117"), cardById), resolveEvolutionGroup(cardById.get("C1-101"), cardById));
  assert.equal(resolveEvolutionGroup(cardById.get("B2a-036"), cardById), resolveEvolutionGroup(cardById.get("B2a-034"), cardById));
  assert.notEqual(resolveEvolutionGroup(cardById.get("B2b-008"), cardById), resolveEvolutionGroup(cardById.get("A4a-010"), cardById));

  // Verify calibrated FastSim matchups: #1 must no longer crush #8 (Oricorio/Magnezone) or #9 (Giratina ex/Dragonair) at 90%+
  const expandWithEvo = (rep) => {
    const out = [];
    for (const c of rep.cards) {
      const enc = encodeCardForFastSim(cardById.get(c.id), 0, cardById);
      for (let i = 0; i < c.count; i++) if (out.length < 20) out.push(enc);
    }
    return out;
  };
  const calVs8 = fastSim({
    op: "test_chunk", opponent_id: top10[7].id,
    deck: expandWithEvo(top10[0].representative), enemy: expandWithEvo(top10[7].representative),
    weights: v3.weights, enemy_weights: v3.weights,
    start_idx: 0, count: 600, total_per_opp: 600, seed_base: 8808
  });
  assert.ok(calVs8.wins / calVs8.completed < 0.55, `Calibrated #1 vs #8 (Oricorio/Magnezone) must be < 55%, got ${calVs8.wins}/${calVs8.completed}`);
  const calVs9 = fastSim({
    op: "test_chunk", opponent_id: top10[8].id,
    deck: expandWithEvo(top10[0].representative), enemy: expandWithEvo(top10[8].representative),
    weights: v3.weights, enemy_weights: v3.weights,
    start_idx: 0, count: 600, total_per_opp: 600, seed_base: 8809
  });
  assert.ok(calVs9.wins / calVs9.completed < 0.72, `Calibrated #1 vs #9 (Giratina ex/Dragonair) must be < 72%, got ${calVs9.wins}/${calVs9.completed}`);

  // Runtime Exact-Mechanics v2 behavioral tests in fastsim.wasm:
  // A) Small Balloon (B3b-064) must NEVER grant +20 Max HP; Chingling (B1-109) must attack at 0 energy & inflict Item-Lock!
  const chinglingEnc = encodeCardForFastSim(cardById.get("B1-109"), 0, cardById);
  const balloonEnc = encodeCardForFastSim(cardById.get("B3b-064"), 0, cardById);
  const igglyEnc = encodeCardForFastSim(cardById.get("A4a-059"), 0, cardById);
  const potionEnc = encodeCardForFastSim(cardById.get("P-A-001"), 0, cardById);
  const deckA = [...Array(10).fill(chinglingEnc), ...Array(10).fill(balloonEnc)];
  const deckB = [...Array(10).fill(igglyEnc), ...Array(10).fill(potionEnc)];
  const repZeroCost = fastSim({
    op: "replay_game", deck: deckA, enemy: deckB,
    weights: v3.weights, enemy_weights: v3.weights,
    game_idx: 0, total_per_opp: 100, seed_base: 424242
  });
  for (const st of repZeroCost.steps) {
    // Chingling base HP is 30; equipping Small Balloon must NEVER turn maxHp into 50!
    assert.ok(st.board[0].maxHp <= 30, `Small Balloon must not grant +20 HP to Chingling (got maxHp=${st.board[0].maxHp})`);
    // Igglybuff Sleep must NEVER emit Poison (reason=1) damage!
    if (st.kind === 12) {
      assert.notEqual(st.aux2 & 0xf, 1, "Sleep deck must never trigger Poison damage in between-turn check");
    }
  }
  const chinglingAttackedZeroE = repZeroCost.steps.some((st) => st.kind === 10 && st.actor === 0 && st.aux1 === 10);
  assert.equal(chinglingAttackedZeroE, true, "Chingling must execute 0-cost 10-damage attack");

  // B) Cyrus (A2-150) must NOT switch an undamaged opponent bench Pokémon; Guzma (A3-151) must strip Giant Cape +20 HP!
  const cyrusEnc = encodeCardForFastSim(cardById.get("A2-150"), 0, cardById);
  const charmanderEnc = encodeCardForFastSim(cardById.get("B2b-007"), 0, cardById);
  const deckCyrus = [...Array(10).fill(charmanderEnc), ...Array(10).fill(cyrusEnc)];
  const deckTargets = Array(20).fill(charmanderEnc);
  const repCyrus = fastSim({
    op: "replay_game", deck: deckCyrus, enemy: deckTargets,
    weights: v3.weights, enemy_weights: v3.weights,
    game_idx: 0, total_per_opp: 100, seed_base: 515151
  });
  // On Turn 1 (before any attack has dealt damage), Cyrus MUST NOT be played!
  const cyrusPlayedT1 = repCyrus.steps.some((st) => st.turn === 1 && st.kind === 6 && st.aux1 === 3 && st.aux2 === 2);
  assert.equal(cyrusPlayedT1, false, "Cyrus must not be played when opponent bench has zero damaged Pokémon");

  const { areDecksIdentical, countDeckDifferences, runGtgDuelConvergence } = await import("../public/app/battle.mjs");
  // Verify mirror detection & card diff counter for custom-deck GTG duel
  const reorderedDeck0 = {
    cards: [...top10[0].representative.cards].reverse(),
    energy: [...(top10[0].representative.energy || [])].reverse()
  };
  assert.equal(areDecksIdentical(top10[0].representative, reorderedDeck0), true);
  assert.equal(countDeckDifferences(top10[0].representative, reorderedDeck0), 0);
  assert.equal(areDecksIdentical(top10[0].representative, top10[1].representative), false);
  assert.ok(countDeckDifferences(top10[0].representative, top10[1].representative) >= 8);

  const gtgTestRes = await runGtgDuelConvergence({
    opp: top10[1],
    myFastDeck: expand(top10[0].representative),
    oppFastDeck: expand(top10[1].representative),
    initPlayerWeights: gtgModel.weights,
    initEnemyWeights: top10Elite.teams[top10[1].id].weights,
    roundGames: 400, // Fast deterministic UT slice exercising exact dual-side simultaneous update + CRN eval
    evalGames: 500,
    candCount: 10,
    tol: 0.001,
    maxRounds: 4,
    seedPrefix: "ut-gtg",
    fastSim,
    gpuSim: null
  });
  assert.ok(gtgTestRes.rounds >= 1 && gtgTestRes.rounds <= 4);
  assert.equal(gtgTestRes.finalPlayerWeights.length, 22);
  assert.equal(gtgTestRes.finalEnemyWeights.length, 22);
  assert.equal(gtgTestRes.finalEval.total, 500);
  assert.equal(gtgTestRes.finalEval.sampleOutcomesStr.length, 500);
  assert.ok(gtgTestRes.history.length === gtgTestRes.rounds + 1);
  // Monotonic best-response guard & complete history metrics (oppWinRate, drawRate, scoreRate)
  for (const h of gtgTestRes.history) {
    assert.ok(h.oppWinRate >= 0 && h.oppWinRate <= 1);
    assert.ok(h.scoreRate >= 0 && h.scoreRate <= 1);
  }
  for (const h of gtgTestRes.history.slice(1)) {
    assert.ok(h.playerGain >= 0, `Player learning must be monotonic, got ${h.playerGain}`);
    assert.ok(h.enemyGain >= 0, `Opponent learning must be monotonic, got ${h.enemyGain}`);
  }
  const anyOppImproved = gtgTestRes.history.slice(1).some((h) => h.enemyGain > 0);
  assert.equal(anyOppImproved, true, "GTG opponent should actively learn stronger counter-strategy");

  // Verify symmetric mirror GTG keeps wP === wE strictly identical and lands near 50% score rate
  const gtgMirrorRes = await runGtgDuelConvergence({
    opp: top10[0],
    myFastDeck: expandWithEvo(top10[0].representative),
    oppFastDeck: expandWithEvo(top10[0].representative),
    initPlayerWeights: gtgModel.weights,
    initEnemyWeights: gtgModel.weights,
    symmetricMirror: true,
    roundGames: 400,
    evalGames: 1000,
    candCount: 10,
    tol: 0.001,
    maxRounds: 3,
    seedPrefix: "ut-gtg-mirror",
    fastSim,
    gpuSim: null
  });
  assert.deepEqual(gtgMirrorRes.finalPlayerWeights, gtgMirrorRes.finalEnemyWeights, "Symmetric mirror GTG must preserve wP === wE");
  const mirrorScore = (gtgMirrorRes.finalEval.wins + 0.5 * gtgMirrorRes.finalEval.draws) / gtgMirrorRes.finalEval.total;
  assert.ok(Math.abs(mirrorScore - 0.5) < 0.06, `Symmetric mirror score rate must stay near 50%, got ${(mirrorScore * 100).toFixed(2)}%`);
});
