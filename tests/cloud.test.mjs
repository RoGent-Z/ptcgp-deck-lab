import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => memStore.set(k, String(v)),
  removeItem: (k) => memStore.delete(k)
};
if (!globalThis.location) {
  globalThis.location = { origin: 'https://rogent-z.github.io', pathname: '/ptcgp-deck-lab/', search: '', hash: '' };
}

import { evaluateDeckOwnership, getCardOwnedCount } from '../public/app/core.mjs';
import { renderCardFace, renderDeckMiniSlot, renderDeckShowcase } from '../public/app/cardface.mjs';
import {
  fetchRemoteVault,
  isCloudConfigured,
  mergeVaultSnapshots,
  pushRemoteVault,
  saveCloudOverride,
  signInAccount,
  signOutAccount,
  signUpAccount
} from '../public/app/cloud.mjs';

test('evaluateDeckOwnership consumes shared functional card pool across alternate arts', () => {
  const cards = JSON.parse(readFileSync(new URL('../public/data/cards.json', import.meta.url), 'utf8'));
  const byId = new Map(cards.map((c) => [c.id, c]));

  // B2b-007 (小火龍) 與 P-A-005 (精靈球)：只持有 1 張 A1 精靈球（同名異畫）與 0 張小火龍
  const collection = { 'A1-216': 1 }; // 檢查任意精靈球異畫是否命中 P-A-005，改直接拿 cards 動態找
  const pokeballs = cards.filter((c) => c.limitName === "Poké Ball" || c.limitName === 'Poké Ball');
  const charmanders = cards.filter((c) => c.limitName === 'Charmander');
  assert.ok(charmanders.length >= 2 && pokeballs.length >= 1);

  const cA = charmanders[0];
  const cB = charmanders[1];
  const pb = pokeballs[0];
  const ownedMap = { [cA.id]: 1 }; // 共持有 1 張小火龍，2 張牌組欄位共用該 1 張額度

  assert.equal(getCardOwnedCount(cB.id, ownedMap, byId, false), 0);
  assert.equal(getCardOwnedCount(cB.id, ownedMap, byId, true), 1);

  const deck = {
    name: '缺卡測試',
    energy: ['Fire'],
    cards: [
      { id: cA.id, count: 1 },
      { id: cB.id, count: 1 },
      { id: pb.id, count: 2 }
    ]
  };
  const res = evaluateDeckOwnership(deck, ownedMap, byId);
  assert.equal(res.totalNeeded, 4);
  assert.equal(res.totalOwned, 1);
  assert.equal(res.totalMissing, 3);
  assert.equal(res.byEntryIndex[0].missing, 0); // 第一張小火龍有額度
  assert.equal(res.byEntryIndex[1].missing, 1); // 第二張小火龍額度用完 -> 缺 1
  assert.equal(res.byEntryIndex[2].missing, 2); // 精靈球 0/2 -> 缺 2

  // renderCardFace & renderDeckShowcase 缺卡標識
  const unownedFace = renderCardFace(cB, { ownedCount: 0, showMissing: true, showDeckAction: true });
  assert.match(unownedFace, /is-unowned/);
  assert.match(unownedFace, /未持有/);

  const ownedFace = renderCardFace(cA, { ownedCount: 1, showMissing: true, showDeckAction: true });
  assert.doesNotMatch(ownedFace, /is-unowned/);
  assert.match(ownedFace, /持有 ×1/);

  const slotMissHtml = renderDeckMiniSlot(pb, 2, pb.id, { showMissing: true, missingCount: 2, ownedForSlot: 0 });
  assert.match(slotMissHtml, /is-unowned/);
  assert.match(slotMissHtml, /未持有/);

  // Showcase 對 2 張需求、只持有 1 張的單卡只標記第 2 格為「未持有/缺卡」
  const halfDeck = { name: '半齊測試', energy: ['Fire'], cards: [{ id: cA.id, count: 2 }] };
  const wallHtml = renderDeckShowcase(halfDeck, byId, { collection: { [cA.id]: 1 }, showMissing: true });
  assert.equal((wallHtml.match(/is-slot-missing/g) || []).length, 1);
  assert.match(wallHtml, /缺 1 張/);

  // 關閉缺卡標記時不顯示任何缺卡樣式
  const cleanWall = renderDeckShowcase(halfDeck, byId, { collection: { [cA.id]: 1 }, showMissing: false });
  assert.equal((cleanWall.match(/is-slot-missing/g) || []).length, 0);
});

