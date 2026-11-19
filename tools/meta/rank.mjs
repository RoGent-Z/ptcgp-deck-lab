export {seasonWindow} from './source.mjs';

const energies=new Set(['Grass','Fire','Water','Lightning','Psychic','Fighting','Darkness','Metal']);
const source='https://play.limitlesstcg.com';

export function canonicalCard(set,number){
  if(!/^[A-Za-z][A-Za-z0-9-]*$/.test(set)||!/^\d+$/.test(String(number))||Number(number)<1)return null;
  return set+'-'+String(Number(number)).padStart(3,'0');
}

export function eligibleEvent(d,evidence){
  if(d.game!=='POCKET'||!d.isPublic||!d.decklists||d.multideck||d.bannedCards?.length||d.specialRules?.length)return false;
  if(d.format!=='STANDARD'&&!(d.format==null&&/\bStandard format\b/i.test(evidence)))return false;
  const restrictions=/\b(?:no[- ]?ex|(?:dual|double|multi|two)[- ]decks?|monotype|pauper|singleton|rising star format|(?:[ABC]\d[a-z]?|dual fusion|one set)[- ]only)\b/i;
  return !restrictions.test(d.name);
}

export function deckFromList(deck){
  if(!deck||!Array.isArray(deck.pokemon)||!Array.isArray(deck.energy))return null;
  if(deck.energy.length<1||deck.energy.length>3||!deck.energy.every(e=>energies.has(e))||new Set(deck.energy).size!==deck.energy.length)return null;
  const counts=new Map();
  for(const card of [...deck.pokemon,...deck.trainer||[]]){
    const id=canonicalCard(card.set,card.number);
    if(!id||!Number.isInteger(card.count)||card.count<1||card.count>2)return null;
    counts.set(id,(counts.get(id)||0)+card.count);
  }
  if([...counts.values()].some(c=>c>2)||[...counts.values()].reduce((s,n)=>s+n,0)!==20)return null;
  const cards=[...counts].sort(([a],[b])=>a.localeCompare(b,'en')).map(([id,count])=>({id,count}));
  return {cards,energy:[...deck.energy].sort()};
}

function bestReceipt(a,b){
  return a.placing-b.placing||Date.parse(b.date)-Date.parse(a.date)||a.url.localeCompare(b.url,'en');
}

function addVariant(forms,key,deck,n=1){
  const current=forms.get(key);
  if(!current){forms.set(key,{...deck,frequency:n});return;}
  const total=current.frequency+n;
  if(bestReceipt(deck,current)<0)forms.set(key,{...deck,frequency:total});
  else current.frequency=total;
}
function newRow(id,name){
  return {id,name,count:0,wins:0,draws:0,losses:0,champions:0,top8:0,forms:new Map()};
}
function classified(s){return s?.deck?.id&&!/^(?:other|unknown|unidentified)$/i.test(s.deck.id);}

export function summarizeEvent(d,standings,pairings) {
  const byPlayer=new Map();
  const rows=new Map();
  const players=new Set();
  for(const s of standings){
    if(!s.player||players.has(s.player))continue;
    players.add(s.player);
    if(!classified(s))continue;
    const id=s.deck.id;
    if(!rows.has(id))rows.set(id,newRow(id,s.deck.name));
    const row=rows.get(id);
    byPlayer.set(s.player,row);
    row.count++;
    if(s.placing===1)row.champions++;
    if(s.placing>=1&&s.placing<=8)row.top8++;
    const form=deckFromList(s.decklist);
    if(form){
      const url=source+'/tournament/'+encodeURIComponent(d.id)+'/player/'+encodeURIComponent(s.player)+'/decklist';
      addVariant(row.forms,JSON.stringify(form),{...form,url,event:d.name,eventId:d.id,date:d.date,placing:s.placing??Number.MAX_SAFE_INTEGER});
    }
  }
  const seen=new Set();
  let matches=0;
  for(const p of pairings){
    const {player1,player2,winner}=p;
    if(!players.has(player1)||!players.has(player2)||player1===player2)continue;
    if(winner!==0&&winner!==player1&&winner!==player2)continue;
    const key=JSON.stringify([p.phase,p.round,p.table??p.match,...[player1,player2].sort()]);
    if(seen.has(key))continue;
    seen.add(key);matches++;
    for(const player of [player1,player2]){
      const row=byPlayer.get(player);
      if(row)row[winner===0?'draws':winner===player?'wins':'losses']++;
    }
  }
  return {id:d.id,name:d.name,date:d.date,players:players.size,matches,rows:[...rows.values()]};
}

export function rankEvents(events){
  const rows=new Map();
  let players=0,matches=0;
  for(const event of events){
    players+=event.players; matches+=event.matches;
    for(const r of event.rows){
      if(!rows.has(r.id))rows.set(r.id,newRow(r.id,r.name));
      const row=rows.get(r.id);
      for(const metric of ['count','wins','draws','losses','champions','top8'])row[metric]+=r[metric];
      for(const [key,variant] of r.forms)addVariant(row.forms,key,variant,variant.frequency);
    }
  }
  const entries=[...rows.values()].map(({forms,...r})=>{
    const total=r.wins+r.losses+r.draws;
    const representative=[...forms.values()].sort((a,b)=>b.frequency-a.frequency||bestReceipt(a,b))[0]??null;
    return {...r,share:r.count/players,winRate:total?r.wins/total:null,representative};
  }).sort((a,b)=>b.count-a.count||b.champions-a.champions||a.id.localeCompare(b.id,'en'));
  return {players,matches,entries};
}
