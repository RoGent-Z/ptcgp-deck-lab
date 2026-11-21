import {randomUUID} from 'node:crypto';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from './freeze.mjs';

const BOOTSTRAP_SEED = 0x4d4c504b;
const REPLICATES = 10000;
const RESULTS = new Map([['win','wins'], ['draw','draws'], ['loss','losses']]);

function check(condition, reason) {
  if (!condition) throw Error(reason);
}
function count() {
  return {games:0, wins:0, draws:0, losses:0};
}
function rates(counts) {
  return {...counts, winRate:counts.wins/counts.games, score:(counts.wins+counts.draws/2)/counts.games};
}
function validate(game) {
  check(Array.isArray(game?.ranks) && game.ranks.length===2 &&
    game.ranks.every(rank=>Number.isInteger(rank) && rank>=1 && rank<=10) &&
    game.ranks[0]!==game.ranks[1], 'Expected two distinct ranks in 1–10');
  check(game.ranks.includes(game.deckRank), 'Unexpected candidate deckRank');
  check(game.first===0 || game.first===1, 'Invalid first seat');
  check(Number.isInteger(game.seed) && game.seed>=0 && game.seed<=0xffffffff, 'Invalid uint32 seed');
  check(RESULTS.has(game.outcome), 'Unknown outcome');
  check(Number.isInteger(game.turns) && game.turns>=1 && game.turns<=30, 'Invalid turns');
  check(Number.isInteger(game.actions) && game.actions>=1 && game.actions<=3000, 'Invalid actions');
  check(Array.isArray(game.points) && game.points.length===2 &&
    game.points.every(p=>Number.isInteger(p) && p>=0), 'Invalid points');
}

function readGames(text) {
  const pairs=new Map(), total=count();
  for (const [index,line] of text.trimEnd().split(/\r?\n/).entries()) {
    try {
      const game=JSON.parse(line);
      validate(game);
      const ranks=[...game.ranks].sort((a,b)=>a-b);
      const key=ranks.join('-');
      if (!pairs.has(key)) pairs.set(key, {ranks, counts:count(), seeds:new Map()});
      const pair=pairs.get(key);
      if (!pair.seeds.has(game.seed)) pair.seeds.set(game.seed, {seats:new Set(), scoreSum:0});
      const cluster=pair.seeds.get(game.seed);
      const seat=game.deckRank+'/'+game.first;
      check(!cluster.seats.has(seat), 'Duplicate orientation at ranks '+key+', seed '+game.seed);
      cluster.seats.add(seat);
      cluster.scoreSum+=game.outcome==='win'?1:game.outcome==='draw'?0.5:0;
      const outcome=RESULTS.get(game.outcome);
      pair.counts[outcome]++;
      pair.counts.games++;
      total[outcome]++;
      total.games++;
    } catch (error) {
      throw Error('challenge.jsonl line '+(index+1)+': '+error.message,{cause:error});
    }
  }
  return {total, pairs};
}

function quantile(sample, probability) {
  const index=(sample.length-1)*probability;
  const lo=Math.floor(index), hi=Math.ceil(index);
  return sample[lo]+(sample[hi]-sample[lo])*(index-lo);
}

// Each seed is resampled with all four crossed games. Deck pair frequencies stay fixed.
function pairedCI(strata,seedsPerPair) {
  let state=BOOTSTRAP_SEED;
  function nextSeedIndex() {
    state^=state<<13;
    state^=state>>>17;
    state^=state<<5;
    return Math.floor((state>>>0)/4294967296*seedsPerPair);
  }
  const sample=new Float64Array(REPLICATES);
  for (let b=0;b<sample.length;b++) {
    let sum=0;
    for (const clusterScores of strata) {
      for (let i=0;i<seedsPerPair;i++) sum+=clusterScores[nextSeedIndex()];
    }
    sample[b]=sum/(strata.length*seedsPerPair);
  }
  sample.sort();
  return [quantile(sample,.025),quantile(sample,.975)];
}

export async function comparePolicies(runDir,seedsPerPair=32) {
  check(Number.isSafeInteger(seedsPerPair) && seedsPerPair>=1, 'Expected positive integer seedsPerPair');
  const input=await readFile(join(runDir,'challenge.jsonl'));
  const {pairs,total}=readGames(input.toString('utf8'));
  check(pairs.size===45,'Expected all 45 matchups among ranks 1–10');
  const ordered=[...pairs.values()].sort((a,b)=>a.ranks[0]-b.ranks[0] || a.ranks[1]-b.ranks[1]);
  const strata=[], byMatchup=[];
  for (const {ranks,counts,seeds} of ordered) {
    check(seeds.size===seedsPerPair,'Expected '+seedsPerPair+' seeds per pair for ranks '+ranks.join('-'));
    const scores=[];
    for (const [seed,cluster] of [...seeds].sort(([a],[b])=>a-b)) {
      check(cluster.seats.size===4,'Expected four orientations for ranks '+ranks.join('-')+', seed '+seed);
      scores.push(cluster.scoreSum/4);
    }
    strata.push(scores);
    byMatchup.push({ranks,...rates(counts)});
  }
  const scoreCI95=pairedCI(strata,seedsPerPair);
  const promote=scoreCI95[0]>.5;
  const report={
    schemaVersion:1, candidate:'v2', incumbent:'v1', challengeSha256:sha256(input), ...rates(total),
    seedsPerPair, matchups:ordered.length, clusters:ordered.length*seedsPerPair, byMatchup,
    scoreCI95, bootstrap:{method:'paired seed quartet percentile bootstrap within each fixed matchup',
      replicates:REPLICATES, initialSeed:BOOTSTRAP_SEED},
    rule:'Promote V2 when the lower 95% confidence limit for its score (win=1, draw=0.5, loss=0) exceeds 0.5',
    promote, decision:promote?'promote-v2':'retain-v1',
  };
  const path=join(runDir,'promotion.json'), temp=path+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temp,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    await rename(temp,path);
  } finally {
    await rm(temp,{force:true});
  }
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  check(process.argv.length===3 || process.argv.length===4,
    'Usage: node tools/battle/compare-policies.mjs <runDir> [seedsPerPair]');
  const seeds=process.argv[3]===undefined?32:Number(process.argv[3]);
  const r=await comparePolicies(resolve(process.argv[2]),seeds);
  console.log(r.decision,'games='+r.games,'score='+r.score,'CI95='+r.scoreCI95.join(','));
}
