import {
  DEEP_EXPLORE_GAMES,
  DEEP_GAMES_PER_OPPONENT,
  EXPLORE_TOTAL_GAMES,
  GAMES_PER_OPPONENT,
  isAndroidOrMobileEnv,
  matchDeckStrategies,
  normalizeFeaturedPokemon,
  replaceDeckCardOnce,
  resolveModelSimProfile,
  titleCase,
  TOTAL_BATCH_GAMES,
  validateDeck
} from './core.mjs';
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
  ensurePairwiseStrategies,
  ensureQrEntityMap,
  ensureStrategyLexicon,
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
  buildFullGameFlowModal,
  buildStrategyLexiconModal,
  ensureCardCoverage,
  executeBattleBatch,
  executeCustomDeckGtgDuel,
  executeDeckCardOptimize,
  executeFixturePreviewBatch,
  executeSingleOpponentDeep,
  fnv1a32,
  probeEngine,
  renderBattleReport,
  renderCustomDuelReport,
  renderDeckOptimizerModal,
  renderSingleOpponentDeepModal,
  renderSingleOpponentDeepProgress,
  resolveOpponentLineup
} from './battle.mjs';
import {
  buildAccountModal,
  buildCardDetailModal,
  buildCatalogAuditModal,
  buildCollectionToolsModal,
  buildDeckShowcaseModal,
  buildMetaDetailModal,
  buildQrExportModal,
  buildQrImportModal,
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
  } else if (selectId === 'battle-duel-deck-a') {
    uiState.battle.duelDeckAId = value;
  } else if (selectId === 'battle-duel-deck-b') {
    uiState.battle.duelDeckBId = value;
  }
  uiState.openSelect = null;
  renderRoute();
}