test('mergeVaultSnapshots merges decks, obeys delete tombstones, and preserves collection properly', () => {
  const d1Old = { id: 'd1', name: 'Old', cards: [{ id: 'A1-001', count: 2 }], energy: ['Grass'], updatedAt: '2026-11-19T10:00:00Z' };
  const d1New = { id: 'd1', name: 'New', cards: [{ id: 'A1-001', count: 2 }], energy: ['Grass'], updatedAt: '2026-11-19T12:00:00Z' };
  const dDeleted = { id: 'd2', name: 'Deleted', cards: [], energy: ['Fire'], updatedAt: '2026-11-19T09:00:00Z' };

  const mergedGuest = mergeVaultSnapshots(
    { decks: [d1Old], collection: { 'A1-001': 1 }, deletedDeckIds: { d2: '2026-11-19T11:00:00Z' } },
    { decks: [d1New, dDeleted], collection: { 'A1-002': 2 }, deletedDeckIds: {} },
    { sameUser: false }
  );
  assert.equal(mergedGuest.decks.length, 1);
  assert.equal(mergedGuest.decks[0].name, 'New');
  assert.deepEqual(mergedGuest.collection, { 'A1-001': 1, 'A1-002': 2 });

  // 同帳號下若明確減少為 0 張，採用更新的 collectionUpdatedAt，不退回舊張數
  const mergedSame = mergeVaultSnapshots(
    { decks: [d1New], collection: {}, collectionUpdatedAt: '2026-11-19T13:00:00Z' },
    { decks: [d1Old], collection: { 'A1-001': 2 }, collectionUpdatedAt: '2026-11-19T10:00:00Z' },
    { sameUser: true }
  );
  assert.deepEqual(mergedSame.collection, {});
});

test('cloud auth and vault REST calls handle signup, login, fetch and push via mocked fetch', async () => {
  memStore.clear();
  assert.equal(isCloudConfigured(), false);
  saveCloudOverride('https://demo-project.supabase.co', 'anon-key-public-example-1234567890');
  assert.equal(isCloudConfigured(), true);

  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/auth/v1/signup')) {
      return new Response(
        JSON.stringify({
          access_token: 'tok-1',
          refresh_token: 'ref-1',
          expires_in: 3600,
          user: { id: 'uid-99', email: 'player@example.com' }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/auth/v1/token')) {
      return new Response(
        JSON.stringify({ error_description: 'Invalid login credentials' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/rest/v1/pocket_lab_vaults') && (init.method || 'GET') === 'GET') {
      return new Response(
        JSON.stringify([{ vault: { schemaVersion: 1, decks: [], collection: { 'A1-001': 2 } } }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/rest/v1/pocket_lab_vaults') && init.method === 'POST') {
      return new Response('', { status: 201 });
    }
    if (url.endsWith('/auth/v1/logout')) {
      return new Response('', { status: 204 });
    }
    return new Response('{}', { status: 404 });
  };

  const signup = await signUpAccount('Player@Example.com', 'secret123', mockFetch);
  assert.equal(signup.needsEmailVerification, false);
  assert.equal(signup.session.user.email, 'player@example.com');

  await assert.rejects(() => signInAccount('player@example.com', 'wrongpass', mockFetch), /信箱或密碼錯誤/);

  const remote = await fetchRemoteVault(signup.session, mockFetch);
  assert.deepEqual(remote.collection, { 'A1-001': 2 });

  const uploaded = await pushRemoteVault(signup.session, { decks: [], collection: { 'A1-001': 2 } }, mockFetch);
  assert.ok(uploaded.updatedAt);

  await signOutAccount(mockFetch);
  saveCloudOverride('', '');
  assert.equal(isCloudConfigured(), false);
});
