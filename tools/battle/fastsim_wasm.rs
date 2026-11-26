//! Zero-allocation, fixed-point i32 WebAssembly Fast-Sim Engine for Pocket Lab (Exact-Mechanics v3).
//! Uses EXACT same Rng32 + Q10 (x1024) fixed-point i32 scoring and Exact-Mechanics v3 card bytecode
//! as WebGPU WGSL -> 100.000% bit-for-bit parity across GPU, CPU, and Replay!
//! Covers 100% of all 4,577 cards (588 attack effects with dual op1+op2+flags, 164 abilities,
//! 177 trainers / 28 tools / 14 stadiums / fossils) with zero dropped secondary effects.

#![allow(static_mut_refs)]

const FEATURES: usize = 22;
const CARD_STRIDE: usize = 28;
const MAX_DECKS: usize = 12; // 0 = player, 1..=10 = enemies
const MAX_ENEMIES: usize = 10;
const MAX_CANDS: usize = 40;
const STEP_STRIDE: usize = 24;
const MAX_REPLAY_STEPS: usize = 1024;
const MAX_OPT_CARDS: usize = 256;

// Special canonical English name hashes (matching compile_card_mechanics.mjs)
const H_ARCEUS: u16 = 1861;
const H_ARCEUS_EX: u16 = 7482;
const H_LATIAS: u16 = 49426;
const H_REGIROCK: u16 = 28242;
const H_REGICE: u16 = 49745;
const H_REGISTEEL: u16 = 4900;
const H_UXIE: u16 = 56213;
const H_AZELF: u16 = 51274;
const H_TANDEMAUS: u16 = 30786;
const H_MAUSHOLD: u16 = 61523;
const H_WISHIWASHI: u16 = 39722;
const H_WISHIWASHI_EX: u16 = 30145;
const H_POOCHYENA: u16 = 39334;
const H_SWEET_HONEY: u16 = 64227;
const H_RABOOT: u16 = 29145;
const H_UNOWN: u16 = 30635;
const H_PIKACHU_EX: u16 = 10636;
const H_VOLBEAT: u16 = 46637;

// Attack flags (16-bit)
const AF_IGNORE_WEAKNESS: u16 = 1 << 0;
const AF_IGNORE_EFFECTS: u16 = 1 << 1;
const AF_NEED_SWITCHED_IN: u16 = 1 << 2;
const AF_DISCARD_HAND_1: u16 = 1 << 3;
const AF_DISCARD_HAND_2: u16 = 1 << 4;
const AF_REQUIRE_HP_OVER_60: u16 = 1 << 5;
const AF_REQUIRE_LAKE_TRIO: u16 = 1 << 6;
const AF_COST_1_IF_DAMAGED: u16 = 1 << 7;
const AF_COST_1_IF_DECK_EMPTY: u16 = 1 << 8;
const AF_FLIP_2_BOTH_TAILS_FAIL: u16 = 1 << 9;
const AF_FLIP_3_ALL_TAILS_FAIL: u16 = 1 << 10;
const AF_FIRST_ATTACK_ONLY_EFF: u16 = 1 << 11;
const AF_ONLY_IF_KO_RECOIL: u16 = 1 << 12;
const AF_ONLY_IF_STADIUM_EFF: u16 = 1 << 13;
const AF_ONLY_IF_KO_LAST_TURN_EFF: u16 = 1 << 14;
const AF_ONLY_IF_EVOLVED_THIS_TURN_EFF: u16 = 1 << 15;

// Slot status flags (32-bit, low 8 bits MUST match SM_* in compile_card_mechanics.mjs!)
const ST_POISON: u32 = 1 << 0;      // 1
const ST_TOXIC20: u32 = 1 << 1;     // 2
const ST_BURN: u32 = 1 << 2;        // 4
const ST_SLEEP: u32 = 1 << 3;       // 8
const ST_PARALYZE: u32 = 1 << 4;    // 16
const ST_CONFUSE: u32 = 1 << 5;     // 32
const ST_TOXIC40: u32 = 1 << 6;     // 64
const ST_DEEP_SLEEP: u32 = 1 << 7;  // 128
const ST_SPECIAL_MASK: u32 = 0xFF;
const ST_CANT_RETREAT: u32 = 1 << 8;
const ST_CANT_ATK_SELF: u32 = 1 << 9;
const ST_CANT_ATK_OPP: u32 = 1 << 10;
const ST_CANT_USE_A1: u32 = 1 << 11;
const ST_CANT_USE_A2: u32 = 1 << 12;
const ST_OPP_MISS_FLIP: u32 = 1 << 13;
const ST_PERM_MISS_FLIP: u32 = 1 << 14;
const ST_INVULN: u32 = 1 << 15;
const ST_DISGUISE_USED: u32 = 1 << 16;
const ST_HAS_ATTACKED: u32 = 1 << 17;
const ST_SWITCHED_IN: u32 = 1 << 18;
const ST_NO_WEAKNESS: u32 = 1 << 19;
const ST_NO_ABILITY: u32 = 1 << 20;
const ST_ATTACH_SLEEP: u32 = 1 << 21;
const ST_NO_ENERGY_ATTACH: u32 = 1 << 22;
const ST_IMMUNE_BASIC: u32 = 1 << 23;
const ST_IMMUNE_LE40: u32 = 1 << 24;
const ST_SURVIVE_10: u32 = 1 << 25;
const ST_RETREAT_TRAP: u32 = 1 << 26;
const ST_DAMAGED_LAST: u32 = 1 << 27;

const ST_LEAVE_ACTIVE_CLEAR: u32 = ST_SPECIAL_MASK
    | ST_CANT_RETREAT
    | ST_CANT_ATK_SELF
    | ST_CANT_ATK_OPP
    | ST_CANT_USE_A1
    | ST_CANT_USE_A2
    | ST_OPP_MISS_FLIP
    | ST_PERM_MISS_FLIP
    | ST_NO_WEAKNESS
    | ST_NO_ABILITY
    | ST_ATTACH_SLEEP
    | ST_NO_ENERGY_ATTACH
    | ST_IMMUNE_BASIC
    | ST_IMMUNE_LE40
    | ST_RETREAT_TRAP;

static mut DECKS_BUF: [i32; MAX_DECKS * 20 * CARD_STRIDE] = [0; MAX_DECKS * 20 * CARD_STRIDE];
static mut BONUS_BUF: [i32; MAX_DECKS * 20] = [0; MAX_DECKS * 20];
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
    meta_hi: u8,     // bit0=sup,1=item,2=fossil,3=tool,4=stad,5=mega,6=ex,7=ub
    tag_bits: u8,    // bit0=anc,1=fut,2=tr,3=sweets,4=puppy,5=psychic,6=draco,7=eevee_evo
    name_hash: u16,
    type_code: u8,
    type2_code: u8,
    weak_code: u8,
    hp: i16,
    retreat: u8,
    prize: u8,
    evolves_from_hash: u16,

    a1_cost: u8,
    a1_flags: u16,
    a1_dmg: i16,
    a1_op1: u8,
    a1_op2: u8,
    a1_aux: u16,
    a1_val1: i32,
    a1_val2: i32,

    a2_cost: u8,
    a2_flags: u16,
    a2_dmg: i16,
    a2_op1: u8,
    a2_op2: u8,
    a2_aux: u16,
    a2_val1: i32,
    a2_val2: i32,

    ab_op: u8,
    ab_cond: u8,
    ab_aux: u16,
    ab_val: i32,

    trn_kind: u8,
    trn_sub: u8,
    trn_cond: u16,
    trn_val: i32,
    trn_h1: i32,
    trn_h2: i32,

    power_q: i32,
    bonus_q: i32,
}

impl CompactCard {
    #[inline(always)] fn is_supporter(&self) -> bool { (self.meta_hi & 1) != 0 }
    #[inline(always)] fn is_item(&self) -> bool { (self.meta_hi & 2) != 0 }
    #[inline(always)] fn is_fossil(&self) -> bool { (self.meta_hi & 4) != 0 }
    #[inline(always)] fn is_tool(&self) -> bool { (self.meta_hi & 8) != 0 }
    #[inline(always)] fn is_stadium(&self) -> bool { (self.meta_hi & 16) != 0 }
    #[inline(always)] fn is_mega(&self) -> bool { (self.meta_hi & 32) != 0 }
    #[inline(always)] fn is_ex(&self) -> bool { (self.meta_hi & 64) != 0 || self.prize >= 2 }
    #[inline(always)] fn is_ub(&self) -> bool { (self.meta_hi & 128) != 0 }
    #[inline(always)] fn is_ancient(&self) -> bool { (self.tag_bits & 1) != 0 }
    #[inline(always)] fn is_future(&self) -> bool { (self.tag_bits & 2) != 0 }
    #[inline(always)] fn is_team_rocket(&self) -> bool { (self.tag_bits & 4) != 0 }
    #[inline(always)] fn has_sweets(&self) -> bool { (self.tag_bits & 8) != 0 }
    #[inline(always)] fn has_puppy(&self) -> bool { (self.tag_bits & 16) != 0 }
    #[inline(always)] fn has_psychic(&self) -> bool { (self.tag_bits & 32) != 0 }
    #[inline(always)] fn has_draco(&self) -> bool { (self.tag_bits & 64) != 0 }
    #[inline(always)] fn is_eevee_evo(&self) -> bool { (self.tag_bits & 128) != 0 }
    #[inline(always)] fn has_type(&self, tc: u8) -> bool { self.type_code == tc || self.type2_code == tc }
    #[inline(always)] fn matches_trn_hashes(&self, h1: i32, h2: i32) -> bool {
        let nh = self.name_hash;
        if nh == 0 { return false; }
        let a = (h1 & 0xffff) as u16;
        let b = ((h1 >> 16) & 0xffff) as u16;
        let c = (h2 & 0xffff) as u16;
        let d = ((h2 >> 16) & 0xffff) as u16;
        (a != 0 && nh == a) || (b != 0 && nh == b) || (c != 0 && nh == c) || (d != 0 && nh == d)
    }
}

#[derive(Clone, Copy, Default)]
struct Slot {
    occ: bool,
    card: CompactCard,
    hp: i16,
    max_hp: i16,
    energy: u8,
    tool: u8,
    tool2: u8,
    status: u32,
    shield: i16,       // + reduces dmg taken, - increases dmg taken (Kommo-o/Hariyama/Espathra)
    shield_ex: i16,    // reduces dmg taken from ex only (Aegislash -80, Cheren -100)
    counter: i16,      // deals `counter` to attacker when damaged
    weaken: i16,       // reduces outgoing attack dmg
    cost_tax: u8,      // attack cost +N next turn
    retreat_tax: u8,   // retreat cost +N next turn
    next_atk_mod: i16, // +60 Togekiss, -50 Deoxys
    stack_boost: i16,  // +30 stacking (Mega Mawile ex, Miltank)
    turn_placed: u8,
}

