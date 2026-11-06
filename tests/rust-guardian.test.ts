import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import rustGuardian, { _testing } from "../extensions/rust-guardian.ts";

const {
  detectRustEdition,
  parseSectionEdition,
  extractCargoErrors,
  formatErrorReport,
  matchesFormattedHash,
  recordFormattedHash,
  isBoilerplateCargoStderrLine,
  isCargoWarningLine,
  isFullFileRead,
  shouldHintReformat,
  getRuntimeState,
  getSessionState,
  normalizePath,
} = _testing;

describe("detectRustEdition", () => {
  it("defaults to '2021' when cargoRoot is null", () => {
    assert.equal(detectRustEdition(null), "2021");
  });

  it("detects explicit edition from Cargo.toml", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rg-test-"));
    try {
      writeFileSync(
        join(tempDir, "Cargo.toml"),
        '[package]\nname = "foo"\nversion = "0.1.0"\nedition = "2024"\n'
      );
      assert.equal(detectRustEdition(tempDir), "2024");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults to '2015' when [package] is present without edition", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rg-test-"));
    try {
      writeFileSync(
        join(tempDir, "Cargo.toml"),
        '[package]\nname = "old-crate"\nversion = "0.1.0"\n'
      );
      assert.equal(detectRustEdition(tempDir), "2015");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves workspace edition inheritance", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "rg-ws-"));
    const memberDir = join(rootDir, "crates", "member");
    try {
      mkdirSync(memberDir, { recursive: true });
      writeFileSync(
        join(rootDir, "Cargo.toml"),
        '[workspace.package]\nedition = "2021"\n\n[workspace]\nmembers = ["crates/*"]\n'
      );
      writeFileSync(
        join(memberDir, "Cargo.toml"),
        '[package]\nname = "member"\nedition.workspace = true\n'
      );
      assert.equal(detectRustEdition(memberDir), "2021");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("extractCargoErrors", () => {
  it("extracts compiler errors from JSON and filters warnings", () => {
    const stdout = [
      JSON.stringify({
        reason: "compiler-message",
        message: {
          level: "warning",
          message: "unused variable: `x`",
          rendered: "warning: unused variable: `x`\n --> src/main.rs:2:9",
          spans: [{ file_name: "src/main.rs" }],
        },
      }),
      JSON.stringify({
        reason: "compiler-message",
        message: {
          level: "error",
          message: "mismatched types",
          rendered: "error[E0308]: mismatched types\n --> src/main.rs:5:12\n  |\n5 | let x: u32 = \"str\";",
          spans: [{ file_name: "src/main.rs" }],
        },
      }),
    ].join("\n");

    const errors = extractCargoErrors(stdout, "");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /error\[E0308\]: mismatched types/);
  });

  it("filters out spanless abort and help summary boilerplate", () => {
    const stdout = [
      JSON.stringify({
        reason: "compiler-message",
        message: {
          level: "error",
          message: "aborting due to 1 previous error",
          rendered: "error: aborting due to 1 previous error",
          spans: [],
        },
      }),
    ].join("\n");

    const errors = extractCargoErrors(stdout, "");
    assert.equal(errors.length, 0);
  });

  it("preserves non-boilerplate stderr lines when errors exist", () => {
    const stdout = JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "error",
        message: "cannot find value `foo`",
        rendered: "error[E0425]: cannot find value `foo` in this scope",
        spans: [{ file_name: "src/main.rs" }],
      },
    });

    const stderr = [
      "warning: build failed, waiting for other jobs to finish...",
      "error: could not compile `my-crate` due to 1 previous error",
      "error: failed to run custom build command for `native-sys`",
    ].join("\n");

    const errors = extractCargoErrors(stdout, stderr);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /cannot find value `foo`/);
    assert.match(errors[1], /failed to run custom build command/);
  });
});

describe("isBoilerplateCargoStderrLine", () => {
  it("identifies standard Cargo failure summary lines", () => {
    assert.equal(isBoilerplateCargoStderrLine("warning: build failed, waiting for other jobs to finish..."), true);
    assert.equal(isBoilerplateCargoStderrLine("error: could not compile `foo` due to 2 previous errors"), true);
    assert.equal(isBoilerplateCargoStderrLine("error: build failed"), true);
    assert.equal(isBoilerplateCargoStderrLine("To learn more, run the command again with --verbose."), true);
    assert.equal(isBoilerplateCargoStderrLine("   "), true);
    assert.equal(isBoilerplateCargoStderrLine("Caused by: syntax error in build.rs"), false);
  });
});

