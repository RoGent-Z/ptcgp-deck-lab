// High-Throughput WebGPU Compute Shader Engine for Pocket Lab 1B Explore + 5M Test.
// Key GPU optimizations:
// 1. Persistent VRAM storage buffers (zero per-batch VRAM allocation).
// 2. Workgroup Shared Memory caching of both 20-card decks (wg_cards[40]) and 22-dim weights (wg_w0/wg_w1).
// 3. Index-only per-thread state (u32 card indices instead of 60-byte Card structs -> ~12x lower register pressure).
// 4. 2D (pair_idx, opp*cand) dispatch + workgroup shared-memory reduction (1 global atomic per 4,096 games).
// 5. Exact fixed-point i32 Q10 (*1024) scoring + exact Rng32 matching fastsim.wasm bit-for-bit.

const FEATURES = 22;
const CARD_STRIDE = 16;
const MAX_ENEMIES = 10;
const MAX_CANDS = 40;

const WGSL_SHARED_HEADER = /* wgsl */ `
const FEATURES: u32 = 22u;
const CARD_STRIDE: u32 = 16u;
const MAX_ENEMIES: u32 = 10u;

struct Params {
  n_opps: u32,
  n_cands: u32,
  games_per_opp: u32,
  start_pair: u32,
  pair_count: u32,
  seed_base: u32,
  games_per_thread: u32,
  total_per_opp: u32,
};

struct Card {
  is_pokemon: i32,
  stage: i32,
  type_code: i32,
  weak_code: i32,
  hp: i32,
  retreat: i32,
  prize: i32,
  atk_cost: i32,
  atk_dmg: i32,
  atk_flags: i32,
  ab_flags: i32,
  trainer_kind: i32,
  effect_val: i32,
  power_q: i32,
  bonus_q: i32,
};

struct Slot {
  occ: i32,
  ci: u32,
  hp: i32,
  max_hp: i32,
  energy: i32,
  tool: i32,
  status: i32,
  turn_placed: i32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> decks_buf: array<i32>;
@group(0) @binding(2) var<storage, read> weights_buf: array<i32>;
@group(0) @binding(3) var<storage, read_write> out_u32: array<atomic<u32>>;

var<workgroup> wg_cards: array<Card, 40>;
var<workgroup> wg_w0: array<i32, 22>;
var<workgroup> wg_w1: array<i32, 22>;

fn load_card_vram(deck_slot: u32, idx: u32) -> Card {
  let o = (deck_slot * 20u + idx) * CARD_STRIDE;
  var c: Card;
  c.is_pokemon = decks_buf[o];
  c.stage = decks_buf[o + 1u];
  c.type_code = decks_buf[o + 2u];
  c.weak_code = decks_buf[o + 3u];
  c.hp = decks_buf[o + 4u];
  c.retreat = decks_buf[o + 5u];
  c.prize = max(1, decks_buf[o + 6u]);
  c.atk_cost = max(1, decks_buf[o + 7u]);
  c.atk_dmg = decks_buf[o + 8u];
  c.atk_flags = decks_buf[o + 9u];
  c.ab_flags = decks_buf[o + 10u];
  c.trainer_kind = decks_buf[o + 11u];
  c.effect_val = decks_buf[o + 12u];
  c.power_q = (c.atk_dmg * 1024) / 100;
  c.bonus_q = decks_buf[o + 14u];
  return c;
}

fn rng_init(seed: u32) -> u32 {
  var s = seed ^ 0x9e3779b9u;
  s = s ^ (s >> 16u);
  s = s * 0x7feb352du;
  s = s ^ (s >> 15u);
  s = s * 0x846ca68bu;
  s = s ^ (s >> 16u);
  return s | 1u;
}

fn rng_next(state: ptr<function, u32>) -> u32 {
  var x = *state;
  x = x ^ (x << 13u);
  x = x ^ (x >> 17u);
  x = x ^ (x << 5u);
  *state = x;
  return x * 0x27d4eb2du;
}

fn get_w(cur: u32, k: u32) -> i32 {
  if (cur == 0u) { return wg_w0[k]; }
  return wg_w1[k];
}

fn sim_game(seed: u32, first_player: u32) -> vec2<u32> {
  var rng = rng_init(seed);
  var lib0: array<u32, 20>;
  var lib1: array<u32, 20>;
  for (var i = 0u; i < 20u; i = i + 1u) {
    lib0[i] = i;
    lib1[i] = 20u + i;
  }
  var lib_len = array<u32, 2>(20u, 20u);
  var hand0: array<u32, 12>;
  var hand1: array<u32, 12>;
  var hand_len = array<u32, 2>(0u, 0u);
  var b0: array<Slot, 4>;
  var b1: array<Slot, 4>;
  for (var s = 0u; s < 4u; s = s + 1u) {
    b0[s].occ = 0;
    b1[s].occ = 0;
  }
  var points = array<i32, 2>(0, 0);

  // Setup player 0
  for (var i = 19u; i >= 1u; i = i - 1u) {
    let j = rng_next(&rng) % (i + 1u);
    let tmp = lib0[i]; lib0[i] = lib0[j]; lib0[j] = tmp;
  }
  var bp0 = 20u;
  for (var i = 0u; i < 20u; i = i + 1u) {
    let c = wg_cards[lib0[i]];
    if (c.is_pokemon == 1 && c.stage == 0) { bp0 = i; break; }
  }
  if (bp0 < 20u && bp0 >= 5u) { let t = lib0[0]; lib0[0] = lib0[bp0]; lib0[bp0] = t; }
  for (var i = 0u; i < 5u; i = i + 1u) {
    lib_len[0] = lib_len[0] - 1u;
    hand0[hand_len[0]] = lib0[lib_len[0]];
    hand_len[0] = hand_len[0] + 1u;
  }
  var pa0 = false;
  var idx0 = 0u;
  loop {
    if (idx0 >= hand_len[0]) { break; }
    let ci = hand0[idx0];
    let c = wg_cards[ci];
    if (c.is_pokemon == 1 && c.stage == 0) {
      if (!pa0) {
        b0[0] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, 0);
        pa0 = true;
        hand_len[0] = hand_len[0] - 1u;
        hand0[idx0] = hand0[hand_len[0]];
        continue;
      } else {
        var pb = false;
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (b0[s].occ == 0) { b0[s] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, 0); pb = true; break; }
        }
        if (pb) {
          hand_len[0] = hand_len[0] - 1u;
          hand0[idx0] = hand0[hand_len[0]];
          continue;
        }
      }
    }
    idx0 = idx0 + 1u;
  }
  if (!pa0) {
    let fb = wg_cards[0u];
    b0[0] = Slot(1, 0u, max(60, fb.hp), max(60, fb.hp), 0, 0, 0, 0);
  }

  // Setup player 1
  for (var i = 19u; i >= 1u; i = i - 1u) {
    let j = rng_next(&rng) % (i + 1u);
    let tmp = lib1[i]; lib1[i] = lib1[j]; lib1[j] = tmp;
  }
  var bp1 = 20u;
  for (var i = 0u; i < 20u; i = i + 1u) {
    let c = wg_cards[lib1[i]];
    if (c.is_pokemon == 1 && c.stage == 0) { bp1 = i; break; }
  }
  if (bp1 < 20u && bp1 >= 5u) { let t = lib1[0]; lib1[0] = lib1[bp1]; lib1[bp1] = t; }
  for (var i = 0u; i < 5u; i = i + 1u) {
    lib_len[1] = lib_len[1] - 1u;
    hand1[hand_len[1]] = lib1[lib_len[1]];
    hand_len[1] = hand_len[1] + 1u;
  }
  var pa1 = false;
  var idx1 = 0u;
  loop {
    if (idx1 >= hand_len[1]) { break; }
    let ci = hand1[idx1];
    let c = wg_cards[ci];
    if (c.is_pokemon == 1 && c.stage == 0) {
      if (!pa1) {
        b1[0] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, 0);
        pa1 = true;
        hand_len[1] = hand_len[1] - 1u;
        hand1[idx1] = hand1[hand_len[1]];
        continue;
      } else {
        var pb = false;
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (b1[s].occ == 0) { b1[s] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, 0); pb = true; break; }
        }
        if (pb) {
          hand_len[1] = hand_len[1] - 1u;
          hand1[idx1] = hand1[hand_len[1]];
          continue;
        }
      }
    }
    idx1 = idx1 + 1u;
  }
  if (!pa1) {
    let fb = wg_cards[20u];
    b1[0] = Slot(1, 20u, max(60, fb.hp), max(60, fb.hp), 0, 0, 0, 0);
  }

  var cur = first_player;
  for (var turn = 1u; turn <= 30u; turn = turn + 1u) {
    let foe = 1u - cur;
    var my_b: array<Slot, 4>;
    var fo_b: array<Slot, 4>;
    var my_h: array<u32, 12>;
    if (cur == 0u) {
      my_b = b0; fo_b = b1; my_h = hand0;
    } else {
      my_b = b1; fo_b = b0; my_h = hand1;
    }
    var my_hl = hand_len[cur];
    var fo_hl = hand_len[foe];
    var my_ll = lib_len[cur];

    if (my_ll > 0u && my_hl < 12u) {
      my_ll = my_ll - 1u;
      if (cur == 0u) { my_h[my_hl] = lib0[my_ll]; } else { my_h[my_hl] = lib1[my_ll]; }
      my_hl = my_hl + 1u;
    }

    var energy_attached = (turn == 1u);
    var supporter_used = false;
    var retreated = false;
    var ability_used = false;
    var dmg_boost = 0;

    for (var step = 0u; step < 8u; step = step + 1u) {
      var best_kind = 0u;
      var best_a = 0u;
      var best_b = 0u;
      var best_score = get_w(cur, 0u);

      // 1. Place basics
      for (var hi = 0u; hi < my_hl; hi = hi + 1u) {
        let c = wg_cards[my_h[hi]];
        if (c.is_pokemon == 1 && c.stage == 0) {
          for (var s = 1u; s < 4u; s = s + 1u) {
            if (my_b[s].occ == 0) {
              let sc = get_w(cur, 2u) + (((c.power_q * get_w(cur, 3u)) >> 10u) * 15 / 100) + ((c.bonus_q * 35) / 100);
              if (sc > best_score) { best_score = sc; best_kind = 1u; best_a = hi; best_b = s; }
              break;
            }
          }
        }
      }

      // 2. Evolve
      if (turn >= 2u) {
        for (var hi = 0u; hi < my_hl; hi = hi + 1u) {
          let c = wg_cards[my_h[hi]];
          if (c.is_pokemon == 1 && c.stage > 0) {
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (my_b[s].occ == 1 && wg_cards[my_b[s].ci].stage + 1 == c.stage && my_b[s].turn_placed < i32(turn)) {
                let ps = select(c.power_q >> 1u, c.power_q, s == 0u);
                let sc = get_w(cur, 4u) + ((ps * get_w(cur, 5u)) >> 10u) + ((c.bonus_q * 45) / 100);
                if (sc > best_score) { best_score = sc; best_kind = 2u; best_a = hi; best_b = s; }
              }
            }
          }
        }
      }

      // 3. Abilities
      if (!ability_used) {
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (my_b[s].occ == 1) {
            let scard = wg_cards[my_b[s].ci];
            if (scard.ab_flags != 0) {
              let sn = select(0, (get_w(cur, 21u) * 35) / 100, (scard.ab_flags & 16) != 0);
              let sc = get_w(cur, 6u) + sn + ((scard.bonus_q * 35) / 100);
              if (sc > best_score) { best_score = sc; best_kind = 4u; best_a = s; }
            }
          }
        }
      }

      // 4. Trainers
      for (var hi = 0u; hi < my_hl; hi = hi + 1u) {
        let c = wg_cards[my_h[hi]];
        if (c.is_pokemon == 0) {
          let is_sup = (c.trainer_kind == 2 || c.trainer_kind == 3 || c.trainer_kind == 4);
          if (is_sup && supporter_used) { continue; }
          var sc = get_w(cur, 7u) + ((c.bonus_q * 40) / 100);
          if (c.trainer_kind == 1) {
            let inv = 5120 / (5 + i32(my_hl));
            sc = sc + ((inv * get_w(cur, 8u)) >> 10u);
          } else if (c.trainer_kind == 2) {
            let missing = my_b[0].max_hp - my_b[0].hp;
            if (missing <= 0) { continue; }
            sc = sc + (get_w(cur, 20u) * min(missing, c.effect_val)) / 50;
          } else if (c.trainer_kind == 3) {
            sc = sc + ((get_w(cur, 19u) * 45) + (get_w(cur, 21u) * 25)) / 100;
          } else if (c.trainer_kind == 4) {
            sc = sc + ((get_w(cur, 10u) * 35) + (get_w(cur, 11u) * 25)) / 100;
          } else if (c.trainer_kind == 5) {
            if (my_b[0].tool != 0) { continue; }
            sc = sc + get_w(cur, 20u);
          } else if (c.trainer_kind == 6) {
            sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
          } else if (c.trainer_kind == 7) {
            sc = sc + get_w(cur, 6u);
          }
          if (sc > best_score) { best_score = sc; best_kind = 3u; best_a = hi; }
        }
      }

      // 5. Energy attach
      if (!energy_attached) {
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (my_b[s].occ == 1) {
            let scard = wg_cards[my_b[s].ci];
            let need = select(0, get_w(cur, 15u), my_b[s].energy < scard.atk_cost);
            let sc = get_w(cur, 13u)
              + select(0, get_w(cur, 14u), s == 0u)
              + need
              + ((scard.power_q * get_w(cur, 16u)) >> 10u)
              + ((scard.bonus_q * 25) / 100);
            if (sc > best_score) { best_score = sc; best_kind = 5u; best_a = s; }
          }
        }
      }

      // 6. Retreat
      if (!retreated && my_b[0].occ == 1 && (my_b[0].status & 4) == 0 && my_b[0].energy >= wg_cards[my_b[0].ci].retreat) {
        let fo_dmg = select(0, wg_cards[fo_b[0].ci].atk_dmg, fo_b[0].occ == 1);
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (my_b[s].occ == 1) {
            let endg = select(0, get_w(cur, 18u), my_b[0].hp <= fo_dmg && my_b[s].hp > my_b[0].hp);
            let sc = get_w(cur, 17u) + endg;
            if (sc > best_score) { best_score = sc; best_kind = 6u; best_a = s; }
          }
        }
      }

      // 7. Attack
      if (turn >= 2u && my_b[0].occ == 1 && (my_b[0].status & 4) == 0) {
        let atk = wg_cards[my_b[0].ci];
        if (my_b[0].energy >= atk.atk_cost && atk.atk_dmg > 0) {
          let weak_b = select(0, 20, fo_b[0].occ == 1 && wg_cards[fo_b[0].ci].weak_code == atk.type_code);
          let tdmg = atk.atk_dmg + dmg_boost + weak_b;
          let ko = select(0, get_w(cur, 11u), fo_b[0].occ == 1 && tdmg >= fo_b[0].hp);
          let eff = select(0, get_w(cur, 12u), (atk.atk_flags & 1) != 0);
          let sn = select(0, get_w(cur, 21u) >> 1u, (atk.atk_flags & 2) != 0);
          let sc = get_w(cur, 9u) + ((tdmg * get_w(cur, 10u)) / 100) + ko + eff + sn + ((atk.bonus_q * 40) / 100);
          if (sc > best_score) { best_kind = 7u; }
        }
      }

      if (best_kind == 0u) {
        break;
      } else if (best_kind == 1u) {
        let ci = my_h[best_a];
        let c = wg_cards[ci];
        my_b[best_b] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, i32(turn));
        my_hl = my_hl - 1u;
        my_h[best_a] = my_h[my_hl];
      } else if (best_kind == 2u) {
        let ci = my_h[best_a];
        let c = wg_cards[ci];
        let taken = max(0, my_b[best_b].max_hp - my_b[best_b].hp);
        let bhp = select(0, 20, my_b[best_b].tool == 1);
        my_b[best_b].ci = ci;
        my_b[best_b].max_hp = c.hp + bhp;
        my_b[best_b].hp = max(10, my_b[best_b].max_hp - taken);
        my_b[best_b].status = 0;
        my_b[best_b].turn_placed = i32(turn);
        my_hl = my_hl - 1u;
        my_h[best_a] = my_h[my_hl];
      } else if (best_kind == 3u) {
        let c = wg_cards[my_h[best_a]];
        my_hl = my_hl - 1u;
        my_h[best_a] = my_h[my_hl];
        if (c.trainer_kind == 2 || c.trainer_kind == 3 || c.trainer_kind == 4) { supporter_used = true; }
        if (c.trainer_kind == 1) {
          let draws = u32(clamp(c.effect_val, 1, 2));
          for (var d = 0u; d < draws; d = d + 1u) {
            if (my_ll > 0u && my_hl < 12u) {
              my_ll = my_ll - 1u;
              if (cur == 0u) { my_h[my_hl] = lib0[my_ll]; } else { my_h[my_hl] = lib1[my_ll]; }
              my_hl = my_hl + 1u;
            }
          }
        } else if (c.trainer_kind == 2) {
          my_b[0].hp = min(my_b[0].max_hp, my_b[0].hp + c.effect_val);
        } else if (c.trainer_kind == 3) {
          if (c.effect_val == 3) {
            if (fo_hl > 3u) { fo_hl = 3u; }
          } else {
            var pick = 4u;
            for (var s = 1u; s < 4u; s = s + 1u) {
              if (fo_b[s].occ == 1) {
                if (c.effect_val == 2 && fo_b[s].hp < fo_b[s].max_hp) { pick = s; break; }
                if (pick == 4u || fo_b[s].hp < fo_b[pick].hp) { pick = s; }
              }
            }
            if (pick < 4u) { let tmp = fo_b[0]; fo_b[0] = fo_b[pick]; fo_b[pick] = tmp; }
          }
        } else if (c.trainer_kind == 4) {
          dmg_boost = dmg_boost + c.effect_val;
        } else if (c.trainer_kind == 5) {
          if (c.effect_val > 0) {
            my_b[0].tool = 1; my_b[0].max_hp = my_b[0].max_hp + 20; my_b[0].hp = my_b[0].hp + 20;
          } else {
            my_b[0].tool = 2;
          }
        } else if (c.trainer_kind == 6) {
          if (c.effect_val == 99 && turn >= 2u) {
            for (var hi2 = 0u; hi2 < my_hl; hi2 = hi2 + 1u) {
              let ev_ci = my_h[hi2];
              let ev = wg_cards[ev_ci];
              if (ev.is_pokemon == 1 && ev.stage == 2) {
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (my_b[s].occ == 1 && wg_cards[my_b[s].ci].stage == 0 && my_b[s].turn_placed < i32(turn)) {
                    let tk = max(0, my_b[s].max_hp - my_b[s].hp);
                    my_b[s].ci = ev_ci;
                    my_b[s].max_hp = ev.hp + select(0, 20, my_b[s].tool == 1);
                    my_b[s].hp = max(10, my_b[s].max_hp - tk);
                    my_b[s].status = 0;
                    my_b[s].turn_placed = i32(turn);
                    my_hl = my_hl - 1u;
                    my_h[hi2] = my_h[my_hl];
                    break;
                  }
                }
                break;
              }
            }
          } else if (c.effect_val >= 2) {
            my_b[0].energy = my_b[0].energy + 1;
          }
        } else if (c.trainer_kind == 7) {
          dmg_boost = dmg_boost + 10;
        }
      } else if (best_kind == 4u) {
        ability_used = true;
        let ab = wg_cards[my_b[best_a].ci].ab_flags;
        if ((ab & 2) != 0 && my_ll > 0u && my_hl < 12u) {
          my_ll = my_ll - 1u;
          if (cur == 0u) { my_h[my_hl] = lib0[my_ll]; } else { my_h[my_hl] = lib1[my_ll]; }
          my_hl = my_hl + 1u;
        }
        if ((ab & 4) != 0) { my_b[0].energy = my_b[0].energy + 1; }
        if ((ab & 8) != 0) { my_b[0].hp = min(my_b[0].max_hp, my_b[0].hp + 20); }
        if ((ab & 16) != 0) {
          var ts = 0u;
          for (var s = 1u; s < 4u; s = s + 1u) { if (fo_b[s].occ == 1) { ts = s; break; } }
          if (fo_b[ts].occ == 1) {
            fo_b[ts].hp = fo_b[ts].hp - 20;
            if (fo_b[ts].hp <= 0) {
              points[cur] = points[cur] + wg_cards[fo_b[ts].ci].prize;
              fo_b[ts].occ = 0;
              if (ts == 0u) {
                for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (fo_b[ns].occ == 1) { let tmp = fo_b[0]; fo_b[0] = fo_b[ns]; fo_b[ns] = tmp; break; } }
              }
              if (points[cur] >= 3 || fo_b[0].occ == 0) {
                return vec2<u32>(select(0u, 1u, cur == 0u), turn);
              }
            }
          }
        }
      } else if (best_kind == 5u) {
        energy_attached = true;
        my_b[best_a].energy = my_b[best_a].energy + 1;
      } else if (best_kind == 6u) {
        retreated = true;
        my_b[0].energy = max(0, my_b[0].energy - wg_cards[my_b[0].ci].retreat);
        my_b[0].status = 0;
        let tmp = my_b[0]; my_b[0] = my_b[best_a]; my_b[best_a] = tmp;
      } else if (best_kind == 7u) {
        let atk = wg_cards[my_b[0].ci];
        let weak_b = select(0, 20, fo_b[0].occ == 1 && wg_cards[fo_b[0].ci].weak_code == atk.type_code);
        let tdmg = atk.atk_dmg + dmg_boost + weak_b;
        if (fo_b[0].occ == 1) {
          fo_b[0].hp = fo_b[0].hp - tdmg;
          if (fo_b[0].tool == 2) { my_b[0].hp = my_b[0].hp - 20; }
          if ((atk.atk_flags & 2) != 0) {
            for (var s = 1u; s < 4u; s = s + 1u) {
              if (fo_b[s].occ == 1) {
                fo_b[s].hp = fo_b[s].hp - 20;
                if (fo_b[s].hp <= 0) { points[cur] = points[cur] + wg_cards[fo_b[s].ci].prize; fo_b[s].occ = 0; }
                break;
              }
            }
          }
          if ((atk.atk_flags & 4) != 0) { fo_b[0].status = fo_b[0].status | 1; }
          if ((atk.atk_flags & 8) != 0) { my_b[0].hp = min(my_b[0].max_hp, my_b[0].hp + 20); }
          if ((atk.atk_flags & 16) != 0) { my_b[0].energy = my_b[0].energy + 1; }

          if (fo_b[0].hp <= 0) {
            points[cur] = points[cur] + wg_cards[fo_b[0].ci].prize;
            fo_b[0].occ = 0;
            for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (fo_b[ns].occ == 1) { let tmp = fo_b[0]; fo_b[0] = fo_b[ns]; fo_b[ns] = tmp; break; } }
          }
          if (my_b[0].hp <= 0) {
            points[foe] = points[foe] + wg_cards[my_b[0].ci].prize;
            my_b[0].occ = 0;
            for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (my_b[ns].occ == 1) { let tmp = my_b[0]; my_b[0] = my_b[ns]; my_b[ns] = tmp; break; } }
          }
          let cw = (points[cur] >= 3 || fo_b[0].occ == 0);
          let fw = (points[foe] >= 3 || my_b[0].occ == 0);
          if (cw && fw) { return vec2<u32>(2u, turn); }
          if (cw) { return vec2<u32>(select(0u, 1u, cur == 0u), turn); }
          if (fw) { return vec2<u32>(select(0u, 1u, foe == 0u), turn); }
        }
        break;
      }
    }

    if (cur == 0u) { b0 = my_b; b1 = fo_b; hand0 = my_h; } else { b1 = my_b; b0 = fo_b; hand1 = my_h; }
    hand_len[cur] = my_hl;
    hand_len[foe] = fo_hl;
    lib_len[cur] = my_ll;

    if (b0[0].occ == 1 && (b0[0].status & 1) != 0) {
      b0[0].hp = b0[0].hp - 10;
      if (b0[0].hp <= 0) {
        points[1] = points[1] + wg_cards[b0[0].ci].prize; b0[0].occ = 0;
        for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (b0[ns].occ == 1) { let tmp = b0[0]; b0[0] = b0[ns]; b0[ns] = tmp; break; } }
        if (points[1] >= 3 || b0[0].occ == 0) { return vec2<u32>(0u, turn); }
      }
    }
    if (b1[0].occ == 1 && (b1[0].status & 1) != 0) {
      b1[0].hp = b1[0].hp - 10;
      if (b1[0].hp <= 0) {
        points[0] = points[0] + wg_cards[b1[0].ci].prize; b1[0].occ = 0;
        for (var ns = 1u; ns < 4u; ns = ns + 1u) { if (b1[ns].occ == 1) { let tmp = b1[0]; b1[0] = b1[ns]; b1[ns] = tmp; break; } }
        if (points[0] >= 3 || b1[0].occ == 0) { return vec2<u32>(1u, turn); }
      }
    }

    cur = foe;
  }
  return vec2<u32>(2u, 30u);
}
`;

