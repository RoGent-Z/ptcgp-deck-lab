import {
  deckFingerprint,
  DEEP_EXPLORE_GAMES,
  DEEP_GAMES_PER_OPPONENT,
  evaluateDeckOwnership,
  EXPLORE_GAMES_PER_OPPONENT,
  EXPLORE_TOTAL_GAMES,
  FIRST_SEAT_GAMES,
  GAMES_PER_OPPONENT,
  getPokemonCategories,
  getPokemonCategoryLabel,
  interval,
  matchesPokemonCategoryFilter,
  POKEMON_CATEGORY_GROUPS,
  titleCase,
  TOTAL_BATCH_GAMES,
  validateDeck
} from './core.mjs';
import { getCloudConfig, isCloudConfigured } from './cloud.mjs';
import {
  cardPrimaryTypes,
  esc,
  expandDeckCards,
  getDeckPokemonCandidates,
  getPokemonSpriteUrl,
  renderCardFace,
  renderCardImgTag,
  renderDeckMiniSlot,
  renderDeckShowcase,
  renderEnergyToken,
  renderPokemonSprites,
  resolveFeaturedPokemon,
  resolveType,
  sortDeckEntriesPtcgpDefault
} from './cardface.mjs';
import { findVariantsForCard, foldText, state } from './data.mjs';
import { icon } from './icons.mjs';
import { ensureCardCoverage, getUnsupportedCards, renderBattleReport, resolveOpponentLineup } from './battle.mjs';

