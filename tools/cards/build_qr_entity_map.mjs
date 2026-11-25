#!/usr/bin/env node
// Build compact offline entity-ID <-> Pocket Lab card-ID mapping for Pokémon TCG Pocket in-game deck QR codes.
// Source: flibustier/pokemon-tcg-pocket-database (community game asset index cPK_/cTR_).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CARDS_PATH = path.join(ROOT, 'public/data/cards.json');
const OUT_PATH = path.join(ROOT, 'public/data/qr-entity-map.json');
const DB_URL = 'https://raw.githubusercontent.com/flibustier/pokemon-tcg-pocket-database/main/dist/cards.json';

const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
const resp = await fetch(DB_URL, { headers: { 'User-Agent': 'PocketLabBuilder' } });
if (!resp.ok) throw Error(`Failed to fetch flibustier database: ${resp.status}`);
const flib = await resp.json();

// Map (SET-NUM) -> { kind: 'pk'|'tr', entityId: number, isBaseArt: boolean }
const flibById = new Map();
for (const r of flib) {
  const m = /^c(PK|TR)_(\d+)_(\d{6})_/i.exec(r.image || '');
  if (!m) continue;
  const kind = m[1].toUpperCase() === 'PK' ? 'pk' : 'tr';
  const entityId = Number(m[3]);
  const isBaseArt = m[2] === '10' || m[2] === '90';
  const setNorm = String(r.set || '').toUpperCase().replace(/^PROMO-/, 'P-');
  let num = Number(r.number);
  // SP1 RGB Mew variants are indexed -3, -2, -1 in flibustier and 028, 029, 030 in Pocket Lab
  if (setNorm === 'SP1' && num < 0) num = 31 + num;
  const id = `${setNorm}-${String(num).padStart(3, '0')}`;
  flibById.set(id, { kind, entityId, isBaseArt, image: r.image });
}

// Rarity preference for choosing the canonical display print when decoding a QR code
function printSortScore(card, isBaseArt) {
  let score = isBaseArt ? 0 : 20;
  const r = String(card.rarity || '');
  if (/^◇{1,4}$/.test(r)) score += 1;
  else if (r === '★') score += 30;
  else if (r === '★★') score += 40;
  else if (r === '★★★') score += 50;
  else if (r === '👑') score += 60;
  else score += 25;
  if (String(card.id).startsWith('P-')) score += 5;
  return score;
}

const pkGroups = new Map();
const trGroups = new Map();
let matched = 0;
const missing = [];

for (const c of cards) {
  const rec = flibById.get(c.id.toUpperCase());
  if (!rec) {
    missing.push(c.id);
    continue;
  }
  matched++;
  const bucket = rec.kind === 'pk' ? pkGroups : trGroups;
  let list = bucket.get(rec.entityId);
  if (!list) {
    list = [];
    bucket.set(rec.entityId, list);
  }
  list.push({ id: c.id, score: printSortScore(c, rec.isBaseArt) });
}

function serializeGroups(map) {
  const out = {};
  const keys = [...map.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const arr = map.get(k)
      .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
      .map((x) => x.id);
    out[String(k)] = arr.length === 1 ? arr[0] : arr;
  }
  return out;
}

const payload = {
  version: 1,
  totalCards: matched,
  pk: serializeGroups(pkGroups),
  tr: serializeGroups(trGroups)
};

fs.writeFileSync(OUT_PATH, JSON.stringify(payload), 'utf8');
const bytes = fs.statSync(OUT_PATH).size;
console.log(`Wrote ${OUT_PATH}: ${matched}/${cards.length} cards (${Object.keys(payload.pk).length} pk entities, ${Object.keys(payload.tr).length} tr entities, ${(bytes / 1024).toFixed(1)} KB)`);
if (missing.length) {
  console.error('Missing cards:', missing);
  process.exit(1);
}
