import { normalizeFeaturedPokemon, readDeckFile, titleCase } from './core.mjs';
import {
  bindCardImageFallback,
  bindFoilEffects,
  esc,
  resolveFeaturedPokemon,
  sortDeckEntriesPtcgpDefault
} from './cardface.mjs';
import {
  deleteDeck,
  ensureFullMeta,
  freshnessStatus,
  loadInitialData,
  saveDeck,
  saveDraft,
  saveRunRecord,
  setFeaturedDeck,
  setOwnedCount,
  state
} from './data.mjs';
import { icon } from './icons.mjs';
import {
  executeBattleBatch,
  executeFixturePreviewBatch,
  fnv1a32,
  probeEngine,
  renderBattleReport,
  resolveOpponentLineup
} from './battle.mjs';
import {
  buildCardDetailModal,
  buildCatalogAuditModal,
  buildDeckShowcaseModal,
  buildMetaDetailModal,
  renderBattle,
  renderCatalog,
  renderCatalogGridHtml,
  renderDecks,
  renderDraftPanel,
  renderHome,
  renderMeta,
  renderSources,
  uiState
} from './views.mjs';

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

  if (action === 'reset-catalog-filters') {
    uiState.catalog = { ...uiState.catalog, q: '', set: '', type: '', kind: '', subtype: '', stage: '', rarity: '', page: 1 };
    renderRoute();
    return;
  }

  if (action === 'show-catalog-audit') {
    openModal('各系列收錄完備度', buildCatalogAuditModal());
    return;
  }

  if (action === 'own-delta') {
    const next = Math.max(0, (state.collection[id] || 0) + Number(el.dataset.delta || 0));
    await setOwnedCount(id, next);
    const valEl = document.getElementById('modal-own-val');
    if (valEl) valEl.textContent = String(next);
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
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${d.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showNotice('已匯出牌組 JSON');
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

  if (action === 'start-real-battle' || action === 'run-fixture-preview') {
    const isDemo = action === 'run-fixture-preview';
    const deck = state.decks.find((d) => d.id === uiState.battle.deckId) || state.decks[0];
    if (!deck) { showNotice('請先選擇或建立一套牌組'); return; }
    const lineup = resolveOpponentLineup(state.meta).selected;
    if (lineup.length < 10) { showNotice('目前不足 10 個有效對手'); return; }

    let run = state.runs.find((r) => r.runId === uiState.battle.activeRunId)
      || state.runs.find((r) => r.deckId === deck.id && r.season === state.meta?.season && Boolean(r.isDemo) === isDemo && r.events.length < 500);

    if (!run) {
      run = {
        runId: `run-${Date.now().toString(36)}`,
        deckId: deck.id,
        deckName: deck.name,
        season: state.meta?.season || 'C1',
        modelVersion: isDemo ? '展示樣板' : (state.modelInfo?.version || 'baseline-v0'),
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
        const weights = state.modelInfo?.weights || Array(22).fill(0);
        await executeBattleBatch({ run, deck, lineup, weights, onTick: updateView, signal: uiState.battle.abortCtrl.signal });
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
    if (deck) {
      const fresh = {
        runId: `run-${Date.now().toString(36)}`,
        deckId: deck.id,
        deckName: deck.name,
        season: state.meta?.season || 'C1',
        modelVersion: state.modelInfo?.version || 'baseline-v0',
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
      const weights = state.modelInfo?.weights || Array(22).fill(0);
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
  const btn = e.target.closest?.('[data-action]');
  if (btn) handleAction(btn);
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
  if (t.id === 'filter-set') { uiState.catalog.set = t.value; uiState.catalog.page = 1; renderRoute(); }
  else if (t.id === 'filter-kind') {
    uiState.catalog.kind = t.value;
    if (t.value === 'trainer') {
      uiState.catalog.stage = '';
      if (uiState.catalog.type && uiState.catalog.type !== 'trainer') uiState.catalog.type = '';
    } else if (t.value === 'pokemon') {
      if (uiState.catalog.type === 'trainer') uiState.catalog.type = '';
      uiState.catalog.subtype = '';
    } else if (uiState.catalog.type !== 'trainer') {
      uiState.catalog.subtype = '';
    }
    uiState.catalog.page = 1;
    renderRoute();
  }
  else if (t.id === 'filter-subtype') { uiState.catalog.subtype = t.value; uiState.catalog.page = 1; renderRoute(); }
  else if (t.id === 'filter-stage') { uiState.catalog.stage = t.value; uiState.catalog.page = 1; renderRoute(); }
  else if (t.id === 'filter-rarity') { uiState.catalog.rarity = t.value; uiState.catalog.page = 1; renderRoute(); }
  else if (t.id === 'battle-deck-select') { uiState.battle.deckId = t.value; uiState.battle.activeRunId = null; renderRoute(); }
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
    const parsed = readDeckFile(await file.text());
    const saved = await saveDeck({ id: crypto.randomUUID(), ...parsed });
    state.selectedDeckId = saved.id;
    renderRoute();
    showNotice(`已匯入「${saved.name}」`);
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

async function boot() {
  bindCardImageFallback(document);
  populateBottomNav();
  if (state.fixture) {
    const banner = document.getElementById('fixture-banner');
    if (banner) banner.hidden = false;
  }
  await Promise.all([loadInitialData(false), probeEngine()]);
  renderRoute();
}

boot().catch((err) => {
  mainEl.innerHTML = `<div class="panel"><h2>載入失敗</h2><p class="desc">${esc(err?.message || '未知錯誤')}</p></div>`;
});
