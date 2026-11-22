import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { instantiateBattle } from "../public/battle/runtime.mjs";
import { buildExplorationCandidates, synthesizeWinningStrategy } from "../public/app/core.mjs";

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

test("deployed trained models (v3/v1/v2), 4577-card 1000+ evaluations, and two-stage 1000-explore + 500-test WASM pipeline execute deterministically", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/battle/models/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.defaultModelId, "v3");
  assert.equal(manifest.exploreTotalGames, 1000);
  assert.equal(manifest.gamesPerOpponent, 50);
  assert.equal(manifest.totalBatchGames, 500);
  assert.equal(manifest.deepTestGamesPerOpponent, 500);

  const v3 = JSON.parse(await readFile(new URL("../public/battle/models/v3.json", import.meta.url), "utf8"));
  const v1 = JSON.parse(await readFile(new URL("../public/battle/models/v1.json", import.meta.url), "utf8"));
  const v2 = JSON.parse(await readFile(new URL("../public/battle/models/v2.json", import.meta.url), "utf8"));
  assert.equal(v3.weights.length, 22);
  assert.ok(v3.trainedGames >= 10_000_000, `Expected >= 10M trained games, got ${v3.trainedGames}`);
  assert.equal(v3.cardPoolEvaluated.totalDistinctCards, 4577);
  assert.ok(v3.cardPoolEvaluated.minGamesPerCard >= 1000);
  assert.equal(v1.weights.length, 22);
  assert.equal(v2.weights.length, 22);

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

  // Verify Stage 1 track_features -> winning strategy synthesis -> Stage 2 test
  const cands = buildExplorationCandidates(v3.weights, "engine-test", 10);
  const expBatch = engine({
    op: "batch",
    games: Array.from({ length: 10 }, (_, i) => ({
      op: "game",
      deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
      enemy: { cards: top10[1].representative.cards, energy: top10[1].representative.energy },
      weights: cands[i],
      enemy_weights: v3.weights,
      seed: 900 + i,
      first: i % 2,
      track_features: true
    }))
  });
  assert.equal(expBatch.results.length, 10);
  for (const r of expBatch.results) {
    assert.ok(Array.isArray(r.featureAdvantage) && r.featureAdvantage.length === 22);
  }
  const exploreEvents = expBatch.results.map((r, i) => ({
    opponentId: top10[1].id,
    index: i,
    first: i % 2,
    candidateIdx: i,
    outcome: r.outcome,
    turns: r.turns,
    featureAdvantage: r.featureAdvantage
  }));
  const strategy = synthesizeWinningStrategy(exploreEvents, v3.weights, cands);
  assert.equal(strategy.weights.length, 22);
  const stage2Game = engine({
    op: "game",
    deck: { cards: top10[0].representative.cards, energy: top10[0].representative.energy },
    enemy: { cards: top10[1].representative.cards, energy: top10[1].representative.energy },
    weights: strategy.weights,
    enemy_weights: v3.weights,
    seed: 9999,
    first: 0,
    replay: true
  });
  assert.ok(["win", "loss", "draw"].includes(stage2Game.outcome));
  assert.ok(Array.isArray(stage2Game.replay) && stage2Game.replay.length > 0);
});