// Explore kernel uses ONLY bindings 0, 1, 2, 3 (matching exploreBindGroup!)
const WGSL_EXPLORE = WGSL_SHARED_HEADER + /* wgsl */ `
var<workgroup> wg_tot: atomic<u32>;
var<workgroup> wg_w: atomic<u32>;
var<workgroup> wg_d: atomic<u32>;
var<workgroup> wg_l: atomic<u32>;
var<workgroup> wg_t: atomic<u32>;

@compute @workgroup_size(128)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  let n_opps = params.n_opps;
  let nc = params.n_cands;
  let pair_slot_y = gid.y;
  let opp_idx = pair_slot_y / nc;
  let cand_idx = pair_slot_y % nc;

  // Cooperatively cache decks + weights into fast on-chip workgroup shared memory!
  if (opp_idx < n_opps) {
    if (lid.x < 20u) {
      wg_cards[lid.x] = load_card_vram(0u, lid.x);
    } else if (lid.x < 40u) {
      wg_cards[lid.x] = load_card_vram(opp_idx + 1u, lid.x - 20u);
    } else if (lid.x < 62u) {
      let k = lid.x - 40u;
      wg_w0[k] = weights_buf[(MAX_ENEMIES + cand_idx) * FEATURES + k];
    } else if (lid.x < 84u) {
      let k = lid.x - 62u;
      wg_w1[k] = weights_buf[opp_idx * FEATURES + k];
    }
  }
  if (lid.x == 0u) {
    atomicStore(&wg_tot, 0u);
    atomicStore(&wg_w, 0u);
    atomicStore(&wg_d, 0u);
    atomicStore(&wg_l, 0u);
    atomicStore(&wg_t, 0u);
  }
  workgroupBarrier();

  let gpt = params.games_per_thread;
  let base_k = gid.x * gpt;
  let end_k = min(params.pair_count, base_k + gpt);

  let pairs_per_opp = max(2u, params.games_per_opp / nc);
  let half_pairs = max(1u, pairs_per_opp / 2u);
  let opp_seed_mix = params.seed_base ^ ((opp_idx + 1u) * 1000003u);

  var loc_tot = 0u;
  var loc_w = 0u;
  var loc_d = 0u;
  var loc_l = 0u;
  var loc_t = 0u;

  if (opp_idx < n_opps && base_k < params.pair_count) {
    for (var k = base_k; k < end_k; k = k + 1u) {
      let pair_idx = params.start_pair + k;
      if (pair_idx >= pairs_per_opp) { break; }
      let first = select(1u, 0u, pair_idx < half_pairs);
      let seed_slot = pair_idx % half_pairs;
      let seed = opp_seed_mix ^ (seed_slot * 2654435761u);

      let res = sim_game(seed, first);
      loc_tot = loc_tot + 1u;
      loc_t = loc_t + res.y;
      if (res.x == 1u) { loc_w = loc_w + 1u; }
      else if (res.x == 2u) { loc_d = loc_d + 1u; }
      else { loc_l = loc_l + 1u; }
    }
  }

  if (loc_tot > 0u) {
    atomicAdd(&wg_tot, loc_tot);
    atomicAdd(&wg_w, loc_w);
    atomicAdd(&wg_d, loc_d);
    atomicAdd(&wg_l, loc_l);
    atomicAdd(&wg_t, loc_t);
  }
  workgroupBarrier();

  if (lid.x == 0u && opp_idx < n_opps) {
    let t_tot = atomicLoad(&wg_tot);
    if (t_tot > 0u) {
      let t_w = atomicLoad(&wg_w);
      let t_d = atomicLoad(&wg_d);
      let t_l = atomicLoad(&wg_l);
      let t_turns = atomicLoad(&wg_t);

      let opp_stride = 6u + nc * 4u;
      let c_off = 8u + cand_idx * 6u;
      let o_off = 512u + opp_idx * opp_stride;
      let oc_off = o_off + 6u + cand_idx * 4u;

      atomicAdd(&out_u32[0u], t_tot);
      atomicAdd(&out_u32[1u], t_w);
      atomicAdd(&out_u32[2u], t_d);
      atomicAdd(&out_u32[3u], t_l);
      atomicAdd(&out_u32[4u], t_turns);

      atomicAdd(&out_u32[c_off], t_tot);
      atomicAdd(&out_u32[c_off + 1u], t_w);
      atomicAdd(&out_u32[c_off + 2u], t_d);
      atomicAdd(&out_u32[c_off + 3u], t_l);

      atomicAdd(&out_u32[o_off], t_tot);
      atomicAdd(&out_u32[o_off + 1u], t_w);
      atomicAdd(&out_u32[o_off + 2u], t_d);
      atomicAdd(&out_u32[o_off + 3u], t_l);

      atomicAdd(&out_u32[oc_off], t_tot);
      atomicAdd(&out_u32[oc_off + 1u], t_w);
      atomicAdd(&out_u32[oc_off + 2u], t_d);
      atomicAdd(&out_u32[oc_off + 3u], t_l);
    }
  }
}
`;

