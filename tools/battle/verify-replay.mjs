import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduleHoldout, seed32 } from './trainer-v1.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const countByOutcome = {win:'wins', loss:'losses', draw:'draws'};
const digest = input => createHash('sha256').update(input).digest('hex');

function auditEvents(rows) {
  const stats = {wins:0, losses:0, draws:0, total:rows.length};
  for (const row of rows) {
    assert.ok(Object.hasOwn(countByOutcome, row.outcome), 'Invalid recorded outcome');
    assert.ok(row.first === 0 || row.first === 1, 'Invalid seat');
    assert.ok(Number.isInteger(row.seed) && row.seed >= 0 && row.seed <= 0xffffffff, 'Invalid uint32 seed');
    assert.ok(Number.isInteger(row.turns) && row.turns >= 0 && row.turns <= 30, 'Invalid turn count');
    assert.ok(Number.isInteger(row.actions) && row.actions > 0 && row.actions <= 3000, 'Invalid action count');
    assert.ok(Array.isArray(row.points) && row.points.length === 2 &&
      row.points.every(p => Number.isInteger(p) && p >= 0), 'Invalid point totals');
    stats[countByOutcome[row.outcome]]++;
  }
  return {...stats, winRate:stats.wins / stats.total};
}

export function auditMirror(rows, decks) {
  assert.equal(decks.length,10,'The example requires 10 distinct opponent ranks');
  assert.equal(rows.length,500,'The example must have 500 completed games');
  const ids = new Map(decks.map(d => [d.rank,d.id]));
  assert.equal(new Set(ids.values()).size,10,'Repeated opponent ID');
  const played = new Set();
  for (const row of rows) {
    assert.ok(Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= 10 && ids.has(row.rank),'Unexpected example rank');
    assert.equal(row.id,ids.get(row.rank),'Opponent ID does not match lineup');
    assert.ok(Number.isInteger(row.index) && row.index >= 0 && row.index < 50,'Invalid example index');
    assert.equal(row.first, row.index < 25 ? 0 : 1, 'Example seat is inconsistent with game index');
    const key = [row.rank,row.index].join('/');
    assert.ok(!played.has(key),'Duplicate example slot: '+key);
    played.add(key);
  }
  return auditEvents(rows);
}

export function auditEvaluation(rows, decks, seedsPerSeat=12) {
  const ranks = new Set(decks.map(d => d.rank));
  assert.equal(ranks.size,decks.length,'Repeated evaluation rank');
  const groups = new Map();
  const seedsByPair = new Map();
  for (const row of rows) {
    assert.equal(row.ranks?.length,2,'An evaluation pair has two ranks');
    const [lo,hi] = [...row.ranks].sort((a,b) => a-b);
    assert.ok(lo < hi && ranks.has(lo) && ranks.has(hi), 'Unknown or repeated pair rank');
    assert.ok(row.deckRank === lo || row.deckRank === hi, 'Candidate rank is outside this pair');
    const key = [lo,hi,row.deckRank,row.first].join('/');
    const seeds = groups.get(key) ?? new Set();
    assert.ok(!seeds.has(row.seed),'Duplicate holdout seed for '+key);
    seeds.add(row.seed);
    groups.set(key,seeds);
    const pair = lo+'/'+hi;
    const allSeeds = seedsByPair.get(pair) ?? new Set();
    allSeeds.add(row.seed);
    seedsByPair.set(pair,allSeeds);
  }
  assert.equal(groups.size, ranks.size * (ranks.size-1) * 2,'Missing holdout pair/seat combination');
  for (const [key,seeds] of groups) assert.equal(seeds.size,seedsPerSeat,'Unbalanced holdout seeds for '+key);
  for (const [pair,seeds] of seedsByPair) assert.equal(seeds.size,seedsPerSeat,'Unpaired holdout seeds for '+pair);
  return auditEvents(rows);
}

export function auditChallenge(rows, decks, holdout, mirror) {
  assert.equal(decks.length,10,'Challenge requires all ten holdout decks');
  const summary=auditEvaluation(rows,decks,32);
  const seen=new Set();
  for (const [phase,games,expected] of [['challenge',rows,1440],['holdout',holdout,null],['mirror',mirror,500]]) {
    const seeds=new Set(games.map(row=>row.seed));
    for (const seed of seeds) {
      assert.ok(!seen.has(seed),'Seed reused across tests: '+phase+'/'+seed);
      seen.add(seed);
    }
    assert.equal(seeds.size,expected ?? games.length/4,'Repeated seed within '+phase);
  }
  return summary;
}

