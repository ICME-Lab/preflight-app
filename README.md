# Preflight

A desktop client for [ICME Preflight](https://docs.icme.io), the formal-verification
service that turns plain-English policies into a cryptographic guardrail for AI
agents. The app lets you create policies, browse and refine compiled rules, run
ad-hoc test actions, manage the Claude Code hook, and watch a live activity log
of every check made against your account (in-app and hook-driven).

Built with [Tauri 2](https://tauri.app) (Rust) + React + TypeScript.

## Prerequisites

- **macOS** (Apple Silicon or Intel). Linux/Windows are theoretically supported
  by Tauri but the build has only been exercised on macOS.
- **Rust** stable: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node 20+**: easiest via [nvm](https://github.com/nvm-sh/nvm), then `nvm install 20`
- **Xcode Command Line Tools**: `xcode-select --install`
- An **ICME Preflight account**. You can create one from inside the app on first
  launch, or grab a key at https://docs.icme.io.

## Install from source

```bash
git clone git@github.com:ICME-Lab/preflight-app.git
cd preflight-app
npm install
```

### Run in dev mode

```bash
npm run tauri dev
```

The first build takes 5-10 minutes while Rust compiles the Tauri + reqwest +
axum dependency tree. Subsequent runs are seconds. The dev window hot-reloads
the React side; Rust changes require a `Ctrl-C` and re-run.

### Build a release binary

```bash
npm run tauri build
```

Outputs:

- `src-tauri/target/release/bundle/macos/Preflight.app` — the app bundle
  (drag to /Applications)
- `src-tauri/target/release/bundle/dmg/Preflight_<version>_<arch>.dmg` — the
  installer image

For a universal binary that runs on both Apple Silicon and Intel:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

### Installing a locally-built binary

If you built locally (vs. downloading from a Release), the binary is **not
quarantined**, so you can copy it straight in:

```bash
cp -R src-tauri/target/release/bundle/macos/Preflight.app /Applications/
open /Applications/Preflight.app
```

If you instead downloaded the `.dmg` from a GitHub Release that is **not** yet
signed + notarized, macOS will refuse to install it. Strip the quarantine
attribute first:

```bash
xattr -d com.apple.quarantine ~/Downloads/Preflight_*.dmg
open ~/Downloads/Preflight_*.dmg
cp -R /Volumes/Preflight/Preflight.app /Applications/
xattr -dr com.apple.quarantine /Applications/Preflight.app
open /Applications/Preflight.app
```

## Configuration

Credentials live in `~/.icme/env` (the same file the Claude Code hook reads)
with mode `0600`:

```
ICME_API_KEY=sk-smt-...
ICME_POLICY_ID=...
ICME_HOOK_ENABLED=true        # toggled from the in-app "Claude Code Hook" panel
```

The app reads this on startup. Signup, login, and the **Log out** flow in the
app all manage these values for you, so you generally don't need to touch the
file directly.

## Project layout

```
preflight-app/
  src/                  React + TypeScript frontend
    components/         Modals, panels, individual policy/scenario UI
    hooks/              localStorage-backed nicknames, hidden flags, rules cache
    utils/smt.ts        SMT-LIB pretty-printer + syntax tokenizer
  src-tauri/            Tauri 2 (Rust) backend
    src/preflight.rs    HTTP client + SSE streaming + env-file helpers
    src/signer.rs       Local axum server for the MetaMask signup handoff
    src/lib.rs          Tauri command surface
    assets/signer.html  Browser-side EIP-3009 signer for x402 signup
    icons/              App icons (macOS .icns, Windows .ico, Linux PNGs)
  .github/workflows/    Release pipeline (signed + notarized DMG on tag push)
```

## Releasing

Tags matching `v*` trigger `.github/workflows/release.yml`, which builds a
universal-apple-darwin binary on a macOS runner, signs it with the Developer
ID stored in repo secrets, notarizes via Apple, and attaches the `.dmg` to a
draft GitHub Release. See the workflow file for the list of secrets it
expects.

```bash
git tag v0.1.2
git push origin v0.1.2
```

## License

MIT.
