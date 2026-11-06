# Comprehensive Review & Publication Strategy: `pi-rust-guardian`

**Target Extension:** `pi-rust-guardian` (v1.0.0)  
**Host Harness:** Pi Coding Agent (`@earendil-works/pi-coding-agent` v1.5.0)  
**Date:** November 2026  
**Status:** Pre-Release Audit & Launch Strategy

---

## 1. Executive Summary & Verdict

`pi-rust-guardian` is an exceptionally well-engineered extension. In an ecosystem where most coding agent extensions aggressively register new tools (adding 3,000–5,000 prompt tokens and disrupting KV caches on local models), `pi-rust-guardian` adheres to a purist, high-performance architecture:
* **0 tools, 0 skills, 0 prompt tokens** on Turn 1.
* **Strict KV-cache prefix integrity** (never touches the top-of-prompt tool registry, never causes mid-session prompt rewinds).
* **Content-addressed Read-Guard** with SHA-256 snapshots and partial-read truncation defense.
* **Coalesced sub-second compiler checks** via `cargo check --all-targets` delivering multi-line `rustc` borrow-checker diagnostic spans directly into `tool_result`.
* **Out-of-context DAG persistence** surviving `/compact`, `/tree` branch switches, and `/fork`.

**Readiness Verdict:**  
The **core TypeScript implementation is 95% publication-ready**. However, the repository lacks the standard release-engineering scaffolding (missing `LICENSE` file, `.gitignore`, `tsconfig.json`, `package.json` repository metadata, and CI workflows) and the README is missing visual demonstrations and a high-converting opening hook.

With the specific refinements detailed in this review, this package has all the ingredients to become a **flagship community extension** in both the **Pi Coding Agent ecosystem** and the **LocalLLaMA / open-weights coding community**.

---

## 2. Name & Brand Analysis

### The Question: Is `pi-rust-guardian` good? Does it reflect what the extension actually does?

### Strengths of the Name
1. **Ecosystem Convention Alignment:**
   In the Pi ecosystem, prefixing with `pi-` (`pi-lens`, `pi-approval-guardian`, `pi-marketplace`, `pi-llama-cpp`) is the gold standard for npm discoverability and package management (`pi install npm:pi-rust-guardian`).
2. **Authority and Protection:**
   The term `"guardian"` conveys safety, reliability, and defense. It mirrors established packages like `pi-approval-guardian` and `guardian-framework`.
3. **Direct Match for the Core Mechanism:**
   The primary mechanism in the code is literally named **Read-Guard**:
   * Blocking blind edits on existing `.rs` files.
   * Detecting out-of-band file drift.
   * Blocking full-file `write` overwrites after partial reads (`offset`/`limit` or truncation).

### Potential Ambiguities & Trade-Offs
* **The "Defender Only" Perception:**  
  A developer seeing `"guardian"` might initially assume this is *only* a permission/safety firewall (like an approval prompt blocking `rm -rf` or gating bash commands).
* **The Hidden Half of the Value Proposition:**  
  The extension does two other massive things:
  1. **Instant Compiler Feedback Loop:** Running `cargo check --all-targets` and parsing `rustc` borrow-checker spans inline.
  2. **Automated Formatting:** Running `rustfmt` at `agent_end` with hash-chain propagation and recursive child-module tracking.

### Name Evaluation & Alternatives

| Candidate Name | Pros | Cons | Verdict |
| :--- | :--- | :--- | :--- |
| **`pi-rust-guardian`** *(Current)* | Authoritative, memorable, matches `Read-Guard`, aligns with `pi-approval-guardian`. | Might sound purely defensive until tagline is read. | **Keep as Primary (Recommended)** |
| `pi-rust-pilot` | Sounds like an active assistant. | Suggests autonomous agent loop / subagent, which it intentionally is not. | Not recommended |
| `pi-cargo-guard` | Specifically highlights Cargo compiler checks. | Misses `rustfmt` and general Rust file protection; narrower scope. | Not recommended |
| `pi-rust` | Short and clean. | High collision risk with Pi agent ports rewritten in Rust (`pi-rust`); causes user confusion. | Avoid |
| `pi-rust-sentinel` | Sounds vigilant and low-overhead. | Less common term than guardian; doesn't offer meaningful advantage. | Alternative |

