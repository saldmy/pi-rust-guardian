# pi-rust-guardian

[![npm version](https://img.shields.io/npm/v/pi-rust-guardian.svg)](https://www.npmjs.com/package/pi-rust-guardian)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/pi--package-extension-purple.svg)](https://pi.dev)
[![Node >=22.19.0](https://img.shields.io/badge/node-%3E%3D22.19.0-green.svg)](https://nodejs.org)
[![CI](https://github.com/saldmy/pi-rust-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/saldmy/pi-rust-guardian/actions/workflows/ci.yml)

> **Zero-tool, zero-prompt-tax Rust compiler feedback and Read-Guard for the [`pi`](https://pi.dev) coding agent.**

`pi-rust-guardian` attaches guardrails and compiler intelligence directly to Pi's core tools (`read`, `write`, `edit`). It requires **0 extra tools**, injects **0 prompt tokens**, avoids KV-cache rewinds on local models, and short-circuits Rust compile feedback into a single turn.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ ● ● ●  📁 π - tui-calculator                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ edit src/app.rs                                                              │
│                                                                              │
│       ...                                                                    │
│ 2270        // Typing a character clears it.                                 │
│ 2271        app.insert("1");                                                 │
│ 2272        assert_eq!(app.committed_result(), None);                       │
│ 2273                                                                         │
│ -2274       // Backspace clears it.                                          │
│ +2274       // Backspace clears it. `commit` always empties the buffer, so   │
│ +2275       // simulate a retained result alongside a live draft.            │
│ 2275        app.insert("0");                                                 │
│ -2276       app.commit();                                                    │
│ -2277       assert_eq!(app.committed_result(), Some("10"));                  │
│ +2277       app.committed_result = Some("10".to_string());                   │
│ 2278        app.backspace();                                                 │
│ 2279        assert_eq!(app.committed_result(), None);                       │
│ 2280                                                                         │
│ 2281        // `clear()` clears it.                                          │
│       ...                                                                    │
│ [rust-guardian] cargo check --all-targets: 0 errors ✓ (0.4s)                  │
│                                                                              │
│ ──────────────────────────────────────────────────────────────────────────── │
│ example prompt here█                                                         │
│ ──────────────────────────────────────────────────────────────────────────── │
│ ~/Code/rust/tui-calculator (master)  •  rust-guardian: ready (1 .rs tracked) │
│ ↑15k ↓11k R332k CH99.8% 21.2%/131k (auto)  Qwen3.8-27B • medium             │
╰──────────────────────────────────────────────────────────────────────────────╯
```

* **Inline Top-Line Status**: Status (`rust-guardian: ready (1 .rs tracked)`) is merged directly into **Line 1 (the top line)** of the Pi footer alongside the active directory and branch, avoiding an extra 3rd line.
* **Inline `edit` Compiler Feedback**: When `cargo check` runs, diagnostics and `rustc` borrow-checker diagrams are attached directly beneath the diff.
* **`/rust-guardian` Slash Command**: Show tracked `.rs` files, SHA-256 digests, `[FULL]` vs `[PARTIAL]` coverage, and check status.

---

## The Problem vs. The Fix

| The Classic Agent Failure Mode | How `pi-rust-guardian` Fixes It |
| :--- | :--- |
| **Silent File Truncation**<br>The agent reads lines 1–80 of a 600-line file (or hits output truncation), then calls `write()`—silently wiping out lines 81–600. | **Content-Addressed Read-Guard**<br>Tracks SHA-256 digests and `full` vs `partial` read coverage. Targeted `edit` is allowed, but whole-file `write` is blocked until the complete file is read. |
| **3-Turn Compiler Lag**<br>Fixing a compile error takes 3 full turns:<br>$$\texttt{edit} \to \texttt{bash("cargo check")} \to \texttt{edit (fix)}$$ | **1-Turn Compiler Loop**<br>Coalesces parallel edits and runs `cargo check --all-targets` in `tool_result`. Multi-line `rustc` borrow-checker diagrams and `help: consider &` hints return on Turn 1. |
| **Prompt Bloat & KV-Cache Rewinds**<br>LSP extensions register 8–13 new tools, adding 3,500–4,100 tokens to Turn 1 and evicting prompt caches when tools toggle. | **0 Tools, 0 Tokens, Append-Only**<br>Pi's 4 core tools stay untouched. State is stored out-of-context in session DAG entries; inference prompt caches (`vLLM`, `llama.cpp`) stay intact. |
| **Formatting Desync**<br>Running `rustfmt` mid-turn shifts line numbers for subsequent edits; running it out-of-band triggers stale line errors next turn. | **Deferred `agent_end` Formatting**<br>Runs `rustfmt` after the turn finishes, tracks child `mod` files, updates SHA-256 hash chains, and supplies re-read recovery hints if lines wrapped. |

---

## Design Philosophy

### 1. Hooks Over Tools (`4 active tools` stays `4 active tools`)
Coding models are heavily post-trained on `pi`’s four core primitives (`read`, `write`, `edit`, `bash`). Extensions that register 8–13 custom discovery or diagnostic tools (`symbol_search`, `module_report`, `lsp_diagnostics`) add thousands of tokens to the Turn-1 prompt and dilute tool selection—especially for smaller or locally hosted models that were fine-tuned on the standard 4-tool action space. `pi-rust-guardian` leaves the tool registry untouched and attaches guardrails directly to `read`, `write`, and `edit`.

### 2. Strict KV-Cache Prefix Integrity
Local inference servers (`llama-server`, `SGLang`, `vLLM`) and cloud prompt caches rely on exact token-prefix matching:
* Extensions that inject ephemeral diagnostic messages via the `context` event cause tail cache rewinds when those messages are dropped or mutated on subsequent turns.
* Extensions that dynamically activate "lazy tools" mid-session mutate the `"tools"` array at the top of the system prompt, invalidating the entire KV cache.

`pi-rust-guardian` never hooks `context` and never mutates the active tool list. Compiler diagnostics are appended permanently to the `edit` or `write` `tool_result` that triggered them, and internal state is stored out-of-context in `toolResult.details` and custom session DAG entries.

### 3. `rustc` (`--all-targets`) Over 1-Line LSP Diagnostics
Language server (`rust-analyzer`) diagnostics are optimized for IDE squiggles and often condense errors into single-line summaries (`E0308: mismatched types`). For an LLM fixing Rust code, the most valuable signal is `rustc`’s full multi-line span output—specifically **borrow-checker lifetime diagrams and compiler-generated `help: consider borrowing here: &value` fix suggestions**. `pi-rust-guardian` invokes `cargo check --all-targets --message-format=json` to surface rich `rustc` error spans while stripping out warning noise.

---

## Architecture & How It Improves Agent Performance

### 1. Two-Tier Content-Addressed Read-Guard (`readSnapshots` + `full` Coverage)
A naive Read-Guard only tracks a `Set<string>` of file paths the agent has touched. `pi-rust-guardian` tracks SHA-256 content digests alongside a boolean `full` coverage flag (`SnapshotEntry { hash, full, formattedSinceRead }`):

* **Blocks Blind Hallucinated Edits**: If the agent attempts to `edit` or `write` an existing `.rs` file it has not read in the current session, the call is blocked in `tool_call` before disk I/O occurs.
* **Catches Out-of-Band File Drift**: On every `edit` or `write`, the file’s current SHA-256 hash on disk is compared against the recorded snapshot. If the file was modified outside `read`/`edit`/`write` (for example via `sed` or `cargo fix` in `bash`, or by the user in an external editor), the hash mismatch is caught and the agent is forced to re-read the file before patching stale lines.
* **Prevents Partial-Read File Truncation**: When a `.rs` file is read with `offset`/`limit` or truncated (`details.truncation.truncated === true`), `pi-rust-guardian` records `full: false`. When `full === false`, **targeted `edit` calls are allowed**, but **full-file `write` overwrites are blocked** until the agent reads the complete file.

### 2. Compaction-Aware Context Synchronization (`syncFromBranch`)
When a long session hits the context limit and `pi` compacts the history, early turns are replaced by a lossy summary while recent turns starting from `compactionEntry.firstKeptEntryId` remain verbatim in context.
* On `session_start`, `session_tree`, and `session_compact`, `pi-rust-guardian` locates the latest compaction boundary (`firstKeptEntryId`).
* It scans `assistant` tool-call metadata across the branch, but **only credits `toolResult` snapshots inside the active post-compaction window**.
* **Automatic Coverage Downgrading**: If the agent performed a full `read` of `src/lib.rs` on Turn 3 (now compacted out of context) and a small `edit` on Turn 30 (still in the active window), `src/lib.rs` is downgraded from `full: true` to `full: false`. The agent can continue making surgical `edit` calls around the code it recently touched without being forced into an unnecessary re-read, but it is blocked from overwriting the entire file with `write` from compacted memory.

### 3. Coalesced, Per-Crate Serialized Compiler Feedback
Without a post-edit hook, fixing a compile error takes three turns:
$$\text{Turn 1: } \texttt{edit} \longrightarrow \text{Turn 2: } \texttt{bash("cargo check")} \longrightarrow \text{Turn 3: } \texttt{edit (fix)}$$
By running `cargo check --all-targets` inside `tool_result`, diagnostics are returned in the **same turn** as the `edit` or `write`.

* **25ms Parallel Batch Coalescing**: In `pi`, when an agent updates a struct definition and its callers across 3 `.rs` files in a single turn (`edit("a.rs")`, `edit("b.rs")`, `edit("c.rs")`), those edits execute in parallel. Without coalescing, `a.rs` would trigger `cargo check` before `b.rs` and `c.rs` finish writing to disk—reporting false errors on an intermediate state and spawning 3 concurrent `cargo` processes that contend on `target/.cargo-lock`.
* `pi-rust-guardian` increments a per-Cargo-root sequence counter (`mutationSeqByRoot`), waits `25ms` (`BATCH_SETTLE_MS`) for sibling writes in the same turn to land on disk, and verifies the sequence counter both before and inside a promise mutex (`enqueueCargoTask`). Earlier edits in the batch step aside cleanly, and `cargo check` runs **once** on the final edit of the batch.
* **Unit & Integration Test Verification (`--all-targets`)**: Plain `cargo check` skips `#[cfg(test)]` modules, allowing agents to write broken unit tests without noticing. Passing `--all-targets` compiles `lib`, `bin`, examples, benches, and `#[cfg(test)]` tests together.

### 4. High-Signal, Warning-Free `rustc` Error Extraction
During an active multi-file refactor, a Rust crate often emits dozens of `unused_import` or `dead_code` warnings before printing the actual compile error at the bottom of `stderr`.
* `extractCargoErrors` parses `cargo check --message-format=json` NDJSON output and extracts `message.rendered` **strictly where `message.level === "error"`**.
* All compiler warnings are discarded so they never distract the model mid-refactor or push real errors past the 3,000-character / 6-error truncation cap.
* Spanless `rustc` summary messages (`"aborting due to N previous errors"`, `"For more information about this error..."`) and Cargo boilerplate stderr lines are stripped, while substantive non-JSON failures (such as `build.rs` panics, linker errors, or broken `Cargo.toml` manifests) are preserved from `stderr`.

### 5. Deferred `rustfmt` With Recursive Child-Module & Hash-Chain Tracking
Code formatting creates a classic conflict for coding agents: running `rustfmt` mid-turn shifts line numbers and breaks subsequent `edit` calls in the same turn, while running `rustfmt` at the end of a turn alters file bytes behind the model's back.

`pi-rust-guardian` resolves this in its `agent_end` pipeline:
1. **End-of-Turn Execution**: `rustfmt` only runs at `agent_end` after all tool calls in the turn have completed.
2. **Edition Detection**: `detectRustEdition` inspects the crate’s `Cargo.toml` (walking up to the workspace root `Cargo.toml` if `edition.workspace = true` is used, and respecting Cargo’s `"2015"` default when `[package]` omits `edition`).
3. **Recursive Child `mod` Awareness**: Running `rustfmt src/lib.rs` automatically parses `mod foo;` declarations and formats `src/foo.rs` on disk. Before running `rustfmt`, `pi-rust-guardian` verifies all tracked snapshots (`validPreFmtSnapshots`), skips formatting any crate where a sibling file was modified out-of-band (`dirtiedCrateRoots`), and then advances `preHash -> postHash` across **every** tracked file whose bytes changed during formatting.
4. **Line-Wrap Recovery Hint**: Advancing the snapshot to `postHash` allows the agent to edit untouched functions in the next turn without a Read-Guard block. However, if `rustfmt` wrapped a long single line into multiple lines and the agent later fails an `edit` (`event.isError`) trying to match the old unformatted line, `tool_result` detects `formattedSinceRead` and appends a recovery hint explaining that `rustfmt` reformatted the file and instructing the agent to `read` the target section.

### 6. Out-of-Context Session DAG & Symlink-Safe Persistence
* **Zero-Token DAG State**: Snapshot metadata (`{ hash, full }`) is saved inside `toolResult.details.rustGuardian`, and `rustfmt` hash transitions (`preHash -> postHash`) are appended via `pi.appendEntry("rust-guardian:fmt", ...)`. Because `pi`’s `convertToLlm()` strips `details` and `custom` entries when projecting messages for the LLM, full state survives `/tree` branch switches, `/fork`, `/resume`, and process restarts at **0 token cost**.
* **Hot `/reload` State**: Runtime maps are stored on `globalThis[Symbol.for("pi.rust-guardian.runtime-state")]` with schema migration, so running `/reload` preserves active snapshots.
* **Symlink-Safe Path Canonicalization**: `canonicalizePath` walks up to the nearest existing ancestor directory and resolves `realpathSync.native` before re-attaching non-existent child segments, ensuring pre-creation `write` paths and post-creation `edit` paths resolve to identical keys inside symlinked directories or worktrees.

---

## Comparison With Other Extensions

| Feature | `pi-rust-guardian` | `pi-lens` | `@piex-dev/lsp` | `@narumitw/pi-lsp` |
| :--- | :--- | :--- | :--- | :--- |
| **Extra LLM Tools Registered** | **0** | **13** (8 active on Turn 1) | **1** (`lsp`) | **2** (`lsp_diagnostics`, `lsp_fix`) |
| **Extra Skills Registered** | **0** | **4** | **0** | **0** |
| **Turn-1 Prompt Token Overhead** | **0 tokens** | **~3,500–4,100 tokens** | **~300 tokens** | **~400 tokens** |
| **Append-Only KV Cache by Default** | **Yes** | Requires `--lens-retain-injections` + `--no-lazy-tools` | **Yes** | **Yes** |
| **Diagnostic Backend** | `cargo check --all-targets` (`rustc` `help:` spans + unit tests) | `rust-analyzer` + `clippy` + `tree-sitter` | `rust-analyzer` LSP | `rust-analyzer` LSP |
| **Compiler Warnings Filtered Out** | **Yes** (errors only) | Configurable | **Yes** | **No** |
| **SHA-256 Read & Partial-Write Guard** | **Yes** (compaction & `/tree` aware) | **Yes** | **No** | **No** |
| **Deferred `rustfmt` + Hash Chains** | **Yes** (tracks child `mod` files) | **Yes** (emits re-read nudge next turn) | **No** | **No** |

---

## When to Use (and When Not to Use)

**Good fit for:**
* **Rust-focused workflows in `pi`** where you want compiler-in-the-loop verification (`rustc` error spans, borrow-checker `help:` hints, and `--all-targets` test checking), automatic `rustfmt`, and Read-Guard protection with zero tool bloat.
* **Local inference setups (`llama.cpp`, `SGLang`, `vLLM`)** where minimizing Turn-1 prefill tokens and avoiding mid-session KV-cache invalidations directly improves response latency.
* **Models tuned for `pi`’s 4 core tools** (as well as frontier models like Claude Opus, GPT/Codex, DeepSeek, and Qwen) that already navigate codebases effectively using `rg` in `bash` + `read`/`edit`.

**Not a fit for:**
* **Polyglot repositories**: `pi-rust-guardian` only intercepts `.rs` files and Cargo workspaces. For multi-language repositories (TypeScript, Python, Go, etc.), use `pi-lens` or `@piex-dev/lsp`.
* **Agent-driven LSP/AST navigation**: If you want the model to explicitly invoke tools like `ast_grep_search` or `lsp_navigation` (go-to-definition / find-references), this extension intentionally does not register any tools.
* **Uncached monoliths with >60s incremental checks**: Because `cargo check --all-targets` runs after `.rs` edits settle, it works best on crates and workspaces where incremental checks complete in a few seconds.

---

## Installation & Configuration

```bash
# Install from npm
pi install npm:pi-rust-guardian

# Or install from GitHub
pi install git:github.com/saldmy/pi-rust-guardian

# Or test for a single session without saving
pi -e npm:pi-rust-guardian
```

### Environment Variables
* **`PI_RUST_GUARDIAN_CARGO_TIMEOUT_MS`** — Timeout in milliseconds for `cargo check --all-targets` (default: `60000`):
  ```bash
  PI_RUST_GUARDIAN_CARGO_TIMEOUT_MS=120000 pi
  ```

### Slash Commands
* **`/rust-guardian`** — Show tracked `.rs` files, short SHA-256 hashes, `[FULL]` / `[PARTIAL]` read coverage, and the latest `cargo check` summary.

---

## Development & Testing

```bash
# Clone the repository
git clone https://github.com/saldmy/pi-rust-guardian.git
cd pi-rust-guardian

# Install dependencies
npm install

# Run type checking
npm run typecheck

# Run unit tests
npm test
```

---

## License

[MIT](LICENSE) © 2026 Dmytro Salo