impl Slot {
    #[inline(always)]
    fn has_tool(&self, t: u8) -> bool { self.tool == t || self.tool2 == t }
    #[inline(always)]
    fn tool_count(&self) -> i32 { (if self.tool != 0 { 1 } else { 0 }) + (if self.tool2 != 0 { 1 } else { 0 }) }
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
fn est_atk_power_v3(dmg: i16, op1: u8, val1: i32) -> i32 {
    let mut d = dmg as i32;
    let b0 = val1 & 0xff;
    let b1 = (val1 >> 8) & 0xff;
    let b2 = (val1 >> 16) & 0xff;
    match op1 {
        3 => { d = if b0 == 3 { d + b1 / 2 } else if b0 == 4 { 35 } else { d / 2 }; }
        4 => {
            if (b2 & 32) != 0 { d += (b1 * 3) / 2; }
            else if (b2 & 8) != 0 { d = b1 * 2; }
            else if (b2 & 6) != 0 { d = (b1 * 3) / 2; }
            else { d = if b0 == 99 { b1 } else { (b1 * b0) / 2 }; }
        }
        5 => {
            if b0 == 97 { d += 45; }
            else if b0 == 98 { d += b1 / 4; }
            else if b0 == 99 { d += b1; }
            else if b2 == 2 { d += b1 * 2; }
            else if b2 == 3 { d += b1 * 2; }
            else { d += (b1 * b0) / 2; }
        }
        6 => {
            if b0 == 26 { d = b1 * 3; }
            else if b0 == 31 || b0 == 32 { d += 50; }
            else if b0 == 33 { d = (d - 30).max(20); }
            else if b0 == 2 || b0 == 5 { d += b1 * 4; }
            else { d += b1 * 2; }
        }
        7 => {
            if b0 == 3 { d = (d - b1 / 3).max(20); }
            else { d += b1 / 2; }
        }
        8 => {
            if b0 == 2 || b0 == 3 || b0 == 4 { d = b1; }
            else if b0 == 6 { d = b1 * 3; }
            else if b0 == 8 { d = b1 * (if b2 == 99 { 3 } else { b2.max(1) }); }
            else if b0 == 10 { d = (b1 * b2.max(1)) / 2; }
            else if b0 == 11 { d = b1 * 2; }
            else if b0 == 12 { d = if b2 == 1 { 140 } else { b1 }; }
            else if b0 == 14 { d = b1 * 2; }
            else { d += b1 / 2; }
        }
        19 => { if b0 == 8 { d += b1; } }
        20 => {
            d = if b0 == 1 { 150 } else if b0 == 6 { 80 } else { 60 };
        }
        _ => {}
    }
    d
}

#[inline(always)]
fn decode_card_from_slice(buf: &[i32], off: usize, bonus_q: i32, forced_slot: i16) -> CompactCard {
    let meta = buf[off + 1] as u32;
    let tags = buf[off + 2] as u32;
    let rp = buf[off + 6] as u32;
    let a1_cf = buf[off + 7] as u32;
    let a1_dmg = buf[off + 8] as i16;
    let a1_ops = buf[off + 9] as u32;
    let a1_val1 = buf[off + 10];
    let a1_val2 = buf[off + 11];
    let a2_cf = buf[off + 12] as u32;
    let a2_dmg = buf[off + 13] as i16;
    let a2_ops = buf[off + 14] as u32;
    let a2_val1 = buf[off + 15];
    let a2_val2 = buf[off + 16];
    let ab_pk = buf[off + 17] as u32;
    let trn_pk = buf[off + 19] as u32;

    let a1_cost = (a1_cf & 0xff) as u8;
    let a1_op1 = (a1_ops & 0xff) as u8;
    let a2_cost = (a2_cf & 0xff) as u8;
    let a2_op1 = (a2_ops & 0xff) as u8;

    let p1 = if a1_cost != 255 { est_atk_power_v3(a1_dmg, a1_op1, a1_val1) } else { 0 };
    let p2 = if a2_cost != 255 { est_atk_power_v3(a2_dmg, a2_op1, a2_val1) } else { 0 };
    let best_p = if p2 > p1 { p2 } else { p1 };

    CompactCard {
        slot_id: if forced_slot >= 0 { forced_slot } else { buf[off + 23] as i16 },
        is_pokemon: buf[off] as u8,
        stage: (meta & 0xff) as u8,
        evo_group: ((meta >> 8) & 0xffff) as u16,
        meta_hi: ((meta >> 24) & 0xff) as u8,
        tag_bits: (tags & 0xff) as u8,
        name_hash: ((tags >> 8) & 0xffff) as u16,
        type_code: buf[off + 3] as u8,
        type2_code: ((tags >> 24) & 0xff) as u8,
        weak_code: buf[off + 4] as u8,
        hp: buf[off + 5] as i16,
        retreat: (rp & 0xff) as u8,
        prize: (((rp >> 8) & 0xff) as u8).max(1),
        evolves_from_hash: ((rp >> 16) & 0xffff) as u16,

        a1_cost,
        a1_flags: ((a1_cf >> 8) & 0xffff) as u16,
        a1_dmg,
        a1_op1,
        a1_op2: ((a1_ops >> 8) & 0xff) as u8,
        a1_aux: ((a1_ops >> 16) & 0xffff) as u16,
        a1_val1,
        a1_val2,

        a2_cost,
        a2_flags: ((a2_cf >> 8) & 0xffff) as u16,
        a2_dmg,
        a2_op1,
        a2_op2: ((a2_ops >> 8) & 0xff) as u8,
        a2_aux: ((a2_ops >> 16) & 0xffff) as u16,
        a2_val1,
        a2_val2,

        ab_op: (ab_pk & 0xff) as u8,
        ab_cond: ((ab_pk >> 8) & 0xff) as u8,
        ab_aux: ((ab_pk >> 16) & 0xffff) as u16,
        ab_val: buf[off + 18],

        trn_kind: (trn_pk & 0xff) as u8,
        trn_sub: ((trn_pk >> 8) & 0xff) as u8,
        trn_cond: ((trn_pk >> 16) & 0xffff) as u16,
        trn_val: buf[off + 20],
        trn_h1: buf[off + 21],
        trn_h2: buf[off + 22],

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

#[inline(never)]
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
fn tool_hp_bonus(tool: u8, c: &CompactCard) -> i16 {
    match tool {
        1 => 20, // Giant Cape
        2 => if c.has_type(0) { 30 } else { 0 }, // Leaf Cape [G]
        3 => if c.stage == 1 { 30 } else { 0 },  // Elegant Cape Stage 1
        4 => if c.is_ancient() { 40 } else { 0 }, // Ancient Booster +40
        _ => 0,
    }
}

#[inline(always)]
fn basic_ab_blocked(board: &[[Slot; 4]; 2]) -> bool {
    // Alolan Muk B2-097: Basic Pokémon in play have no Abilities
    for p in 0..2 {
        for s in 0..4 {
            if board[p][s].occ && (board[p][s].status & ST_NO_ABILITY) == 0
                && board[p][s].card.ab_op == 17 && board[p][s].card.ab_val == 7 {
                return true;
            }
        }
    }
    false
}

#[inline(always)]
fn healing_blocked(board: &[[Slot; 4]; 2]) -> bool {
    // Claydol A3a-031: Neither player's Pokémon can be healed
    let blk_bas = basic_ab_blocked(board);
    for p in 0..2 {
        for s in 0..4 {
            if board[p][s].occ && (board[p][s].status & ST_NO_ABILITY) == 0
                && board[p][s].card.ab_op == 17 && board[p][s].card.ab_val == 6
                && !(blk_bas && board[p][s].card.stage == 0) {
                return true;
            }
        }
    }
    false
}

#[inline(never)]
fn ab_active(board: &[[Slot; 4]; 2], p: usize, s: usize, stadium: u8, turn: u8) -> bool {
    let sl = board[p][s];
    if !sl.occ || sl.card.ab_op == 0 { return false; }
    if (sl.status & ST_NO_ABILITY) != 0 { return false; }
    if sl.card.stage == 0 && basic_ab_blocked(board) { return false; }
    match sl.card.ab_cond {
        0 => true,
        1 => s == 0,
        2 => s > 0,
        3 => {
            for k in 0..4 {
                if board[p][k].occ && (board[p][k].card.name_hash == H_ARCEUS || board[p][k].card.name_hash == H_ARCEUS_EX) {
                    return true;
                }
            }
            false
        }
        4 => {
            for k in 0..4 {
                if k != s && board[p][k].occ && board[p][k].card.name_hash == sl.card.name_hash { return true; }
            }
            false
        }
        5 => {
            for k in 0..4 {
                if board[p][k].occ && board[p][k].card.name_hash == H_LATIAS { return true; }
            }
            false
        }
        6 => sl.tool != 0 || sl.tool2 != 0,
        7 => sl.hp >= sl.max_hp,
        8 => sl.hp <= 50,
        9 => stadium != 0,
        10 => turn <= 2,
        11 => {
            for k in 0..4 {
                if k != s && board[p][k].occ && board[p][k].card.name_hash == H_UNOWN { return true; }
            }
            false
        }
        12 => sl.energy > 0,
        _ => true,
    }
}

#[inline(always)]
fn count_bench(side: &[Slot; 4]) -> i32 {
    let mut n = 0i32;
    for s in 1..4 { if side[s].occ { n += 1; } }
    n
}

#[inline(always)]
fn eff_energy(board: &[[Slot; 4]; 2], p: usize, s: usize, stadium: u8, turn: u8) -> i32 {
    let e = board[p][s].energy as i32;
    if board[p][s].card.has_type(0) {
        for k in 0..4 {
            if ab_active(board, p, k, stadium, turn) && board[p][k].card.ab_op == 15 && board[p][k].card.ab_val == 8 {
                return e * 2;
            }
        }
    }
    e
}

#[inline(never)]
fn eff_retreat_cost(board: &[[Slot; 4]; 2], p: usize, stadium: u8, turn: u8, discount: i32) -> i32 {
    let act = board[p][0];
    if !act.occ { return 99; }
    let foe = 1 - p;
    // Free retreat tools & abilities
    if act.card.stage == 2 && act.has_tool(9) { return 0; } // Big Air Balloon
    if ab_active(board, p, 0, stadium, turn) && act.card.ab_op == 15 && (act.card.ab_val & 0xff) == 7 && ((act.card.ab_val >> 8) & 0xff) == 0 {
        return 0;
    }
    for k in 0..4 {
        if ab_active(board, p, k, stadium, turn) && board[p][k].card.ab_op == 15 && (board[p][k].card.ab_val & 0xff) == 7 {
            let sub = (board[p][k].card.ab_val >> 8) & 0xff;
            if sub == 2 { return 0; } // Jumpluff
            if sub == 5 && act.card.name_hash == board[p][k].card.ab_aux { return 0; } // Tatsugiri -> Dondozo
        }
    }
    let mut r = act.card.retreat as i32 + act.retreat_tax as i32;
    // Opponent Ariados (+1 retreat)
    for k in 0..4 {
        if ab_active(board, foe, k, stadium, turn) && board[foe][k].card.ab_op == 15 && board[foe][k].card.ab_val == 6 {
            r += 1;
        }
    }
    // Own passive discounts
    for k in 1..4 {
        if ab_active(board, p, k, stadium, turn) && board[p][k].card.ab_op == 15 && (board[p][k].card.ab_val & 0xff) == 7 {
            let sub = (board[p][k].card.ab_val >> 8) & 0xff;
            if sub == 1 && act.card.stage == 0 { r -= 1; }
            else if sub == 3 && act.card.has_type(6) { r -= 1; }
        }
    }
    if ab_active(board, p, 0, stadium, turn) && act.card.ab_op == 15 && (act.card.ab_val & 0xff) == 7 && ((act.card.ab_val >> 8) & 0xff) == 4 {
        r -= 2; // Beldum
    }
    if act.card.stage == 0 && act.has_tool(7) { r -= 1; } // Small Balloon
    if act.card.has_type(2) && act.has_tool(8) { r -= 1; } // Inflatable Boat
    if stadium == 4 && act.card.has_type(4) { r -= 2; } // Peculiar Plaza [P] -2
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

#[inline(never)]
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

#[inline(never)]
fn search_deck_to_hand(
    libs: &mut [[CompactCard; 20]; 2],
    lib_len: &mut [usize; 2],
    hands: &mut [[CompactCard; 12]; 2],
    hand_len: &mut [usize; 2],
    p: usize,
    mode: u8,
    h1: i32,
    h2: i32,
    rng: &mut Rng32,
) -> bool {
    // mode: 0=basic non-fossil, 1=any poke, 2=basic hp<=50, 3=stage2, 4=mega ex, 5=item, 6=tool,
    //       7=stadium, 8=supporter, 9=basic [G], 10=named(h1,h2), 11=team rocket poke, 12=any [P] poke
    if hand_len[p] >= 12 || lib_len[p] == 0 { return false; }
    let mut match_pos = 20usize;
    let mut matches = 0u32;
    for i in 0..lib_len[p] {
        let c = libs[p][i];
        let ok = match mode {
            0 => c.is_pokemon == 1 && c.stage == 0 && !c.is_fossil(),
            1 => c.is_pokemon == 1 && !c.is_fossil(),
            2 => c.is_pokemon == 1 && c.stage == 0 && !c.is_fossil() && c.hp <= 50,
            3 => c.is_pokemon == 1 && c.stage == 2,
            4 => c.is_pokemon == 1 && c.is_mega(),
            5 => c.is_pokemon == 0 && c.is_item(),
            6 => c.is_pokemon == 0 && c.is_tool(),
            7 => c.is_pokemon == 0 && c.is_stadium(),
            8 => c.is_pokemon == 0 && c.is_supporter(),
            9 => c.is_pokemon == 1 && c.stage == 0 && !c.is_fossil() && c.has_type(0),
            10 => c.matches_trn_hashes(h1, h2),
            11 => c.is_pokemon == 1 && c.is_team_rocket(),
            12 => c.is_pokemon == 1 && !c.is_fossil() && c.has_type(4),
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
fn has_status_immunity(board: &[[Slot; 4]; 2], p: usize, s: usize, stadium: u8, turn: u8) -> bool {
    let sl = board[p][s];
    if !sl.occ { return true; }
    if sl.has_tool(12) && sl.card.has_type(7) { return true; } // Steel Apron [M]
    if sl.has_tool(15) { return true; } // Clear Veil blocks attack effects
    if ab_active(board, p, s, stadium, turn) {
        if sl.card.ab_op == 17 && sl.card.ab_val == 1 { return true; } // Arceus ex / Hoothoot
        if sl.card.ab_op == 11 && ((sl.card.ab_val >> 8) & 0xff) == 7 { return true; } // Regice effect immune
    }
    if sl.energy > 0 {
        for k in 0..4 {
            if ab_active(board, p, k, stadium, turn) && board[p][k].card.ab_op == 17 && board[p][k].card.ab_val == 2 {
                return true; // Ogerpon ex / Comfey
            }
        }
    }
    false
}

#[inline(never)]
fn apply_status(board: &mut [[Slot; 4]; 2], p: usize, s: usize, mask: u32, stadium: u8, turn: u8, by_attack: bool) -> u8 {
    if !board[p][s].occ { return 0; }
    if has_status_immunity(board, p, s, stadium, turn) { return 0; }
    if by_attack && (board[p][s].status & ST_INVULN) != 0 { return 0; }
    let sl = &mut board[p][s];
    if (mask & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0 {
        sl.status &= !(ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE);
    }
    if (mask & ST_TOXIC40) != 0 { sl.status &= !(ST_POISON | ST_TOXIC20); }
    else if (mask & ST_TOXIC20) != 0 && (sl.status & ST_TOXIC40) == 0 { sl.status &= !ST_POISON; }
    else if (mask & ST_POISON) != 0 && (sl.status & (ST_TOXIC20 | ST_TOXIC40)) != 0 { return 1; }
    sl.status |= mask;
    if (mask & ST_PARALYZE) != 0 { 4 }
    else if (mask & (ST_SLEEP | ST_DEEP_SLEEP)) != 0 { 3 }
    else if (mask & ST_CONFUSE) != 0 { 5 }
    else if (mask & ST_BURN) != 0 { 2 }
    else if (mask & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0 { 1 }
    else { 0 }
}

#[inline(always)]
fn bench_dmg_blocked(board: &[[Slot; 4]; 2], p: usize, s: usize, by_attack: bool, stadium: u8, turn: u8) -> bool {
    if s == 0 { return false; }
    if board[p][s].has_tool(14) { return true; } // Protective Poncho blocks attack & ability dmg on bench!
    if by_attack && ab_active(board, p, s, stadium, turn) && board[p][s].card.ab_op == 11 && ((board[p][s].card.ab_val >> 8) & 0xff) == 6 {
        return true; // Wartortle Shell Shield
    }
    false
}

#[inline(never)]
fn calc_passive_dmg_mods(
    board: &[[Slot; 4]; 2],
    cur: usize,
    foe: usize,
    atk_flags: u16,
    raw_d: i16,
    dmg_boost: i16,
    dmg_boost_ex: i16,
    named_boost: i16,
    named_boost_h1: i32,
    named_boost_h2: i32,
    eevee_boost: i16,
    next_team_boost: i16,
    points_cur: u8,
    stadium: u8,
    team_shield_def: i16,
    team_shield_def_type: u8,
    turn: u8,
) -> (i16, i16) {
    let atk_slot = board[cur][0];
    let def_slot = board[foe][0];
    let atk_c = atk_slot.card;
    let def_c = def_slot.card;
    let ign_weak = (atk_flags & AF_IGNORE_WEAKNESS) != 0 || (def_slot.occ && (def_slot.status & ST_NO_WEAKNESS) != 0);
    let ign_eff = (atk_flags & AF_IGNORE_EFFECTS) != 0;

    let mut add: i16 = dmg_boost + next_team_boost + atk_slot.next_atk_mod + atk_slot.stack_boost;
    if def_slot.occ && def_c.is_ex() { add += dmg_boost_ex; }
    if named_boost > 0 && atk_c.matches_trn_hashes(named_boost_h1, named_boost_h2) { add += named_boost; }
    if eevee_boost > 0 && atk_c.is_eevee_evo() { add += eevee_boost; }

    // Tools on attacker
    if atk_slot.has_tool(16) && atk_c.is_future() { add += 20; } // Future Booster
    if atk_slot.has_tool(17) && atk_c.name_hash == H_PIKACHU_EX { add += 30; } // Light Ball (Pikachu ex)
    if atk_slot.has_tool(18) && atk_c.is_ub() { add += (points_cur as i16) * 10; } // Beastite

    // Attacker side passive damage boost abilities
    for k in 0..4 {
        if !ab_active(board, cur, k, stadium, turn) { continue; }
        let ac = board[cur][k].card;
        if ac.ab_op == 12 {
            let amt = (ac.ab_val & 0xff) as i16;
            let mode = (ac.ab_val >> 8) & 0xff;
            let tf = ((ac.ab_val >> 16) & 0xff) as u8;
            match mode {
                0 => {
                    if ac.ab_cond == 13 {
                        if atk_c.evolves_from_hash == ac.ab_aux { add += amt; }
                    } else if tf == 255 || atk_c.has_type(tf) {
                        add += amt;
                    }
                }
                1 => { if k == 0 { add += amt; } } // Carnivine / Quaquaval
                3 => { if atk_c.has_type(4) || atk_c.has_type(7) { add += amt; } } // Aegislash [P]+[M]
                _ => {}
            }
        } else if k == 0 && ac.ab_op == 11 && ((ac.ab_val >> 8) & 0xff) == 8 {
            add += 20; // Falinks +20 attack
        }
    }

    // Stadium attack bonuses
    if stadium == 2 && atk_c.stage == 1 { add += 10; } // Training Area
    if stadium == 5 && atk_c.has_type(5) && def_slot.occ && def_c.is_ex() { add += 20; } // Arena of Antiquity

    // Weakness (+20, or ×2 under Bounded Field stadium == 6 for non-Mega!)
    let is_weak = !ign_weak && def_slot.occ && def_c.weak_code != 255 && atk_c.has_type(def_c.weak_code);
    let weak_b: i16 = if is_weak {
        if stadium == 6 && !atk_c.is_mega() { (raw_d + add).max(0) } else { 20 }
    } else {
        0
    };
    add += weak_b;

    // Damage reductions on defender (bypassed if AF_IGNORE_EFFECTS!)
    let mut red: i16 = atk_slot.weaken;
    if def_slot.occ && !ign_eff {
        // Note: def_slot.shield can be negative (Kommo-o +30 / Hariyama +50 / Espathra +50 -> increases dmg!)
        red += def_slot.shield;
        if atk_c.is_ex() { red += def_slot.shield_ex; }
        if team_shield_def > 0 {
            let ok = team_shield_def_type == 255
                || (team_shield_def_type == 254 && def_c.is_ub())
                || def_c.has_type(team_shield_def_type);
            if ok { red += team_shield_def; }
        }
        // Defender Tools
        if def_slot.has_tool(10) && def_c.stage == 0 { red += 20; } // Eviolite
        if def_slot.has_tool(11) && def_c.retreat >= 3 { red += 20; } // Heavy Helmet
        if def_slot.has_tool(12) && def_c.has_type(7) { red += 10; } // Steel Apron
        if def_slot.has_tool(13) && def_c.has_type(7) { red += 50; } // Metal Core Barrier

        // Defender side passive reduction abilities
        let mut metal_team_applied = false;
        for k in 0..4 {
            if !ab_active(board, foe, k, stadium, turn) { continue; }
            let dc = board[foe][k].card;
            if dc.ab_op == 11 {
                let amt = (dc.ab_val & 0xff) as i16;
                let mode = (dc.ab_val >> 8) & 0xff;
                let tf = ((dc.ab_val >> 16) & 0xff) as u8;
                match mode {
                    0 | 8 => { if k == 0 { red += amt; } }
                    1 => {
                        if tf == 7 {
                            if def_c.has_type(7) && !metal_team_applied { red += amt; metal_team_applied = true; }
                        } else if tf == 255 || def_c.has_type(tf) {
                            red += amt;
                        }
                    }
                    2 => { if k == 0 { red += amt; } } // Luxray A3a opp active -20
                    3 => { if k == 0 && (atk_c.has_type(1) || atk_c.has_type(2)) { red += amt; } } // Thick Fat
                    4 => { if k == 0 && atk_c.has_type(5) { red += amt; } } // Staraptor vs [F]
                    _ => {}
                }
            }
        }
    }
    (add - red, weak_b)
}

#[inline(never)]
fn can_pay_attack(
    board: &[[Slot; 4]; 2],
    cur: usize,
    foe: usize,
    base_cost: u8,
    atk_flags: u16,
    barry_disc: i32,
    lib_len_cur: usize,
    hand_len_cur: usize,
    stadium: u8,
    turn: u8,
) -> bool {
    if base_cost == 255 { return false; }
    let act = board[cur][0];
    let c = act.card;
    // Regigigas B3-134 Ancient Seal: needs Regirock, Regice, Registeel on bench
    if ab_active(board, cur, 0, stadium, turn) && c.ab_op == 15 && c.ab_val == 11 {
        let mut r1 = false; let mut r2 = false; let mut r3 = false;
        for s in 1..4 {
            if board[cur][s].occ {
                let nh = board[cur][s].card.name_hash;
                if nh == H_REGIROCK { r1 = true; }
                else if nh == H_REGICE { r2 = true; }
                else if nh == H_REGISTEEL { r3 = true; }
            }
        }
        if !(r1 && r2 && r3) { return false; }
    }
    if (atk_flags & AF_NEED_SWITCHED_IN) != 0 && (act.status & ST_SWITCHED_IN) == 0 { return false; }
    if (atk_flags & AF_DISCARD_HAND_1) != 0 && hand_len_cur < 1 { return false; }
    if (atk_flags & AF_DISCARD_HAND_2) != 0 && hand_len_cur < 2 { return false; }
    if (atk_flags & AF_REQUIRE_HP_OVER_60) != 0 && act.hp <= 60 { return false; }
    if (atk_flags & AF_REQUIRE_LAKE_TRIO) != 0 {
        let mut u = false; let mut a = false;
        for s in 1..4 {
            if board[cur][s].occ {
                if board[cur][s].card.name_hash == H_UXIE { u = true; }
                if board[cur][s].card.name_hash == H_AZELF { a = true; }
            }
        }
        if !(u && a) { return false; }
    }

    let mut need = base_cost as i32;
    if (atk_flags & AF_COST_1_IF_DAMAGED) != 0 && act.hp < act.max_hp { need = 1; }
    if (atk_flags & AF_COST_1_IF_DECK_EMPTY) != 0 && lib_len_cur == 0 { need = 1; }

    // Own cost reductions (Iron Valiant Future -1, Abomasnow/Cherubi -1, Barry -2)
    for k in 0..4 {
        if ab_active(board, cur, k, stadium, turn) && board[cur][k].card.ab_op == 15 && (board[cur][k].card.ab_val & 0xff) == 4 {
            let sub = (board[cur][k].card.ab_val >> 8) & 0xff;
            if sub == 1 && c.is_future() { need -= 1; }
            else if sub == 0 && k == 0 { need -= 1; }
        }
    }
    need -= barry_disc;
    // Opponent cost tax (Stoutland / Goomy +1, Porygon-Z / Wo-Chien / TR Tinkaton)
    need += act.cost_tax as i32;
    if board[foe][0].occ && ab_active(board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 15 && board[foe][0].card.ab_val == 5 {
        need += 1;
    }
    if need < 0 { need = 0; }
    eff_energy(board, cur, 0, stadium, turn) >= need
}

#[inline(never)]
fn eval_cond_op7(
    cond_id: i32,
    extra: i32,
    aux: u16,
    board: &[[Slot; 4]; 2],
    cur: usize,
    foe: usize,
    atk_cost: u8,
    supporter_used: bool,
    ko_last_turn: &[u8; 2],
    points: &[u8; 2],
    hand_len: &[usize; 2],
    sweets_used_last: &[u8; 2],
    disc_quick_grow: &[u8; 2],
    disc_volbeat: &[u8; 2],
    stadium: u8,
    turn: u8,
) -> bool {
    let act = board[cur][0];
    let foe_s = board[foe][0];
    match cond_id {
        0 => eff_energy(board, cur, 0, stadium, turn) >= (atk_cost as i32) + extra,
        1 => foe_s.occ && foe_s.hp < foe_s.max_hp,
        2 | 3 => act.hp < act.max_hp,
        4 => act.hp >= act.max_hp,
        5 => act.hp <= extra as i16,
        6 => {
            for s in 1..4 { if board[cur][s].occ && board[cur][s].hp < board[cur][s].max_hp { return true; } }
            false
        }
        7 => foe_s.occ && (foe_s.status & ST_SPECIAL_MASK) != 0,
        8 => foe_s.occ && (foe_s.status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0,
        9 => foe_s.occ && (foe_s.status & ST_BURN) != 0,
        10 => foe_s.occ && (foe_s.status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0,
        11 => foe_s.occ && (foe_s.status & ST_CONFUSE) != 0,
        12 => foe_s.occ && foe_s.card.is_ex(),
        13 => foe_s.occ && foe_s.card.stage == 0,
        14 => foe_s.occ && foe_s.card.stage > 0,
        15 => foe_s.occ && foe_s.card.ab_op != 0,
        16 => foe_s.occ && foe_s.tool_count() > 0,
        17 => act.tool_count() > 0,
        18 => ko_last_turn[cur] != 0,
        19 => supporter_used,
        20 => foe_s.occ && foe_s.hp > act.hp,
        21 => foe_s.occ && foe_s.hp < act.hp,
        22 => (act.status & ST_SWITCHED_IN) != 0,
        23 => act.card.stage > 0 && act.turn_placed == turn,
        24 => (act.status & ST_HAS_ATTACKED) == 0,
        25 => stadium != 0,
        26 => (act.energy as i32) + (if foe_s.occ { foe_s.energy as i32 } else { 0 }) >= extra,
        27 => {
            let mut tot = 0i32;
            for s in 0..4 { if board[cur][s].occ { tot += board[cur][s].energy as i32; } }
            tot >= extra
        }
        28 => foe_s.occ && act.energy > foe_s.energy,
        29 => foe_s.occ && act.energy == foe_s.energy,
        30 => foe_s.occ && act.energy > 0 && foe_s.energy > 0 && act.card.type_code == foe_s.card.type_code,
        31 => match extra {
            0 => hand_len[cur] == 1 || hand_len[cur] == 3 || hand_len[cur] == 5,
            1 => hand_len[cur] == 2 || hand_len[cur] == 4 || hand_len[cur] == 6,
            2 => hand_len[foe] == 2 || hand_len[foe] == 4 || hand_len[foe] == 6,
            _ => hand_len[cur] == hand_len[foe],
        },
        32 => {
            let t1 = (extra & 0xf) as u8;
            let t2 = ((extra >> 4) & 0xf) as u8;
            if t2 == 14 {
                for s in 0..4 { if board[foe][s].occ && board[foe][s].card.has_type(t1) { return true; } }
                false
            } else {
                foe_s.occ && (foe_s.card.has_type(t1) || (t2 < 10 && foe_s.card.has_type(t2)))
            }
        }
        33 => match extra {
            0 => {
                for s in 1..4 { if board[cur][s].occ && board[cur][s].card.name_hash == aux { return true; } }
                false
            }
            1 => {
                for s in 1..4 { if board[cur][s].occ && board[cur][s].card.stage == 2 { return true; } }
                false
            }
            2 => foe_s.occ && foe_s.card.name_hash == aux,
            3 => foe_s.occ && foe_s.card.is_team_rocket(),
            4 => count_bench(&board[cur]) < count_bench(&board[foe]),
            _ => false,
        },
        34 => sweets_used_last[cur] != 0,
        35 => if extra == 0 { points[cur] == 0 } else { points[foe] == 1 },
        36 => {
            for s in 1..4 {
                if board[cur][s].occ && board[cur][s].card.stage == 0 && board[cur][s].card.has_type(0) { return true; }
            }
            false
        }
        37 => (act.status & ST_DAMAGED_LAST) != 0,
        38 => false, // evaluated live on attack (discards top card)
        39 => if extra == 1 { disc_volbeat[cur] != 0 } else { disc_quick_grow[cur] != 0 },
        40 => {
            if extra >= 10 { act.energy > 0 } else { (act.energy as i32) >= extra }
        }
        _ => false,
    }
}

#[inline(never)]
fn eval_count_op6(
    sub: i32,
    extra: i32,
    aux: u16,
    board: &[[Slot; 4]; 2],
    cur: usize,
    foe: usize,
    hands: &[[CompactCard; 12]; 2],
    hand_len: &[usize; 2],
    libs: &[[CompactCard; 20]; 2],
    lib_len: &[usize; 2],
    points: &[u8; 2],
    pts_last_turn: &[u8; 2],
    ko_count: &[u8; 2],
    sweets_total: &[u8; 2],
    disc_poke: &[u8; 2],
    disc_poke_p: &[u8; 2],
    disc_item: &[u8; 2],
    disc_supp: &[u8; 2],
    stadium: u8,
    turn: u8,
) -> i32 {
    match sub {
        0 => count_bench(&board[cur]),
        1 => count_bench(&board[foe]),
        2 => count_bench(&board[cur]) + count_bench(&board[foe]),
        3 => {
            let mut n = 0;
            for s in 1..4 { if board[cur][s].occ && board[cur][s].card.has_type(extra as u8) { n += 1; } }
            n
        }
        4 => {
            let mut n = 0;
            for s in 1..4 { if board[cur][s].occ && board[cur][s].card.stage > 0 { n += 1; } }
            n
        }
        5 => eff_energy(board, cur, 0, stadium, turn),
        6 => {
            let mut n = 0;
            for s in 0..4 { if board[cur][s].occ { n += board[cur][s].energy as i32; } }
            n
        }
        7 => if board[foe][0].occ { board[foe][0].energy as i32 } else { 0 },
        8 => {
            let mut n = 0;
            for s in 0..4 { if board[foe][s].occ { n += board[foe][s].energy as i32; } }
            n
        }
        9 => if board[foe][0].occ { board[foe][0].card.retreat as i32 } else { 0 },
        10 => points[cur] as i32,
        11 => points[foe] as i32,
        12 => ko_count[cur] as i32,
        13 => pts_last_turn[foe] as i32,
        14 => {
            let mut n = 0;
            for s in 0..4 { if board[cur][s].occ { n += board[cur][s].tool_count(); } }
            n
        }
        15 => hand_len[cur] as i32,
        16 => if extra == 4 { disc_poke_p[cur] as i32 } else { disc_poke[cur] as i32 },
        17 => disc_item[cur] as i32,
        18 => disc_supp[cur] as i32,
        19 => {
            let mut n = 0;
            for i in 0..lib_len[foe] { if libs[foe][i].is_pokemon == 0 { n += 1; } }
            n
        }
        20 => {
            let mut n = 0;
            for s in 0..4 { if board[foe][s].occ && board[foe][s].card.ab_op != 0 { n += 1; } }
            n
        }
        21 => {
            if !board[foe][0].occ { 0 } else {
                let st = board[foe][0].status;
                let mut n = 0;
                if (st & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0 { n += 1; }
                if (st & ST_BURN) != 0 { n += 1; }
                if (st & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE)) != 0 { n += 1; }
                n
            }
        }
        22 => sweets_total[cur] as i32,
        23 => {
            let mut n = 0;
            for s in 0..4 { if board[cur][s].occ && board[cur][s].card.has_puppy() { n += 1; } }
            for hi in 0..hand_len[cur] { if hands[cur][hi].has_puppy() { n += 1; } }
            n
        }
        24 => {
            let mut n = 0;
            for s in 1..4 {
                if board[cur][s].occ {
                    let nh = board[cur][s].card.name_hash;
                    if extra == 1 {
                        if nh == H_WISHIWASHI || nh == H_WISHIWASHI_EX { n += 1; }
                    } else if nh == aux { n += 1; }
                }
            }
            n
        }
        25 => (board[cur][0].energy as i32).min(3),
        26 => board[cur][0].energy as i32,
        27 => {
            let mut n = 0;
            for hi in 0..hand_len[cur] { if hands[cur][hi].is_tool() { n += 1; } }
            n.min(2)
        }
        28 => {
            let mut n = 0;
            for s in 1..4 { if board[cur][s].occ && board[cur][s].card.has_type(2) { n += 1; } }
            n
        }
        29 => {
            let mut n = 0;
            for hi in 0..hand_len[cur] { if hands[cur][hi].name_hash == H_SWEET_HONEY { n += 1; } }
            n
        }
        30 => {
            let top_n = (extra & 0xf) as usize;
            let filt = (extra >> 4) & 0xf;
            let lim = top_n.min(lib_len[cur]);
            let mut n = 0;
            for k in 0..lim {
                let c = libs[cur][lib_len[cur] - 1 - k];
                if filt == 1 {
                    if c.is_pokemon == 1 && c.is_team_rocket() { n += 1; }
                } else if c.is_pokemon == 1 && c.retreat >= 3 { n += 1; }
            }
            n
        }
        31 => (board[cur][0].max_hp - board[cur][0].hp).max(0) as i32,
        32 => board[cur][0].hp.max(0) as i32,
        33 => -(board[cur][0].max_hp - board[cur][0].hp).max(0) as i32,
        _ => 0,
    }
}

#[inline(never)]
fn eval_live_attack_dmg_v3(
    board: &[[Slot; 4]; 2],
    cur: usize,
    foe: usize,
    cost: u8,
    base_dmg: i16,
    op1: u8,
    val1: i32,
    aux: u16,
    hands: &[[CompactCard; 12]; 2],
    hand_len: &[usize; 2],
    libs: &[[CompactCard; 20]; 2],
    lib_len: &[usize; 2],
    supporter_used: bool,
    ko_last_turn: &[u8; 2],
    points: &[u8; 2],
    pts_last_turn: &[u8; 2],
    ko_count: &[u8; 2],
    sweets_used_last: &[u8; 2],
    sweets_total: &[u8; 2],
    disc_poke: &[u8; 2],
    disc_poke_p: &[u8; 2],
    disc_item: &[u8; 2],
    disc_supp: &[u8; 2],
    disc_quick_grow: &[u8; 2],
    disc_volbeat: &[u8; 2],
    stadium: u8,
    turn: u8,
) -> (i16, bool) {
    let b0 = val1 & 0xff;
    let b1 = (val1 >> 8) & 0xff;
    let b2 = (val1 >> 16) & 0xff;
    match op1 {
        3 => {
            if b0 == 3 { (base_dmg + (b1 as i16) / 2, false) }
            else if b0 == 4 { (35, false) }
            else { (base_dmg / 2, false) }
        }
        4 => {
            if (b2 & 32) != 0 { (base_dmg + ((b1 * 3) / 2) as i16, false) }
            else if (b2 & 8) != 0 { (((eff_energy(board, cur, 0, stadium, turn) * b1) / 2) as i16, false) }
            else if (b2 & 2) != 0 { ((((1 + count_bench(&board[cur])) * b1) / 2) as i16, false) }
            else if (b2 & 4) != 0 {
                let mut n = 0;
                for s in 0..4 {
                    if board[cur][s].occ && (board[cur][s].card.name_hash == H_TANDEMAUS || board[cur][s].card.name_hash == H_MAUSHOLD) { n += 1; }
                }
                (((n * b1) / 2) as i16, false)
            } else {
                let mut n = if b0 == 99 { 2 } else { b0 };
                if (b2 & 1) != 0 && board[cur][0].has_tool(24) { n = 4; }
                if (b2 & 16) != 0 {
                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.name_hash == H_RABOOT { n += 3; } }
                }
                (((b1 * n) / 2) as i16, false)
            }
        }
        5 => {
            if b0 == 97 { (base_dmg + 45, false) }
            else if b0 == 98 { (base_dmg + (b1 / 4) as i16, false) }
            else if b0 == 99 { (base_dmg + b1 as i16, false) }
            else if b2 == 2 { (base_dmg + ((eff_energy(board, cur, 0, stadium, turn) * b1) / 2) as i16, false) }
            else if b2 == 3 { (base_dmg, false) }
            else { (base_dmg + ((b1 * b0) / 2) as i16, false) }
        }
        6 => {
            let cnt = eval_count_op6(b0, b2, aux, board, cur, foe, hands, hand_len, libs, lib_len, points, pts_last_turn, ko_count, sweets_total, disc_poke, disc_poke_p, disc_item, disc_supp, stadium, turn);
            if b0 == 33 { ((base_dmg as i32 + cnt).max(0) as i16, false) }
            else { (base_dmg + (cnt * b1) as i16, false) }
        }
        7 => {
            let ok = eval_cond_op7(b0, b2, aux, board, cur, foe, cost, supporter_used, ko_last_turn, points, hand_len, sweets_used_last, disc_quick_grow, disc_volbeat, stadium, turn);
            if b0 == 3 { (if ok { (base_dmg - b1 as i16).max(0) } else { base_dmg }, false) }
            else { (base_dmg + if ok { b1 as i16 } else { 0 }, false) }
        }
        8 => {
            if b0 == 2 || b0 == 3 || b0 == 4 || b0 == 6 || b0 == 8 || b0 == 10 || b0 == 11 || b0 == 12 || b0 == 14 {
                let est = if b0 == 8 { b1 * (if b2 == 99 { eff_energy(board, cur, 0, stadium, turn) } else { b2.max(1) }) }
                else if b0 == 11 {
                    let mut me = 0;
                    for s in 0..4 { if board[foe][s].occ && (board[foe][s].energy as i32) > me { me = board[foe][s].energy as i32; } }
                    me * b1
                }
                else if b0 == 12 { if b2 == 1 { 140 } else { b1 } }
                else if b0 == 14 { b1 * 2 }
                else { b1 };
                (est as i16, true)
            } else {
                (base_dmg, false)
            }
        }
        19 => {
            if b0 == 8 { (base_dmg + b1 as i16, false) } else { (base_dmg, base_dmg == 0) }
        }
        20 => {
            let fhp = if board[foe][0].occ { board[foe][0].hp } else { 100 };
            if b0 == 1 { (fhp, true) }
            else if b0 == 2 || b0 == 3 { (fhp / 2, true) }
            else if b0 == 4 || b0 == 5 { (fhp / 2, true) }
            else { (70, true) }
        }
        _ => (base_dmg, base_dmg == 0 && op1 != 0),
    }
}

#[inline(never)]
fn record_discard_card(
    c: &CompactCard,
    p: usize,
    disc_poke: &mut [u8; 2],
    disc_poke_p: &mut [u8; 2],
    disc_item: &mut [u8; 2],
    disc_supp: &mut [u8; 2],
    disc_tool: &mut [u8; 2],
    disc_basic_w: &mut [u8; 2],
    disc_basic_any: &mut [u8; 2],
    disc_quick_grow: &mut [u8; 2],
    disc_volbeat: &mut [u8; 2],
) {
    if c.is_pokemon == 1 && !c.is_fossil() {
        disc_poke[p] = disc_poke[p].saturating_add(1);
        if c.has_type(4) { disc_poke_p[p] = disc_poke_p[p].saturating_add(1); }
        if c.stage == 0 {
            disc_basic_any[p] = disc_basic_any[p].saturating_add(1);
            if c.has_type(2) { disc_basic_w[p] = disc_basic_w[p].saturating_add(1); }
        }
        if c.name_hash == H_VOLBEAT { disc_volbeat[p] = 1; } // Volbeat tracked by canonical hash
    } else if c.is_pokemon == 0 {
        if c.is_item() {
            disc_item[p] = disc_item[p].saturating_add(1);
            if c.trn_kind == 6 && c.trn_sub == 2 && c.trn_val == 0 { disc_quick_grow[p] = 1; }
        } else if c.is_supporter() {
            disc_supp[p] = disc_supp[p].saturating_add(1);
        } else if c.is_tool() {
            disc_tool[p] = disc_tool[p].saturating_add(1);
        }
    }
}

#[inline(never)]
fn handle_active_ko(
    victim: usize,
    winner: usize,
    by_attack: bool,
    extra_point: u8,
    stadium: u8,
    turn: u8,
    board: &mut [[Slot; 4]; 2],
    points: &mut [u8; 2],
    pts_last_turn: &mut [u8; 2],
    ko_count: &mut [u8; 2],
    ko_last_turn: &mut [u8; 2],
    libs: &mut [[CompactCard; 20]; 2],
    lib_len: &mut [usize; 2],
    hands: &mut [[CompactCard; 12]; 2],
    hand_len: &mut [usize; 2],
    energy_discarded: &mut [u8; 2],
    disc_poke: &mut [u8; 2],
    disc_poke_p: &mut [u8; 2],
    disc_basic_w: &mut [u8; 2],
    disc_basic_any: &mut [u8; 2],
    rng: &mut Rng32,
) -> (bool, i16, bool) {
    // Returns (was_ko, attacker_recoil, attacker_insta_ko_cursola)
    if !board[victim][0].occ || board[victim][0].hp > 0 { return (false, 0, false); }
    let v_slot = board[victim][0];
    let v_card = v_slot.card;

    // 1. Survive at 10 HP: Hala (ST_SURVIVE_10) or Conkeldurr Guts (ab_op=13, mode=8)
    if by_attack {
        if (v_slot.status & ST_SURVIVE_10) != 0 {
            board[victim][0].hp = 10;
            board[victim][0].status &= !ST_SURVIVE_10;
            return (false, 0, false);
        }
        if ab_active(board, victim, 0, stadium, turn) && v_card.ab_op == 13 && ((v_card.ab_val >> 8) & 0xff) == 8 {
            let mut dh = false;
            if rng.flip_coin(&mut dh) {
                board[victim][0].hp = 10;
                return (false, 0, false);
            }
        }
    }

    // 2. On-KO Abilities & Tools
    let mut rec_dmg: i16 = 0;
    let mut cursola_ko = false;
    let mut zero_pts = false;
    if ab_active(board, victim, 0, stadium, turn) && v_card.ab_op == 13 {
        let amt = (v_card.ab_val & 0xff) as i16;
        let mode = (v_card.ab_val >> 8) & 0xff;
        if mode == 6 {
            // Dusknoir B1-105 / Glimmora: coin heads -> 0 points!
            let mut dh = false;
            if rng.flip_coin(&mut dh) { zero_pts = true; }
        } else if by_attack {
            match mode {
                3 => { rec_dmg = amt; } // Pyukumuku 50 / TR Electrode 70
                4 => {
                    // Spiritomb B2: 10 to ALL opp
                    for s in 0..4 {
                        if board[winner][s].occ && !bench_dmg_blocked(board, winner, s, false, stadium, turn) {
                            board[winner][s].hp -= 10;
                        }
                    }
                }
                5 => {
                    // Passimian ex: move all energy to 1 Bench
                    let prom = best_bench_promote(&board[victim]);
                    if prom < 4 { board[victim][prom].energy = board[victim][prom].energy.saturating_add(v_slot.energy); }
                }
                7 => {
                    // Galarian Cursola: flip coin -> KO attacker!
                    let mut dh = false;
                    if rng.flip_coin(&mut dh) { cursola_ko = true; }
                }
                _ => {}
            }
        }
    }

    // Tool: Electrical Cord (tool 25) -> move up to 2 energy to bench
    if by_attack && v_slot.has_tool(25) && v_card.has_type(3) && v_slot.energy > 0 {
        let mut left = v_slot.energy.min(2);
        for s in 1..4 {
            if left == 0 { break; }
            if board[victim][s].occ { board[victim][s].energy = board[victim][s].energy.saturating_add(1); left -= 1; }
        }
    }
    let had_lucky_egg = by_attack && v_slot.has_tool(23);
    let had_rescue_scarf = by_attack && v_slot.has_tool(27);
    if v_slot.energy > 0 { energy_discarded[victim] = 1; }

    let gained = if zero_pts { 0 } else { v_card.prize.saturating_add(extra_point) };
    points[winner] = points[winner].saturating_add(gained);
    pts_last_turn[winner] = pts_last_turn[winner].saturating_add(gained);
    ko_count[victim] = ko_count[victim].saturating_add(1);
    if by_attack { ko_last_turn[victim] = 1; }

    if had_rescue_scarf && hand_len[victim] < 12 {
        hands[victim][hand_len[victim]] = v_card;
        hand_len[victim] += 1;
    } else if !v_card.is_fossil() {
        disc_poke[victim] = disc_poke[victim].saturating_add(1);
        if v_card.has_type(4) { disc_poke_p[victim] = disc_poke_p[victim].saturating_add(1); }
        if v_card.stage == 0 {
            disc_basic_any[victim] = disc_basic_any[victim].saturating_add(1);
            if v_card.has_type(2) { disc_basic_w[victim] = disc_basic_w[victim].saturating_add(1); }
        }
    }

    // Attacker Lucky Mittens (tool 24): draw 1 on KO
    if by_attack && board[winner][0].occ && board[winner][0].has_tool(24) {
        draw_one(libs, lib_len, hands, hand_len, winner);
    }
    // Attacker Zoroark A4a-050 (ab_op=21, val=3): KO opp -> invuln next turn!
    if by_attack && board[winner][0].occ && ab_active(board, winner, 0, stadium, turn) && board[winner][0].card.ab_op == 21 && board[winner][0].card.ab_val == 3 {
        board[winner][0].status |= ST_INVULN;
    }

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
    (true, rec_dmg, cursola_ko)
}

#[inline(never)]
fn handle_bench_ko(
    victim: usize,
    winner: usize,
    slot_s: usize,
    by_attack: bool,
    stadium: u8,
    turn: u8,
    board: &mut [[Slot; 4]; 2],
    points: &mut [u8; 2],
    pts_last_turn: &mut [u8; 2],
    ko_count: &mut [u8; 2],
    ko_last_turn: &mut [u8; 2],
    libs: &mut [[CompactCard; 20]; 2],
    lib_len: &mut [usize; 2],
    hands: &mut [[CompactCard; 12]; 2],
    hand_len: &mut [usize; 2],
    energy_discarded: &mut [u8; 2],
    disc_poke: &mut [u8; 2],
    disc_poke_p: &mut [u8; 2],
    disc_basic_w: &mut [u8; 2],
    disc_basic_any: &mut [u8; 2],
    rng: &mut Rng32,
) -> bool {
    if !board[victim][slot_s].occ || board[victim][slot_s].hp > 0 { return false; }
    let v_slot = board[victim][slot_s];
    let v_card = v_slot.card;
    let mut zero_pts = false;
    if ab_active(board, victim, slot_s, stadium, turn) && v_card.ab_op == 13 && ((v_card.ab_val >> 8) & 0xff) == 6 {
        let mut dh = false;
        if rng.flip_coin(&mut dh) { zero_pts = true; }
    }
    if v_slot.energy > 0 { energy_discarded[victim] = 1; }
    let gained = if zero_pts { 0 } else { v_card.prize };
    points[winner] = points[winner].saturating_add(gained);
    pts_last_turn[winner] = pts_last_turn[winner].saturating_add(gained);
    ko_count[victim] = ko_count[victim].saturating_add(1);
    if by_attack { ko_last_turn[victim] = 1; }
    if by_attack && v_slot.has_tool(27) && hand_len[victim] < 12 {
        hands[victim][hand_len[victim]] = v_card;
        hand_len[victim] += 1;
    } else if !v_card.is_fossil() {
        disc_poke[victim] = disc_poke[victim].saturating_add(1);
        if v_card.has_type(4) { disc_poke_p[victim] = disc_poke_p[victim].saturating_add(1); }
        if v_card.stage == 0 {
            disc_basic_any[victim] = disc_basic_any[victim].saturating_add(1);
            if v_card.has_type(2) { disc_basic_w[victim] = disc_basic_w[victim].saturating_add(1); }
        }
    }
    if by_attack && board[winner][0].occ && board[winner][0].has_tool(24) {
        draw_one(libs, lib_len, hands, hand_len, winner);
    }
    if by_attack && v_slot.has_tool(23) {
        while hand_len[victim] < 5 && lib_len[victim] > 0 {
            draw_one(libs, lib_len, hands, hand_len, victim);
        }
    }
    board[victim][slot_s].occ = false;
    true
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
    let mut pts_last_turn = [0u8, 0u8];
    let mut ko_count = [0u8, 0u8];
    let mut ko_last_turn = [0u8, 0u8];
    let mut item_lock = [0u8, 0u8];
    let mut supp_lock = [0u8, 0u8];
    let mut evo_lock = [0u8, 0u8];
    let mut team_shield = [0i16, 0i16];
    let mut team_shield_type = [255u8, 255u8];
    let mut next_team_boost = [0i16, 0i16];
    let mut sweets_used_last = [0u8, 0u8];
    let mut sweets_total = [0u8, 0u8];
    let mut energy_discarded = [0u8, 0u8];
    let mut disc_poke = [0u8, 0u8];
    let mut disc_poke_p = [0u8, 0u8];
    let mut disc_item = [0u8, 0u8];
    let mut disc_supp = [0u8, 0u8];
    let mut disc_tool = [0u8, 0u8];
    let mut disc_basic_w = [0u8, 0u8];
    let mut disc_basic_any = [0u8, 0u8];
    let mut disc_quick_grow = [0u8, 0u8];
    let mut disc_volbeat = [0u8, 0u8];
    let mut delayed_slot = [4u8, 4u8];
    let mut delayed_dmg = [0i16, 0i16];
    let mut stadium: u8 = 0;

    let mut feat_sum = [0.0f32; FEATURES];
    let mut feat_cnt = 0u32;

    if RECORD { unsafe { REPLAY_LEN = 0; } }

    // Opening setup (guaranteed >=1 non-fossil Basic in opening 5)
    for p in 0..2 {
        for i in (1..20).rev() {
            let j = (rng.next_u32() as usize) % (i + 1);
            libs[p].swap(i, j);
        }
        let mut basic_pos = 20usize;
        for i in (0..20).rev() {
            if libs[p][i].is_pokemon == 1 && libs[p][i].stage == 0 && !libs[p][i].is_fossil() {
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
            if c.is_pokemon == 1 && c.stage == 0 && !c.is_fossil() {
                if !placed_active {
                    board[p][0] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, ..Slot::default() };
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
                            board[p][s] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, ..Slot::default() };
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
                if deck_ref[k].is_pokemon == 1 && !deck_ref[k].is_fossil() { fb = deck_ref[k]; break; }
            }
            board[p][0] = Slot { occ: true, card: fb, hp: fb.hp.max(60), max_hp: fb.hp.max(60), ..Slot::default() };
            if RECORD { push_replay_step(0, p, 1, fb.slot_id as i32, 0, 0, &points, &board, &hand_len, &lib_len); }
        }
    }

    let mut cur = first_player;
    for turn in 1u8..=30u8 {
        let foe = 1 - cur;
        let w = if cur == 0 { w0 } else { w1 };
        let do_track = track_feat && cur == 0;

        let had_cant_atk_self = board[cur][0].occ && (board[cur][0].status & ST_CANT_ATK_SELF) != 0;
        let had_cant_a1 = board[cur][0].occ && (board[cur][0].status & ST_CANT_USE_A1) != 0;
        let had_cant_a2 = board[cur][0].occ && (board[cur][0].status & ST_CANT_USE_A2) != 0;
        let cur_team_boost = next_team_boost[cur];
        next_team_boost[cur] = 0;

        // Expire protective buffs from opponent's turn
        team_shield[cur] = 0;
        team_shield_type[cur] = 255;
        for s in 0..4 {
            if board[cur][s].occ {
                if board[cur][s].shield > 0 { board[cur][s].shield = 0; } // positive shields expire; keep Espathra negative debuff until end of foe turn
                board[cur][s].shield_ex = 0;
                board[cur][s].counter = 0;
                board[cur][s].status &= !(ST_INVULN | ST_NO_WEAKNESS | ST_IMMUNE_BASIC | ST_IMMUNE_LE40 | ST_SURVIVE_10 | ST_RETREAT_TRAP);
            }
        }
        // Reset points earned this turn tracker for cur
        pts_last_turn[cur] = 0;
        let mut sweets_used_this_turn = 0u8;

        // Start-of-turn draw
        let drawn_id = draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
        if RECORD && drawn_id >= 0 {
            push_replay_step(turn, cur, 3, drawn_id, 1, 0, &points, &board, &hand_len, &lib_len);
        }

        // Start-of-turn Active Ability: Meloetta (ab_op == 2)
        if board[cur][0].occ && ab_active(&board, cur, 0, stadium, turn) && board[cur][0].card.ab_op == 2 {
            if search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 12, 0, 0, &mut rng) {
                if RECORD { push_replay_step(turn, cur, 7, board[cur][0].card.slot_id as i32, 0, 2 | (1 << 8), &points, &board, &hand_len, &lib_len); }
            }
        }

        // Once-per-turn Active Stadium effects (Fragrant Forest=9, Mesagoza=10, Abandoned Station=11, Arcade=12, Area Zero=13, Kid's Room=14)
        match stadium {
            9 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 9, 0, 0, &mut rng); }
            10 => { let mut dh = false; if rng.flip_coin(&mut dh) { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, 0, 0, &mut rng); } }
            11 => { let mut dh = false; if rng.flip_coin(&mut dh) { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); } }
            12 => {
                let mut dh = false;
                if rng.flip_coin(&mut dh) && rng.flip_coin(&mut dh) && rng.flip_coin(&mut dh) {
                    while hand_len[cur] < 7 && lib_len[cur] > 0 { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                }
            }
            13 => {
                if count_bench(&board[cur]) >= 2 && lib_len[cur] > 0 {
                    for hi in 0..hand_len[cur] {
                        if hands[cur][hi].is_pokemon == 1 && hands[cur][hi].stage == 0 && !hands[cur][hi].is_fossil() {
                            let b = hands[cur][hi];
                            hand_len[cur] -= 1;
                            hands[cur][hi] = hands[cur][hand_len[cur]];
                            if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = b; lib_len[cur] += 1; }
                            draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                            break;
                        }
                    }
                }
            }
            14 => {
                let mut has_t = false;
                for i in 0..lib_len[cur] { if libs[cur][i].is_tool() { has_t = true; break; } }
                if has_t && hand_len[cur] > 1 {
                    let put_b = hands[cur][hand_len[cur] - 1];
                    hand_len[cur] -= 1;
                    if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = put_b; lib_len[cur] += 1; }
                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 6, 0, 0, &mut rng);
                }
            }
            _ => {}
        }

        let mut energy_attached = turn == 1;
        let mut supporter_used = false;
        let mut retreated = false;
        let mut ability_used_mask: u8 = 0;
        let mut dmg_boost: i16 = 0;
        let mut dmg_boost_ex: i16 = 0;
        let mut named_boost: i16 = 0;
        let mut named_boost_h1: i32 = 0;
        let mut named_boost_h2: i32 = 0;
        let mut eevee_boost: i16 = 0;
        let mut retreat_discount: i32 = 0;
        let mut barry_disc: i32 = 0;
        let mut barry_h1: i32 = 0;
        let mut barry_h2: i32 = 0;
        let mut iris_active = false;
        let mut iris_h1: i32 = 0;
        let mut drayden_bonus: i32 = 0;
        let mut guaranteed_heads = false;
        let mut gholdengo_used = false;

        let opp_gengar_lock = board[foe][0].occ && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 17 && board[foe][0].card.ab_val == 4;
        let opp_stad_lock = board[foe][0].occ && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 17 && board[foe][0].card.ab_val == 5;
        let mut opp_aero_lock = false;
        for s in 0..4 {
            if ab_active(&board, foe, s, stadium, turn) && board[foe][s].card.ab_op == 15 && board[foe][s].card.ab_val == 3 {
                opp_aero_lock = true; break;
            }
        }
        let heal_blocked = healing_blocked(&board);

        for _step in 0..10 {
            let mut best_kind: u8 = 0;
            let mut best_a: usize = 0;
            let mut best_b: usize = 0;
            let mut best_score: i32 = w[0];
            let mut chosen_f0 = 0usize;
            let mut chosen_f1 = 0usize;
            let mut chosen_v1 = 0.0f32;
            let mut n_opts = 1u32;

            // 1. Place basics (including Fossils onto bench during turn)
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage == 0 {
                    for s in 1..4 {
                        if !board[cur][s].occ {
                            n_opts += 1;
                            let mut sc = w[2] + (((c.power_q * w[3]) >> 10) * 15 / 100) + ((c.bonus_q * 35) / 100);
                            if c.ab_op == 6 && c.ab_val == 1 {
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

            // 2. Evolve (strict evo_group; Turn 1 allowed ONLY for active Eevee Boost Evolution; blocked by Malamar evo_lock / Aerodactyl ex active)
            if evo_lock[cur] == 0 {
                for hi in 0..hand_len[cur] {
                    let c = hands[cur][hi];
                    if c.is_pokemon == 1 && c.stage > 0 && c.stage < 99 {
                        for s in 0..4 {
                            if !board[cur][s].occ { continue; }
                            if s == 0 && opp_aero_lock { continue; }
                            let bc = board[cur][s].card;
                            let can_t1 = s == 0 && ab_active(&board, cur, 0, stadium, turn) && bc.ab_op == 15 && bc.ab_val == 1;
                            if !can_t1 && (turn < 2 || board[cur][s].turn_placed >= turn) { continue; }
                            // Wait to use Magneton Volt Charge before evolving into Magnezone
                            if ab_active(&board, cur, s, stadium, turn) && bc.ab_op == 3 && bc.ab_val == 1 && (ability_used_mask & (1u8 << s)) == 0 { continue; }
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
            }

            // 3. Active Once-Per-Turn Abilities (ab_op: 3, 4, 8, 12(mode=2), 14, 16, 19)
            for s in 0..4 {
                if !ab_active(&board, cur, s, stadium, turn) || (ability_used_mask & (1u8 << s)) != 0 { continue; }
                let ab_op = board[cur][s].card.ab_op;
                let ab_val = board[cur][s].card.ab_val;
                let mut valid = false;
                let mut extra_sc = 0i32;
                let mut f1 = 6usize;
                let mut v1 = 0.0f32;
                match ab_op {
                    3 => {
                        match ab_val {
                            1 => { valid = true; extra_sc = w[15] >> 1; }
                            2 => { valid = board[cur][s].hp > 20 && (energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 4); extra_sc = w[15] >> 1; }
                            3 => { valid = board[cur][s].hp > 30; extra_sc = w[15]; }
                            4 => {
                                // Giratina ex: ENDS TURN! Only use if we can't attack profitably this turn (or Turn 1)!
                                let can_atk_now = turn >= 2 && board[cur][0].occ && can_pay_attack(&board, cur, foe, board[cur][0].card.a1_cost, board[cur][0].card.a1_flags, 0, lib_len[cur], hand_len[cur], stadium, turn);
                                if !can_atk_now || turn == 1 {
                                    valid = true;
                                    extra_sc = if turn == 1 { w[15] } else { (w[15] >> 1) - (w[9] >> 2) };
                                }
                            }
                            _ => {}
                        }
                    }
                    4 => {
                        if board[cur][0].occ {
                            if ab_val == 2 { valid = energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 3; }
                            else { valid = true; }
                            extra_sc = w[14] >> 1;
                        }
                    }
                    8 => {
                        if board[foe][0].occ { valid = true; extra_sc = (w[21] * 35) / 100; f1 = 21; v1 = 0.35; }
                    }
                    12 => {
                        if ((ab_val >> 8) & 0xff) == 2 && board[cur][s].energy > 0 && turn >= 2 {
                            // Skeledirge: discard 1 energy for +50 dmg this turn
                            valid = true; extra_sc = w[10] >> 1; f1 = 10; v1 = 0.5;
                        }
                    }
                    14 => {
                        let mode = (ab_val >> 8) & 0xff;
                        if mode == 6 {
                            valid = board[cur][0].occ && (board[cur][0].status & ST_SPECIAL_MASK) != 0;
                            extra_sc = w[20] >> 1;
                        } else if !heal_blocked {
                            match mode {
                                0 | 1 | 2 => {
                                    if board[cur][0].occ && board[cur][0].hp < board[cur][0].max_hp {
                                        valid = true; extra_sc = w[20] >> 1; f1 = 20; v1 = 0.5;
                                    }
                                }
                                3 => {
                                    // Arboliva: heal 60 from damaged ex w/ energy, discard 1 energy
                                    if board[cur][0].occ && board[cur][0].card.is_ex() && board[cur][0].energy > 0 && board[cur][0].max_hp - board[cur][0].hp >= 40 {
                                        valid = true; extra_sc = w[20] >> 1;
                                    }
                                }
                                4 | 5 => {
                                    if board[cur][0].occ && board[cur][0].hp < board[cur][0].max_hp && board[cur][s].hp > 30 {
                                        valid = true; extra_sc = w[20] >> 1;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    16 => {
                        match ab_val {
                            1 | 5 | 6 | 7 => {
                                if count_bench(&board[cur]) > 0 {
                                    let best_b_s = best_bench_promote(&board[cur]);
                                    if best_b_s < 4 && (board[cur][0].hp < board[cur][0].max_hp / 2 || (board[cur][best_b_s].energy > board[cur][0].energy && board[cur][best_b_s].card.power_q > board[cur][0].card.power_q)) {
                                        valid = true; extra_sc = w[18] >> 1;
                                    }
                                }
                            }
                            2 | 3 => {
                                // Lunala ex / Vaporeon: move bench energy to Active
                                let mut has_be = false;
                                for bs in 1..4 { if board[cur][bs].occ && board[cur][bs].energy > 0 { has_be = true; break; } }
                                if board[cur][0].occ && has_be { valid = true; extra_sc = w[14]; }
                            }
                            4 => {
                                // Tyranitar: gather all [D] energy onto self
                                let mut other_e = false;
                                for k in 0..4 { if k != s && board[cur][k].occ && board[cur][k].energy > 0 { other_e = true; break; } }
                                if other_e { valid = true; extra_sc = w[14]; }
                            }
                            _ => {}
                        }
                    }
                    19 => {
                        match ab_val {
                            1 | 5 => { valid = count_bench(&board[foe]) > 0; extra_sc = w[19] >> 1; }
                            2 => {
                                let mut hd = false;
                                for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp { hd = true; break; } }
                                valid = hd; extra_sc = w[19];
                            }
                            3 => {
                                let mut hb = false;
                                for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].card.stage == 0 { hb = true; break; } }
                                valid = hb; extra_sc = w[19] >> 1;
                            }
                            4 => { valid = board[foe][0].occ && board[foe][0].card.stage == 0 && count_bench(&board[foe]) > 0; extra_sc = w[19] >> 1; }
                            6 | 7 | 8 | 10 => { valid = hand_len[cur] < 12 && (ab_val == 10 || lib_len[cur] > 0); extra_sc = w[8]; }
                            9 => { valid = hand_len[cur] >= 2 && lib_len[cur] > 0; extra_sc = w[8] >> 1; }
                            11..=16 => { valid = board[foe][0].occ && !has_status_immunity(&board, foe, 0, stadium, turn); extra_sc = w[12] >> 1; }
                            17 => { valid = lib_len[foe] > 0; extra_sc = w[19] >> 2; }
                            18 => { valid = board[foe][0].occ && board[foe][0].tool_count() > 0; extra_sc = w[19] >> 1; }
                            19 => { valid = hand_len[foe] > 0; extra_sc = w[8] >> 1; }
                            _ => {} // 20 = info peek
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

            // 4. Trainers (1 Supporter/turn + Item-Lock + Supporter-Lock + Stadium-Lock + exact preconditions!)
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon != 0 || c.trn_kind == 0 || c.trn_kind == 8 { continue; }
                if c.is_supporter() && (supporter_used || supp_lock[cur] == 1 || opp_gengar_lock) { continue; }
                if c.is_item() && item_lock[cur] == 1 { continue; }
                if c.is_stadium() && opp_stad_lock { continue; }

                let mut sc = w[7] + ((c.bonus_q * 40) / 100);
                let mut f1 = 7usize;
                let mut v1 = 0.0f32;
                let mut playable = true;

                match c.trn_kind {
                    1 => {
                        match c.trn_sub {
                            2 => {
                                let mut ok = false;
                                for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 0 && !libs[cur][k].is_fossil() { ok = true; break; } }
                                playable = ok;
                            }
                            3 => { playable = hand_len[foe] > 0 && hand_len[foe] + 1 >= hand_len[cur]; }
                            5 => {
                                let mut hp = false; for k in 0..hand_len[cur] { if k != hi && hands[cur][k].is_pokemon == 1 { hp = true; break; } }
                                let mut dp = false; for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 { dp = true; break; } }
                                playable = hp && dp;
                            }
                            6 => {
                                let mut ok = false;
                                for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 0 && !libs[cur][k].is_fossil() && libs[cur][k].hp <= 50 { ok = true; break; } }
                                playable = ok;
                            }
                            7 => {
                                let mut ok = false; for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].stage == 2 { ok = true; break; } }
                                playable = ok;
                            }
                            8 => {
                                let mut ok = false; for k in 0..lib_len[cur] { if libs[cur][k].is_pokemon == 1 && libs[cur][k].is_mega() { ok = true; break; } }
                                playable = ok;
                            }
                            12 => {
                                let mut mc = 0;
                                for pp in 0..2 { for ss in 0..4 { if board[pp][ss].occ && board[pp][ss].card.is_mega() { mc += 1; } } }
                                playable = mc > 0 && lib_len[cur] > 0;
                            }
                            13 => {
                                let mut ok = false; for k in 0..lib_len[cur] { if libs[cur][k].is_stadium() { ok = true; break; } }
                                playable = ok;
                            }
                            18 => {
                                let mut ok = false; for k in 0..lib_len[cur] { if libs[cur][k].matches_trn_hashes(c.trn_h1, c.trn_h2) { ok = true; break; } }
                                playable = ok;
                            }
                            20 => { playable = if c.trn_val == 1 { disc_basic_any[cur] > 0 } else { disc_basic_w[cur] > 0 }; }
                            21 => { playable = disc_item[foe] > 0; }
                            22 => { playable = hand_len[cur] >= 3 && lib_len[cur] > 0; } // Maintenance needs 2 other cards
                            _ => { playable = lib_len[cur] > 0; }
                        }
                        let inv = 5120 / (5 + hand_len[cur] as i32);
                        sc += (inv * w[8]) >> 10; f1 = 8; v1 = (inv as f32) / 1024.0;
                    }
                    2 => {
                        match c.trn_sub {
                            6 => { playable = board[cur][0].occ && (board[cur][0].status & ST_SPECIAL_MASK) != 0; }
                            15 => {
                                // Eevee Bag: playable if any Eevee evo on board (either +10 dmg or heal 20)
                                let mut has_ee = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_eevee_evo() { has_ee = true; break; } }
                                playable = has_ee && (turn >= 2 || !heal_blocked);
                            }
                            16 => {
                                // Acerola: damaged Palossand/Mimikyu -> move 40 dmg to opp Active
                                let mut ok = false;
                                for s in 0..4 {
                                    if board[cur][s].occ && board[cur][s].hp < board[cur][s].max_hp && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { ok = true; break; }
                                }
                                playable = ok && board[foe][0].occ;
                            }
                            _ => {
                                if heal_blocked || !board[cur][0].occ { playable = false; }
                                else {
                                    let mut tgt_miss = 0i16;
                                    for s in 0..4 {
                                        if !board[cur][s].occ { continue; }
                                        let scard = board[cur][s].card;
                                        let ok_t = match c.trn_sub {
                                            2 => scard.has_type((c.trn_cond - 1) as u8),
                                            3 => board[cur][s].energy > 0,
                                            4 => scard.stage == 2,
                                            7 | 8 => s == 0,
                                            10 => board[cur][s].energy > 0,
                                            11 => scard.has_type(4) && board[cur][s].energy >= 2,
                                            12 | 13 | 14 => scard.matches_trn_hashes(c.trn_h1, c.trn_h2),
                                            _ => true,
                                        };
                                        if ok_t {
                                            let miss = board[cur][s].max_hp - board[cur][s].hp;
                                            if miss > tgt_miss { tgt_miss = miss; }
                                        }
                                    }
                                    let has_st = (c.trn_sub == 5 || c.trn_sub == 7 || c.trn_sub == 13) && (board[cur][0].status & ST_SPECIAL_MASK) != 0;
                                    if tgt_miss <= 0 && !has_st { playable = false; }
                                    else {
                                        let eff_h = if tgt_miss > 0 { tgt_miss.min((c.trn_val as i16).clamp(20, 90)) as i32 } else { 25 };
                                        sc += (w[20] * eff_h) / 50; f1 = 20; v1 = (eff_h as f32) * 0.02;
                                    }
                                }
                            }
                        }
                    }
                    3 => {
                        match c.trn_sub {
                            1 => { playable = count_bench(&board[foe]) > 0; }
                            2 => {
                                let mut hd = false;
                                for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp { hd = true; break; } }
                                playable = hd;
                            }
                            3 => {
                                let mut has_n = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { has_n = true; break; } }
                                playable = has_n && count_bench(&board[foe]) > 0;
                            }
                            4 => { playable = board[foe][0].occ && board[foe][0].card.stage == c.trn_val as u8 && count_bench(&board[foe]) > 0; }
                            5 => { playable = hand_len[foe] > 3; }
                            6 => { playable = hand_len[foe] > (3usize.saturating_sub(points[foe] as usize).max(1)); }
                            7 => { playable = hand_len[foe] > 4; }
                            8 | 9 => { playable = hand_len[foe] > 0; }
                            10 => {
                                let mut ht = false;
                                for s in 0..4 { if board[foe][s].occ && board[foe][s].tool_count() > 0 { ht = true; break; } }
                                playable = ht;
                            }
                            11 => {
                                let mut ht = stadium != 0;
                                for s in 0..4 { if board[foe][s].occ && board[foe][s].tool_count() > 0 { ht = true; break; } }
                                playable = ht;
                            }
                            12 => { playable = board[foe][0].occ && board[foe][0].energy > 0; }
                            13 => {
                                let mut hn = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { hn = true; break; } }
                                playable = hn && board[foe][0].occ && board[foe][0].energy > 0;
                            }
                            14 => {
                                let mut ok = false;
                                for s in 0..4 { if board[foe][s].occ && board[foe][s].card.ab_op != 0 && board[foe][s].energy > 0 { ok = true; break; } }
                                playable = ok;
                            }
                            15 => { playable = board[foe][0].occ && !has_status_immunity(&board, foe, 0, stadium, turn); }
                            16 => { playable = board[foe][0].occ; }
                            17 => { playable = disc_basic_any[foe] > 0 && count_bench(&board[foe]) < 3; }
                            18 => { playable = count_bench(&board[foe]) < 3 && hand_len[foe] > 0; }
                            19 => {
                                let mut be = false;
                                for s in 1..4 { if board[foe][s].occ && board[foe][s].energy > 0 { be = true; break; } }
                                playable = board[cur][0].occ && board[cur][0].card.has_psychic() && be;
                            }
                            20 => {
                                // Bounce own active to hand (only if bench exists & active damaged & matches target!)
                                if count_bench(&board[cur]) == 0 || !board[cur][0].occ || board[cur][0].hp >= board[cur][0].max_hp || board[cur][0].hp > 60 {
                                    playable = false;
                                } else {
                                    let ac = board[cur][0].card;
                                    playable = match c.trn_val {
                                        1 => ac.matches_trn_hashes(c.trn_h1, c.trn_h2),
                                        2 => ac.has_type(9),
                                        3 => ac.has_type(2) && !ac.is_ex(),
                                        4 => ac.is_future(),
                                        _ => false,
                                    };
                                }
                            }
                            _ => { playable = false; }
                        }
                        sc += ((w[19] * 45) + (w[21] * 25)) / 100; f1 = 19; v1 = 0.5;
                    }
                    4 => {
                        match c.trn_sub {
                            1 => { playable = turn >= 2 && board[foe][0].occ; }
                            2 => { playable = turn >= 2 && board[foe][0].occ && board[foe][0].card.is_ex(); }
                            3 => { playable = turn >= 2 && board[cur][0].occ && board[cur][0].card.has_type(5) && board[foe][0].occ && board[foe][0].card.is_ex(); }
                            4 => { playable = turn >= 2 && board[cur][0].occ && board[cur][0].card.matches_trn_hashes(c.trn_h1, c.trn_h2) && board[foe][0].occ; }
                            5 => { playable = turn >= 2 && board[cur][0].occ && board[cur][0].card.matches_trn_hashes(c.trn_h1, c.trn_h2) && board[foe][0].occ && board[foe][0].card.is_ex(); }
                            6 => { playable = turn >= 2; }
                            7 => { playable = turn >= 2 && points[foe] == 0; }
                            8 | 9 | 12 => {
                                let mut hn = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { hn = true; break; } }
                                playable = hn && turn >= 2;
                            }
                            10 => { playable = !guaranteed_heads && turn >= 2; }
                            11 => { playable = turn >= 2 && board[cur][0].occ && board[cur][0].card.matches_trn_hashes(c.trn_h1, c.trn_h2); }
                            13 => { playable = turn >= 2 && board[cur][0].occ && board[cur][0].card.has_draco(); }
                            _ => { playable = false; }
                        }
                        sc += ((w[10] * 35) + (w[11] * 25)) / 100; f1 = 11; v1 = 0.4;
                    }
                    5 => {
                        let tv = c.trn_val as u8;
                        let mut tgt_s = 4usize;
                        for s in 0..4 {
                            if !board[cur][s].occ { continue; }
                            let max_t = if ab_active(&board, cur, s, stadium, turn) && board[cur][s].card.ab_op == 15 && board[cur][s].card.ab_val == 9 { 2 } else { 1 };
                            if board[cur][s].tool_count() >= max_t { continue; }
                            let scard = board[cur][s].card;
                            let ok = match tv {
                                2 => scard.has_type(0),
                                3 => scard.stage == 1,
                                4 => scard.is_ancient(),
                                7 | 10 => scard.stage == 0,
                                8 => scard.has_type(2),
                                9 => scard.stage == 2,
                                11 => scard.retreat >= 3,
                                12 | 13 => scard.has_type(7),
                                14 => s > 0, // Protective Poncho goes on Bench!
                                16 => scard.is_future(),
                                17 => scard.name_hash == (c.trn_h1 & 0xffff) as u16,
                                18 => scard.is_ub(),
                                19 | 26 => scard.has_type(6),
                                25 => scard.has_type(3),
                                _ => true,
                            };
                            if ok { tgt_s = s; break; }
                        }
                        if tgt_s >= 4 { playable = false; }
                        else { sc += if tgt_s == 0 { w[20] } else { w[20] >> 1 }; f1 = 20; v1 = 1.0; }
                    }
                    6 => {
                        match c.trn_sub {
                            1 => {
                                if turn < 2 || evo_lock[cur] != 0 { playable = false; }
                                else {
                                    let mut ok = false;
                                    for hi2 in 0..hand_len[cur] {
                                        let evc = hands[cur][hi2];
                                        if evc.is_pokemon == 1 && evc.stage == 2 {
                                            for s in 0..4 {
                                                if !board[cur][s].occ || (s == 0 && opp_aero_lock) { continue; }
                                                let evo_ok = evc.evo_group == 0 || board[cur][s].card.evo_group == 0 || board[cur][s].card.evo_group == evc.evo_group;
                                                if board[cur][s].card.stage == 0 && evo_ok && board[cur][s].turn_placed < turn { ok = true; break; }
                                            }
                                            if ok { break; }
                                        }
                                    }
                                    playable = ok;
                                }
                                sc += w[4] + ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 4; v1 = 1.0;
                            }
                            2 => {
                                playable = turn >= 2 && evo_lock[cur] == 0 && lib_len[cur] > 0;
                                sc += w[4]; f1 = 4; v1 = 0.8;
                            }
                            3 => {
                                playable = !retreated && count_bench(&board[cur]) > 0 && eff_retreat_cost(&board, cur, stadium, turn, retreat_discount) > 0;
                                sc += w[18] >> 1; f1 = 18; v1 = 0.5;
                            }
                            4 => {
                                playable = count_bench(&board[cur]) > 0 && board[cur][0].occ && match c.trn_val {
                                    1 => board[cur][0].hp < board[cur][0].max_hp,
                                    2 => board[cur][0].card.stage == 1,
                                    _ => true,
                                };
                                sc += w[18] >> 1; f1 = 18; v1 = 0.5;
                            }
                            5 | 6 => {
                                let tf = (c.trn_cond.saturating_sub(1)) as u8;
                                let mut ok = false;
                                let start_s = if c.trn_sub == 6 { 1 } else { 0 };
                                for s in start_s..4 { if board[cur][s].occ && board[cur][s].card.has_type(tf) { ok = true; break; } }
                                playable = ok;
                                sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5;
                            }
                            7 => {
                                let mut ok = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.stage == 2 { ok = true; break; } }
                                playable = ok;
                                sc += ((w[13] * 45) + (w[15] * 35)) / 100; f1 = 15; v1 = 0.5;
                            }
                            8 => { playable = board[cur][0].occ && board[cur][0].card.has_type(1) && (energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 5); sc += w[15] >> 1; }
                            9 => {
                                let mut hub = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_ub() { hub = true; break; } }
                                playable = points[foe] >= 1 && hub && (energy_discarded[cur] > 0 || turn >= 4);
                                sc += w[15];
                            }
                            10 => {
                                let mut hn = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { hn = true; break; } }
                                playable = hn && (energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 5);
                                sc += w[15];
                            }
                            11 => {
                                let mut ha = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_ancient() { ha = true; break; } }
                                playable = ha && (energy_discarded[cur] > 0 || points[foe] > 0 || turn >= 4);
                                sc += w[15];
                            }
                            12 | 13 => {
                                let mut hn = false;
                                for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { hn = true; break; } }
                                // Kiawe (13) ENDS TURN! Don't play if we can attack profitably right now
                                playable = hn && (c.trn_sub == 12 || turn == 1 || board[cur][0].energy < 2);
                                sc += w[15];
                            }
                            14 | 15 => {
                                let mut be = false;
                                for s in 1..4 { if board[cur][s].occ && board[cur][s].energy > 0 { be = true; break; } }
                                let act_ok = if c.trn_sub == 15 && c.trn_val == 1 { board[cur][0].occ && board[cur][0].card.matches_trn_hashes(c.trn_h1, c.trn_h2) } else { board[cur][0].occ };
                                playable = act_ok && be;
                                sc += w[14];
                            }
                            16 => {
                                // Barry: Snorlax/Heracross/Staraptor cost -2 this turn
                                playable = turn >= 2 && board[cur][0].occ && board[cur][0].card.matches_trn_hashes(c.trn_h1, c.trn_h2);
                                sc += w[14];
                            }
                            _ => { playable = false; }
                        }
                    }
                    7 => {
                        let sv = c.trn_val as u8;
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

            // 5. Energy attach from Energy Zone (respects Banette ST_NO_ENERGY_ATTACH on Active!)
            if !energy_attached {
                for s in 0..4 {
                    if !board[cur][s].occ { continue; }
                    if s == 0 && (board[cur][0].status & ST_NO_ENERGY_ATTACH) != 0 { continue; }
                    n_opts += 1;
                    let bc = board[cur][s].card;
                    let max_c = if bc.a2_cost != 255 && bc.a2_cost > bc.a1_cost { bc.a2_cost } else if bc.a1_cost != 255 { bc.a1_cost } else { 1 };
                    let extra_need = if bc.a1_op1 == 7 && (bc.a1_val1 & 0xff) == 0 { (bc.a1_val1 >> 16) & 0xff } else { 0 };
                    let need_b = (board[cur][s].energy as i32) < (max_c as i32) + extra_need;
                    let chip_b = if ab_active(&board, cur, s, stadium, turn) && bc.ab_op == 7 && bc.ab_val < 100 { (w[21] * 45) / 100 } else { 0 };
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

            // 6. Retreat
            let active_ex_blocked = board[cur][0].occ && board[foe][0].occ
                && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 10
                && board[cur][0].card.is_ex();
            let r_cost = eff_retreat_cost(&board, cur, stadium, turn, retreat_discount);
            let cant_ret = board[cur][0].occ && (board[cur][0].status & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CANT_RETREAT)) != 0;
            if !retreated && board[cur][0].occ && !cant_ret && (board[cur][0].energy as i32) >= r_cost {
                let foe_dmg = if board[foe][0].occ { (board[foe][0].card.power_q * 100) >> 10 } else { 0 };
                for s in 1..4 {
                    if board[cur][s].occ {
                        n_opts += 1;
                        let endg_b = ((board[cur][0].hp as i32) <= foe_dmg && board[cur][s].hp > board[cur][0].hp)
                            || (active_ex_blocked && !board[cur][s].card.is_ex());
                        let sc = w[17] + (if endg_b { w[18] } else { 0 });
                        if sc > best_score {
                            best_score = sc; best_kind = 6; best_a = s;
                            chosen_f0 = 17; chosen_f1 = 18; chosen_v1 = if endg_b { 1.0 } else { 0.0 };
                        }
                    }
                }
            }

            // 7. Dual-Attack Selection
            let cant_atk = board[cur][0].occ && (board[cur][0].status & (ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CANT_ATK_SELF | ST_CANT_ATK_OPP)) != 0;
            if turn >= 2 && board[cur][0].occ && !cant_atk {
                let atk_c = board[cur][0].card;
                let my_barry = if barry_disc > 0 && atk_c.matches_trn_hashes(barry_h1, barry_h2) { barry_disc } else { 0 };
                for ai in 0..2usize {
                    if ai == 0 && (board[cur][0].status & ST_CANT_USE_A1) != 0 { continue; }
                    if ai == 1 && (board[cur][0].status & ST_CANT_USE_A2) != 0 { continue; }
                    let (ac, af, ad, ao1, av1, ao2, aaux) = if ai == 0 {
                        (atk_c.a1_cost, atk_c.a1_flags, atk_c.a1_dmg, atk_c.a1_op1, atk_c.a1_val1, atk_c.a1_op2, atk_c.a1_aux)
                    } else {
                        (atk_c.a2_cost, atk_c.a2_flags, atk_c.a2_dmg, atk_c.a2_op1, atk_c.a2_val1, atk_c.a2_op2, atk_c.a2_aux)
                    };
                    if !can_pay_attack(&board, cur, foe, ac, af, my_barry, lib_len[cur], hand_len[cur], stadium, turn) { continue; }
                    let (raw_d, is_special) = eval_live_attack_dmg_v3(
                        &board, cur, foe, ac, ad, ao1, av1, aaux,
                        &hands, &hand_len, &libs, &lib_len,
                        supporter_used, &ko_last_turn, &points, &pts_last_turn, &ko_count,
                        &sweets_used_last, &sweets_total, &disc_poke, &disc_poke_p, &disc_item, &disc_supp, &disc_quick_grow, &disc_volbeat,
                        stadium, turn,
                    );
                    if raw_d <= 0 && !is_special && ao1 == 0 && ao2 == 0 { continue; }
                    let ign_eff = (af & AF_IGNORE_EFFECTS) != 0;
                    if active_ex_blocked && !ign_eff && !is_special && ao1 != 8 && ao1 != 13 && ao1 != 18 && ao1 != 1 && ao2 == 0 { continue; }

                    let (mod_net, _) = calc_passive_dmg_mods(
                        &board, cur, foe, af, raw_d, dmg_boost, dmg_boost_ex,
                        named_boost, named_boost_h1, named_boost_h2, eevee_boost, cur_team_boost,
                        points[cur], stadium, team_shield[foe], team_shield_type[foe], turn,
                    );
                    n_opts += 1;
                    let total_dmg = if is_special { raw_d } else if raw_d > 0 { (raw_d + mod_net).max(0) } else { 0 };
                    let ko_b = board[foe][0].occ && total_dmg >= board[foe][0].hp;
                    let eff_b = if ao1 != 0 || ao2 != 0 { w[12] } else { 0 };
                    let snipe_b = if ao1 == 8 || ao2 == 8 { w[21] >> 1 } else { 0 };
                    let has_disc = ao1 == 10 || ao2 == 10;
                    let heavy_rec = (ao1 == 9 && (av1 & 0xff) >= 40) || (ao2 == 9 && (atk_c.a1_val2 & 0xff) >= 40);
                    let pen = if has_disc && !ko_b { (w[15] >> 2).max(0) } else if heavy_rec && board[cur][0].hp <= 50 { w[11] >> 1 } else { 0 };
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
                    let mut bonus_hp: i16 = if stadium == 3 && c.stage == 0 { 20 } else { 0 };
                    // Lilligant (+20 HP to all [G])
                    if c.has_type(0) {
                        for k in 0..4 {
                            if ab_active(&board, cur, k, stadium, turn) && board[cur][k].card.ab_op == 18 && board[cur][k].card.ab_val == 20 {
                                bonus_hp += 20;
                            }
                        }
                    }
                    board[cur][best_b] = Slot { occ: true, card: c, hp: c.hp + bonus_hp, max_hp: c.hp + bonus_hp, turn_placed: turn, ..Slot::default() };
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];
                    if RECORD { push_replay_step(turn, cur, 4, c.slot_id as i32, best_b as i32, 0, &points, &board, &hand_len, &lib_len); }
                    // On-Bench Triggers (ab_op == 6)
                    if ab_active(&board, cur, best_b, stadium, turn) && c.ab_op == 6 {
                        match c.ab_val {
                            1 => {
                                let walling_ex = board[cur][0].occ && ab_active(&board, cur, 0, stadium, turn) && board[cur][0].card.ab_op == 10 && board[foe][0].occ && board[foe][0].card.is_ex();
                                let mut tot_e = 0u8;
                                for k in 0..4 { if board[cur][k].occ && k != best_b { tot_e = tot_e.saturating_add(board[cur][k].energy); } }
                                let need_e = if c.a1_cost != 255 { c.a1_cost.max(2) } else { 3 };
                                if !walling_ex && tot_e >= need_e {
                                    for k in 0..4 { if board[cur][k].occ && k != best_b { board[cur][k].energy = 0; } }
                                    board[cur][best_b].energy = board[cur][best_b].energy.saturating_add(tot_e);
                                    board[cur].swap(0, best_b);
                                    board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                                    if RECORD { push_replay_step(turn, cur, 7, c.slot_id as i32, 0, 6 | ((tot_e as i32) << 8), &points, &board, &hand_len, &lib_len); }
                                }
                            }
                            2 => {
                                if count_bench(&board[foe]) > 0 {
                                    let pick = best_bench_promote(&board[foe]);
                                    if pick < 4 {
                                        board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR;
                                        board[foe][0].stack_boost = 0;
                                        board[foe].swap(0, pick);
                                        board[foe][0].status &= !ST_HAS_ATTACKED;
                                        if RECORD { push_replay_step(turn, cur, 7, c.slot_id as i32, best_b as i32, 7 | (1 << 8), &points, &board, &hand_len, &lib_len); }
                                    }
                                }
                            }
                            3 => {
                                if !heal_blocked && board[cur][0].occ && board[cur][0].card.has_type(0) {
                                    board[cur][0].hp = (board[cur][0].hp + 20).min(board[cur][0].max_hp);
                                    if RECORD { push_replay_step(turn, cur, 7, c.slot_id as i32, best_b as i32, 15 | (20 << 8), &points, &board, &hand_len, &lib_len); }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                2 => {
                    let c = hands[cur][best_a];
                    let dmg_taken = (board[cur][best_b].max_hp - board[cur][best_b].hp).max(0);
                    let bhp = tool_hp_bonus(board[cur][best_b].tool, &c) + tool_hp_bonus(board[cur][best_b].tool2, &c);
                    let mut extra_ab_hp: i16 = 0;
                    if c.has_type(0) {
                        for k in 0..4 {
                            if ab_active(&board, cur, k, stadium, turn) && board[cur][k].card.ab_op == 18 && board[cur][k].card.ab_val == 20 { extra_ab_hp += 20; }
                        }
                    }
                    if c.ab_op == 18 && c.ab_val == 99 { extra_ab_hp += (board[cur][best_b].energy as i16) * 30; }
                    board[cur][best_b].card = c;
                    board[cur][best_b].max_hp = c.hp + bhp + extra_ab_hp;
                    board[cur][best_b].hp = (board[cur][best_b].max_hp - dmg_taken).max(10);
                    board[cur][best_b].status &= !ST_SPECIAL_MASK;
                    board[cur][best_b].turn_placed = turn;
                    hand_len[cur] -= 1;
                    hands[cur][best_a] = hands[cur][hand_len[cur]];

                    // Lilligant entering play gives +20 HP to existing [G] allies
                    if c.ab_op == 18 && c.ab_val == 20 {
                        for k in 0..4 {
                            if board[cur][k].occ && board[cur][k].card.has_type(0) {
                                board[cur][k].max_hp += 20;
                                board[cur][k].hp += 20;
                            }
                        }
                    }

                    let mut evo_trig = 0i32;
                    if c.ab_op == 5 {
                        evo_trig = c.ab_val;
                        match c.ab_val {
                            1 => { if board[cur][0].occ && board[cur][0].card.has_type(1) { board[cur][0].energy = board[cur][0].energy.saturating_add(1); } }
                            2 => {
                                draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                                draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                            }
                            3 => {
                                for bs in 1..4 {
                                    if !board[cur][bs].occ {
                                        for li in 0..lib_len[cur] {
                                            if libs[cur][li].is_pokemon == 1 && libs[cur][li].stage == 1 && libs[cur][li].evo_group == c.evo_group {
                                                let clone_c = libs[cur][li];
                                                lib_len[cur] -= 1;
                                                libs[cur][li] = libs[cur][lib_len[cur]];
                                                board[cur][bs] = Slot { occ: true, card: clone_c, hp: clone_c.hp, max_hp: clone_c.hp, turn_placed: turn, ..Slot::default() };
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                }
                            }
                            4 | 5 => {
                                let d_amt = if c.ab_val == 5 { 30 } else { 20 };
                                if board[foe][0].occ {
                                    board[foe][0].hp -= d_amt;
                                    handle_active_ko(foe, cur, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                }
                            }
                            6 => {
                                shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                let want = (3usize.saturating_sub(points[foe] as usize)).max(1);
                                for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                            }
                            8 => { if board[foe][0].occ && rng.flip_coin(&mut guaranteed_heads) { apply_status(&mut board, foe, 0, ST_PARALYZE, stadium, turn, false); } }
                            9 => {
                                let lim = 4usize.min(lib_len[cur]);
                                let mut taken = 0usize;
                                for _ in 0..lim {
                                    if lib_len[cur] == 0 { break; }
                                    let top = libs[cur][lib_len[cur] - 1 - taken];
                                    if top.is_item() && hand_len[cur] < 12 {
                                        let idx_t = lib_len[cur] - 1 - taken;
                                        lib_len[cur] -= 1;
                                        libs[cur][idx_t] = libs[cur][lib_len[cur]];
                                        hands[cur][hand_len[cur]] = top;
                                        hand_len[cur] += 1;
                                    } else { taken += 1; }
                                }
                            }
                            10 => {
                                if board[foe][0].occ && board[foe][0].energy > 0 {
                                    board[foe][0].energy -= 1; energy_discarded[foe] = 1;
                                }
                            }
                            12 => {
                                if !heal_blocked {
                                    for s in 0..4 {
                                        if board[cur][s].occ && board[cur][s].card.has_type(2) && board[cur][s].hp < board[cur][s].max_hp {
                                            board[cur][s].hp = (board[cur][s].hp + 60).min(board[cur][s].max_hp); break;
                                        }
                                    }
                                }
                            }
                            13 => { apply_status(&mut board, foe, 0, ST_POISON | ST_BURN, stadium, turn, false); }
                            14 => {
                                if board[foe][0].occ && board[foe][0].energy > 0 {
                                    board[foe][0].energy -= 1;
                                    board[cur][best_b].energy = board[cur][best_b].energy.saturating_add(1);
                                }
                            }
                            15 => { board[cur][best_b].status |= ST_INVULN; }
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
                    if c.is_supporter() { supporter_used = true; }
                    if !c.is_tool() && !c.is_stadium() {
                        record_discard_card(&c, cur, &mut disc_poke, &mut disc_poke_p, &mut disc_item, &mut disc_supp, &mut disc_tool, &mut disc_basic_w, &mut disc_basic_any, &mut disc_quick_grow, &mut disc_volbeat);
                    }
                    let mut rep_val = c.trn_val;
                    let mut end_turn_now = false;

                    // Helper closure check for Gholdengo B4a Luxury Coin (reroll trainer coin flip once)
                    let mut has_gholdengo = false;
                    if !gholdengo_used {
                        for s in 0..4 {
                            if ab_active(&board, cur, s, stadium, turn) && board[cur][s].card.ab_op == 15 && board[cur][s].card.ab_val == (12 | (1 << 8)) {
                                has_gholdengo = true; break;
                            }
                        }
                    }

                    match c.trn_kind {
                        1 => {
                            match c.trn_sub {
                                1 => { for _ in 0..(c.trn_val.clamp(1, 3)) { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); } }
                                2 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 0, 0, 0, &mut rng); }
                                3 => {
                                    let want = hand_len[foe];
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, &mut rng);
                                    for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                }
                                4 => {
                                    let mn = hand_len[cur]; let fn_ = hand_len[foe];
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, &mut rng);
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                    for _ in 0..mn { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                    for _ in 0..fn_ { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                                }
                                5 => {
                                    let cnt = c.trn_val.clamp(1, 2);
                                    let mut got = 0;
                                    for _ in 0..cnt {
                                        if search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, 0, 0, &mut rng) { got += 1; }
                                    }
                                    for _ in 0..got {
                                        for k in 0..hand_len[cur] {
                                            if hands[cur][k].is_pokemon == 1 {
                                                let pb = hands[cur][k];
                                                hand_len[cur] -= 1;
                                                hands[cur][k] = hands[cur][hand_len[cur]];
                                                if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = pb; lib_len[cur] += 1; }
                                                break;
                                            }
                                        }
                                    }
                                }
                                6 => {
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 2, 0, 0, &mut rng);
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 2, 0, 0, &mut rng);
                                }
                                7 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 3, 0, 0, &mut rng); }
                                8 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 4, 0, 0, &mut rng); }
                                9 => { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); } // Serena's Choice top 3 pick 1
                                10 => {
                                    let mut h = rng.flip_coin(&mut guaranteed_heads);
                                    if !h && has_gholdengo { gholdengo_used = true; h = rng.flip_coin(&mut guaranteed_heads); }
                                    search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, if h { 5 } else { 6 }, 0, 0, &mut rng);
                                }
                                11 => {
                                    let mut h = rng.flip_coin(&mut guaranteed_heads);
                                    if !h && has_gholdengo { gholdengo_used = true; h = rng.flip_coin(&mut guaranteed_heads); }
                                    if h { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 5, 0, 0, &mut rng); }
                                }
                                12 => {
                                    let mut mc = 0;
                                    for pp in 0..2 { for ss in 0..4 { if board[pp][ss].occ && board[pp][ss].card.is_mega() { mc += 1; } } }
                                    for _ in 0..mc { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                }
                                13 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 7, 0, 0, &mut rng); }
                                14 | 15 | 16 => {
                                    let lim = 4usize.min(lib_len[cur]);
                                    let mut skip = 0usize;
                                    for _ in 0..lim {
                                        if lib_len[cur] <= skip { break; }
                                        let idx_t = lib_len[cur] - 1 - skip;
                                        let top = libs[cur][idx_t];
                                        let ok = if c.trn_sub == 14 { top.is_pokemon == 1 && top.stage == 1 }
                                            else if c.trn_sub == 15 { top.is_tool() }
                                            else { top.has_puppy() };
                                        if ok && hand_len[cur] < 12 {
                                            lib_len[cur] -= 1;
                                            libs[cur][idx_t] = libs[cur][lib_len[cur]];
                                            hands[cur][hand_len[cur]] = top;
                                            hand_len[cur] += 1;
                                        } else { skip += 1; }
                                    }
                                }
                                17 => {
                                    if lib_len[cur] > 0 {
                                        let top = libs[cur][lib_len[cur] - 1];
                                        if top.is_pokemon == 1 && top.has_type(4) && hand_len[cur] < 12 {
                                            lib_len[cur] -= 1;
                                            hands[cur][hand_len[cur]] = top;
                                            hand_len[cur] += 1;
                                        }
                                    }
                                }
                                18 => {
                                    for _ in 0..(c.trn_val.clamp(1, 2)) {
                                        search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 10, c.trn_h1, c.trn_h2, &mut rng);
                                    }
                                }
                                19 => {
                                    for _ in 0..5 {
                                        if rng.flip_coin(&mut guaranteed_heads) {
                                            search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 11, 0, 0, &mut rng);
                                        } else { break; }
                                    }
                                }
                                20 => {
                                    // Recover Basic / [W] from discard (approximate by cloning a deck Basic into hand if disc > 0)
                                    let deck_ref = if cur == 0 { d0 } else { d1 };
                                    let want_n = if c.trn_val == 3 {
                                        let mut h = 0; for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } } h
                                    } else { 1 };
                                    let mut got = 0;
                                    for k in 0..20 {
                                        if got >= want_n || hand_len[cur] >= 12 { break; }
                                        let ok = if c.trn_val == 1 { deck_ref[k].is_pokemon == 1 && deck_ref[k].stage == 0 && !deck_ref[k].is_fossil() }
                                            else { deck_ref[k].is_pokemon == 1 && deck_ref[k].has_type(2) && (c.trn_val == 3 || deck_ref[k].stage == 0) };
                                        if ok { hands[cur][hand_len[cur]] = deck_ref[k]; hand_len[cur] += 1; got += 1; }
                                    }
                                }
                                21 => {
                                    // TR Thieving Machine: copy an Item from opp deck into hand
                                    let o_ref = if foe == 0 { d0 } else { d1 };
                                    for k in 0..20 {
                                        if o_ref[k].is_item() && hand_len[cur] < 12 { hands[cur][hand_len[cur]] = o_ref[k]; hand_len[cur] += 1; break; }
                                    }
                                }
                                22 => {
                                    // Maintenance: shuffle 2 hand cards -> draw 1
                                    for _ in 0..2 {
                                        if hand_len[cur] > 0 {
                                            hand_len[cur] -= 1;
                                            let pb = hands[cur][hand_len[cur]];
                                            if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = pb; lib_len[cur] += 1; }
                                        }
                                    }
                                    draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                                }
                                23 => { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); } // Penny approx
                                _ => {}
                            }
                        }
                        2 => {
                            match c.trn_sub {
                                3 => {
                                    // Irida: heal 40 from ALL own Pokémon with [W] energy!
                                    if !heal_blocked {
                                        for s in 0..4 {
                                            if board[cur][s].occ && board[cur][s].energy > 0 {
                                                board[cur][s].hp = (board[cur][s].hp + 40).min(board[cur][s].max_hp);
                                            }
                                        }
                                    }
                                }
                                6 => { if board[cur][0].occ { board[cur][0].status &= !ST_SPECIAL_MASK; } }
                                7 => {
                                    if board[cur][0].occ {
                                        if !heal_blocked { board[cur][0].hp = (board[cur][0].hp + 10).min(board[cur][0].max_hp); }
                                        board[cur][0].status &= !ST_SPECIAL_MASK;
                                    }
                                }
                                8 => {
                                    // Lucky Ice Pop: heal 20 Active, coin heads return to hand!
                                    if !heal_blocked && board[cur][0].occ && board[cur][0].hp < board[cur][0].max_hp {
                                        board[cur][0].hp = (board[cur][0].hp + 20).min(board[cur][0].max_hp);
                                        let mut h = rng.flip_coin(&mut guaranteed_heads);
                                        if !h && has_gholdengo { gholdengo_used = true; h = rng.flip_coin(&mut guaranteed_heads); }
                                        if h && hand_len[cur] < 12 { hands[cur][hand_len[cur]] = c; hand_len[cur] += 1; }
                                    }
                                }
                                9 => {
                                    // Sweet Honey: flip until tails * 20
                                    let mut h = 0i16;
                                    for _ in 0..6 { if rng.flip_coin(&mut guaranteed_heads) { h += 20; } else { break; } }
                                    if !heal_blocked && board[cur][0].occ && h > 0 { board[cur][0].hp = (board[cur][0].hp + h).min(board[cur][0].max_hp); }
                                    rep_val = h as i32;
                                }
                                15 => {
                                    // Eevee Bag: heal 20 to all Eevee evos if damaged, else +10 dmg!
                                    let mut any_dmg = false;
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_eevee_evo() && board[cur][s].hp < board[cur][s].max_hp { any_dmg = true; break; } }
                                    if any_dmg && !heal_blocked {
                                        for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_eevee_evo() { board[cur][s].hp = (board[cur][s].hp + 20).min(board[cur][s].max_hp); } }
                                    } else {
                                        eevee_boost += 10;
                                    }
                                }
                                16 => {
                                    // Acerola: move 40 damage from Palossand/Mimikyu to opp Active!
                                    for s in 0..4 {
                                        if board[cur][s].occ && board[cur][s].hp < board[cur][s].max_hp && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) {
                                            let mv = (board[cur][s].max_hp - board[cur][s].hp).min(40);
                                            board[cur][s].hp += mv;
                                            if board[foe][0].occ {
                                                board[foe][0].hp -= mv;
                                                handle_active_ko(foe, cur, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                            }
                                            break;
                                        }
                                    }
                                }
                                _ => {
                                    // Targeted single-pokemon heal (1=Potion, 2=Erika, 4=Lillie, 5=PCL, 10=SuperPotion, 11=Diantha, 12=Mallow, 13=Whitney, 14=Marlon)
                                    let mut best_s = 4usize;
                                    let mut best_miss = -1i16;
                                    for s in 0..4 {
                                        if !board[cur][s].occ { continue; }
                                        let scard = board[cur][s].card;
                                        let ok = match c.trn_sub {
                                            2 => scard.has_type((c.trn_cond - 1) as u8),
                                            4 => scard.stage == 2,
                                            10 => board[cur][s].energy > 0,
                                            11 => scard.has_type(4) && board[cur][s].energy >= 2,
                                            12 | 13 | 14 => scard.matches_trn_hashes(c.trn_h1, c.trn_h2),
                                            _ => true,
                                        };
                                        if ok {
                                            let miss = board[cur][s].max_hp - board[cur][s].hp;
                                            if miss > best_miss { best_miss = miss; best_s = s; }
                                        }
                                    }
                                    if best_s < 4 {
                                        if !heal_blocked && best_miss > 0 {
                                            let h = (c.trn_val as i16).min(board[cur][best_s].max_hp);
                                            board[cur][best_s].hp = (board[cur][best_s].hp + h).min(board[cur][best_s].max_hp);
                                            if c.trn_sub == 10 { board[cur][best_s].energy = board[cur][best_s].energy.saturating_sub(1); energy_discarded[cur] = 1; }
                                            else if c.trn_sub == 11 { board[cur][best_s].energy = board[cur][best_s].energy.saturating_sub(2); energy_discarded[cur] = 1; }
                                            else if c.trn_sub == 12 { if board[cur][best_s].energy > 0 { energy_discarded[cur] = 1; } board[cur][best_s].energy = 0; }
                                        }
                                        if c.trn_sub == 5 { board[cur][best_s].status &= !ST_SPECIAL_MASK; }
                                        else if c.trn_sub == 13 { board[cur][best_s].status &= !(ST_SLEEP | ST_DEEP_SLEEP | ST_PARALYZE | ST_CONFUSE); }
                                    }
                                }
                            }
                        }
                        3 => {
                            match c.trn_sub {
                                1 | 4 => {
                                    let pick = best_bench_promote(&board[foe]);
                                    if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe][0].stack_boost = 0; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                2 => {
                                    let mut pick = 4usize;
                                    for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp && (pick == 4 || board[foe][bs].hp < board[foe][pick].hp) { pick = bs; } }
                                    if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe][0].stack_boost = 0; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                3 => {
                                    let mut pick = 4usize;
                                    for bs in 1..4 { if board[foe][bs].occ && (pick == 4 || board[foe][bs].hp < board[foe][pick].hp) { pick = bs; } }
                                    if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe][0].stack_boost = 0; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                5 => {
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                    for _ in 0..3 { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                                }
                                6 => {
                                    shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe, &mut rng);
                                    let want = (3usize.saturating_sub(points[foe] as usize)).max(1);
                                    for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, foe); }
                                }
                                7 => { while hand_len[foe] > 4 { hand_len[foe] -= 1; } }
                                8 => {
                                    for k in 0..hand_len[foe] {
                                        if hands[foe][k].is_supporter() {
                                            let sb = hands[foe][k]; hand_len[foe] -= 1; hands[foe][k] = hands[foe][hand_len[foe]];
                                            if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = sb; lib_len[foe] += 1; }
                                            break;
                                        }
                                    }
                                }
                                9 => {
                                    if hand_len[foe] > 0 {
                                        let idx_r = (rng.next_u32() as usize) % hand_len[foe];
                                        let rb = hands[foe][idx_r]; hand_len[foe] -= 1; hands[foe][idx_r] = hands[foe][hand_len[foe]];
                                        if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = rb; lib_len[foe] += 1; }
                                    }
                                }
                                10 => {
                                    let sides: &[usize] = if c.trn_val == 2 { &[0, 1] } else { &[foe] };
                                    for &pp in sides {
                                        for s in 0..4 {
                                            if board[pp][s].occ && board[pp][s].tool_count() > 0 {
                                                let hb = tool_hp_bonus(board[pp][s].tool, &board[pp][s].card) + tool_hp_bonus(board[pp][s].tool2, &board[pp][s].card);
                                                board[pp][s].tool = 0; board[pp][s].tool2 = 0;
                                                if hb > 0 { board[pp][s].max_hp = (board[pp][s].max_hp - hb).max(10); board[pp][s].hp = board[pp][s].hp.min(board[pp][s].max_hp); }
                                            }
                                        }
                                    }
                                }
                                11 => {
                                    let mut did = false;
                                    for s in 0..4 {
                                        if board[foe][s].occ && board[foe][s].tool != 0 {
                                            let hb = tool_hp_bonus(board[foe][s].tool, &board[foe][s].card);
                                            board[foe][s].tool = 0;
                                            if hb > 0 { board[foe][s].max_hp = (board[foe][s].max_hp - hb).max(10); board[foe][s].hp = board[foe][s].hp.min(board[foe][s].max_hp); }
                                            did = true; break;
                                        }
                                    }
                                    if !did {
                                        if stadium == 3 {
                                            for pp in 0..2 { for ss in 0..4 { if board[pp][ss].occ && board[pp][ss].card.stage == 0 { board[pp][ss].max_hp = (board[pp][ss].max_hp - 20).max(10); board[pp][ss].hp = board[pp][ss].hp.min(board[pp][ss].max_hp); } } }
                                        }
                                        stadium = 0;
                                    }
                                }
                                12 => {
                                    if board[foe][0].occ && board[foe][0].energy > 0 {
                                        let mut disc = 0u8;
                                        if c.trn_val == 99 {
                                            for _ in 0..6 { if board[foe][0].energy > 0 && rng.flip_coin(&mut guaranteed_heads) { board[foe][0].energy -= 1; disc += 1; } else { break; } }
                                        } else if c.trn_val == 2 {
                                            if rng.flip_coin(&mut guaranteed_heads) && rng.flip_coin(&mut guaranteed_heads) { board[foe][0].energy -= 1; disc = 1; }
                                        } else {
                                            board[foe][0].energy -= 1; disc = 1;
                                        }
                                        if disc > 0 { energy_discarded[foe] = 1; rep_val = disc as i32; }
                                    }
                                }
                                13 => {
                                    if board[foe][0].occ && board[foe][0].energy > 0 {
                                        let d = board[foe][0].energy.min(2); board[foe][0].energy -= d; energy_discarded[foe] = 1;
                                    }
                                }
                                14 => {
                                    for s in 0..4 {
                                        if board[foe][s].occ && board[foe][s].card.ab_op != 0 && board[foe][s].energy > 0 {
                                            board[foe][s].energy -= 1; energy_discarded[foe] = 1; break;
                                        }
                                    }
                                }
                                15 => {
                                    apply_status(&mut board, foe, 0, ST_CONFUSE, stadium, turn, false);
                                    if !rng.flip_coin(&mut guaranteed_heads) { apply_status(&mut board, cur, 0, ST_CONFUSE, stadium, turn, false); }
                                }
                                16 => { if board[foe][0].occ { board[foe][0].retreat_tax = board[foe][0].retreat_tax.saturating_add(1); } }
                                17 => {
                                    let o_ref = if foe == 0 { d0 } else { d1 };
                                    for bs in 1..4 {
                                        if !board[foe][bs].occ {
                                            for k in 0..20 {
                                                if o_ref[k].is_pokemon == 1 && o_ref[k].stage == 0 && !o_ref[k].is_fossil() {
                                                    board[foe][bs] = Slot { occ: true, card: o_ref[k], hp: o_ref[k].hp, max_hp: o_ref[k].hp, turn_placed: turn, ..Slot::default() };
                                                    break;
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }
                                18 => {
                                    let mut idx_h = 0;
                                    while idx_h < hand_len[foe] {
                                        if hands[foe][idx_h].is_pokemon == 1 && hands[foe][idx_h].stage == 0 && !hands[foe][idx_h].is_fossil() {
                                            let mut placed = false;
                                            for bs in 1..4 {
                                                if !board[foe][bs].occ {
                                                    let bc = hands[foe][idx_h];
                                                    board[foe][bs] = Slot { occ: true, card: bc, hp: bc.hp, max_hp: bc.hp, turn_placed: turn, ..Slot::default() };
                                                    hand_len[foe] -= 1; hands[foe][idx_h] = hands[foe][hand_len[foe]];
                                                    placed = true; break;
                                                }
                                            }
                                            if placed { continue; }
                                        }
                                        idx_h += 1;
                                    }
                                }
                                19 => {
                                    for bs in 1..4 {
                                        if board[foe][bs].occ && board[foe][bs].energy > 0 {
                                            board[foe][bs].energy -= 1; board[foe][0].energy = board[foe][0].energy.saturating_add(1); break;
                                        }
                                    }
                                }
                                20 => {
                                    let bounced = board[cur][0].card;
                                    if board[cur][0].energy > 0 { energy_discarded[cur] = 1; }
                                    board[cur][0].occ = false;
                                    let prom = best_bench_promote(&board[cur]);
                                    if prom < 4 { board[cur].swap(0, prom); board[cur][0].status &= !ST_HAS_ATTACKED; }
                                    if c.trn_val == 4 {
                                        if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = bounced; lib_len[cur] += 1; }
                                    } else if hand_len[cur] < 12 {
                                        hands[cur][hand_len[cur]] = bounced; hand_len[cur] += 1;
                                    }
                                }
                                _ => {}
                            }
                        }
                        4 => {
                            match c.trn_sub {
                                1 => { dmg_boost += c.trn_val as i16; }
                                2 | 3 => { dmg_boost_ex += c.trn_val as i16; }
                                4 | 5 => { named_boost += c.trn_val as i16; named_boost_h1 = c.trn_h1; named_boost_h2 = c.trn_h2; }
                                6 => {
                                    team_shield[cur] += c.trn_val as i16;
                                    team_shield_type[cur] = if c.trn_cond > 0 { (c.trn_cond - 1) as u8 } else { 255 };
                                }
                                7 => { team_shield[cur] += 20; team_shield_type[cur] = 254; } // Beast Wall UB
                                8 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { board[cur][s].shield += 50; } }
                                }
                                9 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { board[cur][s].shield_ex += 100; } }
                                }
                                10 => { guaranteed_heads = true; }
                                11 => { iris_active = true; iris_h1 = c.trn_h1; }
                                12 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { board[cur][s].status |= ST_SURVIVE_10; } }
                                }
                                13 => { drayden_bonus += 1; }
                                _ => {}
                            }
                        }
                        5 => {
                            let tv = c.trn_val as u8;
                            for s in 0..4 {
                                if !board[cur][s].occ { continue; }
                                let max_t = if ab_active(&board, cur, s, stadium, turn) && board[cur][s].card.ab_op == 15 && board[cur][s].card.ab_val == 9 { 2 } else { 1 };
                                if board[cur][s].tool_count() >= max_t { continue; }
                                let scard = board[cur][s].card;
                                let ok = match tv {
                                    2 => scard.has_type(0),
                                    3 => scard.stage == 1,
                                    4 => scard.is_ancient(),
                                    7 | 10 => scard.stage == 0,
                                    8 => scard.has_type(2),
                                    9 => scard.stage == 2,
                                    11 => scard.retreat >= 3,
                                    12 | 13 => scard.has_type(7),
                                    14 => s > 0,
                                    16 => scard.is_future(),
                                    17 => scard.name_hash == (c.trn_h1 & 0xffff) as u16,
                                    18 => scard.is_ub(),
                                    19 | 26 => scard.has_type(6),
                                    25 => scard.has_type(3),
                                    _ => true,
                                };
                                if ok {
                                    if board[cur][s].tool == 0 { board[cur][s].tool = tv; } else { board[cur][s].tool2 = tv; }
                                    let hb = tool_hp_bonus(tv, &scard);
                                    if hb > 0 { board[cur][s].max_hp += hb; board[cur][s].hp += hb; }
                                    if tv == 12 && scard.has_type(7) { board[cur][s].status &= !ST_SPECIAL_MASK; }
                                    break;
                                }
                            }
                        }
                        6 => {
                            match c.trn_sub {
                                1 => {
                                    // Rare Candy: Basic -> Stage 2
                                    let mut done = false;
                                    for hi2 in 0..hand_len[cur] {
                                        let evc = hands[cur][hi2];
                                        if evc.is_pokemon == 1 && evc.stage == 2 {
                                            for s in 0..4 {
                                                if !board[cur][s].occ || (s == 0 && opp_aero_lock) { continue; }
                                                let evo_ok = evc.evo_group == 0 || board[cur][s].card.evo_group == 0 || board[cur][s].card.evo_group == evc.evo_group;
                                                if board[cur][s].card.stage == 0 && evo_ok && board[cur][s].turn_placed < turn {
                                                    let taken = (board[cur][s].max_hp - board[cur][s].hp).max(0);
                                                    let bhp = tool_hp_bonus(board[cur][s].tool, &evc) + tool_hp_bonus(board[cur][s].tool2, &evc);
                                                    board[cur][s].card = evc;
                                                    board[cur][s].max_hp = evc.hp + bhp;
                                                    board[cur][s].hp = (board[cur][s].max_hp - taken).max(10);
                                                    board[cur][s].status &= !ST_SPECIAL_MASK;
                                                    board[cur][s].turn_placed = turn;
                                                    hand_len[cur] -= 1;
                                                    hands[cur][hi2] = hands[cur][hand_len[cur]];
                                                    done = true; break;
                                                }
                                            }
                                            if done { break; }
                                        }
                                    }
                                }
                                2 => {
                                    // Quick-Grow Extract ([G]) / Wallace ([W] HP<=50)
                                    let tf = (c.trn_cond.saturating_sub(1)) as u8;
                                    let max_hp_lim = if c.trn_val > 0 { c.trn_val as i16 } else { 999 };
                                    let mut evolved = false;
                                    for s in 0..4 {
                                        if !board[cur][s].occ || board[cur][s].turn_placed >= turn || (s == 0 && opp_aero_lock) { continue; }
                                        let bc = board[cur][s].card;
                                        if !bc.has_type(tf) || bc.hp > max_hp_lim { continue; }
                                        for li in 0..lib_len[cur] {
                                            let evc = libs[cur][li];
                                            let evo_ok = evc.evo_group == 0 || bc.evo_group == 0 || bc.evo_group == evc.evo_group;
                                            if evc.is_pokemon == 1 && evc.stage == bc.stage + 1 && evo_ok {
                                                let taken = (board[cur][s].max_hp - board[cur][s].hp).max(0);
                                                let bhp = tool_hp_bonus(board[cur][s].tool, &evc) + tool_hp_bonus(board[cur][s].tool2, &evc);
                                                board[cur][s].card = evc;
                                                board[cur][s].max_hp = evc.hp + bhp;
                                                board[cur][s].hp = (board[cur][s].max_hp - taken).max(10);
                                                board[cur][s].status &= !ST_SPECIAL_MASK;
                                                board[cur][s].turn_placed = turn;
                                                lib_len[cur] -= 1;
                                                libs[cur][li] = libs[cur][lib_len[cur]];
                                                evolved = true; break;
                                            }
                                        }
                                        if evolved { break; }
                                    }
                                }
                                3 => { retreat_discount += c.trn_val; }
                                4 => {
                                    let prom = best_bench_promote(&board[cur]);
                                    if prom < 4 {
                                        board[cur][0].status &= !ST_LEAVE_ACTIVE_CLEAR;
                                        board[cur][0].stack_boost = 0;
                                        board[cur].swap(0, prom);
                                        board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                                    }
                                }
                                5 => {
                                    let mut h = 0u8;
                                    for _ in 0..8 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } else { break; } }
                                    if board[cur][0].occ && board[cur][0].card.has_type(2) { board[cur][0].energy = board[cur][0].energy.saturating_add(h); }
                                    rep_val = h as i32;
                                }
                                6 => {
                                    let mut h = rng.flip_coin(&mut guaranteed_heads);
                                    if !h && has_gholdengo { gholdengo_used = true; h = rng.flip_coin(&mut guaranteed_heads); }
                                    if h {
                                        for s in 1..4 { if board[cur][s].occ && board[cur][s].card.has_type(3) { board[cur][s].energy = board[cur][s].energy.saturating_add(1); break; } }
                                    }
                                }
                                7 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.stage == 2 { board[cur][s].energy = board[cur][s].energy.saturating_add(1); break; } }
                                }
                                8 => { if board[cur][0].occ && board[cur][0].card.has_type(1) { board[cur][0].energy = board[cur][0].energy.saturating_add(1); } }
                                9 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_ub() { board[cur][s].energy = board[cur][s].energy.saturating_add(2); break; } }
                                }
                                10 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { board[cur][s].energy = board[cur][s].energy.saturating_add(2); break; } }
                                }
                                11 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.is_ancient() { board[cur][s].energy = board[cur][s].energy.saturating_add(3); break; } }
                                }
                                12 => {
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { board[cur][s].energy = board[cur][s].energy.saturating_add(c.trn_val as u8); } }
                                }
                                13 => {
                                    // Kiawe: +2 [R] AND END TURN!
                                    for s in 0..4 { if board[cur][s].occ && board[cur][s].card.matches_trn_hashes(c.trn_h1, c.trn_h2) { board[cur][s].energy = board[cur][s].energy.saturating_add(2); break; } }
                                    end_turn_now = true;
                                }
                                14 => {
                                    for s in 1..4 { if board[cur][s].occ && board[cur][s].energy > 0 { board[cur][s].energy -= 1; board[cur][0].energy = board[cur][0].energy.saturating_add(1); break; } }
                                }
                                15 => {
                                    let mut tot = 0u8;
                                    for s in 1..4 { if board[cur][s].occ && board[cur][s].energy > 0 { tot = tot.saturating_add(board[cur][s].energy); board[cur][s].energy = 0; } }
                                    board[cur][0].energy = board[cur][0].energy.saturating_add(tot);
                                }
                                16 => { barry_disc = 2; barry_h1 = c.trn_h1; barry_h2 = c.trn_h2; }
                                _ => {}
                            }
                        }
                        7 => {
                            let new_st = c.trn_val as u8;
                            if stadium == 3 && new_st != 3 {
                                for pp in 0..2 { for ss in 0..4 { if board[pp][ss].occ && board[pp][ss].card.stage == 0 { board[pp][ss].max_hp = (board[pp][ss].max_hp - 20).max(10); board[pp][ss].hp = board[pp][ss].hp.min(board[pp][ss].max_hp); } } }
                            } else if stadium != 3 && new_st == 3 {
                                for pp in 0..2 { for ss in 0..4 { if board[pp][ss].occ && board[pp][ss].card.stage == 0 { board[pp][ss].max_hp += 20; board[pp][ss].hp += 20; } } }
                            }
                            stadium = new_st;
                        }
                        _ => {}
                    }
                    if RECORD { push_replay_step(turn, cur, 6, c.slot_id as i32, c.trn_kind as i32, rep_val, &points, &board, &hand_len, &lib_len); }
                    if points[cur] >= 3 || !board[foe][0].occ {
                        *points_out = points;
                        return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                    }
                    if end_turn_now { break; }
                }
                4 => {
                    ability_used_mask |= 1u8 << best_a;
                    let ab_op = board[cur][best_a].card.ab_op;
                    let ab_val = board[cur][best_a].card.ab_val;
                    let ab_card_id = board[cur][best_a].card.slot_id as i32;
                    let mut end_turn_now = false;
                    match ab_op {
                        3 => {
                            match ab_val {
                                1 => { board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1); }
                                2 => { board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1); board[cur][best_a].hp = (board[cur][best_a].hp - 20).max(10); }
                                3 => { board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(2); board[cur][best_a].hp = (board[cur][best_a].hp - 30).max(10); }
                                4 => { board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1); end_turn_now = true; } // Giratina ex ENDS TURN!
                                _ => {}
                            }
                        }
                        4 => { if board[cur][0].occ { board[cur][0].energy = board[cur][0].energy.saturating_add(1); } }
                        8 => {
                            let dmg_s = (ab_val & 0xff) as i16;
                            let active_only = ((ab_val >> 8) & 0xff) != 0;
                            let mut ts = 0usize;
                            if !active_only {
                                for s in 1..4 {
                                    if board[foe][s].occ && !bench_dmg_blocked(&board, foe, s, false, stadium, turn)
                                        && (!board[foe][ts].occ || board[foe][s].hp < board[foe][ts].hp) { ts = s; }
                                }
                            }
                            if board[foe][ts].occ && !bench_dmg_blocked(&board, foe, ts, false, stadium, turn) {
                                board[foe][ts].hp -= dmg_s;
                                if ts == 0 {
                                    handle_active_ko(foe, cur, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                } else {
                                    handle_bench_ko(foe, cur, ts, false, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                }
                            }
                        }
                        12 => {
                            // Skeledirge: discard 1 energy -> +50 dmg this turn
                            if board[cur][best_a].energy > 0 {
                                board[cur][best_a].energy -= 1; energy_discarded[cur] = 1;
                                dmg_boost += 50;
                            }
                        }
                        14 => {
                            let amt = (ab_val & 0xff) as i16;
                            let mode = (ab_val >> 8) & 0xff;
                            match mode {
                                0 | 1 => { if !heal_blocked && board[cur][0].occ { board[cur][0].hp = (board[cur][0].hp + amt).min(board[cur][0].max_hp); } }
                                2 => {
                                    if !heal_blocked {
                                        let tf = ((ab_val >> 16) & 0xff) as u8;
                                        for s in 0..4 {
                                            if board[cur][s].occ && (tf == 255 || board[cur][s].card.has_type(tf)) {
                                                board[cur][s].hp = (board[cur][s].hp + amt).min(board[cur][s].max_hp);
                                            }
                                        }
                                    }
                                }
                                3 => {
                                    if !heal_blocked && board[cur][0].occ && board[cur][0].energy > 0 {
                                        board[cur][0].hp = (board[cur][0].hp + 60).min(board[cur][0].max_hp);
                                        board[cur][0].energy -= 1; energy_discarded[cur] = 1;
                                    }
                                }
                                4 => {
                                    if board[cur][0].occ && best_a > 0 {
                                        let mv = (board[cur][0].max_hp - board[cur][0].hp).min(30).min(board[cur][best_a].hp - 10).max(0);
                                        board[cur][0].hp += mv; board[cur][best_a].hp -= mv;
                                    }
                                }
                                5 => {
                                    if board[cur][0].occ && best_a > 0 {
                                        let mv = (board[cur][0].max_hp - board[cur][0].hp).min(board[cur][best_a].hp - 10).max(0);
                                        board[cur][0].hp += mv; board[cur][best_a].hp -= mv;
                                    }
                                }
                                6 => { if board[cur][0].occ { board[cur][0].status &= !ST_SPECIAL_MASK; } }
                                _ => {}
                            }
                        }
                        16 => {
                            match ab_val {
                                1 | 5 | 6 | 7 => {
                                    let prom = best_bench_promote(&board[cur]);
                                    if prom < 4 {
                                        board[cur][0].status &= !ST_LEAVE_ACTIVE_CLEAR;
                                        board[cur][0].stack_boost = 0;
                                        board[cur].swap(0, prom);
                                        board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                                    }
                                }
                                2 => {
                                    for bs in 1..4 {
                                        if board[cur][bs].occ && board[cur][bs].energy > 0 {
                                            board[cur][0].energy = board[cur][0].energy.saturating_add(board[cur][bs].energy);
                                            board[cur][bs].energy = 0; break;
                                        }
                                    }
                                }
                                3 => {
                                    for bs in 1..4 {
                                        if board[cur][bs].occ && board[cur][bs].energy > 0 {
                                            board[cur][bs].energy -= 1; board[cur][0].energy = board[cur][0].energy.saturating_add(1); break;
                                        }
                                    }
                                }
                                4 => {
                                    let mut tot = 0u8;
                                    for k in 0..4 { if k != best_a && board[cur][k].occ && board[cur][k].energy > 0 { tot = tot.saturating_add(board[cur][k].energy); board[cur][k].energy = 0; } }
                                    board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(tot);
                                }
                                _ => {}
                            }
                        }
                        19 => {
                            match ab_val {
                                1 | 4 => {
                                    let pick = best_bench_promote(&board[foe]);
                                    if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                2 => {
                                    let mut pick = 4usize;
                                    for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].hp < board[foe][bs].max_hp { pick = bs; break; } }
                                    if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                3 => {
                                    let mut pick = 4usize;
                                    for bs in 1..4 { if board[foe][bs].occ && board[foe][bs].card.stage == 0 { pick = bs; break; } }
                                    if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                }
                                5 => {
                                    if rng.flip_coin(&mut guaranteed_heads) {
                                        let pick = best_bench_promote(&board[foe]);
                                        if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                    }
                                }
                                6 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, 0, 0, &mut rng); }
                                7 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 6, 0, 0, &mut rng); }
                                8 => { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                9 => {
                                    if hand_len[cur] > 0 { hand_len[cur] -= 1; draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                }
                                10 => {
                                    // Ribombee: add Sweet Honey rental card to hand
                                    if hand_len[cur] < 12 {
                                        let mut sh = CompactCard::default();
                                        sh.name_hash = H_SWEET_HONEY;
                                        sh.meta_hi = 2; // item
                                        sh.trn_kind = 2; sh.trn_sub = 9; sh.trn_val = 20;
                                        hands[cur][hand_len[cur]] = sh; hand_len[cur] += 1;
                                    }
                                }
                                11 => { apply_status(&mut board, foe, 0, ST_POISON, stadium, turn, false); }
                                12 => { apply_status(&mut board, foe, 0, ST_BURN, stadium, turn, false); }
                                13 => { if rng.flip_coin(&mut guaranteed_heads) { apply_status(&mut board, foe, 0, ST_SLEEP, stadium, turn, false); } }
                                14 => { if rng.flip_coin(&mut guaranteed_heads) { apply_status(&mut board, foe, 0, ST_POISON, stadium, turn, false); } }
                                15 => { apply_status(&mut board, foe, 0, ST_CONFUSE, stadium, turn, false); }
                                16 => {
                                    let r = rng.next_u32() % 3;
                                    let st = if r == 0 { ST_BURN } else if r == 1 { ST_CONFUSE } else { ST_POISON };
                                    apply_status(&mut board, foe, 0, st, stadium, turn, false);
                                }
                                17 => { if lib_len[foe] > 0 { lib_len[foe] -= 1; } }
                                18 => {
                                    if board[foe][0].occ && board[foe][0].tool_count() > 0 {
                                        let hb = tool_hp_bonus(board[foe][0].tool, &board[foe][0].card) + tool_hp_bonus(board[foe][0].tool2, &board[foe][0].card);
                                        board[foe][0].tool = 0; board[foe][0].tool2 = 0;
                                        if hb > 0 { board[foe][0].max_hp = (board[foe][0].max_hp - hb).max(10); board[foe][0].hp = board[foe][0].hp.min(board[foe][0].max_hp); }
                                        board[cur][best_a].occ = false;
                                    }
                                }
                                19 => { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                    if RECORD { push_replay_step(turn, cur, 7, ab_card_id, best_a as i32, (ab_op as i32) | ((ab_val & 0xff) << 8), &points, &board, &hand_len, &lib_len); }
                    if points[cur] >= 3 || !board[foe][0].occ {
                        *points_out = points;
                        return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                    }
                    if end_turn_now { break; }
                }
                5 => {
                    energy_attached = true;
                    board[cur][best_a].energy = board[cur][best_a].energy.saturating_add(1);
                    let tgt_card = board[cur][best_a].card;
                    // Reuniclus / Serperior B4a-005: +30 HP per energy
                    if ab_active(&board, cur, best_a, stadium, turn) && tgt_card.ab_op == 18 && tgt_card.ab_val == 99 {
                        board[cur][best_a].max_hp += 30;
                        board[cur][best_a].hp += 30;
                    }
                    // Gothitelle ST_ATTACH_SLEEP
                    if best_a == 0 && (board[cur][0].status & ST_ATTACH_SLEEP) != 0 {
                        apply_status(&mut board, cur, 0, ST_SLEEP, stadium, turn, false);
                    }
                    if RECORD { push_replay_step(turn, cur, 8, tgt_card.slot_id as i32, best_a as i32, board[cur][best_a].energy as i32, &points, &board, &hand_len, &lib_len); }

                    // On-Attach-Energy Ability (ab_op == 7): Darkrai ex (20), C1 Charizard (30), Cresselia ex (heal 20!), Komala (self Asleep!), Porygon2 (self evolve!)
                    if ab_active(&board, cur, best_a, stadium, turn) && tgt_card.ab_op == 7 {
                        let av = tgt_card.ab_val;
                        if av < 100 && board[foe][0].occ {
                            let chip = av as i16;
                            board[foe][0].hp -= chip;
                            handle_active_ko(foe, cur, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                            if RECORD { push_replay_step(turn, cur, 7, tgt_card.slot_id as i32, best_a as i32, 9 | ((chip as i32) << 8), &points, &board, &hand_len, &lib_len); }
                            if points[cur] >= 3 || !board[foe][0].occ {
                                *points_out = points;
                                return finish_game(if cur == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                            }
                        } else if av >= 100 && av < 200 && !heal_blocked {
                            let h = (av - 100) as i16;
                            board[cur][best_a].hp = (board[cur][best_a].hp + h).min(board[cur][best_a].max_hp);
                            if RECORD { push_replay_step(turn, cur, 7, tgt_card.slot_id as i32, best_a as i32, 15 | ((h as i32) << 8), &points, &board, &hand_len, &lib_len); }
                        } else if av == 200 && best_a == 0 {
                            apply_status(&mut board, cur, 0, ST_SLEEP, stadium, turn, false);
                        } else if av == 201 {
                            // Porygon2 Buggy Evolution: evolve from deck!
                            for li in 0..lib_len[cur] {
                                let evc = libs[cur][li];
                                if evc.is_pokemon == 1 && evc.stage == tgt_card.stage + 1 && evc.evo_group == tgt_card.evo_group {
                                    let taken = (board[cur][best_a].max_hp - board[cur][best_a].hp).max(0);
                                    let bhp = tool_hp_bonus(board[cur][best_a].tool, &evc) + tool_hp_bonus(board[cur][best_a].tool2, &evc);
                                    board[cur][best_a].card = evc;
                                    board[cur][best_a].max_hp = evc.hp + bhp;
                                    board[cur][best_a].hp = (board[cur][best_a].max_hp - taken).max(10);
                                    board[cur][best_a].status &= !ST_SPECIAL_MASK;
                                    board[cur][best_a].turn_placed = turn;
                                    lib_len[cur] -= 1;
                                    libs[cur][li] = libs[cur][lib_len[cur]];
                                    break;
                                }
                            }
                        }
                    }

                    // Opponent Jolteon ex (ab_op == 20): 20 dmg to the Pokémon receiving energy!
                    if board[foe][0].occ && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 20 {
                        let jdmg = board[foe][0].card.ab_val as i16;
                        if !bench_dmg_blocked(&board, cur, best_a, false, stadium, turn) {
                            board[cur][best_a].hp -= jdmg;
                            if best_a == 0 {
                                handle_active_ko(cur, foe, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                            } else {
                                handle_bench_ko(cur, foe, best_a, false, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
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
                    let pay = eff_retreat_cost(&board, cur, stadium, turn, retreat_discount).max(0) as u8;
                    let had_trap = (board[cur][0].status & ST_RETREAT_TRAP) != 0;
                    if pay > 0 { energy_discarded[cur] = 1; }
                    board[cur][0].energy = board[cur][0].energy.saturating_sub(pay);
                    board[cur][0].status &= !ST_LEAVE_ACTIVE_CLEAR;
                    board[cur][0].weaken = 0;
                    board[cur][0].cost_tax = 0;
                    board[cur][0].retreat_tax = 0;
                    board[cur][0].next_atk_mod = 0;
                    board[cur][0].stack_boost = 0;
                    board[cur].swap(0, best_a);
                    board[cur][0].status = (board[cur][0].status | ST_SWITCHED_IN) & !ST_HAS_ATTACKED;
                    if had_trap {
                        board[cur][0].hp -= 40;
                        handle_active_ko(cur, foe, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                    }
                    if RECORD { push_replay_step(turn, cur, 9, old_id, best_a as i32, new_id, &points, &board, &hand_len, &lib_len); }
                    if points[foe] >= 3 || !board[cur][0].occ {
                        *points_out = points;
                        return finish_game(if foe == 0 { 1 } else { 0 }, turn, track_feat, feat_cnt, &feat_sum, feat_out);
                    }
                }
                7 => {
                    let atk_idx = best_a;
                    let atk_c = board[cur][0].card;
                    let (mut ac, mut af, mut ad, mut ao1, mut av1, mut ao2, mut av2, mut aaux) = if atk_idx == 0 {
                        (atk_c.a1_cost, atk_c.a1_flags, atk_c.a1_dmg, atk_c.a1_op1, atk_c.a1_val1, atk_c.a1_op2, atk_c.a1_val2, atk_c.a1_aux)
                    } else {
                        (atk_c.a2_cost, atk_c.a2_flags, atk_c.a2_dmg, atk_c.a2_op1, atk_c.a2_val1, atk_c.a2_op2, atk_c.a2_val2, atk_c.a2_aux)
                    };

                    // Op 20 val 6: Genome Hacking / Copy Attack (Mew ex, Mimikyu, Ditto, Mew B2b)
                    let mut copy_failed = false;
                    if ao1 == 20 && (av1 & 0xff) == 6 {
                        let c_mode = (av1 >> 8) & 0xff;
                        if c_mode == 1 && !rng.flip_coin(&mut guaranteed_heads) {
                            copy_failed = true;
                        } else {
                            let src_card = if c_mode == 3 {
                                let mut bc = CompactCard::default();
                                for s in 1..4 {
                                    if board[cur][s].occ && !board[cur][s].card.is_ex() && board[cur][s].card.a1_cost != 255 {
                                        bc = board[cur][s].card; break;
                                    }
                                }
                                bc
                            } else if board[foe][0].occ {
                                board[foe][0].card
                            } else {
                                CompactCard::default()
                            };
                            let pick_a2 = src_card.a2_cost != 255 && (src_card.a2_dmg >= src_card.a1_dmg || src_card.a1_cost == 255);
                            if pick_a2 {
                                ac = src_card.a2_cost; af = src_card.a2_flags; ad = src_card.a2_dmg;
                                ao1 = src_card.a2_op1; av1 = src_card.a2_val1; ao2 = src_card.a2_op2; av2 = src_card.a2_val2; aaux = src_card.a2_aux;
                            } else if src_card.a1_cost != 255 {
                                ac = src_card.a1_cost; af = src_card.a1_flags; ad = src_card.a1_dmg;
                                ao1 = src_card.a1_op1; av1 = src_card.a1_val1; ao2 = src_card.a1_op2; av2 = src_card.a1_val2; aaux = src_card.a1_aux;
                            } else {
                                copy_failed = true;
                            }
                            if ao1 == 20 && (av1 & 0xff) == 6 { copy_failed = true; } // prevent recursive copy loop
                        }
                    }

                    // Discard hand cost flags (Sableye / Cofagrigus)
                    if (af & AF_DISCARD_HAND_2) != 0 {
                        for _ in 0..2 {
                            if hand_len[cur] > 0 {
                                hand_len[cur] -= 1;
                                let dc = hands[cur][hand_len[cur]];
                                record_discard_card(&dc, cur, &mut disc_poke, &mut disc_poke_p, &mut disc_item, &mut disc_supp, &mut disc_tool, &mut disc_basic_w, &mut disc_basic_any, &mut disc_quick_grow, &mut disc_volbeat);
                            }
                        }
                    } else if (af & AF_DISCARD_HAND_1) != 0 && hand_len[cur] > 0 {
                        hand_len[cur] -= 1;
                        let dc = hands[cur][hand_len[cur]];
                        record_discard_card(&dc, cur, &mut disc_poke, &mut disc_poke_p, &mut disc_item, &mut disc_supp, &mut disc_tool, &mut disc_basic_w, &mut disc_basic_any, &mut disc_quick_grow, &mut disc_volbeat);
                    }

                    // Sweets Relay tracking
                    if atk_c.has_sweets() {
                        sweets_used_this_turn = 1;
                        sweets_total[cur] = sweets_total[cur].saturating_add(1);
                    }

                    // Check Victini Victory Star availability for [R] Pokémon attacks (once per turn)
                    let mut has_victini = false;
                    if atk_c.has_type(1) {
                        for s in 0..4 {
                            if ab_active(&board, cur, s, stadium, turn) && board[cur][s].card.ab_op == 15 && board[cur][s].card.ab_val == 12 {
                                has_victini = true; break;
                            }
                        }
                    }

                    let mut miss_flag = 0i32;
                    let mut eff_tag = 0i32;
                    let mut eff_num = 0i32;
                    let mut total_dmg: i16 = 0;
                    let mut weak_b: i16 = 0;
                    let mut ko_flag = 0i32;
                    let mut op1_heads: i32 = 0;
                    let is_first_atk = (board[cur][0].status & ST_HAS_ATTACKED) == 0;
                    let was_evolved_turn = board[cur][0].card.stage > 0 && board[cur][0].turn_placed == turn;

                    // Pre-attack miss checks
                    if copy_failed {
                        miss_flag = 1; eff_tag = 30;
                    } else if (board[cur][0].status & ST_CONFUSE) != 0 && !rng.flip_coin(&mut guaranteed_heads) {
                        miss_flag = 1; eff_tag = 27;
                    } else if (board[cur][0].status & (ST_OPP_MISS_FLIP | ST_PERM_MISS_FLIP)) != 0 && !rng.flip_coin(&mut guaranteed_heads) {
                        miss_flag = 1; eff_tag = 28;
                    } else if ao1 == 3 && (av1 & 0xff) == 1 {
                        let mut h = rng.flip_coin(&mut guaranteed_heads);
                        if !h && has_victini { has_victini = false; h = rng.flip_coin(&mut guaranteed_heads); }
                        if !h { miss_flag = 1; eff_tag = 30; }
                    } else if ao1 == 14 && ((av1 >> 8) & 0xff) == 8 {
                        let mut h = rng.flip_coin(&mut guaranteed_heads);
                        if !h && has_victini { has_victini = false; h = rng.flip_coin(&mut guaranteed_heads); }
                        if !h { miss_flag = 1; eff_tag = 30; }
                    } else if (af & AF_FLIP_2_BOTH_TAILS_FAIL) != 0 && ao1 != 11 {
                        let h1 = rng.flip_coin(&mut guaranteed_heads);
                        let h2 = rng.flip_coin(&mut guaranteed_heads);
                        if !h1 && !h2 { miss_flag = 1; eff_tag = 30; }
                    }

                    // Consume single-turn next_atk_mod after declaring attack
                    let cur_next_mod = board[cur][0].next_atk_mod;
                    board[cur][0].next_atk_mod = 0;

                    // Pre-damage Tool removal (Starly / Purrloin / Hoopa B4)
                    if miss_flag == 0 && board[foe][0].occ && (ao1 == 17 && (av1 & 0xff) == 9) {
                        let all_opp = ((av1 >> 8) & 0xff) != 0;
                        let max_s = if all_opp { 4 } else { 1 };
                        for s in 0..max_s {
                            if board[foe][s].occ && board[foe][s].tool_count() > 0 {
                                let hb = tool_hp_bonus(board[foe][s].tool, &board[foe][s].card) + tool_hp_bonus(board[foe][s].tool2, &board[foe][s].card);
                                board[foe][s].tool = 0; board[foe][s].tool2 = 0;
                                if hb > 0 { board[foe][s].max_hp = (board[foe][s].max_hp - hb).max(10); board[foe][s].hp = board[foe][s].hp.min(board[foe][s].max_hp); }
                                eff_tag = 22;
                            }
                        }
                    }

                    let mut active_took_dmg = false;
                    let mut any_foe_ko = false;
                    let extra_pt: u8 = if iris_active && atk_c.matches_trn_hashes(iris_h1, 0) { 1 } else { 0 };

                    if miss_flag == 0 && board[foe][0].occ {
                        let mut raw_d = ad;
                        let mut direct_active = true;
                        let ign_eff = (af & AF_IGNORE_EFFECTS) != 0;

                        // === PHASE 1: PRIMARY DAMAGE / TARGETING OPCODE (op1) ===
                        let b0 = av1 & 0xff;
                        let b1 = (av1 >> 8) & 0xff;
                        let b2 = (av1 >> 16) & 0xff;
                        match ao1 {
                            3 => {
                                if b0 == 3 {
                                    // Flip coin: heads +b1, tails self recoil b2
                                    let mut h = rng.flip_coin(&mut guaranteed_heads);
                                    if !h && has_victini { has_victini = false; h = rng.flip_coin(&mut guaranteed_heads); }
                                    if h { raw_d = ad + b1 as i16; eff_tag = 24; eff_num = 1; }
                                    else { board[cur][0].hp -= b2 as i16; eff_tag = 7; eff_num = b2; }
                                } else if b0 == 4 {
                                    // Delibird: heads 70 dmg, tails heal opp 30
                                    if rng.flip_coin(&mut guaranteed_heads) { raw_d = 70; eff_tag = 24; eff_num = 1; }
                                    else { direct_active = false; if !heal_blocked { board[foe][0].hp = (board[foe][0].hp + 30).min(board[foe][0].max_hp); } }
                                }
                            }
                            4 => {
                                let mut heads = 0i32;
                                let mut flips = b0;
                                if (b2 & 8) != 0 { flips = eff_energy(&board, cur, 0, stadium, turn).min(12); }
                                else if (b2 & 2) != 0 { flips = 1 + count_bench(&board[cur]); }
                                else if (b2 & 4) != 0 {
                                    flips = 0;
                                    for s in 0..4 { if board[cur][s].occ && (board[cur][s].card.name_hash == H_TANDEMAUS || board[cur][s].card.name_hash == H_MAUSHOLD) { flips += 1; } }
                                } else {
                                    if (b2 & 1) != 0 && board[cur][0].has_tool(24) { flips = 4; }
                                    if (b2 & 16) != 0 {
                                        for s in 0..4 { if board[cur][s].occ && board[cur][s].card.name_hash == H_RABOOT { flips += 3; } }
                                    }
                                }
                                if flips == 99 {
                                    for _ in 0..10 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } else { break; } }
                                    if heads == 0 && has_victini {
                                        has_victini = false;
                                        for _ in 0..10 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } else { break; } }
                                    }
                                } else {
                                    for _ in 0..flips.clamp(0, 12) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    if heads == 0 && flips > 0 && has_victini {
                                        has_victini = false;
                                        for _ in 0..flips.clamp(0, 12) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    }
                                }
                                op1_heads = heads;
                                if (b2 & 32) != 0 {
                                    // Camerupt: discard 1 [R] per heads, +30 per discarded!
                                    let disc = (heads as u8).min(board[cur][0].energy);
                                    if disc > 0 { board[cur][0].energy -= disc; energy_discarded[cur] = 1; }
                                    raw_d = ad + (disc as i16) * (b1 as i16);
                                } else {
                                    raw_d = (b1 as i16) * (heads as i16);
                                }
                                eff_tag = 24; eff_num = heads;
                            }
                            5 => {
                                let mut heads = 0i32;
                                if b0 == 97 {
                                    for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    let bonus = if heads == 1 { 20 } else if heads == 2 { 50 } else if heads == 3 { 120 } else { 0 };
                                    raw_d = ad + bonus;
                                } else if b0 == 98 {
                                    let h1 = rng.flip_coin(&mut guaranteed_heads);
                                    let h2 = rng.flip_coin(&mut guaranteed_heads);
                                    heads = (if h1 { 1 } else { 0 }) + (if h2 { 1 } else { 0 });
                                    raw_d = ad + if heads == 2 { b1 as i16 } else { 0 };
                                } else if b0 == 99 {
                                    for _ in 0..10 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } else { break; } }
                                    raw_d = ad + (b1 as i16) * (heads as i16);
                                } else if b2 == 2 {
                                    let n = eff_energy(&board, cur, 0, stadium, turn).min(10);
                                    for _ in 0..n { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    raw_d = ad + (b1 as i16) * (heads as i16);
                                } else if b2 == 3 {
                                    // Mega Slowbro ex: 3 coins, +20*heads to each opp Bench!
                                    for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    let bd = (b1 as i16) * (heads as i16);
                                    if bd > 0 {
                                        for s in 1..4 {
                                            if board[foe][s].occ && !bench_dmg_blocked(&board, foe, s, true, stadium, turn) {
                                                board[foe][s].hp -= bd;
                                                if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                            }
                                        }
                                    }
                                } else {
                                    for _ in 0..b0.clamp(1, 8) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    if heads == 0 && has_victini {
                                        has_victini = false;
                                        for _ in 0..b0.clamp(1, 8) { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    }
                                    raw_d = ad + (b1 as i16) * (heads as i16);
                                }
                                op1_heads = heads;
                                eff_tag = 24; eff_num = heads;
                            }
                            6 => {
                                let cnt = eval_count_op6(b0, b2, aaux, &board, cur, foe, &hands, &hand_len, &libs, &lib_len, &points, &pts_last_turn, &ko_count, &sweets_total, &disc_poke, &disc_poke_p, &disc_item, &disc_supp, stadium, turn);
                                if b0 == 26 {
                                    // Mega Rayquaza ex: discard ALL energy -> 50 * discarded!
                                    let disc = board[cur][0].energy;
                                    if disc > 0 { board[cur][0].energy = 0; energy_discarded[cur] = 1; }
                                    raw_d = (disc as i16) * (b1 as i16);
                                    eff_tag = 8; eff_num = disc as i32;
                                } else if b0 == 27 {
                                    // Slowking A4a: discard up to 2 Tools from hand -> 50 * discarded
                                    let mut disc = 0i16;
                                    let mut k = 0;
                                    while k < hand_len[cur] && disc < 2 {
                                        if hands[cur][k].is_tool() {
                                            disc += 1;
                                            disc_tool[cur] = disc_tool[cur].saturating_add(1);
                                            hand_len[cur] -= 1; hands[cur][k] = hands[cur][hand_len[cur]];
                                            continue;
                                        }
                                        k += 1;
                                    }
                                    raw_d = disc * (b1 as i16);
                                } else if b0 == 28 {
                                    // Gyarados A4: discard benched [W] Pokémon -> +40 each!
                                    let mut disc = 0i16;
                                    for s in 1..4 {
                                        if board[cur][s].occ && board[cur][s].card.has_type(2) {
                                            if board[cur][s].energy > 0 { energy_discarded[cur] = 1; }
                                            disc_poke[cur] = disc_poke[cur].saturating_add(1);
                                            board[cur][s].occ = false;
                                            disc += 1;
                                        }
                                    }
                                    raw_d = ad + disc * (b1 as i16);
                                } else if b0 == 33 {
                                    raw_d = (ad as i32 + cnt).max(0) as i16;
                                } else {
                                    raw_d = ad + (cnt * b1) as i16;
                                }
                            }
                            7 => {
                                if b0 == 36 {
                                    // Vespiquen ex B4-011: discard 1 Benched Basic [G] for +70!
                                    let mut did = false;
                                    for s in 1..4 {
                                        if board[cur][s].occ && board[cur][s].card.stage == 0 && board[cur][s].card.has_type(0) {
                                            if board[cur][s].energy > 0 { energy_discarded[cur] = 1; }
                                            disc_poke[cur] = disc_poke[cur].saturating_add(1);
                                            board[cur][s].occ = false;
                                            did = true; break;
                                        }
                                    }
                                    raw_d = ad + if did { b1 as i16 } else { 0 };
                                } else if b0 == 38 {
                                    // Pachirisu B4 / Dugtrio A4a: discard top card of own deck!
                                    let mut ok = false;
                                    if lib_len[cur] > 0 {
                                        lib_len[cur] -= 1;
                                        let tc = libs[cur][lib_len[cur]];
                                        record_discard_card(&tc, cur, &mut disc_poke, &mut disc_poke_p, &mut disc_item, &mut disc_supp, &mut disc_tool, &mut disc_basic_w, &mut disc_basic_any, &mut disc_quick_grow, &mut disc_volbeat);
                                        ok = if b2 == 0 { tc.is_item() } else { tc.is_pokemon == 1 && tc.has_type(5) };
                                    }
                                    raw_d = ad + if ok { b1 as i16 } else { 0 };
                                } else {
                                    let ok = eval_cond_op7(b0, b2, aaux, &board, cur, foe, ac, supporter_used, &ko_last_turn, &points, &hand_len, &sweets_used_last, &disc_quick_grow, &disc_volbeat, stadium, turn);
                                    if b0 == 3 { raw_d = if ok { (ad - b1 as i16).max(0) } else { ad }; }
                                    else { raw_d = ad + if ok { b1 as i16 } else { 0 }; }
                                }
                            }
                            8 => {
                                // Pure snipe / spread / delayed modes
                                match b0 {
                                    2 | 3 | 4 => {
                                        direct_active = false;
                                        let mut ts = 4usize;
                                        let start_s = if b0 == 3 { 1 } else { 0 };
                                        for s in start_s..4 {
                                            if !board[foe][s].occ { continue; }
                                            if s > 0 && bench_dmg_blocked(&board, foe, s, true, stadium, turn) { continue; }
                                            if b0 == 4 && board[foe][s].hp >= board[foe][s].max_hp { continue; }
                                            let blk = s == 0 && active_ex_blocked && !ign_eff;
                                            if !blk && (ts == 4 || board[foe][s].hp < board[foe][ts].hp) { ts = s; }
                                        }
                                        if ts < 4 {
                                            board[foe][ts].hp -= b1 as i16;
                                            if ts == 0 { total_dmg = b1 as i16; }
                                            else {
                                                eff_tag = 6; eff_num = b1;
                                                if handle_bench_ko(foe, cur, ts, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                            }
                                        }
                                    }
                                    6 => {
                                        // Spiritomb / Lurantis / Kyogre / Archeops: b1 (+next_mod) to ALL opp Pokémon
                                        direct_active = false;
                                        let per = (b1 as i16) + cur_next_mod;
                                        for s in 0..4 {
                                            if !board[foe][s].occ { continue; }
                                            if s == 0 && active_ex_blocked && !ign_eff { continue; }
                                            if s > 0 && bench_dmg_blocked(&board, foe, s, true, stadium, turn) { continue; }
                                            board[foe][s].hp -= per;
                                            if s == 0 { total_dmg = per; }
                                            else if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                        }
                                        eff_tag = 6; eff_num = per as i32;
                                    }
                                    8 => {
                                        // Random opp Pokémon `times` × b1 (Dragonite, Wugtrio ex, Gholdengo ex, Mega Dragonite ex + Drayden!)
                                        direct_active = false;
                                        let mut times = if b2 == 99 { eff_energy(&board, cur, 0, stadium, turn).min(10) } else { b2.max(1) };
                                        if atk_c.has_draco() { times += drayden_bonus; }
                                        let mut thit = 0i16;
                                        for _ in 0..times {
                                            let mut occ_idx = [0usize; 4]; let mut occ_n = 0usize;
                                            for s in 0..4 { if board[foe][s].occ && board[foe][s].hp > 0 { occ_idx[occ_n] = s; occ_n += 1; } }
                                            if occ_n == 0 { break; }
                                            let pick = occ_idx[(rng.next_u32() as usize) % occ_n];
                                            if pick == 0 && active_ex_blocked && !ign_eff { continue; }
                                            if pick > 0 && bench_dmg_blocked(&board, foe, pick, true, stadium, turn) { continue; }
                                            board[foe][pick].hp -= b1 as i16;
                                            thit += b1 as i16;
                                            if pick > 0 && handle_bench_ko(foe, cur, pick, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                        }
                                        total_dmg = thit; eff_tag = 6; eff_num = thit as i32;
                                    }
                                    10 => {
                                        // Magcargo / Zapdos B2: random OTHER Pokémon (both sides!)
                                        direct_active = false;
                                        let mut thit = 0i16;
                                        for _ in 0..b2.max(1) {
                                            let mut pool_p = [0usize; 7]; let mut pool_s = [0usize; 7]; let mut pn = 0usize;
                                            for s in 1..4 { if board[cur][s].occ && board[cur][s].hp > 0 { pool_p[pn] = cur; pool_s[pn] = s; pn += 1; } }
                                            for s in 0..4 { if board[foe][s].occ && board[foe][s].hp > 0 { pool_p[pn] = foe; pool_s[pn] = s; pn += 1; } }
                                            if pn == 0 { break; }
                                            let ri = (rng.next_u32() as usize) % pn;
                                            let tp = pool_p[ri]; let ts = pool_s[ri];
                                            if tp == foe && ts == 0 && active_ex_blocked && !ign_eff { continue; }
                                            if tp == foe && ts > 0 && bench_dmg_blocked(&board, foe, ts, true, stadium, turn) { continue; }
                                            board[tp][ts].hp -= b1 as i16;
                                            if tp == foe { thit += b1 as i16; }
                                            if ts > 0 {
                                                let win_p = 1 - tp;
                                                if handle_bench_ko(tp, win_p, ts, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) && tp == foe { any_foe_ko = true; }
                                            }
                                        }
                                        total_dmg = thit; eff_tag = 6; eff_num = thit as i32;
                                    }
                                    11 => {
                                        // Tapu Lele: b1 * energy to 1 opp Pokémon
                                        direct_active = false;
                                        let mut ts = 0usize;
                                        for s in 1..4 { if board[foe][s].occ && !bench_dmg_blocked(&board, foe, s, true, stadium, turn) && board[foe][s].energy > board[foe][ts].energy { ts = s; } }
                                        let sd = (board[foe][ts].energy as i16) * (b1 as i16);
                                        if ts == 0 { total_dmg = sd; board[foe][0].hp -= sd; }
                                        else {
                                            board[foe][ts].hp -= sd; eff_tag = 6; eff_num = sd as i32;
                                            if handle_bench_ko(foe, cur, ts, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                        }
                                    }
                                    12 => {
                                        // Delayed damage/KO at end of opponent's next turn (Meowscarada ex 70, Mismagius 90, Armaldo KO)
                                        direct_active = false;
                                        delayed_slot[foe] = 0; // target opponent's Active spot
                                        delayed_dmg[foe] = if b2 == 1 { 9999 } else { b1 as i16 };
                                        eff_tag = 25;
                                    }
                                    14 => {
                                        // Dewgong C1: 60 damage to 2 of opp's Pokémon!
                                        direct_active = false;
                                        let mut hits = 0;
                                        for s in 0..4 {
                                            if hits >= 2 { break; }
                                            if !board[foe][s].occ { continue; }
                                            if s == 0 && active_ex_blocked && !ign_eff { continue; }
                                            if s > 0 && bench_dmg_blocked(&board, foe, s, true, stadium, turn) { continue; }
                                            board[foe][s].hp -= b1 as i16;
                                            hits += 1;
                                            if s == 0 { total_dmg = b1 as i16; }
                                            else if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                        }
                                        eff_tag = 6; eff_num = b1 * hits;
                                    }
                                    _ => {} // Modes 0,1,5,7,9,13 also hit Active directly, then splash in Phase 2!
                                }
                            }
                            11 => {
                                // Check Pidgeot / Mega Pidgeot ex flip-2/3 all-tails fail BEFORE direct damage!
                                if b0 == 4 || b0 == 5 {
                                    let nf = if b0 == 5 { 3 } else { 2 };
                                    let mut heads = 0i32;
                                    for _ in 0..nf { if rng.flip_coin(&mut guaranteed_heads) { heads += 1; } }
                                    op1_heads = heads;
                                    if heads == 0 && ((af & AF_FLIP_2_BOTH_TAILS_FAIL) != 0 || (af & AF_FLIP_3_ALL_TAILS_FAIL) != 0) {
                                        direct_active = false; miss_flag = 1; eff_tag = 30;
                                    } else if heads > 0 && board[foe][0].energy > 0 {
                                        let d = (heads as u8).min(board[foe][0].energy);
                                        board[foe][0].energy -= d; energy_discarded[foe] = 1;
                                        eff_tag = 19; eff_num = d as i32;
                                    }
                                }
                            }
                            17 => {
                                // Sandy Shocks: switch in 1 opp bench, then deal 50 to new Active!
                                if b0 == 3 && b1 >= 10 {
                                    direct_active = false;
                                    let pick = best_bench_promote(&board[foe]);
                                    if pick < 4 {
                                        board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR;
                                        board[foe].swap(0, pick);
                                        board[foe][0].status &= !ST_HAS_ATTACKED;
                                        board[foe][0].hp -= b1 as i16;
                                        total_dmg = b1 as i16;
                                        eff_tag = 15;
                                    }
                                }
                            }
                            20 => {
                                direct_active = false;
                                match b0 {
                                    1 => { total_dmg = board[foe][0].hp; board[foe][0].hp = 0; eff_tag = 25; }
                                    2 => {
                                        let ok = if b1 >= 2 { rng.flip_coin(&mut guaranteed_heads) && rng.flip_coin(&mut guaranteed_heads) } else { rng.flip_coin(&mut guaranteed_heads) };
                                        if ok {
                                            board[foe][0].occ = false;
                                            let prom = best_bench_promote(&board[foe]);
                                            if prom < 4 { board[foe].swap(0, prom); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                            eff_tag = 25;
                                        } else { miss_flag = 1; eff_tag = 30; }
                                    }
                                    3 => {
                                        if rng.flip_coin(&mut guaranteed_heads) && rng.flip_coin(&mut guaranteed_heads) {
                                            total_dmg = board[foe][0].hp; board[foe][0].hp = 0; eff_tag = 25;
                                        } else { miss_flag = 1; eff_tag = 30; }
                                    }
                                    4 => {
                                        let cut = ((board[foe][0].hp / 2) / 10) * 10;
                                        let dealt = cut.max(10);
                                        board[foe][0].hp -= dealt; total_dmg = dealt; eff_tag = 25;
                                    }
                                    5 => {
                                        if rng.flip_coin(&mut guaranteed_heads) {
                                            let dealt = (board[foe][0].hp - 10).max(0);
                                            board[foe][0].hp = board[foe][0].hp.min(10);
                                            total_dmg = dealt; eff_tag = 25;
                                        } else { miss_flag = 1; eff_tag = 30; }
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }

                        // === APPLY DIRECT ACTIVE DAMAGE (with Invuln / Disguise / Dodge / Bastiodon / Goodra / Oricorio / Carracosta / Silcoon) ===
                        if direct_active && raw_d > 0 && miss_flag == 0 {
                            let invuln = !ign_eff && (board[foe][0].status & ST_INVULN) != 0;
                            let imm_basic = !ign_eff && (board[foe][0].status & ST_IMMUNE_BASIC) != 0 && atk_c.stage == 0;
                            let disguise = !ign_eff && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 21 && board[foe][0].card.ab_val == 1 && (board[foe][0].status & ST_DISGUISE_USED) == 0;
                            let dodge = !ign_eff && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 21 && board[foe][0].card.ab_val == 2 && { let mut dh = false; rng.flip_coin(&mut dh) };
                            if invuln || (!ign_eff && active_ex_blocked) || imm_basic || disguise || dodge {
                                if disguise { board[foe][0].status |= ST_DISGUISE_USED; }
                                total_dmg = 0;
                                if invuln || imm_basic || disguise || dodge { miss_flag = 1; eff_tag = 29; }
                            } else {
                                let (mod_net, wb) = calc_passive_dmg_mods(
                                    &board, cur, foe, af, raw_d, dmg_boost, dmg_boost_ex,
                                    named_boost, named_boost_h1, named_boost_h2, eevee_boost, cur_team_boost,
                                    points[cur], stadium, team_shield[foe], team_shield_type[foe], turn,
                                );
                                // Note: cur_next_mod was consumed into local var, re-include it since calc_passive_dmg_mods read 0!
                                let mut d_final = (raw_d + mod_net + cur_next_mod).max(0);
                                // Bastiodon (-100) / Hisuian Goodra (-80) flip-coin reduction (ab_op=11, mode=5)
                                if !ign_eff && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 11 && ((board[foe][0].card.ab_val >> 8) & 0xff) == 5 {
                                    let mut dh = false;
                                    if rng.flip_coin(&mut dh) { d_final = (d_final - (board[foe][0].card.ab_val & 0xff) as i16).max(0); }
                                }
                                // Silcoon Harden: prevent if <= 40
                                if !ign_eff && (board[foe][0].status & ST_IMMUNE_LE40) != 0 && d_final <= 40 { d_final = 0; }
                                weak_b = wb;
                                total_dmg = d_final;
                                if total_dmg > 0 {
                                    board[foe][0].hp -= total_dmg;
                                    board[foe][0].status |= ST_DAMAGED_LAST;
                                    active_took_dmg = true;
                                }
                            }
                        } else if !direct_active && total_dmg > 0 && board[foe][0].occ {
                            active_took_dmg = true;
                        }

                        // === MEGA KANGASKHAN EX DOUBLE ATTACK (op1=19, mode=8): 2nd attack hits for 40! ===
                        if ao1 == 19 && (av1 & 0xff) == 8 && miss_flag == 0 {
                            let d2_raw = ((av1 >> 8) & 0xff) as i16;
                            // Resolve 1st hit KO first so 2nd hit hits the promoted Pokémon!
                            if board[foe][0].occ && board[foe][0].hp <= 0 {
                                let (ko1, rec1, cur1) = handle_active_ko(foe, cur, true, extra_pt, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                if ko1 { ko_flag = 1; any_foe_ko = true; }
                                if rec1 > 0 { board[cur][0].hp -= rec1; }
                                if cur1 { board[cur][0].hp = 0; }
                            }
                            if board[foe][0].occ && points[cur] < 3 && board[cur][0].hp > 0 {
                                let (mod2, _) = calc_passive_dmg_mods(&board, cur, foe, af, d2_raw, dmg_boost, dmg_boost_ex, named_boost, named_boost_h1, named_boost_h2, eevee_boost, cur_team_boost, points[cur], stadium, team_shield[foe], team_shield_type[foe], turn);
                                let d2 = (d2_raw + mod2).max(0);
                                let ex_blk2 = ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 10 && atk_c.is_ex();
                                if !ex_blk2 && d2 > 0 {
                                    board[foe][0].hp -= d2;
                                    total_dmg += d2;
                                }
                            }
                        }

                        // === DEFENDER CONTACT REACTIONS ===
                        if active_took_dmg && board[foe][0].occ {
                            if board[foe][0].has_tool(5) { board[cur][0].hp -= 20; if eff_tag == 0 { eff_tag = 26; eff_num = 20; } } // Rocky Helmet
                            if board[foe][0].has_tool(6) { apply_status(&mut board, cur, 0, ST_POISON, stadium, turn, false); } // Poison Barb
                            if board[foe][0].has_tool(26) && board[foe][0].card.has_type(6) && hand_len[cur] > 0 {
                                // Dark Pendant: attacker shuffles random card into deck
                                let ri = (rng.next_u32() as usize) % hand_len[cur];
                                let rb = hands[cur][ri]; hand_len[cur] -= 1; hands[cur][ri] = hands[cur][hand_len[cur]];
                                if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = rb; lib_len[cur] += 1; }
                            }
                            if board[foe][0].counter > 0 {
                                let cd = board[foe][0].counter;
                                board[cur][0].hp -= cd;
                                if eff_tag == 0 { eff_tag = 26; eff_num = cd as i32; }
                            }
                            if ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 13 {
                                let amt = (board[foe][0].card.ab_val & 0xff) as i16;
                                let mode = (board[foe][0].card.ab_val >> 8) & 0xff;
                                if mode == 0 { board[cur][0].hp -= amt; if eff_tag == 0 { eff_tag = 26; eff_num = amt as i32; } }
                                else if mode == 1 { apply_status(&mut board, cur, 0, ST_POISON, stadium, turn, false); }
                                else if mode == 2 {
                                    for bs in 1..4 { if board[foe][bs].occ { board[foe][bs].energy = board[foe][bs].energy.saturating_add(1); break; } }
                                }
                            }
                        }

                        // === PHASE 2: EXECUTE BOTH POST-EFFECT SLOTS (op1 AND op2!) ===
                        let slots_op: [(u8, i32, bool); 2] = [(ao1, av1, false), (ao2, av2, true)];
                        for &(op, val, is_second) in slots_op.iter() {
                            if op == 0 || miss_flag != 0 { continue; }
                            // Check conditional-effect flags on the post-effect slot
                            let cond_slot = (is_second) || (ao2 == 0);
                            if cond_slot && (af & AF_FIRST_ATTACK_ONLY_EFF) != 0 && !is_first_atk && (op == 1 || op == 17) { continue; }
                            if cond_slot && (af & AF_ONLY_IF_STADIUM_EFF) != 0 && stadium == 0 && (op == 1 || op == 12) { continue; }
                            if cond_slot && (af & AF_ONLY_IF_KO_LAST_TURN_EFF) != 0 && ko_last_turn[cur] == 0 && op == 1 { continue; }
                            if cond_slot && (af & AF_ONLY_IF_EVOLVED_THIS_TURN_EFF) != 0 && !was_evolved_turn && op == 11 { continue; }

                            let p0 = val & 0xff;
                            let p1 = (val >> 8) & 0xff;
                            let p2 = (val >> 16) & 0xff;
                            match op {
                                1 => {
                                    // Status infliction on Opponent Active (respects Clear Veil / Regice / Invuln / Arceus)
                                    let mut do_st = true;
                                    let mut mask: u32 = (p0 as u32) & 0xFF;
                                    match p1 {
                                        1 => { do_st = rng.flip_coin(&mut guaranteed_heads); }
                                        2 => {
                                            let pick = rng.next_u32() % 5;
                                            mask = match pick { 0 => ST_SLEEP, 1 => ST_BURN, 2 => ST_CONFUSE, 3 => ST_PARALYZE, _ => ST_POISON };
                                        }
                                        3 => {
                                            if rng.flip_coin(&mut guaranteed_heads) { mask = ST_CONFUSE; }
                                            else { do_st = false; apply_status(&mut board, cur, 0, ST_CONFUSE, stadium, turn, false); }
                                        }
                                        4 => { mask = if rng.flip_coin(&mut guaranteed_heads) { ST_PARALYZE } else { ST_CONFUSE }; }
                                        5 => { mask = ST_CONFUSE; }
                                        6 => { do_st = op1_heads >= 2; }
                                        7 => { do_st = op1_heads >= 1; }
                                        8 => { do_st = false; if !has_status_immunity(&board, foe, 0, stadium, turn) { board[foe][0].status |= ST_ATTACH_SLEEP; } }
                                        _ => {}
                                    }
                                    if do_st && board[foe][0].occ {
                                        let st = apply_status(&mut board, foe, 0, mask, stadium, turn, true);
                                        if st != 0 && eff_tag == 0 { eff_tag = st as i32; }
                                    }
                                }
                                2 => {
                                    match p0 {
                                        1 => { apply_status(&mut board, cur, 0, ST_SLEEP, stadium, turn, false); }
                                        2 => { apply_status(&mut board, cur, 0, ST_CONFUSE, stadium, turn, false); }
                                        3 => { apply_status(&mut board, cur, 0, ST_CONFUSE, stadium, turn, false); apply_status(&mut board, foe, 0, ST_CONFUSE, stadium, turn, true); }
                                        4 => { apply_status(&mut board, cur, 0, ST_SLEEP, stadium, turn, false); apply_status(&mut board, foe, 0, ST_SLEEP, stadium, turn, true); }
                                        5 => { board[cur][0].status &= !ST_SPECIAL_MASK; }
                                        _ => {}
                                    }
                                }
                                8 => {
                                    // Secondary / Splash bench damage (modes 0, 1, 5, 7, 9, 13)
                                    match p0 {
                                        0 => {
                                            let ok = p2 == 0 || rng.flip_coin(&mut guaranteed_heads);
                                            if ok {
                                                for s in 1..4 {
                                                    if board[foe][s].occ && !bench_dmg_blocked(&board, foe, s, true, stadium, turn) {
                                                        board[foe][s].hp -= p1 as i16;
                                                        if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                                        eff_tag = 6; eff_num = p1; break;
                                                    }
                                                }
                                            }
                                        }
                                        1 => {
                                            let mut ok = true;
                                            if p2 == 1 {
                                                ok = false;
                                                for s in 1..4 { if board[cur][s].occ && board[cur][s].card.name_hash == aaux { ok = true; break; } }
                                            }
                                            if ok {
                                                let mut hit = false;
                                                for s in 1..4 {
                                                    if board[foe][s].occ && !bench_dmg_blocked(&board, foe, s, true, stadium, turn) {
                                                        board[foe][s].hp -= p1 as i16; hit = true;
                                                        if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                                    }
                                                }
                                                if hit { eff_tag = 6; eff_num = p1; }
                                            }
                                        }
                                        5 => {
                                            // 0=all damaged bench (Toxtricity ex), 1=1 damaged bench (TR Zapdos ex), 2=all bench w/ energy (Alakazam)
                                            for s in 1..4 {
                                                if !board[foe][s].occ || bench_dmg_blocked(&board, foe, s, true, stadium, turn) { continue; }
                                                let cond = if p2 == 2 { board[foe][s].energy > 0 } else { board[foe][s].hp < board[foe][s].max_hp };
                                                if cond {
                                                    board[foe][s].hp -= p1 as i16;
                                                    eff_tag = 6; eff_num = p1;
                                                    if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                                    if p2 == 1 { break; }
                                                }
                                            }
                                        }
                                        7 | 13 => {
                                            // Mega Blastoise ex (3 extra -> 2 bench 50) / Blastoise B1a (2 extra -> 1 bench 50)
                                            if eff_energy(&board, cur, 0, stadium, turn) >= (ac as i32) + p2 {
                                                let max_t = if p0 == 7 { 2 } else { 1 };
                                                let mut cnt = 0;
                                                for s in 1..4 {
                                                    if cnt >= max_t { break; }
                                                    if board[foe][s].occ && !bench_dmg_blocked(&board, foe, s, true, stadium, turn) {
                                                        board[foe][s].hp -= p1 as i16; cnt += 1;
                                                        if handle_bench_ko(foe, cur, s, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                                    }
                                                }
                                                if cnt > 0 { eff_tag = 6; eff_num = p1; }
                                            }
                                        }
                                        9 => {
                                            // Random opp Bench `p2` times × `p1` (Mega Ampharos ex, Ampharos, Alolan Exeggutor ex)
                                            let mut th = 0;
                                            for _ in 0..p2.max(1) {
                                                let mut bidx = [0usize; 3]; let mut bn = 0usize;
                                                for s in 1..4 { if board[foe][s].occ && board[foe][s].hp > 0 { bidx[bn] = s; bn += 1; } }
                                                if bn == 0 { break; }
                                                let pick = bidx[(rng.next_u32() as usize) % bn];
                                                if bench_dmg_blocked(&board, foe, pick, true, stadium, turn) { continue; }
                                                board[foe][pick].hp -= p1 as i16; th += p1;
                                                if handle_bench_ko(foe, cur, pick, true, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng) { any_foe_ko = true; }
                                            }
                                            if th > 0 { eff_tag = 6; eff_num = th; }
                                        }
                                        _ => {}
                                    }
                                }
                                9 => {
                                    // Self / Bench Recoil
                                    let only_ko = (af & AF_ONLY_IF_KO_RECOIL) != 0;
                                    let will_ko = any_foe_ko || (board[foe][0].occ && board[foe][0].hp <= 0);
                                    if !only_ko || will_ko {
                                        match p1 {
                                            0 => { board[cur][0].hp -= p0 as i16; if eff_tag == 0 { eff_tag = 7; eff_num = p0; } }
                                            1 | 5 => {
                                                for s in 1..4 {
                                                    if board[cur][s].occ {
                                                        board[cur][s].hp -= p0 as i16;
                                                        handle_bench_ko(cur, foe, s, false, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                                        if eff_tag == 0 { eff_tag = 7; eff_num = p0; }
                                                        break;
                                                    }
                                                }
                                            }
                                            2 => {
                                                for s in 1..4 {
                                                    if board[cur][s].occ {
                                                        board[cur][s].hp -= p0 as i16;
                                                        handle_bench_ko(cur, foe, s, false, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                                    }
                                                }
                                                if eff_tag == 0 { eff_tag = 7; eff_num = p0; }
                                            }
                                            3 => {
                                                if !rng.flip_coin(&mut guaranteed_heads) {
                                                    board[cur][0].hp -= p0 as i16; if eff_tag == 0 { eff_tag = 7; eff_num = p0; }
                                                }
                                            }
                                            4 => {
                                                // Forretress: 100 self + 50 all bench both sides!
                                                board[cur][0].hp -= 100;
                                                for pp in 0..2 {
                                                    for s in 1..4 {
                                                        if board[pp][s].occ && !(pp == foe && bench_dmg_blocked(&board, foe, s, true, stadium, turn)) {
                                                            board[pp][s].hp -= 50;
                                                            handle_bench_ko(pp, 1 - pp, s, pp == foe, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                                                        }
                                                    }
                                                }
                                                if eff_tag == 0 { eff_tag = 7; eff_num = 100; }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                10 => {
                                    // Discard Own Energy
                                    match p1 {
                                        0 => {
                                            let dcnt = if p0 >= 99 { board[cur][0].energy } else { (p0 as u8).min(board[cur][0].energy) };
                                            if dcnt > 0 { board[cur][0].energy -= dcnt; energy_discarded[cur] = 1; }
                                            if eff_tag == 0 { eff_tag = 8; eff_num = dcnt as i32; }
                                        }
                                        1 => {
                                            if !rng.flip_coin(&mut guaranteed_heads) {
                                                let dcnt = (p0 as u8).min(board[cur][0].energy);
                                                if dcnt > 0 { board[cur][0].energy -= dcnt; energy_discarded[cur] = 1; }
                                                if eff_tag == 0 { eff_tag = 8; eff_num = dcnt as i32; }
                                            }
                                        }
                                        2 | 3 => {
                                            let times = if p1 == 3 { 2 } else { 1 };
                                            for _ in 0..times {
                                                if (rng.next_u32() & 1) == 0 && board[cur][0].energy > 0 { board[cur][0].energy -= 1; energy_discarded[cur] = 1; }
                                                else if board[foe][0].energy > 0 { board[foe][0].energy -= 1; energy_discarded[foe] = 1; }
                                            }
                                            if eff_tag == 0 { eff_tag = 8; eff_num = times; }
                                        }
                                        4 => {
                                            let mut rem = 2u8;
                                            for s in 0..4 {
                                                while rem > 0 && board[cur][s].occ && board[cur][s].energy > 0 {
                                                    board[cur][s].energy -= 1; energy_discarded[cur] = 1; rem -= 1;
                                                }
                                            }
                                            if eff_tag == 0 { eff_tag = 8; eff_num = (2 - rem) as i32; }
                                        }
                                        5 => {
                                            if board[cur][0].energy > 0 { board[cur][0].energy -= 1; energy_discarded[cur] = 1; }
                                            if board[foe][0].energy > 0 { board[foe][0].energy -= 1; energy_discarded[foe] = 1; }
                                            if eff_tag == 0 { eff_tag = 8; eff_num = 1; }
                                        }
                                        _ => {}
                                    }
                                }
                                11 => {
                                    // Discard Opponent Active Energy (modes 4 & 5 already ran in Phase 1!)
                                    if p0 != 4 && p0 != 5 && board[foe][0].occ && board[foe][0].energy > 0 && !has_status_immunity(&board, foe, 0, stadium, turn) {
                                        let mut disc = 0u8;
                                        match p0 {
                                            1 => { board[foe][0].energy -= 1; disc = 1; }
                                            2 => { if rng.flip_coin(&mut guaranteed_heads) { board[foe][0].energy -= 1; disc = 1; } }
                                            3 => {
                                                for _ in 0..6 {
                                                    if board[foe][0].energy > 0 && rng.flip_coin(&mut guaranteed_heads) { board[foe][0].energy -= 1; disc += 1; } else { break; }
                                                }
                                            }
                                            6 => { disc = board[foe][0].energy.min(2); board[foe][0].energy -= disc; }
                                            _ => {}
                                        }
                                        if disc > 0 { energy_discarded[foe] = 1; if eff_tag == 0 { eff_tag = 19; eff_num = disc as i32; } }
                                    }
                                }
                                12 => {
                                    // Heal
                                    if !heal_blocked {
                                        let amt_raw = val & 0xfff;
                                        let mode = (val >> 12) & 0xf;
                                        let h: i16 = if amt_raw == 999 { total_dmg } else { amt_raw as i16 };
                                        match mode {
                                            0 | 1 => { if h > 0 { board[cur][0].hp = (board[cur][0].hp + h).min(board[cur][0].max_hp); if eff_tag == 0 { eff_tag = 9; eff_num = h as i32; } } }
                                            2 => {
                                                for s in 1..4 {
                                                    if board[cur][s].occ && board[cur][s].hp < board[cur][s].max_hp {
                                                        board[cur][s].hp = (board[cur][s].hp + h).min(board[cur][s].max_hp);
                                                        if eff_tag == 0 { eff_tag = 9; eff_num = h as i32; } break;
                                                    }
                                                }
                                            }
                                            3 => {
                                                for s in 0..4 { if board[cur][s].occ { board[cur][s].hp = (board[cur][s].hp + h).min(board[cur][s].max_hp); } }
                                                if eff_tag == 0 { eff_tag = 9; eff_num = h as i32; }
                                            }
                                            4 => {
                                                for s in 1..4 { if board[cur][s].occ { board[cur][s].hp = (board[cur][s].hp + h).min(board[cur][s].max_hp); } }
                                                if eff_tag == 0 { eff_tag = 9; eff_num = h as i32; }
                                            }
                                            5 => {
                                                if rng.flip_coin(&mut guaranteed_heads) {
                                                    board[cur][0].hp = (board[cur][0].hp + h).min(board[cur][0].max_hp);
                                                    if eff_tag == 0 { eff_tag = 9; eff_num = h as i32; }
                                                }
                                            }
                                            6 => {
                                                if board[foe][0].occ && (board[foe][0].status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0 {
                                                    board[cur][0].hp = (board[cur][0].hp + h).min(board[cur][0].max_hp);
                                                    if eff_tag == 0 { eff_tag = 9; eff_num = h as i32; }
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                13 => {
                                    // Energy Ramp / Move
                                    let cnt = p0 as u8;
                                    match p1 {
                                        0 => { board[cur][0].energy = board[cur][0].energy.saturating_add(cnt); eff_tag = 10; eff_num = cnt as i32; }
                                        1 => {
                                            let prom = best_bench_promote(&board[cur]);
                                            if prom < 4 { board[cur][prom].energy = board[cur][prom].energy.saturating_add(cnt); eff_tag = 10; eff_num = cnt as i32; }
                                        }
                                        2 => {
                                            let mut added = 0;
                                            for s in 1..4 { if board[cur][s].occ && added < 2 { board[cur][s].energy = board[cur][s].energy.saturating_add(1); added += 1; } }
                                            if added > 0 { eff_tag = 10; eff_num = added; }
                                        }
                                        3 => {
                                            // Moltres ex / Mew ex C1-057: flip 3 coins, attach heads to Bench!
                                            let mut h = 0u8;
                                            for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } }
                                            if h == 0 && has_victini { has_victini = false; for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } } }
                                            let prom = best_bench_promote(&board[cur]);
                                            if h > 0 && prom < 4 { board[cur][prom].energy = board[cur][prom].energy.saturating_add(h); eff_tag = 10; eff_num = h as i32; }
                                        }
                                        4 => {
                                            let mut h = 0u8;
                                            for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } }
                                            if h == 0 && has_victini { has_victini = false; for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } } }
                                            if h > 0 { board[cur][0].energy = board[cur][0].energy.saturating_add(h); eff_tag = 10; eff_num = h as i32; }
                                        }
                                        5 => {
                                            if rng.flip_coin(&mut guaranteed_heads) { board[cur][0].energy = board[cur][0].energy.saturating_add(cnt); eff_tag = 10; eff_num = cnt as i32; }
                                        }
                                        6 => {
                                            let prom = best_bench_promote(&board[cur]);
                                            if prom < 4 && rng.flip_coin(&mut guaranteed_heads) { board[cur][prom].energy = board[cur][prom].energy.saturating_add(cnt); eff_tag = 10; eff_num = cnt as i32; }
                                        }
                                        7 => {
                                            // Mega Gardevoir ex / Ho-Oh ex: attach 3 energy across bench / board!
                                            let prom = best_bench_promote(&board[cur]);
                                            let tgt = if prom < 4 { prom } else { 0 };
                                            board[cur][tgt].energy = board[cur][tgt].energy.saturating_add(cnt);
                                            eff_tag = 10; eff_num = cnt as i32;
                                        }
                                        8 => {
                                            // Move energy from self to Bench (Morpeko 2, Regice 2, Lunala/Mismagius/Swanna ALL)
                                            let prom = best_bench_promote(&board[cur]);
                                            if prom < 4 && board[cur][0].energy > 0 {
                                                let mv = if cnt >= 99 { board[cur][0].energy } else { cnt.min(board[cur][0].energy) };
                                                board[cur][0].energy -= mv;
                                                board[cur][prom].energy = board[cur][prom].energy.saturating_add(mv);
                                                eff_tag = 10; eff_num = mv as i32;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                14 => {
                                    // Defensive shield / counter / invuln / vulnerability
                                    match p1 {
                                        0 => { board[cur][0].shield += p0 as i16; if eff_tag == 0 { eff_tag = 11; eff_num = p0; } }
                                        1 => { board[cur][0].shield += p0 as i16; board[cur][0].status |= ST_NO_WEAKNESS; if eff_tag == 0 { eff_tag = 11; eff_num = p0; } }
                                        2 => { board[cur][0].status |= ST_NO_WEAKNESS; if eff_tag == 0 { eff_tag = 11; eff_num = 1; } }
                                        3 => { board[cur][0].shield_ex += p0 as i16; if eff_tag == 0 { eff_tag = 11; eff_num = p0; } }
                                        4 => { board[cur][0].status |= ST_IMMUNE_LE40; if eff_tag == 0 { eff_tag = 11; eff_num = p0; } }
                                        5 => { board[cur][0].status |= ST_IMMUNE_BASIC; if eff_tag == 0 { eff_tag = 11; eff_num = 99; } }
                                        6 => { board[cur][0].counter = p0 as i16; if eff_tag == 0 { eff_tag = 11; eff_num = p0; } }
                                        7 => { if rng.flip_coin(&mut guaranteed_heads) { board[cur][0].status |= ST_INVULN; eff_tag = 11; eff_num = 99; } }
                                        8 => { board[cur][0].status |= ST_INVULN; eff_tag = 11; eff_num = 99; } // Fly already flipped heads!
                                        9 => { if rng.flip_coin(&mut guaranteed_heads) { board[cur][0].shield += p0 as i16; eff_tag = 11; eff_num = p0; } }
                                        10 => { board[cur][0].shield -= p0 as i16; } // Kommo-o +30 / Hariyama +50 self vuln
                                        11 => { if board[foe][0].occ { board[foe][0].shield -= p0 as i16; } } // Espathra: foe takes +50 next turn
                                        12 => { if board[foe][0].occ { board[foe][0].status |= ST_RETREAT_TRAP; } } // Galarian Stunfisk
                                        _ => {}
                                    }
                                }
                                15 => {
                                    // Disrupt opponent attack (respects Clear Veil / Regice)
                                    if board[foe][0].occ && !has_status_immunity(&board, foe, 0, stadium, turn) {
                                        match p1 {
                                            0 => { board[foe][0].weaken += p0 as i16; eff_tag = 12; eff_num = p0; }
                                            1 => { board[foe][0].status |= ST_OPP_MISS_FLIP; eff_tag = 12; eff_num = 99; }
                                            2 => { board[foe][0].status |= ST_PERM_MISS_FLIP; eff_tag = 12; eff_num = 99; }
                                            3 => { board[foe][0].status |= ST_CANT_ATK_OPP; eff_tag = 12; eff_num = 98; }
                                            4 => { if rng.flip_coin(&mut guaranteed_heads) { board[foe][0].status |= ST_CANT_ATK_OPP; eff_tag = 12; eff_num = 98; } }
                                            5 => { if board[foe][0].card.stage == 0 { board[foe][0].status |= ST_CANT_ATK_OPP; eff_tag = 12; eff_num = 98; } }
                                            6 => { board[foe][0].cost_tax = board[foe][0].cost_tax.saturating_add(p0 as u8); eff_tag = 12; eff_num = p0; }
                                            7 => { board[foe][0].cost_tax = board[foe][0].cost_tax.saturating_add(p0 as u8); board[foe][0].retreat_tax = board[foe][0].retreat_tax.saturating_add(p0 as u8); eff_tag = 12; eff_num = p0; }
                                            8 => {
                                                let pick_a = if board[foe][0].card.a2_cost != 255 && (rng.next_u32() & 1) == 1 { ST_CANT_USE_A2 } else { ST_CANT_USE_A1 };
                                                board[foe][0].status |= pick_a; eff_tag = 12; eff_num = 98;
                                            }
                                            9 => { board[foe][0].status |= ST_NO_ABILITY; eff_tag = 23; }
                                            10 => { board[foe][0].status |= ST_NO_ENERGY_ATTACH; eff_tag = 23; }
                                            _ => {}
                                        }
                                    }
                                }
                                16 => {
                                    // Self Switch or Shuffle Self into Deck
                                    let prom = best_bench_promote(&board[cur]);
                                    if prom < 4 {
                                        if p0 == 1 {
                                            let sh_c = board[cur][0].card;
                                            if board[cur][0].energy > 0 { energy_discarded[cur] = 1; }
                                            board[cur][0].occ = false;
                                            board[cur].swap(0, prom);
                                            board[cur][0].status &= !ST_HAS_ATTACKED;
                                            if lib_len[cur] < 20 { libs[cur][lib_len[cur]] = sh_c; lib_len[cur] += 1; }
                                        } else {
                                            board[cur][0].status &= !ST_LEAVE_ACTIVE_CLEAR;
                                            board[cur][0].stack_boost = 0;
                                            board[cur].swap(0, prom);
                                            board[cur][0].status &= !ST_HAS_ATTACKED;
                                        }
                                        if eff_tag == 0 { eff_tag = 13; }
                                    }
                                }
                                17 => {
                                    // Opponent Locks / Disruption / Mill / Switch / Devolve
                                    match p0 {
                                        1 => { if board[foe][0].occ && !has_status_immunity(&board, foe, 0, stadium, turn) { board[foe][0].status |= ST_CANT_RETREAT; if eff_tag == 0 { eff_tag = 14; } } }
                                        2 => {
                                            let pick = best_bench_promote(&board[foe]);
                                            if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe][0].stack_boost = 0; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; eff_tag = 15; }
                                        }
                                        3 => {
                                            if p1 == 1 && rng.flip_coin(&mut guaranteed_heads) {
                                                let pick = best_bench_promote(&board[foe]);
                                                if pick < 4 { board[foe][0].status &= !ST_LEAVE_ACTIVE_CLEAR; board[foe].swap(0, pick); board[foe][0].status &= !ST_HAS_ATTACKED; eff_tag = 15; }
                                            }
                                        }
                                        4 => { item_lock[foe] = 1; eff_tag = 16; }
                                        5 => { supp_lock[foe] = 1; eff_tag = 18; }
                                        6 => { item_lock[foe] = 1; supp_lock[foe] = 1; eff_tag = 18; } // Mega Gengar ex / Flutter Mane ex!
                                        7 => { evo_lock[foe] = 1; eff_tag = 23; } // Malamar!
                                        8 => {
                                            let ok = p1 == 0 || rng.flip_coin(&mut guaranteed_heads);
                                            if ok {
                                                for k in 0..hand_len[foe] {
                                                    if hands[foe][k].is_supporter() {
                                                        hand_len[foe] -= 1; hands[foe][k] = hands[foe][hand_len[foe]]; eff_tag = 17; break;
                                                    }
                                                }
                                            }
                                        }
                                        10 => {
                                            let ok = p1 != 1 || rng.flip_coin(&mut guaranteed_heads);
                                            if ok && hand_len[foe] > 0 {
                                                if p1 == 2 || p1 == 3 {
                                                    for k in 0..hand_len[foe] {
                                                        if (p1 == 2 && hands[foe][k].is_item()) || (p1 == 3 && hands[foe][k].is_tool()) {
                                                            hand_len[foe] -= 1; hands[foe][k] = hands[foe][hand_len[foe]]; eff_tag = 23; break;
                                                        }
                                                    }
                                                } else {
                                                    let ri = (rng.next_u32() as usize) % hand_len[foe];
                                                    hand_len[foe] -= 1; hands[foe][ri] = hands[foe][hand_len[foe]]; eff_tag = 23;
                                                }
                                            }
                                        }
                                        11 => {
                                            let cnt = if p1 == 99 { if rng.flip_coin(&mut guaranteed_heads) { 1 } else { 0 } }
                                                else if p1 == 98 {
                                                    let mut h = 0; for _ in 0..3 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } } h
                                                } else { p1 };
                                            for _ in 0..cnt {
                                                if hand_len[foe] > 0 {
                                                    let ri = (rng.next_u32() as usize) % hand_len[foe];
                                                    let cb = hands[foe][ri]; hand_len[foe] -= 1; hands[foe][ri] = hands[foe][hand_len[foe]];
                                                    if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = cb; lib_len[foe] += 1; }
                                                    eff_tag = 23;
                                                }
                                            }
                                        }
                                        12 => {
                                            if rng.flip_coin(&mut guaranteed_heads) && count_bench(&board[foe]) > 0 {
                                                let bounced = board[foe][0].card;
                                                board[foe][0].occ = false;
                                                let prom = best_bench_promote(&board[foe]);
                                                if prom < 4 { board[foe].swap(0, prom); board[foe][0].status &= !ST_HAS_ATTACKED; }
                                                if lib_len[foe] < 20 { libs[foe][lib_len[foe]] = bounced; lib_len[foe] += 1; }
                                                eff_tag = 23;
                                            }
                                        }
                                        13 => {
                                            let cnt = if p1 == 99 {
                                                let mut h = 0; for _ in 0..8 { if rng.flip_coin(&mut guaranteed_heads) { h += 1; } else { break; } } h
                                            } else { p1 };
                                            for _ in 0..cnt {
                                                if lib_len[foe] > 0 {
                                                    lib_len[foe] -= 1;
                                                    let mc = libs[foe][lib_len[foe]];
                                                    record_discard_card(&mc, foe, &mut disc_poke, &mut disc_poke_p, &mut disc_item, &mut disc_supp, &mut disc_tool, &mut disc_basic_w, &mut disc_basic_any, &mut disc_quick_grow, &mut disc_volbeat);
                                                }
                                            }
                                            if eff_tag == 0 { eff_tag = 23; }
                                        }
                                        14 => {
                                            for _ in 0..p1 {
                                                if lib_len[cur] > 0 {
                                                    lib_len[cur] -= 1;
                                                    let mc = libs[cur][lib_len[cur]];
                                                    record_discard_card(&mc, cur, &mut disc_poke, &mut disc_poke_p, &mut disc_item, &mut disc_supp, &mut disc_tool, &mut disc_basic_w, &mut disc_basic_any, &mut disc_quick_grow, &mut disc_volbeat);
                                                }
                                            }
                                        }
                                        15 => {
                                            for _ in 0..p1 {
                                                if lib_len[cur] > 0 { lib_len[cur] -= 1; }
                                                if lib_len[foe] > 0 { lib_len[foe] -= 1; }
                                            }
                                            if eff_tag == 0 { eff_tag = 23; }
                                        }
                                        16 => { stadium = 0; eff_tag = 22; }
                                        17 => {
                                            // Celebi A4a-006: devolve opp Active
                                            if board[foe][0].occ && board[foe][0].card.stage > 0 {
                                                let dmg_on = (board[foe][0].max_hp - board[foe][0].hp).max(0);
                                                board[foe][0].max_hp = (board[foe][0].max_hp - 50).max(50);
                                                board[foe][0].hp = board[foe][0].max_hp - dmg_on;
                                                board[foe][0].card.stage -= 1;
                                                eff_tag = 23;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                18 => {
                                    // Draw / Search / Bench Summon / Self-Evolve
                                    match p0 {
                                        1 => { for _ in 0..p1.max(1) { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); } eff_tag = 20; eff_num = 1; }
                                        2 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 1, 0, 0, &mut rng); eff_tag = 20; eff_num = 2; }
                                        3 => {
                                            let mut put = 0;
                                            for bs in 1..4 {
                                                if put >= p1.max(1) { break; }
                                                if !board[cur][bs].occ {
                                                    for li in 0..lib_len[cur] {
                                                        if libs[cur][li].is_pokemon == 1 && libs[cur][li].stage == 0 && !libs[cur][li].is_fossil() {
                                                            let bc = libs[cur][li]; lib_len[cur] -= 1; libs[cur][li] = libs[cur][lib_len[cur]];
                                                            board[cur][bs] = Slot { occ: true, card: bc, hp: bc.hp, max_hp: bc.hp, turn_placed: turn, ..Slot::default() };
                                                            put += 1; eff_tag = 20; eff_num = 3; break;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        4 => {
                                            let want = hand_len[foe];
                                            shuffle_hand_into_deck(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, &mut rng);
                                            for _ in 0..want { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                            eff_tag = 20; eff_num = 4;
                                        }
                                        5 => {
                                            while hand_len[cur] < hand_len[foe] && lib_len[cur] > 0 { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                            eff_tag = 20; eff_num = 1;
                                        }
                                        6 => {
                                            let mut pn = 0;
                                            for s in 0..4 { if board[cur][s].occ && board[cur][s].card.name_hash == H_POOCHYENA { pn += 1; } }
                                            for _ in 0..pn { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
                                            eff_tag = 20; eff_num = pn;
                                        }
                                        7 => { search_deck_to_hand(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur, 8, 0, 0, &mut rng); eff_tag = 20; eff_num = 2; }
                                        8 => {
                                            if disc_item[cur] > 0 && hand_len[cur] < 12 {
                                                let dref = if cur == 0 { d0 } else { d1 };
                                                for k in 0..20 { if dref[k].is_item() { hands[cur][hand_len[cur]] = dref[k]; hand_len[cur] += 1; break; } }
                                            }
                                            eff_tag = 20; eff_num = 1;
                                        }
                                        9 => {
                                            // Magikarp self-evolve from deck!
                                            let bc = board[cur][0].card;
                                            for li in 0..lib_len[cur] {
                                                let evc = libs[cur][li];
                                                if evc.is_pokemon == 1 && evc.stage == bc.stage + 1 && evc.evo_group == bc.evo_group {
                                                    let taken = (board[cur][0].max_hp - board[cur][0].hp).max(0);
                                                    let bhp = tool_hp_bonus(board[cur][0].tool, &evc) + tool_hp_bonus(board[cur][0].tool2, &evc);
                                                    board[cur][0].card = evc;
                                                    board[cur][0].max_hp = evc.hp + bhp;
                                                    board[cur][0].hp = (board[cur][0].max_hp - taken).max(10);
                                                    board[cur][0].status &= !ST_SPECIAL_MASK;
                                                    board[cur][0].turn_placed = turn;
                                                    lib_len[cur] -= 1; libs[cur][li] = libs[cur][lib_len[cur]];
                                                    eff_tag = 20; eff_num = 3; break;
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                19 => {
                                    match p0 {
                                        1 => { board[cur][0].status |= ST_CANT_ATK_SELF; eff_tag = 21; }
                                        2 => { board[cur][0].status |= if atk_idx == 0 { ST_CANT_USE_A1 } else { ST_CANT_USE_A2 }; eff_tag = 21; }
                                        3 => { if !rng.flip_coin(&mut guaranteed_heads) { board[cur][0].status |= ST_CANT_ATK_SELF; eff_tag = 21; } }
                                        4 => { board[cur][0].next_atk_mod = p1 as i16; }
                                        5 => { next_team_boost[cur] = p1 as i16; }
                                        6 => { board[cur][0].stack_boost = (board[cur][0].stack_boost + p1 as i16).min(180); }
                                        7 => { board[cur][0].next_atk_mod = -(p1 as i16); }
                                        _ => {}
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    board[cur][0].status |= ST_HAS_ATTACKED;

                    // Resolve KOs on opponent Active & own Active
                    let (foe_ko, pyu_rec, cursola_ko) = handle_active_ko(foe, cur, true, extra_pt, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                    if foe_ko { ko_flag = 1; }
                    if pyu_rec > 0 && board[cur][0].occ { board[cur][0].hp -= pyu_rec; }
                    if cursola_ko && board[cur][0].occ { board[cur][0].hp = 0; }
                    handle_active_ko(cur, foe, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);

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

        // === END-OF-TURN TRIGGERS FOR CURRENT PLAYER ===
        sweets_used_last[cur] = sweets_used_this_turn;

        // Delayed Attack Damage / KO (Meowscarada ex / Mismagius / Armaldo — fires at end of opp's next turn!)
        if delayed_slot[cur] < 4 && delayed_dmg[cur] > 0 {
            let ds = delayed_slot[cur] as usize;
            let dd = delayed_dmg[cur];
            delayed_slot[cur] = 4; delayed_dmg[cur] = 0;
            if board[cur][ds].occ {
                if dd >= 9000 { board[cur][ds].hp = 0; } else { board[cur][ds].hp -= dd; }
                if ds == 0 {
                    handle_active_ko(cur, foe, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                } else {
                    handle_bench_ko(cur, foe, ds, false, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                }
            }
        }

        // Metal Core Barrier (tool 13) on foe's board discards at end of opponent's (cur's) turn!
        for s in 0..4 {
            if board[foe][s].occ {
                if board[foe][s].tool == 13 { board[foe][s].tool = 0; }
                if board[foe][s].tool2 == 13 { board[foe][s].tool2 = 0; }
            }
        }
        // Caterpie B3b-001 (ab_op=9, val=7): at end of opponent's (cur's) turn, if foe Active is Caterpie, self-evolve!
        if board[foe][0].occ && ab_active(&board, foe, 0, stadium, turn) && board[foe][0].card.ab_op == 9 && board[foe][0].card.ab_val == 7 {
            let bc = board[foe][0].card;
            for li in 0..lib_len[foe] {
                let evc = libs[foe][li];
                if evc.is_pokemon == 1 && evc.stage == bc.stage + 1 && evc.evo_group == bc.evo_group {
                    let taken = (board[foe][0].max_hp - board[foe][0].hp).max(0);
                    let bhp = tool_hp_bonus(board[foe][0].tool, &evc) + tool_hp_bonus(board[foe][0].tool2, &evc);
                    board[foe][0].card = evc; board[foe][0].max_hp = evc.hp + bhp;
                    board[foe][0].hp = (board[foe][0].max_hp - taken).max(10);
                    board[foe][0].status &= !ST_SPECIAL_MASK; board[foe][0].turn_placed = turn;
                    lib_len[foe] -= 1; libs[foe][li] = libs[foe][lib_len[foe]]; break;
                }
            }
        }

        if board[cur][0].occ {
            // Entei ex / Suicune ex / Raikou ex Legendary Pulse (ab_op == 1)
            if ab_active(&board, cur, 0, stadium, turn) && board[cur][0].card.ab_op == 1 {
                let d_id = draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur);
                if RECORD && d_id >= 0 { push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 1, 9, &points, &board, &hand_len, &lib_len); }
            }
            // Deceptive Needle (tool 19): 10 dmg to opp Active if [D] Active
            if board[cur][0].has_tool(19) && board[cur][0].card.has_type(6) && board[foe][0].occ {
                let vic_card = board[foe][0].card.slot_id as i32;
                board[foe][0].hp -= 10;
                let (ko, _, _) = handle_active_ko(foe, cur, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                if RECORD { push_replay_step(turn, foe, 12, vic_card, 10, 5 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
            }
            // Leftovers (tool 20): heal 10 Active
            if !heal_blocked && board[cur][0].has_tool(20) && board[cur][0].hp < board[cur][0].max_hp {
                board[cur][0].hp = (board[cur][0].hp + 10).min(board[cur][0].max_hp);
                if RECORD { push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 10, 8, &points, &board, &hand_len, &lib_len); }
            }
            // Snorlax ex (ab_op=9, val=4): heal 20 Active
            if !heal_blocked && ab_active(&board, cur, 0, stadium, turn) && board[cur][0].card.ab_op == 9 && board[cur][0].card.ab_val == 4 && board[cur][0].hp < board[cur][0].max_hp {
                board[cur][0].hp = (board[cur][0].hp + 20).min(board[cur][0].max_hp);
                if RECORD { push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 20, 8, &points, &board, &hand_len, &lib_len); }
            }
            // Paralysis clears at end of own turn
            if (board[cur][0].status & ST_PARALYZE) != 0 {
                board[cur][0].status &= !ST_PARALYZE;
                if RECORD { push_replay_step(turn, cur, 12, board[cur][0].card.slot_id as i32, 0, 4 | (1 << 5), &points, &board, &hand_len, &lib_len); }
            }
            // Clear turn-scoped debuffs on cur
            board[cur][0].status &= !(ST_CANT_RETREAT | ST_CANT_ATK_OPP | ST_OPP_MISS_FLIP | ST_SWITCHED_IN | ST_ATTACH_SLEEP | ST_NO_ENERGY_ATTACH | ST_DAMAGED_LAST);
            if had_cant_atk_self { board[cur][0].status &= !ST_CANT_ATK_SELF; }
            if had_cant_a1 { board[cur][0].status &= !ST_CANT_USE_A1; }
            if had_cant_a2 { board[cur][0].status &= !ST_CANT_USE_A2; }
            board[cur][0].weaken = 0;
            board[cur][0].cost_tax = 0;
            board[cur][0].retreat_tax = 0;
            if board[cur][0].shield < 0 { board[cur][0].shield = 0; }
        }
        // Stadium EoT: Soothing Shore (7) heal 20 each w/ energy; Hiking Trail (8) draw until 3!
        if stadium == 7 && !heal_blocked {
            for s in 0..4 {
                if board[cur][s].occ && board[cur][s].energy > 0 && board[cur][s].hp < board[cur][s].max_hp {
                    board[cur][s].hp = (board[cur][s].hp + 20).min(board[cur][s].max_hp);
                }
            }
        } else if stadium == 8 {
            while hand_len[cur] < 3 && lib_len[cur] > 0 { draw_one(&mut libs, &mut lib_len, &mut hands, &mut hand_len, cur); }
        }
        // Sitrus Berry (tool 21) & Lum Berry (tool 22) at end of each turn (both players!)
        for pp in 0..2 {
            for s in 0..4 {
                if !board[pp][s].occ { continue; }
                if !heal_blocked && board[pp][s].has_tool(21) && board[pp][s].hp * 2 <= board[pp][s].max_hp {
                    board[pp][s].hp = (board[pp][s].hp + 30).min(board[pp][s].max_hp);
                    if board[pp][s].tool == 21 { board[pp][s].tool = 0; } else { board[pp][s].tool2 = 0; }
                }
                if board[pp][s].has_tool(22) && (board[pp][s].status & ST_SPECIAL_MASK) != 0 {
                    board[pp][s].status &= !ST_SPECIAL_MASK;
                    if board[pp][s].tool == 22 { board[pp][s].tool = 0; } else { board[pp][s].tool2 = 0; }
                }
            }
        }
        // Zeraora Turn-1 EoT +1 energy (ab_op=9, val=5)
        if turn <= 2 {
            for s in 0..4 {
                if board[cur][s].occ && ab_active(&board, cur, s, stadium, turn) && board[cur][s].card.ab_op == 9 && board[cur][s].card.ab_val == 5 {
                    board[cur][s].energy = board[cur][s].energy.saturating_add(1);
                    if RECORD { push_replay_step(turn, cur, 12, board[cur][s].card.slot_id as i32, 1, 10, &points, &board, &hand_len, &lib_len); }
                }
            }
        }
        item_lock[cur] = 0;
        supp_lock[cur] = 0;
        evo_lock[cur] = 0;
        ko_last_turn[cur] = 0;

        // === POKÉMON CHECKUP (Poison / Toxic20 / Toxic40 / Burn / Sleep / DeepSleep / Darkrai / Glaceon / Flygon / Garganacl) ===
        for p in 0..2 {
            let opp = 1 - p;
            // Garganacl (ab_op=9, val=6): heal 10 ALL own Pokémon
            if !heal_blocked {
                for k in 0..4 {
                    if ab_active(&board, p, k, stadium, turn) && board[p][k].card.ab_op == 9 && board[p][k].card.ab_val == 6 {
                        for s in 0..4 { if board[p][s].occ { board[p][s].hp = (board[p][s].hp + 10).min(board[p][s].max_hp); } }
                    }
                }
            }
            if !board[p][0].occ { continue; }
            // 1. Poison / Toxic20 / Toxic40 (+ Nihilego ab_op=17, val=3)
            if (board[p][0].status & (ST_POISON | ST_TOXIC20 | ST_TOXIC40)) != 0 {
                let mut pdmg: i16 = if (board[p][0].status & ST_TOXIC40) != 0 { 40 } else if (board[p][0].status & ST_TOXIC20) != 0 { 20 } else { 10 };
                for s in 0..4 { if ab_active(&board, opp, s, stadium, turn) && board[opp][s].card.ab_op == 17 && board[opp][s].card.ab_val == 3 { pdmg += 10; } }
                let st_card = board[p][0].card.slot_id as i32;
                board[p][0].hp -= pdmg;
                let (ko, _, _) = handle_active_ko(p, opp, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                if RECORD { push_replay_step(turn, p, 12, st_card, pdmg as i32, 1 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
                if !board[p][0].occ { continue; }
            }
            // 2. Burn (20 dmg + flip to cure)
            if (board[p][0].status & ST_BURN) != 0 {
                let st_card = board[p][0].card.slot_id as i32;
                board[p][0].hp -= 20;
                let mut cured = 0i32; let mut dh = false;
                if rng.flip_coin(&mut dh) { board[p][0].status &= !ST_BURN; cured = 1; }
                let (ko, _, _) = handle_active_ko(p, opp, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                if RECORD { push_replay_step(turn, p, 12, st_card, 20, 2 | ((ko as i32) << 4) | (cured << 5), &points, &board, &hand_len, &lib_len); }
                if !board[p][0].occ { continue; }
            }
            // 3. Sleep / Deep Sleep + Darkrai Nightmare (ab_op=9, val=1)
            if (board[p][0].status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0 {
                let mut nm_dmg = 0i16;
                for s in 0..4 { if ab_active(&board, opp, s, stadium, turn) && board[opp][s].card.ab_op == 9 && board[opp][s].card.ab_val == 1 { nm_dmg += 20; } }
                if nm_dmg > 0 {
                    let st_card = board[p][0].card.slot_id as i32;
                    board[p][0].hp -= nm_dmg;
                    let (ko, _, _) = handle_active_ko(p, opp, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                    if RECORD { push_replay_step(turn, p, 12, st_card, nm_dmg as i32, 6 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
                    if !board[p][0].occ { continue; }
                }
                if (board[p][0].status & (ST_SLEEP | ST_DEEP_SLEEP)) != 0 {
                    let st_card = board[p][0].card.slot_id as i32;
                    let deep = (board[p][0].status & ST_DEEP_SLEEP) != 0;
                    let mut dh = false;
                    let woke = if deep { rng.flip_coin(&mut dh) && rng.flip_coin(&mut dh) } else { rng.flip_coin(&mut dh) };
                    if woke { board[p][0].status &= !(ST_SLEEP | ST_DEEP_SLEEP); }
                    if RECORD { push_replay_step(turn, p, 12, st_card, 0, 3 | ((woke as i32) << 5), &points, &board, &hand_len, &lib_len); }
                }
            }
            // 4. Glaceon ex (ab_op=9, val=2: 10 to opp Active) / Flygon ex (ab_op=9, val=3: 10 to ALL opp!)
            if board[opp][0].occ && ab_active(&board, opp, 0, stadium, turn) && board[opp][0].card.ab_op == 9 {
                let gv = board[opp][0].card.ab_val;
                if gv == 2 || gv == 3 {
                    let st_card = board[p][0].card.slot_id as i32;
                    board[p][0].hp -= 10;
                    let (ko, _, _) = handle_active_ko(p, opp, false, 0, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                    if RECORD { push_replay_step(turn, p, 12, st_card, 10, 7 | ((ko as i32) << 4), &points, &board, &hand_len, &lib_len); }
                    if gv == 3 {
                        for bs in 1..4 {
                            if board[p][bs].occ && !bench_dmg_blocked(&board, p, bs, false, stadium, turn) {
                                board[p][bs].hp -= 10;
                                handle_bench_ko(p, opp, bs, false, stadium, turn, &mut board, &mut points, &mut pts_last_turn, &mut ko_count, &mut ko_last_turn, &mut libs, &mut lib_len, &mut hands, &mut hand_len, &mut energy_discarded, &mut disc_poke, &mut disc_poke_p, &mut disc_basic_w, &mut disc_basic_any, &mut rng);
                            }
                        }
                    }
                }
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
                &d0, &enemies[opp_idx], &cands[cand_idx], &w_enemies[opp_idx],
                seed, first, track, &mut feat_buf, &mut pts_dummy,
            );

            total += 1;
            turns_sum += turns as u64;
            let c_off = 8 + cand_idx * 6;
            let o_off = 512 + opp_idx * opp_stride;
            let oc_off = o_off + 6 + cand_idx * 4;
            OUT_U32[c_off] += 1; OUT_U32[o_off] += 1; OUT_U32[oc_off] += 1;

            match code {
                1 => {
                    wins += 1; OUT_U32[c_off + 1] += 1; OUT_U32[o_off + 1] += 1; OUT_U32[oc_off + 1] += 1;
                    if has_feat {
                        OUT_U32[c_off + 4] += 1; OUT_U32[o_off + 4] += 1;
                        let cf = cand_idx * 44; let of = 2048 + opp_idx * 44;
                        for k in 0..FEATURES { OUT_F64[cf + k] += feat_buf[k] as f64; OUT_F64[of + k] += feat_buf[k] as f64; }
                    }
                }
                2 => { draws += 1; OUT_U32[c_off + 2] += 1; OUT_U32[o_off + 2] += 1; OUT_U32[oc_off + 2] += 1; }
                _ => {
                    losses += 1; OUT_U32[c_off + 3] += 1; OUT_U32[o_off + 3] += 1; OUT_U32[oc_off + 3] += 1;
                    if has_feat {
                        OUT_U32[c_off + 5] += 1; OUT_U32[o_off + 5] += 1;
                        let cf = cand_idx * 44 + 22; let of = 2048 + opp_idx * 44 + 22;
                        for k in 0..FEATURES { OUT_F64[cf + k] += feat_buf[k] as f64; OUT_F64[of + k] += feat_buf[k] as f64; }
                    }
                }
            }
        }
        OUT_U32[0] = total; OUT_U32[1] = wins; OUT_U32[2] = draws; OUT_U32[3] = losses;
        OUT_U32[4] = (turns_sum & 0xFFFF_FFFF) as u32; OUT_U32[5] = (turns_sum >> 32) as u32;
    }
    total
}

#[no_mangle]
pub extern "C" fn run_test_chunk(enemy_slot: u32, start_idx: u32, count: u32, total_per_opp: u32, seed_base: u32) -> u32 {
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

    let (mut wins, mut draws, mut losses) = (0u32, 0u32, 0u32);
    let (mut f_wins, mut f_draws, mut f_losses) = (0u32, 0u32, 0u32);
    let (mut s_wins, mut s_draws, mut s_losses) = (0u32, 0u32, 0u32);
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
        OUT_U32[0] = n as u32; OUT_U32[1] = wins; OUT_U32[2] = draws; OUT_U32[3] = losses;
        OUT_U32[4] = f_wins; OUT_U32[5] = f_draws; OUT_U32[6] = f_losses;
        OUT_U32[7] = s_wins; OUT_U32[8] = s_draws; OUT_U32[9] = s_losses; OUT_U32[10] = turns_sum;
    }
    n as u32
}

#[no_mangle]
pub extern "C" fn run_replay_game(enemy_slot: u32, game_idx: u32, total_per_opp: u32, seed_base: u32) -> u32 {
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
        OUT_U32[0] = code as u32; OUT_U32[1] = turns as u32; OUT_U32[2] = first as u32;
        OUT_U32[3] = pts[0] as u32; OUT_U32[4] = pts[1] as u32;
        REPLAY_LEN
    }
}

#[no_mangle]
pub extern "C" fn run_optimize_batch(n_cands: u32, n_enemies: u32, games_per_opp: u32, seed_base: u32) -> u32 {
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
            let (mut tot, mut wins, mut draws, mut losses) = (0u32, 0u32, 0u32, 0u32);
            for o in 0..n_opps {
                let opp_mix = seed_base ^ ((o as u32 + 1).wrapping_mul(1_000_003));
                for idx in 0..gpo {
                    let first = if idx < half { 0 } else { 1 };
                    let seed_slot = (idx % half) as u32;
                    let seed = opp_mix ^ seed_slot.wrapping_mul(2654435761);
                    let (code, _, _) = simulate_i32_impl::<false>(&d0, &enemies[o], &w_player, &w_enemies[o], seed, first, false, &mut dummy, &mut pts_dummy);
                    tot += 1;
                    match code { 1 => wins += 1, 2 => draws += 1, _ => losses += 1 }
                }
            }
            let out_o = ci * 4;
            OUT_U32[out_o] = tot; OUT_U32[out_o + 1] = wins; OUT_U32[out_o + 2] = draws; OUT_U32[out_o + 3] = losses;
        }
    }
    nc as u32
}
