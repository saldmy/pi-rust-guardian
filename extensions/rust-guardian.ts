import {
  FooterComponent,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024; // 16 MB so JSON diagnostics never overflow
const MAX_REPORTED_ERRORS = 6;
const MAX_ERROR_CHARS = 3000;
const BATCH_SETTLE_MS = 25; // Coalesce parallel .rs edits in the same crate & turn
const DEFAULT_CARGO_TIMEOUT_MS = 60_000;
const MAX_FORMATTED_HASH_ENTRIES = 4096;
const FMT_CUSTOM_ENTRY_TYPE = "rust-guardian:fmt";
const STATUS_KEY = "rust-guardian";

function getCargoTimeoutMs(): number {
  const raw = process.env.PI_RUST_GUARDIAN_CARGO_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CARGO_TIMEOUT_MS;
}

interface SnapshotEntry {
  hash: string;
  full: boolean;
  formattedSinceRead?: boolean;
}

interface GuardianToolDetails {
  hash: string;
  full: boolean;
  formattedSinceRead?: boolean;
}

interface SessionGuardianState {
  readSnapshots: Map<string, SnapshotEntry>;
  invalidatedPaths: Set<string>;
  editedThisTurn: Set<string>;
  lastCheckSummary?: string;
}

interface GuardianRuntimeState {
  sessions: Map<string, SessionGuardianState>;
  formattedHashes: Map<string, string>;
}

const RUNTIME_STATE_KEY = Symbol.for("pi.rust-guardian.runtime-state");
const ORIG_FOOTER_RENDER_KEY = Symbol.for("pi.rust-guardian.orig-footer-render");

/**
 * Patches FooterComponent.prototype.render so the `rust-guardian` status is placed
 * on Line 1 (the top path/branch line) instead of creating an extra 3rd line at the bottom.
 */
function installPathLineFooterPatch(): void {
  const proto = FooterComponent?.prototype as any;
  if (!proto || typeof proto.render !== "function") return;

  const globalStore = globalThis as Record<symbol, any>;
  if (!globalStore[ORIG_FOOTER_RENDER_KEY]) {
    globalStore[ORIG_FOOTER_RENDER_KEY] = proto.render;
  }
  const origRender: (width: number) => string[] =
    globalStore[ORIG_FOOTER_RENDER_KEY];

  proto.render = function (width: number): string[] {
    const footerData = this.footerData;
    const statuses: ReadonlyMap<string, string> | undefined =
      footerData?.getExtensionStatuses?.();
    const rgText = statuses?.get(STATUS_KEY);

    if (
      !rgText ||
      !footerData ||
      typeof footerData.getExtensionStatuses !== "function"
    ) {
      return origRender.call(this, width);
    }

    // Temporarily omit `rust-guardian` from getExtensionStatuses() so stock FooterComponent
    // does not push a 3rd line for it at the bottom of the footer.
    const origGetStatuses = footerData.getExtensionStatuses;
    let lines: string[];
    try {
      footerData.getExtensionStatuses = () => {
        const filtered = new Map(statuses);
        filtered.delete(STATUS_KEY);
        return filtered;
      };
      lines = origRender.call(this, width);
    } finally {
      footerData.getExtensionStatuses = origGetStatuses;
    }

    if (Array.isArray(lines) && lines.length > 0) {
      const cleanRg = rgText.replace(/[\r\n\t]+/g, " ").trim();
      const sep = "  •  ";
      const combined = `${lines[0]}${sep}${cleanRg}`;
      if (visibleWidth(combined) <= width) {
        lines[0] = combined;
      } else {
        const available = width - visibleWidth(lines[0]) - visibleWidth(sep);
        if (available > 10) {
          lines[0] = truncateToWidth(
            `${lines[0]}${sep}${truncateToWidth(cleanRg, available)}`,
            width
          );
        }
      }
    }

    return lines;
  };
}

function getRuntimeState(): GuardianRuntimeState {
  const globalStore = globalThis as Record<symbol, any>;
  const existing = globalStore[RUNTIME_STATE_KEY];

  if (!existing) {
    const initial: GuardianRuntimeState = {
      sessions: new Map<string, SessionGuardianState>(),
      formattedHashes: new Map<string, string>(),
    };
    globalStore[RUNTIME_STATE_KEY] = initial;
    return initial;
  }

  if (!(existing.sessions instanceof Map)) {
    const sessions = new Map<string, SessionGuardianState>();
    if (existing.readSnapshots instanceof Map) {
      sessions.set("default", {
        readSnapshots: existing.readSnapshots,
        invalidatedPaths:
          existing.invalidatedPaths instanceof Set
            ? existing.invalidatedPaths
            : new Set<string>(),
        editedThisTurn: new Set<string>(),
      });
    }
    existing.sessions = sessions;
  }

  if (!(existing.formattedHashes instanceof Map)) {
    existing.formattedHashes = new Map<string, string>();
  } else {
    const map = existing.formattedHashes as Map<any, any>;
    for (const [k, v] of Array.from(map.entries())) {
      if (
        v &&
        typeof v === "object" &&
        typeof v.preHash === "string" &&
        typeof v.postHash === "string"
      ) {
        map.delete(k);
        map.set(v.preHash, v.postHash);
      }
    }
  }

  return existing as GuardianRuntimeState;
}

function getSessionKey(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as any;
  const id =
    sm?.getSessionId?.() ??
    sm?.sessionId ??
    sm?.getSessionFile?.() ??
    sm?.sessionFile;
  if (typeof id === "string" && id.trim()) return id.trim();
  return canonicalizePath(ctx.cwd);
}

function getSessionState(
  runtime: GuardianRuntimeState,
  ctx: ExtensionContext
): SessionGuardianState {
  const key = getSessionKey(ctx);
  let session = runtime.sessions.get(key);
  if (!session) {
    const migrated = runtime.sessions.get("default");
    if (migrated && key !== "default") {
      if (!(migrated.editedThisTurn instanceof Set)) {
        migrated.editedThisTurn = new Set<string>();
      }
      runtime.sessions.delete("default");
      runtime.sessions.set(key, migrated);
      return migrated;
    }
    session = {
      readSnapshots: new Map<string, SnapshotEntry>(),
      invalidatedPaths: new Set<string>(),
      editedThisTurn: new Set<string>(),
    };
    runtime.sessions.set(key, session);
  } else if (!(session.editedThisTurn instanceof Set)) {
    session.editedThisTurn = new Set<string>();
  }
  return session;
}

function updateFooterStatus(
  ctx: ExtensionContext,
  session: SessionGuardianState,
  overrideText?: string
): void {
  if (!ctx.hasUI) return;
  const theme = (ctx.ui as any).theme;
  const count = session.readSnapshots.size;
  const countLabel = `${count} .rs tracked`;
  const dim = (s: string) => (theme ? theme.fg("dim", s) : s);

  if (overrideText) {
    ctx.ui.setStatus(STATUS_KEY, overrideText);
    return;
  }

  if (session.lastCheckSummary) {
    ctx.ui.setStatus(
      STATUS_KEY,
      `${dim("rust-guardian:")} ${session.lastCheckSummary} ${dim(`(${countLabel})`)}`
    );
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, dim(`rust-guardian: ready (${countLabel})`));
}

function recordFormattedHash(
  formattedHashes: Map<string, string>,
  preHash: string,
  postHash: string
): void {
  if (!preHash || !postHash || preHash === postHash) return;
  formattedHashes.set(preHash, postHash);
  if (formattedHashes.size > MAX_FORMATTED_HASH_ENTRIES) {
    const oldestKey = formattedHashes.keys().next().value;
    if (oldestKey !== undefined) formattedHashes.delete(oldestKey);
  }
}

function matchesFormattedHash(
  formattedHashes: Map<string, string>,
  recordedHash: string,
  currentDiskHash: string
): boolean {
  let cur: string | undefined = recordedHash;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const next = formattedHashes.get(cur);
    if (!next) return false;
    if (next === currentDiskHash) return true;
    cur = next;
  }
  return false;
}

