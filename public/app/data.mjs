import { sortDeckEntriesPtcgpDefault } from './cardface.mjs';
import { normalizeFeaturedPokemon, normalizeSearch } from './core.mjs';
import { all, get, put, remove } from './storage.mjs';

export const isFixtureMode = () => new URLSearchParams(location.search).get('fixture') === '1';

export const state = {
  fixture: isFixtureMode(),
  meta: null,
  metaFullLoaded: false,
  cards: [],
  cardsById: new Map(),
  cardsMissing: false,
  catalog: null,
  foldMap: {},
  spriteMap: {},
  decks: [],
  collection: {},
  draft: null,
  selectedDeckId: null,
  featuredDeckId: null,
  runs: [],
  lastCheckedAt: null,
  engineReady: false,
  engineError: '',
  runtimeFn: null,
  modelInfo: null
};

async function fetchJsonOptional(url, noStore = false) {
  const res = await fetch(url, noStore ? { cache: 'no-store' } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw Error(`載入 ${url} 失敗 (${res.status})`);
  return res.json();
}

function indexCards(cards, foldMap) {
  for (const c of cards) {
    const moveText = (c.attacks || []).map((a) => `${a.name || ''} ${a.effect || ''}`).join(' ');
    const abText = (c.abilities || []).map((a) => `${a.name || ''} ${a.effect || ''}`).join(' ');
    c._search = normalizeSearch(
      `${c.id} ${c.name} ${c.nameEn || ''} ${c.set || ''} ${c.setName || ''} ${moveText} ${abText} ${c.effect || ''}`,
      foldMap
    );
  }
}

function indexMetaEntries(meta, foldMap) {
  for (const e of meta?.entries || []) {
    e._search = normalizeSearch(`${e.name || ''} ${e.nameEn || ''} ${e.id || ''}`, foldMap);
  }
}

export async function loadInitialData(forceRefresh = false) {
  const prevHash = state.meta?.hash;

  const [fold, metaTop, cardsData, catalogData, modelData, spritesData] = await Promise.all([
    Object.keys(state.foldMap).length
      ? Promise.resolve(state.foldMap)
      : fetchJsonOptional('assets/han-fold.json').catch(() => ({})),
    fetchJsonOptional('data/meta.top.json', forceRefresh)
      .then((d) => d || fetchJsonOptional('data/meta.json', forceRefresh))
      .catch(() => null),
    fetchJsonOptional('data/cards.json', forceRefresh).catch(() => null),
    fetchJsonOptional('data/catalog.json', forceRefresh).catch(() => null),
    fetchJsonOptional('battle/models/current.json', forceRefresh)
      .then((d) => d || fetchJsonOptional('battle/models/baseline-v0.json', forceRefresh))
      .catch(() => null),
    fetchJsonOptional('data/sprites.json', forceRefresh).catch(() => null)
  ]);

  state.foldMap = fold || {};
  state.spriteMap = spritesData?.byNameEn || {};
  state.lastCheckedAt = new Date().toISOString();

  if (metaTop) {
    state.meta = metaTop;
    state.metaFullLoaded = !metaTop.truncated;
  }
  state.modelInfo = modelData;

  if (Array.isArray(cardsData) && cardsData.length > 0) {
    state.cards = cardsData;
    state.catalog = catalogData;
    state.cardsMissing = false;
  } else if (state.fixture) {
    const fx = await import('./fixture.mjs');
    state.cards = structuredClone(fx.FIXTURE_CARDS);
    state.catalog = fx.FIXTURE_CATALOG;
    state.cardsMissing = false;
  } else {
    state.cards = [];
    state.catalog = catalogData;
    state.cardsMissing = true;
  }

  indexCards(state.cards, state.foldMap);
  state.cardsById = new Map(state.cards.map((c) => [c.id, c]));
  indexMetaEntries(state.meta, state.foldMap);

  await loadLocalStore();

  // 既有舊資料若尚未寫入固定排序，依 PTCG Pocket 預設順序整理一次並鎖定
  if (!state.cardsMissing) {
    for (const d of state.decks) {
      let changed = false;
      if (typeof d.name === 'string' && d.name.includes('(赛事代表)')) {
        d.name = d.name.replace('(赛事代表)', '(賽事代表)');
        changed = true;
      }
      if (!d.customOrder && Array.isArray(d.cards) && d.cards.length > 1) {
        d.cards = sortDeckEntriesPtcgpDefault(d.cards, state.cardsById);
        d.customOrder = true;
        changed = true;
      }
      if (changed) {
        try { await put('decks', d.id, d); } catch {}
      }
    }
    if (state.draft && !state.draft.customOrder && Array.isArray(state.draft.cards) && state.draft.cards.length > 1) {
      state.draft.cards = sortDeckEntriesPtcgpDefault(state.draft.cards, state.cardsById);
    }
  }
  return { changed: Boolean(prevHash && state.meta?.hash && prevHash !== state.meta.hash) };
}

export async function ensureFullMeta() {
  if (state.metaFullLoaded && state.meta && !state.meta.truncated) return state.meta;
  const full = await fetchJsonOptional('data/meta.json', false);
  if (full) {
    indexMetaEntries(full, state.foldMap);
    state.meta = full;
    state.metaFullLoaded = true;
  }
  return state.meta;
}

export async function loadLocalStore() {
  try {
    const [decks, draftSaved, colSaved, runs, featuredId] = await Promise.all([
      all('decks'),
      get('settings', 'draftDeck'),
      get('collection', 'owned'),
      all('runs'),
      get('settings', 'featuredDeckId')
    ]);
    state.decks = (decks || []).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    state.collection = colSaved || {};
    state.runs = (runs || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    state.featuredDeckId = featuredId || null;

    if (state.fixture && state.decks.length === 0) {
      const fx = await import('./fixture.mjs');
      state.decks = [structuredClone(fx.FIXTURE_SAMPLE_DECK)];
    }

    if (draftSaved && Array.isArray(draftSaved.cards)) {
      state.draft = draftSaved;
    } else if (state.decks.length > 0) {
      state.draft = structuredClone(state.decks[0]);
    } else {
      state.draft = { id: crypto.randomUUID(), name: '未命名牌組', cards: [], energy: [], customOrder: false, updatedAt: new Date().toISOString() };
    }
    if (!state.selectedDeckId && state.decks.length > 0) {
      state.selectedDeckId = state.decks[0].id;
    }
  } catch (err) {
    console.warn('IndexedDB unavailable:', err);
    if (!state.draft) {
      state.draft = { id: crypto.randomUUID(), name: '未命名牌組', cards: [], energy: [], customOrder: false, updatedAt: new Date().toISOString() };
    }
  }
}

export async function saveDraft(draft) {
  draft.updatedAt = new Date().toISOString();
  state.draft = draft;
  try { await put('settings', 'draftDeck', draft); } catch {}
}

export async function saveDeck(deck) {
  const clean = {
    id: deck.id || crypto.randomUUID(),
    name: (deck.name || '未命名牌組').trim().slice(0, 150),
    cards: (deck.cards || []).filter((x) => x.count > 0).map((x) => ({ id: x.id, count: x.count })),
    energy: [...(deck.energy || [])].slice(0, 3),
    featuredPokemon: normalizeFeaturedPokemon(deck.featuredPokemon),
    customOrder: Boolean(deck.customOrder),
    updatedAt: new Date().toISOString()
  };
  await put('decks', clean.id, clean);
  const idx = state.decks.findIndex((d) => d.id === clean.id);
  if (idx >= 0) state.decks[idx] = clean;
  else state.decks.unshift(clean);
  state.selectedDeckId = clean.id;
  return clean;
}

export async function deleteDeck(id) {
  await remove('decks', id);
  state.decks = state.decks.filter((d) => d.id !== id);
  if (state.selectedDeckId === id) {
    state.selectedDeckId = state.decks[0]?.id || null;
  }
  if (state.featuredDeckId === id) {
    await setFeaturedDeck(state.decks[0]?.id || null);
  }
}

export async function setFeaturedDeck(id) {
  state.featuredDeckId = id || null;
  try { await put('settings', 'featuredDeckId', state.featuredDeckId); } catch {}
}

export async function setOwnedCount(cardId, count) {
  const n = Math.max(0, Math.min(99, Number(count) || 0));
  if (n === 0) delete state.collection[cardId];
  else state.collection[cardId] = n;
  try { await put('collection', 'owned', state.collection); } catch {}
}

export async function saveRunRecord(run) {
  await put('runs', run.runId, run);
  const idx = state.runs.findIndex((r) => r.runId === run.runId);
  if (idx >= 0) state.runs[idx] = run;
  else state.runs.unshift(run);
}

export function foldText(text) {
  return normalizeSearch(text, state.foldMap);
}

export function freshnessStatus() {
  const ts = state.meta?.asOf;
  if (!ts) return { level: 'warn', label: '無賽事資料', detail: '尚未載入快照' };
  const diffHours = (Date.now() - Date.parse(ts)) / 3600000;
  let rel = '';
  if (diffHours < 1) rel = `${Math.max(1, Math.round(diffHours * 60))} 分鐘前`;
  else if (diffHours < 48) rel = `${Math.round(diffHours)} 小時前`;
  else rel = `${Math.round(diffHours / 24)} 天前`;

  const level = diffHours < 6 ? 'fresh' : diffHours < 24 ? 'warn' : 'stale';
  return {
    level,
    label: `賽事 · ${rel}`,
    detail: `最近成功同步：${new Date(ts).toLocaleString('zh-TW')}；最近檢查：${state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleTimeString('zh-TW') : '剛剛'}`
  };
}

export function findVariantsForCard(card) {
  if (!card) return [];
  const key = card.limitName || card.nameEn || card.name;
  return state.cards.filter((c) => (c.limitName || c.nameEn || c.name) === key && c.id !== card.id);
}
