import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, link, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
const requiredHash=/^[a-f\d]{64}$/i;
const energies=new Set(['Grass','Fire','Water','Lightning','Psychic','Fighting','Darkness','Metal']);

export function validateLineup({source,decks}) {
  if(!source?.season||!Number.isFinite(Date.parse(source.asOf))||!requiredHash.test(source.hash)||!requiredHash.test(source.sha256)){
    throw Error('Invalid frozen source provenance');
  }
  if(!Array.isArray(decks)||decks.length!==30)throw Error('Expected 30 ranked decks');
  const ids=new Set(),contents=new Set();
  for(const [index,d] of decks.entries()){
    if(d.rank!==index+1||typeof d.id!=='string'||!d.id||!d.name||ids.has(d.id))throw Error('Invalid or duplicate ranked deck '+(index+1));
    ids.add(d.id);
    if(!/^https?:\/\//.test(d.sourceUrl))throw Error('Missing source URL for deck '+d.rank);
    if(!Array.isArray(d.cards)||d.cards.some(c=>typeof c.id!=='string'||!c.id||![1,2].includes(c.count))||
      new Set(d.cards.map(c=>c.id)).size!==d.cards.length||d.cards.reduce((n,c)=>n+c.count,0)!==20)throw Error('Invalid 20-card list at rank '+d.rank);
    if(!Array.isArray(d.energy)||d.energy.length<1||d.energy.length>3||!d.energy.every(e=>energies.has(e))||
      new Set(d.energy).size!==d.energy.length)throw Error('Invalid energy settings at rank '+d.rank);
    const signature=JSON.stringify([d.cards.map(({id,count})=>[id,count]).sort(),[...d.energy].sort()]);
    if(contents.has(signature))throw Error('Identical deck contents at more than one rank');
    contents.add(signature);
  }
}

async function existing(path) {
  const result=JSON.parse(await readFile(path,'utf8'));
  validateLineup(result);
  return result;
}

export async function freezeLineup(directory,sourcePath=new URL('../../public/data/meta.top.json',import.meta.url)) {
  const target=join(directory,'lineup.json');
  try{return await existing(target);}catch(error){if(error.code!=='ENOENT')throw error;}
  const bytes=await readFile(sourcePath);
  const meta=JSON.parse(bytes);
  const decks=meta.entries.slice(0,30).map(({id,name,representative},i)=>({
    rank:i+1,id,name,cards:representative?.cards,energy:representative?.energy,sourceUrl:representative?.url,
  }));
  const result={source:{season:meta.season,asOf:meta.asOf,hash:meta.hash,sha256:sha256(bytes)},decks};
  validateLineup(result);
  await mkdir(directory,{recursive:true});
  const temp=join(directory,'.lineup-'+randomUUID()+'.tmp');
  await writeFile(temp,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  try{
    // Atomically create the immutable target. A concurrent freeze can never replace it.
    await link(temp,target);
    return result;
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    return await existing(target);
  }finally{await unlink(temp);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw Error('Usage: node tools/battle/freeze.mjs <runDir>');
  const lineup=await freezeLineup(resolve(process.argv[2]));
  console.log('Frozen 30 ranks for',lineup.source.season,'from',lineup.source.sha256);
}
