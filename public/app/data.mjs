import { sortDeckEntriesPtcgpDefault } from './cardface.mjs';
import {
  consumeOAuthHashIfPresent,
  ensureValidSession,
  fetchRemoteVault,
  isCloudConfigured,
  mergeVaultSnapshots,
  pushRemoteVault
} from './cloud.mjs';
import { getPokemonCategories, getPokemonCategorySearchTerms, normalizeFeaturedPokemon, normalizeSearch, readDeckFile } from './core.mjs';
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
  collectionUpdatedAt: '',
  deletedDeckIds: {},
  showMissingBadges: true,
  draft: null,
  selectedDeckId: null,
  featuredDeckId: null,
  runs: [],
  lastCheckedAt: null,
  engineReady: false,
  engineError: '',
  runtimeFn: null,
  fastSimFn: null,
  fastSimModule: null,
  fastSimReady: false,
  modelInfo: null,
  modelManifest: null,
  modelsById: new Map(),
  cardPriors: null,
  strategyIndex: null,
  strategyLexicon: null,
  coverageMap: null,
  cloudSession: null,
  lastSyncedUserId: null,
  cloudSyncState: 'idle',
  cloudSyncMessage: '',
  cloudSyncAt: ''
};

let cloudSyncListener = null;
let cloudSyncTimer = null;

export function setCloudSyncListener(fn) {
  cloudSyncListener = typeof fn === 'function' ? fn : null;
}

