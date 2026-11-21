import {readFile, writeFile, rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256,validateLineup} from './freeze.mjs';
import {comparePolicies} from './compare-policies.mjs';

function requireValue(condition,message){if(!condition)throw Error(message);}
function validRank(rank){return Number.isInteger(rank)&&rank>=1&&rank<=10;}
function counter(){return {total:0,wins:0,draws:0,losses:0,firstGames:0,turns:0,actions:0};}

function add(c,game){
  c.total++;
  c[({win:'wins',draw:'draws',loss:'losses'})[game.outcome]]++;
  if(game.first===0)c.firstGames++;
  c.turns+=game.turns;
  c.actions+=game.actions;
}
function rates(c){
  return {...c,secondGames:c.total-c.firstGames,winRate:c.wins/c.total,score:(c.wins+c.draws*0.5)/c.total};
}
function wilson(c){
  const z=1.959963984540054, n=c.total, p=c.wins/n;
  const scale=1+z*z/n,center=(p+z*z/(2*n))/scale;
  const margin=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/scale;
  return [Math.max(0,center-margin),Math.min(1,center+margin)];
}
function checkGame(row){
  requireValue(row&&['win','draw','loss'].includes(row.outcome),'Invalid outcome');
  requireValue(row.first===0||row.first===1,'Invalid first player');
  requireValue(Number.isInteger(row.seed)&&row.seed>=0&&row.seed<=0xffffffff,'Invalid uint32 seed');
  requireValue(Number.isInteger(row.turns)&&row.turns>=1&&row.turns<=30,'Invalid turn count');
  requireValue(Number.isInteger(row.actions)&&row.actions>0&&row.actions<=3000,'Invalid action count');
  requireValue(Array.isArray(row.points)&&row.points.length===2&&row.points.every(x=>Number.isInteger(x)&&x>=0),'Invalid player points');
}
async function jsonLines(dir,name,consume){
  const bytes=await readFile(join(dir,name));
  const lines=bytes.toString('utf8').trimEnd().split(/\r?\n/);
  for(const [i,line] of lines.entries()){
    try{
      const row=JSON.parse(line);
      checkGame(row);
      consume(row);
    }catch(error){throw Error(name+' line '+(i+1)+': '+error.message,{cause:error});}
  }
  return sha256(bytes);
}
async function mirrorReport(dir,lineup){
  const total=counter();
  const ranks=lineup.decks.slice(0,10).map(d=>({...counter(),rank:d.rank,id:d.id,name:d.name,
    bySeat:{first:counter(),second:counter()},indexes:new Set(),seeds:new Set()}));
  const hash=await jsonLines(dir,'mirror-500.jsonl',r=>{
    requireValue(validRank(r.rank)&&r.id===ranks[r.rank-1].id,'Unexpected mirror deck ID or rank');
    const rank=ranks[r.rank-1];
    requireValue(Number.isInteger(r.index)&&r.index>=0&&r.index<50&&!rank.indexes.has(r.index),'Missing or duplicate mirror index');
    requireValue(r.first===(r.index<25?0:1),'Incorrect first player for mirror index');
    const seatSeed=r.first+'/'+r.seed;
    requireValue(!rank.seeds.has(seatSeed),'Duplicate mirror seed for one seat');
    rank.indexes.add(r.index);rank.seeds.add(seatSeed);
    add(rank,r);add(rank.bySeat[r.first===0?'first':'second'],r);add(total,r);
  });
  requireValue(ranks.every(r=>r.indexes.size===50&&r.firstGames===25),'Expected 50 mirror games per rank with 25 per seat');
  const {rank,id,name}=lineup.decks[0];
  return {summary:{...rates(total),playerDeck:{rank,id,name},winRateDefinition:'wins/500, ten equally weighted opponents',
    byRank:ranks.map(({indexes,seeds,bySeat,...s})=>({...rates(s),winRateCI95:wilson(s),bySeat:{first:rates(bySeat.first),second:rates(bySeat.second)}}))},hash};
}

// Resample a quartet as a unit within each of the 45 fixed matchups.
function bootstrap(strata) {
  const replicates=10000;
  const initialSeed=0x4d4c504b;
  let state=initialSeed;
  function next(){
    state^=state<<13;state^=state>>>17;state^=state<<5;
    return (state>>>0)/4294967296;
  }
  const size=strata.reduce((n,values)=>n+values.length,0);
  const scores=[];
  for(let rep=0;rep<replicates;rep++){
    let total=0;
    for(const values of strata){
      for(let k=0;k<values.length;k++)total+=values[Math.floor(next()*values.length)];
    }
    scores.push(total/size);
  }
  scores.sort((a,b)=>a-b);
  function quantile(p){
    const index=(scores.length-1)*p;
    const lo=Math.floor(index);
    return scores[lo]+(scores[Math.ceil(index)]-scores[lo])*(index-lo);
  }
  return {scoreCI95:[quantile(.025),quantile(.975)],bootstrap:{
    method:'stratified paired percentile bootstrap, 45 fixed matchups, 12 seed quartets per matchup',
    replicates,initialSeed,
  }};
}

