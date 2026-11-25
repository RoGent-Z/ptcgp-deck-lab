import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDeckQrMatrix,
  createDeckQrSvg,
  decodeDeckQrPayload,
  decodeQrFromImageData,
  encodeDeckQrPayload,
  encodeDeckToGameQr,
  resolveDecodedPayloadToDeck
} from "../public/app/deck-qr.mjs";
import { validateDeck } from "../public/app/core.mjs";

const cards = JSON.parse(await readFile(new URL("../public/data/cards.json", import.meta.url), "utf8"));
const entityMap = JSON.parse(await readFile(new URL("../public/data/qr-entity-map.json", import.meta.url), "utf8"));
const metaTop = JSON.parse(await readFile(new URL("../public/data/meta.top.json", import.meta.url), "utf8"));
const cardsById = new Map(cards.map((c) => [c.id, c]));

test("QR entity map covers all 4,577 cards including promos, fossils, and SP1 Mew", () => {
  assert.equal(entityMap.totalCards, cards.length);
  const covered = new Set();
  for (const bucket of [entityMap.pk, entityMap.tr]) {
    for (const v of Object.values(bucket)) {
      for (const cid of Array.isArray(v) ? v : [v]) covered.add(cid);
    }
  }
  assert.equal(covered.size, cards.length, `Expected all ${cards.length} cards mapped, got ${covered.size}`);
  // Fossils must live in the Trainer namespace just like the real game
  const trIds = new Set(Object.values(entityMap.tr).flat());
  assert.equal(trIds.has("A1-216"), true, "Helix Fossil must be in trainer namespace");
  assert.equal(trIds.has("A1-218"), true, "Old Amber must be in trainer namespace");
});

test("real Pokémon TCG Pocket in-game deck code decodes to exact 20-card legal deck", () => {
  const realInGamePayload = "C5iWnpiWnpiXopiWqJiWqJiXwJiahpiYLpiaXpiaaJicAgkAM+oAM+oAA9QAA9QAM/4AM/4AR6QAGUYAGUYBBA==";
  const decoded = decodeDeckQrPayload(realInGamePayload);
  assert.equal(decoded.trainerIds.length + decoded.pokemonIds.length, 20);
  assert.deepEqual(decoded.energyTypes, [4]); // Lightning

  const resolved = resolveDecodedPayloadToDeck(decoded, entityMap, cardsById);
  assert.equal(resolved.totalCards, 20);
  assert.equal(resolved.unknownEntities.length, 0);
  assert.deepEqual(resolved.energy, ["Lightning"]);
  assert.deepEqual(validateDeck(resolved, cardsById), []);
  assert.ok(resolved.cards.some((e) => e.id === "B3a-019" && e.count === 1), "Expected 1x Miraidon ex");
  assert.ok(resolved.cards.some((e) => e.id === "B1a-026" && e.count === 2), "Expected 2x Magnezone");
  assert.ok(resolved.cards.some((e) => e.id === "A3-066" && e.count === 2), "Expected 2x Oricorio");
  assert.ok(resolved.cards.some((e) => e.id === "P-A-007" && e.count === 2), "Expected 2x Professor's Research");

  // Owned-print preference: when user owns an alt-art print (e.g. A1-225 vs A1-272 Sabrina / P-A-007), picks owned variant
  const altOwned = { "B1a-085": 2 }; // Alt-art if present, or test with A1-227 Bulbasaur
  const bulbPayload = encodeDeckQrPayload({
    trainerIds: Array(18).fill(10), // Potion
    pokemonIds: [10, 10], // Bulbasaur
    energyTypes: [1]
  });
  const decBulb = resolveDecodedPayloadToDeck(decodeDeckQrPayload(bulbPayload), entityMap, cardsById, { "A1-227": 2 });
  assert.ok(decBulb.cards.some((e) => e.id === "A1-227" && e.count === 2), "Should prefer owned alternate-art print");
});

