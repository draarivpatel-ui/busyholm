# Unsigned, offline packaging

These scripts build local, unsigned bundles. They contain no signing identity, notarisation, account login, store upload or publishing step. A normal run requires every verification gate (`tools/verify`) to pass; `--draft` is an explicit diagnostic mode that can produce local artifacts with failed gates, labels them as drafts and still returns 1.

```sh
source tools/env.sh                 # optional: Rust toolchain on PATH
python3 tools/verify/run.py prepare
python3 tools/verify/run.py all --json tools/verify/output/all.json
bash packaging/macos.sh --out packaging/out/macos --report tools/verify/output/all.json
bash packaging/windows.sh --out packaging/out/windows --report tools/verify/output/all.json
```

For a plain local build without the gates, `cd app && npm ci && npm run build` (see `app/README.md`, "Release build") is the shorter route.

Use a new output folder for every run. `--dry-run` writes the command plan and a store-depot folder layout without compiling. A release report must match the target OS, the current git HEAD and the product source fingerprints; a Mac report cannot approve a Windows or Linux release. Windows arm64 is `python3 packaging/build.py --target windows-arm64 --out ...`. On an Intel Mac, `macos.sh` selects the x64 target. A universal macOS build is not implemented.

All Cargo commands use `--offline --locked` and the installed toolchain. Tauri is invoked through the installed `app/node_modules/.bin/tauri`, never `npx`. On macOS every build and bundle command runs inside an OS sandbox that denies outbound networking, including any bundler or cargo-xwin helper. The scripts never install dependencies or accept a new SDK licence; missing caches stop the build.

The real collector feature is always enabled. The matching `busyholm-hook` is built for the same target and included as a Tauri external binary, so it sits beside the app executable where the installer looks for it. Notices, the original Fraunces `OFL.txt` and the MPL source archive are bundled as resources. The frontend is rebuilt from the real renderer and UI before assembly.

On macOS, Tauri makes `Busyholm.app` with `--no-sign`; `hdiutil create` then makes `Busyholm-unsigned.dmg` containing the app and an Applications link, and `hdiutil verify` checks the image. The compiler may leave an ad hoc signature on Mach-O code; this is not a Developer ID signature or notarisation. Because the build is unsigned, macOS Gatekeeper will warn on first launch (right-click and Open, or allow it in System Settings, Privacy and Security).

Windows NSIS builds use cargo-xwin with an already cached SDK. The bundle overlay sets WebView2 installation mode to `skip`: no runtime installer is downloaded or executed, so WebView2 must already be installed. The Windows build has not been run on a real Windows desktop.

For Linux, run `bash packaging/linux.sh --out /path/to/new/output --draft` inside a provisioned Linux VM or checkout. The script enters a fresh user and network namespace before building AppImage and deb. Rust, Node, the Tauri CLI, WebKitGTK and GTK development libraries, AppImage tools and all crate, npm and bundler caches must already be installed. If user namespaces are disabled, run in an offline container with no network interface and call `build.py` directly. No apt command or dependency download is included. Linux is not a supported release target yet.

Depot dry runs stage raw files under `steam/content/<os>/` with launch metadata in `steam/launch-dry-run.json`, for stores that want unpacked files. Installers are rejected in a depot, and no fake binaries are created.

Third-party licence texts that an installed package does not ship are committed in `packaging/licence-overrides/<name>-<version>/`; see `tools/verify/README.md`.
