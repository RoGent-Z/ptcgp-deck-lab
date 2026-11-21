import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { instantiateBattle } from "../public/battle/runtime.mjs";

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

test("deployed trained models (v1/v2) and manifest execute WASM batch deterministically", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/battle/models/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.defaultModelId, "v1");
  const v1 = JSON.parse(await readFile(new URL("../public/battle/models/v1.json", import.meta.url), "utf8"));
  const v2 = JSON.parse(await readFile(new URL("../public/battle/models/v2.json", import.meta.url), "utf8"));
  assert.equal(v1.weights.length, 22);
  assert.equal(v2.weights.length, 22);

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
      weights: v1.weights,
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
});
