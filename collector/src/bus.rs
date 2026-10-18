use std::{collections::VecDeque, sync::{Arc, Condvar, Mutex}, sync::mpsc::{RecvError, RecvTimeoutError, TryRecvError}, time::{Duration,Instant}};
use busyholm_contracts::{AgentEvent, Snapshot, Moment, Ledger, Validate, common::Tool, snapshot::HooksStatus, agent_event::EventKind};
use serde::Serialize;

#[derive(Debug, Clone)]
pub enum CollectorInput {
    Event(AgentEvent),
    Rebuild(Vec<AgentEvent>),
    Hooks { tool: Tool, status: HooksStatus },
    /// An adapter saw a file notice: poll the adapters now (`Waker`, review r1 M5).
    Wake,
    Shutdown,
    /// Stop without writing the final flush ("Delete everything", review r3 P1-B).
    ShutdownWithoutFlush,
}

/// One JSON object per stdout line in sidecar mode.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CollectorOutput { Snapshot(Snapshot), Moment(Moment), Ledger(Ledger) }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError { InvalidEvent, Full, Closed }

#[derive(Clone)]
pub struct EventSender { shared: Arc<Shared> }
impl EventSender {
    fn enqueue(&self, input:CollectorInput)->Result<(),SendError> {
        let mut q=self.shared.queue.lock().unwrap();
        if q.closed||q.stop_at.is_some() {return Err(SendError::Closed);}
        if q.urgent.len()+q.normal.len()>=self.shared.capacity {return Err(SendError::Full);}
        push(&mut q,input);
        self.shared.ready.notify_one(); Ok(())
    }
    pub fn send(&self, event:AgentEvent)->Result<(),SendError> {
        event.validate().map_err(|_|SendError::InvalidEvent)?;
        if event.parent.as_ref()==Some(&event.instance) {return Err(SendError::InvalidEvent);}
        self.enqueue(CollectorInput::Event(event))
    }
    /// Atomically accepts all events from one sanitized payload, or none.
    pub fn send_batch(&self, events:Vec<AgentEvent>)->Result<(),SendError> {
        if events.iter().any(|e|e.validate().is_err()||e.parent.as_ref()==Some(&e.instance)) {return Err(SendError::InvalidEvent);}
        let mut q=self.shared.queue.lock().unwrap();
        if q.closed||q.stop_at.is_some() {return Err(SendError::Closed);}
        if q.urgent.len()+q.normal.len()+events.len()>self.shared.capacity {return Err(SendError::Full);}
        for e in events {push(&mut q,CollectorInput::Event(e));}
        self.shared.ready.notify_one(); Ok(())
    }
    pub fn rebuild(&self, events:Vec<AgentEvent>)->Result<(),SendError> {
        if events.len()>64 || events.iter().any(|e| e.validate().is_err()) {return Err(SendError::InvalidEvent);}
        self.enqueue(CollectorInput::Rebuild(events))
    }
    /// A handle adapters keep to ask for an early poll (review r1 M5).
    pub fn waker(&self)->Waker {Waker{shared:self.shared.clone()}}
    pub fn hooks(&self, tool:Tool,status:HooksStatus)->Result<(),SendError> {self.enqueue(CollectorInput::Hooks{tool,status})}
    /// Asks the service to stop. The stop travels outside the bounded data queue, so it is never refused with
    /// `Full` (a lost stop hung Quit, review r1 H2): everything queued before it is still delivered, then
    /// `Shutdown`; sends after it get `Closed`. Only fails with `Closed` once the service is gone.
    pub fn shutdown(&self)->Result<(),SendError> {
        let mut q=self.shared.queue.lock().unwrap();
        if q.closed {return Err(SendError::Closed);}
        if q.stop_at.is_none() {q.stop_at=Some(q.next);}
        self.shared.ready.notify_all(); Ok(())
    }
    /// Asks the service to stop immediately without flushing anything to disk ("Delete everything", review r3 P1-B).
    pub fn shutdown_without_flush(&self)->Result<(),SendError> {
        let mut q=self.shared.queue.lock().unwrap();
        if q.closed {return Err(SendError::Closed);}
        q.urgent.clear();
        q.normal.clear();
        q.skip_flush=true;
        if q.stop_at.is_none() {q.stop_at=Some(q.next);}
        self.shared.ready.notify_all(); Ok(())
    }
}