### Naming Recommendation
**Keep `pi-rust-guardian`.** It has strong brand weight and natural authority.  
To resolve the "defender-only" ambiguity, pair it with a laser-focused, high-impact tagline across npm, GitHub, and social media:

> **"Zero-tool, zero-prompt-tax Rust compiler feedback and Read-Guard for the Pi coding agent."**

---

## 3. Ecosystem & Collision Analysis (Internet Research)

A real-time search of the npm registry, GitHub, and crates.io reveals the following landscape:

### 1. Registry Collision Check
* **npm Registry:**
  * `pi-rust-guardian`: **AVAILABLE / UNCLAIMED** (Confirmed). You can register and publish this exact package name immediately.
  * Closely related packages:
    * `guardian-framework` (Pi architectural enforcement).
    * `pi-approval-guardian` (Pi fail-closed approval gate).
  * *Takeaway:* No collision on npm. The name is completely clear and aligns with an established category of Pi packages.
* **crates.io:**
  * `rust-guardian` exists as an unrelated Rust crate (`cargo install rust-guardian`) for static code quality analysis and placeholder/TODO scanning.
  * *Takeaway:* Because your extension is an npm/Pi package (`pi-rust-guardian`), there is no technical clash. However, in your README, explicitly state that installation is via `pi install npm:pi-rust-guardian` (not `cargo install`) to prevent developer confusion.
* **GitHub:**
  * Repositories like `yannelli/pi-rust` and `Dicklesworthstone/pi_agent_rust` are **complete rewrites of the Pi CLI in Rust**, not extensions for the TypeScript Pi agent.
  * No existing extension repository uses `pi-rust-guardian`.

### 2. Competitive Positioning Matrix in the Pi Ecosystem

| Feature | `pi-rust-guardian` | `pi-lens` | `@piex-dev/lsp` | `@narumitw/pi-lsp` |
| :--- | :--- | :--- | :--- | :--- |
| **Architecture** | **Lifecycle Hooks only** | Hybrid (Hooks + Tools) | Explicit Tool Call | Explicit Tool Call |
| **Extra Tools Added** | **0 tools** (`read`, `write`, `edit`, `bash` untouched) | **13 tools** (8 active Turn 1) | **1 tool** (`lsp`) | **2 tools** (`lsp_diagnostics`, `lsp_fix`) |
| **Extra Skills Added** | **0** | **4** | **0** | **0** |
| **Prompt Token Overhead** | **0 tokens** | **~3,500–4,100 tokens** | **~300 tokens** | **~400 tokens** |
| **KV-Cache Impact** | **Append-only (Zero Cache Rewind)** | Invalidates cache on tool toggle | Safe append-only | Safe append-only |
| **Diagnostic Engine** | `cargo check --all-targets` (native `rustc` JSON) | `rust-analyzer` + `tree-sitter` + `clippy` | `rust-analyzer` LSP | `rust-analyzer` LSP |
| **Rich Lifetime Spans & `help:` Suggestions** | **Full compiler spans** | Compact single-line linter messages | 1-line LSP diagnostics | 1-line LSP diagnostics |
| **Blind Edit & Truncation Guard** | **Yes (SHA-256 + full/partial)** | Yes | No | No |
| **Automated `rustfmt`** | **Yes (deferred to `agent_end` with hash chain)** | Yes | No | No |
| **Best Suited For** | **Fast Rust crates, local LLMs (`llama.cpp`, `vLLM`), frontier models** | Polyglot multi-repo inspection | Multi-language LSP queries | Targeted LSP queries |

**Your Killer Differentiator:**  
`pi-lens` and `@piex-dev/lsp` try to be universal multi-language powerhouses, but they burden the model with new tool schemas and thousands of prompt tokens. For models fine-tuned specifically on the 4 canonical Pi tools (such as Qwen 2.5 Coder, DeepSeek Coder, or local quantized weights), **adding 10 new tools degrades tool selection accuracy**. `pi-rust-guardian` is the **only** extension that supercharges Rust development without changing the model's 4-tool action space.

