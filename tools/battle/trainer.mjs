import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runnerPath = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const engineCommit = 'a0f9d14bf2dd2a342e53cd7057486d7ce96ea545';
const config = Object.freeze({
  method: 'cross-entropy',
  experimentSeed: 'pocket-lab-c1-cem-v1',
  generations: 8,
  candidates: 24,
  elites: 6,
  trainGamesPerCandidate: 96,
  validationSeedsPerPair: 8,
  evaluationSeedsPerPair: 12,
  trainRanks: Array.from({length: 16}, (_, i) => i + 11),
  validationRanks: [27, 28, 29, 30],
  holdoutRanks: Array.from({length: 10}, (_, i) => i + 1),
});

export const featureNames = [
  'endTurn', 'noop', 'place', 'activePower', 'evolve', 'evolutionPower',
  'abilityOrStadium', 'trainer', 'drawAtLowHand', 'attack', 'baseDamage',
  'estimatedKnockout', 'attackEffect', 'attach', 'attachActive', 'energyDemand',
  'attachTargetPower', 'retreat', 'protectEndangeredActive', 'activationTarget',
  'toolOrHeal', 'targetedDamage',
];
export const baselineWeights = Object.freeze([
  -0.75, -0.5, 2.0, 0.65, 3.1, 0.8, 2.6, 1.15, 2.25,
  1.35, 0.7, 2.1, 0.22, 2.45, 0.42, 0.9, 0.38, -1.35, 2.65, 0.56, 1.65, 1.8,
]);

