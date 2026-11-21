import { evaluateDeckOwnership } from './core.mjs';

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

export const TYPE_META = {
  grass:     { key: 'grass',     en: 'Grass',     zh: '草',   icon: 'assets/energy/grass.png',     color: 'var(--t-grass)',     deep: 'var(--t-grass-deep)',     ink: '#141414' },
  fire:      { key: 'fire',      en: 'Fire',      zh: '火',   icon: 'assets/energy/fire.png',      color: 'var(--t-fire)',      deep: 'var(--t-fire-deep)',      ink: '#ffffff' },
  water:     { key: 'water',     en: 'Water',     zh: '水',   icon: 'assets/energy/water.png',     color: 'var(--t-water)',     deep: 'var(--t-water-deep)',     ink: '#ffffff' },
  lightning: { key: 'lightning', en: 'Lightning', zh: '雷',   icon: 'assets/energy/lightning.png', color: 'var(--t-lightning)', deep: 'var(--t-lightning-deep)', ink: '#141414' },
  psychic:   { key: 'psychic',   en: 'Psychic',   zh: '超',   icon: 'assets/energy/psychic.png',   color: 'var(--t-psychic)',   deep: 'var(--t-psychic-deep)',   ink: '#ffffff' },
  fighting:  { key: 'fighting',  en: 'Fighting',  zh: '鬥',   icon: 'assets/energy/fighting.png',  color: 'var(--t-fighting)',  deep: 'var(--t-fighting-deep)',  ink: '#ffffff' },
  darkness:  { key: 'darkness',  en: 'Darkness',  zh: '惡',   icon: 'assets/energy/darkness.png',  color: 'var(--t-darkness)',  deep: 'var(--t-darkness-deep)',  ink: '#ffffff' },
  metal:     { key: 'metal',     en: 'Metal',     zh: '鋼',   icon: 'assets/energy/metal.png',     color: 'var(--t-metal)',     deep: 'var(--t-metal-deep)',     ink: '#141414' },
  colorless: { key: 'colorless', en: 'Colorless', zh: '無',   icon: 'assets/energy/colorless.png', color: 'var(--t-colorless)', deep: 'var(--t-colorless-deep)', ink: '#141414' },
  dragon:    { key: 'dragon',    en: 'Dragon',    zh: '龍',   icon: 'assets/energy/dragon.png',    color: 'var(--t-dragon)',    deep: 'var(--t-dragon-deep)',    ink: '#141414' },
  fairy:     { key: 'fairy',     en: 'Fairy',     zh: '妖',   icon: 'assets/energy/fairy.png',     color: 'var(--t-psychic)',   deep: 'var(--t-psychic-deep)',   ink: '#141414' },
  trainer:   { key: 'trainer',   en: 'Trainer',   zh: '訓',   icon: 'assets/energy/trainer.png',   color: 'var(--t-trainer)',   deep: 'var(--t-trainer-deep)',   ink: '#141414' }
};

export const STAGE_LABELS = {
  basic: '基礎',
  stage1: '1階進化',
  stage2: '2階進化'
};

export const TRAINER_LABELS = {
  item: '物品',
  supporter: '支援者',
  tool: '寶可夢道具',
  'pokemon tool': '寶可夢道具',
  stadium: '競技場',
  fossil: '化石'
};

export function resolveType(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return TYPE_META[k] || TYPE_META.trainer;
}

export function cardPrimaryTypes(card) {
  if (card?.type === 'trainer' && (!card.types || !card.types.length)) return [TYPE_META.trainer];
  const arr = (card?.types || []).map(resolveType);
  return arr.length ? arr : [TYPE_META.colorless];
}

export function isFoilCard(card) {
  if (!card) return false;
  const r = String(card.rarity || '');
  if (/☆|★|♛|✦|AN|crown|sar|ur|sr|ar|rr/i.test(r)) return true;
  if (/\bex\b|\bEX\b/i.test(card.name || '') || /\bex\b/i.test(card.nameEn || '')) return true;
  return false;
}

export function isCrownCard(card) {
  const r = String(card?.rarity || '');
  return /♛|crown/i.test(r);
}

