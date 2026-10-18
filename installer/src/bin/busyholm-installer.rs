//! A small command line over the installer library, for previews and manual checks.
//!
//! ```text
//! busyholm-installer <preview|install|disconnect-preview|disconnect> [components] [folders] [--yes]
//!
//! components: --claude-hooks --claude-statusline --codex --opencode   (disconnect: none means all)
//! folders:    --data-dir D --claude-dir D --codex-dir D --opencode-dir D   (defaults: this OS and the usual homes)
//! sources:    --shim <built busyholm-hook> --plugin <busyholm.js>
//! ```
//!
//! `preview` and `disconnect-preview` print the exact diff and write nothing. `install` and `disconnect` write
//! only with `--yes`.

use busyholm_installer::{Component, Installer, Layout, Sources};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().cloned() else {
        eprintln!("usage: busyholm-installer <preview|install|disconnect-preview|disconnect> [options]; see the file header");
        std::process::exit(2);
    };
    let mut comps = Vec::new();
    let (mut data, mut claude, mut codex, mut opencode, mut shim, mut plugin) = (None, None, None, None, None, None);
    let mut yes = false;
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let mut val = || it.next().map(PathBuf::from);
        match a.as_str() {
            "--claude-hooks" => comps.push(Component::ClaudeHooks),
            "--claude-statusline" => comps.push(Component::ClaudeStatusline),
            "--codex" => comps.push(Component::CodexHooks),
            "--opencode" => comps.push(Component::OpencodePlugin),
            "--data-dir" => data = val(),
            "--claude-dir" => claude = val(),
            "--codex-dir" => codex = val(),
            "--opencode-dir" => opencode = val(),
            "--shim" => shim = val(),
            "--plugin" => plugin = val(),
            "--yes" => yes = true,
            other => {
                eprintln!("unknown option {other}");
                std::process::exit(2);
            }
        }
    }
    let env = |k: &str| std::env::var(k).ok();
    let home = PathBuf::from(env("HOME").or_else(|| env("USERPROFILE")).unwrap_or_default());
    let mut layout = Layout::from_env_with(&home, Layout::default_data_dir(&home, &env), &env);
    if let Some(d) = data { layout.data_dir = d }
    if let Some(d) = claude { layout.claude_dir = d }
    if let Some(d) = codex { layout.codex_dir = d }
    if let Some(d) = opencode { layout.opencode_dir = d }
    let installer = Installer::new(layout);
    let result = (|| -> Result<(), busyholm_installer::InstallError> {
        let plan = match cmd.as_str() {
            "preview" | "install" => {
                let shim_binary = shim.clone().unwrap_or_else(|| PathBuf::from("busyholm-hook"));
                let opencode_plugin = match &plugin {
                    Some(p) => std::fs::read_to_string(p).map_err(|e| busyholm_installer::InstallError::Io { path: p.clone(), source: e })?,
                    None => String::new(),
                };
                installer.plan_install(&comps, &Sources { shim_binary, opencode_plugin })?
            }
            "disconnect-preview" | "disconnect" => installer.plan_disconnect(&comps)?,
            _ => {
                eprintln!("unknown command {cmd}");
                std::process::exit(2);
            }
        };
        print!("{}", plan.diff_text());
        if plan.is_noop() {
            println!("# nothing to do");
        }
        if matches!(cmd.as_str(), "install" | "disconnect") {
            if yes {
                installer.apply(&plan)?;
                println!("# done");
            } else {
                println!("# preview only: add --yes to write");
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
