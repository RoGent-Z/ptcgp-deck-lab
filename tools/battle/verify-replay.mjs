import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const lineup=json('lineup.json');
  assert.ok(Array.isArray(lineup.decks), 'Missing frozen deck lineup');
  const decks = lineup.decks.filter(d => d.rank >= 1 && d.rank <= 10);
  const baseline=json('baseline-v0.json');
  const candidate=json('candidate-v1.json');
  auditModels(baseline,candidate);
  const mirror=readJsonLines(folder,'mirror-500.jsonl');
  const holdout=readJsonLines(folder,'eval.jsonl');
  const summaries={mirror:auditMirror(mirror,decks),holdout:auditEvaluation(holdout,decks)};
  const training=json('training.json');
  const actualDigests={
    engineArchiveSha256:digest(readFileSync(join(root,'engine/deckgym-source.tgz'))),
    bridgeSha256:digest(readFileSync(join(root,'engine/pocket_lab.rs'))),
    trainerSha256:digest(readFileSync(join(root,'tools/battle/trainer.mjs'))),
    lineupSha256:digest(readFileSync(join(folder,'lineup.json')))
  };
  for (const artifact of [baseline,candidate,training]) {
    for (const [key,hash] of Object.entries(actualDigests)) {
      assert.equal(artifact.provenance?.[key],hash,'Frozen '+key+' differs from current input');
    }
    assert.deepEqual(artifact.source,lineup.source,'Artifacts refer to different source snapshots');
  }
  assert.deepEqual(training.bestCandidate.weight,candidate.weights,'Final weights differ from selected checkpoint');
  assert.equal(training.generations.reduce((sum,g) => sum + g.games,0),candidate.trainedGames,'Wrong training-game total');
  const heldOut=summaries.holdout;
  for (const key of ['wins','draws','losses']) assert.equal(candidate.eval?.[key],heldOut[key],'Incorrect holdout '+key);
  assert.equal(candidate.eval.games,heldOut.total);
  const provenance={engineCommit:candidate.engineCommit,trainedGames:candidate.trainedGames,
    ...actualDigests,baselineWeightsSha256:digest(JSON.stringify(baseline.weights)),candidateWeightsSha256:digest(JSON.stringify(candidate.weights))};
  if(recordsOnly) return {mode:'records-only',summaries,provenance};

  const byRank=new Map(decks.map(d => [d.rank,d]));
  const example=byRank.get(1);
  const samples=sampleMirror(mirror).map(row => ({
    kind:'mirror',row,left:example,right:byRank.get(row.rank),enemyWeights:candidate.weights
  }));
  // Holdout seat and deck ownership are separate. Check both for each of the extreme ranks.
  for (const deckRank of [1,10]) for (const first of [0,1]) {
    const row=holdout.find(r => r.deckRank === deckRank && r.first === first && r.ranks.includes(1) && r.ranks.includes(10));
    assert.ok(row,'Missing held-out replay sample');
    samples.push({kind:'holdout',row,left:byRank.get(deckRank),right:byRank.get(row.ranks.find(r => r !== deckRank)),enemyWeights:baseline.weights});
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
  assert.equal(manifest.sourceArchiveSha256,actualDigests.engineArchiveSha256,'Replay binary uses a different upstream archive');
  assert.equal(manifest.bridgeSha256,actualDigests.bridgeSha256,'Replay binary uses a different rules bridge');
  assert.equal(manifest.cliSha256,digest(readFileSync(join(root,'engine/pocket_lab_cli.rs'))),'Replay binary uses a different driver');
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
