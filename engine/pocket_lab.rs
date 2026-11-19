//! Browser bridge for the pinned AGPL-3.0 DeckGym rules.
//! The policy only reads legal choices, its own hand, and the public board.
use crate::actions::{apply_action, SimpleAction};
use crate::card_ids::CardId;
use crate::card_validation::get_implementation_status;
use crate::database::get_card_by_enum;
use crate::models::{Card, EnergyType};
use crate::state::{GameOutcome, PlayedCard};
use crate::{Deck, State};
use rand::{rngs::StdRng, SeedableRng};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};

#[derive(Deserialize)]
struct Entry { id: String, count: u8 }
#[derive(Deserialize)]
struct List { cards: Vec<Entry>, energy: Vec<String> }

fn lookup(id: &str) -> Option<CardId> {
    let (set, number) = id.trim().rsplit_once('-')?;
    let n = number.parse::<u16>().ok()?;
    let set = match set { "PROMO-A" | "PROMOA" | "PA" => "P-A", "PROMO-B" | "PROMOB" | "PB" => "P-B", "PROMO-C" | "PROMOC" | "PC" => "P-C", other => other };
    CardId::from_card_id(&format!("{set} {n:03}"))
}
fn deck(list: List) -> Result<Deck, String> {
    if list.cards.iter().map(|c| c.count as usize).sum::<usize>() != 20 {
        return Err("對戰牌組需要 20 張卡牌".into());
    }
    let mut energy: Vec<EnergyType> = list.energy.iter()
        .map(|name| EnergyType::SELECTABLE.iter().copied()
            .find(|e| e.as_str().eq_ignore_ascii_case(name.trim()))
            .ok_or_else(|| format!("能量區不支援 {name}")))
        .collect::<Result<_, _>>()?;
    energy.sort();
    energy.dedup();
    if !(1..=3).contains(&energy.len()) || energy.iter().any(|e| !e.is_selectable()) {
        return Err("請選擇 1 至 3 種可產生的能量".into());
    }
    let mut cards = Vec::new();
    for e in list.cards {
        let id = lookup(&e.id).ok_or_else(|| format!("規則引擎尚未收錄 {}", e.id))?;
        let status = get_implementation_status(id);
        if !status.is_complete() { return Err(format!("{}：{}", e.id, status.description())); }
        if !(1..=2).contains(&e.count) { return Err(format!("{} 數量無效", e.id)); }
        cards.extend(std::iter::repeat_n(get_card_by_enum(id), e.count as usize));
    }
    cards.sort_by_key(Card::get_id);
    let result = Deck { cards, energy_types: energy };
    if !result.is_valid() { return Err("需要基礎寶可夢，同名卡最多兩張".into()); }
    Ok(result)
}

pub const FEATURES: usize = 22;
fn target(state: &State, player: usize, index: usize) -> Option<&PlayedCard> {
    state.in_play_pokemon[player].get(index)?.as_ref()
}
fn card_power(card: &Card) -> f64 {
    if let Card::Pokemon(p) = card { p.attacks.iter().map(|a| a.fixed_damage).max().unwrap_or(0) as f64 / 100.0 } else { 0.0 }
}
fn score(state: &State, who: usize, action: &SimpleAction, w: &[f64]) -> f64 {
    use SimpleAction::*;
    let foe = 1 - who;
    let active = target(state, who, 0);
    let enemy = target(state, foe, 0);
    let mut f = [0.0; FEATURES];
    match action {
        EndTurn => f[0] = 1.0,
        Noop => f[1] = 1.0,
        Place(c, slot) => { f[2] = 1.0; if *slot == 0 { f[3] = card_power(c); } }
        Evolve { evolution, in_play_idx, .. } => {
            f[4] = 1.0; f[5] = card_power(evolution) * if *in_play_idx == 0 {1.0} else {0.5};
        }
        UseAbility {..} | UseStadium => f[6] = 1.0,
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
                } else {false};
                if a.fixed_damage + if weak {20} else {0} >= e.get_remaining_hp() { f[11] = 1.0; }
            }
            if a.effect.is_some() { f[12] = 1.0; }
        }
        Attach { attachments, .. } => {
            f[13] = 1.0;
            for (_, _, slot) in attachments {
                if *slot == 0 {f[14] = 1.0;}
                if let Some(p) = target(state, who, *slot) {
                    let wanted = p.card.get_attacks().iter().map(|a| a.energy_required.len()).max().unwrap_or(0);
                    f[15] += if p.attached_energy.len() < wanted {1.0} else {0.0};
                    f[16] += card_power(&p.card);
                }
            }
        }
        Retreat(slot) => {
            f[17] = 1.0;
            if let (Some(now), Some(next), Some(e)) = (active, target(state, who, *slot), enemy) {
                if (now.get_remaining_hp() as f64 / 100.0) <= card_power(&e.card) && next.get_remaining_hp() > now.get_remaining_hp() { f[18] = 1.0; }
            }
        }
        Activate { player, in_play_idx } => if let Some(p) = target(state,*player,*in_play_idx) {
            let sign = if *player == who {1.0} else {-1.0};
            f[19] = sign * (p.get_remaining_hp() as f64 / 100.0 + p.attached_energy.len() as f64);
        }
        AttachTool {in_play_idx,..} | Heal {in_play_idx,..} | HealAndDiscardEnergy {in_play_idx,..} => {
            f[20] = if *in_play_idx == 0 {1.0} else {0.5};
        }
        ApplyDamage {targets,..} => {
            f[21] = targets.iter().filter(|(_,p,_)| *p == foe).map(|(d,p,s)| {
                let hp = target(state,*p,*s).map_or(1, |x| x.get_remaining_hp().max(1));
                *d as f64 / hp as f64
            }).sum();
        }
        _ => {}
    };
    f.iter().zip(w).map(|(a,b)| a*b).sum()
}

