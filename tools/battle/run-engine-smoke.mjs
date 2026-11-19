import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const snapshot = JSON.parse(await readFile(new URL('../../public/data/meta.top.json',import.meta.url),'utf8'));
const decks = snapshot.entries.slice(0,10).map(x => x.representative);
const distinct = [...new Set(decks.flatMap(deck=>deck.cards.map(c=>c.id)))];
const weights = [-5,-2,4,2,5,1,2,3,2,2,3,6,1,7,1,5,0.5,-2,5,1,2,3];
const runner = spawn(process.execPath,[fileURLToPath(new URL('run-engine.mjs',import.meta.url))],
  {stdio:['pipe','pipe','inherit'],windowsHide:true});
const lines = createInterface({input:runner.stdout})[Symbol.asyncIterator]();
async function query(request) {
  runner.stdin.write(JSON.stringify(request)+'\n');
  const response = await lines.next();
  assert.equal(response.done,false,'engine exited before replying');
  return JSON.parse(response.value);
}
try {
  const {coverage} = await query({op:'coverage',ids:[...distinct,'UNKNOWN-999']});
  assert.equal(coverage['UNKNOWN-999'],'Unknown card');
  for (const id of distinct) assert.equal(coverage[id],'Fully implemented',id);
  const games = decks.map((enemy,i)=>({op:'game',deck:decks[0],enemy,first:i%2,weights,seed:31+i}));
  const start = Date.now();
  const batch = await query({op:'batch',games});
  assert.equal(batch.results.length,10);
  for (const [i,result] of batch.results.entries()) {
    assert.ok(['draw','loss','win'].includes(result.outcome),'match '+i+': '+JSON.stringify(result));
    assert.equal(result.first,i%2);
  }
  for (const game of games.slice(0,2)) {
    const replay = await query({...game,replay:true});
    assert.deepEqual(await query({...game,replay:true}),replay);
    assert.equal(replay.replay.find(ply=>ply.turn===1).actor,game.first);
  }
  assert.match((await query({...games[0],deck:{...decks[0],cards:[]}})).error,/20/);
  console.log(JSON.stringify({covered:distinct.length,matches:batch.results.length,replays:2,
    elapsedMs:Date.now()-start,outcomes:batch.results.map(r=>r.outcome)}));
} finally {
  runner.stdin.end();
}
