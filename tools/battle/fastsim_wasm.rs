//! Zero-allocation, fixed-point i32 WebAssembly Fast-Sim Engine for Pocket Lab.
//! Uses EXACT same Rng32 + Q10 (x1024) fixed-point i32 scoring as WebGPU WGSL compute shader
//! and native Top-10 Round-Robin League trainer -> 100.000% bit-for-bit parity across GPU, CPU, and Replay!
//! Supports per-opponent 10M-trained elite enemy weights (WEIGHTS_BUF[0..10*22]) and up to 40 candidates.

#![allow(static_mut_refs)]

const FEATURES: usize = 22;
const CARD_STRIDE: usize = 14;
const MAX_DECKS: usize = 12; // 0 = player, 1..=10 = enemies
const MAX_ENEMIES: usize = 10;
const MAX_CANDS: usize = 40;
const STEP_STRIDE: usize = 24;
const MAX_REPLAY_STEPS: usize = 1024;

static mut DECKS_BUF: [i32; MAX_DECKS * 20 * CARD_STRIDE] = [0; MAX_DECKS * 20 * CARD_STRIDE];
static mut BONUS_BUF: [i32; MAX_DECKS * 20] = [0; MAX_DECKS * 20]; // Q10 fixed-point (* 1024)
// WEIGHTS_BUF layout (all Q10 i32):
// [0 .. 10*22]       = enemy_weights[0..10] (each opponent's own 10M-trained elite weights!)
// [10*22 .. 50*22]   = candidates[0..40] (or player test weights at cand 0)
static mut WEIGHTS_BUF: [i32; (MAX_ENEMIES + MAX_CANDS) * FEATURES] = [0; (MAX_ENEMIES + MAX_CANDS) * FEATURES];
static mut OUT_U32: [u32; 16384] = [0; 16384];
static mut OUT_F64: [f64; 4096] = [0.0; 4096];
static mut OUT_U8: [u8; 131072] = [0; 131072];
static mut REPLAY_BUF: [i32; MAX_REPLAY_STEPS * STEP_STRIDE] = [0; MAX_REPLAY_STEPS * STEP_STRIDE];
static mut REPLAY_LEN: u32 = 0;

#[no_mangle] pub extern "C" fn get_decks_ptr() -> *mut i32 { unsafe { DECKS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_bonus_ptr() -> *mut i32 { unsafe { BONUS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_weights_ptr() -> *mut i32 { unsafe { WEIGHTS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_out_u32_ptr() -> *mut u32 { unsafe { OUT_U32.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_out_f64_ptr() -> *mut f64 { unsafe { OUT_F64.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_out_u8_ptr() -> *mut u8 { unsafe { OUT_U8.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_replay_ptr() -> *mut i32 { unsafe { REPLAY_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_replay_len() -> u32 { unsafe { REPLAY_LEN } }

#[derive(Clone, Copy, Default)]
struct CompactCard {
    slot_id: i16,
    is_pokemon: u8,
    stage: u8,
    type_code: u8,
    weak_code: u8,
    hp: i16,
    retreat: u8,
    prize: u8,
    atk_cost: u8,
    atk_dmg: i16,
    atk_flags: u8,
    ab_flags: u8,
    trainer_kind: u8,
    effect_val: i16,
    power_q: i32,
    bonus_q: i32,
}

#[derive(Clone, Copy, Default)]
struct Slot {
    occ: bool,
    card: CompactCard,
    hp: i16,
    max_hp: i16,
    energy: u8,
    tool: i8,
    status: u8,
    turn_placed: u8,
}

/// Exact 32-bit hash + xorshift RNG shared bit-for-bit with WebGPU WGSL compute shader!
#[derive(Clone, Copy)]
struct Rng32(u32);
impl Rng32 {
    #[inline(always)]
    fn new(seed: u32) -> Self {
        let mut s = seed ^ 0x9e3779b9u32;
        s ^= s >> 16;
        s = s.wrapping_mul(0x7feb352du32);
        s ^= s >> 15;
        s = s.wrapping_mul(0x846ca68bu32);
        s ^= s >> 16;
        Self(s | 1u32)
    }
    #[inline(always)]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x.wrapping_mul(0x27d4eb2du32)
    }
}