#[derive(Deserialize)]
struct Match { deck: List, enemy: List, weights: Vec<f64>, enemy_weights: Option<Vec<f64>>,
    seed: u32, first: usize, #[serde(default)] replay: bool }

fn game(input: Match) -> Result<Value,String> {
    let opponent_weights = input.enemy_weights.as_ref().unwrap_or(&input.weights);
    if input.first > 1 || [opponent_weights,&input.weights].iter().any(|v| v.len()!=FEATURES || v.iter().any(|x| !x.is_finite())) {
        return Err("模型或先手參數無效".into());
    }
    let mut rng = StdRng::seed_from_u64(input.seed as u64);
    let mut state = State::initialize(&deck(input.deck)?, &deck(input.enemy)?, &mut rng);
    state.current_player = input.first;
    let mut actions = Vec::new();
    let mut decisions = 0;
    while state.winner.is_none() {
        if decisions >= 3000 { return Err("引擎未能在 3000 個動作內完成，該局未計入".into()); }
        let (who, options) = state.generate_possible_actions();
        let w = if who == 0 { &input.weights } else { opponent_weights };
        let mut best: Option<(usize,f64,String)> = None;
        for (idx, option) in options.iter().enumerate() {
            let value = score(&state, who, &option.action, w);
            // Visible legal ties use a canonical label independent of a HashMap's iteration order.
            if best.as_ref().is_some_and(|(_,v,_)| *v > value) { continue; }
            let label = option.action.to_string();
            if best.as_ref().is_none_or(|(_,v,key)| value > *v || label < *key) { best = Some((idx,value,label)); }
        }
        let (idx, _, label) = best.ok_or("引擎沒有合法動作")?;
        let turn = state.turn_count;
        apply_action(&mut rng, &mut state, &options[idx]);
        if input.replay { actions.push(json!({"turn":turn,"actor":who,"action":label,"points":state.points})); }
        decisions += 1;
    }
    let outcome = match state.winner.unwrap() {GameOutcome::Win(0)=>"win",GameOutcome::Win(_)=>"loss",GameOutcome::Tie=>"draw"};
    let mut out = json!({"outcome":outcome,"turns":state.turn_count.min(30),"actions":decisions,"points":state.points,"first":input.first});
    if input.replay {out["replay"] = Value::Array(actions);}
    Ok(out)
}

fn one_match(v: Value) -> Value {
    let parsed = serde_json::from_value(v).map_err(|e| e.to_string());
    std::panic::catch_unwind(|| parsed.and_then(game))
        .unwrap_or_else(|p| Err(format!("引擎錯誤：{}", p.downcast_ref::<String>().map(String::as_str)
            .or_else(|| p.downcast_ref::<&str>().copied()).unwrap_or("panic"))))
        .unwrap_or_else(|e|json!({"error":e}))
}

pub fn dispatch(data: &[u8]) -> Result<Value,String> {
    let v: Value = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    match v["op"].as_str() {
        Some("coverage") => {
            let mut result = BTreeMap::new();
            let ids: HashSet<String> = serde_json::from_value(v["ids"].clone()).map_err(|e| e.to_string())?;
            for id in ids {
                let status = lookup(&id).map(get_implementation_status).map_or("Unknown card", |s| s.description());
                result.insert(id,status);
            }
            Ok(json!({"coverage":result}))
        }
        Some("game") => Ok(one_match(v)),
        Some("batch") => {
            let mut items = v;
            let games = items["games"].as_array_mut().ok_or("games 必須是陣列")?;
            if games.len() > 5000 { return Err("每批最多 5000 局".into()); }
            let results: Vec<Value> = std::mem::take(games).into_iter().map(one_match).collect();
            Ok(json!({"results":results}))
        }
        _ => Err("未知操作".into())
    }
}

thread_local! {static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };}
#[no_mangle] pub extern "C" fn lab_alloc(len: usize) -> *mut u8 { Box::into_raw(vec![0;len].into_boxed_slice()) as *mut u8 }
#[no_mangle] pub unsafe extern "C" fn lab_run(ptr: *mut u8, len: usize) -> *const u8 {
    let input = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr,len));
    let value = dispatch(&input).unwrap_or_else(|e|json!({"error":e}));
    OUTPUT.with_borrow_mut(|out| {out.clear(); serde_json::to_writer(&mut *out,&value).unwrap(); out.as_ptr()})
}
#[no_mangle] pub extern "C" fn lab_output_len() -> usize { OUTPUT.with_borrow(|b| b.len()) }
