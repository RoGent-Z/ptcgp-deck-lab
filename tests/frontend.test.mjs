import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  expandDeckCards,
  getCardImageUrls,
  getDeckPokemonCandidates,
  getPokemonSpriteSlug,
  isFoilCard,
  normalizeSpeciesSlug,
  renderCardFace,
  renderDeckShowcase,
  renderEnergyToken,
  renderPokemonSprites,
  resolveFeaturedPokemon,
  sortDeckEntriesPtcgpDefault
} from '../public/app/cardface.mjs';
import { FIXTURE_CARDS, FIXTURE_SAMPLE_DECK } from '../public/app/fixture.mjs';
import { normalizeFeaturedPokemon, readDeckFile, validateDeck } from '../public/app/core.mjs';

test('cardface renders pokemon, dual-type foil, and official energy icon without text or XSS', () => {
  const xssCard = {
    ...FIXTURE_CARDS[0],
    name: '<script>alert(1)</script>'
  };
  const html = renderCardFace(xssCard, { showDeckAction: true, inDeckCount: 2 });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /組內 ×2/);
  assert.match(html, /https:\/\/game\.pokemontcgpocket\.app\/zh-tw\/tcgp\/A1\/001\/low\.webp/);

  const urlsHi = getCardImageUrls({ id: 'C1-056', set: 'C1' }, true);
  assert.equal(urlsHi[0], 'https://game.pokemontcgpocket.app/zh-tw/tcgp/C1/056/high.webp');
  assert.equal(urlsHi[2], 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/pocket/C1/C1_056_EN.webp');

  const dual = FIXTURE_CARDS.find((c) => c.id === 'C1-056');
  assert.equal(isFoilCard(dual), true);
  const dualHtml = renderCardFace(dual);
  assert.match(dualHtml, /is-dual/);
  assert.match(dualHtml, /is-foil/);

  const tokenHtml = renderEnergyToken('Fire', 'md');
  assert.match(tokenHtml, /src="assets\/energy\/fire\.png"/);
  assert.doesNotMatch(tokenHtml, />火</);
});

test('pokemon 2D sprite resolution, featured trio limit, and Swiss matte assets verify clean', () => {
  assert.equal(normalizeSpeciesSlug('Mega Charizard Y ex'), 'charizard-mega-y');
  assert.equal(normalizeSpeciesSlug('Alolan Raichu ex'), 'raichu-alola');
  assert.equal(normalizeSpeciesSlug("Team Rocket's Mewtwo"), 'mewtwo');
  assert.equal(normalizeSpeciesSlug('Paldean Clodsire ex'), 'clodsire');
  assert.equal(normalizeSpeciesSlug('Origin Forme Palkia'), 'palkia-origin');
  assert.equal(getPokemonSpriteSlug({ type: 'trainer', nameEn: 'Professor Research' }), '');

  const byId = new Map(FIXTURE_CARDS.map((c) => [c.id, c]));
  const candidates = getDeckPokemonCandidates(FIXTURE_SAMPLE_DECK, byId);
  assert.ok(candidates.length >= 4);

  // 自动挑选最多 3 只，优先 Mega / ex 高顺位代表宝可梦
  const autoFeatured = resolveFeaturedPokemon(FIXTURE_SAMPLE_DECK, byId);
  assert.equal(autoFeatured.length, 3);
  assert.ok(autoFeatured.some((p) => p.slug === 'charizard-mega-y'));
  assert.ok(autoFeatured.some((p) => p.slug === 'entei'));

  // 手动指定最多 3 只（超出 3 只自动截断，并保留自定义顺序）
  const customDeck = {
    ...FIXTURE_SAMPLE_DECK,
    featuredPokemon: normalizeFeaturedPokemon(['bulbasaur', 'charmander', 'entei', 'charizard-mega-y'])
  };
  assert.deepEqual(customDeck.featuredPokemon, ['bulbasaur', 'charmander', 'entei']);
  const manualFeatured = resolveFeaturedPokemon(customDeck, byId);
  assert.deepEqual(manualFeatured.map((p) => p.slug), ['bulbasaur', 'charmander', 'entei']);

  const spritesHtml = renderPokemonSprites(manualFeatured, 'md');
  assert.equal((spritesHtml.match(/class="poke-sprite"/g) || []).length, 3);
  assert.match(spritesHtml, /assets\/pokemon\/bulbasaur\.png/);

  // 确认 JSON 导入导出保留 featuredPokemon
  const parsed = readDeckFile(JSON.stringify(customDeck));
  assert.deepEqual(parsed.featuredPokemon, ['bulbasaur', 'charmander', 'entei']);

  // 验证本地已落盘全部 12 枚能量/训练家图标与 sprites.json 清单，且 CSS 禁用 backdrop-filter 玻璃态
  for (const k of ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal', 'colorless', 'dragon', 'fairy', 'trainer']) {
    assert.ok(existsSync(new URL(`../public/assets/energy/${k}.png`, import.meta.url)), `missing energy/${k}.png`);
  }
  const spritesManifest = JSON.parse(readFileSync(new URL('../public/data/sprites.json', import.meta.url), 'utf8'));
  assert.ok(spritesManifest.count >= 1000);
  for (const s of ['bulbasaur', 'pikachu', 'charizard-mega-y', 'dragonite-mega', 'clodsire']) {
    assert.ok(existsSync(new URL(`../public/assets/pokemon/${s}.png`, import.meta.url)), `missing pokemon/${s}.png`);
  }
  const cssText = readFileSync(new URL('../public/app/site.css', import.meta.url), 'utf8');
  assert.doesNotMatch(cssText, /backdrop-filter\s*:/i);
});