function getSelectedBattleModel() {
  const defaultId = isAndroidOrMobileEnv()
    ? (state.modelManifest?.mobileDefaultModelId || 'lite-1m5q')
    : (state.modelManifest?.defaultModelId || 'v3');
  const id = uiState.battle.modelId || defaultId;
  const model = state.modelsById.get(id) || state.modelInfo;
  const simProfile = resolveModelSimProfile(model || { id });
  return {
    id,
    version: model?.version || (id === 'lite-1m5q' ? 'lite-1m5q' : 'selfplay-cem-v3'),
    label: model?.metaEntry?.label || simProfile.label,
    weights: model?.weights || Array(22).fill(0),
    simProfile
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
const qrImageInputEl = document.getElementById('qr-image-file');

// === 遊戲內卡組二維碼：相機掃描、截圖識別與雙向匯出 ===
let qrCameraStream = null;
let qrScanTimer = null;
let qrScanBusy = false;
let qrModulePromise = null;
let lastQrExport = null;

function loadQrModule() {
  if (!qrModulePromise) qrModulePromise = import('./deck-qr.mjs');
  return qrModulePromise;
}

function stopQrCamera() {
  if (qrScanTimer) {
    clearTimeout(qrScanTimer);
    qrScanTimer = null;
  }
  qrScanBusy = false;
  if (qrCameraStream) {
    for (const track of qrCameraStream.getTracks()) {
      try { track.stop(); } catch {}
    }
    qrCameraStream = null;
  }
  const vid = document.getElementById('qr-video');
  if (vid) vid.srcObject = null;
  uiState.qrImport.scanning = false;
}

function refreshQrImportModal() {
  if (!dialogEl.open || !uiState.qrImport.open) return;
  dialogBodyEl.innerHTML = buildQrImportModal();
  bindFoilEffects(dialogBodyEl);
}

async function applyDecodedQrPayload(rawPayload) {
  const [qrMod, entityMap] = await Promise.all([loadQrModule(), ensureQrEntityMap()]);
  if (!entityMap) throw Error('無法載入卡牌代碼對照表，請重新整理後再試');
  const decoded = qrMod.decodeDeckQrPayload(rawPayload);
  const resolved = qrMod.resolveDecodedPayloadToDeck(decoded, entityMap, state.cardsById, state.collection);
  if (!resolved.cards.length) throw Error('無法識別此卡組碼中的卡牌');
  stopQrCamera();
  uiState.qrImport.error = '';
  uiState.qrImport.statusText = '';
  uiState.qrImport.decoding = false;
  uiState.qrImport.result = resolved;
  try { navigator.vibrate?.(60); } catch {}
  refreshQrImportModal();
  showNotice(`已識別遊戲牌組「${resolved.name}」（${resolved.totalCards} 張）`);
}

async function decodeQrImageFileAndPreview(file) {
  if (!file) return;
  stopQrCamera();
  uiState.qrImport.error = '';
  uiState.qrImport.decoding = true;
  uiState.qrImport.statusText = '正在解析圖片中的卡組二維碼…';
  refreshQrImportModal();
  try {
    const [qrMod] = await Promise.all([loadQrModule(), ensureQrEntityMap()]);
    const res = await qrMod.decodeQrFromImageFile(file);
    if (!res?.payload) {
      throw Error('圖片中未識別到有效的遊戲卡組二維碼，請確認截圖清晰完整（或試著放大二維碼區域再試）');
    }
    await applyDecodedQrPayload(res.payload);
  } catch (err) {
    uiState.qrImport.decoding = false;
    uiState.qrImport.statusText = '';
    uiState.qrImport.error = err?.message || '無法識別圖片中的卡組碼';
    refreshQrImportModal();
  }
}

async function startQrCameraScan() {
  stopQrCamera();
  uiState.qrImport.error = '';
  uiState.qrImport.result = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    uiState.qrImport.error = '目前環境不支援開啟相機，請點擊「選擇遊戲截圖」匯入相簿截圖。';
    refreshQrImportModal();
    return;
  }
  uiState.qrImport.statusText = '正在請求相機權限…';
  refreshQrImportModal();
  try {
    const [qrMod] = await Promise.all([loadQrModule(), ensureQrEntityMap()]);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    if (!dialogEl.open || !uiState.qrImport.open) {
      for (const t of stream.getTracks()) try { t.stop(); } catch {}
      return;
    }
    qrCameraStream = stream;
    uiState.qrImport.scanning = true;
    uiState.qrImport.statusText = '相機已開啟，請對準遊戲內的牌組二維碼';
    refreshQrImportModal();

    const vid = document.getElementById('qr-video');
    if (!vid) { stopQrCamera(); return; }
    vid.srcObject = stream;
    await vid.play().catch(() => {});

    const scanCanvas = document.createElement('canvas');
    const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    let nativeDetector = null;
    if (typeof window.BarcodeDetector === 'function') {
      try { nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
    }

    const tick = async () => {
      if (!qrCameraStream || !uiState.qrImport.scanning || !uiState.qrImport.open) return;
      if (!qrScanBusy && vid.readyState >= 2 && vid.videoWidth > 0 && vid.videoHeight > 0) {
        qrScanBusy = true;
        try {
          const maxW = 960;
          const scale = vid.videoWidth > maxW ? maxW / vid.videoWidth : 1;
          const cw = Math.round(vid.videoWidth * scale);
          const ch = Math.round(vid.videoHeight * scale);
          if (scanCanvas.width !== cw || scanCanvas.height !== ch) {
            scanCanvas.width = cw;
            scanCanvas.height = ch;
          }
          scanCtx.drawImage(vid, 0, 0, cw, ch);

          let rawPayload = '';
          if (nativeDetector) {
            try {
              const found = await nativeDetector.detect(scanCanvas);
              if (found?.[0]?.rawValue) rawPayload = found[0].rawValue;
            } catch {}
          }
          if (!rawPayload) {
            const imgData = scanCtx.getImageData(0, 0, cw, ch);
            const dec = qrMod.decodeQrFromImageData(imgData, { fastCamera: true });
            if (dec?.payload) rawPayload = dec.payload;
          }
          if (rawPayload) {
            try {
              qrMod.decodeDeckQrPayload(rawPayload);
              await applyDecodedQrPayload(rawPayload);
              return;
            } catch {
              // 掃到非遊戲牌組二維碼，持續等待正確圖碼
            }
          }
        } finally {
          qrScanBusy = false;
        }
      }
      qrScanTimer = setTimeout(tick, 280);
    };
    qrScanTimer = setTimeout(tick, 320);
  } catch (err) {
    stopQrCamera();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
    uiState.qrImport.statusText = '';
    uiState.qrImport.error = denied
      ? '尚未授權相機權限，請在系統設定允許相機，或直接點「選擇遊戲截圖」匯入。'
      : `無法開啟相機（${err?.message || '未偵測到可用鏡頭'}），請改用「選擇遊戲截圖」。`;
    refreshQrImportModal();
  }
}

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
  else if (route === 'battle') {
    if (!state.engineReady && !state.engineError) {
      probeEngine().then(() => {
        if (currentRoute() === 'battle') renderRoute();
      });
    }
    html = renderBattle();
  } else if (route === 'sources') html = renderSources();

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

  if (action === 'open-qr-import') {
    stopQrCamera();
    uiState.qrImport = {
      open: true,
      scanning: false,
      decoding: false,
      statusText: '',
      error: '',
      result: null,
      rawText: ''
    };
    openModal('掃碼匯入遊戲牌組', buildQrImportModal());
    ensureQrEntityMap().catch(() => null);
    loadQrModule().catch(() => null);
    return;
  }

  if (action === 'qr-start-camera') {
    await startQrCameraScan();
    return;
  }

  if (action === 'qr-stop-camera') {
    stopQrCamera();
    uiState.qrImport.statusText = '';
    refreshQrImportModal();
    return;
  }

  if (action === 'qr-pick-image') {
    if (qrImageInputEl) {
      qrImageInputEl.value = '';
      qrImageInputEl.click();
    }
    return;
  }

  if (action === 'qr-parse-text') {
    const raw = document.getElementById('qr-raw-code-input')?.value?.trim() || '';
    uiState.qrImport.rawText = raw;
    if (!raw) {
      uiState.qrImport.error = '請先貼上遊戲卡組代碼';
      refreshQrImportModal();
      return;
    }
    try {
      await applyDecodedQrPayload(raw);
    } catch (err) {
      uiState.qrImport.error = err?.message || '代碼解析失敗';
      refreshQrImportModal();
    }
    return;
  }

  if (action === 'qr-reset') {
    stopQrCamera();
    uiState.qrImport.result = null;
    uiState.qrImport.error = '';
    uiState.qrImport.statusText = '';
    uiState.qrImport.decoding = false;
    refreshQrImportModal();
    return;
  }

  if (action === 'qr-confirm-save' || action === 'qr-confirm-battle') {
    const res = uiState.qrImport.result;
    if (!res?.cards?.length) return;
    const customName = document.getElementById('qr-deck-name-input')?.value?.trim() || res.name || '掃碼匯入牌組';
    const saved = await saveDeck({
      id: crypto.randomUUID(),
      name: customName.slice(0, 150),
      cards: res.cards,
      energy: res.energy,
      customOrder: true
    });
    state.selectedDeckId = saved.id;
    uiState.qrImport.open = false;
    uiState.qrImport.result = null;
    if (dialogEl.open) dialogEl.close();
    if (action === 'qr-confirm-battle') {
      uiState.battle.deckId = saved.id;
      location.hash = '#battle';
    } else {
      if (currentRoute() !== 'decks') location.hash = '#decks';
      else renderRoute();
    }
    showNotice(`已將「${saved.name}」加入我的牌組`);
    return;
  }

  if (action === 'export-deck-qr') {
    const d = state.decks.find((x) => x.id === id);
    if (!d) return;
    try {
      const [qrMod, entityMap] = await Promise.all([loadQrModule(), ensureQrEntityMap()]);
      if (!entityMap) throw Error('無法載入卡牌代碼對照表');
      const qrRes = qrMod.encodeDeckToGameQr(d, entityMap, state.cardsById);
      lastQrExport = { deck: d, qrRes };
      openModal(`遊戲二維碼 · ${d.name}`, buildQrExportModal(d, qrRes));
    } catch (err) {
      showNotice(err?.message || '產生遊戲二維碼失敗');
    }
    return;
  }

  if (action === 'qr-download-png') {
    if (!lastQrExport?.qrRes?.payload) return;
    try {
      const qrMod = await loadQrModule();
      const dataUrl = qrMod.renderDeckQrToPngDataUrl(lastQrExport.qrRes.payload, { size: 520 });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${(lastQrExport.deck?.name || 'pocket-deck').replace(/[\\/:*?"<>|]/g, '_')}-qr.png`;
      a.click();
      showNotice('已下載遊戲卡組二維碼圖片');
    } catch (err) {
      showNotice(err?.message || '下載圖片失敗');
    }
    return;
  }

  if (action === 'qr-copy-code') {
    const val = document.getElementById('qr-export-code-val')?.value || lastQrExport?.qrRes?.payload || '';
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      showNotice('已複製遊戲卡組代碼');
    } catch {
      const inp = document.getElementById('qr-export-code-val');
      if (inp) { inp.select(); document.execCommand?.('copy'); }
      showNotice('已選取卡組代碼');
    }
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

  if (action === 'open-deck-optimizer') {
    const deck = state.decks.find((d) => d.id === id)
      || state.decks.find((d) => d.id === uiState.battle.deckId)
      || state.decks[0];
    if (!deck) { showNotice('請先選擇一套牌組'); return; }
    const issues = state.cardsMissing ? [] : validateDeck(deck, state.cardsById);
    if (issues.length > 0) { showNotice(issues[0]); return; }
    uiState.battle.optAbortCtrl?.abort();
    const firstCardId = deck.cards?.[0]?.id || '';
    uiState.battle.optimizer = {
      deckId: deck.id,
      selectedCardId: firstCardId,
      running: false,
      progress: null,
      result: null
    };
    openModal('牌組 AI 優化', renderDeckOptimizerModal({ ...uiState.battle.optimizer, deck }), { wide: true });
    return;
  }

  if (action === 'select-optimize-card') {
    const opt = uiState.battle.optimizer;
    if (!opt || opt.running) return;
    opt.selectedCardId = el.dataset.cardId || '';
    opt.result = null;
    const deck = state.decks.find((d) => d.id === opt.deckId);
    if (dialogEl.open && deck) {
      dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });
    }
    return;
  }

  if (action === 'reset-deck-optimize') {
    const opt = uiState.battle.optimizer;
    if (!opt) return;
    uiState.battle.optAbortCtrl?.abort();
    opt.running = false;
    opt.progress = null;
    opt.result = null;
    const deck = state.decks.find((d) => d.id === opt.deckId);
    if (dialogEl.open && deck) {
      dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });
    }
    return;
  }

  if (action === 'cancel-deck-optimize') {
    uiState.battle.optAbortCtrl?.abort();
    const opt = uiState.battle.optimizer;
    if (opt) {
      opt.running = false;
      opt.progress = null;
      const deck = state.decks.find((d) => d.id === opt.deckId);
      if (dialogEl.open && deck) {
        dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });
      }
    }
    showNotice('已取消優化');
    return;
  }

  if (action === 'start-deck-optimize') {
    const opt = uiState.battle.optimizer;
    if (!opt || opt.running || !opt.selectedCardId) return;
    const deck = state.decks.find((d) => d.id === opt.deckId);
    if (!deck) { showNotice('找不到目標牌組'); return; }
    const lineup = resolveOpponentLineup(state.meta, null).selected;
    if (lineup.length < 10) { showNotice('賽事環境資料尚未就緒'); return; }

    uiState.battle.optAbortCtrl?.abort();
    const ctrl = new AbortController();
    uiState.battle.optAbortCtrl = ctrl;
    opt.running = true;
    opt.result = null;
    opt.progress = { stage: 'screen', done: 0, total: state.cards.length || 4577 };
    dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });

    try {
      const res = await executeDeckCardOptimize({
        deck,
        targetCardId: opt.selectedCardId,
        lineup,
        signal: ctrl.signal,
        onProgress: (info) => {
          opt.progress = info;
          if (dialogEl.open && !ctrl.signal.aborted) {
            dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });
          }
        }
      });
      if (!res || ctrl.signal.aborted) return;
      opt.running = false;
      opt.progress = null;
      opt.result = res;
      if (dialogEl.open) {
        dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });
      }
    } catch (err) {
      opt.running = false;
      opt.progress = null;
      if (dialogEl.open) {
        dialogBodyEl.innerHTML = renderDeckOptimizerModal({ ...opt, deck });
      }
      showNotice(err?.message || '優化過程中斷');
    }
    return;
  }

  if (action === 'apply-deck-optimize') {
    const opt = uiState.battle.optimizer;
    const newId = el.dataset.newId;
    const mode = el.dataset.mode || 'replace';
    if (!opt || !newId) return;
    const deck = state.decks.find((d) => d.id === opt.deckId);
    if (!deck) { showNotice('找不到目標牌組'); return; }
    try {
      const nextDeck = replaceDeckCardOnce(deck, opt.selectedCardId, newId, state.cardsById);
      nextDeck.cards = sortDeckEntriesPtcgpDefault(nextDeck.cards, state.cardsById);
      nextDeck.featuredPokemon = resolveFeaturedPokemon(nextDeck, state.cardsById, state.spriteMap).map((x) => x.slug);
      nextDeck.customOrder = true;
      const newCardName = state.cardsById.get(newId)?.name || newId;
      if (mode === 'copy') {
        const copied = await saveDeck({
          ...nextDeck,
          id: crypto.randomUUID(),
          name: `${deck.name} (AI 優化)`
        });
        state.selectedDeckId = copied.id;
        uiState.battle.deckId = copied.id;
        if (dialogEl.open) dialogEl.close();
        renderRoute();
        showNotice(`已另存為「${copied.name}」（換入 ${newCardName}）`);
      } else {
        await saveDeck(nextDeck);
        if (dialogEl.open) dialogEl.close();
        renderRoute();
        showNotice(`已替換為「${newCardName}」並儲存牌組`);
      }
    } catch (err) {
      showNotice('無法替換：' + (err?.message || '不符合牌組規則'));
    }
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

  if (action === 'battle-tab') {
    uiState.battle.tab = el.dataset.tab === 'my-duel' ? 'my-duel' : 'meta';
    renderRoute();
    return;
  }

  if (action === 'swap-custom-duel-decks') {
    if (uiState.battle.duelRunning) return;
    const prevA = uiState.battle.duelDeckAId;
    uiState.battle.duelDeckAId = uiState.battle.duelDeckBId;
    uiState.battle.duelDeckBId = prevA;
    renderRoute();
    return;
  }

  if (action === 'quick-load-meta-deck-pair') {
    const entries = (state.meta?.entries || []).filter((e) => e.representative?.cards?.length);
    if (!entries.length) { showNotice('目前無可用的賽事代表牌組'); return; }
    const createdIds = [];
    for (const idx of [0, 1]) {
      const entry = entries[idx];
      if (!entry?.representative) continue;
      if (state.decks.length >= 2 && idx === 1) break;
      const autoFeatured = resolveFeaturedPokemon(entry.representative, state.cardsById, state.spriteMap).map((x) => x.slug);
      const rankLabel = idx === 0 ? '榜首代表' : '亞軍代表';
      const created = await saveDeck({
        id: crypto.randomUUID(),
        name: `${entry.name} (${rankLabel})`,
        cards: sortDeckEntriesPtcgpDefault(entry.representative.cards, state.cardsById),
        energy: structuredClone(entry.representative.energy),
        featuredPokemon: autoFeatured,
        customOrder: true
      });
      createdIds.push(created.id);
    }
    if (createdIds.length >= 2) {
      uiState.battle.duelDeckAId = createdIds[0];
      uiState.battle.duelDeckBId = createdIds[1];
    } else if (createdIds.length === 1) {
      if (!uiState.battle.duelDeckAId) uiState.battle.duelDeckAId = state.decks[0]?.id || createdIds[0];
      uiState.battle.duelDeckBId = createdIds[0];
    }
    renderRoute();
    showNotice('已匯入熱門牌組供 GTG 互打測試');
    return;
  }

  if (action === 'start-custom-duel') {
    if (uiState.battle.duelRunning || uiState.battle.running) return;
    const deckA = state.decks.find((d) => d.id === uiState.battle.duelDeckAId) || state.decks[0];
    const deckB = state.decks.find((d) => d.id === uiState.battle.duelDeckBId) || state.decks[1] || deckA;
    if (!deckA || !deckB) { showNotice('請先選擇兩副已儲存的牌組'); return; }
    if (!state.engineReady) { showNotice('對戰模擬功能尚未就緒'); return; }

    if (state.runtimeFn) {
      const coverIds = [...(deckA.cards || []).map((c) => c.id), ...(deckB.cards || []).map((c) => c.id)];
      ensureCardCoverage(coverIds);
    }
    const gtgModel = state.modelsById.get('gtg-elite-lite') || getSelectedBattleModel();
    const baseWeights = gtgModel?.weights || state.modelInfo?.weights || Array(22).fill(0);
    const gtgProfile = resolveModelSimProfile(gtgModel || { id: 'gtg-elite-lite' });

    uiState.battle.duelAbortCtrl?.abort();
    const ctrl = new AbortController();
    uiState.battle.duelAbortCtrl = ctrl;
    uiState.battle.duelRunning = true;
    uiState.battle.duelProgress = {
      running: true,
      deckAName: deckA.name,
      deckBName: deckB.name,
      round: 0,
      frac: 0.05,
      history: []
    };
    renderRoute();

    try {
      const duelRes = await executeCustomDeckGtgDuel({
        deckA,
        deckB,
        baseWeights,
        simProfile: gtgProfile,
        signal: ctrl.signal,
        onProgress: (info) => {
          if (ctrl.signal.aborted) return;
          uiState.battle.duelProgress = {
            running: true,
            deckAName: deckA.name,
            deckBName: deckB.name,
            ...info
          };
          const area = document.getElementById('custom-duel-report-area');
          if (area) {
            area.innerHTML = renderCustomDuelReport(null, uiState.battle.duelProgress, { canReplay: state.engineReady });
          }
        }
      });
      if (!duelRes || ctrl.signal.aborted) {
        showNotice('已取消牌組互打模擬');
      } else {
        uiState.battle.duelResult = duelRes;
        showNotice(`已完成「${deckA.name}」vs「${deckB.name}」GTG 互打測試`);
      }
    } catch (err) {
      showNotice(err?.message || '牌組互打模擬失敗');
    } finally {
      uiState.battle.duelRunning = false;
      uiState.battle.duelProgress = null;
      renderRoute();
    }
    return;
  }

  if (action === 'cancel-custom-duel') {
    uiState.battle.duelAbortCtrl?.abort();
    uiState.battle.duelRunning = false;
    uiState.battle.duelProgress = null;
    renderRoute();
    showNotice('已取消牌組互打模擬');
    return;
  }

  if (action === 'reset-custom-duel') {
    uiState.battle.duelResult = null;
    uiState.battle.duelProgress = null;
    renderRoute();
    showNotice('已清空本次互打紀錄');
    return;
  }

  if (action === 'replay-custom-duel') {
    const duelRes = uiState.battle.duelResult;
    if (!duelRes) { showNotice('請先執行牌組 GTG 互打測試'); return; }
    const idx = Number(el.dataset.idx) || 0;
    const html = buildFullGameFlowModal({
      opp: duelRes.opp,
      oppId: duelRes.opp.id,
      idx,
      run: { modelVersion: 'gtg-elite-lite', simProfile: duelRes.profile },
      deck: duelRes.deckA,
      weights: duelRes.baseWeights,
      customSimProfile: duelRes.profile,
      customGamesPerOpp: duelRes.evalGames,
      customWeights: duelRes.playerWeights,
      customEnemyWeights: duelRes.enemyWeights,
      customSeedPrefix: duelRes.seedPrefix,
      customSeedBase: duelRes.testSeedBase,
      customMyFastDeck: duelRes.myFastDeck,
      customOppFastDeck: duelRes.oppFastDeck,
      replayAction: 'replay-custom-duel'
    });
    openModal(`對局回放 · ${duelRes.deckA.name} vs ${duelRes.deckB.name}（第 ${(idx + 1).toLocaleString('zh-TW')} 局）`, html, { wide: true });
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
    const profile = model.simProfile;
    const targetVersion = isDemo ? '展示樣板' : model.version;

    const isIncomplete = (r) => {
      const rp = resolveModelSimProfile(r);
      const testDone = r.compactResults
        ? Object.values(r.compactResults).reduce((s, rec) => s + (rec?.total || 0), 0)
        : (r.events?.length || 0);
      return (r.exploreStats?.completed ?? r.winningStrategy?.exploreTotal ?? 0) < rp.exploreTotalGames
        || testDone < rp.totalBatchGames;
    };

    let run = state.runs.find((r) => r.runId === uiState.battle.activeRunId && r.deckId === deck.id && (r.isDemo || r.modelVersion === targetVersion))
      || state.runs.find((r) => r.deckId === deck.id && r.season === state.meta?.season && Boolean(r.isDemo) === isDemo && r.modelVersion === targetVersion && isIncomplete(r));

    if (!run) {
      run = {
        runId: `run-${Date.now().toString(36)}`,
        deckId: deck.id,
        deckName: deck.name,
        season: state.meta?.season || 'C1',
        modelId: model.id,
        modelVersion: targetVersion,
        simProfile: profile,
        isDemo,
        exploreStats: null,
        winningStrategy: null,
        matchedStrategies: null,
        compactResults: {},
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
        await executeBattleBatch({
          run,
          deck,
          lineup,
          weights: model.weights,
          simProfile: profile,
          onTick: updateView,
          signal: uiState.battle.abortCtrl.signal
        });
      }
      if (!uiState.battle.abortCtrl.signal.aborted) {
        showNotice('勝率模擬已完成');
      }
    } catch (err) {
      showNotice(err?.message || '模擬中斷');
    } finally {
      uiState.battle.running = false;
      renderRoute();
    }
    return;
  }

  if (action === 'run-single-opponent-deep') {
    const oppId = el.dataset.opp;
    const opp = (state.meta?.entries || []).find((e) => e.id === oppId);
    const deck = state.decks.find((d) => d.id === uiState.battle.deckId) || state.decks[0];
    if (!opp || !deck) { showNotice('找不到參戰牌組或目標對手'); return; }
    if (!state.engineReady) { showNotice('對戰模擬引擎尚未就緒'); return; }
    const model = getSelectedBattleModel();
    const profile = model.simProfile;
    uiState.battle.deepAbortCtrl?.abort();
    const ctrl = new AbortController();
    uiState.battle.deepAbortCtrl = ctrl;

    openModal(
      `單獨深度測試 · 對陣 ${opp.name}`,
      renderSingleOpponentDeepProgress({
        opp,
        phase: 'explore',
        done: 0,
        total: profile.deepExploreGames
      }),
      { wide: true }
    );

    try {
      const deepRes = await executeSingleOpponentDeep({
        opp,
        deck,
        baseWeights: model.weights,
        simProfile: profile,
        signal: ctrl.signal,
        onProgress: (info) => {
          if (dialogEl.open && !ctrl.signal.aborted) {
            dialogBodyEl.innerHTML = renderSingleOpponentDeepProgress({ opp, ...info });
          }
        }
      });
      if (!deepRes || ctrl.signal.aborted) {
        showNotice('已取消深度測試');
        return;
      }
      uiState.battle.lastSingleDeep = deepRes;
      const html = renderSingleOpponentDeepModal(deepRes, 0);
      openModal(`對陣 ${opp.name} · 勝率分析與回放`, html, { wide: true });
      showNotice(`已完成對「${opp.name}」的勝率測試`);
    } catch (err) {
      showNotice(err?.message || '深度測試失敗');
    }
    return;
  }

  if (action === 'open-strategy-lexicon' || action === 'strategy-lex-filter' || action === 'strategy-lex-page') {
    if (!uiState.battle.lex) uiState.battle.lex = { q: '', cat: 'pairwise_synergy', onlyMatched: false, page: 1 };
    if (action === 'strategy-lex-filter') {
      uiState.battle.lex.cat = el.dataset.cat || 'all';
      uiState.battle.lex.onlyMatched = el.dataset.matched === '1';
      uiState.battle.lex.page = 1;
    } else if (action === 'strategy-lex-page') {
      uiState.battle.lex.page = Math.max(1, Number(el.dataset.page) || 1);
    }
    if (!state.strategyLexicon || !state.pairwiseStrategies) {
      openModal('策略詞條庫（載入中…）', '<div class="empty-box is-dashed">正在載入 1,048 萬條策略詞條庫…</div>', { wide: true });
      await Promise.all([ensureStrategyLexicon(), ensurePairwiseStrategies()]);
    }
    const run = state.runs.find((r) => r.runId === uiState.battle.activeRunId) || state.runs[0];
    const selDeck = state.decks.find((d) => d.id === uiState.battle.deckId) || state.decks[0] || null;
    const matchedLive = run?.matchedStrategies
      || (selDeck ? matchDeckStrategies(selDeck, [], state.strategyLexicon, state.modelInfo?.weights || [], state.pairwiseStrategies, state.cardsById) : null);
    const matchedIds = matchedLive?.matchedIds || [];
    const activePairs = matchedLive?.activePairStrategies || [];
    const html = buildStrategyLexiconModal({
      lexicon: state.strategyLexicon,
      pairwiseDb: state.pairwiseStrategies,
      indexDoc: state.strategyIndex,
      matchedIdSet: new Set(matchedIds),
      activePairs,
      deck: selDeck,
      ...uiState.battle.lex
    });
    const total = (state.strategyLexicon?.entries?.length || 13500) + (state.pairwiseStrategies?.totalPairwiseEntries || 10472176);
    openModal(`策略詞條庫（${total.toLocaleString('zh-TW')} 條）`, html, { wide: true });
    return;
  }

  if (action === 'cancel-single-deep') {
    uiState.battle.deepAbortCtrl?.abort();
    dialogEl.close();
    showNotice('已中止單組深度模擬');
    return;
  }

  if (action === 'replay-single-deep') {
    const deepRes = uiState.battle.lastSingleDeep;
    if (!deepRes) { showNotice('請先執行單獨深度測試'); return; }
    const idx = Number(el.dataset.idx) || 0;
    const html = renderSingleOpponentDeepModal(deepRes, idx);
    openModal(`對陣 ${deepRes.opp.name} · 第 ${(idx + 1).toLocaleString('zh-TW')} 局回放`, html, { wide: true });
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
        modelId: model.id,
        modelVersion: model.version,
        simProfile: model.simProfile,
        isDemo: false,
        exploreStats: null,
        winningStrategy: null,
        matchedStrategies: null,
        compactResults: {},
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
    const opp = (state.meta?.entries || []).find((e) => e.id === oppId);
    const deck = state.decks.find((d) => d.id === run?.deckId) || state.decks.find((d) => d.id === uiState.battle.deckId) || state.decks[0];
    const weights = getWeightsForVersion(run?.modelVersion);
    const p = resolveModelSimProfile(run);
    const html = buildFullGameFlowModal({ opp, oppId, idx, run, deck, weights });
    openModal(`對局回放 · 對陣 ${opp?.name || oppId}（第 ${(idx + 1).toLocaleString('zh-TW')} 局）`, html, { wide: true });
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
  } else if (target.id === 'lex-search-input') {
    if (!uiState.battle.lex) uiState.battle.lex = { q: '', cat: 'all', onlyMatched: false, page: 1 };
    uiState.battle.lex.q = target.value;
    uiState.battle.lex.page = 1;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      if (!dialogEl.open || (!state.strategyLexicon && !state.pairwiseStrategies)) return;
      const run = state.runs.find((r) => r.runId === uiState.battle.activeRunId) || state.runs[0];
      const selDeck = state.decks.find((d) => d.id === uiState.battle.deckId) || state.decks[0] || null;
      const matchedLive = run?.matchedStrategies
        || (selDeck ? matchDeckStrategies(selDeck, [], state.strategyLexicon, state.modelInfo?.weights || [], state.pairwiseStrategies, state.cardsById) : null);
      const matchedIds = matchedLive?.matchedIds || [];
      const activePairs = matchedLive?.activePairStrategies || [];
      dialogBodyEl.innerHTML = buildStrategyLexiconModal({
        lexicon: state.strategyLexicon,
        pairwiseDb: state.pairwiseStrategies,
        indexDoc: state.strategyIndex,
        matchedIdSet: new Set(matchedIds),
        activePairs,
        deck: selDeck,
        ...uiState.battle.lex
      });
      const inp = document.getElementById('lex-search-input');
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }, 120);
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

