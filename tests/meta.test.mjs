import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalCard, eligibleEvent, deckFromList, summarizeEvent, rankEvents, seasonWindow} from '../tools/meta/rank.mjs';

const detail = {id:'e1',game:'POCKET',date:'2026-11-18T00:00:00Z',name:'Standard Cup',isPublic:true,decklists:true,format:null};
const list = {pokemon:Array.from({length:9},(_,i)=>({set:'A2b',number:i+1,count:2})),trainer:[{set:'P-A',number:'7',count:2}],energy:['Grass']};
const entry=(player,deck,placing,decklist=list)=>({player,deck:{id:deck,name:deck},placing,decklist});

test('source IDs and verified format flags preserve game semantics',()=>{
  assert.equal(canonicalCard('A2b','7'),'A2b-007');
  assert.equal(canonicalCard('P-A','7'),'P-A-007');
  assert.equal(eligibleEvent(detail,'Standard format'),true);
  assert.equal(eligibleEvent(detail,''),false);
  assert.equal(eligibleEvent({...detail,format:'NOEX'},'Standard format'),false);
  assert.equal(eligibleEvent({...detail,multideck:true},'Standard format'),false);
  assert.equal(eligibleEvent({...detail,bannedCards:['a']},'Standard format'),false);
  assert.equal(eligibleEvent({...detail,name:'C1 ONLY tournament'},'Standard format'),false);
  assert.equal(eligibleEvent({...detail,name:'Standard CUP | ENG only'},'Standard format'),true);
  assert.equal(deckFromList(list).cards.length,10);
  assert.equal(deckFromList({...list,energy:[]}),null);
  assert.equal(deckFromList({...list,pokemon:list.pokemon.slice(1)}),null);
});

test('Swiss and bracket pairing WDL counts one match each, excludes byes/double losses',()=>{
  const pairs=[{round:1,phase:1,table:1,player1:'p',player2:'q',winner:0},{round:2,phase:1,table:1,player1:'p',winner:'p'},{round:3,phase:1,table:1,player1:'p',player2:'q',winner:-1},{round:4,phase:2,match:'T2-1',player1:'p',player2:'q',winner:'p',games:{1:{winner:'p'},2:{winner:'q'},3:{winner:'p'}}}];
  const event=summarizeEvent(detail,[entry('p','deck1',1),entry('q','deck2',2)],pairs);
  const {entries,players,matches}=rankEvents([event]);
  assert.equal(players,2);assert.equal(matches,2);
  assert.deepEqual(entries.map(({wins,draws,losses,champions,top8})=>[wins,draws,losses,champions,top8]),[[1,1,0,1,1],[0,1,1,0,1]]);
  assert.equal(entries[0].winRate,0.5);assert.equal(entries[0].share,0.5);
});

test('representative is the most frequent complete list and retains actual source',()=>{
  const alternative={...list,energy:['Water']};
  const players=[entry('first','deck',1,alternative),entry('runner','deck',2),entry('fourth','deck',4),entry('unknown',null,5)];
  const event=summarizeEvent(detail,players,[]);
  const aggregate=rankEvents([event]);
  assert.equal(aggregate.entries[0].count,3);
  assert.equal(aggregate.entries[0].share,0.75);
  assert.equal(aggregate.entries[0].representative.frequency,2);
  assert.equal(aggregate.entries[0].representative.url,'https://play.limitlesstcg.com/tournament/e1/player/runner/decklist');
  assert.equal(aggregate.entries[0].winRate,null);
});

test('window never crosses a format boundary; established windows use 28 UTC calendar days',()=>{
  assert.equal(seasonWindow('2026-11-19T03:00:00Z','2026-10-29T01:00:00Z'),'2026-10-29T01:00:00.000Z');
  assert.equal(seasonWindow('2026-12-05T03:00:00Z','2026-10-29T01:00:00Z'),'2026-11-08T00:00:00.000Z');
});