function checkScore(tally, games) {
  assert.equal(tally?.games,games,'Unexpected number of games');
  for (const key of ['wins','losses','draws']) assert.ok(Number.isInteger(tally[key]) && tally[key]>=0,'Invalid '+key);
  assert.equal(tally.wins+tally.losses+tally.draws,games,'Result counts do not add up to games');
  assert.equal(tally.score,(tally.wins+.5*tally.draws)/games,'Incorrect draw-adjusted score');
}

function auditPublishedSeeds(comparisons,mirror,decks,continued) {
  // The original, checksum-verified v1 schedule routine also defines the v2 paired seeds.
  const ranks=decks.map(deck=>deck.rank);
  for (const {kind,rows} of comparisons) {
    const direct=kind==='challenge';
    const phase=direct?'v2-v1-challenge':continued?'v2-v0-eval':'test';
    const expected=new Set(scheduleHoldout(ranks,direct?32:12,phase).map(row=>row.ranks.join('/')+'/'+row.seed));
    for (const row of rows) {
      assert.ok(expected.has(row.ranks.join('/')+'/'+row.seed),'Unexpected '+kind+' seed for this pair');
    }
  }
  const experiment=continued?'pocket-lab-c1-cem-v2':'pocket-lab-c1-cem-v1';
  for (const row of mirror) {
    assert.equal(row.seed,seed32([experiment,'example',row.id,row.index].join('|')),'Unexpected example seed');
  }
}

export function auditContinuation(candidate,training,parent,parentTraining) {
  assert.equal(candidate.version,'selfplay-cem-v2');
  assert.equal(parent.version,'selfplay-cem-v1');
  assert.equal(training.parentVersion,parent.version);
  assert.equal(parent.trainedGames,18432,'Unexpected frozen parent game count');
  assert.equal(parentTraining.trainedGames,parent.trainedGames);
  assert.equal(training.parentTrainedGames,parent.trainedGames);
  assert.equal(candidate.parentTrainedGames,parent.trainedGames);
  assert.deepEqual(parentTraining.bestCandidate?.weight,parent.weights,'Frozen parent checkpoint weights differ from parent model');
  assert.deepEqual(parentTraining.provenance,parent.provenance,'Frozen parent provenance differs from checkpoint');
  const config=training.config;
  assert.equal(config.generations,16);
  assert.equal(training.generations.length,config.generations,'Missing completed training generations');
  assert.equal(config.candidates,24);
  assert.equal(config.trainGamesPerCandidate,192);
  assert.equal(config.checkedPerGeneration,3);
  assert.equal(config.selectionCandidates,6);
  let accumulated=0;
  for (const [i,g] of training.generations.entries()) {
    assert.equal(g.round,i+1,'Unexpected generation number');
    assert.equal(g.candidates.length,config.candidates,'Missing trained candidate');
    const entries=new Map(g.candidates.map(entry=>[entry.index,entry]));
    let games=0;
    for (let index=0;index<config.candidates;index++) {
      const entry=entries.get(index);
      assert.equal(entry?.epoch,g.round,'Missing trained candidate in generation');
      checkScore(entry.training,config.trainGamesPerCandidate);
      games+=entry.training.games;
    }
    assert.equal(g.games,games,'Wrong games in generation');
    accumulated+=games;
    assert.equal(g.totalGames,accumulated,'Wrong cumulative games in checkpoint');
    assert.equal(g.validated.length,config.checkedPerGeneration,'Missing validation candidate');
    assert.equal(new Set(g.validated.map(entry=>entry.index)).size,g.validated.length,'Repeated validation candidate');
    for (const entry of g.validated) {
      const measured=entries.get(entry.index);
      assert.deepEqual(entry.weight,measured?.weight,'Validation weights absent from measured population');
      assert.deepEqual(entry.training,measured.training,'Validation candidate training result changed');
      checkScore(entry.validation,768);
    }
  }
  assert.equal(training.trainedGames,accumulated,'Training checkpoint game total differs');
  assert.equal(candidate.trainedGames,accumulated,'Candidate trained games must count only this run');
  assert.equal(candidate.cumulativeTrainingGames,parent.trainedGames+accumulated,'Unexpected total across both training runs');
  const {chosen,finalists}=training.selection;
  assert.ok(finalists.length>0 && finalists.length<=config.selectionCandidates,'Invalid finalist count');
  assert.equal(new Set(finalists.map(f=>JSON.stringify(f.weight))).size,finalists.length,'Duplicate finalist weights');
  assert.deepEqual(chosen,finalists[0],'Selected candidate differs from top finalist');
  for (const entry of finalists) {
    const tested=training.generations[entry.epoch-1]?.validated.find(c=>c.index===entry.index);
    assert.ok(tested,'Finalist was absent from validation');
    for (const key of ['weight','training','validation']) assert.deepEqual(entry[key],tested[key],'Finalist '+key+' changed');
    checkScore(entry.confirmation,1152);
    assert.ok(chosen.confirmation.score>=entry.confirmation.score,'Selected candidate has a lower confirmation score');
  }
  assert.deepEqual(candidate.weights,chosen.weight,'Selected candidate weights differ');
  assert.deepEqual(candidate.selection,{round:chosen.epoch,candidateIndex:chosen.index,
    validation:chosen.validation,confirmation:chosen.confirmation},'Model selection differs from training record');
}

