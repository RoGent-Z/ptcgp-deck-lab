import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  baselineWeights, buildPopulation, buildProvenance, fitDistribution, json, jsonl, maybeJson,
  model, openEngine, pairedGames, parallel, parseDecks, playRows, randomFrom, readJson,
  scheduleHoldout, scheduleMirror, seed32, sha256, shuffle, smoke, tally,
} from './trainer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parentDir = join(root, 'reports', 'battle-ml-c1');
const experiment = 'pocket-lab-c1-cem-v2';
const config = Object.freeze({
  method: 'warm-started cross-entropy', experimentSeed: experiment,
  generations: 16, candidates: 24, elites: 6, trainGamesPerCandidate: 192,
  validationSeedsPerPair: 32, selectionSeedsPerPair: 48, challengeSeedsPerPair: 32,
  evaluationSeedsPerPair: 12, checkedPerGeneration: 3, selectionCandidates: 6,
  trainRanks: Array.from({length:16}, (_, i) => i + 11),
  validationRanks: [27,28,29,30],
  holdoutRanks: Array.from({length:10}, (_, i) => i + 1),
  trainOpponents: ['selfplay-cem-v1', 'selfplay-cem-v1', 'previous validation leader'],
});

export function continuationSchedule(epoch) {
  const order = shuffle(config.trainRanks, randomFrom(experiment + '|pairs|' + epoch));
  return [1, 3, 5].flatMap((offset, group) => order.flatMap((rank, i) =>
    pairedGames([rank, order[(i + offset) % order.length]].sort((a,b) => a-b),
      seed32(experiment + '|train|' + epoch + '|' + group + '|' + i),
      {opponent: group === 2 ? 'incumbent' : 'baseline'}),
  ));
}
export const validationSchedule = () => scheduleHoldout(config.validationRanks, config.validationSeedsPerPair, 'v2-validation');
export const confirmSchedule = () => scheduleHoldout(config.validationRanks, config.selectionSeedsPerPair, 'v2-selection');
export const challengeSchedule = () => scheduleHoldout(config.holdoutRanks, config.challengeSeedsPerPair, 'v2-v1-challenge');
const baselineSchedule = () => scheduleHoldout(config.holdoutRanks, config.evaluationSeedsPerPair, 'v2-v0-eval');
export function continuationMirror(lineup) {
  return scheduleMirror(lineup).map(row => ({
    ...row, seed: seed32(experiment + '|example|' + row.id + '|' + row.index),
  }));
}

