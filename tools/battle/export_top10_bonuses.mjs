import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { matchDeckStrategies } from '../../public/app/core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const meta = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'meta.top.json'), 'utf8'));
const v3 = JSON.parse(await readFile(path.join(ROOT, 'public', 'battle', 'models', 'v3.json'), 'utf8'));
const lexicon = JSON.parse(await readFile(path.join(ROOT, 'public', 'battle', 'strategies', 'lexicon.json'), 'utf8'));
const top10 = meta.entries.slice(0, 10);
const lineup = top10.map((e, i) => ({ rank: i + 1, entry: e }));

const lines = [];
for (const entry of top10) {
  const m = matchDeckStrategies(entry.representative, lineup, lexicon, v3.weights);
  const bonuses = [];
  for (const c of entry.representative.cards) {
    const b = Number(m.cardBonusById[c.id] || 0);
    for (let k = 0; k < c.count; k++) bonuses.push(b.toFixed(4));
  }
  lines.push(`${entry.id}\t${entry.name}\t${m.lexiconSeedWeights.map((x) => x.toFixed(6)).join(',')}\t${bonuses.join(',')}`);
}

await writeFile(path.join(ROOT, 'tmp', 'v4-eval', 'top10_lexicon_bonuses.tsv'), lines.join('\n') + '\n', 'utf8');
console.log(`Exported Top-10 lexicon seed weights & card bonuses (${lines.length} teams).`);
