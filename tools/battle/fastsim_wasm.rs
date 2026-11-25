//! Zero-allocation, fixed-point i32 WebAssembly Fast-Sim Engine for Pocket Lab (Exact-Mechanics v2).
//! Uses EXACT same Rng32 + Q10 (x1024) fixed-point i32 scoring and exact card mechanics as WebGPU WGSL
//! -> 100.000% bit-for-bit parity across GPU, CPU, and Replay!
//! Supports dual attacks (0-cost & 2-attack Pokémon), 29 attack effect opcodes, 28 ability opcodes,
//! exact Trainer/Supporter/Item/Tool/Stadium execution, and authentic PTCG Pocket Special Conditions.

#![allow(static_mut_refs)]

const FEATURES: usize = 22;
const CARD_STRIDE: usize = 20;
const MAX_DECKS: usize = 12; // 0 = player, 1..=10 = enemies
const MAX_ENEMIES: usize = 10;
const MAX_CANDS: usize = 40;
const STEP_STRIDE: usize = 24;
const MAX_REPLAY_STEPS: usize = 1024;
const MAX_OPT_CARDS: usize = 256;

// Slot status bit flags
const ST_POISON: u16 = 1 << 0;
const ST_TOXIC: u16 = 1 << 1;
const ST_BURN: u16 = 1 << 2;
const ST_SLEEP: u16 = 1 << 3;
const ST_PARALYZE: u16 = 1 << 4;
const ST_CONFUSE: u16 = 1 << 5;
const ST_SPECIAL_MASK: u16 = ST_POISON | ST_TOXIC | ST_BURN | ST_SLEEP | ST_PARALYZE | ST_CONFUSE;
const ST_CANT_RETREAT: u16 = 1 << 6;
const ST_CANT_ATK_SELF: u16 = 1 << 7;
const ST_CANT_ATK_OPP: u16 = 1 << 8;
const ST_OPP_MISS_FLIP: u16 = 1 << 9;
const ST_INVULN: u16 = 1 << 10;
const ST_DISGUISE_USED: u16 = 1 << 11;
const ST_HAS_ATTACKED: u16 = 1 << 12;
const ST_SWITCHED_IN: u16 = 1 << 13;
const ST_NEXT_BOOST: u16 = 1 << 14;

static mut DECKS_BUF: [i32; MAX_DECKS * 20 * CARD_STRIDE] = [0; MAX_DECKS * 20 * CARD_STRIDE];
static mut BONUS_BUF: [i32; MAX_DECKS * 20] = [0; MAX_DECKS * 20]; // Q10 fixed-point (* 1024)
static mut CAND_CARDS_BUF: [i32; MAX_OPT_CARDS * CARD_STRIDE] = [0; MAX_OPT_CARDS * CARD_STRIDE];
static mut CAND_BONUS_BUF: [i32; MAX_OPT_CARDS] = [0; MAX_OPT_CARDS];
static mut WEIGHTS_BUF: [i32; (MAX_ENEMIES + MAX_CANDS) * FEATURES] = [0; (MAX_ENEMIES + MAX_CANDS) * FEATURES];
static mut OUT_U32: [u32; 16384] = [0; 16384];
static mut OUT_F64: [f64; 4096] = [0.0; 4096];
static mut OUT_U8: [u8; 131072] = [0; 131072];
static mut REPLAY_BUF: [i32; MAX_REPLAY_STEPS * STEP_STRIDE] = [0; MAX_REPLAY_STEPS * STEP_STRIDE];
static mut REPLAY_LEN: u32 = 0;

#[no_mangle] pub extern "C" fn get_decks_ptr() -> *mut i32 { unsafe { DECKS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_bonus_ptr() -> *mut i32 { unsafe { BONUS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_cand_cards_ptr() -> *mut i32 { unsafe { CAND_CARDS_BUF.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn get_cand_bonus_ptr() -> *mut i32 { unsafe { CAND_BONUS_BUF.as_mut_ptr() } }
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
    evo_group: u16,
    is_supporter: u8,
    is_item: u8,
    is_fossil: u8,
    type_code: u8,
    weak_code: u8,
    hp: i16,
    retreat: u8,
    prize: u8,
    a1_cost: u8,
    a1_dmg: i16,
    a1_op: u8,
    a1_val: i16,
    a2_cost: u8,
    a2_dmg: i16,
    a2_op: u8,
    a2_val: i16,
    ab_op: u8,
    ab_val: i16,
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
    tool: u8,
    status: u16,
    shield: i16,
    weaken: i16,
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
    #[inline(always)]
    fn flip_coin(&mut self, guaranteed_heads: &mut bool) -> bool {
        if *guaranteed_heads {
            *guaranteed_heads = false;
            return true;
        }
        (self.next_u32() & 1u32) == 1u32
    }
}

#[inline(always)]
fn est_atk_power(dmg: i16, op: u8, val: i16) -> i32 {
    let mut d = dmg as i32;
    let hi = (val >> 8) & 0xff;
    let lo = val & 0xff;
    match op {
        8 => { d = if val == 99 { d } else { (d * (val as i32)) / 2 }; }
        9 => { d += if hi == 99 { lo as i32 } else { ((lo as i32) * (hi as i32)) / 2 }; }
        10 => { d += (lo as i32) * (if hi == 2 { 4 } else { 2 }); }
        11 => { d = if val >= 1000 { (val as i32 - 1000) * 2 } else { d + (val as i32) * 3 }; }
        12 => { d += (lo as i32) * 2; }
        13 => { d += ((lo as i32) * 55) / 100; }
        14 => { if hi != 2 { d += if hi == 3 { 40 } else { (lo as i32) / 2 }; } }
        17 => {
            if hi == 2 || hi == 8 || hi == 10 { d = lo as i32; }
            else if hi >= 3 && hi <= 7 { d = (hi as i32 - 2) * (lo as i32); }
            else if hi == 9 { d = (lo as i32) * 3; }
            else { d += (lo as i32) / 2; }
        }
        28 => { d = if val == 1 { 150 } else { 70 }; }
        _ => {}
    }
    d
}

#[inline(always)]
fn decode_card_from_slice(buf: &[i32], off: usize, bonus_q: i32, forced_slot: i16) -> CompactCard {
    let raw_meta = buf[off + 1];
    let a1_cost = (buf[off + 7] & 0xff) as u8;
    let a1_dmg = buf[off + 8] as i16;
    let a1_op = (buf[off + 9] & 0xff) as u8;
    let a1_val = buf[off + 10] as i16;
    let a2_cost = (buf[off + 11] & 0xff) as u8;
    let a2_dmg = buf[off + 12] as i16;
    let a2_op = (buf[off + 13] & 0xff) as u8;
    let a2_val = buf[off + 14] as i16;
    let p1 = if a1_cost != 255 { est_atk_power(a1_dmg, a1_op, a1_val) } else { 0 };
    let p2 = if a2_cost != 255 { est_atk_power(a2_dmg, a2_op, a2_val) } else { 0 };
    let best_p = if p2 > p1 { p2 } else { p1 };
    CompactCard {
        slot_id: if forced_slot >= 0 { forced_slot } else { buf[off + 19] as i16 },
        is_pokemon: buf[off] as u8,
        stage: (raw_meta & 0xff) as u8,
        evo_group: ((raw_meta >> 8) & 0xffff) as u16,
        is_supporter: ((raw_meta >> 24) & 1) as u8,
        is_item: ((raw_meta >> 25) & 1) as u8,
        is_fossil: ((raw_meta >> 26) & 1) as u8,
        type_code: buf[off + 2] as u8,
        weak_code: buf[off + 3] as u8,
        hp: buf[off + 4] as i16,
        retreat: buf[off + 5] as u8,
        prize: (buf[off + 6] as u8).max(1),
        a1_cost,
        a1_dmg,
        a1_op,
        a1_val,
        a2_cost,
        a2_dmg,
        a2_op,
        a2_val,
        ab_op: (buf[off + 15] & 0xff) as u8,
        ab_val: buf[off + 16] as i16,
        trainer_kind: buf[off + 17] as u8,
        effect_val: buf[off + 18] as i16,
        power_q: (best_p * 1024) / 100,
        bonus_q,
    }
}

#[inline(always)]
fn read_deck(deck_slot: usize) -> [CompactCard; 20] {
    let mut out = [CompactCard::default(); 20];
    unsafe {
        let base_c = deck_slot * 20;
        for i in 0..20 {
            out[i] = decode_card_from_slice(&DECKS_BUF, (base_c + i) * CARD_STRIDE, BONUS_BUF[base_c + i], -1);
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
            REPLAY_BUF[bo + 7] = if act.occ { (act.tool as i32) | (((act.status & ST_SPECIAL_MASK) as i32) << 8) } else { 0 };
        }
        REPLAY_LEN += 1;
    }
}

#[inline(always)]
fn tool_hp_bonus(tool: u8) -> i16 {
    if tool == 1 { 20 } else if tool == 2 { 30 } else { 0 }
}

#[inline(always)]
fn eff_energy(side: &[Slot; 4], s: usize) -> i32 {
    let e = side[s].energy as i32;
    if side[s].card.type_code == 0 {
        for k in 0..4 {
            if side[k].occ && side[k].card.ab_op == 27 {
                return e * 2;
            }
        }
    }
    e
}

#[inline(always)]
fn eff_retreat_cost(side: &[Slot; 4], stadium: u8, discount: i32) -> i32 {
    let act = side[0];
    if act.card.ab_op == 25 && act.card.ab_val == 3 && act.energy > 0 { return 0; }
    for k in 0..4 {
        if side[k].occ && side[k].card.ab_op == 25 && side[k].card.ab_val == 2 { return 0; }
    }
    let mut r = act.card.retreat as i32;
    if act.card.stage == 0 {
        for k in 1..4 {
            if side[k].occ && side[k].card.ab_op == 25 && side[k].card.ab_val == 1 { r -= 1; break; }
        }
        if act.tool == 5 { r -= 1; }
    }
    if act.tool == 11 { r -= 1; }
    if stadium == 4 { r -= 2; }
    r -= discount;
    if r < 0 { 0 } else { r }
}

#[inline(always)]
fn best_bench_promote(side: &[Slot; 4]) -> usize {
    let mut best = 4usize;
    let mut best_sc = -99999i32;
    for s in 1..4 {
        if side[s].occ {
            let sc = (side[s].hp as i32) + (side[s].energy as i32) * 35 + (side[s].card.power_q >> 4);
            if sc > best_sc { best_sc = sc; best = s; }
        }
    }
    best
}

#[inline(always)]
fn draw_one(libs: &mut [[CompactCard; 20]; 2], lib_len: &mut [usize; 2], hands: &mut [[CompactCard; 12]; 2], hand_len: &mut [usize; 2], p: usize) -> i32 {
    if lib_len[p] > 0 && hand_len[p] < 12 {
        lib_len[p] -= 1;
        let c = libs[p][lib_len[p]];
        hands[p][hand_len[p]] = c;
        hand_len[p] += 1;
        c.slot_id as i32
    } else {
        -1
    }
}

#[inline(always)]
fn shuffle_hand_into_deck(
    libs: &mut [[CompactCard; 20]; 2],
    lib_len: &mut [usize; 2],
    hands: &mut [[CompactCard; 12]; 2],
    hand_len: &mut [usize; 2],
    p: usize,
    rng: &mut Rng32,
) {
    for hi in 0..hand_len[p] {
        if lib_len[p] < 20 {
            libs[p][lib_len[p]] = hands[p][hi];
            lib_len[p] += 1;
        }
    }
    hand_len[p] = 0;
    let n = lib_len[p];
    if n > 1 {
        for i in (1..n).rev() {
            let j = (rng.next_u32() as usize) % (i + 1);
            libs[p].swap(i, j);
        }
    }
}

#[inline(always)]
fn search_deck_to_hand(
    libs: &mut [[CompactCard; 20]; 2],
    lib_len: &mut [usize; 2],
    hands: &mut [[CompactCard; 12]; 2],
    hand_len: &mut [usize; 2],
    p: usize,
    mode: u8, // 0=any basic non-fossil, 1=any pokemon, 2=basic hp<=50, 3=stage2
    rng: &mut Rng32,
) -> bool {
    if hand_len[p] >= 12 || lib_len[p] == 0 { return false; }
    let mut match_pos = 20usize;
    let mut matches = 0u32;
    for i in 0..lib_len[p] {
        let c = libs[p][i];
        let ok = match mode {
            0 => c.is_pokemon == 1 && c.stage == 0 && c.is_fossil == 0,
            1 => c.is_pokemon == 1 && c.is_fossil == 0,
            2 => c.is_pokemon == 1 && c.stage == 0 && c.is_fossil == 0 && c.hp <= 50,
            3 => c.is_pokemon == 1 && c.stage == 2,
            4 => c.is_pokemon == 1 && c.stage == 1,
            _ => false,
        };
        if ok {
            matches += 1;
            if (rng.next_u32() % matches) == 0 { match_pos = i; }
        }
    }
    if match_pos < lib_len[p] {
        let found = libs[p][match_pos];
        lib_len[p] -= 1;
        libs[p][match_pos] = libs[p][lib_len[p]];
        hands[p][hand_len[p]] = found;
        hand_len[p] += 1;
        true
    } else {
        false
    }
}

#[inline(always)]
fn count_bench(side: &[Slot; 4]) -> i32 {
    let mut n = 0i32;
    for s in 1..4 { if side[s].occ { n += 1; } }
    n
}

#[inline(always)]
fn has_status_immunity(slot: &Slot) -> bool {
    slot.card.ab_op == 18 || slot.tool == 10
}

