// Fast zero-allocation fixed-point i32 WASM runtime wrapper for Pocket Lab (Exact-Mechanics v3).
// Uses exact Q10 (* 1024) i32 weights/bonuses and Rng32 matching WebGPU WGSL bit-for-bit.
const FEATURES = 22;
const CARD_STRIDE = 28;
const MAX_ENEMIES = 10;
const MAX_CANDS = 40;
const moduleCache = new WeakMap();

function packCardFields(buf, off, c, slotId) {
  if (Array.isArray(c.v3Tpl) && c.v3Tpl.length >= 23) {
    for (let i = 0; i < 23; i++) buf[off + i] = c.v3Tpl[i] | 0;
    // Apply optimizer override if card was marked incompatible (stage===99 or disabled attack/trainer)
    if (c.stage === 99) {
      buf[off + 1] = (buf[off + 1] & ~0xff) | 99;
      buf[off + 7] = 255; buf[off + 8] = 0; buf[off + 9] = 0; buf[off + 10] = 0; buf[off + 11] = 0;
      buf[off + 12] = 255; buf[off + 13] = 0; buf[off + 14] = 0; buf[off + 15] = 0; buf[off + 16] = 0;
      buf[off + 17] = 0; buf[off + 18] = 0;
    } else if (c.isPokemon === 0 && c.trainerKind === 0) {
      buf[off + 19] = 0; buf[off + 20] = 0;
    } else if (c.isPokemon === 1) {
      if (c.a1Cost === 255) { buf[off + 7] = 255; buf[off + 8] = 0; buf[off + 9] = 0; buf[off + 10] = 0; buf[off + 11] = 0; }
      if (c.a2Cost === 255) { buf[off + 12] = 255; buf[off + 13] = 0; buf[off + 14] = 0; buf[off + 15] = 0; buf[off + 16] = 0; }
    }
    buf[off + 23] = slotId | 0;
    buf[off + 24] = 0;
    buf[off + 25] = 0;
    buf[off + 26] = 0;
    buf[off + 27] = 0;
    return;
  }
  // Fallback packing for synthetic unit-test cards without a v3 template
  const meta = (c.stage & 0xff)
    | (((c.evoGroup || 0) & 0xffff) << 8)
    | ((c.isSupporter ? 1 : 0) << 24)
    | ((c.isItem ? 1 : 0) << 25)
    | ((c.isFossil ? 1 : 0) << 26)
    | ((c.trainerKind === 5 ? 1 : 0) << 27)
    | ((c.trainerKind === 7 ? 1 : 0) << 28)
    | (((c.prize || 1) >= 3 ? 1 : 0) << 29)
    | (((c.prize || 1) >= 2 ? 1 : 0) << 30);
  const a1Cost = c.a1Cost !== undefined ? c.a1Cost : (c.atkCost ?? 1);
  const a1Dmg = c.a1Cost !== undefined ? c.a1Dmg : (c.atkDmg ?? 0);
  const a2Cost = c.a2Cost !== undefined ? c.a2Cost : 255;
  const a2Dmg = c.a2Cost !== undefined ? c.a2Dmg : 0;
  buf[off] = c.isPokemon | 0;
  buf[off + 1] = meta | 0;
  buf[off + 2] = (255 << 24) | 0;
  buf[off + 3] = (c.typeCode ?? 9) | 0;
  buf[off + 4] = (c.weakCode ?? 255) | 0;
  buf[off + 5] = (c.hp ?? 60) | 0;
  buf[off + 6] = ((c.retreat ?? 1) & 0xff) | (((c.prize ?? 1) & 0xff) << 8);
  buf[off + 7] = a1Cost | 0;
  buf[off + 8] = a1Dmg | 0;
  buf[off + 9] = (c.a1Op1 || 0) | ((c.a1Op2 || 0) << 8);
  buf[off + 10] = (c.a1Val1 || 0) | 0;
  buf[off + 11] = (c.a1Val2 || 0) | 0;
  buf[off + 12] = a2Cost | 0;
  buf[off + 13] = a2Dmg | 0;
  buf[off + 14] = (c.a2Op1 || 0) | ((c.a2Op2 || 0) << 8);
  buf[off + 15] = (c.a2Val1 || 0) | 0;
  buf[off + 16] = (c.a2Val2 || 0) | 0;
  buf[off + 17] = (c.abOp || 0) | 0;
  buf[off + 18] = (c.abVal || 0) | 0;
  buf[off + 19] = (c.trainerKind || 0) | ((c.trainerSub || 1) << 8);
  buf[off + 20] = (c.effectVal || 0) | 0;
  buf[off + 21] = 0;
  buf[off + 22] = 0;
  buf[off + 23] = slotId | 0;
  buf[off + 24] = 0;
  buf[off + 25] = 0;
  buf[off + 26] = 0;
  buf[off + 27] = 0;
}