/// Asks the service loop to poll its adapters now (a file notice arrived) instead of at the next period. It never
/// competes with data for queue space and never fails; repeated wakes before the loop runs coalesce into one.
#[derive(Clone)]
pub struct Waker { shared:Arc<Shared> }
impl Waker {
    pub fn wake(&self) {
        let mut q=self.shared.queue.lock().unwrap_or_else(|e|e.into_inner());
        if !q.wake {q.wake=true;self.shared.ready.notify_one();}
    }
}

struct Queued { sequence:u64,input:CollectorInput }
struct Queue {
    urgent:VecDeque<Queued>, normal:VecDeque<Queued>, closed:bool,next:u64,
    /// Set by `shutdown`: the sequence number at the stop. Data sent after it is refused, so once both queues are
    /// empty the receiver gets `Shutdown` (or `ShutdownWithoutFlush` when `skip_flush` is set).
    stop_at:Option<u64>,
    skip_flush:bool,
    /// Set by `Waker::wake`; delivered as `Wake` once no data is waiting.
    wake:bool,
}
struct Shared { queue:Mutex<Queue>, ready:Condvar, capacity:usize }
fn urgent(input:&CollectorInput)->bool {
    matches!(input,CollectorInput::Event(e) if matches!(e.kind,EventKind::NeedsPermission|EventKind::NeedsAnswer|EventKind::Answered|EventKind::SessionEnd))
}
fn push(q:&mut Queue,input:CollectorInput) {
    let sequence=q.next;q.next=q.next.wrapping_add(1);
    if urgent(&input) {q.urgent.push_back(Queued{sequence,input});}else{q.normal.push_back(Queued{sequence,input});}
}
fn pop(q:&mut Queue)->Option<CollectorInput> {
    if let Some(front)=q.urgent.front() {
        if let CollectorInput::Event(urgent)=&front.input {
            let before=q.normal.iter().position(|queued|queued.sequence<front.sequence&&match &queued.input {
                CollectorInput::Event(e)=>e.instance==urgent.instance,
                CollectorInput::Rebuild(_)=>true,_=>false,
            });
            if let Some(index)=before {return q.normal.remove(index).map(|q|q.input);}
        }
    }
    q.urgent.pop_front().or_else(||q.normal.pop_front()).map(|q|q.input)
        .or_else(||q.stop_at.map(|_|if q.skip_flush {CollectorInput::ShutdownWithoutFlush} else {CollectorInput::Shutdown}))
        .or_else(||std::mem::take(&mut q.wake).then_some(CollectorInput::Wake))
}
pub struct EventReceiver { shared:Arc<Shared> }
impl EventReceiver {
    pub fn try_recv(&self)->Result<CollectorInput,TryRecvError> {
        let mut q=self.shared.queue.lock().unwrap();
        pop(&mut q).ok_or(if q.closed {TryRecvError::Disconnected}else{TryRecvError::Empty})
    }
    pub fn recv(&self)->Result<CollectorInput,RecvError> {
        let mut q=self.shared.queue.lock().unwrap();
        loop {
            if let Some(input)=pop(&mut q) {return Ok(input);}
            if q.closed {return Err(RecvError);}
            q=self.shared.ready.wait(q).unwrap();
        }
    }
    pub fn recv_timeout(&self,timeout:Duration)->Result<CollectorInput,RecvTimeoutError> {
        let deadline=Instant::now()+timeout; let mut q=self.shared.queue.lock().unwrap();
        loop {
            if let Some(input)=pop(&mut q) {return Ok(input);}
            if q.closed {return Err(RecvTimeoutError::Disconnected);}
            let left=deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {return Err(RecvTimeoutError::Timeout);}
            q=self.shared.ready.wait_timeout(q,left).unwrap().0;
        }
    }
}
impl Drop for EventReceiver {
    fn drop(&mut self) {self.shared.queue.lock().unwrap().closed=true; self.shared.ready.notify_all();}
}
pub struct EventBus { pub receiver:EventReceiver, sender:EventSender }
impl EventBus {
    pub fn bounded(capacity: usize) -> Self {
        let shared=Arc::new(Shared {queue:Mutex::new(Queue{urgent:VecDeque::new(),normal:VecDeque::new(),closed:false,next:0,stop_at:None,skip_flush:false,wake:false}),ready:Condvar::new(),capacity:capacity.max(1)});
        Self {receiver:EventReceiver {shared:shared.clone()}, sender:EventSender {shared}}
    }
    pub fn sender(&self) -> EventSender { self.sender.clone() }
}