export function sampleMirror(rows) {
  return [1,5,10].flatMap(rank => [0,49].map(index => {
    const row = rows.find(r => r.rank === rank && r.index === index);
    assert.ok(row,'Missing sample '+rank+'/'+index);
    return row;
  }));
}

export function auditModels(baseline, candidate) {
  for (const model of [baseline,candidate]) {
    assert.equal(model.features,22);
    assert.ok(Array.isArray(model.weights) && model.weights.length === model.features && model.weights.every(Number.isFinite), 'Invalid learned weights');
    assert.ok(typeof model.version === 'string' && model.version.length, 'Missing version');
    assert.match(model.engineCommit,/^[a-f\d]{40}$/i,'Missing full engine revision');
    assert.ok(Number.isFinite(Date.parse(model.createdAt)) && model.source, 'Missing model provenance');
  }
  assert.equal(candidate.engineCommit,baseline.engineCommit,'Incompatible engine revisions');
  assert.notEqual(candidate.version,baseline.version,'Model labels must identify two versions');
  assert.equal(baseline.trainedGames,0,'The baseline is frozen');
  assert.ok(Number.isSafeInteger(candidate.trainedGames) && candidate.trainedGames > 0,'Invalid training count');
}

export function auditTrace(recorded, firstRun, secondRun) {
  for (const run of [firstRun,secondRun]) {
    assert.ok(run && !run.error,'Engine replay failed: '+(run?.error || 'missing output'));
    for (const field of ['outcome','turns','actions','points','first']) {
      assert.deepEqual(run[field],recorded[field], 'Recorded '+field+' does not match replay');
    }
    assert.equal(run.replay?.length,recorded.actions,'Truncated action trace');
    assert.deepEqual(run.replay.at(-1)?.points,recorded.points,'Final trace points differ from reported points');
    for (const step of run.replay) {
      assert.ok((step.actor === 0 || step.actor === 1) && Number.isInteger(step.turn) &&
        typeof step.action === 'string' && step.action.length, 'Malformed action in trace');
    }
  }
  assert.deepEqual(firstRun.replay,secondRun.replay,'Independent processes produced different action traces');
  return digest(JSON.stringify(firstRun.replay));
}

function readJsonLines(folder, name) {
  const lines=readFileSync(join(folder,name),'utf8').trimEnd().split(/\r?\n/);
  return lines.map((line,index) => {
    try { return JSON.parse(line); }
    catch { throw Error(name+' has invalid JSON on line '+(index+1)); }
  });
}

function runIsolated(inputs, binary) {
  const run=spawnSync(process.execPath,[join(root,'tools/battle/run-engine.mjs')],{
    cwd:root, encoding:'utf8', windowsHide:true, maxBuffer:24*1024*1024, timeout:180_000,
    env:{...process.env,PTCGP_BATTLE_ENGINE:binary},
    input:inputs.map(row => JSON.stringify(row)).join('\n')+'\n'
  });
  if (run.error) throw run.error;
  assert.equal(run.status,0,'Engine subprocess failed: '+run.stderr.trim());
  const outputs=run.stdout.trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(outputs.length,inputs.length,'One result is required per seed');
  return outputs;
}