function isKnownFormattedOutputHash(
  formattedHashes: Map<string, string>,
  targetHash: string
): boolean {
  for (const postHash of formattedHashes.values()) {
    if (postHash === targetHash) return true;
  }
  return false;
}

function shouldHintReformat(
  snapEntry: SnapshotEntry | undefined,
  currentDiskHash: string | null,
  formattedHashes: Map<string, string>
): boolean {
  if (snapEntry !== undefined && snapEntry.hash === currentDiskHash) {
    return Boolean(snapEntry.formattedSinceRead);
  }
  return (
    currentDiskHash !== null &&
    isKnownFormattedOutputHash(formattedHashes, currentDiskHash)
  );
}

function canonicalizePath(absPath: string): string {
  const realpath = realpathSync.native ?? realpathSync;
  let cur = absPath;
  const tail: string[] = [];

  while (true) {
    try {
      const resolvedBase = realpath(cur);
      return tail.length > 0
        ? resolve(resolvedBase, ...tail.reverse())
        : resolvedBase;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return absPath;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function normalizePath(cwd: string, rawPath: string): string {
  const cleaned = rawPath.trim().replace(/^@/, "");
  let resolved: string;
  if (cleaned === "~") {
    resolved = homedir();
  } else if (cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    resolved = resolve(homedir(), cleaned.slice(2));
  } else {
    resolved = resolve(cwd, cleaned);
  }
  return canonicalizePath(resolved);
}

function isRustFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".rs");
}

function readSnapshotHash(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function getFileMtimeMs(absPath: string): number | null {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function isFullFileRead(
  absPath: string,
  offset: unknown,
  limit: unknown,
  wasTruncated: boolean
): boolean {
  if (wasTruncated) return false;
  if (typeof offset === "number" && offset > 1) return false;
  if (typeof limit === "number") {
    try {
      const content = readFileSync(absPath, "utf8");
      const lineCount = content.split("\n").length;
      return limit >= lineCount;
    } catch {
      return false;
    }
  }
  return true;
}

function findCargoRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  while (true) {
    if (existsSync(resolve(dir, "Cargo.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseSectionEdition(
  toml: string,
  sectionHeader: string
): string | null {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRegex = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "m");
  const headerMatch = headerRegex.exec(toml);
  if (!headerMatch) return null;

  const afterHeader = toml.slice(headerMatch.index + headerMatch[0].length);
  const nextSectionMatch = /^\s*\[/m.exec(afterHeader);
  const sectionBody = nextSectionMatch
    ? afterHeader.slice(0, nextSectionMatch.index)
    : afterHeader;

  const editionMatch = sectionBody.match(/^\s*edition\s*=\s*["'](\d{4})["']/m);
  return editionMatch?.[1] ?? null;
}

function detectRustEdition(cargoRoot: string | null): string {
  if (!cargoRoot) return "2021";
  let dir: string | null = cargoRoot;
  while (dir) {
    const manifestPath = resolve(dir, "Cargo.toml");
    if (existsSync(manifestPath)) {
      try {
        const toml = readFileSync(manifestPath, "utf8");
        const edition =
          (dir !== cargoRoot
            ? parseSectionEdition(toml, "workspace.package") ??
              parseSectionEdition(toml, "package")
            : parseSectionEdition(toml, "package") ??
              parseSectionEdition(toml, "workspace.package")) ??
          toml.match(/^\s*edition\s*=\s*["'](\d{4})["']/m)?.[1] ??
          null;
        if (edition) return edition;

        const inheritsWorkspace =
          /^\s*edition\s*\.\s*workspace\s*=\s*true\b/m.test(toml) ||
          /^\s*edition\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b/m.test(toml);
        if (!inheritsWorkspace && /^\s*\[package\]/m.test(toml)) {
          return "2015";
        }
      } catch {
        // Ignore unreadable Cargo.toml
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "2021";
}

function isBoilerplateCargoStderrLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  return (
    /^warning:\s+build failed, waiting for other jobs to finish\.\.\.$/.test(
      t
    ) ||
    /^error:\s+could not compile\s+.+\s+due to\s+\d+\s+previous error/.test(
      t
    ) ||
    /^error:\s+build failed$/.test(t) ||
    /^To learn more, run the command again with --verbose\.$/.test(t)
  );
}

function isCargoWarningLine(line: string): boolean {
  return /^warning:\s/i.test(line.trim());
}

function extractCargoErrors(stdout: string, stderr: string): string[] {
  const errors = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (
        msg.reason === "compiler-message" &&
        msg.message?.level === "error" &&
        typeof msg.message?.rendered === "string"
      ) {
        const text: string = msg.message.message ?? "";
        const hasSpans =
          Array.isArray(msg.message.spans) && msg.message.spans.length > 0;
        if (
          !hasSpans &&
          (text.startsWith("aborting due to ") ||
            text.startsWith("For more information about ") ||
            text.startsWith("Some errors have detailed explanations"))
        ) {
          continue;
        }
        errors.add(msg.message.rendered.trim());
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  const trimmedStderr = stderr.trim();
  if (trimmedStderr) {
    const stderrLines = trimmedStderr
      .split("\n")
      .filter((line) => !isBoilerplateCargoStderrLine(line));

    if (errors.size === 0) {
      if (stderrLines.length > 0) {
        errors.add(stderrLines.join("\n").trim());
      }
    } else {
      const nonWarningLines = stderrLines.filter(
        (line) => !isCargoWarningLine(line)
      );
      if (nonWarningLines.length > 0) {
        errors.add(nonWarningLines.join("\n").trim());
      }
    }
  }

  return Array.from(errors);
}

function formatErrorReport(errors: string[]): string {
  const sliced = errors.slice(0, MAX_REPORTED_ERRORS).join("\n\n");
  const isCharTruncated = sliced.length > MAX_ERROR_CHARS;
  const omittedCount = Math.max(0, errors.length - MAX_REPORTED_ERRORS);

  let body = isCharTruncated ? sliced.slice(0, MAX_ERROR_CHARS) : sliced;
  if (isCharTruncated || omittedCount > 0) {
    const reasons: string[] = [];
    if (isCharTruncated) reasons.push("output char-truncated");
    if (omittedCount > 0) reasons.push(`${omittedCount} more error(s) omitted`);
    body += `\n... (${reasons.join(", ")})`;
  }

  return `\n[cargo check --all-targets: ${errors.length} error(s) — fix before finishing]:\n${body}`;
}

/**
 * Appends cargo check diagnostics to `details.diff` so pi's `renderDiff()` displays
 * them directly inside the TUI `edit` box. Every line starts with `[` or `│` (not `+`, `-`,
 * or whitespace) so `parseDiffLine()` treats it as a raw footer line.
 */
function appendToEditDiff(
  existingDetails: Record<string, unknown> | undefined,
  boxFooter: string
): Record<string, unknown> | undefined {
  if (!existingDetails || typeof existingDetails.diff !== "string") {
    return existingDetails;
  }
  const safeLines = boxFooter
    .trim()
    .split("\n")
    .map((line, idx) => (idx === 0 ? `[rust-guardian] ${line}` : `│ ${line}`))
    .join("\n");

  return {
    ...existingDetails,
    diff: `${existingDetails.diff}\n${safeLines}`,
  };
}

function withGuardianDetails(
  existingDetails: unknown,
  rustGuardian: GuardianToolDetails
): Record<string, unknown> {
  const base =
    existingDetails !== null &&
    typeof existingDetails === "object" &&
    !Array.isArray(existingDetails)
      ? (existingDetails as Record<string, unknown>)
      : {};
  return { ...base, rustGuardian };
}

export default function (pi: ExtensionAPI) {
  installPathLineFooterPatch();

  const runtimeState = getRuntimeState();
  const { formattedHashes } = runtimeState;

  let cargoMutex: Promise<unknown> = Promise.resolve();
  const mutationSeqByRoot = new Map<string, number>();

  function enqueueCargoTask<T>(task: () => Promise<T>): Promise<T> {
    const next = cargoMutex.then(task, task);
    cargoMutex = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  pi.registerCommand("rust-guardian", {
    description:
      "Show tracked Rust files, SHA-256 snapshots, and cargo check status",
    handler: async (_args, ctx) => {
      const session = getSessionState(runtimeState, ctx);
      const entries = Array.from(session.readSnapshots.entries());
      if (entries.length === 0) {
        ctx.ui.notify(
          `[rust-guardian] active\nTracked .rs files: 0\nFormatted hash chains: ${formattedHashes.size}\nLast check: ${session.lastCheckSummary ?? "none yet"}`,
          "info"
        );
        return;
      }

      const lines = entries.map(([absPath, snap]) => {
        const rel = relative(ctx.cwd, absPath) || basename(absPath);
        const mode = snap.full ? "FULL" : "PARTIAL";
        const fmt = snap.formattedSinceRead ? " · rustfmt" : "";
        return `  • ${rel} [${mode}${fmt}] (${snap.hash.slice(0, 8)})`;
      });

      ctx.ui.notify(
        `[rust-guardian] (${entries.length} tracked .rs file${entries.length === 1 ? "" : "s"}, ${formattedHashes.size} fmt hash${formattedHashes.size === 1 ? "" : "es"}):\n` +
          lines.join("\n"),
        "info"
      );
    },
  });

  const syncFromBranch = (
    ctx: ExtensionContext,
    mode: "start" | "tree" | "compact",
    reason?: string
  ) => {
    const session = getSessionState(runtimeState, ctx);
    const { readSnapshots, invalidatedPaths } = session;
    const isNewOrSwitchedSession = mode === "start" && reason !== "reload";
    const previousSnapshots = isNewOrSwitchedSession
      ? new Map<string, SnapshotEntry>()
      : new Map(readSnapshots);

    readSnapshots.clear();

    if (mode !== "compact") {
      session.editedThisTurn.clear();
    }

    if (isNewOrSwitchedSession || mode === "tree") {
      invalidatedPaths.clear();
      session.lastCheckSummary = undefined;
    }

    try {
      const entries = (ctx.sessionManager?.getBranch?.() ?? []) as any[];

      for (const entry of entries) {
        if (
          entry?.type === "custom" &&
          entry?.customType === FMT_CUSTOM_ENTRY_TYPE &&
          Array.isArray(entry?.data?.mappings)
        ) {
          for (const item of entry.data.mappings) {
            if (
              typeof item?.preHash === "string" &&
              typeof item?.postHash === "string"
            ) {
              recordFormattedHash(formattedHashes, item.preHash, item.postHash);
            }
          }
        }
      }

      let startIdx = 0;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === "compaction") {
          const keptId = entries[i].firstKeptEntryId;
          const keptIdx = keptId
            ? entries.findIndex((e: any) => e?.id === keptId)
            : -1;
          startIdx = keptIdx !== -1 ? keptIdx : i + 1;
          break;
        }
      }

      interface ToolCallMeta {
        absPath: string;
        toolName: "read" | "edit" | "write";
        isPartialRead: boolean;
      }

      interface WindowCoverageEntry {
        hash: string | null;
        full: boolean;
        formattedSinceRead: boolean;
      }

      const callIdToMeta = new Map<string, ToolCallMeta>();
      const windowCoverage = new Map<string, WindowCoverageEntry>();

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const msg = entry?.message;
        if (!msg) continue;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (
              block?.type === "toolCall" &&
              typeof block.id === "string" &&
              (block.name === "read" ||
                block.name === "edit" ||
                block.name === "write") &&
              typeof block.arguments?.path === "string"
            ) {
              const absPath = normalizePath(ctx.cwd, block.arguments.path);
              if (isRustFile(absPath)) {
                const isPartialRead =
                  block.name === "read" &&
                  (block.arguments?.offset !== undefined ||
                    block.arguments?.limit !== undefined);
                callIdToMeta.set(block.id, {
                  absPath,
                  toolName: block.name,
                  isPartialRead,
                });
              }
            }
          }
        } else if (
          i >= startIdx &&
          msg.role === "toolResult" &&
          !msg.isError &&
          typeof msg.toolCallId === "string"
        ) {
          const meta = callIdToMeta.get(msg.toolCallId);
          if (!meta) continue;

          const { absPath, toolName, isPartialRead } = meta;
          readSnapshots.delete(absPath);

          const detailsObj = msg.details as Record<string, any> | undefined;
          const guardianDetails = detailsObj?.rustGuardian as
            | { hash?: unknown; full?: unknown; formattedSinceRead?: unknown }
            | undefined;
          const recordedHash =
            typeof guardianDetails?.hash === "string"
              ? guardianDetails.hash
              : null;
          const wasTruncated = detailsObj?.truncation?.truncated === true;

          let thisCallIsFull = false;
          if (toolName === "write") {
            thisCallIsFull = true;
          } else if (toolName === "read") {
            thisCallIsFull =
              typeof guardianDetails?.full === "boolean"
                ? !wasTruncated && guardianDetails.full
                : !isPartialRead && !wasTruncated;
          }

          const priorInWindow = windowCoverage.get(absPath);
          let carriedFull = false;
          let formattedBetweenPriorAndThis = false;

          if (
            priorInWindow?.hash !== null &&
            priorInWindow?.hash !== undefined &&
            recordedHash !== null &&
            priorInWindow.hash !== recordedHash &&
            matchesFormattedHash(
              formattedHashes,
              priorInWindow.hash,
              recordedHash
            )
          ) {
            formattedBetweenPriorAndThis = true;
          }

          if (priorInWindow?.full) {
            if (toolName === "edit" || toolName === "write") {
              carriedFull = true;
            } else if (toolName === "read") {
              if (priorInWindow.hash !== null && recordedHash !== null) {
                carriedFull =
                  priorInWindow.hash === recordedHash ||
                  formattedBetweenPriorAndThis;
              } else {
                carriedFull = true;
              }
            }
          }

          const isFull = thisCallIsFull || carriedFull;
          const formattedSinceReadInWindow =
            typeof guardianDetails?.formattedSinceRead === "boolean"
              ? guardianDetails.formattedSinceRead
              : toolName === "read" || toolName === "write"
                ? false
                : Boolean(priorInWindow?.formattedSinceRead) ||
                  formattedBetweenPriorAndThis;

          windowCoverage.set(absPath, {
            hash: recordedHash,
            full: isFull,
            formattedSinceRead: formattedSinceReadInWindow,
          });

          if (mode === "compact" && !previousSnapshots.has(absPath)) continue;

          const currentHash = readSnapshotHash(absPath);
          if (currentHash === null) continue;

          if (recordedHash !== null) {
            const matchesCurrentViaFmt =
              recordedHash !== currentHash &&
              matchesFormattedHash(formattedHashes, recordedHash, currentHash);

            if (recordedHash === currentHash || matchesCurrentViaFmt) {
              readSnapshots.set(absPath, {
                hash: currentHash,
                full: isFull,
                formattedSinceRead:
                  formattedSinceReadInWindow || matchesCurrentViaFmt,
              });
            }
            continue;
          }

          if (invalidatedPaths.has(absPath)) continue;

          const prev = previousSnapshots.get(absPath);
          if (prev !== undefined) {
            if (prev.hash === currentHash) {
              readSnapshots.set(absPath, {
                hash: currentHash,
                full: isFull,
                formattedSinceRead: Boolean(prev.formattedSinceRead),
              });
            }
            continue;
          }

          const entryTimeMs =
            parseTimestampMs(msg.timestamp) ??
            parseTimestampMs(entry?.timestamp);
          const mtimeMs = getFileMtimeMs(absPath);
          if (
            entryTimeMs === null ||
            mtimeMs === null ||
            mtimeMs > entryTimeMs
          ) {
            continue;
          }

          readSnapshots.set(absPath, {
            hash: currentHash,
            full: isFull,
            formattedSinceRead: false,
          });
        }
      }
    } catch {
      // Ignore if session branch isn't ready yet
    }

    updateFooterStatus(ctx, session);
  };

  pi.on("session_start", async (event, ctx) =>
    syncFromBranch(ctx, "start", (event as { reason?: string })?.reason)
  );
  pi.on("session_tree", async (_event, ctx) => syncFromBranch(ctx, "tree"));
  pi.on("session_compact", async (_event, ctx) =>
    syncFromBranch(ctx, "compact")
  );
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // 1. READ-GUARD: Block blind, stale, or partial-read overwrites on existing .rs files
  pi.on("tool_call", async (event, ctx) => {
    const isEdit = isToolCallEventType("edit", event);
    const isWrite = isToolCallEventType("write", event);
    if (!isEdit && !isWrite) {
      return undefined;
    }

    const rawPath = event.input?.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;

    const absPath = normalizePath(ctx.cwd, rawPath);
    if (!isRustFile(absPath)) return undefined;

    if (existsSync(absPath)) {
      const session = getSessionState(runtimeState, ctx);
      const { readSnapshots } = session;
      const recorded = readSnapshots.get(absPath);
      const current = readSnapshotHash(absPath);
      if (
        recorded === undefined ||
        current === null ||
        recorded.hash !== current
      ) {
        const reason = `Read-Guard: '${rawPath}' already exists (or was modified/compacted since last read). Call 'read' on it before modifying.`;
        if (ctx.hasUI) ctx.ui.notify(`[rust-guardian] ${reason}`, "warning");
        return { block: true, reason };
      }
      if (isWrite && !recorded.full) {
        const reason = `Read-Guard: '${rawPath}' was only partially read (with offset/limit, truncated output, or compacted full read). Read the full file before overwriting it with 'write', or use 'edit' for targeted changes.`;
        if (ctx.hasUI) ctx.ui.notify(`[rust-guardian] ${reason}`, "warning");
        return { block: true, reason };
      }
    }
    return undefined;
  });

  // 2. TRACK .rs READS + RUN COALESCE-SERIALIZED CARGO CHECK ON .rs EDITS/WRITES
  pi.on("tool_result", async (event, ctx) => {
    const inputObj = event.input as
      | { path?: unknown; offset?: unknown; limit?: unknown }
      | undefined;
    const rawPath = inputObj?.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;

    const absPath = normalizePath(ctx.cwd, rawPath);
    if (!isRustFile(absPath)) return undefined;

    const session = getSessionState(runtimeState, ctx);
    const { readSnapshots, invalidatedPaths } = session;
    let patchedDetails: Record<string, unknown> | undefined;

    if (
      !event.isError &&
      (event.toolName === "read" ||
        event.toolName === "edit" ||
        event.toolName === "write")
    ) {
      const snap = readSnapshotHash(absPath);
      if (snap !== null) {
        const prior = readSnapshots.get(absPath);
        const wasTruncated =
          (event.details as any)?.truncation?.truncated === true;

        let full = false;
        let singleOpFull = false;
        let formattedSinceRead = false;

        if (event.toolName === "write") {
          full = true;
          singleOpFull = true;
          formattedSinceRead = false;
        } else if (event.toolName === "read") {
          singleOpFull = isFullFileRead(
            absPath,
            inputObj?.offset,
            inputObj?.limit,
            wasTruncated
          );
          full = singleOpFull || Boolean(prior?.hash === snap && prior.full);
          formattedSinceRead = false;
        } else if (event.toolName === "edit") {
          singleOpFull = false;
          full = Boolean(prior?.full);
          formattedSinceRead = Boolean(prior?.formattedSinceRead);
        }

        readSnapshots.set(absPath, {
          hash: snap,
          full,
          formattedSinceRead,
        });
        invalidatedPaths.delete(absPath);
        patchedDetails = withGuardianDetails(event.details, {
          hash: snap,
          full: singleOpFull,
          formattedSinceRead,
        });
        updateFooterStatus(ctx, session);
      }
    }

    if (event.isError) {
      if (event.toolName === "edit") {
        const snapEntry = readSnapshots.get(absPath);
        const currentDiskHash = readSnapshotHash(absPath);
        const wasReformatted = shouldHintReformat(
          snapEntry,
          currentDiskHash,
          formattedHashes
        );

        if (wasReformatted) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `[rust-guardian] '${rawPath}' was reformatted by rustfmt — telling agent to re-read target lines.`,
              "info"
            );
          }
          return {
            content: [
              ...event.content,
              {
                type: "text",
                text: `\n[rust-guardian hint: '${rawPath}' was reformatted by rustfmt after it was last read, which may have wrapped or re-indented lines. Call 'read' on the target section to inspect current formatting before retrying 'edit'.]`,
              },
            ],
          };
        }
      }
      return undefined;
    }

    if (event.toolName !== "edit" && event.toolName !== "write") {
      return patchedDetails ? { details: patchedDetails } : undefined;
    }

    session.editedThisTurn.add(absPath);
    const cargoRoot = findCargoRoot(absPath);
    if (!cargoRoot) {
      return patchedDetails ? { details: patchedDetails } : undefined;
    }

    const mySeq = (mutationSeqByRoot.get(cargoRoot) ?? 0) + 1;
    mutationSeqByRoot.set(cargoRoot, mySeq);

    await new Promise((resolveTimer) =>
      setTimeout(resolveTimer, BATCH_SETTLE_MS)
    );
    if (
      (mutationSeqByRoot.get(cargoRoot) ?? 0) > mySeq ||
      ctx.signal?.aborted
    ) {
      return patchedDetails ? { details: patchedDetails } : undefined;
    }

    const timeoutMs = getCargoTimeoutMs();
    const timeoutSec = Math.round(timeoutMs / 1000);

    const result = await enqueueCargoTask(async () => {
      if (
        (mutationSeqByRoot.get(cargoRoot) ?? 0) > mySeq ||
        ctx.signal?.aborted
      ) {
        return {
          ok: true as const,
          skipped: true,
          errors: [] as string[],
          elapsedMs: 0,
        };
      }

      const startMs = Date.now();
      const theme = ctx.hasUI ? (ctx.ui as any).theme : undefined;
      const runningText = theme
        ? theme.fg("warning", "rust-guardian: running cargo check --all-targets…")
        : "rust-guardian: running cargo check --all-targets…";
      updateFooterStatus(ctx, session, runningText);

      try {
        await execFileAsync(
          "cargo",
          [
            "check",
            "--all-targets",
            "--quiet",
            "--color=never",
            "--message-format=json",
          ],
          {
            cwd: cargoRoot,
            timeout: timeoutMs,
            maxBuffer: MAX_BUFFER,
            signal: ctx.signal,
          }
        );
        return {
          ok: true as const,
          errors: [] as string[],
          elapsedMs: Date.now() - startMs,
        };
      } catch (err: any) {
        const elapsedMs = Date.now() - startMs;
        if (err?.name === "AbortError" || ctx.signal?.aborted) {
          return {
            ok: true as const,
            skipped: true,
            errors: [] as string[],
            elapsedMs,
          };
        }

        const errors = extractCargoErrors(err?.stdout || "", err?.stderr || "");

        if (err?.code === "ENOENT") {
          errors.push(
            "cargo executable was not found in PATH. Ensure Rust and Cargo are installed and available in the current environment."
          );
          return { ok: false as const, errors, elapsedMs };
        }

        if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          if (errors.length === 0) {
            errors.push(
              "cargo check output exceeded 16 MB buffer limit without parseable error spans."
            );
          }
          return { ok: false as const, errors, elapsedMs };
        }

        if (err?.killed || err?.signal === "SIGTERM") {
          if (errors.length > 0) {
            errors.push(
              `[cargo check --all-targets timed out after ${timeoutSec}s — showing diagnostics emitted before timeout]`
            );
          } else {
            errors.push(
              `cargo check --all-targets timed out after ${timeoutSec}s.`
            );
          }
          return { ok: false as const, errors, elapsedMs };
        }

        if (errors.length === 0) {
          errors.push(
            err?.message || "cargo check failed with an unknown error."
          );
        }
        return { ok: false as const, errors, elapsedMs };
      }
    });

    if (result.skipped) {
      updateFooterStatus(ctx, session);
      return patchedDetails ? { details: patchedDetails } : undefined;
    }

    const theme = ctx.hasUI ? (ctx.ui as any).theme : undefined;
    const durationLabel = `${(result.elapsedMs / 1000).toFixed(1)}s`;

    if (result.ok) {
      session.lastCheckSummary = theme
        ? theme.fg("success", `cargo check ok (${durationLabel})`)
        : `cargo check ok (${durationLabel})`;
      updateFooterStatus(ctx, session);
    } else {
      const errCount = result.errors.length;
      session.lastCheckSummary = theme
        ? theme.fg("error", `cargo check: ${errCount} error(s) (${durationLabel})`)
        : `cargo check: ${errCount} error(s) (${durationLabel})`;
      updateFooterStatus(ctx, session);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `[rust-guardian] cargo check caught ${errCount} error(s) in ${rawPath} (${durationLabel})`,
          "warning"
        );
      }
    }

    const statusText = result.ok
      ? "\n[cargo check --all-targets: 0 errors ✓]"
      : formatErrorReport(result.errors);

    const boxFooter = result.ok
      ? `cargo check --all-targets: 0 errors (${durationLabel})`
      : formatErrorReport(result.errors).trimStart();

    const finalDetails =
      event.toolName === "edit"
        ? appendToEditDiff(patchedDetails, boxFooter)
        : patchedDetails;

    return {
      content: [...event.content, { type: "text", text: statusText }],
      ...(finalDetails ? { details: finalDetails } : {}),
    };
  });

  // 3. SAFE RUSTFMT AT AGENT_END: Format files edited this turn & advance verified snapshots
  pi.on("agent_end", async (_event, ctx) => {
    const session = getSessionState(runtimeState, ctx);
    if (session.editedThisTurn.size === 0) return;
    const filesToFormat = Array.from(session.editedThisTurn);
    session.editedThisTurn.clear();

    const { readSnapshots, invalidatedPaths } = session;

    await enqueueCargoTask(async () => {
      const validPreFmtSnapshots = new Map<string, SnapshotEntry>();
      const dirtiedCrateRoots = new Set<string>();

      for (const [trackedPath, snap] of readSnapshots.entries()) {
        if (readSnapshotHash(trackedPath) === snap.hash) {
          validPreFmtSnapshots.set(trackedPath, snap);
        } else {
          readSnapshots.delete(trackedPath);
          invalidatedPaths.add(trackedPath);
          const root = findCargoRoot(trackedPath);
          if (root) dirtiedCrateRoots.add(root);
        }
      }

      const editionByRoot = new Map<string | null, string>();

      for (const filePath of filesToFormat) {
        if (ctx.signal?.aborted) break;
        if (!existsSync(filePath)) continue;
        if (!validPreFmtSnapshots.has(filePath)) continue;

        const cargoRoot = findCargoRoot(filePath);
        if (cargoRoot && dirtiedCrateRoots.has(cargoRoot)) continue;

        let edition = editionByRoot.get(cargoRoot);
        if (!edition) {
          edition = detectRustEdition(cargoRoot);
          editionByRoot.set(cargoRoot, edition);
        }

        try {
          await execFileAsync("rustfmt", ["--edition", edition, filePath], {
            cwd: cargoRoot ?? dirname(filePath),
            timeout: 5000,
            maxBuffer: MAX_BUFFER,
            signal: ctx.signal,
          });
        } catch {
          // Ignore if file has syntax errors preventing rustfmt
        }
      }

      const newFormatMappings: Array<{ preHash: string; postHash: string }> =
        [];

      for (const [trackedPath, preSnap] of validPreFmtSnapshots.entries()) {
        const postHash = readSnapshotHash(trackedPath);
        if (postHash === null) {
          readSnapshots.delete(trackedPath);
          invalidatedPaths.add(trackedPath);
        } else if (postHash !== preSnap.hash) {
          readSnapshots.set(trackedPath, {
            hash: postHash,
            full: preSnap.full,
            formattedSinceRead: true,
          });
          recordFormattedHash(formattedHashes, preSnap.hash, postHash);
          newFormatMappings.push({ preHash: preSnap.hash, postHash });
        }
      }

      if (newFormatMappings.length > 0) {
        try {
          (pi as any).appendEntry?.(FMT_CUSTOM_ENTRY_TYPE, {
            mappings: newFormatMappings,
          });
        } catch {
          // Ignore if appendEntry is not supported in the current host version
        }
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[rust-guardian] rustfmt formatted ${newFormatMappings.length} file${newFormatMappings.length === 1 ? "" : "s"}`,
            "info"
          );
        }
      }

      updateFooterStatus(ctx, session);
    });
  });
}

export const _testing = {
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
  canonicalizePath,
  normalizePath,
  getRuntimeState,
  getSessionState,
};
