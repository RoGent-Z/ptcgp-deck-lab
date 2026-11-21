import { normalizeFeaturedPokemon, titleCase } from './core.mjs';
import {
  bindCardImageFallback,
  bindFoilEffects,
  esc,
  resolveFeaturedPokemon,
  sortDeckEntriesPtcgpDefault
} from './cardface.mjs';
import {
  saveCloudOverride,
  signInAccount,
  signOutAccount,
  signUpAccount,
  startGoogleSignIn
} from './cloud.mjs';
import {
  deleteDeck,
  ensureFullMeta,
  exportFullBackupJson,
  freshnessStatus,
  importBackupJson,
  initCloudSessionAndSync,
  loadInitialData,
  saveDeck,
  saveDraft,
  saveRunRecord,
  setCloudSyncListener,
  setFeaturedDeck,
  setOwnedBatch,
  setOwnedCount,
  setShowMissingBadges,
  state,
  syncWithCloud
} from './data.mjs';
import { icon } from './icons.mjs';
import {
  ensureCardCoverage,
  executeBattleBatch,
  executeFixturePreviewBatch,
  fnv1a32,
  probeEngine,
  renderBattleReport,
  resolveOpponentLineup
} from './battle.mjs';
import {
  buildAccountModal,
  buildCardDetailModal,
  buildCatalogAuditModal,
  buildCollectionToolsModal,
  buildDeckShowcaseModal,
  buildMetaDetailModal,
  filterCatalogCards,
  renderBattle,
  renderCatalog,
  renderCatalogGridHtml,
  renderDecks,
  renderDraftPanel,
  renderHome,
  renderMeta,
  renderPokeTagPopoverBody,
  renderPokeTagTriggerLabel,
  renderSources,
  uiState
} from './views.mjs';

function syncAllPickerPopovers() {
  const f = uiState.catalog;
  const trigger = document.getElementById('poke-tag-trigger');
  const label = document.getElementById('poke-tag-trigger-text');
  const pop = document.getElementById('poke-tag-popover');
  const active = Boolean(f.pokeInclude.length || f.pokeExclude.length);
  if (label) label.textContent = renderPokeTagTriggerLabel(f);
  if (trigger) {
    trigger.setAttribute('aria-expanded', f.pokeTagOpen ? 'true' : 'false');
    trigger.classList.toggle('has-active', active);
    trigger.classList.toggle('select-followup', f.kind === 'pokemon' || active);
  }
  if (pop) {
    pop.hidden = !f.pokeTagOpen;
    if (f.pokeTagOpen) pop.innerHTML = renderPokeTagPopoverBody(f);
  }

  for (const wrap of document.querySelectorAll('.swiss-select-wrap[data-select-wrap]')) {
    const sid = wrap.dataset.selectWrap;
    const open = uiState.openSelect === sid;
    const btn = wrap.querySelector('.swiss-select-btn');
    const panel = wrap.querySelector('.swiss-select-popover');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (panel) panel.hidden = !open;
  }
}

function applySwissSelectValue(selectId, value) {
  if (selectId === 'filter-set') {
    uiState.catalog.set = value;
    uiState.catalog.page = 1;
  } else if (selectId === 'filter-kind') {
    uiState.catalog.kind = value;
    if (value === 'trainer') {
      uiState.catalog.stage = '';
      uiState.catalog.pokeInclude = [];
      uiState.catalog.pokeExclude = [];
      uiState.catalog.pokeTagOpen = false;
      if (uiState.catalog.type && uiState.catalog.type !== 'trainer') uiState.catalog.type = '';
    } else if (value === 'pokemon') {
      if (uiState.catalog.type === 'trainer') uiState.catalog.type = '';
      uiState.catalog.subtype = '';
    } else if (uiState.catalog.type !== 'trainer') {
      uiState.catalog.subtype = '';
    }
    uiState.catalog.page = 1;
  } else if (selectId === 'filter-subtype') {
    uiState.catalog.subtype = value;
    uiState.catalog.page = 1;
  } else if (selectId === 'filter-stage') {
    uiState.catalog.stage = value;
    uiState.catalog.page = 1;
  } else if (selectId === 'filter-rarity') {
    uiState.catalog.rarity = value;
    uiState.catalog.page = 1;
  } else if (selectId === 'filter-owned') {
    uiState.catalog.owned = value;
    uiState.catalog.page = 1;
  } else if (selectId === 'battle-deck-select') {
    uiState.battle.deckId = value;
    uiState.battle.activeRunId = null;
  } else if (selectId === 'battle-model-select') {
    uiState.battle.modelId = value;
    uiState.battle.activeRunId = null;
  }
  uiState.openSelect = null;
  renderRoute();
}

function getSelectedBattleModel() {
  const id = uiState.battle.modelId || state.modelManifest?.defaultModelId || 'v1';
  const model = state.modelsById.get(id) || state.modelInfo;
  return {
    id,
    version: model?.version || 'baseline-v0',
    weights: model?.weights || Array(22).fill(0)
  };
}

function getWeightsForVersion(version) {
  for (const m of state.modelsById.values()) {
    if (m?.version === version && Array.isArray(m.weights)) return m.weights;
  }
  return getSelectedBattleModel().weights;
}

