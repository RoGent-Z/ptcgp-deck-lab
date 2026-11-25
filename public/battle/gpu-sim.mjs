// High-Throughput WebGPU Compute Shader Engine for Pocket Lab (Exact-Mechanics v2).
// Key GPU optimizations:
// 1. Persistent VRAM storage buffers (zero per-batch VRAM allocation).
// 2. Workgroup Shared Memory caching of both 20-card decks (wg_cards[40]) and 22-dim weights (wg_w0/wg_w1).
// 3. Index-only per-thread state (u32 card indices -> minimal register pressure).
// 4. 2D (pair_idx, opp*cand) dispatch + workgroup shared-memory reduction.
// 5. Exact fixed-point i32 Q10 (*1024) scoring + exact Rng32 + Exact-Mechanics v2 matching fastsim.wasm bit-for-bit!

const FEATURES = 22;
const CARD_STRIDE = 24;
const MAX_ENEMIES = 10;
const MAX_CANDS = 40;

const WGSL_SHARED_HEADER = /* wgsl */ `
const FEATURES: u32 = 22u;
const CARD_STRIDE: u32 = 24u;
const MAX_ENEMIES: u32 = 10u;

const ST_POISON: i32 = 1;
const ST_TOXIC: i32 = 2;
const ST_BURN: i32 = 4;
const ST_SLEEP: i32 = 8;
const ST_PARALYZE: i32 = 16;
const ST_CONFUSE: i32 = 32;
const ST_SPECIAL_MASK: i32 = 63;
const ST_CANT_RETREAT: i32 = 64;
const ST_CANT_ATK_SELF: i32 = 128;
const ST_CANT_ATK_OPP: i32 = 256;
const ST_OPP_MISS_FLIP: i32 = 512;
const ST_INVULN: i32 = 1024;
const ST_DISGUISE_USED: i32 = 2048;
const ST_HAS_ATTACKED: i32 = 4096;
const ST_SWITCHED_IN: i32 = 8192;
const ST_NEXT_BOOST: i32 = 16384;

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
  evo_group: i32,
  is_supporter: i32,
  is_item: i32,
  is_fossil: i32,
  type_code: i32,
  weak_code: i32,
  hp: i32,
  retreat: i32,
  prize: i32,
  a1_cost: i32,
  a1_dmg: i32,
  a1_op: i32,
  a1_val: i32,
  a2_cost: i32,
  a2_dmg: i32,
  a2_op: i32,
  a2_val: i32,
  ab_op: i32,
  ab_val: i32,
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
  shield: i32,
  weaken: i32,
  turn_placed: i32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> decks_buf: array<i32>;
@group(0) @binding(2) var<storage, read> weights_buf: array<i32>;
@group(0) @binding(3) var<storage, read_write> out_u32: array<atomic<u32>>;

var<workgroup> wg_cards: array<Card, 40>;
var<workgroup> wg_w0: array<i32, 22>;
var<workgroup> wg_w1: array<i32, 22>;

fn est_atk_power(dmg: i32, op: i32, val: i32) -> i32 {
  var d = dmg;
  let hi = (val >> 8u) & 255;
  let lo = val & 255;
  if (op == 8) {
    d = select((d * val) / 2, d, val == 99);
  } else if (op == 9) {
    d = d + select((lo * hi) / 2, lo, hi == 99);
  } else if (op == 10) {
    d = d + lo * select(2, 4, hi == 2);
  } else if (op == 11) {
    d = select(d + val * 3, (val - 1000) * 2, val >= 1000);
  } else if (op == 12) {
    d = d + lo * 2;
  } else if (op == 13) {
    d = d + (lo * 55) / 100;
  } else if (op == 14) {
    if (hi != 2) { d = d + select(lo / 2, 40, hi == 3); }
  } else if (op == 17) {
    if (hi == 2 || hi == 8 || hi == 10) { d = lo; }
    else if (hi >= 3 && hi <= 7) { d = (hi - 2) * lo; }
    else if (hi == 9) { d = lo * 3; }
    else { d = d + lo / 2; }
  } else if (op == 28) {
    d = select(70, 150, val == 1);
  }
  return d;
}

fn load_card_vram(deck_slot: u32, idx: u32) -> Card {
  let o = (deck_slot * 20u + idx) * CARD_STRIDE;
  let raw_meta = decks_buf[o + 1u];
  var c: Card;
  c.is_pokemon = decks_buf[o];
  c.stage = raw_meta & 255;
  c.evo_group = (raw_meta >> 8u) & 65535;
  c.is_supporter = (raw_meta >> 24u) & 1;
  c.is_item = (raw_meta >> 25u) & 1;
  c.is_fossil = (raw_meta >> 26u) & 1;
  c.type_code = decks_buf[o + 2u];
  c.weak_code = decks_buf[o + 3u];
  c.hp = decks_buf[o + 4u];
  c.retreat = decks_buf[o + 5u];
  c.prize = max(1, decks_buf[o + 6u]);
  c.a1_cost = decks_buf[o + 7u] & 255;
  c.a1_dmg = decks_buf[o + 8u];
  c.a1_op = decks_buf[o + 9u] & 255;
  c.a1_val = decks_buf[o + 10u];
  c.a2_cost = decks_buf[o + 11u] & 255;
  c.a2_dmg = decks_buf[o + 12u];
  c.a2_op = decks_buf[o + 13u] & 255;
  c.a2_val = decks_buf[o + 14u];
  c.ab_op = decks_buf[o + 15u] & 255;
  c.ab_val = decks_buf[o + 16u];
  c.trainer_kind = decks_buf[o + 17u];
  c.effect_val = decks_buf[o + 18u];
  let p1 = select(0, est_atk_power(c.a1_dmg, c.a1_op, c.a1_val), c.a1_cost != 255);
  let p2 = select(0, est_atk_power(c.a2_dmg, c.a2_op, c.a2_val), c.a2_cost != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = decks_buf[o + 20u];
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

fn rng_next(st_p: ptr<function, u32>) -> u32 {
  var x = *st_p;
  x = x ^ (x << 13u);
  x = x ^ (x >> 17u);
  x = x ^ (x << 5u);
  *st_p = x;
  return x * 0x27d4eb2du;
}

fn flip_coin_g(rng_p: ptr<function, u32>, gh_p: ptr<function, bool>) -> bool {
  if (*gh_p) {
    *gh_p = false;
    return true;
  }
  return (rng_next(rng_p) & 1u) == 1u;
}

fn get_w(cur: u32, k: u32) -> i32 {
  if (cur == 0u) { return wg_w0[k]; }
  return wg_w1[k];
}

fn tool_hp_bonus(t_val: i32) -> i32 {
  if (t_val == 1) { return 20; }
  if (t_val == 2) { return 30; }
  return 0;
}

fn count_bench_s(side: array<Slot, 4>) -> i32 {
  var n = 0;
  for (var s = 1u; s < 4u; s = s + 1u) { if (side[s].occ == 1) { n = n + 1; } }
  return n;
}

fn eff_energy_s(side: array<Slot, 4>, s: u32) -> i32 {
  let e = side[s].energy;
  if (wg_cards[side[s].ci].type_code == 0) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (side[k].occ == 1 && wg_cards[side[k].ci].ab_op == 27) { return e * 2; }
    }
  }
  return e;
}

fn eff_retreat_s(side: array<Slot, 4>, stad: i32, disc: i32) -> i32 {
  let act_s = side[0];
  let act_c = wg_cards[act_s.ci];
  if (act_c.ab_op == 25 && act_c.ab_val == 3 && act_s.energy > 0) { return 0; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (side[k].occ == 1 && wg_cards[side[k].ci].ab_op == 25 && wg_cards[side[k].ci].ab_val == 2) { return 0; }
  }
  var r = act_c.retreat;
  if (act_c.stage == 0) {
    for (var k = 1u; k < 4u; k = k + 1u) {
      if (side[k].occ == 1 && wg_cards[side[k].ci].ab_op == 25 && wg_cards[side[k].ci].ab_val == 1) { r = r - 1; break; }
    }
    if (act_s.tool == 5) { r = r - 1; }
  }
  if (act_s.tool == 11) { r = r - 1; }
  if (stad == 4) { r = r - 2; }
  r = r - disc;
  return max(0, r);
}

fn best_bench_s(side: array<Slot, 4>) -> u32 {
  var best = 4u;
  var best_sc = -99999;
  for (var s = 1u; s < 4u; s = s + 1u) {
    if (side[s].occ == 1) {
      let sc = side[s].hp + side[s].energy * 35 + (wg_cards[side[s].ci].power_q >> 4u);
      if (sc > best_sc) { best_sc = sc; best = s; }
    }
  }
  return best;
}

fn has_st_immune(sl: Slot) -> bool {
  return wg_cards[sl.ci].ab_op == 18 || sl.tool == 10;
}

fn apply_st_val(sl: Slot, mask: i32) -> i32 {
  if (has_st_immune(sl)) { return sl.status; }
  var st = sl.status;
  if ((mask & (ST_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0) {
    st = st & (~(ST_SLEEP | ST_PARALYZE | ST_CONFUSE));
  }
  if ((mask & ST_TOXIC) != 0) { st = st & (~ST_POISON); }
  if ((mask & ST_POISON) != 0 && (st & ST_TOXIC) != 0) { return st; }
  return st | mask;
}

fn calc_mods_s(
  atk_side: array<Slot, 4>,
  def_side: array<Slot, 4>,
  d_boost: i32,
  d_boost_ex: i32,
  stad: i32,
  tm_shield_def: i32
) -> i32 {
  let act_s = atk_side[0];
  let def_s = def_side[0];
  let act_c = wg_cards[act_s.ci];
  var add = d_boost;
  if (def_s.occ == 1 && wg_cards[def_s.ci].prize >= 2) { add = add + d_boost_ex; }
  if (act_s.tool == 9) { add = add + 20; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (atk_side[k].occ == 1 && wg_cards[atk_side[k].ci].ab_op == 13) { add = add + wg_cards[atk_side[k].ci].ab_val; }
  }
  if (stad == 2 && act_c.stage == 1) { add = add + 10; }
  if (stad == 6 && def_s.occ == 1 && wg_cards[def_s.ci].prize >= 2) { add = add + 20; }
  if ((act_s.status & ST_NEXT_BOOST) != 0) { add = add + 60; }
  if (def_s.occ == 1 && wg_cards[def_s.ci].weak_code == act_c.type_code) { add = add + 20; }

  var red = act_s.weaken + tm_shield_def;
  if (def_s.occ == 1) {
    let def_c = wg_cards[def_s.ci];
    if (def_s.shield > 0) { red = red + def_s.shield; }
    if (def_s.tool == 6 && def_c.stage == 0) { red = red + 20; }
    if (def_s.tool == 10) { red = red + 10; }
    if (def_c.ab_op == 12) {
      let v = def_c.ab_val;
      red = red + select(v, v - 100, v >= 100);
    }
    for (var k = 1u; k < 4u; k = k + 1u) {
      if (def_side[k].occ == 1 && wg_cards[def_side[k].ci].ab_op == 12 && wg_cards[def_side[k].ci].ab_val >= 100) {
        red = red + (wg_cards[def_side[k].ci].ab_val - 100);
      }
    }
  }
  return add - red;
}

fn eval_live_dmg_s(
  atk_side: array<Slot, 4>,
  def_side: array<Slot, 4>,
  cost: i32,
  base_dmg: i32,
  op: i32,
  val: i32,
  sup_used: bool,
  ko_last: bool,
  turn_i: i32
) -> vec2<i32> {
  // returns vec2(raw_d, is_special_0_or_1)
  let act_s = atk_side[0];
  let def_s = def_side[0];
  let hi = (val >> 8u) & 255;
  let lo = val & 255;
  if (op == 8) {
    let n = select(val, 1, val == 99);
    let exp_d = (base_dmg * n) / select(2, 1, val == 99);
    return vec2<i32>(exp_d, 0);
  } else if (op == 9) {
    let exp_d = select((lo * hi) / 2, lo, hi == 99);
    return vec2<i32>(base_dmg + exp_d, 0);
  } else if (op == 10) {
    var cnt = 0;
    if (hi == 0) { cnt = count_bench_s(atk_side); }
    else if (hi == 1) { cnt = count_bench_s(def_side); }
    else if (hi == 2) { cnt = count_bench_s(atk_side) + count_bench_s(def_side); }
    else if (hi == 3) { cnt = (1 + count_bench_s(atk_side)) / 2; }
    return vec2<i32>(base_dmg + cnt * lo, 0);
  } else if (op == 11) {
    let e = eff_energy_s(atk_side, 0u);
    let d = select(base_dmg + e * val, ((val - 1000) * e) / 2, val >= 1000);
    return vec2<i32>(d, 0);
  } else if (op == 12) {
    if (hi == 1) {
      var te = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (def_side[s].occ == 1) { te = te + def_side[s].energy; } }
      return vec2<i32>(base_dmg + te * lo, 0);
    } else if (hi == 2) {
      var me = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (def_side[s].occ == 1 && def_side[s].energy > me) { me = def_side[s].energy; } }
      return vec2<i32>(me * lo, 1);
    } else {
      let fe = select(0, def_s.energy, def_s.occ == 1);
      return vec2<i32>(base_dmg + fe * lo, 0);
    }
  } else if (op == 13) {
    let e = eff_energy_s(atk_side, 0u);
    return vec2<i32>(base_dmg + select(0, lo, e >= cost + hi), 0);
  } else if (op == 14) {
    var d = base_dmg;
    if (hi == 0 && def_s.occ == 1 && def_s.hp < def_s.max_hp) { d = d + lo; }
    else if (hi == 1 && act_s.hp < act_s.max_hp) { d = d + lo; }
    else if (hi == 2 && act_s.hp < act_s.max_hp) { d = max(0, d - lo); }
    else if (hi == 3) { d = d + max(0, act_s.max_hp - act_s.hp); }
    return vec2<i32>(d, 0);
  } else if (op == 17) {
    if (hi == 2 || hi == 8 || hi == 10) { return vec2<i32>(lo, 1); }
    else if (hi >= 3 && hi <= 7) { return vec2<i32>((hi - 2) * lo, 1); }
    else if (hi == 9) { return vec2<i32>(lo, 1); }
    return vec2<i32>(base_dmg, 0);
  } else if (op == 27) {
    var bonus = 0;
    if (hi == 0 && def_s.occ == 1 && (def_s.status & ST_SPECIAL_MASK) != 0) { bonus = lo; }
    else if (hi == 1 && def_s.occ == 1 && wg_cards[def_s.ci].prize >= 2) { bonus = lo; }
    else if (hi == 2 && (act_s.status & ST_HAS_ATTACKED) == 0) { bonus = lo; }
    else if (hi == 3 && def_s.occ == 1 && wg_cards[def_s.ci].stage == 0) { bonus = lo; }
    else if (hi == 4 && act_s.tool != 0) { bonus = lo; }
    else if (hi == 5 && def_s.occ == 1 && def_s.tool != 0) { bonus = lo; }
    else if (hi == 6 && ko_last) { bonus = lo; }
    else if (hi == 7 && sup_used) { bonus = lo; }
    else if (hi == 8 && def_s.occ == 1 && def_s.hp > act_s.hp) { bonus = lo; }
    else if (hi == 9 && def_s.occ == 1 && wg_cards[def_s.ci].ab_op != 0) { bonus = lo; }
    else if (hi == 10 && (act_s.status & ST_SWITCHED_IN) != 0) { bonus = lo; }
    else if (hi == 11 && wg_cards[act_s.ci].stage > 0 && act_s.turn_placed == turn_i) { bonus = lo; }
    return vec2<i32>(base_dmg + bonus, 0);
  } else if (op == 28) {
    if (val == 1) { return vec2<i32>(select(150, def_s.hp, def_s.occ == 1), 1); }
    else if (val == 2) { return vec2<i32>(select(60, def_s.hp / 2, def_s.occ == 1), 1); }
    else if (val == 3) { return vec2<i32>(select(40, def_s.hp / 4, def_s.occ == 1), 1); }
    return vec2<i32>(select(50, def_s.hp / 2, def_s.occ == 1), 1);
  } else if (op == 7) {
    return vec2<i32>(base_dmg / 2, 0);
  }
  return vec2<i32>(base_dmg, select(0, 1, base_dmg == 0 && op != 0));
}

fn sim_game(seed: u32, first_player: u32) -> vec2<u32> {
  var rng = rng_init(seed);
  var libs: array<array<u32, 20>, 2>;
  for (var i = 0u; i < 20u; i = i + 1u) {
    libs[0][i] = i;
    libs[1][i] = 20u + i;
  }
  var lib_len = array<u32, 2>(20u, 20u);
  var hands: array<array<u32, 12>, 2>;
  var hand_len = array<u32, 2>(0u, 0u);
  var board: array<array<Slot, 4>, 2>;
  for (var p = 0u; p < 2u; p = p + 1u) {
    for (var s = 0u; s < 4u; s = s + 1u) {
      board[p][s] = Slot(0, 0u, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  var points = array<i32, 2>(0, 0);
  var item_lock = array<i32, 2>(0, 0);
  var supp_lock = array<i32, 2>(0, 0);
  var ko_last_turn = array<i32, 2>(0, 0);
  var team_shield = array<i32, 2>(0, 0);
  var energy_disc = array<i32, 2>(0, 0);
  var stad: i32 = 0;

  // Opening setup for both players (non-fossil Basic guaranteed in opening 5)
  for (var p = 0u; p < 2u; p = p + 1u) {
    for (var i = 19u; i >= 1u; i = i - 1u) {
      let j = rng_next(&rng) % (i + 1u);
      let tmp = libs[p][i]; libs[p][i] = libs[p][j]; libs[p][j] = tmp;
    }
    var bp = 20u;
    for (var ii = 0u; ii < 20u; ii = ii + 1u) {
      let i = 19u - ii;
      let c = wg_cards[libs[p][i]];
      if (c.is_pokemon == 1 && c.stage == 0 && c.is_fossil == 0) { bp = i; break; }
    }
    if (bp < 15u) { let t = libs[p][19u]; libs[p][19u] = libs[p][bp]; libs[p][bp] = t; }
    for (var i = 0u; i < 5u; i = i + 1u) {
      lib_len[p] = lib_len[p] - 1u;
      hands[p][hand_len[p]] = libs[p][lib_len[p]];
      hand_len[p] = hand_len[p] + 1u;
    }
    var pa = false;
    var idx = 0u;
    loop {
      if (idx >= hand_len[p]) { break; }
      let ci = hands[p][idx];
      let c = wg_cards[ci];
      if (c.is_pokemon == 1 && c.stage == 0 && c.is_fossil == 0) {
        if (!pa) {
          board[p][0] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, 0, 0, 0);
          pa = true;
          hand_len[p] = hand_len[p] - 1u;
          hands[p][idx] = hands[p][hand_len[p]];
          continue;
        } else {
          var pb = false;
          for (var s = 1u; s < 4u; s = s + 1u) {
            if (board[p][s].occ == 0) { board[p][s] = Slot(1, ci, c.hp, c.hp, 0, 0, 0, 0, 0, 0); pb = true; break; }
          }
          if (pb) {
            hand_len[p] = hand_len[p] - 1u;
            hands[p][idx] = hands[p][hand_len[p]];
            continue;
          }
        }
      }
      idx = idx + 1u;
    }
    if (!pa) {
      var fbi = p * 20u;
      for (var k = 0u; k < 20u; k = k + 1u) {
        let kc = wg_cards[p * 20u + k];
        if (kc.is_pokemon == 1 && kc.is_fossil == 0) { fbi = p * 20u + k; break; }
      }
      let fb = wg_cards[fbi];
      board[p][0] = Slot(1, fbi, max(60, fb.hp), max(60, fb.hp), 0, 0, 0, 0, 0, 0);
    }
  }

  var cur = first_player;
  for (var turn = 1u; turn <= 30u; turn = turn + 1u) {
    let foe = 1u - cur;
    let turn_i = i32(turn);

    let had_cant_atk_self = (board[cur][0].occ == 1) && ((board[cur][0].status & ST_CANT_ATK_SELF) != 0);
    let had_next_boost_start = (board[cur][0].occ == 1) && ((board[cur][0].status & ST_NEXT_BOOST) != 0);

    team_shield[cur] = 0;
    for (var s = 0u; s < 4u; s = s + 1u) {
      if (board[cur][s].occ == 1) {
        board[cur][s].shield = 0;
        board[cur][s].status = board[cur][s].status & (~ST_INVULN);
      }
    }

    // Start-of-turn draw
    if (lib_len[cur] > 0u && hand_len[cur] < 12u) {
      lib_len[cur] = lib_len[cur] - 1u;
      hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
      hand_len[cur] = hand_len[cur] + 1u;
    }

    // Start-of-turn Active Ability (Meloetta ab_op == 2: search 1 Pokémon)
    if (board[cur][0].occ == 1 && wg_cards[board[cur][0].ci].ab_op == 2 && hand_len[cur] < 12u && lib_len[cur] > 0u) {
      var m_pos = 20u;
      var m_cnt = 0u;
      for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
        let lc = wg_cards[libs[cur][li]];
        if (lc.is_pokemon == 1 && lc.is_fossil == 0) {
          m_cnt = m_cnt + 1u;
          if ((rng_next(&rng) % m_cnt) == 0u) { m_pos = li; }
        }
      }
      if (m_pos < lib_len[cur]) {
        let found = libs[cur][m_pos];
        lib_len[cur] = lib_len[cur] - 1u;
        libs[cur][m_pos] = libs[cur][lib_len[cur]];
        hands[cur][hand_len[cur]] = found;
        hand_len[cur] = hand_len[cur] + 1u;
      }
    }

    // Search Stadium (stad == 5)
    if (stad == 5 && lib_len[cur] > 0u && hand_len[cur] < 12u) {
      lib_len[cur] = lib_len[cur] - 1u;
      hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
      hand_len[cur] = hand_len[cur] + 1u;
    }

    var energy_attached = (turn == 1u);
    var supporter_used = false;
    var retreated = false;
    var ability_used_mask: u32 = 0u;
    var dmg_boost = 0;
    var dmg_boost_ex = 0;
    var retreat_disc = 0;
    var guar_heads = false;

    let opp_gengar_lock = (board[foe][0].occ == 1) && (wg_cards[board[foe][0].ci].ab_op == 21);
    let opp_cost_tax = select(0, 1, (board[foe][0].occ == 1) && (wg_cards[board[foe][0].ci].ab_op == 28));

    for (var step = 0u; step < 9u; step = step + 1u) {
      var best_kind = 0u;
      var best_a = 0u;
      var best_b = 0u;
      var best_score = get_w(cur, 0u);

      // 1. Place basics (incl. Fossils onto bench)
      for (var hi = 0u; hi < hand_len[cur]; hi = hi + 1u) {
        let c = wg_cards[hands[cur][hi]];
        if (c.is_pokemon == 1 && c.stage == 0) {
          for (var s = 1u; s < 4u; s = s + 1u) {
            if (board[cur][s].occ == 0) {
              var sc = get_w(cur, 2u) + (((c.power_q * get_w(cur, 3u)) >> 10u) * 15 / 100) + ((c.bonus_q * 35) / 100);
              if (c.ab_op == 6) {
                var te = 0;
                for (var k = 0u; k < 4u; k = k + 1u) { if (board[cur][k].occ == 1) { te = te + board[cur][k].energy; } }
                if (te >= 2) { sc = sc + get_w(cur, 13u) + get_w(cur, 14u); }
              }
              if (sc > best_score) { best_score = sc; best_kind = 1u; best_a = hi; best_b = s; }
              break;
            }
          }
        }
      }

      // 2. Evolve (strict evo_group; Turn 1 allowed for active Eevee ab_op == 16)
      for (var hi = 0u; hi < hand_len[cur]; hi = hi + 1u) {
        let c = wg_cards[hands[cur][hi]];
        if (c.is_pokemon == 1 && c.stage > 0 && c.stage < 99) {
          for (var s = 0u; s < 4u; s = s + 1u) {
            if (board[cur][s].occ == 0) { continue; }
            let bc = wg_cards[board[cur][s].ci];
            let can_t1 = (s == 0u) && (bc.ab_op == 16);
            if (!can_t1 && (turn < 2u || board[cur][s].turn_placed >= turn_i)) { continue; }
            if (bc.ab_op == 3 && (ability_used_mask & (1u << s)) == 0u && (bc.ab_val != 3 || board[cur][s].hp > 30)) { continue; }
            let evo_ok = (c.evo_group == 0) || (bc.evo_group == 0) || (bc.evo_group == c.evo_group);
            if (bc.stage + 1 == c.stage && evo_ok) {
              let ps = select(c.power_q >> 1u, c.power_q, s == 0u);
              let sc = get_w(cur, 4u) + ((ps * get_w(cur, 5u)) >> 10u) + ((c.bonus_q * 45) / 100);
              if (sc > best_score) { best_score = sc; best_kind = 2u; best_a = hi; best_b = s; }
            }
          }
        }
      }

      // 3. Active Once-Per-Turn Abilities (ab_op: 3, 4, 8, 15, 17, 20)
      for (var s = 0u; s < 4u; s = s + 1u) {
        if (board[cur][s].occ == 0 || (ability_used_mask & (1u << s)) != 0u) { continue; }
        let scard = wg_cards[board[cur][s].ci];
        let ab_op = scard.ab_op;
        let ab_val = scard.ab_val;
        var valid = false;
        var extra_sc = 0;
        if (ab_op == 3) {
          if (ab_val == 3) { valid = board[cur][s].hp > 30; extra_sc = get_w(cur, 15u); }
          else if (ab_val == 2) { valid = (energy_disc[cur] > 0 || points[foe] > 0 || turn >= 4u); extra_sc = get_w(cur, 15u) >> 1u; }
          else { valid = true; extra_sc = get_w(cur, 15u) >> 1u; }
        } else if (ab_op == 4) {
          if (board[cur][0].occ == 1) {
            if (ab_val == 2) { valid = (s > 0u) && (energy_disc[cur] > 0 || points[foe] > 0 || turn >= 3u); }
            else { valid = true; }
            extra_sc = get_w(cur, 14u) >> 1u;
          }
        } else if (ab_op == 8) {
          if (board[foe][0].occ == 1) { valid = true; extra_sc = (get_w(cur, 21u) * 35) / 100; }
        } else if (ab_op == 15) {
          if (board[cur][0].occ == 1 && board[cur][0].hp < board[cur][0].max_hp) { valid = true; extra_sc = get_w(cur, 20u) >> 1u; }
        } else if (ab_op == 17) {
          if (count_bench_s(board[cur]) > 0) {
            let bbs = best_bench_s(board[cur]);
            if (bbs < 4u && (board[cur][0].hp < board[cur][0].max_hp / 2 || (board[cur][bbs].energy > board[cur][0].energy && wg_cards[board[cur][bbs].ci].power_q > wg_cards[board[cur][0].ci].power_q))) {
              valid = true; extra_sc = get_w(cur, 18u) >> 1u;
            }
          }
        } else if (ab_op == 20) {
          if (ab_val == 1) { valid = (s == 0u) && (count_bench_s(board[foe]) > 0); extra_sc = get_w(cur, 19u) >> 1u; }
          else if (ab_val == 2) {
            var hd = false;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (board[foe][bs].occ == 1 && board[foe][bs].hp < board[foe][bs].max_hp) { hd = true; break; } }
            valid = (s == 0u) && hd; extra_sc = get_w(cur, 19u);
          } else if (ab_val == 3) {
            var hb = false;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (board[foe][bs].occ == 1 && wg_cards[board[foe][bs].ci].stage == 0) { hb = true; break; } }
            valid = hb; extra_sc = get_w(cur, 19u) >> 1u;
          } else if (ab_val == 4) { valid = (hand_len[cur] < 12u) && (lib_len[cur] > 0u); extra_sc = get_w(cur, 8u); }
          else if (ab_val >= 5 && ab_val <= 9) { valid = (board[foe][0].occ == 1) && (!has_st_immune(board[foe][0])); extra_sc = get_w(cur, 12u) >> 1u; }
          else if (ab_val == 10) { valid = lib_len[foe] > 0u; extra_sc = get_w(cur, 19u) >> 2u; }
        }
        if (valid) {
          let sc = get_w(cur, 6u) + extra_sc + ((scard.bonus_q * 35) / 100);
          if (sc > best_score) { best_score = sc; best_kind = 4u; best_a = s; }
        }
      }

      // 4. Trainers
      for (var hi = 0u; hi < hand_len[cur]; hi = hi + 1u) {
        let c = wg_cards[hands[cur][hi]];
        if (c.is_pokemon != 0 || c.trainer_kind == 0) { continue; }
        if (c.is_supporter == 1 && (supporter_used || supp_lock[cur] == 1 || opp_gengar_lock)) { continue; }
        if (c.is_item == 1 && item_lock[cur] == 1) { continue; }

        var sc = get_w(cur, 7u) + ((c.bonus_q * 40) / 100);
        var playable = true;
        let ev = c.effect_val;

        if (c.trainer_kind == 1) {
          if (ev == 10) {
            var hb = false;
            for (var k = 0u; k < lib_len[cur]; k = k + 1u) {
              let lc = wg_cards[libs[cur][k]];
              if (lc.is_pokemon == 1 && lc.stage == 0 && lc.is_fossil == 0) { hb = true; break; }
            }
            if (!hb) { playable = false; }
          } else if (ev == 11) {
            if (hand_len[foe] == 0u || hand_len[foe] + 1u < hand_len[cur]) { playable = false; }
          } else if (ev == 12) {
            var hp_h = false;
            for (var k = 0u; k < hand_len[cur]; k = k + 1u) { if (k != hi && wg_cards[hands[cur][k]].is_pokemon == 1) { hp_h = true; break; } }
            var hp_d = false;
            for (var k = 0u; k < lib_len[cur]; k = k + 1u) { if (wg_cards[libs[cur][k]].is_pokemon == 1) { hp_d = true; break; } }
            if (!hp_h || !hp_d) { playable = false; }
          } else if (ev == 13) {
            var hl = false;
            for (var k = 0u; k < lib_len[cur]; k = k + 1u) {
              let lc = wg_cards[libs[cur][k]];
              if (lc.is_pokemon == 1 && lc.stage == 0 && lc.is_fossil == 0 && lc.hp <= 50) { hl = true; break; }
            }
            if (!hl) { playable = false; }
          } else if (ev == 16) {
            var hs2 = false;
            for (var k = 0u; k < lib_len[cur]; k = k + 1u) {
              let lc = wg_cards[libs[cur][k]];
              if (lc.is_pokemon == 1 && lc.stage == 2) { hs2 = true; break; }
            }
            if (!hs2) { playable = false; }
          } else if (ev == 17) {
            var hs1 = false;
            for (var k = 0u; k < lib_len[cur]; k = k + 1u) {
              let lc = wg_cards[libs[cur][k]];
              if (lc.is_pokemon == 1 && lc.stage == 1) { hs1 = true; break; }
            }
            if (!hs1) { playable = false; }
          } else if (lib_len[cur] == 0u) {
            playable = false;
          }
          let inv = 5120 / (5 + i32(hand_len[cur]));
          sc = sc + ((inv * get_w(cur, 8u)) >> 10u);
        } else if (c.trainer_kind == 2) {
          let h_amt = ev & 255;
          let cures = (ev & 256) != 0;
          let s2_only = (ev & 512) != 0;
          if (board[cur][0].occ == 0) { playable = false; }
          else if (s2_only && wg_cards[board[cur][0].ci].stage != 2) { playable = false; }
          else {
            let missing = board[cur][0].max_hp - board[cur][0].hp;
            let has_st = (board[cur][0].status & ST_SPECIAL_MASK) != 0;
            if (missing <= 0 && !(cures && has_st)) { playable = false; }
            else {
              let eff_h = select(25, min(missing, max(20, h_amt)), missing > 0);
              sc = sc + (get_w(cur, 20u) * eff_h) / 50;
            }
          }
        } else if (c.trainer_kind == 3) {
          if (ev == 1) { playable = count_bench_s(board[foe]) > 0; }
          else if (ev == 3) {
            var hs2_b = false;
            for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (board[cur][ss].occ == 1 && wg_cards[board[cur][ss].ci].stage == 2) { hs2_b = true; break; } }
            playable = hs2_b && (count_bench_s(board[foe]) > 0);
          } else if (ev == 15) {
            var hs1_b = false;
            for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (board[cur][ss].occ == 1 && wg_cards[board[cur][ss].ci].stage >= 1) { hs1_b = true; break; } }
            playable = hs1_b && (count_bench_s(board[foe]) > 0);
          }
          else if (ev == 2) {
            var hd = false;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (board[foe][bs].occ == 1 && board[foe][bs].hp < board[foe][bs].max_hp) { hd = true; break; } }
            playable = hd;
          } else if (ev == 4) { playable = hand_len[foe] > 3u; }
          else if (ev == 5) {
            let want_m = u32(max(1, 3 - points[foe]));
            playable = hand_len[foe] > want_m;
          } else if (ev == 6) {
            var ht = false;
            for (var s = 0u; s < 4u; s = s + 1u) { if (board[foe][s].occ == 1 && board[foe][s].tool != 0) { ht = true; break; } }
            playable = ht;
          } else if (ev == 7) {
            var ht = stad != 0;
            for (var s = 0u; s < 4u; s = s + 1u) { if (board[foe][s].occ == 1 && board[foe][s].tool != 0) { ht = true; break; } }
            playable = ht;
          } else if (ev == 8 || ev == 14) { playable = (board[foe][0].occ == 1) && (board[foe][0].energy > 0); }
          else if (ev == 9) { playable = (count_bench_s(board[cur]) > 0) && (board[cur][0].occ == 1) && (board[cur][0].hp < board[cur][0].max_hp) && (board[cur][0].hp <= 60); }
          else if (ev == 10) { playable = (board[foe][0].occ == 1) && (wg_cards[board[foe][0].ci].stage == 0) && (count_bench_s(board[foe]) > 0); }
          else if (ev == 11) { playable = hand_len[foe] > 4u; }
          else if (ev == 12) { playable = hand_len[foe] > 0u; }
          else { playable = false; }
          sc = sc + ((get_w(cur, 19u) * 45) + (get_w(cur, 21u) * 25)) / 100;
        } else if (c.trainer_kind == 4) {
          if ((ev & 1024) != 0) {
            playable = (!guar_heads) && (turn >= 2u);
            sc = sc + (get_w(cur, 12u) >> 1u);
          } else if ((ev & 512) != 0) {
            playable = turn >= 2u;
            sc = sc + (get_w(cur, 20u) >> 1u);
          } else {
            let vs_ex = (ev & 256) != 0;
            if (turn < 2u || board[foe][0].occ == 0 || (vs_ex && wg_cards[board[foe][0].ci].prize < 2)) { playable = false; }
            sc = sc + ((get_w(cur, 10u) * 35) + (get_w(cur, 11u) * 25)) / 100;
          }
        } else if (c.trainer_kind == 5) {
          var tgt_s = 4u;
          for (var s = 0u; s < 4u; s = s + 1u) {
            if (board[cur][s].occ == 1 && board[cur][s].tool == 0) {
              if ((ev == 5 || ev == 6) && wg_cards[board[cur][s].ci].stage != 0) { continue; }
              tgt_s = s; break;
            }
          }
          if (tgt_s >= 4u) { playable = false; }
          else { sc = sc + select(get_w(cur, 20u) >> 1u, get_w(cur, 20u), tgt_s == 0u); }
        } else if (c.trainer_kind == 6) {
          if (ev == 99) {
            if (turn < 2u) { playable = false; }
            else {
              var cc = false;
              for (var hi2 = 0u; hi2 < hand_len[cur]; hi2 = hi2 + 1u) {
                let evc = wg_cards[hands[cur][hi2]];
                if (evc.is_pokemon == 1 && evc.stage == 2) {
                  for (var s = 0u; s < 4u; s = s + 1u) {
                    if (board[cur][s].occ == 0) { continue; }
                    let bc = wg_cards[board[cur][s].ci];
                    let evo_ok = (evc.evo_group == 0) || (bc.evo_group == 0) || (bc.evo_group == evc.evo_group);
                    if (bc.stage == 0 && evo_ok && board[cur][s].turn_placed < turn_i) { cc = true; break; }
                  }
                  if (cc) { break; }
                }
              }
              playable = cc;
            }
            sc = sc + get_w(cur, 4u) + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
          } else if (ev == 1 || ev == 12) {
            playable = (!retreated) && (count_bench_s(board[cur]) > 0) && (eff_retreat_s(board[cur], stad, retreat_disc) > 0);
            sc = sc + (get_w(cur, 18u) >> 1u);
          } else if (ev == 13) {
            playable = (count_bench_s(board[cur]) > 0) && (board[cur][0].occ == 1) && (board[cur][0].hp < board[cur][0].max_hp);
            sc = sc + (get_w(cur, 18u) >> 1u);
          } else if (ev == 3) {
            var hs2 = false;
            for (var s = 0u; s < 4u; s = s + 1u) { if (board[cur][s].occ == 1 && wg_cards[board[cur][s].ci].stage == 2) { hs2 = true; break; } }
            playable = hs2;
            sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
          } else if (ev == 4) {
            playable = (energy_disc[cur] > 0 || points[foe] > 0 || turn >= 5u);
            sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
          } else if (ev == 6) {
            var be = 0;
            for (var s = 1u; s < 4u; s = s + 1u) { if (board[cur][s].occ == 1) { be = be + board[cur][s].energy; } }
            playable = be > 0;
            sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
          } else if (ev == 7) {
            playable = (turn >= 2u) && (lib_len[cur] > 0u);
            sc = sc + get_w(cur, 4u);
          } else {
            sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
          }
        } else if (c.trainer_kind == 7) {
          if (stad == ev) { playable = false; }
          else { sc = sc + (get_w(cur, 6u) >> 1u); }
        } else {
          playable = false;
        }

        if (playable && sc > best_score) { best_score = sc; best_kind = 3u; best_a = hi; }
      }

      // 5. Energy attach
      if (!energy_attached) {
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (board[cur][s].occ == 1) {
            let bc = wg_cards[board[cur][s].ci];
            var max_c = 1;
            if (bc.a2_cost != 255 && bc.a2_cost > bc.a1_cost) { max_c = bc.a2_cost; }
            else if (bc.a1_cost != 255) { max_c = bc.a1_cost; }
            let extra_c = select(0, bc.a1_val >> 8u, bc.a1_op == 13);
            let need_b = board[cur][s].energy < (max_c + extra_c);
            let chip_b = select(0, (get_w(cur, 21u) * 45) / 100, bc.ab_op == 9);
            let sc = get_w(cur, 13u)
              + select(0, get_w(cur, 14u), s == 0u)
              + select(0, get_w(cur, 15u), need_b)
              + chip_b
              + ((bc.power_q * get_w(cur, 16u)) >> 10u)
              + ((bc.bonus_q * 25) / 100);
            if (sc > best_score) { best_score = sc; best_kind = 5u; best_a = s; }
          }
        }
      }

      // 6. Retreat
      let act_ex_blk = (board[cur][0].occ == 1) && (board[foe][0].occ == 1)
        && (wg_cards[board[foe][0].ci].ab_op == 11)
        && (wg_cards[board[cur][0].ci].prize >= 2);
      let r_cost = select(99, eff_retreat_s(board[cur], stad, retreat_disc), board[cur][0].occ == 1);
      let cant_ret = (board[cur][0].occ == 1) && ((board[cur][0].status & (ST_SLEEP | ST_PARALYZE | ST_CANT_RETREAT)) != 0);
      if (!retreated && board[cur][0].occ == 1 && !cant_ret && board[cur][0].energy >= r_cost) {
        let fo_dmg = select(0, (wg_cards[board[foe][0].ci].power_q * 100) >> 10u, board[foe][0].occ == 1);
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (board[cur][s].occ == 1) {
            let endg_b = (board[cur][0].hp <= fo_dmg && board[cur][s].hp > board[cur][0].hp)
              || (act_ex_blk && wg_cards[board[cur][s].ci].prize == 1);
            let sc = get_w(cur, 17u) + select(0, get_w(cur, 18u), endg_b);
            if (sc > best_score) { best_score = sc; best_kind = 6u; best_a = s; }
          }
        }
      }

      // 7. Dual-Attack Selection
      let cant_atk = (board[cur][0].occ == 1) && ((board[cur][0].status & (ST_SLEEP | ST_PARALYZE | ST_CANT_ATK_SELF | ST_CANT_ATK_OPP)) != 0);
      if (turn >= 2u && board[cur][0].occ == 1 && !cant_atk) {
        let atk_c = wg_cards[board[cur][0].ci];
        let my_e = eff_energy_s(board[cur], 0u);
        let mod_net = calc_mods_s(board[cur], board[foe], dmg_boost, dmg_boost_ex, stad, team_shield[foe]);
        for (var ai = 0u; ai < 2u; ai = ai + 1u) {
          let ac = select(atk_c.a2_cost, atk_c.a1_cost, ai == 0u);
          let ad = select(atk_c.a2_dmg, atk_c.a1_dmg, ai == 0u);
          let ao = select(atk_c.a2_op, atk_c.a1_op, ai == 0u);
          let av = select(atk_c.a2_val, atk_c.a1_val, ai == 0u);
          if (ac == 255 || my_e < ac + opp_cost_tax) { continue; }
          let lv = eval_live_dmg_s(board[cur], board[foe], ac, ad, ao, av, supporter_used, ko_last_turn[cur] != 0, turn_i);
          let raw_d = lv.x;
          let is_sp = lv.y == 1;
          if (raw_d <= 0 && !is_sp) { continue; }
          if (act_ex_blk && !is_sp && ao != 17 && ao != 19 && ao != 25 && !(ao >= 1 && ao <= 6)) { continue; }

          let total_dmg = select(select(0, max(0, raw_d + mod_net), raw_d > 0), raw_d, is_sp);
          let ko_b = (board[foe][0].occ == 1) && (total_dmg >= board[foe][0].hp);
          let eff_b = select(0, get_w(cur, 12u), ao != 0);
          let snipe_b = select(0, get_w(cur, 21u) >> 1u, ao == 17);
          var pen = 0;
          if (ao == 16 && !ko_b) { pen = max(0, get_w(cur, 15u) >> 2u); }
          else if (ao == 15 && av >= 40 && board[cur][0].hp <= av) { pen = get_w(cur, 11u) >> 1u; }
          let sc = get_w(cur, 9u) + ((total_dmg * get_w(cur, 10u)) / 100) + select(0, get_w(cur, 11u), ko_b) + eff_b + snipe_b + ((atk_c.bonus_q * 40) / 100) - pen;
          if (sc > best_score) { best_score = sc; best_kind = 7u; best_a = ai; }
        }
      }

      if (best_kind == 0u) {
        break;
      } else if (best_kind == 1u) {
        let ci = hands[cur][best_a];
        let c = wg_cards[ci];
        let bhp_s = select(0, 20, stad == 3 && c.stage == 0);
        board[cur][best_b] = Slot(1, ci, c.hp + bhp_s, c.hp + bhp_s, 0, 0, 0, 0, 0, turn_i);
        hand_len[cur] = hand_len[cur] - 1u;
        hands[cur][best_a] = hands[cur][hand_len[cur]];
        if (c.ab_op == 6) {
          let wall_ex = (board[cur][0].occ == 1) && (wg_cards[board[cur][0].ci].ab_op == 11) && (board[foe][0].occ == 1) && (wg_cards[board[foe][0].ci].prize >= 2);
          var te = 0;
          for (var k = 0u; k < 4u; k = k + 1u) {
            if (board[cur][k].occ == 1 && k != best_b) { te = te + board[cur][k].energy; }
          }
          let need_e = select(3, max(2, c.a1_cost), c.a1_cost != 255);
          if (!wall_ex && te >= need_e) {
            for (var k = 0u; k < 4u; k = k + 1u) {
              if (board[cur][k].occ == 1 && k != best_b) { board[cur][k].energy = 0; }
            }
            board[cur][best_b].energy = board[cur][best_b].energy + te;
            let tmp = board[cur][0]; board[cur][0] = board[cur][best_b]; board[cur][best_b] = tmp;
            board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
          }
        } else if (c.ab_op == 7 && count_bench_s(board[foe]) > 0) {
          let pk = best_bench_s(board[foe]);
          if (pk < 4u) {
            let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp;
            board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED);
          }
        }
      } else if (best_kind == 2u) {
        let ci = hands[cur][best_a];
        let c = wg_cards[ci];
        let taken = max(0, board[cur][best_b].max_hp - board[cur][best_b].hp);
        let bhp = tool_hp_bonus(board[cur][best_b].tool);
        board[cur][best_b].ci = ci;
        board[cur][best_b].max_hp = c.hp + bhp;
        board[cur][best_b].hp = max(10, board[cur][best_b].max_hp - taken);
        board[cur][best_b].status = board[cur][best_b].status & (~ST_SPECIAL_MASK);
        board[cur][best_b].turn_placed = turn_i;
        hand_len[cur] = hand_len[cur] - 1u;
        hands[cur][best_a] = hands[cur][hand_len[cur]];

        if (c.ab_op == 5) {
          if (c.ab_val == 1) {
            if (board[cur][0].occ == 1) { board[cur][0].energy = board[cur][0].energy + 1; }
          } else if (c.ab_val == 2) {
            for (var dd = 0u; dd < 2u; dd = dd + 1u) {
              if (lib_len[cur] > 0u && hand_len[cur] < 12u) {
                lib_len[cur] = lib_len[cur] - 1u;
                hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
                hand_len[cur] = hand_len[cur] + 1u;
              }
            }
          } else if (c.ab_val == 3) {
            for (var bs = 1u; bs < 4u; bs = bs + 1u) {
              if (board[cur][bs].occ == 0) {
                for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                  let lc = wg_cards[libs[cur][li]];
                  if (lc.is_pokemon == 1 && lc.stage == 1 && lc.evo_group == c.evo_group) {
                    let cci = libs[cur][li];
                    lib_len[cur] = lib_len[cur] - 1u;
                    libs[cur][li] = libs[cur][lib_len[cur]];
                    board[cur][bs] = Slot(1, cci, lc.hp, lc.hp, 0, 0, 0, 0, 0, turn_i);
                    break;
                  }
                }
                break;
              }
            }
          } else if (c.ab_val == 4) {
            if (board[foe][0].occ == 1) {
              board[foe][0].hp = board[foe][0].hp - 20;
              if (board[foe][0].hp <= 0) {
                points[cur] = points[cur] + wg_cards[board[foe][0].ci].prize;
                board[foe][0].occ = 0;
                let pr = best_bench_s(board[foe]);
                if (pr < 4u) {
                  let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp;
                  board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED);
                }
              }
            }
          } else if (c.ab_val == 5) {
            for (var k = 0u; k < hand_len[foe]; k = k + 1u) {
              if (lib_len[foe] < 20u) { libs[foe][lib_len[foe]] = hands[foe][k]; lib_len[foe] = lib_len[foe] + 1u; }
            }
            hand_len[foe] = 0u;
            let nl = lib_len[foe];
            if (nl > 1u) {
              for (var ii = 0u; ii < nl - 1u; ii = ii + 1u) {
                let i = (nl - 1u) - ii;
                let j = rng_next(&rng) % (i + 1u);
                let tmp = libs[foe][i]; libs[foe][i] = libs[foe][j]; libs[foe][j] = tmp;
              }
            }
            let want_m = u32(max(1, 3 - points[foe]));
            for (var dd = 0u; dd < want_m; dd = dd + 1u) {
              if (lib_len[foe] > 0u && hand_len[foe] < 12u) {
                lib_len[foe] = lib_len[foe] - 1u;
                hands[foe][hand_len[foe]] = libs[foe][lib_len[foe]];
                hand_len[foe] = hand_len[foe] + 1u;
              }
            }
          }
        }
        if (points[cur] >= 3 || board[foe][0].occ == 0) {
          return vec2<u32>(select(0u, 1u, cur == 0u), turn);
        }
      } else if (best_kind == 3u) {
        let ci = hands[cur][best_a];
        let c = wg_cards[ci];
        hand_len[cur] = hand_len[cur] - 1u;
        hands[cur][best_a] = hands[cur][hand_len[cur]];
        if (c.is_supporter == 1) { supporter_used = true; }
        let ev = c.effect_val;

        if (c.trainer_kind == 1) {
          if (ev == 10 || ev == 13 || ev == 16 || ev == 17) {
            let s_times = select(1u, 2u, ev == 13 || ev == 17);
            for (var st_i = 0u; st_i < s_times; st_i = st_i + 1u) {
              if (hand_len[cur] < 12u && lib_len[cur] > 0u) {
                var m_pos = 20u; var m_cnt = 0u;
                for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                  let lc = wg_cards[libs[cur][li]];
                  var ok = false;
                  if (ev == 10) { ok = lc.is_pokemon == 1 && lc.stage == 0 && lc.is_fossil == 0; }
                  else if (ev == 13) { ok = lc.is_pokemon == 1 && lc.stage == 0 && lc.is_fossil == 0 && lc.hp <= 50; }
                  else if (ev == 17) { ok = lc.is_pokemon == 1 && lc.stage == 1; }
                  else { ok = lc.is_pokemon == 1 && lc.stage == 2; }
                  if (ok) { m_cnt = m_cnt + 1u; if ((rng_next(&rng) % m_cnt) == 0u) { m_pos = li; } }
                }
                if (m_pos < lib_len[cur]) {
                  let found = libs[cur][m_pos];
                  lib_len[cur] = lib_len[cur] - 1u;
                  libs[cur][m_pos] = libs[cur][lib_len[cur]];
                  hands[cur][hand_len[cur]] = found;
                  hand_len[cur] = hand_len[cur] + 1u;
                }
              }
            }
          } else if (ev == 11) {
            let want = hand_len[foe];
            for (var k = 0u; k < hand_len[cur]; k = k + 1u) {
              if (lib_len[cur] < 20u) { libs[cur][lib_len[cur]] = hands[cur][k]; lib_len[cur] = lib_len[cur] + 1u; }
            }
            hand_len[cur] = 0u;
            let nl = lib_len[cur];
            if (nl > 1u) {
              for (var ii = 0u; ii < nl - 1u; ii = ii + 1u) {
                let i = (nl - 1u) - ii;
                let j = rng_next(&rng) % (i + 1u);
                let tmp = libs[cur][i]; libs[cur][i] = libs[cur][j]; libs[cur][j] = tmp;
              }
            }
            for (var dd = 0u; dd < want; dd = dd + 1u) {
              if (lib_len[cur] > 0u && hand_len[cur] < 12u) {
                lib_len[cur] = lib_len[cur] - 1u;
                hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
                hand_len[cur] = hand_len[cur] + 1u;
              }
            }
          } else if (ev == 12) {
            for (var k = 0u; k < hand_len[cur]; k = k + 1u) {
              if (wg_cards[hands[cur][k]].is_pokemon == 1) {
                let pb_ci = hands[cur][k];
                hand_len[cur] = hand_len[cur] - 1u;
                hands[cur][k] = hands[cur][hand_len[cur]];
                if (lib_len[cur] < 20u) { libs[cur][lib_len[cur]] = pb_ci; lib_len[cur] = lib_len[cur] + 1u; }
                if (hand_len[cur] < 12u && lib_len[cur] > 0u) {
                  var m_pos = 20u; var m_cnt = 0u;
                  for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                    let lc = wg_cards[libs[cur][li]];
                    if (lc.is_pokemon == 1 && lc.is_fossil == 0) {
                      m_cnt = m_cnt + 1u; if ((rng_next(&rng) % m_cnt) == 0u) { m_pos = li; }
                    }
                  }
                  if (m_pos < lib_len[cur]) {
                    let found = libs[cur][m_pos];
                    lib_len[cur] = lib_len[cur] - 1u;
                    libs[cur][m_pos] = libs[cur][lib_len[cur]];
                    hands[cur][hand_len[cur]] = found;
                    hand_len[cur] = hand_len[cur] + 1u;
                  }
                }
                break;
              }
            }
          } else if (ev == 14) {
            let my_n = hand_len[cur]; let fo_n = hand_len[foe];
            for (var k = 0u; k < hand_len[cur]; k = k + 1u) { if (lib_len[cur] < 20u) { libs[cur][lib_len[cur]] = hands[cur][k]; lib_len[cur] = lib_len[cur] + 1u; } }
            hand_len[cur] = 0u;
            let nl0 = lib_len[cur];
            if (nl0 > 1u) {
              for (var ii = 0u; ii < nl0 - 1u; ii = ii + 1u) {
                let i = (nl0 - 1u) - ii; let j = rng_next(&rng) % (i + 1u);
                let tmp = libs[cur][i]; libs[cur][i] = libs[cur][j]; libs[cur][j] = tmp;
              }
            }
            for (var k = 0u; k < hand_len[foe]; k = k + 1u) { if (lib_len[foe] < 20u) { libs[foe][lib_len[foe]] = hands[foe][k]; lib_len[foe] = lib_len[foe] + 1u; } }
            hand_len[foe] = 0u;
            let nl1 = lib_len[foe];
            if (nl1 > 1u) {
              for (var ii = 0u; ii < nl1 - 1u; ii = ii + 1u) {
                let i = (nl1 - 1u) - ii; let j = rng_next(&rng) % (i + 1u);
                let tmp = libs[foe][i]; libs[foe][i] = libs[foe][j]; libs[foe][j] = tmp;
              }
            }
            for (var dd = 0u; dd < my_n; dd = dd + 1u) { if (lib_len[cur] > 0u && hand_len[cur] < 12u) { lib_len[cur] = lib_len[cur] - 1u; hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]]; hand_len[cur] = hand_len[cur] + 1u; } }
            for (var dd = 0u; dd < fo_n; dd = dd + 1u) { if (lib_len[foe] > 0u && hand_len[foe] < 12u) { lib_len[foe] = lib_len[foe] - 1u; hands[foe][hand_len[foe]] = libs[foe][lib_len[foe]]; hand_len[foe] = hand_len[foe] + 1u; } }
          } else if (ev == 15) {
            if (lib_len[cur] > 0u && hand_len[cur] < 12u) { lib_len[cur] = lib_len[cur] - 1u; hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]]; hand_len[cur] = hand_len[cur] + 1u; }
          } else {
            let dr = u32(clamp(ev, 1, 2));
            for (var dd = 0u; dd < dr; dd = dd + 1u) {
              if (lib_len[cur] > 0u && hand_len[cur] < 12u) {
                lib_len[cur] = lib_len[cur] - 1u;
                hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
                hand_len[cur] = hand_len[cur] + 1u;
              }
            }
          }
        } else if (c.trainer_kind == 2) {
          var h = ev & 255;
          if ((ev & 2048) != 0) {
            h = 0;
            for (var cf = 0u; cf < 6u; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { h = h + 20; } else { break; } }
          }
          if ((ev & 4096) != 0) {
            board[cur][0].hp = board[cur][0].max_hp;
            if (board[cur][0].energy > 0) { energy_disc[cur] = 1; }
            board[cur][0].energy = 0;
          } else if (h > 0) {
            board[cur][0].hp = min(board[cur][0].max_hp, board[cur][0].hp + h);
          }
          if ((ev & 256) != 0) { board[cur][0].status = board[cur][0].status & (~ST_SPECIAL_MASK); }
          if ((ev & 1024) != 0 && hand_len[cur] < 12u && flip_coin_g(&rng, &guar_heads)) {
            hands[cur][hand_len[cur]] = ci;
            hand_len[cur] = hand_len[cur] + 1u;
          }
        } else if (c.trainer_kind == 3) {
          if (ev == 1 || ev == 10) {
            let pk = best_bench_s(board[foe]);
            if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          } else if (ev == 2) {
            var pk = 4u;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) {
              if (board[foe][bs].occ == 1 && board[foe][bs].hp < board[foe][bs].max_hp) {
                if (pk == 4u || board[foe][bs].hp < board[foe][pk].hp) { pk = bs; }
              }
            }
            if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          } else if (ev == 3 || ev == 15) {
            var pk = 4u;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) {
              if (board[foe][bs].occ == 1) { if (pk == 4u || board[foe][bs].hp < board[foe][pk].hp) { pk = bs; } }
            }
            if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          } else if (ev == 4 || ev == 5) {
            for (var k = 0u; k < hand_len[foe]; k = k + 1u) { if (lib_len[foe] < 20u) { libs[foe][lib_len[foe]] = hands[foe][k]; lib_len[foe] = lib_len[foe] + 1u; } }
            hand_len[foe] = 0u;
            let nl = lib_len[foe];
            if (nl > 1u) {
              for (var ii = 0u; ii < nl - 1u; ii = ii + 1u) {
                let i = (nl - 1u) - ii; let j = rng_next(&rng) % (i + 1u);
                let tmp = libs[foe][i]; libs[foe][i] = libs[foe][j]; libs[foe][j] = tmp;
              }
            }
            let want_d = select(u32(max(1, 3 - points[foe])), 3u, ev == 4);
            for (var dd = 0u; dd < want_d; dd = dd + 1u) { if (lib_len[foe] > 0u && hand_len[foe] < 12u) { lib_len[foe] = lib_len[foe] - 1u; hands[foe][hand_len[foe]] = libs[foe][lib_len[foe]]; hand_len[foe] = hand_len[foe] + 1u; } }
          } else if (ev == 6) {
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (board[foe][s].occ == 1 && board[foe][s].tool != 0) {
                let hp_b = tool_hp_bonus(board[foe][s].tool);
                board[foe][s].tool = 0;
                if (hp_b > 0) { board[foe][s].max_hp = max(10, board[foe][s].max_hp - hp_b); board[foe][s].hp = min(board[foe][s].hp, board[foe][s].max_hp); }
              }
            }
          } else if (ev == 7) {
            var did = false;
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (board[foe][s].occ == 1 && board[foe][s].tool != 0) {
                let hp_b = tool_hp_bonus(board[foe][s].tool);
                board[foe][s].tool = 0;
                if (hp_b > 0) { board[foe][s].max_hp = max(10, board[foe][s].max_hp - hp_b); board[foe][s].hp = min(board[foe][s].hp, board[foe][s].max_hp); }
                did = true; break;
              }
            }
            if (!did) {
              if (stad == 3) {
                for (var pp = 0u; pp < 2u; pp = pp + 1u) {
                  for (var ss = 0u; ss < 4u; ss = ss + 1u) {
                    if (board[pp][ss].occ == 1 && wg_cards[board[pp][ss].ci].stage == 0) {
                      board[pp][ss].max_hp = max(10, board[pp][ss].max_hp - 20);
                      board[pp][ss].hp = min(board[pp][ss].hp, board[pp][ss].max_hp);
                    }
                  }
                }
              }
              stad = 0;
            }
          } else if (ev == 8) {
            var disc_c = 0;
            for (var cf = 0u; cf < 5u; cf = cf + 1u) {
              if (board[foe][0].energy > 0 && flip_coin_g(&rng, &guar_heads)) { board[foe][0].energy = board[foe][0].energy - 1; disc_c = disc_c + 1; } else { break; }
            }
            if (disc_c > 0) { energy_disc[foe] = 1; }
          } else if (ev == 9) {
            let pr = best_bench_s(board[cur]);
            if (pr < 4u) {
              let b_ci = board[cur][0].ci;
              board[cur][0].occ = 0;
              let tmp = board[cur][0]; board[cur][0] = board[cur][pr]; board[cur][pr] = tmp;
              board[cur][0].status = board[cur][0].status & (~ST_HAS_ATTACKED);
              if (hand_len[cur] < 12u) { hands[cur][hand_len[cur]] = b_ci; hand_len[cur] = hand_len[cur] + 1u; }
            }
          } else if (ev == 11) {
            if (hand_len[foe] > 4u) { hand_len[foe] = 4u; }
          } else if (ev == 12) {
            for (var k = 0u; k < hand_len[foe]; k = k + 1u) {
              if (wg_cards[hands[foe][k]].is_supporter == 1) {
                let s_ci = hands[foe][k];
                hand_len[foe] = hand_len[foe] - 1u;
                hands[foe][k] = hands[foe][hand_len[foe]];
                if (lib_len[foe] < 20u) { libs[foe][lib_len[foe]] = s_ci; lib_len[foe] = lib_len[foe] + 1u; }
                break;
              }
            }
          } else if (ev == 14) {
            if (board[foe][0].occ == 1 && board[foe][0].energy > 0) { board[foe][0].energy = board[foe][0].energy - 1; energy_disc[foe] = 1; }
          }
        } else if (c.trainer_kind == 4) {
          if ((ev & 1024) != 0) { guar_heads = true; }
          else if ((ev & 512) != 0) { team_shield[cur] = team_shield[cur] + (ev & 255); }
          else if ((ev & 256) != 0) { dmg_boost_ex = dmg_boost_ex + (ev & 255); }
          else { dmg_boost = dmg_boost + (ev & 255); }
        } else if (c.trainer_kind == 5) {
          for (var s = 0u; s < 4u; s = s + 1u) {
            if (board[cur][s].occ == 1 && board[cur][s].tool == 0) {
              if ((ev == 5 || ev == 6) && wg_cards[board[cur][s].ci].stage != 0) { continue; }
              board[cur][s].tool = ev;
              let hp_b = tool_hp_bonus(ev);
              if (hp_b > 0) { board[cur][s].max_hp = board[cur][s].max_hp + hp_b; board[cur][s].hp = board[cur][s].hp + hp_b; }
              if (ev == 10) { board[cur][s].status = board[cur][s].status & (~ST_SPECIAL_MASK); }
              break;
            }
          }
        } else if (c.trainer_kind == 6) {
          if (ev == 99) {
            var done_candy = false;
            for (var hi2 = 0u; hi2 < hand_len[cur]; hi2 = hi2 + 1u) {
              let ev_ci = hands[cur][hi2];
              let evc = wg_cards[ev_ci];
              if (evc.is_pokemon == 1 && evc.stage == 2) {
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (board[cur][s].occ == 0) { continue; }
                  let bc = wg_cards[board[cur][s].ci];
                  let evo_ok = (evc.evo_group == 0) || (bc.evo_group == 0) || (bc.evo_group == evc.evo_group);
                  if (bc.stage == 0 && evo_ok && board[cur][s].turn_placed < turn_i) {
                    let tk = max(0, board[cur][s].max_hp - board[cur][s].hp);
                    let bhp = tool_hp_bonus(board[cur][s].tool);
                    board[cur][s].ci = ev_ci;
                    board[cur][s].max_hp = evc.hp + bhp;
                    board[cur][s].hp = max(10, board[cur][s].max_hp - tk);
                    board[cur][s].status = board[cur][s].status & (~ST_SPECIAL_MASK);
                    board[cur][s].turn_placed = turn_i;
                    hand_len[cur] = hand_len[cur] - 1u;
                    hands[cur][hi2] = hands[cur][hand_len[cur]];
                    done_candy = true; break;
                  }
                }
                if (done_candy) { break; }
              }
            }
          } else if (ev == 1) { retreat_disc = retreat_disc + 1; }
          else if (ev == 12) { retreat_disc = retreat_disc + 2; }
          else if (ev == 13) {
            let pr = best_bench_s(board[cur]);
            if (pr < 4u) {
              board[cur][0].status = board[cur][0].status & (~ST_SPECIAL_MASK);
              let tmp = board[cur][0]; board[cur][0] = board[cur][pr]; board[cur][pr] = tmp;
              board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
            }
          } else if (ev == 2 || ev == 4) {
            board[cur][0].energy = board[cur][0].energy + 1;
          } else if (ev == 3) {
            for (var s = 0u; s < 4u; s = s + 1u) { if (board[cur][s].occ == 1 && wg_cards[board[cur][s].ci].stage == 2) { board[cur][s].energy = board[cur][s].energy + 1; break; } }
          } else if (ev == 5) {
            for (var cf = 0u; cf < 6u; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { board[cur][0].energy = board[cur][0].energy + 1; } else { break; } }
          } else if (ev == 6) {
            for (var s = 1u; s < 4u; s = s + 1u) {
              if (board[cur][s].occ == 1 && board[cur][s].energy > 0) { board[cur][0].energy = board[cur][0].energy + board[cur][s].energy; board[cur][s].energy = 0; }
            }
          } else if (ev == 7) {
            var ev_done = false;
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (board[cur][s].occ == 0 || board[cur][s].turn_placed >= turn_i) { continue; }
              let bc = wg_cards[board[cur][s].ci];
              for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                let ev_ci = libs[cur][li];
                let evc = wg_cards[ev_ci];
                let evo_ok = (evc.evo_group == 0) || (bc.evo_group == 0) || (bc.evo_group == evc.evo_group);
                if (evc.is_pokemon == 1 && evc.stage == bc.stage + 1 && evo_ok) {
                  let tk = max(0, board[cur][s].max_hp - board[cur][s].hp);
                  let bhp = tool_hp_bonus(board[cur][s].tool);
                  board[cur][s].ci = ev_ci;
                  board[cur][s].max_hp = evc.hp + bhp;
                  board[cur][s].hp = max(10, board[cur][s].max_hp - tk);
                  board[cur][s].status = board[cur][s].status & (~ST_SPECIAL_MASK);
                  board[cur][s].turn_placed = turn_i;
                  lib_len[cur] = lib_len[cur] - 1u;
                  libs[cur][li] = libs[cur][lib_len[cur]];
                  ev_done = true; break;
                }
              }
              if (ev_done) { break; }
            }
          }
        } else if (c.trainer_kind == 7) {
          if (stad == 3 && ev != 3) {
            for (var pp = 0u; pp < 2u; pp = pp + 1u) {
              for (var ss = 0u; ss < 4u; ss = ss + 1u) {
                if (board[pp][ss].occ == 1 && wg_cards[board[pp][ss].ci].stage == 0) {
                  board[pp][ss].max_hp = max(10, board[pp][ss].max_hp - 20);
                  board[pp][ss].hp = min(board[pp][ss].hp, board[pp][ss].max_hp);
                }
              }
            }
          } else if (stad != 3 && ev == 3) {
            for (var pp = 0u; pp < 2u; pp = pp + 1u) {
              for (var ss = 0u; ss < 4u; ss = ss + 1u) {
                if (board[pp][ss].occ == 1 && wg_cards[board[pp][ss].ci].stage == 0) {
                  board[pp][ss].max_hp = board[pp][ss].max_hp + 20;
                  board[pp][ss].hp = board[pp][ss].hp + 20;
                }
              }
            }
          }
          stad = ev;
        }
      } else if (best_kind == 4u) {
        ability_used_mask = ability_used_mask | (1u << best_a);
        let scard = wg_cards[board[cur][best_a].ci];
        let ab_op = scard.ab_op;
        let ab_val = scard.ab_val;
        if (ab_op == 3) {
          if (ab_val == 3) {
            board[cur][best_a].energy = board[cur][best_a].energy + 2;
            board[cur][best_a].hp = max(10, board[cur][best_a].hp - 30);
          } else {
            board[cur][best_a].energy = board[cur][best_a].energy + 1;
          }
        } else if (ab_op == 4) {
          if (board[cur][0].occ == 1) { board[cur][0].energy = board[cur][0].energy + 1; }
        } else if (ab_op == 8) {
          var ts = 0u;
          for (var s = 1u; s < 4u; s = s + 1u) {
            if (board[foe][s].occ == 1 && (board[foe][ts].occ == 0 || board[foe][s].hp < board[foe][ts].hp)) { ts = s; }
          }
          if (board[foe][ts].occ == 1) {
            board[foe][ts].hp = board[foe][ts].hp - ab_val;
            if (board[foe][ts].hp <= 0) {
              points[cur] = points[cur] + wg_cards[board[foe][ts].ci].prize;
              board[foe][ts].occ = 0;
              if (ts == 0u) {
                let pr = best_bench_s(board[foe]);
                if (pr < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
              }
              if (points[cur] >= 3 || board[foe][0].occ == 0) {
                return vec2<u32>(select(0u, 1u, cur == 0u), turn);
              }
            }
          }
        } else if (ab_op == 15) {
          if (board[cur][0].occ == 1) { board[cur][0].hp = min(board[cur][0].max_hp, board[cur][0].hp + ab_val); }
        } else if (ab_op == 17) {
          let pr = best_bench_s(board[cur]);
          if (pr < 4u) {
            board[cur][0].status = board[cur][0].status & (~ST_SPECIAL_MASK);
            let tmp = board[cur][0]; board[cur][0] = board[cur][pr]; board[cur][pr] = tmp;
            board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
          }
        } else if (ab_op == 20) {
          if (ab_val == 1) {
            let pk = best_bench_s(board[foe]);
            if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          } else if (ab_val == 2) {
            var pk = 4u;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (board[foe][bs].occ == 1 && board[foe][bs].hp < board[foe][bs].max_hp) { pk = bs; break; } }
            if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          } else if (ab_val == 3) {
            var pk = 4u;
            for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (board[foe][bs].occ == 1 && wg_cards[board[foe][bs].ci].stage == 0) { pk = bs; break; } }
            if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          } else if (ab_val == 4) {
            if (hand_len[cur] < 12u && lib_len[cur] > 0u) {
              var m_pos = 20u; var m_cnt = 0u;
              for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                let lc = wg_cards[libs[cur][li]];
                if (lc.is_pokemon == 1 && lc.is_fossil == 0) { m_cnt = m_cnt + 1u; if ((rng_next(&rng) % m_cnt) == 0u) { m_pos = li; } }
              }
              if (m_pos < lib_len[cur]) {
                let found = libs[cur][m_pos]; lib_len[cur] = lib_len[cur] - 1u; libs[cur][m_pos] = libs[cur][lib_len[cur]];
                hands[cur][hand_len[cur]] = found; hand_len[cur] = hand_len[cur] + 1u;
              }
            }
          } else if (ab_val == 5) { if (board[foe][0].occ == 1) { board[foe][0].status = apply_st_val(board[foe][0], ST_POISON); } }
          else if (ab_val == 6) { if (board[foe][0].occ == 1) { board[foe][0].status = apply_st_val(board[foe][0], ST_BURN); } }
          else if (ab_val == 7) { if (board[foe][0].occ == 1 && flip_coin_g(&rng, &guar_heads)) { board[foe][0].status = apply_st_val(board[foe][0], ST_SLEEP); } }
          else if (ab_val == 8) { if (board[foe][0].occ == 1 && flip_coin_g(&rng, &guar_heads)) { board[foe][0].status = apply_st_val(board[foe][0], ST_POISON); } }
          else if (ab_val == 9) { if (board[foe][0].occ == 1) { board[foe][0].status = apply_st_val(board[foe][0], ST_CONFUSE); } }
          else if (ab_val == 10) { if (lib_len[foe] > 0u) { lib_len[foe] = lib_len[foe] - 1u; } }
        }
      } else if (best_kind == 5u) {
        energy_attached = true;
        board[cur][best_a].energy = board[cur][best_a].energy + 1;
        let tc = wg_cards[board[cur][best_a].ci];
        if (tc.ab_op == 19 && tc.ab_val == 99) {
          board[cur][best_a].max_hp = board[cur][best_a].max_hp + 30;
          board[cur][best_a].hp = board[cur][best_a].hp + 30;
        }
        if (tc.ab_op == 9 && board[foe][0].occ == 1) {
          board[foe][0].hp = board[foe][0].hp - tc.ab_val;
          if (board[foe][0].hp <= 0) {
            points[cur] = points[cur] + wg_cards[board[foe][0].ci].prize;
            board[foe][0].occ = 0;
            let pr = best_bench_s(board[foe]);
            if (pr < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
          }
          if (points[cur] >= 3 || board[foe][0].occ == 0) { return vec2<u32>(select(0u, 1u, cur == 0u), turn); }
        }
        if (board[foe][0].occ == 1 && wg_cards[board[foe][0].ci].ab_op == 22) {
          board[cur][best_a].hp = board[cur][best_a].hp - wg_cards[board[foe][0].ci].ab_val;
          if (board[cur][best_a].hp <= 0) {
            points[foe] = points[foe] + wg_cards[board[cur][best_a].ci].prize;
            board[cur][best_a].occ = 0;
            if (best_a == 0u) {
              let pr = best_bench_s(board[cur]);
              if (pr < 4u) { let tmp = board[cur][0]; board[cur][0] = board[cur][pr]; board[cur][pr] = tmp; board[cur][0].status = board[cur][0].status & (~ST_HAS_ATTACKED); }
            }
          }
          if (points[foe] >= 3 || board[cur][0].occ == 0) { return vec2<u32>(select(0u, 1u, foe == 0u), turn); }
        }
      } else if (best_kind == 6u) {
        retreated = true;
        let pay = eff_retreat_s(board[cur], stad, retreat_disc);
        if (pay > 0) { energy_disc[cur] = 1; }
        board[cur][0].energy = max(0, board[cur][0].energy - pay);
        board[cur][0].status = board[cur][0].status & (~(ST_SPECIAL_MASK | ST_CANT_RETREAT | ST_OPP_MISS_FLIP | ST_CANT_ATK_OPP | ST_CANT_ATK_SELF | ST_NEXT_BOOST));
        board[cur][0].weaken = 0;
        let tmp = board[cur][0]; board[cur][0] = board[cur][best_a]; board[cur][best_a] = tmp;
        board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
      } else if (best_kind == 7u) {
        let atk_c = wg_cards[board[cur][0].ci];
        let ac = select(atk_c.a2_cost, atk_c.a1_cost, best_a == 0u);
        let ad = select(atk_c.a2_dmg, atk_c.a1_dmg, best_a == 0u);
        let ao = select(atk_c.a2_op, atk_c.a1_op, best_a == 0u);
        let av = select(atk_c.a2_val, atk_c.a1_val, best_a == 0u);
        let hi = (av >> 8u) & 255;
        let lo = av & 255;

        var miss_f = false;
        var total_dmg = 0;

        if ((board[cur][0].status & ST_CONFUSE) != 0 && !flip_coin_g(&rng, &guar_heads)) { miss_f = true; }
        else if ((board[cur][0].status & ST_OPP_MISS_FLIP) != 0 && !flip_coin_g(&rng, &guar_heads)) { miss_f = true; }
        else if (ao == 7 && !flip_coin_g(&rng, &guar_heads)) { miss_f = true; }
        else if (ao == 20 && av == 98 && !flip_coin_g(&rng, &guar_heads)) { miss_f = true; }

        let had_nb = (board[cur][0].status & ST_NEXT_BOOST) != 0;
        board[cur][0].status = board[cur][0].status & (~ST_NEXT_BOOST);

        if (!miss_f && board[foe][0].occ == 1) {
          if (ao == 23 && av == 6 && board[foe][0].tool != 0) {
            let hp_b = tool_hp_bonus(board[foe][0].tool);
            board[foe][0].tool = 0;
            if (hp_b > 0) { board[foe][0].max_hp = max(10, board[foe][0].max_hp - hp_b); board[foe][0].hp = min(board[foe][0].hp, board[foe][0].max_hp); }
          }

          var raw_d = ad;
          var direct_act = true;

          if (ao == 8) {
            var hd = 0;
            if (av == 99) { for (var cf = 0u; cf < 10u; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { hd = hd + 1; } else { break; } } }
            else { let lim = u32(clamp(av, 1, 12)); for (var cf = 0u; cf < lim; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { hd = hd + 1; } } }
            raw_d = ad * hd;
          } else if (ao == 9) {
            var hd = 0;
            if (hi == 99) { for (var cf = 0u; cf < 10u; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { hd = hd + 1; } else { break; } } }
            else { let lim = u32(clamp(hi, 1, 8)); for (var cf = 0u; cf < lim; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { hd = hd + 1; } } }
            raw_d = ad + lo * hd;
          } else if (ao == 10) {
            if (hi == 3) {
              let nn = u32(1 + count_bench_s(board[cur]));
              var hd = 0;
              for (var cf = 0u; cf < nn; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { hd = hd + 1; } }
              raw_d = lo * hd;
            } else {
              var cnt = 0;
              if (hi == 0) { cnt = count_bench_s(board[cur]); }
              else if (hi == 1) { cnt = count_bench_s(board[foe]); }
              else { cnt = count_bench_s(board[cur]) + count_bench_s(board[foe]); }
              raw_d = ad + cnt * lo;
            }
          } else if (ao == 11) {
            let e = eff_energy_s(board[cur], 0u);
            if (av >= 1000) {
              let per = av - 1000;
              let lim = u32(min(e, 10));
              var hd = 0;
              for (var cf = 0u; cf < lim; cf = cf + 1u) { if (flip_coin_g(&rng, &guar_heads)) { hd = hd + 1; } }
              raw_d = per * hd;
            } else {
              raw_d = ad + e * av;
            }
          } else if (ao == 12) {
            if (hi == 1) {
              var te = 0;
              for (var s = 0u; s < 4u; s = s + 1u) { if (board[foe][s].occ == 1) { te = te + board[foe][s].energy; } }
              raw_d = ad + te * lo;
            } else if (hi == 2) {
              direct_act = false;
              var ts = 0u;
              for (var s = 1u; s < 4u; s = s + 1u) { if (board[foe][s].occ == 1 && board[foe][s].energy > board[foe][ts].energy) { ts = s; } }
              let sd = board[foe][ts].energy * lo;
              if (ts == 0u) { total_dmg = sd; board[foe][0].hp = board[foe][0].hp - sd; }
              else {
                board[foe][ts].hp = board[foe][ts].hp - sd;
                if (board[foe][ts].hp <= 0) { points[cur] = points[cur] + wg_cards[board[foe][ts].ci].prize; board[foe][ts].occ = 0; }
              }
            } else {
              raw_d = ad + board[foe][0].energy * lo;
            }
          } else if (ao == 13) {
            let e = eff_energy_s(board[cur], 0u);
            raw_d = ad + select(0, lo, e >= ac + hi);
          } else if (ao == 14) {
            if (hi == 0 && board[foe][0].hp < board[foe][0].max_hp) { raw_d = ad + lo; }
            else if (hi == 1 && board[cur][0].hp < board[cur][0].max_hp) { raw_d = ad + lo; }
            else if (hi == 2 && board[cur][0].hp < board[cur][0].max_hp) { raw_d = max(0, ad - lo); }
            else if (hi == 3) { raw_d = ad + max(0, board[cur][0].max_hp - board[cur][0].hp); }
          } else if (ao == 17) {
            if (hi == 2 || hi == 8 || hi == 10) {
              direct_act = false;
              var ts = 4u;
              if (hi == 10) {
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (board[foe][s].occ == 1 && board[foe][s].hp < board[foe][s].max_hp) {
                    if (ts == 4u || board[foe][s].hp < board[foe][ts].hp) { ts = s; }
                  }
                }
              } else {
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (board[foe][s].occ == 1) {
                    let blk = (s == 0u) && act_ex_blk;
                    if (!blk && (ts == 4u || board[foe][s].hp < board[foe][ts].hp)) { ts = s; }
                  }
                }
              }
              if (ts < 4u) {
                board[foe][ts].hp = board[foe][ts].hp - lo;
                if (ts == 0u) { total_dmg = lo; }
                else if (board[foe][ts].hp <= 0) { points[cur] = points[cur] + wg_cards[board[foe][ts].ci].prize; board[foe][ts].occ = 0; }
              }
              if (hi == 8) {
                if (board[cur][0].energy > 0) { energy_disc[cur] = 1; }
                board[cur][0].energy = 0;
              }
            } else if (hi >= 3 && hi <= 7) {
              direct_act = false;
              let times = u32(hi - 2);
              var thit = 0;
              for (var tt = 0u; tt < times; tt = tt + 1u) {
                var oidx = array<u32, 4>(0u, 0u, 0u, 0u);
                var on = 0u;
                for (var s = 0u; s < 4u; s = s + 1u) { if (board[foe][s].occ == 1 && board[foe][s].hp > 0) { oidx[on] = s; on = on + 1u; } }
                if (on == 0u) { break; }
                let pk = oidx[rng_next(&rng) % on];
                if (pk == 0u && act_ex_blk) { continue; }
                board[foe][pk].hp = board[foe][pk].hp - lo;
                thit = thit + lo;
                if (pk > 0u && board[foe][pk].hp <= 0) { points[cur] = points[cur] + wg_cards[board[foe][pk].ci].prize; board[foe][pk].occ = 0; }
              }
              total_dmg = thit;
            } else if (hi == 9) {
              direct_act = false;
              for (var s = 0u; s < 4u; s = s + 1u) {
                if (board[foe][s].occ == 1) {
                  if (s == 0u && act_ex_blk) { continue; }
                  board[foe][s].hp = board[foe][s].hp - lo;
                  if (s == 0u) { total_dmg = lo; }
                  else if (board[foe][s].hp <= 0) { points[cur] = points[cur] + wg_cards[board[foe][s].ci].prize; board[foe][s].occ = 0; }
                }
              }
            }
          } else if (ao == 27) {
            var b = 0;
            if (hi == 0 && (board[foe][0].status & ST_SPECIAL_MASK) != 0) { b = lo; }
            else if (hi == 1 && wg_cards[board[foe][0].ci].prize >= 2) { b = lo; }
            else if (hi == 2 && (board[cur][0].status & ST_HAS_ATTACKED) == 0) {
              b = lo;
              board[foe][0].status = apply_st_val(board[foe][0], ST_PARALYZE);
            }
            else if (hi == 3 && wg_cards[board[foe][0].ci].stage == 0) { b = lo; }
            else if (hi == 4 && board[cur][0].tool != 0) { b = lo; }
            else if (hi == 5 && board[foe][0].tool != 0) { b = lo; }
            else if (hi == 6 && ko_last_turn[cur] != 0) { b = lo; }
            else if (hi == 7 && supporter_used) { b = lo; }
            else if (hi == 8 && board[foe][0].hp > board[cur][0].hp) { b = lo; }
            else if (hi == 9 && wg_cards[board[foe][0].ci].ab_op != 0) { b = lo; }
            else if (hi == 10 && (board[cur][0].status & ST_SWITCHED_IN) != 0) { b = lo; }
            else if (hi == 11 && wg_cards[board[cur][0].ci].stage > 0 && board[cur][0].turn_placed == turn_i) { b = lo; }
            raw_d = ad + b;
          } else if (ao == 28) {
            direct_act = false;
            if (av == 1) { total_dmg = board[foe][0].hp; board[foe][0].hp = 0; }
            else if (av == 2) {
              board[foe][0].occ = 0;
              let pr = best_bench_s(board[foe]);
              if (pr < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
            } else if (av == 3) {
              if (flip_coin_g(&rng, &guar_heads) && flip_coin_g(&rng, &guar_heads)) { total_dmg = board[foe][0].hp; board[foe][0].hp = 0; }
            } else {
              let cut = ((board[foe][0].hp / 2) / 10) * 10;
              let dealt = max(10, cut);
              board[foe][0].hp = board[foe][0].hp - dealt;
              total_dmg = dealt;
            }
          }

          var act_took = false;
          if (direct_act && raw_d > 0) {
            let invuln = (board[foe][0].status & ST_INVULN) != 0;
            let fc = wg_cards[board[foe][0].ci];
            let disg = (fc.ab_op == 26) && (fc.ab_val == 1) && ((board[foe][0].status & ST_DISGUISE_USED) == 0);
            var dodge = false;
            if (!invuln && !act_ex_blk && !disg && fc.ab_op == 26 && fc.ab_val == 2) {
              var dh = false;
              dodge = flip_coin_g(&rng, &dh);
            }
            if (invuln || act_ex_blk || disg || dodge) {
              if (disg) { board[foe][0].status = board[foe][0].status | ST_DISGUISE_USED; }
              total_dmg = 0;
            } else {
              let mod_n = calc_mods_s(board[cur], board[foe], dmg_boost, dmg_boost_ex, stad, team_shield[foe]);
              let enb = select(0, 60, had_nb);
              total_dmg = max(0, raw_d + mod_n + enb);
              if (total_dmg > 0) { board[foe][0].hp = board[foe][0].hp - total_dmg; act_took = true; }
            }
          } else if (!direct_act && total_dmg > 0 && board[foe][0].occ == 1) {
            act_took = true;
          }

          if (act_took && board[foe][0].occ == 1) {
            if (board[foe][0].tool == 3) { board[cur][0].hp = board[cur][0].hp - 20; }
            if (board[foe][0].tool == 4) { board[cur][0].status = apply_st_val(board[cur][0], ST_POISON); }
            if (board[foe][0].shield < 0) { board[cur][0].hp = board[cur][0].hp + board[foe][0].shield; }
            let fc = wg_cards[board[foe][0].ci];
            if (fc.ab_op == 14) {
              if (fc.ab_val == 99) { board[cur][0].status = apply_st_val(board[cur][0], ST_POISON); }
              else if (fc.ab_val > 0 && fc.ab_val < 100) { board[cur][0].hp = board[cur][0].hp - fc.ab_val; }
            }
          }

          // Post-damage attack effects
          if (ao == 1) { board[foe][0].status = apply_st_val(board[foe][0], select(ST_POISON, ST_TOXIC, av >= 20)); }
          else if (ao == 2) { board[foe][0].status = apply_st_val(board[foe][0], ST_BURN); }
          else if (ao == 3) { board[foe][0].status = apply_st_val(board[foe][0], ST_SLEEP); }
          else if (ao == 4) { board[foe][0].status = apply_st_val(board[foe][0], ST_PARALYZE); }
          else if (ao == 5) { board[foe][0].status = apply_st_val(board[foe][0], ST_CONFUSE); }
          else if (ao == 6) {
            if (flip_coin_g(&rng, &guar_heads)) {
              var msk = 0;
              if ((av & 1) != 0) { msk = msk | ST_POISON; }
              if ((av & 2) != 0) { msk = msk | ST_BURN; }
              if ((av & 4) != 0) { msk = msk | ST_SLEEP; }
              if ((av & 8) != 0) { msk = msk | ST_PARALYZE; }
              if ((av & 16) != 0) { msk = msk | ST_CONFUSE; }
              board[foe][0].status = apply_st_val(board[foe][0], msk);
            }
          } else if (ao == 15) {
            if (av >= 1000) {
              let sb = av - 1000;
              for (var s = 1u; s < 4u; s = s + 1u) {
                if (board[cur][s].occ == 1) {
                  board[cur][s].hp = board[cur][s].hp - sb;
                  if (board[cur][s].hp <= 0) { points[foe] = points[foe] + wg_cards[board[cur][s].ci].prize; board[cur][s].occ = 0; }
                  break;
                }
              }
            } else { board[cur][0].hp = board[cur][0].hp - av; }
          } else if (ao == 16) {
            if (av == 100) {
              if ((rng_next(&rng) & 1u) == 0u && board[cur][0].energy > 0) { board[cur][0].energy = board[cur][0].energy - 1; energy_disc[cur] = 1; }
              else if (board[foe][0].energy > 0) { board[foe][0].energy = board[foe][0].energy - 1; energy_disc[foe] = 1; }
            } else if (av >= 99) {
              if (board[cur][0].energy > 0) { energy_disc[cur] = 1; }
              board[cur][0].energy = 0;
            } else {
              if (board[cur][0].energy > 0) { energy_disc[cur] = 1; }
              board[cur][0].energy = max(0, board[cur][0].energy - av);
            }
          } else if (ao == 17) {
            if (hi == 0) {
              for (var s = 1u; s < 4u; s = s + 1u) {
                if (board[foe][s].occ == 1) {
                  board[foe][s].hp = board[foe][s].hp - lo;
                  if (board[foe][s].hp <= 0) { points[cur] = points[cur] + wg_cards[board[foe][s].ci].prize; board[foe][s].occ = 0; }
                  break;
                }
              }
            } else if (hi == 1) {
              for (var s = 1u; s < 4u; s = s + 1u) {
                if (board[foe][s].occ == 1) {
                  board[foe][s].hp = board[foe][s].hp - lo;
                  if (board[foe][s].hp <= 0) { points[cur] = points[cur] + wg_cards[board[foe][s].ci].prize; board[foe][s].occ = 0; }
                }
              }
            }
          } else if (ao == 18) {
            let h = select(av, total_dmg, av == 999);
            if (h > 0) { board[cur][0].hp = min(board[cur][0].max_hp, board[cur][0].hp + h); }
          } else if (ao == 19) {
            if (av == 1) { board[cur][0].energy = board[cur][0].energy + 1; }
            else {
              let mb = select(1, 2, av == 3);
              var cnt = 0;
              for (var s = 1u; s < 4u; s = s + 1u) {
                if (board[cur][s].occ == 1) { board[cur][s].energy = board[cur][s].energy + 1; cnt = cnt + 1; if (cnt >= mb) { break; } }
              }
            }
          } else if (ao == 20) {
            if (av == 98 || av == 99) {
              if (av == 98 || flip_coin_g(&rng, &guar_heads)) { board[cur][0].status = board[cur][0].status | ST_INVULN; }
            } else if (av > 100) { board[cur][0].shield = -(av - 100); }
            else { board[cur][0].shield = av; }
          } else if (ao == 21) {
            if (av == 99) { board[foe][0].status = board[foe][0].status | ST_OPP_MISS_FLIP; }
            else if (av == 98) { board[foe][0].status = board[foe][0].status | ST_CANT_ATK_OPP; }
            else if (av == 97) { if (flip_coin_g(&rng, &guar_heads)) { board[foe][0].status = board[foe][0].status | ST_CANT_ATK_OPP; } }
            else { board[foe][0].weaken = board[foe][0].weaken + av; }
          } else if (ao == 22) {
            let pr = best_bench_s(board[cur]);
            if (pr < 4u) {
              board[cur][0].status = board[cur][0].status & (~ST_SPECIAL_MASK);
              let tmp = board[cur][0]; board[cur][0] = board[cur][pr]; board[cur][pr] = tmp;
              board[cur][0].status = board[cur][0].status & (~ST_HAS_ATTACKED);
            }
          } else if (ao == 23) {
            if (av == 1) { board[foe][0].status = board[foe][0].status | ST_CANT_RETREAT; }
            else if (av == 2) {
              let pk = best_bench_s(board[foe]);
              if (pk < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pk]; board[foe][pk] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
            } else if (av == 3) { item_lock[foe] = 1; }
            else if (av == 4) {
              for (var k = 0u; k < hand_len[foe]; k = k + 1u) {
                if (wg_cards[hands[foe][k]].is_supporter == 1) { hand_len[foe] = hand_len[foe] - 1u; hands[foe][k] = hands[foe][hand_len[foe]]; break; }
              }
            } else if (av == 5) { supp_lock[foe] = 1; }
            else if (av == 7) {
              if (hand_len[foe] > 0u) {
                let pk = rng_next(&rng) % hand_len[foe];
                let cb = hands[foe][pk];
                hand_len[foe] = hand_len[foe] - 1u; hands[foe][pk] = hands[foe][hand_len[foe]];
                if (lib_len[foe] < 20u) { libs[foe][lib_len[foe]] = cb; lib_len[foe] = lib_len[foe] + 1u; }
              }
            } else if (av == 8) {
              if (flip_coin_g(&rng, &guar_heads) && count_bench_s(board[foe]) > 0) {
                let b_ci = board[foe][0].ci;
                board[foe][0].occ = 0;
                let pr = best_bench_s(board[foe]);
                if (pr < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
                if (lib_len[foe] < 20u) { libs[foe][lib_len[foe]] = b_ci; lib_len[foe] = lib_len[foe] + 1u; }
              }
            }
          } else if (ao == 24) {
            var disc_c = 0;
            if (av == 1 && board[foe][0].energy > 0) { board[foe][0].energy = board[foe][0].energy - 1; disc_c = 1; }
            else if (av == 2 && board[foe][0].energy > 0 && flip_coin_g(&rng, &guar_heads)) { board[foe][0].energy = board[foe][0].energy - 1; disc_c = 1; }
            else if (av == 3) { for (var cf = 0u; cf < 5u; cf = cf + 1u) { if (board[foe][0].energy > 0 && flip_coin_g(&rng, &guar_heads)) { board[foe][0].energy = board[foe][0].energy - 1; disc_c = disc_c + 1; } else { break; } } }
            if (disc_c > 0) { energy_disc[foe] = 1; }
          } else if (ao == 25) {
            if (av == 1) { if (lib_len[cur] > 0u && hand_len[cur] < 12u) { lib_len[cur] = lib_len[cur] - 1u; hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]]; hand_len[cur] = hand_len[cur] + 1u; } }
            else if (av == 2) {
              if (hand_len[cur] < 12u && lib_len[cur] > 0u) {
                var m_pos = 20u; var m_cnt = 0u;
                for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                  let lc = wg_cards[libs[cur][li]];
                  if (lc.is_pokemon == 1 && lc.is_fossil == 0) { m_cnt = m_cnt + 1u; if ((rng_next(&rng) % m_cnt) == 0u) { m_pos = li; } }
                }
                if (m_pos < lib_len[cur]) {
                  let found = libs[cur][m_pos]; lib_len[cur] = lib_len[cur] - 1u; libs[cur][m_pos] = libs[cur][lib_len[cur]];
                  hands[cur][hand_len[cur]] = found; hand_len[cur] = hand_len[cur] + 1u;
                }
              }
            } else if (av == 3) {
              for (var bs = 1u; bs < 4u; bs = bs + 1u) {
                if (board[cur][bs].occ == 0) {
                  for (var li = 0u; li < lib_len[cur]; li = li + 1u) {
                    let b_ci = libs[cur][li];
                    let bc = wg_cards[b_ci];
                    if (bc.is_pokemon == 1 && bc.stage == 0 && bc.is_fossil == 0) {
                      lib_len[cur] = lib_len[cur] - 1u; libs[cur][li] = libs[cur][lib_len[cur]];
                      board[cur][bs] = Slot(1, b_ci, bc.hp, bc.hp, 0, 0, 0, 0, 0, turn_i);
                      break;
                    }
                  }
                  break;
                }
              }
            } else if (av == 4) {
              let want = hand_len[foe];
              for (var k = 0u; k < hand_len[cur]; k = k + 1u) { if (lib_len[cur] < 20u) { libs[cur][lib_len[cur]] = hands[cur][k]; lib_len[cur] = lib_len[cur] + 1u; } }
              hand_len[cur] = 0u;
              let nl = lib_len[cur];
              if (nl > 1u) {
                for (var ii = 0u; ii < nl - 1u; ii = ii + 1u) {
                  let i = (nl - 1u) - ii; let j = rng_next(&rng) % (i + 1u);
                  let tmp = libs[cur][i]; libs[cur][i] = libs[cur][j]; libs[cur][j] = tmp;
                }
              }
              for (var dd = 0u; dd < want; dd = dd + 1u) { if (lib_len[cur] > 0u && hand_len[cur] < 12u) { lib_len[cur] = lib_len[cur] - 1u; hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]]; hand_len[cur] = hand_len[cur] + 1u; } }
            }
          } else if (ao == 26) {
            if (av == 1) { board[cur][0].status = board[cur][0].status | ST_CANT_ATK_SELF; }
            else { board[cur][0].status = board[cur][0].status | ST_NEXT_BOOST; }
          }
        }

        board[cur][0].status = board[cur][0].status | ST_HAS_ATTACKED;

        // Resolve opponent Active KO (Guts, Lucky Egg, Pyukumuku)
        var pyu_rec = 0;
        if (board[foe][0].occ == 1 && board[foe][0].hp <= 0) {
          let fc = wg_cards[board[foe][0].ci];
          var survived = false;
          if (fc.ab_op == 26 && fc.ab_val == 3) {
            var dh = false;
            if (flip_coin_g(&rng, &dh)) { board[foe][0].hp = 10; survived = true; }
          }
          if (!survived) {
            if (fc.ab_op == 14 && fc.ab_val >= 100) { pyu_rec = fc.ab_val - 100; }
            let had_egg = board[foe][0].tool == 7;
            points[cur] = points[cur] + fc.prize;
            ko_last_turn[foe] = 1;
            board[foe][0].occ = 0;
            let pr = best_bench_s(board[foe]);
            if (pr < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
            if (had_egg) {
              loop {
                if (hand_len[foe] >= 5u || lib_len[foe] == 0u) { break; }
                lib_len[foe] = lib_len[foe] - 1u;
                hands[foe][hand_len[foe]] = libs[foe][lib_len[foe]];
                hand_len[foe] = hand_len[foe] + 1u;
              }
            }
          }
        }
        if (pyu_rec > 0 && board[cur][0].occ == 1) { board[cur][0].hp = board[cur][0].hp - pyu_rec; }
        // Resolve self Active KO
        if (board[cur][0].occ == 1 && board[cur][0].hp <= 0) {
          points[foe] = points[foe] + wg_cards[board[cur][0].ci].prize;
          board[cur][0].occ = 0;
          let pr = best_bench_s(board[cur]);
          if (pr < 4u) { let tmp = board[cur][0]; board[cur][0] = board[cur][pr]; board[cur][pr] = tmp; board[cur][0].status = board[cur][0].status & (~ST_HAS_ATTACKED); }
        }

        let cw = (points[cur] >= 3 || board[foe][0].occ == 0);
        let fw = (points[foe] >= 3 || board[cur][0].occ == 0);
        if (cw && fw) { return vec2<u32>(2u, turn); }
        if (cw) { return vec2<u32>(select(0u, 1u, cur == 0u), turn); }
        if (fw) { return vec2<u32>(select(0u, 1u, foe == 0u), turn); }
        break;
      }
    }

    // === End-of-Turn Triggers for Current Player ===
    if (board[cur][0].occ == 1) {
      if (wg_cards[board[cur][0].ci].ab_op == 1 && lib_len[cur] > 0u && hand_len[cur] < 12u) {
        lib_len[cur] = lib_len[cur] - 1u;
        hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
        hand_len[cur] = hand_len[cur] + 1u;
      }
      if (board[cur][0].tool == 8 && board[foe][0].occ == 1) {
        board[foe][0].hp = board[foe][0].hp - 10;
        if (board[foe][0].hp <= 0) {
          points[cur] = points[cur] + wg_cards[board[foe][0].ci].prize;
          board[foe][0].occ = 0;
          let pr = best_bench_s(board[foe]);
          if (pr < 4u) { let tmp = board[foe][0]; board[foe][0] = board[foe][pr]; board[foe][pr] = tmp; board[foe][0].status = board[foe][0].status & (~ST_HAS_ATTACKED); }
        }
        if (points[cur] >= 3 || board[foe][0].occ == 0) { return vec2<u32>(select(0u, 1u, cur == 0u), turn); }
      }
      let cur_c = wg_cards[board[cur][0].ci];
      if ((cur_c.ab_op == 23 && cur_c.ab_val == 2) || (stad == 7 && board[cur][0].energy > 0)) {
        if (board[cur][0].hp < board[cur][0].max_hp) { board[cur][0].hp = min(board[cur][0].max_hp, board[cur][0].hp + 20); }
      }
      if ((board[cur][0].status & ST_PARALYZE) != 0) { board[cur][0].status = board[cur][0].status & (~ST_PARALYZE); }
      board[cur][0].status = board[cur][0].status & (~(ST_CANT_RETREAT | ST_CANT_ATK_OPP | ST_OPP_MISS_FLIP | ST_SWITCHED_IN));
      if (had_cant_atk_self) { board[cur][0].status = board[cur][0].status & (~ST_CANT_ATK_SELF); }
      if (had_next_boost_start) { board[cur][0].status = board[cur][0].status & (~ST_NEXT_BOOST); }
      board[cur][0].weaken = 0;
    }
    if (turn <= 2u) {
      for (var s = 0u; s < 4u; s = s + 1u) {
        if (board[cur][s].occ == 1 && wg_cards[board[cur][s].ci].ab_op == 23 && wg_cards[board[cur][s].ci].ab_val == 3) {
          board[cur][s].energy = board[cur][s].energy + 1;
        }
      }
    }
    item_lock[cur] = 0;
    supp_lock[cur] = 0;
    ko_last_turn[cur] = 0;

    // === Between-Turns Pokémon Check ===
    for (var p = 0u; p < 2u; p = p + 1u) {
      let opp = 1u - p;
      if (board[p][0].occ == 0) { continue; }

      if ((board[p][0].status & (ST_POISON | ST_TOXIC)) != 0) {
        var pdmg = select(10, 20, (board[p][0].status & ST_TOXIC) != 0);
        for (var s = 0u; s < 4u; s = s + 1u) { if (board[opp][s].occ == 1 && wg_cards[board[opp][s].ci].ab_op == 24) { pdmg = pdmg + 10; } }
        board[p][0].hp = board[p][0].hp - pdmg;
        if (board[p][0].hp <= 0) {
          points[opp] = points[opp] + wg_cards[board[p][0].ci].prize;
          board[p][0].occ = 0;
          let pr = best_bench_s(board[p]);
          if (pr < 4u) { let tmp = board[p][0]; board[p][0] = board[p][pr]; board[p][pr] = tmp; board[p][0].status = board[p][0].status & (~ST_HAS_ATTACKED); }
        }
        if (board[p][0].occ == 0) { continue; }
      }
      if ((board[p][0].status & ST_BURN) != 0) {
        board[p][0].hp = board[p][0].hp - 20;
        var dh = false;
        if (flip_coin_g(&rng, &dh)) { board[p][0].status = board[p][0].status & (~ST_BURN); }
        if (board[p][0].hp <= 0) {
          points[opp] = points[opp] + wg_cards[board[p][0].ci].prize;
          board[p][0].occ = 0;
          let pr = best_bench_s(board[p]);
          if (pr < 4u) { let tmp = board[p][0]; board[p][0] = board[p][pr]; board[p][pr] = tmp; board[p][0].status = board[p][0].status & (~ST_HAS_ATTACKED); }
        }
        if (board[p][0].occ == 0) { continue; }
      }
      if ((board[p][0].status & ST_SLEEP) != 0) {
        var nmd = 0;
        for (var s = 0u; s < 4u; s = s + 1u) { if (board[opp][s].occ == 1 && wg_cards[board[opp][s].ci].ab_op == 10) { nmd = nmd + wg_cards[board[opp][s].ci].ab_val; } }
        if (nmd > 0) {
          board[p][0].hp = board[p][0].hp - nmd;
          if (board[p][0].hp <= 0) {
            points[opp] = points[opp] + wg_cards[board[p][0].ci].prize;
            board[p][0].occ = 0;
            let pr = best_bench_s(board[p]);
            if (pr < 4u) { let tmp = board[p][0]; board[p][0] = board[p][pr]; board[p][pr] = tmp; board[p][0].status = board[p][0].status & (~ST_HAS_ATTACKED); }
          }
          if (board[p][0].occ == 0) { continue; }
        }
        if ((board[p][0].status & ST_SLEEP) != 0) {
          var dh = false;
          if (flip_coin_g(&rng, &dh)) { board[p][0].status = board[p][0].status & (~ST_SLEEP); }
        }
      }
      if (board[opp][0].occ == 1 && wg_cards[board[opp][0].ci].ab_op == 23 && wg_cards[board[opp][0].ci].ab_val == 1) {
        board[p][0].hp = board[p][0].hp - 10;
        if (board[p][0].hp <= 0) {
          points[opp] = points[opp] + wg_cards[board[p][0].ci].prize;
          board[p][0].occ = 0;
          let pr = best_bench_s(board[p]);
          if (pr < 4u) { let tmp = board[p][0]; board[p][0] = board[p][pr]; board[p][pr] = tmp; board[p][0].status = board[p][0].status & (~ST_HAS_ATTACKED); }
        }
      }
    }

    let p0_w = (points[0] >= 3 || board[1][0].occ == 0);
    let p1_w = (points[1] >= 3 || board[0][0].occ == 0);
    if (p0_w && p1_w) { return vec2<u32>(2u, turn); }
    if (p0_w) { return vec2<u32>(1u, turn); }
    if (p1_w) { return vec2<u32>(0u, turn); }

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

// Deck AI Optimizer Batch Kernel: tests up to 256 candidate replacement cards at slot 19 vs Top-10 opponents in parallel!
const WGSL_OPTIMIZE = WGSL_SHARED_HEADER + /* wgsl */ `
@group(0) @binding(4) var<storage, read> cand_cards_buf: array<i32>;
var<workgroup> wg_opt: array<atomic<u32>, 4>;

