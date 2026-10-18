# Optional helper: puts the usual Rust toolchain locations on PATH for this shell
# (Homebrew rustup and ~/.cargo/bin). Skip it if `cargo` already works for you.
# Usage: source tools/env.sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
export HOMEBREW_NO_AUTO_UPDATE=1
