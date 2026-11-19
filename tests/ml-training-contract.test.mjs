import assert from 'node:assert/strict';
import test from 'node:test';
import {fitDistribution, buildPopulation, scheduleTraining, featureNames, baselineWeights} from '../tools/battle/trainer.mjs';

test('CEM retains incumbent and deterministically samples signed, bounded mutations', () => {
  const mean = [...baselineWeights];
  const sigma = mean.map(weight => Math.max(0.2, Math.abs(weight) / 3));
  const schedule = buildPopulation(mean, sigma, mean, 3);
  assert.deepEqual(schedule, buildPopulation(mean, sigma, mean, 3));
  assert.equal(schedule.length, 24);
  assert.equal(featureNames.length, 22);
  assert.deepEqual(schedule[0], mean);
  assert.equal(new Set(schedule.map(w => JSON.stringify(w))).size, 24);
  assert.ok(schedule.every(vector => vector.every(w => Number.isFinite(w) && Math.abs(w) <= 8)));
});

test('CEM refits weights to successful candidates and retains exploration', () => {
  const d = fitDistribution([0,0], [1,1], [[2,0],[2,0]]);
  assert.deepEqual(d.mean, [1.5,0]);
  assert.deepEqual(d.sigma, [0.25,0.25]);
});

test('training uses every designated training deck, exact four-way seat crosses, and phase-specific seeds', () => {
  const ranks = Array.from({length:16}, (_, idx) => 11 + idx);
  const games = scheduleTraining(ranks, 0, false);
  assert.equal(games.length, 96);
  assert.deepEqual([...new Set(games.map(g => g.deckRank))].sort((a,b)=>a-b), ranks);
  assert.equal(games.filter(g => g.first === 0).length, 48);
  assert.equal(games.filter(g => g.opponent === 'incumbent').length, 0);
  const second = scheduleTraining(ranks, 1, true);
  assert.equal(second.filter(g => g.opponent === 'incumbent').length, 48);
  assert.ok(second.every(g => !games.some(h => g.seed === h.seed)));
});

