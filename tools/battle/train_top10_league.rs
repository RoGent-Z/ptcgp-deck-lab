//! Native 24-thread Top-10 Meta Round-Robin Co-Evolution League.
//! Every single one of the Top-10 meta teams trains across 10,000,000 games against
//! all 10 evolving opponents (100,000,000 total league games + 1,000,000-game final matrix),
//! using exact fixed-point i32 scoring & u32 RNG matching fastsim.wasm and WebGPU WGSL.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const FEATURES: usize = 22;
const NUM_TEAMS: usize = 10;
const NUM_GENS: usize = 10;
const NUM_CANDS: usize = 25;
// Per generation per team: 25 cands * 10 opponents * 4,000 games = 1,000,000 games
// Across 10 generations: 10,000,000 games PER TEAM = 100,000,000 total games!
const GAMES_PER_CAND_PER_OPP: usize = 4000;

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
    power_q: i32, // fixed-point atk_dmg * 1024 / 100
    bonus_q: i32, // fixed-point strategy_bonus * 1024
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

/// Deterministic 32-bit PCG-style hash RNG (exact match with WebGPU WGSL u32 & fastsim.wasm!)
#[derive(Clone, Copy)]
struct Rng32(u32);
impl Rng32 {
    #[inline(always)]
    fn new(seed: u32) -> Self {
        let mut s = seed ^ 0x9e3779b9;
        s ^= s >> 16;
        s = s.wrapping_mul(0x7feb352d);
        s ^= s >> 15;
        s = s.wrapping_mul(0x846ca68b);
        s ^= s >> 16;
        Self(s | 1)
    }
    #[inline(always)]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x.wrapping_mul(0x27d4eb2d)
    }
    #[inline(always)]
    fn next_f64(&mut self) -> f64 {
        (self.next_u32() as f64) / 4294967296.0
    }
    #[inline(always)]
    fn normal(&mut self) -> f64 {
        let u1 = self.next_f64().max(1e-12);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
}

#[inline(always)]
fn to_fixed(w: &[f64; FEATURES]) -> [i32; FEATURES] {
    let mut out = [0i32; FEATURES];
    for i in 0..FEATURES {
        out[i] = (w[i] * 1024.0).round() as i32;
    }
    out
}