export function seed32(label) {
  let hash = 2166136261;
  for (const byte of Buffer.from(String(label), 'utf8')) {
    hash = Math.imul(hash ^ byte, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(label) {
  let state = seed32(label);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normal(random) {
  const u = Math.max(Number.MIN_VALUE, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const roundWeight = value => Math.round(Math.max(-8, Math.min(8, value)) * 1e6) / 1e6;
export function buildPopulation(mean, sigma, incumbent, epoch) {
  const random = randomFrom(config.experimentSeed + '|population|' + epoch);
  return [[...incumbent], ...Array.from({length: config.candidates - 1}, () =>
    mean.map((weight, i) => roundWeight(weight + sigma[i] * normal(random))),
  )];
}

export function fitDistribution(mean, sigma, elite) {
  if (!elite.length) throw Error('CEM requires elite policies');
  const center = mean.map((_, i) => elite.reduce((sum, w) => sum + w[i], 0) / elite.length);
  const deviation = center.map((avg, i) => Math.sqrt(
    elite.reduce((sum, w) => sum + (w[i] - avg) ** 2, 0) / elite.length,
  ));
  return {
    mean: center.map((weight, i) => roundWeight(0.75 * weight + 0.25 * mean[i])),
    sigma: deviation.map((spread, i) => Math.max(0.08, Math.min(2, 0.75 * spread + 0.25 * sigma[i]))),
  };
}

function pairedGames(ranks, seed, extra = {}) {
  return ranks.flatMap(deckRank => [0, 1].map(first => ({ranks, deckRank, first, seed, ...extra})));
}

export function scheduleHoldout(ranks, seedCount, prefix) {
  const ordered = [...ranks].sort((a, b) => a - b);
  const schedule = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const pair = [ordered[i], ordered[j]];
      for (let s = 0; s < seedCount; s++) {
        const seed = seed32(config.experimentSeed + '|' + prefix + '|' + pair.join('-') + '|' + s);
        schedule.push(...pairedGames(pair, seed));
      }
    }
  }
  return schedule;
}

export function scheduleTraining(ranks, epoch, hasIncumbent) {
  const order = shuffle(ranks, randomFrom(config.experimentSeed + '|matchup|' + epoch));
  const ring = [...order.map((r, i) => [r, order[(i + 1) % order.length]]),
    ...order.slice(0, 8).map((r, i) => [r, order[(i + 3) % order.length]])];
  return ring.flatMap((pair, i) => pairedGames(pair.sort((a, b) => a - b),
    seed32(config.experimentSeed + '|train|' + epoch + '|' + i),
    {opponent: hasIncumbent && i % 2 ? 'incumbent' : 'baseline'}));
}

export function scheduleMirror(lineup) {
  const decks = Array.isArray(lineup) ? lineup : lineup.decks;
  return decks.filter(deck => deck.rank <= 10).flatMap(({rank, id}) =>
    Array.from({length: 50}, (_, index) => ({
      rank, id, index, first: index < 25 ? 0 : 1,
      seed: seed32(config.experimentSeed + '|example|' + id + '|' + index),
    })),
  );
}

function gameScore({wins, draws, games}) {
  return (wins + draws / 2) / games;
}

function tally(results) {
  const count = {games: results.length, wins: 0, draws: 0, losses: 0};
  for (const row of results) count[{win: 'wins', draw: 'draws', loss: 'losses'}[row.outcome]]++;
  return {...count, score: gameScore(count)};
}

function openEngine(binary) {
  const child = spawn(process.execPath, [runnerPath], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, PTCGP_BATTLE_ENGINE: binary},
  });
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  let pending, ended = false, diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  function fail(error) {
    ended = true;
    pending?.reject(error);
    pending = undefined;
  }
  lines.on('line', line => {
    if (!pending) return;
    const {resolve: finish, reject} = pending;
    pending = undefined;
    try { finish(JSON.parse(line)); }
    catch { reject(Error('对战引擎响应不是 JSON: ' + line.slice(0, 180))); }
  });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => fail(Error('对战引擎退出 (' + code + ') ' + diagnostics.trim())));
  return {
    request(input) {
      if (ended || pending) throw Error('对战进程不可用 ' + diagnostics.trim());
      return new Promise((finish, reject) => {
        pending = {resolve: finish, reject};
        child.stdin.write(JSON.stringify(input) + '\n');
      });
    },
    close() { lines.close(); child.stdin.end(); },
  };
}

const dataDeck = ({cards, energy}) => ({cards, energy});
const resultFields = ({outcome, turns, actions, points}) => ({outcome, turns, actions, points});

function expectResult(result, game) {
  if (!result || !['win', 'draw', 'loss'].includes(result.outcome) || result.first !== game.first ||
      !Number.isInteger(result.turns) || result.turns < 1 || result.turns > 30 ||
      !Number.isInteger(result.actions) || result.actions < 1 ||
      !Array.isArray(result.points) || result.points.length !== 2 ||
      result.points.some(points => !Number.isInteger(points) || points < 0)) {
    const error = Error(result?.error || '对局返回无效结果');
    error.game = game;
    error.result = result;
    throw error;
  }
}

function inputFor(row, decks, weights, opponents) {
  const firstRank = row.rank === undefined ? row.deckRank : 1;
  const secondRank = row.rank ?? row.ranks.find(r => r !== row.deckRank);
  return {
    op: 'game', deck: dataDeck(decks.get(firstRank)), enemy: dataDeck(decks.get(secondRank)),
    weights, enemy_weights: row.opponent === 'incumbent' ? opponents.incumbent : opponents.baseline,
    seed: row.seed, first: row.first,
  };
}

async function playRows(engine, rows, decks, weights, opponents) {
  const results = [];
  for (let i = 0; i < rows.length; i += 48) {
    const slice = rows.slice(i, i + 48);
    const input = slice.map(row => inputFor(row, decks, weights, opponents));
    const {results: games, error} = await engine.request({op: 'batch', games: input});
    if (error || !Array.isArray(games) || games.length !== input.length) throw Error(error || '对战批次结果数量不匹配');
    for (let j = 0; j < input.length; j++) {
      expectResult(games[j], input[j]);
      results.push({...slice[j], ...resultFields(games[j])});
    }
  }
  return results;
}

async function parallel(pool, items, task) {
  const results = new Array(items.length);
  let next = 0, failure;
  await Promise.all(pool.map(async engine => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await task(engine, items[index], index); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function maybeJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function atomic(path, content) {
  const temporary = path + '.' + process.pid + '.partial';
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

const json = (path, value) => atomic(path, JSON.stringify(value, null, 2) + '\n');
const jsonl = (path, values) => atomic(path, values.map(value => JSON.stringify(value)).join('\n') + '\n');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function buildProvenance() {
  const dir = join(root, 'tmp', 'battle-build', 'bin');
  const manifest = await readJson(join(dir, 'manifest.json'));
  const binary = process.env.PTCGP_BATTLE_ENGINE ?? join(dir, manifest.filename);
  const digest = async name => sha256(await readFile(join(root, 'engine', name)));
  const engineArchiveSha256 = await digest('deckgym-source.tgz');
  const bridgeSha256 = await digest('pocket_lab.rs');
  const cliSha256 = await digest('pocket_lab_cli.rs');
  const engineBinarySha256 = sha256(await readFile(binary));
  if (manifest.sourceArchiveSha256 !== engineArchiveSha256 || manifest.bridgeSha256 !== bridgeSha256 ||
      manifest.cliSha256 !== cliSha256 || manifest.sha256 !== engineBinarySha256) {
    throw Error('引擎二进制与源码清单不一致，请重新构建。');
  }
  return {binary, metadata: {engineArchiveSha256, bridgeSha256, cliSha256, engineBinarySha256, engineTarget: manifest.target}};
}

function model(version, weights, trainedGames, source, createdAt, provenance) {
  return {version, features: featureNames.length, featureNames, weights, trainedGames, createdAt,
    engineCommit, source, provenance};
}

function parseDecks(lineup) {
  const decks = new Map();
  for (const deck of lineup.decks) {
    if (!Number.isInteger(deck.rank) || decks.has(deck.rank) || !deck.id ||
        !deck.cards?.length || deck.cards.reduce((sum, c) => sum + c.count, 0) !== 20 ||
        !(deck.energy?.length >= 1 && deck.energy.length <= 3)) {
      throw Error('冻结牌表无效，排名 ' + deck.rank);
    }
    decks.set(deck.rank, deck);
  }
  if (decks.size !== 30 || Array.from({length: 30}, (_, i) => i + 1).some(rank => !decks.has(rank))) {
    throw Error('冻结牌表必须完整包含排名 1–30');
  }
  return decks;
}

async function smoke(engine, decks) {
  const ids = [...new Set([...decks.values()].flatMap(d => d.cards.map(c => c.id)))];
  const status = await engine.request({op: 'coverage', ids});
  if (status.error) throw Error(status.error);
  const missing = ids.filter(id => !['Complete', 'Fully implemented', 'Implemented', 'ok'].includes(status.coverage?.[id]));
  if (missing.length) throw Error('规则引擎尚未支持 ' + missing.map(id => id + '=' + status.coverage?.[id]).join('、'));
  for (const first of [0, 1]) {
    const seed = seed32('smoke-seat-' + first);
    const game = {...inputFor({ranks: [1, 2], deckRank: 1, first, seed}, decks, baselineWeights,
      {baseline: baselineWeights}), replay: true};
    const result = await engine.request(game);
    expectResult(result, game);
    const replayed = await engine.request(game);
    const same = JSON.stringify(result) === JSON.stringify(replayed);
    if (!same || result.replay?.length !== result.actions ||
        result.replay?.find(step => step.turn === 1)?.actor !== first) {
      const error = Error('先后手或固定种子动作回放不一致');
      error.game = game;
      error.result = result;
      throw error;
    }
  }
  return ids.length;
}

async function train(out, pool, decks, source, provenance, coveredCards) {
  const file = join(out, 'training.json');
  const prior = await maybeJson(file);
  if (prior && JSON.stringify(prior.provenance) !== JSON.stringify(provenance)) {
    throw Error('现有训练断点对应不同的引擎、牌表或训练脚本。请指定新的输出目录。');
  }
  const start = prior?.startedAt ?? new Date().toISOString();
  const baseline = model('baseline-v0', [...baselineWeights], 0, source, start, provenance);
  await json(join(out, 'baseline-v0.json'), baseline);
  const state = prior ?? {
    schemaVersion: 1, source, provenance, config, coveredCards, startedAt: start, trainedGames: 0,
    generations: [], mean: [...baselineWeights],
    sigma: baselineWeights.map(weight => Math.max(0.35, Math.min(1.15, 0.55 + 0.2 * Math.abs(weight)))),
    incumbent: [...baselineWeights], bestCandidate: null,
  };
  const validation = scheduleHoldout(config.validationRanks, config.validationSeedsPerPair, 'validation');
  while (state.generations.length < config.generations) {
    const epoch = state.generations.length;
    const round = scheduleTraining(config.trainRanks, epoch, epoch > 0);
    const population = buildPopulation(state.mean, state.sigma, state.incumbent, epoch);
    const competitors = {baseline: baselineWeights, incumbent: state.incumbent};
    const measured = await parallel(pool, population, async (runner, weight, index) => ({
      index, weight, training: tally(await playRows(runner, round, decks, weight, competitors)),
    }));
    measured.sort((a, b) => b.training.score - a.training.score || a.index - b.index);

    const distinct = measured.filter(item => JSON.stringify(item.weight) !== JSON.stringify(baselineWeights));
    const proposed = distinct.slice(0, 3);
    const tested = await parallel(pool, proposed, async (runner, item) => ({
      ...item, validation: tally(await playRows(runner, validation, decks, item.weight, competitors)),
    }));
    tested.sort((a, b) => b.validation.score - a.validation.score || b.training.score - a.training.score || a.index - b.index);
    const winner = tested[0];
    if (!state.bestCandidate || winner.validation.score > state.bestCandidate.validation.score) {
      state.bestCandidate = {...winner, epoch: epoch + 1};
    }
    state.incumbent = [...state.bestCandidate.weight];
    const fitted = fitDistribution(state.mean, state.sigma, measured.slice(0, config.elites).map(c => c.weight));
    Object.assign(state, fitted);
    const games = measured.reduce((sum, item) => sum + item.training.games, 0);
    state.trainedGames += games;
    state.generations.push({
      round: epoch + 1, games, totalGames: state.trainedGames, scheduledSeedCount: round.length / 4,
      bestTraining: measured[0].training, roundWinner: winner.index, validation: winner.validation,
      championRound: state.bestCandidate.epoch, championValidation: state.bestCandidate.validation,
      candidates: measured.map(({index, weight, training}) => ({index, weight, training})),
      validated: tested.map(({index, validation}) => ({index, validation})),
    });
    state.updatedAt = new Date().toISOString();
    await json(file, state);
    console.log('轮次 ' + (epoch + 1) + '/' + config.generations + ' · ' + state.trainedGames +
      ' 局训练 · 验证得分 ' + (100 * state.bestCandidate.validation.score).toFixed(2) + '%');
  }
  const candidate = model('selfplay-cem-v1', state.bestCandidate.weight, state.trainedGames, source, state.updatedAt, provenance);
  candidate.selection = {round: state.bestCandidate.epoch, validation: state.bestCandidate.validation};
  await json(join(out, 'candidate-v1.json'), candidate);
  return candidate;
}

async function evaluate(out, pool, decks, candidate, lineup) {
  const evalRows = scheduleHoldout(config.holdoutRanks, config.evaluationSeedsPerPair, 'test');
  const chunks = Array.from({length: evalRows.length / 48}, (_, i) => evalRows.slice(48 * i, 48 * (i + 1)));
  const evalGames = (await parallel(pool, chunks, (engine, rows) =>
    playRows(engine, rows, decks, candidate.weights, {baseline: baselineWeights}))).flat();
  if (evalGames.length !== 2160) throw Error('独立评测应产生 2160 局');
  await jsonl(join(out, 'eval.jsonl'), evalGames);
  candidate.eval = {opponent: 'baseline-v0', ...tally(evalGames)};
  await json(join(out, 'candidate-v1.json'), candidate);
  console.log('独立评测 · ' + JSON.stringify(candidate.eval));

  const mirrorRows = scheduleMirror(lineup);
  const slices = Array.from({length: 10}, (_, i) => mirrorRows.slice(50 * i, 50 * (i + 1)));
  const mirrorGames = (await parallel(pool, slices, (engine, rows) =>
    playRows(engine, rows, decks, candidate.weights, {baseline: candidate.weights}))).flat();
  if (mirrorGames.length !== 500) throw Error('原始前十批次应产生 500 局');
  await jsonl(join(out, 'mirror-500.jsonl'), mirrorGames);
  console.log('原始前十 500 局 · ' + JSON.stringify(tally(mirrorGames)));
}

async function main() {
  const [output = join(root, 'reports', 'battle-ml-c1'), mode = 'all', count = '4'] = process.argv.slice(2);
  const workers = Number(count);
  if (!['all', 'smoke', 'train', 'eval'].includes(mode) || !Number.isInteger(workers) || workers < 1 || workers > 8) {
    throw Error('用法: node tools/battle/trainer.mjs [输出目录] [all|smoke|train|eval] [1–8 个进程]');
  }
  const out = resolve(output);
  await mkdir(out, {recursive: true});
  const lockPath = join(out, '.run.lock');
  const lock = await open(lockPath, 'wx');
  const pool = [];
  try {
    await lock.writeFile(String(process.pid) + '\n');
    const lineup = await readJson(join(out, 'lineup.json'));
    const decks = parseDecks(lineup);
    const {binary, metadata} = await buildProvenance();
    const provenance = {
      ...metadata,
      trainerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      lineupSha256: sha256(await readFile(join(out, 'lineup.json'))),
    };
    pool.push(openEngine(binary));
    const coveredCards = await smoke(pool[0], decks);
    console.log('冒烟通过 · 30 套真实牌表 / ' + coveredCards + ' 个不同卡号 · 固定种子与先后手一致');
    if (mode === 'smoke') return;
    while (pool.length < workers) pool.push(openEngine(binary));
    const candidate = mode === 'eval' ? await readJson(join(out, 'candidate-v1.json')) :
      await train(out, pool, decks, lineup.source, provenance, coveredCards);
    if (mode === 'train') return;
    if (JSON.stringify(candidate.provenance) !== JSON.stringify(provenance)) throw Error('候选权重与当前引擎、训练脚本或牌表不一致');
    await evaluate(out, pool, decks, candidate, lineup);
  } catch (error) {
    await json(join(out, 'last-error.json'), {
      at: new Date().toISOString(), message: error.message, game: error.game, result: error.result,
    });
    throw error;
  } finally {
    for (const engine of pool) engine.close();
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

export {
  buildProvenance, json, jsonl, maybeJson, model, openEngine, pairedGames,
  parallel, parseDecks, playRows, randomFrom, readJson, sha256, shuffle, smoke, tally,
};