#[inline(always)]
fn apply_status(slot: &mut Slot, mask: u16) -> u8 {
    if has_status_immunity(slot) { return 0; }
    // Special conditions Sleep/Paralyze/Confuse replace each other; Poison/Burn stack independently!
    if (mask & (ST_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0 {
        slot.status &= !(ST_SLEEP | ST_PARALYZE | ST_CONFUSE);
    }
    if (mask & ST_TOXIC) != 0 { slot.status &= !ST_POISON; }
    if (mask & ST_POISON) != 0 && (slot.status & ST_TOXIC) != 0 { return 1; }
    slot.status |= mask;
    if (mask & ST_PARALYZE) != 0 { 4 }
    else if (mask & ST_SLEEP) != 0 { 3 }
    else if (mask & ST_CONFUSE) != 0 { 5 }
    else if (mask & ST_BURN) != 0 { 2 }
    else if (mask & (ST_POISON | ST_TOXIC)) != 0 { 1 }
    else { 0 }
}

#[inline(always)]
fn calc_passive_dmg_mods(
    attacker_side: &[Slot; 4],
    defender_side: &[Slot; 4],
    dmg_boost: i16,
    dmg_boost_ex: i16,
    stadium: u8,
    team_shield_def: i16,
) -> (i16, i16) {
    let atk_slot = attacker_side[0];
    let def_slot = defender_side[0];
    let mut add: i16 = dmg_boost;
    if def_slot.occ && def_slot.card.prize >= 2 { add += dmg_boost_ex; }
    // Tool: Future Booster (+20)
    if atk_slot.tool == 9 { add += 20; }
    // Passive team attack boost (Lucario +20)
    for k in 0..4 {
        if attacker_side[k].occ && attacker_side[k].card.ab_op == 13 {
            add += attacker_side[k].card.ab_val;
        }
    }
    // Stadium bonuses
    if stadium == 2 && atk_slot.card.stage == 1 { add += 10; } // Training Area
    if stadium == 6 && def_slot.occ && def_slot.card.prize >= 2 { add += 20; } // Ancient Arena
    // Next-turn attack boost (Togekiss +60)
    if (atk_slot.status & ST_NEXT_BOOST) != 0 { add += 60; }
    // Weakness (+20)
    let weak_b: i16 = if def_slot.occ && def_slot.card.weak_code == atk_slot.card.type_code { 20 } else { 0 };
    add += weak_b;

    // Damage reductions on defender
    let mut red: i16 = atk_slot.weaken + team_shield_def;
    if def_slot.occ {
        if def_slot.shield > 0 { red += def_slot.shield; }
        if def_slot.tool == 6 && def_slot.card.stage == 0 { red += 20; } // Eviolite
        if def_slot.tool == 10 { red += 10; } // Steel Apron
        if def_slot.card.ab_op == 12 {
            let v = def_slot.card.ab_val;
            red += if v >= 100 { v - 100 } else { v };
        }
        for k in 1..4 {
            if defender_side[k].occ && defender_side[k].card.ab_op == 12 && defender_side[k].card.ab_val >= 100 {
                red += defender_side[k].card.ab_val - 100;
            }
        }
    }
    (add - red, weak_b)
}

#[inline(always)]
fn eval_live_attack_dmg(
    atk_side: &[Slot; 4],
    def_side: &[Slot; 4],
    cost: u8,
    base_dmg: i16,
    op: u8,
    val: i16,
    supporter_used: bool,
    ko_last_turn: bool,
    turn: u8,
) -> (i16, bool) {
    // Returns (estimated_raw_damage_to_active, is_pure_bench_or_utility)
    let act = atk_side[0];
    let foe = def_side[0];
    let hi = (val >> 8) & 0xff;
    let lo = val & 0xff;
    match op {
        8 => {
            let n = if val == 99 { 1 } else { val as i32 };
            let exp = ((base_dmg as i32) * n) / (if val == 99 { 1 } else { 2 });
            (exp as i16, false)
        }
        9 => {
            let exp = if hi == 99 { lo as i32 } else { ((lo as i32) * (hi as i32)) / 2 };
            (base_dmg + exp as i16, false)
        }
        10 => {
            let cnt = match hi {
                0 => count_bench(atk_side),
                1 => count_bench(def_side),
                2 => count_bench(atk_side) + count_bench(def_side),
                3 => (1 + count_bench(atk_side)) / 2,
                _ => 0,
            };
            (base_dmg + (cnt * (lo as i32)) as i16, false)
        }
        11 => {
            let e = eff_energy(atk_side, 0);
            if val >= 1000 { (((val as i32 - 1000) * e) / 2) as i16 } else { base_dmg + (e * (val as i32)) as i16 }
            .into_pair(false)
        }
        12 => {
            if hi == 1 {
                let mut tot_e = 0i32;
                for s in 0..4 { if def_side[s].occ { tot_e += def_side[s].energy as i32; } }
                (base_dmg + (tot_e * (lo as i32)) as i16, false)
            } else if hi == 2 {
                let mut max_e = 0i32;
                for s in 0..4 { if def_side[s].occ && (def_side[s].energy as i32) > max_e { max_e = def_side[s].energy as i32; } }
                ((max_e * (lo as i32)) as i16, true)
            } else {
                let fe = if foe.occ { foe.energy as i32 } else { 0 };
                (base_dmg + (fe * (lo as i32)) as i16, false)
            }
        }
        13 => {
            let e = eff_energy(atk_side, 0);
            let bonus = if e >= (cost as i32) + (hi as i32) { lo } else { 0 };
            (base_dmg + bonus, false)
        }
        14 => {
            let mut d = base_dmg;
            if hi == 0 && foe.occ && foe.hp < foe.max_hp { d += lo; }
            else if hi == 1 && act.hp < act.max_hp { d += lo; }
            else if hi == 2 && act.hp < act.max_hp { d = (d - lo).max(0); }
            else if hi == 3 { d += (act.max_hp - act.hp).max(0); }
            (d, false)
        }
        17 => {
            if hi == 2 || hi == 8 || hi == 10 { (lo, true) }
            else if hi >= 3 && hi <= 7 { (((hi - 2) * lo) as i16, true) }
            else if hi == 9 { (lo, true) }
            else { (base_dmg, false) }
        }
        27 => {
            let mut bonus = 0i16;
            match hi {
                0 => { if foe.occ && (foe.status & ST_SPECIAL_MASK) != 0 { bonus = lo; } }
                1 => { if foe.occ && foe.card.prize >= 2 { bonus = lo; } }
                2 => { if (act.status & ST_HAS_ATTACKED) == 0 { bonus = lo; } }
                3 => { if foe.occ && foe.card.stage == 0 { bonus = lo; } }
                4 => { if act.tool != 0 { bonus = lo; } }
                5 => { if foe.occ && foe.tool != 0 { bonus = lo; } }
                6 => { if ko_last_turn { bonus = lo; } }
                7 => { if supporter_used { bonus = lo; } }
                8 => { if foe.occ && foe.hp > act.hp { bonus = lo; } }
                9 => { if foe.occ && foe.card.ab_op != 0 { bonus = lo; } }
                10 => { if (act.status & ST_SWITCHED_IN) != 0 { bonus = lo; } }
                11 => { if act.card.stage > 0 && act.turn_placed == turn { bonus = lo; } }
                _ => {}
            }
            (base_dmg + bonus, false)
        }
        28 => {
            if val == 1 { (if foe.occ { foe.hp } else { 150 }, true) }
            else if val == 2 { (if foe.occ { foe.hp / 2 } else { 60 }, true) }
            else if val == 3 { (if foe.occ { foe.hp / 4 } else { 40 }, true) }
            else { (if foe.occ { foe.hp / 2 } else { 50 }, true) }
        }
        7 => ((base_dmg / 2), false),
        _ => (base_dmg, base_dmg == 0 && op != 0),
    }
}

trait IntoPair { fn into_pair(self, b: bool) -> (i16, bool); }
impl IntoPair for i16 { #[inline(always)] fn into_pair(self, b: bool) -> (i16, bool) { (self, b) } }

#[inline(always)]
fn handle_active_ko(
    victim: usize,
    winner: usize,
    by_attack: bool,
    board: &mut [[Slot; 4]; 2],
    points: &mut [u8; 2],
    libs: &mut [[CompactCard; 20]; 2],
    lib_len: &mut [usize; 2],
    hands: &mut [[CompactCard; 12]; 2],
    hand_len: &mut [usize; 2],
    ko_last_turn: &mut [u8; 2],
    rng: &mut Rng32,
) -> (bool, i16) {
    // Returns (was_ko, pyukumuku_recoil_to_attacker)
    if !board[victim][0].occ || board[victim][0].hp > 0 { return (false, 0); }
    // Guts (Conkeldurr): flip coin -> survive at 10 HP
    if by_attack && board[victim][0].card.ab_op == 26 && board[victim][0].card.ab_val == 3 {
        let mut dummy_h = false;
        if rng.flip_coin(&mut dummy_h) {
            board[victim][0].hp = 10;
            return (false, 0);
        }
    }
    let pyu_recoil = if by_attack && board[victim][0].card.ab_op == 14 && board[victim][0].card.ab_val >= 100 {
        board[victim][0].card.ab_val - 100
    } else {
        0
    };
    let had_lucky_egg = by_attack && board[victim][0].tool == 7;
    points[winner] = points[winner].saturating_add(board[victim][0].card.prize);
    if by_attack { ko_last_turn[victim] = 1; }
    board[victim][0].occ = false;
    let prom = best_bench_promote(&board[victim]);
    if prom < 4 {
        board[victim].swap(0, prom);
        board[victim][0].status &= !ST_HAS_ATTACKED;
    }
    if had_lucky_egg {
        while hand_len[victim] < 5 && lib_len[victim] > 0 {
            draw_one(libs, lib_len, hands, hand_len, victim);
        }
    }
    (true, pyu_recoil)
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
    let mut item_lock = [0u8, 0u8];
    let mut supp_lock = [0u8, 0u8];
    let mut ko_last_turn = [0u8, 0u8];
    let mut team_shield = [0i16, 0i16];
    let mut energy_discarded = [0u8, 0u8];
    let mut stadium: u8 = 0;

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
        // 起手抽牌從牌庫頂端（19..15）抽出，保證至少 1 張非化石基礎寶可夢位於起手 5 張內
        let mut basic_pos = 20usize;
        for i in (0..20).rev() {
            if libs[p][i].is_pokemon == 1 && libs[p][i].stage == 0 && libs[p][i].is_fossil == 0 {
                basic_pos = i;
                break;
            }
        }
        if basic_pos < 15 { libs[p].swap(19, basic_pos); }
        for _ in 0..5 {
            lib_len[p] -= 1;
            hands[p][hand_len[p]] = libs[p][lib_len[p]];
            hand_len[p] += 1;
        }
        let mut placed_active = false;
        let mut idx = 0;
        while idx < hand_len[p] {
            let c = hands[p][idx];
            if c.is_pokemon == 1 && c.stage == 0 && c.is_fossil == 0 {
                if !placed_active {
                    board[p][0] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, shield: 0, weaken: 0, turn_placed: 0 };
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
                            board[p][s] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, shield: 0, weaken: 0, turn_placed: 0 };
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
            let deck_ref = if p == 0 { d0 } else { d1 };
            let mut fb = deck_ref[0];
            for k in 0..20 {
                if deck_ref[k].is_pokemon == 1 && deck_ref[k].is_fossil == 0 { fb = deck_ref[k]; break; }
            }
            board[p][0] = Slot { occ: true, card: fb, hp: fb.hp.max(60), max_hp: fb.hp.max(60), energy: 0, tool: 0, status: 0, shield: 0, weaken: 0, turn_placed: 0 };
            if RECORD { push_replay_step(0, p, 1, fb.slot_id as i32, 0, 0, &points, &board, &hand_len, &lib_len); }
        }
    }

    let mut cur = first_player;
    for turn in 1u8..=30u8 {
        let foe = 1 - cur;
        let w = if cur == 0 { w0 } else { w1 };
        let do_track = track_feat && cur == 0;

        // Start-of-turn snapshot for 1-turn self flags (so CantAttackSelf / NextBoost last through THIS turn then expire)
        let had_cant_atk_self = board[cur][0].occ && (board[cur][0].status & ST_CANT_ATK_SELF) != 0;
        let had_next_boost_start = board[cur][0].occ && (board[cur][0].status & ST_NEXT_BOOST) != 0;

        // Clear own protective buffs that lasted during opponent's last turn
        team_shield[cur] = 0;
        for s in 0..4 {
            if board[cur][s].occ {
                board[cur][s].shield = 0;
                board[cur][s].status &= !ST_INVULN;
            }
        }

        // Start-of-turn draw
        let drawn_id = draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
        if RECORD && drawn_id >= 0 {
            push_replay_step(turn, cur, 3, drawn_id, 1, 0, &points, &board, &hand_len, &lib_len);
        }

        // Start-of-turn Active Ability (Meloetta ab_op == 2: search 1 Pokémon)
        if board[cur][0].occ && board[cur][0].card.ab_op == 2 {
            if search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, &mut rng) {
                if RECORD {
                    push_replay_step(turn, cur, 7, board[cur][0].card.slot_id as i32, 0, 2 | (1 << 8), &points, &board, &hand_len, &lib_len);
                }
            }
        }

        // Search Stadium (stadium == 5) once per turn draw 1 card
        if stadium == 5 {
            let sid = draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
            if RECORD && sid >= 0 {
                push_replay_step(turn, cur, 3, sid, 2, 0, &points, &board, &hand_len, &lib_len);
            }
        }

        let mut energy_attached = turn == 1;
        let mut supporter_used = false;
        let mut retreated = false;
        let mut ability_used_mask: u8 = 0;
        let mut dmg_boost: i16 = 0;
        let mut dmg_boost_ex: i16 = 0;
        let mut retreat_discount: i32 = 0;
        let mut guaranteed_heads = false;

        let opp_gengar_lock = board[foe][0].occ && board[foe][0].card.ab_op == 21;
        let opp_cost_tax: i32 = if board[foe][0].occ && board[foe][0].card.ab_op == 28 { 1 } else { 0 };

        for _step in 0..9 {
            let mut best_kind: u8 = 0;
            let mut best_a: usize = 0;
            let mut best_b: usize = 0;
            let mut best_score: i32 = w[0];
            let mut chosen_f0 = 0usize;
            let mut chosen_f1 = 0usize;
            let mut chosen_v1 = 0.0f32;
            let mut n_opts = 1u32;

            // 1. Place basics (including Fossils onto bench during turn!)
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage == 0 {
                    for s in 1..4 {
                        if !board[cur][s].occ {
                            n_opts += 1;
                            let mut sc = w[2] + (((c.power_q * w[3]) >> 10) * 15 / 100) + ((c.bonus_q * 35) / 100);
                            // Miraidon ex / Koraidon ex on-bench switch+energy gather bonus when board has >= 2 energy
                            if c.ab_op == 6 {
                                let mut tot_e = 0i32;
                                for k in 0..4 { if board[cur][k].occ { tot_e += board[cur][k].energy as i32; } }
                                if tot_e >= 2 { sc += w[13] + w[14]; }
                            }
                            if sc > best_score {
                                best_score = sc; best_kind = 1; best_a = hi; best_b = s;
                                chosen_f0 = 2; chosen_f1 = 3; chosen_v1 = (c.power_q as f32) * (0.15 / 1024.0);
                            }
                            break;
                        }
                    }
                }
            }

            // 2. Evolve (strict evo_group; Turn 1 allowed ONLY for active Eevee Boost Evolution ab_op == 16!)
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage > 0 && c.stage < 99 {
                    for s in 0..4 {
                        if !board[cur][s].occ { continue; }
                        let bc = board[cur][s].card;
                        let can_t1 = s == 0 && bc.ab_op == 16;
                        if !can_t1 && (turn < 2 || board[cur][s].turn_placed >= turn) { continue; }
                        // 若進化前（如三合一磁怪）本回合尚有未使用的自身充能特性，先充能再進化！
                        if bc.ab_op == 3 && (ability_used_mask & (1u8 << s)) == 0 && (bc.ab_val != 3 || board[cur][s].hp > 30) { continue; }
                        let evo_ok = c.evo_group == 0 || bc.evo_group == 0 || bc.evo_group == c.evo_group;
                        if bc.stage + 1 == c.stage && evo_ok {
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

            // 3. Active Once-Per-Turn Abilities (ab_op: 3, 4, 8, 15, 17, 20)
            for s in 0..4 {
                if !board[cur][s].occ || (ability_used_mask & (1u8 << s)) != 0 { continue; }
                let ab_op = board[cur][s].card.ab_op;
                let ab_val = board[cur][s].card.ab_val;
                let mut valid = false;
                let mut extra_sc = 0i32;
                let mut f1 = 6usize;
                let mut v1 = 0.0f32;
                match ab_op {
                    3 => {
                        // Self ramp: Hydreigon (+2e, -30hp) only if hp > 30; discard ramp needs discard/turn>=3
                        if ab_val == 3 { valid = board[cur][s].hp > 30; extra_sc = w[15]; }
                        else if ab_val == 2 { valid = energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 4; extra_sc = w[15] >> 1; }
                        else { valid = true; extra_sc = w[15] >> 1; }
                    }
                    4 => {
                        if board[cur][0].occ {
                            if ab_val == 2 { valid = s > 0 && (energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 3); }
                            else { valid = true; }
                            extra_sc = w[14] >> 1;
                        }
                    }
                    8 => {
                        if board[foe][0].occ {
                            valid = true;
                            extra_sc = (w[21] * 35) / 100;
                            f1 = 21; v1 = 0.35;
                        }
                    }
                    15 => {
                        if board[cur][0].occ && board[cur][0].hp < board[cur][0].max_hp {
                            valid = true;
                            extra_sc = w[20] >> 1;
                            f1 = 20; v1 = 0.5;
                        }
                    }
                    17 => {
                        // Free switch Active with Bench (Greninja ex / Solgaleo ex) only if bench exists and active is hurt/under-energized or ex-blocked
                        if count_bench(&board[cur]) > 0 {
                            let best_b_s = best_bench_promote(&board[cur]);
                            if best_b_s < 4 && (board[cur][0].hp < board[cur][0].max_hp / 2 || (board[cur][best_b_s].energy > board[cur][0].energy && board[cur][best_b_s].card.power_q > board[cur][0].card.power_q)) {
                                valid = true;
                                extra_sc = w[18] >> 1;
                            }
                        }
                    }
                    20 => {
                        match ab_val {
                            1 => { valid = s == 0 && count_bench(&board[foe]) > 0; extra_sc = w[19] >> 1; }
                            2 => {
                                let mut has_dmg_b = false;
                                for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp { has_dmg_b = true; break; } }
                                valid = s == 0 && has_dmg_b; extra_sc = w[19];
                            }
                            3 => {
                                let mut has_bas_b = false;
                                for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].card.stage == 0 { has_bas_b = true; break; } }
                                valid = has_bas_b; extra_sc = w[19] >> 1;
                            }
                            4 => { valid = hand_len[cur] < 12 && lib_len[cur] > 0; extra_sc = w[8]; }
                            5 | 6 | 7 | 8 | 9 => {
                                valid = board[foe][0].occ && !has_status_immunity(&board[foe][0]);
                                extra_sc = w[12] >> 1;
                            }
                            10 => { valid = lib_len[foe] > 0; extra_sc = w[19] >> 2; }
                            _ => {}
                        }
                    }
                    _ => {}
                }
                if valid {
                    n_opts += 1;
                    let sc = w[6] + extra_sc + ((board[cur][s].card.bonus_q * 35) / 100);
                    if sc > best_score {
                        best_score = sc; best_kind = 4; best_a = s;
                        chosen_f0 = 6; chosen_f1 = f1; chosen_v1 = v1;
                    }
                }
            }

            // 4. Trainers (strict 1 Supporter/turn + Item-Lock + Supporter-Lock + exact preconditions!)
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon != 0 || c.trainer_kind == 0 { continue; }
                if c.is_supporter == 1 && (supporter_used || supp_lock[cur] == 1 || opp_gengar_lock) { continue; }
                if c.is_item == 1 && item_lock[cur] == 1 { continue; }

                let mut sc = w[7] + ((c.bonus_q * 40) / 100);
                let mut f1 = 7usize;
                let mut v1 = 0.0f32;
                let mut playable = true;

                match c.trainer_kind {
                    1 => {
                        let ev = c.effect_val;
                        if ev == 10 {
                            // Poké Ball: need a non-fossil Basic in deck
                            let mut has_b = false;
                            for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 0 && libs[cur][k].is_fossil == 0 { has_b = true; break; } }
                            if !has_b { playable = false; }
                        } else if ev == 11 {
                            // Copycat: valuable when opponent has >= our other hand cards
                            if hand_len[foe] == 0 || hand_len[foe] + 1 < hand_len[cur] { playable = false; }
                        } else if ev == 12 {
                            // May / Communication: need another Pokémon in hand AND Pokémon in deck
                            let mut h_poke = false;
                            for k in 0..hand_len[cur] { if k != hi && hands[cur][k].is_pokemon == 1 { h_poke = true; break; } }
                            let mut d_poke = false;
                            for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 { d_poke = true; break; } }
                            if !h_poke || !d_poke { playable = false; }
                        } else if ev == 13 {
                            let mut has_lo = false;
                            for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 0 && libs[cur][k].is_fossil == 0 && libs[cur][k].hp <= 50 { has_lo = true; break; } }
                            if !has_lo { playable = false; }
                        } else if ev == 16 {
                            let mut has_s2 = false;
                            for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 2 { has_s2 = true; break; } }
                            if !has_s2 { playable = false; }
                        } else if ev == 17 {
                            let mut has_s1 = false;
                            for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 1 { has_s1 = true; break; } }
                            if !has_s1 { playable = false; }
                        } else if lib_len[cur] == 0 {
                            playable = false;
                        }
                        let inv = 5120 / (5 + hand_len[cur] as i32);
                        sc += (inv * w[8]) >> 10; f1 = 8; v1 = (inv as f32) / 1024.0;
                    }
                    2 => {
                        let ev = c.effect_val;
                        let heal_amt = ev & 0xff;
                        let cures = (ev & 256) != 0;
                        let s2_only = (ev & 512) != 0;
                        if !board[cur][0].occ { playable = false; }
                        else if s2_only && board[cur][0].card.stage != 2 { playable = false; }
                        else {
                            let missing = board[cur][0].max_hp - board[cur][0].hp;
                            let has_st = (board[cur][0].status & ST_SPECIAL_MASK) != 0;
                            if missing <= 0 && !(cures && has_st) { playable = false; }
                            else {
                                let eff_h = if missing > 0 { missing.min(heal_amt.max(20)) as i32 } else { 25 };
                                sc += (w[20] * eff_h) / 50; f1 = 20; v1 = (eff_h as f32) * 0.02;
                            }
                        }
                    }
                    3 => {
                        match c.effect_val {
                            1 => { playable = count_bench(&board[foe]) > 0; }
                            3 => {
                                // 青綠的挑釁：須己方場上有 2 階進化（妙蛙花/噴火龍/水箭龜/大比鳥）且對手有備戰
                                let mut has_s2 = false;
                                for ss in 0..4 { if board[cur][ss].occ && board[cur][ss].card.stage == 2 { has_s2 = true; break; } }
                                playable = has_s2 && count_bench(&board[foe]) > 0;
                            }
                            15 => {
                                // 水蓮等指定進化條件抓人
                                let mut has_s1 = false;
                                for ss in 0..4 { if board[cur][ss].occ && board[cur][ss].card.stage >= 1 { has_s1 = true; break; } }
                                playable = has_s1 && count_bench(&board[foe]) > 0;
                            }
                            2 => {
                                // Cyrus: STRICTLY requires damaged opponent bench Pokémon!
                                let mut has_dmg = false;
                                for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp { has_dmg = true; break; } }
                                playable = has_dmg;
                            }
                            4 => { playable = hand_len[foe] > 3; }
                            5 => { playable = hand_len[foe] > (3usize.saturating_sub(points[foe] as usize).max(1)); }
                            6 => {
                                // Guzma: requires opponent has at least 1 Tool attached!
                                let mut has_t = false;
                                for s in 0..4 { if board[foe][s].occ && board[foe][s].tool != 0 { has_t = true; break; } }
                                playable = has_t;
                            }
                            7 => {
                                // Field Blower: requires opp Tool OR active Stadium!
                                let mut has_t = stadium != 0;
                                for s in 0..4 { if board[foe][s].occ && board[foe][s].tool != 0 { has_t = true; break; } }
                                playable = has_t;
                            }
                            8 | 14 => { playable = board[foe][0].occ && board[foe][0].energy > 0; }
                            9 => {
                                // Bounce own active to hand (only if bench exists & active is damaged!)
                                playable = count_bench(&board[cur]) > 0 && board[cur][0].occ && board[cur][0].hp < board[cur][0].max_hp && board[cur][0].hp <= 60;
                            }
                            10 => { playable = board[foe][0].occ && board[foe][0].card.stage == 0 && count_bench(&board[foe]) > 0; }
                            11 => { playable = hand_len[foe] > 4; }
                            12 => { playable = hand_len[foe] > 0; }
                            _ => { playable = false; }
                        }
                        sc += ((w[19] * 45) + (w[21] * 25)) / 100; f1 = 19; v1 = 0.5;
                    }
                    4 => {
                        let ev = c.effect_val;
                        if (ev & 1024) != 0 {
                            // Will: guaranteed next coin flip
                            playable = !guaranteed_heads && turn >= 2;
                            sc += w[12] >> 1; f1 = 12; v1 = 0.5;
                        } else if (ev & 512) != 0 {
                            // Team damage reduction (Blue / Adaman / Jasmine)
                            playable = turn >= 2;
                            sc += w[20] >> 1; f1 = 20; v1 = 0.5;
                        } else {
                            let vs_ex = (ev & 256) != 0;
                            if turn < 2 || !board[foe][0].occ || (vs_ex && board[foe][0].card.prize < 2) { playable = false; }
                            sc += ((w[10] * 35) + (w[11] * 25)) / 100; f1 = 11; v1 = 0.4;
                        }
                    }
                    5 => {
                        // Tool: attach to active if no tool (or matching bench if active already has tool!)
                        let mut tgt_s = 4usize;
                        let tv = c.effect_val as u8;
                        for s in 0..4 {
                            if board[cur][s].occ && board[cur][s].tool == 0 {
                                if (tv == 5 || tv == 6) && board[cur][s].card.stage != 0 { continue; }
                                tgt_s = s; break;
                            }
                        }
                        if tgt_s >= 4 { playable = false; }
                        else { sc += if tgt_s == 0 { w[20] } else { w[20] >> 1 }; f1 = 20; v1 = 1.0; }
                    }
                    6 => {
                        let ev = c.effect_val;
                        if ev == 99 {
                            if turn < 2 { playable = false; }
                            else {
                                let mut can_candy = false;
                                for hi2 in 0..hand_len[cur] {
                                    let evc = hands[cur][hi2];
                                    if evc.is_pokemon == 1 && evc.stage == 2 {
                                        for s in 0..4 {
                                            if !board[cur][s].occ { continue; }
                                            let evo_ok = evc.evo_group == 0 || board[cur][s].card.evo_group == 0 || board[cur][s].card.evo_group == evc.evo_group;
                                            if board[cur][s].card.stage == 0 && evo_ok && board[cur][s].turn_placed < turn {
                                                can_candy = true; break;
                                            }
                                        }
                                        if can_candy { break; }
                                    }
                                }
                                playable = can_candy;
                            }
                            sc += w[4] + ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 4; v1 = 1.0;
                        } else if ev == 1 || ev == 12 {
                            // X Speed (-1) / Leaf (-2): only useful if we have bench and active retreat > discount
                            playable = !retreated && count_bench(&board[cur]) > 0 && eff_retreat_cost(&board[cur], stadium, retreat_discount) > 0;
                            sc += w[18] >> 1; f1 = 18; v1 = 0.5;
                        } else if ev == 13 {
                            // Free switch supporter (Lyra/Skyla)
                            playable = count_bench(&board[cur]) > 0 && board[cur][0].occ && board[cur][0].hp < board[cur][0].max_hp;
                            sc += w[18] >> 1; f1 = 18; v1 = 0.5;
                        } else if ev == 3 {
                            let mut has_s2 = false;
                            for s in 0..4 { if board[cur][s].occ && board[cur][s].card.stage == 2 { has_s2 = true; break; } }
                            playable = has_s2;
                            sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5;
                        } else if ev == 4 {
                            playable = energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 5;
                            sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5;
                        } else if ev == 6 {
                            let mut bench_e = 0u8;
                            for s in 1..4 { if board[cur][s].occ { bench_e += board[cur][s].energy; } }
                            playable = bench_e > 0;
                            sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5;
                        } else if ev == 7 {
                            playable = turn >= 2 && lib_len[cur] > 0;
                            sc += w[4]; f1 = 4; v1 = 0.8;
                        } else {
                            sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5;
                        }
                    }
                    7 => {
                        let sv = c.effect_val as u8;
                        if stadium == sv { playable = false; }
                        else { sc += w[6] >> 1; f1 = 6; v1 = 0.5; }
                    }
                    _ => { playable = false; }
                }

                if playable {
                    n_opts += 1;
                    if sc > best_score {
                        best_score = sc; best_kind = 3; best_a = hi;
                        chosen_f0 = 7; chosen_f1 = f1; chosen_v1 = v1;
                    }
                }
            }

            // 5. Energy attach from Energy Zone
            if !energy_attached {
                for s in 0..4 {
                    if board[cur][s].occ {
                        n_opts += 1;
                        let bc = board[cur][s].card;
                        let max_c = if bc.a2_cost != 255 && bc.a2_cost > bc.a1_cost { bc.a2_cost } else if bc.a1_cost != 255 { bc.a1_cost } else { 1 };
                        let need_b = (board[cur][s].energy as i32) < (max_c as i32) + (if bc.a1_op == 13 { (bc.a1_val >> 8) as i32 } else { 0 });
                        let chip_b = if bc.ab_op == 9 { (w[21] * 45) / 100 } else { 0 };
                        let sc = w[13]
                            + (if s == 0 { w[14] } else { 0 })
                            + (if need_b { w[15] } else { 0 })
                            + chip_b
                            + ((bc.power_q * w[16]) >> 10)
                            + ((bc.bonus_q * 25) / 100);
                        if sc > best_score {
                            best_score = sc; best_kind = 5; best_a = s;
                            chosen_f0 = 13; chosen_f1 = if s == 0 { 14 } else { 15 }; chosen_v1 = if s == 0 || need_b { 1.0 } else { 0.0 };
                        }
                    }
                }
            }

            // 6. Retreat
            let active_ex_blocked = board[cur][0].occ && board[foe][0].occ && board[foe][0].card.ab_op == 11 && board[cur][0].card.prize >= 2;
            let r_cost = if board[cur][0].occ { eff_retreat_cost(&board[cur], stadium, retreat_discount) } else { 99 };
            let cant_ret = board[cur][0].occ && (board[cur][0].status & (ST_SLEEP | ST_PARALYZE | ST_CANT_RETREAT)) != 0;
            if !retreated && board[cur][0].occ && !cant_ret && (board[cur][0].energy as i32) >= r_cost {
                let foe_dmg = if board[foe][0].occ { (board[foe][0].card.power_q * 100) >> 10 } else { 0 };
                for s in 1..4 {
                    if board[cur][s].occ {
                        n_opts += 1;
                        let endg_b = ((board[cur][0].hp as i32) <= foe_dmg && board[cur][s].hp > board[cur][0].hp)
                            || (active_ex_blocked && board[cur][s].card.prize == 1);
                        let sc = w[17] + (if endg_b { w[18] } else { 0 });
                        if sc > best_score {
                            best_score = sc; best_kind = 6; best_a = s;
                            chosen_f0 = 17; chosen_f1 = 18; chosen_v1 = if endg_b { 1.0 } else { 0.0 };
                        }
                    }
                }
            }

            // 7. Dual-Attack Selection (Attack 1 & Attack 2; supports 0-cost attacks!)
            let cant_atk = board[cur][0].occ && (board[cur][0].status & (ST_SLEEP | ST_PARALYZE | ST_CANT_ATK_SELF | ST_CANT_ATK_OPP)) != 0;
            if turn >= 2 && board[cur][0].occ && !cant_atk {
                let atk_c = board[cur][0].card;
                let my_e = eff_energy(&board[cur], 0);
                let (mod_net, _weak_b) = calc_passive_dmg_mods(&board[cur], &board[foe], dmg_boost, dmg_boost_ex, stadium, team_shield[foe]);
                for ai in 0..2usize {
                    let (ac, ad, ao, av) = if ai == 0 {
                        (atk_c.a1_cost, atk_c.a1_dmg, atk_c.a1_op, atk_c.a1_val)
                    } else {
                        (atk_c.a2_cost, atk_c.a2_dmg, atk_c.a2_op, atk_c.a2_val)
                    };
                    if ac == 255 || my_e < (ac as i32) + opp_cost_tax { continue; }
                    let (raw_d, is_special) = eval_live_attack_dmg(&board[cur], &board[foe], ac, ad, ao, av, supporter_used, ko_last_turn[cur] != 0, turn);
                    if raw_d <= 0 && !is_special { continue; }
                    // Against Oricorio ex-immunity: skip pure active damage attacks if no utility/bench snipe
                    if active_ex_blocked && !is_special && ao != 17 && ao != 19 && ao != 25 && !(ao >= 1 && ao <= 6) { continue; }

                    n_opts += 1;
                    let total_dmg = if is_special { raw_d } else if raw_d > 0 { (raw_d + mod_net).max(0) } else { 0 };
                    let ko_b = board[foe][0].occ && total_dmg >= board[foe][0].hp;
                    let eff_b = if ao != 0 { w[12] } else { 0 };
                    let snipe_b = if ao == 17 { w[21] >> 1 } else { 0 };
                    // Mild cost awareness when choosing between A1 and A2 (don't discard 2 energy if A1 already KOs!)
                    let pen = if ao == 16 && !ko_b { (w[15] >> 2).max(0) } else if ao == 15 && av >= 40 && board[cur][0].hp <= av { w[11] >> 1 } else { 0 };
                    let sc = w[9] + (((total_dmg as i32) * w[10]) / 100) + (if ko_b { w[11] } else { 0 }) + eff_b + snipe_b + ((atk_c.bonus_q * 40) / 100) - pen;
                    if sc > best_score {
                        best_score = sc; best_kind = 7; best_a = ai;
                        chosen_f0 = 9; chosen_f1 = if ko_b { 11 } else { 10 }; chosen_v1 = if ko_b { 1.0 } else { (total_dmg as f32) * 0.01 };
                    }
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
                    let bonus_st_hp: i16 = if stadium == 3 && c.stage == 0 { 20 } else { 0 };
                    board[cur][best_b] = Slot { occ: true, card: c, hp: c.hp + bonus_st_hp, max_hp: c.hp + bonus_st_hp, energy: 0, tool: 0, status: 0, shield: 0, weaken: 0, turn_placed: turn };
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
                    if RECORD { push_replay_step(turn, cur, 4, c.slot_id as i32, best_b as i32, 0, &points, &board, &hand_len, &lib_len); }
                    // On-Bench Triggers: Miraidon ex / Koraidon ex (ab_op == 6, 可選：場上能量足供出招且不破壞花舞鳥防線時才換上吸能!) & Roaring Moon (ab_op == 7)
                    if c.ab_op == 6 {
                        let walling_ex = board[cur][0].occ && board[cur][0].card.ab_op == 11 && board[foe][0].occ && board[foe][0].card.prize >= 2;
                        let mut tot_e = 0u8;
                        for k in 0..4 {
                            if board[cur][k].occ && k != best_b { tot_e = tot_e.saturating_add(board[cur][k].energy); }
                        }
                        let need_e = if c.a1_cost != 255 { c.a1_cost.max(2) } else { 3 };
                        if !walling_ex && tot_e >= need_e {
                            for k in 0..4 {
                                if board[cur][k].occ && k != best_b { board[cur][k].energy = 0; }
                            }
                            board[cur][best_b].energy = board[cur][best_b].energy.saturating_add(tot_e);
                            board[cur].swap(0, best_b);
                            board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                            if RECORD { push_replay_step(turn, cur, 7, c.slot_id as i32, 0, 6 | ((tot_e as i32) << 8), &points, &board, &hand_len, &lib_len); }
                        }
                    } else if c.ab_op == 7 && count_bench(&board[foe]) > 0 {
                        let pick = best_bench_promote(&board[foe]);
                        if pick < 4 {
                            board[foe].swap(0, pick);
                            board[foe][0].status &= !ST_HAS_ATTACKED;
                            if RECORD { push_replay_step(turn, cur, 7, c.slot_id as i32, best_b as i32, 7 | (1 << 8), &points, &board, &hand_len, &lib_len); }
                        }
                    }
                }
                2 => {
                    let c = hands[cur][best_a];
                    let dmg_taken = (board[cur][best_b].max_hp - board[cur][best_b].hp).max(0);
                    let bhp = tool_hp_bonus(board[cur][best_b].tool);
                    board[cur][best_b].card = c;
                    board[cur][best_b].max_hp = c.hp + bhp;
                    board[cur][best_b].hp = (board[cur][best_b].max_hp - dmg_taken).max(10);
                    board[cur][best_b].status &= !ST_SPECIAL_MASK;
                    board[cur][best_b].turn_placed = turn;
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];

                    let mut evo_trig = 0i32;
                    if c.ab_op == 5 {
                        evo_trig = c.ab_val as i32;
                        match c.ab_val {
                            1 => { if board[cur][0].occ { board[cur][0].energy = board[cur][0].energy.saturating_add(1); } }
                            2 => {
                                draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                                draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                            }
                            3 => {
                                // Frogadier: summon clone from deck onto bench
                                for bs in 1..4 {
                                    if !board[cur][bs].occ {
                                        for li in 0..lib_len[cur] {
                                            if libs[cur][li].is_pokemon == 1 && libs[cur][li].stage == 1 && libs[cur][li].evo_group == c.evo_group {
                                                let clone_c = libs[cur][li];
                                                lib_len[cur] -= 1;
                                                libs[cur][li] = libs[cur][lib_len[cur]];
                                                board[cur][bs] = Slot { occ: true, card: clone_c, hp: clone_c.hp, max_hp: clone_c.hp, energy: 0, tool: 0, status: 0, shield: 0, weaken: 0, turn_placed: turn };
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                }
                            }
                            4 => {
                                // Drizzile: 20 dmg to opp active
                                if board[foe][0].occ {
                                    board[foe][0].hp -= 20;
                                    handle_active_ko(foe, cur, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                                }
                            }
                            5 => {
                                // Polteageist: Mars opp hand
                                shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                let want = (3usize.saturating_sub(points[foe] as usize)).max(1);
                                for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                            }
                            _ => {}
                        }
                    }
                    if RECORD { push_replay_step(turn, cur, 5, c.slot_id as i32, best_b as i32, evo_trig, &points, &board, &hand_len, &lib_len); }
                    if points[cur] >= 3 || !board[foe][0].occ {
                        *points_out = points;
                        return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                    }
                }
                3 => {
                    let c = hands[cur][best_a];
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
                    if c.is_supporter == 1 { supporter_used = true; }
                    let mut rep_val = c.effect_val as i32;

                    match c.trainer_kind {
                        1 => {
                            match c.effect_val {
                                10 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 0, &mut rng); }
                                11 => {
                                    // Copycat
                                    let want = hand_len[foe];
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, &mut rng);
                                    for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                }
                                12 => {
                                    // May / Pokemon Communication
                                    for k in 0..hand_len[cur] {
                                        if hands[cur][k].is_pokemon == 1 {
                                            let put_back = hands[cur][k];
                                            hand_len[cur] -= 1;
                                            hands[cur][k] = hands[cur][hand_len[cur]];
                                            if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = put_back; lib_len[cur] += 1; }
                                            search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, &mut rng);
                                            break;
                                        }
                                    }
                                }
                                13 => {
                                    // Lisia: up to 2 basics with HP <= 50
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 2, &mut rng);
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 2, &mut rng);
                                }
                                14 => {
                                    // Iono
                                    let my_n = hand_len[cur];
                                    let fo_n = hand_len[foe];
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, &mut rng);
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                    for _ in 0..my_n { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                    for _ in 0..fo_n { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                                }
                                15 => {
                                    draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                                }
                                16 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 3, &mut rng); }
                                17 => {
                                    // 希特隆：檢索最多 2 張 1 階進化（如三合一磁怪）
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 4, &mut rng);
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 4, &mut rng);
                                }
                                _ => {
                                    let draws = c.effect_val.clamp(1, 2) as usize;
                                    for _ in 0..draws { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                }
                            }
                        }
                        2 => {
                            let ev = c.effect_val;
                            let mut h = ev & 0xff;
                            if (ev & 2048) != 0 {
                                // Sweet Honey: flip until tails * 20
                                h = 0;
                                for _ in 0..6 {
                                    if rng.flip_coin(&mut guaranteed_heads) { h += 20; } else { break; }
                                }
                                rep_val = h as i32;
                            }
                            if (ev & 4096) != 0 {
                                // Mallow: full heal + discard all energy
                                board[cur][0].hp = board[cur][0].max_hp;
                                if board[cur][0].energy > 0 { energy_discarded[cur] = 1; }
                                board[cur][0].energy = 0;
                            } else if h > 0 {
                                board[cur][0].hp = (board[cur][0].hp + h).min(board[cur][0].max_hp);
                            }
                            if (ev & 256) != 0 { board[cur][0].status &= !ST_SPECIAL_MASK; }
                            if (ev & 1024) != 0 && hand_len[cur] < 12 && rng.flip_coin(&mut guaranteed_heads) {
                                // Lucky Ice Pop returns to hand on heads!
                                hands[cur][hand_len[cur]] = c;
                                hand_len[cur] += 1;
                            }
                        }
                        3 => {
                            match c.effect_val {
                                1 | 10 => {
                                    // Sabrina / Repel: opponent chooses healthiest bench
                                    let pick = best_bench_promote(&board[foe]);
                                    if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                2 => {
                                    // Cyrus: pull DAMAGED opp bench ONLY (prefer lowest HP)
                                    let mut pick = 4usize;
                                    for bs in 1..4 {
                                        if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp {
                                            if pick == 4 || board[foe][bs].hp < board[foe][pick].hp { pick = bs; }
                                        }
                                    }
                                    if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                3 | 15 => {
                                    // Blue's Taunt / Lana: pull lowest-HP opp bench
                                    let mut pick = 4usize;
                                    for bs in 1..4 {
                                        if board[foe][bs].occ {
                                            if pick == 4 || board[foe][bs].hp < board[foe][pick].hp { pick = bs; }
                                        }
                                    }
                                    if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                4 => {
                                    // Red Card
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                    for _ in 0..3 { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                                }
                                5 => {
                                    // Mars
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                    let want = (3usize.saturating_sub(points[foe] as usize)).max(1);
                                    for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                                }
                                6 => {
                                    // Guzma: discard ALL tools from opponent's board!
                                    for s in 0..4 {
                                        if board[foe][s].occ && board[foe][s].tool != 0 {
                                            let hp_b = tool_hp_bonus(board[foe][s].tool);
                                            board[foe][s].tool = 0;
                                            if hp_b > 0 {
                                                board[foe][s].max_hp = (board[foe][s].max_hp - hp_b).max(10);
                                                board[foe][s].hp = board[foe][s].hp.min(board[foe][s].max_hp);
                                            }
                                        }
                                    }
                                }
                                7 => {
                                    // Field Blower: discard 1 opp Tool or active Stadium
                                    let mut did = false;
                                    for s in 0..4 {
                                        if board[foe][s].occ && board[foe][s].tool != 0 {
                                            let hp_b = tool_hp_bonus(board[foe][s].tool);
                                            board[foe][s].tool = 0;
                                            if hp_b > 0 {
                                                board[foe][s].max_hp = (board[foe][s].max_hp - hp_b).max(10);
                                                board[foe][s].hp = board[foe][s].hp.min(board[foe][s].max_hp);
                                            }
                                            did = true; break;
                                        }
                                    }
                                    if !did {
                                        if stadium == 3 {
                                            for pp in 0..2 {
                                                for ss in 0..4 {
                                                    if board[pp][ss].occ && board[pp][ss].card.stage == 0 {
                                                        board[pp][ss].max_hp = (board[pp][ss].max_hp - 20).max(10);
                                                        board[pp][ss].hp = board[pp][ss].hp.min(board[pp][ss].max_hp);
                                                    }
                                                }
                                            }
                                        }
                                        stadium = 0;
                                    }
                                }
                                8 => {
                                    // Team Rocket Grunt: flip until tails discard opp active energy
                                    let mut disc = 0u8;
                                    for _ in 0..5 {
                                        if board[foe][0].energy > 0 && rng.flip_coin(&mut guaranteed_heads) {
                                            board[foe][0].energy -= 1;
                                            disc += 1;
                                        } else { break; }
                                    }
                                    if disc > 0 { energy_discarded[foe] = 1; }
                                }
                                9 => {
                                    // Bounce own active to hand, promote bench
                                    let prom = best_bench_promote(&board[cur]);
                                    if prom < 4 {
                                        let bounced = board[cur][0].card;
                                        board[cur][0].occ = false;
                                        board[cur].swap(0, prom);
                                        board[cur][0].status &= !ST_HAS_ATTACKED;
                                        if hand_len[cur] < 12 { hands[cur][hand_len[cur]] = bounced; hand_len[cur] += 1; }
                                    }
                                }
                                11 => { if hand_len[foe] > 4 { hand_len[foe] = 4; } }
                                12 => {
                                    // Silver: shuffle 1 supporter from opp hand back to deck
                                    for k in 0..hand_len[foe] {
                                        if hands[foe][k].is_supporter == 1 {
                                            let sc = hands[foe][k];
                                            hand_len[foe] -= 1;
                                            hands[foe][k] = hands[foe][hand_len[foe]];
                                            if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = sc; lib_len[foe] += 1; }
                                            break;
                                        }
                                    }
                                }
                                14 => {
                                    if board[foe][0].occ && board[foe][0].energy > 0 {
                                        board[foe][0].energy -= 1;
                                        energy_discarded[foe] = 1;
                                    }
                                }
                                _ => {}
                            }
                        }
                        4 => {
                            let ev = c.effect_val;
                            if (ev & 1024) != 0 { guaranteed_heads = true; }
                            else if (ev & 512) != 0 { team_shield[cur] += ev & 0xff; }
                            else if (ev & 256) != 0 { dmg_boost_ex += ev & 0xff; }
                            else { dmg_boost += ev & 0xff; }
                        }
                        5 => {
                            let tv = c.effect_val as u8;
                            for s in 0..4 {
                                if board[cur][s].occ && board[cur][s].tool == 0 {
                                    if (tv == 5 || tv == 6) && board[cur][s].card.stage != 0 { continue; }
                                    board[cur][s].tool = tv;
                                    let hp_b = tool_hp_bonus(tv);
                                    if hp_b > 0 {
                                        board[cur][s].max_hp += hp_b;
                                        board[cur][s].hp += hp_b;
                                    }
                                    if tv == 10 { board[cur][s].status &= !ST_SPECIAL_MASK; }
                                    break;
                                }
                            }
                        }
                        6 => {
                            match c.effect_val {
                                99 => {
                                    let mut done_candy = false;
                                    for hi2 in 0..hand_len[cur] {
                                        if hands[cur][hi2].is_pokemon == 1 && hands[cur][hi2].stage == 2 {
                                            let evc = hands[cur][hi2];
                                            for s in 0..4 {
                                                if !board[cur][s].occ { continue; }
                                                let evo_ok = evc.evo_group == 0 || board[cur][s].card.evo_group == 0 || board[cur][s].card.evo_group == evc.evo_group;
                                                if board[cur][s].card.stage == 0 && evo_ok && board[cur][s].turn_placed < turn {
                                                    let taken = (board[cur][s].max_hp - board[cur][s].hp).max(0);
                                                    let bhp = tool_hp_bonus(board[cur][s].tool);
                                                    board[cur][s].card = evc;
                                                    board[cur][s].max_hp = evc.hp + bhp;
                                                    board[cur][s].hp = (board[cur][s].max_hp - taken).max(10);
                                                    board[cur][s].status &= !ST_SPECIAL_MASK;
                                                    board[cur][s].turn_placed = turn;
                                                    hand_len[cur] -= 1;
                                                    hands[cur][hi2] = hands[cur][hand_len[cur]];
                                                    done_candy = true;
                                                    break;
                                                }
                                            }
                                            if done_candy { break; }
                                        }
                                    }
                                }
                                1 => { retreat_discount += 1; }
                                12 => { retreat_discount += 2; }
                                13 => {
                                    let prom = best_bench_promote(&board[cur]);
                                    if prom < 4 {
                                        board[cur][0].status &= !ST_SPECIAL_MASK;
                                        board[cur].swap(0, prom);
                                        board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                                    }
                                }
                                2 => { board[cur][0].energy = board[cur][0].energy.saturating_add(1); }
                                3 => {
                                    for s in 0..4 {
                                        if board[cur][s].occ && board[cur][s].card.stage == 2 {
                                            board[cur][s].energy = board[cur][s].energy.saturating_add(1);
                                            break;
                                        }
                                    }
                                }
                                4 => { board[cur][0].energy = board[cur][0].energy.saturating_add(1); }
                                5 => {
                                    // Misty: flip until tails
                                    let mut added = 0u8;
                                    for _ in 0..6 {
                                        if rng.flip_coin(&mut guaranteed_heads) {
                                            board[cur][0].energy = board[cur][0].energy.saturating_add(1);
                                            added += 1;
                                        } else { break; }
                                    }
                                    rep_val = 500 + (added as i32);
                                }
                                6 => {
                                    for s in 1..4 {
                                        if board[cur][s].occ && board[cur][s].energy > 0 {
                                            board[cur][0].energy = board[cur][0].energy.saturating_add(board[cur][s].energy);
                                            board[cur][s].energy = 0;
                                        }
                                    }
                                }
                                7 => {
                                    // Early-Growth Extract: evolve 1 board Pokémon from deck
                                    let mut evolved = false;
                                    for s in 0..4 {
                                        if !board[cur][s].occ || board[cur][s].turn_placed >= turn { continue; }
                                        let bc = board[cur][s].card;
                                        for li in 0..lib_len[cur] {
                                            let evc = libs[cur][li];
                                            let evo_ok = evc.evo_group == 0 || bc.evo_group == 0 || bc.evo_group == evc.evo_group;
                                            if evc.is_pokemon == 1 && evc.stage == bc.stage + 1 && evo_ok {
                                                let taken = (board[cur][s].max_hp - board[cur][s].hp).max(0);
                                                let bhp = tool_hp_bonus(board[cur][s].tool);
                                                board[cur][s].card = evc;
                                                board[cur][s].max_hp = evc.hp + bhp;
                                                board[cur][s].hp = (board[cur][s].max_hp - taken).max(10);
                                                board[cur][s].status &= !ST_SPECIAL_MASK;
                                                board[cur][s].turn_placed = turn;
                                                lib_len[cur] -= 1;
                                                libs[cur][li] = libs[cur][lib_len[cur]];
                                                evolved = true;
                                                break;
                                            }
                                        }
                                        if evolved { break; }
                                    }
                                }
                                _ => {}
                            }
                        }
                        7 => {
                            let new_st = c.effect_val as u8;
                            if stadium == 3 && new_st != 3 {
                                for pp in 0..2 {
                                    for ss in 0..4 {
                                        if board[pp][ss].occ && board[pp][ss].card.stage == 0 {
                                            board[pp][ss].max_hp = (board[pp][ss].max_hp - 20).max(10);
                                            board[pp][ss].hp = board[pp][ss].hp.min(board[pp][ss].max_hp);
                                        }
                                    }
                                }
                            } else if stadium != 3 && new_st == 3 {
                                for pp in 0..2 {
                                    for ss in 0..4 {
                                        if board[pp][ss].occ && board[pp][ss].card.stage == 0 {
                                            board[pp][ss].max_hp += 20;
                                            board[pp][ss].hp += 20;
                                        }
                                    }
                                }
                            }
                            stadium = new_st;
                        }
                        _ => {}
                    }
                    if RECORD { push_replay_step(turn, cur, 6, c.slot_id as i32, c.trainer_kind as i32, rep_val, &points, &board, &hand_len, &lib_len); }
                }
                4 => {
                    ability_used_mask |= 1u8 << best_a;
                    let ab_op = board[cur][best_a].card.ab_op;
                    let ab_val = board[cur][best_a].card.ab_val;
                    let ab_card_id = board[cur][best_a].card.slot_id as i32;
                    match ab_op {
                        3 => {
                            if ab_val == 3 {
                                // Hydreigon: +2 energy, -30 self HP
                                board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(2);
                                board[cur][best_a].hp = (board[cur][best_a].hp - 30).max(10);
                            } else {
                                board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1);
                            }
                            if board[cur][best_a].card.ab_op == 19 && board[cur][best_a].card.ab_val == 99 {
                                board[cur][best_a].max_hp += 30; board[cur][best_a].hp += 30;
                            }
                        }
                        4 => {
                            if board[cur][0].occ { board[cur][0].energy = board[cur][0].energy.saturating_add(1); }
                        }
                        8 => {
                            // Greninja Water Shuriken: snipe lowest-HP opp Pokémon (or active if KO)
                            let mut ts = 0usize;
                            for s in 1..4 {
                                if board[foe][s].occ && (!board[foe][ts].occ || board[foe][s].hp < board[foe][ts].hp) { ts = s; }
                            }
                            if board[foe][ts].occ {
                                board[foe][ts].hp -= ab_val;
                                if board[foe][ts].hp <= 0 {
                                    points[cur] = points[cur].saturating_add(board[foe][ts].card.prize);
                                    board[foe][ts].occ = false;
                                    if ts == 0 {
                                        let prom = best_bench_promote(&board[foe]);
                                        if prom < 4 { board[foe].swap(0, prom); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                    }
                                    if RECORD { push_replay_step(turn, cur, 7, ab_card_id, best_a as i32, (ab_op as i32) | ((ab_val as i32) << 8), &points, &board, &hand_len, &lib_len); }
                                    if points[cur] >= 3 || !board[foe][0].occ {
                                        *points_out = points;
                                        return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                                    }
                                    continue;
                                }
                            }
                        }
                        15 => {
                            if board[cur][0].occ { board[cur][0].hp = (board[cur][0].hp + ab_val).min(board[cur][0].max_hp); }
                        }
                        17 => {
                            let prom = best_bench_promote(&board[cur]);
                            if prom < 4 {
                                board[cur][0].status &= !ST_SPECIAL_MASK;
                                board[cur].swap(0, prom);
                                board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                            }
                        }
                        20 => {
                            match ab_val {
                                1 => {
                                    let pick = best_bench_promote(&board[foe]);
                                    if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                2 => {
                                    let mut pick = 4usize;
                                    for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp { pick = bs; break; } }
                                    if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                3 => {
                                    let mut pick = 4usize;
                                    for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].card.stage == 0 { pick = bs; break; } }
                                    if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                4 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, &mut rng); }
                                5 => { if board[foe][0].occ { apply_status(&mut board[foe][0], ST_POISON); } }
                                6 => { if board[foe][0].occ { apply_status(&mut board[foe][0], ST_BURN); } }
                                7 => { if board[foe][0].occ && rng.flip_coin(&mut guaranteed_heads) { apply_status(&mut board[foe][0], ST_SLEEP); } }
                                8 => { if board[foe][0].occ && rng.flip_coin(&mut guaranteed_heads) { apply_status(&mut board[foe][0], ST_POISON); } }
                                9 => { if board[foe][0].occ { apply_status(&mut board[foe][0], ST_CONFUSE); } }
                                10 => { if lib_len[foe] > 0 { lib_len[foe] -= 1; } }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                    if RECORD { push_replay_step(turn, cur, 7, ab_card_id, best_a as i32, (ab_op as i32) | ((ab_val as i32) << 8), &points, &board, &hand_len, &lib_len); }
                }
                5 => {
                    energy_attached = true;
                    board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1);
                    let tgt_card = board[cur][best_a].card;
                    // Reuniclus: +30 max HP per energy
                    if tgt_card.ab_op == 19 && tgt_card.ab_val == 99 {
                        board[cur][best_a].max_hp += 30;
                        board[cur][best_a].hp += 30;
                    }
                    if RECORD { push_replay_step(turn, cur, 8, tgt_card.slot_id as i32, best_a as i32, board[cur][best_a].energy as i32, &points, &board, &hand_len, &lib_len); }

                    // Trigger Darkrai ex (20) / C1 Charizard Flame Aura (30): ab_op == 9
                    if tgt_card.ab_op == 9 && board[foe][0].occ {
                        let chip = tgt_card.ab_val;
                        board[foe][0].hp -= chip;
                        handle_active_ko(foe, cur, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                        if RECORD { push_replay_step(turn, cur, 7, tgt_card.slot_id as i32, best_a as i32, 9 | ((chip as i32) << 8), &points, &board, &hand_len, &lib_len); }
                        if points[cur] >= 3 || !board[foe][0].occ {
                            *points_out = points;
                            return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                        }
                    }
                    // Trigger Opponent Jolteon ex (ab_op == 22): 20 dmg to the Pokémon receiving energy!
                    if board[foe][0].occ && board[foe][0].card.ab_op == 22 {
                        let jdmg = board[foe][0].card.ab_val;
                        board[cur][best_a].hp -= jdmg;
                        if board[cur][best_a].hp <= 0 {
                            points[foe] = points[foe].saturating_add(board[cur][best_a].card.prize);
                            board[cur][best_a].occ = false;
                            if best_a == 0 {
                                let prom = best_bench_promote(&board[cur]);
                                if prom < 4 { board[cur].swap(0, prom); board[cur][0].status &= !ST_HAS_ATTACKED; }
                            }
                        }
                        if RECORD { push_replay_step(turn, foe, 7, board[foe][0].card.slot_id as i32, 0, 22 | ((jdmg as i32) << 8), &points, &board, &hand_len, &lib_len); }
                        if points[foe] >= 3 || !board[cur][0].occ {
                            *points_out = points;
                            return finish_game(if foe == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                        }
                    }
                }
                6 => {
                    retreated = true;
                    let old_id = board[cur][0].card.slot_id as i32;
                    let new_id = board[cur][best_a].card.slot_id as i32;
                    let pay = eff_retreat_cost(&board[cur], stadium, retreat_discount).max(0) as u8;
                    if pay > 0 { energy_discarded[cur] = 1; }
                    board[cur][0].energy = board[cur][0].energy.saturating_sub(pay);
                    board[cur][0].status &= !(ST_SPECIAL_MASK | ST_CANT_RETREAT | ST_OPP_MISS_FLIP | ST_CANT_ATK_OPP | ST_CANT_ATK_SELF | ST_NEXT_BOOST);
                    board[cur][0].weaken = 0;
                    board[cur].swap(0, best_a);
                    board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                    if RECORD { push_replay_step(turn, cur, 9, old_id, best_a as i32, new_id, &points, &board, &hand_len, &lib_len); }
                }
                7 => {
                    let atk_idx = best_a;
                    let atk_c = board[cur][0].card;
                    let (ac, ad, ao, av) = if atk_idx == 0 {
                        (atk_c.a1_cost, atk_c.a1_dmg, atk_c.a1_op, atk_c.a1_val)
                    } else {
                        (atk_c.a2_cost, atk_c.a2_dmg, atk_c.a2_op, atk_c.a2_val)
                    };
                    let hi = (av >> 8) & 0xff;
                    let lo = av & 0xff;

                    let mut miss_flag = 0i32;
                    let mut eff_tag = 0i32;
                    let mut eff_num = 0i32;
                    let mut total_dmg: i16 = 0;
                    let mut weak_b: i16 = 0;
                    let mut ko_flag = 0i32;

                    // Pre-attack miss checks: Confusion -> Magnezone OppMissFlip -> Op 7 Flip-to-hit -> Op 20 val 98 Fly fail
                    if (board[cur][0].status & ST_CONFUSE) != 0 && !rng.flip_coin(&mut guaranteed_heads) {
                        miss_flag = 1; eff_tag = 27;
                    } else if (board[cur][0].status & ST_OPP_MISS_FLIP) != 0 && !rng.flip_coin(&mut guaranteed_heads) {
                        miss_flag = 1; eff_tag = 28;
                    } else if ao == 7 && !rng.flip_coin(&mut guaranteed_heads) {
                        miss_flag = 1; eff_tag = 30;
                    } else if ao == 20 && av == 98 && !rng.flip_coin(&mut guaranteed_heads) {
                        miss_flag = 1; eff_tag = 30;
                    }

                    // Consume Next-Turn Boost after declaring attack
                    let had_next_boost = (board[cur][0].status & ST_NEXT_BOOST) != 0;
                    board[cur][0].status &= !ST_NEXT_BOOST;

                    if miss_flag == 0 && board[foe][0].occ {
                        // Op 23 val 6 (Starly): discard opp Tool BEFORE damage
                        if ao == 23 && av == 6 && board[foe][0].tool != 0 {
                            let hp_b = tool_hp_bonus(board[foe][0].tool);
                            board[foe][0].tool = 0;
                            if hp_b > 0 {
                                board[foe][0].max_hp = (board[foe][0].max_hp - hp_b).max(10);
                                board[foe][0].hp = board[foe][0].hp.min(board[foe][0].max_hp);
                            }
                            eff_tag = 22;
                        }

                        // Compute raw active damage for exact opcode
                        let mut raw_d = ad;
                        let mut direct_active = true;
                        match ao {
                            8 => {
                                let mut heads = 0i16;
                                if av == 99 {
                                    for _ in 0..10 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } else { break; } }
                                } else {
                                    for _ in 0..(av.clamp(1, 12)) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                }
                                raw_d = ad * heads;
                                eff_tag = 24; eff_num = heads as i32;
                            }
                            9 => {
                                let mut heads = 0i16;
                                if hi == 99 {
                                    for _ in 0..10 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } else { break; } }
                                } else {
                                    for _ in 0..(hi.clamp(1, 8)) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                }
                                raw_d = ad + lo * heads;
                                eff_tag = 24; eff_num = heads as i32;
                            }
                            10 => {
                                if hi == 3 {
                                    let n = 1 + count_bench(&board[cur]);
                                    let mut heads = 0i16;
                                    for _ in 0..n { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    raw_d = lo * heads;
                                    eff_tag = 24; eff_num = heads as i32;
                                } else {
                                    let cnt = match hi {
                                        0 => count_bench(&board[cur]),
                                        1 => count_bench(&board[foe]),
                                        _ => count_bench(&board[cur]) + count_bench(&board[foe]),
                                    };
                                    raw_d = ad + (cnt as i16) * lo;
                                }
                            }
                            11 => {
                                let e = eff_energy(&board[cur], 0);
                                if av >= 1000 {
                                    let per = av - 1000;
                                    let mut heads = 0i16;
                                    for _ in 0..e.min(10) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    raw_d = per * heads;
                                    eff_tag = 24; eff_num = heads as i32;
                                } else {
                                    raw_d = ad + (e as i16) * av;
                                }
                            }
                            12 => {
                                if hi == 1 {
                                    let mut te = 0i16;
                                    for s in 0..4 { if board[foe][s].occ { te += board[foe][s].energy as i16; } }
                                    raw_d = ad + te * lo;
                                } else if hi == 2 {
                                    // Tapu Lele: snipe opp pokemon with highest energy
                                    direct_active = false;
                                    let mut ts = 0usize;
                                    for s in 1..4 { if board[foe][s].occ && board[foe][s].energy > board[foe][ts].energy { ts = s; } }
                                    let sd = (board[foe][ts].energy as i16) * lo;
                                    if ts == 0 {
                                        total_dmg = sd;
                                        board[foe][0].hp -= sd;
                                    } else {
                                        board[foe][ts].hp -= sd;
                                        eff_tag = 6; eff_num = sd as i32;
                                        if board[foe][ts].hp <= 0 {
                                            points[cur] = points[cur].saturating_add(board[foe][ts].card.prize);
                                            board[foe][ts].occ = false;
                                        }
                                    }
                                } else {
                                    raw_d = ad + (board[foe][0].energy as i16) * lo;
                                }
                            }
                            13 => {
                                let e = eff_energy(&board[cur], 0);
                                raw_d = ad + if e >= (ac as i32) + (hi as i32) { lo } else { 0 };
                            }
                            14 => {
                                if hi == 0 && board[foe][0].hp < board[foe][0].max_hp { raw_d = ad + lo; }
                                else if hi == 1 && board[cur][0].hp < board[cur][0].max_hp { raw_d = ad + lo; }
                                else if hi == 2 && board[cur][0].hp < board[cur][0].max_hp { raw_d = (ad - lo).max(0); }
                                else if hi == 3 { raw_d = ad + (board[cur][0].max_hp - board[cur][0].hp).max(0); }
                            }
                            17 => {
                                if hi == 2 || hi == 8 || hi == 10 {
                                    direct_active = false;
                                    let mut ts = 4usize;
                                    if hi == 10 {
                                        // Decidueye ex: 1 damaged opp pokemon
                                        for s in 0..4 {
                                            if board[foe][s].occ && board[foe][s].hp < board[foe][s].max_hp {
                                                if ts == 4 || board[foe][s].hp < board[foe][ts].hp { ts = s; }
                                            }
                                        }
                                    } else {
                                        for s in 0..4 {
                                            if board[foe][s].occ {
                                                // Prefer bench KO or lowest HP (skip Oricorio ex-immune active if bench exists)
                                                let blocked = s == 0 && active_ex_blocked;
                                                if !blocked && (ts == 4 || board[foe][s].hp < board[foe][ts].hp) { ts = s; }
                                            }
                                        }
                                    }
                                    if ts < 4 {
                                        board[foe][ts].hp -= lo;
                                        if ts == 0 { total_dmg = lo; } else { eff_tag = 6; eff_num = lo as i32; }
                                        if ts > 0 && board[foe][ts].hp <= 0 {
                                            points[cur] = points[cur].saturating_add(board[foe][ts].card.prize);
                                            board[foe][ts].occ = false;
                                        }
                                    }
                                    if hi == 8 {
                                        if board[cur][0].energy > 0 { energy_discarded[cur] = 1; }
                                        board[cur][0].energy = 0;
                                    }
                                } else if hi >= 3 && hi <= 7 {
                                    // Random spread hits (Wugtrio ex 3x50, Dragonite 4x50)
                                    direct_active = false;
                                    let times = (hi - 2) as usize;
                                    let mut total_hit = 0i16;
                                    for _ in 0..times {
                                        let mut occ_idx = [0usize; 4];
                                        let mut occ_n = 0usize;
                                        for s in 0..4 { if board[foe][s].occ && board[foe][s].hp > 0 { occ_idx[occ_n] = s; occ_n += 1; } }
                                        if occ_n == 0 { break; }
                                        let pick = occ_idx[(rng.next_u32() as usize) % occ_n];
                                        if pick == 0 && active_ex_blocked { continue; }
                                        board[foe][pick].hp -= lo;
                                        total_hit += lo;
                                        if pick > 0 && board[foe][pick].hp <= 0 {
                                            points[cur] = points[cur].saturating_add(board[foe][pick].card.prize);
                                            board[foe][pick].occ = false;
                                        }
                                    }
                                    total_dmg = total_hit;
                                    eff_tag = 6; eff_num = total_hit as i32;
                                } else if hi == 9 {
                                    // Spiritomb: lo to ALL opp Pokemon
                                    direct_active = false;
                                    for s in 0..4 {
                                        if board[foe][s].occ {
                                            if s == 0 && active_ex_blocked { continue; }
                                            board[foe][s].hp -= lo;
                                            if s == 0 { total_dmg = lo; }
                                            else if board[foe][s].hp <= 0 {
                                                points[cur] = points[cur].saturating_add(board[foe][s].card.prize);
                                                board[foe][s].occ = false;
                                            }
                                        }
                                    }
                                    eff_tag = 6; eff_num = lo as i32;
                                }
                            }
                            27 => {
                                let mut b = 0i16;
                                match hi {
                                    0 => { if (board[foe][0].status & ST_SPECIAL_MASK) != 0 { b = lo; } }
                                    1 => { if board[foe][0].card.prize >= 2 { b = lo; } }
                                    2 => {
                                        if (board[cur][0].status & ST_HAS_ATTACKED) == 0 {
                                            b = lo;
                                            let st = apply_status(&mut board[foe][0], ST_PARALYZE);
                                            if st != 0 { eff_tag = st as i32; }
                                        }
                                    }
                                    3 => { if board[foe][0].card.stage == 0 { b = lo; } }
                                    4 => { if board[cur][0].tool != 0 { b = lo; } }
                                    5 => { if board[foe][0].tool != 0 { b = lo; } }
                                    6 => { if ko_last_turn[cur] != 0 { b = lo; } }
                                    7 => { if supporter_used { b = lo; } }
                                    8 => { if board[foe][0].hp > board[cur][0].hp { b = lo; } }
                                    9 => { if board[foe][0].card.ab_op != 0 { b = lo; } }
                                    10 => { if (board[cur][0].status & ST_SWITCHED_IN) != 0 { b = lo; } }
                                    11 => { if board[cur][0].card.stage > 0 && board[cur][0].turn_placed == turn { b = lo; } }
                                    _ => {}
                                }
                                raw_d = ad + b;
                            }
                            28 => {
                                direct_active = false;
                                if av == 1 {
                                    total_dmg = board[foe][0].hp;
                                    board[foe][0].hp = 0;
                                    eff_tag = 25;
                                } else if av == 2 {
                                    // Discard opp active without scoring points
                                    board[foe][0].occ = false;
                                    let prom = best_bench_promote(&board[foe]);
                                    if prom < 4 { board[foe].swap(0, prom); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                    eff_tag = 25;
                                } else if av == 3 {
                                    // Bewear: flip 2 coins, both heads -> KO
                                    if rng.flip_coin(&mut guaranteed_heads) && rng.flip_coin(&mut guaranteed_heads) {
                                        total_dmg = board[foe][0].hp;
                                        board[foe][0].hp = 0;
                                        eff_tag = 25;
                                    } else {
                                        miss_flag = 1; eff_tag = 30;
                                    }
                                } else {
                                    // Super Fang: halve remaining HP (round down to nearest 10)
                                    let cut = ((board[foe][0].hp / 2) / 10) * 10;
                                    let dealt = cut.max(10);
                                    board[foe][0].hp -= dealt;
                                    total_dmg = dealt;
                                    eff_tag = 25;
                                }
                            }
                            _ => {}
                        }

                        // Apply direct damage to Opponent Active (checking Invuln, Disguise, Dodge, Ex-Immunity, Passive Mods)
                        let mut active_took_dmg = false;
                        if direct_active && raw_d > 0 {
                            let invuln = (board[foe][0].status & ST_INVULN) != 0;
                            let disguise = board[foe][0].card.ab_op == 26 && board[foe][0].card.ab_val == 1 && (board[foe][0].status & ST_DISGUISE_USED) == 0;
                            let dodge = board[foe][0].card.ab_op == 26 && board[foe][0].card.ab_val == 2 && { let mut dh = false; rng.flip_coin(&mut dh) };
                            if invuln || active_ex_blocked || disguise || dodge {
                                if disguise { board[foe][0].status |= ST_DISGUISE_USED; }
                                total_dmg = 0;
                                if invuln || disguise || dodge { miss_flag = 1; eff_tag = 29; }
                            } else {
                                let (mod_net, wb) = calc_passive_dmg_mods(&board[cur], &board[foe], dmg_boost, dmg_boost_ex, stadium, team_shield[foe]);
                                let extra_nb = if had_next_boost { 60 } else { 0 };
                                weak_b = wb;
                                total_dmg = (raw_d + mod_net + extra_nb).max(0);
                                if total_dmg > 0 {
                                    board[foe][0].hp -= total_dmg;
                                    active_took_dmg = true;
                                }
                            }
                        } else if !direct_active && total_dmg > 0 && board[foe][0].occ {
                            active_took_dmg = true;
                        }

                        // Defender contact reactions when damaged by attack
                        if active_took_dmg && board[foe][0].occ {
                            // Rocky Helmet (tool == 3): 20 recoil
                            if board[foe][0].tool == 3 {
                                board[cur][0].hp -= 20;
                                if eff_tag == 0 { eff_tag = 26; eff_num = 20; }
                            }
                            // Poison Barb (tool == 4): Poison attacker
                            if board[foe][0].tool == 4 { apply_status(&mut board[cur][0], ST_POISON); }
                            // Counter shield (Mega Sableye ex / Alolan Sandslash: shield < 0)
                            if board[foe][0].shield < 0 {
                                let c_dmg = -board[foe][0].shield;
                                board[cur][0].hp -= c_dmg;
                                if eff_tag == 0 { eff_tag = 26; eff_num = c_dmg as i32; }
                            }
                            // Druddigon / Poliwrath / Ferrothorn / Lycanroc ex / Dragalge ex (ab_op == 14)
                            if board[foe][0].card.ab_op == 14 {
                                let fv = board[foe][0].card.ab_val;
                                if fv == 99 { apply_status(&mut board[cur][0], ST_POISON); }
                                else if fv > 0 && fv < 100 {
                                    board[cur][0].hp -= fv;
                                    if eff_tag == 0 { eff_tag = 26; eff_num = fv as i32; }
                                }
                            }
                        }

                        // Post-damage attack additional effects!
                        match ao {
                            1 => { let st = apply_status(&mut board[foe][0], if av >= 20 { ST_TOXIC } else { ST_POISON }); if st != 0 { eff_tag = st as i32; } }
                            2 => { let st = apply_status(&mut board[foe][0], ST_BURN); if st != 0 { eff_tag = st as i32; } }
                            3 => { let st = apply_status(&mut board[foe][0], ST_SLEEP); if st != 0 { eff_tag = st as i32; } }
                            4 => { let st = apply_status(&mut board[foe][0], ST_PARALYZE); if st != 0 { eff_tag = st as i32; } }
                            5 => { let st = apply_status(&mut board[foe][0], ST_CONFUSE); if st != 0 { eff_tag = st as i32; } }
                            6 => {
                                if rng.flip_coin(&mut guaranteed_heads) {
                                    let mut mask = 0u16;
                                    if (av & 1) != 0 { mask |= ST_POISON; }
                                    if (av & 2) != 0 { mask |= ST_BURN; }
                                    if (av & 4) != 0 { mask |= ST_SLEEP; }
                                    if (av & 8) != 0 { mask |= ST_PARALYZE; }
                                    if (av & 16) != 0 { mask |= ST_CONFUSE; }
                                    let st = apply_status(&mut board[foe][0], mask);
                                    if st != 0 { eff_tag = st as i32; }
                                }
                            }
                            15 => {
                                if av >= 1000 {
                                    // Zapdos self-bench recoil
                                    let sb = av - 1000;
                                    for s in 1..4 {
                                        if board[cur][s].occ {
                                            board[cur][s].hp -= sb;
                                            if board[cur][s].hp <= 0 {
                                                points[foe] = points[foe].saturating_add(board[cur][s].card.prize);
                                                board[cur][s].occ = false;
                                            }
                                            eff_tag = 7; eff_num = sb as i32;
                                            break;
                                        }
                                    }
                                } else {
                                    board[cur][0].hp -= av;
                                    eff_tag = 7; eff_num = av as i32;
                                }
                            }
                            16 => {
                                if av == 100 {
                                    // Gyarados ex: discard 1 random energy from either board
                                    if (rng.next_u32() & 1) == 0 && board[cur][0].energy > 0 {
                                        board[cur][0].energy -= 1; energy_discarded[cur] = 1;
                                    } else if board[foe][0].energy > 0 {
                                        board[foe][0].energy -= 1; energy_discarded[foe] = 1;
                                    }
                                    eff_tag = 8; eff_num = 1;
                                } else if av >= 99 {
                                    let dcnt = board[cur][0].energy;
                                    if dcnt > 0 { energy_discarded[cur] = 1; }
                                    board[cur][0].energy = 0;
                                    eff_tag = 8; eff_num = dcnt as i32;
                                } else {
                                    let dcnt = (av as u8).min(board[cur][0].energy);
                                    if dcnt > 0 { energy_discarded[cur] = 1; }
                                    board[cur][0].energy = board[cur][0].energy.saturating_sub(av as u8);
                                    eff_tag = 8; eff_num = dcnt as i32;
                                }
                            }
                            17 => {
                                if hi == 0 {
                                    // +lo to 1 opp bench (Hoopa ex)
                                    for s in 1..4 {
                                        if board[foe][s].occ {
                                            board[foe][s].hp -= lo;
                                            if board[foe][s].hp <= 0 {
                                                points[cur] = points[cur].saturating_add(board[foe][s].card.prize);
                                                board[foe][s].occ = false;
                                            }
                                            eff_tag = 6; eff_num = lo as i32;
                                            break;
                                        }
                                    }
                                } else if hi == 1 {
                                    // +lo to ALL opp bench (Palkia ex)
                                    let mut hit_any = false;
                                    for s in 1..4 {
                                        if board[foe][s].occ {
                                            board[foe][s].hp -= lo;
                                            hit_any = true;
                                            if board[foe][s].hp <= 0 {
                                                points[cur] = points[cur].saturating_add(board[foe][s].card.prize);
                                                board[foe][s].occ = false;
                                            }
                                        }
                                    }
                                    if hit_any { eff_tag = 6; eff_num = lo as i32; }
                                }
                            }
                            18 => {
                                let h = if av == 999 { total_dmg } else { av };
                                if h > 0 {
                                    board[cur][0].hp = (board[cur][0].hp + h).min(board[cur][0].max_hp);
                                    eff_tag = 9; eff_num = h as i32;
                                }
                            }
                            19 => {
                                if av == 1 {
                                    board[cur][0].energy = board[cur][0].energy.saturating_add(1);
                                    eff_tag = 10; eff_num = 1;
                                } else {
                                    let max_b = if av == 3 { 2 } else { 1 };
                                    let mut cnt = 0i32;
                                    for s in 1..4 {
                                        if board[cur][s].occ {
                                            board[cur][s].energy = board[cur][s].energy.saturating_add(1);
                                            cnt += 1;
                                            if cnt >= max_b { break; }
                                        }
                                    }
                                    if cnt > 0 { eff_tag = 10; eff_num = cnt; }
                                }
                            }
                            20 => {
                                if av == 98 || av == 99 {
                                    if av == 98 || rng.flip_coin(&mut guaranteed_heads) {
                                        board[cur][0].status |= ST_INVULN;
                                        eff_tag = 11; eff_num = 99;
                                    }
                                } else if av > 100 {
                                    board[cur][0].shield = -(av - 100);
                                    eff_tag = 11; eff_num = (av - 100) as i32;
                                } else {
                                    board[cur][0].shield = av;
                                    eff_tag = 11; eff_num = av as i32;
                                }
                            }
                            21 => {
                                if av == 99 {
                                    board[foe][0].status |= ST_OPP_MISS_FLIP;
                                    eff_tag = 12; eff_num = 99;
                                } else if av == 98 {
                                    board[foe][0].status |= ST_CANT_ATK_OPP;
                                    eff_tag = 12; eff_num = 98;
                                } else if av == 97 {
                                    if rng.flip_coin(&mut guaranteed_heads) {
                                        board[foe][0].status |= ST_CANT_ATK_OPP;
                                        eff_tag = 12; eff_num = 98;
                                    }
                                } else {
                                    board[foe][0].weaken += av;
                                    eff_tag = 12; eff_num = av as i32;
                                }
                            }
                            22 => {
                                let prom = best_bench_promote(&board[cur]);
                                if prom < 4 {
                                    board[cur][0].status &= !ST_SPECIAL_MASK;
                                    board[cur].swap(0, prom);
                                    board[cur][0].status &= !ST_HAS_ATTACKED;
                                    eff_tag = 13;
                                }
                            }
                            23 => {
                                match av {
                                    1 => { board[foe][0].status |= ST_CANT_RETREAT; eff_tag = 14; }
                                    2 => {
                                        let pick = best_bench_promote(&board[foe]);
                                        if pick < 4 { board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; eff_tag = 15; }
                                    }
                                    3 => { item_lock[foe] = 1; eff_tag = 16; }
                                    4 => {
                                        // Mega Absol ex: discard 1 Supporter from opponent hand
                                        for k in 0..hand_len[foe] {
                                            if hands[foe][k].is_supporter == 1 {
                                                hand_len[foe] -= 1;
                                                hands[foe][k] = hands[foe][hand_len[foe]];
                                                eff_tag = 17;
                                                break;
                                            }
                                        }
                                    }
                                    5 => { supp_lock[foe] = 1; eff_tag = 18; }
                                    7 => {
                                        if hand_len[foe] > 0 {
                                            let pick = (rng.next_u32() as usize) % hand_len[foe];
                                            let c_back = hands[foe][pick];
                                            hand_len[foe] -= 1;
                                            hands[foe][pick] = hands[foe][hand_len[foe]];
                                            if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = c_back; lib_len[foe] += 1; }
                                            eff_tag = 23;
                                        }
                                    }
                                    8 => {
                                        if rng.flip_coin(&mut guaranteed_heads) && count_bench(&board[foe]) > 0 {
                                            let bounced = board[foe][0].card;
                                            board[foe][0].occ = false;
                                            let prom = best_bench_promote(&board[foe]);
                                            if prom < 4 { board[foe].swap(0, prom); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                            if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = bounced; lib_len[foe] += 1; }
                                            eff_tag = 23;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            24 => {
                                let mut disc = 0i32;
                                if av == 1 && board[foe][0].energy > 0 {
                                    board[foe][0].energy -= 1; disc = 1;
                                } else if av == 2 && board[foe][0].energy > 0 && rng.flip_coin(&mut guaranteed_heads) {
                                    board[foe][0].energy -= 1; disc = 1;
                                } else if av == 3 {
                                    for _ in 0..5 {
                                        if board[foe][0].energy > 0 && rng.flip_coin(&mut guaranteed_heads) {
                                            board[foe][0].energy -= 1; disc += 1;
                                        } else { break; }
                                    }
                                }
                                if disc > 0 { energy_discarded[foe] = 1; eff_tag = 19; eff_num = disc; }
                            }
                            25 => {
                                if av == 1 { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); eff_tag = 20; eff_num = 1; }
                                else if av == 2 { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, &mut rng); eff_tag = 20; eff_num = 2; }
                                else if av == 3 {
                                    // Call for Family: bench 1 basic from deck
                                    for bs in 1..4 {
                                        if !board[cur][bs].occ {
                                            for li in 0..lib_len[cur] {
                                                if libs[cur][li].is_pokemon == 1 && libs[cur][li].stage == 0 && libs[cur][li].is_fossil == 0 {
                                                    let bc = libs[cur][li];
                                                    lib_len[cur] -= 1;
                                                    libs[cur][li] = libs[cur][lib_len[cur]];
                                                    board[cur][bs] = Slot { occ: true, card: bc, hp: bc.hp, max_hp: bc.hp, energy: 0, tool: 0, status: 0, shield: 0, weaken: 0, turn_placed: turn };
                                                    eff_tag = 20; eff_num = 3;
                                                    break;
                                                }
                                            }
                                            break;
                                        }
                                    }
                                } else if av == 4 {
                                    let want = hand_len[foe];
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, &mut rng);
                                    for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                    eff_tag = 20; eff_num = 4;
                                }
                            }
                            26 => {
                                if av == 1 { board[cur][0].status |= ST_CANT_ATK_SELF; eff_tag = 21; }
                                else { board[cur][0].status |= ST_NEXT_BOOST; }
                            }
                            _ => {}
                        }
                    }

                    board[cur][0].status |= ST_HAS_ATTACKED;

                    // Resolve KOs on opponent active & own active
                    let (foe_ko, pyu_rec) = handle_active_ko(foe, cur, true, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                    if foe_ko { ko_flag = 1; }
                    if pyu_rec > 0 && board[cur][0].occ { board[cur][0].hp -= pyu_rec; }
                    handle_active_ko(cur, foe, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);

                    if RECORD {
                        let packed_aux2 = ((weak_b as i32) & 0x3f)
                            | ((ko_flag & 1) << 6)
                            | (((atk_idx as i32) & 1) << 7)
                            | ((miss_flag & 1) << 8)
                            | ((eff_tag & 0x3f) << 9)
                            | ((eff_num & 0x3ff) << 15);
                        push_replay_step(turn, cur, 10, atk_c.slot_id as i32, total_dmg as i32, packed_aux2, &points, &board, &hand_len, &lib_len);
                    }

                    let cur_won = points[cur] >= 3 || !board[foe][0].occ;
                    let foe_won = points[foe] >= 3 || !board[cur][0].occ;
                    if cur_won && foe_won { *points_out = points; return finish_game(2, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                    if cur_won { *points_out = points; return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                    if foe_won { *points_out = points; return finish_game(if foe == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
                    break;
                }
                _ => break,
            }
        }

        // === End-of-Turn Triggers for Current Player ===
        if board[cur][0].occ {
            // Entei ex / Suicune ex Legendary Pulse (ab_op == 1): draw 1 at EoT
            if board[cur][0].card.ab_op == 1 {
                let d_id = draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                if RECORD && d_id >= 0 {
                    push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 1, 9, &points, &board, &hand_len, &lib_len);
                }
            }
            // Trick Pin (tool == 8): 10 dmg to opp active at EoT
            if board[cur][0].tool == 8 && board[foe][0].occ {
                let vic_card = board[foe][0].card.slot_id as i32;
                board[foe][0].hp -= 10;
                let (ko, _) = handle_active_ko(foe, cur, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                if RECORD {
                    push_replay_step(turn, foe, 12, vic_card, 10, 5 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len);
                }
                if points[cur] >= 3 || !board[foe][0].occ {
                    *points_out = points;
                    return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                }
            }
            // Snorlax ex (ab_op == 23, val == 2) or Healing Beach (stadium == 7)
            if (board[cur][0].card.ab_op == 23 && board[cur][0].card.ab_val == 2) || (stadium == 7 && board[cur][0].energy > 0) {
                if board[cur][0].hp < board[cur][0].max_hp {
                    board[cur][0].hp = (board[cur][0].hp + 20).min(board[cur][0].max_hp);
                    if RECORD {
                        push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 20, 8, &points, &board, &hand_len, &lib_len);
                    }
                }
            }
            // Paralysis on current player's active clears at end of current player's turn
            if (board[cur][0].status & ST_PARALYZE) != 0 {
                board[cur][0].status &= !ST_PARALYZE;
                if RECORD {
                    push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 0, 4 | (1 << 5), &points, &board, &hand_len, &lib_len);
                }
            }
            // Clear turn-scoped debuffs on current player
            board[cur][0].status &= !(ST_CANT_RETREAT | ST_CANT_ATK_OPP | ST_OPP_MISS_FLIP | ST_SWITCHED_IN);
            if had_cant_atk_self { board[cur][0].status &= !ST_CANT_ATK_SELF; }
            if had_next_boost_start { board[cur][0].status &= !ST_NEXT_BOOST; }
            board[cur][0].weaken = 0;
        }
        // Zeraora Turn-1 EoT +1 energy (ab_op == 23, val == 3)
        if turn <= 2 {
            for s in 0..4 {
                if board[cur][s].occ && board[cur][s].card.ab_op == 23 && board[cur][s].card.ab_val == 3 {
                    board[cur][s].energy = board[cur][s].energy.saturating_add(1);
                    if RECORD {
                        push_replay_step(turn, cur, 12, board[cur][s].card.slot_id as i32, 1, 10, &points, &board, &hand_len, &lib_len);
                    }
                }
            }
        }
        item_lock[cur] = 0;
        supp_lock[cur] = 0;
        ko_last_turn[cur] = 0;

        // === Between-Turns Pokémon Check (Poison / Burn / Sleep / Darkrai Nightmare / Glaceon ex) ===
        for p in 0..2 {
            let opp = 1 - p;
            if !board[p][0].occ { continue; }

            // 1. Poison / Toxic (+ Nihilego ab_op == 24)
            if (board[p][0].status & (ST_POISON | ST_TOXIC)) != 0 {
                let mut pdmg: i16 = if (board[p][0].status & ST_TOXIC) != 0 { 20 } else { 10 };
                for s in 0..4 { if board[opp][s].occ && board[opp][s].card.ab_op == 24 { pdmg += 10; } }
                let st_card = board[p][0].card.slot_id as i32;
                board[p][0].hp -= pdmg;
                let (ko, _) = handle_active_ko(p, opp, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                if RECORD { push_replay_step(turn, p, 12, st_card, pdmg as i32, 1 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
                if !board[p][0].occ { continue; }
            }
            // 2. Burn (20 dmg + flip to cure)
            if (board[p][0].status & ST_BURN) != 0 {
                let st_card = board[p][0].card.slot_id as i32;
                board[p][0].hp -= 20;
                let mut cured = 0i32;
                let mut dh = false;
                if rng.flip_coin(&mut dh) { board[p][0].status &= !ST_BURN; cured = 1; }
                let (ko, _) = handle_active_ko(p, opp, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                if RECORD { push_replay_step(turn, p, 12, st_card, 20, 2 | ((ko as i32) << 4) | (cured << 5), &points, &board, &hand_len, &lib_len); }
                if !board[p][0].occ { continue; }
            }
            // 3. Sleep: Darkrai Nightmare (ab_op == 10) BEFORE wake-up flip!
            if (board[p][0].status & ST_SLEEP) != 0 {
                let mut nm_dmg = 0i16;
                for s in 0..4 { if board[opp][s].occ && board[opp][s].card.ab_op == 10 { nm_dmg += board[opp][s].card.ab_val; } }
                if nm_dmg > 0 {
                    let st_card = board[p][0].card.slot_id as i32;
                    board[p][0].hp -= nm_dmg;
                    let (ko, _) = handle_active_ko(p, opp, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                    if RECORD { push_replay_step(turn, p, 12, st_card, nm_dmg as i32, 6 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
                    if !board[p][0].occ { continue; }
                }
                if (board[p][0].status & ST_SLEEP) != 0 {
                    let st_card = board[p][0].card.slot_id as i32;
                    let mut woke = 0i32;
                    let mut dh = false;
                    if rng.flip_coin(&mut dh) { board[p][0].status &= !ST_SLEEP; woke = 1; }
                    if RECORD { push_replay_step(turn, p, 12, st_card, 0, 3 | (woke << 5), &points, &board, &hand_len, &lib_len); }
                }
            }
            // 4. Glaceon ex Snowy Terrain (ab_op == 23, val == 1)
            if board[opp][0].occ && board[opp][0].card.ab_op == 23 && board[opp][0].card.ab_val == 1 {
                let st_card = board[p][0].card.slot_id as i32;
                board[p][0].hp -= 10;
                let (ko, _) = handle_active_ko(p, opp, false, &mut board, &mut points, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut ko_last_turn, &mut rng);
                if RECORD { push_replay_step(turn, p, 12, st_card, 10, 7 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
            }
        }

        let p0_won = points[0] >= 3 || !board[1][0].occ;
        let p1_won = points[1] >= 3 || !board[0][0].occ;
        if p0_won && p1_won { *points_out = points; return finish_game(2, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
        if p0_won { *points_out = points; return finish_game(1, turn, track_feat, feat_cnt, &feat_sum, feat_out); }
        if p1_won { *points_out = points; return finish_game(0, turn, track_feat, feat_cnt, &feat_sum, feat_out); }

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

#[no_mangle]
pub extern "C" fn run_optimize_batch(
    n_cands: u32,
    n_enemies: u32,
    games_per_opp: u32,
    seed_base: u32,
) -> u32 {
    let nc = (n_cands as usize).clamp(1, MAX_OPT_CARDS);
    let n_opps = (n_enemies as usize).clamp(1, MAX_ENEMIES);
    let gpo = (games_per_opp as usize).max(2);
    let half = (gpo / 2).max(1);

    let mut d0 = read_deck(0);
    let mut enemies = [[CompactCard::default(); 20]; MAX_ENEMIES];
    let mut w_enemies = [[0i32; FEATURES]; MAX_ENEMIES];
    let mut w_player = [0i32; FEATURES];
    unsafe {
        for o in 0..n_opps {
            enemies[o] = read_deck(o + 1);
            let off = o * FEATURES;
            w_enemies[o].copy_from_slice(&WEIGHTS_BUF[off..off + FEATURES]);
        }
        w_player.copy_from_slice(&WEIGHTS_BUF[MAX_ENEMIES * FEATURES..(MAX_ENEMIES + 1) * FEATURES]);
    }

    let mut dummy = [0.0f32; FEATURES];
    let mut pts_dummy = [0u8; 2];

    unsafe {
        for ci in 0..nc {
            d0[19] = decode_card_from_slice(&CAND_CARDS_BUF, ci * CARD_STRIDE, CAND_BONUS_BUF[ci], 19);

            let mut tot = 0u32;
            let mut wins = 0u32;
            let mut draws = 0u32;
            let mut losses = 0u32;

            for o in 0..n_opps {
                let opp_mix = seed_base ^ ((o as u32 + 1).wrapping_mul(1_000_003));
                for idx in 0..gpo {
                    let first = if idx < half { 0 } else { 1 };
                    let seed_slot = (idx % half) as u32;
                    let seed = opp_mix ^ seed_slot.wrapping_mul(2654435761);
                    let (code, _, _) = simulate_i32_impl::<false>(
                        &d0,
                        &enemies[o],
                        &w_player,
                        &w_enemies[o],
                        seed,
                        first,
                        false,
                        &mut dummy,
                        &mut pts_dummy,
                    );
                    tot += 1;
                    match code {
                        1 => wins += 1,
                        2 => draws += 1,
                        _ => losses += 1,
                    }
                }
            }
            let out_o = ci * 4;
            OUT_U32[out_o] = tot;
            OUT_U32[out_o + 1] = wins;
            OUT_U32[out_o + 2] = draws;
            OUT_U32[out_o + 3] = losses;
        }
    }
    nc as u32
}
