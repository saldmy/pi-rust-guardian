import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _testing } from "../extensions/rust-guardian.ts";

const {
  detectRustEdition,
  extractCargoErrors,
  formatErrorReport,
  matchesFormattedHash,
  recordFormattedHash,
  isBoilerplateCargoStderrLine,
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
