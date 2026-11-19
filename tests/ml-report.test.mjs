import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {freezeLineup} from '../tools/battle/freeze.mjs';
import {verifyRun} from '../tools/battle/verify-report.mjs';

const digest=s=>createHash('sha256').update(s).digest('hex');
async function example(t){
  const dir=await mkdtemp(join(tmpdir(),'pocket-frozen-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const entries=Array.from({length:32},(_,i)=>({id:'deck-'+(i+1),name:'Deck '+(i+1),representative:{
    cards:Array.from({length:10},(_,j)=>({id:'set-'+(i*10+j),count:2})),energy:['Water'],url:'https://example.org/deck/'+i}}));
  const path=join(dir,'meta.json');
  const source=JSON.stringify({season:'C1',asOf:'2026-11-19T00:00:00Z',hash:'a'.repeat(64),entries});
  await writeFile(path,source);
  await freezeLineup(dir,path);
  return {dir,path,source};
}
test('freeze is byte-stable, pinned to initial input and robust to subsequent meta changes',async t=>{
  const {dir,path,source}=await example(t);
  const before=await readFile(join(dir,'lineup.json'),'utf8');
  await writeFile(path,'{}');
  await freezeLineup(dir,path);
  const frozen=JSON.parse(before);
  assert.equal(await readFile(join(dir,'lineup.json'),'utf8'),before);
  assert.equal(frozen.source.sha256,digest(source));
  assert.deepEqual(frozen.decks.map(d=>d.rank),Array.from({length:30},(_,i)=>i+1));
  assert.equal(frozen.decks[29].sourceUrl,'https://example.org/deck/29');
});
function fixtures(){
  const shape={turns:4,actions:12,points:[3,0]};
  const mirror=[],evaluation=[];
  for(let rank=1;rank<=10;rank++){
    for(let index=0;index<50;index++)mirror.push({rank,id:'deck-'+rank,index,first:index<25?0:1,seed:index,outcome:index<25?'win':'loss',...shape});
    for(let other=rank+1;other<=10;other++)for(let seed=0;seed<12;seed++)for(const deckRank of [rank,other])for(const first of [0,1]){
      evaluation.push({ranks:[rank,other],deckRank,first,seed,outcome:seed<6?'win':'draw',...shape});
    }
  }
  return {mirror,evaluation};
}
async function put(dir,file,rows){await writeFile(join(dir,file),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
test('reconstructs 500 + 2160 individual games, intervals and reports',async t=>{
  const {dir}=await example(t);
  const {mirror,evaluation}=fixtures();
  await put(dir,'mirror-500.jsonl',mirror);
  await put(dir,'eval.jsonl',evaluation);
  const {mirror:summary,evaluation:scores}=await verifyRun(dir);
  assert.equal(summary.total,500);
  assert.equal(summary.playerDeck.rank,1);
  assert.equal(summary.byRank[0].winRateCI95.length,2);
  assert.equal(summary.byRank[0].bySeat.first.wins,25);
  assert.equal(summary.byRank[0].bySeat.second.losses,25);
  assert.equal(summary.byRank.length,10);
  assert.equal(summary.byRank[0].wins,25);
  assert.equal(scores.draws,1080);
  assert.equal(scores.wins,1080);
  assert.equal(scores.score,0.75);
  assert.equal(scores.byMatchup.length,45);
  assert.equal(scores.clusters,540);
  assert.equal(scores.beatsBaseline,true);
  assert.ok(scores.scoreCI95[0]<0.75&&scores.scoreCI95[1]>0.75);
  const first=await readFile(join(dir,'report.json'),'utf8');
  await verifyRun(dir);
  assert.equal(await readFile(join(dir,'report.json'),'utf8'),first);
  const prose=await readFile(join(dir,'report.md'),'utf8');
  assert.ok(prose.includes('2160')&&prose.includes('第 1 名為玩家範例牌組')&&prose.includes('綜合勝率 50.00%'));
});
test('rejects duplicated seed orientations, wrong mirror seating, wrong deck identity and training ranks',async t=>{
  const {dir}=await example(t);
  const {mirror,evaluation}=fixtures();
  await put(dir,'mirror-500.jsonl',mirror);
  await put(dir,'eval.jsonl',[evaluation[1],...evaluation.slice(1)]);
  await assert.rejects(verifyRun(dir),/orientation|座位/);
  await put(dir,'eval.jsonl',[{...evaluation[0],ranks:[1,11]},...evaluation.slice(1)]);
  await assert.rejects(verifyRun(dir),/rank|留出/);
  await put(dir,'mirror-500.jsonl',[{...mirror[0],first:1},...mirror.slice(1)]);
  await assert.rejects(verifyRun(dir),/first|先手/);
  await put(dir,'mirror-500.jsonl',[{...mirror[0],id:'foreign'},...mirror.slice(1)]);
  await assert.rejects(verifyRun(dir),/deck|牌組/);
});
