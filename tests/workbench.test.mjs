import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDeck,
  readDeckFile,
  normalizeSearch,
  resultsFor,
  aggregate,
  validOutcomes,
  summarizeBatch,
  computeCompositeWinRate,
  isEngineImplementedStatus,
  buildExplorationCandidates,
  synthesizeWinningStrategy,
  EXPLORE_TOTAL_GAMES,
  EXPLORE_GAMES_PER_OPPONENT,
  GAMES_PER_OPPONENT,
  FIRST_SEAT_GAMES,
  TOTAL_BATCH_GAMES,
  DEEP_GAMES_PER_OPPONENT
} from '../public/app/core.mjs';
const cards = new Map(Array.from({length:11},(_,i)=>['A1-'+String(i+1).padStart(3,'0'), {name:i===10?'妙蛙種子':i===0?'妙蛙種子':'牌'+i, type:'pokemon', stage:i===0?'basic':'stage1'}]));
const complete={name:'测试',cards:Array.from(cards.keys()).slice(0,10).map(id=>({id,count:2})),energy:['Grass']};
test('valid 20-card deck and energy persist through exchange',()=>{assert.deepEqual(validateDeck(complete,cards),[]);assert.deepEqual(readDeckFile(JSON.stringify(complete)).cards, complete.cards)});
test('same name across printings triggers shared cap',()=>{const altered=structuredClone(complete);altered.cards[9].id='A1-011';assert.match(validateDeck(altered,cards).join(' '),/妙蛙種子/)});
test('invalid import is rejected without partial coercion',()=>{for(const bad of [{...complete,cards:[{id:'A1-005',count:0}]},{...complete,energy:['Typo']},{...complete,cards:[{id:'A1-001',count:'2'}]}]) assert.throws(()=>readDeckFile(JSON.stringify(bad)))});
test('search handles compact card id',()=>{assert.equal(normalizeSearch(' A1－001 '),'a1001')});
test('aggregate includes draws, rejects duplicate slot, incomplete seeds',()=>{let events=[{opponentId:'a',index:0,outcome:'win'},{opponentId:'a',index:0,outcome:'loss'},{opponentId:'a',index:1,outcome:'draw'},{opponentId:'a',index:2,outcome:'skip'},{opponentId:'b',index:2,outcome:'loss'}];const accepted=validOutcomes(events,['a','b']);assert.equal(accepted.length,3);assert.equal(resultsFor(accepted,'a').length,2);assert.deepEqual(aggregate(accepted),{wins:1,draws:1,losses:1,total:3});assert.equal(summarizeBatch(accepted,['a','b']).complete,false)});
test('computeCompositeWinRate and two-stage 1000-explore + 500-test strategy synthesis work cleanly',()=>{
  assert.equal(EXPLORE_TOTAL_GAMES,1000);
  assert.equal(EXPLORE_GAMES_PER_OPPONENT,100);
  assert.equal(GAMES_PER_OPPONENT,50);
  assert.equal(FIRST_SEAT_GAMES,25);
  assert.equal(TOTAL_BATCH_GAMES,500);
  assert.equal(DEEP_GAMES_PER_OPPONENT,500);
  assert.equal(isEngineImplementedStatus('Fully implemented'),true);
  assert.equal(isEngineImplementedStatus('Unknown card'),false);
  const lineup=[{rank:1,entry:{id:'a',name:'A',share:0.3}},{rank:2,entry:{id:'b',name:'B',share:0.1}}];
  const events=[
    ...Array.from({length:10},(_,i)=>({opponentId:'a',index:i,outcome:i<8?'win':'loss',turns:8})),
    ...Array.from({length:10},(_,i)=>({opponentId:'b',index:25+i,outcome:i<2?'win':'loss',turns:10}))
  ];
  const comp=computeCompositeWinRate(events,lineup);
  assert.equal(comp.total,20);
  assert.equal(comp.wins,10);
  assert.ok(Math.abs(comp.equalWinRate-0.5)<1e-9);
  // Weighted: (0.8 * 0.3 + 0.2 * 0.1) / (0.3 + 0.1) = 0.26 / 0.4 = 0.65
  assert.ok(Math.abs(comp.weightedWinRate-0.65)<1e-9);
  assert.ok(Math.abs(comp.first.winRate-0.8)<1e-9);
  assert.ok(Math.abs(comp.second.winRate-0.2)<1e-9);
  assert.equal(comp.avgTurns,9);

  // Verify 1,000-game exploration candidate generation & winning-game strategy synthesis
  const baseW=Array(22).fill(0.5);
  const cands=buildExplorationCandidates(baseW,'unit-test',10);
  assert.equal(cands.length,10);
  assert.deepEqual(cands[0],baseW);
  const expEvents=[];
  for(let i=0;i<100;i++){
    const candIdx=i%10;
    const isWin=(candIdx===3 || candIdx===4) ? (i<90) : (i%5===0);
    expEvents.push({
      opponentId:i<50?'a':'b',
      index:i%50,
      first:i%2,
      candidateIdx:candIdx,
      outcome:isWin?'win':'loss',
      featureAdvantage:Array.from({length:22},(_,f)=>isWin?(f===0?0.4:0.05):(f===0?-0.2:0))
    });
  }
  const strat=synthesizeWinningStrategy(expEvents,baseW,cands);
  assert.equal(strat.exploreTotal,100);
  assert.ok(strat.exploreWins>0);
  assert.equal(strat.weights.length,22);
  assert.ok(strat.weights[0]>baseW[0]);
  assert.ok(strat.byOpponent.a && strat.byOpponent.b);
  assert.equal(strat.topAdjustments.length,6);
  assert.equal(strat.allAdjustments.length,22);
});

