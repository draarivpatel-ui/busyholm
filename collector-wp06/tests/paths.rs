use collector_wp06::paths::{agy_root, opencode_data_dir, opencode_db};
use std::path::Path;

#[test]
fn opencode_data_dir_follows_xdg_then_home() {
    let home = Path::new("/home/u");
    assert_eq!(opencode_data_dir(home, None), Path::new("/home/u/.local/share/opencode"));
    assert_eq!(opencode_data_dir(home, Some("")), Path::new("/home/u/.local/share/opencode"));
    assert_eq!(opencode_data_dir(home, Some("/data/xdg")), Path::new("/data/xdg/opencode"));
    assert_eq!(opencode_data_dir(home, Some("relative/dir")), Path::new("/home/u/.local/share/opencode"), "a relative XDG value is ignored, as the XDG spec says");
    assert_eq!(opencode_db(Path::new("/d/opencode")), Path::new("/d/opencode/opencode.db"));
}

#[test]
fn windows_style_home_is_just_a_path() {
    let home = Path::new(r"C:\Users\u");
    let d = opencode_data_dir(home, None);
    assert!(d.ends_with(".local/share/opencode") || d.ends_with(r".local\share\opencode"));
    assert!(agy_root(home).ends_with(".gemini/antigravity-cli") || agy_root(home).ends_with(r".gemini\antigravity-cli"));
}

#[test]
fn agy_root_is_under_dot_gemini() {
    assert_eq!(agy_root(Path::new("/Users/u")), Path::new("/Users/u/.gemini/antigravity-cli"));
}

#[test]
fn database_candidates_follow_the_override_then_xdg_then_appdata() {
    use collector_wp06::paths::opencode_db_candidates;
    use std::collections::HashMap;
    let home = Path::new("/home/u");
    let env = |pairs: &[(&str, &str)]| {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| m.get(k).cloned()
    };
    assert_eq!(opencode_db_candidates(home, &env(&[])), vec![Path::new("/home/u/.local/share/opencode/opencode.db")]);
    assert_eq!(
        opencode_db_candidates(home, &env(&[("OPENCODE_DB", "/x/my.db"), ("XDG_DATA_HOME", "/d")])),
        vec![Path::new("/x/my.db"), Path::new("/d/opencode/opencode.db")]
    );
    assert_eq!(opencode_db_candidates(home, &env(&[("OPENCODE_DB", "relative.db")])).len(), 1, "a relative override is ignored");
    let c = opencode_db_candidates(home, &env(&[("APPDATA", "/ad")]));
    assert_eq!(c.last().unwrap(), Path::new("/ad/opencode/opencode.db"));
    assert_eq!(c.len(), 2);
}
