// Pokémon TCG Pocket 遊戲內卡組二維碼解碼／編碼模組（支援官方藍點帶圖示截圖、相機即時掃碼與雙向匯出）
// Binary deck payload & dotted Version-9 QR recovery adapted from MIT-licensed KevinGutowski/tcgp-deck-qr.
import { sortDeckEntriesPtcgpDefault } from './cardface.mjs';
import { jsQR, qrcode } from './qr-vendor.mjs';

const TRAINER_ID_OFFSET = 10_000_000;
const MAX_U24 = 0xff_ff_ff;
const POCKET_QR_MODULE_COUNT = 53; // Pokémon TCG Pocket 官方卡組二維碼固定為 QR Version 9 (53×53)
const FINDER_DISTANCE_MODULES = POCKET_QR_MODULE_COUNT - 7;

export const ENERGY_NAMES_BY_CODE = new Map([
  [1, 'Grass'],
  [2, 'Fire'],
  [3, 'Water'],
  [4, 'Lightning'],
  [5, 'Psychic'],
  [6, 'Fighting'],
  [7, 'Darkness'],
  [8, 'Metal'],
  [10, 'Dragon'],
  [11, 'Colorless']
]);

export const SELECTABLE_ENERGY_CODES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

export const ENERGY_CODE_BY_NAME = new Map(
  [...ENERGY_NAMES_BY_CODE.entries()].map(([code, name]) => [name.toLowerCase(), code])
);

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function decodeDeckQrPayload(rawPayload) {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    throw Error('卡組代碼不能為空');
  }
  const normalized = rawPayload.trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw Error('這不是有效的 Pokémon TCG Pocket 遊戲卡組碼');
  }

  let buffer;
  try {
    buffer = base64ToBytes(normalized);
  } catch {
    throw Error('卡組碼格式解析失敗');
  }

  let offset = 0;
  const readByte = (label) => {
    if (offset >= buffer.length) throw Error(`卡組碼資料不完整（缺少${label}）`);
    return buffer[offset++];
  };
  const readU24 = (label) => {
    if (offset + 3 > buffer.length) throw Error(`卡組碼資料截斷（${label}）`);
    const v = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
    offset += 3;
    return v >>> 0;
  };

  const trainerCount = readByte('訓練家數量');
  if (trainerCount > 20) throw Error('這不是有效的 Pokémon TCG Pocket 遊戲卡組碼');
  const trainerIds = [];
  for (let i = 0; i < trainerCount; i++) {
    const raw = readU24('訓練家編號');
    const tid = raw - TRAINER_ID_OFFSET;
    if (tid < 0) throw Error('訓練家卡編號超出範圍');
    trainerIds.push(tid);
  }

  const pokemonCount = readByte('寶可夢數量');
  if (pokemonCount > 20 || trainerCount + pokemonCount === 0 || trainerCount + pokemonCount > 20) {
    throw Error('卡組張數異常，非有效的 20 張牌組碼');
  }
  const pokemonIds = [];
  for (let i = 0; i < pokemonCount; i++) {
    pokemonIds.push(readU24('寶可夢編號'));
  }

  const energyCount = readByte('能量數量');
  if (energyCount > 3 || offset + energyCount !== buffer.length) {
    throw Error('卡組碼能量區段格式不符');
  }
  const energyTypes = [];
  for (let i = 0; i < energyCount; i++) {
    const code = buffer[offset++];
    if (!ENERGY_NAMES_BY_CODE.has(code)) throw Error(`未知的能量類型代碼 (${code})`);
    energyTypes.push(code);
  }

  return { trainerIds, pokemonIds, energyTypes, raw: normalized };
}