async function evalReport(dir,lineup){
  const total=counter();
  const byRank=lineup.decks.slice(0,10).map(d=>({...counter(),rank:d.rank,id:d.id,name:d.name}));
  const pairs=new Map();
  const hash=await jsonLines(dir,'eval.jsonl',r=>{
    requireValue(Array.isArray(r.ranks)&&r.ranks.length===2&&r.ranks.every(validRank)&&r.ranks[0]!==r.ranks[1]&&r.ranks.includes(r.deckRank),'Invalid held-out deck rank');
    const ranks=[...r.ranks].sort((a,b)=>a-b);
    const key=ranks.join('-');
    if(!pairs.has(key))pairs.set(key,{ranks,...counter(),seeds:new Map()});
    const pair=pairs.get(key);
    if(!pair.seeds.has(r.seed))pair.seeds.set(r.seed,{orientations:new Set(),scoreSum:0});
    const group=pair.seeds.get(r.seed);
    const orientation=r.deckRank+'/'+r.first;
    requireValue(!group.orientations.has(orientation),'Duplicate crossed orientation in a paired seed');
    group.orientations.add(orientation);
    group.scoreSum+=r.outcome==='win'?1:r.outcome==='draw'?.5:0;
    add(pair,r);add(byRank[r.deckRank-1],r);add(total,r);
  });
  requireValue(pairs.size===45,'Expected all 45 unordered held-out matchups');
  const ordered=[...pairs.values()].sort((a,b)=>a.ranks[0]-b.ranks[0]||a.ranks[1]-b.ranks[1]);
  const strata=[];
  for(const {ranks,seeds} of ordered){
    requireValue(seeds.size===12&&[...seeds.values()].every(g=>g.orientations.size===4),
      'Incomplete paired seed quartet for ranks '+ranks.join(','));
    strata.push([...seeds].sort(([a],[b])=>a-b).map(([,g])=>g.scoreSum/4));
  }
  const summary=rates(total);
  const {scoreCI95,bootstrap:metadata}=bootstrap(strata);
  return {summary:{...summary,clusters:540,scoreCI95,beatsBaseline:scoreCI95[0]>.5,baselineScore:1-summary.score,
    scoreDifference:2*summary.score-1,scoreDifferenceCI95:scoreCI95.map(x=>2*x-1),
    bootstrap:metadata,byRank:byRank.map(rates),byMatchup:ordered.map(({seeds,...counts})=>rates(counts))},hash};
}