// Test kernel adds binding 4 (out_sample) for clickable 500-dot capture!
const WGSL_TEST = WGSL_SHARED_HEADER + /* wgsl */ `
@group(0) @binding(4) var<storage, read_write> out_sample: array<u32>;
var<workgroup> wg_acc: array<atomic<u32>, 11>;

@compute @workgroup_size(128)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  if (lid.x < 20u) {
    wg_cards[lid.x] = load_card_vram(0u, lid.x);
  } else if (lid.x < 40u) {
    wg_cards[lid.x] = load_card_vram(1u, lid.x - 20u);
  } else if (lid.x < 62u) {
    let k = lid.x - 40u;
    wg_w0[k] = weights_buf[MAX_ENEMIES * FEATURES + k];
  } else if (lid.x < 84u) {
    let k = lid.x - 62u;
    wg_w1[k] = weights_buf[k];
  }
  if (lid.x < 11u) { atomicStore(&wg_acc[lid.x], 0u); }
  workgroupBarrier();

  let tid = gid.x;
  let gpt = params.games_per_thread;
  let base_k = tid * gpt;
  let end_k = min(params.pair_count, base_k + gpt);

  let half = params.total_per_opp / 2u;
  var loc_n = 0u;
  var loc_w = 0u; var loc_d = 0u; var loc_l = 0u;
  var loc_fw = 0u; var loc_fd = 0u; var loc_fl = 0u;
  var loc_sw = 0u; var loc_sd = 0u; var loc_sl = 0u;
  var loc_t = 0u;

  if (base_k < params.pair_count) {
    let base_mix = params.seed_base ^ 1000003u;
    for (var k = base_k; k < end_k; k = k + 1u) {
      let idx = params.start_pair + k;
      if (idx >= params.total_per_opp) { break; }
      let first = select(1u, 0u, idx < half);
      let seed = base_mix ^ (idx * 2654435761u);
      let res = sim_game(seed, first);
      let code = res.x;
      loc_n = loc_n + 1u;
      loc_t = loc_t + res.y;

      if (idx < 250u) {
        out_sample[idx] = code | (res.y << 8u);
      } else if (idx >= half && idx < half + 250u) {
        out_sample[250u + (idx - half)] = code | (res.y << 8u);
      }

      if (code == 1u) {
        loc_w = loc_w + 1u;
        if (first == 0u) { loc_fw = loc_fw + 1u; } else { loc_sw = loc_sw + 1u; }
      } else if (code == 2u) {
        loc_d = loc_d + 1u;
        if (first == 0u) { loc_fd = loc_fd + 1u; } else { loc_sd = loc_sd + 1u; }
      } else {
        loc_l = loc_l + 1u;
        if (first == 0u) { loc_fl = loc_fl + 1u; } else { loc_sl = loc_sl + 1u; }
      }
    }
  }

  if (loc_n > 0u) {
    atomicAdd(&wg_acc[0], loc_n);
    atomicAdd(&wg_acc[1], loc_w);
    atomicAdd(&wg_acc[2], loc_d);
    atomicAdd(&wg_acc[3], loc_l);
    atomicAdd(&wg_acc[4], loc_fw);
    atomicAdd(&wg_acc[5], loc_fd);
    atomicAdd(&wg_acc[6], loc_fl);
    atomicAdd(&wg_acc[7], loc_sw);
    atomicAdd(&wg_acc[8], loc_sd);
    atomicAdd(&wg_acc[9], loc_sl);
    atomicAdd(&wg_acc[10], loc_t);
  }
  workgroupBarrier();

  if (lid.x < 11u) {
    let v = atomicLoad(&wg_acc[lid.x]);
    if (v > 0u) { atomicAdd(&out_u32[lid.x], v); }
  }
}
`;