function notifyCloudStatus() {
  if (cloudSyncListener) cloudSyncListener();
}

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
    const cats = getPokemonCategories(c);
    c._pokeCats = cats;
    const catTerms = cats.map((id) => getPokemonCategorySearchTerms(id)).join(' ');
    c._search = normalizeSearch(
      `${c.id} ${c.name} ${c.nameEn || ''} ${c.set || ''} ${c.setName || ''} ${moveText} ${abText} ${c.effect || ''} ${catTerms}`,
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

  const [fold, metaTop, cardsData, catalogData, modelManifestData, fallbackModelData, cardPriorsData, strategyIndexData, spritesData] = await Promise.all([
    Object.keys(state.foldMap).length
      ? Promise.resolve(state.foldMap)
      : fetchJsonOptional('assets/han-fold.json').catch(() => ({})),
    fetchJsonOptional('data/meta.top.json', forceRefresh)
      .then((d) => d || fetchJsonOptional('data/meta.json', forceRefresh))
      .catch(() => null),
    fetchJsonOptional('data/cards.json', forceRefresh).catch(() => null),
    fetchJsonOptional('data/catalog.json', forceRefresh).catch(() => null),
    fetchJsonOptional('battle/models/manifest.json', forceRefresh).catch(() => null),
    fetchJsonOptional('battle/models/current.json', forceRefresh)
      .then((d) => d || fetchJsonOptional('battle/models/baseline-v0.json', forceRefresh))
      .catch(() => null),
    fetchJsonOptional('battle/models/card-priors.json', forceRefresh).catch(() => null),
    fetchJsonOptional('battle/strategies/index.json', forceRefresh).catch(() => null),
    fetchJsonOptional('data/sprites.json', forceRefresh).catch(() => null)
  ]);

  state.foldMap = fold || {};
  state.spriteMap = spritesData?.byNameEn || {};
  state.cardPriors = cardPriorsData || null;
  state.strategyIndex = strategyIndexData || null;
  state.lastCheckedAt = new Date().toISOString();

  if (metaTop) {
    state.meta = metaTop;
    state.metaFullLoaded = !metaTop.truncated;
  }

  state.modelManifest = modelManifestData || null;
  state.modelsById = new Map();
  if (modelManifestData?.models?.length) {
    const loadedModels = await Promise.all(
      modelManifestData.models.map(async (entry) => {
        const data = await fetchJsonOptional(entry.file, forceRefresh).catch(() => null);
        return data ? [entry.id, { ...data, metaEntry: entry }] : null;
      })
    );
    for (const pair of loadedModels) {
      if (pair) state.modelsById.set(pair[0], pair[1]);
    }
  }
  const defaultId = modelManifestData?.defaultModelId || 'v3';
  state.modelInfo = state.modelsById.get(defaultId) || fallbackModelData || null;
  if (state.modelInfo && !state.modelsById.has(defaultId)) {
    state.modelsById.set(defaultId, state.modelInfo);
  }

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

let strategyLexiconPromise = null;
export async function ensureStrategyLexicon() {
  if (state.strategyLexicon) return state.strategyLexicon;
  if (!strategyLexiconPromise) {
    strategyLexiconPromise = fetchJsonOptional('battle/strategies/lexicon.json')
      .then((doc) => {
        if (doc) state.strategyLexicon = doc;
        return state.strategyLexicon;
      })
      .catch(() => null)
      .finally(() => { strategyLexiconPromise = null; });
  }
  return strategyLexiconPromise;
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
    const [decks, draftSaved, colSaved, runs, featuredId, cloudMetaSaved, showMissSaved] = await Promise.all([
      all('decks'),
      get('settings', 'draftDeck'),
      get('collection', 'owned'),
      all('runs'),
      get('settings', 'featuredDeckId'),
      get('settings', 'cloudMeta'),
      get('settings', 'showMissingBadges')
    ]);
    state.decks = (decks || []).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    state.collection = colSaved || {};
    state.runs = (runs || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    state.featuredDeckId = featuredId || null;
    state.deletedDeckIds = cloudMetaSaved?.deletedDeckIds || {};
    state.collectionUpdatedAt = cloudMetaSaved?.collectionUpdatedAt || '';
    state.lastSyncedUserId = cloudMetaSaved?.lastSyncedUserId || null;
    state.cloudSyncAt = cloudMetaSaved?.cloudSyncAt || '';
    if (typeof showMissSaved === 'boolean') state.showMissingBadges = showMissSaved;

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

async function persistCloudMeta() {
  try {
    await put('settings', 'cloudMeta', {
      deletedDeckIds: state.deletedDeckIds,
      collectionUpdatedAt: state.collectionUpdatedAt,
      lastSyncedUserId: state.lastSyncedUserId,
      cloudSyncAt: state.cloudSyncAt
    });
  } catch {}
}

export function buildLocalVaultSnapshot() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    decks: structuredClone(state.decks || []),
    deletedDeckIds: { ...(state.deletedDeckIds || {}) },
    collection: { ...(state.collection || {}) },
    collectionUpdatedAt: state.collectionUpdatedAt || '',
    draft: structuredClone(state.draft || null),
    featuredDeckId: state.featuredDeckId || null
  };
}

export async function applyVaultToLocalStore(vault, userId = null) {
  const nextDecks = Array.isArray(vault?.decks) ? structuredClone(vault.decks) : [];
  if (!state.cardsMissing) {
    for (const d of nextDecks) {
      if (!d.customOrder && Array.isArray(d.cards) && d.cards.length > 1) {
        d.cards = sortDeckEntriesPtcgpDefault(d.cards, state.cardsById);
        d.customOrder = true;
      }
    }
  }

  const prevDecks = await all('decks').catch(() => []);
  const nextIds = new Set(nextDecks.map((d) => d.id));
  for (const old of prevDecks) {
    if (!nextIds.has(old.id)) {
      try { await remove('decks', old.id); } catch {}
    }
  }
  for (const d of nextDecks) {
    try { await put('decks', d.id, d); } catch {}
  }

  state.decks = nextDecks.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  state.collection = { ...(vault?.collection || {}) };
  state.collectionUpdatedAt = vault?.collectionUpdatedAt || new Date().toISOString();
  state.deletedDeckIds = { ...(vault?.deletedDeckIds || {}) };
  state.featuredDeckId = vault?.featuredDeckId || null;
  if (vault?.draft && Array.isArray(vault.draft.cards)) {
    state.draft = structuredClone(vault.draft);
    try { await put('settings', 'draftDeck', state.draft); } catch {}
  }
  if (!nextIds.has(state.selectedDeckId)) {
    state.selectedDeckId = state.decks[0]?.id || null;
  }
  if (userId) state.lastSyncedUserId = userId;

  try {
    await Promise.all([
      put('collection', 'owned', state.collection),
      put('settings', 'featuredDeckId', state.featuredDeckId),
      persistCloudMeta()
    ]);
  } catch {}
}

export async function initCloudSessionAndSync() {
  if (!isCloudConfigured()) return null;
  const oauthSession = await consumeOAuthHashIfPresent();
  const session = oauthSession || await ensureValidSession();
  state.cloudSession = session;
  notifyCloudStatus();
  if (session) {
    await syncWithCloud('merge');
  }
  return session;
}

export async function syncWithCloud(mode = 'merge') {
  if (!isCloudConfigured()) {
    state.cloudSyncState = 'unconfigured';
    return null;
  }
  const session = await ensureValidSession();
  state.cloudSession = session;
  if (!session) {
    state.cloudSyncState = 'idle';
    notifyCloudStatus();
    return null;
  }

  state.cloudSyncState = 'syncing';
  state.cloudSyncMessage = '雲端同步中…';
  notifyCloudStatus();

  try {
    const local = buildLocalVaultSnapshot();
    let finalVault = local;
    if (mode === 'push') {
      finalVault = await pushRemoteVault(session, local);
      state.lastSyncedUserId = session.user.id;
    } else {
      const remote = await fetchRemoteVault(session);
      if (mode === 'pull') {
        if (remote) {
          await applyVaultToLocalStore(remote, session.user.id);
          finalVault = remote;
        }
      } else if (remote) {
        const merged = mergeVaultSnapshots(local, remote, {
          sameUser: state.lastSyncedUserId === session.user.id
        });
        await applyVaultToLocalStore(merged, session.user.id);
        finalVault = await pushRemoteVault(session, merged);
      } else {
        finalVault = await pushRemoteVault(session, local);
        state.lastSyncedUserId = session.user.id;
      }
    }
    state.cloudSyncState = 'synced';
    state.cloudSyncAt = finalVault?.updatedAt || new Date().toISOString();
    state.cloudSyncMessage = '已同步雲端';
    await persistCloudMeta();
    notifyCloudStatus();
    return finalVault;
  } catch (err) {
    state.cloudSyncState = 'error';
    state.cloudSyncMessage = err?.message || '雲端同步失敗';
    notifyCloudStatus();
    throw err;
  }
}

export function scheduleCloudSync() {
  if (!state.cloudSession || !isCloudConfigured()) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    syncWithCloud('push').catch(() => {});
  }, 1200);
}