function toggleFeaturedSlugOnDeck(deck, slug) {
  const cur = resolveFeaturedPokemon(deck, state.cardsById, state.spriteMap).map((x) => x.slug);
  if (cur.includes(slug)) {
    if (cur.length <= 1) {
      showNotice('至少保留 1 隻代表寶可夢（點擊恢復自動可重設）');
      return false;
    }
    deck.featuredPokemon = normalizeFeaturedPokemon(cur.filter((s) => s !== slug));
    return true;
  }
  if (cur.length >= 3) {
    showNotice('最多只能選定 3 隻代表寶可夢，請先取消 1 隻');
    return false;
  }
  deck.featuredPokemon = normalizeFeaturedPokemon([...cur, slug]);
  return true;
}

const mainEl = document.getElementById('main');
const noticeEl = document.getElementById('notice');
const dialogEl = document.getElementById('dialog');
const dialogTitleEl = document.getElementById('dialog-title');
const dialogBodyEl = document.getElementById('dialog-body');
const draftDrawerEl = document.getElementById('draft-drawer');
const drawerFabEl = document.getElementById('drawer-fab');
const drawerFabCountEl = document.getElementById('drawer-fab-count');
const importInputEl = document.getElementById('import-file');

let noticeTimer = null;
function showNotice(msg) {
  noticeEl.textContent = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.textContent = ''; }, 3200);
}

function openModal(title, html, opts = {}) {
  dialogEl.classList.toggle('is-wide', Boolean(opts.wide));
  dialogTitleEl.textContent = title;
  dialogBodyEl.innerHTML = html;
  bindFoilEffects(dialogBodyEl);
  if (!dialogEl.open) dialogEl.showModal();
}

