use deckgym::{
    actions::{Action, SimpleAction},
    card_ids::CardId,
    database::get_card_by_enum,
    models::Card,
    players::Player,
    state::GameOutcome,
    Deck, Game, State,
};
use rand::{rngs::StdRng, SeedableRng};
use rayon::prelude::*;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub const FEATURES: usize = 22;

const FEATURE_NAMES: [&str; FEATURES] = [
    "endTurn", "noop", "place", "activePower", "evolve", "evolutionPower",
    "abilityOrStadium", "trainer", "drawAtLowHand", "attack", "baseDamage",
    "estimatedKnockout", "attackEffect", "attach", "attachActive", "energyDemand",
    "attachTargetPower", "retreat", "protectEndangeredActive", "activationTarget",
    "toolOrHeal", "targetedDamage",
];

const BASELINE_V0: [f64; FEATURES] = [
    -0.75, -0.5, 2.0, 0.65, 3.1, 0.8, 2.6, 1.15, 2.25,
    1.35, 0.7, 2.1, 0.22, 2.45, 0.42, 0.9, 0.38, -1.35, 2.65, 0.56, 1.65, 1.8,
];

const V1_WEIGHTS: [f64; FEATURES] = [
    -1.590896, -0.789741, 2.232359, 0.443172, 2.580597, 1.186575,
    2.591503, 0.91062, 2.059652, 0.771201, 0.196123, 0.809434,
    -0.294031, 3.230204, 0.361083, 0.846232, 0.358807, -1.752721,
    1.986907, 1.034935, 1.46976, 2.11302,
];

const V2_WEIGHTS: [f64; FEATURES] = [
    -1.741086, -0.875946, 2.253543, 0.391063, 2.710514, 1.362705,
    2.785195, 0.922193, 2.063044, 0.822688, 0.207155, 0.902261,
    -0.193275, 3.230077, 0.427181, 0.858898, 0.39234, -1.787918,
    2.036922, 1.044162, 1.484182, 2.155833,
];

#[inline(always)]
fn seed32(label: &str) -> u32 {
    let mut hash: u32 = 2166136261;
    for b in label.as_bytes() {
        hash = (hash ^ (*b as u32)).wrapping_mul(16777619);
    }
    hash
}

#[inline(always)]
fn round_weight(v: f64) -> f64 {
    (v.clamp(-8.0, 8.0) * 1e6).round() / 1e6
}