async function freezeInput(out, dest, source) {
  const bytes = await readFile(join(parentDir, source));
  try {
    const output = await open(join(out, dest), 'wx');
    try { await output.writeFile(bytes); } finally { await output.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readFile(join(out, dest));
    if (!previous.equals(bytes)) throw Error('冻结输入冲突 ' + dest);
  }
  return bytes;
}

const jsonEquals = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const signature = ({weight}) => JSON.stringify(weight);
const leaderboard = (a,b) => b.validation.score - a.validation.score ||
  b.training.score - a.training.score || a.epoch - b.epoch || a.index - b.index;
const view = ({index, epoch, training, validation, confirmation, weight}) =>
  ({index, epoch, training, validation, confirmation, weight});

function verifySchedules(lineup, priorEval) {
  const train = Array.from({length:config.generations}, (_, i) => continuationSchedule(i));
  const phases = [
    ...train.map((rows, i) => ['train:' + (i+1), rows, 48]),
    ['validation', validationSchedule(), 192], ['selection', confirmSchedule(), 288],
    ['challenge', challengeSchedule(), 1440], ['eval', baselineSchedule(), 540],
    ['mirror', continuationMirror(lineup), 500],
  ];
  const seen = new Set(priorEval.map(row => row.seed));
  for (const [name, rows, expected] of phases) {
    const seeds = new Set(rows.map(row => row.seed));
    if (seeds.size !== expected || [...seeds].some(seed => seen.has(seed))) {
      throw Error('随机种子重复 ' + name);
    }
    seeds.forEach(seed => seen.add(seed));
  }
  return train;
}

async function optimize(out, pool, decks, source, provenance, coveredCards, parentModel, parentCheckpoint, schedule) {
  const checkpoint = join(out, 'training.json');
  const previous = await maybeJson(checkpoint);
  if (previous && !jsonEquals(previous.provenance, provenance)) {
    throw Error('续训断点对应的引擎、训练脚本、冻结牌表或父模型已变化。');
  }
  const state = previous ?? {
    schemaVersion: 2, source, provenance, coveredCards, config,
    parentVersion: parentModel.version, parentTrainedGames: parentModel.trainedGames,
    startedAt: new Date().toISOString(), trainedGames: 0, generations: [],
    mean: [...parentModel.weights],
    sigma: parentCheckpoint.sigma.map(sigma => Math.max(.20, Math.min(.60, 1.5*sigma))),
    incumbent: [...parentModel.weights], bestCandidate: null,
  };
  const parentOnly = {baseline: parentModel.weights};
  const validation = validationSchedule();
  while (state.generations.length < config.generations) {
    const epoch = state.generations.length;
    const population = buildPopulation(state.mean, state.sigma, state.incumbent, epoch + parentCheckpoint.generations.length);
    const opponents = {...parentOnly, incumbent: state.incumbent};
    const measured = await parallel(pool, population, async (runner, weight, index) => ({
      index, weight, epoch: epoch+1, training: tally(await playRows(runner, schedule[epoch], decks, weight, opponents)),
    }));
    measured.sort((a,b) => b.training.score - a.training.score || a.index - b.index);
    const uniqueNew = measured.filter((entry, i) =>
      !jsonEquals(entry.weight, parentModel.weights) && measured.findIndex(x => signature(x) === signature(entry)) === i);
    const proposed = uniqueNew.slice(0, config.checkedPerGeneration);
    if (!proposed.length) throw Error('候选集合缺少有变化的策略');
    const tested = await parallel(pool, proposed, async (runner, entry) => ({
      ...entry, validation: tally(await playRows(runner, validation, decks, entry.weight, parentOnly)),
    }));
    tested.sort(leaderboard);
    const best = tested[0];
    if (!state.bestCandidate || leaderboard(best, state.bestCandidate) < 0) state.bestCandidate = view(best);
    state.incumbent = state.bestCandidate.validation.score > .5
      ? [...state.bestCandidate.weight] : [...parentModel.weights];
    Object.assign(state, fitDistribution(state.mean, state.sigma, measured.slice(0,config.elites).map(row => row.weight)));
    const games = measured.reduce((sum, entry) => sum + entry.training.games, 0);
    state.trainedGames += games;
    state.generations.push({
      round: epoch+1, games, totalGames: state.trainedGames, scheduledSeedCount: schedule[epoch].length / 4,
      bestTraining: measured[0].training, roundWinner: best.index, validation: best.validation,
      championRound: state.bestCandidate.epoch, championValidation: state.bestCandidate.validation,
      candidates: measured.map(view), validated: tested.map(view),
    });
    state.updatedAt = new Date().toISOString();
    await json(checkpoint, state);
    console.log('续训 ' + (epoch+1) + '/' + config.generations + ' · ' + state.trainedGames +
      ' 局 · 对 V1 验证得分 ' + (100 * state.bestCandidate.validation.score).toFixed(2) + '%');
  }

  if (!state.selection) {
    const candidates = state.generations.flatMap(g => g.validated).sort(leaderboard);
    const distinct = [...new Map(candidates.reverse().map(item=>[signature(item), item])).values()].sort(leaderboard);
    const confirm = confirmSchedule();
    const finalists = await parallel(pool, distinct.slice(0, config.selectionCandidates), async (runner, item) => ({
      ...item, confirmation: tally(await playRows(runner, confirm, decks, item.weight, parentOnly)),
    }));
    finalists.sort((a,b) => b.confirmation.score - a.confirmation.score || leaderboard(a,b));
    state.selection = {finalists: finalists.map(view), chosen: view(finalists[0])};
    await json(checkpoint, state);
    console.log('复选 · 对 V1 得分 ' + (100 * state.selection.chosen.confirmation.score).toFixed(2) + '%');
  }
  const chosen = state.selection.chosen;
  const candidate = model('selfplay-cem-v2', chosen.weight, state.trainedGames, source, state.updatedAt, provenance);
  candidate.parentTrainedGames = parentModel.trainedGames;
  candidate.cumulativeTrainingGames = parentModel.trainedGames + state.trainedGames;
  candidate.selection = {round:chosen.epoch, candidateIndex:chosen.index, validation:chosen.validation, confirmation:chosen.confirmation};
  await json(join(out, 'candidate-v2.json'), candidate);
  return candidate;
}

async function playSet(pool, rows, decks, challenger, opponent) {
  const batches = Array.from({length: Math.ceil(rows.length/48)}, (_,i) => rows.slice(48*i,48*(i+1)));
  return (await parallel(pool, batches, (engine, games) =>
    playRows(engine, games, decks, challenger.weights, {baseline:opponent}))).flat();
}

async function main() {
  const [output = join(root, 'reports', 'battle-ml-c1-v2'), count = '4'] = process.argv.slice(2);
  const workerCount = Number(count);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
    throw Error('用法: node tools/battle/trainer-v2.mjs [输出目录] [1–8 个进程]');
  }
  const out = resolve(output);
  if (out === resolve(parentDir)) throw Error('续训需使用独立输出目录');
  await mkdir(out,{recursive:true});
  const lockPath = join(out,'.run.lock');
  const lock = await open(lockPath,'wx');
  const pool = [];
  try {
    await lock.writeFile(String(process.pid)+'\n');
    const lineupBytes = await freezeInput(out,'lineup.json','lineup.json');
    const parentBytes = await freezeInput(out,'parent-v1.json','candidate-v1.json');
    const parentCheckpointBytes = await freezeInput(out,'parent-training.json','training.json');
    const lineup = JSON.parse(lineupBytes);
    const parentModel = JSON.parse(parentBytes);
    const parentCheckpoint = JSON.parse(parentCheckpointBytes);
    const decks = parseDecks(lineup);
    const {binary,metadata} = await buildProvenance();
    const trainerPath = fileURLToPath(import.meta.url);
    const provenance = {
      ...metadata, trainerFile:basename(trainerPath),
      trainerSha256:sha256(await readFile(trainerPath)),
      trainerCommonSha256:sha256(await readFile(new URL('./trainer.mjs', import.meta.url))),
      lineupSha256:sha256(lineupBytes), parentModelSha256:sha256(parentBytes),
      parentTrainingSha256:sha256(parentCheckpointBytes),
    };
    const archivedTrainer = sha256(await readFile(new URL('./trainer-v1.mjs',import.meta.url)));
    if (parentModel.version !== 'selfplay-cem-v1' || parentModel.trainedGames !== 18432 ||
        parentModel.provenance.trainerSha256 !== archivedTrainer ||
        !jsonEquals(parentModel.provenance, parentCheckpoint.provenance) ||
        !jsonEquals(parentModel.weights, parentCheckpoint.bestCandidate.weight) ||
        parentModel.provenance.engineBinarySha256 !== metadata.engineBinarySha256 ||
        parentModel.provenance.lineupSha256 !== provenance.lineupSha256) {
      throw Error('V1 权重、训练记录或引擎证据不一致');
    }
    const priorEval = (await readFile(join(parentDir,'eval.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const schedule = verifySchedules(lineup,priorEval);
    pool.push(openEngine(binary));
    const coveredCards = await smoke(pool[0],decks);
    console.log('校验通过 · 原 V1 权重热启动 · 30 套赛事牌表 / ' + coveredCards + ' 个卡号');
    while (pool.length < workerCount) pool.push(openEngine(binary));

    const frozenBaseline = await readJson(join(parentDir,'baseline-v0.json'));
    if (!jsonEquals(frozenBaseline.weights, baselineWeights)) throw Error('冻结基线权重与训练器不一致');
    await json(join(out,'baseline-v0.json'),model('baseline-v0',baselineWeights,0,lineup.source,frozenBaseline.createdAt,provenance));
    const candidate = await optimize(out,pool,decks,lineup.source,provenance,coveredCards,parentModel,parentCheckpoint,schedule);

    const challenge = await playSet(pool,challengeSchedule(),decks,candidate,parentModel.weights);
    await jsonl(join(out,'challenge.jsonl'),challenge);
    candidate.challenge = {opponent:parentModel.version,...tally(challenge)};
    console.log('对 V1 盲测 · ' + JSON.stringify(candidate.challenge));
    const evalGames = await playSet(pool,baselineSchedule(),decks,candidate,baselineWeights);
    await jsonl(join(out,'eval.jsonl'),evalGames);
    candidate.eval = {opponent:'baseline-v0',...tally(evalGames)};
    await json(join(out,'candidate-v2.json'),candidate);
    console.log('对 V0 盲测 · ' + JSON.stringify(candidate.eval));
    const example = await playSet(pool,continuationMirror(lineup),decks,candidate,candidate.weights);
    await jsonl(join(out,'mirror-500.jsonl'),example);
    console.log('原始前十 500 局 · ' + JSON.stringify(tally(example)));
  } catch (error) {
    await json(join(out,'last-error.json'),{at:new Date().toISOString(),message:error.message,game:error.game,result:error.result});
    throw error;
  } finally {
    for(const engine of pool) engine.close();
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode=1; });
}

