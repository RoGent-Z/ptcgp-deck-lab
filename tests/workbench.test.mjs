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
  createEmptyExploreStats,
  mergeExploreChunkStats,
  synthesizeWinningStrategyFromStats,
  EXPLORE_TOTAL_GAMES,
  EXPLORE_GAMES_PER_OPPONENT,
  GAMES_PER_OPPONENT,
  FIRST_SEAT_GAMES,
  TOTAL_BATCH_GAMES,
  DEEP_EXPLORE_GAMES,
  DEEP_GAMES_PER_OPPONENT
} from '../public/app/core.mjs';
const cards = new Map(Array.from({length:11},(_,i)=>['A1-'+String(i+1).padStart(3,'0'), {name:i===10?'妙蛙種子':i===0?'妙蛙種子':'牌'+i, type:'pokemon', stage:i===0?'basic':'stage1'}]));
const complete={name:'测试',cards:Array.from(cards.keys()).slice(0,10).map(id=>({id,count:2})),energy:['Grass']};
test('valid 20-card deck and energy persist through exchange',()=>{assert.deepEqual(validateDeck(complete,cards),[]);assert.deepEqual(readDeckFile(JSON.stringify(complete)).cards, complete.cards)});
test('same name across printings triggers shared cap',()=>{const altered=structuredClone(complete);altered.cards[9].id='A1-011';assert.match(validateDeck(altered,cards).join(' '),/妙蛙種子/)});
test('invalid import is rejected without partial coercion',()=>{for(const bad of [{...complete,cards:[{id:'A1-005',count:0}]},{...complete,energy:['Typo']},{...complete,cards:[{id:'A1-001',count:'2'}]}]) assert.throws(()=>readDeckFile(JSON.stringify(bad)))});
test('search handles compact card id',()=>{assert.equal(normalizeSearch(' A1－001 '),'a1001')});
test('aggregate includes draws, rejects duplicate slot, incomplete seeds',()=>{let events=[{opponentId:'a',index:0,outcome:'win'},{opponentId:'a',index:0,outcome:'loss'},{opponentId:'a',index:1,outcome:'draw'},{opponentId:'a',index:2,outcome:'skip'},{opponentId:'b',index:2,outcome:'loss'}];const accepted=validOutcomes(events,['a','b']);assert.equal(accepted.length,3);assert.equal(resultsFor(accepted,'a').length,2);assert.deepEqual(aggregate(accepted),{wins:1,draws:1,losses:1,total:3});assert.equal(summarizeBatch(accepted,['a','b']).complete,false)});
test('computeCompositeWinRate and two-stage 100k-explore + 5k-test strategy synthesis work cleanly',()=>{
  assert.equal(EXPLORE_TOTAL_GAMES,100000);
  assert.equal(EXPLORE_GAMES_PER_OPPONENT,10000);
  assert.equal(GAMES_PER_OPPONENT,500);
  assert.equal(FIRST_SEAT_GAMES,250);
  assert.equal(TOTAL_BATCH_GAMES,5000);
  assert.equal(DEEP_EXPLORE_GAMES,100000);
  assert.equal(DEEP_GAMES_PER_OPPONENT,5000);
  assert.equal(isEngineImplementedStatus('Fully implemented'),true);
  assert.equal(isEngineImplementedStatus('Unknown card'),false);
  const lineup=[{rank:1,entry:{id:'a',name:'A',share:0.3}},{rank:2,entry:{id:'b',name:'B',share:0.1}}];
  const events=[
    ...Array.from({length:10},(_,i)=>({opponentId:'a',index:i,outcome:i<8?'win':'loss',turns:8})),
    ...Array.from({length:10},(_,i)=>({opponentId:'b',index:250+i,outcome:i<2?'win':'loss',turns:10}))
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

  // Verify 100,000-game chunked sufficient-statistics merging & winning-strategy synthesis
  const baseW=Array(22).fill(0.5);
  const cands=buildExplorationCandidates(baseW,'unit-test',20);
  assert.equal(cands.length,20);
  assert.deepEqual(cands[0],baseW);
  const acc=createEmptyExploreStats(['a','b'],20);
  const makeChunk=(startGame,oppIdx)=>({
    startGame,
    completed:1000,
    wins:520,
    draws:40,
    losses:440,
    turnsSum:9000,
    byCandidate:Array.from({length:20},(_,c)=>({
      games:50,
      wins:c===4?36:25,
      draws:2,
      losses:c===4?12:23,
      winFeatSum:Array.from({length:22},(_,f)=>f===0?12:1),
      winFeatCount:c===4?36:25,
      lossFeatSum:Array.from({length:22},(_,f)=>f===0?-6:0),
      lossFeatCount:c===4?12:23
    })),
    byOpponent:['a','b'].map((id,idx)=>({
      id,
      games:idx===oppIdx?1000:0,
      wins:idx===oppIdx?520:0,
      draws:idx===oppIdx?40:0,
      losses:idx===oppIdx?440:0,
      byCandidate:Array.from({length:20},(_,c)=>({
        games:idx===oppIdx?50:0,
        wins:idx===oppIdx?(c===4?36:25):0,
        draws:idx===oppIdx?2:0,
        losses:idx===oppIdx?(c===4?12:23):0
      })),
      winFeatSum:Array(22).fill(idx===oppIdx?10:0),
      winFeatCount:idx===oppIdx?520:0,
      lossFeatSum:Array(22).fill(0),
      lossFeatCount:idx===oppIdx?440:0
    }))
  });
  mergeExploreChunkStats(acc,makeChunk(0,0));
  mergeExploreChunkStats(acc,makeChunk(1000,1));
  const strat=synthesizeWinningStrategyFromStats(acc,baseW,cands);
  assert.equal(strat.exploreTotal,2000);
  assert.equal(strat.exploreWins,1040);
  assert.equal(strat.weights.length,22);
  assert.ok(strat.byOpponent.a && strat.byOpponent.b);
  assert.equal(strat.topAdjustments.length,6);
  assert.equal(strat.allAdjustments.length,22);

  // Also ensure legacy event-array synthesizeWinningStrategy stays functional
  const legacy=synthesizeWinningStrategy([
    {opponentId:'a',index:0,candidateIdx:4,outcome:'win',featureAdvantage:Array(22).fill(0.1)},
    {opponentId:'a',index:1,candidateIdx:0,outcome:'loss',featureAdvantage:Array(22).fill(-0.1)}
  ],baseW,cands);
  assert.equal(legacy.weights.length,22);
});