#[inline(always)]
fn simulate_i32(
    d0: &[CompactCard; 20],
    d1: &[CompactCard; 20],
    w0: &[i32; FEATURES],
    w1: &[i32; FEATURES],
    seed: u32,
    first_player: usize,
) -> u8 {
    let mut rng = Rng32::new(seed);
    let mut libs = [*d0, *d1];
    let mut lib_len = [20usize, 20usize];
    let mut hands = [[CompactCard::default(); 12]; 2];
    let mut hand_len = [0usize, 0usize];
    let mut board = [[Slot::default(); 4]; 2];
    let mut points = [0u8, 0u8];

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
        if basic_pos < 20 && basic_pos >= 5 {
            libs[p].swap(0, basic_pos);
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
            let mut best_score: i32 = w[0];

            // 1. Place basics
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage == 0 {
                    for s in 1..4 {
                        if !board[cur][s].occ {
                            let sc = w[2] + (((c.power_q * w[3]) >> 10) * 15 / 100) + ((c.bonus_q * 35) / 100);
                            if sc > best_score { best_score = sc; best_kind = 1; best_a = hi; best_b = s; }
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
                                let p_shift = if s == 0 { c.power_q } else { c.power_q >> 1 };
                                let sc = w[4] + ((p_shift * w[5]) >> 10) + ((c.bonus_q * 45) / 100);
                                if sc > best_score { best_score = sc; best_kind = 2; best_a = hi; best_b = s; }
                            }
                        }
                    }
                }
            }

            // 3. Ability
            if !ability_used {
                for s in 0..4 {
                    if board[cur][s].occ && board[cur][s].card.ab_flags != 0 {
                        let sn = if (board[cur][s].card.ab_flags & 16) != 0 { (w[21] * 35) / 100 } else { 0 };
                        let sc = w[6] + sn + ((board[cur][s].card.bonus_q * 35) / 100);
                        if sc > best_score { best_score = sc; best_kind = 4; best_a = s; }
                    }
                }
            }

            // 4. Trainer
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 0 {
                    let is_sup = c.trainer_kind == 2 || c.trainer_kind == 3 || c.trainer_kind == 4;
                    if is_sup && supporter_used { continue; }
                    let mut sc = w[7] + ((c.bonus_q * 40) / 100);
                    match c.trainer_kind {
                        1 => {
                            let inv = 5120 / (5 + hand_len[cur] as i32);
                            sc += (inv * w[8]) >> 10;
                        }
                        2 => {
                            let missing = board[cur][0].max_hp - board[cur][0].hp;
                            if missing <= 0 { continue; }
                            sc += (w[20] * (missing.min(c.effect_val) as i32)) / 50;
                        }
                        3 => { sc += ((w[19] * 45) + (w[21] * 25)) / 100; }
                        4 => { sc += ((w[10] * 35) + (w[11] * 25)) / 100; }
                        5 => {
                            if board[cur][0].tool != 0 { continue; }
                            sc += w[20];
                        }
                        6 => { sc += ((w[13] * 45) + (w[15] * 35)) / 100; }
                        7 => { sc += w[6]; }
                        _ => {}
                    }
                    if sc > best_score { best_score = sc; best_kind = 3; best_a = hi; }
                }
            }

            // 5. Energy attach
            if !energy_attached {
                for s in 0..4 {
                    if board[cur][s].occ {
                        let need = if board[cur][s].energy < board[cur][s].card.atk_cost { w[15] } else { 0 };
                        let sc = w[13]
                            + (if s == 0 { w[14] } else { 0 })
                            + need
                            + ((board[cur][s].card.power_q * w[16]) >> 10)
                            + ((board[cur][s].card.bonus_q * 25) / 100);
                        if sc > best_score { best_score = sc; best_kind = 5; best_a = s; }
                    }
                }
            }

            // 6. Retreat
            if !retreated && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.retreat {
                let foe_dmg = if board[foe][0].occ { board[foe][0].card.atk_dmg } else { 0 };
                for s in 1..4 {
                    if board[cur][s].occ {
                        let endg = if board[cur][0].hp <= foe_dmg && board[cur][s].hp > board[cur][0].hp { w[18] } else { 0 };
                        let sc = w[17] + endg;
                        if sc > best_score { best_score = sc; best_kind = 6; best_a = s; }
                    }
                }
            }

            // 7. Attack
            if turn >= 2 && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.atk_cost && board[cur][0].card.atk_dmg > 0 {
                let atk = board[cur][0].card;
                let weak_bonus = if board[foe][0].occ && board[foe][0].card.weak_code == atk.type_code { 20 } else { 0 };
                let total_dmg = atk.atk_dmg + dmg_boost + weak_bonus;
                let ko = if board[foe][0].occ && total_dmg >= board[foe][0].hp { w[11] } else { 0 };
                let eff = if (atk.atk_flags & 1) != 0 { w[12] } else { 0 };
                let snipe = if (atk.atk_flags & 2) != 0 { w[21] >> 1 } else { 0 };
                let sc = w[9] + ((total_dmg as i32 * w[10]) / 100) + ko + eff + snipe + ((atk.bonus_q * 40) / 100);
                if sc > best_score { best_kind = 7; }
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
                                if points[cur] >= 3 || !board[foe][0].occ { return if cur == 0 { 1 } else { 0 }; }
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
                        if cur_won && foe_won { return 2; }
                        if cur_won { return if cur == 0 { 1 } else { 0 }; }
                        if foe_won { return if foe == 0 { 1 } else { 0 }; }
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
                    if points[opp] >= 3 || !board[p][0].occ { return if opp == 0 { 1 } else { 0 }; }
                }
            }
        }
        cur = foe;
    }
    2
}

fn round6(v: f64) -> f64 {
    (v.clamp(-8.0, 8.0) * 1e6).round() / 1e6
}