async function compileFastModule(wasmSource) {
  if (wasmSource instanceof WebAssembly.Module) return wasmSource;
  if (typeof wasmSource === 'object' && wasmSource !== null && moduleCache.has(wasmSource)) {
    return moduleCache.get(wasmSource);
  }
  const view = wasmSource instanceof ArrayBuffer
    ? new Uint8Array(wasmSource)
    : new Uint8Array(wasmSource.buffer, wasmSource.byteOffset, wasmSource.byteLength);
  const mod = await WebAssembly.compile(view);
  if (typeof wasmSource === 'object' && wasmSource !== null) moduleCache.set(wasmSource, mod);
  return mod;
}

export async function instantiateFastSim(wasmSource) {
  const mod = await compileFastModule(wasmSource);
  const instance = await WebAssembly.instantiate(mod, {});
  const ex = instance.exports;
  const mem = ex.memory;

  const writeDeck = (slot, compactCards) => {
    const decks = new Int32Array(mem.buffer, ex.get_decks_ptr(), 12 * 20 * CARD_STRIDE);
    const bonuses = new Int32Array(mem.buffer, ex.get_bonus_ptr(), 12 * 20);
    const baseCard = slot * 20;
    for (let i = 0; i < 20; i++) {
      const c = compactCards[i] || compactCards[0];
      packCardFields(decks, (baseCard + i) * CARD_STRIDE, c, i);
      bonuses[baseCard + i] = Math.round(Number(c.strategyBonus || 0) * 1024);
    }
  };

  return function invokeFastSim(req) {
    if (req.op === 'explore_10m_chunk' || req.op === 'explore_chunk') {
      const enemies = req.enemies || [];
      const cands = req.candidates || [];
      const nOpps = Math.min(MAX_ENEMIES, enemies.length);
      const nCands = Math.min(MAX_CANDS, cands.length);

      writeDeck(0, req.deck);
      for (let o = 0; o < nOpps; o++) writeDeck(o + 1, enemies[o].cards);

      const weights = new Int32Array(mem.buffer, ex.get_weights_ptr(), (MAX_ENEMIES + MAX_CANDS) * FEATURES);
      weights.fill(0);
      const enemyWeightsList = req.enemy_weights_list || null;
      for (let o = 0; o < nOpps; o++) {
        const ew = (enemyWeightsList && enemyWeightsList[o]) || req.enemy_weights || [];
        const off = o * FEATURES;
        for (let k = 0; k < FEATURES; k++) weights[off + k] = Math.round(Number(ew[k] || 0) * 1024);
      }
      for (let c = 0; c < nCands; c++) {
        const off = (MAX_ENEMIES + c) * FEATURES;
        for (let k = 0; k < FEATURES; k++) weights[off + k] = Math.round(Number(cands[c][k] || 0) * 1024);
      }

      ex.run_explore_chunk(
        nOpps,
        nCands,
        req.games_per_opponent >>> 0,
        req.start_game >>> 0,
        req.count >>> 0,
        req.seed_base >>> 0
      );

      const u32 = new Uint32Array(mem.buffer, ex.get_out_u32_ptr(), 4096);
      const f64 = new Float64Array(mem.buffer, ex.get_out_f64_ptr(), 3072);

      const byCandidate = [];
      for (let c = 0; c < nCands; c++) {
        const co = 8 + c * 6;
        const cf = c * 44;
        byCandidate.push({
          games: u32[co],
          wins: u32[co + 1],
          draws: u32[co + 2],
          losses: u32[co + 3],
          winFeatCount: u32[co + 4],
          lossFeatCount: u32[co + 5],
          winFeatSum: Array.from(f64.subarray(cf, cf + FEATURES)),
          lossFeatSum: Array.from(f64.subarray(cf + FEATURES, cf + 44))
        });
      }

      const oppStride = 6 + nCands * 4;
      const byOpponent = [];
      for (let o = 0; o < nOpps; o++) {
        const oo = 512 + o * oppStride;
        const of = 2048 + o * 44;
        const oppCands = [];
        for (let c = 0; c < nCands; c++) {
          const oco = oo + 6 + c * 4;
          oppCands.push({
            games: u32[oco],
            wins: u32[oco + 1],
            draws: u32[oco + 2],
            losses: u32[oco + 3]
          });
        }
        byOpponent.push({
          id: enemies[o].id,
          games: u32[oo],
          wins: u32[oo + 1],
          draws: u32[oo + 2],
          losses: u32[oo + 3],
          winFeatCount: u32[oo + 4],
          lossFeatCount: u32[oo + 5],
          winFeatSum: Array.from(f64.subarray(of, of + FEATURES)),
          lossFeatSum: Array.from(f64.subarray(of + FEATURES, of + 44)),
          byCandidate: oppCands
        });
      }

      return {
        startGame: req.start_game,
        completed: u32[0],
        wins: u32[1],
        draws: u32[2],
        losses: u32[3],
        turnsSum: u32[4] + u32[5] * 4294967296,
        byCandidate,
        byOpponent
      };
    }

    if (req.op === 'test_50k_chunk' || req.op === 'test_chunk') {
      writeDeck(0, req.deck);
      writeDeck(1, req.enemy);
      const weights = new Int32Array(mem.buffer, ex.get_weights_ptr(), (MAX_ENEMIES + 1) * FEATURES);
      for (let k = 0; k < FEATURES; k++) {
        weights[k] = Math.round(Number(req.enemy_weights[k] || 0) * 1024);
        weights[MAX_ENEMIES * FEATURES + k] = Math.round(Number(req.weights[k] || 0) * 1024);
      }

      const n = ex.run_test_chunk(
        1,
        req.start_idx >>> 0,
        req.count >>> 0,
        req.total_per_opp >>> 0,
        req.seed_base >>> 0
      );

      const u32 = new Uint32Array(mem.buffer, ex.get_out_u32_ptr(), 16);
      const u8 = new Uint8Array(mem.buffer, ex.get_out_u8_ptr(), n * 2);
      const outcomes = new Uint8Array(n);
      const turns = new Uint8Array(n);
      outcomes.set(u8.subarray(0, n));
      turns.set(u8.subarray(n, n * 2));

      return {
        opponentId: req.opponent_id,
        startIdx: req.start_idx,
        completed: u32[0],
        wins: u32[1],
        draws: u32[2],
        losses: u32[3],
        firstWins: u32[4],
        firstDraws: u32[5],
        firstLosses: u32[6],
        secondWins: u32[7],
        secondDraws: u32[8],
        secondLosses: u32[9],
        turnsSum: u32[10],
        outcomes,
        turns
      };
    }

    if (req.op === 'replay_game') {
      writeDeck(0, req.deck);
      writeDeck(1, req.enemy);
      const weights = new Int32Array(mem.buffer, ex.get_weights_ptr(), (MAX_ENEMIES + 1) * FEATURES);
      for (let k = 0; k < FEATURES; k++) {
        weights[k] = Math.round(Number(req.enemy_weights[k] || 0) * 1024);
        weights[MAX_ENEMIES * FEATURES + k] = Math.round(Number(req.weights[k] || 0) * 1024);
      }
      const stepCount = ex.run_replay_game(
        1,
        req.game_idx >>> 0,
        req.total_per_opp >>> 0,
        req.seed_base >>> 0
      );
      const u32 = new Uint32Array(mem.buffer, ex.get_out_u32_ptr(), 8);
      const raw = new Int32Array(mem.buffer, ex.get_replay_ptr(), stepCount * 24);
      const steps = [];
      for (let i = 0; i < stepCount; i++) {
        const o = i * 24;
        steps.push({
          turn: raw[o],
          actor: raw[o + 1],
          kind: raw[o + 2],
          cardIdx: raw[o + 3],
          aux1: raw[o + 4],
          aux2: raw[o + 5],
          points: [raw[o + 6], raw[o + 7]],
          board: [
            {
              cardIdx: raw[o + 8],
              hp: raw[o + 9],
              maxHp: raw[o + 10],
              energy: raw[o + 11],
              bench: raw[o + 12],
              hand: raw[o + 13],
              deck: raw[o + 14],
              tool: raw[o + 15]
            },
            {
              cardIdx: raw[o + 16],
              hp: raw[o + 17],
              maxHp: raw[o + 18],
              energy: raw[o + 19],
              bench: raw[o + 20],
              hand: raw[o + 21],
              deck: raw[o + 22],
              tool: raw[o + 23]
            }
          ]
        });
      }
      const code = u32[0];
      return {
        outcome: code === 1 ? 'win' : code === 0 ? 'loss' : 'draw',
        turns: u32[1],
        first: u32[2],
        points: [u32[3], u32[4]],
        steps
      };
    }

    if (req.op === 'optimize_batch') {
      const enemies = req.enemies || [];
      const candCards = req.candidate_cards || [];
      const nOpps = Math.min(MAX_ENEMIES, enemies.length);
      const nCands = Math.min(256, candCards.length);

      writeDeck(0, req.base_deck);
      for (let o = 0; o < nOpps; o++) writeDeck(o + 1, enemies[o].cards);

      const weights = new Int32Array(mem.buffer, ex.get_weights_ptr(), (MAX_ENEMIES + 1) * FEATURES);
      weights.fill(0);
      const enemyWeightsList = req.enemy_weights_list || [];
      for (let o = 0; o < nOpps; o++) {
        const ew = enemyWeightsList[o] || req.enemy_weights || [];
        const off = o * FEATURES;
        for (let k = 0; k < FEATURES; k++) weights[off + k] = Math.round(Number(ew[k] || 0) * 1024);
      }
      const pw = req.player_weights || [];
      for (let k = 0; k < FEATURES; k++) weights[MAX_ENEMIES * FEATURES + k] = Math.round(Number(pw[k] || 0) * 1024);

      const cBuf = new Int32Array(mem.buffer, ex.get_cand_cards_ptr(), 256 * CARD_STRIDE);
      const cBonus = new Int32Array(mem.buffer, ex.get_cand_bonus_ptr(), 256);
      for (let i = 0; i < nCands; i++) {
        const c = candCards[i];
        packCardFields(cBuf, i * CARD_STRIDE, c, 19);
        cBonus[i] = Math.round(Number(c.strategyBonus || 0) * 1024);
      }

      ex.run_optimize_batch(nCands, nOpps, req.games_per_opp >>> 0, req.seed_base >>> 0);
      const u32 = new Uint32Array(mem.buffer, ex.get_out_u32_ptr(), nCands * 4);
      const results = [];
      for (let i = 0; i < nCands; i++) {
        const o = i * 4;
        results.push({
          games: u32[o],
          wins: u32[o + 1],
          draws: u32[o + 2],
          losses: u32[o + 3]
        });
      }
      return { results };
    }

    throw Error(`Unknown fastsim op: ${req.op}`);
  };
}