#[inline(always)]
fn read_deck(deck_slot: usize) -> [CompactCard; 20] {
    let mut out = [CompactCard::default(); 20];
    unsafe {
        let base_c = deck_slot * 20;
        for i in 0..20 {
            let off = (base_c + i) * CARD_STRIDE;
            let atk_dmg = DECKS_BUF[off + 8] as i16;
            out[i] = CompactCard {
                slot_id: DECKS_BUF[off + 13] as i16,
                is_pokemon: DECKS_BUF[off] as u8,
                stage: DECKS_BUF[off + 1] as u8,
                type_code: DECKS_BUF[off + 2] as u8,
                weak_code: DECKS_BUF[off + 3] as u8,
                hp: DECKS_BUF[off + 4] as i16,
                retreat: DECKS_BUF[off + 5] as u8,
                prize: (DECKS_BUF[off + 6] as u8).max(1),
                atk_cost: (DECKS_BUF[off + 7] as u8).max(1),
                atk_dmg,
                atk_flags: DECKS_BUF[off + 9] as u8,
                ab_flags: DECKS_BUF[off + 10] as u8,
                trainer_kind: DECKS_BUF[off + 11] as u8,
                effect_val: DECKS_BUF[off + 12] as i16,
                power_q: ((atk_dmg as i32) * 1024) / 100,
                bonus_q: BONUS_BUF[base_c + i],
            };
        }
    }
    out
}

#[inline(always)]
fn push_replay_step(
    turn: u8,
    actor: usize,
    kind: i32,
    card_idx: i32,
    aux1: i32,
    aux2: i32,
    points: &[u8; 2],
    board: &[[Slot; 4]; 2],
    hand_len: &[usize; 2],
    lib_len: &[usize; 2],
) {
    unsafe {
        let idx = REPLAY_LEN as usize;
        if idx >= MAX_REPLAY_STEPS { return; }
        let o = idx * STEP_STRIDE;
        REPLAY_BUF[o] = turn as i32;
        REPLAY_BUF[o + 1] = actor as i32;
        REPLAY_BUF[o + 2] = kind;
        REPLAY_BUF[o + 3] = card_idx;
        REPLAY_BUF[o + 4] = aux1;
        REPLAY_BUF[o + 5] = aux2;
        REPLAY_BUF[o + 6] = points[0] as i32;
        REPLAY_BUF[o + 7] = points[1] as i32;

        for p in 0..2 {
            let bo = o + 8 + p * 8;
            let act = board[p][0];
            let mut bench_cnt = 0i32;
            for s in 1..4 { if board[p][s].occ { bench_cnt += 1; } }
            REPLAY_BUF[bo] = if act.occ { act.card.slot_id as i32 } else { -1 };
            REPLAY_BUF[bo + 1] = if act.occ { act.hp as i32 } else { 0 };
            REPLAY_BUF[bo + 2] = if act.occ { act.max_hp as i32 } else { 0 };
            REPLAY_BUF[bo + 3] = if act.occ { act.energy as i32 } else { 0 };
            REPLAY_BUF[bo + 4] = bench_cnt;
            REPLAY_BUF[bo + 5] = hand_len[p] as i32;
            REPLAY_BUF[bo + 6] = lib_len[p] as i32;
            REPLAY_BUF[bo + 7] = if act.occ { act.tool as i32 } else { 0 };
        }
        REPLAY_LEN += 1;
    }
}

