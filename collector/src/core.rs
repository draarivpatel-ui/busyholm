use std::{collections::{BTreeMap,BTreeSet},sync::Arc};
use busyholm_contracts::{AgentEvent,Ledger,Snapshot,Moment,Validate,
    agent_event::{EventKind as E,EventSource,EventLimit,Notification},
    common::{Confidence,NeedsYouReason,Tool,Version,Privacy},
    snapshot::{AgentState as S,SnapshotAgent,ToolStatus,HooksStatus,Presence,Attention,Coverage,CoverageReason},
    moment::MomentKind as M,pending_alerts::{PendingAlerts,PendingAlert}};
use crate::{Clock,CollectorOutput,UsageStore,ledger::{LedgerStore,Counter,Calendar,LocalCalendar},coverage::{CoverageEntry,CoverageFile,HOOK_GRACE_MS,MAX_ENTRIES,MISS_LIMIT}};
const FRESH:u64=5000;
const QUIET:u64=1800000;

#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum CoreError {InvalidEvent,Capacity,IdentityConflict}
struct Instance {
    view:SnapshotAgent, state_at:u64, last_signal:u64, last_activity:u64,
    authority:(u8,u64), reveal_at:Option<u64>, alive:Option<bool>, gone_at:Option<u64>,
    registry_busy:bool, codex_open:bool, turn_started:Option<u64>, error_pending:bool,
    limit:Option<EventLimit>, waiting_at:Option<u64>, waiting_earned:bool,
    confirmed_at:u64, restored:bool, placeholder:bool,
    /// Source time (wall ms) of the newest evidence that raised or confirmed the current alert. A rebuild
    /// observation that is not newer than this cannot answer it (review r1 H3).
    alert_at:u64,
    /// Wall time at which this instance was counted as a main session, so a later reconciliation into a child can
    /// take the count back (r1 H6).
    main_session_at:Option<u64>,
}
impl Instance {
    fn state(&mut self,state:S,wall:u64,mono:u64,confidence:Confidence) {
        if self.view.state!=state {self.view.since=wall.max(self.view.started_at); self.state_at=mono;}
        self.view.state=state; self.view.confidence=confidence;
        if state!=S::NeedsYou {self.view.reason=None;self.view.request_id=None;self.waiting_at=None;self.restored=false;}
        if state!=S::Working {self.view.activity=None;}
        if state!=S::Limited {self.view.limited_until=None;self.limit=None;}
    }
    fn deadline(&self)->Option<(u64,Option<S>)> {
        let mut deadlines=Vec::new();
        if let Some(gone)=self.gone_at {deadlines.push((gone.max(self.last_signal)+60000,None));}
        match self.view.state {
            S::Working=> {
                if self.codex_open {deadlines.push((self.last_activity+1200000,Some(S::Unknown)));}
                else if !self.registry_busy {deadlines.push((self.last_activity+90000,Some(S::YourTurn)));}
            }
            S::YourTurn|S::Error=>deadlines.push((self.state_at+600000,Some(S::Idle))),
            _=>{}
        }
        // Pending alerts need positive evidence that the session disappeared.
        // A limited state needs a good signal, never a clock-only recovery.
        if !matches!(self.view.state,S::NeedsYou|S::Limited) {
            if self.alive==Some(true) {if self.view.state!=S::Idle {deadlines.push((self.last_signal+QUIET,Some(S::Idle)));}}
            else {deadlines.push((self.last_signal+QUIET,None));}
        }
        deadlines.into_iter().min_by_key(|x|x.0)
    }
}
fn rank(e:&AgentEvent)->u8 {
    match e.source {EventSource::Hook|EventSource::Plugin if e.confidence==Confidence::Exact=>4,
        EventSource::Registry|EventSource::Poll=>3,EventSource::Log|EventSource::Hook|EventSource::Plugin=>2,EventSource::Process=>1}
}
fn notice(kind:M,t:u64,i:Option<&Instance>)->Moment {
    Moment{schema_version:Version,kind,t,agent:i.map(|i|i.view.id.clone()),tool:i.map(|i|i.view.tool),reason:None,
        turn_ms:None,provider:None,structure:None,stage:None,milestone:None,request_id:None}
}
/// What has been seen of one connector's hooks (see DECISIONS.md, INT-1).
#[derive(Default)]
struct Evidence {
    /// Wall time of the hook event that proved delivery; `Some` means verified.
    verified_at:Option<u64>,
    /// A hook event has arrived at some point (so the hooks exist), verified or not.
    hooked:bool,
    last_hook:Option<u64>,
    /// Log or registry turn starts (monotonic ms) still waiting for a hook event within the grace period.
    candidates:Vec<u64>,
    /// Turn starts seen in logs or the registry that no hook event matched, since the last hook event.
    misses:u8,
}
fn valid_id(s:&str)->bool {s.len()==32&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
/// Tools the product cannot raise alerts for in this version, whatever adapters exist.
fn alerts_unsupported(tool:Tool)->bool {matches!(tool,Tool::Antigravity|Tool::Gemini|Tool::Cursor|Tool::Aider|Tool::Other)}
pub struct Collector {
    clock:Arc<dyn Clock>, instances:BTreeMap<String,Instance>, connectors:BTreeMap<(Tool,String),ToolStatus>,
    usage:UsageStore, ledger:LedgerStore, ordinals:BTreeMap<Tool,u16>,
    completed:BTreeMap<(String,String,String),u64>, answered:BTreeMap<(String,String,String),u64>,
    last_accounted:u64,last_wall:u64,last_snapshot:Option<u64>,dirty:bool,quick:u32,invalid:u64,rejected:u64,
    usage_stale:Vec<bool>,
    /// What the installer last reported for each tool (`set_hooks`), also before the connector exists.
    told:BTreeMap<Tool,HooksStatus>,
    evidence:BTreeMap<(Tool,String),Evidence>,
    /// The tools that have an adapter; `None` while unknown (the plain stdin collector).
    adapters:Option<BTreeSet<Tool>>,
    /// Connectors whose status was set by hand with `set_coverage`; coverage is not derived for these.
    manual:BTreeSet<(Tool,String)>,
}
impl Collector {
    pub fn new(clock:Arc<dyn Clock>,seed:u32)->Self {Self::with_calendar(clock,seed,Arc::new(LocalCalendar))}
    pub fn with_calendar(clock:Arc<dyn Clock>,seed:u32,calendar:Arc<dyn Calendar>)->Self {
        let now=clock.now_ms(); let mono=clock.monotonic_ms();
        Self {clock,instances:BTreeMap::new(),connectors:BTreeMap::new(),usage:UsageStore::default(),ledger:LedgerStore::new(seed,now,calendar),ordinals:BTreeMap::new(),completed:BTreeMap::new(),answered:BTreeMap::new(),last_accounted:mono,last_wall:now,last_snapshot:None,dirty:true,quick:0,invalid:0,rejected:0,usage_stale:Vec::new(),told:BTreeMap::new(),evidence:BTreeMap::new(),adapters:None,manual:BTreeSet::new()}
    }
    fn validate(&mut self,e:&AgentEvent)->Result<(),CoreError> {
        if e.validate().is_err() || e.parent.as_ref()==Some(&e.instance)
            || e.usage.as_ref().is_some_and(|u|u.observed_at>self.clock.now_ms()) {self.invalid+=1;return Err(CoreError::InvalidEvent);}
        if let Some(i)=self.instances.get(&e.instance) {
            if i.view.tool!=e.agent || i.view.root_id!=e.root_id {return Err(CoreError::IdentityConflict);}
        }
        Ok(())
    }
    fn ensure(&mut self,e:&AgentEvent,wall:u64,mono:u64,placeholder:bool)->Result<(),CoreError> {
        if self.instances.contains_key(&e.instance) {return Ok(());}
        if self.instances.len()>=64 {return Err(CoreError::Capacity);}
        if !self.add_connector(e.agent,&e.root_id) {return Err(CoreError::Capacity);}
        let ordinal=self.ordinals.entry(e.agent).or_default();
        *ordinal=(*ordinal+1).min(999);
        if self.instances.values().any(|i|i.view.tool==e.agent&&i.view.ordinal==*ordinal) {
            *ordinal=(1..=999).find(|o|!self.instances.values().any(|i|i.view.tool==e.agent&&i.view.ordinal==*o)).ok_or(CoreError::Capacity)?;
        }
        let starting=matches!(e.kind,E::SessionStart|E::ProcessUp)&&!placeholder;
        self.instances.insert(e.instance.clone(),Instance {
            view:SnapshotAgent{id:e.instance.clone(),tool:e.agent,host:e.host,ordinal:*ordinal,parent:e.parent.clone(),root_id:e.root_id.clone(),account_id:e.account_id.clone(),session_id:e.session_id.clone(),turn_id:e.turn_id.clone(),request_id:None,state:if starting{S::Starting}else{S::Unknown},reason:None,activity:None,confidence:e.confidence,since:wall,started_at:wall,limited_until:None,project_label:None},
            state_at:mono,last_signal:mono,last_activity:mono,authority:(0,mono),reveal_at:starting.then_some(mono+2000),alive:None,gone_at:None,registry_busy:false,codex_open:false,turn_started:None,error_pending:false,limit:None,waiting_at:None,waiting_earned:false,confirmed_at:wall,restored:false,placeholder,alert_at:wall,main_session_at:None,
        }); self.dirty=true; Ok(())
    }
    /// Makes sure the connector exists (at most 16); false when there is no room.
    fn add_connector(&mut self,tool:Tool,root_id:&str)->bool {
        let key=(tool,root_id.to_string());
        if self.connectors.contains_key(&key) {return true;}
        if self.connectors.len()>=MAX_ENTRIES {return false;}
        self.connectors.insert(key,ToolStatus{tool,root_id:root_id.to_string(),presence:Presence::Present,hooks:HooksStatus::Missing,coverage:Coverage::Degraded,coverage_reason:Some(CoverageReason::HooksMissing)});
        self.refresh_coverage();self.dirty=true;true
    }
    /// The coverage of one connector, derived from what has been observed (the rules are in DECISIONS.md, INT-1):
    /// no adapter or no alert support is unsupported; a hook event that arrived is verified; anything else is degraded.
    fn derive_coverage(&self,key:&(Tool,String))->(HooksStatus,Coverage,Option<CoverageReason>) {
        let tool=key.0;
        if alerts_unsupported(tool) {return (HooksStatus::Unsupported,Coverage::Unsupported,Some(CoverageReason::NoPermissionEvent));}
        if self.adapters.as_ref().is_some_and(|a|!a.contains(&tool)) {return (HooksStatus::Unsupported,Coverage::Unsupported,Some(CoverageReason::Other));}
        let told=self.told.get(&tool).copied();
        if told==Some(HooksStatus::Unsupported) {return (HooksStatus::Unsupported,Coverage::Unsupported,Some(CoverageReason::Other));}
        let ev=self.evidence.get(key);
        let gone=told==Some(HooksStatus::Missing);
        if !gone&&ev.is_some_and(|e|e.verified_at.is_some()) {return (HooksStatus::Installed,Coverage::Verified,None);}
        let hooks=told.unwrap_or(if ev.is_some_and(|e|e.hooked) {HooksStatus::Installed}else{HooksStatus::Missing});
        let failed=ev.is_some_and(|e|e.misses>=MISS_LIMIT);
        let reason=match hooks {
            HooksStatus::Missing=>CoverageReason::HooksMissing,
            HooksStatus::PendingReview=>CoverageReason::HooksPendingReview,
            HooksStatus::Installed=>if failed {CoverageReason::RoundTripFailed}else{CoverageReason::RoundTripPending},
            HooksStatus::Unsupported=>CoverageReason::Other,
        };
        (hooks,Coverage::Degraded,Some(reason))
    }
    fn refresh_coverage(&mut self) {
        let keys:Vec<_>=self.connectors.keys().filter(|k|!self.manual.contains(*k)).cloned().collect();
        for key in keys {
            let (hooks,coverage,reason)=self.derive_coverage(&key);
            let status=self.connectors.get_mut(&key).unwrap();
            if (status.hooks,status.coverage,status.coverage_reason)!=(hooks,coverage,reason) {
                status.hooks=hooks;status.coverage=coverage;status.coverage_reason=reason;self.dirty=true;
            }
        }
    }
    /// A hook event arrived through the receiver and the router for this connector: the round trip is proven.
    fn hook_arrived(&mut self,tool:Tool,root_id:&str,mono:u64,wall:u64) {
        // The installer says the entries are gone: an event can only come from a session that predates the
        // disconnect, so it proves nothing about the hooks as they are now.
        if matches!(self.told.get(&tool),Some(HooksStatus::Missing|HooksStatus::Unsupported))||alerts_unsupported(tool) {return;}
        let ev=self.evidence.entry((tool,root_id.to_string())).or_default();
        ev.hooked=true;ev.last_hook=Some(mono);ev.candidates.clear();ev.misses=0;
        if ev.verified_at.is_none() {ev.verified_at=Some(wall);self.ledger.hooks_connected(wall);}
        self.refresh_coverage();
    }
    /// A turn start seen through a log or the registry. A hook event for the same turn normally arrives within
    /// moments; one that does not is a miss.
    fn log_turn(&mut self,tool:Tool,root_id:&str,mono:u64) {
        let ev=self.evidence.entry((tool,root_id.to_string())).or_default();
        if ev.last_hook.is_some_and(|h|mono.saturating_sub(h)<=HOOK_GRACE_MS) {return;}
        if ev.candidates.len()>=8 {ev.candidates.remove(0);ev.misses=ev.misses.saturating_add(1);}
        ev.candidates.push(mono);
        if ev.misses>=MISS_LIMIT {ev.verified_at=None;self.refresh_coverage();}
    }
    fn expire_candidates(&mut self,now:u64) {
        let mut changed=false;
        for ev in self.evidence.values_mut() {
            let before=ev.candidates.len();
            ev.candidates.retain(|c|now.saturating_sub(*c)<=HOOK_GRACE_MS);
            let expired=before-ev.candidates.len();
            if expired>0 {
                ev.misses=ev.misses.saturating_add(expired.min(255) as u8);
                if ev.misses>=MISS_LIMIT {ev.verified_at=None;}
                changed=true;
            }
        }
        if changed {self.refresh_coverage();}
    }
    /// A child first seen through its own hooks (Codex sends them before its rollout names the parent) was created as
    /// a main session. The first event that carries its parent reconciles it: the parent is adopted, the turn id
    /// hashed in the provisional scope is dropped and the main-session count is taken back (review r1 H6). Only
    /// none to some: a known parent never changes, and an adoption that would make a cycle is ignored.
    fn adopt_parent(&mut self,e:&AgentEvent,wall:u64,mono:u64)->Result<(),CoreError> {
        let Some(parent)=e.parent.as_ref() else {return Ok(())};
        if !self.instances.get(&e.instance).is_some_and(|i|i.view.parent.is_none()) {return Ok(());}
        let mut up=Some(parent.clone());
        for _ in 0..64 {
            let Some(id)=up else {break};
            if id==e.instance {return Ok(());}
            up=self.instances.get(&id).and_then(|i|i.view.parent.clone());
        }
        if !self.instances.contains_key(parent) {let mut p=e.clone();p.instance=parent.clone();p.parent=None;p.kind=E::Heartbeat;p.request_id=None;self.ensure(&p,wall,mono,true)?;}
        let i=self.instances.get_mut(&e.instance).unwrap();
        i.view.parent=Some(parent.clone());i.view.turn_id=None;
        if e.session_id.is_some() {i.view.session_id=e.session_id.clone();}
        if let Some(at)=i.main_session_at.take() {self.ledger.uncount(e.agent,at,Counter::Sessions);}
        self.dirty=true;Ok(())
    }
    fn remove(&mut self,id:&str) {
        let children:Vec<_>=self.instances.iter().filter(|(_,i)|i.view.parent.as_deref()==Some(id)).map(|(id,_)|id.clone()).collect();
        self.instances.remove(id);for child in children {self.remove(&child);}self.dirty=true;
    }
    fn advance(&mut self) {
        let now=self.clock.monotonic_ms();let wall=self.clock.now_ms();
        loop {
            let due=self.instances.iter().filter_map(|(id,i)|i.deadline().map(|(t,s)|(t,id.clone(),s))).filter(|(t,_,_)|*t<=now).min_by_key(|(t,_,_)|*t);
            let boundary=due.as_ref().map_or(now,|(t,_,_)|(*t).max(self.last_accounted));
            if boundary>self.last_accounted {
                let working:BTreeSet<_>=self.instances.values().filter(|i|i.view.state==S::Working&&i.view.parent.is_none()&&!i.placeholder).map(|i|i.view.tool).collect();
                let start=if wall>=self.last_wall && wall-self.last_wall==now-self.last_accounted {self.last_wall}else{wall.saturating_sub(now-self.last_accounted)};
                if !working.is_empty() {self.ledger.work_union(start,boundary-self.last_accounted);}
                for tool in working {self.ledger.work(tool,start,boundary-self.last_accounted);}
                self.last_wall=start+(boundary-self.last_accounted);self.last_accounted=boundary;
            }
            if let Some((at,id,state))=due {
                if let Some(state)=state {let i=self.instances.get_mut(&id).unwrap();i.state(state,wall.saturating_sub(now.saturating_sub(at)),at,Confidence::Inferred);i.codex_open=false;i.registry_busy=false;i.turn_started=None;self.dirty=true;}
                else {self.remove(&id);}
            }else{break;}
        }
        self.last_accounted=now;self.last_wall=wall;
        self.expire_candidates(now);
        let stale:Vec<_>=self.usage.snapshot(wall).iter().map(|u|u.stale).collect();
        if stale!=self.usage_stale {self.usage_stale=stale;self.dirty=true;}
        for i in self.instances.values_mut() {if i.reveal_at.is_some_and(|t|t<=now){i.reveal_at=None;self.dirty=true;}}
        // Bounded privacy-safe dedup memory, retained for a full day.
        self.completed.retain(|_,t|now.saturating_sub(*t)<86400000);
        self.answered.retain(|_,t|now.saturating_sub(*t)<86400000);
    }
    pub fn ingest(&mut self,mut e:AgentEvent)->Result<Vec<CollectorOutput>,CoreError> {
        self.validate(&e)?;self.advance();let wall=self.clock.now_ms();let mono=self.clock.monotonic_ms();e.t=wall;
        if e.kind==E::UsageSample {
            let sample=e.usage.clone().unwrap();
            let previous=self.usage.snapshot(wall).into_iter().find(|u|u.provider==sample.provider&&u.window==sample.window&&u.account_id==e.account_id&&u.root_id==e.root_id);
            let mut moments=Vec::new();
            if self.usage.insert_scoped(sample.clone(),e.account_id.clone(),e.root_id.clone(),wall) {
                self.dirty=true;
                let mut reset=false;
                if sample.used_pct<100.0&&wall.saturating_sub(sample.observed_at)<=FRESH {
                    for i in self.instances.values_mut() {
                        let matching=i.view.state==S::Limited&&i.view.root_id==e.root_id&&i.view.account_id==e.account_id
                            &&i.limit.as_ref().is_some_and(|l|l.provider==sample.provider&&l.resets_at.map_or(true,|at|sample.observed_at>=at)
                                &&matches!((l.window,sample.window),(busyholm_contracts::common::LimitWindow::FiveHour,busyholm_contracts::common::Window::FiveHour)|(busyholm_contracts::common::LimitWindow::Weekly,busyholm_contracts::common::Window::Weekly)));
                        if matching {i.state(S::Idle,wall,mono,Confidence::Exact);i.last_signal=mono;reset=true;}
                    }
                    if reset||previous.is_some_and(|old|sample.resets_at>old.resets_at&&sample.observed_at>=old.resets_at) {
                        let mut m=notice(if sample.window==busyholm_contracts::common::Window::Weekly {M::WeeklyReset}else{M::LimitReset},wall,None);m.provider=Some(sample.provider);moments.push(m);
                    }
                }
            }
            return Ok(self.emit(moments));
        }
        let new=!self.instances.contains_key(&e.instance);
        if let Some(parent)=&e.parent {
            if !self.instances.contains_key(parent) {let mut p=e.clone();p.instance=parent.clone();p.parent=None;p.kind=E::Heartbeat;p.request_id=None;self.ensure(&p,wall,mono,true)?;}
        }
        self.ensure(&e,wall,mono,false)?;
        // Before any dedup or authority rejection: identity metadata is never "stale" (r1 H6).
        self.adopt_parent(&e,wall,mono)?;
        // Evidence about the connector's hooks, taken before any dedup rejection (a duplicate still proves delivery).
        // Usage samples returned above: the statusline wrap proves the wrap, not the alert hooks.
        match e.source {
            EventSource::Hook|EventSource::Plugin=>self.hook_arrived(e.agent,&e.root_id,mono,wall),
            EventSource::Log|EventSource::Registry|EventSource::Poll if e.kind==E::TurnStart=>self.log_turn(e.agent,&e.root_id,mono),
            _=>{}
        }
        let turn_key=e.turn_id.as_ref().map(|t|(e.root_id.clone(),e.instance.clone(),t.clone()));
        if turn_key.as_ref().is_some_and(|k|self.completed.contains_key(k))&&matches!(e.kind,E::TurnStart|E::TurnEnd|E::TurnInterrupted) {self.rejected+=1;return Ok(self.emit(Vec::new()));}
        let request_key=e.request_id.as_ref().map(|r|(e.root_id.clone(),e.instance.clone(),r.clone()));
        if request_key.as_ref().is_some_and(|k|self.answered.contains_key(k))&&matches!(e.kind,E::NeedsPermission|E::NeedsAnswer|E::Answered|E::ToolEnd) {self.rejected+=1;return Ok(self.emit(Vec::new()));}
        let mut moments=Vec::new();
        // A session started before a disconnect still has the hooks loaded; they no longer raise alerts.
        let hooks_gone=matches!(self.told.get(&e.agent),Some(HooksStatus::Missing|HooksStatus::Unsupported));
        let i=self.instances.get_mut(&e.instance).unwrap();
        i.last_signal=mono;
        if e.kind==E::ProcessUp {i.alive=Some(true);i.gone_at=None;}
        if e.kind==E::ProcessDown {i.alive=Some(false);i.gone_at=Some(mono);self.dirty=true;return Ok(self.emit(moments));}
        if e.source==EventSource::Registry {
            if e.kind==E::TurnStart {i.registry_busy=true;}
            if matches!(e.kind,E::TurnEnd|E::TurnInterrupted|E::SessionEnd) {i.registry_busy=false;}
        }
        if rank(&e)<i.authority.0&&mono.saturating_sub(i.authority.1)<FRESH&&e.kind!=E::SessionEnd {
            self.rejected+=1;return Ok(self.emit(moments));
        }
        if !matches!(e.source,EventSource::Process) {i.last_activity=mono;}
        i.authority=(rank(&e),mono);i.view.host=e.host;
        if e.account_id.is_some(){i.view.account_id=e.account_id.clone();}
        if e.session_id.is_some(){i.view.session_id=e.session_id.clone();}
        let main=i.view.parent.is_none();
        let idle_notification=e.detail.as_ref().is_some_and(|d|d.notification==Some(Notification::IdlePrompt));
        let answering=i.view.state==S::NeedsYou&&matches!(e.kind,E::Answered|E::ToolEnd|E::TurnStart);
        // A tool result answers a keyed request only with the same id: an idless one may be a parallel tool's (r1
        // H4c, at the collector boundary for every adapter). An unkeyed alert, a new prompt or an inferred answer
        // without an id still close it.
        let matched_request=i.view.request_id.is_none()||e.request_id==i.view.request_id||(e.request_id.is_none()&&e.kind!=E::ToolEnd);
        if answering&&matched_request {
            let mut m=notice(M::Answered,wall,Some(i));m.request_id=i.view.request_id.clone().or(e.request_id.clone());
            if i.waiting_earned&&i.waiting_at.is_some_and(|at|mono.saturating_sub(at)<=60000) {self.quick=self.quick.saturating_add(1);}
            if let Some(r)=i.view.request_id.as_ref().or(e.request_id.as_ref()) {self.answered.insert((e.root_id.clone(),e.instance.clone(),r.clone()),mono);}
            i.state(S::Working,wall,mono,e.confidence);moments.push(m);
        }else if answering&&!matched_request {self.rejected+=1;return Ok(self.emit(moments));}
        // Review r1 M1: a prompt after a limit hit is an attempt (the same limit may still apply), so it keeps the
        // agent limited. The limit ends on the first sign the model answered that attempt: tool activity, a
        // question, a permission request or a finished turn (or, as before, a fresh good usage sample).
        let answered_retry=match e.kind {
            E::Heartbeat=>!idle_notification&&e.source!=EventSource::Process,
            E::ToolEnd|E::Answered|E::NeedsPermission|E::NeedsAnswer|E::TurnEnd=>true,
            _=>false,
        };
        if i.view.state==S::Limited&&i.turn_started.is_some()&&answered_retry {
            let mut m=notice(M::LimitReset,wall,None);m.provider=i.limit.as_ref().map(|l|l.provider);if m.provider.is_some(){moments.push(m);}
            i.state(S::Working,wall,mono,e.confidence);
        }
        match e.kind {
            E::SessionStart|E::ProcessUp=> {
                if new&&main {self.ledger.count(e.agent,wall,Counter::Sessions);i.main_session_at=Some(wall);}
                if !new&&i.placeholder {i.placeholder=false;if main{self.ledger.count(e.agent,wall,Counter::Sessions);i.main_session_at=Some(wall);}}
            }
            E::TurnStart if i.view.state==S::Limited=> {
                // A retry: remember the turn, stay limited until the model answers it (above).
                if i.turn_started.is_none()||e.turn_id.as_ref().is_some_and(|t|Some(t)!=i.view.turn_id.as_ref()){i.turn_started=Some(mono);}
                i.view.turn_id=e.turn_id.clone().or(i.view.turn_id.clone());
                i.codex_open=e.agent==Tool::Codex;i.placeholder=false;
            }
            E::TurnStart=> {
                if i.error_pending {moments.push(notice(M::Recovered,wall,Some(i)));if main{self.ledger.count(e.agent,wall,Counter::Recovered);}i.error_pending=false;}
                if i.turn_started.is_none()||e.turn_id.as_ref().is_some_and(|t|Some(t)!=i.view.turn_id.as_ref()){i.turn_started=Some(mono);}
                i.view.turn_id=e.turn_id.clone().or(i.view.turn_id.clone());
                i.codex_open=e.agent==Tool::Codex;i.placeholder=false;
                i.state(S::Working,wall,mono,e.confidence);
            }
            E::Heartbeat=> {
                if !idle_notification&&!matches!(i.view.state,S::NeedsYou|S::Error|S::Limited)
                    &&(i.view.state!=S::YourTurn||e.agent==Tool::Antigravity) {
                    i.state(S::Working,wall,mono,e.confidence);i.turn_started.get_or_insert(mono);
                }
                if i.view.state==S::Working {i.view.activity=e.detail.as_ref().and_then(|d|d.activity).or(i.view.activity);}
            }
            E::NeedsPermission|E::NeedsAnswer=> {
                if matches!(e.source,EventSource::Hook|EventSource::Plugin)&&e.confidence==Confidence::Exact&&!hooks_gone
                    && (matches!(i.view.state,S::Working|S::Starting|S::Unknown|S::NeedsYou)) {
                    let reason=if e.kind==E::NeedsPermission{NeedsYouReason::Permission}else{NeedsYouReason::Question};
                    let same=i.view.state==S::NeedsYou&&i.view.request_id==e.request_id;
                    if !same {i.state(S::NeedsYou,wall,mono,e.confidence);i.view.since=wall;i.state_at=mono;i.waiting_at=Some(mono);i.waiting_earned=true;if main{self.ledger.count(e.agent,wall,Counter::NeedsYou);}let mut m=notice(M::NeedsYou,wall,Some(i));m.reason=Some(reason);m.request_id=e.request_id.clone();moments.push(m);}
                    i.view.reason=Some(reason);i.view.request_id=e.request_id.clone();i.confirmed_at=wall;i.alert_at=wall;i.restored=false;i.view.confidence=e.confidence;
                }
            }
            E::Answered|E::ToolEnd=> {
                // An open turn moved to Unknown by a hooks disconnect (it may have been blocked) resumes on its result.
                if i.view.state==S::Unknown&&i.turn_started.is_some() {i.state(S::Working,wall,mono,e.confidence);}
                if i.view.state==S::Working {i.view.activity=e.detail.as_ref().and_then(|d|d.activity).or(i.view.activity);}
            }
            E::TurnInterrupted if i.view.state==S::Limited=> {i.turn_started=None;i.codex_open=false;}
            E::TurnEnd|E::TurnInterrupted=> {
                // A turn whose 90 s of silence was inferred as finished may still end for real later (a long tool).
                let late_end=i.view.state==S::YourTurn&&i.view.confidence==Confidence::Inferred&&e.kind==E::TurnEnd&&i.codex_open==false;
                if late_end&&(e.turn_id.is_none()||i.view.turn_id.is_none()||e.turn_id==i.view.turn_id) {i.view.state=S::Working;}
                if matches!(i.view.state,S::Working|S::NeedsYou|S::Starting)||(i.view.state==S::Unknown&&i.turn_started.is_some()) {
                    // The request this turn was waiting on is over with it; a late copy must not raise it again.
                    if i.view.state==S::NeedsYou {if let Some(r)=i.view.request_id.as_ref() {self.answered.insert((e.root_id.clone(),e.instance.clone(),r.clone()),mono);}}
                    if e.turn_id.is_some()&&i.view.turn_id.is_some()&&e.turn_id!=i.view.turn_id {self.rejected+=1;return Ok(self.emit(moments));}
                    if let Some(key)=turn_key {self.completed.insert(key,mono);}
                    if e.kind==E::TurnEnd {let mut m=notice(M::TurnEnd,wall,Some(i));m.turn_ms=i.turn_started.map(|start|mono.saturating_sub(start).min(604800000) as u32);moments.push(m);self.ledger.count(e.agent,wall,if main{Counter::Turns}else{Counter::SubagentTurns});}
                    else if main{self.ledger.count(e.agent,wall,Counter::Interrupted);}
                    i.codex_open=false;i.registry_busy=false;i.turn_started=None;i.state(S::YourTurn,wall,mono,e.confidence);
                }
            }
            E::Error=> {
                if i.view.state!=S::Error {moments.push(notice(M::Error,wall,Some(i)));if main{self.ledger.count(e.agent,wall,Counter::Errors);}}
                i.error_pending=true;i.turn_started=None;i.codex_open=false;i.registry_busy=false;i.state(S::Error,wall,mono,e.confidence);
            }
            E::LimitHit=> {
                if i.view.state!=S::Limited {let mut m=notice(M::LimitHit,wall,Some(i));m.provider=e.limit.as_ref().map(|l|l.provider);moments.push(m);if main{self.ledger.count(e.agent,wall,Counter::LimitHits);}}
                i.state(S::Limited,wall,mono,e.confidence);i.view.limited_until=e.limit.as_ref().and_then(|l|l.resets_at);i.limit=e.limit.clone();i.turn_started=None;i.codex_open=false;i.registry_busy=false;
            }
            E::SessionEnd=> {self.remove(&e.instance);}
            E::ProcessDown|E::UsageSample=>{}
        }
        self.dirty=true;
        while self.completed.len()>4096 {let key=self.completed.iter().min_by_key(|(_,t)|*t).unwrap().0.clone();self.completed.remove(&key);}
        while self.answered.len()>4096 {let key=self.answered.iter().min_by_key(|(_,t)|*t).unwrap().0.clone();self.answered.remove(&key);}
        Ok(self.emit(moments))
    }
    fn emit(&mut self,moments:Vec<Moment>)->Vec<CollectorOutput> {
        let mut output:Vec<_>=moments.into_iter().map(CollectorOutput::Moment).collect();let mono=self.clock.monotonic_ms();
        if self.dirty&&self.last_snapshot.map_or(true,|last|mono.saturating_sub(last)>=250) {
            output.push(CollectorOutput::Snapshot(self.snapshot()));self.last_snapshot=Some(mono);self.dirty=false;
        }
        output
    }
    pub fn tick(&mut self)->Vec<CollectorOutput> {self.advance();self.emit(Vec::new())}
    pub fn snapshot(&self)->Snapshot {
        let now=self.clock.now_ms();let mono=self.clock.monotonic_ms();
        let mut agents:Vec<_>=self.instances.values().map(|i|{
            let mut a=i.view.clone();if i.reveal_at.is_some_and(|at|mono<at)&&matches!(a.state,S::Working|S::YourTurn|S::Idle){a.state=S::Starting;a.since=a.started_at;a.reason=None;a.activity=None;}
            a
        }).collect();agents.sort_by_key(|a|(a.tool,a.ordinal));
        let needs:Vec<_>=agents.iter().filter(|a|a.state==S::NeedsYou).collect();
        let attention=Attention{needs_you:needs.len() as u8,oldest_since:needs.iter().map(|a|a.since).min()};
        let tools=self.connectors.values().map(|t|{let mut t=t.clone();t.presence=if agents.iter().any(|a|a.tool==t.tool&&a.root_id==t.root_id){Presence::Present}else{Presence::Offline};t}).collect();
        Snapshot{schema_version:Version,t:now,demo:false,agents,tools,limits:self.usage.snapshot(now),attention}
    }
    pub fn rebuild(&mut self,events:Vec<AgentEvent>)->Result<Vec<CollectorOutput>,CoreError> {
        for e in &events {self.validate(e)?;}
        let wall=self.clock.now_ms();let mono=self.clock.monotonic_ms();
        let alive:BTreeSet<_>=events.iter().filter(|e|e.kind==E::ProcessUp).map(|e|e.instance.clone()).collect();
        let mut ordered=events;ordered.sort_by_key(|e|(e.et.unwrap_or(e.t),rank(e)));
        for e in ordered {
            if e.kind==E::UsageSample {self.usage.insert_scoped(e.usage.unwrap(),e.account_id,e.root_id,wall);continue;}
            if e.kind==E::ProcessUp&&self.instances.contains_key(&e.instance) {self.instances.get_mut(&e.instance).unwrap().alive=Some(true);continue;}
            if let Some(parent)=&e.parent {if !self.instances.contains_key(parent){let mut p=e.clone();p.instance=parent.clone();p.parent=None;p.kind=E::Heartbeat;p.request_id=None;self.ensure(&p,wall,mono,true)?;}}
            self.ensure(&e,wall,mono,false)?;self.adopt_parent(&e,wall,mono)?;let i=self.instances.get_mut(&e.instance).unwrap();
            let at=e.et.unwrap_or(e.t);
            // An alert (restored from disk or raised earlier) stays until newer, relevant evidence closes it: an
            // observation from before it, or a tool result for another request, says nothing about it (r1 H3).
            if i.view.state==S::NeedsYou {
                let other_request=i.view.request_id.is_some()&&e.request_id!=i.view.request_id
                    &&(e.kind==E::ToolEnd||(e.kind==E::Answered&&e.request_id.is_some()));
                if at<=i.alert_at||other_request {continue;}
            }
            let stale=wall.saturating_sub(at)>600000;
            i.alive=alive.contains(&e.instance).then_some(true);i.reveal_at=None;
            if stale {i.state(if i.alive==Some(true){S::Idle}else{S::Unknown},wall,mono,Confidence::Inferred);continue;}
            // A retry after a limit hit is not proof the limit ended (r1 M1).
            if i.view.state==S::Limited&&e.kind==E::TurnStart {i.turn_started=Some(mono);continue;}
            let state=match e.kind {E::TurnStart|E::Heartbeat|E::ToolEnd=>S::Working,E::TurnEnd|E::TurnInterrupted=>S::YourTurn,E::Error=>S::Error,E::LimitHit=>S::Limited,E::NeedsPermission|E::NeedsAnswer=>S::NeedsYou,E::SessionStart|E::ProcessUp=>S::Starting,E::Answered=>S::Working,E::SessionEnd|E::ProcessDown=>{self.remove(&e.instance);continue;},E::UsageSample=>unreachable!()};
            i.state(state,wall,mono,e.confidence);i.registry_busy=e.kind==E::TurnStart&&e.source==EventSource::Registry;i.codex_open=e.agent==Tool::Codex&&e.kind==E::TurnStart;i.error_pending=state==S::Error;i.turn_started=(state==S::Working).then_some(mono);i.confirmed_at=wall;
            if state==S::NeedsYou {i.view.reason=Some(if e.kind==E::NeedsPermission{NeedsYouReason::Permission}else{NeedsYouReason::Question});i.view.request_id=e.request_id;i.waiting_at=Some(mono);i.waiting_earned=false;i.alert_at=at.min(wall);}
            if state==S::Limited {i.view.limited_until=e.limit.as_ref().and_then(|l|l.resets_at);i.limit=e.limit;}
        }
        self.dirty=true;Ok(self.emit(Vec::new()))
    }
    pub fn ledger(&self)->&Ledger {&self.ledger.value}
    pub fn load_ledger(&mut self,ledger:Ledger)->Result<(),CoreError> {ledger.validate().map_err(|_|CoreError::InvalidEvent)?;self.ledger.value=ledger;Ok(())}
    pub fn quick_answers(&self)->u32 {self.quick}
    pub fn diagnostics(&self)->serde_json::Value {serde_json::json!({"invalid_events":self.invalid,"rejected_events":self.rejected})}
    /// What the installer knows about the hooks of a tool (from its manifest). Also remembered before the
    /// tool's first event. `Missing` and `Unsupported` end a verification (the entries are gone); the other
    /// statuses keep it, because a delivered hook event beats an inference from config files.
    pub fn set_hooks(&mut self,tool:Tool,status:HooksStatus) {
        let previous=self.told.insert(tool,status);
        for ev in self.evidence.iter_mut().filter(|(k,_)|k.0==tool).map(|(_,e)|e) {
            if matches!(status,HooksStatus::Missing|HooksStatus::Unsupported) {ev.verified_at=None;ev.hooked=false;ev.last_hook=None;ev.candidates.clear();ev.misses=0;}
            else if status==HooksStatus::Installed&&previous!=Some(HooksStatus::Installed) {ev.candidates.clear();ev.misses=0;}
        }
        // Disconnecting ends this tool's open alerts with the hooks that raised them (the bell and flag stop). The agent
        // may still be blocked, so it is not working until new activity says so.
        if matches!(status,HooksStatus::Missing|HooksStatus::Unsupported) {
            let (wall,mono)=(self.clock.now_ms(),self.clock.monotonic_ms());
            for i in self.instances.values_mut().filter(|i|i.view.tool==tool&&i.view.state==S::NeedsYou) {i.state(S::Unknown,wall,mono,Confidence::Inferred);}
        }
        self.refresh_coverage();self.dirty=true;
    }
    pub fn set_coverage(&mut self,status:ToolStatus)->Result<(),CoreError> {
        let mut test=self.snapshot();test.tools=vec![status.clone()];test.validate().map_err(|_|CoreError::InvalidEvent)?;
        if self.connectors.len()>=16&&!self.connectors.contains_key(&(status.tool,status.root_id.clone())){return Err(CoreError::Capacity);}
        if status.coverage==Coverage::Verified {self.ledger.hooks_connected(self.clock.now_ms());}
        let key=(status.tool,status.root_id.clone());self.manual.insert(key.clone());
        self.connectors.insert(key,status);self.dirty=true;Ok(())
    }
    /// The tools that have an adapter (`AdapterRouter::registered`). A tool without one is `unsupported`.
    pub fn set_adapters(&mut self,tools:impl IntoIterator<Item=Tool>) {
        self.adapters=Some(tools.into_iter().collect());self.refresh_coverage();self.dirty=true;
    }
    /// What must survive a restart: the verified connectors (ids and times only).
    pub fn coverage_record(&self)->CoverageFile {
        let mut file=CoverageFile::empty();
        file.entries=self.evidence.iter().filter_map(|((tool,root),ev)|ev.verified_at.map(|verified_at|CoverageEntry{tool:*tool,root_id:root.clone(),verified_at})).collect();
        file
    }
    /// Loads the record written by `coverage_record`. A record from another OS is ignored; a malformed one is an error.
    pub fn restore_coverage(&mut self,file:CoverageFile)->Result<(),CoreError> {
        if file.schema_version!=1||file.entries.len()>MAX_ENTRIES {return Err(CoreError::InvalidEvent);}
        let mut seen=BTreeSet::new();
        for e in &file.entries {
            if !valid_id(&e.root_id)||!(946684800000..=4102444800000).contains(&e.verified_at)||!seen.insert((e.tool,e.root_id.clone())) {return Err(CoreError::InvalidEvent);}
        }
        if file.os!=std::env::consts::OS {return Ok(());}
        for e in file.entries {
            if alerts_unsupported(e.tool)||!self.add_connector(e.tool,&e.root_id) {continue;}
            let ev=self.evidence.entry((e.tool,e.root_id)).or_default();
            ev.verified_at=Some(e.verified_at);ev.hooked=true;
        }
        self.refresh_coverage();self.dirty=true;Ok(())
    }
    pub fn pending_alerts(&self)->PendingAlerts {
        PendingAlerts{schema_version:Version,privacy:Privacy::default(),saved_at:self.clock.now_ms(),alerts:self.instances.values().filter(|i|i.view.state==S::NeedsYou).map(|i|PendingAlert{agent:i.view.id.clone(),tool:i.view.tool,host:i.view.host,root_id:i.view.root_id.clone(),account_id:i.view.account_id.clone(),session_id:i.view.session_id.clone(),request_id:i.view.request_id.clone(),reason:i.view.reason.unwrap(),since:i.view.since,last_confirmed_at:i.confirmed_at}).collect()}
    }
    pub fn restore_pending(&mut self,pending:PendingAlerts)->Result<(),CoreError> {
        pending.validate().map_err(|_|CoreError::InvalidEvent)?;let wall=self.clock.now_ms();let mono=self.clock.monotonic_ms();
        for a in pending.alerts {
            if a.last_confirmed_at<a.since||a.last_confirmed_at>pending.saved_at{return Err(CoreError::InvalidEvent);}
            // The wall clock may have been set back since the file was written (NTP, DST fixes): keep the alert.
            let mut a=a;if a.since>wall {a.since=wall;a.last_confirmed_at=a.last_confirmed_at.min(wall);}
            let e=AgentEvent{v:Version,agent:a.tool,instance:a.agent.clone(),parent:None,root_id:a.root_id,account_id:a.account_id,session_id:a.session_id,turn_id:None,request_id:a.request_id,host:a.host,kind:E::NeedsPermission,source:EventSource::Hook,confidence:Confidence::Inferred,t:wall,et:None,detail:None,usage:None,limit:None,tokens_delta:None};
            self.ensure(&e,wall,mono,false)?;let i=self.instances.get_mut(&a.agent).unwrap();i.view.started_at=a.since;i.state(S::NeedsYou,a.since,mono,Confidence::Inferred);i.view.reason=Some(a.reason);i.view.request_id=e.request_id;i.restored=true;i.confirmed_at=a.last_confirmed_at;i.alert_at=a.last_confirmed_at;i.waiting_earned=false;
        }
        self.dirty=true;Ok(())
    }
    /// Sleep until the next actual deadline; idle collectors do not poll at 4 Hz.
    pub fn next_wake_ms(&self)->u64 {
        let mono=self.clock.monotonic_ms();let wall=self.clock.now_ms();let mut due=Vec::new();
        if self.dirty {due.push(self.last_snapshot.map_or(mono,|last|last+250));}
        for i in self.instances.values(){if let Some((at,_))=i.deadline(){due.push(at);}if let Some(at)=i.reveal_at{due.push(at);}}
        for ev in self.evidence.values() {for c in &ev.candidates {due.push(c+HOOK_GRACE_MS+1);}}
        if let Some(at)=self.usage.next_stale_at(wall){due.push(mono+at.saturating_sub(wall));}
        due.into_iter().min().map_or(30000,|at|at.saturating_sub(mono).min(30000))
    }
}