export async function saveDraft(draft) {
  draft.updatedAt = new Date().toISOString();
  state.draft = draft;
  try { await put('settings', 'draftDeck', draft); } catch {}
  scheduleCloudSync();
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
  if (state.deletedDeckIds?.[clean.id]) {
    delete state.deletedDeckIds[clean.id];
    await persistCloudMeta();
  }
  await put('decks', clean.id, clean);
  const idx = state.decks.findIndex((d) => d.id === clean.id);
  if (idx >= 0) state.decks[idx] = clean;
  else state.decks.unshift(clean);
  state.selectedDeckId = clean.id;
  scheduleCloudSync();
  return clean;
}

export async function deleteDeck(id) {
  await remove('decks', id);
  state.decks = state.decks.filter((d) => d.id !== id);
  state.deletedDeckIds[id] = new Date().toISOString();
  await persistCloudMeta();
  if (state.selectedDeckId === id) {
    state.selectedDeckId = state.decks[0]?.id || null;
  }
  if (state.featuredDeckId === id) {
    await setFeaturedDeck(state.decks[0]?.id || null);
  }
  scheduleCloudSync();
}

export async function setFeaturedDeck(id) {
  state.featuredDeckId = id || null;
  try { await put('settings', 'featuredDeckId', state.featuredDeckId); } catch {}
  scheduleCloudSync();
}

export async function setShowMissingBadges(enabled) {
  state.showMissingBadges = Boolean(enabled);
  try { await put('settings', 'showMissingBadges', state.showMissingBadges); } catch {}
}

export async function setOwnedCount(cardId, count) {
  const n = Math.max(0, Math.min(99, Number(count) || 0));
  if (n === 0) delete state.collection[cardId];
  else state.collection[cardId] = n;
  state.collectionUpdatedAt = new Date().toISOString();
  try {
    await put('collection', 'owned', state.collection);
    await persistCloudMeta();
  } catch {}
  scheduleCloudSync();
}

export async function setOwnedBatch(updates) {
  for (const [cardId, count] of updates) {
    const n = Math.max(0, Math.min(99, Number(count) || 0));
    if (n === 0) delete state.collection[cardId];
    else state.collection[cardId] = n;
  }
  state.collectionUpdatedAt = new Date().toISOString();
  try {
    await put('collection', 'owned', state.collection);
    await persistCloudMeta();
  } catch {}
  scheduleCloudSync();
}

export function exportFullBackupJson() {
  return JSON.stringify({
    pocketLabBackup: 1,
    exportedAt: new Date().toISOString(),
    ...buildLocalVaultSnapshot()
  }, null, 2);
}

export async function importBackupJson(text) {
  if (text.length > 2_000_000) throw Error('備份檔案過大');
  let obj;
  try { obj = JSON.parse(text); } catch { throw Error('JSON 格式無效'); }
  if (obj && (Array.isArray(obj.decks) || (obj.collection && typeof obj.collection === 'object'))) {
    const cleanCol = {};
    for (const [k, v] of Object.entries(obj.collection || {})) {
      const n = Number(v);
      if (typeof k === 'string' && /^[A-Z0-9a-z-]{1,22}$/.test(k) && Number.isInteger(n) && n > 0 && n <= 99) {
        cleanCol[k] = n;
      }
    }
    const importedDecks = [];
    for (const d of obj.decks || []) {
      const parsed = readDeckFile(JSON.stringify(d));
      importedDecks.push({ ...parsed, id: d.id || crypto.randomUUID(), updatedAt: d.updatedAt || new Date().toISOString() });
    }
    const merged = mergeVaultSnapshots(buildLocalVaultSnapshot(), {
      decks: importedDecks,
      collection: cleanCol,
      collectionUpdatedAt: new Date().toISOString(),
      featuredDeckId: obj.featuredDeckId || null
    });
    await applyVaultToLocalStore(merged, state.cloudSession?.user?.id || null);
    scheduleCloudSync();
    return { mode: 'backup', deckCount: importedDecks.length, colCount: Object.keys(cleanCol).length };
  }
  const parsed = readDeckFile(text);
  const saved = await saveDeck({ id: crypto.randomUUID(), ...parsed });
  return { mode: 'deck', saved };
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
