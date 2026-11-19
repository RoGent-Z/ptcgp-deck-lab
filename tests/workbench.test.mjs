import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeck, readDeckFile, normalizeSearch, resultsFor, aggregate, validOutcomes, summarizeBatch } from '../public/app/core.mjs';
const cards = new Map(Array.from({length:11},(_,i)=>['A1-'+String(i+1).padStart(3,'0'), {name:i===10?'妙蛙種子':i===0?'妙蛙種子':'牌'+i, type:'pokemon', stage:i===0?'basic':'stage1'}]));
const complete={name:'测试',cards:Array.from(cards.keys()).slice(0,10).map(id=>({id,count:2})),energy:['Grass']};
test('valid 20-card deck and energy persist through exchange',()=>{assert.deepEqual(validateDeck(complete,cards),[]);assert.deepEqual(readDeckFile(JSON.stringify(complete)).cards, complete.cards)});
test('same name across printings triggers shared cap',()=>{const altered=structuredClone(complete);altered.cards[9].id='A1-011';assert.match(validateDeck(altered,cards).join(' '),/妙蛙種子/)});
test('invalid import is rejected without partial coercion',()=>{for(const bad of [{...complete,cards:[{id:'A1-005',count:0}]},{...complete,energy:['Typo']},{...complete,cards:[{id:'A1-001',count:'2'}]}]) assert.throws(()=>readDeckFile(JSON.stringify(bad)))});
test('search handles compact card id',()=>{assert.equal(normalizeSearch(' A1－001 '),'a1001')});
test('aggregate includes draws, rejects duplicate slot, incomplete seeds',()=>{let events=[{opponentId:'a',index:0,outcome:'win'},{opponentId:'a',index:0,outcome:'loss'},{opponentId:'a',index:1,outcome:'draw'},{opponentId:'a',index:2,outcome:'skip'},{opponentId:'b',index:2,outcome:'loss'}];const accepted=validOutcomes(events,['a','b']);assert.equal(accepted.length,3);assert.equal(resultsFor(accepted,'a').length,2);assert.deepEqual(aggregate(accepted),{wins:1,draws:1,losses:1,total:3});assert.equal(summarizeBatch(accepted,['a','b']).complete,false)});

