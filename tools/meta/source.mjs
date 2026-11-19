import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
export const cacheRoot=join(projectRoot,'data/meta/cache-v1');
export const source='https://play.limitlesstcg.com';
const knownStarts={C1:'2026-10-29T01:00:00.000Z'};
let nextApiRequest=0;

export async function save(path,text) {
  await mkdir(dirname(path),{recursive:true});
  const tmp=path+'.'+process.pid+'.tmp';
  await writeFile(tmp,text);
  await rename(tmp,path);
}

export async function read(path) {
  try {return await readFile(path,'utf8');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}

async function get(url,json=false) {
  const isApi=url.startsWith(source+'/api/');
  for(let attempt=0;attempt<6;attempt++){
    if(isApi)await delay(Math.max(0,nextApiRequest-Date.now()));
    let response;
    try {
      response=await fetch(url,{headers:{'User-Agent':'pocket-battle-lab/1.0 (GitHub Pages tournament sync)'},signal:AbortSignal.timeout(30000)});
    }catch(error){
      if(attempt===5)throw error;
      await delay(1000*2**attempt);continue;
    }
    const rate=response.headers.get('ratelimit')||'';
    const remaining=rate.match(/\br=(\d+)/)?.[1];
    const reset=Number(rate.match(/\bt=(\d+)/)?.[1]||300);
    if(isApi&&remaining==='0')nextApiRequest=Date.now()+(reset+1)*1000;
    if(response.status===429||response.status>=500){
      const seconds=Number(response.headers.get('retry-after')||0)||(response.status===429?reset+1:2**attempt);
      await response.body?.cancel();
      if(attempt===5)throw Error('Limitless temporarily unavailable: '+response.status);
      await delay(Math.min(600,Math.max(1,seconds))*1000);continue;
    }
    if(!response.ok)throw Error('Source '+response.status+' '+url);
    return json?response.json():response.text();
  }
}
export function seasonWindow(now,release){
  const floor=new Date(now);
  floor.setUTCHours(0,0,0,0);
  floor.setUTCDate(floor.getUTCDate()-27);
  return new Date(Math.max(floor.getTime(),Date.parse(release))).toISOString();
}
function decode(s){return s.replaceAll('&amp;','&').replaceAll('&#39;',"'").trim();}

export async function seasonFor(now) {
  const html=await get(source+'/decks?game=POCKET');
  const selected=html.match(/<option\s+data-set="([A-Za-z0-9-]+)"\s+selected>([^<]+)<\/option>/i);
  if(!selected)throw Error('Current Pocket tournament set missing');
  const id=selected[1];
  let releaseAt=knownStarts[id];
  if(!releaseAt){
    const sets=await get('https://pocket.limitlesstcg.com/cards');
    const row=sets.match(new RegExp('<a href="/cards/'+id+'">(\\d{1,2} [A-Za-z]{3} \\d{2})</a>'));
    if(!row)throw Error('Cannot find release date for '+id);
    const [day,month,year]=row[1].split(' ');
    releaseAt=new Date(Date.parse(day+' '+month+' 20'+year+' 00:00:00 GMT')).toISOString();
  }
  return {id,name:decode(selected[2]).replace(/^\S+\s+-\s+/,''),releaseAt,windowStart:seasonWindow(now,releaseAt)};
}

export async function eventIndex(windowStart,now) {
  const tournaments=new Map();
  let finished=false;
  for(let page=1;page<=100;page++){
    const rows=await get(source+'/api/tournaments?game=POCKET&limit=100&page='+page,true);
    if(!Array.isArray(rows))throw Error('Invalid tournament index');
    for(const row of rows){
      if(!row.id||!row.date||row.game!=='POCKET')throw Error('Invalid tournament data shape');
      const date=Date.parse(row.date);
      if(date>=Date.parse(windowStart)&&date<=Date.parse(now))tournaments.set(row.id,row);
      if(date<Date.parse(windowStart))finished=true;
    }
    if(finished||rows.length<100)return [...tournaments.values()];
  }
  throw Error('Tournament pagination failed to reach date boundary');
}

async function cached(id,name,load,valid) {
  const path=join(cacheRoot,id,name+'.json');
  const previous=await read(path);
  if(previous!==null)return JSON.parse(previous);
  const data=await load();
  if(!valid(data))throw Error('Invalid '+name+' for '+id);
  await save(path,JSON.stringify(data));
  return data;
}
export async function eventData(row,shouldInclude) {
  if(row.format&&!['STANDARD'].includes(row.format))return null;
  const url=source+'/api/tournaments/'+row.id;
  const detail=await cached(row.id,'details',()=>get(url+'/details',true),x=>x?.id===row.id);
  let formatEvidence='';
  if(detail.format==null){
    formatEvidence=await cached(row.id,'format',async()=>{
      const html=await get(source+'/tournament/'+row.id+'/details');
      const head=html.match(/<meta name="description" content="([^"]+)"/i)?.[1]||'';
      if(!head)throw Error('Tournament format metadata missing for '+row.id);
      return head;
    },x=>typeof x==='string');
  }
  if(!shouldInclude(detail,formatEvidence))return null;
  const standings=await cached(row.id,'standings',()=>get(url+'/standings',true),x=>Array.isArray(x)&&x.length>0&&x.some(p=>p.placing===1));
  const pairings=await cached(row.id,'pairings',()=>get(url+'/pairings',true),x=>Array.isArray(x)&&x.length>0);
  return {detail,standings,pairings};
}