test('fixture sample deck is valid 20-card standard deck', () => {
  const byId = new Map(FIXTURE_CARDS.map((c) => [c.id, c]));
  assert.deepEqual(validateDeck(FIXTURE_SAMPLE_DECK, byId), []);
});

test('renderDeckShowcase expands full 20-card wall and pads empty slots safely', () => {
  const byId = new Map(FIXTURE_CARDS.map((c) => [c.id, c]));
  const fullHtml = renderDeckShowcase(FIXTURE_SAMPLE_DECK, byId, { valid: true });
  assert.equal((fullHtml.match(/class="showcase-card/g) || []).length, 20);
  assert.equal((fullHtml.match(/class="showcase-empty"/g) || []).length, 0);
  assert.match(fullHtml, /標準合法/);
  assert.equal((fullHtml.match(/class="poke-sprite"/g) || []).length, 3);

  const partial = { name: '<img src=x onerror=alert(1)>', cards: [{ id: 'A1-001', count: 2 }], energy: ['Grass'] };
  const partHtml = renderDeckShowcase(partial, byId, { valid: false });
  assert.doesNotMatch(partHtml, /<img src=x/);
  assert.match(partHtml, /&lt;img src=x/);
  assert.equal((partHtml.match(/class="showcase-card/g) || []).length, 2);
  assert.equal((partHtml.match(/class="showcase-empty"/g) || []).length, 18);
});

test('catalog trainer subtypes cover all trainer cards consistently', () => {
  const cards = JSON.parse(readFileSync(new URL('../public/data/cards.json', import.meta.url), 'utf8'));
  const trainers = cards.filter((c) => c.type === 'trainer');
  assert.ok(trainers.length >= 400);
  const subtypes = new Set(trainers.map((c) => String(c.subtype || '').toLowerCase()));
  for (const req of ['item', 'supporter', 'tool', 'stadium', 'fossil']) {
    assert.ok(subtypes.has(req), `expected trainer subtype ${req}`);
  }
});

test('meta.top.json stays consistent with meta.json hash and translated top entries', () => {
  const full = JSON.parse(readFileSync(new URL('../public/data/meta.json', import.meta.url), 'utf8'));
  const top = JSON.parse(readFileSync(new URL('../public/data/meta.top.json', import.meta.url), 'utf8'));
  assert.equal(top.hash, full.hash);
  assert.equal(top.totalEntries, full.entries.length);
  assert.equal(top.entries.length, Math.min(40, full.entries.length));
  assert.equal(top.entries[0].id, full.entries[0].id);
  for (const e of top.entries) {
    assert.match(e.name, /[\u4e00-\u9fff]/, `expected Chinese name for ${e.id}, got ${e.name}`);
  }
});

test('sortDeckEntriesPtcgpDefault groups evolution families & trainer subtypes while expandDeckCards locks custom order', () => {
  const cards = JSON.parse(readFileSync(new URL('../public/data/cards.json', import.meta.url), 'utf8'));
  const byId = new Map(cards.map((c) => [c.id, c]));

  const shuffled = [
    { id: 'C1-127', count: 1 },  // supporter 莎莉娜的選擇
    { id: 'B1-255', count: 1 },  // stage1 水 超級暴鯉龍ex
    { id: 'B4-154', count: 1 },  // stadium 療癒海邊
    { id: 'B2-196', count: 1 },  // stage1 水 阿羅拉九尾ex
    { id: 'P-A-005', count: 2 }, // item 精靈球
    { id: 'A4-214', count: 1 },  // basic 水 鯉魚王
    { id: 'B3b-065', count: 1 }, // tool 優雅斗篷
    { id: 'B1a-014', count: 1 }, // stage2 火 超級噴火龍Yex
    { id: 'B4-204', count: 1 },  // basic 水 阿羅拉六尾
    { id: 'B2b-007', count: 2 }  // basic 火 小火龍
  ];
  const sortedIds = sortDeckEntriesPtcgpDefault(shuffled, byId).map((x) => x.id);
  assert.deepEqual(sortedIds, [
    'B2b-007', 'B1a-014', // 火屬性：小火龍 → 超級噴火龍Yex（神奇糖果跳階仍維持同進化鏈相鄰）
    'A4-214', 'B1-255',   // 水屬性：鯉魚王 → 超級暴鯉龍ex
    'B4-204', 'B2-196',   // 水屬性：阿羅拉六尾 → 阿羅拉九尾ex
    'P-A-005',            // 物品：精靈球
    'B3b-065',            // 道具：優雅斗篷
    'C1-127',             // 支援者：莎莉娜的選擇
    'B4-154'              // 競技場：療癒海邊
  ]);

  // 嚴格保留自訂順序（之後不可再自動重排），且匯入/匯出保留 customOrder
  const customDeck = {
    name: '自訂測試',
    energy: ['Water'],
    cards: [{ id: 'P-A-005', count: 2 }, { id: 'A4-214', count: 1 }],
    customOrder: true
  };
  assert.deepEqual(expandDeckCards(customDeck, byId).map((x) => x.id), ['P-A-005', 'P-A-005', 'A4-214']);
  assert.equal(readDeckFile(JSON.stringify(customDeck)).customOrder, true);
});