export function verifyRun(folder, {recordsOnly=false}={}) {
  const json = name => JSON.parse(readFileSync(join(folder,name),'utf8'));
  const fileHash = path => digest(readFileSync(path));
  const lineup=json('lineup.json');
  assert.ok(Array.isArray(lineup.decks), 'Missing frozen deck lineup');
  const decks = lineup.decks.filter(d => d.rank >= 1 && d.rank <= 10);
  const baseline=json('baseline-v0.json');
  const training=json('training.json');
  const continued=training.schemaVersion === 2;
  assert.ok(continued || training.schemaVersion===1,'Unknown training checkpoint version');
  const candidate=json(continued?'candidate-v2.json':'candidate-v1.json');
  auditModels(baseline,candidate);
  assert.equal(baseline.version,'baseline-v0');
  assert.equal(candidate.version,continued?'selfplay-cem-v2':'selfplay-cem-v1');
  const mirror=readJsonLines(folder,'mirror-500.jsonl');
  const holdout=readJsonLines(folder,'eval.jsonl');
  const summaries={mirror:auditMirror(mirror,decks),holdout:auditEvaluation(holdout,decks)};
  const comparisons=[{kind:'holdout',rows:holdout,summary:candidate.eval,opponent:baseline}];
  const trainerDir=join(root,'tools/battle');
  const archive=join(trainerDir,'trainer-v1.mjs');
  const archiveHash=fileHash(archive);
  const actualDigests={
    engineArchiveSha256:fileHash(join(root,'engine/deckgym-source.tgz')),
    bridgeSha256:fileHash(join(root,'engine/pocket_lab.rs')),
    cliSha256:fileHash(join(root,'engine/pocket_lab_cli.rs')),
    trainerSha256:continued?fileHash(join(trainerDir,'trainer-v2.mjs')):archiveHash,
    lineupSha256:fileHash(join(folder,'lineup.json'))
  };
  const parentTraining=continued?json('parent-training.json'):training;
  const originalBaseline=parentTraining.generations[0].candidates.find(entry=>entry.index===0);
  assert.deepEqual(baseline.weights,originalBaseline?.weight,'Frozen baseline weights differ from initial v1 generation');
  if (continued) {
    const parent=json('parent-v1.json');
    auditModels(baseline,parent);
    auditContinuation(candidate,training,parent,parentTraining);
    assert.deepEqual(parent.source,lineup.source,'Parent uses a different source snapshot');
    assert.deepEqual(parentTraining.source,lineup.source,'Parent checkpoint uses a different source snapshot');
    assert.deepEqual(parent.featureNames,candidate.featureNames,'Parent feature ordering differs');
    assert.deepEqual(parent.provenance,{engineArchiveSha256:actualDigests.engineArchiveSha256,
      bridgeSha256:actualDigests.bridgeSha256,cliSha256:actualDigests.cliSha256,
      engineBinarySha256:candidate.provenance.engineBinarySha256,engineTarget:candidate.provenance.engineTarget,
      lineupSha256:actualDigests.lineupSha256,trainerSha256:archiveHash},'Parent run uses different frozen inputs');
    Object.assign(actualDigests,{
      trainerCommonSha256:fileHash(join(trainerDir,'trainer.mjs')),
      parentModelSha256:fileHash(join(folder,'parent-v1.json')),
      parentTrainingSha256:fileHash(join(folder,'parent-training.json'))
    });
    const originalRun=join(root,'reports/battle-ml-c1');
    for (const [original,hash] of [['candidate-v1.json',actualDigests.parentModelSha256],['training.json',actualDigests.parentTrainingSha256]]) {
      const file=join(originalRun,original);
      if (existsSync(file)) assert.equal(fileHash(file),hash,'Parent copy differs from archived v1 '+original);
    }
    const challenge=readJsonLines(folder,'challenge.jsonl');
    summaries.challenge=auditChallenge(challenge,decks,holdout,mirror);
    comparisons.push({kind:'challenge',rows:challenge,summary:candidate.challenge,opponent:parent});
  } else {
    assert.deepEqual(training.bestCandidate.weight,candidate.weights,'Final weights differ from selected checkpoint');
    assert.equal(training.generations.reduce((sum,g) => sum + g.games,0),candidate.trainedGames,'Wrong training-game total');
  }
  for (const artifact of [baseline,candidate,training]) {
    if (continued) assert.equal(artifact.provenance.trainerFile,'trainer-v2.mjs','Unexpected continuation trainer');
    for (const [key,hash] of Object.entries(actualDigests)) {
      assert.equal(artifact.provenance?.[key],hash,'Frozen '+key+' differs from current input');
    }
    assert.deepEqual(artifact.provenance,candidate.provenance,'Artifacts have different provenance');
    assert.deepEqual(artifact.source,lineup.source,'Artifacts refer to different source snapshots');
  }
  auditPublishedSeeds(comparisons,mirror,decks,continued);
  for (const {kind,summary,opponent} of comparisons) {
    const totals=summaries[kind];
    assert.equal(summary?.opponent,opponent.version,'Opponent differs for '+kind);
    for (const key of ['wins','draws','losses']) assert.equal(summary[key],totals[key],'Incorrect '+kind+' '+key);
    checkScore(summary,totals.total);
  }
  const provenance={engineCommit:candidate.engineCommit,trainedGames:candidate.trainedGames,
    ...actualDigests,baselineWeightsSha256:digest(JSON.stringify(baseline.weights)),candidateWeightsSha256:digest(JSON.stringify(candidate.weights))};
  if(recordsOnly) return {mode:'records-only',summaries,provenance};

  const byRank=new Map(decks.map(d => [d.rank,d]));
  const example=byRank.get(1);
  const samples=sampleMirror(mirror).map(row => ({
    kind:'mirror',row,left:example,right:byRank.get(row.rank),enemyWeights:candidate.weights
  }));
  // Check deck ownership and turn order independently against each frozen policy.
  for (const {kind,rows,opponent} of comparisons) {
    for (const deckRank of [1,10]) for (const first of [0,1]) {
      const row=rows.find(r => r.deckRank === deckRank && r.first === first && r.ranks.includes(1) && r.ranks.includes(10));
      assert.ok(row,'Missing '+kind+' replay sample');
      samples.push({kind,row,left:byRank.get(deckRank),right:byRank.get(row.ranks.find(r => r !== deckRank)),enemyWeights:opponent.weights});
    }
  }
  const asEngineDeck = d => ({cards:d.cards,energy:d.energy});
  const inputs=samples.map(({row,left,right,enemyWeights}) => ({
    op:'game',deck:asEngineDeck(left),enemy:asEngineDeck(right),
    weights:candidate.weights,enemy_weights:enemyWeights,first:row.first,seed:row.seed,replay:true
  }));
  const build=join(root,'tmp/battle-build/bin');
  const manifest=JSON.parse(readFileSync(join(build,'manifest.json'),'utf8'));
  const binary=join(build,manifest.filename);
  const binarySha256=digest(readFileSync(binary));
  assert.equal(binarySha256,manifest.sha256,'Replay engine binary differs from its build manifest');
  assert.equal(binarySha256,candidate.provenance.engineBinarySha256,'The selected engine binary differs from the training engine');
  assert.equal(manifest.target,candidate.provenance.engineTarget,'The replay and training engine targets differ');
  assert.equal(manifest.sourceArchiveSha256,actualDigests.engineArchiveSha256,'Replay binary uses a different upstream archive');
  assert.equal(manifest.bridgeSha256,actualDigests.bridgeSha256,'Replay binary uses a different rules bridge');
  assert.equal(manifest.cliSha256,actualDigests.cliSha256,'Replay binary uses a different driver');
  const a=runIsolated(inputs,binary);
  const b=runIsolated([...inputs].reverse(),binary).reverse();
  const replays=samples.map(({kind,row,left,right},i) => ({
    kind,deckRank:left.rank,enemyRank:right.rank,first:row.first,seed:row.seed,outcome:row.outcome,
    turns:row.turns,actions:row.actions,points:row.points,traceSha256:auditTrace(row,a[i],b[i])
  }));
  return {mode:'independent-engine-replays',summaries,provenance,verificationEngine:{target:manifest.target,binarySha256},replays};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  const folder=resolve(args.find(arg => !arg.startsWith('--')) || join(root,'reports/battle-ml-c1'));
  try {
    console.log(JSON.stringify(verifyRun(folder,{recordsOnly:args.includes('--records-only')}),null,2));
  } catch (error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