describe("formatErrorReport", () => {
  it("formats error list with check title", () => {
    const errors = ["error 1: bad syntax", "error 2: type mismatch"];
    const formatted = formatErrorReport(errors);
    assert.match(formatted, /cargo check --all-targets: 2 error\(s\)/);
    assert.match(formatted, /error 1: bad syntax/);
    assert.match(formatted, /error 2: type mismatch/);
  });

  it("omits excess errors beyond MAX_REPORTED_ERRORS", () => {
    const errors = Array.from({ length: 10 }, (_, i) => `error #${i + 1}`);
    const formatted = formatErrorReport(errors);
    assert.match(formatted, /4 more error\(s\) omitted/);
  });
});

describe("hash chaining and formatting recovery", () => {
  it("tracks sequential format steps and resolves transition chains", () => {
    const map = new Map<string, string>();
    recordFormattedHash(map, "hash_v1", "hash_v2");
    recordFormattedHash(map, "hash_v2", "hash_v3");

    assert.equal(matchesFormattedHash(map, "hash_v1", "hash_v2"), true);
    assert.equal(matchesFormattedHash(map, "hash_v1", "hash_v3"), true);
    assert.equal(matchesFormattedHash(map, "hash_v1", "hash_v4"), false);
  });

  it("handles cyclical transitions gracefully without infinite loops", () => {
    const map = new Map<string, string>();
    recordFormattedHash(map, "hash_a", "hash_b");
    recordFormattedHash(map, "hash_b", "hash_a");

    assert.equal(matchesFormattedHash(map, "hash_a", "hash_c"), false);
  });
});

describe("normalizePath", () => {
  it("cleans leading @ and resolves relative paths", () => {
    const cwd = tmpdir();
    const normalized = normalizePath(cwd, "@src/main.rs");
    assert.ok(normalized.endsWith("src/main.rs"));
  });
});

describe("pi-tui visibleWidth / truncateToWidth (CJK & emoji)", () => {
  it("measures wide CJK characters as double-width", () => {
    assert.equal(visibleWidth("日本語"), 6);
    assert.equal(visibleWidth("a日本b"), 6);
  });

  it("measures emojis as double-width columns", () => {
    const emojiStr = "a\u{1F680}b"; // a + rocket + b (4 code units, 4 columns)
    assert.equal(visibleWidth(emojiStr), 4);
    assert.ok(visibleWidth(emojiStr) > [...emojiStr].length); // > code points
  });

  it("truncates to width without exceeding the allotted width", () => {
    const truncated = truncateToWidth("hello 日本語 world", 10);
    assert.ok(visibleWidth(truncated) <= 10);
    const emojiTruncated = truncateToWidth("\u{1F680}\u{1F680}\u{1F680}abc", 5);
    assert.ok(visibleWidth(emojiTruncated) <= 5);
  });
});

describe("shouldHintReformat", () => {
  it("returns false when snap matches disk hash and formattedSinceRead is false, even if hash is a known formatted output", () => {
    const formattedHashes = new Map<string, string>([["h1", "h2"]]);
    const snapEntry = { hash: "h2", full: true, formattedSinceRead: false };
    assert.equal(shouldHintReformat(snapEntry, "h2", formattedHashes), false);
  });

  it("returns true when snap matches disk hash and formattedSinceRead is true", () => {
    const snapEntry = { hash: "h2", full: true, formattedSinceRead: true };
    assert.equal(
      shouldHintReformat(snapEntry, "h2", new Map()),
      true
    );
  });

  it("falls back to known-formatted-output check when snapEntry is missing or stale", () => {
    const formattedHashes = new Map<string, string>([["h1", "h2"]]);
    assert.equal(shouldHintReformat(undefined, "h2", formattedHashes), true);
    assert.equal(
      shouldHintReformat(
        { hash: "h0", full: true, formattedSinceRead: false },
        "h2",
        formattedHashes
      ),
      true
    );
    assert.equal(shouldHintReformat(undefined, "h9", formattedHashes), false);
  });
});

