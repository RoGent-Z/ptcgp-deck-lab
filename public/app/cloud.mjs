import { CLOUD_CONFIG } from './cloud-config.mjs';

const OVERRIDE_KEY = 'ptcgp_cloud_config_v1';
const SESSION_KEY = 'ptcgp_cloud_session_v1';
const TABLE_NAME = 'pocket_lab_vaults';

function cleanUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

export function getStoredCloudOverride() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return { supabaseUrl: '', supabaseAnonKey: '' };
    const parsed = JSON.parse(raw);
    return {
      supabaseUrl: cleanUrl(parsed?.supabaseUrl),
      supabaseAnonKey: String(parsed?.supabaseAnonKey || '').trim()
    };
  } catch {
    return { supabaseUrl: '', supabaseAnonKey: '' };
  }
}

export function saveCloudOverride(url, anonKey) {
  const clean = cleanUrl(url);
  const key = String(anonKey || '').trim();
  if (!clean && !key) {
    localStorage.removeItem(OVERRIDE_KEY);
    return { supabaseUrl: '', supabaseAnonKey: '' };
  }
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(clean)) {
    throw Error('連線網址格式無效，請輸入完整 https://...supabase.co 網址');
  }
  if (!key || key.length < 20) {
    throw Error('公開金鑰（anon key）格式無效');
  }
  const obj = { supabaseUrl: clean, supabaseAnonKey: key };
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(obj));
  return obj;
}

export function getCloudConfig() {
  const baseUrl = cleanUrl(CLOUD_CONFIG.supabaseUrl);
  const baseKey = String(CLOUD_CONFIG.supabaseAnonKey || '').trim();
  if (baseUrl && baseKey) return { supabaseUrl: baseUrl, supabaseAnonKey: baseKey, fromRepo: true };
  const over = getStoredCloudOverride();
  return { supabaseUrl: over.supabaseUrl, supabaseAnonKey: over.supabaseAnonKey, fromRepo: false };
}

export function isCloudConfigured() {
  const cfg = getCloudConfig();
  return Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
}

export function loadCloudSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.accessToken || !s?.user?.id) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveCloudSession(session) {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

function normalizeAuthSession(payload) {
  if (!payload?.access_token || !payload?.user?.id) return null;
  const expiresIn = Number(payload.expires_in || 3600);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || '',
    expiresAt: Date.now() + expiresIn * 1000,
    user: {
      id: payload.user.id,
      email: payload.user.email || ''
    }
  };
}

function translateAuthError(data, fallbackStatus) {
  const msg = String(data?.error_description || data?.msg || data?.message || '');
  if (/invalid login credentials/i.test(msg)) return '信箱或密碼錯誤';
  if (/email not confirmed/i.test(msg)) return '此帳號信箱尚未驗證，請先收取驗證信';
  if (/user already registered|already exists/i.test(msg)) return '此信箱已註冊過帳號，請改用登入';
  if (/password.*at least/i.test(msg) || /weak password/i.test(msg)) return '密碼強度不足，請輸入至少 6 個字元';
  if (/invalid.*email|unable to validate email/i.test(msg)) return '請輸入正確的 Email 格式';
  if (/rate limit|too many requests/i.test(msg)) return '操作過於頻繁，請稍候再試';
  return msg || `驗證服務回應失敗 (${fallbackStatus})`;
}

async function authRequest(path, { method = 'POST', body = null, accessToken = '' } = {}, fetchImpl = fetch) {
  const cfg = getCloudConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw Error('雲端帳號服務尚未完成連線設定');
  }
  const headers = {
    apikey: cfg.supabaseAnonKey,
    'Content-Type': 'application/json'
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl(`${cfg.supabaseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Error(translateAuthError(data, res.status));
  return data;
}

export async function consumeOAuthHashIfPresent(fetchImpl = fetch) {
  const h = String(location.hash || '');
  if (!h.includes('access_token=')) return null;
  const params = new URLSearchParams(h.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token') || '';
  const expiresIn = Number(params.get('expires_in') || 3600);
  if (!accessToken || !isCloudConfigured()) return null;

  try {
    const user = await authRequest('/auth/v1/user', { method: 'GET', accessToken }, fetchImpl);
    if (!user?.id) return null;
    const session = saveCloudSession({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      user: { id: user.id, email: user.email || '' }
    });
    history.replaceState(null, '', `${location.pathname}${location.search}#home`);
    return session;
  } catch {
    history.replaceState(null, '', `${location.pathname}${location.search}#home`);
    return null;
  }
}

export async function signUpAccount(email, password, fetchImpl = fetch) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw Error('請輸入正確的 Email 格式');
  if (String(password || '').length < 6) throw Error('密碼長度至少需要 6 個字元');

  const redirectTo = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : undefined;
  const data = await authRequest(
    '/auth/v1/signup',
    { method: 'POST', body: { email: cleanEmail, password, ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : {}) } },
    fetchImpl
  );
  const session = normalizeAuthSession(data);
  if (session) saveCloudSession(session);
  return {
    session,
    user: data?.user || session?.user || null,
    needsEmailVerification: !session
  };
}

export async function signInAccount(email, password, fetchImpl = fetch) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) throw Error('請輸入 Email 與密碼');
  const data = await authRequest(
    '/auth/v1/token?grant_type=password',
    { method: 'POST', body: { email: cleanEmail, password } },
    fetchImpl
  );
  const session = normalizeAuthSession(data);
  if (!session) throw Error('登入回應格式異常');
  return saveCloudSession(session);
}

