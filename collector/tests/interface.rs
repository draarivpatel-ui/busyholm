use collector::{contracts::{AgentEvent, common::Tool}, Adapter, AdapterContext, AdapterError,
    CollectorInput, EventBus, EventSender, SendError};

fn event() -> AgentEvent {
    serde_json::from_value(serde_json::json!({"v":1,"agent":"claude","instance":"00000000000000000000000000000001",
        "parent":null,"root_id":"00000000000000000000000000000003","account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "host":"cli","kind":"turn_start","source":"hook","confidence":"exact","t":1791806400000_u64})).unwrap()
}

struct Example;
impl Adapter for Example {
    fn tool(&self) -> Tool { Tool::Claude }
    fn map_hook(&mut self, _: &[u8], _: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> { Ok(vec![event()]) }
}

#[test]
fn public_adapter_is_object_safe_and_sender_is_send_sync() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<EventSender>();
    let adapter: Box<dyn Adapter> = Box::new(Example);
    assert_eq!(adapter.tool(), Tool::Claude);
}

#[test]
fn bus_accepts_only_valid_events_without_blocking() {
    let bus = EventBus::bounded(1);
    assert_eq!(bus.sender().send(event()), Ok(()));
    assert_eq!(bus.sender().send(event()), Err(SendError::Full));
    assert!(matches!(bus.receiver.try_recv().unwrap(), CollectorInput::Event(_)));
    let mut bad = event(); bad.instance = "private raw session id".into();
    assert_eq!(bus.sender().send(bad), Err(SendError::InvalidEvent));
}