function percent(x){return (x*100).toFixed(2)+'%';}
function cell(value){return String(value).replaceAll('|','\\|').replace(/[\r\n]+/g,' ');}
function wdl(c){return [c.wins,c.draws,c.losses].join('/');}
function markdown({mirror,evaluation,source,continuation}){
  const summary=[
    '# 固定牌表的對戰驗證','',
    '環境 '+source.season+'，榜單快照 '+source.asOf+'。第 11–26 名供訓練、第 27–30 名供驗證及選模，第 1–10 名供本次留出評估。','',
    ...(continuation ? continuationSummary(continuation) : []),
    '## 同一模型的前十牌組對戰','',
    '固定第 1 名為玩家範例牌組（'+cell(mirror.playerDeck.name)+'），雙方均採用同一模型。範例牌組分別對陣前十名，每個對手各打 50 局，其中先攻和後攻各 25 局。對第 1 名的這組使用相同牌表。','',
    mirror.total+' 局共 '+mirror.wins+' 勝、'+mirror.draws+' 和、'+mirror.losses+' 負，綜合勝率 '+percent(mirror.winRate)+'（勝場 ÷ 500，每個對手權重相同）。表內先後攻戰績按勝／和／負排列，單對陣勝率附 Wilson 95% 區間。','',
    '| 對手排名 | 對手牌組 | 勝 | 和 | 負 | 勝率 | 95% 區間 | 先攻 25 局 | 後攻 25 局 |','| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...mirror.byRank.map(s=>'| '+[s.rank,cell(s.name),s.wins,s.draws,s.losses,percent(s.winRate),s.winRateCI95.map(percent).join('–'),wdl(s.bySeat.first),wdl(s.bySeat.second)].join(' | ')+' |'),
    '','## 候選策略對基線策略','',
    '前十套牌的 45 種兩兩配對各使用 12 個種子，每個種子輪換兩套牌與先後手，共 '+evaluation.total+' 局。從候選策略的視角計算，共 '+evaluation.wins+' 勝、'+evaluation.draws+' 和、'+evaluation.losses+' 負，勝率 '+percent(evaluation.winRate)+'。','',
    '和局計半分時，候選策略得分率為 '+percent(evaluation.score)+'（95% 區間 '+evaluation.scoreCI95.map(percent).join(' 至 ')+'），基線為 '+percent(evaluation.baselineScore)+'。兩者差距為 '+(100*evaluation.scoreDifference).toFixed(2)+' 個百分點（95% 區間 '+evaluation.scoreDifferenceCI95.map(x=>(100*x).toFixed(2)).join(' 至 ')+'）。','',
    '區間固定這 45 種對陣，在各對陣內以同一種子的四局為單位有放回抽樣，重複 10,000 次。結果適用於這一版本的牌表、引擎和兩種策略。','',
    evaluation.beatsBaseline?'候選策略得分率的 95% 區間下界高於 50%，在本次留出評估中勝過基線。':evaluation.scoreCI95[1]<.5?'候選策略得分率的 95% 區間上界低於 50%，基線在本次留出評估中得分更高。':'候選策略得分率的 95% 區間包含 50%，這批對局尚無法分出兩種策略的優劣。','',
    '| 候選策略使用的牌組 | 勝 | 和 | 負 | 得分率 |','| --- | ---: | ---: | ---: | ---: |',
    ...evaluation.byRank.map(s=>'| '+[cell(s.name),s.wins,s.draws,s.losses,percent(s.score)].join(' | ')+' |'),'',
  ];
  return summary.join('\n');
}
function continuationSummary({model,challenge,retained}){
  return [
    '## V2 續訓與 V1 對照','',
    'V2 從 V1 權重開始，續訓 '+model.trainedGames.toLocaleString('en-US')+' 局，累計 '+model.cumulativeTrainingGames.toLocaleString('en-US')+' 局。入圍候選各打 768 局驗證，複選時每名候選以不同種子再打 1,152 局。','',
    '凍結 V2 權重後，以獨立種子與 V1 直接對戰 '+challenge.games.toLocaleString('en-US')+' 局，共 '+challenge.wins+' 勝、'+challenge.draws+' 和、'+challenge.losses+' 負。V2 得分率 '+percent(challenge.score)+'，95% 區間 '+challenge.scoreCI95.map(percent).join('–')+'。本地保留策略為 **'+retained+'**。','',
    '晉級門檻為得分率區間下界高於 50%。評估沿用同一批前十牌表，對局種子與原 V1 評估、此次訓練和驗證隔離。以下 500 局及對 V0 的對照均使用此次 V2 候選。','',
  ];
}
async function replace(path,text){
  const temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,text);
  await rename(temp,path);
}
export async function verifyRun(dir){
  const lineupBytes=await readFile(join(dir,'lineup.json'));
  const lineup=JSON.parse(lineupBytes);
  validateLineup(lineup);
  const mirror=await mirrorReport(dir,lineup);
  const evaluation=await evalReport(dir,lineup);
  const report={schemaVersion:1,source:lineup.source,inputSha256:{lineup:sha256(lineupBytes),mirror:mirror.hash,evaluation:evaluation.hash},
    ranks:{train:[11,26],validation:[27,30],evaluation:[1,10]},mirror:mirror.summary,evaluation:evaluation.summary};
  let candidate;
  try { candidate=JSON.parse(await readFile(join(dir,'candidate-v2.json'),'utf8')); }
  catch(error){ if(error.code!=='ENOENT')throw error; }
  if(candidate){
    const challenge=await comparePolicies(dir);
    for(const field of ['games','wins','draws','losses','score']){
      requireValue(candidate.challenge?.[field]===challenge[field],'V2 challenge differs from model metadata');
    }
    report.continuation={
      model:{version:candidate.version,trainedGames:candidate.trainedGames,cumulativeTrainingGames:candidate.cumulativeTrainingGames},
      challenge, retained:challenge.promote?'V2':'V1',
    };
    report.inputSha256.challenge=challenge.challengeSha256;
  }
  await replace(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');
  await replace(join(dir,'report.md'),markdown(report));
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw Error('Usage: node tools/battle/verify-report.mjs <runDir>');
  const result=await verifyRun(resolve(process.argv[2]));
  console.log('Verified mirror',result.mirror.total,'and holdout',result.evaluation.total,'games.');
}
