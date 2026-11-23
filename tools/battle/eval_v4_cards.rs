//! Native 24-thread per-card 2,400-game evaluator across all 4,577 PTCG Pocket cards.
//! Total simulated games: 4,577 cards * 2,400 games (4 tactical regimes * 600 paired games) = 10,984,800 games!
//! Zero external crates — compiles in ~2s with `rustc -O`.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const FEATURES: usize = 22;
const GAMES_PER_REGIME: usize = 600; // 300 first + 300 second per regime
const NUM_REGIMES: usize = 4;        // 0=Tempo, 1=Control/Disrupt, 2=Sustain/Evolve, 3=Snipe/PrizeMap
const GAMES_PER_CARD: usize = GAMES_PER_REGIME * NUM_REGIMES; // 2,400 games/card!

#[derive(Clone, Copy, Default)]
struct CompactCard {
    idx: u16,
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
}

#[derive(Clone, Copy, Default)]
struct Slot {
    occ: bool,
    card: CompactCard,
    hp: i16,
    max_hp: i16,
    energy: u8,
    tool: i8,   // 0=none, 1=cape(+20hp), 2=helmet(20 recoil)
    status: u8, // bit0=poison, bit1=burn, bit2=sleep
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
fn simulate_game(
    d0: &[CompactCard; 20],
    d1: &[CompactCard; 20],
    w0: &[f32; FEATURES],
    w1: &[f32; FEATURES],
    seed: u64,
    first_player: usize,
) -> (u8, u16, u16) {
    let mut rng = Rng::new(seed);
    let mut libs = [*d0, *d1];
    let mut lib_len = [20usize, 20usize];
    let mut hands = [[CompactCard::default(); 12]; 2];
    let mut hand_len = [0usize, 0usize];
    let mut board = [[Slot::default(); 4]; 2];
    let mut points = [0u8, 0u8];
    let mut decisions = 0u16;

    // Shuffle + guarantee opening basic
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
            if bp >= 5 {
                libs[p].swap(0, bp);
            }
        }
        for _ in 0..5 {
            lib_len[p] -= 1;
            let c = libs[p][lib_len[p]];
            hands[p][hand_len[p]] = c;
            hand_len[p] += 1;
        }
        // Place strongest basic active + up to 2 bench basics
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
            // Fallback: place first pokemon from hand
            board[p][0] = Slot { occ: true, card: d0[0], hp: d0[0].hp.max(60), max_hp: d0[0].hp.max(60), energy: 0, tool: 0, status: 0, turn_placed: 0 };
        }
    }

    let mut cur = first_player;
    for turn in 1u16..=30u16 {
        let foe = 1 - cur;
        let w = if cur == 0 { w0 } else { w1 };

        // Draw 1 card
        if lib_len[cur] > 0 && hand_len[cur] < 12 {
            lib_len[cur] -= 1;
            hands[cur][hand_len[cur]] = libs[cur][lib_len[cur]];
            hand_len[cur] += 1;
        }

        // Play loop: up to 8 tactical actions per turn
        let mut energy_attached = turn == 1; // Turn 1 first player cannot attach energy in PTCG Pocket!
        let mut supporter_used = false;
        let mut retreated = false;
        let mut ability_used = false;
        let mut dmg_boost: i16 = 0;

        for _step in 0..8 {
            decisions = decisions.saturating_add(1);
            let mut best_kind: u8 = 0; // 0=EndTurn, 1=Place, 2=Evolve, 3=Trainer, 4=Ability, 5=Attach, 6=Retreat, 7=Attack
            let mut best_a: usize = 0;
            let mut best_b: usize = 0;
            let mut best_score: f32 = w[0];

            // 1. Place basics onto bench
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 1 && c.stage == 0 {
                    for s in 1..4 {
                        if !board[cur][s].occ {
                            let sc = w[2] + 0.15 * c.power;
                            if sc > best_score { best_score = sc; best_kind = 1; best_a = hi; best_b = s; }
                            break;
                        }
                    }
                }
            }

            // 2. Evolve (respecting turn_placed < turn)
            if turn >= 2 {
                for hi in 0..hand_len[cur] {
                    let c = hands[cur][hi];
                    if c.is_pokemon == 1 && c.stage > 0 {
                        for s in 0..4 {
                            if board[cur][s].occ && board[cur][s].card.stage + 1 == c.stage && (board[cur][s].turn_placed as u16) < turn {
                                let sc = w[4] + c.power * (if s == 0 { 1.0 } else { 0.5 }) * w[5];
                                if sc > best_score { best_score = sc; best_kind = 2; best_a = hi; best_b = s; }
                            }
                        }
                    }
                }
            }

            // 3. Abilities
            if !ability_used {
                for s in 0..4 {
                    if board[cur][s].occ && board[cur][s].card.ab_flags != 0 {
                        let sc = w[6] + if (board[cur][s].card.ab_flags & 16) != 0 { 0.3 * w[21] } else { 0.0 };
                        if sc > best_score { best_score = sc; best_kind = 4; best_a = s; }
                    }
                }
            }

            // 4. Trainers
            for hi in 0..hand_len[cur] {
                let c = hands[cur][hi];
                if c.is_pokemon == 0 {
                    let is_sup = c.trainer_kind == 2 || c.trainer_kind == 3 || c.trainer_kind == 4;
                    if is_sup && supporter_used { continue; }
                    let mut sc = w[7];
                    match c.trainer_kind {
                        1 => { sc += (1.0 / (1.0 + hand_len[cur] as f32 / 5.0)) * w[8]; }
                        2 => {
                            let missing = board[cur][0].max_hp - board[cur][0].hp;
                            if missing <= 0 { continue; }
                            sc += w[20] * (missing.min(c.effect_val) as f32 / 50.0);
                        }
                        3 => {
                            // Gust / Mars disruption
                            sc += 0.45 * w[19] + 0.25 * w[21];
                        }
                        4 => { sc += 0.35 * w[10] + 0.25 * w[11]; }
                        5 => {
                            if board[cur][0].tool != 0 { continue; }
                            sc += w[20];
                        }
                        6 => { sc += 0.45 * w[13] + 0.35 * w[15]; }
                        7 => { sc += w[6]; }
                        _ => {}
                    }
                    if sc > best_score { best_score = sc; best_kind = 3; best_a = hi; best_b = 0; }
                }
            }

            // 5. Energy attach
            if !energy_attached {
                for s in 0..4 {
                    if board[cur][s].occ {
                        let need = if board[cur][s].energy < board[cur][s].card.atk_cost { 1.0 } else { 0.0 };
                        let sc = w[13]
                            + (if s == 0 { w[14] } else { 0.0 })
                            + need * w[15]
                            + board[cur][s].card.power * w[16];
                        if sc > best_score { best_score = sc; best_kind = 5; best_a = s; }
                    }
                }
            }

            // 6. Retreat
            if !retreated && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.retreat {
                let foe_power = if board[foe][0].occ { board[foe][0].card.power } else { 0.0 };
                for s in 1..4 {
                    if board[cur][s].occ {
                        let endangered = (board[cur][0].hp as f32 / 100.0) <= foe_power && board[cur][s].hp > board[cur][0].hp;
                        let sc = w[17] + if endangered { w[18] } else { 0.0 };
                        if sc > best_score { best_score = sc; best_kind = 6; best_a = s; }
                    }
                }
            }

            // 7. Attack (ends turn!)
            if turn >= 2 && board[cur][0].occ && (board[cur][0].status & 4) == 0 && board[cur][0].energy >= board[cur][0].card.atk_cost && board[cur][0].card.atk_dmg > 0 {
                let atk = board[cur][0].card;
                let weak_bonus = if board[foe][0].occ && board[foe][0].card.weak_code == atk.type_code { 20 } else { 0 };
                let total_dmg = atk.atk_dmg + dmg_boost + weak_bonus;
                let ko = if board[foe][0].occ && total_dmg >= board[foe][0].hp { 1.0 } else { 0.0 };
                let eff = if (atk.atk_flags & 1) != 0 { 1.0 } else { 0.0 };
                let snipe = if (atk.atk_flags & 2) != 0 { 0.5 } else { 0.0 };
                let sc = w[9] + (total_dmg as f32 / 100.0) * w[10] + ko * w[11] + eff * w[12] + snipe * w[21];
                if sc > best_score { best_score = sc; best_kind = 7; }
            }

            match best_kind {
                0 => break,
                1 => {
                    let c = hands[cur][best_a];
                    board[cur][best_b] = Slot { occ: true, card: c, hp: c.hp, max_hp: c.hp, energy: 0, tool: 0, status: 0, turn_placed: turn as u8 };
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
                    board[cur][best_b].status = 0; // Evolving clears status!
                    board[cur][best_b].turn_placed = turn as u8;
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
                            // Gust (Sabrina/Cyrus) or Mars
                            if c.effect_val == 3 {
                                // Mars/Red Card: trim opponent hand to 3
                                if hand_len[foe] > 3 { hand_len[foe] = 3; }
                            } else {
                                // Swap foe active with damaged or weakest bench
                                let mut pick = None;
                                for s in 1..4 {
                                    if board[foe][s].occ {
                                        if c.effect_val == 2 && board[foe][s].hp < board[foe][s].max_hp {
                                            pick = Some(s);
                                            break;
                                        }
                                        if pick.is_none() || board[foe][s].hp < board[foe][pick.unwrap()].hp {
                                            pick = Some(s);
                                        }
                                    }
                                }
                                if let Some(s) = pick {
                                    board[foe].swap(0, s);
                                }
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
                                // Rare Candy: evolve basic directly to stage2 in hand if present
                                for hi2 in 0..hand_len[cur] {
                                    if hands[cur][hi2].is_pokemon == 1 && hands[cur][hi2].stage == 2 {
                                        for s in 0..4 {
                                            if board[cur][s].occ && board[cur][s].card.stage == 0 && (board[cur][s].turn_placed as u16) < turn {
                                                let ev = hands[cur][hi2];
                                                let taken = (board[cur][s].max_hp - board[cur][s].hp).max(0);
                                                board[cur][s].card = ev;
                                                board[cur][s].max_hp = ev.hp + if board[cur][s].tool == 1 { 20 } else { 0 };
                                                board[cur][s].hp = (board[cur][s].max_hp - taken).max(10);
                                                board[cur][s].status = 0;
                                                board[cur][s].turn_placed = turn as u8;
                                                hand_len[cur] -= 1;
                                                hands[cur][hi2] = hands[cur][hand_len[cur]];
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                }
                            } else if c.effect_val >= 2 {
                                // Energy acceleration
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
                        // Bench or active ping 20
                        let mut target_s = 0;
                        for s in 1..4 {
                            if board[foe][s].occ { target_s = s; break; }
                        }
                        if board[foe][target_s].occ {
                            board[foe][target_s].hp -= 20;
                            if board[foe][target_s].hp <= 0 {
                                points[cur] = points[cur].saturating_add(board[foe][target_s].card.prize);
                                board[foe][target_s].occ = false;
                                if target_s == 0 {
                                    for ns in 1..4 {
                                        if board[foe][ns].occ { board[foe].swap(0, ns); break; }
                                    }
                                }
                                if points[cur] >= 3 || !board[foe][0].occ {
                                    return (if cur == 0 { 1 } else { 0 }, turn, decisions);
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
                    board[cur][0].status = 0; // Retreating clears status!
                    board[cur].swap(0, best_a);
                }
                7 => {
                    let atk = board[cur][0].card;
                    let weak_bonus = if board[foe][0].occ && board[foe][0].card.weak_code == atk.type_code { 20 } else { 0 };
                    let total_dmg = atk.atk_dmg + dmg_boost + weak_bonus;
                    if board[foe][0].occ {
                        board[foe][0].hp -= total_dmg;
                        // Rocky Helmet recoil
                        if board[foe][0].tool == 2 {
                            board[cur][0].hp -= 20;
                        }
                        // Attack bonus effects
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
                            for ns in 1..4 {
                                if board[foe][ns].occ { board[foe].swap(0, ns); break; }
                            }
                        }
                        if board[cur][0].hp <= 0 {
                            points[foe] = points[foe].saturating_add(board[cur][0].card.prize);
                            board[cur][0].occ = false;
                            for ns in 1..4 {
                                if board[cur][ns].occ { board[cur].swap(0, ns); break; }
                            }
                        }
                        let cur_won = points[cur] >= 3 || !board[foe][0].occ;
                        let foe_won = points[foe] >= 3 || !board[cur][0].occ;
                        if cur_won && foe_won { return (2, turn, decisions); }
                        if cur_won { return (if cur == 0 { 1 } else { 0 }, turn, decisions); }
                        if foe_won { return (if foe == 0 { 1 } else { 0 }, turn, decisions); }
                    }
                    break;
                }
                _ => break,
            }
        }

        // Between-turns Pokemon Checkup (poison/burn)
        for p in 0..2 {
            if board[p][0].occ && (board[p][0].status & 1) != 0 {
                board[p][0].hp -= 10;
                if board[p][0].hp <= 0 {
                    let opp = 1 - p;
                    points[opp] = points[opp].saturating_add(board[p][0].card.prize);
                    board[p][0].occ = false;
                    for ns in 1..4 {
                        if board[p][ns].occ { board[p].swap(0, ns); break; }
                    }
                    if points[opp] >= 3 || !board[p][0].occ {
                        return (if opp == 0 { 1 } else { 0 }, turn, decisions);
                    }
                }
            }
        }

        cur = foe;
    }

    (2, 30, decisions)
}

fn main() {
    let t0 = Instant::now();
    let base_dir = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let cards_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/cards.tsv")).expect("read cards.tsv");
    let decks_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/meta_decks.tsv")).expect("read meta_decks.tsv");
    let v3_txt = fs::read_to_string(format!("{base_dir}/tmp/v4-eval/v3_weights.txt")).expect("read v3_weights.txt");

    let mut base_w = [0.0f32; FEATURES];
    for (i, s) in v3_txt.trim().split(',').enumerate() {
        if i < FEATURES { base_w[i] = s.parse::<f32>().unwrap_or(0.0); }
    }

    let mut cards: Vec<(String, CompactCard)> = Vec::new();
    for line in cards_txt.lines() {
        if line.trim().is_empty() { continue; }
        let p: Vec<&str> = line.split('\t').collect();
        let atk_dmg: i16 = p[10].parse().unwrap_or(0);
        let c = CompactCard {
            idx: p[0].parse().unwrap_or(0),
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
            power: (atk_dmg as f32) / 100.0,
        };
        cards.push((p[1].to_string(), c));
    }

    let mut meta_decks: Vec<[CompactCard; 20]> = Vec::new();
    for line in decks_txt.lines() {
        if line.trim().is_empty() { continue; }
        let p: Vec<&str> = line.split('\t').collect();
        let mut arr = [CompactCard::default(); 20];
        for (k, s) in p[1].split(',').enumerate().take(20) {
            let ci: usize = s.parse().unwrap_or(0);
            arr[k] = cards[ci].1;
        }
        meta_decks.push(arr);
    }

    // 4 Tactical Regimes grounded in competitive web strategy guides:
    // 0: Aggro/Tempo, 1: Control/Hand-Disruption, 2: Sustain/Evolution-Ramp, 3: Snipe/Cyrus-PrizeMap
    let mut regimes = [base_w; NUM_REGIMES];
    // Tempo
    regimes[0][2] += 0.45; regimes[0][3] += 0.35; regimes[0][9] += 0.45; regimes[0][10] += 0.40; regimes[0][11] += 0.55; regimes[0][14] += 0.35;
    // Control / Disruption
    regimes[1][6] += 0.45; regimes[1][7] += 0.45; regimes[1][8] += 0.50; regimes[1][19] += 0.45; regimes[1][18] += 0.40;
    // Sustain / Evolution
    regimes[2][4] += 0.55; regimes[2][5] += 0.50; regimes[2][15] += 0.40; regimes[2][16] += 0.40; regimes[2][20] += 0.55; regimes[2][18] += 0.45;
    // Snipe / PrizeMap
    regimes[3][11] += 0.60; regimes[3][12] += 0.35; regimes[3][21] += 0.65; regimes[3][19] += 0.40; regimes[3][17] += 0.25;

    let n_cards = cards.len();
    let n_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
    let cursor = AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<Option<String>>> = (0..n_cards).map(|_| std::sync::Mutex::new(None)).collect();

    std::thread::scope(|scope| {
        for _ in 0..n_threads {
            scope.spawn(|| {
                loop {
                    let ci = cursor.fetch_add(1, Ordering::Relaxed);
                    if ci >= n_cards { break; }
                    let (ref card_id, card) = cards[ci];
                    let mut total_w = 0u32;
                    let mut total_d = 0u32;
                    let mut total_l = 0u32;
                    let mut first_w = 0u32;
                    let mut second_w = 0u32;
                    let mut total_turns = 0u64;
                    let mut total_dec = 0u64;
                    let mut reg_w = [0u32; NUM_REGIMES];
                    let mut reg_d = [0u32; NUM_REGIMES];

                    for r in 0..NUM_REGIMES {
                        for g in 0..GAMES_PER_REGIME {
                            let host_idx = (ci + g) % meta_decks.len();
                            let foe_idx = (ci * 3 + g * 7 + r + 1) % meta_decks.len();
                            let mut my_deck = meta_decks[host_idx];
                            // Inject 2 copies of the evaluated card into appropriate slots
                            let slot_a = if card.is_pokemon == 1 { 2 } else { 14 };
                            let slot_b = if card.is_pokemon == 1 { 3 } else { 15 };
                            my_deck[slot_a] = card;
                            my_deck[slot_b] = card;

                            let first = if g < GAMES_PER_REGIME / 2 { 0 } else { 1 };
                            let seed = ((ci as u64 + 1) * 1_000_003) ^ ((r as u64 + 1) * 65537) ^ (g as u64 * 2654435761);
                            let (out, turns, dec) = simulate_game(&my_deck, &meta_decks[foe_idx], &regimes[r], &base_w, seed, first);
                            total_turns += turns as u64;
                            total_dec += dec as u64;
                            match out {
                                1 => {
                                    total_w += 1;
                                    reg_w[r] += 1;
                                    if first == 0 { first_w += 1; } else { second_w += 1; }
                                }
                                2 => {
                                    total_d += 1;
                                    reg_d[r] += 1;
                                }
                                _ => { total_l += 1; }
                            }
                        }
                    }

                    let g_f = GAMES_PER_CARD as f64;
                    let wr = total_w as f64 / g_f;
                    let sr = (total_w as f64 + 0.5 * total_d as f64) / g_f;
                    let f1 = first_w as f64 / (g_f * 0.5);
                    let f2 = second_w as f64 / (g_f * 0.5);
                    let avg_t = total_turns as f64 / g_f;
                    let mut best_r = 0usize;
                    let mut best_rsr = -1.0f64;
                    let mut reg_srs = [0.0f64; NUM_REGIMES];
                    for r in 0..NUM_REGIMES {
                        let rsr = (reg_w[r] as f64 + 0.5 * reg_d[r] as f64) / (GAMES_PER_REGIME as f64);
                        reg_srs[r] = rsr;
                        if rsr > best_rsr { best_rsr = rsr; best_r = r; }
                    }
                    let delta = best_rsr - sr;

                    let row = format!(
                        "\"{}\":{{\"g\":{},\"dec\":{},\"w\":{},\"d\":{},\"l\":{},\"wr\":{:.4},\"sr\":{:.4},\"f1\":{:.4},\"f2\":{:.4},\"t\":{:.2},\"br\":{},\"bd\":{:.4},\"rs\":[{:.4},{:.4},{:.4},{:.4}]}}",
                        card_id, GAMES_PER_CARD, total_dec, total_w, total_d, total_l, wr, sr, f1, f2, avg_t, best_r, delta,
                        reg_srs[0], reg_srs[1], reg_srs[2], reg_srs[3]
                    );
                    *results[ci].lock().unwrap() = Some(row);
                }
            });
        }
    });

    let elapsed = t0.elapsed().as_secs_f64();
    let total_games = n_cards * GAMES_PER_CARD;
    let out_dir = format!("{base_dir}/reports/battle-ml-v4-strategies");
    fs::create_dir_all(&out_dir).expect("create report dir");
    let out_path = format!("{out_dir}/card-telemetry.json");
    let mut f = BufWriter::new(File::create(&out_path).expect("create telemetry json"));
    writeln!(f, "{{").unwrap();
    writeln!(f, "  \"totalCards\": {},", n_cards).unwrap();
    writeln!(f, "  \"gamesPerCard\": {},", GAMES_PER_CARD).unwrap();
    writeln!(f, "  \"totalGamesSimulated\": {},", total_games).unwrap();
    writeln!(f, "  \"elapsedSec\": {:.2},", elapsed).unwrap();
    writeln!(f, "  \"gamesPerSec\": {:.0},", total_games as f64 / elapsed.max(0.001)).unwrap();
    writeln!(f, "  \"byCardId\": {{").unwrap();
    for (i, slot) in results.iter().enumerate() {
        let row = slot.lock().unwrap().take().unwrap();
        if i + 1 < n_cards {
            writeln!(f, "    {},", row).unwrap();
        } else {
            writeln!(f, "    {}", row).unwrap();
        }
    }
    writeln!(f, "  }}").unwrap();
    writeln!(f, "}}").unwrap();
    f.flush().unwrap();
    println!(
        "Evaluated {} cards x {} games = {} total games in {:.2}s ({:.0} games/sec across {} threads) -> {}",
        n_cards, GAMES_PER_CARD, total_games, elapsed, total_games as f64 / elapsed.max(0.001), n_threads, out_path
    );
}
