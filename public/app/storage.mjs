const database='ptcgp-deck-lab-v1', stores=['decks','settings','collection','runs'];
let openPromise;
export function openStore(){
  if(!openPromise) openPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(database,1);
    request.onupgradeneeded=()=>{for(const key of stores)if(!request.result.objectStoreNames.contains(key))request.result.createObjectStore(key)};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();openPromise=null};resolve(db)};
    request.onerror=()=>reject(request.error); request.onblocked=()=>reject(Error('其他分頁正在佔用本機資料庫'));
  });
  return openPromise;
}
export async function storeOp(store,action,...args){
  const db=await openStore();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,['get','getAll','getAllKeys'].includes(action)?'readonly':'readwrite');
    const req=tx.objectStore(store)[action](...args);
    tx.oncomplete=()=>resolve(req.result); tx.onabort=tx.onerror=()=>reject(tx.error||req.error||Error('本機儲存失敗'));
  });
}
export const get=(store,key)=>storeOp(store,'get',key);
export const put=(store,key,value)=>storeOp(store,'put',value,key);
export const remove=(store,key)=>storeOp(store,'delete',key);
export const all=(store)=>storeOp(store,'getAll');