let gpuEngineInstance = null;
let gpuProbePromise = null;

function packDeckToI32(target, slot, compactCards) {
  const baseCard = slot * 20;
  for (let i = 0; i < 20; i++) {
    const c = compactCards[i] || compactCards[0];
    const o = (baseCard + i) * CARD_STRIDE;
    target[o] = c.isPokemon | 0;
    target[o + 1] = c.stage | 0;
    target[o + 2] = c.typeCode | 0;
    target[o + 3] = c.weakCode | 0;
    target[o + 4] = c.hp | 0;
    target[o + 5] = c.retreat | 0;
    target[o + 6] = c.prize | 0;
    target[o + 7] = c.atkCost | 0;
    target[o + 8] = c.atkDmg | 0;
    target[o + 9] = c.atkFlags | 0;
    target[o + 10] = c.abFlags | 0;
    target[o + 11] = c.trainerKind | 0;
    target[o + 12] = c.effectVal | 0;
    target[o + 13] = i;
    target[o + 14] = Math.round(Number(c.strategyBonus || 0) * 1024);
    target[o + 15] = 0;
  }
}

async function checkShaderModule(mod, label) {
  if (typeof mod.getCompilationInfo !== 'function') return;
  const info = await mod.getCompilationInfo();
  const errs = (info.messages || []).filter((m) => m.type === 'error');
  if (errs.length) {
    throw Error(`WGSL ${label} compile error: ${errs.map((e) => `L${e.lineNum}: ${e.message}`).join('; ')}`);
  }
}