fn main() {
    let t0 = Instant::now();
    let base_dir = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let cards_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/cards.tsv")).expect("read cards.tsv");
    let decks_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/meta_decks.tsv")).expect("read meta_decks.tsv");
    let v3_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/v3_weights.txt")).expect("read v3_weights.txt");
    let bonus_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/top10_lexicon_bonuses.tsv")).expect("read top10_lexicon_bonuses.tsv");

    let mut v3_w = [0.0f64; FEATURES];
    for (i, s) in v3_txt.trim().split(',').enumerate().take(FEATURES) {
        v3_w[i] = s.parse::<f64>().unwrap_or(0.0);
    }

    let mut cards: Vec<CompactCard> = Vec::new();
    for line in cards_txt.lines() {
        if line.trim().is_empty() { continue; }
        let p: Vec<&str> = line.split('\t').collect();
        let atk_dmg: i16 = p[10].parse().unwrap_or(0);
        cards.push(CompactCard {
            is_pokemon: p[2].parse().unwrap_or(0),
            stage: p[3].parse().unwrap_or(0),
            type_code: p[4].parse().unwrap_or(9),
            weak_code: p[5].parse().unwrap_or(255),
            hp: p[6].parse().unwrap_or(60),
            retreat: p[7].parse().unwrap_or(1),
            prize: p[8].parse().unwrap_or(1),
            atk_cost: p[9].parse().unwrap_or(1),
            atk_dmg,
            atk_flags: p[11].parse().unwrap_or(0),
            ab_flags: p[12].parse().unwrap_or(0),
            trainer_kind: p[13].parse().unwrap_or(0),
            effect_val: p[14].parse().unwrap_or(0),
            power_q: ((atk_dmg as i32) * 1024) / 100,
            bonus_q: 0,
        });
    }

    let mut team_ids = Vec::new();
    let mut team_names = Vec::new();
    let mut team_w = [[0.0f64; FEATURES]; NUM_TEAMS];
    let mut team_bonuses = [[0i32; 20]; NUM_TEAMS];
    for (ti, line) in bonus_txt.lines().enumerate().take(NUM_TEAMS) {
        let p: Vec<&str> = line.split('\t').collect();
        team_ids.push(p[0].to_string());
        team_names.push(p[1].to_string());
        for (k, s) in p[2].split(',').enumerate().take(FEATURES) {
            team_w[ti][k] = s.parse::<f64>().unwrap_or(v3_w[k]);
        }
        for (k, s) in p[3].split(',').enumerate().take(20) {
            team_bonuses[ti][k] = (s.parse::<f64>().unwrap_or(0.0) * 1024.0).round() as i32;
        }
    }

    let mut decks = [[CompactCard::default(); 20]; NUM_TEAMS];
    for (ti, line) in decks_txt.lines().enumerate().take(NUM_TEAMS) {
        let p: Vec<&str> = line.split('\t').collect();
        for (k, s) in p[1].split(',').enumerate().take(20) {
            let ci: usize = s.parse().unwrap_or(0);
            let mut c = cards[ci];
            c.bonus_q = team_bonuses[ti][k];
            decks[ti][k] = c;
        }
    }

    let n_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
    let mut rng = Rng32::new(20261123);

    // 10 Generations of Round-Robin Co-Evolution:
    // Each team plays 1,000,000 games/gen * 10 gens = 10,000,000 games/team (100,000,000 total!)
    for gen in 0..NUM_GENS {
        let sigma = 0.34 * (0.82f64).powi(gen as i32);
        let opp_fixed: [[i32; FEATURES]; NUM_TEAMS] = std::array::from_fn(|o| to_fixed(&team_w[o]));

        // Generate 25 candidates per team (250 total candidates evaluated in parallel)
        let mut all_cands = [[[0.0f64; FEATURES]; NUM_CANDS]; NUM_TEAMS];
        let mut all_cands_q = [[[0i32; FEATURES]; NUM_CANDS]; NUM_TEAMS];
        for t in 0..NUM_TEAMS {
            all_cands[t][0] = team_w[t];
            all_cands_q[t][0] = to_fixed(&team_w[t]);
            for c in 1..NUM_CANDS {
                for k in 0..FEATURES {
                    let scale = if k <= 1 { sigma * 0.45 } else { sigma };
                    all_cands[t][c][k] = round6(team_w[t][k] + rng.normal() * scale);
                }
                all_cands_q[t][c] = to_fixed(&all_cands[t][c]);
            }
        }

        // Parallelize across all 250 (team, cand) jobs!
        let total_jobs = NUM_TEAMS * NUM_CANDS;
        let cursor = AtomicUsize::new(0);
        let scores: Vec<std::sync::Mutex<(u32, u32, u32)>> = (0..total_jobs).map(|_| std::sync::Mutex::new((0, 0, 0))).collect();

        std::thread::scope(|scope| {
            for _ in 0..n_threads {
                scope.spawn(|| {
                    loop {
                        let job = cursor.fetch_add(1, Ordering::Relaxed);
                        if job >= total_jobs { break; }
                        let t = job / NUM_CANDS;
                        let c = job % NUM_CANDS;
                        let wc = &all_cands_q[t][c];
                        let half = GAMES_PER_CAND_PER_OPP / 2;
                        let mut w_cnt = 0u32;
                        let mut d_cnt = 0u32;
                        let mut l_cnt = 0u32;

                        for opp in 0..NUM_TEAMS {
                            let wo = &opp_fixed[opp];
                            let seed_head = ((gen as u32 + 1) * 0x9e3779b1) ^ ((t as u32 + 1) * 0x85ebca6b) ^ ((opp as u32 + 1) * 0xc2b2ae35);
                            for g in 0..GAMES_PER_CAND_PER_OPP {
                                let first = if g < half { 0 } else { 1 };
                                let pair = (g % half) as u32;
                                let seed = seed_head ^ pair.wrapping_mul(2654435761);
                                match simulate_i32(&decks[t], &decks[opp], wc, wo, seed, first) {
                                    1 => w_cnt += 1,
                                    2 => d_cnt += 1,
                                    _ => l_cnt += 1,
                                }
                            }
                        }
                        *scores[job].lock().unwrap() = (w_cnt, d_cnt, l_cnt);
                    }
                });
            }
        });

        let mut next_w = team_w;
        for t in 0..NUM_TEAMS {
            let mut ranked: Vec<(usize, f64)> = (0..NUM_CANDS).map(|c| {
                let (w, d, l) = *scores[t * NUM_CANDS + c].lock().unwrap();
                let tot = (w + d + l).max(1) as f64;
                (c, (w as f64 + 0.5 * d as f64) / tot)
            }).collect();
            ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
            let top_sr = ranked[0].1;
            let mut acc = [0.0f64; FEATURES];
            let mut w_sum = 0.0f64;
            for &(cid, sr) in ranked.iter().take(5) {
                let imp = (24.0 * (sr - top_sr)).exp();
                for k in 0..FEATURES { acc[k] += all_cands[t][cid][k] * imp; }
                w_sum += imp;
            }
            for k in 0..FEATURES {
                let elite_val = acc[k] / w_sum;
                next_w[t][k] = round6(0.65 * elite_val + 0.35 * team_w[t][k]);
            }
        }
        team_w = next_w;
        println!("Gen {}/{} complete ({:.1}s elapsed, {}M total games)", gen + 1, NUM_GENS, t0.elapsed().as_secs_f64(), (gen + 1) * 10);
    }

    // Final validation: 10x10 Round-Robin Matrix (10,000 games/pair = 1,000,000 games) + Elite vs Generic V3 (10,000 games/team = 100,000 games)
    let final_q: [[i32; FEATURES]; NUM_TEAMS] = std::array::from_fn(|t| to_fixed(&team_w[t]));
    let v3_q = to_fixed(&v3_w);
    let matrix_games = 10000usize;
    let matrix_res: Vec<std::sync::Mutex<(u32, u32, u32)>> = (0..NUM_TEAMS * NUM_TEAMS).map(|_| std::sync::Mutex::new((0, 0, 0))).collect();
    let vs_v3_res: Vec<std::sync::Mutex<(u32, u32, u32)>> = (0..NUM_TEAMS).map(|_| std::sync::Mutex::new((0, 0, 0))).collect();
    let cursor2 = AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..n_threads {
            scope.spawn(|| {
                loop {
                    let job = cursor2.fetch_add(1, Ordering::Relaxed);
                    if job >= NUM_TEAMS * NUM_TEAMS + NUM_TEAMS { break; }
                    if job < NUM_TEAMS * NUM_TEAMS {
                        let a = job / NUM_TEAMS;
                        let b = job % NUM_TEAMS;
                        let mut w = 0u32; let mut d = 0u32; let mut l = 0u32;
                        for g in 0..matrix_games {
                            let first = if g < matrix_games / 2 { 0 } else { 1 };
                            let seed = 0x51a7_0001u32 ^ ((a as u32 + 1) * 1000003) ^ ((b as u32 + 1) * 999983) ^ (g as u32).wrapping_mul(2654435761);
                            match simulate_i32(&decks[a], &decks[b], &final_q[a], &final_q[b], seed, first) {
                                1 => w += 1, 2 => d += 1, _ => l += 1,
                            }
                        }
                        *matrix_res[job].lock().unwrap() = (w, d, l);
                    } else {
                        let t = job - NUM_TEAMS * NUM_TEAMS;
                        let mut w = 0u32; let mut d = 0u32; let mut l = 0u32;
                        for g in 0..matrix_games {
                            let opp = g % NUM_TEAMS;
                            let first = if g < matrix_games / 2 { 0 } else { 1 };
                            let seed = 0x77b1_0003u32 ^ ((t as u32 + 1) * 1000003) ^ (g as u32).wrapping_mul(2654435761);
                            match simulate_i32(&decks[t], &decks[opp], &final_q[t], &v3_q, seed, first) {
                                1 => w += 1, 2 => d += 1, _ => l += 1,
                            }
                        }
                        *vs_v3_res[t].lock().unwrap() = (w, d, l);
                    }
                }
            });
        }
    });

    let elapsed = t0.elapsed().as_secs_f64();
    let total_games = (NUM_TEAMS * NUM_GENS * NUM_CANDS * NUM_TEAMS * GAMES_PER_CAND_PER_OPP) as u64;

    // Write public/battle/models/top10-elite.json
    let out_path = format!("{base_dir}/public/battle/models/top10-elite.json");
    let mut f = BufWriter::new(File::create(&out_path).expect("create top10-elite.json"));
    writeln!(f, "{{").unwrap();
    writeln!(f, "  \"schemaVersion\": 1,").unwrap();
    writeln!(f, "  \"season\": \"C1\",").unwrap();
    writeln!(f, "  \"gamesPerTeam\": 10000000,").unwrap();
    writeln!(f, "  \"totalLeagueGames\": {},", total_games).unwrap();
    writeln!(f, "  \"generations\": {},", NUM_GENS).unwrap();
    writeln!(f, "  \"elapsedSec\": {:.2},", elapsed).unwrap();
    writeln!(f, "  \"teams\": {{").unwrap();
    for t in 0..NUM_TEAMS {
        let (vw, vd, vl) = *vs_v3_res[t].lock().unwrap();
        let vs_v3_wr = (vw as f64) / ((vw + vd + vl).max(1) as f64);
        let mut rr_w = 0u64; let mut rr_tot = 0u64;
        let mut row_wrs = Vec::new();
        for o in 0..NUM_TEAMS {
            let (mw, md, ml) = *matrix_res[t * NUM_TEAMS + o].lock().unwrap();
            rr_w += mw as u64;
            rr_tot += (mw + md + ml) as u64;
            row_wrs.push(format!("{:.4}", (mw as f64) / ((mw + md + ml).max(1) as f64)));
        }
        let rr_wr = (rr_w as f64) / (rr_tot.max(1) as f64);
        let w_str: Vec<String> = team_w[t].iter().map(|x| format!("{:.6}", x)).collect();
        let comma = if t + 1 < NUM_TEAMS { "," } else { "" };
        writeln!(
            f,
            "    \"{}\": {{\"rank\": {}, \"name\": \"{}\", \"gamesTrained\": 10000000, \"leagueWinRate\": {:.4}, \"vsV3WinRate\": {:.4}, \"vsMatrix\": [{}], \"weights\": [{}]}}{}",
            team_ids[t], t + 1, team_names[t], rr_wr, vs_v3_wr, row_wrs.join(", "), w_str.join(", "), comma
        ).unwrap();
    }
    writeln!(f, "  }}").unwrap();
    writeln!(f, "}}").unwrap();
    f.flush().unwrap();

    fs::copy(&out_path, format!("{base_dir}/reports/battle-ml-v4-strategies/top10-league-report.json")).ok();
    println!(
        "Top-10 Round-Robin League DONE: {} total games (10,000,000/team) in {:.2}s ({:.0} games/sec across {} threads) -> {}",
        total_games, elapsed, (total_games as f64) / elapsed.max(0.001), n_threads, out_path
    );
}
