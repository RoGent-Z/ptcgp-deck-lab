import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readData(file) {
  return JSON.parse(readFileSync(new URL('../public/data/' + file, import.meta.url)));
}

test('catalog reconciles every print with the set roster', () => {
  const cards = readData('cards.json');
  const catalog = readData('catalog.json');
  assert.ok(cards.length >= 4577);
  assert.equal(cards.length, catalog.count);
  assert.equal(new Set(cards.map(c => c.id)).size, cards.length);
  assert.equal(catalog.sets.reduce((sum,s) => sum+s.count,0), cards.length);
  for (const card of cards) {
    assert.match(card.id, /^(?:[A-Z]+[0-9]+[a-z]?|P-[A-Z]+)-\d{3,}$/);
    assert.ok(card.name && card.nameEn && card.source);
    assert.ok(Array.isArray(card.types) && Array.isArray(card.attacks) && Array.isArray(card.abilities));
  }
});

test('CHT examples include current and early game effects, reprints and dual types', () => {
  const cards = new Map(readData('cards.json').map(c => [c.id, c]));
  assert.equal(cards.get('A1-001').name,'妙蛙種子');
  assert.equal(cards.get('C1-005').name,'阿羅拉椰蛋樹ex');
  assert.match(cards.get('C1-005').attacks[0].effect,/50/);
  assert.equal(cards.get('C1-153').attacks[0].name,cards.get('C1-005').attacks[0].name);
  assert.deepEqual(new Set(cards.get('C1-056').types),new Set(['psychic','fighting']));
  assert.equal(cards.get('P-A-007').name,'博士的研究');
  assert.match(cards.get('P-A-007').effect,/2/);
  assert.equal(cards.get('SP1-029').name,'夢幻');
});