function renderPokemonPicker(deck, mode = 'draft') {
  if (mode !== 'draft') return '';
  const candidates = getDeckPokemonCandidates(deck, state.cardsById, state.spriteMap);
  if (!candidates.length || state.cardsMissing) return '';
  const selected = resolveFeaturedPokemon(deck, state.cardsById, state.spriteMap);
  const selectedSet = new Set(selected.map((x) => x.slug));
  const action = 'toggle-draft-pokemon';
  const resetAction = 'reset-draft-pokemon';
  const hasExplicit = Array.isArray(deck?.featuredPokemon) && deck.featuredPokemon.length > 0;

  return `
    <div class="rep-picker-box">
      <div class="rep-picker-head">
        <span class="field-caption">代表寶可夢 ${selected.length}/3</span>
        ${hasExplicit ? `<button class="mini-reset" type="button" data-action="${resetAction}" data-id="${esc(deck?.id || '')}">恢復自動</button>` : ''}
      </div>
      <div class="rep-picker-chips" role="group" aria-label="代表寶可夢選擇">
        ${candidates.map((p) => {
          const active = selectedSet.has(p.slug);
          return `<button class="poke-pick ${active ? 'is-selected' : ''}" type="button" data-action="${action}" data-id="${esc(deck?.id || '')}" data-slug="${esc(p.slug)}" aria-pressed="${active}" title="${esc(p.name)}">
            <img class="poke-sprite" src="${esc(getPokemonSpriteUrl(p.slug))}" alt="${esc(p.name)}" decoding="async">
            <span>${esc(p.name)}</span>
          </button>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderValidationIssues(valid, issues, extraClass = '') {
  if (valid || !issues.length) return '';
  return `<div class="draft-validation ${extraClass} is-invalid"><ul class="val-issues">${issues.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
}

const ENERGY_ORDER = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
const FILTER_TYPES = ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal', 'colorless', 'dragon', 'trainer'];
const TRAINER_SUBTYPE_OPTIONS = [
  { id: 'item', label: '物品' },
  { id: 'supporter', label: '支援者' },
  { id: 'tool', label: '寶可夢道具' },
  { id: 'stadium', label: '競技場（場地）' },
  { id: 'fossil', label: '化石' }
];

export const uiState = {
  openSelect: null,
  catalog: {
    q: '',
    set: '',
    type: '',
    kind: '',
    subtype: '',
    pokeInclude: [],
    pokeExclude: [],
    pokeTagOpen: false,
    stage: '',
    rarity: '',
    owned: '',
    page: 1,
    perPage: 30
  },
  decks: { view: 'showcase' },
  meta: { sort: 'count', q: '', page: 1, perPage: 40 },
  battle: { deckId: null, modelId: null, running: false, activeRunId: null, abortCtrl: null },
  auth: { mode: 'login' }
};

function deckTotalCount(deck) {
  return (deck?.cards || []).reduce((s, c) => s + c.count, 0);
}

function getCardMapCount(deck) {
  const m = new Map();
  for (const item of deck?.cards || []) m.set(item.id, item.count);
  return m;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('zh-TW');
}

function renderShareBar(entry, maxShare, rank) {
  const sharePct = (entry.share * 100).toFixed(1);
  const barW = maxShare > 0 ? Math.min(100, (entry.share / maxShare) * 100).toFixed(1) : '0';
  const wr = entry.winRate != null ? (entry.winRate * 100).toFixed(1) + '%' : '—';
  const wrDelta = entry.winRate != null ? (entry.winRate - 0.5) * 100 : 0;
  const wrWidth = Math.min(50, Math.abs(wrDelta) * 2.5).toFixed(1);
  const tokens = (entry.representative?.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('');
  const repSprites = renderPokemonSprites(resolveFeaturedPokemon(entry.representative, state.cardsById, state.spriteMap), 'sm');
  const isTop10 = rank <= 10;

  return `
    <button class="meta-row ${isTop10 ? 'is-top10' : ''}" type="button" data-action="inspect-meta" data-id="${esc(entry.id)}">
      <span class="meta-rank ${rank === 1 ? 'is-first' : ''}">#${rank}</span>
      <span class="meta-main">
        <span class="meta-title-line">
          <span class="tokens-inline">${tokens}</span>
          ${repSprites}
          <strong class="meta-name">${esc(entry.name)}</strong>
          ${isTop10 ? '<span class="tag-opp">模擬對手</span>' : ''}
        </span>
        <span class="meta-sub">${entry.count} 套 · ${entry.wins}勝 ${entry.draws}和 ${entry.losses}敗 · 8強 ${entry.top8}</span>
      </span>
      <span class="meta-share">
        <span class="share-head"><span>使用率</span><b>${sharePct}%</b></span>
        <span class="share-track"><i style="width:${barW}%"></i></span>
      </span>
      <span class="meta-wr">
        <span class="wr-val ${wrDelta >= 0 ? 'is-pos' : 'is-neg'}">${wr}</span>
        <span class="wr-bias" aria-hidden="true">
          <i class="${wrDelta >= 0 ? 'is-right' : 'is-left'}" style="width:${wrWidth}%"></i>
        </span>
      </span>
      <span class="meta-crown">
        ${entry.champions > 0 ? `${icon('crown', 14)}<span>${entry.champions}</span>` : '<span class="muted">—</span>'}
      </span>
    </button>
  `;
}

function renderHomeShowcaseSection() {
  if (!state.decks.length || state.cardsMissing) return '';
  const deck = state.decks.find((d) => d.id === state.featuredDeckId) || state.decks[0];
  if (!deck) return '';
  const expanded = expandDeckCards(deck, state.cardsById);
  if (!expanded.length) return '';
  const tokens = (deck.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('');
  const sprites = renderPokemonSprites(resolveFeaturedPokemon(deck, state.cardsById, state.spriteMap), 'md');
  const thumbs = expanded.slice(0, 20).map((x) => x.card
    ? `<button class="home-mini-card" type="button" data-action="inspect-card" data-id="${esc(x.card.id)}" title="${esc(x.card.name)}">${renderCardImgTag(x.card, 'home-mini-img', false)}</button>`
    : `<span class="home-mini-card is-miss">${esc(x.id)}</span>`
  ).join('');

  return `
    <section class="block-section panel showcase-home-panel">
      <div class="section-head">
        <div>
          <div class="title-with-sprites">
            ${sprites}
            <h2>我的牌桌陳列 · ${esc(deck.name)}</h2>
          </div>
          <p class="sub">${tokens} ${expanded.length}/20 張</p>
        </div>
        <div class="actions">
          <button class="btn btn-outline" type="button" data-action="open-deck-showcase" data-id="${esc(deck.id)}">沉浸陳列預覽</button>
          <a class="text-link" href="#decks">管理我的牌組 →</a>
        </div>
      </div>
      <div class="home-showcase-strip">${thumbs}</div>
    </section>
  `;
}

// 1. 首頁 #home
export function renderHome() {
  const m = state.meta;
  const top10 = (m?.entries || []).slice(0, 10);
  const seasonLabel = m ? `${m.seasonName || m.season} ${m.season} · ${formatDate(m.releaseAt)} 起` : '等待賽事快照';
  const metrics = m
    ? [
        { num: m.events, lbl: '納入標準賽事' },
        { num: m.players?.toLocaleString('zh-TW'), lbl: '參賽人次' },
        { num: m.matches?.toLocaleString('zh-TW'), lbl: '有效對局數' },
        { num: (m.totalEntries || m.entries?.length || 0).toLocaleString('zh-TW'), lbl: '活躍牌組原型' }
      ]
    : [
        { num: '—', lbl: '納入標準賽事' },
        { num: '—', lbl: '參賽人次' },
        { num: '—', lbl: '有效對局數' },
        { num: '—', lbl: '活躍牌組原型' }
      ];

  const top10Cards = top10.map((entry, idx) => {
    const rank = idx + 1;
    const tokens = (entry.representative?.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('');
    const repSprites = renderPokemonSprites(resolveFeaturedPokemon(entry.representative, state.cardsById, state.spriteMap), 'sm');
    const share = (entry.share * 100).toFixed(1) + '%';
    const wr = entry.winRate != null ? (entry.winRate * 100).toFixed(1) + '%' : '—';
    const primaryEnergy = (entry.representative?.energy?.[0] || 'colorless').toLowerCase();
    return `
      <button class="top10-card" type="button" data-action="inspect-meta" data-id="${esc(entry.id)}" style="--deck-accent:var(--t-${primaryEnergy},var(--accent))">
        <div class="top10-head">
          <span class="top10-rank ${rank === 1 ? 'is-gold' : ''}">#${rank}</span>
          <span class="tokens-inline">${tokens}</span>
          ${entry.champions > 0 ? `<span class="top10-crown">${icon('crown', 13)}${entry.champions}</span>` : ''}
        </div>
        <div class="top10-name-row">
          ${repSprites}
          <strong class="top10-name">${esc(entry.name)}</strong>
        </div>
        <div class="top10-stats">
          <div><span>使用率</span><b>${share}</b></div>
          <div><span>賽事勝率</span><b>${wr}</b></div>
        </div>
      </button>
    `;
  }).join('');

  const top3Spec = top10.slice(0, 3).map((entry, idx) => {
    const repSprites = renderPokemonSprites(resolveFeaturedPokemon(entry.representative, state.cardsById, state.spriteMap), 'sm');
    return `<li><span class="spec-idx">0${idx + 1}</span>${repSprites}<span class="spec-name">${esc(entry.name)}</span><b>${(entry.share * 100).toFixed(1)}%</b></li>`;
  }).join('');

  return `
    <section class="hero">
      <div class="hero-copy">
        <span class="hero-season">${esc(seasonLabel)}</span>
        <h1>Pocket Lab</h1>
        <p class="hero-sub">Pokémon TCG Pocket 繁中卡牌圖鑑、牌組陳列與賽事環境工具。</p>
        <div class="actions">
          <a class="btn btn-hero-white" href="#catalog">開始組牌</a>
          <a class="btn btn-hero-ink" href="#meta">查看賽事環境</a>
        </div>
      </div>
      <div class="hero-spec" aria-label="當季環境摘要">
        <div class="hero-spec-head">
          <span class="swiss-code">目前使用率前三</span>
          <span class="swiss-code">${m ? `${m.season} 前三` : '—'}</span>
        </div>
        <ul class="hero-spec-list">
          ${top3Spec || '<li><span class="spec-idx">--</span><span class="spec-name">等待賽事環境快照載入</span></li>'}
        </ul>
        <div class="hero-spec-foot">
          <span>${state.cardsMissing ? '卡庫尚未載入' : `繁中圖鑑 ${state.cards.length.toLocaleString('zh-TW')} 張`}</span>
          <span>已存 ${state.decks.length} 套牌組</span>
        </div>
      </div>
    </section>

    <section class="metrics" aria-label="當季賽事統計">
      ${metrics.map((x) => `<div class="metric-cell"><strong class="metric-num">${esc(x.num)}</strong><span class="metric-lbl">${esc(x.lbl)}</span></div>`).join('')}
    </section>

    <section class="block-section panel">
      <div class="section-head">
        <div>
          <h2>目前使用率前十對手</h2>
          <p class="sub">${m ? `${formatDate(m.windowStart)} – ${formatDate(m.latestEvent)}` : '未載入'}</p>
        </div>
        <a class="text-link" href="#meta">查看全部 ${m?.totalEntries || m?.entries?.length || ''} 個原型 →</a>
      </div>
      ${top10Cards ? `<div class="top10-grid">${top10Cards}</div>` : '<div class="empty-box">暫無賽事快照，請點擊右上角「檢查更新」。</div>'}
    </section>

    ${renderHomeShowcaseSection()}

    <section class="entry-bento" aria-label="快速入口">
      <a class="entry-card is-wide" href="#catalog">
        <div class="entry-top">${icon('catalog', 20)}<strong>繁中卡牌圖鑑與組牌</strong></div>
        <p>${state.cardsMissing ? '卡庫尚未載入，可開啟 ?fixture=1 預覽介面。' : `已收錄 ${state.cards.length.toLocaleString('zh-TW')} 張繁中卡牌，支援簡繁名稱檢索與即時草稿編輯。`}</p>
        <span class="entry-go">進入圖鑑 →</span>
      </a>
      <a class="entry-card" href="#decks">
        <div class="entry-top">${icon('decks', 20)}<strong>我的牌組</strong></div>
        <p>已儲存 <b>${state.decks.length}</b> 套牌組，支援 5×4 完整陳列預覽與對戰測試。</p>
        <span class="entry-go">管理牌組 →</span>
      </a>
      <a class="entry-card" href="#battle">
        <div class="entry-top">${icon('battle', 20)}<strong>對戰測試</strong></div>
        <p>${state.engineReady ? '支援與目前賽事前十牌組進行批次對戰測試。' : '對戰模擬引擎籌備中，可先瀏覽前十賽事牌組清單。'}</p>
        <span class="entry-go">前往測試 →</span>
      </a>
    </section>
  `;
}

// 右側草稿面板（桌面側欄 & 手機抽屜共用）
export function renderDraftPanel() {
  const draft = state.draft || { name: '未命名牌組', cards: [], energy: [] };
  const total = deckTotalCount(draft);
  const issues = state.cardsMissing ? ['等待卡庫 cards.json 後執行完整合法性校驗'] : validateDeck(draft, state.cardsById);
  const valid = !state.cardsMissing && issues.length === 0;
  const draftSprites = renderPokemonSprites(resolveFeaturedPokemon(draft, state.cardsById, state.spriteMap), 'sm');

  const draftCards = draft.cards || [];
  const ownership = evaluateDeckOwnership(draft, state.collection, state.cardsById);

  let rowsHtml = '';
  for (let idx = 0; idx < draftCards.length; idx++) {
    const item = draftCards[idx];
    const card = state.cardsById.get(item.id);
    const color = card ? cardPrimaryTypes(card)[0].color : 'var(--text-faint)';
    const ownInfo = ownership.byEntryIndex[idx];
    const missHtml = state.showMissingBadges && ownInfo && ownInfo.missing > 0
      ? `<span class="miss-pill ${ownInfo.ownedForSlot === 0 ? 'is-none' : 'is-short'}">${ownInfo.ownedForSlot === 0 ? '未持有' : `缺 ${ownInfo.missing}`}</span>`
      : '';
    rowsHtml += `
      <li class="draft-row" draggable="true" data-id="${esc(item.id)}">
        <span class="draft-bar" style="background:${color}"></span>
        <div class="draft-reorder">
          <button type="button" data-action="move-draft-card" data-id="${esc(item.id)}" data-dir="-1" aria-label="上移 ${esc(card?.name || item.id)}" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" data-action="move-draft-card" data-id="${esc(item.id)}" data-dir="1" aria-label="下移 ${esc(card?.name || item.id)}" ${idx === draftCards.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <button class="draft-card-btn" type="button" data-action="inspect-card" data-id="${esc(item.id)}">
          <span class="draft-card-name">${esc(card?.name || item.id)}</span>
          <small class="draft-card-id">${esc(item.id)}${missHtml}</small>
        </button>
        <div class="draft-stepper">
          <button type="button" data-action="remove-card" data-id="${esc(item.id)}" aria-label="減少 ${esc(card?.name || item.id)}">−</button>
          <span class="draft-qty">${item.count}</span>
          <button type="button" data-action="add-card" data-id="${esc(item.id)}" aria-label="增加 ${esc(card?.name || item.id)}">+</button>
        </div>
      </li>
    `;
  }

  const energyButtons = ENERGY_ORDER.map((en) => {
    const active = (draft.energy || []).some((e) => titleCase(e) === en);
    const zh = resolveType(en).zh;
    return `<button class="energy-pick ${active ? 'is-selected' : ''}" type="button" data-action="toggle-draft-energy" data-energy="${en}" aria-pressed="${active}" aria-label="${esc(zh)}">${renderEnergyToken(en, 'lg')}</button>`;
  }).join('');

  return `
    <div class="draft-head">
      <div class="draft-head-top">
        <div class="title-with-sprites">
          <span>目前草稿</span>
          ${draftSprites}
        </div>
        <div class="draft-head-right">
          ${draftCards.length > 1 ? '<button class="mini-pill" type="button" data-action="sort-draft-default" title="依 PTCG Pocket 預設順序整理">預設排序</button>' : ''}
          <button class="mini-pill" type="button" data-action="open-draft-showcase" title="展開 20 張牌桌陳列牆">完整預覽</button>
          <strong class="draft-count ${total === 20 ? 'is-full' : ''}">${total}<small>/20</small></strong>
        </div>
      </div>
      <div class="progress-track is-slim"><i style="width:${Math.min(100, (total / 20) * 100)}%"></i></div>
    </div>
    <div class="draft-body">
      <label class="field-label">
        <span>牌組名稱</span>
        <input id="draft-name" type="text" maxlength="150" value="${esc(draft.name)}" placeholder="輸入牌組名稱">
      </label>
      <div class="draft-energy-box">
        <span class="field-caption">能量區（1–3 種）</span>
        <div class="energy-picker">${energyButtons}</div>
      </div>
      ${renderPokemonPicker(draft, 'draft')}
      ${draftCards.length
        ? `<ul class="draft-list">${rowsHtml}</ul>`
        : '<div class="empty-box is-compact">點擊左側卡牌上的 <b>+</b> 加入草稿。</div>'}
      ${renderValidationIssues(valid, issues)}
      <div class="draft-actions">
        <button class="btn btn-primary" type="button" data-action="save-draft">儲存牌組</button>
        <button class="btn btn-outline" type="button" data-action="new-draft">清空新建</button>
        <button class="btn btn-outline is-full-row" type="button" data-action="draft-to-battle">用此牌組對戰測試 →</button>
      </div>
    </div>
  `;
}

export function filterCatalogCards() {
  const f = uiState.catalog;
  const qFold = foldText(f.q);
  return state.cards.filter((c) => {
    if (f.set && c.set !== f.set) return false;
    if (f.kind && c.type !== f.kind) return false;
    if (f.subtype && (c.type !== 'trainer' || String(c.subtype || '').toLowerCase() !== f.subtype)) return false;
    if ((f.pokeInclude.length || f.pokeExclude.length) && !matchesPokemonCategoryFilter(c, f.pokeInclude, f.pokeExclude)) {
      return false;
    }
    if (f.stage && c.stage !== f.stage) return false;
    if (f.rarity && c.rarity !== f.rarity) return false;
    if (f.type) {
      if (f.type === 'trainer') {
        if (c.type !== 'trainer') return false;
      } else if (!(c.types || []).some((t) => String(t).toLowerCase() === f.type)) {
        return false;
      }
    }
    if (f.owned) {
      const cnt = Number(state.collection?.[c.id] || 0);
      if (f.owned === 'missing' && cnt !== 0) return false;
      if (f.owned === 'short' && cnt >= 2) return false;
      if (f.owned === 'owned' && cnt <= 0) return false;
    }
    if (qFold && !c._search.includes(qFold)) return false;
    return true;
  });
}

export function renderSwissSelect({
  id,
  title,
  value = '',
  options = [],
  followUp = false,
  columns = 1,
  disabled = false,
  fullWidth = false
}) {
  const activeOpt = options.find((o) => String(o.value) === String(value)) || options[0];
  const isOpen = uiState.openSelect === id;
  const hasValue = Boolean(value);
  return `
    <div class="swiss-select-wrap ${fullWidth ? 'is-full' : ''}" data-select-wrap="${esc(id)}">
      <button
        type="button"
        id="${esc(id)}"
        class="tag-picker-btn swiss-select-btn ${followUp ? 'select-followup' : ''} ${hasValue ? 'has-active' : ''} ${fullWidth ? 'is-full' : ''}"
        data-action="toggle-swiss-select"
        data-select-id="${esc(id)}"
        aria-haspopup="listbox"
        aria-expanded="${isOpen ? 'true' : 'false'}"
        aria-controls="${esc(id)}-popover"
        ${disabled ? 'disabled' : ''}
      >
        <span class="swiss-select-val">${esc(activeOpt?.label || title || '請選擇')}</span>
        <span class="tag-picker-caret" aria-hidden="true">▾</span>
      </button>
      <div
        id="${esc(id)}-popover"
        class="tag-picker-popover swiss-select-popover ${columns > 1 ? 'is-wide' : ''}"
        role="listbox"
        aria-label="${esc(title)}"
        ${isOpen ? '' : 'hidden'}
      >
        <div class="tag-pop-head">
          <strong>${esc(title)}</strong>
          <button class="mini-reset" type="button" data-action="close-swiss-select">關閉</button>
        </div>
        <div class="swiss-select-list ${columns > 1 ? 'is-grid-2' : ''}">
          ${options.map((o) => {
            const selected = String(o.value) === String(value);
            return `
              <button
                type="button"
                class="swiss-opt ${selected ? 'is-selected' : ''}"
                data-action="pick-swiss-select"
                data-select-id="${esc(id)}"
                data-value="${esc(o.value)}"
                role="option"
                aria-selected="${selected ? 'true' : 'false'}"
              >
                <span class="swiss-opt-mark" aria-hidden="true">${selected ? '✓' : ''}</span>
                <span class="swiss-opt-label">${esc(o.label)}</span>
              </button>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

export function renderPokeTagTriggerLabel(f = uiState.catalog) {
  const incCount = f.pokeInclude.length;
  const excCount = f.pokeExclude.length;
  if (!incCount && !excCount) return '寶可夢分類';
  if (incCount === 1 && !excCount) return `✓ ${getPokemonCategoryLabel(f.pokeInclude[0])}`;
  if (!incCount && excCount === 1) return `✕ 非${getPokemonCategoryLabel(f.pokeExclude[0])}`;
  const parts = [];
  if (incCount) parts.push(`✓${incCount}`);
  if (excCount) parts.push(`✕${excCount}`);
  return `分類 ${parts.join(' ')}`;
}

export function renderPokeTagPopoverBody(f = uiState.catalog) {
  const incSet = new Set(f.pokeInclude);
  const excSet = new Set(f.pokeExclude);
  return `
    <div class="tag-pop-head">
      <span class="tag-pop-legend">
        <span class="legend-chip is-inc">✓ 包含</span>
        <span class="legend-chip is-exc">✕ 排除</span>
        <span class="muted">再點取消</span>
      </span>
      <span class="tag-pop-actions">
        ${(f.pokeInclude.length || f.pokeExclude.length) ? '<button class="mini-reset" type="button" data-action="clear-poke-tags">清空</button>' : ''}
        <button class="mini-reset" type="button" data-action="close-swiss-select">完成</button>
      </span>
    </div>
    ${POKEMON_CATEGORY_GROUPS.map((g) => `
      <div class="tag-pop-group">
        <div class="tag-pop-title">${esc(g.group)}${g.combine === 'any' ? ' <small>(複選並集)</small>' : ''}</div>
        <div class="tag-pop-grid">
          ${g.options.map((o) => {
            const isInc = incSet.has(o.id);
            const isExc = excSet.has(o.id);
            const stateCls = isInc ? 'is-include' : (isExc ? 'is-exclude' : '');
            const mark = isInc ? '✓ ' : (isExc ? '✕ ' : '');
            return `<button class="tag-tri-btn ${stateCls}" type="button" data-action="cycle-poke-tag" data-tag="${esc(o.id)}" aria-pressed="${isInc ? 'true' : (isExc ? 'mixed' : 'false')}">${mark}${esc(o.label)}</button>`;
          }).join('')}
        </div>
      </div>
    `).join('')}
  `;
}

export function renderCatalogGridHtml() {
  if (state.cardsMissing) {
    return `
      <div class="empty-box is-dashed">
        <strong>卡庫暫未載入</strong>
        <p>未能讀取到卡牌資料檔案，請點擊右上角「檢查更新」重試。</p>
        <div class="actions">
          <a class="btn btn-primary" href="?fixture=1#catalog">開啟展示樣板</a>
          <a class="btn btn-outline" href="#meta">查看賽事環境</a>
        </div>
      </div>
    `;
  }

  const filtered = filterCatalogCards();
  const f = uiState.catalog;
  const totalPages = Math.max(1, Math.ceil(filtered.length / f.perPage));
  f.page = Math.min(Math.max(1, f.page), totalPages);
  const start = (f.page - 1) * f.perPage;
  const slice = filtered.slice(start, start + f.perPage);
  const inDeckMap = getCardMapCount(state.draft);

  if (slice.length === 0) {
    return `<div class="empty-box is-dashed">
      <strong>沒有符合的卡牌</strong>
      <p>請試著清空篩選條件，或輸入簡/繁體卡名、卡號（如 A1-001 / C1-005）。</p>
      <button class="btn btn-outline" type="button" data-action="reset-catalog-filters">重設篩選</button>
    </div>`;
  }

  return `
    <div class="catalog-meta-bar">
      <span>符合 <b>${filtered.length}</b> 張卡牌（第 ${f.page} / ${totalPages} 頁）</span>
      <div class="actions">
        <button class="text-link" type="button" data-action="open-collection-tools">批次管理收藏</button>
        ${state.catalog ? `<button class="text-link" type="button" data-action="show-catalog-audit">查看系列收錄完備度 →</button>` : ''}
      </div>
    </div>
    <div class="card-grid">
      ${slice.map((c) => renderCardFace(c, {
        showDeckAction: true,
        inDeckCount: inDeckMap.get(c.id) || 0,
        ownedCount: state.collection?.[c.id] || 0,
        showMissing: state.showMissingBadges
      })).join('')}
    </div>
    <div class="pager">
      <button class="btn btn-outline" type="button" data-action="catalog-page" data-page="${f.page - 1}" ${f.page <= 1 ? 'disabled' : ''}>上一頁</button>
      <span class="pager-num">第 ${f.page} / ${totalPages} 頁</span>
      <button class="btn btn-outline" type="button" data-action="catalog-page" data-page="${f.page + 1}" ${f.page >= totalPages ? 'disabled' : ''}>下一頁</button>
    </div>
  `;
}

// 2. 卡牌圖鑑 #catalog
export function renderCatalog() {
  const f = uiState.catalog;
  const sets = state.catalog?.sets || [...new Set(state.cards.map((c) => c.set).filter(Boolean))].map((id) => ({ id, name: id }));
  const rarities = [...new Set(state.cards.map((c) => c.rarity).filter(Boolean))];

  const typeChips = FILTER_TYPES.map((t) => {
    const active = f.type === t;
    const meta = resolveType(t);
    return `<button class="chip-filter ${active ? 'is-active' : ''}" type="button" data-action="catalog-type" data-type="${t}" aria-label="${esc(meta.zh)}" title="${esc(meta.zh)}">${renderEnergyToken(t, 'sm')}</button>`;
  }).join('');

  return `
    <div class="page-head">
      <h1>卡牌圖鑑</h1>
      <p class="desc">支援簡繁名稱、卡號與招式效果檢索。</p>
    </div>
    <div class="catalog-layout">
      <div class="catalog-main panel">
        <div class="search-box">
          ${icon('search', 18)}
          <input id="catalog-q" type="search" value="${esc(f.q)}" placeholder="搜尋卡名（支援簡體/繁中）、卡號、招式或效果…" autocomplete="off">
        </div>
        <div class="filter-bar">
          <div class="chip-row" role="group" aria-label="屬性篩選">
            <button class="chip-filter ${!f.type ? 'is-active' : ''}" type="button" data-action="catalog-type" data-type="">全部屬性</button>
            ${typeChips}
          </div>
          <div class="select-row">
            ${renderSwissSelect({
              id: 'filter-set',
              title: '選擇卡包系列',
              value: f.set,
              columns: 2,
              options: [
                { value: '', label: '全部系列' },
                ...sets.map((s) => ({ value: s.id, label: `${s.id} ${s.name || ''}`.trim() }))
              ]
            })}
            ${renderSwissSelect({
              id: 'filter-kind',
              title: '選擇卡牌類別',
              value: f.kind,
              options: [
                { value: '', label: '全部類別' },
                { value: 'pokemon', label: '寶可夢' },
                { value: 'trainer', label: '訓練家' }
              ]
            })}
            ${(f.kind === 'trainer' || f.type === 'trainer') ? `
              ${renderSwissSelect({
                id: 'filter-subtype',
                title: '選擇訓練家子類',
                value: f.subtype,
                followUp: true,
                options: [
                  { value: '', label: '全部訓練家' },
                  ...TRAINER_SUBTYPE_OPTIONS.map((o) => ({ value: o.id, label: o.label }))
                ]
              })}
            ` : `
              ${renderSwissSelect({
                id: 'filter-stage',
                title: '選擇進化階段',
                value: f.stage,
                followUp: f.kind === 'pokemon',
                options: [
                  { value: '', label: '全部階段' },
                  { value: 'basic', label: '基礎' },
                  { value: 'stage1', label: '1階進化' },
                  { value: 'stage2', label: '2階進化' }
                ]
              })}
              <div class="tag-picker-wrap">
                <button
                  type="button"
                  id="poke-tag-trigger"
                  class="tag-picker-btn ${(f.kind === 'pokemon' || f.pokeInclude.length || f.pokeExclude.length) ? 'select-followup' : ''} ${(f.pokeInclude.length || f.pokeExclude.length) ? 'has-active' : ''}"
                  data-action="toggle-poke-popover"
                  aria-expanded="${f.pokeTagOpen ? 'true' : 'false'}"
                  aria-controls="poke-tag-popover"
                >
                  <span id="poke-tag-trigger-text">${esc(renderPokeTagTriggerLabel(f))}</span>
                  <span class="tag-picker-caret" aria-hidden="true">▾</span>
                </button>
                <div id="poke-tag-popover" class="tag-picker-popover" ${f.pokeTagOpen ? '' : 'hidden'}>
                  ${renderPokeTagPopoverBody(f)}
                </div>
              </div>
            `}
            ${renderSwissSelect({
              id: 'filter-rarity',
              title: '選擇稀有度',
              value: f.rarity,
              columns: 2,
              options: [
                { value: '', label: '全部稀有度' },
                ...rarities.map((r) => ({ value: r, label: r }))
              ]
            })}
            ${renderSwissSelect({
              id: 'filter-owned',
              title: '選擇持有狀態',
              value: f.owned,
              options: [
                { value: '', label: '全部持有狀態' },
                { value: 'missing', label: '遊戲內未持有 (0 張)' },
                { value: 'short', label: '未滿編 (< 2 張)' },
                { value: 'owned', label: '已持有 (≥ 1 張)' }
              ]
            })}
          </div>
        </div>
        <div id="catalog-results">${renderCatalogGridHtml()}</div>
      </div>
      <aside class="draft-sidebar panel" id="draft-sidebar" aria-label="草稿牌組編輯器">
        ${renderDraftPanel()}
      </aside>
    </div>
  `;
}

// 3. 我的牌組 #decks
export function renderDecks() {
  const selected = state.decks.find((d) => d.id === state.selectedDeckId) || state.decks[0] || null;
  if (selected && state.selectedDeckId !== selected.id) state.selectedDeckId = selected.id;

  const listHtml = state.decks.map((d) => {
    const cnt = deckTotalCount(d);
    const active = selected?.id === d.id;
    const isFeatured = state.featuredDeckId === d.id;
    const tokens = (d.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('');
    const repSprites = renderPokemonSprites(resolveFeaturedPokemon(d, state.cardsById, state.spriteMap), 'sm');
    return `
      <button class="saved-deck-item ${active ? 'is-active' : ''}" type="button" data-action="select-deck" data-id="${esc(d.id)}">
        <span class="saved-top">
          <span class="saved-title-wrap">
            ${repSprites}
            <strong>${esc(d.name)}</strong>
          </span>
          <span class="saved-cnt ${cnt === 20 ? 'is-ok' : ''}">${cnt}/20</span>
        </span>
        <span class="saved-bottom">
          <span class="tokens-inline">${tokens || '<small class="muted">未選能量</small>'}${isFeatured ? '<span class="tag-opp">首頁陳列</span>' : ''}</span>
          <small class="muted">${formatDate(d.updatedAt)}</small>
        </span>
      </button>
    `;
  }).join('');

  let detailHtml = '';
  if (!selected) {
    detailHtml = `<div class="empty-box is-dashed">
      <strong>還沒有已儲存的牌組</strong>
      <p>你可以前往「卡牌圖鑑」組建並儲存草稿、匯入 JSON 牌表，或從「賽事環境」複製一套代表構築。</p>
      <div class="actions">
        <a class="btn btn-primary" href="#catalog">前往圖鑑組牌</a>
        <button class="btn btn-outline" type="button" data-action="import-deck-trigger">匯入 JSON 牌表</button>
      </div>
    </div>`;
  } else {
    const expanded = (selected.cards || []).map((entry) => ({
      ...entry,
      card: state.cardsById.get(entry.id)
    }));
    const slotsCount = expanded.reduce((s, e) => s + e.count, 0);
    const emptySlots = Math.max(0, 20 - slotsCount);
    const issues = state.cardsMissing ? ['等待卡庫後校驗'] : validateDeck(selected, state.cardsById);
    const isValid = !state.cardsMissing && issues.length === 0;
    const pkCount = expanded.filter((x) => x.card?.type === 'pokemon').reduce((s, x) => s + x.count, 0);
    const trCount = expanded.filter((x) => x.card?.type === 'trainer').reduce((s, x) => s + x.count, 0);
    const isFeatured = state.featuredDeckId === selected.id;
    const isShowcase = uiState.decks.view === 'showcase';

    const featuredList = resolveFeaturedPokemon(selected, state.cardsById, state.spriteMap);
    const detailSprites = renderPokemonSprites(featuredList, 'lg');
    const ownership = evaluateDeckOwnership(selected, state.collection, state.cardsById);
    const ownSummaryText = state.showMissingBadges && slotsCount > 0
      ? (ownership.totalMissing > 0 ? ` · 缺 ${ownership.totalMissing} 張未持有` : ' · 已集齊')
      : '';

    const viewBody = isShowcase
      ? renderDeckShowcase(selected, state.cardsById, {
          valid: isValid,
          spriteMap: state.spriteMap,
          featuredPokemon: featuredList,
          collection: state.collection,
          showMissing: state.showMissingBadges
        })
      : `<div class="slot-grid">
          ${expanded.map((e, i) => renderDeckMiniSlot(e.card, e.count, e.id, {
            showMissing: state.showMissingBadges,
            missingCount: ownership.byEntryIndex[i]?.missing || 0,
            ownedForSlot: ownership.byEntryIndex[i]?.ownedForSlot || 0
          })).join('')}
          ${Array.from({ length: emptySlots }, () => '<div class="deck-slot is-empty"><span>空位</span></div>').join('')}
        </div>`;

    detailHtml = `
      <div class="deck-detail-head">
        <div class="deck-title-edit">
          <div class="deck-title-input-row">
            ${detailSprites}
            <input id="deck-rename-input" class="deck-name-input" type="text" maxlength="150" value="${esc(selected.name)}" data-deck-id="${esc(selected.id)}" aria-label="牌組名稱">
          </div>
          <p class="sub">共 ${slotsCount} 張（寶可夢 ${pkCount} · 訓練家 ${trCount}${ownSummaryText}） · 更新於 ${formatDate(selected.updatedAt)}</p>
        </div>
        <div class="deck-head-right">
          <button class="mini-pill ${state.showMissingBadges ? 'is-on' : ''}" type="button" data-action="toggle-missing-badges" title="切換顯示或隱藏未持有卡牌標記">${state.showMissingBadges ? '缺卡標記：開' : '缺卡標記：關'}</button>
          <div class="seg-group" role="group" aria-label="牌組檢視方式">
            <button class="seg-btn ${isShowcase ? 'is-active' : ''}" type="button" data-action="set-decks-view" data-view="showcase">完整陳列 (5×4)</button>
            <button class="seg-btn ${!isShowcase ? 'is-active' : ''}" type="button" data-action="set-decks-view" data-view="compact">精簡清單</button>
          </div>
          <div class="tokens-inline">${(selected.energy || []).map((e) => renderEnergyToken(e, 'md')).join('')}</div>
        </div>
      </div>
      <div class="actions spaced block-gap">
        <div class="actions">
          <button class="btn btn-primary" type="button" data-action="open-deck-showcase" data-id="${esc(selected.id)}">沉浸大螢幕預覽</button>
          <button class="btn btn-outline" type="button" data-action="deck-to-battle" data-id="${esc(selected.id)}">${icon('battle', 16)}前往對戰測試</button>
          <button class="btn btn-outline" type="button" data-action="load-to-draft" data-id="${esc(selected.id)}">載入至草稿編輯</button>
          <button class="btn btn-outline" type="button" data-action="feature-deck" data-id="${esc(selected.id)}">${isFeatured ? '★ 已陳列於首頁' : '☆ 設為首頁陳列'}</button>
          <button class="btn btn-outline" type="button" data-action="duplicate-deck" data-id="${esc(selected.id)}">${icon('copy', 15)}複製</button>
          <button class="btn btn-outline" type="button" data-action="export-deck" data-id="${esc(selected.id)}">${icon('download', 15)}匯出 JSON</button>
        </div>
        <button class="btn btn-danger" type="button" data-action="delete-deck" data-id="${esc(selected.id)}">刪除</button>
      </div>
      <div class="block-gap">${viewBody}</div>
      ${renderValidationIssues(isValid, issues, 'block-gap')}
    `;
  }

  return `
    <div class="page-head">
      <h1>我的牌組</h1>
    </div>
    <div class="decks-layout">
      <aside class="panel decks-list-col">
        <div class="actions block-gap">
          <button class="btn btn-primary" type="button" data-action="create-empty-deck">+ 新增空白</button>
          <button class="btn btn-outline" type="button" data-action="import-deck-trigger">${icon('upload', 15)}匯入 JSON</button>
        </div>
        <div class="saved-deck-list">
          ${listHtml || '<div class="empty-box is-compact">尚無本地牌組</div>'}
        </div>
      </aside>
      <section class="panel decks-detail-col">${detailHtml}</section>
    </div>
  `;
}

// 4. 賽事環境 #meta
export function renderMeta() {
  const m = state.meta;
  if (!m) {
    return `<div class="page-head"><h1>賽事環境排行</h1></div><div class="empty-box is-dashed">尚未載入賽事快照（<code>public/data/meta.json</code>）。</div>`;
  }
  const f = uiState.meta;
  const qFold = foldText(f.q);
  let list = [...(m.entries || [])];

  // 紀錄原始使用率排名（前十作為對戰對手基準）
  const usageRank = new Map();
  (m.entries || []).forEach((e, idx) => usageRank.set(e.id, idx + 1));

  if (f.sort === 'winRate') {
    list.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.count - a.count);
  } else if (f.sort === 'champions') {
    list.sort((a, b) => b.champions - a.champions || b.count - a.count);
  } else if (f.sort === 'top8') {
    list.sort((a, b) => b.top8 - a.top8 || b.count - a.count);
  }

  if (qFold) {
    list = list.filter((e) => (e._search || foldText(`${e.name} ${e.nameEn || ''} ${e.id}`)).includes(qFold));
  }

  const maxShare = Math.max(0.01, ...(m.entries || []).map((e) => e.share || 0));
  const totalPages = Math.max(1, Math.ceil(list.length / f.perPage));
  f.page = Math.min(Math.max(1, f.page), totalPages);
  const slice = list.slice((f.page - 1) * f.perPage, f.page * f.perPage);

  const sortButtons = [
    { id: 'count', label: '參賽使用率' },
    { id: 'winRate', label: '賽事勝率' },
    { id: 'champions', label: '冠軍次數' },
    { id: 'top8', label: '八強次數' }
  ].map((s) => `<button class="seg-btn ${f.sort === s.id ? 'is-active' : ''}" type="button" data-action="meta-sort" data-sort="${s.id}">${s.label}</button>`).join('');

  return `
    <div class="page-head">
      <h1>賽事環境 · ${esc(m.seasonName || m.season)}</h1>
      <p class="desc">${formatDate(m.windowStart)} – ${formatDate(m.latestEvent)} · 共 ${m.events} 場賽事、${m.players?.toLocaleString('zh-TW')} 人次、${m.matches?.toLocaleString('zh-TW')} 場對局。</p>
    </div>

    <div class="panel">
      <div class="meta-toolbar">
        <div class="seg-group" role="group" aria-label="排行榜排序方式">${sortButtons}</div>
        <div class="search-box is-inline">
          ${icon('search', 16)}
          <input id="meta-q" type="search" value="${esc(f.q)}" placeholder="篩選原型名稱…" autocomplete="off">
        </div>
      </div>

      ${m.truncated ? `<div class="status-note">目前僅顯示使用率前 ${m.entries.length} 個原型（共 ${m.totalEntries} 個）。<button class="text-link" type="button" data-action="load-full-meta">載入全部 ${m.totalEntries} 個原型 →</button></div>` : ''}

      <div class="meta-table-head">
        <span>排名</span><span>牌組原型</span><span>使用率佔比</span><span>賽事勝率（對比 50%）</span><span>冠軍</span>
      </div>
      <div class="meta-list">
        ${slice.length ? slice.map((e) => renderShareBar(e, maxShare, usageRank.get(e.id) || 999)).join('') : '<div class="empty-box">沒有符合的原型</div>'}
      </div>

      <div class="pager">
        <button class="btn btn-outline" type="button" data-action="meta-page" data-page="${f.page - 1}" ${f.page <= 1 ? 'disabled' : ''}>上一頁</button>
        <span class="pager-num">第 ${f.page} / ${totalPages} 頁 · 共 ${list.length} 個原型</span>
        <button class="btn btn-outline" type="button" data-action="meta-page" data-page="${f.page + 1}" ${f.page >= totalPages ? 'disabled' : ''}>下一頁</button>
      </div>
    </div>
  `;
}

function renderTrainingBenchmarkSection() {
  const manifest = state.modelManifest;
  const bench = manifest?.benchmark;
  if (!bench) return '';
  const mirror = bench.mirror;
  const cardEval = bench.cardPoolEvaluated || {};
  const vsBase = bench.vsBaseline || {};
  const mirrorWrText = mirror?.winRate != null ? (mirror.winRate * 100).toFixed(2) + '%' : '—';
  const mirrorScoreText = mirror?.score != null ? (mirror.score * 100).toFixed(2) + '%' : '—';
  const baseScoreText = vsBase?.score != null ? (vsBase.score * 100).toFixed(2) + '%' : '—';
  const rankRows = (mirror?.byRank || []).map((r) => `
    <tr>
      <td class="num">#${r.rank}</td>
      <td>${esc(r.name)}</td>
      <td class="num">${r.total || 500}</td>
      <td class="num">${r.wins}/${r.draws}/${r.losses}</td>
      <td class="num"><strong>${(r.winRate * 100).toFixed(1)}%</strong></td>
      <td class="num">${r.first ? `${r.first.wins}/${r.first.draws}/${r.first.losses}` : '—'}</td>
      <td class="num">${r.second ? `${r.second.wins}/${r.second.draws}/${r.second.losses}` : '—'}</td>
    </tr>
  `).join('');

  return `
    <details class="panel block-gap bench-details">
      <summary class="bench-summary">
        <div>
          <h2>C1-V3 千萬局全卡池訓練與 10×500 局（5,000 局）基準參考</h2>
          <p class="sub">主力模型 <b>selfplay-cem-v3</b>（新增 <b>${(bench.trainedGamesV3 || 11645480).toLocaleString('zh-TW')}</b> 局 · 累計 <b>${(bench.cumulativeGamesV3 || 11737640).toLocaleString('zh-TW')}</b> 局 · 全 <b>${cardEval.totalDistinctCards || 4577}</b> 張卡每張 ≥<b>${(cardEval.minGamesPerCard || 1200).toLocaleString('zh-TW')}</b> 局 / ≥<b>${(cardEval.minDecisionsPerCard || 2400).toLocaleString('zh-TW')}</b> 次決策考量）</p>
        </div>
        <span class="bench-toggle">展開檢視明細</span>
      </summary>
      <div class="bench-body">
        <div class="bench-cards">
          <div class="bench-card">
            <span class="comp-label">千萬局全卡池訓練與留出驗證（V3 vs V0）</span>
            <strong>${(bench.trainedGamesV3 || 11645480).toLocaleString('zh-TW')} 局訓練 · 對基線得分率 ${baseScoreText}</strong>
            <small>第一階段全卡池 ${cardEval.totalDistinctCards || 4577} 張卡各進行 ${cardEval.minGamesPerCard || 1200} 局完整對局（549.24 萬局，累計 ${(cardEval.totalCardDecisionEvaluations || 10984800).toLocaleString('zh-TW')} 次單卡決策評估），第二階段 48 輪 CEM 聯賽自對弈 614.4 萬局，第三階段於 DeckGym 精確規則引擎 2,160 局留出測試取得 ${vsBase.wins || 1314}勝 ${vsBase.draws || 32}和 ${vsBase.losses || 814}敗（${baseScoreText}，超越 V1 的 60.62% 與 V2 的 58.77%）。</small>
          </div>
          <div class="bench-card">
            <span class="comp-label">榜首對前十 10×500 局（5,000 局完整流程）基準</span>
            <strong>${mirrorWrText} 勝率 · ${mirrorScoreText} 積分（${mirror?.wins || 0}勝 ${mirror?.draws || 0}和 ${mirror?.losses || 0}敗）</strong>
            <small>代表牌組：${esc(mirror?.playerDeck?.name || '超級噴火龍Yex · 炎帝ex')}（雙方均使用 V3 權重，每個對手固定進行先攻 250 局 + 後攻 250 局 = 500 局完整流程對局）。</small>
          </div>
        </div>
        ${rankRows ? `
          <div class="bench-table-wrap">
            <table class="bench-table">
              <thead>
                <tr><th>排名</th><th>對手原型</th><th>局數</th><th>勝/和/敗</th><th>對戰勝率</th><th>先攻 250 局</th><th>後攻 250 局</th></tr>
              </thead>
              <tbody>${rankRows}</tbody>
            </table>
          </div>` : ''}
      </div>
    </details>
  `;
}

// 5. 對戰測試 #battle
export function renderBattle() {
  const m = state.meta;
  const decks = state.decks;
  const selectedDeck = decks.find((d) => d.id === uiState.battle.deckId) || decks[0] || null;
  if (selectedDeck && uiState.battle.deckId !== selectedDeck.id) uiState.battle.deckId = selectedDeck.id;

  const modelList = state.modelManifest?.models || [];
  const defaultModelId = state.modelManifest?.defaultModelId || 'v3';
  if (!uiState.battle.modelId || (modelList.length && !state.modelsById.has(uiState.battle.modelId))) {
    uiState.battle.modelId = state.modelsById.has(defaultModelId) ? defaultModelId : (modelList[0]?.id || 'current');
  }
  const activeModel = state.modelsById.get(uiState.battle.modelId) || state.modelInfo;
  const activeModelMeta = activeModel?.metaEntry || modelList.find((x) => x.id === uiState.battle.modelId) || null;
  const activeModelVersion = activeModel?.version || 'selfplay-cem-v3';

  if (state.engineReady && state.runtimeFn) {
    const coverIds = [
      ...(m?.entries || []).slice(0, 20).flatMap((e) => (e.representative?.cards || []).map((c) => c.id)),
      ...(selectedDeck?.cards || []).map((c) => c.id)
    ];
    ensureCardCoverage(coverIds);
  }

  const lineup = resolveOpponentLineup(m, state.coverageMap);
  const deckIssues = selectedDeck && !state.cardsMissing ? validateDeck(selectedDeck, state.cardsById) : [];
  const unsupportedDeckCards = selectedDeck ? getUnsupportedCards(selectedDeck.cards) : [];
  const deckLegal = selectedDeck && (state.cardsMissing || deckIssues.length === 0) && deckTotalCount(selectedDeck) === 20;
  const engineSupported = unsupportedDeckCards.length === 0;

  // 匹配相同牌組 + 賽季 + 策略模型的測試紀錄（支援斷點續跑）
  const activeRun = (uiState.battle.activeRunId && state.runs.find((r) => r.runId === uiState.battle.activeRunId && r.deckId === selectedDeck?.id && (r.isDemo || r.modelVersion === activeModelVersion)))
    || (selectedDeck && state.runs.find((r) => r.deckId === selectedDeck.id && r.season === m?.season && !r.isDemo && r.modelVersion === activeModelVersion))
    || null;

  const cardEvalCount = activeModel?.cardPoolEvaluated?.totalDistinctCards;
  const modelBadge = activeModel
    ? `${activeModelVersion} · 訓練 ${(activeModel.cumulativeTrainingGames || activeModel.trainedGames || 0).toLocaleString('zh-TW')} 局${cardEvalCount ? ` · 全 ${cardEvalCount} 卡千次評估` : ''}${activeModelMeta?.vsBaseline?.score ? ` · 對基線 ${(activeModelMeta.vsBaseline.score * 100).toFixed(1)}%` : ''}`
    : '規則基線 v0（未發現模型檔案）';

  const modelOptions = modelList.length
    ? modelList.map((entry) => ({ value: entry.id, label: entry.label || entry.version }))
    : [{ value: 'current', label: activeModelVersion }];

  const canRunReal = Boolean(state.engineReady && selectedDeck && deckLegal && engineSupported && lineup.selected.length === 10);
  const expDone = activeRun?.exploreStats?.completed ?? activeRun?.winningStrategy?.exploreTotal ?? 0;
  const testDone = activeRun?.compactResults
    ? Object.values(activeRun.compactResults).reduce((s, r) => s + (r?.total || 0), 0)
    : (activeRun?.events?.length || 0);
  const hasIncompleteRun = Boolean(
    activeRun
    && !activeRun.isDemo
    && (expDone > 0 || testDone > 0)
    && (expDone < EXPLORE_TOTAL_GAMES || testDone < TOTAL_BATCH_GAMES)
  );
  const primaryBtnLabel = hasIncompleteRun
    ? `繼續剩餘（推演 ${expDone.toLocaleString('zh-TW')}/${EXPLORE_TOTAL_GAMES.toLocaleString('zh-TW')} · 測試 ${testDone.toLocaleString('zh-TW')}/${TOTAL_BATCH_GAMES.toLocaleString('zh-TW')}）`
    : `開始千萬級勝率推演（先 ${EXPLORE_TOTAL_GAMES.toLocaleString('zh-TW')} 推演 → 再 ${TOTAL_BATCH_GAMES.toLocaleString('zh-TW')} 測試）`;
  const lexTotal = state.strategyIndex?.totalEntries || state.strategyLexicon?.totalEntries || 13500;

  return `
    <div class="page-head">
      <h1>對戰測試與模擬綜合勝率（13,500 策略詞條 · 10,000,000 局推演 → 50,000 局測試）</h1>
      <p class="desc">全卡庫 4,577 張卡每張逐一考察 2,400 局實戰並結合頂尖競技攻略，構建 <b>${lexTotal.toLocaleString('zh-TW')} 條獨立策略詞條</b>並注入引擎：第一階段以多執行緒 WASM 進行 <b>${EXPLORE_TOTAL_GAMES.toLocaleString('zh-TW')} 次對局推演勝利策略</b>（前十對手各 ${EXPLORE_GAMES_PER_OPPONENT.toLocaleString('zh-TW')} 局），第二階段採用獲勝策略再進行 <b>${TOTAL_BATCH_GAMES.toLocaleString('zh-TW')} 次實際勝率推演</b>（每對手先攻 ${FIRST_SEAT_GAMES.toLocaleString('zh-TW')} + 後攻 ${FIRST_SEAT_GAMES.toLocaleString('zh-TW')} = ${GAMES_PER_OPPONENT.toLocaleString('zh-TW')} 局）。</p>
    </div>

    <div class="battle-setup-grid">
      <section class="panel">
        <h2>1. 選擇測試牌組與千萬局策略模型</h2>
        <div class="field-stack">
          <div class="field-label">
            <span>參戰牌組</span>
            ${renderSwissSelect({
              id: 'battle-deck-select',
              title: '選擇參戰牌組',
              value: selectedDeck?.id || '',
              fullWidth: true,
              disabled: !decks.length || uiState.battle.running,
              options: decks.length
                ? decks.map((d) => ({ value: d.id, label: `${d.name} (${deckTotalCount(d)}/20)` }))
                : [{ value: '', label: '尚無已儲存牌組（可下方一鍵匯入榜首）' }]
            })}
          </div>
          <div class="field-label">
            <span>AI 決策模型</span>
            ${renderSwissSelect({
              id: 'battle-model-select',
              title: '選擇 AI 決策模型',
              value: uiState.battle.modelId || '',
              fullWidth: true,
              disabled: uiState.battle.running,
              options: modelOptions
            })}
          </div>
          ${selectedDeck && !deckLegal ? `<div class="status-note is-warn">目前選中的牌組未符合 20 張合法規則，請先至「卡牌圖鑑」補齊。</div>` : ''}
          ${unsupportedDeckCards.length ? `<div class="status-note is-warn">以下卡牌尚未實裝至 DeckGym 規則引擎，暫無法模擬：${unsupportedDeckCards.map((c) => esc(c.id)).join('、')}</div>` : ''}
        </div>
        <div class="engine-status-card ${state.engineReady ? 'is-ready' : 'is-pending'}">
          <div>
            <strong>模擬引擎：${state.engineReady ? 'WASM 已就緒' : '籌備中'}</strong>
            <p>${state.engineReady ? `目前模型：${esc(modelBadge)}` : esc(state.engineError || '對戰模擬引擎尚未開放，目前可瀏覽賽事前十牌組清單。')}</p>
          </div>
        </div>
        <div class="actions block-gap">
          <button class="btn btn-primary" type="button" data-action="start-real-battle" ${canRunReal && !uiState.battle.running ? '' : 'disabled'}>
            ${icon('play', 15)}<span>${primaryBtnLabel}</span>
          </button>
          <button class="btn btn-outline" type="button" data-action="open-strategy-lexicon">瀏覽 ${lexTotal.toLocaleString('zh-TW')} 策略詞條庫</button>
          ${uiState.battle.running ? `<button class="btn btn-outline" type="button" data-action="pause-battle">${icon('pause', 15)}暫停</button>` : ''}
          ${(m?.entries?.length && !uiState.battle.running) ? `<button class="btn btn-outline" type="button" data-action="quick-load-meta-deck">${icon('plus', 15)}${decks.length ? '匯入榜首試測' : '一鍵匯入榜首並測試'}</button>` : ''}
          ${state.fixture ? `<button class="btn btn-outline" type="button" data-action="run-fixture-preview" ${uiState.battle.running ? 'disabled' : ''}>展示點陣預覽</button>` : ''}
          ${activeRun ? `<button class="btn btn-outline" type="button" data-action="reset-battle-run" ${uiState.battle.running ? 'disabled' : ''}>清空重測</button>` : ''}
        </div>
      </section>

      <section class="panel">
        <h2>2. 鎖定的前十對手（${lineup.selected.length}/10 · 10,000,000 推演 + 50,000 測試）</h2>
        <ol class="opponent-preview-list">
          ${lineup.selected.map((x) => `
            <li>
              <span class="rank-num">#${x.rank}</span>
              <span class="tokens-inline">${(x.entry.representative?.energy || []).map((e) => renderEnergyToken(e, 'sm')).join('')}</span>
              ${renderPokemonSprites(resolveFeaturedPokemon(x.entry.representative, state.cardsById, state.spriteMap), 'sm')}
              <span class="opp-name">${esc(x.entry.name)}</span>
              <span class="opp-share">${(x.entry.share * 100).toFixed(1)}%</span>
            </li>
          `).join('')}
        </ol>
      </section>
    </div>

    <section class="panel block-gap" id="battle-report-area">
      ${activeRun
        ? renderBattleReport(activeRun, lineup.selected, { canReplay: state.engineReady || state.fixture })
        : '<div class="empty-box is-dashed"><strong>尚無測試紀錄</strong><p>開始對戰測試後，系統將自動從 <b>13,500 條策略詞條庫</b>激活本牌組專屬詞條，透過多執行緒 FastSim WASM 先執行 <b>10,000,000 次對局推演勝利策略</b>，後續自動採取該獲勝策略進行 <b>50,000 次實際勝率推演</b>（每對手 5,000 局），即時計算等權與環境加權「模擬綜合勝率」，並支援 DeckGym 四階段完整對局回放。</p></div>'}
    </section>

    ${renderTrainingBenchmarkSection()}
  `;
}

// 6. 資料來源 #sources
export function renderSources() {
  const m = state.meta;
  const eventsList = (m?.sources || []).slice(0, 65).map((s) =>
    `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> <span class="muted">(${formatDate(s.date)} · ${s.players} 人 / ${s.matches} 局)</span></li>`
  ).join('');

  return `
    <div class="page-head">
      <h1>資料來源與授權</h1>
      <p class="desc">Pocket Lab 為 Pokémon TCG Pocket 非官方玩家工具，站內收錄資料來源如下。</p>
    </div>
    <div class="sources-grid">
      <section class="panel">
        <h2>卡牌與圖素來源</h2>
        <p class="desc">繁中卡牌資料整理自 <strong>52Poké 神奇寶貝百科</strong> 與公開編號清單（CC BY-NC-SA 3.0）。</p>
        <p class="desc">目前收錄卡牌：<b>${state.cardsMissing ? '0（尚未載入）' : state.cards.length}</b> 張。</p>
      </section>
      <section class="panel">
        <h2>對戰引擎與模型</h2>
        <p class="desc">規則引擎基於開源專案 <code>deckgym-core</code>（AGPL-3.0）。</p>
        <p class="desc">目前模型：${state.modelInfo ? `${esc(state.modelInfo.version)}` : '籌備中'}。</p>
      </section>
      <section class="panel is-span2">
        <div class="section-head">
          <div>
            <h2>本季納入標準賽事（${m?.events || 0} 場）</h2>
            <p class="sub">資料快照雜湊：<code>${esc((m?.hash || '').slice(0, 16) || '—')}</code> · 統計口徑：${esc(m?.winRateDefinition || '—')}</p>
          </div>
          ${m?.truncated ? '<button class="btn btn-outline" type="button" data-action="load-full-meta">載入全部賽事列表</button>' : ''}
        </div>
        <ul class="source-event-list">${eventsList || '<li>暫無賽事列表</li>'}</ul>
      </section>
    </div>
  `;
}

// 弹窗内容：单卡详情
export function buildCardDetailModal(card) {
  const variants = findVariantsForCard(card);
  const owned = state.collection[card.id] || 0;
  const pokeCats = card.type === 'pokemon'
    ? (card._pokeCats || getPokemonCategories(card))
    : [];
  const pokeTagsHtml = pokeCats.length
    ? `<div class="card-cat-tags">${pokeCats.map((id) => `<span class="card-cat-pill ${id === 'ultra_beast' || id === 'ancient' || id === 'future' || id === 'mega' ? 'is-special' : ''}">${esc(getPokemonCategoryLabel(id))}</span>`).join('')}</div>`
    : '';
  const attacksHtml = (card.attacks || []).map((a) => `
    <div class="modal-move">
      <div class="modal-move-head">
        <strong>${esc(a.name)}</strong>
        <span>${(a.cost || []).map((c) => renderEnergyToken(c, 'sm')).join('')} <b>${esc(a.damage || '')}</b></span>
      </div>
      ${a.effect ? `<p class="desc">${esc(a.effect)}</p>` : ''}
    </div>
  `).join('');
  const abHtml = (card.abilities || []).map((a) => `
    <div class="modal-move">
      <div class="modal-move-head"><span class="tag-opp">特性</span><strong>${esc(a.name)}</strong></div>
      <p class="desc">${esc(a.effect || '')}</p>
    </div>
  `).join('');

  const priorInfo = state.cardPriors?.byCardId?.[card.id] || null;
  const priorHtml = priorInfo
    ? `<div class="modal-move"><div class="modal-move-head"><span class="tag-opp">千萬局訓練評估</span><strong>參戰 ${Number(priorInfo.g || 0).toLocaleString('zh-TW')} 局 · 決策考量 ${Number(priorInfo.ev || 0).toLocaleString('zh-TW')} 次</strong></div><p class="desc">單卡實測得分率 <b>${((priorInfo.sr || 0) * 100).toFixed(1)}%</b>（${priorInfo.w}勝 / ${priorInfo.d}和）· 戰術權重先驗 <code>${priorInfo.p >= 0 ? '+' : ''}${priorInfo.p}</code></p></div>`
    : '';

  return `
    <div class="modal-card-layout">
      <div class="modal-card-preview">${renderCardFace(card, { showDeckAction: false, hiRes: true })}</div>
      <div class="modal-card-info">
        <p class="desc">系列：<b>${esc(card.set)} ${esc(card.setName || '')}</b> · 卡包：${esc(card.pack || '—')} · 稀有度：${esc(card.rarity || '—')}</p>
        ${pokeTagsHtml}
        ${card.nameEn ? `<p class="desc">原名：${esc(card.nameEn)}</p>` : ''}
        ${priorHtml}
        ${abHtml}
        ${attacksHtml}
        ${card.type === 'trainer' && card.effect ? `<div class="modal-move"><p>${esc(card.effect)}</p></div>` : ''}
        ${card.type === 'pokemon' ? `<p class="desc">弱點：${card.weakness ? renderEnergyToken(card.weakness, 'sm') : '無'} · 撤退費用：${card.retreat ?? '—'}</p>` : ''}
        <div class="modal-own-bar">
          <span>我的收藏持有量：</span>
          <div class="draft-stepper">
            <button type="button" data-action="own-delta" data-id="${esc(card.id)}" data-delta="-1">−</button>
            <span id="modal-own-val" class="draft-qty">${owned}</span>
            <button type="button" data-action="own-delta" data-id="${esc(card.id)}" data-delta="1">+</button>
          </div>
        </div>
        ${variants.length ? `
          <div class="detail-section">
            <strong>同卡異畫 / 再錄版本（共用同名 2 張上限）</strong>
            <div class="variant-chips">
              ${variants.map((v) => `<button class="mini" type="button" data-action="inspect-card" data-id="${esc(v.id)}">${esc(v.id)} (${esc(v.rarity || '')})</button>`).join('')}
            </div>
          </div>` : ''}
        <div class="actions block-gap">
          <button class="btn btn-primary" type="button" data-action="add-card" data-id="${esc(card.id)}">+ 加入目前草稿</button>
          <span class="muted">來源：${esc(typeof card.source === 'string' ? card.source : card.source?.title || '52Poké')}</span>
        </div>
      </div>
    </div>
  `;
}

// 彈窗內容：賽事代表牌表
export function buildMetaDetailModal(entry) {
  const rep = entry.representative;
  const repCards = rep?.cards ? sortDeckEntriesPtcgpDefault(rep.cards, state.cardsById) : [];
  const ownership = evaluateDeckOwnership({ cards: repCards }, state.collection, state.cardsById);
  const rows = repCards.map((c, idx) => {
    const card = state.cardsById.get(c.id);
    const thumb = card ? renderCardImgTag(card, 'rep-thumb', false) : '';
    const own = ownership.byEntryIndex[idx];
    const missHtml = state.showMissingBadges && own && own.missing > 0
      ? `<span class="miss-pill ${own.ownedForSlot === 0 ? 'is-none' : 'is-short'}">${own.ownedForSlot === 0 ? '未持有' : `缺 ${own.missing}`}</span>`
      : '';
    return `
      <li class="rep-row ${card ? '' : 'is-missing'}">
        ${thumb ? `<span class="rep-thumb-wrap">${thumb}</span>` : ''}
        <span class="rep-id">${esc(c.id)}</span>
        <span class="rep-name">${card ? esc(card.name) : '卡庫缺失'}${missHtml}</span>
        ${card ? `<span class="tokens-inline">${cardPrimaryTypes(card).map((t) => renderEnergyToken(t.key, 'sm')).join('')}</span>` : ''}
        <strong class="rep-qty">×${c.count}</strong>
      </li>
    `;
  }).join('');

  return `
    <div class="detail-meta-head">
      <div>
        <p class="desc">參賽 ${entry.count} 套（使用率 ${(entry.share * 100).toFixed(2)}%）· ${entry.wins}勝 ${entry.draws}和 ${entry.losses}敗（勝率 ${entry.winRate != null ? (entry.winRate * 100).toFixed(2) + '%' : '—'}）· 冠軍 ${entry.champions} 次 / 八強 ${entry.top8} 次</p>
        ${rep ? `<p class="desc">代表牌表出處：<a href="${esc(rep.url)}" target="_blank" rel="noopener">${esc(rep.event)}</a>（第 ${esc(rep.placing)} 名 · 該構築出現 ${rep.frequency} 次${state.showMissingBadges ? ` · 持卡進度 ${ownership.totalOwned}/20${ownership.totalMissing ? `（缺 ${ownership.totalMissing} 張）` : '（已集齊）'}` : ''}）</p>` : ''}
      </div>
    </div>
    ${rep ? `
      <div class="detail-section">
        <div class="actions spaced">
          <strong>完整 20 張代表牌表 · 能量：${(rep.energy || []).map((e) => renderEnergyToken(e, 'sm')).join(' ')}</strong>
          <div class="actions">
            <button class="btn btn-outline" type="button" data-action="open-meta-showcase" data-id="${esc(entry.id)}">展開 20 張陳列預覽</button>
            <button class="btn btn-primary" type="button" data-action="clone-meta-deck" data-id="${esc(entry.id)}">複製到我的牌組</button>
          </div>
        </div>
        <ul class="rep-list">${rows}</ul>
      </div>
    ` : '<div class="empty-box">該原型暫無完整 20 張代表牌表。</div>'}
  `;
}

export function buildCatalogAuditModal() {
  const sets = state.catalog?.sets || [];
  return `
    <div class="audit-table">
      ${sets.map((s) => `
        <div class="audit-row">
          <strong>${esc(s.id)} ${esc(s.name || '')}</strong>
          <span>${s.count}${s.expected ? ` / ${s.expected}` : ''} 張</span>
          <small class="muted">${(s.missing || []).length ? esc(s.missing.join('、')) : '無缺口'}</small>
        </div>
      `).join('')}
    </div>
  `;
}

export function buildDeckShowcaseModal(deck, opts = {}) {
  const issues = state.cardsMissing ? ['等待卡庫'] : validateDeck(deck, state.cardsById);
  const valid = !state.cardsMissing && issues.length === 0;
  return `
    ${renderDeckShowcase(deck, state.cardsById, {
      valid,
      hiRes: true,
      immersive: true,
      spriteMap: state.spriteMap,
      collection: state.collection,
      showMissing: state.showMissingBadges
    })}
    <div class="actions spaced block-gap">
      <span class="muted">${valid ? '' : esc(issues[0] || '')}</span>
      <div class="actions">
        ${opts.saveDraftButton ? '<button class="btn btn-primary" type="button" data-action="save-draft">儲存為我的牌組</button>' : ''}
        ${opts.cloneMetaId ? `<button class="btn btn-primary" type="button" data-action="clone-meta-deck" data-id="${esc(opts.cloneMetaId)}">複製到我的牌組</button>` : ''}
        ${opts.battleDeckId ? `<button class="btn btn-primary" type="button" data-action="deck-to-battle" data-id="${esc(opts.battleDeckId)}">前往對戰測試</button>` : ''}
      </div>
    </div>
  `;
}

export function buildCollectionToolsModal() {
  const filtered = filterCatalogCards();
  const ownedKinds = Object.values(state.collection || {}).filter((n) => n > 0).length;
  const ownedCopies = Object.values(state.collection || {}).reduce((s, n) => s + (Number(n) || 0), 0);
  return `
    <div class="modal-stack">
      <div class="status-note">已標記持有 <b>${ownedKinds}</b> 種卡牌（共 <b>${ownedCopies}</b> 張），目前圖鑑篩選結果共 <b>${filtered.length}</b> 張。</div>
      <div class="detail-section">
        <strong>批次標記目前篩選範圍（共 ${filtered.length} 張）</strong>
        <p class="desc">可先在圖鑑選好系列（例如某擴充包），再一鍵設為已持有，最後逐張扣掉還沒抽到的卡。</p>
        <div class="actions block-gap">
          <button class="btn btn-outline" type="button" data-action="batch-collection-add1" ${filtered.length ? '' : 'disabled'}>全部各 +1 張</button>
          <button class="btn btn-outline" type="button" data-action="batch-collection-fill2" ${filtered.length ? '' : 'disabled'}>全部補滿 ×2</button>
          <button class="btn btn-danger" type="button" data-action="batch-collection-clear" ${filtered.length ? '' : 'disabled'}>清空此篩選持有</button>
        </div>
      </div>
      <div class="detail-section">
        <strong>帳號／全庫備份匯入匯出</strong>
        <div class="actions block-gap">
          <button class="btn btn-outline" type="button" data-action="export-full-backup">匯出全部牌組與收藏 JSON</button>
          <button class="btn btn-outline" type="button" data-action="import-deck-trigger">匯入備份或單副牌表 JSON</button>
        </div>
      </div>
    </div>
  `;
}

export function buildAccountModal() {
  const configured = isCloudConfigured();
  const cfg = getCloudConfig();
  const session = state.cloudSession;
  const mode = uiState.auth.mode === 'signup' ? 'signup' : 'login';
  const decksCnt = state.decks.length;
  const ownedCnt = Object.values(state.collection || {}).filter((n) => n > 0).length;

  if (session?.user) {
    const syncLabel = state.cloudSyncAt ? new Date(state.cloudSyncAt).toLocaleString('zh-TW') : '尚未同步';
    return `
      <div class="modal-stack">
        <div class="account-card">
          <div class="account-card-head">
            <div>
              <strong>${esc(session.user.email || session.user.id)}</strong>
              <p class="sub">雲端狀態：${esc(state.cloudSyncMessage || '已連線')} · 上次同步：${esc(syncLabel)}</p>
            </div>
            <span class="tag-opp">已登入</span>
          </div>
          <div class="account-stats">
            <div><b>${decksCnt}</b><span>已存牌組</span></div>
            <div><b>${ownedCnt}</b><span>已標記持有卡</span></div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="button" data-action="cloud-sync-now">立即雙向同步</button>
          <button class="btn btn-outline" type="button" data-action="cloud-pull-overwrite">下載雲端覆蓋本機</button>
          <button class="btn btn-outline" type="button" data-action="cloud-push-overwrite">上傳本機覆蓋雲端</button>
        </div>
        <div class="detail-section">
          <strong>完整資料備份</strong>
          <div class="actions block-gap">
            <button class="btn btn-outline" type="button" data-action="export-full-backup">匯出全部牌組與收藏 JSON</button>
            <button class="btn btn-outline" type="button" data-action="import-deck-trigger">匯入備份 JSON</button>
            <button class="btn btn-danger" type="button" data-action="cloud-signout">登出帳號</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="modal-stack">
      ${!configured ? `
        <div class="status-note is-warn">目前尚未連結雲端帳號伺服器（仍可先於本機儲存牌組、標記缺卡並匯出備份）。</div>
      ` : ''}
      <div class="seg-group auth-tabs" role="group" aria-label="帳號模式切換">
        <button class="seg-btn ${mode === 'login' ? 'is-active' : ''}" type="button" data-action="switch-auth-tab" data-mode="login">登入帳號</button>
        <button class="seg-btn ${mode === 'signup' ? 'is-active' : ''}" type="button" data-action="switch-auth-tab" data-mode="signup">註冊新帳號</button>
      </div>
      <form id="cloud-auth-form" class="auth-form">
        <label class="field-label">
          <span>電子郵件（Email）</span>
          <input id="auth-email" type="email" required autocomplete="email" placeholder="you@example.com" ${configured ? '' : 'disabled'}>
        </label>
        <label class="field-label">
          <span>密碼（至少 6 碼）</span>
          <input id="auth-password" type="password" required minlength="6" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" placeholder="輸入密碼" ${configured ? '' : 'disabled'}>
        </label>
        ${mode === 'signup' ? `
          <label class="field-label">
            <span>確認密碼</span>
            <input id="auth-password2" type="password" required minlength="6" autocomplete="new-password" placeholder="再次輸入密碼" ${configured ? '' : 'disabled'}>
          </label>
        ` : ''}
        <div class="actions">
          <button class="btn btn-primary" type="submit" ${configured ? '' : 'disabled'}>${mode === 'signup' ? '建立新帳號並同步' : '登入帳號'}</button>
          <button class="btn btn-outline" type="button" data-action="cloud-google-login" ${configured ? '' : 'disabled'}>使用 Google 帳號登入</button>
        </div>
      </form>
      <div class="detail-section">
        <strong>本機資料備份（目前本機：${decksCnt} 套牌組 · ${ownedCnt} 種持有卡）</strong>
        <div class="actions block-gap">
          <button class="btn btn-outline" type="button" data-action="export-full-backup">匯出全部資料 JSON</button>
          <button class="btn btn-outline" type="button" data-action="import-deck-trigger">匯入備份 JSON</button>
        </div>
      </div>
      ${!cfg.fromRepo ? `
        <details class="cloud-setup-details">
          <summary>管理員：設定本機測試用 Supabase 連線</summary>
          <form id="cloud-config-form" class="auth-form">
            <label class="field-label">
              <span>Supabase Project URL</span>
              <input id="cfg-sb-url" type="url" value="${esc(cfg.supabaseUrl)}" placeholder="https://xxxx.supabase.co">
            </label>
            <label class="field-label">
              <span>Supabase Anon Key（公開金鑰）</span>
              <input id="cfg-sb-key" type="text" value="${esc(cfg.supabaseAnonKey)}" placeholder="貼上 anon public key">
            </label>
            <div class="actions">
              <button class="btn btn-outline" type="submit">套用連線設定</button>
              ${cfg.supabaseUrl ? '<button class="btn btn-danger" type="button" data-action="cloud-clear-override">清除設定</button>' : ''}
            </div>
          </form>
        </details>
      ` : ''}
    </div>
  `;
}

export { deckFingerprint };
