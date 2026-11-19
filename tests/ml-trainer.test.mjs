import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditEvaluation, auditMirror, auditTrace, auditModels, sampleMirror } from '../tools/battle/verify-replay.mjs';
import {scheduleHoldout,scheduleTraining,scheduleMirror,seed32} from '../tools/battle/trainer.mjs';
import {verifyRun as generateReport} from '../tools/battle/verify-report.mjs';

const ranks = Array.from({length:10}, (_, i) => ({rank:i+1, id:'opponent-'+(i+1)}));
const result = {turns:12, actions:2, points:[3,0], outcome:'win'};
const mirror = ranks.flatMap(({rank,id}) => Array.from({length:50}, (_,index) => ({
  ...result, rank,id,index,first:index<25?0:1,seed:rank*50+index
})));

test('independent mirror audit recomputes wins, draws and losses and picks both seats', () => {
  const rows = mirror.map((r,i) => ({...r,outcome:i<25?'win':i<100?'draw':'loss'}));
  const summary=auditMirror(rows,ranks);
  assert.deepEqual([summary.wins,summary.draws,summary.losses,summary.total,summary.winRate],[25,75,400,500,.05]);
  const sample=sampleMirror([...rows].reverse());
  assert.deepEqual(sample.map(x => [x.rank,x.first]),[[1,0],[1,1],[5,0],[5,1],[10,0],[10,1]]);
  assert.throws(() => auditMirror([...rows.slice(1),rows[1]],ranks),/duplicate/i);
  assert.throws(() => auditMirror(rows.slice(1),ranks),/500/);
  assert.throws(() => auditMirror(rows.map((x,i) => i===0?{...x,first:1}:x),ranks),/seat/i);
});

test('holdout audit checks each rank-pair, candidate ownership and both seats individually', () => {
  const trio=ranks.slice(0,3);
  const rows=[];
  for (const [i,j] of [[1,2],[1,3],[2,3]]) {
    for (const deckRank of [i,j]) for (const first of [0,1]) for (const seed of [4,7]) {
      rows.push({...result,ranks:[i,j],deckRank,first,seed});
    }
  }
  assert.equal(auditEvaluation(rows,trio,2).total,24);
  assert.throws(() => auditEvaluation(rows.map((x,i) => i===3?rows[2]:x),trio,2),/duplicate/i);
  assert.throws(() => auditEvaluation(rows.map((x,i) => i===0?{...x,deckRank:3}:x),trio,2),/rank/i);
  assert.throws(() => auditEvaluation(rows.map((x,i) => i===0?{...x,seed:333}:x),trio,2),/Unpaired/);
});

test('training, validation, holdout and mirror schedules use disjoint reproducible seeds', () => {
  assert.equal(seed32('hello'),0x4f9f2cab);
  const trainingRanks=Array.from({length:16},(_,i)=>i+11);
  const training=Array.from({length:8},(_,i)=>scheduleTraining(trainingRanks,i,i>0)).flat();
  const validation=scheduleHoldout([27,28,29,30],8,'validation');
  const testRanks=ranks.map(x=>x.rank);
  const holdout=scheduleHoldout(testRanks,12,'test');
  const mirrorRows=scheduleMirror(ranks);
  assert.deepEqual(holdout,scheduleHoldout([...testRanks].reverse(),12,'test'));
  assert.equal(auditEvaluation(holdout.map(r=>({...r,...result})),ranks).total,2160);
  assert.equal(auditMirror(mirrorRows.map(r=>({...r,...result})),ranks).total,500);
  const seeds=[training,validation,holdout,mirrorRows].map(rows=>new Set(rows.map(r=>r.seed)));
  const union=new Set(seeds.flatMap(group=>[...group]));
  assert.equal(union.size,seeds.reduce((n,s)=>n+s.size,0));
  assert.equal(seeds[2].size,540);
  assert.equal(seeds[3].size,500);
});

test('replay audit catches a changed action or score in a run having the same result', () => {
  const recorded = {...result, actions:2,first:0};
  const replay = {...recorded,replay:[
    {turn:1,actor:0,action:'Place',points:[0,0]},
    {turn:12,actor:0,action:'Attack',points:[3,0]}
  ]};
  assert.match(auditTrace(recorded,replay,structuredClone(replay)),/^[\da-f]{64}$/);
  const diverged=structuredClone(replay);
  diverged.replay[0].action='Attach';
  assert.throws(()=>auditTrace(recorded,replay,diverged),/trace/i);
  assert.throws(()=>auditTrace({...recorded,points:[2,1]},replay,replay),/points/i);
  assert.throws(()=>auditTrace(recorded,{...replay,replay:[]},replay));
});

test('model audit distinguishes frozen hand weights and an actually trained model', () => {
  const baseline={features:22,weights:Array(22).fill(0),version:'baseline-v0',trainedGames:0,engineCommit:'a'.repeat(40),source:'rule baseline',createdAt:'2026-11-19T08:00:00Z'};
  const candidate={...baseline,version:'candidate-v1',weights:[1,...Array(21).fill(0)],trainedGames:500,source:'evolution strategy'};
  auditModels(baseline,candidate);
  assert.throws(()=>auditModels(baseline,{...candidate,trainedGames:0}));
  assert.throws(()=>auditModels(baseline,{...candidate,weights:[0,1]}));
  assert.throws(()=>auditModels(baseline,{...candidate,engineCommit:'b'.repeat(40)}));
});

test('report keeps each quartet intact and gives draws half credit only in evaluation score', async t => {
  const folder=await mkdtemp(join(tmpdir(),'ptcgp-stats-test-'));
  t.after(() => rm(folder,{recursive:true,force:true}));
  const decks=Array.from({length:30},(_,i)=>({
    rank:i+1,id:'opponent-'+(i+1),name:'Fixture '+(i+1),sourceUrl:'https://example.org/events/'+i,
    energy:['Grass'],cards:Array.from({length:10},(_,j)=>({id:'A1-'+String(1+i+j).padStart(3,'0'),count:2}))
  }));
  const source={season:'fixture',asOf:'2026-11-19T00:00:00Z',hash:'1'.repeat(64),sha256:'2'.repeat(64)};
  const holdout=scheduleHoldout(ranks.map(d=>d.rank),12,'statistics-test').map(row=>({
    ...row,...result,
    // Each matchup/seed quartet has exactly two draws, a win and a loss.
    outcome:row.first===1?'draw':row.deckRank===row.ranks[0]?'win':'loss'
  }));
  const jsonl = rows => rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  await Promise.all([
    writeFile(join(folder,'lineup.json'),JSON.stringify({decks,source})),
    writeFile(join(folder,'eval.jsonl'),jsonl(holdout)),
    writeFile(join(folder,'mirror-500.jsonl'),jsonl(mirror))
  ]);
  const report=await generateReport(folder);
  assert.equal(report.evaluation.total,2160);
  assert.equal(report.evaluation.winRate,.25);
  assert.equal(report.evaluation.score,.5);
  assert.deepEqual(report.evaluation.scoreCI95,[.5,.5]);
  assert.equal(report.evaluation.clusters,540);
  assert.deepEqual(report.evaluation.scoreDifferenceCI95,[0,0]);
});