test("all Top-10 meta decks round-trip through game QR SVG & standard/pocket-decorated image decoding", async () => {
  for (const entry of metaTop.entries.slice(0, 10)) {
    const enc = encodeDeckToGameQr(entry.representative, entityMap, cardsById);
    assert.ok(enc.svg.startsWith("<svg "));
    const dec = decodeDeckQrPayload(enc.payload);
    const res = resolveDecodedPayloadToDeck(dec, entityMap, cardsById);
    assert.equal(res.totalCards, 20, `${entry.name} round-trip card count`);
    assert.equal(res.unknownEntities.length, 0, `${entry.name} unknown entities`);
    assert.deepEqual(validateDeck(res, cardsById), [], `${entry.name} deck validity`);
  }

  // Render Top-1 deck into standard RGBA image AND synthetic Pocket blue-dotted center-obscured screenshot, verify BOTH decode!
  const top1Qr = encodeDeckToGameQr(metaTop.entries[0].representative, entityMap, cardsById);
  const matrix = createDeckQrMatrix(top1Qr.payload);
  assert.equal(matrix.length, 53);

  // 1) Standard black-on-white QR image
  const scale = 6;
  const margin = 4;
  const side = (53 + margin * 2) * scale;
  const stdPx = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < 53; r++) {
    for (let c = 0; c < 53; c++) {
      if (!matrix[r][c]) continue;
      for (let y = (r + margin) * scale; y < (r + margin + 1) * scale; y++) {
        for (let x = (c + margin) * scale; x < (c + margin + 1) * scale; x++) {
          const o = (y * side + x) * 4;
          stdPx[o] = 0; stdPx[o + 1] = 0; stdPx[o + 2] = 0; stdPx[o + 3] = 255;
        }
      }
    }
  }
  const stdRes = decodeQrFromImageData({ data: stdPx, width: side, height: side });
  assert.ok(stdRes && stdRes.payload === top1Qr.payload);

  // 2) Synthetic Pocket blue-dotted QR with a white center Poké Ball obstruction (simulating real game screenshot)
  const pScale = 10;
  const padX = 80;
  const padY = 120;
  const pw = 53 * pScale + padX * 2;
  const ph = 53 * pScale + padY * 2;
  const pocketPx = new Uint8ClampedArray(pw * ph * 4).fill(245);
  for (let i = 3; i < pocketPx.length; i += 4) pocketPx[i] = 255;
  for (let r = 0; r < 53; r++) {
    for (let c = 0; c < 53; c++) {
      if (!matrix[r][c]) continue;
      // Obscure center 9x9 region with white logo (tests QR Level-H error correction + dotted finder reconstruction)
      if (r >= 22 && r <= 30 && c >= 22 && c <= 30) continue;
      const isFinder = (r < 7 && c < 7) || (r < 7 && c >= 46) || (r >= 46 && c < 7);
      const cx = padX + c * pScale + pScale / 2;
      const cy = padY + r * pScale + pScale / 2;
      const rad = isFinder ? pScale * 0.52 : pScale * 0.36;
      for (let y = padY + r * pScale; y < padY + (r + 1) * pScale; y++) {
        for (let x = padX + c * pScale; x < padX + (c + 1) * pScale; x++) {
          if (isFinder || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad) {
            const o = (y * pw + x) * 4;
            pocketPx[o] = 0; pocketPx[o + 1] = 111; pocketPx[o + 2] = 199; pocketPx[o + 3] = 255;
          }
        }
      }
    }
  }
  const decPocket = decodeQrFromImageData({ data: pocketPx, width: pw, height: ph });
  assert.ok(decPocket, "Must recover blue-dotted center-obscured Pocket QR screenshot");
  assert.equal(decPocket.payload, top1Qr.payload);

  // 3) If real unedited in-game screenshot fixture is present in tmp/, verify end-to-end decode too!
  const realShotUrl = new URL("../tmp/sample-pocket-screenshot.png", import.meta.url);
  if (existsSync(realShotUrl)) {
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(await readFile(realShotUrl));
    const shotDec = decodeQrFromImageData({ data: png.data, width: png.width, height: png.height });
    assert.ok(shotDec && shotDec.method === "pocket-decorated");
    const shotResolved = resolveDecodedPayloadToDeck(decodeDeckQrPayload(shotDec.payload), entityMap, cardsById);
    assert.equal(shotResolved.totalCards, 20);
    assert.deepEqual(validateDeck(shotResolved, cardsById), []);
  }
});

test("rejects invalid non-deck QR payloads cleanly", () => {
  assert.throws(() => decodeDeckQrPayload("https://example.com/not-a-deck"));
  assert.throws(() => decodeDeckQrPayload(""));
  assert.throws(() => decodeDeckQrPayload("AAAA"));
});
