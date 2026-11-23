//! Zero-allocation, zero-dependency WebAssembly Fast-Sim Engine for Pocket Lab.
//! Supports 10,000,000-game exploration (Stage 1) + 50,000-game formal test (Stage 2)
//! across parallel Web Workers with full 13,500+ Strategy Lexicon card-level bonuses
//! and 22-dim feature-advantage extraction.
//! Compile: rustc --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=3 -C lto=fat -C codegen-units=1 -C panic=abort tools/battle/fastsim_wasm.rs -o public/battle/fastsim.wasm

#![allow(static_mut_refs)]

const FEATURES: usize = 22;
const CARD_STRIDE: usize = 14;
const MAX_DECKS: usize = 12; // 0 = player, 1..=10 = enemies
const MAX_CANDS: usize = 40;

static mut DECKS_BUF: [i32; MAX_DECKS * 20 * CARD_STRIDE] = [0; MAX_DECKS * 20 * CARD_STRIDE];
static mut BONUS_BUF: [f32; MAX_DECKS * 20] = [0.0; MAX_DECKS * 20];
// weights[0..22] = enemy_weights; weights[22 + c*22 ..] = candidate c weights (or player test weights at c=0)
static mut WEIGHTS_BUF: [f32; (MAX_CANDS + 1) * FEATURES] = [0.0; (MAX_CANDS + 1) * FEATURES];
static mut OUT_U32: [u32; 16384] = [0; 16384];
static mut OUT_F64: [f64; 4096] = [0.0; 4096];
static mut OUT_U8: [u8; 131072] = [0; 131072]; // supports up to 65,536 games per test_chunk

#[no_mangle] pub extern "C" fn get_decks_ptr() -> *mut i32 { unsafe { DECKS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_bonus_ptr() -> *mut f32 { unsafe { BONUS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_weights_ptr() -> *mut f32 { unsafe { WEIGHTS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_out_u32_ptr() -> *mut u32 { unsafe { OUT_U32.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_out_f64_ptr() -> *mut f64 { unsafe { OUT_F64.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_out_u8_ptr() -> *mut u8 { unsafe { OUT_U8.as_mut_ptr() } }

#[derive(Clone, Copy, Default)]
struct CompactCard {
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
    power: f32,
    strategy_bonus: f32,
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

#[derive(Clone, Copy)]
struct Rng(u64);
impl Rng {
    #[inline(always)]
    fn new(seed: u64) -> Self {
        Self(seed ^ 0x9e3779b97f4a7c15)
    }
    #[inline(always)]
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        ((z ^ (z >> 31)) >> 32) as u32
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
                power: (atk_dmg as f32) * 0.01,
                strategy_bonus: BONUS_BUF[base_c + i],
            };
        }
    }
    out
}

