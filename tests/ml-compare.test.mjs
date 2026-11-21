import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {comparePolicies} from '../tools/battle/compare-policies.mjs';

function games(seedsPerPair, outcome) {
  const rows = [];
  for (let a=1;a<10;a++) for (let b=a+1;b<=10;b++) {
    for (let seed=1;seed<=seedsPerPair;seed++) {
      for (const deckRank of [a,b]) for (const first of [0,1]) {
        const game = {ranks:[a,b],deckRank,first,seed,turns:9,actions:45,points:[3,3]};
        rows.push({...game,outcome:outcome(game)});
      }
    }
  }
  return rows;
}
async function sample(t) {
  const dir=await mkdtemp(join(tmpdir(),'pocket-promote-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const write=async rows=>{
    const text=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
    await writeFile(join(dir,'challenge.jsonl'),text);
    return createHash('sha256').update(text).digest('hex');
  };
  return {dir,write};
}

test('default full direct challenge promotes V2 only with score CI strictly above half',async t=>{
  const {dir,write}=await sample(t);
  const rows=games(32,g=>g.seed%4===0?'loss':g.seed%4===1?'draw':'win');
  const digest=await write(rows);
  const report=await comparePolicies(dir);
  assert.equal(report.games,5760);
  assert.deepEqual([report.wins,report.draws,report.losses],[2880,1440,1440]);
  assert.equal(report.clusters,1440);
  assert.equal(report.seedsPerPair,32);
  assert.equal(report.byMatchup.length,45);
  assert.equal(report.byMatchup[0].games,128);
  assert.equal(report.winRate,.5);
  assert.equal(report.score,.625);
  assert.ok(report.scoreCI95[0]>.5&&report.scoreCI95[1]>.625);
  assert.equal(report.promote,true);
  assert.equal(report.decision,'promote-v2');
  assert.equal(report.challengeSha256,digest);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'promotion.json'),'utf8')),report);
  await write(rows.reverse());
  assert.deepEqual((await comparePolicies(dir)).scoreCI95,report.scoreCI95);
});

test('a quartet with two wins and two losses has constant half score and retains V1',async t=>{
  const {dir,write}=await sample(t);
  await write(games(5,g=>g.first===0?'win':'loss'));
  const report=await comparePolicies(dir,5);
  assert.deepEqual(report.scoreCI95,[.5,.5]);
  assert.equal(report.promote,false);
  assert.equal(report.decision,'retain-v1');
  await assert.rejects(comparePolicies(dir),/32 seed/);
});

test('rejects missing or duplicated seats, missing pairings, foreign deck ranks and invalid seeds',async t=>{
  const {dir,write}=await sample(t);
  const rows=games(2,()=>'win');
  for (const [replacement,pattern] of [
    [[rows[1],...rows.slice(1)],/duplicate orientation/i],
    [rows.slice(1),/four orientations/i],
    [rows.slice(8),/45 matchups/i],
    [[{...rows[0],ranks:[1,11]},...rows.slice(1)],/ranks/],
    [[{...rows[0],deckRank:3},...rows.slice(1)],/deckRank/],
    [[{...rows[0],first:true},...rows.slice(1)],/first/],
    [[{...rows[0],seed:-1},...rows.slice(1)],/seed/],
    [[{...rows[0],outcome:null},...rows.slice(1)],/outcome/],
  ]) {
    await write(replacement);
    await assert.rejects(comparePolicies(dir,2),pattern);
  }
  await assert.rejects(readFile(join(dir,'promotion.json')),{code:'ENOENT'});
});