---

## 4. In-Depth Code Review: `extensions/rust-guardian.ts`

### Architectural Highlights (What was done exceptionally well)
1. **Compaction-Aware Snapshot Sync (`syncFromBranch`):**  
   Locating `compactionEntry.firstKeptEntryId` and only crediting `toolResult` snapshots inside the active uncompacted window is brilliant. It ensures that if a model previously read a file 40 turns ago (now summarized away), it cannot blindly overwrite it with stale memory.
2. **25ms Batch Coalescing (`mutationSeqByRoot`):**  
   When an LLM edits `models.rs`, `handlers.rs`, and `main.rs` concurrently in a single turn, firing 3 simultaneous `cargo check` runs would trigger lock contention on `target/.cargo-lock`. The 25ms timer + sequence check ensures `cargo check` executes exactly **once** after the batch settles.
3. **Warning Stripping via JSON Parsing:**  
   Extracting `message.rendered` where `message.level === "error"` prevents compiler warnings (`unused_imports`, `dead_code`) from filling up the LLM's context window during refactorings.
4. **Deferred `rustfmt` + DAG Hash Tracking:**  
   Postponing `rustfmt` until `agent_end` prevents line numbers from shifting between parallel edits in the same turn. Emitting `rust-guardian:fmt` custom entries ensures branch switches (`/tree`) and restarts don't invalidate hashes.

### Code Improvements & Edge Cases to Fix

#### 1. Rust Edition Default in `detectRustEdition`
* **Current Behavior:** Defaults to `"2024"`.
* **Issue:** Rust edition 2024 was stabilized in Rust 1.85.0 (February 2025). If a developer uses a slightly older stable Rust toolchain (e.g. 1.80–1.84), running `rustfmt --edition 2024` will fail with an error:
  `error: edition 2024 is unstable and only available with -Zunstable-options`.
* **Recommendation:** If no edition is detected in `Cargo.toml`, default to `"2021"` rather than `"2024"`. Edition 2021 is compatible with all modern Rust installations (1.56+) and matches the vast majority of crates in the wild.

#### 2. Graceful `ENOENT` Handling when `cargo` or `rustfmt` is Missing
* **Current Behavior:** If `cargo` is not installed or not in `$PATH` (e.g., when launched from an environment where `~/.cargo/bin` is not sourced), `execFileAsync("cargo", ...)` throws `ENOENT`. This is passed into `formatErrorReport`, outputting:
  `[cargo check --all-targets: 1 error(s) — fix before finishing]: spawn cargo ENOENT`
* **Recommendation:** Catch `err.code === "ENOENT"` explicitly and emit an informative notification:
  `[rust-guardian] 'cargo' executable not found in PATH. Ensure Cargo is installed and available.`
  Rather than failing the agent's edit turn as a compile error.

#### 3. TUI Line Truncation Guard
* **Current Behavior:** In `installPathLineFooterPatch()`, Line 116 checks `if (available > 10)`. This is safe and prevents negative slice offsets.
* **Enhancement:** Ensure that if `FooterComponent` is not exported (e.g. if Pi is running in headless `--mode json` or `--mode rpc`), the patch exits early without warnings. The current code has `if (!proto || typeof proto.render !== "function") return;`, which is already safe.

---

## 5. README.md Review & Audit

### What is Already Great
* The "Design Philosophy" section (Hooks Over Tools, KV-Cache Integrity, `rustc` multi-line spans) is persuasive and technically accurate.
* The comparison table with `pi-lens` and `@piex-dev/lsp` establishes clear differentiation.
* The "When to Use / When Not to Use" section is honest and builds trust with senior developers.

### Critical Deficiencies in Current README

