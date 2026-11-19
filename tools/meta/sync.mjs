import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {eligibleEvent,rankEvents,summarizeEvent} from './rank.mjs';
import {projectRoot,source,save,read,seasonFor,eventIndex,eventData} from './source.mjs';
import {translateMetaSnapshot} from './translate.mjs';

const now=new Date().toISOString();
const season=await seasonFor(now);
const candidates=await eventIndex(season.windowStart,now);
const events=[];
console.log('Window',season.windowStart,season.name,'Candidates',candidates.length);
for(const [index,row] of candidates.entries()){
  const event=await eventData(row,eligibleEvent);
  if(event)events.push(summarizeEvent(event.detail,event.standings,event.pairings));
  if((index+1)%10===0)console.log('Checked',index+1,'/',candidates.length,'Included',events.length);
}
const {entries,players,matches}=rankEvents(events);
if(entries.length<10||matches===0||entries.slice(0,10).some(e=>!e.representative))throw Error('Insufficient data for a verified top ten. The previous snapshot is preserved.');
const rankedPlayers=entries.reduce((sum,e)=>sum+e.count,0);
const rawNext={schemaVersion:1,season:season.id,seasonName:season.name,releaseAt:season.releaseAt,windowStart:season.windowStart,
  events:events.length,players,classifiedPlayers:rankedPlayers,matches,candidateEvents:candidates.length,
  latestEvent:events.map(e=>e.date).sort().at(-1),source:source+'/decks?game=POCKET',rankBy:'entries',
  winRateDefinition:'wins/(wins+losses+draws), matches; excludes byes and double losses',
  sources:events.map(e=>({id:e.id,name:e.name,date:e.date,players:e.players,matches:e.matches,url:source+'/tournament/'+e.id+'/standings'})),entries};
const next=translateMetaSnapshot(rawNext,projectRoot);
const path=join(projectRoot,'public/data/meta.json');
const previousText=await read(path);
const previous=previousText&&JSON.parse(previousText);
const hash=createHash('sha256').update(JSON.stringify(next)).digest('hex');
if(previous?.hash===hash){
  console.log('Unchanged',hash);
}else{
  if(previous?.hash)await save(join(projectRoot,'data/meta/snapshots',previous.hash+'.json'),previousText);
  await save(path,JSON.stringify({...next,asOf:now,hash})+'\n');
  const topPath=join(projectRoot,'public/data/meta.top.json');
  const top={...next,sourcesCount:next.sources.length,sources:next.sources.slice(0,10),entries:next.entries.slice(0,40),totalEntries:next.entries.length,truncated:next.entries.length>40,asOf:now,hash};
  await save(topPath,JSON.stringify(top)+'\n');
  console.log('Snapshot ready:',events.length,'events,',players,'entrants,',matches,'matches;',entries.length,'archetypes.');
}