qrImageInputEl?.addEventListener('change', async () => {
  const file = qrImageInputEl.files?.[0];
  if (!file) return;
  await decodeQrImageFileAndPreview(file);
});

document.addEventListener('paste', async (e) => {
  if (!dialogEl.open || !uiState.qrImport.open || uiState.qrImport.result) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        await decodeQrImageFileAndPreview(file);
        return;
      }
    }
  }
});

dialogBodyEl?.addEventListener('dragover', (e) => {
  const dz = e.target.closest?.('#qr-dropzone');
  if (!dz) return;
  e.preventDefault();
  dz.classList.add('is-drag');
});
dialogBodyEl?.addEventListener('dragleave', (e) => {
  const dz = e.target.closest?.('#qr-dropzone');
  if (dz) dz.classList.remove('is-drag');
});
dialogBodyEl?.addEventListener('drop', async (e) => {
  const dz = e.target.closest?.('#qr-dropzone');
  if (!dz) return;
  e.preventDefault();
  dz.classList.remove('is-drag');
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) {
    await decodeQrImageFileAndPreview(file);
  }
});

document.getElementById('dialog-close')?.addEventListener('click', () => dialogEl.close());
dialogEl?.addEventListener('click', (e) => { if (e.target === dialogEl) dialogEl.close(); });
dialogEl?.addEventListener('close', () => {
  stopQrCamera();
  uiState.qrImport.open = false;
  uiState.battle.deepAbortCtrl?.abort();
  uiState.battle.optAbortCtrl?.abort();
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
  await loadInitialData(false);
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
