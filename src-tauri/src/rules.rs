use crate::model::{RepeatMode, Rule};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GiftObservation {
    pub connection_id: String,
    pub room_id: String,
    pub msg_id: String,
    pub sender_id: String,
    pub gift_id: String,
    pub gift_type: u32,
    pub repeat_count: u32,
    pub repeat_end: Option<bool>,
    pub group_id: Option<String>,
    pub gift_name: Option<String>,
    pub sender_label: Option<String>,
    pub receiver_user_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct InputBatch {
    pub event_id: String,
    pub rule: Rule,
    pub repeats: u32,
    pub generation: u64,
    pub enqueued_at: Instant,
}

#[derive(Debug)]
pub enum GiftOutcome {
    Progress { count: u32, gift_id: String },
    Duplicate,
    NoMatch,
    Cooldown,
    Batch(InputBatch),
    Invalid(String),
}

#[derive(Debug)]
struct StreakState { highest: u32, updated: Instant, suppressed: bool }

pub struct RuleEngine {
    observations: HashMap<String, Instant>,
    finalized: HashMap<String, Instant>,
    streaks: HashMap<String, StreakState>,
    cooldowns: HashMap<String, Instant>,
    ttl: Duration,
    last_maintenance: Instant,
}

impl Default for RuleEngine {
    fn default() -> Self { let now = Instant::now(); Self { observations: HashMap::new(), finalized: HashMap::new(), streaks: HashMap::new(), cooldowns: HashMap::new(), ttl: Duration::from_secs(600), last_maintenance: now } }
}

impl RuleEngine {
    pub fn process(&mut self, event: GiftObservation, rules: &[Rule], armed: bool, generation: u64) -> GiftOutcome {
        let now = Instant::now();
        self.maintain(now);
        if !valid_id(&event.room_id, 128) || !valid_id(&event.sender_id, 128) || !valid_id(&event.gift_id, 32) || !valid_id(&event.msg_id, 128) || event.repeat_count == 0 || event.repeat_count > 1_000_000 {
            return GiftOutcome::Invalid("Identity atau count gift tidak valid.".into());
        }
        let observation_id = format!("{}|{}|{}|{}|{}|{}|{}|{:?}", event.room_id, event.sender_id, event.gift_id, event.group_id.as_deref().unwrap_or("-"), event.msg_id, event.gift_type, event.repeat_count, event.repeat_end);
        if self.observations.contains_key(&observation_id) { return GiftOutcome::Duplicate; }
        if self.observations.len() >= 10_000 { return GiftOutcome::Invalid("Kapasitas deduplikasi penuh.".into()); }
        self.observations.insert(observation_id, now);

        let (event_id, count) = if event.gift_type == 1 {
            let group = match event.group_id.as_deref().filter(|id| valid_id(id, 128)) { Some(value) => value, None => return GiftOutcome::Invalid("Gift streak tidak memiliki groupId valid.".into()) };
            let id = format!("{}|{}|{}|{}", event.room_id, event.sender_id, event.gift_id, group);
            if self.finalized.contains_key(&id) { return GiftOutcome::Duplicate; }
            match event.repeat_end {
                Some(false) => {
                    if self.streaks.len() >= 1_000 && !self.streaks.contains_key(&id) { return GiftOutcome::Invalid("Kapasitas streak aktif penuh.".into()); }
                    let state = self.streaks.entry(id).or_insert(StreakState { highest: event.repeat_count, updated: now, suppressed: !armed });
                    state.highest = state.highest.max(event.repeat_count); state.updated = now; state.suppressed |= !armed;
                    return GiftOutcome::Progress { count: state.highest, gift_id: event.gift_id };
                }
                Some(true) => {
                    let state = self.streaks.remove(&id);
                    if let Some(ref progress) = state { if event.repeat_count < progress.highest { self.finalized.insert(id, now); return GiftOutcome::Invalid("Count final streak lebih kecil dari progress tertinggi.".into()); } }
                    self.finalized.insert(id.clone(), now);
                    if state.is_some_and(|progress| progress.suppressed) || !armed { return GiftOutcome::Duplicate; }
                    (id, event.repeat_count)
                }
                None => return GiftOutcome::Invalid("repeatEnd wajib untuk gift streak.".into()),
            }
        } else {
            let id = format!("{}|{}|{}|{}", event.room_id, event.sender_id, event.gift_id, event.msg_id);
            if self.finalized.contains_key(&id) { return GiftOutcome::Duplicate; }
            self.finalized.insert(id.clone(), now);
            if !armed { return GiftOutcome::Duplicate; }
            (id, event.repeat_count)
        };

        let rule = match rules.iter().find(|rule| rule.enabled && rule.gift_id == event.gift_id) { Some(value) => value.clone(), None => return GiftOutcome::NoMatch };
        if self.cooldowns.get(&rule.id).is_some_and(|last| now.duration_since(*last) < Duration::from_millis(rule.cooldown_ms)) { return GiftOutcome::Cooldown; }
        self.cooldowns.insert(rule.id.clone(), now);
        let repeats = match rule.repeat_mode { RepeatMode::Once => 1, RepeatMode::PerUnit => count.min(rule.max_repeats), RepeatMode::Fixed => rule.fixed_count.min(rule.max_repeats) };
        GiftOutcome::Batch(InputBatch { event_id, rule, repeats, generation, enqueued_at: now })
    }

    pub fn suppress_open_streaks(&mut self) { for state in self.streaks.values_mut() { state.suppressed = true; } }
    pub fn clear_room(&mut self) { self.streaks.clear(); }
    fn maintain(&mut self, now: Instant) {
        if now.duration_since(self.last_maintenance) < Duration::from_secs(1) { return; }
        let ttl = self.ttl;
        self.observations.retain(|_, seen| now.duration_since(*seen) < ttl);
        self.finalized.retain(|_, seen| now.duration_since(*seen) < ttl);
        let mut tombstones = HashSet::new();
        self.streaks.retain(|id, state| { let keep = now.duration_since(state.updated) < Duration::from_secs(60); if !keep { tombstones.insert(id.clone()); } keep });
        for id in tombstones { self.finalized.insert(id, now); }
        self.last_maintenance = now;
    }
}

fn valid_id(value: &str, max: usize) -> bool { !value.is_empty() && value.len() <= max && value != "0" && value.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b':' | b'.')) }

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(mode: RepeatMode) -> Rule { Rule { id: "rule-1".into(), enabled: true, gift_id: "5953".into(), gift_label: "Rose".into(), priority: 50, keys: vec!["Space".into()], hold_ms: 100, cooldown_ms: 0, repeat_mode: mode, fixed_count: 4, max_repeats: 10, repeat_gap_ms: 100 } }
    fn gift(count: u32, end: bool) -> GiftObservation { GiftObservation { connection_id: "c-1".into(), room_id: "100".into(), msg_id: format!("{count}"), sender_id: "200".into(), gift_id: "5953".into(), gift_type: 1, repeat_count: count, repeat_end: Some(end), group_id: Some("300".into()), gift_name: Some("Rose".into()), sender_label: None, receiver_user_id: None } }
    #[test] fn streak_finalizes_once() { let mut engine = RuleEngine::default(); let rules = [rule(RepeatMode::PerUnit)]; assert!(matches!(engine.process(gift(1, false), &rules, true, 1), GiftOutcome::Progress { count: 1, .. })); assert!(matches!(engine.process(gift(3, false), &rules, true, 1), GiftOutcome::Progress { count: 3, .. })); match engine.process(gift(3, true), &rules, true, 1) { GiftOutcome::Batch(batch) => assert_eq!(batch.repeats, 3), value => panic!("unexpected {value:?}") }; assert!(matches!(engine.process(gift(3, true), &rules, true, 1), GiftOutcome::Duplicate)); }
    #[test] fn suppressed_streak_never_executes() { let mut engine = RuleEngine::default(); let rules = [rule(RepeatMode::Once)]; engine.process(gift(1, false), &rules, false, 1); assert!(matches!(engine.process(gift(2, true), &rules, true, 1), GiftOutcome::Duplicate)); }
    #[test] fn rejects_lower_final_count() { let mut engine = RuleEngine::default(); let rules = [rule(RepeatMode::Once)]; engine.process(gift(3, false), &rules, true, 1); assert!(matches!(engine.process(gift(2, true), &rules, true, 1), GiftOutcome::Invalid(_))); }
}