export function startGoogleSignIn() {
  const cfg = getCloudConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw Error('雲端帳號服務尚未完成連線設定');
  }
  const redirectTo = `${location.origin}${location.pathname}${location.search}`;
  location.href = `${cfg.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
}

export async function ensureValidSession(fetchImpl = fetch) {
  const cur = loadCloudSession();
  if (!cur) return null;
  if (cur.expiresAt && cur.expiresAt - Date.now() > 60_000) return cur;
  if (!cur.refreshToken) {
    saveCloudSession(null);
    return null;
  }
  try {
    const data = await authRequest(
      '/auth/v1/token?grant_type=refresh_token',
      { method: 'POST', body: { refresh_token: cur.refreshToken } },
      fetchImpl
    );
    const next = normalizeAuthSession(data);
    return saveCloudSession(next);
  } catch {
    saveCloudSession(null);
    return null;
  }
}

export async function signOutAccount(fetchImpl = fetch) {
  const cur = loadCloudSession();
  saveCloudSession(null);
  if (cur?.accessToken && isCloudConfigured()) {
    try {
      await authRequest('/auth/v1/logout', { method: 'POST', accessToken: cur.accessToken }, fetchImpl);
    } catch {}
  }
}

function toTimestampMs(iso) {
  const n = Date.parse(iso || '');
  return Number.isFinite(n) ? n : 0;
}

// 雙向合併本機與雲端保險箱資料（含刪除墓碑 deletedDeckIds 與收藏時間戳判斷）
export function mergeVaultSnapshots(localVault, remoteVault, { sameUser = false } = {}) {
  const local = localVault || {};
  const remote = remoteVault || {};
  const deletedMap = { ...(remote.deletedDeckIds || {}), ...(local.deletedDeckIds || {}) };

  const deckMap = new Map();
  const applyDeck = (d) => {
    if (!d?.id) return;
    const delAt = toTimestampMs(deletedMap[d.id]);
    const updAt = toTimestampMs(d.updatedAt);
    if (delAt && delAt >= updAt) return;
    const prev = deckMap.get(d.id);
    if (!prev || updAt >= toTimestampMs(prev.updatedAt)) {
      deckMap.set(d.id, structuredClone(d));
    }
  };
  for (const d of remote.decks || []) applyDeck(d);
  for (const d of local.decks || []) applyDeck(d);

  const mergedDecks = [...deckMap.values()].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  );

  let collection = {};
  let collectionUpdatedAt = '';
  const localColAt = toTimestampMs(local.collectionUpdatedAt);
  const remoteColAt = toTimestampMs(remote.collectionUpdatedAt);
  if (sameUser && (localColAt || remoteColAt)) {
    if (remoteColAt > localColAt) {
      collection = { ...(remote.collection || {}) };
      collectionUpdatedAt = remote.collectionUpdatedAt || '';
    } else {
      collection = { ...(local.collection || {}) };
      collectionUpdatedAt = local.collectionUpdatedAt || '';
    }
  } else {
    // 初次從訪客本機合併進雲端帳號時保留兩側標記的最高持有數
    const allIds = new Set([
      ...Object.keys(remote.collection || {}),
      ...Object.keys(local.collection || {})
    ]);
    for (const id of allIds) {
      const cnt = Math.max(Number(remote.collection?.[id] || 0), Number(local.collection?.[id] || 0));
      if (cnt > 0) collection[id] = Math.min(99, cnt);
    }
    collectionUpdatedAt = new Date(Math.max(localColAt, remoteColAt, Date.now())).toISOString();
  }

  const localDraftAt = toTimestampMs(local.draft?.updatedAt);
  const remoteDraftAt = toTimestampMs(remote.draft?.updatedAt);
  const draft = remoteDraftAt > localDraftAt && remote.draft?.cards
    ? structuredClone(remote.draft)
    : structuredClone(local.draft || remote.draft || null);

  let featuredDeckId = toTimestampMs(remote.updatedAt) > toTimestampMs(local.updatedAt)
    ? (remote.featuredDeckId || local.featuredDeckId || null)
    : (local.featuredDeckId || remote.featuredDeckId || null);
  if (featuredDeckId && !mergedDecks.some((d) => d.id === featuredDeckId)) {
    featuredDeckId = mergedDecks[0]?.id || null;
  }

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    decks: mergedDecks,
    deletedDeckIds: deletedMap,
    collection,
    collectionUpdatedAt,
    draft,
    featuredDeckId
  };
}

export async function fetchRemoteVault(session, fetchImpl = fetch) {
  const cfg = getCloudConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !session?.accessToken) {
    throw Error('請先登入雲端帳號');
  }
  const url = `${cfg.supabaseUrl}/rest/v1/${TABLE_NAME}?user_id=eq.${encodeURIComponent(session.user.id)}&select=vault,updated_at`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${session.accessToken}`
    }
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.message || ''; } catch {}
    throw Error(msg || `讀取雲端資料失敗 (${res.status})`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0]?.vault || null;
}

export async function pushRemoteVault(session, vault, fetchImpl = fetch) {
  const cfg = getCloudConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !session?.accessToken) {
    throw Error('請先登入雲端帳號');
  }
  const url = `${cfg.supabaseUrl}/rest/v1/${TABLE_NAME}?on_conflict=user_id`;
  const nowIso = new Date().toISOString();
  const payload = {
    user_id: session.user.id,
    vault: { ...vault, updatedAt: nowIso },
    updated_at: nowIso
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.message || ''; } catch {}
    throw Error(msg || `上傳雲端資料失敗 (${res.status})`);
  }
  return payload.vault;
}