export async function probeWebGPU() {
  if (gpuEngineInstance) return gpuEngineInstance;
  if (gpuProbePromise) return gpuProbePromise;

  gpuProbePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    // Skip WebGPU compute shaders in Android WebView / Capacitor APK (prevents Mali/Immortalis Vulkan GPU process crashes on Dimensity/Android 15)
    const isAndroidWebView = (typeof window !== 'undefined' && (window.Capacitor?.isNativePlatform?.() || typeof window.PocketLabNative !== 'undefined'))
      || /Android/i.test(navigator.userAgent || '');
    if (isAndroidWebView) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const info = adapter.info || {};
      const rawName = info.description || info.device || info.architecture || info.vendor || 'WebGPU 獨立顯卡';
      const adapterName = String(rawName).trim() || 'WebGPU 獨立顯卡';

      const exploreModule = device.createShaderModule({ code: WGSL_EXPLORE });
      const testModule = device.createShaderModule({ code: WGSL_TEST });
      await checkShaderModule(exploreModule, 'EXPLORE');
      await checkShaderModule(testModule, 'TEST');

      const explorePipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: exploreModule, entryPoint: 'main' }
      });
      const testPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: testModule, entryPoint: 'main' }
      });

      // Persistent VRAM buffers (allocated once in GPU memory)
      const uniformBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      const decksBuf = device.createBuffer({
        size: 12 * 20 * CARD_STRIDE * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      const weightsBuf = device.createBuffer({
        size: (MAX_ENEMIES + MAX_CANDS) * FEATURES * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      const outU32Size = 4096 * 4;
      const outU32Buf = device.createBuffer({
        size: outU32Size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      const outSampleSize = 512 * 4;
      const outSampleBuf = device.createBuffer({
        size: outSampleSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      const readU32Buf = device.createBuffer({
        size: outU32Size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const readSampleBuf = device.createBuffer({
        size: outSampleSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });

      // Explore bind group has EXACTLY bindings 0..3 matching WGSL_EXPLORE!
      const exploreBindGroup = device.createBindGroup({
        layout: explorePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: decksBuf } },
          { binding: 2, resource: { buffer: weightsBuf } },
          { binding: 3, resource: { buffer: outU32Buf } }
        ]
      });
      // Test bind group has bindings 0..4 matching WGSL_TEST!
      const testBindGroup = device.createBindGroup({
        layout: testPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: decksBuf } },
          { binding: 2, resource: { buffer: weightsBuf } },
          { binding: 3, resource: { buffer: outU32Buf } },
          { binding: 4, resource: { buffer: outSampleBuf } }
        ]
      });

      const zeroU32 = new Uint32Array(4096);
      const zeroSample = new Uint32Array(512);
      const decksHost = new Int32Array(12 * 20 * CARD_STRIDE);
      const weightsHost = new Int32Array((MAX_ENEMIES + MAX_CANDS) * FEATURES);
      const uniformHost = new Uint32Array(8);

      // Self-test explore pipeline with a tiny 16-game dispatch to guarantee valid GPU execution!
      const dummyCard = { isPokemon: 1, stage: 0, typeCode: 1, weakCode: 2, hp: 60, retreat: 1, prize: 1, atkCost: 1, atkDmg: 30, atkFlags: 0, abFlags: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0 };
      packDeckToI32(decksHost, 0, Array(20).fill(dummyCard));
      packDeckToI32(decksHost, 1, Array(20).fill(dummyCard));
      device.queue.writeBuffer(decksBuf, 0, decksHost);
      device.queue.writeBuffer(weightsBuf, 0, weightsHost);
      device.queue.writeBuffer(outU32Buf, 0, zeroU32.subarray(0, 64));
      uniformHost.set([1, 1, 16, 0, 16, 12345, 1, 16]);
      device.queue.writeBuffer(uniformBuf, 0, uniformHost);
      const testEnc = device.createCommandEncoder();
      const testPass = testEnc.beginComputePass();
      testPass.setPipeline(explorePipeline);
      testPass.setBindGroup(0, exploreBindGroup);
      testPass.dispatchWorkgroups(1, 1, 1);
      testPass.end();
      testEnc.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, 64);
      device.queue.submit([testEnc.finish()]);
      await readU32Buf.mapAsync(GPUMapMode.READ, 0, 64);
      const smoke = new Uint32Array(readU32Buf.getMappedRange(0, 64).slice(0));
      readU32Buf.unmap();
      if (smoke[0] !== 16) {
        throw Error(`Explore shader smoke check failed (expected 16, got ${smoke[0]})`);
      }

      gpuEngineInstance = {
        ready: true,
        adapterName,
        uploadExploreContext({ deck, enemies, enemyWeightsList, candidates }) {
          packDeckToI32(decksHost, 0, deck);
          for (let o = 0; o < enemies.length; o++) packDeckToI32(decksHost, o + 1, enemies[o].cards);
          device.queue.writeBuffer(decksBuf, 0, decksHost);

          weightsHost.fill(0);
          for (let o = 0; o < enemies.length; o++) {
            const ew = (enemyWeightsList && enemyWeightsList[o]) || enemyWeightsList?.[0] || [];
            for (let k = 0; k < FEATURES; k++) weightsHost[o * FEATURES + k] = Math.round(Number(ew[k] || 0) * 1024);
          }
          for (let c = 0; c < candidates.length; c++) {
            const off = (MAX_ENEMIES + c) * FEATURES;
            for (let k = 0; k < FEATURES; k++) weightsHost[off + k] = Math.round(Number(candidates[c][k] || 0) * 1024);
          }
          device.queue.writeBuffer(weightsBuf, 0, weightsHost);
        },

        async runExplorePairSlice({ nOpps, nCands, gamesPerOpp, startPair, pairCount, seedBase, enemyIds }) {
          const gpt = 32;
          const wgX = Math.ceil(Math.ceil(pairCount / gpt) / 128);
          const wgY = nOpps * nCands;

          uniformHost[0] = nOpps >>> 0;
          uniformHost[1] = nCands >>> 0;
          uniformHost[2] = gamesPerOpp >>> 0;
          uniformHost[3] = startPair >>> 0;
          uniformHost[4] = pairCount >>> 0;
          uniformHost[5] = seedBase >>> 0;
          uniformHost[6] = gpt;
          uniformHost[7] = gamesPerOpp >>> 0;

          device.queue.writeBuffer(uniformBuf, 0, uniformHost);
          device.queue.writeBuffer(outU32Buf, 0, zeroU32);

          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(explorePipeline);
          pass.setBindGroup(0, exploreBindGroup);
          pass.dispatchWorkgroups(wgX, wgY, 1);
          pass.end();
          encoder.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, outU32Size);
          device.queue.submit([encoder.finish()]);

          await readU32Buf.mapAsync(GPUMapMode.READ);
          const u32 = new Uint32Array(readU32Buf.getMappedRange().slice(0));
          readU32Buf.unmap();

          const byCandidate = [];
          for (let c = 0; c < nCands; c++) {
            const co = 8 + c * 6;
            byCandidate.push({
              games: u32[co], wins: u32[co + 1], draws: u32[co + 2], losses: u32[co + 3],
              winFeatCount: 0, lossFeatCount: 0,
              winFeatSum: Array(FEATURES).fill(0), lossFeatSum: Array(FEATURES).fill(0)
            });
          }
          const oppStride = 6 + nCands * 4;
          const byOpponent = [];
          for (let o = 0; o < nOpps; o++) {
            const oo = 512 + o * oppStride;
            const oppCands = [];
            for (let c = 0; c < nCands; c++) {
              const oco = oo + 6 + c * 4;
              oppCands.push({ games: u32[oco], wins: u32[oco + 1], draws: u32[oco + 2], losses: u32[oco + 3] });
            }
            byOpponent.push({
              id: enemyIds[o],
              games: u32[oo], wins: u32[oo + 1], draws: u32[oo + 2], losses: u32[oo + 3],
              winFeatCount: 0, lossFeatCount: 0,
              winFeatSum: Array(FEATURES).fill(0), lossFeatSum: Array(FEATURES).fill(0),
              byCandidate: oppCands
            });
          }

          return {
            completed: u32[0],
            wins: u32[1],
            draws: u32[2],
            losses: u32[3],
            turnsSum: u32[4],
            byCandidate,
            byOpponent
          };
        },

        async runTestOpponent({ deck, enemy, playerWeights, enemyWeights, totalPerOpp, seedBase, onBatch }) {
          packDeckToI32(decksHost, 0, deck);
          packDeckToI32(decksHost, 1, enemy);
          device.queue.writeBuffer(decksBuf, 0, decksHost.subarray(0, 2 * 20 * CARD_STRIDE));

          for (let k = 0; k < FEATURES; k++) {
            weightsHost[k] = Math.round(Number(enemyWeights[k] || 0) * 1024);
            weightsHost[MAX_ENEMIES * FEATURES + k] = Math.round(Number(playerWeights[k] || 0) * 1024);
          }
          device.queue.writeBuffer(weightsBuf, 0, weightsHost);
          device.queue.writeBuffer(outSampleBuf, 0, zeroSample);

          const batchSize = 500000;
          const agg = {
            total: 0, wins: 0, draws: 0, losses: 0,
            firstWins: 0, firstDraws: 0, firstLosses: 0,
            secondWins: 0, secondDraws: 0, secondLosses: 0,
            turnsSum: 0
          };
          for (let start = 0; start < totalPerOpp; start += batchSize) {
            const count = Math.min(batchSize, totalPerOpp - start);
            const gpt = 16;
            const workgroups = Math.ceil(Math.ceil(count / gpt) / 128);
            uniformHost[0] = 1;
            uniformHost[1] = 1;
            uniformHost[2] = totalPerOpp >>> 0;
            uniformHost[3] = start >>> 0;
            uniformHost[4] = count >>> 0;
            uniformHost[5] = seedBase >>> 0;
            uniformHost[6] = gpt;
            uniformHost[7] = totalPerOpp >>> 0;

            device.queue.writeBuffer(uniformBuf, 0, uniformHost);
            device.queue.writeBuffer(outU32Buf, 0, zeroU32.subarray(0, 16));

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(testPipeline);
            pass.setBindGroup(0, testBindGroup);
            pass.dispatchWorkgroups(workgroups);
            pass.end();
            encoder.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, 64);
            device.queue.submit([encoder.finish()]);

            await readU32Buf.mapAsync(GPUMapMode.READ, 0, 64);
            const u32 = new Uint32Array(readU32Buf.getMappedRange(0, 64).slice(0));
            readU32Buf.unmap();

            agg.total += u32[0];
            agg.wins += u32[1];
            agg.draws += u32[2];
            agg.losses += u32[3];
            agg.firstWins += u32[4];
            agg.firstDraws += u32[5];
            agg.firstLosses += u32[6];
            agg.secondWins += u32[7];
            agg.secondDraws += u32[8];
            agg.secondLosses += u32[9];
            agg.turnsSum += u32[10];
            if (typeof onBatch === 'function') {
              const cont = await onBatch(u32[0], agg);
              if (cont === false) return { ...agg, aborted: true, sampleOutcomes: new Uint8Array(500), sampleTurns: new Uint8Array(500) };
            }
          }

          const enc2 = device.createCommandEncoder();
          enc2.copyBufferToBuffer(outSampleBuf, 0, readSampleBuf, 0, outSampleSize);
          device.queue.submit([enc2.finish()]);
          await readSampleBuf.mapAsync(GPUMapMode.READ);
          const sampleRaw = new Uint32Array(readSampleBuf.getMappedRange().slice(0));
          readSampleBuf.unmap();

          const sampleOutcomes = new Uint8Array(500);
          const sampleTurns = new Uint8Array(500);
          for (let i = 0; i < 500; i++) {
            sampleOutcomes[i] = sampleRaw[i] & 0xff;
            sampleTurns[i] = (sampleRaw[i] >> 8) & 0xff;
          }
          return { ...agg, sampleOutcomes, sampleTurns };
        }
      };

      return gpuEngineInstance;
    } catch (err) {
      console.warn('[gpu-sim] WebGPU unavailable, falling back to multi-core WASM:', err?.message || err);
      return null;
    }
  })();

  return gpuProbePromise;
}