1. **Missing Visual Demonstration (The #1 reason GitHub projects get skipped):**
   * Developers decide whether to star/install a CLI tool within **10 seconds** of opening the repository.
   * Currently, the README is dense technical text. There is **no terminal GIF, SVG, or ASCII diagram** showing:
     - The inline `[rust-guardian] cargo check ok (0.4s)` footer.
     - The red compiler error span with borrow-checker hints rendered inside the `edit` box.
     - The Read-Guard blocking an unread write.
2. **Unresolved Placeholder in Installation Instructions:**
   * Line 120 currently reads:
     ```bash
     pi install git:github.com/<your-username>/pi-rust-guardian
     ```
   * Having `<your-username>` in a published README breaks copy-paste installation for users.
3. **No Badges:**
   * Lacks npm version, license, node version, and Pi package badges.
4. **Missing "Problem vs. Solution" Quickstart Hook:**
   * The README immediately dives into architectural philosophy on Line 9.
   * It needs a punchy 3-bullet "The Problem / The Fix" section at the top:
     * *Problem:* Agent hallucinates edits on files it hasn't read, or deletes 400 lines using `write` after a partial read.
     * *Problem:* Fixing a Rust compile error takes 3 turns (`edit` $\to$ `cargo check` $\to$ `edit fix`).
     * *Solution:* `pi-rust-guardian` intercepts edits, provides instant compiler feedback in Turn 1, and prevents destructive writes.
5. **Missing Troubleshooting & FAQ:**
   * "What if my crate takes 60s to check?" (Document `PI_RUST_GUARDIAN_CARGO_TIMEOUT_MS`).
   * "Does it work in Cargo workspaces?" (Yes, searches up for `Cargo.toml`).
   * "Can I exclude certain directories?"

---

## 6. Repository & Release Checklist: What Else Is Missing?

To open-source this on GitHub and publish to npm, the following repository files must be created or updated:

### 1. `LICENSE` File (CRITICAL)
* **Status:** **MISSING ON DISK**.
* `package.json` specifies `"license": "MIT"` and includes `"LICENSE"` in the `"files"` array, but no `LICENSE` file exists in the directory. `npm publish` will issue a warning or fail packaging.
* **Action:** Add the standard MIT License file.

### 2. `.gitignore` & Repository Cleanliness (CRITICAL)
* **Status:** **MISSING ON DISK**.
* A `.DS_Store` file (8,196 bytes) is currently sitting in the repository root.
* **Action:** Remove `.DS_Store` and create a `.gitignore` covering:
  ```gitignore
  node_modules/
  dist/
  .DS_Store
  *.log
  .pi/
  ```

### 3. `tsconfig.json` (DEVELOPER EXPERIENCE)
* **Status:** **MISSING ON DISK**.
* Anyone cloning the repository to contribute or inspect code will see missing type definitions and IDE warnings.
* **Action:** Add a clean `tsconfig.json` targeting NodeNext / ES2022.

### 4. `package.json` Metadata
* **Status:** Incomplete.
* Missing fields:
  * `"repository"`: `{ "type": "git", "url": "https://github.com/<username>/pi-rust-guardian.git" }`
  * `"author"`: Your name / handle
  * `"bugs"`: `{ "url": "https://github.com/<username>/pi-rust-guardian/issues" }`
  * `"homepage"`: `https://github.com/<username>/pi-rust-guardian#readme`
  * `"scripts"`:
    * `"typecheck": "tsc --noEmit"`
    * `"test": "vitest run"`
    * `"prepublishOnly": "npm run typecheck"`

### 5. Automated CI/CD (GitHub Actions)
* Add `.github/workflows/ci.yml`:
  * Runs on `push` and `pull_request`.
  * Installs Node.js 22 & 24 and runs `npm run typecheck` and tests.
* Add `.github/workflows/release.yml`:
  * Automated npm publish with GitHub provenance when a git tag `v*` is pushed.

### 6. Unit Tests (`tests/rust-guardian.test.ts`)
* Write unit tests for pure helper functions:
  * `extractCargoErrors`: Verify JSON compiler error extraction and warning stripping.
  * `detectRustEdition`: Verify parsing of 2015, 2021, and workspace inheritance.
  * `formatErrorReport`: Verify truncation cap (3000 chars, max 6 errors).
  * `matchesFormattedHash`: Verify hash chain traversal.

---

## 7. Community Launch & Popularity Playbook

To make this extension widely noticed and recognized, follow this step-by-step launch strategy across the three target communities:

```
┌─────────────────────────────────────────────────────────────────┐
│                     LAUNCH MULTIPLIER FUNNEL                    │
├─────────────────┬───────────────────────────┬───────────────────┤
│ Target Audience │ Value Angle               │ Distribution Hub │
├─────────────────┼───────────────────────────┼───────────────────┤
│ Pi Community    │ Zero-tool, 0-prompt-tax   │ awesome-pi, Pi    │
│                 │ Rust powerhouse           │ Discord/Matrix    │
├─────────────────┼───────────────────────────┼───────────────────┤
│ LocalLLaMA /    │ Append-only KV-cache,     │ Reddit /r/Local-  │
│ Open Weights    │ sub-second feedback for   │ LLaMA, X/Twitter  │
│                 │ Qwen/DeepSeek             │                   │
├─────────────────┼───────────────────────────┼───────────────────┤
│ Rust Community  │ Compiler-in-the-loop,     │ Reddit /r/rust,   │
│                 │ borrow-checker diagrams   │ This Week in Rust │
└─────────────────┴───────────────────────────┴───────────────────┘
```

### Phase 1: Pi Ecosystem Integration (Immediate)
1. **Publish to npm:**
   ```bash
   npm publish --access public
   ```
   Users can immediately test with:
   ```bash
   pi -e npm:pi-rust-guardian
   ```
2. **Submit PR to `awesome-pi`:**
   * Open a PR adding `pi-rust-guardian` under **Extensions > Language Support / Development Tools**.
   * Highlight: *"Zero-tool, zero-prompt-tax Rust guardrails with inline cargo check and rustfmt."*
3. **Post in Pi Discord / GitHub Discussions:**
   * Share in the official `#extensions` channel.
   * Frame it as a technical case study: *"Why we built a Rust extension with 0 tools instead of registering 10 LSP tools (and how it preserves KV-cache on local models)."* Mario Zechner and the Pi core contributors appreciate architectural purity.

### Phase 2: LocalLLaMA & AI Coding Community (High Viral Potential)
1. **Reddit `/r/LocalLLaMA` Post:**
   * Title suggestion:  
     *`We solved Rust coding on local models (Qwen 2.5 / DeepSeek) in Pi: 0 prompt tokens, no KV-cache thrashing, and inline rustc borrow-checker spans`*
   * Content structure:
     * Show why traditional extensions fail local models (3,500 token prompt bloat + tools confusion).
     * Show the 25ms batch coalescing and inline `cargo check` feedback.
     * Include an asciinema / GIF demonstration.
2. **X / Twitter Tech Thread:**
   * Tag Mario Zechner (`@badlogicgames`) and Pi community builders.
   * Include a 30-second video of an agent writing Rust code, encountering a borrow checker error, and fixing it in Turn 1 thanks to the inline `help:` hint.

### Phase 3: Rust Community (This Week in Rust & `/r/rust`)
1. **Submit to "This Week in Rust" (Crate/Tool of the Week):**
   * Submit via GitHub PR to `rust-lang/this-week-in-rust`.
2. **Reddit `/r/rust` Post:**
   * Emphasize the Rust-specific engineering: how `rustc --message-format=json` parses multi-line borrow diagrams, `--all-targets` integration, and child `mod` tracking during `rustfmt`.

---

## 8. Summary Checklist Before Publishing

- [ ] **1. Set Edition Fallback:** In `detectRustEdition()`, default fallback to `"2021"` instead of `"2024"`.
- [ ] **2. Add LICENSE File:** Place the MIT license in the root directory.
- [ ] **3. Add .gitignore:** Remove `.DS_Store` and ignore `node_modules/`, `dist/`, `.DS_Store`.
- [ ] **4. Add tsconfig.json:** Configure clean TypeScript resolution for contributors.
- [ ] **5. Update package.json:** Add `repository`, `author`, `bugs`, `homepage`, and `scripts` (`typecheck`, `test`).
- [ ] **6. Polish README.md:** Replace `<your-username>`, add badging, terminal demo ASCII/GIF, and problem-solution summary.
- [ ] **7. Publish to npm:** Run `npm publish --access public`.
- [ ] **8. Submit to `awesome-pi`:** Open PR to official community list.