fn load_cand_vram(ci: u32) -> Card {
  let o = ci * CARD_STRIDE;
  let raw_meta = cand_cards_buf[o + 1u];
  var c: Card;
  c.is_pokemon = cand_cards_buf[o];
  c.stage = raw_meta & 255;
  c.evo_group = (raw_meta >> 8u) & 65535;
  c.is_supporter = (raw_meta >> 24u) & 1;
  c.is_item = (raw_meta >> 25u) & 1;
  c.is_fossil = (raw_meta >> 26u) & 1;
  c.type_code = cand_cards_buf[o + 2u];
  c.weak_code = cand_cards_buf[o + 3u];
  c.hp = cand_cards_buf[o + 4u];
  c.retreat = cand_cards_buf[o + 5u];
  c.prize = max(1, cand_cards_buf[o + 6u]);
  c.a1_cost = cand_cards_buf[o + 7u] & 255;
  c.a1_dmg = cand_cards_buf[o + 8u];
  c.a1_op = cand_cards_buf[o + 9u] & 255;
  c.a1_val = cand_cards_buf[o + 10u];
  c.a2_cost = cand_cards_buf[o + 11u] & 255;
  c.a2_dmg = cand_cards_buf[o + 12u];
  c.a2_op = cand_cards_buf[o + 13u] & 255;
  c.a2_val = cand_cards_buf[o + 14u];
  c.ab_op = cand_cards_buf[o + 15u] & 255;
  c.ab_val = cand_cards_buf[o + 16u];
  c.trainer_kind = cand_cards_buf[o + 17u];
  c.effect_val = cand_cards_buf[o + 18u];
  let p1 = select(0, est_atk_power(c.a1_dmg, c.a1_op, c.a1_val), c.a1_cost != 255);
  let p2 = select(0, est_atk_power(c.a2_dmg, c.a2_op, c.a2_val), c.a2_cost != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = cand_cards_buf[o + 20u];
  return c;
}

@compute @workgroup_size(128)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  let n_opps = params.n_opps;
  let n_cands = params.n_cands;
  let ci = gid.y / n_opps;
  let opp_idx = gid.y % n_opps;

  if (ci < n_cands && opp_idx < n_opps) {
    if (lid.x < 19u) {
      wg_cards[lid.x] = load_card_vram(0u, lid.x);
    } else if (lid.x == 19u) {
      wg_cards[19u] = load_cand_vram(ci);
    } else if (lid.x < 40u) {
      wg_cards[lid.x] = load_card_vram(opp_idx + 1u, lid.x - 20u);
    } else if (lid.x < 62u) {
      let k = lid.x - 40u;
      wg_w0[k] = weights_buf[MAX_ENEMIES * FEATURES + k];
    } else if (lid.x < 84u) {
      let k = lid.x - 62u;
      wg_w1[k] = weights_buf[opp_idx * FEATURES + k];
    }
  }
  if (lid.x < 4u) { atomicStore(&wg_opt[lid.x], 0u); }
  workgroupBarrier();

  let gpo = params.games_per_opp;
  let half = max(1u, gpo / 2u);
  let gpt = params.games_per_thread;
  let base_k = gid.x * gpt;
  let end_k = min(gpo, base_k + gpt);

  var loc_tot = 0u;
  var loc_w = 0u;
  var loc_d = 0u;
  var loc_l = 0u;

  if (ci < n_cands && opp_idx < n_opps && base_k < gpo) {
    let opp_mix = params.seed_base ^ ((opp_idx + 1u) * 1000003u);
    for (var idx = base_k; idx < end_k; idx = idx + 1u) {
      let first = select(1u, 0u, idx < half);
      let seed_slot = idx % half;
      let seed = opp_mix ^ (seed_slot * 2654435761u);
      let res = sim_game(seed, first);
      loc_tot = loc_tot + 1u;
      if (res.x == 1u) { loc_w = loc_w + 1u; }
      else if (res.x == 2u) { loc_d = loc_d + 1u; }
      else { loc_l = loc_l + 1u; }
    }
  }

  if (loc_tot > 0u) {
    atomicAdd(&wg_opt[0], loc_tot);
    atomicAdd(&wg_opt[1], loc_w);
    atomicAdd(&wg_opt[2], loc_d);
    atomicAdd(&wg_opt[3], loc_l);
  }
  workgroupBarrier();

  if (lid.x < 4u && ci < n_cands && opp_idx < n_opps) {
    let v = atomicLoad(&wg_opt[lid.x]);
    if (v > 0u) { atomicAdd(&out_u32[ci * 4u + lid.x], v); }
  }
}
`;

let gpuEngineInstance = null;
let gpuProbePromise = null;

function packCardToI32(dst, o, c, slotId) {
  const meta = (c.stage & 0xff)
    | (((c.evoGroup || 0) & 0xffff) << 8)
    | ((c.isSupporter ? 1 : 0) << 24)
    | ((c.isItem ? 1 : 0) << 25)
    | ((c.isFossil ? 1 : 0) << 26);
  const hasV2 = c.a1Cost !== undefined;
  dst[o] = c.isPokemon | 0;
  dst[o + 1] = meta | 0;
  dst[o + 2] = c.typeCode | 0;
  dst[o + 3] = c.weakCode | 0;
  dst[o + 4] = c.hp | 0;
  dst[o + 5] = c.retreat | 0;
  dst[o + 6] = c.prize | 0;
  dst[o + 7] = (hasV2 ? c.a1Cost : (c.atkCost ?? 1)) | 0;
  dst[o + 8] = (hasV2 ? c.a1Dmg : (c.atkDmg ?? 0)) | 0;
  dst[o + 9] = (hasV2 ? c.a1Op : 0) | 0;
  dst[o + 10] = (hasV2 ? c.a1Val : 0) | 0;
  dst[o + 11] = (hasV2 ? c.a2Cost : 255) | 0;
  dst[o + 12] = (hasV2 ? c.a2Dmg : 0) | 0;
  dst[o + 13] = (hasV2 ? c.a2Op : 0) | 0;
  dst[o + 14] = (hasV2 ? c.a2Val : 0) | 0;
  dst[o + 15] = (hasV2 ? c.abOp : 0) | 0;
  dst[o + 16] = (hasV2 ? c.abVal : 0) | 0;
  dst[o + 17] = c.trainerKind | 0;
  dst[o + 18] = c.effectVal | 0;
  dst[o + 19] = slotId | 0;
  dst[o + 20] = Math.round(Number(c.strategyBonus || 0) * 1024);
  dst[o + 21] = 0;
  dst[o + 22] = 0;
  dst[o + 23] = 0;
}

function packDeckToI32(dst, slot, compactCards) {
  const baseCard = slot * 20;
  for (let i = 0; i < 20; i++) {
    const c = compactCards[i] || compactCards[0];
    packCardToI32(dst, (baseCard + i) * CARD_STRIDE, c, i);
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
      const optimizeModule = device.createShaderModule({ code: WGSL_OPTIMIZE });
      await checkShaderModule(exploreModule, 'EXPLORE');
      await checkShaderModule(testModule, 'TEST');
      await checkShaderModule(optimizeModule, 'OPTIMIZE');

      const explorePipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: exploreModule, entryPoint: 'main' }
      });
      const testPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: testModule, entryPoint: 'main' }
      });
      const optimizePipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: optimizeModule, entryPoint: 'main' }
      });

      const uniformBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      const decksBuf = device.createBuffer({
        size: 12 * 20 * CARD_STRIDE * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      const candCardsBuf = device.createBuffer({
        size: 256 * CARD_STRIDE * 4,
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

      const exploreBindGroup = device.createBindGroup({
        layout: explorePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: decksBuf } },
          { binding: 2, resource: { buffer: weightsBuf } },
          { binding: 3, resource: { buffer: outU32Buf } }
        ]
      });
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
      const optimizeBindGroup = device.createBindGroup({
        layout: optimizePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: decksBuf } },
          { binding: 2, resource: { buffer: weightsBuf } },
          { binding: 3, resource: { buffer: outU32Buf } },
          { binding: 4, resource: { buffer: candCardsBuf } }
        ]
      });

      const zeroU32 = new Uint32Array(4096);
      const zeroSample = new Uint32Array(512);
      const decksHost = new Int32Array(12 * 20 * CARD_STRIDE);
      const candCardsHost = new Int32Array(256 * CARD_STRIDE);
      const weightsHost = new Int32Array((MAX_ENEMIES + MAX_CANDS) * FEATURES);
      const uniformHost = new Uint32Array(8);

      const dummyCard = {
        isPokemon: 1, stage: 0, evoGroup: 1, isSupporter: 0, isItem: 0, isFossil: 0,
        typeCode: 1, weakCode: 2, hp: 60, retreat: 1, prize: 1,
        a1Cost: 1, a1Dmg: 30, a1Op: 0, a1Val: 0,
        a2Cost: 255, a2Dmg: 0, a2Op: 0, a2Val: 0,
        abOp: 0, abVal: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0
      };
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
        },

        uploadOptimizeContext({ baseDeck, enemies, playerWeights, enemyWeightsList }) {
          packDeckToI32(decksHost, 0, baseDeck);
          for (let o = 0; o < enemies.length; o++) packDeckToI32(decksHost, o + 1, enemies[o].cards);
          device.queue.writeBuffer(decksBuf, 0, decksHost);

          weightsHost.fill(0);
          for (let o = 0; o < enemies.length; o++) {
            const ew = (enemyWeightsList && enemyWeightsList[o]) || enemyWeightsList?.[0] || [];
            for (let k = 0; k < FEATURES; k++) weightsHost[o * FEATURES + k] = Math.round(Number(ew[k] || 0) * 1024);
          }
          for (let k = 0; k < FEATURES; k++) {
            weightsHost[MAX_ENEMIES * FEATURES + k] = Math.round(Number(playerWeights[k] || 0) * 1024);
          }
          device.queue.writeBuffer(weightsBuf, 0, weightsHost);
        },

        async runOptimizeBatch({ candidateCards, nOpps, gamesPerOpp, seedBase }) {
          const nCands = Math.min(256, candidateCards.length);
          for (let i = 0; i < nCands; i++) {
            packCardToI32(candCardsHost, i * CARD_STRIDE, candidateCards[i], 19);
          }
          device.queue.writeBuffer(candCardsBuf, 0, candCardsHost.subarray(0, nCands * CARD_STRIDE));

          const gpt = 8;
          const wgX = Math.ceil(Math.ceil(gamesPerOpp / gpt) / 128);
          const wgY = nCands * nOpps;
          const outCount = nCands * 4;
          const outBytes = outCount * 4;

          uniformHost[0] = nOpps >>> 0;
          uniformHost[1] = nCands >>> 0;
          uniformHost[2] = gamesPerOpp >>> 0;
          uniformHost[3] = 0;
          uniformHost[4] = gamesPerOpp >>> 0;
          uniformHost[5] = seedBase >>> 0;
          uniformHost[6] = gpt;
          uniformHost[7] = gamesPerOpp >>> 0;

          device.queue.writeBuffer(uniformBuf, 0, uniformHost);
          device.queue.writeBuffer(outU32Buf, 0, zeroU32.subarray(0, outCount));

          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(optimizePipeline);
          pass.setBindGroup(0, optimizeBindGroup);
          pass.dispatchWorkgroups(wgX, wgY, 1);
          pass.end();
          encoder.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, outBytes);
          device.queue.submit([encoder.finish()]);

          await readU32Buf.mapAsync(GPUMapMode.READ, 0, outBytes);
          const u32 = new Uint32Array(readU32Buf.getMappedRange(0, outBytes).slice(0));
          readU32Buf.unmap();

          const results = [];
          for (let i = 0; i < nCands; i++) {
            const o = i * 4;
            results.push({ games: u32[o], wins: u32[o + 1], draws: u32[o + 2], losses: u32[o + 3] });
          }
          return { results };
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
