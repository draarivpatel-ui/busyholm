use std::collections::BTreeMap;
use busyholm_contracts::{agent_event::EventUsage, common::{Provider,Window}, snapshot::SnapshotLimit};

#[derive(Default)]
pub struct UsageStore { samples:BTreeMap<(Provider,Window,Option<String>,String),EventUsage> }
impl UsageStore {
    pub fn insert(&mut self,sample:EventUsage,now:u64)->bool {
        self.insert_scoped(sample,None,"00000000000000000000000000000000".into(),now)
    }
    pub fn insert_scoped(&mut self,sample:EventUsage,account:Option<String>,root:String,now:u64)->bool {
        if !sample.used_pct.is_finite() || !(0.0..=100.0).contains(&sample.used_pct)
            || sample.observed_at>now || sample.observed_at<946684800000 || sample.resets_at<946684800000
            || sample.resets_at>4102444800000 || root.len()!=32
            || !root.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase()) {return false;}
        if account.as_ref().is_some_and(|id|id.len()!=32||!id.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase())) {return false;}
        let key=(sample.provider,sample.window,account,root);
        if let Some(old)=self.samples.get(&key) {if sample.observed_at<=old.observed_at {return false;}}
        if !self.samples.contains_key(&key)&&self.samples.len()>=16 {return false;}
        self.samples.insert(key,sample); true
    }
    pub fn snapshot(&self,now:u64)->Vec<SnapshotLimit> {
        self.samples.iter().map(|((provider,window,account,root),s)|SnapshotLimit{
            provider:*provider,window:*window,account_id:account.clone(),root_id:root.clone(),used_pct:s.used_pct,
            resets_at:s.resets_at,observed_at:s.observed_at,stale:now.saturating_sub(s.observed_at)>=1800000,
        }).collect()
    }
    pub fn next_stale_at(&self,now:u64)->Option<u64> {
        self.samples.values().map(|s|s.observed_at.saturating_add(1800000)).filter(|t|*t>now).min()
    }
}
