# Offline verification

Release gates that run without a network and without installing anything. Product inputs are synthetic, agent folders are overridden only for child processes, and app data lives in fresh temporary folders. Every command returns 1 for a failed or incomplete gate.

```sh
python3 tools/verify/run.py self-test      # negative controls (seeded failures must be caught)
python3 tools/verify/run.py prepare        # builds the shim, sidecar, pages and app with the collector
python3 tools/verify/run.py all --json tools/verify/output/all.json
```

Individual checks: `static-network`, `runtime-network`, `privacy`, `licenses` and `dash`.

- **static-network** scans authored product code for networking APIs. The receiver and the shim client are the two audited loopback implementations listed in `loopback-policy.json`; their source digests are pinned, so a changed file fails until it is reviewed and the digest is updated. The OpenCode plugin (`collector-wp06/plugin/busyholm.js`) is a loopback client too and is checked by rule (see `loopback_client_issues` in `checks.py`). Static scanning is a tripwire, not a proof against deliberately obfuscated code.
- **runtime-network** records TCP and UDP sockets with unprivileged `lsof` while the real shim and collector run, and rejects any non-loopback peer or wildcard listener. Short connections can still escape sampling; the report says so.
- **privacy** runs the real shim, the real collector service and (unless `--sidecar-only`) the real app with canary strings planted in every content field. Every file the run produces is scanned as bytes (plain text, UTF-16, hex and base64). `--seed-leak` plants a canary in an output and must fail.
- **licenses** generates third-party notices from `cargo metadata --offline --locked` and the npm lockfiles, plus locally installed notice files. SPDX expressions are parsed with AND/OR precedence; unknown and strong-copyleft-only licences fail. MPL-2.0 is allowed with the complete package source archive included. The Fraunces OFL text is copied without rewriting.
- **dash** lints user-facing copy (public README files, HTML and literal strings in product code) for em and en dashes.

When an installed package ships no licence text, the generator uses a committed override from `packaging/licence-overrides/<name>-<version>/` (an npm scope slash becomes `__`). The text must match the declared SPDX expression; otherwise the gate fails. Each override folder has a `SOURCE.txt` with the `spdx:` line and the URLs the text came from.

Data inventory the privacy check allows: `ledger.json`, `choices.json`, `settings.json`, `install-manifest.json`, `salt`, `backups/`, `demo-ledger.json`, `pending-alerts.json`, `coverage.json`, `onboarding.json`, `runtime.json` and `receiver-keys.json`, plus atomic and recovery variants of those names. Unknown top-level outputs are rejected.

Performance budgets are measured separately; see `SPEC` notes in `docs/` if present, and `world/renderer/tools/measure-cpu.mjs` for a Chrome comparison tool.
