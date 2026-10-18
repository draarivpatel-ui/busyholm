//! Review r1 M4: Busyholm started before `<CODEX_HOME>/sessions` exists must still register Codex (hooks would
//! otherwise get 400 until a restart) and attach the rollout watch once the folder appears.
use std::sync::Arc;
use collector::{AdapterContext, Clock, IdentityHasher, SystemClock, contracts::common::Tool};
use sidecar::{build_router, Roots};

#[test]
fn m4_codex_is_registered_while_its_sessions_folder_does_not_exist_yet() {
    let base = std::env::temp_dir().canonicalize().unwrap().join(format!("bh-fixa-m4-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let ctx = AdapterContext { clock, identities: IdentityHasher::new([3; 32]) };
    let router = build_router(ctx, &Roots { claude: None, codex_sessions: Some(base.join("codex/sessions")) });
    assert_eq!(router.registered(), vec![Tool::Codex], "a provisional Codex connector maps hooks until the folder appears");
}