export function getCardImageUrls(card, hiRes = false) {
  const urls = [];
  if (card?.image && /^https?:\/\//.test(card.image)) {
    urls.push(card.image);
  }
  const idStr = String(card?.id || '');
  const idx = idStr.lastIndexOf('-');
  if (idx > 0) {
    const setCode = card?.set || idStr.slice(0, idx);
    const numStr = idStr.slice(idx + 1).padStart(3, '0');
    const zhHigh = `https://game.pokemontcgpocket.app/zh-tw/tcgp/${encodeURIComponent(setCode)}/${encodeURIComponent(numStr)}/high.webp`;
    const zhLow = `https://game.pokemontcgpocket.app/zh-tw/tcgp/${encodeURIComponent(setCode)}/${encodeURIComponent(numStr)}/low.webp`;
    const isNativeAndroid = typeof window !== 'undefined' && typeof window.PocketLabNative?.exportTextFile === 'function';
    const zh52Poke = isNativeAndroid
      ? `__52poke_card/${encodeURIComponent(setCode)}/${encodeURIComponent(numStr)}.png`
      : '';
    const enLimitless = `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/pocket/${encodeURIComponent(setCode)}/${encodeURIComponent(setCode)}_${encodeURIComponent(numStr)}_EN.webp`;
    if (hiRes) {
      urls.push(zhHigh, zhLow);
    } else {
      urls.push(zhLow);
    }
    if (zh52Poke) urls.push(zh52Poke);
    urls.push(enLimitless);
  }
  return [...new Set(urls)];
}