describe("isFullFileRead", () => {
  const makeFile = () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rg-full-read-"));
    const filePath = join(tempDir, "small.rs");
    writeFileSync(
      filePath,
      Array.from({ length: 20 }, (_, i) => `let x${i} = ${i};`).join("\n")
    );
    return filePath;
  };

  it("treats offset:1 with a limit covering the whole file as a full read", () => {
    const filePath = makeFile();
    assert.equal(isFullFileRead(filePath, 1, 100, false), true);
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it("treats a limit smaller than the file as partial", () => {
    const filePath = makeFile();
    assert.equal(isFullFileRead(filePath, undefined, 5, false), false);
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it("treats offset > 1 as partial", () => {
    const filePath = makeFile();
    assert.equal(isFullFileRead(filePath, 2, undefined, false), false);
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it("treats truncated reads as partial", () => {
    const filePath = makeFile();
    assert.equal(isFullFileRead(filePath, undefined, undefined, true), false);
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it("treats an unbounded, untruncated read as full", () => {
    const filePath = makeFile();
    assert.equal(isFullFileRead(filePath, undefined, undefined, false), true);
    rmSync(dirname(filePath), { recursive: true, force: true });
  });
});

describe("extractCargoErrors warning filtering", () => {
  it("excludes cargo stderr warning lines when compiler errors exist", () => {
    const stdout = JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "error",
        message: "mismatched types",
        rendered: "error[E0308]: mismatched types\n --> src/main.rs:5:12",
        spans: [{ file_name: "src/main.rs" }],
      },
    });

    const stderr = [
      "warning: profiles for the non root package will be ignored",
      "warning: unused manifest key: workspace.foo",
      "error: could not compile `my-crate` due to 1 previous error",
    ].join("\n");

    const errors = extractCargoErrors(stdout, stderr);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /mismatched types/);
    assert.ok(errors.every((e) => !isCargoWarningLine(e)));
  });

  it("returns only non-boilerplate panic lines when stdout has no errors", () => {
    const stderr = [
      "warning: build failed, waiting for other jobs to finish...",
      "thread 'main' panicked at build.rs:3:1: build script panicked",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    ].join("\n");

    const errors = extractCargoErrors("", stderr);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /panicked/);
    assert.ok(!errors[0].includes("build failed, waiting"));
  });
});

describe("detectRustEdition section-aware parsing", () => {
  it("parses edition even when array fields appear before edition", () => {
    const toml = [
      "[workspace.package]",
      'authors = ["Alice <alice@example.com>", "Bob <bob@example.com>"]',
      'keywords = ["pi", "rust", "extension"]',
      'edition = "2024"',
      "",
      "[dependencies]",
      'serde = { version = "1.0", features = ["derive"] }',
    ].join("\n");

    assert.equal(parseSectionEdition(toml, "workspace.package"), "2024");
  });

  it("prefers [workspace.package] edition over [package] edition in mixed root manifests", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "rg-mixed-"));
    const memberDir = join(rootDir, "crates", "member");
    try {
      mkdirSync(memberDir, { recursive: true });
      writeFileSync(
        join(rootDir, "Cargo.toml"),
        [
          "[package]",
          'name = "root"',
          'version = "0.1.0"',
          'authors = ["Root Author <root@example.com>"]',
          'edition = "2018"',
          "",
          "[workspace.package]",
          'authors = ["Workspace Author <ws@example.com>"]',
          'edition = "2024"',
          "",
          "[workspace]",
          'members = ["crates/*"]',
        ].join("\n")
      );
      writeFileSync(
        join(memberDir, "Cargo.toml"),
        '[package]\nname = "member"\nedition.workspace = true\n'
      );
      assert.equal(detectRustEdition(memberDir), "2024");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("session isolation for editedThisTurn", () => {
  it("returns independent editedThisTurn sets per session key", () => {
    const runtime = getRuntimeState();
    const mkCtx = (id: string) =>
      ({
        cwd: tmpdir(),
        hasUI: false,
        sessionManager: { getSessionId: () => id },
      }) as any;

    const a = getSessionState(runtime, mkCtx(`iso-a-${Date.now()}`));
    const b = getSessionState(runtime, mkCtx(`iso-b-${Date.now()}`));
    a.editedThisTurn.add("/tmp/a.rs");
    assert.notEqual(a.editedThisTurn, b.editedThisTurn);
    assert.equal(b.editedThisTurn.size, 0);
  });

  it("backfills editedThisTurn on legacy session state objects during reload", () => {
    const runtime = getRuntimeState();
    const key = `legacy-${Date.now()}`;
    (runtime.sessions as Map<string, any>).set(key, {
      readSnapshots: new Map(),
      invalidatedPaths: new Set(),
      // editedThisTurn intentionally undefined as in prior version
    });

    const ctx = {
      cwd: tmpdir(),
      hasUI: false,
      sessionManager: { getSessionId: () => key },
    } as any;

    const session = getSessionState(runtime, ctx);
    assert.ok(session.editedThisTurn instanceof Set);
    assert.doesNotThrow(() => session.editedThisTurn.clear());
  });
});

describe("syncFromBranch replay preserves formattedSinceRead and guardianDetails.full", () => {
  it("retains guardianDetails.full: true from read toolResult with offset/limit", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rg-full-replay-"));
    const srcDir = join(tempDir, "src");
    const filePath = join(srcDir, "lib.rs");
    try {
      mkdirSync(srcDir, { recursive: true });
      const fileContent = "pub fn foo() {}\n";
      writeFileSync(filePath, fileContent);
      const h1 = createHash("sha256").update(fileContent).digest("hex");

      const handlers: Record<string, ((...args: any[]) => any)[]> = {};
      const mockPi = {
        registerCommand: () => {},
        on: (name: string, cb: (...args: any[]) => any) => {
          handlers[name] = [cb];
        },
        appendEntry: () => {},
      } as any;
      rustGuardian(mockPi);

      const sessionId = `full-replay-${Date.now()}`;
      const ctx = {
        cwd: tempDir,
        hasUI: false,
        sessionManager: {
          getSessionId: () => sessionId,
          getBranch: () => [
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "c_read",
                    name: "read",
                    arguments: { path: "src/lib.rs", offset: 1, limit: 100 },
                  },
                ],
              },
            },
            {
              message: {
                role: "toolResult",
                toolCallId: "c_read",
                isError: false,
                details: { rustGuardian: { hash: h1, full: true } },
              },
            },
          ],
        },
      } as any;

      await handlers.session_start[0]({}, ctx);

      const session = getSessionState(getRuntimeState(), ctx);
      const snap = session.readSnapshots.get(normalizePath(tempDir, "src/lib.rs"));
      assert.ok(snap);
      assert.equal(snap!.full, true, "expected full to be true from guardianDetails.full");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retains formattedSinceRead: true from edit toolResult details during replay", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rg-replay-"));
    const srcDir = join(tempDir, "src");
    const filePath = join(srcDir, "lib.rs");
    try {
      mkdirSync(srcDir, { recursive: true });
      const fileContent = "pub fn f() -> u32 { 1 }\n";
      writeFileSync(filePath, fileContent);
      const h3 = createHash("sha256")
        .update(fileContent)
        .digest("hex");

      const handlers: Record<string, ((...args: any[]) => any)[]> = {};
      const mockPi = {
        registerCommand: () => {},
        on: (name: string, cb: (...args: any[]) => any) => {
          handlers[name] = [cb];
        },
        appendEntry: () => {},
      } as any;
      rustGuardian(mockPi);

      const sessionId = `replay-${Date.now()}`;
      const ctx = {
        cwd: tempDir,
        hasUI: false,
        sessionManager: {
          getSessionId: () => sessionId,
          getBranch: () => [
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "c1",
                    name: "read",
                    arguments: { path: "src/lib.rs" },
                  },
                ],
              },
            },
            {
              message: {
                role: "toolResult",
                toolCallId: "c1",
                isError: false,
                details: { rustGuardian: { hash: "h1", full: true } },
              },
            },
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "c2",
                    name: "edit",
                    arguments: { path: "src/lib.rs" },
                  },
                ],
              },
            },
            {
              message: {
                role: "toolResult",
                toolCallId: "c2",
                isError: false,
                details: {
                  rustGuardian: { hash: h3, full: true, formattedSinceRead: true },
                },
              },
            },
          ],
        },
      } as any;

      await handlers.session_start[0]({}, ctx);

      const session = getSessionState(getRuntimeState(), ctx);
      const snap = session.readSnapshots.get(normalizePath(tempDir, "src/lib.rs"));
      assert.ok(snap, "expected the replayed file to be tracked");
      assert.equal(snap!.hash, h3);
      assert.equal(snap!.full, true);
      assert.equal(snap!.formattedSinceRead, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