export function encodeDeckQrPayload({ trainerIds = [], pokemonIds = [], energyTypes = [] }) {
  if (trainerIds.length + pokemonIds.length !== 20) {
    throw Error(`遊戲內卡組碼必須剛好為 20 張卡牌（目前 ${trainerIds.length + pokemonIds.length} 張）`);
  }
  if (energyTypes.length < 1 || energyTypes.length > 3) {
    throw Error(`遊戲內卡組碼須設定 1 至 3 種能量（目前 ${energyTypes.length} 種）`);
  }
  const bytes = [trainerIds.length & 0xff];
  for (const tid of trainerIds) {
    const v = tid + TRAINER_ID_OFFSET;
    if (!Number.isInteger(v) || v < TRAINER_ID_OFFSET || v > MAX_U24) {
      throw Error(`無效的訓練家卡編號 (${tid})`);
    }
    bytes.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  bytes.push(pokemonIds.length & 0xff);
  for (const pid of pokemonIds) {
    if (!Number.isInteger(pid) || pid < 0 || pid > MAX_U24) {
      throw Error(`無效的寶可夢卡編號 (${pid})`);
    }
    bytes.push((pid >>> 16) & 0xff, (pid >>> 8) & 0xff, pid & 0xff);
  }
  bytes.push(energyTypes.length & 0xff);
  for (const code of energyTypes) {
    if (!SELECTABLE_ENERGY_CODES.has(code)) {
      throw Error(`能量類型 (${ENERGY_NAMES_BY_CODE.get(code) || code}) 無法在遊戲內卡組編輯器選取`);
    }
    bytes.push(code & 0xff);
  }
  return bytesToBase64(bytes);
}

const ENTITY_LOOKUP_CACHE = new WeakMap();

export function buildEntityLookup(entityMap) {
  if (!entityMap) return null;
  let cached = ENTITY_LOOKUP_CACHE.get(entityMap);
  if (cached) return cached;

  const pk = new Map();
  const tr = new Map();
  const byCardId = new Map();

  for (const [k, v] of Object.entries(entityMap.pk || {})) {
    const id = Number(k);
    const list = Array.isArray(v) ? v : [v];
    pk.set(id, list);
    for (const cid of list) byCardId.set(cid.toUpperCase(), { kind: 'pk', entityId: id });
  }
  for (const [k, v] of Object.entries(entityMap.tr || {})) {
    const id = Number(k);
    const list = Array.isArray(v) ? v : [v];
    tr.set(id, list);
    for (const cid of list) byCardId.set(cid.toUpperCase(), { kind: 'tr', entityId: id });
  }

  cached = { pk, tr, byCardId };
  ENTITY_LOOKUP_CACHE.set(entityMap, cached);
  return cached;
}

function pickPreferredPrint(prints, cardsById, collection) {
  if (!prints?.length) return null;
  const valid = prints.filter((cid) => !cardsById || cardsById.has(cid));
  const pool = valid.length ? valid : prints;
  if (collection && typeof collection === 'object') {
    let bestOwned = null;
    let bestQty = 0;
    for (const cid of pool) {
      const qty = Number(collection[cid] || 0);
      if (qty > bestQty) {
        bestQty = qty;
        bestOwned = cid;
      }
    }
    if (bestOwned) return bestOwned;
  }
  return pool[0];
}

export function autoNameDecodedDeck(cards, cardsById) {
  if (!cards?.length || !cardsById) return '掃碼匯入牌組';
  const scored = [];
  for (const entry of cards) {
    const c = cardsById.get(entry.id);
    if (!c || c.type !== 'pokemon') continue;
    const isMega = /超級|Mega\b/i.test(`${c.name || ''} ${c.nameEn || ''}`);
    const isEx = isMega || /ex$/i.test(c.name || '') || /\bex\b/i.test(c.nameEn || '');
    const stg = c.stage === 'stage2' ? 3 : c.stage === 'stage1' ? 2 : 1;
    const score = (isMega ? 120 : isEx ? 90 : 0) + stg * 22 + entry.count * 12 + (Number(c.hp) || 0) * 0.1;
    scored.push({ name: c.name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const names = [];
  for (const item of scored) {
    if (!names.includes(item.name)) names.push(item.name);
    if (names.length >= 2) break;
  }
  return names.length ? names.join(' · ') : '掃碼匯入牌組';
}

export function resolveDecodedPayloadToDeck(decoded, entityMap, cardsById, collection = {}) {
  const lookup = buildEntityLookup(entityMap);
  if (!lookup) throw Error('尚未載入卡牌代碼對照表');

  const countsByCardId = new Map();
  const unknownEntities = [];

  const addGroup = (ids, kind) => {
    const map = kind === 'pk' ? lookup.pk : lookup.tr;
    for (const eid of ids) {
      const prints = map.get(eid);
      const picked = pickPreferredPrint(prints, cardsById, collection);
      if (!picked) {
        unknownEntities.push({ kind, entityId: eid });
        continue;
      }
      countsByCardId.set(picked, (countsByCardId.get(picked) || 0) + 1);
    }
  };

  addGroup(decoded.pokemonIds || [], 'pk');
  addGroup(decoded.trainerIds || [], 'tr');

  let cards = [...countsByCardId.entries()].map(([id, count]) => ({ id, count }));
  if (cardsById) {
    cards = sortDeckEntriesPtcgpDefault(cards, cardsById);
  }
  const energy = (decoded.energyTypes || [])
    .map((code) => ENERGY_NAMES_BY_CODE.get(code))
    .filter((name) => Boolean(name) && name !== 'Dragon' && name !== 'Colorless');
  const rawEnergyNames = (decoded.energyTypes || [])
    .map((code) => ENERGY_NAMES_BY_CODE.get(code))
    .filter(Boolean);
  const finalEnergy = energy.length ? energy : rawEnergyNames.slice(0, 3);
  const totalCards = cards.reduce((s, c) => s + c.count, 0);
  const name = autoNameDecodedDeck(cards, cardsById);

  return {
    name,
    cards,
    energy: finalEnergy,
    totalCards,
    unknownEntities,
    payload: decoded.raw || ''
  };
}

export function encodeDeckToGameQr(deck, entityMap, cardsById) {
  const lookup = buildEntityLookup(entityMap);
  if (!lookup) throw Error('尚未載入卡牌代碼對照表');

  const trainerIds = [];
  const pokemonIds = [];
  for (const entry of deck?.cards || []) {
    const rec = lookup.byCardId.get(String(entry.id || '').toUpperCase());
    if (!rec) {
      const card = cardsById?.get(entry.id);
      throw Error(`找不到「${card?.name || entry.id}」的遊戲內卡組編號`);
    }
    const cnt = Math.max(1, Number(entry.count || 1));
    for (let i = 0; i < cnt; i++) {
      if (rec.kind === 'tr') trainerIds.push(rec.entityId);
      else pokemonIds.push(rec.entityId);
    }
  }
  const energyTypes = [];
  for (const e of deck?.energy || []) {
    const code = ENERGY_CODE_BY_NAME.get(String(e || '').trim().toLowerCase());
    if (!code || !SELECTABLE_ENERGY_CODES.has(code)) {
      throw Error(`能量「${e}」不在遊戲內卡組碼支援範圍內`);
    }
    if (!energyTypes.includes(code)) energyTypes.push(code);
  }

  const payload = encodeDeckQrPayload({ trainerIds, pokemonIds, energyTypes });
  const svg = createDeckQrSvg(payload);
  return {
    payload,
    svg,
    trainerCount: trainerIds.length,
    pokemonCount: pokemonIds.length,
    energyCount: energyTypes.length
  };
}

export function createDeckQrMatrix(payload) {
  const qr = qrcode(9, 'H');
  qr.addData(payload, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const matrix = [];
  for (let r = 0; r < n; r++) {
    const row = new Uint8Array(n);
    for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c) ? 1 : 0;
    matrix.push(row);
  }
  return matrix;
}

export function createDeckQrSvg(payload, { color = '#006fc7', background = '#ffffff', margin = 4 } = {}) {
  const matrix = createDeckQrMatrix(payload);
  const n = matrix.length;
  const side = n + margin * 2;
  const cmds = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) cmds.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><path fill="${background}" d="M0 0h${side}v${side}H0z"/><path fill="${color}" d="${cmds.join('')}"/></svg>`;
}

export function renderDeckQrToPngDataUrl(payload, { size = 480, color = '#006fc7', background = '#ffffff', margin = 4 } = {}) {
  const matrix = createDeckQrMatrix(payload);
  const n = matrix.length;
  const total = n + margin * 2;
  const scale = Math.max(4, Math.floor(size / total));
  const px = total * scale;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = color;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}

// === QR 圖像解碼（標準 QR + Pokémon TCG Pocket 藍點中央圖示截圖專屬還原） ===

function standardDecode(image) {
  const data = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);
  const decoded = jsQR(data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  if (!decoded?.data) return null;
  return { payload: decoded.data, method: 'standard' };
}

function pixelMatchesMode(r, g, b, a, mode) {
  if (a < 128) return false;
  if (mode.dark) {
    // 灰階或高對比翻拍點陣
    const lum = (r * 77 + g * 150 + b * 29) >> 8;
    return lum < mode.lumMax;
  }
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return (mx - mn) >= mode.sat && (b - r) >= mode.br && (g - r) >= mode.gr && b >= mode.minB;
}

function colorAt(image, x, y, mode) {
  const col = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const row = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const off = (row * image.width + col) * 4;
  return pixelMatchesMode(image.data[off], image.data[off + 1], image.data[off + 2], image.data[off + 3], mode);
}

function connectedComponents(image, sample, mode) {
  const width = Math.ceil(image.width / sample);
  const height = Math.ceil(image.height / sample);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, y * sample + sample / 2);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, x * sample + sample / 2);
      mask[y * width + x] = colorAt(image, sx, sy, mode) ? 1 : 0;
    }
  }

  const seen = new Uint8Array(mask.length);
  const comps = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let area = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width;
      const y = (idx - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
      if (x + 1 < width && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] && !seen[idx - width]) { seen[idx - width] = 1; stack.push(idx - width); }
      if (y + 1 < height && mask[idx + width] && !seen[idx + width]) { seen[idx + width] = 1; stack.push(idx + width); }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const ratio = bw / bh;
    const density = area / (bw * bh);
    if (bw >= 10 && bh >= 10 && ratio >= 0.7 && ratio <= 1.42 && density >= 0.18 && density <= 0.82) {
      comps.push({
        area,
        size: (bw + bh) / 2,
        center: {
          x: ((minX + maxX + 1) / 2) * sample,
          y: ((minY + maxY + 1) / 2) * sample
        }
      });
    }
  }
  return comps;
}

function finderTriples(comps, allowTilt = false) {
  const triples = [];
  const alignLimit = allowTilt ? 1.5 : 0.75;
  for (const tl of comps) {
    for (const tr of comps) {
      if (tr.center.x <= tl.center.x) continue;
      const horiz = Math.hypot(tr.center.x - tl.center.x, tr.center.y - tl.center.y);
      if (horiz < tl.size * 3.8 || Math.abs(tr.center.y - tl.center.y) > tl.size * alignLimit) continue;
      for (const bl of comps) {
        if (bl.center.y <= tl.center.y) continue;
        const vert = Math.hypot(bl.center.x - tl.center.x, bl.center.y - tl.center.y);
        if (vert < tl.size * 3.8 || Math.abs(bl.center.x - tl.center.x) > tl.size * alignLimit) continue;
        const mean = (tl.size + tr.size + bl.size) / 3;
        const sizeErr = (Math.abs(tl.size - mean) + Math.abs(tr.size - mean) + Math.abs(bl.size - mean)) / mean;
        const dx1 = tr.center.x - tl.center.x;
        const dy1 = tr.center.y - tl.center.y;
        const dx2 = bl.center.x - tl.center.x;
        const dy2 = bl.center.y - tl.center.y;
        const orthoErr = Math.abs((dx1 * dx2 + dy1 * dy2) / (horiz * vert));
        const lenErr = Math.abs(horiz - vert) / Math.max(horiz, vert);
        if (orthoErr > 0.25 || lenErr > 0.25) continue;
        triples.push({ topLeft: tl, topRight: tr, bottomLeft: bl, score: sizeErr + lenErr + orthoErr * 2 });
      }
    }
  }
  return triples.sort((a, b) => a.score - b.score);
}

function buildSyntheticQr(image, triple, mode, shiftX, shiftY, scaleAdj) {
  const renderScale = 6;
  const quiet = 4;
  const side = (POCKET_QR_MODULE_COUNT + quiet * 2) * renderScale;
  const pixels = new Uint8ClampedArray(side * side * 4);
  pixels.fill(255);

  const colVecX = ((triple.topRight.center.x - triple.topLeft.center.x) / FINDER_DISTANCE_MODULES) * scaleAdj;
  const colVecY = ((triple.topRight.center.y - triple.topLeft.center.y) / FINDER_DISTANCE_MODULES) * scaleAdj;
  const rowVecX = ((triple.bottomLeft.center.x - triple.topLeft.center.x) / FINDER_DISTANCE_MODULES) * scaleAdj;
  const rowVecY = ((triple.bottomLeft.center.y - triple.topLeft.center.y) / FINDER_DISTANCE_MODULES) * scaleAdj;

  const sOff = [
    [0, 0],
    [colVecX * 0.12, colVecY * 0.12],
    [-colVecX * 0.12, -colVecY * 0.12],
    [rowVecX * 0.12, rowVecY * 0.12],
    [-rowVecX * 0.12, -rowVecY * 0.12]
  ];

  for (let row = 0; row < POCKET_QR_MODULE_COUNT; row++) {
    const rOff = row - 3 + shiftY;
    for (let col = 0; col < POCKET_QR_MODULE_COUNT; col++) {
      const cOff = col - 3 + shiftX;
      const cx = triple.topLeft.center.x + cOff * colVecX + rOff * rowVecX;
      const cy = triple.topLeft.center.y + cOff * colVecY + rOff * rowVecY;
      let votes = 0;
      for (let k = 0; k < 5; k++) {
        if (colorAt(image, cx + sOff[k][0], cy + sOff[k][1], mode)) votes++;
      }
      if (votes < 2) continue;

      const sx = (col + quiet) * renderScale;
      const sy = (row + quiet) * renderScale;
      for (let y = sy; y < sy + renderScale; y++) {
        let off = (y * side + sx) * 4;
        for (let x = 0; x < renderScale; x++) {
          pixels[off] = 0;
          pixels[off + 1] = 0;
          pixels[off + 2] = 0;
          pixels[off + 3] = 255;
          off += 4;
        }
      }
    }
  }
  return { pixels, side };
}

function decoratedDecode(image, { fastCamera = false } = {}) {
  const sample = Math.max(1, Math.floor(Math.max(image.width, image.height) / (fastCamera ? 900 : 1600)));
  const modes = fastCamera
    ? [
        { sat: 50, br: 26, gr: 4, minB: 80, dark: false },
        { sat: 30, br: 18, gr: 0, minB: 65, dark: false }
      ]
    : [
        { sat: 55, br: 30, gr: 5, minB: 90, dark: false },
        { sat: 45, br: 25, gr: 4, minB: 85, dark: false },
        { sat: 65, br: 30, gr: 5, minB: 95, dark: false },
        { sat: 30, br: 18, gr: 0, minB: 65, dark: false },
        { dark: true, lumMax: 125 }
      ];
  const scales = fastCamera ? [1, 0.996, 1.004] : [1, 0.998, 1.002, 0.995, 1.005];
  const shifts = fastCamera ? [0, -0.06, 0.06] : [0, -0.06, 0.06];
  const maxTriples = fastCamera ? 3 : 8;

  for (const mode of modes) {
    const triples = finderTriples(connectedComponents(image, sample, mode), fastCamera || mode.sat <= 35);
    for (const triple of triples.slice(0, maxTriples)) {
      for (const sc of scales) {
        for (const sx of shifts) {
          for (const sy of shifts) {
            const { pixels, side } = buildSyntheticQr(image, triple, mode, sx, sy, sc);
            const decoded = jsQR(pixels, side, side, { inversionAttempts: 'dontInvert' });
            if (decoded?.data) {
              return { payload: decoded.data, method: 'pocket-decorated' };
            }
          }
        }
      }
    }
  }
  return null;
}

export function decodeQrFromImageData(imageData, opts = {}) {
  return standardDecode(imageData) || decoratedDecode(imageData, opts);
}

export async function decodeQrFromImageFile(file) {
  const bitmapOrImg = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error('無法讀取此圖片檔案')); };
    img.src = url;
  });

  const maxDim = 1800;
  let w = bitmapOrImg.naturalWidth || bitmapOrImg.width;
  let h = bitmapOrImg.naturalHeight || bitmapOrImg.height;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmapOrImg, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  return decodeQrFromImageData(imgData, { fastCamera: false });
}
