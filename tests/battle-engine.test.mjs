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