export function renderCardImgTag(card, className = 'cf-img', hiRes = false) {
  const urls = getCardImageUrls(card, hiRes);
  if (!urls.length) return '';
  const [primary, ...rest] = urls;
  return `<img class="${esc(className)}" src="${esc(primary)}" data-fallbacks="${esc(rest.join('|'))}" alt="${esc(card?.name || card?.id || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

export function renderEnergyToken(raw, size = 'md') {
  const t = resolveType(raw);
  return `<span class="energy-token size-${esc(size)} kind-${esc(t.key)}" title="${esc(t.zh)} (${esc(t.en)})"><img class="energy-img" src="${esc(t.icon)}" alt="${esc(t.zh)}" decoding="async"></span>`;
}

const SPRITE_ALIASES = {
  'clodsire-paldea': 'clodsire',
  'basculegion-hisui': 'basculegion',
  'perrserker-galar': 'perrserker',
  'obstagoon-galar': 'obstagoon',
  'mr-rime-galar': 'mr-rime',
  'cursola-galar': 'cursola',
  'basculin-hisui': 'basculin-white-striped',
  'single-strike-urshifu': 'urshifu',
  'rapid-strike-urshifu': 'urshifu-rapid-strike',
  'cornerstone-mask-ogerpon': 'ogerpon-cornerstone',
  'hearthflame-mask-ogerpon': 'ogerpon-hearthflame',
  'wellspring-mask-ogerpon': 'ogerpon-wellspring',
  'teal-mask-ogerpon': 'ogerpon',
  'tauros-paldea': 'tauros-paldea-combat',
  'flabebe': 'flabebe'
};

const toAsciiSlug = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/['.:]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

export function normalizeSpeciesSlug(nameEn) {
  let n = String(nameEn || '').trim();
  if (!n) return '';
  n = n.replace(/\s+(?:ex|EX)$/, '').trim();
  n = n.replace(/^Team Rocket's\s+/, '').trim();
  n = n.replace(/^Detective\s+/, '').trim();
  n = n.replace(/♀/g, '-f').replace(/♂/g, '-m');

  const mReg = n.match(/^(Alolan|Galarian|Hisuian|Paldean)\s+(.+)$/);
  if (mReg) {
    const regMap = { Alolan: 'alola', Galarian: 'galar', Hisuian: 'hisui', Paldean: 'paldea' };
    const slug = `${normalizeSpeciesSlug(mReg[2])}-${regMap[mReg[1]]}`;
    return SPRITE_ALIASES[slug] || slug;
  }

  const mMega = n.match(/^Mega\s+(.+?)(?:\s+([XY]))?$/);
  if (mMega) {
    const suf = mMega[2] ? '-' + mMega[2].toLowerCase() : '';
    const slug = `${normalizeSpeciesSlug(mMega[1])}-mega${suf}`;
    return SPRITE_ALIASES[slug] || slug;
  }

  const mOrig = n.match(/^Origin Forme\s+(.+)$/);
  if (mOrig) return `${normalizeSpeciesSlug(mOrig[1])}-origin`;

  for (const rot of ['Wash', 'Heat', 'Frost', 'Fan', 'Mow']) {
    if (n === `${rot} Rotom`) return `rotom-${rot.toLowerCase()}`;
  }
  if (n === 'Dawn Wings Necrozma') return 'necrozma-dawn-wings';
  if (n === 'Dusk Mane Necrozma') return 'necrozma-dusk-mane';
  if (n === 'Ultra Necrozma') return 'necrozma-ultra';

  const mCast = n.match(/^Castform\s+(\w+)\s+Form$/);
  if (mCast) return `castform-${mCast[1].toLowerCase()}`;

  if (n.startsWith('Oricorio ')) {
    const style = n.slice(9).replace(/\s*Style$/, '').trim().toLowerCase().replace(/\s+/g, '-');
    return `oricorio-${style}`;
  }

  const mWorm = n.match(/^(.+?)\s+(Plant|Sandy|Trash)\s+Cloak$/);
  if (mWorm) return `${toAsciiSlug(mWorm[1])}-${mWorm[2].toLowerCase()}`;

  n = n.replace(/\s+(?:Forme|Form|Mode|Cloak|Size|Mask|Style)$/, '');
  const slug = toAsciiSlug(n);
  return SPRITE_ALIASES[slug] || slug;
}

export function getPokemonSpriteSlug(cardOrName, spriteMap = null) {
  if (!cardOrName) return '';
  if (typeof cardOrName === 'string') {
    return (spriteMap && spriteMap[cardOrName]) || normalizeSpeciesSlug(cardOrName);
  }
  if (cardOrName.type && cardOrName.type !== 'pokemon') return '';
  const rawEn = cardOrName.limitName || cardOrName.nameEn || '';
  return (spriteMap && rawEn && spriteMap[rawEn]) || normalizeSpeciesSlug(rawEn);
}

export const getPokemonSpriteUrl = (slug) => (slug ? `assets/pokemon/${encodeURIComponent(slug)}.png` : '');

const STAGE_PRIORITY = { basic: 1, stage1: 2, stage2: 3 };

export function getDeckPokemonCandidates(deck, cardsById, spriteMap = null) {
  const bySlug = new Map();
  let order = 0;
  for (const entry of deck?.cards || []) {
    const card = cardsById?.get ? cardsById.get(entry.id) : null;
    if (!card || card.type !== 'pokemon') continue;
    const slug = getPokemonSpriteSlug(card, spriteMap);
    if (!slug) continue;
    const isAce = isFoilCard(card) || /\bex\b|\bEX\b|^Mega\s+/i.test(card.nameEn || '');
    const stageRank = STAGE_PRIORITY[card.stage] || 1;
    const prev = bySlug.get(slug);
    if (prev) {
      prev.count += entry.count || 1;
      if ((isAce && !prev.isAce) || stageRank > prev.stageRank) {
        prev.isAce = prev.isAce || isAce;
        prev.stageRank = Math.max(prev.stageRank, stageRank);
        prev.name = card.name || prev.name;
      }
    } else {
      bySlug.set(slug, {
        slug,
        name: card.name || card.nameEn || slug,
        nameEn: card.nameEn || slug,
        count: entry.count || 1,
        isAce,
        stageRank,
        order: order++
      });
    }
  }
  return [...bySlug.values()].sort(
    (a, b) => Number(b.isAce) - Number(a.isAce) || b.stageRank - a.stageRank || b.count - a.count || a.order - b.order
  );
}

export function resolveFeaturedPokemon(deck, cardsById, spriteMap = null) {
  const candidates = getDeckPokemonCandidates(deck, cardsById, spriteMap);
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const explicit = Array.isArray(deck?.featuredPokemon) ? deck.featuredPokemon : [];
  if (explicit.length > 0) {
    if (candidates.length > 0) {
      const valid = explicit.map((s) => bySlug.get(s)).filter(Boolean).slice(0, 3);
      if (valid.length > 0) return valid;
    } else {
      return explicit.slice(0, 3).map((slug) => ({ slug, name: slug, nameEn: slug }));
    }
  }
  return candidates.slice(0, 3);
}

export function renderPokemonSprites(list, size = 'md') {
  if (!Array.isArray(list) || !list.length) return '';
  const chips = list
    .slice(0, 3)
    .map((p) => {
      const slug = typeof p === 'string' ? p : p.slug;
      const label = (typeof p === 'string' ? p : p.name || p.nameEn || slug) || slug;
      if (!slug) return '';
      return `<span class="poke-sprite-chip size-${esc(size)}" title="${esc(label)}"><img class="poke-sprite" src="${esc(getPokemonSpriteUrl(slug))}" alt="${esc(label)}" decoding="async"></span>`;
    })
    .filter(Boolean)
    .join('');
  return chips ? `<span class="poke-sprites-inline size-${esc(size)}">${chips}</span>` : '';
}

export function cardSubline(card) {
  if (card.type === 'trainer') {
    return TRAINER_LABELS[String(card.subtype || '').toLowerCase()] || card.subtype || '訓練家';
  }
  const stage = STAGE_LABELS[card.stage] || card.stage || '寶可夢';
  const typesText = cardPrimaryTypes(card).map((t) => t.zh).join(' / ');
  return `${stage} · ${typesText}`;
}

export function renderCardFace(card, opts = {}) {
  const types = cardPrimaryTypes(card);
  const t1 = types[0];
  const t2 = types[1] || null;
  const foil = isFoilCard(card);
  const crown = isCrownCard(card);
  const inDeck = opts.inDeckCount || 0;
  const trackOwned = opts.ownedCount != null && opts.showMissing !== false;
  const ownedCount = Math.max(0, Number(opts.ownedCount || 0));
  const illegal = card.legal === false || card.playable === false;
  const engineMissing = opts.engineStatus && opts.engineStatus !== 'Implemented' && opts.engineStatus !== 'ok';
  const hiRes = Boolean(opts.hiRes);

  const styleVars = [
    `--c1:${t1.color}`,
    `--c1-deep:${t1.deep}`,
    `--c2:${t2 ? t2.color : t1.color}`,
    `--c2-deep:${t2 ? t2.deep : t1.deep}`
  ].join(';');

  const classes = [
    'card-face',
    card.type === 'trainer' ? 'is-trainer' : 'is-pokemon',
    t2 ? 'is-dual' : '',
    foil ? 'is-foil' : '',
    crown ? 'is-crown' : '',
    hiRes ? 'is-hires' : '',
    trackOwned && ownedCount === 0 ? 'is-unowned' : ''
  ].filter(Boolean).join(' ');

  const tokensHtml = card.type === 'trainer'
    ? renderEnergyToken('trainer', 'sm')
    : types.slice(0, 2).map((t) => renderEnergyToken(t.key, 'sm')).join('');

  const imgTag = renderCardImgTag(card, 'cf-img', hiRes);
  const ownTagHtml = trackOwned
    ? (ownedCount === 0
        ? '<span class="cf-own-tag is-missing">未持有</span>'
        : `<span class="cf-own-tag is-owned">持有 ×${ownedCount}</span>`)
    : '';

  const badges = [];
  if (illegal) badges.push('<span class="cf-status is-warn">非標準</span>');
  else if (engineMissing) badges.push('<span class="cf-status is-mute">待實裝</span>');

  return `
    <article class="${classes}" style="${styleVars}" data-card-id="${esc(card.id)}">
      <button class="cf-hit" type="button" data-action="inspect-card" data-id="${esc(card.id)}" aria-label="查看 ${esc(card.name)} (${esc(card.id)})">
        <div class="cf-media">
          ${ownTagHtml}
          <div class="cf-fallback" aria-hidden="true">
            <div class="cf-fb-emblem">${tokensHtml}</div>
            <span class="cf-fb-name">${esc(card.name)}</span>
            <span class="cf-fb-id">${esc(card.id)}</span>
          </div>
          ${imgTag}
        </div>
        ${hiRes ? '' : `
          <div class="cf-caption">
            <div class="cf-cap-top">
              <span class="cf-name" title="${esc(card.name)}">${esc(card.name)}</span>
              <span class="cf-tokens">${tokensHtml}</span>
            </div>
            <div class="cf-foot">
              <span class="cf-id">${esc(card.id)}</span>
              ${badges.join('')}
              <span class="cf-rarity">${esc(card.rarity || '')}</span>
            </div>
          </div>`}
      </button>
      ${opts.showDeckAction ? `
        <div class="cf-bar">
          ${inDeck > 0 ? `<span class="cf-indeck">組內 ×${inDeck}</span>` : '<span class="cf-bar-hint">加入草稿</span>'}
          <div class="cf-actions">
            ${inDeck > 0 ? `<button class="cf-step" type="button" data-action="remove-card" data-id="${esc(card.id)}" aria-label="從牌組減少 ${esc(card.name)}">−</button>` : ''}
            <button class="cf-step is-add" type="button" data-action="add-card" data-id="${esc(card.id)}" aria-label="將 ${esc(card.name)} 加入牌組">+</button>
          </div>
        </div>` : ''}
      ${trackOwned && !hiRes ? `
        <div class="cf-own-row">
          <span class="cf-own-label ${ownedCount > 0 ? 'is-owned' : 'is-missing'}">${ownedCount > 0 ? `持有 ×${ownedCount}` : '遊戲內未持有'}</span>
          <div class="cf-actions">
            ${ownedCount > 0 ? `<button class="cf-step" type="button" data-action="own-delta" data-id="${esc(card.id)}" data-delta="-1" aria-label="減少持有 ${esc(card.name)}">−</button>` : ''}
            <button class="cf-step is-own-add" type="button" data-action="own-delta" data-id="${esc(card.id)}" data-delta="1" aria-label="標記持有 ${esc(card.name)}">+</button>
          </div>
        </div>` : ''}
    </article>
  `;
}

export function renderDeckMiniSlot(card, count, idFallback, opts = {}) {
  if (!card) {
    return `<div class="deck-slot is-missing" title="卡庫缺失 ${esc(idFallback)}">
      <span class="slot-id">${esc(idFallback)}</span>
      <span class="slot-name">卡庫缺失</span>
      <span class="slot-qty">×${count}</span>
    </div>`;
  }
  const t = cardPrimaryTypes(card)[0];
  const thumb = renderCardImgTag(card, 'slot-thumb', false);
  const missingCount = Math.max(0, Number(opts.missingCount || 0));
  const showMissing = opts.showMissing !== false && missingCount > 0;
  const ownedForSlot = Number(opts.ownedForSlot || 0);
  const missBadge = showMissing
    ? `<span class="slot-miss ${ownedForSlot === 0 ? 'is-none' : 'is-short'}">${ownedForSlot === 0 ? '未持有' : `缺 ${missingCount}`}</span>`
    : '';
  return `<button class="deck-slot ${showMissing ? 'is-unowned' : ''}" type="button" style="--slot-c:${t.color};--slot-deep:${t.deep}" data-action="inspect-card" data-id="${esc(card.id)}" title="${esc(card.name)} (${esc(card.id)})">
    <span class="slot-thumb-wrap">${thumb}</span>
    <span class="slot-info">
      <span class="slot-id">${esc(card.id)}${missBadge}</span>
      <span class="slot-name">${esc(card.name)}</span>
      <span class="slot-qty">×${count}</span>
    </span>
  </button>`;
}

const TYPE_SORT_ORDER = {
  grass: 0,
  fire: 1,
  water: 2,
  lightning: 3,
  psychic: 4,
  fighting: 5,
  darkness: 6,
  metal: 7,
  dragon: 8,
  colorless: 9
};
const STAGE_ORDER = { basic: 0, stage1: 1, stage2: 2 };
const TRAINER_SORT_ORDER = { item: 0, fossil: 1, tool: 2, supporter: 3, stadium: 4 };

function normEvoKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
}

function compareCardIds(idA, idB) {
  const splitId = (id) => {
    const s = String(id || '');
    const m = s.match(/^(.*)-(\d+)([a-z]*)$/i);
    if (!m) return [s, 0, ''];
    return [m[1], Number.parseInt(m[2], 10), m[3]];
  };
  const [sa, na, xa] = splitId(idA);
  const [sb, nb, xb] = splitId(idB);
  if (sa !== sb) return sa.localeCompare(sb);
  if (na !== nb) return na - nb;
  return xa.localeCompare(xb);
}

function getCardTypeRank(card) {
  const t = String(card?.types?.[0] || '').toLowerCase();
  return Object.hasOwn(TYPE_SORT_ORDER, t) ? TYPE_SORT_ORDER[t] : 99;
}

function buildPokemonByNameMap(cardsById) {
  const byName = new Map();
  if (!cardsById) return byName;
  const iter = typeof cardsById.values === 'function' ? cardsById.values() : [];
  for (const card of iter) {
    if (!card || card.type !== 'pokemon') continue;
    for (const raw of [card.nameEn, card.limitName]) {
      const k = normEvoKey(raw);
      if (!k) continue;
      if (!byName.has(k) || compareCardIds(card.id, byName.get(k).id) < 0) {
        byName.set(k, card);
      }
    }
  }
  return byName;
}

function resolveFamilyKey(card, pkByName) {
  if (!card || card.type !== 'pokemon') return '';
  let cur = card;
  let curKey = normEvoKey(cur.nameEn || cur.limitName || cur.name || cur.id);
  const seen = new Set();
  for (let hop = 0; hop < 4; hop++) {
    const parentRaw = cur?.evolvesFrom;
    if (!parentRaw) break;
    const pKey = normEvoKey(parentRaw);
    if (!pKey || seen.has(pKey)) break;
    seen.add(pKey);
    curKey = pKey;
    const parentCard = pkByName.get(pKey);
    if (!parentCard) break;
    cur = parentCard;
  }
  return curKey;
}

// 依 PTCG Pocket 牌組預設順序整理：寶可夢（屬性輪 → 進化鏈 基礎/1階/2階）→ 訓練家（物品 → 化石 → 道具 → 支援者 → 競技場）
export function sortDeckEntriesPtcgpDefault(entries, cardsById) {
  const list = (entries || []).filter((x) => x && x.id && x.count > 0).map((x) => ({ ...x }));
  if (list.length <= 1) return list;

  const getCard = (id) => (cardsById?.get ? cardsById.get(id) : null);
  const pkByName = buildPokemonByNameMap(cardsById);

  const familyStats = new Map();
  const entryMeta = list.map((entry) => {
    const card = getCard(entry.id);
    if (!card || card.type !== 'pokemon') return { entry, card, famKey: '' };
    const famKey = resolveFamilyKey(card, pkByName);
    const tRank = getCardTypeRank(card);
    const cur = familyStats.get(famKey) || { minTypeRank: 99, minBasicId: '', minAnyId: '' };
    if (tRank < cur.minTypeRank) cur.minTypeRank = tRank;
    if (!cur.minAnyId || compareCardIds(card.id, cur.minAnyId) < 0) cur.minAnyId = card.id;
    if (card.stage === 'basic' && (!cur.minBasicId || compareCardIds(card.id, cur.minBasicId) < 0)) {
      cur.minBasicId = card.id;
    }
    familyStats.set(famKey, cur);
    return { entry, card, famKey };
  });

  entryMeta.sort((a, b) => {
    const ca = a.card;
    const cb = b.card;
    const ma = ca ? (ca.type === 'trainer' ? 1 : 0) : 2;
    const mb = cb ? (cb.type === 'trainer' ? 1 : 0) : 2;
    if (ma !== mb) return ma - mb;

    if (ma === 0) {
      const fa = familyStats.get(a.famKey);
      const fb = familyStats.get(b.famKey);
      if (fa.minTypeRank !== fb.minTypeRank) return fa.minTypeRank - fb.minTypeRank;
      if (a.famKey !== b.famKey) {
        const ra = fa.minBasicId || fa.minAnyId;
        const rb = fb.minBasicId || fb.minAnyId;
        const cmpId = compareCardIds(ra, rb);
        if (cmpId !== 0) return cmpId;
        return a.famKey.localeCompare(b.famKey);
      }
      const sa = STAGE_ORDER[ca.stage] ?? 9;
      const sb = STAGE_ORDER[cb.stage] ?? 9;
      if (sa !== sb) return sa - sb;
      const ta = getCardTypeRank(ca);
      const tb = getCardTypeRank(cb);
      if (ta !== tb) return ta - tb;
      return compareCardIds(ca.id, cb.id);
    }

    if (ma === 1) {
      const subA = TRAINER_SORT_ORDER[String(ca.subtype || '').toLowerCase()] ?? 9;
      const subB = TRAINER_SORT_ORDER[String(cb.subtype || '').toLowerCase()] ?? 9;
      if (subA !== subB) return subA - subB;
      return compareCardIds(ca.id, cb.id);
    }

    return compareCardIds(a.entry.id, b.entry.id);
  });

  return entryMeta.map((x) => x.entry);
}

// 嚴格保留 deck.cards 目前的排列順序（自訂排序或預先套用過預設排序後的陣列）
export function expandDeckCards(deck, cardsById) {
  const list = [];
  for (const entry of deck?.cards || []) {
    if (!entry || !entry.id || entry.count <= 0) continue;
    const card = cardsById?.get ? cardsById.get(entry.id) : null;
    for (let i = 0; i < entry.count; i++) {
      list.push({ id: entry.id, card });
    }
  }
  return list;
}

export function renderDeckShowcase(deck, cardsById, opts = {}) {
  const expanded = expandDeckCards(deck, cardsById);
  const total = expanded.length;
  const emptyCount = Math.max(0, 20 - total);
  const hiRes = Boolean(opts.hiRes);
  const pkCount = expanded.filter((x) => x.card?.type === 'pokemon').length;
  const trCount = expanded.filter((x) => x.card?.type === 'trainer').length;
  const tokens = (deck?.energy || []).map((e) => renderEnergyToken(e, 'md')).join('');
  const featuredList = opts.featuredPokemon || resolveFeaturedPokemon(deck, cardsById, opts.spriteMap || null);
  const spritesHtml = renderPokemonSprites(featuredList, 'md');

  const trackMissing = Boolean(opts.collection && opts.showMissing !== false);
  const ownership = trackMissing ? evaluateDeckOwnership(deck, opts.collection, cardsById) : null;
  const slotMissList = [];
  if (ownership) {
    for (const e of ownership.byEntryIndex) {
      for (let i = 0; i < e.count; i++) {
        slotMissList.push(i >= e.ownedForSlot ? (e.ownedForSlot === 0 ? '未持有' : '缺卡') : '');
      }
    }
  }

  const cardsHtml = expanded.map((item, idx) => {
    const card = item.card;
    if (!card) {
      return `<div class="showcase-card is-missing" title="${esc(item.id)}">
        <span class="showcase-idx">${idx + 1}</span>
        <span class="showcase-miss-id">${esc(item.id)}</span>
        <small>卡庫缺失</small>
      </div>`;
    }
    const types = cardPrimaryTypes(card);
    const t1 = types[0];
    const t2 = types[1] || null;
    const foil = isFoilCard(card);
    const crown = isCrownCard(card);
    const missLabel = slotMissList[idx] || '';
    const cls = [
      'showcase-card',
      'card-face',
      t2 ? 'is-dual' : '',
      foil ? 'is-foil' : '',
      crown ? 'is-crown' : '',
      missLabel ? 'is-slot-missing' : ''
    ].filter(Boolean).join(' ');
    const styleVars = `--c1:${t1.color};--c1-deep:${t1.deep};--c2:${t2 ? t2.color : t1.color};--c2-deep:${t2 ? t2.deep : t1.deep}`;
    return `<button class="${cls}" type="button" style="${styleVars}" data-action="inspect-card" data-id="${esc(card.id)}" aria-label="${esc(card.name)} (${esc(card.id)})">
      <span class="showcase-media">
        ${missLabel ? `<span class="cf-own-tag is-missing">${esc(missLabel)}</span>` : ''}
        <span class="cf-fallback" aria-hidden="true">
          <span class="cf-fb-name">${esc(card.name)}</span>
          <span class="cf-fb-id">${esc(card.id)}</span>
        </span>
        ${renderCardImgTag(card, 'cf-img', hiRes)}
      </span>
      <span class="showcase-foot">
        <span class="showcase-cname">${esc(card.name)}</span>
        <span class="showcase-cid">${esc(card.id)}</span>
      </span>
    </button>`;
  }).join('');

  const emptyHtml = Array.from({ length: emptyCount }, (_, i) =>
    `<div class="showcase-empty" aria-label="空卡位 ${total + i + 1}"><span>${total + i + 1}</span></div>`
  ).join('');

  const ownSummary = ownership && total > 0
    ? (ownership.totalMissing > 0 ? ` · 缺 ${ownership.totalMissing} 張` : ' · 已齊全')
    : '';

  return `
    <div class="showcase-board ${opts.immersive ? 'is-immersive' : ''}">
      <div class="showcase-plaque">
        <div class="showcase-title-wrap">
          <div class="showcase-title-row">
            ${spritesHtml}
            <strong class="showcase-title">${esc(deck?.name || '未命名牌組')}</strong>
          </div>
          <span class="showcase-meta">${total}/20 張（寶可夢 ${pkCount} · 訓練家 ${trCount}${ownSummary}）</span>
        </div>
        <div class="showcase-plaque-right">
          <span class="tokens-inline">${tokens}</span>
          ${opts.valid ? '<span class="showcase-badge is-ok">標準合法</span>' : (total < 20 ? `<span class="showcase-badge">缺 ${20 - total} 張</span>` : '')}
        </div>
      </div>
      <div class="showcase-grid" role="list" aria-label="20 張牌組陳列牆">
        ${cardsHtml}
        ${emptyHtml}
      </div>
      <div class="showcase-stamp">Pocket Lab</div>
    </div>
  `;
}

export function bindFoilEffects(root) {
  if (!root || root.dataset.foilBound) return;
  root.dataset.foilBound = '1';
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  let active = null;
  root.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card-face.is-foil');
    if (active && active !== card) {
      active.style.removeProperty('--mx');
      active.style.removeProperty('--my');
    }
    if (!card) {
      active = null;
      return;
    }
    active = card;
    const rect = card.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    card.style.setProperty('--mx', x.toFixed(1) + '%');
    card.style.setProperty('--my', y.toFixed(1) + '%');
  });
  root.addEventListener('pointerleave', () => {
    if (active) {
      active.style.removeProperty('--mx');
      active.style.removeProperty('--my');
      active = null;
    }
  });
}

export function bindCardImageFallback(root) {
  if (!root || root.dataset?.imgFallbackBound) return;
  if (root.dataset) root.dataset.imgFallbackBound = '1';

  root.addEventListener('load', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    img.classList.add('is-loaded');
    img.parentElement?.classList.add('has-loaded');
  }, true);

  root.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.classList.contains('poke-sprite') || img.classList.contains('energy-img')) {
      img.hidden = true;
      if (img.parentElement) img.parentElement.hidden = true;
      return;
    }
    const queue = (img.dataset.fallbacks || '').split('|').filter(Boolean);
    if (queue.length > 0) {
      const next = queue.shift();
      img.dataset.fallbacks = queue.join('|');
      img.src = next;
    } else {
      img.hidden = true;
      img.parentElement?.classList.add('is-img-failed');
    }
  }, true);
}
