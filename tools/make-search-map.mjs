import {mkdir,writeFile} from 'node:fs/promises';
const base=new URL('../public/assets/',import.meta.url);
await mkdir(base,{recursive:true});
const source='https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.1.9/';
async function read(path){const response=await fetch(source+path);if(!response.ok)throw Error(response.status+' '+path);return response.text();}
const map={};
for(const line of (await read('data/dictionary/TSCharacters.txt')).split(/\r?\n/)){
  if(!line||line.startsWith('#'))continue;
  const [orig,repl]=line.split('\t'); if(orig&&repl)map[orig]=repl.split(' ')[0];
}
await writeFile(new URL('han-fold.json',base),JSON.stringify(map));
await writeFile(new URL('OpenCC-LICENSE.txt',base),await read('LICENSE'));