function currentRoute() {
  const hash = location.hash.replace(/^#/, '').trim();
  if (['home', 'catalog', 'decks', 'meta', 'battle', 'sources'].includes(hash)) return hash;
  return 'home';
}

function updateChrome(route) {
  document.querySelectorAll('#navigation a, #bottom-nav a').forEach((a) => {
    const r = (a.getAttribute('href') || '').replace(/^#/, '');
    if (r === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const fr = freshnessStatus();
  const frEl = document.getElementById('freshness');
  if (frEl) {
    frEl.dataset.level = fr.level;
    frEl.title = fr.detail;
    const textEl = frEl.querySelector('.freshness-text');
    if (textEl) textEl.textContent = fr.label;
  }

  const accBtn = document.getElementById('account-btn');
  const accTxt = document.getElementById('account-btn-text');
  if (accBtn && accTxt) {
    const user = state.cloudSession?.user;
    if (user) {
      accBtn.dataset.state = state.cloudSyncState === 'error' ? 'error' : state.cloudSyncState === 'syncing' ? 'syncing' : 'online';
      const label = (user.email || user.id || '已登入').split('@')[0];
      accTxt.textContent = state.cloudSyncState === 'syncing' ? '同步中…' : label;
      accBtn.title = `${user.email || user.id} · ${state.cloudSyncMessage || '已登入'}`;
    } else {
      accBtn.dataset.state = 'off';
      accTxt.textContent = '登入 / 註冊';
      accBtn.title = '帳號登入、註冊與雲端同步';
    }
  }

  const totalDraft = (state.draft?.cards || []).reduce((s, c) => s + c.count, 0);
  if (drawerFabCountEl) drawerFabCountEl.textContent = `${totalDraft}/20`;
  if (drawerFabEl) {
    drawerFabEl.hidden = route !== 'catalog';
  }
  if (route !== 'catalog' && draftDrawerEl) {
    draftDrawerEl.hidden = true;
    drawerFabEl?.setAttribute('aria-expanded', 'false');
  }
}

function refreshDraftPanels() {
  const html = renderDraftPanel();
  const sidebar = document.getElementById('draft-sidebar');
  if (sidebar) sidebar.innerHTML = html;
  if (draftDrawerEl && !draftDrawerEl.hidden) draftDrawerEl.innerHTML = html;
  const totalDraft = (state.draft?.cards || []).reduce((s, c) => s + c.count, 0);
  if (drawerFabCountEl) drawerFabCountEl.textContent = `${totalDraft}/20`;
}

function renderRoute(moveFocus = false) {
  const route = currentRoute();
  updateChrome(route);

  let html = '';
  if (route === 'home') html = renderHome();
  else if (route === 'catalog') html = renderCatalog();
  else if (route === 'decks') html = renderDecks();
  else if (route === 'meta') html = renderMeta();
  else if (route === 'battle') html = renderBattle();
  else if (route === 'sources') html = renderSources();

  mainEl.innerHTML = `<div class="route-stage">${html}</div>`;
  bindFoilEffects(mainEl);
  if (moveFocus) mainEl.focus({ preventScroll: true });
}

function populateBottomNav() {
  const items = [
    ['home', '總覽'],
    ['catalog', '圖鑑'],
    ['decks', '牌組'],
    ['meta', '環境'],
    ['battle', '對戰']
  ];
  document.querySelectorAll('#bottom-nav a').forEach((a, idx) => {
    const [key, label] = items[idx] || [];
    if (!key) return;
    a.innerHTML = `${icon(key, 19)}<span>${label}</span>`;
  });
}

function mutateDraftCard(id, delta) {
  const draft = state.draft || { id: crypto.randomUUID(), name: '未命名牌組', cards: [], energy: [], customOrder: false };
  const idx = draft.cards.findIndex((c) => c.id === id);
  if (idx >= 0) {
    draft.cards[idx].count += delta;
    if (draft.cards[idx].count <= 0) draft.cards.splice(idx, 1);
    else if (draft.cards[idx].count > 2 && delta > 0) {
      draft.cards[idx].count = 2;
      showNotice('單卡最多加入 2 張');
    }
  } else if (delta > 0) {
    const total = draft.cards.reduce((s, c) => s + c.count, 0);
    if (total >= 20) {
      showNotice('目前草稿已滿 20 張（仍可先加入再調整）');
    }
    draft.cards.push({ id, count: 1 });
    if (!draft.customOrder && !state.cardsMissing) {
      draft.cards = sortDeckEntriesPtcgpDefault(draft.cards, state.cardsById);
    }
  }
  saveDraft(draft);
  refreshDraftPanels();
  if (currentRoute() === 'catalog') {
    const resEl = document.getElementById('catalog-results');
    if (resEl) resEl.innerHTML = renderCatalogGridHtml();
  }
}

async function handleAction(el) {
  const action = el.dataset.action;
  const id = el.dataset.id;

  if (action === 'inspect-card') {
    const card = state.cardsById.get(id);
    if (!card) { showNotice('卡庫尚未收錄 ' + id); return; }
    openModal(`${card.name} · ${card.id}`, buildCardDetailModal(card));
    return;
  }

  if (action === 'add-card') { mutateDraftCard(id, 1); return; }
  if (action === 'remove-card') { mutateDraftCard(id, -1); return; }

  if (action === 'move-draft-card') {
    const dir = Number(el.dataset.dir || 0);
    const cards = state.draft?.cards;
    if (!Array.isArray(cards) || !dir) return;
    const idx = cards.findIndex((c) => c.id === id);
    const nextIdx = idx + dir;
    if (idx < 0 || nextIdx < 0 || nextIdx >= cards.length) return;
    const [moved] = cards.splice(idx, 1);
    cards.splice(nextIdx, 0, moved);
    state.draft.customOrder = true;
    await saveDraft(state.draft);
    refreshDraftPanels();
    return;
  }

  if (action === 'sort-draft-default') {
    if (!state.draft?.cards?.length) return;
    state.draft.cards = sortDeckEntriesPtcgpDefault(state.draft.cards, state.cardsById);
    state.draft.customOrder = false;
    await saveDraft(state.draft);
    refreshDraftPanels();
    showNotice('已依 PTCG Pocket 預設順序整理');
    return;
  }

  if (action === 'toggle-draft-energy') {
    const en = el.dataset.energy;
    const draft = state.draft;
    const exists = draft.energy.some((e) => titleCase(e) === en);
    if (exists) {
      draft.energy = draft.energy.filter((e) => titleCase(e) !== en);
    } else if (draft.energy.length >= 3) {
      showNotice('最多只能選擇 3 種能量');
      return;
    } else {
      draft.energy.push(en);
    }
    await saveDraft(draft);
    refreshDraftPanels();
    return;
  }

  if (action === 'save-draft') {
    const saved = await saveDeck({ ...state.draft, customOrder: true });
    state.draft = structuredClone(saved);
    await saveDraft(state.draft);
    showNotice(`已儲存牌組「${saved.name}」`);
    return;
  }

  if (action === 'new-draft') {
    await saveDraft({ id: crypto.randomUUID(), name: '未命名牌組', cards: [], energy: [], customOrder: false });
    refreshDraftPanels();
    if (currentRoute() === 'catalog') {
      const resEl = document.getElementById('catalog-results');
      if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    }
    showNotice('已清空草稿');
    return;
  }

  if (action === 'draft-to-battle') {
    const saved = await saveDeck({ ...state.draft, customOrder: true });
    state.draft = structuredClone(saved);
    await saveDraft(state.draft);
    uiState.battle.deckId = saved.id;
    location.hash = '#battle';
    return;
  }

  if (action === 'catalog-type') {
    const nextType = el.dataset.type || '';
    uiState.catalog.type = nextType;
    if (nextType === 'trainer') {
      if (uiState.catalog.kind === 'pokemon') uiState.catalog.kind = '';
      uiState.catalog.stage = '';
      uiState.catalog.pokeInclude = [];
      uiState.catalog.pokeExclude = [];
      uiState.catalog.pokeTagOpen = false;
    } else {
      if (nextType && uiState.catalog.kind === 'trainer') uiState.catalog.kind = '';
      if (uiState.catalog.kind !== 'trainer') uiState.catalog.subtype = '';
    }
    uiState.catalog.page = 1;
    renderRoute();
    return;
  }

  if (action === 'catalog-page') {
    uiState.catalog.page = Number(el.dataset.page || 1);
    const resEl = document.getElementById('catalog-results');
    if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (action === 'toggle-swiss-select') {
    const sid = el.dataset.selectId || '';
    uiState.catalog.pokeTagOpen = false;
    uiState.openSelect = uiState.openSelect === sid ? null : sid;
    syncAllPickerPopovers();
    return;
  }

  if (action === 'close-swiss-select') {
    uiState.openSelect = null;
    uiState.catalog.pokeTagOpen = false;
    syncAllPickerPopovers();
    return;
  }

  if (action === 'pick-swiss-select') {
    const sid = el.dataset.selectId || '';
    const val = el.dataset.value ?? '';
    applySwissSelectValue(sid, val);
    return;
  }

  if (action === 'toggle-poke-popover') {
    uiState.openSelect = null;
    uiState.catalog.pokeTagOpen = !uiState.catalog.pokeTagOpen;
    syncAllPickerPopovers();
    return;
  }

  if (action === 'cycle-poke-tag') {
    const tagId = el.dataset.tag || '';
    if (!tagId) return;
    const f = uiState.catalog;
    const inInc = f.pokeInclude.includes(tagId);
    const inExc = f.pokeExclude.includes(tagId);
    if (!inInc && !inExc) {
      f.pokeInclude = [...f.pokeInclude, tagId];
    } else if (inInc) {
      f.pokeInclude = f.pokeInclude.filter((x) => x !== tagId);
      f.pokeExclude = [...f.pokeExclude, tagId];
    } else {
      f.pokeExclude = f.pokeExclude.filter((x) => x !== tagId);
    }
    f.page = 1;
    syncAllPickerPopovers();
    const resEl = document.getElementById('catalog-results');
    if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    return;
  }

  if (action === 'clear-poke-tags') {
    uiState.catalog.pokeInclude = [];
    uiState.catalog.pokeExclude = [];
    uiState.catalog.page = 1;
    syncAllPickerPopovers();
    const resEl = document.getElementById('catalog-results');
    if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    return;
  }

  if (action === 'reset-catalog-filters') {
    uiState.openSelect = null;
    uiState.catalog = { ...uiState.catalog, q: '', set: '', type: '', kind: '', subtype: '', pokeInclude: [], pokeExclude: [], pokeTagOpen: false, stage: '', rarity: '', owned: '', page: 1 };
    renderRoute();
    return;
  }

  if (action === 'show-catalog-audit') {
    openModal('各系列收錄完備度', buildCatalogAuditModal());
    return;
  }

  if (action === 'open-collection-tools') {
    openModal('收藏批次管理與備份', buildCollectionToolsModal());
    return;
  }

  if (action === 'batch-collection-add1' || action === 'batch-collection-fill2' || action === 'batch-collection-clear') {
    const list = filterCatalogCards();
    const updates = list.map((c) => {
      const cur = Number(state.collection?.[c.id] || 0);
      if (action === 'batch-collection-clear') return [c.id, 0];
      if (action === 'batch-collection-fill2') return [c.id, Math.max(cur, 2)];
      return [c.id, Math.min(99, cur + 1)];
    });
    await setOwnedBatch(updates);
    const resEl = document.getElementById('catalog-results');
    if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    refreshDraftPanels();
    if (dialogEl.open) dialogBodyEl.innerHTML = buildCollectionToolsModal();
    showNotice(`已更新 ${updates.length} 張卡牌持有數量`);
    return;
  }

  if (action === 'toggle-missing-badges') {
    await setShowMissingBadges(!state.showMissingBadges);
    renderRoute();
    refreshDraftPanels();
    showNotice(state.showMissingBadges ? '已開啟未持有／缺卡標記' : '已隱藏未持有／缺卡標記');
    return;
  }

  if (action === 'export-full-backup') {
    await exportJsonFile(`pocket-lab-backup-${new Date().toISOString().slice(0, 10)}.json`, exportFullBackupJson(), '已匯出全部牌組與收藏備份 JSON');
    return;
  }

  if (action === 'open-account-modal') {
    openModal('帳號與雲端同步', buildAccountModal());
    return;
  }

  if (action === 'switch-auth-tab') {
    uiState.auth.mode = el.dataset.mode || 'login';
    dialogBodyEl.innerHTML = buildAccountModal();
    return;
  }

  if (action === 'cloud-google-login') {
    try {
      startGoogleSignIn();
    } catch (err) {
      showNotice(err?.message || '無法啟動 Google 登入');
    }
    return;
  }

  if (action === 'cloud-sync-now' || action === 'cloud-pull-overwrite' || action === 'cloud-push-overwrite') {
    const mode = action === 'cloud-pull-overwrite' ? 'pull' : action === 'cloud-push-overwrite' ? 'push' : 'merge';
    try {
      await syncWithCloud(mode);
      renderRoute();
      refreshDraftPanels();
      if (dialogEl.open) dialogBodyEl.innerHTML = buildAccountModal();
      showNotice(mode === 'pull' ? '已自雲端下載並套用' : mode === 'push' ? '已上傳覆蓋雲端備份' : '雲端雙向同步完成');
    } catch (err) {
      showNotice(err?.message || '雲端同步失敗');
    }
    return;
  }

  if (action === 'cloud-signout') {
    await signOutAccount();
    state.cloudSession = null;
    state.cloudSyncState = 'idle';
    state.cloudSyncMessage = '';
    updateChrome(currentRoute());
    if (dialogEl.open) dialogBodyEl.innerHTML = buildAccountModal();
    showNotice('已登出帳號（本機資料保留）');
    return;
  }

  if (action === 'cloud-clear-override') {
    saveCloudOverride('', '');
    if (dialogEl.open) dialogBodyEl.innerHTML = buildAccountModal();
    showNotice('已清除本機連線設定');
    return;
  }

  if (action === 'own-delta') {
    const next = Math.max(0, (state.collection[id] || 0) + Number(el.dataset.delta || 0));
    await setOwnedCount(id, next);
    const valEl = document.getElementById('modal-own-val');
    if (valEl) valEl.textContent = String(next);
    if (currentRoute() === 'catalog') {
      const resEl = document.getElementById('catalog-results');
      if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    }
    refreshDraftPanels();
    return;
  }

  if (action === 'select-deck') {
    state.selectedDeckId = id;
    renderRoute();
    return;
  }

  if (action === 'create-empty-deck') {
    const created = await saveDeck({ id: crypto.randomUUID(), name: `新牌組 ${state.decks.length + 1}`, cards: [], energy: ['Fire'] });
    state.selectedDeckId = created.id;
    renderRoute();
    return;
  }

  if (action === 'import-deck-trigger') {
    importInputEl.value = '';
    importInputEl.click();
    return;
  }

  if (action === 'export-deck') {
    const d = state.decks.find((x) => x.id === id);
    if (!d) return;
    const payload = {
      name: d.name,
      cards: d.cards,
      energy: d.energy,
      ...(d.featuredPokemon?.length ? { featuredPokemon: d.featuredPokemon } : {}),
      ...(d.customOrder ? { customOrder: true } : {})
    };
    await exportJsonFile(
      `${d.name.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      JSON.stringify(payload, null, 2),
      '已匯出牌組 JSON'
    );
    return;
  }

  if (action === 'duplicate-deck') {
    const d = state.decks.find((x) => x.id === id);
    if (!d) return;
    const copy = await saveDeck({ ...structuredClone(d), id: crypto.randomUUID(), name: d.name + ' (複本)', customOrder: true });
    state.selectedDeckId = copy.id;
    renderRoute();
    showNotice('已複製牌組');
    return;
  }

  if (action === 'load-to-draft') {
    const d = state.decks.find((x) => x.id === id);
    if (!d) return;
    await saveDraft(structuredClone(d));
    location.hash = '#catalog';
    showNotice('已載入圖鑑草稿');
    return;
  }

  if (action === 'delete-deck') {
    await deleteDeck(id);
    renderRoute();
    showNotice('已刪除牌組');
    return;
  }

  if (action === 'deck-to-battle') {
    if (dialogEl.open) dialogEl.close();
    uiState.battle.deckId = id;
    location.hash = '#battle';
    return;
  }

  if (action === 'toggle-draft-pokemon') {
    const slug = el.dataset.slug;
    if (!state.draft || !slug) return;
    if (toggleFeaturedSlugOnDeck(state.draft, slug)) {
      await saveDraft(state.draft);
      refreshDraftPanels();
    }
    return;
  }

  if (action === 'reset-draft-pokemon') {
    if (!state.draft) return;
    state.draft.featuredPokemon = [];
    await saveDraft(state.draft);
    refreshDraftPanels();
    showNotice('已恢復自動推薦代表寶可夢');
    return;
  }

  if (action === 'set-decks-view') {
    uiState.decks.view = el.dataset.view || 'showcase';
    renderRoute();
    return;
  }

  if (action === 'feature-deck') {
    const next = state.featuredDeckId === id ? null : id;
    await setFeaturedDeck(next);
    renderRoute();
    showNotice(next ? '已設為首頁牌桌陳列' : '已取消首頁陳列指定');
    return;
  }

  if (action === 'open-deck-showcase') {
    const d = state.decks.find((x) => x.id === id);
    if (!d) return;
    openModal(`牌組陳列預覽 · ${d.name}`, buildDeckShowcaseModal(d, { battleDeckId: d.id }), { wide: true });
    return;
  }

  if (action === 'open-draft-showcase') {
    openModal(`草稿陳列預覽 · ${state.draft.name}`, buildDeckShowcaseModal(state.draft, { saveDraftButton: true }), { wide: true });
    return;
  }

  if (action === 'open-meta-showcase') {
    const entry = (state.meta?.entries || []).find((e) => e.id === id);
    if (!entry?.representative) return;
    const deck = {
      name: entry.name,
      cards: sortDeckEntriesPtcgpDefault(entry.representative.cards, state.cardsById),
      energy: entry.representative.energy || []
    };
    openModal(`賽事代表陳列 · ${entry.name}`, buildDeckShowcaseModal(deck, { cloneMetaId: entry.id }), { wide: true });
    return;
  }

  if (action === 'inspect-meta') {
    const entry = (state.meta?.entries || []).find((e) => e.id === id);
    if (!entry) return;
    openModal(entry.name, buildMetaDetailModal(entry));
    return;
  }

  if (action === 'clone-meta-deck') {
    const entry = (state.meta?.entries || []).find((e) => e.id === id);
    if (!entry?.representative) return;
    const autoFeatured = resolveFeaturedPokemon(entry.representative, state.cardsById, state.spriteMap).map((x) => x.slug);
    const created = await saveDeck({
      id: crypto.randomUUID(),
      name: `${entry.name} (賽事代表)`,
      cards: sortDeckEntriesPtcgpDefault(entry.representative.cards, state.cardsById),
      energy: structuredClone(entry.representative.energy),
      featuredPokemon: autoFeatured,
      customOrder: true
    });
    if (dialogEl.open) dialogEl.close();
    showNotice(`已複製「${created.name}」到我的牌組`);
    return;
  }

  if (action === 'meta-sort') {
    uiState.meta.sort = el.dataset.sort || 'count';
    uiState.meta.page = 1;
    renderRoute();
    return;
  }

  if (action === 'meta-page') {
    uiState.meta.page = Number(el.dataset.page || 1);
    renderRoute();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (action === 'load-full-meta') {
    showNotice('正在載入完整 537 原型環境資料…');
    await ensureFullMeta();
    renderRoute();
    showNotice('已載入全部原型與賽事明細');
    return;
  }

  if (action === 'quick-load-meta-deck') {
    const entry = (state.meta?.entries || []).find((e) => e.representative?.cards?.length === 20 || e.representative?.cards?.length);
    if (!entry?.representative) { showNotice('目前無可用的賽事代表牌組'); return; }
    const autoFeatured = resolveFeaturedPokemon(entry.representative, state.cardsById, state.spriteMap).map((x) => x.slug);
    const created = await saveDeck({
      id: crypto.randomUUID(),
      name: `${entry.name} (榜首代表)`,
      cards: sortDeckEntriesPtcgpDefault(entry.representative.cards, state.cardsById),
      energy: structuredClone(entry.representative.energy),
      featuredPokemon: autoFeatured,
      customOrder: true
    });
    uiState.battle.deckId = created.id;
    uiState.battle.activeRunId = null;
    renderRoute();
    showNotice(`已載入「${created.name}」供綜合勝率測試`);
    return;
  }

  if (action === 'start-real-battle' || action === 'run-fixture-preview') {
    const isDemo = action === 'run-fixture-preview';
    const deck = state.decks.find((d) => d.id === uiState.battle.deckId) || state.decks[0];
    if (!deck) { showNotice('請先選擇或建立一套牌組'); return; }

    if (!isDemo && state.engineReady) {
      const ids = [
        ...(state.meta?.entries || []).slice(0, 20).flatMap((e) => (e.representative?.cards || []).map((c) => c.id)),
        ...(deck.cards || []).map((c) => c.id)
      ];
      ensureCardCoverage(ids);
    }

    const lineup = resolveOpponentLineup(state.meta, isDemo ? null : state.coverageMap).selected;
    if (lineup.length < 10) { showNotice('目前不足 10 個有效對手'); return; }

    const model = getSelectedBattleModel();
    const targetVersion = isDemo ? '展示樣板' : model.version;

    let run = state.runs.find((r) => r.runId === uiState.battle.activeRunId && r.deckId === deck.id && (r.isDemo || r.modelVersion === targetVersion))
      || state.runs.find((r) => r.deckId === deck.id && r.season === state.meta?.season && Boolean(r.isDemo) === isDemo && r.modelVersion === targetVersion && r.events.length < 500);

    if (!run) {
      run = {
        runId: `run-${Date.now().toString(36)}`,
        deckId: deck.id,
        deckName: deck.name,
        season: state.meta?.season || 'C1',
        modelVersion: targetVersion,
        isDemo,
        events: [],
        createdAt: new Date().toISOString()
      };
      await saveRunRecord(run);
    }

    uiState.battle.activeRunId = run.runId;
    uiState.battle.running = true;
    uiState.battle.abortCtrl = new AbortController();
    renderRoute();

    const updateView = (latestRun) => {
      const box = document.getElementById('battle-report-area');
      if (box) box.innerHTML = renderBattleReport(latestRun, lineup, { canReplay: state.engineReady || state.fixture });
    };

    try {
      if (isDemo) {
        await executeFixturePreviewBatch({ run, lineup, onTick: updateView, signal: uiState.battle.abortCtrl.signal });
      } else {
        await executeBattleBatch({ run, deck, lineup, weights: model.weights, onTick: updateView, signal: uiState.battle.abortCtrl.signal });
      }
      if (!uiState.battle.abortCtrl.signal.aborted) {
        showNotice('500 局模擬已完成');
      }
    } catch (err) {
      showNotice(err?.message || '模擬中斷');
    } finally {
      uiState.battle.running = false;
      renderRoute();
    }
    return;
  }

  if (action === 'pause-battle') {
    uiState.battle.abortCtrl?.abort();
    uiState.battle.running = false;
    showNotice('已暫停模擬，進度已儲存');
    renderRoute();
    return;
  }

  if (action === 'reset-battle-run') {
    uiState.battle.abortCtrl?.abort();
    uiState.battle.running = false;
    const deck = state.decks.find((d) => d.id === uiState.battle.deckId);
    const model = getSelectedBattleModel();
    if (deck) {
      const fresh = {
        runId: `run-${Date.now().toString(36)}`,
        deckId: deck.id,
        deckName: deck.name,
        season: state.meta?.season || 'C1',
        modelVersion: model.version,
        isDemo: false,
        events: [],
        createdAt: new Date().toISOString()
      };
      await saveRunRecord(fresh);
      uiState.battle.activeRunId = fresh.runId;
    }
    renderRoute();
    showNotice('已重設本次模擬紀錄');
    return;
  }

  if (action === 'replay-game') {
    const oppId = el.dataset.opp;
    const idx = Number(el.dataset.idx);
    const run = state.runs.find((r) => r.runId === uiState.battle.activeRunId) || state.runs[0];
    const ev = run?.events?.find((e) => e.opponentId === oppId && e.index === idx);
    const opp = (state.meta?.entries || []).find((e) => e.id === oppId);
    const seed = ev?.seed ?? fnv1a32(`${run?.runId || 'demo'}:${oppId}:${idx}`);
    let logText = '';
    if (state.engineReady && state.runtimeFn && opp?.representative) {
      const deck = state.decks.find((d) => d.id === run.deckId);
      const weights = getWeightsForVersion(run?.modelVersion);
      const replay = state.runtimeFn({
        op: 'game',
        deck: { cards: deck.cards, energy: deck.energy },
        enemy: { cards: opp.representative.cards, energy: opp.representative.energy },
        weights,
        seed,
        first: idx < 25 ? 0 : 1,
        replay: true
      });
      logText = (replay.replay || []).map((s) => `第${s.turn}回合 [玩家${s.actor + 1}] ${s.action}  (分數 ${s.points?.join('-')})`).join('\n');
    } else {
      logText = `對局種子：0x${seed.toString(16).toUpperCase()}\n先後攻：${idx < 25 ? '我方先攻' : '我方後攻'}\n結果：${ev?.outcome === 'win' ? '勝' : ev?.outcome === 'loss' ? '敗' : ev?.outcome === 'draw' ? '和' : '—'}（${ev?.turns || '—'} 回合）\n\n對戰模擬引擎尚未載入，暫無法顯示逐回合詳情。`;
    }
    openModal(`重播計算 · 對陣 ${opp?.name || oppId} 第 ${idx + 1} 局`, `<pre class="detail-log">${esc(logText)}</pre>`);
  }
}

// 全局事件绑定
document.addEventListener('click', (e) => {
  const insidePicker = Boolean(e.target.closest?.('.tag-picker-wrap, .swiss-select-wrap'));
  if ((uiState.catalog.pokeTagOpen || uiState.openSelect) && !insidePicker) {
    uiState.catalog.pokeTagOpen = false;
    uiState.openSelect = null;
    syncAllPickerPopovers();
    if (window.innerWidth <= 640) return;
  }
  const btn = e.target.closest?.('[data-action]');
  if (btn) handleAction(btn);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (uiState.catalog.pokeTagOpen || uiState.openSelect)) {
    const returnFocusId = uiState.openSelect || 'poke-tag-trigger';
    uiState.catalog.pokeTagOpen = false;
    uiState.openSelect = null;
    syncAllPickerPopovers();
    document.getElementById(returnFocusId)?.focus();
  }
});

let qTimer = null;
document.addEventListener('input', (e) => {
  const target = e.target;
  if (target.id === 'catalog-q') {
    uiState.catalog.q = target.value;
    uiState.catalog.page = 1;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const resEl = document.getElementById('catalog-results');
      if (resEl) resEl.innerHTML = renderCatalogGridHtml();
    }, 110);
  } else if (target.id === 'meta-q') {
    uiState.meta.q = target.value;
    uiState.meta.page = 1;
    renderRoute();
    const input = document.getElementById('meta-q');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  } else if (target.id === 'draft-name') {
    state.draft.name = target.value;
    saveDraft(state.draft);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'deck-rename-input') {
    const d = state.decks.find((x) => x.id === t.dataset.deckId);
    const nextName = t.value.trim();
    if (d && nextName && nextName !== d.name) {
      d.name = nextName;
      await saveDeck(d);
      renderRoute();
      showNotice(`已重新命名為「${d.name}」`);
    }
    return;
  }
  if (t.id === 'filter-set' || t.id === 'filter-kind' || t.id === 'filter-subtype' || t.id === 'filter-stage' || t.id === 'filter-rarity' || t.id === 'filter-owned' || t.id === 'battle-deck-select') {
    applySwissSelectValue(t.id, t.value);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'cloud-auth-form') {
    e.preventDefault();
    const email = document.getElementById('auth-email')?.value || '';
    const pass = document.getElementById('auth-password')?.value || '';
    const pass2 = document.getElementById('auth-password2')?.value;
    const isSignup = uiState.auth.mode === 'signup';
    if (isSignup && pass2 != null && pass !== pass2) {
      showNotice('兩次輸入的密碼不一致');
      return;
    }
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      if (isSignup) {
        const res = await signUpAccount(email, pass);
        if (res.needsEmailVerification) {
          showNotice('註冊成功！請先至信箱點擊驗證信後再登入');
          uiState.auth.mode = 'login';
          dialogBodyEl.innerHTML = buildAccountModal();
          return;
        }
        state.cloudSession = res.session;
      } else {
        state.cloudSession = await signInAccount(email, pass);
      }
      await syncWithCloud('merge');
      renderRoute();
      refreshDraftPanels();
      dialogBodyEl.innerHTML = buildAccountModal();
      showNotice(isSignup ? '註冊並登入成功，資料已同步雲端' : '登入成功，已同步雲端牌組與收藏');
    } catch (err) {
      showNotice(err?.message || '驗證失敗');
      if (submitBtn) submitBtn.disabled = false;
    }
    return;
  }
  if (form.id === 'cloud-config-form') {
    e.preventDefault();
    try {
      const url = document.getElementById('cfg-sb-url')?.value || '';
      const key = document.getElementById('cfg-sb-key')?.value || '';
      saveCloudOverride(url, key);
      dialogBodyEl.innerHTML = buildAccountModal();
      showNotice('已套用 Supabase 連線設定');
    } catch (err) {
      showNotice(err?.message || '設定格式錯誤');
    }
  }
});

// 草稿牌組拖曳排序（桌面側欄與抽屜共用）
let draggedDraftId = null;
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.draft-list .draft-row');
  if (!row) return;
  draggedDraftId = row.dataset.id || null;
  row.classList.add('is-dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedDraftId || '');
  }
});
document.addEventListener('dragover', (e) => {
  const row = e.target.closest?.('.draft-list .draft-row');
  if (!row || !draggedDraftId) return;
  e.preventDefault();
  document.querySelectorAll('.draft-row.is-drag-over').forEach((n) => n.classList.remove('is-drag-over'));
  if (row.dataset.id !== draggedDraftId) row.classList.add('is-drag-over');
});
document.addEventListener('dragleave', (e) => {
  const row = e.target.closest?.('.draft-list .draft-row');
  if (row) row.classList.remove('is-drag-over');
});
document.addEventListener('dragend', () => {
  draggedDraftId = null;
  document.querySelectorAll('.draft-row.is-dragging,.draft-row.is-drag-over').forEach((n) => {
    n.classList.remove('is-dragging', 'is-drag-over');
  });
});
document.addEventListener('drop', async (e) => {
  const row = e.target.closest?.('.draft-list .draft-row');
  const srcId = draggedDraftId;
  draggedDraftId = null;
  document.querySelectorAll('.draft-row.is-dragging,.draft-row.is-drag-over').forEach((n) => {
    n.classList.remove('is-dragging', 'is-drag-over');
  });
  if (!row || !srcId) return;
  const dstId = row.dataset.id;
  if (!dstId || srcId === dstId || !Array.isArray(state.draft?.cards)) return;
  e.preventDefault();
  const cards = state.draft.cards;
  const from = cards.findIndex((c) => c.id === srcId);
  const to = cards.findIndex((c) => c.id === dstId);
  if (from < 0 || to < 0) return;
  const [moved] = cards.splice(from, 1);
  cards.splice(to, 0, moved);
  state.draft.customOrder = true;
  await saveDraft(state.draft);
  refreshDraftPanels();
});

importInputEl.addEventListener('change', async () => {
  const file = importInputEl.files?.[0];
  if (!file) return;
  try {
    const res = await importBackupJson(await file.text());
    if (res.mode === 'backup') {
      renderRoute();
      refreshDraftPanels();
      if (dialogEl.open) dialogBodyEl.innerHTML = buildAccountModal();
      showNotice(`已匯入 ${res.deckCount} 套牌組與 ${res.colCount} 種收藏紀錄`);
    } else {
      state.selectedDeckId = res.saved.id;
      renderRoute();
      showNotice(`已匯入「${res.saved.name}」`);
    }
  } catch (err) {
    showNotice('匯入失敗：' + (err?.message || '格式無效'));
  }
});

document.getElementById('dialog-close')?.addEventListener('click', () => dialogEl.close());
dialogEl?.addEventListener('click', (e) => { if (e.target === dialogEl) dialogEl.close(); });
dialogEl?.addEventListener('close', () => {
  dialogEl.classList.remove('is-wide');
  dialogBodyEl.innerHTML = '';
});

drawerFabEl?.addEventListener('click', () => {
  const open = draftDrawerEl.hidden;
  if (open) {
    draftDrawerEl.innerHTML = renderDraftPanel();
    draftDrawerEl.hidden = false;
  } else {
    draftDrawerEl.hidden = true;
  }
  drawerFabEl.setAttribute('aria-expanded', String(open));
});

document.getElementById('refresh')?.addEventListener('click', async () => {
  showNotice('正在檢查最新快照…');
  try {
    const { changed } = await loadInitialData(true);
    renderRoute();
    showNotice(changed ? '已更新至最新已發布資料' : '目前已是最新已發布快照');
  } catch (err) {
    showNotice('檢查更新失敗：' + (err?.message || '網路異常'));
  }
});

window.addEventListener('hashchange', () => renderRoute(true));

async function exportJsonFile(filename, jsonText, noticeMessage) {
  if (typeof window.PocketLabNative?.exportTextFile === 'function') {
    const ok = window.PocketLabNative.exportTextFile(filename, jsonText, 'application/json');
    if (ok) {
      showNotice(noticeMessage);
      return;
    }
  }
  const blob = new Blob([jsonText], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showNotice(noticeMessage);
}

async function boot() {
  bindCardImageFallback(document);
  populateBottomNav();
  setCloudSyncListener(() => updateChrome(currentRoute()));
  if (state.fixture) {
    const banner = document.getElementById('fixture-banner');
    if (banner) banner.hidden = false;
  }
  await Promise.all([loadInitialData(false), probeEngine()]);
  renderRoute();
  initCloudSessionAndSync()
    .then((sess) => {
      if (sess) {
        renderRoute();
        refreshDraftPanels();
      }
    })
    .catch(() => {});
}

boot().catch((err) => {
  mainEl.innerHTML = `<div class="panel"><h2>載入失敗</h2><p class="desc">${esc(err?.message || '未知錯誤')}</p></div>`;
});
