use std::{collections::BTreeMap,sync::Arc};
use chrono::{Local,TimeZone,Utc,FixedOffset};
use busyholm_contracts::{Ledger,common::{Privacy,Tool,Version},ledger::{Counts,DayTotals}};

/// Keeps a hostile timestamp inside the range the calendar library can format (year 9999).
fn clamp(ms:u64)->i64 {ms.min(253_402_300_799_999) as i64}
pub trait Calendar:Send+Sync {
    fn day(&self,ms:u64)->String;
    fn next_day(&self,ms:u64)->u64 {
        let day=self.day(ms); let mut lo=ms; let mut hi=ms.saturating_add(27*3600000);
        while hi-lo>1 {let mid=lo+(hi-lo)/2; if self.day(mid)==day {lo=mid;}else{hi=mid;}}
        hi
    }
}
pub struct LocalCalendar;
impl Calendar for LocalCalendar {
    fn day(&self,ms:u64)->String { Local.timestamp_millis_opt(clamp(ms)).single().unwrap_or_else(||Local.timestamp_millis_opt(0).unwrap()).format("%Y-%m-%d").to_string() }
}
pub struct FixedCalendar(pub i32);
impl Calendar for FixedCalendar {
    fn day(&self,ms:u64)->String {Utc.timestamp_millis_opt(clamp(ms)).single().unwrap_or_else(||Utc.timestamp_millis_opt(0).unwrap()).with_timezone(&FixedOffset::east_opt(self.0).unwrap()).format("%Y-%m-%d").to_string()}
}
fn empty()->Counts {Counts{turns:0,interrupted_turns:0,sessions:0,working_seconds:0,needs_you:0,errors:0,recovered:0,limit_hits:0,subagent_turns:0}}
fn field(counts:&mut Counts,counter:Counter)->&mut u32 {
    match counter {Counter::Turns=>&mut counts.turns,Counter::Interrupted=>&mut counts.interrupted_turns,Counter::Sessions=>&mut counts.sessions,Counter::NeedsYou=>&mut counts.needs_you,Counter::Errors=>&mut counts.errors,Counter::Recovered=>&mut counts.recovered,Counter::LimitHits=>&mut counts.limit_hits,Counter::SubagentTurns=>&mut counts.subagent_turns}
}
#[derive(Clone,Copy)]
pub enum Counter {Turns,Interrupted,Sessions,NeedsYou,Errors,Recovered,LimitHits,SubagentTurns}
pub struct LedgerStore {
    pub value:Ledger, calendar:Arc<dyn Calendar>, remainder:BTreeMap<(String,Tool),u64>, pub dirty:bool,
    /// Milliseconds below a whole second of the day-level union, per day.
    union_remainder:BTreeMap<String,u64>,
}
impl LedgerStore {
    pub fn new(seed:u32,now:u64,calendar:Arc<dyn Calendar>)->Self {
        Self {value:Ledger{schema_version:Version,privacy:Privacy::default(),seed,founded_day:calendar.day(now),hooks_first_connected_day:None,days:BTreeMap::new(),day_totals:None,backfill:None},calendar,remainder:BTreeMap::new(),dirty:false,union_remainder:BTreeMap::new()}
    }
    pub fn count(&mut self,tool:Tool,at:u64,counter:Counter) {
        let counts=self.value.days.entry(self.calendar.day(at)).or_default().entry(tool).or_insert_with(empty);
        let n=field(counts,counter);
        *n=n.saturating_add(1).min(1000000); self.dirty=true;
    }
    /// Takes back one count made at `at` (a provisional identity that turned out to be something else, r1 H6).
    pub fn uncount(&mut self,tool:Tool,at:u64,counter:Counter) {
        let day=self.calendar.day(at);
        if let Some(counts)=self.value.days.get_mut(&day).and_then(|d|d.get_mut(&tool)) {let n=field(counts,counter);*n=n.saturating_sub(1);self.dirty=true;}
    }
    /// Unioned wall-clock intervals, one call per working tool, not per session.
    pub fn work(&mut self,tool:Tool,mut start:u64,mut ms:u64) {
        while ms>0 {
            let day=self.calendar.day(start); let duration=ms.min(self.calendar.next_day(start).saturating_sub(start));
            if duration==0 {break;}
            let remainder=self.remainder.entry((day.clone(),tool)).or_default();
            *remainder=remainder.saturating_add(duration); let seconds=*remainder/1000; *remainder%=1000;
            if seconds>0 {
                let counts=self.value.days.entry(day).or_default().entry(tool).or_insert_with(empty);
                counts.working_seconds=counts.working_seconds.saturating_add(seconds.min(u32::MAX as u64) as u32).min(90000); self.dirty=true;
            }
            start+=duration; ms-=duration;
        }
    }
    /// Wall time with at least one main session of ANY tool working (Ledger v1 `day_totals`, review r1 M2), so tools
    /// side by side are counted once. Call it once per interval, before `work` for the tools of that interval: a day
    /// without an entry yet (a ledger written before the field) starts from its largest per-tool time so far, a lower
    /// bound of the true union.
    pub fn work_union(&mut self,mut start:u64,mut ms:u64) {
        while ms>0 {
            let day=self.calendar.day(start); let duration=ms.min(self.calendar.next_day(start).saturating_sub(start));
            if duration==0 {break;}
            let remainder=self.union_remainder.entry(day.clone()).or_default();
            *remainder=remainder.saturating_add(duration); let seconds=*remainder/1000; *remainder%=1000;
            if seconds>0 {
                let seed=self.value.days.get(&day).map_or(0,|tools|tools.values().map(|c|c.working_seconds).max().unwrap_or(0));
                let totals=self.value.day_totals.get_or_insert_with(BTreeMap::new).entry(day).or_insert(DayTotals{working_seconds:seed});
                totals.working_seconds=totals.working_seconds.saturating_add(seconds.min(u32::MAX as u64) as u32).min(90000); self.dirty=true;
            }
            start+=duration; ms-=duration;
        }
    }
    pub fn hooks_connected(&mut self,at:u64) {
        if self.value.hooks_first_connected_day.is_none() {self.value.hooks_first_connected_day=Some(self.calendar.day(at));self.dirty=true;}
    }
}