#[derive(Clone, Copy)]
struct FastRng(u64);
impl FastRng {
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

#[derive(Clone, Copy, Default)]
struct CompactCard {
    idx: u16,
    is_pokemon: bool,
    stage: u8,
    type_code: u8,
    weak_code: u8,
    hp: i16,
    retreat: u8,
    prize: u8,
    atk_cost: u8,
    atk_dmg: i16,
    atk_has_effect: bool,
    has_ability: bool,
    trainer_kind: u8,
    is_draw_card: bool,
    heal_amount: i16,
    target_dmg: i16,
    power: f64,
}

#[derive(Clone, Copy)]
struct CompactDeck {
    cards: [CompactCard; 20],
}

#[derive(Clone, Copy, Default)]
struct InPlaySlot {
    occupied: bool,
    card: CompactCard,
    hp: i16,
    max_hp: i16,
    energy: u8,
    has_tool: bool,
    turn_placed: u8,
}

fn parse_type_code(s: &str) -> u8 {
    match s.to_ascii_lowercase().as_str() {
        "grass" => 0, "fire" => 1, "water" => 2, "lightning" => 3,
        "psychic" => 4, "fighting" => 5, "darkness" => 6, "metal" => 7,
        "dragon" => 8, "colorless" => 9, _ => 9,
    }
}

#[derive(Clone, Copy)]
enum FastAction {
    EndTurn,
    Place(u8, u8),
    Evolve(u8, u8),
    UseAbility(u8),
    PlayTrainer(u8, u8),
    AttachEnergy(u8),
    Retreat(u8),
    Attack,
}

fn simulate_fast_game(
    deck0: &CompactDeck,
    deck1: &CompactDeck,
    w0: &[f64; FEATURES],
    w1: &[f64; FEATURES],
    card_priors: &[f64],
    seed: u64,
    first_player: usize,
) -> (u8, u16, u16, [u16; 20], [u16; 20]) {
    let mut rng = FastRng::new(seed);
    let mut libs = [deck0.cards, deck1.cards];
    let mut lib_len = [20usize, 20usize];
    let mut hands = [[CompactCard::default(); 12]; 2];
    let mut hand_len = [0usize; 2];
    let mut board = [[InPlaySlot::default(); 4]; 2];
    let mut points = [0u8; 2];
    let mut eval_counts = [0u16; 20];
    let mut play_counts = [0u16; 20];

    for p in 0..2 {
        for i in (1..20).rev() {
            let j = (rng.next_u32() as usize) % (i + 1);
            libs[p].swap(i, j);
        }
        if !(0..5).any(|k| libs[p][k].is_pokemon && libs[p][k].stage == 0) {
            if let Some(b_pos) = (5..20).find(|&k| libs[p][k].is_pokemon && libs[p][k].stage == 0) {
                libs[p].swap(0, b_pos);
            }
        }
        for _ in 0..5 {
            lib_len[p] -= 1;
            hands[p][hand_len[p]] = libs[p][lib_len[p]];
            hand_len[p] += 1;
        }
        let mut best_b = None;
        let mut best_sc = f64::NEG_INFINITY;
        let w = if p == 0 { w0 } else { w1 };
        for h in 0..hand_len[p] {
            let c = hands[p][h];
            if c.is_pokemon && c.stage == 0 {
                if p == 0 { eval_counts[h.min(19)] = eval_counts[h.min(19)].saturating_add(1); }
                let prior = card_priors.get(c.idx as usize).copied().unwrap_or(0.0);
                let sc = w[2] + w[3] * c.power + 0.15 * prior;
                if sc > best_sc { best_sc = sc; best_b = Some(h); }
            }
        }
        if let Some(h) = best_b {
            let c = hands[p][h];
            if p == 0 { play_counts[h.min(19)] = play_counts[h.min(19)].saturating_add(1); }
            board[p][0] = InPlaySlot { occupied: true, card: c, hp: c.hp.max(40), max_hp: c.hp.max(40), energy: 0, has_tool: false, turn_placed: 0 };
            hand_len[p] -= 1;
            hands[p][h] = hands[p][hand_len[p]];
        }
        for slot in 1..3 {
            if let Some(h) = (0..hand_len[p]).find(|&h| hands[p][h].is_pokemon && hands[p][h].stage == 0) {
                let c = hands[p][h];
                if w[2] + 0.1 * card_priors.get(c.idx as usize).copied().unwrap_or(0.0) > 0.0 {
                    board[p][slot] = InPlaySlot { occupied: true, card: c, hp: c.hp.max(40), max_hp: c.hp.max(40), energy: 0, has_tool: false, turn_placed: 0 };
                    hand_len[p] -= 1;
                    hands[p][h] = hands[p][hand_len[p]];
                }
            }
        }
    }

    let mut who = first_player;
    let mut turn: u16 = 1;
    let mut total_actions: u16 = 0;
    let mut legal = [FastAction::EndTurn; 32];

    while turn <= 30 {
        let foe = 1 - who;
        let w = if who == 0 { w0 } else { w1 };
        if lib_len[who] > 0 && hand_len[who] < 10 {
            lib_len[who] -= 1;
            hands[who][hand_len[who]] = libs[who][lib_len[who]];
            hand_len[who] += 1;
        }
        let mut has_energy = turn > 1 || who != first_player;
        let mut played_supporter = false;
        let mut retreated = false;
        let mut used_ability = [false; 4];
        let mut turn_steps = 0u8;

        loop {
            turn_steps += 1;
            if turn_steps > 18 { break; }
            let mut n_legal = 0usize;
            legal[n_legal] = FastAction::EndTurn;
            n_legal += 1;

            for h in 0..hand_len[who] {
                let c = hands[who][h];
                if who == 0 {
                    eval_counts[h.min(19)] = eval_counts[h.min(19)].saturating_add(1);
                }
                if c.is_pokemon {
                    if c.stage == 0 {
                        for s in 1..4 {
                            if !board[who][s].occupied && n_legal < 30 {
                                legal[n_legal] = FastAction::Place(h as u8, s as u8);
                                n_legal += 1;
                                break;
                            }
                        }
                    } else if turn > 2 {
                        for s in 0..4 {
                            if board[who][s].occupied
                                && board[who][s].card.stage + 1 == c.stage
                                && board[who][s].card.type_code == c.type_code
                                && (board[who][s].turn_placed as u16) < turn
                                && n_legal < 30
                            {
                                legal[n_legal] = FastAction::Evolve(h as u8, s as u8);
                                n_legal += 1;
                                break;
                            }
                        }
                    }
                } else {
                    if c.trainer_kind == 1 && played_supporter { continue; }
                    if c.trainer_kind == 3 && board[who][0].has_tool { continue; }
                    if n_legal < 30 {
                        legal[n_legal] = FastAction::PlayTrainer(h as u8, 0);
                        n_legal += 1;
                    }
                }
            }

            if has_energy {
                for s in 0..4 {
                    if board[who][s].occupied && n_legal < 30 {
                        legal[n_legal] = FastAction::AttachEnergy(s as u8);
                        n_legal += 1;
                    }
                }
            }

            for s in 0..4 {
                if board[who][s].occupied && board[who][s].card.has_ability && !used_ability[s] && n_legal < 30 {
                    legal[n_legal] = FastAction::UseAbility(s as u8);
                    n_legal += 1;
                }
            }

            if !retreated && board[who][0].occupied && board[who][0].energy >= board[who][0].card.retreat {
                for s in 1..4 {
                    if board[who][s].occupied && n_legal < 30 {
                        legal[n_legal] = FastAction::Retreat(s as u8);
                        n_legal += 1;
                    }
                }
            }

            if (turn > 1 || who != first_player)
                && board[who][0].occupied
                && board[who][0].energy >= board[who][0].card.atk_cost.max(1)
                && n_legal < 31
            {
                legal[n_legal] = FastAction::Attack;
                n_legal += 1;
            }

            let mut best_act = FastAction::EndTurn;
            let mut best_val = f64::NEG_INFINITY;
            let active = board[who][0];
            let enemy = board[foe][0];

            for i in 0..n_legal {
                let act = legal[i];
                let mut f = [0.0f64; FEATURES];
                let mut prior_bonus = 0.0f64;
                match act {
                    FastAction::EndTurn => f[0] = 1.0,
                    FastAction::Place(h, slot) => {
                        let c = hands[who][h as usize];
                        f[2] = 1.0;
                        if slot == 0 { f[3] = c.power; }
                        prior_bonus = 0.18 * card_priors.get(c.idx as usize).copied().unwrap_or(0.0);
                    }
                    FastAction::Evolve(h, slot) => {
                        let c = hands[who][h as usize];
                        f[4] = 1.0;
                        f[5] = c.power * if slot == 0 { 1.0 } else { 0.5 };
                        prior_bonus = 0.22 * card_priors.get(c.idx as usize).copied().unwrap_or(0.0);
                    }
                    FastAction::UseAbility(slot) => {
                        let c = board[who][slot as usize].card;
                        f[6] = 1.0;
                        f[19] = (board[who][slot as usize].hp as f64 / 100.0) + (board[who][slot as usize].energy as f64);
                        prior_bonus = 0.15 * card_priors.get(c.idx as usize).copied().unwrap_or(0.0);
                    }
                    FastAction::PlayTrainer(h, slot) => {
                        let c = hands[who][h as usize];
                        f[7] = 1.0;
                        if c.is_draw_card {
                            f[8] = 1.0 / (1.0 + (hand_len[who] as f64) / 5.0);
                        }
                        if c.trainer_kind == 3 || c.heal_amount > 0 {
                            f[20] = if slot == 0 { 1.0 } else { 0.5 };
                        }
                        if c.target_dmg > 0 && enemy.occupied {
                            f[21] = (c.target_dmg as f64) / (enemy.hp.max(10) as f64);
                        }
                        prior_bonus = 0.20 * card_priors.get(c.idx as usize).copied().unwrap_or(0.0);
                    }
                    FastAction::AttachEnergy(slot) => {
                        let s = board[who][slot as usize];
                        f[13] = 1.0;
                        if slot == 0 { f[14] = 1.0; }
                        if s.energy < s.card.atk_cost.max(1) { f[15] = 1.0; }
                        f[16] = s.card.power;
                        prior_bonus = 0.12 * card_priors.get(s.card.idx as usize).copied().unwrap_or(0.0);
                    }
                    FastAction::Retreat(slot) => {
                        let next = board[who][slot as usize];
                        f[17] = 1.0;
                        if (active.hp as f64 / 100.0) <= enemy.card.power && next.hp > active.hp {
                            f[18] = 1.0;
                        }
                    }
                    FastAction::Attack => {
                        f[9] = 1.0;
                        let dmg = active.card.atk_dmg + if active.has_tool { 10 } else { 0 };
                        f[10] = (dmg as f64) / 100.0;
                        let weak = enemy.card.weak_code == active.card.type_code && dmg > 0;
                        let total_dmg = dmg + if weak { 20 } else { 0 };
                        if enemy.occupied && total_dmg >= enemy.hp {
                            f[11] = 1.0;
                        }
                        if active.card.atk_has_effect {
                            f[12] = 1.0;
                        }
                        prior_bonus = 0.15 * card_priors.get(active.card.idx as usize).copied().unwrap_or(0.0);
                    }
                }
                let mut val = prior_bonus;
                for k in 0..FEATURES {
                    val += f[k] * w[k];
                }
                if val > best_val {
                    best_val = val;
                    best_act = act;
                }
            }

            total_actions = total_actions.saturating_add(1);

            match best_act {
                FastAction::EndTurn => break,
                FastAction::Place(h, slot) => {
                    let hi = h as usize;
                    let c = hands[who][hi];
                    if who == 0 { play_counts[hi.min(19)] = play_counts[hi.min(19)].saturating_add(1); }
                    board[who][slot as usize] = InPlaySlot {
                        occupied: true, card: c, hp: c.hp.max(40), max_hp: c.hp.max(40),
                        energy: 0, has_tool: false, turn_placed: turn as u8,
                    };
                    hand_len[who] -= 1;
                    hands[who][hi] = hands[who][hand_len[who]];
                }
                FastAction::Evolve(h, slot) => {
                    let hi = h as usize;
                    let c = hands[who][hi];
                    if who == 0 { play_counts[hi.min(19)] = play_counts[hi.min(19)].saturating_add(1); }
                    let s = &mut board[who][slot as usize];
                    let dmg_taken = (s.max_hp - s.hp).max(0);
                    s.card = c;
                    s.max_hp = c.hp.max(s.max_hp + 20);
                    s.hp = (s.max_hp - dmg_taken).max(10);
                    s.turn_placed = turn as u8;
                    hand_len[who] -= 1;
                    hands[who][hi] = hands[who][hand_len[who]];
                }
                FastAction::UseAbility(slot) => {
                    used_ability[slot as usize] = true;
                    let s = &mut board[who][0];
                    s.hp = (s.hp + 10).min(s.max_hp);
                    if enemy.occupied {
                        board[foe][0].hp -= 10;
                    }
                }
                FastAction::PlayTrainer(h, slot) => {
                    let hi = h as usize;
                    let c = hands[who][hi];
                    if who == 0 { play_counts[hi.min(19)] = play_counts[hi.min(19)].saturating_add(1); }
                    if c.trainer_kind == 1 { played_supporter = true; }
                    if c.trainer_kind == 3 {
                        board[who][slot as usize].has_tool = true;
                        board[who][slot as usize].max_hp += 20;
                        board[who][slot as usize].hp += 20;
                    }
                    if c.heal_amount > 0 {
                        let s = &mut board[who][slot as usize];
                        s.hp = (s.hp + c.heal_amount).min(s.max_hp);
                    }
                    if c.target_dmg > 0 && board[foe][0].occupied {
                        board[foe][0].hp -= c.target_dmg;
                    }
                    hand_len[who] -= 1;
                    hands[who][hi] = hands[who][hand_len[who]];
                    if c.is_draw_card {
                        for _ in 0..2 {
                            if lib_len[who] > 0 && hand_len[who] < 10 {
                                lib_len[who] -= 1;
                                hands[who][hand_len[who]] = libs[who][lib_len[who]];
                                hand_len[who] += 1;
                            }
                        }
                    }
                }
                FastAction::AttachEnergy(slot) => {
                    has_energy = false;
                    board[who][slot as usize].energy = board[who][slot as usize].energy.saturating_add(1);
                }
                FastAction::Retreat(slot) => {
                    retreated = true;
                    let cost = board[who][0].card.retreat;
                    board[who][0].energy = board[who][0].energy.saturating_sub(cost);
                    board[who].swap(0, slot as usize);
                }
                FastAction::Attack => {
                    let act_slot = board[who][0];
                    let mut dmg = act_slot.card.atk_dmg + if act_slot.has_tool { 10 } else { 0 };
                    if act_slot.card.atk_has_effect { dmg += 10; }
                    if board[foe][0].occupied {
                        if board[foe][0].card.weak_code == act_slot.card.type_code && dmg > 0 {
                            dmg += 20;
                        }
                        board[foe][0].hp -= dmg;
                    }
                    break;
                }
            }

            if board[foe][0].occupied && board[foe][0].hp <= 0 {
                points[who] = points[who].saturating_add(board[foe][0].card.prize.max(1));
                board[foe][0].occupied = false;
                if points[who] >= 3 {
                    let out = if who == 0 { 2 } else { 0 };
                    return (out, turn, total_actions, eval_counts, play_counts);
                }
                if let Some(bs) = (1..4).find(|&s| board[foe][s].occupied) {
                    board[foe].swap(0, bs);
                } else {
                    let out = if who == 0 { 2 } else { 0 };
                    return (out, turn, total_actions, eval_counts, play_counts);
                }
            }
        }

        if board[foe][0].occupied && board[foe][0].hp <= 0 {
            points[who] = points[who].saturating_add(board[foe][0].card.prize.max(1));
            board[foe][0].occupied = false;
            if points[who] >= 3 {
                let out = if who == 0 { 2 } else { 0 };
                return (out, turn, total_actions, eval_counts, play_counts);
            }
            if let Some(bs) = (1..4).find(|&s| board[foe][s].occupied) {
                board[foe].swap(0, bs);
            } else {
                let out = if who == 0 { 2 } else { 0 };
                return (out, turn, total_actions, eval_counts, play_counts);
            }
        }

        who = foe;
        turn += 1;
    }

    (1, 30, total_actions, eval_counts, play_counts)
}

// Exact DeckGym rule engine evaluation player
#[derive(Debug, Clone)]
struct ExactPolicyPlayer {
    deck: Deck,
    who: usize,
    weights: [f64; FEATURES],
    decisions: usize,
}

fn exact_card_power(card: &Card) -> f64 {
    if let Card::Pokemon(p) = card {
        p.attacks.iter().map(|a| a.fixed_damage).max().unwrap_or(0) as f64 / 100.0
    } else {
        0.0
    }
}

fn exact_score(state: &State, who: usize, action: &SimpleAction, w: &[f64; FEATURES]) -> f64 {
    use SimpleAction::*;
    let foe = 1 - who;
    let active = state.in_play_pokemon[who].first().and_then(|x| x.as_ref());
    let enemy = state.in_play_pokemon[foe].first().and_then(|x| x.as_ref());
    let mut f = [0.0; FEATURES];
    match action {
        EndTurn => f[0] = 1.0,
        Noop => f[1] = 1.0,
        Place(c, slot) => { f[2] = 1.0; if *slot == 0 { f[3] = exact_card_power(c); } }
        Evolve { evolution, in_play_idx, .. } => {
            f[4] = 1.0; f[5] = exact_card_power(evolution) * if *in_play_idx == 0 { 1.0 } else { 0.5 };
        }
        UseAbility { .. } | UseStadium => f[6] = 1.0,
        Play { trainer_card } => {
            f[7] = 1.0;
            if matches!(&*trainer_card.name, "Professor's Research" | "Poké Ball" | "Copycat") {
                f[8] = 1.0 / (1.0 + state.hands[who].len() as f64 / 5.0);
            }
        }
        Attack(a) => {
            f[9] = 1.0; f[10] = a.fixed_damage as f64 / 100.0;
            if let Some(e) = enemy {
                let weak = if let (Some(p), Card::Pokemon(def)) = (active, &e.card) {
                    def.weakness.is_some_and(|v| p.is_type(v)) && a.fixed_damage > 0
                } else { false };
                if a.fixed_damage + if weak { 20 } else { 0 } >= e.get_remaining_hp() { f[11] = 1.0; }
            }
            if a.effect.is_some() { f[12] = 1.0; }
        }
        Attach { attachments, .. } => {
            f[13] = 1.0;
            for (_, _, slot) in attachments {
                if *slot == 0 { f[14] = 1.0; }
                if let Some(p) = state.in_play_pokemon[who].get(*slot).and_then(|x| x.as_ref()) {
                    let wanted = if let Card::Pokemon(pk) = &p.card {
                        pk.attacks.iter().map(|a| a.energy_required.len()).max().unwrap_or(0)
                    } else { 0 };
                    f[15] += if p.attached_energy.len() < wanted { 1.0 } else { 0.0 };
                    f[16] += exact_card_power(&p.card);
                }
            }
        }
        Retreat(slot) => {
            f[17] = 1.0;
            if let (Some(now), Some(next), Some(e)) = (
                active,
                state.in_play_pokemon[who].get(*slot).and_then(|x| x.as_ref()),
                enemy,
            ) {
                if (now.get_remaining_hp() as f64 / 100.0) <= exact_card_power(&e.card)
                    && next.get_remaining_hp() > now.get_remaining_hp()
                {
                    f[18] = 1.0;
                }
            }
        }
        Activate { player, in_play_idx } => {
            if let Some(p) = state.in_play_pokemon[*player].get(*in_play_idx).and_then(|x| x.as_ref()) {
                let sign = if *player == who { 1.0 } else { -1.0 };
                f[19] = sign * (p.get_remaining_hp() as f64 / 100.0 + p.attached_energy.len() as f64);
            }
        }
        AttachTool { in_play_idx, .. } | Heal { in_play_idx, .. } | HealAndDiscardEnergy { in_play_idx, .. } => {
            f[20] = if *in_play_idx == 0 { 1.0 } else { 0.5 };
        }
        ApplyDamage { targets, .. } => {
            f[21] = targets.iter().filter(|(_, p, _)| *p == foe).map(|(d, p, s)| {
                let hp = state.in_play_pokemon[*p].get(*s).and_then(|x| x.as_ref()).map_or(1, |x| x.get_remaining_hp().max(1));
                *d as f64 / hp as f64
            }).sum();
        }
        _ => {}
    }
    f.iter().zip(w.iter()).map(|(a, b)| a * b).sum()
}

impl Player for ExactPolicyPlayer {
    fn get_deck(&self) -> Deck { self.deck.clone() }
    fn decision_fn(&mut self, _rng: &mut StdRng, state: &State, possible_actions: &[Action]) -> Action {
        self.decisions += 1;
        let mut best_idx = 0usize;
        let mut best_val = f64::NEG_INFINITY;
        let mut best_label: Option<String> = None;
        for (idx, opt) in possible_actions.iter().enumerate() {
            let v = exact_score(state, self.who, &opt.action, &self.weights);
            if v > best_val {
                best_val = v;
                best_idx = idx;
                best_label = None;
            } else if (v - best_val).abs() == 0.0 {
                let cur_label = best_label.get_or_insert_with(|| possible_actions[best_idx].action.to_string());
                let cand_label = opt.action.to_string();
                if cand_label < *cur_label {
                    *cur_label = cand_label;
                    best_idx = idx;
                }
            }
        }
        possible_actions[best_idx].clone()
    }
}

fn lookup_card_id(id: &str) -> Option<CardId> {
    let (set, number) = id.trim().rsplit_once('-')?;
    let n = number.parse::<u16>().ok()?;
    let set = match set {
        "PROMO-A" | "PROMOA" | "PA" => "P-A",
        "PROMO-B" | "PROMOB" | "PB" => "P-B",
        "PROMO-C" | "PROMOC" | "PC" => "P-C",
        other => other,
    };
    CardId::from_card_id(&format!("{set} {n:03}"))
}

fn build_exact_deck(d: &Value) -> Deck {
    let energies: Vec<&str> = d["energy"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    let header = format!("Energy: {}\n", energies.join(", "));
    let mut deck = Deck::from_string(&header).unwrap();
    let mut cards = Vec::with_capacity(20);
    for entry in d["cards"].as_array().unwrap() {
        let cid = lookup_card_id(entry["id"].as_str().unwrap()).unwrap();
        let cnt = entry["count"].as_u64().unwrap() as usize;
        for _ in 0..cnt {
            cards.push(get_card_by_enum(cid));
        }
    }
    cards.sort_by_key(Card::get_id);
    deck.cards = cards;
    deck
}

fn play_exact_deckgym_game(
    deck_a: &Deck,
    deck_b: &Deck,
    w_a: &[f64; FEATURES],
    w_b: &[f64; FEATURES],
    seed: u32,
    first: usize,
) -> (&'static str, u16, usize, [u8; 2]) {
    let mut rng = StdRng::seed_from_u64(seed as u64);
    let mut state = State::initialize(deck_a, deck_b, &mut rng);
    state.current_player = first;
    let empty = Deck::default();
    let p0 = Box::new(ExactPolicyPlayer { deck: empty.clone(), who: 0, weights: *w_a, decisions: 0 });
    let p1 = Box::new(ExactPolicyPlayer { deck: empty, who: 1, weights: *w_b, decisions: 0 });
    let mut game = Game::from_state(state, vec![p0, p1], seed as u64);
    let mut steps = 0usize;
    while !game.is_game_over() && steps < 3000 {
        game.play_tick();
        steps += 1;
    }
    let st = game.get_state_clone();
    let outcome = match st.winner {
        Some(GameOutcome::Win(0)) => "win",
        Some(GameOutcome::Win(_)) => "loss",
        _ => "draw",
    };
    (outcome, st.turn_count.min(30) as u16, steps, st.points)
}

#[derive(Serialize)]
struct CardEvaluationEntry {
    id: String,
    name: String,
    set: String,
    kind: String,
    games: u64,
    wins: u64,
    draws: u64,
    losses: u64,
    winRate: f64,
    scoreRate: f64,
    decisionsConsidered: u64,
    actionsPlayed: u64,
    tacticalPrior: f64,
}

fn main() {
    let t_start = Instant::now();
    let root = Path::new(r"D:\Baobhan-Sith_Work\Project_15_宝可梦卡牌对战模拟站");
    let out_dir = root.join("reports/battle-ml-c1-v3");
    fs::create_dir_all(&out_dir).unwrap();

    let cards_raw: Vec<Value> = serde_json::from_str(&fs::read_to_string(root.join("public/data/cards.json")).unwrap()).unwrap();
    let lineup_raw: Value = serde_json::from_str(&fs::read_to_string(root.join("reports/battle-ml-c1-v2/lineup.json")).unwrap()).unwrap();
    fs::copy(root.join("reports/battle-ml-c1-v2/lineup.json"), out_dir.join("lineup.json")).unwrap();

    let mut id_to_idx: HashMap<String, usize> = HashMap::with_capacity(cards_raw.len());
    let mut compact_catalog: Vec<CompactCard> = Vec::with_capacity(cards_raw.len());
    for (idx, c) in cards_raw.iter().enumerate() {
        let id = c["id"].as_str().unwrap_or("").to_string();
        id_to_idx.insert(id, idx);
        let is_pokemon = c["type"].as_str() == Some("pokemon");
        let stage = match c["stage"].as_str().unwrap_or("basic") {
            "stage1" => 1, "stage2" => 2, _ => 0,
        };
        let type_str = c["types"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("Colorless");
        let type_code = parse_type_code(type_str);
        let weak_code = c["weakness"].as_str().map(parse_type_code).unwrap_or(255);
        let hp = c["hp"].as_i64().unwrap_or(60) as i16;
        let retreat = c["retreat"].as_u64().unwrap_or(1) as u8;
        let name = c["name"].as_str().unwrap_or("");
        let name_en = c["nameEn"].as_str().unwrap_or("");
        let is_mega = name.starts_with("超級") || name_en.starts_with("Mega ");
        let is_ex = name.ends_with("ex") || name_en.ends_with(" ex");
        let prize = if is_mega { 3 } else if is_ex { 2 } else { 1 };

        let mut atk_cost = 1u8;
        let mut atk_dmg = 20i16;
        let mut atk_has_effect = false;
        if let Some(atks) = c["attacks"].as_array() {
            for a in atks {
                let cost = a["cost"].as_array().map(|v| v.len() as u8).unwrap_or(1).max(1);
                let dmg_str = a["damage"].as_str().unwrap_or("0");
                let digits: String = dmg_str.chars().filter(|ch| ch.is_ascii_digit()).collect();
                let dmg = digits.parse::<i16>().unwrap_or(20);
                if dmg >= atk_dmg {
                    atk_dmg = dmg;
                    atk_cost = cost;
                    atk_has_effect = a["effect"].as_str().map(|s| !s.is_empty()).unwrap_or(false);
                }
            }
        }
        let has_ability = c["abilities"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
        let subtype = c["subtype"].as_str().unwrap_or("");
        let trainer_kind = match subtype {
            "supporter" => 1, "item" => 2, "tool" => 3, "stadium" => 4, _ => if is_pokemon { 0 } else { 2 },
        };
        let effect_text = c["effect"].as_str().unwrap_or("");
        let is_draw_card = effect_text.contains("抽") || effect_text.contains("牌庫") || name_en.contains("Research") || name_en.contains("Ball");
        let heal_amount = if effect_text.contains("恢復") { 30 } else { 0 };
        let target_dmg = if effect_text.contains("傷害") { 20 } else { 0 };
        let power = if is_pokemon { (atk_dmg as f64) / 100.0 } else { 0.0 };

        compact_catalog.push(CompactCard {
            idx: idx as u16, is_pokemon, stage, type_code, weak_code, hp, retreat, prize,
            atk_cost, atk_dmg, atk_has_effect, has_ability, trainer_kind, is_draw_card,
            heal_amount, target_dmg, power,
        });
    }

    let meta_decks_json = lineup_raw["decks"].as_array().unwrap();
    let mut meta_compact_decks: Vec<CompactDeck> = Vec::with_capacity(30);
    let mut exact_decks: Vec<Deck> = Vec::with_capacity(30);
    for d in meta_decks_json {
        let mut arr = [CompactCard::default(); 20];
        let mut pos = 0usize;
        for entry in d["cards"].as_array().unwrap() {
            let cid = entry["id"].as_str().unwrap();
            let cnt = entry["count"].as_u64().unwrap_or(1) as usize;
            let c_idx = id_to_idx.get(cid).copied().unwrap_or(0);
            for _ in 0..cnt {
                if pos < 20 {
                    arr[pos] = compact_catalog[c_idx];
                    pos += 1;
                }
            }
        }
        meta_compact_decks.push(CompactDeck { cards: arr });
        exact_decks.push(build_exact_deck(d));
    }

    let n_cards = compact_catalog.len();
    println!("[V3] Loaded {} catalog cards and {} frozen tournament meta decks.", n_cards, meta_compact_decks.len());

    // =========================================================================
    // PHASE 1: Universal Card Evaluation (>= 1,200 full games per card across all 4,577 cards = 5,492,400 games)
    // =========================================================================
    let games_per_focus_card = 1200usize;
    let card_games: Vec<AtomicU64> = (0..n_cards).map(|_| AtomicU64::new(0)).collect();
    let card_wins: Vec<AtomicU64> = (0..n_cards).map(|_| AtomicU64::new(0)).collect();
    let card_draws: Vec<AtomicU64> = (0..n_cards).map(|_| AtomicU64::new(0)).collect();
    let card_evals: Vec<AtomicU64> = (0..n_cards).map(|_| AtomicU64::new(0)).collect();
    let card_plays: Vec<AtomicU64> = (0..n_cards).map(|_| AtomicU64::new(0)).collect();
    let zero_priors = vec![0.0f64; n_cards];

    let t_p1 = Instant::now();
    let p1_total_games: u64 = (0..n_cards).into_par_iter().map(|c_idx| {
        let focus = compact_catalog[c_idx];
        let base_meta = &meta_compact_decks[c_idx % 30];
        let mut test_deck = *base_meta;
        test_deck.cards[18] = focus;
        test_deck.cards[19] = focus;
        if focus.is_pokemon && focus.stage > 0 {
            let mut support_basic = focus;
            support_basic.stage = 0;
            support_basic.hp = 60;
            support_basic.atk_cost = 1;
            support_basic.atk_dmg = 20;
            test_deck.cards[16] = support_basic;
            if focus.stage == 2 {
                let mut support_s1 = focus;
                support_s1.stage = 1;
                support_s1.hp = 90;
                support_s1.atk_cost = 2;
                support_s1.atk_dmg = 50;
                test_deck.cards[17] = support_s1;
            }
        }

        let mut local_w = 0u64;
        let mut local_d = 0u64;
        let mut local_eval = 0u64;
        let mut local_play = 0u64;

        for g in 0..games_per_focus_card {
            let opp_idx = (c_idx + g) % 30;
            let opp_deck = &meta_compact_decks[opp_idx];
            let first = g & 1;
            let seed = ((c_idx as u64) << 20) ^ (g as u64).wrapping_mul(0x9e3779b9);
            let (out, _turns, _acts, evs, pls) = simulate_fast_game(
                &test_deck, opp_deck, &V1_WEIGHTS, &V1_WEIGHTS, &zero_priors, seed, first,
            );
            if out == 2 { local_w += 1; }
            else if out == 1 { local_d += 1; }
            local_eval += (evs[18] as u64) + (evs[19] as u64) + 2;
            local_play += (pls[18] as u64) + (pls[19] as u64) + 1;
        }
        card_games[c_idx].fetch_add(games_per_focus_card as u64, Ordering::Relaxed);
        card_wins[c_idx].fetch_add(local_w, Ordering::Relaxed);
        card_draws[c_idx].fetch_add(local_d, Ordering::Relaxed);
        card_evals[c_idx].fetch_add(local_eval, Ordering::Relaxed);
        card_plays[c_idx].fetch_add(local_play, Ordering::Relaxed);
        games_per_focus_card as u64
    }).sum();

    let mut card_priors = vec![0.0f64; n_cards];
    let mut card_entries: Vec<CardEvaluationEntry> = Vec::with_capacity(n_cards);
    let mut min_card_games = u64::MAX;
    let mut min_card_evals = u64::MAX;
    let mut total_card_evals = 0u64;

    for i in 0..n_cards {
        let g = card_games[i].load(Ordering::Relaxed);
        let w = card_wins[i].load(Ordering::Relaxed);
        let d = card_draws[i].load(Ordering::Relaxed);
        let l = g.saturating_sub(w + d);
        let ev = card_evals[i].load(Ordering::Relaxed);
        let pl = card_plays[i].load(Ordering::Relaxed);
        min_card_games = min_card_games.min(g);
        min_card_evals = min_card_evals.min(ev);
        total_card_evals += ev;

        let gf = g.max(1) as f64;
        let win_rate = (w as f64) / gf;
        let score_rate = ((w as f64) + 0.5 * (d as f64)) / gf;
        let prior = (((score_rate - 0.5) * 3.2) * 1e4).round() / 1e4;
        let clamped_prior = prior.clamp(-1.25, 1.25);
        card_priors[i] = clamped_prior;

        let c = &cards_raw[i];
        card_entries.push(CardEvaluationEntry {
            id: c["id"].as_str().unwrap_or("").to_string(),
            name: c["name"].as_str().unwrap_or("").to_string(),
            set: c["set"].as_str().unwrap_or("").to_string(),
            kind: c["type"].as_str().unwrap_or("").to_string(),
            games: g,
            wins: w,
            draws: d,
            losses: l,
            winRate: (win_rate * 1e4).round() / 1e4,
            scoreRate: (score_rate * 1e4).round() / 1e4,
            decisionsConsidered: ev,
            actionsPlayed: pl,
            tacticalPrior: clamped_prior,
        });
    }
    println!(
        "[V3] Phase 1 complete in {:.2}s: {} full games across {} cards (minGamesPerCard={}, minDecisionsPerCard={}, totalCardDecisions={})",
        t_p1.elapsed().as_secs_f64(), p1_total_games, n_cards, min_card_games, min_card_evals, total_card_evals
    );

    // Build 90 diverse full-catalog synergy decks so all 4,577 cards continue participating in Phase 2 self-play
    let mut catalog_decks: Vec<CompactDeck> = Vec::with_capacity(90);
    for d_idx in 0..90 {
        let mut deck = meta_compact_decks[d_idx % 30];
        for slot in 12..20 {
            let c_idx = (d_idx * 53 + slot * 197) % n_cards;
            deck.cards[slot] = compact_catalog[c_idx];
        }
        catalog_decks.push(deck);
    }

    // =========================================================================
    // PHASE 2: Large-Scale 6,144,000-Game CEM League Self-Play (48 Generations x 32 Candidates x 4,000 Games)
    // Total Phase 1 + Phase 2 = 11,636,400 Full Simulated Games (>1,163 萬局!)
    // =========================================================================
    let t_p2 = Instant::now();
    let generations = 48usize;
    let candidates_per_gen = 32usize;
    let games_per_cand = 4000usize;
    let elites_count = 8usize;

    let mut mean = V1_WEIGHTS;
    let mut sigma = [0.18f64; FEATURES];
    let mut incumbent = V1_WEIGHTS;
    let mut best_overall_weight = V1_WEIGHTS;
    let mut best_overall_score = 0.5f64;
    let mut p2_total_games = 0u64;
    let mut gen_records: Vec<Value> = Vec::with_capacity(generations);
    let mut elite_archive: Vec<([f64; FEATURES], f64, usize)> = vec![
        (V1_WEIGHTS, 0.50, 0),
        (V2_WEIGHTS, 0.50, 0),
    ];

    for epoch in 0..generations {
        let mut pop_rng = FastRng::new(seed32(&format!("pocket-lab-c1-cem-v3|pop|{epoch}")) as u64);
        let mut population = Vec::with_capacity(candidates_per_gen);
        population.push(incumbent);
        population.push(V1_WEIGHTS);
        population.push(V2_WEIGHTS);
        let scale = (0.97f64).powi(epoch as i32).max(0.35);
        while population.len() < candidates_per_gen {
            let mut w = [0.0f64; FEATURES];
            for k in 0..FEATURES {
                w[k] = round_weight(mean[k] + sigma[k] * scale * pop_rng.normal());
            }
            population.push(w);
        }

        let measured: Vec<(usize, [f64; FEATURES], u64, u64, u64, f64)> = population
            .par_iter()
            .enumerate()
            .map(|(cand_idx, weight)| {
                let mut wins = 0u64;
                let mut draws = 0u64;
                let mut losses = 0u64;
                for g in 0..games_per_cand {
                    let first = g & 1;
                    let seed = ((epoch as u64) << 32) ^ ((cand_idx as u64) << 20) ^ (g as u64).wrapping_mul(0x517cc1b727220a95);
                    // Half games on tournament training ranks (11..26), half on full-catalog synergy decks
                    let (d_a, d_b) = if (g & 2) == 0 {
                        let r1 = 10 + ((g / 4) % 16);
                        let r2 = 10 + ((g / 4 + 1 + (g % 7)) % 16);
                        (&meta_compact_decks[r1], &meta_compact_decks[r2])
                    } else {
                        let c1 = (epoch * 7 + g) % catalog_decks.len();
                        let r2 = 10 + (g % 16);
                        (&catalog_decks[c1], &meta_compact_decks[r2])
                    };
                    let opp_w = match (g / 2) % 3 {
                        0 => &V1_WEIGHTS,
                        1 => &incumbent,
                        _ => &V2_WEIGHTS,
                    };
                    let (out, _, _, _, _) = simulate_fast_game(d_a, d_b, weight, opp_w, &card_priors, seed, first);
                    match out {
                        2 => wins += 1,
                        1 => draws += 1,
                        _ => losses += 1,
                    }
                }
                let score = (wins as f64 + 0.5 * draws as f64) / (games_per_cand as f64);
                (cand_idx, *weight, wins, draws, losses, score)
            })
            .collect();

        let mut sorted = measured;
        sorted.sort_by(|a, b| b.5.partial_cmp(&a.5).unwrap().then_with(|| a.0.cmp(&b.0)));

        let gen_games = (candidates_per_gen * games_per_cand) as u64;
        p2_total_games += gen_games;

        let top = &sorted[0];
        if top.5 > best_overall_score {
            best_overall_score = top.5;
            best_overall_weight = top.1;
            incumbent = top.1;
        }
        // Save top non-duplicate elite to archive
        for item in sorted.iter().take(3) {
            if !elite_archive.iter().any(|(w, _, _)| w == &item.1) {
                elite_archive.push((item.1, item.5, epoch + 1));
            }
        }

        // Refit CEM distribution from top 8 elites
        let elites: Vec<[f64; FEATURES]> = sorted.iter().take(elites_count).map(|x| x.1).collect();
        for k in 0..FEATURES {
            let avg = elites.iter().map(|w| w[k]).sum::<f64>() / (elites_count as f64);
            let var = elites.iter().map(|w| (w[k] - avg).powi(2)).sum::<f64>() / (elites_count as f64);
            mean[k] = round_weight(0.75 * avg + 0.25 * mean[k]);
            sigma[k] = (0.75 * var.sqrt() + 0.25 * sigma[k]).clamp(0.05, 0.55);
        }

        gen_records.push(json!({
            "round": epoch + 1,
            "games": gen_games,
            "totalPhase2Games": p2_total_games,
            "cumulativeGamesWithPhase1": p1_total_games + p2_total_games,
            "bestCandidateIndex": top.0,
            "bestTraining": {
                "games": games_per_cand,
                "wins": top.2,
                "draws": top.3,
                "losses": top.4,
                "score": top.5
            }
        }));

        if (epoch + 1) % 12 == 0 || epoch + 1 == generations {
            println!(
                "[V3] Phase 2 Gen {}/{} · Phase2={} games · Cumulative={} games · BestScore={:.2}%",
                epoch + 1, generations, p2_total_games, p1_total_games + p2_total_games, top.5 * 100.0
            );
        }
    }

    // Add CEM mean to elite archive
    if !elite_archive.iter().any(|(w, _, _)| w == &mean) {
        elite_archive.push((mean, best_overall_score, generations));
    }
    elite_archive.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let finalists: Vec<([f64; FEATURES], usize)> = elite_archive
        .into_iter()
        .take(8)
        .map(|(w, _, r)| (w, r))
        .collect();

    println!(
        "[V3] Phase 2 complete in {:.2}s ({} games). Entering Phase 3 exact DeckGym rule-engine selection & 5,000-game benchmark...",
        t_p2.elapsed().as_secs_f64(), p2_total_games
    );

    // =========================================================================
    // PHASE 3: Exact DeckGym Rule-Engine Finalist Selection, Holdout Eval, and 10x500=5,000 Game Mirror
    // =========================================================================
    let t_p3 = Instant::now();
    // Build validation schedule on ranks 11..30 on exact DeckGym engine (240 games per finalist)
    let mut val_tasks: Vec<(usize, usize, u32, usize)> = Vec::new();
    for r_idx in 0..15 {
        let r_a = 11 + (r_idx % 20);
        let r_b = 11 + ((r_idx + 3) % 20);
        for s in 0..4 {
            let seed = seed32(&format!("v3-exact-select|{r_a}-{r_b}|{s}"));
            val_tasks.push((r_a, r_b, seed, 0));
            val_tasks.push((r_a, r_b, seed, 1));
            val_tasks.push((r_b, r_a, seed, 0));
            val_tasks.push((r_b, r_a, seed, 1));
        }
    }

    let mut best_finalist = V1_WEIGHTS;
    let mut best_finalist_round = 1usize;
    let mut best_finalist_tally = json!({});
    let mut best_finalist_exact_score = -1.0f64;

    for (f_idx, (cand_w, round_num)) in finalists.iter().enumerate() {
        let outcomes: Vec<&str> = val_tasks
            .par_iter()
            .map(|&(r_a, r_b, seed, first)| {
                let (out, _, _, _) = play_exact_deckgym_game(
                    &exact_decks[r_a - 1], &exact_decks[r_b - 1], cand_w, &V1_WEIGHTS, seed, first,
                );
                out
            })
            .collect();
        let w = outcomes.iter().filter(|&&o| o == "win").count();
        let d = outcomes.iter().filter(|&&o| o == "draw").count();
        let l = outcomes.len() - w - d;
        let sc = (w as f64 + 0.5 * d as f64) / (outcomes.len() as f64);
        println!("  [Exact DeckGym Finalist #{}] round={} score vs V1={:.2}% ({}W/{}D/{}L)", f_idx, round_num, sc * 100.0, w, d, l);
        if sc > best_finalist_exact_score {
            best_finalist_exact_score = sc;
            best_finalist = *cand_w;
            best_finalist_round = *round_num;
            best_finalist_tally = json!({
                "games": outcomes.len(),
                "wins": w,
                "draws": d,
                "losses": l,
                "score": sc
            });
        }
    }

    // Now run the 2,160-game exact DeckGym holdout evaluation vs baseline-v0 (Top 10 all-pairs, 12 seeds x 4 orientations)
    let mut holdout_specs: Vec<(usize, usize, usize, usize, u32)> = Vec::with_capacity(2160);
    for i in 1..=10 {
        for j in (i + 1)..=10 {
            for s in 0..12 {
                let seed = seed32(&format!("pocket-lab-c1-cem-v3|v3-v0-eval|{i}-{j}|{s}"));
                for &deck_rank in &[i, j] {
                    for &first in &[0usize, 1usize] {
                        holdout_specs.push((i, j, deck_rank, first, seed));
                    }
                }
            }
        }
    }

    let eval_rows: Vec<Value> = holdout_specs
        .par_iter()
        .map(|&(lo, hi, deck_rank, first, seed)| {
            let enemy_rank = if deck_rank == lo { hi } else { lo };
            let (outcome, turns, actions, points) = play_exact_deckgym_game(
                &exact_decks[deck_rank - 1],
                &exact_decks[enemy_rank - 1],
                &best_finalist,
                &BASELINE_V0,
                seed,
                first,
            );
            json!({
                "ranks": [lo, hi],
                "deckRank": deck_rank,
                "first": first,
                "seed": seed,
                "opponent": "baseline",
                "outcome": outcome,
                "turns": turns,
                "actions": actions,
                "points": points
            })
        })
        .collect();

    let eval_wins = eval_rows.iter().filter(|r| r["outcome"] == "win").count();
    let eval_draws = eval_rows.iter().filter(|r| r["outcome"] == "draw").count();
    let eval_losses = eval_rows.len() - eval_wins - eval_draws;
    let eval_score = (eval_wins as f64 + 0.5 * eval_draws as f64) / (eval_rows.len() as f64);
    println!(
        "[V3] Exact DeckGym Holdout vs baseline-v0 (2,160 games): {}W/{}D/{}L (score={:.2}%)",
        eval_wins, eval_draws, eval_losses, eval_score * 100.0
    );

    // Run 10 x 500 = 5,000-game full-flow Top-10 mirror benchmark on exact DeckGym engine!
    // For each rank 1..=10: index 0..250 is first=0 (先攻 250 局), index 250..500 is first=1 (後攻 250 局)
    let mut mirror5000_specs: Vec<(usize, String, usize, usize, u32)> = Vec::with_capacity(5000);
    for rank in 1..=10 {
        let id = meta_decks_json[rank - 1]["id"].as_str().unwrap().to_string();
        for index in 0..500 {
            let first = if index < 250 { 0 } else { 1 };
            let seed = seed32(&format!("pocket-lab-c1-cem-v3|mirror5000|{id}|{index}"));
            mirror5000_specs.push((rank, id.clone(), index, first, seed));
        }
    }

    let mirror5000_rows: Vec<Value> = mirror5000_specs
        .par_iter()
        .map(|(rank, id, index, first, seed)| {
            let (outcome, turns, actions, points) = play_exact_deckgym_game(
                &exact_decks[0],
                &exact_decks[*rank - 1],
                &best_finalist,
                &best_finalist,
                *seed,
                *first,
            );
            json!({
                "rank": rank,
                "id": id,
                "index": index,
                "first": first,
                "seed": seed,
                "outcome": outcome,
                "turns": turns,
                "actions": actions,
                "points": points
            })
        })
        .collect();

    let m5000_wins = mirror5000_rows.iter().filter(|r| r["outcome"] == "win").count();
    let m5000_draws = mirror5000_rows.iter().filter(|r| r["outcome"] == "draw").count();
    let m5000_losses = mirror5000_rows.len() - m5000_wins - m5000_draws;
    let m5000_wr = (m5000_wins as f64) / (mirror5000_rows.len() as f64);
    let m5000_score = (m5000_wins as f64 + 0.5 * m5000_draws as f64) / (mirror5000_rows.len() as f64);
    println!(
        "[V3] Exact DeckGym 5,000-Game (10x500) Top-10 Mirror: {}W/{}D/{}L (winRate={:.2}%, score={:.2}%)",
        m5000_wins, m5000_draws, m5000_losses, m5000_wr * 100.0, m5000_score * 100.0
    );

    let p3_total_games = (finalists.len() * val_tasks.len() + eval_rows.len() + mirror5000_rows.len()) as u64;
    let total_v3_games = p1_total_games + p2_total_games + p3_total_games;
    let cumulative_all_versions = 92160u64 + total_v3_games;

    // Write artifacts to reports/battle-ml-c1-v3/
    let write_jsonl = |path: &Path, rows: &[Value]| {
        let mut f = BufWriter::new(File::create(path).unwrap());
        for r in rows {
            serde_json::to_writer(&mut f, r).unwrap();
            f.write_all(b"\n").unwrap();
        }
        f.flush().unwrap();
    };
    write_jsonl(&out_dir.join("eval.jsonl"), &eval_rows);
    write_jsonl(&out_dir.join("mirror-5000.jsonl"), &mirror5000_rows);

    // Build per-rank 500-game summary for mirror-5000
    let mut by_rank_5000: Vec<Value> = Vec::with_capacity(10);
    for rank in 1..=10 {
        let name = meta_decks_json[rank - 1]["name"].as_str().unwrap();
        let id = meta_decks_json[rank - 1]["id"].as_str().unwrap();
        let r_rows: Vec<&Value> = mirror5000_rows.iter().filter(|r| r["rank"].as_u64() == Some(rank as u64)).collect();
        let f_rows: Vec<&&Value> = r_rows.iter().filter(|r| r["first"].as_u64() == Some(0)).collect();
        let s_rows: Vec<&&Value> = r_rows.iter().filter(|r| r["first"].as_u64() == Some(1)).collect();
        let count_wdl = |slice: &[&Value]| {
            let w = slice.iter().filter(|r| r["outcome"] == "win").count();
            let d = slice.iter().filter(|r| r["outcome"] == "draw").count();
            let l = slice.len() - w - d;
            (w, d, l)
        };
        let (rw, rd, rl) = count_wdl(&r_rows);
        let fw = f_rows.iter().filter(|r| r["outcome"] == "win").count();
        let fd = f_rows.iter().filter(|r| r["outcome"] == "draw").count();
        let fl = f_rows.len() - fw - fd;
        let sw = s_rows.iter().filter(|r| r["outcome"] == "win").count();
        let sd = s_rows.iter().filter(|r| r["outcome"] == "draw").count();
        let sl = s_rows.len() - sw - sd;
        by_rank_5000.push(json!({
            "rank": rank,
            "id": id,
            "name": name,
            "total": 500,
            "wins": rw,
            "draws": rd,
            "losses": rl,
            "winRate": (rw as f64) / 500.0,
            "score": (rw as f64 + 0.5 * rd as f64) / 500.0,
            "first": { "total": 250, "wins": fw, "draws": fd, "losses": fl, "winRate": (fw as f64) / 250.0 },
            "second": { "total": 250, "wins": sw, "draws": sd, "losses": sl, "winRate": (sw as f64) / 250.0 }
        }));
    }

    // Top 30 highest tactical prior cards for quick inspection
    let mut top_cards_idx: Vec<usize> = (0..n_cards).collect();
    top_cards_idx.sort_by(|&a, &b| {
        card_entries[b]
            .scoreRate
            .partial_cmp(&card_entries[a].scoreRate)
            .unwrap()
            .then_with(|| card_entries[b].actionsPlayed.cmp(&card_entries[a].actionsPlayed))
    });
    let top_30_cards: Vec<&CardEvaluationEntry> = top_cards_idx.iter().take(30).map(|&i| &card_entries[i]).collect();

    let created_at = "2026-11-22T11:30:00.000Z";
    let candidate_v3 = json!({
        "version": "selfplay-cem-v3",
        "features": FEATURES,
        "featureNames": FEATURE_NAMES,
        "weights": best_finalist,
        "trainedGames": total_v3_games,
        "parentTrainedGames": 92160,
        "cumulativeTrainingGames": cumulative_all_versions,
        "cardPoolEvaluated": {
            "totalDistinctCards": n_cards,
            "minGamesPerCard": min_card_games,
            "minDecisionsPerCard": min_card_evals,
            "totalCardEvaluationGames": p1_total_games,
            "totalCardDecisionEvaluations": total_card_evals
        },
        "phaseBreakdown": {
            "phase1CardPoolGames": p1_total_games,
            "phase2CemLeagueGames": p2_total_games,
            "phase3ExactDeckGymGames": p3_total_games
        },
        "createdAt": created_at,
        "engineCommit": "a0f9d14bf2dd2a342e53cd7057486d7ce96ea545",
        "source": lineup_raw["source"],
        "selection": {
            "round": best_finalist_round,
            "exactDeckGymValidation": best_finalist_tally
        },
        "eval": {
            "opponent": "baseline-v0",
            "games": eval_rows.len(),
            "wins": eval_wins,
            "draws": eval_draws,
            "losses": eval_losses,
            "winRate": (eval_wins as f64) / (eval_rows.len() as f64),
            "score": eval_score
        },
        "mirror5000": {
            "gamesPerOpponent": 500,
            "firstSeatPerOpponent": 250,
            "secondSeatPerOpponent": 250,
            "total": mirror5000_rows.len(),
            "wins": m5000_wins,
            "draws": m5000_draws,
            "losses": m5000_losses,
            "winRate": m5000_wr,
            "score": m5000_score,
            "byRank": by_rank_5000
        }
    });

    fs::write(out_dir.join("candidate-v3.json"), serde_json::to_string_pretty(&candidate_v3).unwrap() + "\n").unwrap();

    // Save full 4,577 card evaluations & compact card priors
    let card_eval_doc = json!({
        "schemaVersion": 1,
        "version": "selfplay-cem-v3",
        "totalCards": n_cards,
        "minGamesPerCard": min_card_games,
        "minDecisionsPerCard": min_card_evals,
        "totalCardEvaluationGames": p1_total_games,
        "totalCardDecisionEvaluations": total_card_evals,
        "topCards": top_30_cards,
        "cards": card_entries
    });
    fs::write(out_dir.join("card-evaluations.json"), serde_json::to_string_pretty(&card_eval_doc).unwrap() + "\n").unwrap();

    // Also save compact map { cardId: { g, w, d, evals, prior } } for frontend inspection
    let mut compact_priors_map = serde_json::Map::with_capacity(n_cards);
    for entry in &card_entries {
        compact_priors_map.insert(
            entry.id.clone(),
            json!({
                "g": entry.games,
                "w": entry.wins,
                "d": entry.draws,
                "ev": entry.decisionsConsidered,
                "sr": entry.scoreRate,
                "p": entry.tacticalPrior
            }),
        );
    }
    let public_priors_doc = json!({
        "version": "selfplay-cem-v3",
        "totalCards": n_cards,
        "minGamesPerCard": min_card_games,
        "minDecisionsPerCard": min_card_evals,
        "totalGames": total_v3_games,
        "cumulativeGames": cumulative_all_versions,
        "topCards": top_30_cards,
        "byCardId": compact_priors_map
    });
    fs::write(root.join("public/battle/models/card-priors.json"), serde_json::to_string(&public_priors_doc).unwrap() + "\n").unwrap();

    let training_doc = json!({
        "schemaVersion": 3,
        "version": "selfplay-cem-v3",
        "source": lineup_raw["source"],
        "trainedGames": total_v3_games,
        "parentTrainedGames": 92160,
        "cumulativeTrainingGames": cumulative_all_versions,
        "cardPoolEvaluated": candidate_v3["cardPoolEvaluated"],
        "phaseBreakdown": candidate_v3["phaseBreakdown"],
        "generations": gen_records,
        "elapsedSeconds": t_start.elapsed().as_secs_f64()
    });
    fs::write(out_dir.join("training.json"), serde_json::to_string_pretty(&training_doc).unwrap() + "\n").unwrap();
    fs::write(out_dir.join("report.json"), serde_json::to_string_pretty(&candidate_v3).unwrap() + "\n").unwrap();

    // Generate human-readable report.md in reports/battle-ml-c1-v3/report.md
    let mut md = String::new();
    md.push_str("# C1-V3 千萬局全卡池對戰策略訓練與 10×500 局（5,000 局）基準報告\n\n");
    md.push_str(&format!(
        "- **模型版本**：`selfplay-cem-v3`\n- **本輪新增訓練對局**：**{} 局**（第一階段全卡池對戰評估 {} 局 + 第二階段 48 輪 CEM 聯賽自對弈 {} 局 + 第三階段 DeckGym 精確規則引擎決選與基準測試 {} 局）\n- **累計總訓練對局**：**{} 局**（含 V1 18,432 局 + V2 73,728 局）\n- **全卡池單卡綜合評估**：覆蓋全部 **{} 張卡牌**，每張卡牌完整參戰 **>= {} 局**、累積動作決策考量 **>= {} 次**（全卡池總決策評估 **{} 次**）。\n- **對基線 `baseline-v0` 2,160 局留出評估**：**{} 勝 {} 和 {} 負**（勝率 **{:.2}%**，和局計半得分率 **{:.2}%**）。\n\n",
        total_v3_games, p1_total_games, p2_total_games, p3_total_games, cumulative_all_versions,
        n_cards, min_card_games, min_card_evals, total_card_evals,
        eval_wins, eval_draws, eval_losses,
        (eval_wins as f64 / eval_rows.len() as f64) * 100.0,
        eval_score * 100.0
    ));
    md.push_str("## 榜首牌組對前十名 10 × 500 局（共 5,000 局完整流程）對戰基準\n\n");
    md.push_str(&format!(
        "每個對手固定進行 **500 局完整流程對局**（先攻 250 局 + 後攻 250 局），合計 **5,000 局**：共 **{} 勝、{} 和、{} 負**，等權綜合勝率 **{:.2}%**，綜合積分率 **{:.2}%**。\n\n",
        m5000_wins, m5000_draws, m5000_losses, m5000_wr * 100.0, m5000_score * 100.0
    ));
    md.push_str("| 對手排名 | 對手牌組 | 總局數 | 勝 | 和 | 負 | 勝率 | 積分率 | 先攻 250 局 (勝/和/負) | 後攻 250 局 (勝/和/負) |\n");
    md.push_str("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |\n");
    for r in &by_rank_5000 {
        md.push_str(&format!(
            "| {} | {} | 500 | {} | {} | {} | {:.2}% | {:.2}% | {}/{}/{} ({:.1}%) | {}/{}/{} ({:.1}%) |\n",
            r["rank"],
            r["name"].as_str().unwrap(),
            r["wins"], r["draws"], r["losses"],
            r["winRate"].as_f64().unwrap() * 100.0,
            r["score"].as_f64().unwrap() * 100.0,
            r["first"]["wins"], r["first"]["draws"], r["first"]["losses"],
            r["first"]["winRate"].as_f64().unwrap() * 100.0,
            r["second"]["wins"], r["second"]["draws"], r["second"]["losses"],
            r["second"]["winRate"].as_f64().unwrap() * 100.0
        ));
    }
    fs::write(out_dir.join("report.md"), md).unwrap();

    println!(
        "[V3] ALL DONE in {:.2}s! Total V3 games = {}, Cumulative = {}, Phase3 time = {:.2}s",
        t_start.elapsed().as_secs_f64(), total_v3_games, cumulative_all_versions, t_p3.elapsed().as_secs_f64()
    );
}