#[inline(always)]
fn simulate_i32_impl<const RECORD: bool>(
    d0: &[CompactCard; 20],
    d1: &[CompactCard; 20],
    w0: &[i32; FEATURES],
    w1: &[i32; FEATURES],
    seed: u32,
    first_player: usize,
    track_feat: bool,
    feat_out: &mut [f32; FEATURES],
    points_out: &mut [u8; 2],
) -> (u8, u8, bool) {
    let mut rng = Rng32::new(seed);
    let mut libs = [*d0, *d1];
    let mut lib_len = [20usize, 20usize];
    let mut hands = [[CompactCard::default(); 12]; 2];
    let mut hand_len = [0usize, 0usize];
    let mut board = [[Slot::default(); 4]; 2];
    let mut points = [0u8, 0u8];
    let mut feat_sum = [0.0f32; FEATURES];
    let mut feat_cnt = 0u32;

    if RECORD {
        unsafe { REPLAY_LEN = 0; }
    }

    for p in 0..2 {
        for i in (1..20).rev() {
            let j = (rng.next_u32() as usize) % (i + 1);
            libs[p].swap(i, j);
        }
        let mut basic_pos = 20usize;
        for i in 0..20 {
            if libs[p][i].is_pokemon == 1 && libs[p][i].stage == 0 {
                basic_pos = i;
                break;
            }
        }
        if basic_pos < 20 && basic_pos >= 5 { libs[p].swap(0, basic_pos); }
        for _ in 0..5 {
            lib_len[p] -= 1;
            hands[p][hand_len[p]] = libs[p][lib_len[p]];
            hand_len[p] += 1;
        }
        let mut placed_active = false;
        let mut idx = 0;
        while idx < hand_len[p] {
            let c = hands[p][idx];
            if c.is_pokemon == 1 && c.stage == 0 {
                if !placed_active {
                    board[p][0] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, turn_placed: 0 };
                    placed_active = true;
                    hand_len[p] -= 1;
                    hands[p][idx] = hands[p][hand_len[p]];
                    if RECORD { push_replay_step(0, p, 1, c.slot_id as i32, 0, 0, &points, &board, &hand_len, &lib_len); }
                    continue;
                } else {
                    let mut placed_bench = false;
                    let mut bslot = 0;
                    for s in 1..4 {
                        if !board[p][s].occ {
                            board[p][s] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, turn_placed: 0 };
                            placed_bench = true;
                            bslot = s;
                            break;
                        }
                    }
                    if placed_bench {
                        hand_len[p] -= 1;
                        hands[p][idx] = hands[p][hand_len[p]];
                        if RECORD { push_replay_step(0, p, 2, c.slot_id as i32, bslot as i32, 0, &points, &board, &hand_len, &lib_len); }
                        continue;
                    }
                }
            }
            idx += 1;
        }
        if !placed_active {
            let fb = if p == 0 { d0[0] } else { d1[0] };
            board[p][0] = Slot { occ: true, card: fb, hp: fb.hp.max(60), max_hp: fb.hp.max(60), energy: 0, tool: 0, status: 0, turn_placed: 0 };
            if RECORD { push_replay_step(0, p, 1, fb.slot_id as i32, 0, 0, &points, &board, &hand_len, &lib_len); }
        }
    }

    let mut cur = first_player;
    for turn in 1u8..=30u8 {
        let foe = 1 - cur;
        let w = if cur == 0 { w0 } else { w1 };
        let do_track = track_feat && cur == 0;

        if lib_len[cur] > 0 && hand_len[cur] < 12 {
            lib_len[cur] -= 1;
            let drawn = libs[cur][lib_len[cur]];
            hands[cur][hand_len[cur]] = drawn;
            hand_len[cur] += 1;
            if RECORD { push_replay_step(turn, cur, 3, drawn.slot_id as i32, 1, 0, &points, &board, &hand_len, &lib_len); }
        }

        let mut energy_attached = turn == 1;
        let mut supporter_used = false;
        let mut retreated = false;
        let mut ability_used = false;
        let mut dmg_boost: i16 = 0;

        for _step in 0..8 {
            let mut best_kind: u8 = 0;
            let mut best_a: usize = 0;
            let mut best_b: usize = 0;
            let mut best_score: i32 = w[0];
            let mut chosen_f0 = 0usize;
            let mut chosen_f1 = 0usize;
            let mut chosen_v1 = 0.0f32;
            let mut n_opts = 1u32;

            // 1. Place basics
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage == 0 {
                    for s in 1..4 {
                        if !board[cur][s].occ {
                            n_opts += 1;
                            let sc = w[2] + (((c.power_q * w[3]) >> 10) * 15 / 100) + ((c.bonus_q * 35) / 100);
                            if sc > best_score {
                                best_score = sc; best_kind = 1; best_a = hi; best_b = s;
                                chosen_f0 = 2; chosen_f1 = 3; chosen_v1 = (c.power_q as f32) * (0.15 / 1024.0);
                            }
                            break;
                        }
                    }
                }
            }

            // 2. Evolve
            if turn >= 2 {
                for hi in 0..hand_len[cur] {
                    let c = hands[cur][hi];
                    if c.is_pokemon == 1 && c.stage > 0 {
                        for s in 0..4 {
                            if board[cur][s].occ && board[cur][s].card.stage + 1 == c.stage && board[cur][s].turn_placed < turn {
                                n_opts += 1;
                                let p_shift = if s == 0 { c.power_q } else { c.power_q >> 1 };
                                let sc = w[4] + ((p_shift * w[5]) >> 10) + ((c.bonus_q * 45) / 100);
                                if sc > best_score {
                                    best_score = sc; best_kind = 2; best_a = hi; best_b = s;
                                    chosen_f0 = 4; chosen_f1 = 5; chosen_v1 = (p_shift as f32) / 1024.0;
                                }
                            }
                        }
                    }
                }
            }

            // 3. Abilities
            if !ability_used {
                for s in 0..4 {
                    if board[cur][s].occ && board[cur][s].card.ab_flags != 0 {
                        n_opts += 1;
                        let sn = if (board[cur][s].card.ab_flags & 16) != 0 { (w[21] * 35) / 100 } else { 0 };
                        let sc = w[6] + sn + ((board[cur][s].card.bonus_q * 35) / 100);
                        if sc > best_score {
                            best_score = sc; best_kind = 4; best_a = s;
                            chosen_f0 = 6; chosen_f1 = 21; chosen_v1 = if sn != 0 { 0.35 } else { 0.0 };
                        }
                    }
                }
            }

            // 4. Trainers
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 0 {
                    let is_sup = c.trainer_kind == 2 || c.trainer_kind == 3 || c.trainer_kind == 4;
                    if is_sup && supporter_used { continue; }
                    let mut sc = w[7] + ((c.bonus_q * 40) / 100);
                    let mut f1 = 7usize;
                    let mut v1 = 0.0f32;
                    match c.trainer_kind {
                        1 => {
                            let inv = 5120 / (5 + hand_len[cur] as i32);
                            sc += (inv * w[8]) >> 10; f1 = 8; v1 = (inv as f32) / 1024.0;
                        }
                        2 => {
                            let missing = board[cur][0].max_hp - board[cur][0].hp;
                            if missing <= 0 { continue; }
                            let heal_amt = missing.min(c.effect_val) as i32;
                            sc += (w[20] * heal_amt) / 50; f1 = 20; v1 = (heal_amt as f32) * 0.02;
                        }
                        3 => { sc += ((w[19] * 45) + (w[21] * 25)) / 100; f1 = 19; v1 = 0.5; }
                        4 => { sc += ((w[10] * 35) + (w[11] * 25)) / 100; f1 = 11; v1 = 0.4; }
                        5 => {
                            if board[cur][0].tool != 0 { continue; }
                            sc += w[20]; f1 = 20; v1 = 1.0;
                        }
                        6 => { sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5; }
                        7 => { sc += w[6]; f1 = 6; v1 = 0.8; }
                        _ => {}
                    }
                    n_opts += 1;
                    if sc > best_score {
                        best_score = sc; best_kind = 3; best_a = hi;
                        chosen_f0 = 7; chosen_f1 = f1; chosen_v1 = v1;
                    }
                }
            }

            // 5. Energy attach
            if !energy_attached {
                for s in 0..4 {
                    if board[cur][s].occ {
                        n_opts += 1;
                        let need_b = board[cur][s].energy < board[cur][s].card.atk_cost;
                        let sc = w[13]
                            + (if s == 0 { w[14] } else { 0 })
                            + (if need_b { w[15] } else { 0 })
                            + ((board[cur][s].card.power_q * w[16]) >> 10)
                            + ((board[cur][s].card.bonus_q * 25) / 100);
                        if sc > best_score {
                            best_score = sc; best_kind = 5; best_a = s;
                            chosen_f0 = 13; chosen_f1 = if s == 0 { 14 } else { 15 }; chosen_v1 = if s == 0 || need_b { 1.0 } else { 0.0 };
                        }
                    }
                }
            }

            // 6. Retreat
            if !retreated && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.retreat {
                let foe_dmg = if board[foe][0].occ { board[foe][0].card.atk_dmg } else { 0 };
                for s in 1..4 {
                    if board[cur][s].occ {
                        n_opts += 1;
                        let endg_b = board[cur][0].hp <= foe_dmg && board[cur][s].hp > board[cur][0].hp;
                        let sc = w[17] + (if endg_b { w[18] } else { 0 });
                        if sc > best_score {
                            best_score = sc; best_kind = 6; best_a = s;
                            chosen_f0 = 17; chosen_f1 = 18; chosen_v1 = if endg_b { 1.0 } else { 0.0 };
                        }
                    }
                }
            }

            // 7. Attack
            if turn >= 2 && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.atk_cost && board[cur][0].card.atk_dmg > 0 {
                n_opts += 1;
                let atk = board[cur][0].card;
                let weak_bonus = if board[foe][0].occ && board[foe][0].card.weak_code == atk.type_code { 20 } else { 0 };
                let total_dmg = atk.atk_dmg + dmg_boost + weak_bonus;
                let ko_b = board[foe][0].occ && total_dmg >= board[foe][0].hp;
                let eff = if (atk.atk_flags & 1) != 0 { w[12] } else { 0 };
                let snipe = if (atk.atk_flags & 2) != 0 { w[21] >> 1 } else { 0 };
                let sc = w[9] + ((total_dmg as i32 * w[10]) / 100) + (if ko_b { w[11] } else { 0 }) + eff + snipe + ((atk.bonus_q * 40) / 100);
                if sc > best_score {
                    best_kind = 7;
                    chosen_f0 = 9; chosen_f1 = if ko_b { 11 } else { 10 }; chosen_v1 = if ko_b { 1.0 } else { (total_dmg as f32) * 0.01 };
                }
            }

            if do_track && n_opts > 1 {
                feat_sum[chosen_f0] += 1.0;
                if chosen_f1 < FEATURES { feat_sum[chosen_f1] += chosen_v1; }
                feat_cnt += 1;
            }

            match best_kind {
                0 => {
                    if RECORD { push_replay_step(turn, cur, 11, -1, 0, 0, &points, &board, &hand_len, &lib_len); }
                    break;
                }
                1 => {
                    let c = hands[cur][best_a];
                    board[cur][best_b] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, turn_placed: turn };
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
                    if RECORD { push_replay_step(turn, cur, 4, c.slot_id as i32, best_b as i32, 0, &points, &board, &hand_len, &lib_len); }
                }
                2 => {
                    let c = hands[cur][best_a];
                    let dmg_taken = (board[cur][best_b].max_hp - board[cur][best_b].hp).max(0);
                    let bonus_hp = if board[cur][best_b].tool == 1 { 20 } else { 0 };
                    board[cur][best_b].card = c;
                    board[cur][best_b].max_hp = c.hp + bonus_hp;
                    board[cur][best_b].hp = (board[cur][best_b].max_hp - dmg_taken).max(10);
                    board[cur][best_b].status = 0;
                    board[cur][best_b].turn_placed = turn;
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
                    if RECORD { push_replay_step(turn, cur, 5, c.slot_id as i32, best_b as i32, 0, &points, &board, &hand_len, &lib_len); }
                }
                3 => {
                    let c = hands[cur][best_a];
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
                    if c.trainer_kind == 2 || c.trainer_kind == 3 || c.trainer_kind == 4 { supporter_used = true; }
                    match c.trainer_kind {
                        1 => {
                            let draws = c.effect_val.clamp(1, 2) as usize;
                            for _ in 0..draws {
                                if lib_len[cur] > 0 && hand_len[cur] < 12 {
                                    lib_len[cur] -= 1;
                                    hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
                                    hand_len[cur] += 1;
                                }
                            }
                        }
                        2 => { board[cur][0].hp = (board[cur][0].hp + c.effect_val).min(board[cur][0].max_hp); }
                        3 => {
                            if c.effect_val == 3 {
                                if hand_len[foe] > 3 { hand_len[foe] = 3; }
                            } else {
                                let mut pick = 4usize;
                                for s in 1..4 {
                                    if board[foe][s].occ {
                                        if c.effect_val == 2 && board[foe][s].hp < board[foe][s].max_hp { pick = s; break; }
                                        if pick == 4 || board[foe][s].hp < board[foe][pick].hp { pick = s; }
                                    }
                                }
                                if pick < 4 { board[foe].swap(0, pick); }
                            }
                        }
                        4 => { dmg_boost += c.effect_val; }
                        5 => {
                            if c.effect_val > 0 {
                                board[cur][0].tool = 1;
                                board[cur][0].max_hp += 20;
                                board[cur][0].hp += 20;
                            } else {
                                board[cur][0].tool = 2;
                            }
                        }
                        6 => {
                            if c.effect_val == 99 && turn >= 2 {
                                for hi2 in 0..hand_len[cur] {
                                    if hands[cur][hi2].is_pokemon == 1 && hands[cur][hi2].stage == 2 {
                                        for s in 0..4 {
                                            if board[cur][s].occ && board[cur][s].card.stage == 0 && board[cur][s].turn_placed < turn {
                                                let ev = hands[cur][hi2];
                                                let taken = (board[cur][s].max_hp - board[cur][s].hp).max(0);
                                                board[cur][s].card = ev;
                                                board[cur][s].max_hp = ev.hp + if board[cur][s].tool == 1 { 20 } else { 0 };
                                                board[cur][s].hp = (board[cur][s].max_hp - taken).max(10);
                                                board[cur][s].status = 0;
                                                board[cur][s].turn_placed = turn;
                                                hand_len[cur] -= 1;
                                                hands[cur][hi2] = hands[cur][hand_len[cur]];
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                }
                            } else if c.effect_val >= 2 {
                                board[cur][0].energy = board[cur][0].energy.saturating_add(1);
                            }
                        }
                        7 => { dmg_boost += 10; }
                        _ => {}
                    }
                    if RECORD { push_replay_step(turn, cur, 6, c.slot_id as i32, c.trainer_kind as i32, c.effect_val as i32, &points, &board, &hand_len, &lib_len); }
                }
                4 => {
                    ability_used = true;
                    let ab = board[cur][best_a].card.ab_flags;
                    let ab_card_id = board[cur][best_a].card.slot_id as i32;
                    if (ab & 2) != 0 && lib_len[cur] > 0 && hand_len[cur] < 12 {
                        lib_len[cur] -= 1;
                        hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
                        hand_len[cur] += 1;
                    }
                    if (ab & 4) != 0 { board[cur][0].energy = board[cur][0].energy.saturating_add(1); }
                    if (ab & 8) != 0 { board[cur][0].hp = (board[cur][0].hp + 20).min(board[cur][0].max_hp); }
                    if (ab & 16) != 0 {
                        let mut target_s = 0;
                        for s in 1..4 { if board[foe][s].occ { target_s = s; break; } }
                        if board[foe][target_s].occ {
                            board[foe][target_s].hp -= 20;
                            if board[foe][target_s].hp <= 0 {
                                points[cur] = points[cur].saturating_add(board[foe][target_s].card.prize);
                                board[foe][target_s].occ = false;
                                if target_s == 0 {
                                    for ns in 1..4 { if board[foe][ns].occ { board[foe].swap(0, ns); break; } }
                                }
                                if RECORD { push_replay_step(turn, cur, 7, ab_card_id, best_a as i32, ab as i32, &points, &board, &hand_len, &lib_len); }
                                if points[cur] >= 3 || !board[foe][0].occ {
                                    *points_out = points;
                                    return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                                }
                            }
                        }
                    }
                    if RECORD { push_replay_step(turn, cur, 7, ab_card_id, best_a as i32, ab as i32, &points, &board, &hand_len, &lib_len); }
                }
                5 => {
                    energy_attached = true;
                    board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1);
                    if RECORD { push_replay_step(turn, cur, 8, board[cur][best_a].card.slot_id as i32, best_a as i32, board[cur][best_a].energy as i32, &points, &board, &hand_len, &lib_len); }
                }
                6 => {
                    retreated = true;
                    let old_id = board[cur][0].card.slot_id as i32;
                    let new_id = board[cur][best_a].card.slot_id as i32;
                    board[cur][0].energy = board[cur][0].energy.saturating_sub(board[cur][0].card.retreat);
                    board[cur][0].status = 0;
                    board[cur].swap(0, best_a);
                    if RECORD { push_replay_step(turn, cur, 9, old_id, best_a as i32, new_id, &points, &board, &hand_len, &lib_len); }
                }
                7 => {
                    let atk = board[cur][0].card;
                    let weak_bonus = if board[foe][0].occ && board[foe][0].card.weak_code == atk.type_code { 20 } else { 0 };
                    let total_dmg = atk.atk_dmg + dmg_boost + weak_bonus;
                    let mut ko_flag = 0i32;
                    if board[foe][0].occ {
                        board[foe][0].hp -= total_dmg;
                        if board[foe][0].tool == 2 { board[cur][0].hp -= 20; }
                        if (atk.atk_flags & 2) != 0 {
                            for s in 1..4 {
                                if board[foe][s].occ {
                                    board[foe][s].hp -= 20;
                                    if board[foe][s].hp <= 0 {
                                        points[cur] = points[cur].saturating_add(board[foe][s].card.prize);
                                        board[foe][s].occ = false;
                                    }
                                    break;
                                }
                            }
                        }
                        if (atk.atk_flags & 4) != 0 { board[foe][0].status |= 1; }
                        if (atk.atk_flags & 8) != 0 { board[cur][0].hp = (board[cur][0].hp + 20).min(board[cur][0].max_hp); }
                        if (atk.atk_flags & 16) != 0 { board[cur][0].energy = board[cur][0].energy.saturating_add(1); }

                        if board[foe][0].hp <= 0 {
                            ko_flag = 1;
                            points[cur] = points[cur].saturating_add(board[foe][0].card.prize);
                            board[foe][0].occ = false;
                            for ns in 1..4 { if board[foe][ns].occ { board[foe].swap(0, ns); break; } }
                        }
                        if board[cur][0].hp <= 0 {
                            points[foe] = points[foe].saturating_add(board[cur][0].card.prize);
                            board[cur][0].occ = false;
                            for ns in 1..4 { if board[cur][ns].occ { board[cur].swap(0, ns); break; } }
                        }
                        if RECORD { push_replay_step(turn, cur, 10, atk.slot_id as i32, total_dmg as i32, (weak_bonus as i32) | (ko_flag << 8), &points, &board, &hand_len, &lib_len); }
                        let cur_won = points[cur] >= 3 || !board[foe][0].occ;
                        let foe_won = points[foe] >= 3 || !board[cur][0].occ;
                        if cur_won && foe_won { *points_out = points; return finish_game(2, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                        if cur_won { *points_out = points; return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                        if foe_won { *points_out = points; return finish_game(if foe == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                    }
                    break;
                }
                _ => break,
            }
        }

        for p in 0..2 {
            if board[p][0].occ && (board[p][0].status & 1) != 0 {
                let st_card = board[p][0].card.slot_id as i32;
                board[p][0].hp -= 10;
                if board[p][0].hp <= 0 {
                    let opp = 1 - p;
                    points[opp] = points[opp].saturating_add(board[p][0].card.prize);
                    board[p][0].occ = false;
                    for ns in 1..4 { if board[p][ns].occ { board[p].swap(0, ns); break; } }
                    if RECORD { push_replay_step(turn, p, 12, st_card, 10, 1, &points, &board, &hand_len, &lib_len); }
                    if points[opp] >= 3 || !board[p][0].occ {
                        *points_out = points;
                        return finish_game(if opp == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                    }
                } else if RECORD {
                    push_replay_step(turn, p, 12, st_card, 10, 0, &points, &board, &hand_len, &lib_len);
                }
            }
        }
        cur = foe;
    }

    *points_out = points;
    finish_game(2, 30, track_feat, feat_cnt, &feat_sum, feat_out)
}

#[inline(always)]
fn finish_game(code: u8, turn: u8, track_feat: bool, feat_cnt: u32, feat_sum: &[f32; FEATURES], feat_out: &mut [f32; FEATURES]) -> (u8, u8, bool) {
    if track_feat && feat_cnt > 0 {
        let inv = 1.0 / (feat_cnt as f32);
        for k in 0..FEATURES { feat_out[k] = feat_sum[k] * inv; }
        (code, turn, true)
    } else {
        (code, turn, false)
    }
}

#[no_mangle]
pub extern "C" fn run_explore_chunk(
    n_enemies: u32,
    n_cands: u32,
    games_per_opp: u32,
    start_game: u32,
    count: u32,
    seed_base: u32,
) -> u32 {
    let n_opps = (n_enemies as usize).clamp(1, MAX_ENEMIES);
    let nc = (n_cands as usize).clamp(1, MAX_CANDS);
    let gpo = (games_per_opp as usize).max(1);
    let total_plan = n_opps * gpo;
    let start = start_game as usize;
    let end = (start + count as usize).min(total_plan);

    let d0 = read_deck(0);
    let mut enemies = [[CompactCard::default(); 20]; MAX_ENEMIES];
    let mut w_enemies = [[0i32; FEATURES]; MAX_ENEMIES];
    let mut cands = [[0i32; FEATURES]; MAX_CANDS];
    unsafe {
        for o in 0..n_opps {
            enemies[o] = read_deck(o + 1);
            let off = o * FEATURES;
            w_enemies[o].copy_from_slice(&WEIGHTS_BUF[off..off + FEATURES]);
        }
        for c in 0..nc {
            let off = (MAX_ENEMIES + c) * FEATURES;
            cands[c].copy_from_slice(&WEIGHTS_BUF[off..off + FEATURES]);
        }
        for v in OUT_U32[0..4096].iter_mut() { *v = 0; }
        for v in OUT_F64[0..3072].iter_mut() { *v = 0.0; }
    }

    let pairs_per_opp = (gpo / nc).max(2);
    let half_pairs = (pairs_per_opp / 2).max(1);

    let mut total = 0u32;
    let mut wins = 0u32;
    let mut draws = 0u32;
    let mut losses = 0u32;
    let mut turns_sum = 0u64;
    let mut feat_buf = [0.0f32; FEATURES];
    let mut pts_dummy = [0u8; 2];
    let opp_stride = 6 + nc * 4;

    unsafe {
        for g in start..end {
            let opp_idx = g / gpo;
            let local_idx = g % gpo;
            let cand_idx = local_idx % nc;
            let pair_idx = local_idx / nc;
            let first = if pair_idx < half_pairs { 0 } else { 1 };
            let seed_slot = (pair_idx % half_pairs) as u32;
            let seed = seed_base ^ ((opp_idx as u32 + 1).wrapping_mul(1_000_003)) ^ seed_slot.wrapping_mul(2654435761);
            let track = (pair_idx & 15) == 0;

            let (code, turns, has_feat) = simulate_i32_impl::<false>(
                &d0,
                &enemies[opp_idx],
                &cands[cand_idx],
                &w_enemies[opp_idx],
                seed,
                first,
                track,
                &mut feat_buf,
                &mut pts_dummy,
            );

            total += 1;
            turns_sum += turns as u64;

            let c_off = 8 + cand_idx * 6;
            let o_off = 512 + opp_idx * opp_stride;
            let oc_off = o_off + 6 + cand_idx * 4;

            OUT_U32[c_off] += 1;
            OUT_U32[o_off] += 1;
            OUT_U32[oc_off] += 1;

            match code {
                1 => {
                    wins += 1;
                    OUT_U32[c_off + 1] += 1;
                    OUT_U32[o_off + 1] += 1;
                    OUT_U32[oc_off + 1] += 1;
                    if has_feat {
                        OUT_U32[c_off + 4] += 1;
                        OUT_U32[o_off + 4] += 1;
                        let cf = cand_idx * 44;
                        let of = 2048 + opp_idx * 44;
                        for k in 0..FEATURES {
                            OUT_F64[cf + k] += feat_buf[k] as f64;
                            OUT_F64[of + k] += feat_buf[k] as f64;
                        }
                    }
                }
                2 => {
                    draws += 1;
                    OUT_U32[c_off + 2] += 1;
                    OUT_U32[o_off + 2] += 1;
                    OUT_U32[oc_off + 2] += 1;
                }
                _ => {
                    losses += 1;
                    OUT_U32[c_off + 3] += 1;
                    OUT_U32[o_off + 3] += 1;
                    OUT_U32[oc_off + 3] += 1;
                    if has_feat {
                        OUT_U32[c_off + 5] += 1;
                        OUT_U32[o_off + 5] += 1;
                        let cf = cand_idx * 44 + 22;
                        let of = 2048 + opp_idx * 44 + 22;
                        for k in 0..FEATURES {
                            OUT_F64[cf + k] += feat_buf[k] as f64;
                            OUT_F64[of + k] += feat_buf[k] as f64;
                        }
                    }
                }
            }
        }

        OUT_U32[0] = total;
        OUT_U32[1] = wins;
        OUT_U32[2] = draws;
        OUT_U32[3] = losses;
        OUT_U32[4] = (turns_sum & 0xFFFF_FFFF) as u32;
        OUT_U32[5] = (turns_sum >> 32) as u32;
    }

    total
}

#[no_mangle]
pub extern "C" fn run_test_chunk(
    enemy_slot: u32,
    start_idx: u32,
    count: u32,
    total_per_opp: u32,
    seed_base: u32,
) -> u32 {
    let e_slot = (enemy_slot as usize).clamp(1, MAX_ENEMIES);
    let d0 = read_deck(0);
    let d1 = read_deck(e_slot);
    let mut w_enemy = [0i32; FEATURES];
    let mut w_player = [0i32; FEATURES];
    unsafe {
        w_enemy.copy_from_slice(&WEIGHTS_BUF[0..FEATURES]);
        w_player.copy_from_slice(&WEIGHTS_BUF[MAX_ENEMIES * FEATURES..(MAX_ENEMIES + 1) * FEATURES]);
    }

    let half = (total_per_opp as usize) / 2;
    let start = start_idx as usize;
    let end = (start + count as usize).min(total_per_opp as usize);
    let n = end.saturating_sub(start).min(65536);

    let mut wins = 0u32;
    let mut draws = 0u32;
    let mut losses = 0u32;
    let mut f_wins = 0u32;
    let mut f_draws = 0u32;
    let mut f_losses = 0u32;
    let mut s_wins = 0u32;
    let mut s_draws = 0u32;
    let mut s_losses = 0u32;
    let mut turns_sum = 0u32;
    let mut dummy = [0.0f32; FEATURES];
    let mut pts_dummy = [0u8; 2];

    unsafe {
        for k in 0..n {
            let idx = start + k;
            let first = if idx < half { 0 } else { 1 };
            let seed = seed_base ^ ((e_slot as u32).wrapping_mul(1_000_003)) ^ (idx as u32).wrapping_mul(2654435761);
            let (code, turns, _) = simulate_i32_impl::<false>(&d0, &d1, &w_player, &w_enemy, seed, first, false, &mut dummy, &mut pts_dummy);
            OUT_U8[k] = code;
            OUT_U8[n + k] = turns;
            turns_sum += turns as u32;
            match code {
                1 => { wins += 1; if first == 0 { f_wins += 1; } else { s_wins += 1; } }
                2 => { draws += 1; if first == 0 { f_draws += 1; } else { s_draws += 1; } }
                _ => { losses += 1; if first == 0 { f_losses += 1; } else { s_losses += 1; } }
            }
        }
        OUT_U32[0] = n as u32;
        OUT_U32[1] = wins;
        OUT_U32[2] = draws;
        OUT_U32[3] = losses;
        OUT_U32[4] = f_wins;
        OUT_U32[5] = f_draws;
        OUT_U32[6] = f_losses;
        OUT_U32[7] = s_wins;
        OUT_U32[8] = s_draws;
        OUT_U32[9] = s_losses;
        OUT_U32[10] = turns_sum;
    }

    n as u32
}

/// Bit-for-bit identical deterministic replay matching both WebGPU WGSL and WASM run_test_chunk!
#[no_mangle]
pub extern "C" fn run_replay_game(
    enemy_slot: u32,
    game_idx: u32,
    total_per_opp: u32,
    seed_base: u32,
) -> u32 {
    let e_slot = (enemy_slot as usize).clamp(1, MAX_ENEMIES);
    let d0 = read_deck(0);
    let d1 = read_deck(e_slot);
    let mut w_enemy = [0i32; FEATURES];
    let mut w_player = [0i32; FEATURES];
    unsafe {
        w_enemy.copy_from_slice(&WEIGHTS_BUF[0..FEATURES]);
        w_player.copy_from_slice(&WEIGHTS_BUF[MAX_ENEMIES * FEATURES..(MAX_ENEMIES + 1) * FEATURES]);
    }
    let half = (total_per_opp as usize) / 2;
    let idx = game_idx as usize;
    let first = if idx < half { 0 } else { 1 };
    let seed = seed_base ^ ((e_slot as u32).wrapping_mul(1_000_003)) ^ (idx as u32).wrapping_mul(2654435761);
    let mut dummy = [0.0f32; FEATURES];
    let mut pts = [0u8; 2];
    let (code, turns, _) = simulate_i32_impl::<true>(&d0, &d1, &w_player, &w_enemy, seed, first, false, &mut dummy, &mut pts);
    unsafe {
        OUT_U32[0] = code as u32;
        OUT_U32[1] = turns as u32;
        OUT_U32[2] = first as u32;
        OUT_U32[3] = pts[0] as u32;
        OUT_U32[4] = pts[1] as u32;
        REPLAY_LEN
    }
}