#[inline(always)]
fn simulate_game(
    d0: &[CompactCard; 20],
    d1: &[CompactCard; 20],
    w0: &[f32; FEATURES],
    w1: &[f32; FEATURES],
    seed: u64,
    first_player: usize,
    track_feat: bool,
    feat_out: &mut [f32; FEATURES],
) -> (u8, u8, bool) {
    let mut rng = Rng::new(seed);
    let mut libs = [*d0, *d1];
    let mut lib_len = [20usize, 20usize];
    let mut hands = [[CompactCard::default(); 12]; 2];
    let mut hand_len = [0usize, 0usize];
    let mut board = [[Slot::default(); 4]; 2];
    let mut points = [0u8, 0u8];
    let mut feat_sum = [0.0f32; FEATURES];
    let mut feat_cnt = 0u32;

    for p in 0..2 {
        for i in (1..20).rev() {
            let j = (rng.next_u32() as usize) % (i + 1);
            libs[p].swap(i, j);
        }
        let mut basic_pos = None;
        for i in 0..20 {
            if libs[p][i].is_pokemon == 1 && libs[p][i].stage == 0 {
                basic_pos = Some(i);
                break;
            }
        }
        if let Some(bp) = basic_pos {
            if bp >= 5 { libs[p].swap(0, bp); }
        }
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
                    continue;
                } else {
                    let mut placed_bench = false;
                    for s in 1..4 {
                        if !board[p][s].occ {
                            board[p][s] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, turn_placed: 0 };
                            placed_bench = true;
                            break;
                        }
                    }
                    if placed_bench {
                        hand_len[p] -= 1;
                        hands[p][idx] = hands[p][hand_len[p]];
                        continue;
                    }
                }
            }
            idx += 1;
        }
        if !placed_active {
            let fb = if p == 0 { d0[0] } else { d1[0] };
            board[p][0] = Slot { occ: true, card: fb, hp: fb.hp.max(60), max_hp: fb.hp.max(60), energy: 0, tool: 0, status: 0, turn_placed: 0 };
        }
    }

    let mut cur = first_player;
    for turn in 1u8..=30u8 {
        let foe = 1 - cur;
        let w = if cur == 0 { w0 } else { w1 };
        let do_track = track_feat && cur == 0;

        if lib_len[cur] > 0 && hand_len[cur] < 12 {
            lib_len[cur] -= 1;
            hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
            hand_len[cur] += 1;
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
            let mut best_score: f32 = w[0];
            let mut chosen_f0 = 0usize;
            let mut chosen_f1 = 0usize;
            let mut chosen_v1 = 0.0f32;
            let mut n_opts = 1u32;

            // 1. Place basics onto bench
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage == 0 {
                    for s in 1..4 {
                        if !board[cur][s].occ {
                            n_opts += 1;
                            let sc = w[2] + 0.15 * c.power * w[3] + c.strategy_bonus * 0.35;
                            if sc > best_score {
                                best_score = sc; best_kind = 1; best_a = hi; best_b = s;
                                chosen_f0 = 2; chosen_f1 = 3; chosen_v1 = 0.15 * c.power;
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
                                let evp = c.power * if s == 0 { 1.0 } else { 0.5 };
                                let sc = w[4] + evp * w[5] + c.strategy_bonus * 0.45;
                                if sc > best_score {
                                    best_score = sc; best_kind = 2; best_a = hi; best_b = s;
                                    chosen_f0 = 4; chosen_f1 = 5; chosen_v1 = evp;
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
                        let sn = if (board[cur][s].card.ab_flags & 16) != 0 { 0.35 } else { 0.0 };
                        let sc = w[6] + sn * w[21] + board[cur][s].card.strategy_bonus * 0.35;
                        if sc > best_score {
                            best_score = sc; best_kind = 4; best_a = s;
                            chosen_f0 = 6; chosen_f1 = 21; chosen_v1 = sn;
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
                    let mut sc = w[7] + c.strategy_bonus * 0.4;
                    let mut f1 = 7usize;
                    let mut v1 = 0.0f32;
                    match c.trainer_kind {
                        1 => {
                            v1 = 1.0 / (1.0 + (hand_len[cur] as f32) * 0.2);
                            sc += v1 * w[8]; f1 = 8;
                        }
                        2 => {
                            let missing = board[cur][0].max_hp - board[cur][0].hp;
                            if missing <= 0 { continue; }
                            v1 = (missing.min(c.effect_val) as f32) * 0.02;
                            sc += v1 * w[20]; f1 = 20;
                        }
                        3 => {
                            v1 = 0.5;
                            sc += 0.45 * w[19] + 0.25 * w[21]; f1 = 19;
                        }
                        4 => {
                            v1 = 0.4;
                            sc += 0.35 * w[10] + 0.25 * w[11]; f1 = 11;
                        }
                        5 => {
                            if board[cur][0].tool != 0 { continue; }
                            v1 = 1.0;
                            sc += w[20]; f1 = 20;
                        }
                        6 => {
                            v1 = 0.5;
                            sc += 0.45 * w[13] + 0.35 * w[15]; f1 = 15;
                        }
                        7 => {
                            v1 = 0.8;
                            sc += w[6]; f1 = 6;
                        }
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
                        let need = if board[cur][s].energy < board[cur][s].card.atk_cost { 1.0 } else { 0.0 };
                        let sc = w[13]
                            + (if s == 0 { w[14] } else { 0.0 })
                            + need * w[15]
                            + board[cur][s].card.power * w[16]
                            + board[cur][s].card.strategy_bonus * 0.25;
                        if sc > best_score {
                            best_score = sc; best_kind = 5; best_a = s;
                            chosen_f0 = 13; chosen_f1 = if s == 0 { 14 } else { 15 }; chosen_v1 = if s == 0 { 1.0 } else { need };
                        }
                    }
                }
            }

            // 6. Retreat
            if !retreated && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.retreat {
                let foe_power = if board[foe][0].occ { board[foe][0].card.power } else { 0.0 };
                for s in 1..4 {
                    if board[cur][s].occ {
                        n_opts += 1;
                        let endg = if (board[cur][0].hp as f32 * 0.01) <= foe_power && board[cur][s].hp > board[cur][0].hp { 1.0 } else { 0.0 };
                        let sc = w[17] + endg * w[18];
                        if sc > best_score {
                            best_score = sc; best_kind = 6; best_a = s;
                            chosen_f0 = 17; chosen_f1 = 18; chosen_v1 = endg;
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
                let ko = if board[foe][0].occ && total_dmg >= board[foe][0].hp { 1.0 } else { 0.0 };
                let eff = if (atk.atk_flags & 1) != 0 { 1.0 } else { 0.0 };
                let snipe = if (atk.atk_flags & 2) != 0 { 0.5 } else { 0.0 };
                let sc = w[9] + (total_dmg as f32 * 0.01) * w[10] + ko * w[11] + eff * w[12] + snipe * w[21] + atk.strategy_bonus * 0.4;
                if sc > best_score {
                    best_kind = 7;
                    chosen_f0 = 9; chosen_f1 = if ko > 0.5 { 11 } else { 10 }; chosen_v1 = if ko > 0.5 { 1.0 } else { total_dmg as f32 * 0.01 };
                }
            }

            if do_track && n_opts > 1 {
                feat_sum[chosen_f0] += 1.0;
                if chosen_f1 < FEATURES { feat_sum[chosen_f1] += chosen_v1; }
                feat_cnt += 1;
            }

            match best_kind {
                0 => break,
                1 => {
                    let c = hands[cur][best_a];
                    board[cur][best_b] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, turn_placed: turn };
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
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
                        2 => {
                            board[cur][0].hp = (board[cur][0].hp + c.effect_val).min(board[cur][0].max_hp);
                        }
                        3 => {
                            if c.effect_val == 3 {
                                if hand_len[foe] > 3 { hand_len[foe] = 3; }
                            } else {
                                let mut pick = None;
                                for s in 1..4 {
                                    if board[foe][s].occ {
                                        if c.effect_val == 2 && board[foe][s].hp < board[foe][s].max_hp {
                                            pick = Some(s); break;
                                        }
                                        if pick.is_none() || board[foe][s].hp < board[foe][pick.unwrap()].hp {
                                            pick = Some(s);
                                        }
                                    }
                                }
                                if let Some(s) = pick { board[foe].swap(0, s); }
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
                }
                4 => {
                    ability_used = true;
                    let ab = board[cur][best_a].card.ab_flags;
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
                                if points[cur] >= 3 || !board[foe][0].occ {
                                    return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                                }
                            }
                        }
                    }
                }
                5 => {
                    energy_attached = true;
                    board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1);
                }
                6 => {
                    retreated = true;
                    board[cur][0].energy = board[cur][0].energy.saturating_sub(board[cur][0].card.retreat);
                    board[cur][0].status = 0;
                    board[cur].swap(0, best_a);
                }
                7 => {
                    let atk = board[cur][0].card;
                    let weak_bonus = if board[foe][0].occ && board[foe][0].card.weak_code == atk.type_code { 20 } else { 0 };
                    let total_dmg = atk.atk_dmg + dmg_boost + weak_bonus;
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
                            points[cur] = points[cur].saturating_add(board[foe][0].card.prize);
                            board[foe][0].occ = false;
                            for ns in 1..4 { if board[foe][ns].occ { board[foe].swap(0, ns); break; } }
                        }
                        if board[cur][0].hp <= 0 {
                            points[foe] = points[foe].saturating_add(board[cur][0].card.prize);
                            board[cur][0].occ = false;
                            for ns in 1..4 { if board[cur][ns].occ { board[cur].swap(0, ns); break; } }
                        }
                        let cur_won = points[cur] >= 3 || !board[foe][0].occ;
                        let foe_won = points[foe] >= 3 || !board[cur][0].occ;
                        if cur_won && foe_won { return finish_game(2, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                        if cur_won { return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                        if foe_won { return finish_game(if foe == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                    }
                    break;
                }
                _ => break,
            }
        }

        for p in 0..2 {
            if board[p][0].occ && (board[p][0].status & 1) != 0 {
                board[p][0].hp -= 10;
                if board[p][0].hp <= 0 {
                    let opp = 1 - p;
                    points[opp] = points[opp].saturating_add(board[p][0].card.prize);
                    board[p][0].occ = false;
                    for ns in 1..4 { if board[p][ns].occ { board[p].swap(0, ns); break; } }
                    if points[opp] >= 3 || !board[p][0].occ {
                        return finish_game(if opp == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                    }
                }
            }
        }

        cur = foe;
    }

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
    let n_opps = (n_enemies as usize).clamp(1, 10);
    let nc = (n_cands as usize).clamp(1, MAX_CANDS);
    let gpo = (games_per_opp as usize).max(1);
    let total_plan = n_opps * gpo;
    let start = start_game as usize;
    let end = (start + count as usize).min(total_plan);

    let d0 = read_deck(0);
    let mut enemies = [[CompactCard::default(); 20]; 10];
    for o in 0..n_opps {
        enemies[o] = read_deck(o + 1);
    }

    let mut w_enemy = [0.0f32; FEATURES];
    let mut cands = [[0.0f32; FEATURES]; MAX_CANDS];
    unsafe {
        w_enemy.copy_from_slice(&WEIGHTS_BUF[0..FEATURES]);
        for c in 0..nc {
            let off = FEATURES + c * FEATURES;
            cands[c].copy_from_slice(&WEIGHTS_BUF[off..off + FEATURES]);
        }
        // Clear output buffers
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

    let opp_stride = 6 + nc * 4;

    unsafe {
        for g in start..end {
            let opp_idx = g / gpo;
            let local_idx = g % gpo;
            let cand_idx = local_idx % nc;
            let pair_idx = local_idx / nc;
            let first = if pair_idx < half_pairs { 0 } else { 1 };
            let seed_slot = pair_idx % half_pairs;
            let seed = ((seed_base as u64) << 32) ^ ((opp_idx as u64 + 1) * 1_000_003) ^ (seed_slot as u64 * 2654435761);
            // Track 22-dim decision features on 1 out of 8 games (= 1,250,000 full feature-tracked games per 10M run!)
            let track = (pair_idx & 7) == 0;

            let (code, turns, has_feat) = simulate_game(
                &d0,
                &enemies[opp_idx],
                &cands[cand_idx],
                &w_enemy,
                seed,
                first,
                track,
                &mut feat_buf,
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
    let e_slot = (enemy_slot as usize).clamp(1, 10);
    let d0 = read_deck(0);
    let d1 = read_deck(e_slot);
    let mut w_enemy = [0.0f32; FEATURES];
    let mut w_player = [0.0f32; FEATURES];
    unsafe {
        w_enemy.copy_from_slice(&WEIGHTS_BUF[0..FEATURES]);
        w_player.copy_from_slice(&WEIGHTS_BUF[FEATURES..2 * FEATURES]);
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

    unsafe {
        for k in 0..n {
            let idx = start + k;
            let first = if idx < half { 0 } else { 1 };
            let seed = ((seed_base as u64) << 32) ^ ((e_slot as u64) * 1_000_003) ^ (idx as u64 * 2654435761);
            let (code, turns, _) = simulate_game(&d0, &d1, &w_player, &w_enemy, seed, first, false, &mut dummy);
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
