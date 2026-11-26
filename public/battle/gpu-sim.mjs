// High-Throughput WebGPU 4-Kernel Wavefront Compute Engine for Pocket Lab (Exact-Mechanics v3).
// Architecture:
// 1. 4-kernel turn-by-turn wavefront (init -> main_phase -> attack_checkup -> finalize), unified across
//    Explore / Test / Optimize via params.mode -> compiles in parallel in ~5s cold (<50ms warm Dawn cache),
//    zero D3D12 E_OUTOFMEMORY, high GPU occupancy, and 100% Exact-Mechanics v3 bit-for-bit parity with fastsim.wasm!
// 2. Persistent VRAM storage buffers + Workgroup Shared Memory caching of decks (wg_cards[41]) and weights.
// 3. Covers 100% of all 4,577 cards (dual op1+op2+16-bit flags, 164 abilities, 177 trainers, 27 tools, 14 stadiums).

const FEATURES = 22;
const CARD_STRIDE = 28;
const MAX_ENEMIES = 10;
const MAX_CANDS = 40;
const WG_SIZE = 64;
const SIM_STATE_BYTES = 288 * 4; // 1152 bytes per concurrent game

const WGSL_INIT = /* wgsl */ `
const FEATURES: u32 = 22u;
const CARD_STRIDE: u32 = 28u;
const MAX_ENEMIES: u32 = 10u;

const H_ARCEUS: i32 = 1861;
const H_ARCEUS_EX: i32 = 7482;
const H_LATIAS: i32 = 49426;
const H_REGIROCK: i32 = 28242;
const H_REGICE: i32 = 49745;
const H_REGISTEEL: i32 = 4900;
const H_UXIE: i32 = 56213;
const H_AZELF: i32 = 51274;
const H_TANDEMAUS: i32 = 30786;
const H_MAUSHOLD: i32 = 61523;
const H_WISHIWASHI: i32 = 39722;
const H_WISHIWASHI_EX: i32 = 30145;
const H_POOCHYENA: i32 = 39334;
const H_SWEET_HONEY: i32 = 64227;
const H_RABOOT: i32 = 29145;
const H_UNOWN: i32 = 30635;
const H_PIKACHU_EX: i32 = 10636;
const H_VOLBEAT: i32 = 46637;

const AF_IGNORE_WEAKNESS: i32 = 1;
const AF_IGNORE_EFFECTS: i32 = 2;
const AF_NEED_SWITCHED_IN: i32 = 4;
const AF_DISCARD_HAND_1: i32 = 8;
const AF_DISCARD_HAND_2: i32 = 16;
const AF_REQUIRE_HP_OVER_60: i32 = 32;
const AF_REQUIRE_LAKE_TRIO: i32 = 64;
const AF_COST_1_IF_DAMAGED: i32 = 128;
const AF_COST_1_IF_DECK_EMPTY: i32 = 256;
const AF_FLIP_2_BOTH_TAILS_FAIL: i32 = 512;
const AF_FLIP_3_ALL_TAILS_FAIL: i32 = 1024;
const AF_FIRST_ATTACK_ONLY_EFF: i32 = 2048;
const AF_ONLY_IF_KO_RECOIL: i32 = 4096;
const AF_ONLY_IF_STADIUM_EFF: i32 = 8192;
const AF_ONLY_IF_KO_LAST_TURN_EFF: i32 = 16384;
const AF_ONLY_IF_EVOLVED_THIS_TURN_EFF: i32 = 32768;

const ST_POISON: u32 = 1u;
const ST_TOXIC20: u32 = 2u;
const ST_BURN: u32 = 4u;
const ST_SLEEP: u32 = 8u;
const ST_PARALYZE: u32 = 16u;
const ST_CONFUSE: u32 = 32u;
const ST_TOXIC40: u32 = 64u;
const ST_DEEP_SLEEP: u32 = 128u;
const ST_SPECIAL_MASK: u32 = 255u;
const ST_CANT_RETREAT: u32 = 256u;
const ST_CANT_ATK_SELF: u32 = 512u;
const ST_CANT_ATK_OPP: u32 = 1024u;
const ST_CANT_USE_A1: u32 = 2048u;
const ST_CANT_USE_A2: u32 = 4096u;
const ST_OPP_MISS_FLIP: u32 = 8192u;
const ST_PERM_MISS_FLIP: u32 = 16384u;
const ST_INVULN: u32 = 32768u;
const ST_DISGUISE_USED: u32 = 65536u;
const ST_HAS_ATTACKED: u32 = 131072u;
const ST_SWITCHED_IN: u32 = 262144u;
const ST_NO_WEAKNESS: u32 = 524288u;
const ST_NO_ABILITY: u32 = 1048576u;
const ST_ATTACH_SLEEP: u32 = 2097152u;
const ST_NO_ENERGY_ATTACH: u32 = 4194304u;
const ST_IMMUNE_BASIC: u32 = 8388608u;
const ST_IMMUNE_LE40: u32 = 16777216u;
const ST_SURVIVE_10: u32 = 33554432u;
const ST_RETREAT_TRAP: u32 = 67108864u;
const ST_DAMAGED_LAST: u32 = 134217728u;
const ST_LEAVE_ACTIVE_CLEAR: u32 = 255u | 256u | 512u | 1024u | 2048u | 4096u | 8192u | 16384u | 524288u | 1048576u | 2097152u | 4194304u | 8388608u | 16777216u | 67108864u;


struct Params {
  mode: u32,
  n_opps: u32,
  n_cands: u32,
  games_per_opp: u32,
  start_pair: u32,
  pair_count: u32,
  seed_base: u32,
  total_per_opp: u32,
  wave_start: u32,
  wave_count: u32,
  wg_x: u32,
  pad0: u32,
};

struct Card {
  r0: i32, r1: i32, r2: i32, r3: i32, r4: i32, r5: i32, r6: i32,
  r7: i32, r8: i32, r9: i32, r10: i32, r11: i32,
  r12: i32, r13: i32, r14: i32, r15: i32, r16: i32,
  r17: i32, r18: i32, r19: i32, r20: i32, r21: i32, r22: i32,
  power_q: i32,
  bonus_q: i32,
};

struct Slot {
  occ: i32,
  ci: u32,
  stage_ov: i32,
  hp: i32,
  max_hp: i32,
  energy: i32,
  tool: i32,
  tool2: i32,
  status: u32,
  shield: i32,
  shield_ex: i32,
  counter: i32,
  weaken: i32,
  cost_tax: i32,
  retreat_tax: i32,
  next_atk_mod: i32,
  stack_boost: i32,
  turn_placed: i32,
};


struct GameState {
  board: array<array<Slot, 4>, 2>,
  libs: array<array<u32, 20>, 2>,
  hands: array<array<u32, 12>, 2>,
  lib_len: array<u32, 2>,
  hand_len: array<u32, 2>,
  points: array<i32, 2>,
  pts_last_turn: array<i32, 2>,
  ko_count: array<i32, 2>,
  ko_last_turn: array<i32, 2>,
  item_lock: array<i32, 2>,
  supp_lock: array<i32, 2>,
  evo_lock: array<i32, 2>,
  team_shield: array<i32, 2>,
  team_shield_type: array<i32, 2>,
  next_team_boost: array<i32, 2>,
  sweets_used_last: array<i32, 2>,
  sweets_total: array<i32, 2>,
  energy_discarded: array<i32, 2>,
  disc_poke: array<i32, 2>,
  disc_poke_p: array<i32, 2>,
  disc_item: array<i32, 2>,
  disc_supp: array<i32, 2>,
  disc_tool: array<i32, 2>,
  disc_basic_w: array<i32, 2>,
  disc_basic_any: array<i32, 2>,
  disc_quick_grow: array<i32, 2>,
  disc_volbeat: array<i32, 2>,
  delayed_slot: array<u32, 2>,
  delayed_dmg: array<i32, 2>,
  rng: u32,
  stadium: i32,
  cur: u32,
  turn: u32,
  done: u32,
  outcome: u32,
  end_turn: u32,
  pending_atk: i32,
  supporter_used: u32,
  guar_heads: u32,
  active_ex_blocked: u32,
  heal_blocked: u32,
  sweets_this_turn: i32,
  had_cant_atk_self: u32,
  had_cant_a1: u32,
  had_cant_a2: u32,
  cur_team_boost: i32,
  dmg_boost: i32,
  dmg_boost_ex: i32,
  named_boost: i32,
  named_h1: i32,
  named_h2: i32,
  eevee_boost: i32,
  iris_active: u32,
  iris_h1: i32,
  drayden_bonus: i32,
  ab_mask: u32,
  pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> decks_buf: array<i32>;
@group(0) @binding(2) var<storage, read> weights_buf: array<i32>;
@group(0) @binding(3) var<storage, read_write> out_u32: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> out_sample: array<u32>;
@group(0) @binding(5) var<storage, read> cand_cards_buf: array<i32>;
@group(0) @binding(6) var<storage, read_write> states_buf: array<GameState>;

var<workgroup> wg_cards: array<Card, 41>;
var<workgroup> wg_w0: array<i32, 22>;
var<workgroup> wg_w1: array<i32, 22>;
var<private> g: GameState;
var<private> g_heal_blk: bool;

// --- Bitfield extraction helpers on Card ---
fn c_stage(c: Card) -> i32 { return c.r1 & 255; }
fn c_evo_group(c: Card) -> i32 { return i32((u32(c.r1) >> 8u) & 65535u); }
fn c_meta_hi(c: Card) -> i32 { return i32((u32(c.r1) >> 24u) & 255u); }
fn c_is_supporter(c: Card) -> bool { return (c_meta_hi(c) & 1) != 0; }
fn c_is_item(c: Card) -> bool { return (c_meta_hi(c) & 2) != 0; }
fn c_is_fossil(c: Card) -> bool { return (c_meta_hi(c) & 4) != 0; }
fn c_is_tool(c: Card) -> bool { return (c_meta_hi(c) & 8) != 0; }
fn c_is_stadium(c: Card) -> bool { return (c_meta_hi(c) & 16) != 0; }
fn c_is_mega(c: Card) -> bool { return (c_meta_hi(c) & 32) != 0; }
fn c_prize(c: Card) -> i32 { return max(1, i32((u32(c.r6) >> 8u) & 255u)); }
fn c_is_ex(c: Card) -> bool { return (c_meta_hi(c) & 64) != 0 || c_prize(c) >= 2; }
fn c_is_ub(c: Card) -> bool { return (c_meta_hi(c) & 128) != 0; }
fn c_tag_bits(c: Card) -> i32 { return i32(u32(c.r2) & 255u); }
fn c_name_hash(c: Card) -> i32 { return i32((u32(c.r2) >> 8u) & 65535u); }
fn c_type2(c: Card) -> i32 { return i32((u32(c.r2) >> 24u) & 255u); }
fn c_is_ancient(c: Card) -> bool { return (c_tag_bits(c) & 1) != 0; }
fn c_is_future(c: Card) -> bool { return (c_tag_bits(c) & 2) != 0; }
fn c_is_team_rocket(c: Card) -> bool { return (c_tag_bits(c) & 4) != 0; }
fn c_has_sweets(c: Card) -> bool { return (c_tag_bits(c) & 8) != 0; }
fn c_has_puppy(c: Card) -> bool { return (c_tag_bits(c) & 16) != 0; }
fn c_has_psychic(c: Card) -> bool { return (c_tag_bits(c) & 32) != 0; }
fn c_has_draco(c: Card) -> bool { return (c_tag_bits(c) & 64) != 0; }
fn c_is_eevee_evo(c: Card) -> bool { return (c_tag_bits(c) & 128) != 0; }
fn c_has_type(c: Card, tc: i32) -> bool { return c.r3 == tc || c_type2(c) == tc; }
fn c_retreat(c: Card) -> i32 { return c.r6 & 255; }
fn c_evfrom_hash(c: Card) -> i32 { return i32((u32(c.r6) >> 16u) & 65535u); }
fn c_a1_cost(c: Card) -> i32 { return c.r7 & 255; }
fn c_a1_flags(c: Card) -> i32 { return i32((u32(c.r7) >> 8u) & 65535u); }
fn c_a1_op1(c: Card) -> i32 { return c.r9 & 255; }
fn c_a1_op2(c: Card) -> i32 { return i32((u32(c.r9) >> 8u) & 255u); }
fn c_a1_aux(c: Card) -> i32 { return i32((u32(c.r9) >> 16u) & 65535u); }
fn c_a2_cost(c: Card) -> i32 { return c.r12 & 255; }
fn c_a2_flags(c: Card) -> i32 { return i32((u32(c.r12) >> 8u) & 65535u); }
fn c_a2_op1(c: Card) -> i32 { return c.r14 & 255; }
fn c_a2_op2(c: Card) -> i32 { return i32((u32(c.r14) >> 8u) & 255u); }
fn c_a2_aux(c: Card) -> i32 { return i32((u32(c.r14) >> 16u) & 65535u); }
fn c_ab_op(c: Card) -> i32 { return c.r17 & 255; }
fn c_ab_cond(c: Card) -> i32 { return i32((u32(c.r17) >> 8u) & 255u); }
fn c_ab_aux(c: Card) -> i32 { return i32((u32(c.r17) >> 16u) & 65535u); }
fn c_trn_kind(c: Card) -> i32 { return c.r19 & 255; }
fn c_trn_sub(c: Card) -> i32 { return i32((u32(c.r19) >> 8u) & 255u); }
fn c_trn_cond(c: Card) -> i32 { return i32((u32(c.r19) >> 16u) & 255u); }
fn c_matches_hashes(c: Card, h1: i32, h2: i32) -> bool {
  let nh = c_name_hash(c);
  if (nh == 0) { return false; }
  let a = i32(u32(h1) & 65535u);
  let b = i32((u32(h1) >> 16u) & 65535u);
  let cc = i32(u32(h2) & 65535u);
  let d = i32((u32(h2) >> 16u) & 65535u);
  return (a != 0 && nh == a) || (b != 0 && nh == b) || (cc != 0 && nh == cc) || (d != 0 && nh == d);
}

fn s_has_tool(sl: Slot, t: i32) -> bool { return sl.tool == t || sl.tool2 == t; }
fn s_tool_cnt(sl: Slot) -> i32 { return select(0, 1, sl.tool != 0) + select(0, 1, sl.tool2 != 0); }
fn s_stage(sl: Slot) -> i32 { return select(sl.stage_ov, c_stage(wg_cards[sl.ci]), sl.stage_ov < 0); }
fn make_slot(ci: u32, hp: i32, turn_p: i32) -> Slot {
  return Slot(1, ci, -1, hp, hp, 0, 0, 0, 0u, 0, 0, 0, 0, 0, 0, 0, 0, turn_p);
}
fn empty_slot() -> Slot {
  return Slot(0, 0u, -1, 0, 0, 0, 0, 0, 0u, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

fn est_atk_power_v3(dmg: i32, op1: i32, val1: i32) -> i32 {
  var d = dmg;
  let b0 = val1 & 255;
  let b1 = i32((u32(val1) >> 8u) & 255u);
  let b2 = i32((u32(val1) >> 16u) & 255u);
  switch (op1) {
    case 3: { d = select(select(d / 2, 35, b0 == 4), d + b1 / 2, b0 == 3); }
    case 4: {
      if ((b2 & 32) != 0) { d = d + (b1 * 3) / 2; }
      else if ((b2 & 8) != 0) { d = b1 * 2; }
      else if ((b2 & 6) != 0) { d = (b1 * 3) / 2; }
      else { d = select((b1 * b0) / 2, b1, b0 == 99); }
    }
    case 5: {
      if (b0 == 97) { d = d + 45; }
      else if (b0 == 98) { d = d + b1 / 4; }
      else if (b0 == 99) { d = d + b1; }
      else if (b2 == 2 || b2 == 3) { d = d + b1 * 2; }
      else { d = d + (b1 * b0) / 2; }
    }
    case 6: {
      if (b0 == 26) { d = b1 * 3; }
      else if (b0 == 31 || b0 == 32) { d = d + 50; }
      else if (b0 == 33) { d = max(20, d - 30); }
      else if (b0 == 2 || b0 == 5) { d = d + b1 * 4; }
      else { d = d + b1 * 2; }
    }
    case 7: {
      if (b0 == 3) { d = max(20, d - b1 / 3); }
      else { d = d + b1 / 2; }
    }
    case 8: {
      if (b0 == 2 || b0 == 3 || b0 == 4) { d = b1; }
      else if (b0 == 6) { d = b1 * 3; }
      else if (b0 == 8) { d = b1 * select(max(1, b2), 3, b2 == 99); }
      else if (b0 == 10) { d = (b1 * max(1, b2)) / 2; }
      else if (b0 == 11 || b0 == 14) { d = b1 * 2; }
      else if (b0 == 12) { d = select(b1, 140, b2 == 1); }
      else { d = d + b1 / 2; }
    }
    case 19: { if (b0 == 8) { d = d + b1; } }
    case 20: { d = select(select(60, 80, b0 == 6), 150, b0 == 1); }
    default: {}
  }
  return d;
}

fn load_card_vram(deck_slot: u32, idx: u32) -> Card {
  let o = (deck_slot * 20u + idx) * CARD_STRIDE;
  var c: Card;
  c.r0 = decks_buf[o]; c.r1 = decks_buf[o + 1u]; c.r2 = decks_buf[o + 2u];
  c.r3 = decks_buf[o + 3u]; c.r4 = decks_buf[o + 4u]; c.r5 = decks_buf[o + 5u];
  c.r6 = decks_buf[o + 6u]; c.r7 = decks_buf[o + 7u]; c.r8 = decks_buf[o + 8u];
  c.r9 = decks_buf[o + 9u]; c.r10 = decks_buf[o + 10u]; c.r11 = decks_buf[o + 11u];
  c.r12 = decks_buf[o + 12u]; c.r13 = decks_buf[o + 13u]; c.r14 = decks_buf[o + 14u];
  c.r15 = decks_buf[o + 15u]; c.r16 = decks_buf[o + 16u]; c.r17 = decks_buf[o + 17u];
  c.r18 = decks_buf[o + 18u]; c.r19 = decks_buf[o + 19u]; c.r20 = decks_buf[o + 20u];
  c.r21 = decks_buf[o + 21u]; c.r22 = decks_buf[o + 22u];
  let p1 = select(0, est_atk_power_v3(c.r8, c_a1_op1(c), c.r10), c_a1_cost(c) != 255);
  let p2 = select(0, est_atk_power_v3(c.r13, c_a2_op1(c), c.r15), c_a2_cost(c) != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = decks_buf[o + 24u];
  return c;
}

fn make_sweet_honey_card() -> Card {
  var c: Card;
  c.r0 = 0; c.r1 = i32(2u << 24u); c.r2 = i32((u32(H_SWEET_HONEY) << 8u) | (255u << 24u));
  c.r3 = 9; c.r4 = 255; c.r5 = 0; c.r6 = 256;
  c.r7 = 255; c.r8 = 0; c.r9 = 0; c.r10 = 0; c.r11 = 0;
  c.r12 = 255; c.r13 = 0; c.r14 = 0; c.r15 = 0; c.r16 = 0;
  c.r17 = 0; c.r18 = 0; c.r19 = 2 | (9 << 8u); c.r20 = 20; c.r21 = 0; c.r22 = 0;
  c.power_q = 0; c.bonus_q = 0;
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

fn rng_next() -> u32 {
  var x = g.rng;
  x = x ^ (x << 13u);
  x = x ^ (x >> 17u);
  x = x ^ (x << 5u);
  g.rng = x;
  return x * 0x27d4eb2du;
}

fn flip_coin_g(gh: ptr<function, bool>) -> bool {
  if (*gh) { *gh = false; return true; }
  return (rng_next() & 1u) == 1u;
}

fn flip_coin_plain() -> bool {
  return (rng_next() & 1u) == 1u;
}

fn get_w(cur: u32, k: u32) -> i32 {
  if (cur == 0u) { return wg_w0[k]; }
  return wg_w1[k];
}

fn tool_hp_bonus(t: i32, c: Card) -> i32 {
  if (t == 1) { return 20; }
  if (t == 2) { return select(0, 30, c_has_type(c, 0)); }
  if (t == 3) { return select(0, 30, c_stage(c) == 1); }
  if (t == 4) { return select(0, 40, c_is_ancient(c)); }
  return 0;
}


fn load_cand_vram(ci: u32) -> Card {
  let o = ci * CARD_STRIDE;
  var c: Card;
  c.r0 = cand_cards_buf[o]; c.r1 = cand_cards_buf[o + 1u]; c.r2 = cand_cards_buf[o + 2u];
  c.r3 = cand_cards_buf[o + 3u]; c.r4 = cand_cards_buf[o + 4u]; c.r5 = cand_cards_buf[o + 5u];
  c.r6 = cand_cards_buf[o + 6u]; c.r7 = cand_cards_buf[o + 7u]; c.r8 = cand_cards_buf[o + 8u];
  c.r9 = cand_cards_buf[o + 9u]; c.r10 = cand_cards_buf[o + 10u]; c.r11 = cand_cards_buf[o + 11u];
  c.r12 = cand_cards_buf[o + 12u]; c.r13 = cand_cards_buf[o + 13u]; c.r14 = cand_cards_buf[o + 14u];
  c.r15 = cand_cards_buf[o + 15u]; c.r16 = cand_cards_buf[o + 16u]; c.r17 = cand_cards_buf[o + 17u];
  c.r18 = cand_cards_buf[o + 18u]; c.r19 = cand_cards_buf[o + 19u]; c.r20 = cand_cards_buf[o + 20u];
  c.r21 = cand_cards_buf[o + 21u]; c.r22 = cand_cards_buf[o + 22u];
  let p1 = select(0, est_atk_power_v3(c.r8, c_a1_op1(c), c.r10), c_a1_cost(c) != 255);
  let p2 = select(0, est_atk_power_v3(c.r13, c_a2_op1(c), c.r15), c_a2_cost(c) != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = cand_cards_buf[o + 24u];
  return c;
}

fn load_wg_cards(lid_x: u32, gid_y: u32, load_weights: bool) {
  if (params.mode == 0u) {
    let opp_idx = gid_y / params.n_cands;
    let cand_idx = gid_y % params.n_cands;
    if (opp_idx < params.n_opps) {
      if (lid_x < 20u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
      else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(opp_idx + 1u, lid_x - 20u); }
      else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
      if (load_weights && lid_x < 22u) {
        wg_w0[lid_x] = weights_buf[(MAX_ENEMIES + cand_idx) * FEATURES + lid_x];
        wg_w1[lid_x] = weights_buf[opp_idx * FEATURES + lid_x];
      }
    }
  } else if (params.mode == 1u) {
    if (lid_x < 20u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
    else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(1u, lid_x - 20u); }
    else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
    if (load_weights && lid_x < 22u) {
      wg_w0[lid_x] = weights_buf[MAX_ENEMIES * FEATURES + lid_x];
      wg_w1[lid_x] = weights_buf[lid_x];
    }
  } else {
    let ci = gid_y / params.n_opps;
    let opp_idx = gid_y % params.n_opps;
    if (ci < params.n_cands && opp_idx < params.n_opps) {
      if (lid_x < 19u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
      else if (lid_x == 19u) { wg_cards[19u] = load_cand_vram(ci); }
      else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(opp_idx + 1u, lid_x - 20u); }
      else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
      if (load_weights && lid_x < 22u) {
        wg_w0[lid_x] = weights_buf[MAX_ENEMIES * FEATURES + lid_x];
        wg_w1[lid_x] = weights_buf[opp_idx * FEATURES + lid_x];
      }
    }
  }
}

fn sync_ab(turn: i32) {
  var blk_b = false;
  var blk_h = false;
  let dz = u32(params.mode == 99u);
  for (var i = 0u; i < 8u + dz; i = i + 1u) {
    let sl = g.board[i >> 2u][i & 3u];
    if (sl.occ == 1 && (sl.status & ST_NO_ABILITY) == 0u) {
      let c = wg_cards[sl.ci];
      if (c_ab_op(c) == 17 && c.r18 == 7) { blk_b = true; }
    }
  }
  var m = 0u;
  for (var i = 0u; i < 8u + dz; i = i + 1u) {
    let p = i >> 2u; let s = i & 3u;
    let sl = g.board[p][s];
    if (sl.occ == 0 || (sl.status & ST_NO_ABILITY) != 0u) { continue; }
    let c = wg_cards[sl.ci];
    let aop = c_ab_op(c);
    if (aop == 0 || (s_stage(sl) == 0 && blk_b)) { continue; }
    if (aop == 17 && c.r18 == 6) { blk_h = true; }
    let cond = c_ab_cond(c);
    var ok = true;
    if (cond == 1) { ok = (s == 0u); }
    else if (cond == 2) { ok = (s > 0u); }
    else if (cond == 6) { ok = (s_tool_cnt(sl) > 0); }
    else if (cond == 7) { ok = (sl.hp >= sl.max_hp); }
    else if (cond == 8) { ok = (sl.hp <= 50); }
    else if (cond == 9) { ok = (g.stadium != 0); }
    else if (cond == 10) { ok = (turn <= 2); }
    else if (cond == 12) { ok = (sl.energy > 0); }
    else if (cond == 3 || cond == 4 || cond == 5 || cond == 11) {
      ok = false;
      let w1 = select(select(select(H_UNOWN, H_LATIAS, cond == 5), c_name_hash(c), cond == 4), H_ARCEUS, cond == 3);
      let w2 = select(w1, H_ARCEUS_EX, cond == 3);
      let excl = (cond == 4 || cond == 11);
      for (var k = 0u; k < 4u + dz; k = k + 1u) {
        if ((!excl || k != s) && g.board[p][k].occ == 1) {
          let nh = c_name_hash(wg_cards[g.board[p][k].ci]);
          if (nh == w1 || nh == w2) { ok = true; break; }
        }
      }
    }
    if (ok) { m = m | (1u << i); }
  }
  g.ab_mask = m;
  g_heal_blk = blk_h;
}

fn healing_blocked() -> bool { return g_heal_blk; }
fn ab_active(p: u32, s: u32, turn: i32) -> bool { return ((g.ab_mask >> (p * 4u + s)) & 1u) != 0u; }

fn count_bench(p: u32) -> i32 {
  var n = 0;
  for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[p][s].occ == 1) { n = n + 1; } }
  return n;
}

fn eff_energy(p: u32, s: u32, turn: i32) -> i32 {
  let e = g.board[p][s].energy;
  if (c_has_type(wg_cards[g.board[p][s].ci], 0)) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (ab_active(p, k, turn)) {
        let kc = wg_cards[g.board[p][k].ci];
        if (c_ab_op(kc) == 15 && kc.r18 == 8) { return e * 2; }
      }
    }
  }
  return e;
}

fn eff_retreat_cost(p: u32, turn: i32, disc: i32) -> i32 {
  let act = g.board[p][0];
  if (act.occ == 0) { return 99; }
  let foe = 1u - p;
  let ac = wg_cards[act.ci];
  if (s_stage(act) == 2 && s_has_tool(act, 9)) { return 0; }
  if (ab_active(p, 0u, turn) && c_ab_op(ac) == 15 && (ac.r18 & 255) == 7 && ((ac.r18 >> 8u) & 255) == 0) { return 0; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(p, k, turn)) {
      let kc = wg_cards[g.board[p][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 7) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 2) { return 0; }
        if (sub == 5 && c_name_hash(ac) == c_ab_aux(kc)) { return 0; }
      }
    }
  }
  var r = c_retreat(ac) + act.retreat_tax;
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(foe, k, turn)) {
      let kc = wg_cards[g.board[foe][k].ci];
      if (c_ab_op(kc) == 15 && kc.r18 == 6) { r = r + 1; }
    }
  }
  for (var k = 1u; k < 4u; k = k + 1u) {
    if (ab_active(p, k, turn)) {
      let kc = wg_cards[g.board[p][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 7) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 1 && s_stage(act) == 0) { r = r - 1; }
        else if (sub == 3 && c_has_type(ac, 6)) { r = r - 1; }
      }
    }
  }
  if (ab_active(p, 0u, turn) && c_ab_op(ac) == 15 && (ac.r18 & 255) == 7 && ((ac.r18 >> 8u) & 255) == 4) { r = r - 2; }
  if (s_stage(act) == 0 && s_has_tool(act, 7)) { r = r - 1; }
  if (c_has_type(ac, 2) && s_has_tool(act, 8)) { r = r - 1; }
  if (g.stadium == 4 && c_has_type(ac, 4)) { r = r - 2; }
  r = r - disc;
  return max(0, r);
}

fn best_bench_promote(p: u32) -> u32 {
  var best = 4u;
  var best_sc = -99999;
  for (var s = 1u; s < 4u; s = s + 1u) {
    if (g.board[p][s].occ == 1) {
      let sl = g.board[p][s];
      let sc = sl.hp + sl.energy * 35 + (wg_cards[sl.ci].power_q >> 4u);
      if (sc > best_sc) { best_sc = sc; best = s; }
    }
  }
  return best;
}

fn draw_one(p: u32) -> bool {
  if (g.lib_len[p] > 0u && g.hand_len[p] < 12u) {
    g.lib_len[p] = g.lib_len[p] - 1u;
    let ci = g.libs[p][g.lib_len[p]];
    g.hands[p][g.hand_len[p]] = ci;
    g.hand_len[p] = g.hand_len[p] + 1u;
    return true;
  }
  return false;
}

fn shuffle_hand_into_deck(p: u32) {
  let hl = g.hand_len[p];
  for (var hi = 0u; hi < hl; hi = hi + 1u) {
    if (g.lib_len[p] < 20u) {
      g.libs[p][g.lib_len[p]] = g.hands[p][hi];
      g.lib_len[p] = g.lib_len[p] + 1u;
    }
  }
  g.hand_len[p] = 0u;
  let n = g.lib_len[p];
  if (n > 1u) {
    for (var ii = 0u; ii < n - 1u; ii = ii + 1u) {
      let i = n - 1u - ii;
      let j = rng_next() % (i + 1u);
      let tmp = g.libs[p][i];
      g.libs[p][i] = g.libs[p][j];
      g.libs[p][j] = tmp;
    }
  }
}

fn search_deck_to_hand(p: u32, mode: i32, h1: i32, h2: i32) -> bool {
  if (g.hand_len[p] >= 12u || g.lib_len[p] == 0u) { return false; }
  var match_pos = 20u;
  var matches = 0u;
  let n = g.lib_len[p];
  for (var i = 0u; i < n; i = i + 1u) {
    let c = wg_cards[g.libs[p][i]];
    var ok = false;
    switch (mode) {
      case 0: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c); }
      case 1: { ok = c.r0 == 1 && !c_is_fossil(c); }
      case 2: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c) && c.r5 <= 50; }
      case 3: { ok = c.r0 == 1 && c_stage(c) == 2; }
      case 4: { ok = c.r0 == 1 && c_is_mega(c); }
      case 5: { ok = c.r0 == 0 && c_is_item(c); }
      case 6: { ok = c.r0 == 0 && c_is_tool(c); }
      case 7: { ok = c.r0 == 0 && c_is_stadium(c); }
      case 8: { ok = c.r0 == 0 && c_is_supporter(c); }
      case 9: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c) && c_has_type(c, 0); }
      case 10: { ok = c_matches_hashes(c, h1, h2); }
      case 11: { ok = c.r0 == 1 && c_is_team_rocket(c); }
      case 12: { ok = c.r0 == 1 && !c_is_fossil(c) && c_has_type(c, 4); }
      default: { ok = false; }
    }
    if (ok) {
      matches = matches + 1u;
      if ((rng_next() % matches) == 0u) { match_pos = i; }
    }
  }
  if (match_pos < n) {
    let found = g.libs[p][match_pos];
    g.lib_len[p] = n - 1u;
    g.libs[p][match_pos] = g.libs[p][n - 1u];
    g.hands[p][g.hand_len[p]] = found;
    g.hand_len[p] = g.hand_len[p] + 1u;
    return true;
  }
  return false;
}

fn has_status_immunity(p: u32, s: u32, turn: i32) -> bool {
  let sl = g.board[p][s];
  if (sl.occ == 0) { return true; }
  let c = wg_cards[sl.ci];
  if (s_has_tool(sl, 12) && c_has_type(c, 7)) { return true; }
  if (s_has_tool(sl, 15)) { return true; }
  if (ab_active(p, s, turn)) {
    if (c_ab_op(c) == 17 && c.r18 == 1) { return true; }
    if (c_ab_op(c) == 11 && ((c.r18 >> 8u) & 255) == 7) { return true; }
  }
  if (sl.energy > 0) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (ab_active(p, k, turn)) {
        let kc = wg_cards[g.board[p][k].ci];
        if (c_ab_op(kc) == 17 && kc.r18 == 2) { return true; }
      }
    }
  }
  return false;
}

fn apply_status(p: u32, s: u32, mask: u32, turn: i32, by_atk: bool) {
  if (g.board[p][s].occ == 0) { return; }
  if (has_status_immunity(p, s, turn)) { return; }
  if (by_atk && (g.board[p][s].status & ST_INVULN) != 0u) { return; }
  var cur_st = g.board[p][s].status;
  if ((mask & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0u) {
    cur_st = cur_st & (~(ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE));
  }
  if ((mask & ST_TOXIC40) != 0u) { cur_st = cur_st & (~(ST_POISON | ST_TOXIC20)); }
  else if ((mask & ST_TOXIC20) != 0u && (cur_st & ST_TOXIC40) == 0u) { cur_st = cur_st & (~ST_POISON); }
  else if ((mask & ST_POISON) != 0u && (cur_st & (ST_TOXIC20 | ST_TOXIC40)) != 0u) { return; }
  g.board[p][s].status = cur_st | mask;
}

fn bench_dmg_blocked(p: u32, s: u32, by_atk: bool, turn: i32) -> bool {
  if (s == 0u) { return false; }
  if (s_has_tool(g.board[p][s], 14)) { return true; }
  if (by_atk && ab_active(p, s, turn)) {
    let c = wg_cards[g.board[p][s].ci];
    if (c_ab_op(c) == 11 && ((c.r18 >> 8u) & 255) == 6) { return true; }
  }
  return false;
}

fn record_discard_card(p: u32, ci: u32) {
  let c = wg_cards[ci];
  if (c.r0 == 1 && !c_is_fossil(c)) {
    g.disc_poke[p] = g.disc_poke[p] + 1;
    if (c_has_type(c, 4)) { g.disc_poke_p[p] = g.disc_poke_p[p] + 1; }
    if (c_stage(c) == 0) {
      g.disc_basic_any[p] = g.disc_basic_any[p] + 1;
      if (c_has_type(c, 2)) { g.disc_basic_w[p] = g.disc_basic_w[p] + 1; }
    }
    if (c_name_hash(c) == H_VOLBEAT) { g.disc_volbeat[p] = 1; }
  } else if (c.r0 == 0) {
    if (c_is_item(c)) {
      g.disc_item[p] = g.disc_item[p] + 1;
      if (c_trn_kind(c) == 6 && c_trn_sub(c) == 2 && c.r20 == 0) { g.disc_quick_grow[p] = 1; }
    } else if (c_is_supporter(c)) {
      g.disc_supp[p] = g.disc_supp[p] + 1;
    } else if (c_is_tool(c)) {
      g.disc_tool[p] = g.disc_tool[p] + 1;
    }
  }
}


fn ko_active_passive(victim: u32, winner: u32) -> bool {
  if (g.board[victim][0].occ == 0 || g.board[victim][0].hp > 0) { return false; }
  let v_slot = g.board[victim][0];
  let v_card = wg_cards[v_slot.ci];
  var zero_pts = false;
  if (ab_active(victim, 0u, 0) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 6) {
    if (flip_coin_plain()) { zero_pts = true; }
  }
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }
  let gained = select(c_prize(v_card), 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (!c_is_fossil(v_card)) { record_discard_card(victim, v_slot.ci); }
  g.board[victim][0].occ = 0;
  let prom = best_bench_promote(victim);
  if (prom < 4u) {
    let tmp = g.board[victim][0]; g.board[victim][0] = g.board[victim][prom]; g.board[victim][prom] = tmp;
    g.board[victim][0].status = g.board[victim][0].status & (~ST_HAS_ATTACKED);
  }
  return true;
}

fn handle_bench_ko(victim: u32, winner: u32, s: u32, by_atk: bool, turn: i32) -> bool {
  if (g.board[victim][s].occ == 0 || g.board[victim][s].hp > 0) { return false; }
  let v_slot = g.board[victim][s];
  let v_card = wg_cards[v_slot.ci];
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }
  var zero_pts = false;
  if (ab_active(victim, s, turn) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 6) {
    if (flip_coin_plain()) { zero_pts = true; }
  }
  let gained = select(c_prize(v_card), 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (by_atk) { g.ko_last_turn[victim] = 1; }
  if (by_atk && s_has_tool(v_slot, 27) && g.hand_len[victim] < 12u) {
    g.hands[victim][g.hand_len[victim]] = v_slot.ci;
    g.hand_len[victim] = g.hand_len[victim] + 1u;
  } else if (!c_is_fossil(v_card)) {
    record_discard_card(victim, v_slot.ci);
  }
  g.board[victim][s].occ = 0;
  return true;
}



@compute @workgroup_size(64)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  load_wg_cards(lid.x, gid.y, false);
  workgroupBarrier();

  let slot = gid.y * (params.wg_x * 64u) + gid.x;
  let k = params.wave_start + gid.x;
  var valid = false;
  var first = 0u;
  var seed = 1u;

  if (params.mode == 0u) {
    let opp_idx = gid.y / params.n_cands;
    let pairs_per_opp = max(2u, params.games_per_opp / params.n_cands);
    let half_pairs = max(1u, pairs_per_opp / 2u);
    let pair_idx = params.start_pair + k;
    valid = opp_idx < params.n_opps && gid.x < params.wave_count && k < params.pair_count && pair_idx < pairs_per_opp;
    first = select(1u, 0u, pair_idx < half_pairs);
    seed = (params.seed_base ^ ((opp_idx + 1u) * 1000003u)) ^ ((pair_idx % half_pairs) * 2654435761u);
  } else if (params.mode == 1u) {
    let idx = params.start_pair + k;
    let half = params.total_per_opp / 2u;
    valid = gid.x < params.wave_count && k < params.pair_count && idx < params.total_per_opp;
    first = select(1u, 0u, idx < half);
    seed = (params.seed_base ^ 1000003u) ^ (idx * 2654435761u);
  } else {
    let ci = gid.y / params.n_opps;
    let opp_idx = gid.y % params.n_opps;
    let gpo = params.games_per_opp;
    let half = max(1u, gpo / 2u);
    valid = ci < params.n_cands && opp_idx < params.n_opps && gid.x < params.wave_count && k < gpo;
    first = select(1u, 0u, k < half);
    seed = (params.seed_base ^ ((opp_idx + 1u) * 1000003u)) ^ ((k % half) * 2654435761u);
  }

  if (!valid) {
    states_buf[slot].done = 3u;
    return;
  }

  g.rng = rng_init(seed);
  for (var i = 0u; i < 20u; i = i + 1u) { g.libs[0][i] = i; g.libs[1][i] = 20u + i; }
  g.lib_len = array<u32, 2>(20u, 20u);
  g.hand_len = array<u32, 2>(0u, 0u);
  for (var p = 0u; p < 2u; p = p + 1u) {
    for (var s = 0u; s < 4u; s = s + 1u) { g.board[p][s] = empty_slot(); }
  }
  g.points = array<i32, 2>(0, 0);
  g.pts_last_turn = array<i32, 2>(0, 0);
  g.ko_count = array<i32, 2>(0, 0);
  g.ko_last_turn = array<i32, 2>(0, 0);
  g.item_lock = array<i32, 2>(0, 0);
  g.supp_lock = array<i32, 2>(0, 0);
  g.evo_lock = array<i32, 2>(0, 0);
  g.team_shield = array<i32, 2>(0, 0);
  g.team_shield_type = array<i32, 2>(255, 255);
  g.next_team_boost = array<i32, 2>(0, 0);
  g.sweets_used_last = array<i32, 2>(0, 0);
  g.sweets_total = array<i32, 2>(0, 0);
  g.energy_discarded = array<i32, 2>(0, 0);
  g.disc_poke = array<i32, 2>(0, 0);
  g.disc_poke_p = array<i32, 2>(0, 0);
  g.disc_item = array<i32, 2>(0, 0);
  g.disc_supp = array<i32, 2>(0, 0);
  g.disc_tool = array<i32, 2>(0, 0);
  g.disc_basic_w = array<i32, 2>(0, 0);
  g.disc_basic_any = array<i32, 2>(0, 0);
  g.disc_quick_grow = array<i32, 2>(0, 0);
  g.disc_volbeat = array<i32, 2>(0, 0);
  g.delayed_slot = array<u32, 2>(4u, 4u);
  g.delayed_dmg = array<i32, 2>(0, 0);
  g.stadium = 0;
  g.cur = first;
  g.turn = 1u;
  g.done = 0u;
  g.outcome = 2u;
  g.end_turn = 30u;
  g.pending_atk = -1;
  g.ab_mask = 0u;
  // Opening setup (non-fossil Basic guaranteed in opening 5)
  for (var p = 0u; p < 2u; p = p + 1u) {
    for (var ii = 0u; ii < 19u; ii = ii + 1u) {
      let i = 19u - ii;
      let j = rng_next() % (i + 1u);
      let tmp = g.libs[p][i]; g.libs[p][i] = g.libs[p][j]; g.libs[p][j] = tmp;
    }
    var bp = 20u;
    for (var ii = 0u; ii < 20u; ii = ii + 1u) {
      let i = 19u - ii;
      let c = wg_cards[g.libs[p][i]];
      if (c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c)) { bp = i; break; }
    }
    if (bp < 15u) { let t = g.libs[p][19u]; g.libs[p][19u] = g.libs[p][bp]; g.libs[p][bp] = t; }
    for (var i = 0u; i < 5u; i = i + 1u) { draw_one(p); }
    var pa = false;
    var idx = 0u;
    loop {
      if (idx >= g.hand_len[p]) { break; }
      let ci = g.hands[p][idx];
      let c = wg_cards[ci];
      if (c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c)) {
        if (!pa) {
          g.board[p][0] = make_slot(ci, c.r5, 0);
          pa = true;
          g.hand_len[p] = g.hand_len[p] - 1u;
          g.hands[p][idx] = g.hands[p][g.hand_len[p]];
          continue;
        } else {
          var pb = false;
          for (var s = 1u; s < 4u; s = s + 1u) {
            if (g.board[p][s].occ == 0) { g.board[p][s] = make_slot(ci, c.r5, 0); pb = true; break; }
          }
          if (pb) {
            g.hand_len[p] = g.hand_len[p] - 1u;
            g.hands[p][idx] = g.hands[p][g.hand_len[p]];
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
        if (kc.r0 == 1 && !c_is_fossil(kc)) { fbi = p * 20u + k; break; }
      }
      let fb = wg_cards[fbi];
      g.board[p][0] = make_slot(fbi, max(60, fb.r5), 0);
    }
  }


  states_buf[slot] = g;
}
`;

const WGSL_MAIN = /* wgsl */ `
const FEATURES: u32 = 22u;
const CARD_STRIDE: u32 = 28u;
const MAX_ENEMIES: u32 = 10u;

const H_ARCEUS: i32 = 1861;
const H_ARCEUS_EX: i32 = 7482;
const H_LATIAS: i32 = 49426;
const H_REGIROCK: i32 = 28242;
const H_REGICE: i32 = 49745;
const H_REGISTEEL: i32 = 4900;
const H_UXIE: i32 = 56213;
const H_AZELF: i32 = 51274;
const H_TANDEMAUS: i32 = 30786;
const H_MAUSHOLD: i32 = 61523;
const H_WISHIWASHI: i32 = 39722;
const H_WISHIWASHI_EX: i32 = 30145;
const H_POOCHYENA: i32 = 39334;
const H_SWEET_HONEY: i32 = 64227;
const H_RABOOT: i32 = 29145;
const H_UNOWN: i32 = 30635;
const H_PIKACHU_EX: i32 = 10636;
const H_VOLBEAT: i32 = 46637;

const AF_IGNORE_WEAKNESS: i32 = 1;
const AF_IGNORE_EFFECTS: i32 = 2;
const AF_NEED_SWITCHED_IN: i32 = 4;
const AF_DISCARD_HAND_1: i32 = 8;
const AF_DISCARD_HAND_2: i32 = 16;
const AF_REQUIRE_HP_OVER_60: i32 = 32;
const AF_REQUIRE_LAKE_TRIO: i32 = 64;
const AF_COST_1_IF_DAMAGED: i32 = 128;
const AF_COST_1_IF_DECK_EMPTY: i32 = 256;
const AF_FLIP_2_BOTH_TAILS_FAIL: i32 = 512;
const AF_FLIP_3_ALL_TAILS_FAIL: i32 = 1024;
const AF_FIRST_ATTACK_ONLY_EFF: i32 = 2048;
const AF_ONLY_IF_KO_RECOIL: i32 = 4096;
const AF_ONLY_IF_STADIUM_EFF: i32 = 8192;
const AF_ONLY_IF_KO_LAST_TURN_EFF: i32 = 16384;
const AF_ONLY_IF_EVOLVED_THIS_TURN_EFF: i32 = 32768;

const ST_POISON: u32 = 1u;
const ST_TOXIC20: u32 = 2u;
const ST_BURN: u32 = 4u;
const ST_SLEEP: u32 = 8u;
const ST_PARALYZE: u32 = 16u;
const ST_CONFUSE: u32 = 32u;
const ST_TOXIC40: u32 = 64u;
const ST_DEEP_SLEEP: u32 = 128u;
const ST_SPECIAL_MASK: u32 = 255u;
const ST_CANT_RETREAT: u32 = 256u;
const ST_CANT_ATK_SELF: u32 = 512u;
const ST_CANT_ATK_OPP: u32 = 1024u;
const ST_CANT_USE_A1: u32 = 2048u;
const ST_CANT_USE_A2: u32 = 4096u;
const ST_OPP_MISS_FLIP: u32 = 8192u;
const ST_PERM_MISS_FLIP: u32 = 16384u;
const ST_INVULN: u32 = 32768u;
const ST_DISGUISE_USED: u32 = 65536u;
const ST_HAS_ATTACKED: u32 = 131072u;
const ST_SWITCHED_IN: u32 = 262144u;
const ST_NO_WEAKNESS: u32 = 524288u;
const ST_NO_ABILITY: u32 = 1048576u;
const ST_ATTACH_SLEEP: u32 = 2097152u;
const ST_NO_ENERGY_ATTACH: u32 = 4194304u;
const ST_IMMUNE_BASIC: u32 = 8388608u;
const ST_IMMUNE_LE40: u32 = 16777216u;
const ST_SURVIVE_10: u32 = 33554432u;
const ST_RETREAT_TRAP: u32 = 67108864u;
const ST_DAMAGED_LAST: u32 = 134217728u;
const ST_LEAVE_ACTIVE_CLEAR: u32 = 255u | 256u | 512u | 1024u | 2048u | 4096u | 8192u | 16384u | 524288u | 1048576u | 2097152u | 4194304u | 8388608u | 16777216u | 67108864u;


struct Params {
  mode: u32,
  n_opps: u32,
  n_cands: u32,
  games_per_opp: u32,
  start_pair: u32,
  pair_count: u32,
  seed_base: u32,
  total_per_opp: u32,
  wave_start: u32,
  wave_count: u32,
  wg_x: u32,
  pad0: u32,
};

struct Card {
  r0: i32, r1: i32, r2: i32, r3: i32, r4: i32, r5: i32, r6: i32,
  r7: i32, r8: i32, r9: i32, r10: i32, r11: i32,
  r12: i32, r13: i32, r14: i32, r15: i32, r16: i32,
  r17: i32, r18: i32, r19: i32, r20: i32, r21: i32, r22: i32,
  power_q: i32,
  bonus_q: i32,
};

struct Slot {
  occ: i32,
  ci: u32,
  stage_ov: i32,
  hp: i32,
  max_hp: i32,
  energy: i32,
  tool: i32,
  tool2: i32,
  status: u32,
  shield: i32,
  shield_ex: i32,
  counter: i32,
  weaken: i32,
  cost_tax: i32,
  retreat_tax: i32,
  next_atk_mod: i32,
  stack_boost: i32,
  turn_placed: i32,
};


struct GameState {
  board: array<array<Slot, 4>, 2>,
  libs: array<array<u32, 20>, 2>,
  hands: array<array<u32, 12>, 2>,
  lib_len: array<u32, 2>,
  hand_len: array<u32, 2>,
  points: array<i32, 2>,
  pts_last_turn: array<i32, 2>,
  ko_count: array<i32, 2>,
  ko_last_turn: array<i32, 2>,
  item_lock: array<i32, 2>,
  supp_lock: array<i32, 2>,
  evo_lock: array<i32, 2>,
  team_shield: array<i32, 2>,
  team_shield_type: array<i32, 2>,
  next_team_boost: array<i32, 2>,
  sweets_used_last: array<i32, 2>,
  sweets_total: array<i32, 2>,
  energy_discarded: array<i32, 2>,
  disc_poke: array<i32, 2>,
  disc_poke_p: array<i32, 2>,
  disc_item: array<i32, 2>,
  disc_supp: array<i32, 2>,
  disc_tool: array<i32, 2>,
  disc_basic_w: array<i32, 2>,
  disc_basic_any: array<i32, 2>,
  disc_quick_grow: array<i32, 2>,
  disc_volbeat: array<i32, 2>,
  delayed_slot: array<u32, 2>,
  delayed_dmg: array<i32, 2>,
  rng: u32,
  stadium: i32,
  cur: u32,
  turn: u32,
  done: u32,
  outcome: u32,
  end_turn: u32,
  pending_atk: i32,
  supporter_used: u32,
  guar_heads: u32,
  active_ex_blocked: u32,
  heal_blocked: u32,
  sweets_this_turn: i32,
  had_cant_atk_self: u32,
  had_cant_a1: u32,
  had_cant_a2: u32,
  cur_team_boost: i32,
  dmg_boost: i32,
  dmg_boost_ex: i32,
  named_boost: i32,
  named_h1: i32,
  named_h2: i32,
  eevee_boost: i32,
  iris_active: u32,
  iris_h1: i32,
  drayden_bonus: i32,
  ab_mask: u32,
  pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> decks_buf: array<i32>;
@group(0) @binding(2) var<storage, read> weights_buf: array<i32>;
@group(0) @binding(3) var<storage, read_write> out_u32: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> out_sample: array<u32>;
@group(0) @binding(5) var<storage, read> cand_cards_buf: array<i32>;
@group(0) @binding(6) var<storage, read_write> states_buf: array<GameState>;

var<workgroup> wg_cards: array<Card, 41>;
var<workgroup> wg_w0: array<i32, 22>;
var<workgroup> wg_w1: array<i32, 22>;
var<private> g: GameState;
var<private> g_heal_blk: bool;

// --- Bitfield extraction helpers on Card ---
fn c_stage(c: Card) -> i32 { return c.r1 & 255; }
fn c_evo_group(c: Card) -> i32 { return i32((u32(c.r1) >> 8u) & 65535u); }
fn c_meta_hi(c: Card) -> i32 { return i32((u32(c.r1) >> 24u) & 255u); }
fn c_is_supporter(c: Card) -> bool { return (c_meta_hi(c) & 1) != 0; }
fn c_is_item(c: Card) -> bool { return (c_meta_hi(c) & 2) != 0; }
fn c_is_fossil(c: Card) -> bool { return (c_meta_hi(c) & 4) != 0; }
fn c_is_tool(c: Card) -> bool { return (c_meta_hi(c) & 8) != 0; }
fn c_is_stadium(c: Card) -> bool { return (c_meta_hi(c) & 16) != 0; }
fn c_is_mega(c: Card) -> bool { return (c_meta_hi(c) & 32) != 0; }
fn c_prize(c: Card) -> i32 { return max(1, i32((u32(c.r6) >> 8u) & 255u)); }
fn c_is_ex(c: Card) -> bool { return (c_meta_hi(c) & 64) != 0 || c_prize(c) >= 2; }
fn c_is_ub(c: Card) -> bool { return (c_meta_hi(c) & 128) != 0; }
fn c_tag_bits(c: Card) -> i32 { return i32(u32(c.r2) & 255u); }
fn c_name_hash(c: Card) -> i32 { return i32((u32(c.r2) >> 8u) & 65535u); }
fn c_type2(c: Card) -> i32 { return i32((u32(c.r2) >> 24u) & 255u); }
fn c_is_ancient(c: Card) -> bool { return (c_tag_bits(c) & 1) != 0; }
fn c_is_future(c: Card) -> bool { return (c_tag_bits(c) & 2) != 0; }
fn c_is_team_rocket(c: Card) -> bool { return (c_tag_bits(c) & 4) != 0; }
fn c_has_sweets(c: Card) -> bool { return (c_tag_bits(c) & 8) != 0; }
fn c_has_puppy(c: Card) -> bool { return (c_tag_bits(c) & 16) != 0; }
fn c_has_psychic(c: Card) -> bool { return (c_tag_bits(c) & 32) != 0; }
fn c_has_draco(c: Card) -> bool { return (c_tag_bits(c) & 64) != 0; }
fn c_is_eevee_evo(c: Card) -> bool { return (c_tag_bits(c) & 128) != 0; }
fn c_has_type(c: Card, tc: i32) -> bool { return c.r3 == tc || c_type2(c) == tc; }
fn c_retreat(c: Card) -> i32 { return c.r6 & 255; }
fn c_evfrom_hash(c: Card) -> i32 { return i32((u32(c.r6) >> 16u) & 65535u); }
fn c_a1_cost(c: Card) -> i32 { return c.r7 & 255; }
fn c_a1_flags(c: Card) -> i32 { return i32((u32(c.r7) >> 8u) & 65535u); }
fn c_a1_op1(c: Card) -> i32 { return c.r9 & 255; }
fn c_a1_op2(c: Card) -> i32 { return i32((u32(c.r9) >> 8u) & 255u); }
fn c_a1_aux(c: Card) -> i32 { return i32((u32(c.r9) >> 16u) & 65535u); }
fn c_a2_cost(c: Card) -> i32 { return c.r12 & 255; }
fn c_a2_flags(c: Card) -> i32 { return i32((u32(c.r12) >> 8u) & 65535u); }
fn c_a2_op1(c: Card) -> i32 { return c.r14 & 255; }
fn c_a2_op2(c: Card) -> i32 { return i32((u32(c.r14) >> 8u) & 255u); }
fn c_a2_aux(c: Card) -> i32 { return i32((u32(c.r14) >> 16u) & 65535u); }
fn c_ab_op(c: Card) -> i32 { return c.r17 & 255; }
fn c_ab_cond(c: Card) -> i32 { return i32((u32(c.r17) >> 8u) & 255u); }
fn c_ab_aux(c: Card) -> i32 { return i32((u32(c.r17) >> 16u) & 65535u); }
fn c_trn_kind(c: Card) -> i32 { return c.r19 & 255; }
fn c_trn_sub(c: Card) -> i32 { return i32((u32(c.r19) >> 8u) & 255u); }
fn c_trn_cond(c: Card) -> i32 { return i32((u32(c.r19) >> 16u) & 255u); }
fn c_matches_hashes(c: Card, h1: i32, h2: i32) -> bool {
  let nh = c_name_hash(c);
  if (nh == 0) { return false; }
  let a = i32(u32(h1) & 65535u);
  let b = i32((u32(h1) >> 16u) & 65535u);
  let cc = i32(u32(h2) & 65535u);
  let d = i32((u32(h2) >> 16u) & 65535u);
  return (a != 0 && nh == a) || (b != 0 && nh == b) || (cc != 0 && nh == cc) || (d != 0 && nh == d);
}

fn s_has_tool(sl: Slot, t: i32) -> bool { return sl.tool == t || sl.tool2 == t; }
fn s_tool_cnt(sl: Slot) -> i32 { return select(0, 1, sl.tool != 0) + select(0, 1, sl.tool2 != 0); }
fn s_stage(sl: Slot) -> i32 { return select(sl.stage_ov, c_stage(wg_cards[sl.ci]), sl.stage_ov < 0); }
fn make_slot(ci: u32, hp: i32, turn_p: i32) -> Slot {
  return Slot(1, ci, -1, hp, hp, 0, 0, 0, 0u, 0, 0, 0, 0, 0, 0, 0, 0, turn_p);
}
fn empty_slot() -> Slot {
  return Slot(0, 0u, -1, 0, 0, 0, 0, 0, 0u, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

fn est_atk_power_v3(dmg: i32, op1: i32, val1: i32) -> i32 {
  var d = dmg;
  let b0 = val1 & 255;
  let b1 = i32((u32(val1) >> 8u) & 255u);
  let b2 = i32((u32(val1) >> 16u) & 255u);
  switch (op1) {
    case 3: { d = select(select(d / 2, 35, b0 == 4), d + b1 / 2, b0 == 3); }
    case 4: {
      if ((b2 & 32) != 0) { d = d + (b1 * 3) / 2; }
      else if ((b2 & 8) != 0) { d = b1 * 2; }
      else if ((b2 & 6) != 0) { d = (b1 * 3) / 2; }
      else { d = select((b1 * b0) / 2, b1, b0 == 99); }
    }
    case 5: {
      if (b0 == 97) { d = d + 45; }
      else if (b0 == 98) { d = d + b1 / 4; }
      else if (b0 == 99) { d = d + b1; }
      else if (b2 == 2 || b2 == 3) { d = d + b1 * 2; }
      else { d = d + (b1 * b0) / 2; }
    }
    case 6: {
      if (b0 == 26) { d = b1 * 3; }
      else if (b0 == 31 || b0 == 32) { d = d + 50; }
      else if (b0 == 33) { d = max(20, d - 30); }
      else if (b0 == 2 || b0 == 5) { d = d + b1 * 4; }
      else { d = d + b1 * 2; }
    }
    case 7: {
      if (b0 == 3) { d = max(20, d - b1 / 3); }
      else { d = d + b1 / 2; }
    }
    case 8: {
      if (b0 == 2 || b0 == 3 || b0 == 4) { d = b1; }
      else if (b0 == 6) { d = b1 * 3; }
      else if (b0 == 8) { d = b1 * select(max(1, b2), 3, b2 == 99); }
      else if (b0 == 10) { d = (b1 * max(1, b2)) / 2; }
      else if (b0 == 11 || b0 == 14) { d = b1 * 2; }
      else if (b0 == 12) { d = select(b1, 140, b2 == 1); }
      else { d = d + b1 / 2; }
    }
    case 19: { if (b0 == 8) { d = d + b1; } }
    case 20: { d = select(select(60, 80, b0 == 6), 150, b0 == 1); }
    default: {}
  }
  return d;
}

fn load_card_vram(deck_slot: u32, idx: u32) -> Card {
  let o = (deck_slot * 20u + idx) * CARD_STRIDE;
  var c: Card;
  c.r0 = decks_buf[o]; c.r1 = decks_buf[o + 1u]; c.r2 = decks_buf[o + 2u];
  c.r3 = decks_buf[o + 3u]; c.r4 = decks_buf[o + 4u]; c.r5 = decks_buf[o + 5u];
  c.r6 = decks_buf[o + 6u]; c.r7 = decks_buf[o + 7u]; c.r8 = decks_buf[o + 8u];
  c.r9 = decks_buf[o + 9u]; c.r10 = decks_buf[o + 10u]; c.r11 = decks_buf[o + 11u];
  c.r12 = decks_buf[o + 12u]; c.r13 = decks_buf[o + 13u]; c.r14 = decks_buf[o + 14u];
  c.r15 = decks_buf[o + 15u]; c.r16 = decks_buf[o + 16u]; c.r17 = decks_buf[o + 17u];
  c.r18 = decks_buf[o + 18u]; c.r19 = decks_buf[o + 19u]; c.r20 = decks_buf[o + 20u];
  c.r21 = decks_buf[o + 21u]; c.r22 = decks_buf[o + 22u];
  let p1 = select(0, est_atk_power_v3(c.r8, c_a1_op1(c), c.r10), c_a1_cost(c) != 255);
  let p2 = select(0, est_atk_power_v3(c.r13, c_a2_op1(c), c.r15), c_a2_cost(c) != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = decks_buf[o + 24u];
  return c;
}

fn make_sweet_honey_card() -> Card {
  var c: Card;
  c.r0 = 0; c.r1 = i32(2u << 24u); c.r2 = i32((u32(H_SWEET_HONEY) << 8u) | (255u << 24u));
  c.r3 = 9; c.r4 = 255; c.r5 = 0; c.r6 = 256;
  c.r7 = 255; c.r8 = 0; c.r9 = 0; c.r10 = 0; c.r11 = 0;
  c.r12 = 255; c.r13 = 0; c.r14 = 0; c.r15 = 0; c.r16 = 0;
  c.r17 = 0; c.r18 = 0; c.r19 = 2 | (9 << 8u); c.r20 = 20; c.r21 = 0; c.r22 = 0;
  c.power_q = 0; c.bonus_q = 0;
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

fn rng_next() -> u32 {
  var x = g.rng;
  x = x ^ (x << 13u);
  x = x ^ (x >> 17u);
  x = x ^ (x << 5u);
  g.rng = x;
  return x * 0x27d4eb2du;
}

fn flip_coin_g(gh: ptr<function, bool>) -> bool {
  if (*gh) { *gh = false; return true; }
  return (rng_next() & 1u) == 1u;
}

fn flip_coin_plain() -> bool {
  return (rng_next() & 1u) == 1u;
}

fn get_w(cur: u32, k: u32) -> i32 {
  if (cur == 0u) { return wg_w0[k]; }
  return wg_w1[k];
}

fn tool_hp_bonus(t: i32, c: Card) -> i32 {
  if (t == 1) { return 20; }
  if (t == 2) { return select(0, 30, c_has_type(c, 0)); }
  if (t == 3) { return select(0, 30, c_stage(c) == 1); }
  if (t == 4) { return select(0, 40, c_is_ancient(c)); }
  return 0;
}


fn load_cand_vram(ci: u32) -> Card {
  let o = ci * CARD_STRIDE;
  var c: Card;
  c.r0 = cand_cards_buf[o]; c.r1 = cand_cards_buf[o + 1u]; c.r2 = cand_cards_buf[o + 2u];
  c.r3 = cand_cards_buf[o + 3u]; c.r4 = cand_cards_buf[o + 4u]; c.r5 = cand_cards_buf[o + 5u];
  c.r6 = cand_cards_buf[o + 6u]; c.r7 = cand_cards_buf[o + 7u]; c.r8 = cand_cards_buf[o + 8u];
  c.r9 = cand_cards_buf[o + 9u]; c.r10 = cand_cards_buf[o + 10u]; c.r11 = cand_cards_buf[o + 11u];
  c.r12 = cand_cards_buf[o + 12u]; c.r13 = cand_cards_buf[o + 13u]; c.r14 = cand_cards_buf[o + 14u];
  c.r15 = cand_cards_buf[o + 15u]; c.r16 = cand_cards_buf[o + 16u]; c.r17 = cand_cards_buf[o + 17u];
  c.r18 = cand_cards_buf[o + 18u]; c.r19 = cand_cards_buf[o + 19u]; c.r20 = cand_cards_buf[o + 20u];
  c.r21 = cand_cards_buf[o + 21u]; c.r22 = cand_cards_buf[o + 22u];
  let p1 = select(0, est_atk_power_v3(c.r8, c_a1_op1(c), c.r10), c_a1_cost(c) != 255);
  let p2 = select(0, est_atk_power_v3(c.r13, c_a2_op1(c), c.r15), c_a2_cost(c) != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = cand_cards_buf[o + 24u];
  return c;
}

fn load_wg_cards(lid_x: u32, gid_y: u32, load_weights: bool) {
  if (params.mode == 0u) {
    let opp_idx = gid_y / params.n_cands;
    let cand_idx = gid_y % params.n_cands;
    if (opp_idx < params.n_opps) {
      if (lid_x < 20u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
      else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(opp_idx + 1u, lid_x - 20u); }
      else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
      if (load_weights && lid_x < 22u) {
        wg_w0[lid_x] = weights_buf[(MAX_ENEMIES + cand_idx) * FEATURES + lid_x];
        wg_w1[lid_x] = weights_buf[opp_idx * FEATURES + lid_x];
      }
    }
  } else if (params.mode == 1u) {
    if (lid_x < 20u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
    else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(1u, lid_x - 20u); }
    else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
    if (load_weights && lid_x < 22u) {
      wg_w0[lid_x] = weights_buf[MAX_ENEMIES * FEATURES + lid_x];
      wg_w1[lid_x] = weights_buf[lid_x];
    }
  } else {
    let ci = gid_y / params.n_opps;
    let opp_idx = gid_y % params.n_opps;
    if (ci < params.n_cands && opp_idx < params.n_opps) {
      if (lid_x < 19u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
      else if (lid_x == 19u) { wg_cards[19u] = load_cand_vram(ci); }
      else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(opp_idx + 1u, lid_x - 20u); }
      else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
      if (load_weights && lid_x < 22u) {
        wg_w0[lid_x] = weights_buf[MAX_ENEMIES * FEATURES + lid_x];
        wg_w1[lid_x] = weights_buf[opp_idx * FEATURES + lid_x];
      }
    }
  }
}

fn sync_ab(turn: i32) {
  var blk_b = false;
  var blk_h = false;
  let dz = u32(params.mode == 99u);
  for (var i = 0u; i < 8u + dz; i = i + 1u) {
    let sl = g.board[i >> 2u][i & 3u];
    if (sl.occ == 1 && (sl.status & ST_NO_ABILITY) == 0u) {
      let c = wg_cards[sl.ci];
      if (c_ab_op(c) == 17 && c.r18 == 7) { blk_b = true; }
    }
  }
  var m = 0u;
  for (var i = 0u; i < 8u + dz; i = i + 1u) {
    let p = i >> 2u; let s = i & 3u;
    let sl = g.board[p][s];
    if (sl.occ == 0 || (sl.status & ST_NO_ABILITY) != 0u) { continue; }
    let c = wg_cards[sl.ci];
    let aop = c_ab_op(c);
    if (aop == 0 || (s_stage(sl) == 0 && blk_b)) { continue; }
    if (aop == 17 && c.r18 == 6) { blk_h = true; }
    let cond = c_ab_cond(c);
    var ok = true;
    if (cond == 1) { ok = (s == 0u); }
    else if (cond == 2) { ok = (s > 0u); }
    else if (cond == 6) { ok = (s_tool_cnt(sl) > 0); }
    else if (cond == 7) { ok = (sl.hp >= sl.max_hp); }
    else if (cond == 8) { ok = (sl.hp <= 50); }
    else if (cond == 9) { ok = (g.stadium != 0); }
    else if (cond == 10) { ok = (turn <= 2); }
    else if (cond == 12) { ok = (sl.energy > 0); }
    else if (cond == 3 || cond == 4 || cond == 5 || cond == 11) {
      ok = false;
      let w1 = select(select(select(H_UNOWN, H_LATIAS, cond == 5), c_name_hash(c), cond == 4), H_ARCEUS, cond == 3);
      let w2 = select(w1, H_ARCEUS_EX, cond == 3);
      let excl = (cond == 4 || cond == 11);
      for (var k = 0u; k < 4u + dz; k = k + 1u) {
        if ((!excl || k != s) && g.board[p][k].occ == 1) {
          let nh = c_name_hash(wg_cards[g.board[p][k].ci]);
          if (nh == w1 || nh == w2) { ok = true; break; }
        }
      }
    }
    if (ok) { m = m | (1u << i); }
  }
  g.ab_mask = m;
  g_heal_blk = blk_h;
}

fn healing_blocked() -> bool { return g_heal_blk; }
fn ab_active(p: u32, s: u32, turn: i32) -> bool { return ((g.ab_mask >> (p * 4u + s)) & 1u) != 0u; }

fn count_bench(p: u32) -> i32 {
  var n = 0;
  for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[p][s].occ == 1) { n = n + 1; } }
  return n;
}

fn eff_energy(p: u32, s: u32, turn: i32) -> i32 {
  let e = g.board[p][s].energy;
  if (c_has_type(wg_cards[g.board[p][s].ci], 0)) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (ab_active(p, k, turn)) {
        let kc = wg_cards[g.board[p][k].ci];
        if (c_ab_op(kc) == 15 && kc.r18 == 8) { return e * 2; }
      }
    }
  }
  return e;
}

fn eff_retreat_cost(p: u32, turn: i32, disc: i32) -> i32 {
  let act = g.board[p][0];
  if (act.occ == 0) { return 99; }
  let foe = 1u - p;
  let ac = wg_cards[act.ci];
  if (s_stage(act) == 2 && s_has_tool(act, 9)) { return 0; }
  if (ab_active(p, 0u, turn) && c_ab_op(ac) == 15 && (ac.r18 & 255) == 7 && ((ac.r18 >> 8u) & 255) == 0) { return 0; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(p, k, turn)) {
      let kc = wg_cards[g.board[p][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 7) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 2) { return 0; }
        if (sub == 5 && c_name_hash(ac) == c_ab_aux(kc)) { return 0; }
      }
    }
  }
  var r = c_retreat(ac) + act.retreat_tax;
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(foe, k, turn)) {
      let kc = wg_cards[g.board[foe][k].ci];
      if (c_ab_op(kc) == 15 && kc.r18 == 6) { r = r + 1; }
    }
  }
  for (var k = 1u; k < 4u; k = k + 1u) {
    if (ab_active(p, k, turn)) {
      let kc = wg_cards[g.board[p][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 7) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 1 && s_stage(act) == 0) { r = r - 1; }
        else if (sub == 3 && c_has_type(ac, 6)) { r = r - 1; }
      }
    }
  }
  if (ab_active(p, 0u, turn) && c_ab_op(ac) == 15 && (ac.r18 & 255) == 7 && ((ac.r18 >> 8u) & 255) == 4) { r = r - 2; }
  if (s_stage(act) == 0 && s_has_tool(act, 7)) { r = r - 1; }
  if (c_has_type(ac, 2) && s_has_tool(act, 8)) { r = r - 1; }
  if (g.stadium == 4 && c_has_type(ac, 4)) { r = r - 2; }
  r = r - disc;
  return max(0, r);
}

fn best_bench_promote(p: u32) -> u32 {
  var best = 4u;
  var best_sc = -99999;
  for (var s = 1u; s < 4u; s = s + 1u) {
    if (g.board[p][s].occ == 1) {
      let sl = g.board[p][s];
      let sc = sl.hp + sl.energy * 35 + (wg_cards[sl.ci].power_q >> 4u);
      if (sc > best_sc) { best_sc = sc; best = s; }
    }
  }
  return best;
}

fn draw_one(p: u32) -> bool {
  if (g.lib_len[p] > 0u && g.hand_len[p] < 12u) {
    g.lib_len[p] = g.lib_len[p] - 1u;
    let ci = g.libs[p][g.lib_len[p]];
    g.hands[p][g.hand_len[p]] = ci;
    g.hand_len[p] = g.hand_len[p] + 1u;
    return true;
  }
  return false;
}

fn shuffle_hand_into_deck(p: u32) {
  let hl = g.hand_len[p];
  for (var hi = 0u; hi < hl; hi = hi + 1u) {
    if (g.lib_len[p] < 20u) {
      g.libs[p][g.lib_len[p]] = g.hands[p][hi];
      g.lib_len[p] = g.lib_len[p] + 1u;
    }
  }
  g.hand_len[p] = 0u;
  let n = g.lib_len[p];
  if (n > 1u) {
    for (var ii = 0u; ii < n - 1u; ii = ii + 1u) {
      let i = n - 1u - ii;
      let j = rng_next() % (i + 1u);
      let tmp = g.libs[p][i];
      g.libs[p][i] = g.libs[p][j];
      g.libs[p][j] = tmp;
    }
  }
}

fn search_deck_to_hand(p: u32, mode: i32, h1: i32, h2: i32) -> bool {
  if (g.hand_len[p] >= 12u || g.lib_len[p] == 0u) { return false; }
  var match_pos = 20u;
  var matches = 0u;
  let n = g.lib_len[p];
  for (var i = 0u; i < n; i = i + 1u) {
    let c = wg_cards[g.libs[p][i]];
    var ok = false;
    switch (mode) {
      case 0: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c); }
      case 1: { ok = c.r0 == 1 && !c_is_fossil(c); }
      case 2: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c) && c.r5 <= 50; }
      case 3: { ok = c.r0 == 1 && c_stage(c) == 2; }
      case 4: { ok = c.r0 == 1 && c_is_mega(c); }
      case 5: { ok = c.r0 == 0 && c_is_item(c); }
      case 6: { ok = c.r0 == 0 && c_is_tool(c); }
      case 7: { ok = c.r0 == 0 && c_is_stadium(c); }
      case 8: { ok = c.r0 == 0 && c_is_supporter(c); }
      case 9: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c) && c_has_type(c, 0); }
      case 10: { ok = c_matches_hashes(c, h1, h2); }
      case 11: { ok = c.r0 == 1 && c_is_team_rocket(c); }
      case 12: { ok = c.r0 == 1 && !c_is_fossil(c) && c_has_type(c, 4); }
      default: { ok = false; }
    }
    if (ok) {
      matches = matches + 1u;
      if ((rng_next() % matches) == 0u) { match_pos = i; }
    }
  }
  if (match_pos < n) {
    let found = g.libs[p][match_pos];
    g.lib_len[p] = n - 1u;
    g.libs[p][match_pos] = g.libs[p][n - 1u];
    g.hands[p][g.hand_len[p]] = found;
    g.hand_len[p] = g.hand_len[p] + 1u;
    return true;
  }
  return false;
}

fn has_status_immunity(p: u32, s: u32, turn: i32) -> bool {
  let sl = g.board[p][s];
  if (sl.occ == 0) { return true; }
  let c = wg_cards[sl.ci];
  if (s_has_tool(sl, 12) && c_has_type(c, 7)) { return true; }
  if (s_has_tool(sl, 15)) { return true; }
  if (ab_active(p, s, turn)) {
    if (c_ab_op(c) == 17 && c.r18 == 1) { return true; }
    if (c_ab_op(c) == 11 && ((c.r18 >> 8u) & 255) == 7) { return true; }
  }
  if (sl.energy > 0) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (ab_active(p, k, turn)) {
        let kc = wg_cards[g.board[p][k].ci];
        if (c_ab_op(kc) == 17 && kc.r18 == 2) { return true; }
      }
    }
  }
  return false;
}

fn apply_status(p: u32, s: u32, mask: u32, turn: i32, by_atk: bool) {
  if (g.board[p][s].occ == 0) { return; }
  if (has_status_immunity(p, s, turn)) { return; }
  if (by_atk && (g.board[p][s].status & ST_INVULN) != 0u) { return; }
  var cur_st = g.board[p][s].status;
  if ((mask & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0u) {
    cur_st = cur_st & (~(ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE));
  }
  if ((mask & ST_TOXIC40) != 0u) { cur_st = cur_st & (~(ST_POISON | ST_TOXIC20)); }
  else if ((mask & ST_TOXIC20) != 0u && (cur_st & ST_TOXIC40) == 0u) { cur_st = cur_st & (~ST_POISON); }
  else if ((mask & ST_POISON) != 0u && (cur_st & (ST_TOXIC20 | ST_TOXIC40)) != 0u) { return; }
  g.board[p][s].status = cur_st | mask;
}

fn bench_dmg_blocked(p: u32, s: u32, by_atk: bool, turn: i32) -> bool {
  if (s == 0u) { return false; }
  if (s_has_tool(g.board[p][s], 14)) { return true; }
  if (by_atk && ab_active(p, s, turn)) {
    let c = wg_cards[g.board[p][s].ci];
    if (c_ab_op(c) == 11 && ((c.r18 >> 8u) & 255) == 6) { return true; }
  }
  return false;
}

fn record_discard_card(p: u32, ci: u32) {
  let c = wg_cards[ci];
  if (c.r0 == 1 && !c_is_fossil(c)) {
    g.disc_poke[p] = g.disc_poke[p] + 1;
    if (c_has_type(c, 4)) { g.disc_poke_p[p] = g.disc_poke_p[p] + 1; }
    if (c_stage(c) == 0) {
      g.disc_basic_any[p] = g.disc_basic_any[p] + 1;
      if (c_has_type(c, 2)) { g.disc_basic_w[p] = g.disc_basic_w[p] + 1; }
    }
    if (c_name_hash(c) == H_VOLBEAT) { g.disc_volbeat[p] = 1; }
  } else if (c.r0 == 0) {
    if (c_is_item(c)) {
      g.disc_item[p] = g.disc_item[p] + 1;
      if (c_trn_kind(c) == 6 && c_trn_sub(c) == 2 && c.r20 == 0) { g.disc_quick_grow[p] = 1; }
    } else if (c_is_supporter(c)) {
      g.disc_supp[p] = g.disc_supp[p] + 1;
    } else if (c_is_tool(c)) {
      g.disc_tool[p] = g.disc_tool[p] + 1;
    }
  }
}


fn ko_active_passive(victim: u32, winner: u32) -> bool {
  if (g.board[victim][0].occ == 0 || g.board[victim][0].hp > 0) { return false; }
  let v_slot = g.board[victim][0];
  let v_card = wg_cards[v_slot.ci];
  var zero_pts = false;
  if (ab_active(victim, 0u, 0) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 6) {
    if (flip_coin_plain()) { zero_pts = true; }
  }
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }
  let gained = select(c_prize(v_card), 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (!c_is_fossil(v_card)) { record_discard_card(victim, v_slot.ci); }
  g.board[victim][0].occ = 0;
  let prom = best_bench_promote(victim);
  if (prom < 4u) {
    let tmp = g.board[victim][0]; g.board[victim][0] = g.board[victim][prom]; g.board[victim][prom] = tmp;
    g.board[victim][0].status = g.board[victim][0].status & (~ST_HAS_ATTACKED);
  }
  return true;
}

fn handle_bench_ko(victim: u32, winner: u32, s: u32, by_atk: bool, turn: i32) -> bool {
  if (g.board[victim][s].occ == 0 || g.board[victim][s].hp > 0) { return false; }
  let v_slot = g.board[victim][s];
  let v_card = wg_cards[v_slot.ci];
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }
  var zero_pts = false;
  if (ab_active(victim, s, turn) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 6) {
    if (flip_coin_plain()) { zero_pts = true; }
  }
  let gained = select(c_prize(v_card), 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (by_atk) { g.ko_last_turn[victim] = 1; }
  if (by_atk && s_has_tool(v_slot, 27) && g.hand_len[victim] < 12u) {
    g.hands[victim][g.hand_len[victim]] = v_slot.ci;
    g.hand_len[victim] = g.hand_len[victim] + 1u;
  } else if (!c_is_fossil(v_card)) {
    record_discard_card(victim, v_slot.ci);
  }
  g.board[victim][s].occ = 0;
  return true;
}



fn calc_passive_dmg_mods(
  cur: u32, foe: u32, atk_flags: i32, raw_d: i32,
  dmg_boost: i32, dmg_boost_ex: i32,
  named_boost: i32, named_h1: i32, named_h2: i32,
  eevee_boost: i32, cur_team_boost: i32, turn: i32
) -> i32 {
  let atk_sl = g.board[cur][0];
  let def_sl = g.board[foe][0];
  let atk_c = wg_cards[atk_sl.ci];
  let def_c = wg_cards[def_sl.ci];
  let ign_weak = (atk_flags & AF_IGNORE_WEAKNESS) != 0 || (def_sl.occ == 1 && (def_sl.status & ST_NO_WEAKNESS) != 0u);
  let ign_eff = (atk_flags & AF_IGNORE_EFFECTS) != 0;

  var add = dmg_boost + cur_team_boost + atk_sl.next_atk_mod + atk_sl.stack_boost;
  if (def_sl.occ == 1 && c_is_ex(def_c)) { add = add + dmg_boost_ex; }
  if (named_boost > 0 && c_matches_hashes(atk_c, named_h1, named_h2)) { add = add + named_boost; }
  if (eevee_boost > 0 && c_is_eevee_evo(atk_c)) { add = add + eevee_boost; }

  if (s_has_tool(atk_sl, 16) && c_is_future(atk_c)) { add = add + 20; }
  if (s_has_tool(atk_sl, 17) && c_name_hash(atk_c) == H_PIKACHU_EX) { add = add + 30; }
  if (s_has_tool(atk_sl, 18) && c_is_ub(atk_c)) { add = add + g.points[cur] * 10; }

  for (var k = 0u; k < 4u; k = k + 1u) {
    if (!ab_active(cur, k, turn)) { continue; }
    let ac = wg_cards[g.board[cur][k].ci];
    let op = c_ab_op(ac);
    if (op == 12) {
      let amt = ac.r18 & 255;
      let mode = (ac.r18 >> 8u) & 255;
      let tf = i32((u32(ac.r18) >> 16u) & 255u);
      if (mode == 0) {
        if (c_ab_cond(ac) == 13) {
          if (c_evfrom_hash(atk_c) == c_ab_aux(ac)) { add = add + amt; }
        } else if (tf == 255 || c_has_type(atk_c, tf)) {
          add = add + amt;
        }
      } else if (mode == 1 && k == 0u) {
        add = add + amt;
      } else if (mode == 3 && (c_has_type(atk_c, 4) || c_has_type(atk_c, 7))) {
        add = add + amt;
      }
    } else if (k == 0u && op == 11 && ((ac.r18 >> 8u) & 255) == 8) {
      add = add + 20;
    }
  }

  if (g.stadium == 2 && s_stage(atk_sl) == 1) { add = add + 10; }
  if (g.stadium == 5 && c_has_type(atk_c, 5) && def_sl.occ == 1 && c_is_ex(def_c)) { add = add + 20; }

  let is_weak = !ign_weak && def_sl.occ == 1 && def_c.r4 != 255 && c_has_type(atk_c, def_c.r4);
  if (is_weak) {
    if (g.stadium == 6 && !c_is_mega(atk_c)) { add = add + max(0, raw_d + add); }
    else { add = add + 20; }
  }

  var red = atk_sl.weaken;
  if (def_sl.occ == 1 && !ign_eff) {
    red = red + def_sl.shield;
    if (c_is_ex(atk_c)) { red = red + def_sl.shield_ex; }
    if (g.team_shield[foe] > 0) {
      let tst = g.team_shield_type[foe];
      if (tst == 255 || (tst == 254 && c_is_ub(def_c)) || c_has_type(def_c, tst)) {
        red = red + g.team_shield[foe];
      }
    }
    if (s_has_tool(def_sl, 10) && s_stage(def_sl) == 0) { red = red + 20; }
    if (s_has_tool(def_sl, 11) && c_retreat(def_c) >= 3) { red = red + 20; }
    if (s_has_tool(def_sl, 12) && c_has_type(def_c, 7)) { red = red + 10; }
    if (s_has_tool(def_sl, 13) && c_has_type(def_c, 7)) { red = red + 50; }

    var metal_team_done = false;
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (!ab_active(foe, k, turn)) { continue; }
      let dc = wg_cards[g.board[foe][k].ci];
      if (c_ab_op(dc) == 11) {
        let amt = dc.r18 & 255;
        let mode = (dc.r18 >> 8u) & 255;
        let tf = i32((u32(dc.r18) >> 16u) & 255u);
        if ((mode == 0 || mode == 8) && k == 0u) { red = red + amt; }
        else if (mode == 1) {
          if (tf == 7) {
            if (c_has_type(def_c, 7) && !metal_team_done) { red = red + amt; metal_team_done = true; }
          } else if (tf == 255 || c_has_type(def_c, tf)) { red = red + amt; }
        } else if (mode == 2 && k == 0u) { red = red + amt; }
        else if (mode == 3 && k == 0u && (c_has_type(atk_c, 1) || c_has_type(atk_c, 2))) { red = red + amt; }
        else if (mode == 4 && k == 0u && c_has_type(atk_c, 5)) { red = red + amt; }
      }
    }
  }
  return add - red;
}


fn can_pay_attack(
  cur: u32, foe: u32, base_cost: i32, atk_flags: i32, barry_disc: i32, turn: i32
) -> bool {
  if (base_cost == 255) { return false; }
  let act = g.board[cur][0];
  let c = wg_cards[act.ci];
  if (ab_active(cur, 0u, turn) && c_ab_op(c) == 15 && c.r18 == 11) {
    var r1 = false; var r2 = false; var r3 = false;
    for (var s = 1u; s < 4u; s = s + 1u) {
      if (g.board[cur][s].occ == 1) {
        let nh = c_name_hash(wg_cards[g.board[cur][s].ci]);
        if (nh == H_REGIROCK) { r1 = true; }
        else if (nh == H_REGICE) { r2 = true; }
        else if (nh == H_REGISTEEL) { r3 = true; }
      }
    }
    if (!(r1 && r2 && r3)) { return false; }
  }
  if ((atk_flags & AF_NEED_SWITCHED_IN) != 0 && (act.status & ST_SWITCHED_IN) == 0u) { return false; }
  if ((atk_flags & AF_DISCARD_HAND_1) != 0 && g.hand_len[cur] < 1u) { return false; }
  if ((atk_flags & AF_DISCARD_HAND_2) != 0 && g.hand_len[cur] < 2u) { return false; }
  if ((atk_flags & AF_REQUIRE_HP_OVER_60) != 0 && act.hp <= 60) { return false; }
  if ((atk_flags & AF_REQUIRE_LAKE_TRIO) != 0) {
    var u = false; var a = false;
    for (var s = 1u; s < 4u; s = s + 1u) {
      if (g.board[cur][s].occ == 1) {
        let nh = c_name_hash(wg_cards[g.board[cur][s].ci]);
        if (nh == H_UXIE) { u = true; }
        if (nh == H_AZELF) { a = true; }
      }
    }
    if (!(u && a)) { return false; }
  }
  var need = base_cost;
  if ((atk_flags & AF_COST_1_IF_DAMAGED) != 0 && act.hp < act.max_hp) { need = 1; }
  if ((atk_flags & AF_COST_1_IF_DECK_EMPTY) != 0 && g.lib_len[cur] == 0u) { need = 1; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(cur, k, turn)) {
      let kc = wg_cards[g.board[cur][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 4) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 1 && c_is_future(c)) { need = need - 1; }
        else if (sub == 0 && k == 0u) { need = need - 1; }
      }
    }
  }
  need = need - barry_disc + act.cost_tax;
  if (g.board[foe][0].occ == 1 && ab_active(foe, 0u, turn)) {
    let fc = wg_cards[g.board[foe][0].ci];
    if (c_ab_op(fc) == 15 && fc.r18 == 5) { need = need + 1; }
  }
  need = max(0, need);
  return eff_energy(cur, 0u, turn) >= need;
}

fn eval_cond_op7(
  cond_id: i32, extra: i32, aux: i32,
  cur: u32, foe: u32, atk_cost: i32, sup_used: bool, turn: i32
) -> bool {
  let act = g.board[cur][0];
  let foe_s = g.board[foe][0];
  let fc = wg_cards[foe_s.ci];
  switch (cond_id) {
    case 0: { return eff_energy(cur, 0u, turn) >= atk_cost + extra; }
    case 1: { return foe_s.occ == 1 && foe_s.hp < foe_s.max_hp; }
    case 2, 3: { return act.hp < act.max_hp; }
    case 4: { return act.hp >= act.max_hp; }
    case 5: { return act.hp <= extra; }
    case 6: {
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].hp < g.board[cur][s].max_hp) { return true; } }
      return false;
    }
    case 7: { return foe_s.occ == 1 && (foe_s.status & ST_SPECIAL_MASK) != 0u; }
    case 8: { return foe_s.occ == 1 && (foe_s.status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0u; }
    case 9: { return foe_s.occ == 1 && (foe_s.status & ST_BURN) != 0u; }
    case 10: { return foe_s.occ == 1 && (foe_s.status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0u; }
    case 11: { return foe_s.occ == 1 && (foe_s.status & ST_CONFUSE) != 0u; }
    case 12: { return foe_s.occ == 1 && c_is_ex(fc); }
    case 13: { return foe_s.occ == 1 && s_stage(foe_s) == 0; }
    case 14: { return foe_s.occ == 1 && s_stage(foe_s) > 0; }
    case 15: { return foe_s.occ == 1 && c_ab_op(fc) != 0; }
    case 16: { return foe_s.occ == 1 && s_tool_cnt(foe_s) > 0; }
    case 17: { return s_tool_cnt(act) > 0; }
    case 18: { return g.ko_last_turn[cur] != 0; }
    case 19: { return sup_used; }
    case 20: { return foe_s.occ == 1 && foe_s.hp > act.hp; }
    case 21: { return foe_s.occ == 1 && foe_s.hp < act.hp; }
    case 22: { return (act.status & ST_SWITCHED_IN) != 0u; }
    case 23: { return s_stage(act) > 0 && act.turn_placed == turn; }
    case 24: { return (act.status & ST_HAS_ATTACKED) == 0u; }
    case 25: { return g.stadium != 0; }
    case 26: { return act.energy + select(0, foe_s.energy, foe_s.occ == 1) >= extra; }
    case 27: {
      var tot = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { tot = tot + g.board[cur][s].energy; } }
      return tot >= extra;
    }
    case 28: { return foe_s.occ == 1 && act.energy > foe_s.energy; }
    case 29: { return foe_s.occ == 1 && act.energy == foe_s.energy; }
    case 30: { return foe_s.occ == 1 && act.energy > 0 && foe_s.energy > 0 && wg_cards[act.ci].r3 == fc.r3; }
    case 31: {
      let hc = g.hand_len[cur]; let hf = g.hand_len[foe];
      if (extra == 0) { return hc == 1u || hc == 3u || hc == 5u; }
      if (extra == 1) { return hc == 2u || hc == 4u || hc == 6u; }
      if (extra == 2) { return hf == 2u || hf == 4u || hf == 6u; }
      return hc == hf;
    }
    case 32: {
      let t1 = extra & 15; let t2 = (extra >> 4u) & 15;
      if (t2 == 14) {
        for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && c_has_type(wg_cards[g.board[foe][s].ci], t1)) { return true; } }
        return false;
      }
      return foe_s.occ == 1 && (c_has_type(fc, t1) || (t2 < 10 && c_has_type(fc, t2)));
    }
    case 33: {
      if (extra == 0) {
        for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_name_hash(wg_cards[g.board[cur][s].ci]) == aux) { return true; } }
        return false;
      }
      if (extra == 1) {
        for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 2) { return true; } }
        return false;
      }
      if (extra == 2) { return foe_s.occ == 1 && c_name_hash(fc) == aux; }
      if (extra == 3) { return foe_s.occ == 1 && c_is_team_rocket(fc); }
      if (extra == 4) { return count_bench(cur) < count_bench(foe); }
      return false;
    }
    case 34: { return g.sweets_used_last[cur] != 0; }
    case 35: { return select(g.points[foe] == 1, g.points[cur] == 0, extra == 0); }
    case 36: {
      for (var s = 1u; s < 4u; s = s + 1u) {
        if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 0 && c_has_type(wg_cards[g.board[cur][s].ci], 0)) { return true; }
      }
      return false;
    }
    case 37: { return (act.status & ST_DAMAGED_LAST) != 0u; }
    case 39: { return select(g.disc_quick_grow[cur] != 0, g.disc_volbeat[cur] != 0, extra == 1); }
    case 40: { return select(act.energy >= extra, act.energy > 0, extra >= 10); }
    default: { return false; }
  }
}

fn eval_count_op6(
  sub: i32, extra: i32, aux: i32, cur: u32, foe: u32, turn: i32
) -> i32 {
  switch (sub) {
    case 0: { return count_bench(cur); }
    case 1: { return count_bench(foe); }
    case 2: { return count_bench(cur) + count_bench(foe); }
    case 3: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], extra)) { n = n + 1; } }
      return n;
    }
    case 4: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) > 0) { n = n + 1; } }
      return n;
    }
    case 5: { return eff_energy(cur, 0u, turn); }
    case 6: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { n = n + g.board[cur][s].energy; } }
      return n;
    }
    case 7: { return select(0, g.board[foe][0].energy, g.board[foe][0].occ == 1); }
    case 8: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1) { n = n + g.board[foe][s].energy; } }
      return n;
    }
    case 9: { return select(0, c_retreat(wg_cards[g.board[foe][0].ci]), g.board[foe][0].occ == 1); }
    case 10: { return g.points[cur]; }
    case 11: { return g.points[foe]; }
    case 12: { return g.ko_count[cur]; }
    case 13: { return g.pts_last_turn[foe]; }
    case 14: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { n = n + s_tool_cnt(g.board[cur][s]); } }
      return n;
    }
    case 15: { return i32(g.hand_len[cur]); }
    case 16: { return select(g.disc_poke[cur], g.disc_poke_p[cur], extra == 4); }
    case 17: { return g.disc_item[cur]; }
    case 18: { return g.disc_supp[cur]; }
    case 19: {
      var n = 0;
      for (var i = 0u; i < g.lib_len[foe]; i = i + 1u) { if (wg_cards[g.libs[foe][i]].r0 == 0) { n = n + 1; } }
      return n;
    }
    case 20: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && c_ab_op(wg_cards[g.board[foe][s].ci]) != 0) { n = n + 1; } }
      return n;
    }
    case 21: {
      if (g.board[foe][0].occ == 0) { return 0; }
      let st_m = g.board[foe][0].status;
      var n = 0;
      if ((st_m & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0u) { n = n + 1; }
      if ((st_m & ST_BURN) != 0u) { n = n + 1; }
      if ((st_m & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0u) { n = n + 1; }
      return n;
    }
    case 22: { return g.sweets_total[cur]; }
    case 23: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_puppy(wg_cards[g.board[cur][s].ci])) { n = n + 1; } }
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) { if (c_has_puppy(wg_cards[g.hands[cur][hi]])) { n = n + 1; } }
      return n;
    }
    case 24: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) {
        if (g.board[cur][s].occ == 1) {
          let nh = c_name_hash(wg_cards[g.board[cur][s].ci]);
          if (extra == 1) { if (nh == H_WISHIWASHI || nh == H_WISHIWASHI_EX) { n = n + 1; } }
          else if (nh == aux) { n = n + 1; }
        }
      }
      return n;
    }
    case 25: { return min(3, g.board[cur][0].energy); }
    case 26: { return g.board[cur][0].energy; }
    case 27: {
      var n = 0;
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) { if (c_is_tool(wg_cards[g.hands[cur][hi]])) { n = n + 1; } }
      return min(2, n);
    }
    case 28: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], 2)) { n = n + 1; } }
      return n;
    }
    case 29: {
      var n = 0;
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) { if (c_name_hash(wg_cards[g.hands[cur][hi]]) == H_SWEET_HONEY) { n = n + 1; } }
      return n;
    }
    case 30: {
      let top_n = u32(extra & 15);
      let filt = (extra >> 4u) & 15;
      let lim = min(top_n, g.lib_len[cur]);
      var n = 0;
      for (var k = 0u; k < lim; k = k + 1u) {
        let c = wg_cards[g.libs[cur][g.lib_len[cur] - 1u - k]];
        if (filt == 1) { if (c.r0 == 1 && c_is_team_rocket(c)) { n = n + 1; } }
        else if (c.r0 == 1 && c_retreat(c) >= 3) { n = n + 1; }
      }
      return n;
    }
    case 31: { return max(0, g.board[cur][0].max_hp - g.board[cur][0].hp); }
    case 32: { return max(0, g.board[cur][0].hp); }
    case 33: { return -max(0, g.board[cur][0].max_hp - g.board[cur][0].hp); }
    default: { return 0; }
  }
}

fn eval_live_dmg_v3(
  cur: u32, foe: u32, cost: i32, base_dmg: i32,
  op1: i32, val1: i32, aux: i32, sup_used: bool, turn: i32
) -> vec2<i32> {
  let b0 = val1 & 255;
  let b1 = i32((u32(val1) >> 8u) & 255u);
  let b2 = i32((u32(val1) >> 16u) & 255u);
  switch (op1) {
    case 3: {
      if (b0 == 3) { return vec2<i32>(base_dmg + b1 / 2, 0); }
      if (b0 == 4) { return vec2<i32>(35, 0); }
      return vec2<i32>(base_dmg / 2, 0);
    }
    case 4: {
      if ((b2 & 32) != 0) { return vec2<i32>(base_dmg + (b1 * 3) / 2, 0); }
      if ((b2 & 8) != 0) { return vec2<i32>((eff_energy(cur, 0u, turn) * b1) / 2, 0); }
      if ((b2 & 2) != 0) { return vec2<i32>(((1 + count_bench(cur)) * b1) / 2, 0); }
      if ((b2 & 4) != 0) {
        var n = 0;
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (g.board[cur][s].occ == 1) {
            let nh = c_name_hash(wg_cards[g.board[cur][s].ci]);
            if (nh == H_TANDEMAUS || nh == H_MAUSHOLD) { n = n + 1; }
          }
        }
        return vec2<i32>((n * b1) / 2, 0);
      }
      var n = select(b0, 2, b0 == 99);
      if ((b2 & 1) != 0 && s_has_tool(g.board[cur][0], 24)) { n = 4; }
      if ((b2 & 16) != 0) {
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (g.board[cur][s].occ == 1 && c_name_hash(wg_cards[g.board[cur][s].ci]) == H_RABOOT) { n = n + 3; }
        }
      }
      return vec2<i32>((b1 * n) / 2, 0);
    }
    case 5: {
      if (b0 == 97) { return vec2<i32>(base_dmg + 45, 0); }
      if (b0 == 98) { return vec2<i32>(base_dmg + b1 / 4, 0); }
      if (b0 == 99) { return vec2<i32>(base_dmg + b1, 0); }
      if (b2 == 2) { return vec2<i32>(base_dmg + (eff_energy(cur, 0u, turn) * b1) / 2, 0); }
      if (b2 == 3) { return vec2<i32>(base_dmg, 0); }
      return vec2<i32>(base_dmg + (b1 * b0) / 2, 0);
    }
    case 6: {
      let cnt = eval_count_op6(b0, b2, aux, cur, foe, turn);
      if (b0 == 33) { return vec2<i32>(max(0, base_dmg + cnt), 0); }
      return vec2<i32>(base_dmg + cnt * b1, 0);
    }
    case 7: {
      let ok = eval_cond_op7(b0, b2, aux, cur, foe, cost, sup_used, turn);
      if (b0 == 3) { return vec2<i32>(select(base_dmg, max(0, base_dmg - b1), ok), 0); }
      return vec2<i32>(base_dmg + select(0, b1, ok), 0);
    }
    case 8: {
      if (b0 == 2 || b0 == 3 || b0 == 4 || b0 == 6 || b0 == 8 || b0 == 10 || b0 == 11 || b0 == 12 || b0 == 14) {
        var est = b1;
        if (b0 == 8) { est = b1 * select(max(1, b2), eff_energy(cur, 0u, turn), b2 == 99); }
        else if (b0 == 11) {
          var me = 0;
          for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && g.board[foe][s].energy > me) { me = g.board[foe][s].energy; } }
          est = me * b1;
        } else if (b0 == 12) { est = select(b1, 140, b2 == 1); }
        else if (b0 == 14) { est = b1 * 2; }
        return vec2<i32>(est, 1);
      }
      return vec2<i32>(base_dmg, 0);
    }
    case 19: {
      if (b0 == 8) { return vec2<i32>(base_dmg + b1, 0); }
      return vec2<i32>(base_dmg, select(0, 1, base_dmg == 0));
    }
    case 20: {
      let fhp = select(100, g.board[foe][0].hp, g.board[foe][0].occ == 1);
      if (b0 == 1) { return vec2<i32>(fhp, 1); }
      if (b0 >= 2 && b0 <= 5) { return vec2<i32>(fhp / 2, 1); }
      return vec2<i32>(70, 1);
    }
    default: {
      return vec2<i32>(base_dmg, select(0, 1, base_dmg == 0 && op1 != 0));
    }
  }
}


@compute @workgroup_size(64)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  load_wg_cards(lid.x, gid.y, true);
  workgroupBarrier();

  let slot = gid.y * (params.wg_x * 64u) + gid.x;
  if (states_buf[slot].done != 0u) { return; }

  g = states_buf[slot];
  let dz = u32(params.mode == 99u);
  let cur = g.cur;
  let foe = 1u - cur;
  let turn = g.turn;
  let turn_i = i32(turn);
  var chosen_atk: i32 = -1;
  var saved_ex_blk: bool = false;

    let had_cant_atk_self = g.board[cur][0].occ == 1 && (g.board[cur][0].status & ST_CANT_ATK_SELF) != 0u;
    let had_cant_a1 = g.board[cur][0].occ == 1 && (g.board[cur][0].status & ST_CANT_USE_A1) != 0u;
    let had_cant_a2 = g.board[cur][0].occ == 1 && (g.board[cur][0].status & ST_CANT_USE_A2) != 0u;
    let cur_team_boost = g.next_team_boost[cur];
    g.next_team_boost[cur] = 0;

    g.team_shield[cur] = 0;
    g.team_shield_type[cur] = 255;
    for (var s = 0u; s < 4u; s = s + 1u) {
      if (g.board[cur][s].occ == 1) {
        if (g.board[cur][s].shield > 0) { g.board[cur][s].shield = 0; }
        g.board[cur][s].shield_ex = 0;
        g.board[cur][s].counter = 0;
        g.board[cur][s].status = g.board[cur][s].status & (~(ST_INVULN | ST_NO_WEAKNESS | ST_IMMUNE_BASIC | ST_IMMUNE_LE40 | ST_SURVIVE_10 | ST_RETREAT_TRAP));
      }
    }
    g.pts_last_turn[cur] = 0;
    var sweets_this_turn = 0;

    draw_one(cur);
  sync_ab(turn_i);

    if (g.board[cur][0].occ == 1 && ab_active(cur, 0u, turn_i) && c_ab_op(wg_cards[g.board[cur][0].ci]) == 2) {
      search_deck_to_hand(cur, 12, 0, 0);
    }

    // Active Stadium once-per-turn
    switch (g.stadium) {
      case 9: { search_deck_to_hand(cur, 9, 0, 0); }
      case 10: { if (flip_coin_plain()) { search_deck_to_hand(cur, 1, 0, 0); } }
      case 11: { if (flip_coin_plain()) { draw_one(cur); } }
      case 12: {
        if (flip_coin_plain() && flip_coin_plain() && flip_coin_plain()) {
          for (var l = 0u; l < 7u; l = l + 1u) { if (g.hand_len[cur] >= 7u || g.lib_len[cur] == 0u) { break; } draw_one(cur); }
        }
      }
      case 13: {
        if (count_bench(cur) >= 2 && g.lib_len[cur] > 0u) {
          for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) {
            let hc = wg_cards[g.hands[cur][hi]];
            if (hc.r0 == 1 && c_stage(hc) == 0 && !c_is_fossil(hc)) {
              let b = g.hands[cur][hi];
              g.hand_len[cur] = g.hand_len[cur] - 1u;
              g.hands[cur][hi] = g.hands[cur][g.hand_len[cur]];
              if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = b; g.lib_len[cur] = g.lib_len[cur] + 1u; }
              draw_one(cur);
              break;
            }
          }
        }
      }
      case 14: {
        var has_t = false;
        for (var i = 0u; i < g.lib_len[cur]; i = i + 1u) { if (c_is_tool(wg_cards[g.libs[cur][i]])) { has_t = true; break; } }
        if (has_t && g.hand_len[cur] > 1u) {
          g.hand_len[cur] = g.hand_len[cur] - 1u;
          let pb = g.hands[cur][g.hand_len[cur]];
          if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = pb; g.lib_len[cur] = g.lib_len[cur] + 1u; }
          search_deck_to_hand(cur, 6, 0, 0);
        }
      }
      default: {}
    }

    var energy_attached = (turn == 1u);
    var supporter_used = false;
    var retreated = false;
    var ability_used_mask: u32 = 0u;
    var dmg_boost = 0;
    var dmg_boost_ex = 0;
    var named_boost = 0;
    var named_h1 = 0;
    var named_h2 = 0;
    var eevee_boost = 0;
    var retreat_disc = 0;
    var barry_disc = 0;
    var barry_h1 = 0;
    var barry_h2 = 0;
    var iris_active = false;
    var iris_h1 = 0;
    var drayden_bonus = 0;
    var guar_heads = false;
    var gholdengo_used = false;

    let opp_gengar_lock = g.board[foe][0].occ == 1 && ab_active(foe, 0u, turn_i) && c_ab_op(wg_cards[g.board[foe][0].ci]) == 17 && wg_cards[g.board[foe][0].ci].r18 == 4;
    let opp_stad_lock = g.board[foe][0].occ == 1 && ab_active(foe, 0u, turn_i) && c_ab_op(wg_cards[g.board[foe][0].ci]) == 17 && wg_cards[g.board[foe][0].ci].r18 == 5;
    var opp_aero_lock = false;
    for (var s = 0u; s < 4u; s = s + 1u) {
      if (ab_active(foe, s, turn_i) && c_ab_op(wg_cards[g.board[foe][s].ci]) == 15 && wg_cards[g.board[foe][s].ci].r18 == 3) {
        opp_aero_lock = true; break;
      }
    }
    let heal_blocked = healing_blocked();


    for (var step = 0u; step < 10u + dz; step = step + 1u) {
      if (step > 0u) { sync_ab(turn_i); }
      var best_kind = 0u;
      var best_a = 0u;
      var best_b = 0u;
      var best_score = get_w(cur, 0u);

      // 1. Place Basics (incl. Fossils onto bench)
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) {
        let c = wg_cards[g.hands[cur][hi]];
        if (c.r0 == 1 && c_stage(c) == 0) {
          for (var s = 1u; s < 4u; s = s + 1u) {
            if (g.board[cur][s].occ == 0) {
              var sc = get_w(cur, 2u) + (((c.power_q * get_w(cur, 3u)) >> 10u) * 15 / 100) + ((c.bonus_q * 35) / 100);
              if (c_ab_op(c) == 6 && c.r18 == 1) {
                var te = 0;
                for (var k = 0u; k < 4u; k = k + 1u) { if (g.board[cur][k].occ == 1) { te = te + g.board[cur][k].energy; } }
                if (te >= 2) { sc = sc + get_w(cur, 13u) + get_w(cur, 14u); }
              }
              if (sc > best_score) { best_score = sc; best_kind = 1u; best_a = hi; best_b = s; }
              break;
            }
          }
        }
      }

      // 2. Evolve
      if (g.evo_lock[cur] == 0) {
        for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) {
          let c = wg_cards[g.hands[cur][hi]];
          let stg = c_stage(c);
          if (c.r0 == 1 && stg > 0 && stg < 99) {
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (g.board[cur][s].occ == 0 || (s == 0u && opp_aero_lock)) { continue; }
              let bc = wg_cards[g.board[cur][s].ci];
              let can_t1 = (s == 0u) && ab_active(cur, 0u, turn_i) && c_ab_op(bc) == 15 && bc.r18 == 1;
              if (!can_t1 && (turn < 2u || g.board[cur][s].turn_placed >= turn_i)) { continue; }
              if (ab_active(cur, s, turn_i) && c_ab_op(bc) == 3 && bc.r18 == 1 && (ability_used_mask & (1u << s)) == 0u) { continue; }
              let eg_c = c_evo_group(c); let eg_b = c_evo_group(bc);
              let evo_ok = (eg_c == 0) || (eg_b == 0) || (eg_b == eg_c);
              if (s_stage(g.board[cur][s]) + 1 == stg && evo_ok) {
                let ps = select(c.power_q >> 1u, c.power_q, s == 0u);
                let sc = get_w(cur, 4u) + ((ps * get_w(cur, 5u)) >> 10u) + ((c.bonus_q * 45) / 100);
                if (sc > best_score) { best_score = sc; best_kind = 2u; best_a = hi; best_b = s; }
              }
            }
          }
        }
      }

      // 3. Active Once-Per-Turn Abilities
      for (var s = 0u; s < 4u; s = s + 1u) {
        if (!ab_active(cur, s, turn_i) || (ability_used_mask & (1u << s)) != 0u) { continue; }
        let scard = wg_cards[g.board[cur][s].ci];
        let ab_op = c_ab_op(scard);
        let ab_val = scard.r18;
        var valid = false;
        var extra_sc = 0;
        switch (ab_op) {
          case 3: {
            if (ab_val == 1) { valid = true; extra_sc = get_w(cur, 15u) >> 1u; }
            else if (ab_val == 2) { valid = g.board[cur][s].hp > 20 && (g.energy_discarded[cur] > 0 || g.points[foe] > 0 || turn >= 4u); extra_sc = get_w(cur, 15u) >> 1u; }
            else if (ab_val == 3) { valid = g.board[cur][s].hp > 30; extra_sc = get_w(cur, 15u); }
            else if (ab_val == 4) {
              let ac0 = wg_cards[g.board[cur][0].ci];
              let can_a = turn >= 2u && g.board[cur][0].occ == 1 && can_pay_attack(cur, foe, c_a1_cost(ac0), c_a1_flags(ac0), 0, turn_i);
              if (!can_a || turn == 1u) { valid = true; extra_sc = select((get_w(cur, 15u) >> 1u) - (get_w(cur, 9u) >> 2u), get_w(cur, 15u), turn == 1u); }
            }
          }
          case 4: {
            if (g.board[cur][0].occ == 1) {
              valid = select(true, g.energy_discarded[cur] > 0 || g.points[foe] > 0 || turn >= 3u, ab_val == 2);
              extra_sc = get_w(cur, 14u) >> 1u;
            }
          }
          case 8: { if (g.board[foe][0].occ == 1) { valid = true; extra_sc = (get_w(cur, 21u) * 35) / 100; } }
          case 12: { if (((ab_val >> 8u) & 255) == 2 && g.board[cur][s].energy > 0 && turn >= 2u) { valid = true; extra_sc = get_w(cur, 10u) >> 1u; } }
          case 14: {
            let mode = (ab_val >> 8u) & 255;
            if (mode == 6) { valid = g.board[cur][0].occ == 1 && (g.board[cur][0].status & ST_SPECIAL_MASK) != 0u; extra_sc = get_w(cur, 20u) >> 1u; }
            else if (!heal_blocked) {
              if (mode <= 2) { valid = g.board[cur][0].occ == 1 && g.board[cur][0].hp < g.board[cur][0].max_hp; extra_sc = get_w(cur, 20u) >> 1u; }
              else if (mode == 3) { valid = g.board[cur][0].occ == 1 && c_is_ex(wg_cards[g.board[cur][0].ci]) && g.board[cur][0].energy > 0 && (g.board[cur][0].max_hp - g.board[cur][0].hp) >= 40; extra_sc = get_w(cur, 20u) >> 1u; }
              else if (mode == 4 || mode == 5) { valid = g.board[cur][0].occ == 1 && g.board[cur][0].hp < g.board[cur][0].max_hp && g.board[cur][s].hp > 30; extra_sc = get_w(cur, 20u) >> 1u; }
            }
          }
          case 16: {
            if (ab_val == 1 || ab_val == 5 || ab_val == 6 || ab_val == 7) {
              if (count_bench(cur) > 0) {
                let bbs = best_bench_promote(cur);
                if (bbs < 4u && (g.board[cur][0].hp < g.board[cur][0].max_hp / 2 || (g.board[cur][bbs].energy > g.board[cur][0].energy && wg_cards[g.board[cur][bbs].ci].power_q > wg_cards[g.board[cur][0].ci].power_q))) {
                  valid = true; extra_sc = get_w(cur, 18u) >> 1u;
                }
              }
            } else if (ab_val == 2 || ab_val == 3) {
              var hbe = false;
              for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[cur][bs].occ == 1 && g.board[cur][bs].energy > 0) { hbe = true; break; } }
              if (g.board[cur][0].occ == 1 && hbe) { valid = true; extra_sc = get_w(cur, 14u); }
            } else if (ab_val == 4) {
              var oe = false;
              for (var k = 0u; k < 4u; k = k + 1u) { if (k != s && g.board[cur][k].occ == 1 && g.board[cur][k].energy > 0) { oe = true; break; } }
              if (oe) { valid = true; extra_sc = get_w(cur, 14u); }
            }
          }
          case 19: {
            if (ab_val == 1 || ab_val == 5) { valid = count_bench(foe) > 0; extra_sc = get_w(cur, 19u) >> 1u; }
            else if (ab_val == 2) {
              var hd = false;
              for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && g.board[foe][bs].hp < g.board[foe][bs].max_hp) { hd = true; break; } }
              valid = hd; extra_sc = get_w(cur, 19u);
            } else if (ab_val == 3) {
              var hb = false;
              for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && s_stage(g.board[foe][bs]) == 0) { hb = true; break; } }
              valid = hb; extra_sc = get_w(cur, 19u) >> 1u;
            } else if (ab_val == 4) { valid = g.board[foe][0].occ == 1 && s_stage(g.board[foe][0]) == 0 && count_bench(foe) > 0; extra_sc = get_w(cur, 19u) >> 1u; }
            else if (ab_val == 6 || ab_val == 7 || ab_val == 8 || ab_val == 10) { valid = g.hand_len[cur] < 12u && (ab_val == 10 || g.lib_len[cur] > 0u); extra_sc = get_w(cur, 8u); }
            else if (ab_val == 9) { valid = g.hand_len[cur] >= 2u && g.lib_len[cur] > 0u; extra_sc = get_w(cur, 8u) >> 1u; }
            else if (ab_val >= 11 && ab_val <= 16) { valid = g.board[foe][0].occ == 1 && !has_status_immunity(foe, 0u, turn_i); extra_sc = get_w(cur, 12u) >> 1u; }
            else if (ab_val == 17) { valid = g.lib_len[foe] > 0u; extra_sc = get_w(cur, 19u) >> 2u; }
            else if (ab_val == 18) { valid = g.board[foe][0].occ == 1 && s_tool_cnt(g.board[foe][0]) > 0; extra_sc = get_w(cur, 19u) >> 1u; }
            else if (ab_val == 19) { valid = g.hand_len[foe] > 0u; extra_sc = get_w(cur, 8u) >> 1u; }
          }
          default: {}
        }
        if (valid) {
          let sc = get_w(cur, 6u) + extra_sc + ((scard.bonus_q * 35) / 100);
          if (sc > best_score) { best_score = sc; best_kind = 4u; best_a = s; }
        }
      }

      // 4. Trainers
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) {
        let c = wg_cards[g.hands[cur][hi]];
        let tk = c_trn_kind(c);
        if (c.r0 != 0 || tk == 0 || tk == 8) { continue; }
        if (c_is_supporter(c) && (supporter_used || g.supp_lock[cur] == 1 || opp_gengar_lock)) { continue; }
        if (c_is_item(c) && g.item_lock[cur] == 1) { continue; }
        if (c_is_stadium(c) && opp_stad_lock) { continue; }

        let sub = c_trn_sub(c);
        let tcond = c_trn_cond(c);
        let tv = c.r20;
        var sc = get_w(cur, 7u) + ((c.bonus_q * 40) / 100);
        var playable = true;

        switch (tk) {
          case 1: {
            if (sub == 2) {
              var ok = false;
              for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { let lc = wg_cards[g.libs[cur][k]]; if (lc.r0 == 1 && c_stage(lc) == 0 && !c_is_fossil(lc)) { ok = true; break; } }
              playable = ok;
            } else if (sub == 3) { playable = g.hand_len[foe] > 0u && g.hand_len[foe] + 1u >= g.hand_len[cur]; }
            else if (sub == 5) {
              var hp = false; for (var k = 0u; k < g.hand_len[cur]; k = k + 1u) { if (k != hi && wg_cards[g.hands[cur][k]].r0 == 1) { hp = true; break; } }
              var dp = false; for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { if (wg_cards[g.libs[cur][k]].r0 == 1) { dp = true; break; } }
              playable = hp && dp;
            } else if (sub == 6) {
              var ok = false; for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { let lc = wg_cards[g.libs[cur][k]]; if (lc.r0 == 1 && c_stage(lc) == 0 && !c_is_fossil(lc) && lc.r5 <= 50) { ok = true; break; } }
              playable = ok;
            } else if (sub == 7) {
              var ok = false; for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { let lc = wg_cards[g.libs[cur][k]]; if (lc.r0 == 1 && c_stage(lc) == 2) { ok = true; break; } }
              playable = ok;
            } else if (sub == 8) {
              var ok = false; for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { let lc = wg_cards[g.libs[cur][k]]; if (lc.r0 == 1 && c_is_mega(lc)) { ok = true; break; } }
              playable = ok;
            } else if (sub == 12) {
              var mc = 0; for (var pp = 0u; pp < 2u; pp = pp + 1u) { for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (g.board[pp][ss].occ == 1 && c_is_mega(wg_cards[g.board[pp][ss].ci])) { mc = mc + 1; } } }
              playable = mc > 0 && g.lib_len[cur] > 0u;
            } else if (sub == 13) {
              var ok = false; for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { if (c_is_stadium(wg_cards[g.libs[cur][k]])) { ok = true; break; } }
              playable = ok;
            } else if (sub == 18) {
              var ok = false; for (var k = 0u; k < g.lib_len[cur]; k = k + 1u) { if (c_matches_hashes(wg_cards[g.libs[cur][k]], c.r21, c.r22)) { ok = true; break; } }
              playable = ok;
            } else if (sub == 20) { playable = select(g.disc_basic_w[cur] > 0, g.disc_basic_any[cur] > 0, tv == 1); }
            else if (sub == 21) { playable = g.disc_item[foe] > 0; }
            else if (sub == 22) { playable = g.hand_len[cur] >= 3u && g.lib_len[cur] > 0u; }
            else { playable = g.lib_len[cur] > 0u; }
            let inv = 5120 / (5 + i32(g.hand_len[cur]));
            sc = sc + ((inv * get_w(cur, 8u)) >> 10u);
          }
          case 2: {
            if (sub == 6) { playable = g.board[cur][0].occ == 1 && (g.board[cur][0].status & ST_SPECIAL_MASK) != 0u; }
            else if (sub == 15) {
              var hee = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_eevee_evo(wg_cards[g.board[cur][s].ci])) { hee = true; break; } }
              playable = hee && (turn >= 2u || !heal_blocked);
            } else if (sub == 16) {
              var ok = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].hp < g.board[cur][s].max_hp && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { ok = true; break; } }
              playable = ok && g.board[foe][0].occ == 1;
            } else if (heal_blocked || g.board[cur][0].occ == 0) { playable = false; }
            else {
              var tm = 0;
              for (var s = 0u; s < 4u; s = s + 1u) {
                if (g.board[cur][s].occ == 0) { continue; }
                let scard = wg_cards[g.board[cur][s].ci];
                var okt = true;
                if (sub == 2) { okt = c_has_type(scard, tcond - 1); }
                else if (sub == 3 || sub == 10) { okt = g.board[cur][s].energy > 0; }
                else if (sub == 4) { okt = s_stage(g.board[cur][s]) == 2; }
                else if (sub == 7 || sub == 8) { okt = s == 0u; }
                else if (sub == 11) { okt = c_has_type(scard, 4) && g.board[cur][s].energy >= 2; }
                else if (sub == 12 || sub == 13 || sub == 14) { okt = c_matches_hashes(scard, c.r21, c.r22); }
                if (okt) { tm = max(tm, g.board[cur][s].max_hp - g.board[cur][s].hp); }
              }
              let hst = (sub == 5 || sub == 7 || sub == 13) && (g.board[cur][0].status & ST_SPECIAL_MASK) != 0u;
              if (tm <= 0 && !hst) { playable = false; }
              else {
                let eh = select(25, min(tm, clamp(tv, 20, 90)), tm > 0);
                sc = sc + (get_w(cur, 20u) * eh) / 50;
              }
            }
          }
          case 3: {
            if (sub == 1) { playable = count_bench(foe) > 0; }
            else if (sub == 2) {
              var hd = false; for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && g.board[foe][bs].hp < g.board[foe][bs].max_hp) { hd = true; break; } }
              playable = hd;
            } else if (sub == 3) {
              var hn = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { hn = true; break; } }
              playable = hn && count_bench(foe) > 0;
            } else if (sub == 4) { playable = g.board[foe][0].occ == 1 && s_stage(g.board[foe][0]) == tv && count_bench(foe) > 0; }
            else if (sub == 5) { playable = g.hand_len[foe] > 3u; }
            else if (sub == 6) { playable = g.hand_len[foe] > u32(max(1, 3 - g.points[foe])); }
            else if (sub == 7) { playable = g.hand_len[foe] > 4u; }
            else if (sub == 8 || sub == 9) { playable = g.hand_len[foe] > 0u; }
            else if (sub == 10) {
              var ht = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && s_tool_cnt(g.board[foe][s]) > 0) { ht = true; break; } }
              playable = ht;
            } else if (sub == 11) {
              var ht = g.stadium != 0; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && s_tool_cnt(g.board[foe][s]) > 0) { ht = true; break; } }
              playable = ht;
            } else if (sub == 12) { playable = g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0; }
            else if (sub == 13) {
              var hn = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { hn = true; break; } }
              playable = hn && g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0;
            } else if (sub == 14) {
              var ok = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && c_ab_op(wg_cards[g.board[foe][s].ci]) != 0 && g.board[foe][s].energy > 0) { ok = true; break; } }
              playable = ok;
            } else if (sub == 15) { playable = g.board[foe][0].occ == 1 && !has_status_immunity(foe, 0u, turn_i); }
            else if (sub == 16) { playable = g.board[foe][0].occ == 1; }
            else if (sub == 17) { playable = g.disc_basic_any[foe] > 0 && count_bench(foe) < 3; }
            else if (sub == 18) { playable = count_bench(foe) < 3 && g.hand_len[foe] > 0u; }
            else if (sub == 19) {
              var be = false; for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && g.board[foe][s].energy > 0) { be = true; break; } }
              playable = g.board[cur][0].occ == 1 && c_has_psychic(wg_cards[g.board[cur][0].ci]) && be;
            } else if (sub == 20) {
              if (count_bench(cur) == 0 || g.board[cur][0].occ == 0 || g.board[cur][0].hp >= g.board[cur][0].max_hp || g.board[cur][0].hp > 60) { playable = false; }
              else {
                let ac = wg_cards[g.board[cur][0].ci];
                if (tv == 1) { playable = c_matches_hashes(ac, c.r21, c.r22); }
                else if (tv == 2) { playable = c_has_type(ac, 9); }
                else if (tv == 3) { playable = c_has_type(ac, 2) && !c_is_ex(ac); }
                else if (tv == 4) { playable = c_is_future(ac); }
                else { playable = false; }
              }
            } else { playable = false; }
            sc = sc + ((get_w(cur, 19u) * 45) + (get_w(cur, 21u) * 25)) / 100;
          }
          case 4: {
            if (sub == 1) { playable = turn >= 2u && g.board[foe][0].occ == 1; }
            else if (sub == 2) { playable = turn >= 2u && g.board[foe][0].occ == 1 && c_is_ex(wg_cards[g.board[foe][0].ci]); }
            else if (sub == 3) { playable = turn >= 2u && g.board[cur][0].occ == 1 && c_has_type(wg_cards[g.board[cur][0].ci], 5) && g.board[foe][0].occ == 1 && c_is_ex(wg_cards[g.board[foe][0].ci]); }
            else if (sub == 4) { playable = turn >= 2u && g.board[cur][0].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][0].ci], c.r21, c.r22) && g.board[foe][0].occ == 1; }
            else if (sub == 5) { playable = turn >= 2u && g.board[cur][0].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][0].ci], c.r21, c.r22) && g.board[foe][0].occ == 1 && c_is_ex(wg_cards[g.board[foe][0].ci]); }
            else if (sub == 6) { playable = turn >= 2u; }
            else if (sub == 7) { playable = turn >= 2u && g.points[foe] == 0; }
            else if (sub == 8 || sub == 9 || sub == 12) {
              var hn = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { hn = true; break; } }
              playable = hn && turn >= 2u;
            } else if (sub == 10) { playable = !guar_heads && turn >= 2u; }
            else if (sub == 11) { playable = turn >= 2u && g.board[cur][0].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][0].ci], c.r21, c.r22); }
            else if (sub == 13) { playable = turn >= 2u && g.board[cur][0].occ == 1 && c_has_draco(wg_cards[g.board[cur][0].ci]); }
            else { playable = false; }
            sc = sc + ((get_w(cur, 10u) * 35) + (get_w(cur, 11u) * 25)) / 100;
          }
          case 5: {
            var tgt_s = 4u;
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (g.board[cur][s].occ == 0) { continue; }
              let scard = wg_cards[g.board[cur][s].ci];
              let max_t = select(1, 2, ab_active(cur, s, turn_i) && c_ab_op(scard) == 15 && scard.r18 == 9);
              if (s_tool_cnt(g.board[cur][s]) >= max_t) { continue; }
              var ok = true;
              if (tv == 2) { ok = c_has_type(scard, 0); }
              else if (tv == 3) { ok = s_stage(g.board[cur][s]) == 1; }
              else if (tv == 4) { ok = c_is_ancient(scard); }
              else if (tv == 7 || tv == 10) { ok = s_stage(g.board[cur][s]) == 0; }
              else if (tv == 8) { ok = c_has_type(scard, 2); }
              else if (tv == 9) { ok = s_stage(g.board[cur][s]) == 2; }
              else if (tv == 11) { ok = c_retreat(scard) >= 3; }
              else if (tv == 12 || tv == 13) { ok = c_has_type(scard, 7); }
              else if (tv == 14) { ok = s > 0u; }
              else if (tv == 16) { ok = c_is_future(scard); }
              else if (tv == 17) { ok = c_name_hash(scard) == i32(u32(c.r21) & 65535u); }
              else if (tv == 18) { ok = c_is_ub(scard); }
              else if (tv == 19 || tv == 26) { ok = c_has_type(scard, 6); }
              else if (tv == 25) { ok = c_has_type(scard, 3); }
              if (ok) { tgt_s = s; break; }
            }
            if (tgt_s >= 4u) { playable = false; }
            else { sc = sc + select(get_w(cur, 20u) >> 1u, get_w(cur, 20u), tgt_s == 0u); }
          }
          case 6: {
            if (sub == 1) {
              if (turn < 2u || g.evo_lock[cur] != 0) { playable = false; }
              else {
                var ok = false;
                for (var hi2 = 0u; hi2 < g.hand_len[cur]; hi2 = hi2 + 1u) {
                  let evc = wg_cards[g.hands[cur][hi2]];
                  if (evc.r0 == 1 && c_stage(evc) == 2) {
                    for (var s = 0u; s < 4u; s = s + 1u) {
                      if (g.board[cur][s].occ == 0 || (s == 0u && opp_aero_lock)) { continue; }
                      let eg_e = c_evo_group(evc); let eg_b = c_evo_group(wg_cards[g.board[cur][s].ci]);
                      if (s_stage(g.board[cur][s]) == 0 && (eg_e == 0 || eg_b == 0 || eg_b == eg_e) && g.board[cur][s].turn_placed < turn_i) { ok = true; break; }
                    }
                    if (ok) { break; }
                  }
                }
                playable = ok;
              }
              sc = sc + get_w(cur, 4u) + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
            } else if (sub == 2) { playable = turn >= 2u && g.evo_lock[cur] == 0 && g.lib_len[cur] > 0u; sc = sc + get_w(cur, 4u); }
            else if (sub == 3) { playable = !retreated && count_bench(cur) > 0 && eff_retreat_cost(cur, turn_i, retreat_disc) > 0; sc = sc + (get_w(cur, 18u) >> 1u); }
            else if (sub == 4) {
              playable = count_bench(cur) > 0 && g.board[cur][0].occ == 1 && select(select(true, s_stage(g.board[cur][0]) == 1, tv == 2), g.board[cur][0].hp < g.board[cur][0].max_hp, tv == 1);
              sc = sc + (get_w(cur, 18u) >> 1u);
            } else if (sub == 5 || sub == 6) {
              let tf = max(0, tcond - 1);
              var ok = false;
              let st_s = select(0u, 1u, sub == 6);
              for (var s = st_s; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], tf)) { ok = true; break; } }
              playable = ok;
              sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
            } else if (sub == 7) {
              var ok = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 2) { ok = true; break; } }
              playable = ok; sc = sc + ((get_w(cur, 13u) * 45) + (get_w(cur, 15u) * 35)) / 100;
            } else if (sub == 8) { playable = g.board[cur][0].occ == 1 && c_has_type(wg_cards[g.board[cur][0].ci], 1) && (g.energy_discarded[cur] > 0 || g.points[foe] > 0 || turn >= 5u); sc = sc + (get_w(cur, 15u) >> 1u); }
            else if (sub == 9) {
              var hub = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_ub(wg_cards[g.board[cur][s].ci])) { hub = true; break; } }
              playable = g.points[foe] >= 1 && hub && (g.energy_discarded[cur] > 0 || turn >= 4u); sc = sc + get_w(cur, 15u);
            } else if (sub == 10) {
              var hn = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { hn = true; break; } }
              playable = hn && (g.energy_discarded[cur] > 0 || g.points[foe] > 0 || turn >= 5u); sc = sc + get_w(cur, 15u);
            } else if (sub == 11) {
              var ha = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_ancient(wg_cards[g.board[cur][s].ci])) { ha = true; break; } }
              playable = ha && (g.energy_discarded[cur] > 0 || g.points[foe] > 0 || turn >= 4u); sc = sc + get_w(cur, 15u);
            } else if (sub == 12 || sub == 13) {
              var hn = false; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { hn = true; break; } }
              playable = hn && (sub == 12 || turn == 1u || g.board[cur][0].energy < 2); sc = sc + get_w(cur, 15u);
            } else if (sub == 14 || sub == 15) {
              var be = false; for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].energy > 0) { be = true; break; } }
              let aok = select(g.board[cur][0].occ == 1, g.board[cur][0].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][0].ci], c.r21, c.r22), sub == 15 && tv == 1);
              playable = aok && be; sc = sc + get_w(cur, 14u);
            } else if (sub == 16) {
              playable = turn >= 2u && g.board[cur][0].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][0].ci], c.r21, c.r22); sc = sc + get_w(cur, 14u);
            } else { playable = false; }
          }
          case 7: { if (g.stadium == tv) { playable = false; } else { sc = sc + (get_w(cur, 6u) >> 1u); } }
          default: { playable = false; }
        }
        if (playable && sc > best_score) { best_score = sc; best_kind = 3u; best_a = hi; }
      }

      // 5. Energy attach
      if (!energy_attached) {
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (g.board[cur][s].occ == 0) { continue; }
          if (s == 0u && (g.board[cur][0].status & ST_NO_ENERGY_ATTACH) != 0u) { continue; }
          let bc = wg_cards[g.board[cur][s].ci];
          let a1c = c_a1_cost(bc); let a2c = c_a2_cost(bc);
          let max_c = select(select(1, a1c, a1c != 255), a2c, a2c != 255 && a2c > a1c);
          let ex_n = select(0, i32((u32(bc.r10) >> 16u) & 255u), c_a1_op1(bc) == 7 && (bc.r10 & 255) == 0);
          let need_b = g.board[cur][s].energy < max_c + ex_n;
          let chip_b = select(0, (get_w(cur, 21u) * 45) / 100, ab_active(cur, s, turn_i) && c_ab_op(bc) == 7 && bc.r18 < 100);
          let sc = get_w(cur, 13u) + select(0, get_w(cur, 14u), s == 0u) + select(0, get_w(cur, 15u), need_b) + chip_b + ((bc.power_q * get_w(cur, 16u)) >> 10u) + ((bc.bonus_q * 25) / 100);
          if (sc > best_score) { best_score = sc; best_kind = 5u; best_a = s; }
        }
      }

      // 6. Retreat
      let active_ex_blocked = g.board[cur][0].occ == 1 && g.board[foe][0].occ == 1
        && ab_active(foe, 0u, turn_i) && c_ab_op(wg_cards[g.board[foe][0].ci]) == 10
        && c_is_ex(wg_cards[g.board[cur][0].ci]);
      let r_cost = eff_retreat_cost(cur, turn_i, retreat_disc);
      let cant_ret = g.board[cur][0].occ == 1 && (g.board[cur][0].status & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CANT_RETREAT)) != 0u;
      if (!retreated && g.board[cur][0].occ == 1 && !cant_ret && g.board[cur][0].energy >= r_cost) {
        let foe_dmg = select(0, (wg_cards[g.board[foe][0].ci].power_q * 100) >> 10u, g.board[foe][0].occ == 1);
        for (var s = 1u; s < 4u; s = s + 1u) {
          if (g.board[cur][s].occ == 1) {
            let endg_b = (g.board[cur][0].hp <= foe_dmg && g.board[cur][s].hp > g.board[cur][0].hp)
              || (active_ex_blocked && !c_is_ex(wg_cards[g.board[cur][s].ci]));
            let sc = get_w(cur, 17u) + select(0, get_w(cur, 18u), endg_b);
            if (sc > best_score) { best_score = sc; best_kind = 6u; best_a = s; }
          }
        }
      }

      // 7. Dual-Attack Selection
      let cant_atk = g.board[cur][0].occ == 1 && (g.board[cur][0].status & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CANT_ATK_SELF | ST_CANT_ATK_OPP)) != 0u;
      if (turn >= 2u && g.board[cur][0].occ == 1 && !cant_atk) {
        let atk_c = wg_cards[g.board[cur][0].ci];
        let my_barry = select(0, barry_disc, barry_disc > 0 && c_matches_hashes(atk_c, barry_h1, barry_h2));
        for (var ai = 0u; ai < 2u + dz; ai = ai + 1u) {
          if (ai == 0u && (g.board[cur][0].status & ST_CANT_USE_A1) != 0u) { continue; }
          if (ai == 1u && (g.board[cur][0].status & ST_CANT_USE_A2) != 0u) { continue; }
          let ac = select(c_a2_cost(atk_c), c_a1_cost(atk_c), ai == 0u);
          let af = select(c_a2_flags(atk_c), c_a1_flags(atk_c), ai == 0u);
          let ad = select(atk_c.r13, atk_c.r8, ai == 0u);
          let ao1 = select(c_a2_op1(atk_c), c_a1_op1(atk_c), ai == 0u);
          let av1 = select(atk_c.r15, atk_c.r10, ai == 0u);
          let ao2 = select(c_a2_op2(atk_c), c_a1_op2(atk_c), ai == 0u);
          let av2 = select(atk_c.r16, atk_c.r11, ai == 0u);
          let aaux = select(c_a2_aux(atk_c), c_a1_aux(atk_c), ai == 0u);
          if (!can_pay_attack(cur, foe, ac, af, my_barry, turn_i)) { continue; }
          let ld = eval_live_dmg_v3(cur, foe, ac, ad, ao1, av1, aaux, supporter_used, turn_i);
          let raw_d = ld.x;
          let is_sp = ld.y != 0;
          if (raw_d <= 0 && !is_sp && ao1 == 0 && ao2 == 0) { continue; }
          let ign_eff = (af & AF_IGNORE_EFFECTS) != 0;
          if (active_ex_blocked && !ign_eff && !is_sp && ao1 != 8 && ao1 != 13 && ao1 != 18 && ao1 != 1 && ao2 == 0) { continue; }
          let mod_net = calc_passive_dmg_mods(cur, foe, af, raw_d, dmg_boost, dmg_boost_ex, named_boost, named_h1, named_h2, eevee_boost, cur_team_boost, turn_i);
          let tot_d = select(select(0, max(0, raw_d + mod_net), raw_d > 0), raw_d, is_sp);
          let ko_b = g.board[foe][0].occ == 1 && tot_d >= g.board[foe][0].hp;
          let eff_b = select(0, get_w(cur, 12u), ao1 != 0 || ao2 != 0);
          let sn_b = select(0, get_w(cur, 21u) >> 1u, ao1 == 8 || ao2 == 8);
          let has_disc = ao1 == 10 || ao2 == 10;
          let heavy_rec = (ao1 == 9 && (av1 & 255) >= 40) || (ao2 == 9 && (av2 & 255) >= 40);
          var pen = 0;
          if (has_disc && !ko_b) { pen = max(0, get_w(cur, 15u) >> 2u); }
          else if (heavy_rec && g.board[cur][0].hp <= 50) { pen = get_w(cur, 11u) >> 1u; }
          let sc = get_w(cur, 9u) + ((tot_d * get_w(cur, 10u)) / 100) + select(0, get_w(cur, 11u), ko_b) + eff_b + sn_b + ((atk_c.bonus_q * 40) / 100) - pen;
          if (sc > best_score) { best_score = sc; best_kind = 7u; best_a = ai; }
        }
      }

      // === EXECUTE CHOSEN ACTION ===
      if (best_kind == 0u) { break; }
      else if (best_kind == 1u) {
        let ci = g.hands[cur][best_a];
        let c = wg_cards[ci];
        var bhp = select(0, 20, g.stadium == 3 && c_stage(c) == 0);
        if (c_has_type(c, 0)) {
          for (var k = 0u; k < 4u; k = k + 1u) {
            if (ab_active(cur, k, turn_i) && c_ab_op(wg_cards[g.board[cur][k].ci]) == 18 && wg_cards[g.board[cur][k].ci].r18 == 20) { bhp = bhp + 20; }
          }
        }
        g.board[cur][best_b] = make_slot(ci, c.r5 + bhp, turn_i);
        g.hand_len[cur] = g.hand_len[cur] - 1u;
        g.hands[cur][best_a] = g.hands[cur][g.hand_len[cur]];
        if (c_ab_op(c) == 6) { sync_ab(turn_i); }
        if (ab_active(cur, best_b, turn_i) && c_ab_op(c) == 6) {
          if (c.r18 == 1) {
            let walling = g.board[cur][0].occ == 1 && ab_active(cur, 0u, turn_i) && c_ab_op(wg_cards[g.board[cur][0].ci]) == 10 && g.board[foe][0].occ == 1 && c_is_ex(wg_cards[g.board[foe][0].ci]);
            var te = 0;
            for (var k = 0u; k < 4u; k = k + 1u) { if (g.board[cur][k].occ == 1 && k != best_b) { te = te + g.board[cur][k].energy; } }
            let need_e = select(3, max(2, c_a1_cost(c)), c_a1_cost(c) != 255);
            if (!walling && te >= need_e) {
              for (var k = 0u; k < 4u; k = k + 1u) { if (g.board[cur][k].occ == 1 && k != best_b) { g.board[cur][k].energy = 0; } }
              g.board[cur][best_b].energy = g.board[cur][best_b].energy + te;
              let tmp = g.board[cur][0]; g.board[cur][0] = g.board[cur][best_b]; g.board[cur][best_b] = tmp;
              g.board[cur][0].status = (g.board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
            }
          } else if (c.r18 == 2 && count_bench(foe) > 0) {
            let pick = best_bench_promote(foe);
            if (pick < 4u) {
              g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR);
              g.board[foe][0].stack_boost = 0;
              let tmp = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = tmp;
              g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED);
            }
          } else if (c.r18 == 3 && !heal_blocked && g.board[cur][0].occ == 1 && c_has_type(wg_cards[g.board[cur][0].ci], 0)) {
            g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + 20);
          }
        }
      } else if (best_kind == 2u) {
        let ci = g.hands[cur][best_a];
        let c = wg_cards[ci];
        let dmg_taken = max(0, g.board[cur][best_b].max_hp - g.board[cur][best_b].hp);
        let bhp = tool_hp_bonus(g.board[cur][best_b].tool, c) + tool_hp_bonus(g.board[cur][best_b].tool2, c);
        var ehp = 0;
        if (c_has_type(c, 0)) {
          for (var k = 0u; k < 4u; k = k + 1u) { if (ab_active(cur, k, turn_i) && c_ab_op(wg_cards[g.board[cur][k].ci]) == 18 && wg_cards[g.board[cur][k].ci].r18 == 20) { ehp = ehp + 20; } }
        }
        if (c_ab_op(c) == 18 && c.r18 == 99) { ehp = ehp + g.board[cur][best_b].energy * 30; }
        g.board[cur][best_b].ci = ci;
        g.board[cur][best_b].stage_ov = -1;
        g.board[cur][best_b].max_hp = c.r5 + bhp + ehp;
        g.board[cur][best_b].hp = max(10, g.board[cur][best_b].max_hp - dmg_taken);
        g.board[cur][best_b].status = g.board[cur][best_b].status & (~ST_SPECIAL_MASK);
        g.board[cur][best_b].turn_placed = turn_i;
        g.hand_len[cur] = g.hand_len[cur] - 1u;
        g.hands[cur][best_a] = g.hands[cur][g.hand_len[cur]];
        if (c_ab_op(c) == 18 && c.r18 == 20) {
          for (var k = 0u; k < 4u; k = k + 1u) { if (g.board[cur][k].occ == 1 && c_has_type(wg_cards[g.board[cur][k].ci], 0)) { g.board[cur][k].max_hp = g.board[cur][k].max_hp + 20; g.board[cur][k].hp = g.board[cur][k].hp + 20; } }
        }
        if (c_ab_op(c) == 5) {
          sync_ab(turn_i);
          switch (c.r18) {
            case 1: { if (g.board[cur][0].occ == 1 && c_has_type(wg_cards[g.board[cur][0].ci], 1)) { g.board[cur][0].energy = g.board[cur][0].energy + 1; } }
            case 2: { draw_one(cur); draw_one(cur); }
            case 3: {
              for (var bs = 1u; bs < 4u; bs = bs + 1u) {
                if (g.board[cur][bs].occ == 0) {
                  for (var li = 0u; li < g.lib_len[cur]; li = li + 1u) {
                    let lc = wg_cards[g.libs[cur][li]];
                    if (lc.r0 == 1 && c_stage(lc) == 1 && c_evo_group(lc) == c_evo_group(c)) {
                      let cl = g.libs[cur][li];
                      g.lib_len[cur] = g.lib_len[cur] - 1u;
                      g.libs[cur][li] = g.libs[cur][g.lib_len[cur]];
                      g.board[cur][bs] = make_slot(cl, lc.r5, turn_i);
                      break;
                    }
                  }
                  break;
                }
              }
            }
            case 4, 5: {
              let da = select(20, 30, c.r18 == 5);
              if (g.board[foe][0].occ == 1) { g.board[foe][0].hp = g.board[foe][0].hp - da; ko_active_passive(foe, cur); }
            }
            case 6: {
              shuffle_hand_into_deck(foe);
              let want = u32(max(1, 3 - g.points[foe]));
              for (var l = 0u; l < want; l = l + 1u) { draw_one(foe); }
            }
            case 8: { if (g.board[foe][0].occ == 1 && flip_coin_g(&guar_heads)) { apply_status(foe, 0u, ST_PARALYZE, turn_i, false); } }
            case 9: {
              let lim = min(4u, g.lib_len[cur]);
              var taken = 0u;
              for (var l = 0u; l < lim; l = l + 1u) {
                if (g.lib_len[cur] <= taken) { break; }
                let idxt = g.lib_len[cur] - 1u - taken;
                let tci = g.libs[cur][idxt];
                if (c_is_item(wg_cards[tci]) && g.hand_len[cur] < 12u) {
                  g.lib_len[cur] = g.lib_len[cur] - 1u;
                  g.libs[cur][idxt] = g.libs[cur][g.lib_len[cur]];
                  g.hands[cur][g.hand_len[cur]] = tci; g.hand_len[cur] = g.hand_len[cur] + 1u;
                } else { taken = taken + 1u; }
              }
            }
            case 10: { if (g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0) { g.board[foe][0].energy = g.board[foe][0].energy - 1; g.energy_discarded[foe] = 1; } }
            case 12: {
              if (!heal_blocked) {
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], 2) && g.board[cur][s].hp < g.board[cur][s].max_hp) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + 60); break; } }
              }
            }
            case 13: { apply_status(foe, 0u, ST_POISON | ST_BURN, turn_i, false); }
            case 14: { if (g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0) { g.board[foe][0].energy = g.board[foe][0].energy - 1; g.board[cur][best_b].energy = g.board[cur][best_b].energy + 1; } }
            case 15: { g.board[cur][best_b].status = g.board[cur][best_b].status | ST_INVULN; }
            default: {}
          }
        }
        if (g.points[cur] >= 3 || g.board[foe][0].occ == 0) { g.done = 1u; g.outcome = select(0u, 1u, cur == 0u); g.end_turn = turn; states_buf[slot] = g; return; }
      } else if (best_kind == 3u) {
        let ci = g.hands[cur][best_a];
        let c = wg_cards[ci];
        g.hand_len[cur] = g.hand_len[cur] - 1u;
        g.hands[cur][best_a] = g.hands[cur][g.hand_len[cur]];
        if (c_is_supporter(c)) { supporter_used = true; }
        if (!c_is_tool(c) && !c_is_stadium(c)) { record_discard_card(cur, ci); }
        var end_turn_now = false;
        var has_ghold = false;
        if (!gholdengo_used) {
          for (var s = 0u; s < 4u; s = s + 1u) {
            if (ab_active(cur, s, turn_i) && c_ab_op(wg_cards[g.board[cur][s].ci]) == 15 && wg_cards[g.board[cur][s].ci].r18 == (12 | (1 << 8u))) { has_ghold = true; break; }
          }
        }
        let tk = c_trn_kind(c);
        let sub = c_trn_sub(c);
        let tcond = c_trn_cond(c);
        let tv = c.r20;
        switch (tk) {
          case 1: {
            switch (sub) {
              case 1: { let n = clamp(tv, 1, 3); for (var l = 0; l < n; l = l + 1) { draw_one(cur); } }
              case 2: { search_deck_to_hand(cur, 0, 0, 0); }
              case 3: { let w = g.hand_len[foe]; shuffle_hand_into_deck(cur); for (var l = 0u; l < w; l = l + 1u) { draw_one(cur); } }
              case 4: {
                let mn = g.hand_len[cur]; let fn_ = g.hand_len[foe];
                shuffle_hand_into_deck(cur); shuffle_hand_into_deck(foe);
                for (var l = 0u; l < mn; l = l + 1u) { draw_one(cur); }
                for (var l = 0u; l < fn_; l = l + 1u) { draw_one(foe); }
              }
              case 5: {
                let cnt = clamp(tv, 1, 2);
                var got = 0;
                for (var l = 0; l < cnt; l = l + 1) { if (search_deck_to_hand(cur, 1, 0, 0)) { got = got + 1; } }
                for (var l = 0; l < got; l = l + 1) {
                  for (var k = 0u; k < g.hand_len[cur]; k = k + 1u) {
                    if (wg_cards[g.hands[cur][k]].r0 == 1) {
                      let pb = g.hands[cur][k];
                      g.hand_len[cur] = g.hand_len[cur] - 1u; g.hands[cur][k] = g.hands[cur][g.hand_len[cur]];
                      if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = pb; g.lib_len[cur] = g.lib_len[cur] + 1u; }
                      break;
                    }
                  }
                }
              }
              case 6: { search_deck_to_hand(cur, 2, 0, 0); search_deck_to_hand(cur, 2, 0, 0); }
              case 7: { search_deck_to_hand(cur, 3, 0, 0); }
              case 8: { search_deck_to_hand(cur, 4, 0, 0); }
              case 9, 23: { draw_one(cur); }
              case 10: {
                var h = flip_coin_g(&guar_heads);
                if (!h && has_ghold) { gholdengo_used = true; h = flip_coin_g(&guar_heads); }
                search_deck_to_hand(cur, select(6, 5, h), 0, 0);
              }
              case 11: {
                var h = flip_coin_g(&guar_heads);
                if (!h && has_ghold) { gholdengo_used = true; h = flip_coin_g(&guar_heads); }
                if (h) { search_deck_to_hand(cur, 5, 0, 0); }
              }
              case 12: {
                var mc = 0; for (var pp = 0u; pp < 2u; pp = pp + 1u) { for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (g.board[pp][ss].occ == 1 && c_is_mega(wg_cards[g.board[pp][ss].ci])) { mc = mc + 1; } } }
                for (var l = 0; l < mc; l = l + 1) { draw_one(cur); }
              }
              case 13: { search_deck_to_hand(cur, 7, 0, 0); }
              case 14, 15, 16: {
                let lim = min(4u, g.lib_len[cur]);
                var skip = 0u;
                for (var l = 0u; l < lim; l = l + 1u) {
                  if (g.lib_len[cur] <= skip) { break; }
                  let idxt = g.lib_len[cur] - 1u - skip;
                  let tci = g.libs[cur][idxt]; let tc = wg_cards[tci];
                  let ok = select(select(c_has_puppy(tc), c_is_tool(tc), sub == 15), tc.r0 == 1 && c_stage(tc) == 1, sub == 14);
                  if (ok && g.hand_len[cur] < 12u) {
                    g.lib_len[cur] = g.lib_len[cur] - 1u; g.libs[cur][idxt] = g.libs[cur][g.lib_len[cur]];
                    g.hands[cur][g.hand_len[cur]] = tci; g.hand_len[cur] = g.hand_len[cur] + 1u;
                  } else { skip = skip + 1u; }
                }
              }
              case 17: {
                if (g.lib_len[cur] > 0u) {
                  let tci = g.libs[cur][g.lib_len[cur] - 1u]; let tc = wg_cards[tci];
                  if (tc.r0 == 1 && c_has_type(tc, 4) && g.hand_len[cur] < 12u) {
                    g.lib_len[cur] = g.lib_len[cur] - 1u; g.hands[cur][g.hand_len[cur]] = tci; g.hand_len[cur] = g.hand_len[cur] + 1u;
                  }
                }
              }
              case 18: { let n = clamp(tv, 1, 2); for (var l = 0; l < n; l = l + 1) { search_deck_to_hand(cur, 10, c.r21, c.r22); } }
              case 19: { for (var l = 0u; l < 5u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { search_deck_to_hand(cur, 11, 0, 0); } else { break; } } }
              case 20: {
                var wn = 1;
                if (tv == 3) { wn = 0; for (var l = 0u; l < 3u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { wn = wn + 1; } } }
                var got = 0;
                for (var k = 0u; k < 20u; k = k + 1u) {
                  if (got >= wn || g.hand_len[cur] >= 12u) { break; }
                  let dci = cur * 20u + k; let dc = wg_cards[dci];
                  let ok = select(dc.r0 == 1 && c_has_type(dc, 2) && (tv == 3 || c_stage(dc) == 0), dc.r0 == 1 && c_stage(dc) == 0 && !c_is_fossil(dc), tv == 1);
                  if (ok) { g.hands[cur][g.hand_len[cur]] = dci; g.hand_len[cur] = g.hand_len[cur] + 1u; got = got + 1; }
                }
              }
              case 21: {
                for (var k = 0u; k < 20u; k = k + 1u) {
                  let oci = foe * 20u + k;
                  if (c_is_item(wg_cards[oci]) && g.hand_len[cur] < 12u) { g.hands[cur][g.hand_len[cur]] = oci; g.hand_len[cur] = g.hand_len[cur] + 1u; break; }
                }
              }
              case 22: {
                for (var l = 0u; l < 2u; l = l + 1u) {
                  if (g.hand_len[cur] > 0u) {
                    g.hand_len[cur] = g.hand_len[cur] - 1u;
                    if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = g.hands[cur][g.hand_len[cur]]; g.lib_len[cur] = g.lib_len[cur] + 1u; }
                  }
                }
                draw_one(cur);
              }
              default: {}
            }
          }
          case 2: {
            if (sub == 3) {
              if (!heal_blocked) {
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].energy > 0) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + 40); } }
              }
            } else if (sub == 6) { if (g.board[cur][0].occ == 1) { g.board[cur][0].status = g.board[cur][0].status & (~ST_SPECIAL_MASK); } }
            else if (sub == 7) {
              if (g.board[cur][0].occ == 1) {
                if (!heal_blocked) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + 10); }
                g.board[cur][0].status = g.board[cur][0].status & (~ST_SPECIAL_MASK);
              }
            } else if (sub == 8) {
              if (!heal_blocked && g.board[cur][0].occ == 1 && g.board[cur][0].hp < g.board[cur][0].max_hp) {
                g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + 20);
                var h = flip_coin_g(&guar_heads);
                if (!h && has_ghold) { gholdengo_used = true; h = flip_coin_g(&guar_heads); }
                if (h && g.hand_len[cur] < 12u) { g.hands[cur][g.hand_len[cur]] = ci; g.hand_len[cur] = g.hand_len[cur] + 1u; }
              }
            } else if (sub == 9) {
              var h = 0; for (var l = 0u; l < 6u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { h = h + 20; } else { break; } }
              if (!heal_blocked && g.board[cur][0].occ == 1 && h > 0) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + h); }
            } else if (sub == 15) {
              var any_d = false;
              for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_eevee_evo(wg_cards[g.board[cur][s].ci]) && g.board[cur][s].hp < g.board[cur][s].max_hp) { any_d = true; break; } }
              if (any_d && !heal_blocked) {
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_eevee_evo(wg_cards[g.board[cur][s].ci])) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + 20); } }
              } else { eevee_boost = eevee_boost + 10; }
            } else if (sub == 16) {
              for (var s = 0u; s < 4u; s = s + 1u) {
                if (g.board[cur][s].occ == 1 && g.board[cur][s].hp < g.board[cur][s].max_hp && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) {
                  let mv = min(40, g.board[cur][s].max_hp - g.board[cur][s].hp);
                  g.board[cur][s].hp = g.board[cur][s].hp + mv;
                  if (g.board[foe][0].occ == 1) { g.board[foe][0].hp = g.board[foe][0].hp - mv; ko_active_passive(foe, cur); }
                  break;
                }
              }
            } else {
              var best_s = 4u; var best_m = -1;
              for (var s = 0u; s < 4u; s = s + 1u) {
                if (g.board[cur][s].occ == 0) { continue; }
                let scard = wg_cards[g.board[cur][s].ci];
                var ok = true;
                if (sub == 2) { ok = c_has_type(scard, tcond - 1); }
                else if (sub == 4) { ok = s_stage(g.board[cur][s]) == 2; }
                else if (sub == 10) { ok = g.board[cur][s].energy > 0; }
                else if (sub == 11) { ok = c_has_type(scard, 4) && g.board[cur][s].energy >= 2; }
                else if (sub == 12 || sub == 13 || sub == 14) { ok = c_matches_hashes(scard, c.r21, c.r22); }
                if (ok) {
                  let miss = g.board[cur][s].max_hp - g.board[cur][s].hp;
                  if (miss > best_m) { best_m = miss; best_s = s; }
                }
              }
              if (best_s < 4u) {
                if (!heal_blocked && best_m > 0) {
                  let h = min(tv, g.board[cur][best_s].max_hp);
                  g.board[cur][best_s].hp = min(g.board[cur][best_s].max_hp, g.board[cur][best_s].hp + h);
                  if (sub == 10) { g.board[cur][best_s].energy = max(0, g.board[cur][best_s].energy - 1); g.energy_discarded[cur] = 1; }
                  else if (sub == 11) { g.board[cur][best_s].energy = max(0, g.board[cur][best_s].energy - 2); g.energy_discarded[cur] = 1; }
                  else if (sub == 12) { if (g.board[cur][best_s].energy > 0) { g.energy_discarded[cur] = 1; } g.board[cur][best_s].energy = 0; }
                }
                if (sub == 5) { g.board[cur][best_s].status = g.board[cur][best_s].status & (~ST_SPECIAL_MASK); }
                else if (sub == 13) { g.board[cur][best_s].status = g.board[cur][best_s].status & (~(ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)); }
              }
            }
          }
          case 3: {
            switch (sub) {
              case 1, 4: {
                let pick = best_bench_promote(foe);
                if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); g.board[foe][0].stack_boost = 0; let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
              }
              case 2: {
                var pick = 4u;
                for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && g.board[foe][bs].hp < g.board[foe][bs].max_hp && (pick == 4u || g.board[foe][bs].hp < g.board[foe][pick].hp)) { pick = bs; } }
                if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); g.board[foe][0].stack_boost = 0; let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
              }
              case 3: {
                var pick = 4u;
                for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && (pick == 4u || g.board[foe][bs].hp < g.board[foe][pick].hp)) { pick = bs; } }
                if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); g.board[foe][0].stack_boost = 0; let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
              }
              case 5: { shuffle_hand_into_deck(foe); draw_one(foe); draw_one(foe); draw_one(foe); }
              case 6: { shuffle_hand_into_deck(foe); let w = u32(max(1, 3 - g.points[foe])); for (var l = 0u; l < w; l = l + 1u) { draw_one(foe); } }
              case 7: { if (g.hand_len[foe] > 4u) { g.hand_len[foe] = 4u; } }
              case 8: {
                for (var k = 0u; k < g.hand_len[foe]; k = k + 1u) {
                  if (c_is_supporter(wg_cards[g.hands[foe][k]])) {
                    let sb = g.hands[foe][k]; g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][k] = g.hands[foe][g.hand_len[foe]];
                    if (g.lib_len[foe] < 20u) { g.libs[foe][g.lib_len[foe]] = sb; g.lib_len[foe] = g.lib_len[foe] + 1u; }
                    break;
                  }
                }
              }
              case 9: {
                if (g.hand_len[foe] > 0u) {
                  let ri = rng_next() % g.hand_len[foe];
                  let rb = g.hands[foe][ri]; g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][ri] = g.hands[foe][g.hand_len[foe]];
                  if (g.lib_len[foe] < 20u) { g.libs[foe][g.lib_len[foe]] = rb; g.lib_len[foe] = g.lib_len[foe] + 1u; }
                }
              }
              case 10: {
                for (var pp = 0u; pp < 2u; pp = pp + 1u) {
                  if (tv != 2 && pp != foe) { continue; }
                  for (var s = 0u; s < 4u; s = s + 1u) {
                    if (g.board[pp][s].occ == 1 && s_tool_cnt(g.board[pp][s]) > 0) {
                      let sc = wg_cards[g.board[pp][s].ci];
                      let hb = tool_hp_bonus(g.board[pp][s].tool, sc) + tool_hp_bonus(g.board[pp][s].tool2, sc);
                      g.board[pp][s].tool = 0; g.board[pp][s].tool2 = 0;
                      if (hb > 0) { g.board[pp][s].max_hp = max(10, g.board[pp][s].max_hp - hb); g.board[pp][s].hp = min(g.board[pp][s].hp, g.board[pp][s].max_hp); }
                    }
                  }
                }
              }
              case 11: {
                var did = false;
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (g.board[foe][s].occ == 1 && g.board[foe][s].tool != 0) {
                    let hb = tool_hp_bonus(g.board[foe][s].tool, wg_cards[g.board[foe][s].ci]);
                    g.board[foe][s].tool = 0;
                    if (hb > 0) { g.board[foe][s].max_hp = max(10, g.board[foe][s].max_hp - hb); g.board[foe][s].hp = min(g.board[foe][s].hp, g.board[foe][s].max_hp); }
                    did = true; break;
                  }
                }
                if (!did) {
                  if (g.stadium == 3) {
                    for (var pp = 0u; pp < 2u; pp = pp + 1u) { for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (g.board[pp][ss].occ == 1 && s_stage(g.board[pp][ss]) == 0) { g.board[pp][ss].max_hp = max(10, g.board[pp][ss].max_hp - 20); g.board[pp][ss].hp = min(g.board[pp][ss].hp, g.board[pp][ss].max_hp); } } }
                  }
                  g.stadium = 0;
                }
              }
              case 12: {
                if (g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0) {
                  var disc = 0;
                  if (tv == 99) {
                    for (var l = 0u; l < 6u; l = l + 1u) { if (g.board[foe][0].energy > 0 && flip_coin_g(&guar_heads)) { g.board[foe][0].energy = g.board[foe][0].energy - 1; disc = disc + 1; } else { break; } }
                  } else if (tv == 2) {
                    if (flip_coin_g(&guar_heads) && flip_coin_g(&guar_heads)) { g.board[foe][0].energy = g.board[foe][0].energy - 1; disc = 1; }
                  } else { g.board[foe][0].energy = g.board[foe][0].energy - 1; disc = 1; }
                  if (disc > 0) { g.energy_discarded[foe] = 1; }
                }
              }
              case 13: { if (g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0) { g.board[foe][0].energy = max(0, g.board[foe][0].energy - 2); g.energy_discarded[foe] = 1; } }
              case 14: {
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && c_ab_op(wg_cards[g.board[foe][s].ci]) != 0 && g.board[foe][s].energy > 0) { g.board[foe][s].energy = g.board[foe][s].energy - 1; g.energy_discarded[foe] = 1; break; } }
              }
              case 15: {
                apply_status(foe, 0u, ST_CONFUSE, turn_i, false);
                if (!flip_coin_g(&guar_heads)) { apply_status(cur, 0u, ST_CONFUSE, turn_i, false); }
              }
              case 16: { if (g.board[foe][0].occ == 1) { g.board[foe][0].retreat_tax = g.board[foe][0].retreat_tax + 1; } }
              case 17: {
                for (var bs = 1u; bs < 4u; bs = bs + 1u) {
                  if (g.board[foe][bs].occ == 0) {
                    for (var k = 0u; k < 20u; k = k + 1u) {
                      let oci = foe * 20u + k; let oc = wg_cards[oci];
                      if (oc.r0 == 1 && c_stage(oc) == 0 && !c_is_fossil(oc)) { g.board[foe][bs] = make_slot(oci, oc.r5, turn_i); break; }
                    }
                    break;
                  }
                }
              }
              case 18: {
                var ih = 0u;
                loop {
                  if (ih >= g.hand_len[foe]) { break; }
                  let hci = g.hands[foe][ih]; let hc = wg_cards[hci];
                  if (hc.r0 == 1 && c_stage(hc) == 0 && !c_is_fossil(hc)) {
                    var pl = false;
                    for (var bs = 1u; bs < 4u; bs = bs + 1u) {
                      if (g.board[foe][bs].occ == 0) {
                        g.board[foe][bs] = make_slot(hci, hc.r5, turn_i);
                        g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][ih] = g.hands[foe][g.hand_len[foe]];
                        pl = true; break;
                      }
                    }
                    if (pl) { continue; }
                  }
                  ih = ih + 1u;
                }
              }
              case 19: {
                for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && g.board[foe][bs].energy > 0) { g.board[foe][bs].energy = g.board[foe][bs].energy - 1; g.board[foe][0].energy = g.board[foe][0].energy + 1; break; } }
              }
              case 20: {
                let bci = g.board[cur][0].ci;
                if (g.board[cur][0].energy > 0) { g.energy_discarded[cur] = 1; }
                g.board[cur][0].occ = 0;
                let prom = best_bench_promote(cur);
                if (prom < 4u) { let t = g.board[cur][0]; g.board[cur][0] = g.board[cur][prom]; g.board[cur][prom] = t; g.board[cur][0].status = g.board[cur][0].status & (~ST_HAS_ATTACKED); }
                if (tv == 4) { if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = bci; g.lib_len[cur] = g.lib_len[cur] + 1u; } }
                else if (g.hand_len[cur] < 12u) { g.hands[cur][g.hand_len[cur]] = bci; g.hand_len[cur] = g.hand_len[cur] + 1u; }
              }
              default: {}
            }
          }
          case 4: {
            switch (sub) {
              case 1: { dmg_boost = dmg_boost + tv; }
              case 2, 3: { dmg_boost_ex = dmg_boost_ex + tv; }
              case 4, 5: { named_boost = named_boost + tv; named_h1 = c.r21; named_h2 = c.r22; }
              case 6: { g.team_shield[cur] = g.team_shield[cur] + tv; g.team_shield_type[cur] = select(255, tcond - 1, tcond > 0); }
              case 7: { g.team_shield[cur] = g.team_shield[cur] + 20; g.team_shield_type[cur] = 254; }
              case 8: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { g.board[cur][s].shield = g.board[cur][s].shield + 50; } } }
              case 9: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { g.board[cur][s].shield_ex = g.board[cur][s].shield_ex + 100; } } }
              case 10: { guar_heads = true; }
              case 11: { iris_active = true; iris_h1 = c.r21; }
              case 12: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { g.board[cur][s].status = g.board[cur][s].status | ST_SURVIVE_10; } } }
              case 13: { drayden_bonus = drayden_bonus + 1; }
              default: {}
            }
          }
          case 5: {
            for (var s = 0u; s < 4u; s = s + 1u) {
              if (g.board[cur][s].occ == 0) { continue; }
              let scard = wg_cards[g.board[cur][s].ci];
              let max_t = select(1, 2, ab_active(cur, s, turn_i) && c_ab_op(scard) == 15 && scard.r18 == 9);
              if (s_tool_cnt(g.board[cur][s]) >= max_t) { continue; }
              var ok = true;
              if (tv == 2) { ok = c_has_type(scard, 0); }
              else if (tv == 3) { ok = s_stage(g.board[cur][s]) == 1; }
              else if (tv == 4) { ok = c_is_ancient(scard); }
              else if (tv == 7 || tv == 10) { ok = s_stage(g.board[cur][s]) == 0; }
              else if (tv == 8) { ok = c_has_type(scard, 2); }
              else if (tv == 9) { ok = s_stage(g.board[cur][s]) == 2; }
              else if (tv == 11) { ok = c_retreat(scard) >= 3; }
              else if (tv == 12 || tv == 13) { ok = c_has_type(scard, 7); }
              else if (tv == 14) { ok = s > 0u; }
              else if (tv == 16) { ok = c_is_future(scard); }
              else if (tv == 17) { ok = c_name_hash(scard) == i32(u32(c.r21) & 65535u); }
              else if (tv == 18) { ok = c_is_ub(scard); }
              else if (tv == 19 || tv == 26) { ok = c_has_type(scard, 6); }
              else if (tv == 25) { ok = c_has_type(scard, 3); }
              if (ok) {
                if (g.board[cur][s].tool == 0) { g.board[cur][s].tool = tv; } else { g.board[cur][s].tool2 = tv; }
                let hb = tool_hp_bonus(tv, scard);
                if (hb > 0) { g.board[cur][s].max_hp = g.board[cur][s].max_hp + hb; g.board[cur][s].hp = g.board[cur][s].hp + hb; }
                if (tv == 12 && c_has_type(scard, 7)) { g.board[cur][s].status = g.board[cur][s].status & (~ST_SPECIAL_MASK); }
                break;
              }
            }
          }
          case 6: {
            switch (sub) {
              case 1: {
                var done = false;
                for (var hi2 = 0u; hi2 < g.hand_len[cur]; hi2 = hi2 + 1u) {
                  let evci = g.hands[cur][hi2]; let evc = wg_cards[evci];
                  if (evc.r0 == 1 && c_stage(evc) == 2) {
                    for (var s = 0u; s < 4u; s = s + 1u) {
                      if (g.board[cur][s].occ == 0 || (s == 0u && opp_aero_lock)) { continue; }
                      let eg_e = c_evo_group(evc); let eg_b = c_evo_group(wg_cards[g.board[cur][s].ci]);
                      if (s_stage(g.board[cur][s]) == 0 && (eg_e == 0 || eg_b == 0 || eg_b == eg_e) && g.board[cur][s].turn_placed < turn_i) {
                        let taken = max(0, g.board[cur][s].max_hp - g.board[cur][s].hp);
                        let bhp = tool_hp_bonus(g.board[cur][s].tool, evc) + tool_hp_bonus(g.board[cur][s].tool2, evc);
                        g.board[cur][s].ci = evci; g.board[cur][s].stage_ov = -1;
                        g.board[cur][s].max_hp = evc.r5 + bhp; g.board[cur][s].hp = max(10, g.board[cur][s].max_hp - taken);
                        g.board[cur][s].status = g.board[cur][s].status & (~ST_SPECIAL_MASK); g.board[cur][s].turn_placed = turn_i;
                        g.hand_len[cur] = g.hand_len[cur] - 1u; g.hands[cur][hi2] = g.hands[cur][g.hand_len[cur]];
                        done = true; break;
                      }
                    }
                    if (done) { break; }
                  }
                }
              }
              case 2: {
                let tf = max(0, tcond - 1);
                let mhlim = select(999, tv, tv > 0);
                var evolved = false;
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (g.board[cur][s].occ == 0 || g.board[cur][s].turn_placed >= turn_i || (s == 0u && opp_aero_lock)) { continue; }
                  let bc = wg_cards[g.board[cur][s].ci];
                  if (!c_has_type(bc, tf) || bc.r5 > mhlim) { continue; }
                  for (var li = 0u; li < g.lib_len[cur]; li = li + 1u) {
                    let evci = g.libs[cur][li]; let evc = wg_cards[evci];
                    let eg_e = c_evo_group(evc); let eg_b = c_evo_group(bc);
                    if (evc.r0 == 1 && c_stage(evc) == s_stage(g.board[cur][s]) + 1 && (eg_e == 0 || eg_b == 0 || eg_b == eg_e)) {
                      let taken = max(0, g.board[cur][s].max_hp - g.board[cur][s].hp);
                      let bhp = tool_hp_bonus(g.board[cur][s].tool, evc) + tool_hp_bonus(g.board[cur][s].tool2, evc);
                      g.board[cur][s].ci = evci; g.board[cur][s].stage_ov = -1;
                      g.board[cur][s].max_hp = evc.r5 + bhp; g.board[cur][s].hp = max(10, g.board[cur][s].max_hp - taken);
                      g.board[cur][s].status = g.board[cur][s].status & (~ST_SPECIAL_MASK); g.board[cur][s].turn_placed = turn_i;
                      g.lib_len[cur] = g.lib_len[cur] - 1u; g.libs[cur][li] = g.libs[cur][g.lib_len[cur]];
                      evolved = true; break;
                    }
                  }
                  if (evolved) { break; }
                }
              }
              case 3: { retreat_disc = retreat_disc + tv; }
              case 4: {
                let prom = best_bench_promote(cur);
                if (prom < 4u) {
                  g.board[cur][0].status = g.board[cur][0].status & (~ST_LEAVE_ACTIVE_CLEAR);
                  g.board[cur][0].stack_boost = 0;
                  let t = g.board[cur][0]; g.board[cur][0] = g.board[cur][prom]; g.board[cur][prom] = t;
                  g.board[cur][0].status = (g.board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
                }
              }
              case 5: {
                var h = 0; for (var l = 0u; l < 8u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { h = h + 1; } else { break; } }
                if (g.board[cur][0].occ == 1 && c_has_type(wg_cards[g.board[cur][0].ci], 2)) { g.board[cur][0].energy = g.board[cur][0].energy + h; }
              }
              case 6: {
                var h = flip_coin_g(&guar_heads);
                if (!h && has_ghold) { gholdengo_used = true; h = flip_coin_g(&guar_heads); }
                if (h) { for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], 3)) { g.board[cur][s].energy = g.board[cur][s].energy + 1; break; } } }
              }
              case 7: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 2) { g.board[cur][s].energy = g.board[cur][s].energy + 1; break; } } }
              case 8: { if (g.board[cur][0].occ == 1 && c_has_type(wg_cards[g.board[cur][0].ci], 1)) { g.board[cur][0].energy = g.board[cur][0].energy + 1; } }
              case 9: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_ub(wg_cards[g.board[cur][s].ci])) { g.board[cur][s].energy = g.board[cur][s].energy + 2; break; } } }
              case 10: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { g.board[cur][s].energy = g.board[cur][s].energy + 2; break; } } }
              case 11: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_is_ancient(wg_cards[g.board[cur][s].ci])) { g.board[cur][s].energy = g.board[cur][s].energy + 3; break; } } }
              case 12: { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { g.board[cur][s].energy = g.board[cur][s].energy + tv; } } }
              case 13: {
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_matches_hashes(wg_cards[g.board[cur][s].ci], c.r21, c.r22)) { g.board[cur][s].energy = g.board[cur][s].energy + 2; break; } }
                end_turn_now = true;
              }
              case 14: { for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].energy > 0) { g.board[cur][s].energy = g.board[cur][s].energy - 1; g.board[cur][0].energy = g.board[cur][0].energy + 1; break; } } }
              case 15: {
                var tot = 0; for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].energy > 0) { tot = tot + g.board[cur][s].energy; g.board[cur][s].energy = 0; } }
                g.board[cur][0].energy = g.board[cur][0].energy + tot;
              }
              case 16: { barry_disc = 2; barry_h1 = c.r21; barry_h2 = c.r22; }
              default: {}
            }
          }
          case 7: {
            if (g.stadium == 3 && tv != 3) {
              for (var pp = 0u; pp < 2u; pp = pp + 1u) { for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (g.board[pp][ss].occ == 1 && s_stage(g.board[pp][ss]) == 0) { g.board[pp][ss].max_hp = max(10, g.board[pp][ss].max_hp - 20); g.board[pp][ss].hp = min(g.board[pp][ss].hp, g.board[pp][ss].max_hp); } } }
            } else if (g.stadium != 3 && tv == 3) {
              for (var pp = 0u; pp < 2u; pp = pp + 1u) { for (var ss = 0u; ss < 4u; ss = ss + 1u) { if (g.board[pp][ss].occ == 1 && s_stage(g.board[pp][ss]) == 0) { g.board[pp][ss].max_hp = g.board[pp][ss].max_hp + 20; g.board[pp][ss].hp = g.board[pp][ss].hp + 20; } } }
            }
            g.stadium = tv;
          }
          default: {}
        }
        if (g.points[cur] >= 3 || g.board[foe][0].occ == 0) { g.done = 1u; g.outcome = select(0u, 1u, cur == 0u); g.end_turn = turn; states_buf[slot] = g; return; }
        if (end_turn_now) { break; }
      } else if (best_kind == 4u) {
        ability_used_mask = ability_used_mask | (1u << best_a);
        let ac = wg_cards[g.board[cur][best_a].ci];
        let ab_op = c_ab_op(ac);
        let ab_val = ac.r18;
        var end_turn_now = false;
        switch (ab_op) {
          case 3: {
            if (ab_val == 1) { g.board[cur][best_a].energy = g.board[cur][best_a].energy + 1; }
            else if (ab_val == 2) { g.board[cur][best_a].energy = g.board[cur][best_a].energy + 1; g.board[cur][best_a].hp = max(10, g.board[cur][best_a].hp - 20); }
            else if (ab_val == 3) { g.board[cur][best_a].energy = g.board[cur][best_a].energy + 2; g.board[cur][best_a].hp = max(10, g.board[cur][best_a].hp - 30); }
            else if (ab_val == 4) { g.board[cur][best_a].energy = g.board[cur][best_a].energy + 1; end_turn_now = true; }
          }
          case 4: { if (g.board[cur][0].occ == 1) { g.board[cur][0].energy = g.board[cur][0].energy + 1; } }
          case 8: {
            let ds = ab_val & 255;
            let ao = ((ab_val >> 8u) & 255) != 0;
            var ts = 0u;
            if (!ao) {
              for (var s = 1u; s < 4u; s = s + 1u) {
                if (g.board[foe][s].occ == 1 && !bench_dmg_blocked(foe, s, false, turn_i) && (g.board[foe][ts].occ == 0 || g.board[foe][s].hp < g.board[foe][ts].hp)) { ts = s; }
              }
            }
            if (g.board[foe][ts].occ == 1 && !bench_dmg_blocked(foe, ts, false, turn_i)) {
              g.board[foe][ts].hp = g.board[foe][ts].hp - ds;
              if (ts == 0u) { ko_active_passive(foe, cur); }
              else { handle_bench_ko(foe, cur, ts, false, turn_i); }
            }
          }
          case 12: { if (g.board[cur][best_a].energy > 0) { g.board[cur][best_a].energy = g.board[cur][best_a].energy - 1; g.energy_discarded[cur] = 1; dmg_boost = dmg_boost + 50; } }
          case 14: {
            let amt = ab_val & 255; let mode = (ab_val >> 8u) & 255;
            if (mode <= 1) { if (!heal_blocked && g.board[cur][0].occ == 1) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + amt); } }
            else if (mode == 2) {
              if (!heal_blocked) {
                let tf = i32((u32(ab_val) >> 16u) & 255u);
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && (tf == 255 || c_has_type(wg_cards[g.board[cur][s].ci], tf))) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + amt); } }
              }
            } else if (mode == 3) {
              if (!heal_blocked && g.board[cur][0].occ == 1 && g.board[cur][0].energy > 0) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + 60); g.board[cur][0].energy = g.board[cur][0].energy - 1; g.energy_discarded[cur] = 1; }
            } else if (mode == 4 && g.board[cur][0].occ == 1 && best_a > 0u) {
              let mv = max(0, min(min(g.board[cur][0].max_hp - g.board[cur][0].hp, 30), g.board[cur][best_a].hp - 10));
              g.board[cur][0].hp = g.board[cur][0].hp + mv; g.board[cur][best_a].hp = g.board[cur][best_a].hp - mv;
            } else if (mode == 5 && g.board[cur][0].occ == 1 && best_a > 0u) {
              let mv = max(0, min(g.board[cur][0].max_hp - g.board[cur][0].hp, g.board[cur][best_a].hp - 10));
              g.board[cur][0].hp = g.board[cur][0].hp + mv; g.board[cur][best_a].hp = g.board[cur][best_a].hp - mv;
            } else if (mode == 6 && g.board[cur][0].occ == 1) { g.board[cur][0].status = g.board[cur][0].status & (~ST_SPECIAL_MASK); }
          }
          case 16: {
            if (ab_val == 1 || ab_val == 5 || ab_val == 6 || ab_val == 7) {
              let prom = best_bench_promote(cur);
              if (prom < 4u) { g.board[cur][0].status = g.board[cur][0].status & (~ST_LEAVE_ACTIVE_CLEAR); g.board[cur][0].stack_boost = 0; let t = g.board[cur][0]; g.board[cur][0] = g.board[cur][prom]; g.board[cur][prom] = t; g.board[cur][0].status = (g.board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED); }
            } else if (ab_val == 2) {
              for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[cur][bs].occ == 1 && g.board[cur][bs].energy > 0) { g.board[cur][0].energy = g.board[cur][0].energy + g.board[cur][bs].energy; g.board[cur][bs].energy = 0; break; } }
            } else if (ab_val == 3) {
              for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[cur][bs].occ == 1 && g.board[cur][bs].energy > 0) { g.board[cur][bs].energy = g.board[cur][bs].energy - 1; g.board[cur][0].energy = g.board[cur][0].energy + 1; break; } }
            } else if (ab_val == 4) {
              var tot = 0; for (var k = 0u; k < 4u; k = k + 1u) { if (k != best_a && g.board[cur][k].occ == 1 && g.board[cur][k].energy > 0) { tot = tot + g.board[cur][k].energy; g.board[cur][k].energy = 0; } }
              g.board[cur][best_a].energy = g.board[cur][best_a].energy + tot;
            }
          }
          case 19: {
            if (ab_val == 1 || ab_val == 4) {
              let pick = best_bench_promote(foe);
              if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
            } else if (ab_val == 2) {
              var pick = 4u; for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && g.board[foe][bs].hp < g.board[foe][bs].max_hp) { pick = bs; break; } }
              if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
            } else if (ab_val == 3) {
              var pick = 4u; for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1 && s_stage(g.board[foe][bs]) == 0) { pick = bs; break; } }
              if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
            } else if (ab_val == 5) {
              if (flip_coin_g(&guar_heads)) {
                let pick = best_bench_promote(foe);
                if (pick < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
              }
            } else if (ab_val == 6) { search_deck_to_hand(cur, 1, 0, 0); }
            else if (ab_val == 7) { search_deck_to_hand(cur, 6, 0, 0); }
            else if (ab_val == 8 || ab_val == 19) { draw_one(cur); }
            else if (ab_val == 9) { if (g.hand_len[cur] > 0u) { g.hand_len[cur] = g.hand_len[cur] - 1u; draw_one(cur); } }
            else if (ab_val == 10) { if (g.hand_len[cur] < 12u) { g.hands[cur][g.hand_len[cur]] = 40u; g.hand_len[cur] = g.hand_len[cur] + 1u; } }
            else if (ab_val == 11) { apply_status(foe, 0u, ST_POISON, turn_i, false); }
            else if (ab_val == 12) { apply_status(foe, 0u, ST_BURN, turn_i, false); }
            else if (ab_val == 13) { if (flip_coin_g(&guar_heads)) { apply_status(foe, 0u, ST_SLEEP, turn_i, false); } }
            else if (ab_val == 14) { if (flip_coin_g(&guar_heads)) { apply_status(foe, 0u, ST_POISON, turn_i, false); } }
            else if (ab_val == 15) { apply_status(foe, 0u, ST_CONFUSE, turn_i, false); }
            else if (ab_val == 16) {
              let r = rng_next() % 3u;
              let stm = select(select(ST_POISON, ST_CONFUSE, r == 1u), ST_BURN, r == 0u);
              apply_status(foe, 0u, stm, turn_i, false);
            } else if (ab_val == 17) { if (g.lib_len[foe] > 0u) { g.lib_len[foe] = g.lib_len[foe] - 1u; } }
            else if (ab_val == 18) {
              if (g.board[foe][0].occ == 1 && s_tool_cnt(g.board[foe][0]) > 0) {
                let fc = wg_cards[g.board[foe][0].ci];
                let hb = tool_hp_bonus(g.board[foe][0].tool, fc) + tool_hp_bonus(g.board[foe][0].tool2, fc);
                g.board[foe][0].tool = 0; g.board[foe][0].tool2 = 0;
                if (hb > 0) { g.board[foe][0].max_hp = max(10, g.board[foe][0].max_hp - hb); g.board[foe][0].hp = min(g.board[foe][0].hp, g.board[foe][0].max_hp); }
                g.board[cur][best_a].occ = 0;
              }
            }
          }
          default: {}
        }
        if (g.points[cur] >= 3 || g.board[foe][0].occ == 0) { g.done = 1u; g.outcome = select(0u, 1u, cur == 0u); g.end_turn = turn; states_buf[slot] = g; return; }
        if (end_turn_now) { break; }
      } else if (best_kind == 5u) {
        energy_attached = true;
        g.board[cur][best_a].energy = g.board[cur][best_a].energy + 1;
        let tc = wg_cards[g.board[cur][best_a].ci];
        if (ab_active(cur, best_a, turn_i) && c_ab_op(tc) == 18 && tc.r18 == 99) {
          g.board[cur][best_a].max_hp = g.board[cur][best_a].max_hp + 30;
          g.board[cur][best_a].hp = g.board[cur][best_a].hp + 30;
        }
        if (best_a == 0u && (g.board[cur][0].status & ST_ATTACH_SLEEP) != 0u) { apply_status(cur, 0u, ST_SLEEP, turn_i, false); }
        if (ab_active(cur, best_a, turn_i) && c_ab_op(tc) == 7) {
          let av = tc.r18;
          if (av < 100 && g.board[foe][0].occ == 1) {
            g.board[foe][0].hp = g.board[foe][0].hp - av;
            ko_active_passive(foe, cur);
            if (g.points[cur] >= 3 || g.board[foe][0].occ == 0) { g.done = 1u; g.outcome = select(0u, 1u, cur == 0u); g.end_turn = turn; states_buf[slot] = g; return; }
          } else if (av >= 100 && av < 200 && !heal_blocked) {
            g.board[cur][best_a].hp = min(g.board[cur][best_a].max_hp, g.board[cur][best_a].hp + (av - 100));
          } else if (av == 200 && best_a == 0u) {
            apply_status(cur, 0u, ST_SLEEP, turn_i, false);
          } else if (av == 201) {
            for (var li = 0u; li < g.lib_len[cur]; li = li + 1u) {
              let evci = g.libs[cur][li]; let evc = wg_cards[evci];
              if (evc.r0 == 1 && c_stage(evc) == s_stage(g.board[cur][best_a]) + 1 && c_evo_group(evc) == c_evo_group(tc)) {
                let taken = max(0, g.board[cur][best_a].max_hp - g.board[cur][best_a].hp);
                let bhp = tool_hp_bonus(g.board[cur][best_a].tool, evc) + tool_hp_bonus(g.board[cur][best_a].tool2, evc);
                g.board[cur][best_a].ci = evci; g.board[cur][best_a].stage_ov = -1;
                g.board[cur][best_a].max_hp = evc.r5 + bhp; g.board[cur][best_a].hp = max(10, g.board[cur][best_a].max_hp - taken);
                g.board[cur][best_a].status = g.board[cur][best_a].status & (~ST_SPECIAL_MASK); g.board[cur][best_a].turn_placed = turn_i;
                g.lib_len[cur] = g.lib_len[cur] - 1u; g.libs[cur][li] = g.libs[cur][g.lib_len[cur]];
                break;
              }
            }
          }
        }
        if (g.board[foe][0].occ == 1 && ab_active(foe, 0u, turn_i) && c_ab_op(wg_cards[g.board[foe][0].ci]) == 20) {
          let jdmg = wg_cards[g.board[foe][0].ci].r18;
          if (!bench_dmg_blocked(cur, best_a, false, turn_i)) {
            g.board[cur][best_a].hp = g.board[cur][best_a].hp - jdmg;
            if (best_a == 0u) { ko_active_passive(cur, foe); }
            else { handle_bench_ko(cur, foe, best_a, false, turn_i); }
          }
          if (g.points[foe] >= 3 || g.board[cur][0].occ == 0) { g.done = 1u; g.outcome = select(0u, 1u, foe == 0u); g.end_turn = turn; states_buf[slot] = g; return; }
        }
      } else if (best_kind == 6u) {
        retreated = true;
        let pay = max(0, eff_retreat_cost(cur, turn_i, retreat_disc));
        let had_trap = (g.board[cur][0].status & ST_RETREAT_TRAP) != 0u;
        if (pay > 0) { g.energy_discarded[cur] = 1; }
        g.board[cur][0].energy = max(0, g.board[cur][0].energy - pay);
        g.board[cur][0].status = g.board[cur][0].status & (~ST_LEAVE_ACTIVE_CLEAR);
        g.board[cur][0].weaken = 0; g.board[cur][0].cost_tax = 0; g.board[cur][0].retreat_tax = 0;
        g.board[cur][0].next_atk_mod = 0; g.board[cur][0].stack_boost = 0;
        let tmp = g.board[cur][0]; g.board[cur][0] = g.board[cur][best_a]; g.board[cur][best_a] = tmp;
        g.board[cur][0].status = (g.board[cur][0].status | ST_SWITCHED_IN) & (~ST_HAS_ATTACKED);
        if (had_trap) {
          sync_ab(turn_i);
          g.board[cur][0].hp = g.board[cur][0].hp - 40;
          ko_active_passive(cur, foe);
        }
        if (g.points[foe] >= 3 || g.board[cur][0].occ == 0) { g.done = 1u; g.outcome = select(0u, 1u, foe == 0u); g.end_turn = turn; states_buf[slot] = g; return; }

      } else if (best_kind == 7u) {
        chosen_atk = i32(best_a);
        saved_ex_blk = active_ex_blocked;
        break;
      } else { break; }
    }

  // Save turn handoff into SimState for attack_checkup kernel
  g.pending_atk = chosen_atk;
  g.supporter_used = select(0u, 1u, supporter_used);
  g.guar_heads = select(0u, 1u, guar_heads);
  g.active_ex_blocked = select(0u, 1u, saved_ex_blk);
  g.heal_blocked = select(0u, 1u, heal_blocked);
  g.sweets_this_turn = sweets_this_turn;
  g.had_cant_atk_self = select(0u, 1u, had_cant_atk_self);
  g.had_cant_a1 = select(0u, 1u, had_cant_a1);
  g.had_cant_a2 = select(0u, 1u, had_cant_a2);
  g.cur_team_boost = cur_team_boost;
  g.dmg_boost = dmg_boost;
  g.dmg_boost_ex = dmg_boost_ex;
  g.named_boost = named_boost;
  g.named_h1 = named_h1;
  g.named_h2 = named_h2;
  g.eevee_boost = eevee_boost;
  g.iris_active = select(0u, 1u, iris_active);
  g.iris_h1 = iris_h1;
  g.drayden_bonus = drayden_bonus;
  states_buf[slot] = g;
}
`;

const WGSL_ATK_CHECKUP = /* wgsl */ `
const FEATURES: u32 = 22u;
const CARD_STRIDE: u32 = 28u;
const MAX_ENEMIES: u32 = 10u;

const H_ARCEUS: i32 = 1861;
const H_ARCEUS_EX: i32 = 7482;
const H_LATIAS: i32 = 49426;
const H_REGIROCK: i32 = 28242;
const H_REGICE: i32 = 49745;
const H_REGISTEEL: i32 = 4900;
const H_UXIE: i32 = 56213;
const H_AZELF: i32 = 51274;
const H_TANDEMAUS: i32 = 30786;
const H_MAUSHOLD: i32 = 61523;
const H_WISHIWASHI: i32 = 39722;
const H_WISHIWASHI_EX: i32 = 30145;
const H_POOCHYENA: i32 = 39334;
const H_SWEET_HONEY: i32 = 64227;
const H_RABOOT: i32 = 29145;
const H_UNOWN: i32 = 30635;
const H_PIKACHU_EX: i32 = 10636;
const H_VOLBEAT: i32 = 46637;

const AF_IGNORE_WEAKNESS: i32 = 1;
const AF_IGNORE_EFFECTS: i32 = 2;
const AF_NEED_SWITCHED_IN: i32 = 4;
const AF_DISCARD_HAND_1: i32 = 8;
const AF_DISCARD_HAND_2: i32 = 16;
const AF_REQUIRE_HP_OVER_60: i32 = 32;
const AF_REQUIRE_LAKE_TRIO: i32 = 64;
const AF_COST_1_IF_DAMAGED: i32 = 128;
const AF_COST_1_IF_DECK_EMPTY: i32 = 256;
const AF_FLIP_2_BOTH_TAILS_FAIL: i32 = 512;
const AF_FLIP_3_ALL_TAILS_FAIL: i32 = 1024;
const AF_FIRST_ATTACK_ONLY_EFF: i32 = 2048;
const AF_ONLY_IF_KO_RECOIL: i32 = 4096;
const AF_ONLY_IF_STADIUM_EFF: i32 = 8192;
const AF_ONLY_IF_KO_LAST_TURN_EFF: i32 = 16384;
const AF_ONLY_IF_EVOLVED_THIS_TURN_EFF: i32 = 32768;

const ST_POISON: u32 = 1u;
const ST_TOXIC20: u32 = 2u;
const ST_BURN: u32 = 4u;
const ST_SLEEP: u32 = 8u;
const ST_PARALYZE: u32 = 16u;
const ST_CONFUSE: u32 = 32u;
const ST_TOXIC40: u32 = 64u;
const ST_DEEP_SLEEP: u32 = 128u;
const ST_SPECIAL_MASK: u32 = 255u;
const ST_CANT_RETREAT: u32 = 256u;
const ST_CANT_ATK_SELF: u32 = 512u;
const ST_CANT_ATK_OPP: u32 = 1024u;
const ST_CANT_USE_A1: u32 = 2048u;
const ST_CANT_USE_A2: u32 = 4096u;
const ST_OPP_MISS_FLIP: u32 = 8192u;
const ST_PERM_MISS_FLIP: u32 = 16384u;
const ST_INVULN: u32 = 32768u;
const ST_DISGUISE_USED: u32 = 65536u;
const ST_HAS_ATTACKED: u32 = 131072u;
const ST_SWITCHED_IN: u32 = 262144u;
const ST_NO_WEAKNESS: u32 = 524288u;
const ST_NO_ABILITY: u32 = 1048576u;
const ST_ATTACH_SLEEP: u32 = 2097152u;
const ST_NO_ENERGY_ATTACH: u32 = 4194304u;
const ST_IMMUNE_BASIC: u32 = 8388608u;
const ST_IMMUNE_LE40: u32 = 16777216u;
const ST_SURVIVE_10: u32 = 33554432u;
const ST_RETREAT_TRAP: u32 = 67108864u;
const ST_DAMAGED_LAST: u32 = 134217728u;
const ST_LEAVE_ACTIVE_CLEAR: u32 = 255u | 256u | 512u | 1024u | 2048u | 4096u | 8192u | 16384u | 524288u | 1048576u | 2097152u | 4194304u | 8388608u | 16777216u | 67108864u;


struct Params {
  mode: u32,
  n_opps: u32,
  n_cands: u32,
  games_per_opp: u32,
  start_pair: u32,
  pair_count: u32,
  seed_base: u32,
  total_per_opp: u32,
  wave_start: u32,
  wave_count: u32,
  wg_x: u32,
  pad0: u32,
};

struct Card {
  r0: i32, r1: i32, r2: i32, r3: i32, r4: i32, r5: i32, r6: i32,
  r7: i32, r8: i32, r9: i32, r10: i32, r11: i32,
  r12: i32, r13: i32, r14: i32, r15: i32, r16: i32,
  r17: i32, r18: i32, r19: i32, r20: i32, r21: i32, r22: i32,
  power_q: i32,
  bonus_q: i32,
};

struct Slot {
  occ: i32,
  ci: u32,
  stage_ov: i32,
  hp: i32,
  max_hp: i32,
  energy: i32,
  tool: i32,
  tool2: i32,
  status: u32,
  shield: i32,
  shield_ex: i32,
  counter: i32,
  weaken: i32,
  cost_tax: i32,
  retreat_tax: i32,
  next_atk_mod: i32,
  stack_boost: i32,
  turn_placed: i32,
};


struct GameState {
  board: array<array<Slot, 4>, 2>,
  libs: array<array<u32, 20>, 2>,
  hands: array<array<u32, 12>, 2>,
  lib_len: array<u32, 2>,
  hand_len: array<u32, 2>,
  points: array<i32, 2>,
  pts_last_turn: array<i32, 2>,
  ko_count: array<i32, 2>,
  ko_last_turn: array<i32, 2>,
  item_lock: array<i32, 2>,
  supp_lock: array<i32, 2>,
  evo_lock: array<i32, 2>,
  team_shield: array<i32, 2>,
  team_shield_type: array<i32, 2>,
  next_team_boost: array<i32, 2>,
  sweets_used_last: array<i32, 2>,
  sweets_total: array<i32, 2>,
  energy_discarded: array<i32, 2>,
  disc_poke: array<i32, 2>,
  disc_poke_p: array<i32, 2>,
  disc_item: array<i32, 2>,
  disc_supp: array<i32, 2>,
  disc_tool: array<i32, 2>,
  disc_basic_w: array<i32, 2>,
  disc_basic_any: array<i32, 2>,
  disc_quick_grow: array<i32, 2>,
  disc_volbeat: array<i32, 2>,
  delayed_slot: array<u32, 2>,
  delayed_dmg: array<i32, 2>,
  rng: u32,
  stadium: i32,
  cur: u32,
  turn: u32,
  done: u32,
  outcome: u32,
  end_turn: u32,
  pending_atk: i32,
  supporter_used: u32,
  guar_heads: u32,
  active_ex_blocked: u32,
  heal_blocked: u32,
  sweets_this_turn: i32,
  had_cant_atk_self: u32,
  had_cant_a1: u32,
  had_cant_a2: u32,
  cur_team_boost: i32,
  dmg_boost: i32,
  dmg_boost_ex: i32,
  named_boost: i32,
  named_h1: i32,
  named_h2: i32,
  eevee_boost: i32,
  iris_active: u32,
  iris_h1: i32,
  drayden_bonus: i32,
  ab_mask: u32,
  pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> decks_buf: array<i32>;
@group(0) @binding(2) var<storage, read> weights_buf: array<i32>;
@group(0) @binding(3) var<storage, read_write> out_u32: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> out_sample: array<u32>;
@group(0) @binding(5) var<storage, read> cand_cards_buf: array<i32>;
@group(0) @binding(6) var<storage, read_write> states_buf: array<GameState>;

var<workgroup> wg_cards: array<Card, 41>;
var<workgroup> wg_w0: array<i32, 22>;
var<workgroup> wg_w1: array<i32, 22>;
var<private> g: GameState;
var<private> g_heal_blk: bool;

// --- Bitfield extraction helpers on Card ---
fn c_stage(c: Card) -> i32 { return c.r1 & 255; }
fn c_evo_group(c: Card) -> i32 { return i32((u32(c.r1) >> 8u) & 65535u); }
fn c_meta_hi(c: Card) -> i32 { return i32((u32(c.r1) >> 24u) & 255u); }
fn c_is_supporter(c: Card) -> bool { return (c_meta_hi(c) & 1) != 0; }
fn c_is_item(c: Card) -> bool { return (c_meta_hi(c) & 2) != 0; }
fn c_is_fossil(c: Card) -> bool { return (c_meta_hi(c) & 4) != 0; }
fn c_is_tool(c: Card) -> bool { return (c_meta_hi(c) & 8) != 0; }
fn c_is_stadium(c: Card) -> bool { return (c_meta_hi(c) & 16) != 0; }
fn c_is_mega(c: Card) -> bool { return (c_meta_hi(c) & 32) != 0; }
fn c_prize(c: Card) -> i32 { return max(1, i32((u32(c.r6) >> 8u) & 255u)); }
fn c_is_ex(c: Card) -> bool { return (c_meta_hi(c) & 64) != 0 || c_prize(c) >= 2; }
fn c_is_ub(c: Card) -> bool { return (c_meta_hi(c) & 128) != 0; }
fn c_tag_bits(c: Card) -> i32 { return i32(u32(c.r2) & 255u); }
fn c_name_hash(c: Card) -> i32 { return i32((u32(c.r2) >> 8u) & 65535u); }
fn c_type2(c: Card) -> i32 { return i32((u32(c.r2) >> 24u) & 255u); }
fn c_is_ancient(c: Card) -> bool { return (c_tag_bits(c) & 1) != 0; }
fn c_is_future(c: Card) -> bool { return (c_tag_bits(c) & 2) != 0; }
fn c_is_team_rocket(c: Card) -> bool { return (c_tag_bits(c) & 4) != 0; }
fn c_has_sweets(c: Card) -> bool { return (c_tag_bits(c) & 8) != 0; }
fn c_has_puppy(c: Card) -> bool { return (c_tag_bits(c) & 16) != 0; }
fn c_has_psychic(c: Card) -> bool { return (c_tag_bits(c) & 32) != 0; }
fn c_has_draco(c: Card) -> bool { return (c_tag_bits(c) & 64) != 0; }
fn c_is_eevee_evo(c: Card) -> bool { return (c_tag_bits(c) & 128) != 0; }
fn c_has_type(c: Card, tc: i32) -> bool { return c.r3 == tc || c_type2(c) == tc; }
fn c_retreat(c: Card) -> i32 { return c.r6 & 255; }
fn c_evfrom_hash(c: Card) -> i32 { return i32((u32(c.r6) >> 16u) & 65535u); }
fn c_a1_cost(c: Card) -> i32 { return c.r7 & 255; }
fn c_a1_flags(c: Card) -> i32 { return i32((u32(c.r7) >> 8u) & 65535u); }
fn c_a1_op1(c: Card) -> i32 { return c.r9 & 255; }
fn c_a1_op2(c: Card) -> i32 { return i32((u32(c.r9) >> 8u) & 255u); }
fn c_a1_aux(c: Card) -> i32 { return i32((u32(c.r9) >> 16u) & 65535u); }
fn c_a2_cost(c: Card) -> i32 { return c.r12 & 255; }
fn c_a2_flags(c: Card) -> i32 { return i32((u32(c.r12) >> 8u) & 65535u); }
fn c_a2_op1(c: Card) -> i32 { return c.r14 & 255; }
fn c_a2_op2(c: Card) -> i32 { return i32((u32(c.r14) >> 8u) & 255u); }
fn c_a2_aux(c: Card) -> i32 { return i32((u32(c.r14) >> 16u) & 65535u); }
fn c_ab_op(c: Card) -> i32 { return c.r17 & 255; }
fn c_ab_cond(c: Card) -> i32 { return i32((u32(c.r17) >> 8u) & 255u); }
fn c_ab_aux(c: Card) -> i32 { return i32((u32(c.r17) >> 16u) & 65535u); }
fn c_trn_kind(c: Card) -> i32 { return c.r19 & 255; }
fn c_trn_sub(c: Card) -> i32 { return i32((u32(c.r19) >> 8u) & 255u); }
fn c_trn_cond(c: Card) -> i32 { return i32((u32(c.r19) >> 16u) & 255u); }
fn c_matches_hashes(c: Card, h1: i32, h2: i32) -> bool {
  let nh = c_name_hash(c);
  if (nh == 0) { return false; }
  let a = i32(u32(h1) & 65535u);
  let b = i32((u32(h1) >> 16u) & 65535u);
  let cc = i32(u32(h2) & 65535u);
  let d = i32((u32(h2) >> 16u) & 65535u);
  return (a != 0 && nh == a) || (b != 0 && nh == b) || (cc != 0 && nh == cc) || (d != 0 && nh == d);
}

fn s_has_tool(sl: Slot, t: i32) -> bool { return sl.tool == t || sl.tool2 == t; }
fn s_tool_cnt(sl: Slot) -> i32 { return select(0, 1, sl.tool != 0) + select(0, 1, sl.tool2 != 0); }
fn s_stage(sl: Slot) -> i32 { return select(sl.stage_ov, c_stage(wg_cards[sl.ci]), sl.stage_ov < 0); }
fn make_slot(ci: u32, hp: i32, turn_p: i32) -> Slot {
  return Slot(1, ci, -1, hp, hp, 0, 0, 0, 0u, 0, 0, 0, 0, 0, 0, 0, 0, turn_p);
}
fn empty_slot() -> Slot {
  return Slot(0, 0u, -1, 0, 0, 0, 0, 0, 0u, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

fn est_atk_power_v3(dmg: i32, op1: i32, val1: i32) -> i32 {
  var d = dmg;
  let b0 = val1 & 255;
  let b1 = i32((u32(val1) >> 8u) & 255u);
  let b2 = i32((u32(val1) >> 16u) & 255u);
  switch (op1) {
    case 3: { d = select(select(d / 2, 35, b0 == 4), d + b1 / 2, b0 == 3); }
    case 4: {
      if ((b2 & 32) != 0) { d = d + (b1 * 3) / 2; }
      else if ((b2 & 8) != 0) { d = b1 * 2; }
      else if ((b2 & 6) != 0) { d = (b1 * 3) / 2; }
      else { d = select((b1 * b0) / 2, b1, b0 == 99); }
    }
    case 5: {
      if (b0 == 97) { d = d + 45; }
      else if (b0 == 98) { d = d + b1 / 4; }
      else if (b0 == 99) { d = d + b1; }
      else if (b2 == 2 || b2 == 3) { d = d + b1 * 2; }
      else { d = d + (b1 * b0) / 2; }
    }
    case 6: {
      if (b0 == 26) { d = b1 * 3; }
      else if (b0 == 31 || b0 == 32) { d = d + 50; }
      else if (b0 == 33) { d = max(20, d - 30); }
      else if (b0 == 2 || b0 == 5) { d = d + b1 * 4; }
      else { d = d + b1 * 2; }
    }
    case 7: {
      if (b0 == 3) { d = max(20, d - b1 / 3); }
      else { d = d + b1 / 2; }
    }
    case 8: {
      if (b0 == 2 || b0 == 3 || b0 == 4) { d = b1; }
      else if (b0 == 6) { d = b1 * 3; }
      else if (b0 == 8) { d = b1 * select(max(1, b2), 3, b2 == 99); }
      else if (b0 == 10) { d = (b1 * max(1, b2)) / 2; }
      else if (b0 == 11 || b0 == 14) { d = b1 * 2; }
      else if (b0 == 12) { d = select(b1, 140, b2 == 1); }
      else { d = d + b1 / 2; }
    }
    case 19: { if (b0 == 8) { d = d + b1; } }
    case 20: { d = select(select(60, 80, b0 == 6), 150, b0 == 1); }
    default: {}
  }
  return d;
}

fn load_card_vram(deck_slot: u32, idx: u32) -> Card {
  let o = (deck_slot * 20u + idx) * CARD_STRIDE;
  var c: Card;
  c.r0 = decks_buf[o]; c.r1 = decks_buf[o + 1u]; c.r2 = decks_buf[o + 2u];
  c.r3 = decks_buf[o + 3u]; c.r4 = decks_buf[o + 4u]; c.r5 = decks_buf[o + 5u];
  c.r6 = decks_buf[o + 6u]; c.r7 = decks_buf[o + 7u]; c.r8 = decks_buf[o + 8u];
  c.r9 = decks_buf[o + 9u]; c.r10 = decks_buf[o + 10u]; c.r11 = decks_buf[o + 11u];
  c.r12 = decks_buf[o + 12u]; c.r13 = decks_buf[o + 13u]; c.r14 = decks_buf[o + 14u];
  c.r15 = decks_buf[o + 15u]; c.r16 = decks_buf[o + 16u]; c.r17 = decks_buf[o + 17u];
  c.r18 = decks_buf[o + 18u]; c.r19 = decks_buf[o + 19u]; c.r20 = decks_buf[o + 20u];
  c.r21 = decks_buf[o + 21u]; c.r22 = decks_buf[o + 22u];
  let p1 = select(0, est_atk_power_v3(c.r8, c_a1_op1(c), c.r10), c_a1_cost(c) != 255);
  let p2 = select(0, est_atk_power_v3(c.r13, c_a2_op1(c), c.r15), c_a2_cost(c) != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = decks_buf[o + 24u];
  return c;
}

fn make_sweet_honey_card() -> Card {
  var c: Card;
  c.r0 = 0; c.r1 = i32(2u << 24u); c.r2 = i32((u32(H_SWEET_HONEY) << 8u) | (255u << 24u));
  c.r3 = 9; c.r4 = 255; c.r5 = 0; c.r6 = 256;
  c.r7 = 255; c.r8 = 0; c.r9 = 0; c.r10 = 0; c.r11 = 0;
  c.r12 = 255; c.r13 = 0; c.r14 = 0; c.r15 = 0; c.r16 = 0;
  c.r17 = 0; c.r18 = 0; c.r19 = 2 | (9 << 8u); c.r20 = 20; c.r21 = 0; c.r22 = 0;
  c.power_q = 0; c.bonus_q = 0;
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

fn rng_next() -> u32 {
  var x = g.rng;
  x = x ^ (x << 13u);
  x = x ^ (x >> 17u);
  x = x ^ (x << 5u);
  g.rng = x;
  return x * 0x27d4eb2du;
}

fn flip_coin_g(gh: ptr<function, bool>) -> bool {
  if (*gh) { *gh = false; return true; }
  return (rng_next() & 1u) == 1u;
}

fn flip_coin_plain() -> bool {
  return (rng_next() & 1u) == 1u;
}

fn get_w(cur: u32, k: u32) -> i32 {
  if (cur == 0u) { return wg_w0[k]; }
  return wg_w1[k];
}

fn tool_hp_bonus(t: i32, c: Card) -> i32 {
  if (t == 1) { return 20; }
  if (t == 2) { return select(0, 30, c_has_type(c, 0)); }
  if (t == 3) { return select(0, 30, c_stage(c) == 1); }
  if (t == 4) { return select(0, 40, c_is_ancient(c)); }
  return 0;
}


fn load_cand_vram(ci: u32) -> Card {
  let o = ci * CARD_STRIDE;
  var c: Card;
  c.r0 = cand_cards_buf[o]; c.r1 = cand_cards_buf[o + 1u]; c.r2 = cand_cards_buf[o + 2u];
  c.r3 = cand_cards_buf[o + 3u]; c.r4 = cand_cards_buf[o + 4u]; c.r5 = cand_cards_buf[o + 5u];
  c.r6 = cand_cards_buf[o + 6u]; c.r7 = cand_cards_buf[o + 7u]; c.r8 = cand_cards_buf[o + 8u];
  c.r9 = cand_cards_buf[o + 9u]; c.r10 = cand_cards_buf[o + 10u]; c.r11 = cand_cards_buf[o + 11u];
  c.r12 = cand_cards_buf[o + 12u]; c.r13 = cand_cards_buf[o + 13u]; c.r14 = cand_cards_buf[o + 14u];
  c.r15 = cand_cards_buf[o + 15u]; c.r16 = cand_cards_buf[o + 16u]; c.r17 = cand_cards_buf[o + 17u];
  c.r18 = cand_cards_buf[o + 18u]; c.r19 = cand_cards_buf[o + 19u]; c.r20 = cand_cards_buf[o + 20u];
  c.r21 = cand_cards_buf[o + 21u]; c.r22 = cand_cards_buf[o + 22u];
  let p1 = select(0, est_atk_power_v3(c.r8, c_a1_op1(c), c.r10), c_a1_cost(c) != 255);
  let p2 = select(0, est_atk_power_v3(c.r13, c_a2_op1(c), c.r15), c_a2_cost(c) != 255);
  c.power_q = (max(p1, p2) * 1024) / 100;
  c.bonus_q = cand_cards_buf[o + 24u];
  return c;
}

fn load_wg_cards(lid_x: u32, gid_y: u32, load_weights: bool) {
  if (params.mode == 0u) {
    let opp_idx = gid_y / params.n_cands;
    let cand_idx = gid_y % params.n_cands;
    if (opp_idx < params.n_opps) {
      if (lid_x < 20u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
      else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(opp_idx + 1u, lid_x - 20u); }
      else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
      if (load_weights && lid_x < 22u) {
        wg_w0[lid_x] = weights_buf[(MAX_ENEMIES + cand_idx) * FEATURES + lid_x];
        wg_w1[lid_x] = weights_buf[opp_idx * FEATURES + lid_x];
      }
    }
  } else if (params.mode == 1u) {
    if (lid_x < 20u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
    else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(1u, lid_x - 20u); }
    else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
    if (load_weights && lid_x < 22u) {
      wg_w0[lid_x] = weights_buf[MAX_ENEMIES * FEATURES + lid_x];
      wg_w1[lid_x] = weights_buf[lid_x];
    }
  } else {
    let ci = gid_y / params.n_opps;
    let opp_idx = gid_y % params.n_opps;
    if (ci < params.n_cands && opp_idx < params.n_opps) {
      if (lid_x < 19u) { wg_cards[lid_x] = load_card_vram(0u, lid_x); }
      else if (lid_x == 19u) { wg_cards[19u] = load_cand_vram(ci); }
      else if (lid_x < 40u) { wg_cards[lid_x] = load_card_vram(opp_idx + 1u, lid_x - 20u); }
      else if (lid_x == 40u) { wg_cards[40u] = make_sweet_honey_card(); }
      if (load_weights && lid_x < 22u) {
        wg_w0[lid_x] = weights_buf[MAX_ENEMIES * FEATURES + lid_x];
        wg_w1[lid_x] = weights_buf[opp_idx * FEATURES + lid_x];
      }
    }
  }
}

fn sync_ab(turn: i32) {
  var blk_b = false;
  var blk_h = false;
  let dz = u32(params.mode == 99u);
  for (var i = 0u; i < 8u + dz; i = i + 1u) {
    let sl = g.board[i >> 2u][i & 3u];
    if (sl.occ == 1 && (sl.status & ST_NO_ABILITY) == 0u) {
      let c = wg_cards[sl.ci];
      if (c_ab_op(c) == 17 && c.r18 == 7) { blk_b = true; }
    }
  }
  var m = 0u;
  for (var i = 0u; i < 8u + dz; i = i + 1u) {
    let p = i >> 2u; let s = i & 3u;
    let sl = g.board[p][s];
    if (sl.occ == 0 || (sl.status & ST_NO_ABILITY) != 0u) { continue; }
    let c = wg_cards[sl.ci];
    let aop = c_ab_op(c);
    if (aop == 0 || (s_stage(sl) == 0 && blk_b)) { continue; }
    if (aop == 17 && c.r18 == 6) { blk_h = true; }
    let cond = c_ab_cond(c);
    var ok = true;
    if (cond == 1) { ok = (s == 0u); }
    else if (cond == 2) { ok = (s > 0u); }
    else if (cond == 6) { ok = (s_tool_cnt(sl) > 0); }
    else if (cond == 7) { ok = (sl.hp >= sl.max_hp); }
    else if (cond == 8) { ok = (sl.hp <= 50); }
    else if (cond == 9) { ok = (g.stadium != 0); }
    else if (cond == 10) { ok = (turn <= 2); }
    else if (cond == 12) { ok = (sl.energy > 0); }
    else if (cond == 3 || cond == 4 || cond == 5 || cond == 11) {
      ok = false;
      let w1 = select(select(select(H_UNOWN, H_LATIAS, cond == 5), c_name_hash(c), cond == 4), H_ARCEUS, cond == 3);
      let w2 = select(w1, H_ARCEUS_EX, cond == 3);
      let excl = (cond == 4 || cond == 11);
      for (var k = 0u; k < 4u + dz; k = k + 1u) {
        if ((!excl || k != s) && g.board[p][k].occ == 1) {
          let nh = c_name_hash(wg_cards[g.board[p][k].ci]);
          if (nh == w1 || nh == w2) { ok = true; break; }
        }
      }
    }
    if (ok) { m = m | (1u << i); }
  }
  g.ab_mask = m;
  g_heal_blk = blk_h;
}

fn healing_blocked() -> bool { return g_heal_blk; }
fn ab_active(p: u32, s: u32, turn: i32) -> bool { return ((g.ab_mask >> (p * 4u + s)) & 1u) != 0u; }

fn count_bench(p: u32) -> i32 {
  var n = 0;
  for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[p][s].occ == 1) { n = n + 1; } }
  return n;
}

fn eff_energy(p: u32, s: u32, turn: i32) -> i32 {
  let e = g.board[p][s].energy;
  if (c_has_type(wg_cards[g.board[p][s].ci], 0)) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (ab_active(p, k, turn)) {
        let kc = wg_cards[g.board[p][k].ci];
        if (c_ab_op(kc) == 15 && kc.r18 == 8) { return e * 2; }
      }
    }
  }
  return e;
}

fn eff_retreat_cost(p: u32, turn: i32, disc: i32) -> i32 {
  let act = g.board[p][0];
  if (act.occ == 0) { return 99; }
  let foe = 1u - p;
  let ac = wg_cards[act.ci];
  if (s_stage(act) == 2 && s_has_tool(act, 9)) { return 0; }
  if (ab_active(p, 0u, turn) && c_ab_op(ac) == 15 && (ac.r18 & 255) == 7 && ((ac.r18 >> 8u) & 255) == 0) { return 0; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(p, k, turn)) {
      let kc = wg_cards[g.board[p][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 7) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 2) { return 0; }
        if (sub == 5 && c_name_hash(ac) == c_ab_aux(kc)) { return 0; }
      }
    }
  }
  var r = c_retreat(ac) + act.retreat_tax;
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (ab_active(foe, k, turn)) {
      let kc = wg_cards[g.board[foe][k].ci];
      if (c_ab_op(kc) == 15 && kc.r18 == 6) { r = r + 1; }
    }
  }
  for (var k = 1u; k < 4u; k = k + 1u) {
    if (ab_active(p, k, turn)) {
      let kc = wg_cards[g.board[p][k].ci];
      if (c_ab_op(kc) == 15 && (kc.r18 & 255) == 7) {
        let sub = (kc.r18 >> 8u) & 255;
        if (sub == 1 && s_stage(act) == 0) { r = r - 1; }
        else if (sub == 3 && c_has_type(ac, 6)) { r = r - 1; }
      }
    }
  }
  if (ab_active(p, 0u, turn) && c_ab_op(ac) == 15 && (ac.r18 & 255) == 7 && ((ac.r18 >> 8u) & 255) == 4) { r = r - 2; }
  if (s_stage(act) == 0 && s_has_tool(act, 7)) { r = r - 1; }
  if (c_has_type(ac, 2) && s_has_tool(act, 8)) { r = r - 1; }
  if (g.stadium == 4 && c_has_type(ac, 4)) { r = r - 2; }
  r = r - disc;
  return max(0, r);
}

fn best_bench_promote(p: u32) -> u32 {
  var best = 4u;
  var best_sc = -99999;
  for (var s = 1u; s < 4u; s = s + 1u) {
    if (g.board[p][s].occ == 1) {
      let sl = g.board[p][s];
      let sc = sl.hp + sl.energy * 35 + (wg_cards[sl.ci].power_q >> 4u);
      if (sc > best_sc) { best_sc = sc; best = s; }
    }
  }
  return best;
}

fn draw_one(p: u32) -> bool {
  if (g.lib_len[p] > 0u && g.hand_len[p] < 12u) {
    g.lib_len[p] = g.lib_len[p] - 1u;
    let ci = g.libs[p][g.lib_len[p]];
    g.hands[p][g.hand_len[p]] = ci;
    g.hand_len[p] = g.hand_len[p] + 1u;
    return true;
  }
  return false;
}

fn shuffle_hand_into_deck(p: u32) {
  let hl = g.hand_len[p];
  for (var hi = 0u; hi < hl; hi = hi + 1u) {
    if (g.lib_len[p] < 20u) {
      g.libs[p][g.lib_len[p]] = g.hands[p][hi];
      g.lib_len[p] = g.lib_len[p] + 1u;
    }
  }
  g.hand_len[p] = 0u;
  let n = g.lib_len[p];
  if (n > 1u) {
    for (var ii = 0u; ii < n - 1u; ii = ii + 1u) {
      let i = n - 1u - ii;
      let j = rng_next() % (i + 1u);
      let tmp = g.libs[p][i];
      g.libs[p][i] = g.libs[p][j];
      g.libs[p][j] = tmp;
    }
  }
}

fn search_deck_to_hand(p: u32, mode: i32, h1: i32, h2: i32) -> bool {
  if (g.hand_len[p] >= 12u || g.lib_len[p] == 0u) { return false; }
  var match_pos = 20u;
  var matches = 0u;
  let n = g.lib_len[p];
  for (var i = 0u; i < n; i = i + 1u) {
    let c = wg_cards[g.libs[p][i]];
    var ok = false;
    switch (mode) {
      case 0: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c); }
      case 1: { ok = c.r0 == 1 && !c_is_fossil(c); }
      case 2: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c) && c.r5 <= 50; }
      case 3: { ok = c.r0 == 1 && c_stage(c) == 2; }
      case 4: { ok = c.r0 == 1 && c_is_mega(c); }
      case 5: { ok = c.r0 == 0 && c_is_item(c); }
      case 6: { ok = c.r0 == 0 && c_is_tool(c); }
      case 7: { ok = c.r0 == 0 && c_is_stadium(c); }
      case 8: { ok = c.r0 == 0 && c_is_supporter(c); }
      case 9: { ok = c.r0 == 1 && c_stage(c) == 0 && !c_is_fossil(c) && c_has_type(c, 0); }
      case 10: { ok = c_matches_hashes(c, h1, h2); }
      case 11: { ok = c.r0 == 1 && c_is_team_rocket(c); }
      case 12: { ok = c.r0 == 1 && !c_is_fossil(c) && c_has_type(c, 4); }
      default: { ok = false; }
    }
    if (ok) {
      matches = matches + 1u;
      if ((rng_next() % matches) == 0u) { match_pos = i; }
    }
  }
  if (match_pos < n) {
    let found = g.libs[p][match_pos];
    g.lib_len[p] = n - 1u;
    g.libs[p][match_pos] = g.libs[p][n - 1u];
    g.hands[p][g.hand_len[p]] = found;
    g.hand_len[p] = g.hand_len[p] + 1u;
    return true;
  }
  return false;
}

fn has_status_immunity(p: u32, s: u32, turn: i32) -> bool {
  let sl = g.board[p][s];
  if (sl.occ == 0) { return true; }
  let c = wg_cards[sl.ci];
  if (s_has_tool(sl, 12) && c_has_type(c, 7)) { return true; }
  if (s_has_tool(sl, 15)) { return true; }
  if (ab_active(p, s, turn)) {
    if (c_ab_op(c) == 17 && c.r18 == 1) { return true; }
    if (c_ab_op(c) == 11 && ((c.r18 >> 8u) & 255) == 7) { return true; }
  }
  if (sl.energy > 0) {
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (ab_active(p, k, turn)) {
        let kc = wg_cards[g.board[p][k].ci];
        if (c_ab_op(kc) == 17 && kc.r18 == 2) { return true; }
      }
    }
  }
  return false;
}

fn apply_status(p: u32, s: u32, mask: u32, turn: i32, by_atk: bool) {
  if (g.board[p][s].occ == 0) { return; }
  if (has_status_immunity(p, s, turn)) { return; }
  if (by_atk && (g.board[p][s].status & ST_INVULN) != 0u) { return; }
  var cur_st = g.board[p][s].status;
  if ((mask & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0u) {
    cur_st = cur_st & (~(ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE));
  }
  if ((mask & ST_TOXIC40) != 0u) { cur_st = cur_st & (~(ST_POISON | ST_TOXIC20)); }
  else if ((mask & ST_TOXIC20) != 0u && (cur_st & ST_TOXIC40) == 0u) { cur_st = cur_st & (~ST_POISON); }
  else if ((mask & ST_POISON) != 0u && (cur_st & (ST_TOXIC20 | ST_TOXIC40)) != 0u) { return; }
  g.board[p][s].status = cur_st | mask;
}

fn bench_dmg_blocked(p: u32, s: u32, by_atk: bool, turn: i32) -> bool {
  if (s == 0u) { return false; }
  if (s_has_tool(g.board[p][s], 14)) { return true; }
  if (by_atk && ab_active(p, s, turn)) {
    let c = wg_cards[g.board[p][s].ci];
    if (c_ab_op(c) == 11 && ((c.r18 >> 8u) & 255) == 6) { return true; }
  }
  return false;
}

fn record_discard_card(p: u32, ci: u32) {
  let c = wg_cards[ci];
  if (c.r0 == 1 && !c_is_fossil(c)) {
    g.disc_poke[p] = g.disc_poke[p] + 1;
    if (c_has_type(c, 4)) { g.disc_poke_p[p] = g.disc_poke_p[p] + 1; }
    if (c_stage(c) == 0) {
      g.disc_basic_any[p] = g.disc_basic_any[p] + 1;
      if (c_has_type(c, 2)) { g.disc_basic_w[p] = g.disc_basic_w[p] + 1; }
    }
    if (c_name_hash(c) == H_VOLBEAT) { g.disc_volbeat[p] = 1; }
  } else if (c.r0 == 0) {
    if (c_is_item(c)) {
      g.disc_item[p] = g.disc_item[p] + 1;
      if (c_trn_kind(c) == 6 && c_trn_sub(c) == 2 && c.r20 == 0) { g.disc_quick_grow[p] = 1; }
    } else if (c_is_supporter(c)) {
      g.disc_supp[p] = g.disc_supp[p] + 1;
    } else if (c_is_tool(c)) {
      g.disc_tool[p] = g.disc_tool[p] + 1;
    }
  }
}


fn ko_active_passive(victim: u32, winner: u32) -> bool {
  if (g.board[victim][0].occ == 0 || g.board[victim][0].hp > 0) { return false; }
  let v_slot = g.board[victim][0];
  let v_card = wg_cards[v_slot.ci];
  var zero_pts = false;
  if (ab_active(victim, 0u, 0) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 6) {
    if (flip_coin_plain()) { zero_pts = true; }
  }
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }
  let gained = select(c_prize(v_card), 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (!c_is_fossil(v_card)) { record_discard_card(victim, v_slot.ci); }
  g.board[victim][0].occ = 0;
  let prom = best_bench_promote(victim);
  if (prom < 4u) {
    let tmp = g.board[victim][0]; g.board[victim][0] = g.board[victim][prom]; g.board[victim][prom] = tmp;
    g.board[victim][0].status = g.board[victim][0].status & (~ST_HAS_ATTACKED);
  }
  return true;
}

fn handle_bench_ko(victim: u32, winner: u32, s: u32, by_atk: bool, turn: i32) -> bool {
  if (g.board[victim][s].occ == 0 || g.board[victim][s].hp > 0) { return false; }
  let v_slot = g.board[victim][s];
  let v_card = wg_cards[v_slot.ci];
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }
  var zero_pts = false;
  if (ab_active(victim, s, turn) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 6) {
    if (flip_coin_plain()) { zero_pts = true; }
  }
  let gained = select(c_prize(v_card), 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (by_atk) { g.ko_last_turn[victim] = 1; }
  if (by_atk && s_has_tool(v_slot, 27) && g.hand_len[victim] < 12u) {
    g.hands[victim][g.hand_len[victim]] = v_slot.ci;
    g.hand_len[victim] = g.hand_len[victim] + 1u;
  } else if (!c_is_fossil(v_card)) {
    record_discard_card(victim, v_slot.ci);
  }
  g.board[victim][s].occ = 0;
  return true;
}



fn handle_active_ko(victim: u32, winner: u32, by_atk: bool, extra_pt: i32, turn: i32) -> vec3<i32> {
  // returns vec3(was_ko, attacker_recoil, cursola_ko)
  if (g.board[victim][0].occ == 0 || g.board[victim][0].hp > 0) { return vec3<i32>(0, 0, 0); }
  let v_slot = g.board[victim][0];
  let v_card = wg_cards[v_slot.ci];

  if (by_atk) {
    if ((v_slot.status & ST_SURVIVE_10) != 0u) {
      g.board[victim][0].hp = 10;
      g.board[victim][0].status = g.board[victim][0].status & (~ST_SURVIVE_10);
      return vec3<i32>(0, 0, 0);
    }
    if (ab_active(victim, 0u, turn) && c_ab_op(v_card) == 13 && ((v_card.r18 >> 8u) & 255) == 8) {
      if (flip_coin_plain()) {
        g.board[victim][0].hp = 10;
        return vec3<i32>(0, 0, 0);
      }
    }
  }

  var rec_dmg = 0;
  var cursola_ko = 0;
  var zero_pts = false;
  if (ab_active(victim, 0u, turn) && c_ab_op(v_card) == 13) {
    let amt = v_card.r18 & 255;
    let mode = (v_card.r18 >> 8u) & 255;
    if (mode == 6) {
      if (flip_coin_plain()) { zero_pts = true; }
    } else if (by_atk) {
      if (mode == 3) { rec_dmg = amt; }
      else if (mode == 4) {
        for (var s = 0u; s < 4u; s = s + 1u) {
          if (g.board[winner][s].occ == 1 && !bench_dmg_blocked(winner, s, false, turn)) {
            g.board[winner][s].hp = g.board[winner][s].hp - 10;
          }
        }
      } else if (mode == 5) {
        let prom = best_bench_promote(victim);
        if (prom < 4u) { g.board[victim][prom].energy = g.board[victim][prom].energy + v_slot.energy; }
      } else if (mode == 7) {
        if (flip_coin_plain()) { cursola_ko = 1; }
      }
    }
  }

  if (by_atk && s_has_tool(v_slot, 25) && c_has_type(v_card, 3) && v_slot.energy > 0) {
    var left = min(2, v_slot.energy);
    for (var s = 1u; s < 4u; s = s + 1u) {
      if (left <= 0) { break; }
      if (g.board[victim][s].occ == 1) {
        g.board[victim][s].energy = g.board[victim][s].energy + 1;
        left = left - 1;
      }
    }
  }
  let had_lucky_egg = by_atk && s_has_tool(v_slot, 23);
  let had_rescue_scarf = by_atk && s_has_tool(v_slot, 27);
  if (v_slot.energy > 0) { g.energy_discarded[victim] = 1; }

  let gained = select(c_prize(v_card) + extra_pt, 0, zero_pts);
  g.points[winner] = g.points[winner] + gained;
  g.pts_last_turn[winner] = g.pts_last_turn[winner] + gained;
  g.ko_count[victim] = g.ko_count[victim] + 1;
  if (by_atk) { g.ko_last_turn[victim] = 1; }

  if (had_rescue_scarf && g.hand_len[victim] < 12u) {
    g.hands[victim][g.hand_len[victim]] = v_slot.ci;
    g.hand_len[victim] = g.hand_len[victim] + 1u;
  } else if (!c_is_fossil(v_card)) {
    record_discard_card(victim, v_slot.ci);
  }

  if (by_atk && g.board[winner][0].occ == 1 && s_has_tool(g.board[winner][0], 24)) {
    draw_one(winner);
  }
  if (by_atk && g.board[winner][0].occ == 1 && ab_active(winner, 0u, turn)) {
    let wc = wg_cards[g.board[winner][0].ci];
    if (c_ab_op(wc) == 21 && wc.r18 == 3) { g.board[winner][0].status = g.board[winner][0].status | ST_INVULN; }
  }

  g.board[victim][0].occ = 0;
  let prom = best_bench_promote(victim);
  if (prom < 4u) {
    let tmp = g.board[victim][0];
    g.board[victim][0] = g.board[victim][prom];
    g.board[victim][prom] = tmp;
    g.board[victim][0].status = g.board[victim][0].status & (~ST_HAS_ATTACKED);
  }
  if (had_lucky_egg) {
    for (var l = 0u; l < 5u; l = l + 1u) {
      if (g.hand_len[victim] >= 5u || g.lib_len[victim] == 0u) { break; }
      draw_one(victim);
    }
  }
  return vec3<i32>(1, rec_dmg, cursola_ko);
}


fn calc_passive_dmg_mods(
  cur: u32, foe: u32, atk_flags: i32, raw_d: i32,
  dmg_boost: i32, dmg_boost_ex: i32,
  named_boost: i32, named_h1: i32, named_h2: i32,
  eevee_boost: i32, cur_team_boost: i32, turn: i32
) -> i32 {
  let atk_sl = g.board[cur][0];
  let def_sl = g.board[foe][0];
  let atk_c = wg_cards[atk_sl.ci];
  let def_c = wg_cards[def_sl.ci];
  let ign_weak = (atk_flags & AF_IGNORE_WEAKNESS) != 0 || (def_sl.occ == 1 && (def_sl.status & ST_NO_WEAKNESS) != 0u);
  let ign_eff = (atk_flags & AF_IGNORE_EFFECTS) != 0;

  var add = dmg_boost + cur_team_boost + atk_sl.next_atk_mod + atk_sl.stack_boost;
  if (def_sl.occ == 1 && c_is_ex(def_c)) { add = add + dmg_boost_ex; }
  if (named_boost > 0 && c_matches_hashes(atk_c, named_h1, named_h2)) { add = add + named_boost; }
  if (eevee_boost > 0 && c_is_eevee_evo(atk_c)) { add = add + eevee_boost; }

  if (s_has_tool(atk_sl, 16) && c_is_future(atk_c)) { add = add + 20; }
  if (s_has_tool(atk_sl, 17) && c_name_hash(atk_c) == H_PIKACHU_EX) { add = add + 30; }
  if (s_has_tool(atk_sl, 18) && c_is_ub(atk_c)) { add = add + g.points[cur] * 10; }

  for (var k = 0u; k < 4u; k = k + 1u) {
    if (!ab_active(cur, k, turn)) { continue; }
    let ac = wg_cards[g.board[cur][k].ci];
    let op = c_ab_op(ac);
    if (op == 12) {
      let amt = ac.r18 & 255;
      let mode = (ac.r18 >> 8u) & 255;
      let tf = i32((u32(ac.r18) >> 16u) & 255u);
      if (mode == 0) {
        if (c_ab_cond(ac) == 13) {
          if (c_evfrom_hash(atk_c) == c_ab_aux(ac)) { add = add + amt; }
        } else if (tf == 255 || c_has_type(atk_c, tf)) {
          add = add + amt;
        }
      } else if (mode == 1 && k == 0u) {
        add = add + amt;
      } else if (mode == 3 && (c_has_type(atk_c, 4) || c_has_type(atk_c, 7))) {
        add = add + amt;
      }
    } else if (k == 0u && op == 11 && ((ac.r18 >> 8u) & 255) == 8) {
      add = add + 20;
    }
  }

  if (g.stadium == 2 && s_stage(atk_sl) == 1) { add = add + 10; }
  if (g.stadium == 5 && c_has_type(atk_c, 5) && def_sl.occ == 1 && c_is_ex(def_c)) { add = add + 20; }

  let is_weak = !ign_weak && def_sl.occ == 1 && def_c.r4 != 255 && c_has_type(atk_c, def_c.r4);
  if (is_weak) {
    if (g.stadium == 6 && !c_is_mega(atk_c)) { add = add + max(0, raw_d + add); }
    else { add = add + 20; }
  }

  var red = atk_sl.weaken;
  if (def_sl.occ == 1 && !ign_eff) {
    red = red + def_sl.shield;
    if (c_is_ex(atk_c)) { red = red + def_sl.shield_ex; }
    if (g.team_shield[foe] > 0) {
      let tst = g.team_shield_type[foe];
      if (tst == 255 || (tst == 254 && c_is_ub(def_c)) || c_has_type(def_c, tst)) {
        red = red + g.team_shield[foe];
      }
    }
    if (s_has_tool(def_sl, 10) && s_stage(def_sl) == 0) { red = red + 20; }
    if (s_has_tool(def_sl, 11) && c_retreat(def_c) >= 3) { red = red + 20; }
    if (s_has_tool(def_sl, 12) && c_has_type(def_c, 7)) { red = red + 10; }
    if (s_has_tool(def_sl, 13) && c_has_type(def_c, 7)) { red = red + 50; }

    var metal_team_done = false;
    for (var k = 0u; k < 4u; k = k + 1u) {
      if (!ab_active(foe, k, turn)) { continue; }
      let dc = wg_cards[g.board[foe][k].ci];
      if (c_ab_op(dc) == 11) {
        let amt = dc.r18 & 255;
        let mode = (dc.r18 >> 8u) & 255;
        let tf = i32((u32(dc.r18) >> 16u) & 255u);
        if ((mode == 0 || mode == 8) && k == 0u) { red = red + amt; }
        else if (mode == 1) {
          if (tf == 7) {
            if (c_has_type(def_c, 7) && !metal_team_done) { red = red + amt; metal_team_done = true; }
          } else if (tf == 255 || c_has_type(def_c, tf)) { red = red + amt; }
        } else if (mode == 2 && k == 0u) { red = red + amt; }
        else if (mode == 3 && k == 0u && (c_has_type(atk_c, 1) || c_has_type(atk_c, 2))) { red = red + amt; }
        else if (mode == 4 && k == 0u && c_has_type(atk_c, 5)) { red = red + amt; }
      }
    }
  }
  return add - red;
}


fn eval_cond_op7(
  cond_id: i32, extra: i32, aux: i32,
  cur: u32, foe: u32, atk_cost: i32, sup_used: bool, turn: i32
) -> bool {
  let act = g.board[cur][0];
  let foe_s = g.board[foe][0];
  let fc = wg_cards[foe_s.ci];
  switch (cond_id) {
    case 0: { return eff_energy(cur, 0u, turn) >= atk_cost + extra; }
    case 1: { return foe_s.occ == 1 && foe_s.hp < foe_s.max_hp; }
    case 2, 3: { return act.hp < act.max_hp; }
    case 4: { return act.hp >= act.max_hp; }
    case 5: { return act.hp <= extra; }
    case 6: {
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].hp < g.board[cur][s].max_hp) { return true; } }
      return false;
    }
    case 7: { return foe_s.occ == 1 && (foe_s.status & ST_SPECIAL_MASK) != 0u; }
    case 8: { return foe_s.occ == 1 && (foe_s.status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0u; }
    case 9: { return foe_s.occ == 1 && (foe_s.status & ST_BURN) != 0u; }
    case 10: { return foe_s.occ == 1 && (foe_s.status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0u; }
    case 11: { return foe_s.occ == 1 && (foe_s.status & ST_CONFUSE) != 0u; }
    case 12: { return foe_s.occ == 1 && c_is_ex(fc); }
    case 13: { return foe_s.occ == 1 && s_stage(foe_s) == 0; }
    case 14: { return foe_s.occ == 1 && s_stage(foe_s) > 0; }
    case 15: { return foe_s.occ == 1 && c_ab_op(fc) != 0; }
    case 16: { return foe_s.occ == 1 && s_tool_cnt(foe_s) > 0; }
    case 17: { return s_tool_cnt(act) > 0; }
    case 18: { return g.ko_last_turn[cur] != 0; }
    case 19: { return sup_used; }
    case 20: { return foe_s.occ == 1 && foe_s.hp > act.hp; }
    case 21: { return foe_s.occ == 1 && foe_s.hp < act.hp; }
    case 22: { return (act.status & ST_SWITCHED_IN) != 0u; }
    case 23: { return s_stage(act) > 0 && act.turn_placed == turn; }
    case 24: { return (act.status & ST_HAS_ATTACKED) == 0u; }
    case 25: { return g.stadium != 0; }
    case 26: { return act.energy + select(0, foe_s.energy, foe_s.occ == 1) >= extra; }
    case 27: {
      var tot = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { tot = tot + g.board[cur][s].energy; } }
      return tot >= extra;
    }
    case 28: { return foe_s.occ == 1 && act.energy > foe_s.energy; }
    case 29: { return foe_s.occ == 1 && act.energy == foe_s.energy; }
    case 30: { return foe_s.occ == 1 && act.energy > 0 && foe_s.energy > 0 && wg_cards[act.ci].r3 == fc.r3; }
    case 31: {
      let hc = g.hand_len[cur]; let hf = g.hand_len[foe];
      if (extra == 0) { return hc == 1u || hc == 3u || hc == 5u; }
      if (extra == 1) { return hc == 2u || hc == 4u || hc == 6u; }
      if (extra == 2) { return hf == 2u || hf == 4u || hf == 6u; }
      return hc == hf;
    }
    case 32: {
      let t1 = extra & 15; let t2 = (extra >> 4u) & 15;
      if (t2 == 14) {
        for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && c_has_type(wg_cards[g.board[foe][s].ci], t1)) { return true; } }
        return false;
      }
      return foe_s.occ == 1 && (c_has_type(fc, t1) || (t2 < 10 && c_has_type(fc, t2)));
    }
    case 33: {
      if (extra == 0) {
        for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_name_hash(wg_cards[g.board[cur][s].ci]) == aux) { return true; } }
        return false;
      }
      if (extra == 1) {
        for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 2) { return true; } }
        return false;
      }
      if (extra == 2) { return foe_s.occ == 1 && c_name_hash(fc) == aux; }
      if (extra == 3) { return foe_s.occ == 1 && c_is_team_rocket(fc); }
      if (extra == 4) { return count_bench(cur) < count_bench(foe); }
      return false;
    }
    case 34: { return g.sweets_used_last[cur] != 0; }
    case 35: { return select(g.points[foe] == 1, g.points[cur] == 0, extra == 0); }
    case 36: {
      for (var s = 1u; s < 4u; s = s + 1u) {
        if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 0 && c_has_type(wg_cards[g.board[cur][s].ci], 0)) { return true; }
      }
      return false;
    }
    case 37: { return (act.status & ST_DAMAGED_LAST) != 0u; }
    case 39: { return select(g.disc_quick_grow[cur] != 0, g.disc_volbeat[cur] != 0, extra == 1); }
    case 40: { return select(act.energy >= extra, act.energy > 0, extra >= 10); }
    default: { return false; }
  }
}

fn eval_count_op6(
  sub: i32, extra: i32, aux: i32, cur: u32, foe: u32, turn: i32
) -> i32 {
  switch (sub) {
    case 0: { return count_bench(cur); }
    case 1: { return count_bench(foe); }
    case 2: { return count_bench(cur) + count_bench(foe); }
    case 3: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], extra)) { n = n + 1; } }
      return n;
    }
    case 4: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) > 0) { n = n + 1; } }
      return n;
    }
    case 5: { return eff_energy(cur, 0u, turn); }
    case 6: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { n = n + g.board[cur][s].energy; } }
      return n;
    }
    case 7: { return select(0, g.board[foe][0].energy, g.board[foe][0].occ == 1); }
    case 8: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1) { n = n + g.board[foe][s].energy; } }
      return n;
    }
    case 9: { return select(0, c_retreat(wg_cards[g.board[foe][0].ci]), g.board[foe][0].occ == 1); }
    case 10: { return g.points[cur]; }
    case 11: { return g.points[foe]; }
    case 12: { return g.ko_count[cur]; }
    case 13: { return g.pts_last_turn[foe]; }
    case 14: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { n = n + s_tool_cnt(g.board[cur][s]); } }
      return n;
    }
    case 15: { return i32(g.hand_len[cur]); }
    case 16: { return select(g.disc_poke[cur], g.disc_poke_p[cur], extra == 4); }
    case 17: { return g.disc_item[cur]; }
    case 18: { return g.disc_supp[cur]; }
    case 19: {
      var n = 0;
      for (var i = 0u; i < g.lib_len[foe]; i = i + 1u) { if (wg_cards[g.libs[foe][i]].r0 == 0) { n = n + 1; } }
      return n;
    }
    case 20: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && c_ab_op(wg_cards[g.board[foe][s].ci]) != 0) { n = n + 1; } }
      return n;
    }
    case 21: {
      if (g.board[foe][0].occ == 0) { return 0; }
      let st_m = g.board[foe][0].status;
      var n = 0;
      if ((st_m & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0u) { n = n + 1; }
      if ((st_m & ST_BURN) != 0u) { n = n + 1; }
      if ((st_m & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0u) { n = n + 1; }
      return n;
    }
    case 22: { return g.sweets_total[cur]; }
    case 23: {
      var n = 0;
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_puppy(wg_cards[g.board[cur][s].ci])) { n = n + 1; } }
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) { if (c_has_puppy(wg_cards[g.hands[cur][hi]])) { n = n + 1; } }
      return n;
    }
    case 24: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) {
        if (g.board[cur][s].occ == 1) {
          let nh = c_name_hash(wg_cards[g.board[cur][s].ci]);
          if (extra == 1) { if (nh == H_WISHIWASHI || nh == H_WISHIWASHI_EX) { n = n + 1; } }
          else if (nh == aux) { n = n + 1; }
        }
      }
      return n;
    }
    case 25: { return min(3, g.board[cur][0].energy); }
    case 26: { return g.board[cur][0].energy; }
    case 27: {
      var n = 0;
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) { if (c_is_tool(wg_cards[g.hands[cur][hi]])) { n = n + 1; } }
      return min(2, n);
    }
    case 28: {
      var n = 0;
      for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], 2)) { n = n + 1; } }
      return n;
    }
    case 29: {
      var n = 0;
      for (var hi = 0u; hi < g.hand_len[cur]; hi = hi + 1u) { if (c_name_hash(wg_cards[g.hands[cur][hi]]) == H_SWEET_HONEY) { n = n + 1; } }
      return n;
    }
    case 30: {
      let top_n = u32(extra & 15);
      let filt = (extra >> 4u) & 15;
      let lim = min(top_n, g.lib_len[cur]);
      var n = 0;
      for (var k = 0u; k < lim; k = k + 1u) {
        let c = wg_cards[g.libs[cur][g.lib_len[cur] - 1u - k]];
        if (filt == 1) { if (c.r0 == 1 && c_is_team_rocket(c)) { n = n + 1; } }
        else if (c.r0 == 1 && c_retreat(c) >= 3) { n = n + 1; }
      }
      return n;
    }
    case 31: { return max(0, g.board[cur][0].max_hp - g.board[cur][0].hp); }
    case 32: { return max(0, g.board[cur][0].hp); }
    case 33: { return -max(0, g.board[cur][0].max_hp - g.board[cur][0].hp); }
    default: { return 0; }
  }
}


@compute @workgroup_size(64)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  load_wg_cards(lid.x, gid.y, false);
  workgroupBarrier();

  let slot = gid.y * (params.wg_x * 64u) + gid.x;
  if (states_buf[slot].done != 0u) { return; }

  g = states_buf[slot];
  let dz = u32(params.mode == 99u);
  let cur = g.cur;
  let foe = 1u - cur;
  let turn = g.turn;
  let turn_i = i32(turn);

  let supporter_used = g.supporter_used != 0u;
  var guar_heads = g.guar_heads != 0u;
  let active_ex_blocked = g.active_ex_blocked != 0u;
  let heal_blocked = g.heal_blocked != 0u;
  var sweets_this_turn = g.sweets_this_turn;
  let had_cant_atk_self = g.had_cant_atk_self != 0u;
  let had_cant_a1 = g.had_cant_a1 != 0u;
  let had_cant_a2 = g.had_cant_a2 != 0u;
  let cur_team_boost = g.cur_team_boost;
  let dmg_boost = g.dmg_boost;
  let dmg_boost_ex = g.dmg_boost_ex;
  let named_boost = g.named_boost;
  let named_h1 = g.named_h1;
  let named_h2 = g.named_h2;
  let eevee_boost = g.eevee_boost;
  let iris_active = g.iris_active != 0u;
  let iris_h1 = g.iris_h1;
  let drayden_bonus = g.drayden_bonus;

  if (g.pending_atk >= 0) {
        let atk_idx = u32(g.pending_atk);
        let atk_c = wg_cards[g.board[cur][0].ci];
        var ac = select(c_a2_cost(atk_c), c_a1_cost(atk_c), atk_idx == 0u);
        var af = select(c_a2_flags(atk_c), c_a1_flags(atk_c), atk_idx == 0u);
        var ad = select(atk_c.r13, atk_c.r8, atk_idx == 0u);
        var ao1 = select(c_a2_op1(atk_c), c_a1_op1(atk_c), atk_idx == 0u);
        var av1 = select(atk_c.r15, atk_c.r10, atk_idx == 0u);
        var ao2 = select(c_a2_op2(atk_c), c_a1_op2(atk_c), atk_idx == 0u);
        var av2 = select(atk_c.r16, atk_c.r11, atk_idx == 0u);
        var aaux = select(c_a2_aux(atk_c), c_a1_aux(atk_c), atk_idx == 0u);

        // Genome Hacking / Copy Attack (op 20, b0 == 6)
        var copy_failed = false;
        if (ao1 == 20 && (av1 & 255) == 6) {
          let cmode = (av1 >> 8u) & 255;
          if (cmode == 1 && !flip_coin_g(&guar_heads)) { copy_failed = true; }
          else {
            var has_src = false;
            var src_ci = 0u;
            if (cmode == 3) {
              for (var s = 1u; s < 4u; s = s + 1u) {
                if (g.board[cur][s].occ == 1 && !c_is_ex(wg_cards[g.board[cur][s].ci]) && c_a1_cost(wg_cards[g.board[cur][s].ci]) != 255) {
                  src_ci = g.board[cur][s].ci; has_src = true; break;
                }
              }
            } else if (g.board[foe][0].occ == 1) { src_ci = g.board[foe][0].ci; has_src = true; }
            if (!has_src) { copy_failed = true; }
            else {
              let sc = wg_cards[src_ci];
              let pick2 = c_a2_cost(sc) != 255 && (sc.r13 >= sc.r8 || c_a1_cost(sc) == 255);
              if (pick2) {
                ac = c_a2_cost(sc); af = c_a2_flags(sc); ad = sc.r13;
                ao1 = c_a2_op1(sc); av1 = sc.r15; ao2 = c_a2_op2(sc); av2 = sc.r16; aaux = c_a2_aux(sc);
              } else if (c_a1_cost(sc) != 255) {
                ac = c_a1_cost(sc); af = c_a1_flags(sc); ad = sc.r8;
                ao1 = c_a1_op1(sc); av1 = sc.r10; ao2 = c_a1_op2(sc); av2 = sc.r11; aaux = c_a1_aux(sc);
              } else { copy_failed = true; }
              if (ao1 == 20 && (av1 & 255) == 6) { copy_failed = true; }
            }
          }
        }

        if ((af & AF_DISCARD_HAND_2) != 0) {
          for (var l = 0u; l < 2u; l = l + 1u) {
            if (g.hand_len[cur] > 0u) { g.hand_len[cur] = g.hand_len[cur] - 1u; record_discard_card(cur, g.hands[cur][g.hand_len[cur]]); }
          }
        } else if ((af & AF_DISCARD_HAND_1) != 0 && g.hand_len[cur] > 0u) {
          g.hand_len[cur] = g.hand_len[cur] - 1u; record_discard_card(cur, g.hands[cur][g.hand_len[cur]]);
        }

        if (c_has_sweets(atk_c)) { sweets_this_turn = 1; g.sweets_total[cur] = g.sweets_total[cur] + 1; }

        var has_victini = false;
        if (c_has_type(atk_c, 1)) {
          for (var s = 0u; s < 4u; s = s + 1u) {
            if (ab_active(cur, s, turn_i) && c_ab_op(wg_cards[g.board[cur][s].ci]) == 15 && wg_cards[g.board[cur][s].ci].r18 == 12) { has_victini = true; break; }
          }
        }

        var miss = false;
        var total_dmg = 0;
        var op1_heads = 0;
        let is_first_atk = (g.board[cur][0].status & ST_HAS_ATTACKED) == 0u;
        let was_evo_turn = s_stage(g.board[cur][0]) > 0 && g.board[cur][0].turn_placed == turn_i;

        if (copy_failed) { miss = true; }
        else if ((g.board[cur][0].status & ST_CONFUSE) != 0u && !flip_coin_g(&guar_heads)) { miss = true; }
        else if ((g.board[cur][0].status & (ST_OPP_MISS_FLIP | ST_PERM_MISS_FLIP)) != 0u && !flip_coin_g(&guar_heads)) { miss = true; }
        else if (ao1 == 3 && (av1 & 255) == 1) {
          var h = flip_coin_g(&guar_heads);
          if (!h && has_victini) { has_victini = false; h = flip_coin_g(&guar_heads); }
          if (!h) { miss = true; }
        } else if (ao1 == 14 && ((av1 >> 8u) & 255) == 8) {
          var h = flip_coin_g(&guar_heads);
          if (!h && has_victini) { has_victini = false; h = flip_coin_g(&guar_heads); }
          if (!h) { miss = true; }
        } else if ((af & AF_FLIP_2_BOTH_TAILS_FAIL) != 0 && ao1 != 11) {
          let h1 = flip_coin_g(&guar_heads); let h2 = flip_coin_g(&guar_heads);
          if (!h1 && !h2) { miss = true; }
        }

        let cur_next_mod = g.board[cur][0].next_atk_mod;
        g.board[cur][0].next_atk_mod = 0;

        if (!miss && g.board[foe][0].occ == 1 && ao1 == 17 && (av1 & 255) == 9) {
          let max_s = select(1u, 4u, ((av1 >> 8u) & 255) != 0);
          for (var s = 0u; s < max_s; s = s + 1u) {
            if (g.board[foe][s].occ == 1 && s_tool_cnt(g.board[foe][s]) > 0) {
              let fc = wg_cards[g.board[foe][s].ci];
              let hb = tool_hp_bonus(g.board[foe][s].tool, fc) + tool_hp_bonus(g.board[foe][s].tool2, fc);
              g.board[foe][s].tool = 0; g.board[foe][s].tool2 = 0;
              if (hb > 0) { g.board[foe][s].max_hp = max(10, g.board[foe][s].max_hp - hb); g.board[foe][s].hp = min(g.board[foe][s].hp, g.board[foe][s].max_hp); }
            }
          }
        }

        var active_took_dmg = false;
        var any_foe_ko = false;
        let extra_pt = select(0, 1, iris_active && c_matches_hashes(atk_c, iris_h1, 0));

        if (!miss && g.board[foe][0].occ == 1) {
          var raw_d = ad;
          var direct_active = true;
          let ign_eff = (af & AF_IGNORE_EFFECTS) != 0;
          let b0 = av1 & 255;
          let b1 = i32((u32(av1) >> 8u) & 255u);
          let b2 = i32((u32(av1) >> 16u) & 255u);

          // === PHASE 1: PRIMARY DAMAGE / TARGETING ===
          switch (ao1) {
            case 3: {
              if (b0 == 3) {
                var h = flip_coin_g(&guar_heads);
                if (!h && has_victini) { has_victini = false; h = flip_coin_g(&guar_heads); }
                if (h) { raw_d = ad + b1; } else { g.board[cur][0].hp = g.board[cur][0].hp - b2; }
              } else if (b0 == 4) {
                if (flip_coin_g(&guar_heads)) { raw_d = 70; }
                else { direct_active = false; if (!heal_blocked) { g.board[foe][0].hp = min(g.board[foe][0].max_hp, g.board[foe][0].hp + 30); } }
              }
            }
            case 4: {
              var heads = 0;
              var flips = b0;
              if ((b2 & 8) != 0) { flips = min(12, eff_energy(cur, 0u, turn_i)); }
              else if ((b2 & 2) != 0) { flips = 1 + count_bench(cur); }
              else if ((b2 & 4) != 0) {
                flips = 0;
                for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { let nh = c_name_hash(wg_cards[g.board[cur][s].ci]); if (nh == H_TANDEMAUS || nh == H_MAUSHOLD) { flips = flips + 1; } } }
              } else {
                if ((b2 & 1) != 0 && s_has_tool(g.board[cur][0], 24)) { flips = 4; }
                if ((b2 & 16) != 0) { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_name_hash(wg_cards[g.board[cur][s].ci]) == H_RABOOT) { flips = flips + 3; } } }
              }
              if (flips == 99) {
                for (var l = 0u; l < 10u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } else { break; } }
                if (heads == 0 && has_victini) { has_victini = false; for (var l = 0u; l < 10u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } else { break; } } }
              } else {
                let nf = clamp(flips, 0, 12);
                for (var l = 0; l < nf; l = l + 1) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } }
                if (heads == 0 && nf > 0 && has_victini) { has_victini = false; for (var l = 0; l < nf; l = l + 1) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } } }
              }
              op1_heads = heads;
              if ((b2 & 32) != 0) {
                let disc = min(heads, g.board[cur][0].energy);
                if (disc > 0) { g.board[cur][0].energy = g.board[cur][0].energy - disc; g.energy_discarded[cur] = 1; }
                raw_d = ad + disc * b1;
              } else { raw_d = b1 * heads; }
            }
            case 5: {
              var heads = 0;
              if (b0 == 97) {
                for (var l = 0u; l < 3u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } }
                raw_d = ad + select(select(select(0, 20, heads == 1), 50, heads == 2), 120, heads == 3);
              } else if (b0 == 98) {
                let h1 = flip_coin_g(&guar_heads); let h2 = flip_coin_g(&guar_heads);
                heads = select(0, 1, h1) + select(0, 1, h2);
                raw_d = ad + select(0, b1, heads == 2);
              } else if (b0 == 99) {
                for (var l = 0u; l < 10u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } else { break; } }
                raw_d = ad + b1 * heads;
              } else if (b2 == 2) {
                let n = min(10, eff_energy(cur, 0u, turn_i));
                for (var l = 0; l < n; l = l + 1) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } }
                raw_d = ad + b1 * heads;
              } else if (b2 == 3) {
                for (var l = 0u; l < 3u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } }
                let bd = b1 * heads;
                if (bd > 0) {
                  for (var s = 1u; s < 4u; s = s + 1u) {
                    if (g.board[foe][s].occ == 1 && !bench_dmg_blocked(foe, s, true, turn_i)) {
                      g.board[foe][s].hp = g.board[foe][s].hp - bd;
                      if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                    }
                  }
                }
              } else {
                let nf = clamp(b0, 1, 8);
                for (var l = 0; l < nf; l = l + 1) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } }
                if (heads == 0 && has_victini) { has_victini = false; for (var l = 0; l < nf; l = l + 1) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } } }
                raw_d = ad + b1 * heads;
              }
              op1_heads = heads;
            }
            case 6: {
              let cnt = eval_count_op6(b0, b2, aaux, cur, foe, turn_i);
              if (b0 == 26) {
                let disc = g.board[cur][0].energy;
                if (disc > 0) { g.board[cur][0].energy = 0; g.energy_discarded[cur] = 1; }
                raw_d = disc * b1;
              } else if (b0 == 27) {
                var disc = 0; var k = 0u;
                loop {
                  if (k >= g.hand_len[cur] || disc >= 2) { break; }
                  if (c_is_tool(wg_cards[g.hands[cur][k]])) {
                    disc = disc + 1; g.disc_tool[cur] = g.disc_tool[cur] + 1;
                    g.hand_len[cur] = g.hand_len[cur] - 1u; g.hands[cur][k] = g.hands[cur][g.hand_len[cur]];
                    continue;
                  }
                  k = k + 1u;
                }
                raw_d = disc * b1;
              } else if (b0 == 28) {
                var disc = 0;
                for (var s = 1u; s < 4u; s = s + 1u) {
                  if (g.board[cur][s].occ == 1 && c_has_type(wg_cards[g.board[cur][s].ci], 2)) {
                    if (g.board[cur][s].energy > 0) { g.energy_discarded[cur] = 1; }
                    g.disc_poke[cur] = g.disc_poke[cur] + 1;
                    g.board[cur][s].occ = 0; disc = disc + 1;
                  }
                }
                raw_d = ad + disc * b1;
              } else if (b0 == 33) { raw_d = max(0, ad + cnt); }
              else { raw_d = ad + cnt * b1; }
            }
            case 7: {
              if (b0 == 36) {
                var did = false;
                for (var s = 1u; s < 4u; s = s + 1u) {
                  if (g.board[cur][s].occ == 1 && s_stage(g.board[cur][s]) == 0 && c_has_type(wg_cards[g.board[cur][s].ci], 0)) {
                    if (g.board[cur][s].energy > 0) { g.energy_discarded[cur] = 1; }
                    g.disc_poke[cur] = g.disc_poke[cur] + 1; g.board[cur][s].occ = 0; did = true; break;
                  }
                }
                raw_d = ad + select(0, b1, did);
              } else if (b0 == 38) {
                var ok = false;
                if (g.lib_len[cur] > 0u) {
                  g.lib_len[cur] = g.lib_len[cur] - 1u;
                  let tci = g.libs[cur][g.lib_len[cur]]; let tc = wg_cards[tci];
                  record_discard_card(cur, tci);
                  ok = select(tc.r0 == 1 && c_has_type(tc, 5), c_is_item(tc), b2 == 0);
                }
                raw_d = ad + select(0, b1, ok);
              } else {
                let ok = eval_cond_op7(b0, b2, aaux, cur, foe, ac, supporter_used, turn_i);
                if (b0 == 3) { raw_d = select(ad, max(0, ad - b1), ok); }
                else { raw_d = ad + select(0, b1, ok); }
              }
            }
            case 8: {
              if (b0 == 2 || b0 == 3 || b0 == 4) {
                direct_active = false;
                var ts = 4u; let st_s = select(0u, 1u, b0 == 3);
                for (var s = st_s; s < 4u; s = s + 1u) {
                  if (g.board[foe][s].occ == 0) { continue; }
                  if (s > 0u && bench_dmg_blocked(foe, s, true, turn_i)) { continue; }
                  if (b0 == 4 && g.board[foe][s].hp >= g.board[foe][s].max_hp) { continue; }
                  let blk = s == 0u && active_ex_blocked && !ign_eff;
                  if (!blk && (ts == 4u || g.board[foe][s].hp < g.board[foe][ts].hp)) { ts = s; }
                }
                if (ts < 4u) {
                  g.board[foe][ts].hp = g.board[foe][ts].hp - b1;
                  if (ts == 0u) { total_dmg = b1; }
                  else if (handle_bench_ko(foe, cur, ts, true, turn_i)) { any_foe_ko = true; }
                }
              } else if (b0 == 6) {
                direct_active = false; let per = b1 + cur_next_mod;
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (g.board[foe][s].occ == 0) { continue; }
                  if (s == 0u && active_ex_blocked && !ign_eff) { continue; }
                  if (s > 0u && bench_dmg_blocked(foe, s, true, turn_i)) { continue; }
                  g.board[foe][s].hp = g.board[foe][s].hp - per;
                  if (s == 0u) { total_dmg = per; }
                  else if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                }
              } else if (b0 == 8) {
                direct_active = false;
                var times = select(max(1, b2), min(10, eff_energy(cur, 0u, turn_i)), b2 == 99);
                if (c_has_draco(atk_c)) { times = times + drayden_bonus; }
                var thit = 0;
                for (var l = 0; l < times; l = l + 1) {
                  var oidx = array<u32, 4>(0u, 0u, 0u, 0u); var on = 0u;
                  for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && g.board[foe][s].hp > 0) { oidx[on] = s; on = on + 1u; } }
                  if (on == 0u) { break; }
                  let pick = oidx[rng_next() % on];
                  if (pick == 0u && active_ex_blocked && !ign_eff) { continue; }
                  if (pick > 0u && bench_dmg_blocked(foe, pick, true, turn_i)) { continue; }
                  g.board[foe][pick].hp = g.board[foe][pick].hp - b1; thit = thit + b1;
                  if (pick > 0u && handle_bench_ko(foe, cur, pick, true, turn_i)) { any_foe_ko = true; }
                }
                total_dmg = thit;
              } else if (b0 == 10) {
                direct_active = false;
                var thit = 0; let times = max(1, b2);
                for (var l = 0; l < times; l = l + 1) {
                  var pp = array<u32, 7>(0u, 0u, 0u, 0u, 0u, 0u, 0u);
                  var ps = array<u32, 7>(0u, 0u, 0u, 0u, 0u, 0u, 0u);
                  var pn = 0u;
                  for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].hp > 0) { pp[pn] = cur; ps[pn] = s; pn = pn + 1u; } }
                  for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && g.board[foe][s].hp > 0) { pp[pn] = foe; ps[pn] = s; pn = pn + 1u; } }
                  if (pn == 0u) { break; }
                  let ri = rng_next() % pn; let tp = pp[ri]; let ts = ps[ri];
                  if (tp == foe && ts == 0u && active_ex_blocked && !ign_eff) { continue; }
                  if (tp == foe && ts > 0u && bench_dmg_blocked(foe, ts, true, turn_i)) { continue; }
                  g.board[tp][ts].hp = g.board[tp][ts].hp - b1;
                  if (tp == foe) { thit = thit + b1; }
                  if (ts > 0u && handle_bench_ko(tp, 1u - tp, ts, true, turn_i) && tp == foe) { any_foe_ko = true; }
                }
                total_dmg = thit;
              } else if (b0 == 11) {
                direct_active = false;
                var ts = 0u;
                for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && !bench_dmg_blocked(foe, s, true, turn_i) && g.board[foe][s].energy > g.board[foe][ts].energy) { ts = s; } }
                let sd = g.board[foe][ts].energy * b1;
                g.board[foe][ts].hp = g.board[foe][ts].hp - sd;
                if (ts == 0u) { total_dmg = sd; }
                else if (handle_bench_ko(foe, cur, ts, true, turn_i)) { any_foe_ko = true; }
              } else if (b0 == 12) {
                direct_active = false;
                g.delayed_slot[foe] = 0u; g.delayed_dmg[foe] = select(b1, 9999, b2 == 1);
              } else if (b0 == 14) {
                direct_active = false; var hits = 0;
                for (var s = 0u; s < 4u; s = s + 1u) {
                  if (hits >= 2) { break; }
                  if (g.board[foe][s].occ == 0) { continue; }
                  if (s == 0u && active_ex_blocked && !ign_eff) { continue; }
                  if (s > 0u && bench_dmg_blocked(foe, s, true, turn_i)) { continue; }
                  g.board[foe][s].hp = g.board[foe][s].hp - b1; hits = hits + 1;
                  if (s == 0u) { total_dmg = b1; }
                  else if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                }
              }
            }
            case 11: {
              if (b0 == 4 || b0 == 5) {
                let nf = select(2, 3, b0 == 5); var heads = 0;
                for (var l = 0; l < nf; l = l + 1) { if (flip_coin_g(&guar_heads)) { heads = heads + 1; } }
                op1_heads = heads;
                if (heads == 0 && ((af & AF_FLIP_2_BOTH_TAILS_FAIL) != 0 || (af & AF_FLIP_3_ALL_TAILS_FAIL) != 0)) {
                  direct_active = false; miss = true;
                } else if (heads > 0 && g.board[foe][0].energy > 0) {
                  let d = min(heads, g.board[foe][0].energy);
                  g.board[foe][0].energy = g.board[foe][0].energy - d; g.energy_discarded[foe] = 1;
                }
              }
            }
            case 17: {
              if (b0 == 3 && b1 >= 10) {
                direct_active = false;
                let pick = best_bench_promote(foe);
                if (pick < 4u) {
                  g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR);
                  let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pick]; g.board[foe][pick] = t;
                  g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED);
                  g.board[foe][0].hp = g.board[foe][0].hp - b1; total_dmg = b1;
                }
              }
            }
            case 20: {
              direct_active = false;
              if (b0 == 1) { total_dmg = g.board[foe][0].hp; g.board[foe][0].hp = 0; }
              else if (b0 == 2) {
                var ok = false;
                if (b1 >= 2) { ok = flip_coin_g(&guar_heads) && flip_coin_g(&guar_heads); }
                else { ok = flip_coin_g(&guar_heads); }
                if (ok) {
                  g.board[foe][0].occ = 0;
                  let prom = best_bench_promote(foe);
                  if (prom < 4u) { let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][prom]; g.board[foe][prom] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
                } else { miss = true; }
              } else if (b0 == 3) {
                if (flip_coin_g(&guar_heads) && flip_coin_g(&guar_heads)) { total_dmg = g.board[foe][0].hp; g.board[foe][0].hp = 0; }
                else { miss = true; }
              } else if (b0 == 4) {
                let cut = max(10, ((g.board[foe][0].hp / 2) / 10) * 10);
                g.board[foe][0].hp = g.board[foe][0].hp - cut; total_dmg = cut;
              } else if (b0 == 5) {
                if (flip_coin_g(&guar_heads)) {
                  let dealt = max(0, g.board[foe][0].hp - 10);
                  g.board[foe][0].hp = min(g.board[foe][0].hp, 10); total_dmg = dealt;
                } else { miss = true; }
              }
            }
            default: {}
          }

          // === APPLY DIRECT ACTIVE DAMAGE ===
          if (direct_active && raw_d > 0 && !miss) {
            let invuln = !ign_eff && (g.board[foe][0].status & ST_INVULN) != 0u;
            let imm_b = !ign_eff && (g.board[foe][0].status & ST_IMMUNE_BASIC) != 0u && s_stage(g.board[cur][0]) == 0;
            let fc0 = wg_cards[g.board[foe][0].ci];
            let disg = !ign_eff && ab_active(foe, 0u, turn_i) && c_ab_op(fc0) == 21 && fc0.r18 == 1 && (g.board[foe][0].status & ST_DISGUISE_USED) == 0u;
            var dodge = false;
            if (!ign_eff && ab_active(foe, 0u, turn_i) && c_ab_op(fc0) == 21 && fc0.r18 == 2) { dodge = flip_coin_plain(); }
            if (invuln || (!ign_eff && active_ex_blocked) || imm_b || disg || dodge) {
              if (disg) { g.board[foe][0].status = g.board[foe][0].status | ST_DISGUISE_USED; }
              total_dmg = 0;
              if (invuln || imm_b || disg || dodge) { miss = true; }
            } else {
              let mod_net = calc_passive_dmg_mods(cur, foe, af, raw_d, dmg_boost, dmg_boost_ex, named_boost, named_h1, named_h2, eevee_boost, cur_team_boost, turn_i);
              var df = max(0, raw_d + mod_net + cur_next_mod);
              if (!ign_eff && ab_active(foe, 0u, turn_i) && c_ab_op(fc0) == 11 && ((fc0.r18 >> 8u) & 255) == 5) {
                if (flip_coin_plain()) { df = max(0, df - (fc0.r18 & 255)); }
              }
              if (!ign_eff && (g.board[foe][0].status & ST_IMMUNE_LE40) != 0u && df <= 40) { df = 0; }
              total_dmg = df;
              if (total_dmg > 0) {
                g.board[foe][0].hp = g.board[foe][0].hp - total_dmg;
                g.board[foe][0].status = g.board[foe][0].status | ST_DAMAGED_LAST;
                active_took_dmg = true;
              }
            }
          } else if (!direct_active && total_dmg > 0 && g.board[foe][0].occ == 1) { active_took_dmg = true; }

          // Mega Kangaskhan ex double hit (op1=19, b0=8)
          if (ao1 == 19 && (av1 & 255) == 8 && !miss) {
            let d2r = (av1 >> 8u) & 255;
            if (g.board[foe][0].occ == 1 && g.board[foe][0].hp <= 0) {
              let kr = handle_active_ko(foe, cur, true, extra_pt, turn_i);
              if (kr.x != 0) { any_foe_ko = true; sync_ab(turn_i); }
              if (kr.y > 0) { g.board[cur][0].hp = g.board[cur][0].hp - kr.y; }
              if (kr.z != 0) { g.board[cur][0].hp = 0; }
            }
            if (g.board[foe][0].occ == 1 && g.points[cur] < 3 && g.board[cur][0].hp > 0) {
              let m2 = calc_passive_dmg_mods(cur, foe, af, d2r, dmg_boost, dmg_boost_ex, named_boost, named_h1, named_h2, eevee_boost, cur_team_boost, turn_i);
              let d2 = max(0, d2r + m2);
              let exb2 = ab_active(foe, 0u, turn_i) && c_ab_op(wg_cards[g.board[foe][0].ci]) == 10 && c_is_ex(atk_c);
              if (!exb2 && d2 > 0) { g.board[foe][0].hp = g.board[foe][0].hp - d2; total_dmg = total_dmg + d2; }
            }
          }

          // Contact reactions
          if (active_took_dmg && g.board[foe][0].occ == 1) {
            if (s_has_tool(g.board[foe][0], 5)) { g.board[cur][0].hp = g.board[cur][0].hp - 20; }
            if (s_has_tool(g.board[foe][0], 6)) { apply_status(cur, 0u, ST_POISON, turn_i, false); }
            if (s_has_tool(g.board[foe][0], 26) && c_has_type(wg_cards[g.board[foe][0].ci], 6) && g.hand_len[cur] > 0u) {
              let ri = rng_next() % g.hand_len[cur];
              let rb = g.hands[cur][ri]; g.hand_len[cur] = g.hand_len[cur] - 1u; g.hands[cur][ri] = g.hands[cur][g.hand_len[cur]];
              if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = rb; g.lib_len[cur] = g.lib_len[cur] + 1u; }
            }
            if (g.board[foe][0].counter > 0) { g.board[cur][0].hp = g.board[cur][0].hp - g.board[foe][0].counter; }
            if (ab_active(foe, 0u, turn_i)) {
              let fc = wg_cards[g.board[foe][0].ci];
              if (c_ab_op(fc) == 13) {
                let amt = fc.r18 & 255; let mode = (fc.r18 >> 8u) & 255;
                if (mode == 0) { g.board[cur][0].hp = g.board[cur][0].hp - amt; }
                else if (mode == 1) { apply_status(cur, 0u, ST_POISON, turn_i, false); }
                else if (mode == 2) { for (var bs = 1u; bs < 4u; bs = bs + 1u) { if (g.board[foe][bs].occ == 1) { g.board[foe][bs].energy = g.board[foe][bs].energy + 1; break; } } }
              }
            }
          }

          // === PHASE 2: EXECUTE BOTH POST-EFFECT SLOTS (op1 AND op2!) ===
          for (var si = 0u; si < select(1u, 2u, ao2 != 0) + dz; si = si + 1u) {
            let op = select(ao2, ao1, si == 0u);
            let val = select(av2, av1, si == 0u);
            if (op == 0 || miss) { continue; }
            let cond_sl = (si == 1u) || (ao2 == 0);
            if (cond_sl && (af & AF_FIRST_ATTACK_ONLY_EFF) != 0 && !is_first_atk && (op == 1 || op == 17)) { continue; }
            if (cond_sl && (af & AF_ONLY_IF_STADIUM_EFF) != 0 && g.stadium == 0 && (op == 1 || op == 12)) { continue; }
            if (cond_sl && (af & AF_ONLY_IF_KO_LAST_TURN_EFF) != 0 && g.ko_last_turn[cur] == 0 && op == 1) { continue; }
            if (cond_sl && (af & AF_ONLY_IF_EVOLVED_THIS_TURN_EFF) != 0 && !was_evo_turn && op == 11) { continue; }

            let p0 = val & 255;
            let p1 = i32((u32(val) >> 8u) & 255u);
            let p2 = i32((u32(val) >> 16u) & 255u);

            switch (op) {
              case 1: {
                var do_st = true; var mask = u32(p0) & 255u;
                if (p1 == 1) { do_st = flip_coin_g(&guar_heads); }
                else if (p1 == 2) {
                  let pk = rng_next() % 5u;
                  mask = select(select(select(select(ST_POISON, ST_PARALYZE, pk == 3u), ST_CONFUSE, pk == 2u), ST_BURN, pk == 1u), ST_SLEEP, pk == 0u);
                } else if (p1 == 3) {
                  if (flip_coin_g(&guar_heads)) { mask = ST_CONFUSE; }
                  else { do_st = false; apply_status(cur, 0u, ST_CONFUSE, turn_i, false); }
                } else if (p1 == 4) { mask = select(ST_CONFUSE, ST_PARALYZE, flip_coin_g(&guar_heads)); }
                else if (p1 == 5) { mask = ST_CONFUSE; }
                else if (p1 == 6) { do_st = op1_heads >= 2; }
                else if (p1 == 7) { do_st = op1_heads >= 1; }
                else if (p1 == 8) { do_st = false; if (!has_status_immunity(foe, 0u, turn_i)) { g.board[foe][0].status = g.board[foe][0].status | ST_ATTACH_SLEEP; } }
                if (do_st && g.board[foe][0].occ == 1) { apply_status(foe, 0u, mask, turn_i, true); }
              }
              case 2: {
                if (p0 == 1) { apply_status(cur, 0u, ST_SLEEP, turn_i, false); }
                else if (p0 == 2) { apply_status(cur, 0u, ST_CONFUSE, turn_i, false); }
                else if (p0 == 3) { apply_status(cur, 0u, ST_CONFUSE, turn_i, false); apply_status(foe, 0u, ST_CONFUSE, turn_i, true); }
                else if (p0 == 4) { apply_status(cur, 0u, ST_SLEEP, turn_i, false); apply_status(foe, 0u, ST_SLEEP, turn_i, true); }
                else if (p0 == 5) { g.board[cur][0].status = g.board[cur][0].status & (~ST_SPECIAL_MASK); }
              }
              case 8: {
                if (p0 == 0) {
                  if (p2 == 0 || flip_coin_g(&guar_heads)) {
                    for (var s = 1u; s < 4u; s = s + 1u) {
                      if (g.board[foe][s].occ == 1 && !bench_dmg_blocked(foe, s, true, turn_i)) {
                        g.board[foe][s].hp = g.board[foe][s].hp - p1;
                        if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                        break;
                      }
                    }
                  }
                } else if (p0 == 1) {
                  var ok = true;
                  if (p2 == 1) {
                    ok = false;
                    for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_name_hash(wg_cards[g.board[cur][s].ci]) == aaux) { ok = true; break; } }
                  }
                  if (ok) {
                    for (var s = 1u; s < 4u; s = s + 1u) {
                      if (g.board[foe][s].occ == 1 && !bench_dmg_blocked(foe, s, true, turn_i)) {
                        g.board[foe][s].hp = g.board[foe][s].hp - p1;
                        if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                      }
                    }
                  }
                } else if (p0 == 5) {
                  for (var s = 1u; s < 4u; s = s + 1u) {
                    if (g.board[foe][s].occ == 0 || bench_dmg_blocked(foe, s, true, turn_i)) { continue; }
                    let cond = select((g.board[foe][s].hp < g.board[foe][s].max_hp), (g.board[foe][s].energy > 0), p2 == 2);
                    if (cond) {
                      g.board[foe][s].hp = g.board[foe][s].hp - p1;
                      if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                      if (p2 == 1) { break; }
                    }
                  }
                } else if (p0 == 7 || p0 == 13) {
                  if (eff_energy(cur, 0u, turn_i) >= ac + p2) {
                    let max_t = select(1, 2, p0 == 7); var cnt = 0;
                    for (var s = 1u; s < 4u; s = s + 1u) {
                      if (cnt >= max_t) { break; }
                      if (g.board[foe][s].occ == 1 && !bench_dmg_blocked(foe, s, true, turn_i)) {
                        g.board[foe][s].hp = g.board[foe][s].hp - p1; cnt = cnt + 1;
                        if (handle_bench_ko(foe, cur, s, true, turn_i)) { any_foe_ko = true; }
                      }
                    }
                  }
                } else if (p0 == 9) {
                  let times = max(1, p2);
                  for (var l = 0; l < times; l = l + 1) {
                    var bidx = array<u32, 3>(0u, 0u, 0u); var bn = 0u;
                    for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[foe][s].occ == 1 && g.board[foe][s].hp > 0) { bidx[bn] = s; bn = bn + 1u; } }
                    if (bn == 0u) { break; }
                    let pk = bidx[rng_next() % bn];
                    if (bench_dmg_blocked(foe, pk, true, turn_i)) { continue; }
                    g.board[foe][pk].hp = g.board[foe][pk].hp - p1;
                    if (handle_bench_ko(foe, cur, pk, true, turn_i)) { any_foe_ko = true; }
                  }
                }
              }
              case 9: {
                let only_ko = (af & AF_ONLY_IF_KO_RECOIL) != 0;
                let will_ko = any_foe_ko || (g.board[foe][0].occ == 1 && g.board[foe][0].hp <= 0);
                if (!only_ko || will_ko) {
                  if (p1 == 0) { g.board[cur][0].hp = g.board[cur][0].hp - p0; }
                  else if (p1 == 1 || p1 == 5) {
                    for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { g.board[cur][s].hp = g.board[cur][s].hp - p0; handle_bench_ko(cur, foe, s, false, turn_i); break; } }
                  } else if (p1 == 2) {
                    for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { g.board[cur][s].hp = g.board[cur][s].hp - p0; handle_bench_ko(cur, foe, s, false, turn_i); } }
                  } else if (p1 == 3) {
                    if (!flip_coin_g(&guar_heads)) { g.board[cur][0].hp = g.board[cur][0].hp - p0; }
                  } else if (p1 == 4) {
                    g.board[cur][0].hp = g.board[cur][0].hp - 100;
                    for (var pp = 0u; pp < 2u; pp = pp + 1u) {
                      for (var s = 1u; s < 4u; s = s + 1u) {
                        if (g.board[pp][s].occ == 1 && !(pp == foe && bench_dmg_blocked(foe, s, true, turn_i))) {
                          g.board[pp][s].hp = g.board[pp][s].hp - 50;
                          handle_bench_ko(pp, 1u - pp, s, pp == foe, turn_i);
                        }
                      }
                    }
                  }
                }
              }
              case 10: {
                if (p1 == 0) {
                  let dc = select(min(p0, g.board[cur][0].energy), g.board[cur][0].energy, p0 >= 99);
                  if (dc > 0) { g.board[cur][0].energy = g.board[cur][0].energy - dc; g.energy_discarded[cur] = 1; }
                } else if (p1 == 1) {
                  if (!flip_coin_g(&guar_heads)) {
                    let dc = min(p0, g.board[cur][0].energy);
                    if (dc > 0) { g.board[cur][0].energy = g.board[cur][0].energy - dc; g.energy_discarded[cur] = 1; }
                  }
                } else if (p1 == 2 || p1 == 3) {
                  let times = select(1, 2, p1 == 3);
                  for (var l = 0; l < times; l = l + 1) {
                    if ((rng_next() & 1u) == 0u && g.board[cur][0].energy > 0) { g.board[cur][0].energy = g.board[cur][0].energy - 1; g.energy_discarded[cur] = 1; }
                    else if (g.board[foe][0].energy > 0) { g.board[foe][0].energy = g.board[foe][0].energy - 1; g.energy_discarded[foe] = 1; }
                  }
                } else if (p1 == 4) {
                  var rem = 2;
                  for (var s = 0u; s < 4u; s = s + 1u) {
                    for (var l = 0; l < 2; l = l + 1) {
                      if (rem <= 0 || g.board[cur][s].occ == 0 || g.board[cur][s].energy <= 0) { break; }
                      g.board[cur][s].energy = g.board[cur][s].energy - 1; g.energy_discarded[cur] = 1; rem = rem - 1;
                    }
                  }
                } else if (p1 == 5) {
                  if (g.board[cur][0].energy > 0) { g.board[cur][0].energy = g.board[cur][0].energy - 1; g.energy_discarded[cur] = 1; }
                  if (g.board[foe][0].energy > 0) { g.board[foe][0].energy = g.board[foe][0].energy - 1; g.energy_discarded[foe] = 1; }
                }
              }
              case 11: {
                if (p0 != 4 && p0 != 5 && g.board[foe][0].occ == 1 && g.board[foe][0].energy > 0 && !has_status_immunity(foe, 0u, turn_i)) {
                  var dc = 0;
                  if (p0 == 1) { g.board[foe][0].energy = g.board[foe][0].energy - 1; dc = 1; }
                  else if (p0 == 2) { if (flip_coin_g(&guar_heads)) { g.board[foe][0].energy = g.board[foe][0].energy - 1; dc = 1; } }
                  else if (p0 == 3) { for (var l = 0u; l < 6u; l = l + 1u) { if (g.board[foe][0].energy > 0 && flip_coin_g(&guar_heads)) { g.board[foe][0].energy = g.board[foe][0].energy - 1; dc = dc + 1; } else { break; } } }
                  else if (p0 == 6) { dc = min(2, g.board[foe][0].energy); g.board[foe][0].energy = g.board[foe][0].energy - dc; }
                  if (dc > 0) { g.energy_discarded[foe] = 1; }
                }
              }
              case 12: {
                if (!heal_blocked) {
                  let ar = val & 4095; let md = i32((u32(val) >> 12u) & 15u);
                  let h = select(ar, total_dmg, ar == 999);
                  if (md <= 1) { if (h > 0) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + h); } }
                  else if (md == 2) { for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].hp < g.board[cur][s].max_hp) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + h); break; } } }
                  else if (md == 3) { for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + h); } } }
                  else if (md == 4) { for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + h); } } }
                  else if (md == 5) { if (flip_coin_g(&guar_heads)) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + h); } }
                  else if (md == 6 && g.board[foe][0].occ == 1 && (g.board[foe][0].status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0u) { g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + h); }
                }
              }
              case 13: {
                if (p1 == 0) { g.board[cur][0].energy = g.board[cur][0].energy + p0; }
                else if (p1 == 1) { let pr = best_bench_promote(cur); if (pr < 4u) { g.board[cur][pr].energy = g.board[cur][pr].energy + p0; } }
                else if (p1 == 2) { var ad2 = 0; for (var s = 1u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && ad2 < 2) { g.board[cur][s].energy = g.board[cur][s].energy + 1; ad2 = ad2 + 1; } } }
                else if (p1 == 3 || p1 == 4) {
                  var h = 0; for (var l = 0u; l < 3u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { h = h + 1; } }
                  if (h == 0 && has_victini) { has_victini = false; for (var l = 0u; l < 3u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { h = h + 1; } } }
                  if (h > 0) {
                    if (p1 == 3) { let pr = best_bench_promote(cur); if (pr < 4u) { g.board[cur][pr].energy = g.board[cur][pr].energy + h; } }
                    else { g.board[cur][0].energy = g.board[cur][0].energy + h; }
                  }
                } else if (p1 == 5) { if (flip_coin_g(&guar_heads)) { g.board[cur][0].energy = g.board[cur][0].energy + p0; } }
                else if (p1 == 6) { let pr = best_bench_promote(cur); if (pr < 4u && flip_coin_g(&guar_heads)) { g.board[cur][pr].energy = g.board[cur][pr].energy + p0; } }
                else if (p1 == 7) { let pr = best_bench_promote(cur); let tgt = select(0u, pr, pr < 4u); g.board[cur][tgt].energy = g.board[cur][tgt].energy + p0; }
                else if (p1 == 8) {
                  let pr = best_bench_promote(cur);
                  if (pr < 4u && g.board[cur][0].energy > 0) {
                    let mv = select(min(p0, g.board[cur][0].energy), g.board[cur][0].energy, p0 >= 99);
                    g.board[cur][0].energy = g.board[cur][0].energy - mv; g.board[cur][pr].energy = g.board[cur][pr].energy + mv;
                  }
                }
              }
              case 14: {
                if (p1 == 0) { g.board[cur][0].shield = g.board[cur][0].shield + p0; }
                else if (p1 == 1) { g.board[cur][0].shield = g.board[cur][0].shield + p0; g.board[cur][0].status = g.board[cur][0].status | ST_NO_WEAKNESS; }
                else if (p1 == 2) { g.board[cur][0].status = g.board[cur][0].status | ST_NO_WEAKNESS; }
                else if (p1 == 3) { g.board[cur][0].shield_ex = g.board[cur][0].shield_ex + p0; }
                else if (p1 == 4) { g.board[cur][0].status = g.board[cur][0].status | ST_IMMUNE_LE40; }
                else if (p1 == 5) { g.board[cur][0].status = g.board[cur][0].status | ST_IMMUNE_BASIC; }
                else if (p1 == 6) { g.board[cur][0].counter = p0; }
                else if (p1 == 7) { if (flip_coin_g(&guar_heads)) { g.board[cur][0].status = g.board[cur][0].status | ST_INVULN; } }
                else if (p1 == 8) { g.board[cur][0].status = g.board[cur][0].status | ST_INVULN; }
                else if (p1 == 9) { if (flip_coin_g(&guar_heads)) { g.board[cur][0].shield = g.board[cur][0].shield + p0; } }
                else if (p1 == 10) { g.board[cur][0].shield = g.board[cur][0].shield - p0; }
                else if (p1 == 11 && g.board[foe][0].occ == 1) { g.board[foe][0].shield = g.board[foe][0].shield - p0; }
                else if (p1 == 12 && g.board[foe][0].occ == 1) { g.board[foe][0].status = g.board[foe][0].status | ST_RETREAT_TRAP; }
              }
              case 15: {
                if (g.board[foe][0].occ == 1 && !has_status_immunity(foe, 0u, turn_i)) {
                  if (p1 == 0) { g.board[foe][0].weaken = g.board[foe][0].weaken + p0; }
                  else if (p1 == 1) { g.board[foe][0].status = g.board[foe][0].status | ST_OPP_MISS_FLIP; }
                  else if (p1 == 2) { g.board[foe][0].status = g.board[foe][0].status | ST_PERM_MISS_FLIP; }
                  else if (p1 == 3) { g.board[foe][0].status = g.board[foe][0].status | ST_CANT_ATK_OPP; }
                  else if (p1 == 4) { if (flip_coin_g(&guar_heads)) { g.board[foe][0].status = g.board[foe][0].status | ST_CANT_ATK_OPP; } }
                  else if (p1 == 5 && s_stage(g.board[foe][0]) == 0) { g.board[foe][0].status = g.board[foe][0].status | ST_CANT_ATK_OPP; }
                  else if (p1 == 6) { g.board[foe][0].cost_tax = g.board[foe][0].cost_tax + p0; }
                  else if (p1 == 7) { g.board[foe][0].cost_tax = g.board[foe][0].cost_tax + p0; g.board[foe][0].retreat_tax = g.board[foe][0].retreat_tax + p0; }
                  else if (p1 == 8) {
                    let pa = select(ST_CANT_USE_A1, ST_CANT_USE_A2, c_a2_cost(wg_cards[g.board[foe][0].ci]) != 255 && (rng_next() & 1u) == 1u);
                    g.board[foe][0].status = g.board[foe][0].status | pa;
                  } else if (p1 == 9) { g.board[foe][0].status = g.board[foe][0].status | ST_NO_ABILITY; }
                  else if (p1 == 10) { g.board[foe][0].status = g.board[foe][0].status | ST_NO_ENERGY_ATTACH; }
                }
              }
              case 16: {
                let pr = best_bench_promote(cur);
                if (pr < 4u) {
                  if (p0 == 1) {
                    let shc = g.board[cur][0].ci;
                    if (g.board[cur][0].energy > 0) { g.energy_discarded[cur] = 1; }
                    g.board[cur][0].occ = 0;
                    let t = g.board[cur][0]; g.board[cur][0] = g.board[cur][pr]; g.board[cur][pr] = t;
                    g.board[cur][0].status = g.board[cur][0].status & (~ST_HAS_ATTACKED);
                    if (g.lib_len[cur] < 20u) { g.libs[cur][g.lib_len[cur]] = shc; g.lib_len[cur] = g.lib_len[cur] + 1u; }
                  } else {
                    g.board[cur][0].status = g.board[cur][0].status & (~ST_LEAVE_ACTIVE_CLEAR);
                    g.board[cur][0].stack_boost = 0;
                    let t = g.board[cur][0]; g.board[cur][0] = g.board[cur][pr]; g.board[cur][pr] = t;
                    g.board[cur][0].status = g.board[cur][0].status & (~ST_HAS_ATTACKED);
                  }
                }
              }
              case 17: {
                if (p0 == 1 && g.board[foe][0].occ == 1 && !has_status_immunity(foe, 0u, turn_i)) { g.board[foe][0].status = g.board[foe][0].status | ST_CANT_RETREAT; }
                else if (p0 == 2 || (p0 == 3 && p1 == 1 && flip_coin_g(&guar_heads))) {
                  let pk = best_bench_promote(foe);
                  if (pk < 4u) { g.board[foe][0].status = g.board[foe][0].status & (~ST_LEAVE_ACTIVE_CLEAR); g.board[foe][0].stack_boost = 0; let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pk]; g.board[foe][pk] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
                } else if (p0 == 4) { g.item_lock[foe] = 1; }
                else if (p0 == 5) { g.supp_lock[foe] = 1; }
                else if (p0 == 6) { g.item_lock[foe] = 1; g.supp_lock[foe] = 1; }
                else if (p0 == 7) { g.evo_lock[foe] = 1; }
                else if (p0 == 8) {
                  if (p1 == 0 || flip_coin_g(&guar_heads)) {
                    for (var k = 0u; k < g.hand_len[foe]; k = k + 1u) { if (c_is_supporter(wg_cards[g.hands[foe][k]])) { g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][k] = g.hands[foe][g.hand_len[foe]]; break; } }
                  }
                } else if (p0 == 10) {
                  if ((p1 != 1 || flip_coin_g(&guar_heads)) && g.hand_len[foe] > 0u) {
                    if (p1 == 2 || p1 == 3) {
                      for (var k = 0u; k < g.hand_len[foe]; k = k + 1u) {
                        let hc = wg_cards[g.hands[foe][k]];
                        if ((p1 == 2 && c_is_item(hc)) || (p1 == 3 && c_is_tool(hc))) { g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][k] = g.hands[foe][g.hand_len[foe]]; break; }
                      }
                    } else {
                      let ri = rng_next() % g.hand_len[foe];
                      g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][ri] = g.hands[foe][g.hand_len[foe]];
                    }
                  }
                } else if (p0 == 11) {
                  var cnt = p1;
                  if (p1 == 99) { cnt = select(0, 1, flip_coin_g(&guar_heads)); }
                  else if (p1 == 98) { cnt = 0; for (var l = 0u; l < 3u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { cnt = cnt + 1; } } }
                  for (var l = 0; l < cnt; l = l + 1) {
                    if (g.hand_len[foe] > 0u) {
                      let ri = rng_next() % g.hand_len[foe];
                      let cb = g.hands[foe][ri]; g.hand_len[foe] = g.hand_len[foe] - 1u; g.hands[foe][ri] = g.hands[foe][g.hand_len[foe]];
                      if (g.lib_len[foe] < 20u) { g.libs[foe][g.lib_len[foe]] = cb; g.lib_len[foe] = g.lib_len[foe] + 1u; }
                    }
                  }
                } else if (p0 == 12) {
                  if (flip_coin_g(&guar_heads) && count_bench(foe) > 0) {
                    let bci = g.board[foe][0].ci; g.board[foe][0].occ = 0;
                    let pr = best_bench_promote(foe);
                    if (pr < 4u) { let t = g.board[foe][0]; g.board[foe][0] = g.board[foe][pr]; g.board[foe][pr] = t; g.board[foe][0].status = g.board[foe][0].status & (~ST_HAS_ATTACKED); }
                    if (g.lib_len[foe] < 20u) { g.libs[foe][g.lib_len[foe]] = bci; g.lib_len[foe] = g.lib_len[foe] + 1u; }
                  }
                } else if (p0 == 13) {
                  var cnt = p1;
                  if (p1 == 99) { cnt = 0; for (var l = 0u; l < 8u; l = l + 1u) { if (flip_coin_g(&guar_heads)) { cnt = cnt + 1; } else { break; } } }
                  for (var l = 0; l < cnt; l = l + 1) { if (g.lib_len[foe] > 0u) { g.lib_len[foe] = g.lib_len[foe] - 1u; record_discard_card(foe, g.libs[foe][g.lib_len[foe]]); } }
                } else if (p0 == 14) {
                  for (var l = 0; l < p1; l = l + 1) { if (g.lib_len[cur] > 0u) { g.lib_len[cur] = g.lib_len[cur] - 1u; record_discard_card(cur, g.libs[cur][g.lib_len[cur]]); } }
                } else if (p0 == 15) {
                  for (var l = 0; l < p1; l = l + 1) { if (g.lib_len[cur] > 0u) { g.lib_len[cur] = g.lib_len[cur] - 1u; } if (g.lib_len[foe] > 0u) { g.lib_len[foe] = g.lib_len[foe] - 1u; } }
                } else if (p0 == 16) { g.stadium = 0; }
                else if (p0 == 17 && g.board[foe][0].occ == 1 && s_stage(g.board[foe][0]) > 0) {
                  let dmg_on = max(0, g.board[foe][0].max_hp - g.board[foe][0].hp);
                  g.board[foe][0].max_hp = max(50, g.board[foe][0].max_hp - 50);
                  g.board[foe][0].hp = g.board[foe][0].max_hp - dmg_on;
                  g.board[foe][0].stage_ov = s_stage(g.board[foe][0]) - 1;
                }
              }
              case 18: {
                if (p0 == 1) { let n = max(1, p1); for (var l = 0; l < n; l = l + 1) { draw_one(cur); } }
                else if (p0 == 2) { search_deck_to_hand(cur, 1, 0, 0); }
                else if (p0 == 3) {
                  var put = 0; let lim = max(1, p1);
                  for (var bs = 1u; bs < 4u; bs = bs + 1u) {
                    if (put >= lim) { break; }
                    if (g.board[cur][bs].occ == 0) {
                      for (var li = 0u; li < g.lib_len[cur]; li = li + 1u) {
                        let bci = g.libs[cur][li]; let bc = wg_cards[bci];
                        if (bc.r0 == 1 && c_stage(bc) == 0 && !c_is_fossil(bc)) {
                          g.lib_len[cur] = g.lib_len[cur] - 1u; g.libs[cur][li] = g.libs[cur][g.lib_len[cur]];
                          g.board[cur][bs] = make_slot(bci, bc.r5, turn_i); put = put + 1; break;
                        }
                      }
                    }
                  }
                } else if (p0 == 4) { let w = g.hand_len[foe]; shuffle_hand_into_deck(cur); for (var l = 0u; l < w; l = l + 1u) { draw_one(cur); } }
                else if (p0 == 5) { for (var l = 0u; l < 12u; l = l + 1u) { if (g.hand_len[cur] >= g.hand_len[foe] || g.lib_len[cur] == 0u) { break; } draw_one(cur); } }
                else if (p0 == 6) {
                  var pn = 0; for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && c_name_hash(wg_cards[g.board[cur][s].ci]) == H_POOCHYENA) { pn = pn + 1; } }
                  for (var l = 0; l < pn; l = l + 1) { draw_one(cur); }
                } else if (p0 == 7) { search_deck_to_hand(cur, 8, 0, 0); }
                else if (p0 == 8 && g.disc_item[cur] > 0 && g.hand_len[cur] < 12u) {
                  for (var k = 0u; k < 20u; k = k + 1u) { let dci = cur * 20u + k; if (c_is_item(wg_cards[dci])) { g.hands[cur][g.hand_len[cur]] = dci; g.hand_len[cur] = g.hand_len[cur] + 1u; break; } }
                } else if (p0 == 9) {
                  let bc = wg_cards[g.board[cur][0].ci];
                  for (var li = 0u; li < g.lib_len[cur]; li = li + 1u) {
                    let evci = g.libs[cur][li]; let evc = wg_cards[evci];
                    if (evc.r0 == 1 && c_stage(evc) == s_stage(g.board[cur][0]) + 1 && c_evo_group(evc) == c_evo_group(bc)) {
                      let taken = max(0, g.board[cur][0].max_hp - g.board[cur][0].hp);
                      let bhp = tool_hp_bonus(g.board[cur][0].tool, evc) + tool_hp_bonus(g.board[cur][0].tool2, evc);
                      g.board[cur][0].ci = evci; g.board[cur][0].stage_ov = -1;
                      g.board[cur][0].max_hp = evc.r5 + bhp; g.board[cur][0].hp = max(10, g.board[cur][0].max_hp - taken);
                      g.board[cur][0].status = g.board[cur][0].status & (~ST_SPECIAL_MASK); g.board[cur][0].turn_placed = turn_i;
                      g.lib_len[cur] = g.lib_len[cur] - 1u; g.libs[cur][li] = g.libs[cur][g.lib_len[cur]]; break;
                    }
                  }
                }
              }
              case 19: {
                if (p0 == 1) { g.board[cur][0].status = g.board[cur][0].status | ST_CANT_ATK_SELF; }
                else if (p0 == 2) { g.board[cur][0].status = g.board[cur][0].status | select(ST_CANT_USE_A2, ST_CANT_USE_A1, atk_idx == 0u); }
                else if (p0 == 3) { if (!flip_coin_g(&guar_heads)) { g.board[cur][0].status = g.board[cur][0].status | ST_CANT_ATK_SELF; } }
                else if (p0 == 4) { g.board[cur][0].next_atk_mod = p1; }
                else if (p0 == 5) { g.next_team_boost[cur] = p1; }
                else if (p0 == 6) { g.board[cur][0].stack_boost = min(180, g.board[cur][0].stack_boost + p1); }
                else if (p0 == 7) { g.board[cur][0].next_atk_mod = -p1; }
              }
              default: {}
            }
          }
        }

        sync_ab(turn_i);
        g.board[cur][0].status = g.board[cur][0].status | ST_HAS_ATTACKED;
        let kr = handle_active_ko(foe, cur, true, extra_pt, turn_i);
        if (kr.y > 0 && g.board[cur][0].occ == 1) { g.board[cur][0].hp = g.board[cur][0].hp - kr.y; }
        if (kr.z != 0 && g.board[cur][0].occ == 1) { g.board[cur][0].hp = 0; }
        ko_active_passive(cur, foe);

        let cur_won = g.points[cur] >= 3 || g.board[foe][0].occ == 0;
        let foe_won = g.points[foe] >= 3 || g.board[cur][0].occ == 0;
        if (cur_won && foe_won) { g.done = 1u; g.outcome = 2u; g.end_turn = turn; states_buf[slot] = g; return; }
        if (cur_won) { g.done = 1u; g.outcome = select(0u, 1u, cur == 0u); g.end_turn = turn; states_buf[slot] = g; return; }
        if (foe_won) { g.done = 1u; g.outcome = select(0u, 1u, foe == 0u); g.end_turn = turn; states_buf[slot] = g; return; }


  }
    // === END-OF-TURN TRIGGERS ===
    sync_ab(turn_i);
    g.sweets_used_last[cur] = sweets_this_turn;
    if (g.delayed_slot[cur] < 4u && g.delayed_dmg[cur] > 0) {
      let ds = g.delayed_slot[cur]; let dd = g.delayed_dmg[cur];
      g.delayed_slot[cur] = 4u; g.delayed_dmg[cur] = 0;
      if (g.board[cur][ds].occ == 1) {
        if (dd >= 9000) { g.board[cur][ds].hp = 0; } else { g.board[cur][ds].hp = g.board[cur][ds].hp - dd; }
        if (ds == 0u) { if (ko_active_passive(cur, foe)) { sync_ab(turn_i); }; }
        else { handle_bench_ko(cur, foe, ds, false, turn_i); }
      }
    }
    for (var s = 0u; s < 4u; s = s + 1u) {
      if (g.board[foe][s].occ == 1) {
        if (g.board[foe][s].tool == 13) { g.board[foe][s].tool = 0; }
        if (g.board[foe][s].tool2 == 13) { g.board[foe][s].tool2 = 0; }
      }
    }
    if (g.board[foe][0].occ == 1 && ab_active(foe, 0u, turn_i) && c_ab_op(wg_cards[g.board[foe][0].ci]) == 9 && wg_cards[g.board[foe][0].ci].r18 == 7) {
      let bc = wg_cards[g.board[foe][0].ci];
      for (var li = 0u; li < g.lib_len[foe]; li = li + 1u) {
        let evci = g.libs[foe][li]; let evc = wg_cards[evci];
        if (evc.r0 == 1 && c_stage(evc) == s_stage(g.board[foe][0]) + 1 && c_evo_group(evc) == c_evo_group(bc)) {
          let taken = max(0, g.board[foe][0].max_hp - g.board[foe][0].hp);
          let bhp = tool_hp_bonus(g.board[foe][0].tool, evc) + tool_hp_bonus(g.board[foe][0].tool2, evc);
          g.board[foe][0].ci = evci; g.board[foe][0].stage_ov = -1;
          g.board[foe][0].max_hp = evc.r5 + bhp; g.board[foe][0].hp = max(10, g.board[foe][0].max_hp - taken);
          g.board[foe][0].status = g.board[foe][0].status & (~ST_SPECIAL_MASK); g.board[foe][0].turn_placed = turn_i;
          g.lib_len[foe] = g.lib_len[foe] - 1u; g.libs[foe][li] = g.libs[foe][g.lib_len[foe]]; break;
        }
      }
    }
    if (g.board[cur][0].occ == 1) {
      if (ab_active(cur, 0u, turn_i) && c_ab_op(wg_cards[g.board[cur][0].ci]) == 1) { draw_one(cur); }
      if (s_has_tool(g.board[cur][0], 19) && c_has_type(wg_cards[g.board[cur][0].ci], 6) && g.board[foe][0].occ == 1) {
        g.board[foe][0].hp = g.board[foe][0].hp - 10; if (ko_active_passive(foe, cur)) { sync_ab(turn_i); };
      }
      if (!heal_blocked && s_has_tool(g.board[cur][0], 20) && g.board[cur][0].hp < g.board[cur][0].max_hp) {
        g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + 10);
      }
      if (!heal_blocked && ab_active(cur, 0u, turn_i) && c_ab_op(wg_cards[g.board[cur][0].ci]) == 9 && wg_cards[g.board[cur][0].ci].r18 == 4 && g.board[cur][0].hp < g.board[cur][0].max_hp) {
        g.board[cur][0].hp = min(g.board[cur][0].max_hp, g.board[cur][0].hp + 20);
      }
      if ((g.board[cur][0].status & ST_PARALYZE) != 0u) { g.board[cur][0].status = g.board[cur][0].status & (~ST_PARALYZE); }
      g.board[cur][0].status = g.board[cur][0].status & (~(ST_CANT_RETREAT | ST_CANT_ATK_OPP | ST_OPP_MISS_FLIP | ST_SWITCHED_IN | ST_ATTACH_SLEEP | ST_NO_ENERGY_ATTACH | ST_DAMAGED_LAST));
      if (had_cant_atk_self) { g.board[cur][0].status = g.board[cur][0].status & (~ST_CANT_ATK_SELF); }
      if (had_cant_a1) { g.board[cur][0].status = g.board[cur][0].status & (~ST_CANT_USE_A1); }
      if (had_cant_a2) { g.board[cur][0].status = g.board[cur][0].status & (~ST_CANT_USE_A2); }
      g.board[cur][0].weaken = 0; g.board[cur][0].cost_tax = 0; g.board[cur][0].retreat_tax = 0;
      if (g.board[cur][0].shield < 0) { g.board[cur][0].shield = 0; }
    }
    if (g.stadium == 7 && !heal_blocked) {
      for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[cur][s].occ == 1 && g.board[cur][s].energy > 0 && g.board[cur][s].hp < g.board[cur][s].max_hp) { g.board[cur][s].hp = min(g.board[cur][s].max_hp, g.board[cur][s].hp + 20); } }
    } else if (g.stadium == 8) {
      for (var l = 0u; l < 3u; l = l + 1u) { if (g.hand_len[cur] >= 3u || g.lib_len[cur] == 0u) { break; } draw_one(cur); }
    }
    for (var pp = 0u; pp < 2u; pp = pp + 1u) {
      for (var s = 0u; s < 4u; s = s + 1u) {
        if (g.board[pp][s].occ == 0) { continue; }
        if (!heal_blocked && s_has_tool(g.board[pp][s], 21) && g.board[pp][s].hp * 2 <= g.board[pp][s].max_hp) {
          g.board[pp][s].hp = min(g.board[pp][s].max_hp, g.board[pp][s].hp + 30);
          if (g.board[pp][s].tool == 21) { g.board[pp][s].tool = 0; } else { g.board[pp][s].tool2 = 0; }
        }
        if (s_has_tool(g.board[pp][s], 22) && (g.board[pp][s].status & ST_SPECIAL_MASK) != 0u) {
          g.board[pp][s].status = g.board[pp][s].status & (~ST_SPECIAL_MASK);
          if (g.board[pp][s].tool == 22) { g.board[pp][s].tool = 0; } else { g.board[pp][s].tool2 = 0; }
        }
      }
    }
    if (turn <= 2u) {
      for (var s = 0u; s < 4u; s = s + 1u) {
        if (g.board[cur][s].occ == 1 && ab_active(cur, s, turn_i) && c_ab_op(wg_cards[g.board[cur][s].ci]) == 9 && wg_cards[g.board[cur][s].ci].r18 == 5) { g.board[cur][s].energy = g.board[cur][s].energy + 1; }
      }
    }
    g.item_lock[cur] = 0; g.supp_lock[cur] = 0; g.evo_lock[cur] = 0; g.ko_last_turn[cur] = 0;

    // === POKEMON CHECKUP ===
    sync_ab(turn_i);
    for (var p = 0u; p < 2u + dz; p = p + 1u) {
      let opp = 1u - p;
      if (!heal_blocked) {
        for (var k = 0u; k < 4u; k = k + 1u) {
          if (ab_active(p, k, turn_i) && c_ab_op(wg_cards[g.board[p][k].ci]) == 9 && wg_cards[g.board[p][k].ci].r18 == 6) {
            for (var s = 0u; s < 4u; s = s + 1u) { if (g.board[p][s].occ == 1) { g.board[p][s].hp = min(g.board[p][s].max_hp, g.board[p][s].hp + 10); } }
          }
        }
      }
      if (g.board[p][0].occ == 0) { continue; }
      if ((g.board[p][0].status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0u) {
        var pd = select(select(10, 20, (g.board[p][0].status & ST_TOXIC20) != 0u), 40, (g.board[p][0].status & ST_TOXIC40) != 0u);
        for (var s = 0u; s < 4u; s = s + 1u) { if (ab_active(opp, s, turn_i) && c_ab_op(wg_cards[g.board[opp][s].ci]) == 17 && wg_cards[g.board[opp][s].ci].r18 == 3) { pd = pd + 10; } }
        g.board[p][0].hp = g.board[p][0].hp - pd;
        if (ko_active_passive(p, opp)) { sync_ab(turn_i); };
        if (g.board[p][0].occ == 0) { continue; }
      }
      if ((g.board[p][0].status & ST_BURN) != 0u) {
        g.board[p][0].hp = g.board[p][0].hp - 20;
        if (flip_coin_plain()) { g.board[p][0].status = g.board[p][0].status & (~ST_BURN); }
        if (ko_active_passive(p, opp)) { sync_ab(turn_i); };
        if (g.board[p][0].occ == 0) { continue; }
      }
      if ((g.board[p][0].status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0u) {
        var nmd = 0;
        for (var s = 0u; s < 4u; s = s + 1u) { if (ab_active(opp, s, turn_i) && c_ab_op(wg_cards[g.board[opp][s].ci]) == 9 && wg_cards[g.board[opp][s].ci].r18 == 1) { nmd = nmd + 20; } }
        if (nmd > 0) {
          g.board[p][0].hp = g.board[p][0].hp - nmd;
          if (ko_active_passive(p, opp)) { sync_ab(turn_i); };
          if (g.board[p][0].occ == 0) { continue; }
        }
        if ((g.board[p][0].status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0u) {
          let deep = (g.board[p][0].status & ST_DEEP_SLEEP) != 0u;
          var woke = false;
          if (deep) { woke = flip_coin_plain() && flip_coin_plain(); }
          else { woke = flip_coin_plain(); }
          if (woke) { g.board[p][0].status = g.board[p][0].status & (~(ST_SLEEP | ST_DEEP_SLEEP)); }
        }
      }
      if (g.board[opp][0].occ == 1 && ab_active(opp, 0u, turn_i) && c_ab_op(wg_cards[g.board[opp][0].ci]) == 9) {
        let gv = wg_cards[g.board[opp][0].ci].r18;
        if (gv == 2 || gv == 3) {
          g.board[p][0].hp = g.board[p][0].hp - 10;
          if (ko_active_passive(p, opp)) { sync_ab(turn_i); };
          if (gv == 3) {
            for (var bs = 1u; bs < 4u; bs = bs + 1u) {
              if (g.board[p][bs].occ == 1 && !bench_dmg_blocked(p, bs, false, turn_i)) {
                g.board[p][bs].hp = g.board[p][bs].hp - 10;
                handle_bench_ko(p, opp, bs, false, turn_i);
              }
            }
          }
        }
      }
    }


  let p0_won = g.points[0] >= 3 || g.board[1][0].occ == 0;
  let p1_won = g.points[1] >= 3 || g.board[0][0].occ == 0;
  if (p0_won && p1_won) { g.done = 1u; g.outcome = 2u; g.end_turn = turn; }
  else if (p0_won) { g.done = 1u; g.outcome = 1u; g.end_turn = turn; }
  else if (p1_won) { g.done = 1u; g.outcome = 0u; g.end_turn = turn; }
  else if (turn >= 30u) { g.done = 1u; g.outcome = 2u; g.end_turn = 30u; }
  else { g.cur = foe; g.turn = turn + 1u; g.pending_atk = -1; }
  states_buf[slot] = g;
}
`;

const WGSL_FINALIZE = /* wgsl */ `
const FEATURES: u32 = 22u;
const CARD_STRIDE: u32 = 28u;
const MAX_ENEMIES: u32 = 10u;

struct Params {
  mode: u32,
  n_opps: u32,
  n_cands: u32,
  games_per_opp: u32,
  start_pair: u32,
  pair_count: u32,
  seed_base: u32,
  total_per_opp: u32,
  wave_start: u32,
  wave_count: u32,
  wg_x: u32,
  pad0: u32,
};

struct Slot {
  occ: i32, ci: u32, stage_ov: i32, hp: i32, max_hp: i32, energy: i32,
  tool: i32, tool2: i32, status: u32, shield: i32, shield_ex: i32,
  counter: i32, weaken: i32, cost_tax: i32, retreat_tax: i32,
  next_atk_mod: i32, stack_boost: i32, turn_placed: i32,
};

struct GameState {
  board: array<array<Slot, 4>, 2>,
  libs: array<array<u32, 20>, 2>,
  hands: array<array<u32, 12>, 2>,
  lib_len: array<u32, 2>,
  hand_len: array<u32, 2>,
  points: array<i32, 2>,
  pts_last_turn: array<i32, 2>,
  ko_count: array<i32, 2>,
  ko_last_turn: array<i32, 2>,
  item_lock: array<i32, 2>,
  supp_lock: array<i32, 2>,
  evo_lock: array<i32, 2>,
  team_shield: array<i32, 2>,
  team_shield_type: array<i32, 2>,
  next_team_boost: array<i32, 2>,
  sweets_used_last: array<i32, 2>,
  sweets_total: array<i32, 2>,
  energy_discarded: array<i32, 2>,
  disc_poke: array<i32, 2>,
  disc_poke_p: array<i32, 2>,
  disc_item: array<i32, 2>,
  disc_supp: array<i32, 2>,
  disc_tool: array<i32, 2>,
  disc_basic_w: array<i32, 2>,
  disc_basic_any: array<i32, 2>,
  disc_quick_grow: array<i32, 2>,
  disc_volbeat: array<i32, 2>,
  delayed_slot: array<u32, 2>,
  delayed_dmg: array<i32, 2>,
  rng: u32,
  stadium: i32,
  cur: u32,
  turn: u32,
  done: u32,
  outcome: u32,
  end_turn: u32,
  pending_atk: i32,
  supporter_used: u32,
  guar_heads: u32,
  active_ex_blocked: u32,
  heal_blocked: u32,
  sweets_this_turn: i32,
  had_cant_atk_self: u32,
  had_cant_a1: u32,
  had_cant_a2: u32,
  cur_team_boost: i32,
  dmg_boost: i32,
  dmg_boost_ex: i32,
  named_boost: i32,
  named_h1: i32,
  named_h2: i32,
  eevee_boost: i32,
  iris_active: u32,
  iris_h1: i32,
  drayden_bonus: i32,
  ab_mask: u32,
  pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> out_u32: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> out_sample: array<u32>;
@group(0) @binding(6) var<storage, read_write> states_buf: array<GameState>;

var<workgroup> wg_acc: array<atomic<u32>, 11>;

@compute @workgroup_size(64)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  if (lid.x < 11u) { atomicStore(&wg_acc[lid.x], 0u); }
  workgroupBarrier();

  let slot = gid.y * (params.wg_x * 64u) + gid.x;
  let done_f = states_buf[slot].done;
  if (done_f == 1u) {
    let code = states_buf[slot].outcome;
    let trn = states_buf[slot].end_turn;
    atomicAdd(&wg_acc[0], 1u);
    atomicAdd(&wg_acc[10], trn);
    if (code == 1u) { atomicAdd(&wg_acc[1], 1u); }
    else if (code == 2u) { atomicAdd(&wg_acc[2], 1u); }
    else { atomicAdd(&wg_acc[3], 1u); }

    if (params.mode == 1u) {
      let idx = params.start_pair + params.wave_start + gid.x;
      let half = params.total_per_opp / 2u;
      let first = select(1u, 0u, idx < half);
      let first_cap = min(250u, half);
      if (idx < first_cap) {
        out_sample[idx] = code | (trn << 8u);
      } else if (idx >= half && idx < half + 250u) {
        out_sample[250u + (idx - half)] = code | (trn << 8u);
      }
      if (code == 1u) {
        if (first == 0u) { atomicAdd(&wg_acc[4], 1u); } else { atomicAdd(&wg_acc[7], 1u); }
      } else if (code == 2u) {
        if (first == 0u) { atomicAdd(&wg_acc[5], 1u); } else { atomicAdd(&wg_acc[8], 1u); }
      } else {
        if (first == 0u) { atomicAdd(&wg_acc[6], 1u); } else { atomicAdd(&wg_acc[9], 1u); }
      }
    }
  }
  workgroupBarrier();

  if (lid.x == 0u) {
    let t_tot = atomicLoad(&wg_acc[0]);
    if (t_tot > 0u) {
      let t_w = atomicLoad(&wg_acc[1]);
      let t_d = atomicLoad(&wg_acc[2]);
      let t_l = atomicLoad(&wg_acc[3]);
      let t_t = atomicLoad(&wg_acc[10]);

      if (params.mode == 0u) {
        let nc = params.n_cands;
        let opp_idx = gid.y / nc;
        let cand_idx = gid.y % nc;
        if (opp_idx < params.n_opps) {
          let opp_stride = 6u + nc * 4u;
          let c_off = 8u + cand_idx * 6u;
          let o_off = 512u + opp_idx * opp_stride;
          let oc_off = o_off + 6u + cand_idx * 4u;
          atomicAdd(&out_u32[0u], t_tot); atomicAdd(&out_u32[1u], t_w);
          atomicAdd(&out_u32[2u], t_d); atomicAdd(&out_u32[3u], t_l); atomicAdd(&out_u32[4u], t_t);
          atomicAdd(&out_u32[c_off], t_tot); atomicAdd(&out_u32[c_off + 1u], t_w);
          atomicAdd(&out_u32[c_off + 2u], t_d); atomicAdd(&out_u32[c_off + 3u], t_l);
          atomicAdd(&out_u32[o_off], t_tot); atomicAdd(&out_u32[o_off + 1u], t_w);
          atomicAdd(&out_u32[o_off + 2u], t_d); atomicAdd(&out_u32[o_off + 3u], t_l);
          atomicAdd(&out_u32[oc_off], t_tot); atomicAdd(&out_u32[oc_off + 1u], t_w);
          atomicAdd(&out_u32[oc_off + 2u], t_d); atomicAdd(&out_u32[oc_off + 3u], t_l);
        }
      } else if (params.mode == 1u) {
        atomicAdd(&out_u32[0u], t_tot); atomicAdd(&out_u32[1u], t_w);
        atomicAdd(&out_u32[2u], t_d); atomicAdd(&out_u32[3u], t_l);
        atomicAdd(&out_u32[4u], atomicLoad(&wg_acc[4])); atomicAdd(&out_u32[5u], atomicLoad(&wg_acc[5])); atomicAdd(&out_u32[6u], atomicLoad(&wg_acc[6]));
        atomicAdd(&out_u32[7u], atomicLoad(&wg_acc[7])); atomicAdd(&out_u32[8u], atomicLoad(&wg_acc[8])); atomicAdd(&out_u32[9u], atomicLoad(&wg_acc[9]));
        atomicAdd(&out_u32[10u], t_t);
      } else {
        let ci = gid.y / params.n_opps;
        let opp_idx = gid.y % params.n_opps;
        if (ci < params.n_cands && opp_idx < params.n_opps) {
          atomicAdd(&out_u32[ci * 4u], t_tot);
          atomicAdd(&out_u32[ci * 4u + 1u], t_w);
          atomicAdd(&out_u32[ci * 4u + 2u], t_d);
          atomicAdd(&out_u32[ci * 4u + 3u], t_l);
        }
      }
    }
  }
}
`;

let gpuEngineInstance = null;
let gpuProbePromise = null;

function packCardToI32(dst, o, c, slotId) {
  if (Array.isArray(c.v3Tpl) && c.v3Tpl.length >= 23) {
    for (let i = 0; i < 23; i++) dst[o + i] = c.v3Tpl[i] | 0;
    if (c.stage === 99) {
      dst[o + 1] = (dst[o + 1] & ~0xff) | 99;
      dst[o + 7] = 255; dst[o + 8] = 0; dst[o + 9] = 0; dst[o + 10] = 0; dst[o + 11] = 0;
      dst[o + 12] = 255; dst[o + 13] = 0; dst[o + 14] = 0; dst[o + 15] = 0; dst[o + 16] = 0;
      dst[o + 17] = 0; dst[o + 18] = 0;
    } else if (c.isPokemon === 0 && c.trainerKind === 0) {
      dst[o + 19] = 0; dst[o + 20] = 0;
    } else if (c.isPokemon === 1) {
      if (c.a1Cost === 255) { dst[o + 7] = 255; dst[o + 8] = 0; dst[o + 9] = 0; dst[o + 10] = 0; dst[o + 11] = 0; }
      if (c.a2Cost === 255) { dst[o + 12] = 255; dst[o + 13] = 0; dst[o + 14] = 0; dst[o + 15] = 0; dst[o + 16] = 0; }
    }
    dst[o + 23] = slotId | 0;
    dst[o + 24] = Math.round(Number(c.strategyBonus || 0) * 1024);
    dst[o + 25] = 0;
    dst[o + 26] = 0;
    dst[o + 27] = 0;
    return;
  }
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
  dst[o] = c.isPokemon | 0;
  dst[o + 1] = meta | 0;
  dst[o + 2] = (255 << 24) | 0;
  dst[o + 3] = (c.typeCode ?? 9) | 0;
  dst[o + 4] = (c.weakCode ?? 255) | 0;
  dst[o + 5] = (c.hp ?? 60) | 0;
  dst[o + 6] = ((c.retreat ?? 1) & 0xff) | (((c.prize ?? 1) & 0xff) << 8);
  dst[o + 7] = a1Cost | 0;
  dst[o + 8] = a1Dmg | 0;
  dst[o + 9] = (c.a1Op1 || 0) | ((c.a1Op2 || 0) << 8);
  dst[o + 10] = (c.a1Val1 || 0) | 0;
  dst[o + 11] = (c.a1Val2 || 0) | 0;
  dst[o + 12] = a2Cost | 0;
  dst[o + 13] = a2Dmg | 0;
  dst[o + 14] = (c.a2Op1 || 0) | ((c.a2Op2 || 0) << 8);
  dst[o + 15] = (c.a2Val1 || 0) | 0;
  dst[o + 16] = (c.a2Val2 || 0) | 0;
  dst[o + 17] = (c.abOp || 0) | 0;
  dst[o + 18] = (c.abVal || 0) | 0;
  dst[o + 19] = (c.trainerKind || 0) | ((c.trainerSub || 1) << 8);
  dst[o + 20] = (c.effectVal || 0) | 0;
  dst[o + 21] = 0;
  dst[o + 22] = 0;
  dst[o + 23] = slotId | 0;
  dst[o + 24] = Math.round(Number(c.strategyBonus || 0) * 1024);
  dst[o + 25] = 0;
  dst[o + 26] = 0;
  dst[o + 27] = 0;
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

      const maxBinding = Number(device.limits?.maxStorageBufferBindingSize || 134217728);
      const MAX_WAVE_SLOTS = Math.min(65536, Math.floor((maxBinding - 1048576) / SIM_STATE_BYTES));
      const statesBufSize = MAX_WAVE_SLOTS * SIM_STATE_BYTES;

      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
        ]
      });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

      const initMod = device.createShaderModule({ code: WGSL_INIT });
      const mainMod = device.createShaderModule({ code: WGSL_MAIN });
      const atkMod = device.createShaderModule({ code: WGSL_ATK_CHECKUP });
      const finMod = device.createShaderModule({ code: WGSL_FINALIZE });
      await Promise.all([
        checkShaderModule(initMod, 'INIT'),
        checkShaderModule(mainMod, 'MAIN'),
        checkShaderModule(atkMod, 'ATK_CHECKUP'),
        checkShaderModule(finMod, 'FINALIZE')
      ]);

      const [initPipeline, mainPipeline, atkPipeline, finPipeline] = await Promise.all([
        device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: initMod, entryPoint: 'main' } }),
        device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: mainMod, entryPoint: 'main' } }),
        device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: atkMod, entryPoint: 'main' } }),
        device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module: finMod, entryPoint: 'main' } })
      ]);

      const uniformBuf = device.createBuffer({
        size: 48,
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
      const statesBuf = device.createBuffer({
        size: statesBufSize,
        usage: GPUBufferUsage.STORAGE
      });
      const readU32Buf = device.createBuffer({
        size: outU32Size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const readSampleBuf = device.createBuffer({
        size: outSampleSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });

      const sharedBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: decksBuf } },
          { binding: 2, resource: { buffer: weightsBuf } },
          { binding: 3, resource: { buffer: outU32Buf } },
          { binding: 4, resource: { buffer: outSampleBuf } },
          { binding: 5, resource: { buffer: candCardsBuf } },
          { binding: 6, resource: { buffer: statesBuf } }
        ]
      });

      const zeroU32 = new Uint32Array(4096);
      const zeroSample = new Uint32Array(512);
      const decksHost = new Int32Array(12 * 20 * CARD_STRIDE);
      const candCardsHost = new Int32Array(256 * CARD_STRIDE);
      const weightsHost = new Int32Array((MAX_ENEMIES + MAX_CANDS) * FEATURES);
      const uniformHost = new Uint32Array(12);

      function dispatchWave(mode, nOpps, nCands, gamesPerOpp, startPair, pairCount, seedBase, totalPerOpp, waveStart, waveCount, wgY) {
        const wgX = Math.max(1, Math.ceil(waveCount / WG_SIZE));
        uniformHost[0] = mode >>> 0;
        uniformHost[1] = nOpps >>> 0;
        uniformHost[2] = nCands >>> 0;
        uniformHost[3] = gamesPerOpp >>> 0;
        uniformHost[4] = startPair >>> 0;
        uniformHost[5] = pairCount >>> 0;
        uniformHost[6] = seedBase >>> 0;
        uniformHost[7] = totalPerOpp >>> 0;
        uniformHost[8] = waveStart >>> 0;
        uniformHost[9] = waveCount >>> 0;
        uniformHost[10] = wgX >>> 0;
        uniformHost[11] = 0;
        device.queue.writeBuffer(uniformBuf, 0, uniformHost);

        const encoder = device.createCommandEncoder();
        const p0 = encoder.beginComputePass();
        p0.setPipeline(initPipeline);
        p0.setBindGroup(0, sharedBindGroup);
        p0.dispatchWorkgroups(wgX, wgY, 1);
        p0.end();

        for (let t = 0; t < 30; t++) {
          const pm = encoder.beginComputePass();
          pm.setPipeline(mainPipeline);
          pm.setBindGroup(0, sharedBindGroup);
          pm.dispatchWorkgroups(wgX, wgY, 1);
          pm.end();

          const pa = encoder.beginComputePass();
          pa.setPipeline(atkPipeline);
          pa.setBindGroup(0, sharedBindGroup);
          pa.dispatchWorkgroups(wgX, wgY, 1);
          pa.end();
        }

        const pf = encoder.beginComputePass();
        pf.setPipeline(finPipeline);
        pf.setBindGroup(0, sharedBindGroup);
        pf.dispatchWorkgroups(wgX, wgY, 1);
        pf.end();
        return encoder;
      }

      // Smoke check (16 games)
      const dummyCard = {
        isPokemon: 1, stage: 0, evoGroup: 1, isSupporter: 0, isItem: 0, isFossil: 0,
        typeCode: 1, weakCode: 2, hp: 60, retreat: 1, prize: 1,
        a1Cost: 1, a1Dmg: 30, a1Op1: 0, a1Op2: 0, a1Val1: 0, a1Val2: 0,
        a2Cost: 255, a2Dmg: 0, a2Op1: 0, a2Op2: 0, a2Val1: 0, a2Val2: 0,
        abOp: 0, abVal: 0, trainerKind: 0, effectVal: 0, strategyBonus: 0
      };
      packDeckToI32(decksHost, 0, Array(20).fill(dummyCard));
      packDeckToI32(decksHost, 1, Array(20).fill(dummyCard));
      device.queue.writeBuffer(decksBuf, 0, decksHost);
      device.queue.writeBuffer(weightsBuf, 0, weightsHost);
      device.queue.writeBuffer(outU32Buf, 0, zeroU32.subarray(0, 64));
      const smokeEnc = dispatchWave(0, 1, 1, 16, 0, 16, 12345, 16, 0, 16, 1);
      smokeEnc.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, 64);
      device.queue.submit([smokeEnc.finish()]);
      await readU32Buf.mapAsync(GPUMapMode.READ, 0, 64);
      const smoke = new Uint32Array(readU32Buf.getMappedRange(0, 64).slice(0));
      readU32Buf.unmap();
      if (smoke[0] !== 16) {
        throw Error(`Wavefront shader smoke check failed (expected 16, got ${smoke[0]})`);
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
          const wgY = nOpps * nCands;
          const maxWgX = Math.max(1, Math.floor(MAX_WAVE_SLOTS / (wgY * WG_SIZE)));
          const waveMaxK = maxWgX * WG_SIZE;

          device.queue.writeBuffer(outU32Buf, 0, zeroU32);
          for (let ws = 0; ws < pairCount; ws += waveMaxK) {
            const wc = Math.min(waveMaxK, pairCount - ws);
            const enc = dispatchWave(0, nOpps, nCands, gamesPerOpp, startPair, pairCount, seedBase, gamesPerOpp, ws, wc, wgY);
            if (ws + wc >= pairCount) {
              enc.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, outU32Size);
            }
            device.queue.submit([enc.finish()]);
          }

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

          const waveMaxK = Math.floor(MAX_WAVE_SLOTS / WG_SIZE) * WG_SIZE;
          const agg = {
            total: 0, wins: 0, draws: 0, losses: 0,
            firstWins: 0, firstDraws: 0, firstLosses: 0,
            secondWins: 0, secondDraws: 0, secondLosses: 0,
            turnsSum: 0
          };
          for (let start = 0; start < totalPerOpp; start += waveMaxK) {
            const count = Math.min(waveMaxK, totalPerOpp - start);
            device.queue.writeBuffer(outU32Buf, 0, zeroU32.subarray(0, 16));
            const enc = dispatchWave(1, 1, 1, totalPerOpp, start, count, seedBase, totalPerOpp, 0, count, 1);
            enc.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, 64);
            device.queue.submit([enc.finish()]);

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

          const wgY = nCands * nOpps;
          const maxWgX = Math.max(1, Math.floor(MAX_WAVE_SLOTS / (wgY * WG_SIZE)));
          const waveMaxK = maxWgX * WG_SIZE;
          const outCount = nCands * 4;
          const outBytes = outCount * 4;

          device.queue.writeBuffer(outU32Buf, 0, zeroU32.subarray(0, outCount));
          for (let ws = 0; ws < gamesPerOpp; ws += waveMaxK) {
            const wc = Math.min(waveMaxK, gamesPerOpp - ws);
            const enc = dispatchWave(2, nOpps, nCands, gamesPerOpp, 0, gamesPerOpp, seedBase, gamesPerOpp, ws, wc, wgY);
            if (ws + wc >= gamesPerOpp) {
              enc.copyBufferToBuffer(outU32Buf, 0, readU32Buf, 0, outBytes);
            }
            device.queue.submit([enc.finish()]);
          }

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
