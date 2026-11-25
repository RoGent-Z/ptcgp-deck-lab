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
  assert.ok(cards.get('SP1-029').attacks.length >= 1, 'SP1 RGB Mew must have verified Psychic attack');
  assert.equal(cards.get('A1-006').name, '鐵甲蛹');
  assert.equal(cards.get('A4b-107').name, '帕路奇亞ex');
  assert.equal(cards.get('A2b-010').attacks[1].cost.length, 5, 'A2b Charizard ex Steam Artillery must cost 5 energy');
  assert.match(cards.get('C1-018').abilities[0].effect, /30/, 'C1 Charizard Flame Aura must include 30 dmg effect');
  assert.match(cards.get('B1a-068').effect, /希特隆的背包/, 'Clemont must not have empty quotes');
  assert.match(cards.get('P-C-009').effect, /超級超夢Y/, 'Genome Converter Y must have trainer effect');
  assert.match(cards.get('B2b-032').attacks[0].effect, /40/, 'Grumpig Swaying Dance bonus must be 40, not 80');

  // Whole-catalog text integrity guard: zero empty effects, empty quotes, missing numbers, or garbled MT terms
  const garbleRe = /「」|隨機個|擲次|抽張|恢復HP|造成點|替補席|活躍寶可夢|活躍位置|活動位置|雷點能量|翻轉\d|對每個頭|後備寶可夢|除了任何前寶可夢|體育場卡/;
  for (const c of cards.values()) {
    if (c.type === 'pokemon') {
      assert.ok(c.attacks.length >= 1, `${c.id} (${c.name}) must have at least 1 attack`);
      for (const ab of c.abilities) {
        assert.ok(ab.effect && ab.effect.trim().length > 0, `${c.id} (${c.name}) ability effect must not be empty`);
        assert.doesNotMatch(ab.effect, garbleRe, `${c.id} ability has garbled text`);
      }
      for (const atk of c.attacks) {
        if (atk.effect) assert.doesNotMatch(atk.effect, garbleRe, `${c.id} attack has garbled text`);
      }
    } else if (c.type === 'trainer') {
      assert.ok(c.effect && c.effect.trim().length > 0, `${c.id} (${c.name}) trainer effect must not be empty`);
      assert.doesNotMatch(c.effect, garbleRe, `${c.id} trainer has garbled text`);
    }
  }
});
