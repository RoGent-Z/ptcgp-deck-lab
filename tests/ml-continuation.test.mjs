import assert from 'node:assert/strict';
import test from 'node:test';
import { continuationSchedule, validationSchedule, challengeSchedule, continuationMirror, confirmSchedule } from '../tools/battle/trainer-v2.mjs';

test('each v2 generation balances deck ownership, starting seats and fixed/current opponents', () => {
  const schedule=continuationSchedule(0);
  assert.equal(schedule.length,192);
  assert.deepEqual(schedule,continuationSchedule(0));
  assert.equal(new Set(schedule.map(row=>row.seed)).size,48);
  for(let rank=11;rank<=26;rank++) for(const first of [0,1]){
    assert.equal(schedule.filter(row=>row.deckRank===rank && row.first===first && row.opponent==='baseline').length,4);
    assert.equal(schedule.filter(row=>row.deckRank===rank && row.first===first && row.opponent==='incumbent').length,2);
  }
  assert.ok(continuationSchedule(1).every(row=>!schedule.some(prior=>prior.seed===row.seed)));
});
test('v2 confirmation and test use separate random sequences and disjoint ranks', () => {
  const train=continuationSchedule(0), validate=validationSchedule(), confirm=confirmSchedule(), challenge=challengeSchedule();
  assert.equal(validate.length,768);
  assert.equal(confirm.length,1152);
  assert.equal(challenge.length,5760);
  const all=[train,validate,confirm,challenge].map(rows=>new Set(rows.map(row=>row.seed)));
  for(let a=0;a<all.length;a++) for(let b=a+1;b<all.length;b++){
    assert.ok([...all[a]].every(seed=>!all[b].has(seed)));
  }
  assert.ok(challenge.every(row=>row.ranks.every(rank=>rank>=1 && rank<=10)));
  assert.ok([...validate,...confirm].every(row=>row.ranks.every(rank=>rank>=27 && rank<=30)));
});
test('v2 example uses exactly fifty real requests per original top rank', () => {
  const lineup={decks:Array.from({length:30},(_,i)=>({rank:i+1,id:'deck-'+(i+1)}))};
  const rows=continuationMirror(lineup);
  assert.equal(rows.length,500);
  assert.equal(new Set(rows.map(r=>r.seed)).size,500);
  assert.deepEqual(rows.filter(r=>r.rank===10).map(r=>r.first),[...Array(25).fill(0),...Array(25).fill(1)]);
});

