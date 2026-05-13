import { spawn } from "node:child_process";

import type { Priority } from "./types.js";

const REMINDER_ID_PREFIX = "x-apple-reminder://";
const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i;

export class AppleScriptError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly hint?: string
  ) {
    super(message);
    this.name = "AppleScriptError";
  }
}

/**
 * Thin wrapper around `osascript` for talking to Reminders.app.
 *
 * Everything we send is one heredoc-style script piped to osascript's stdin. We never compose
 * scripts by appending user input as raw bytes — strings always go through {@link escape} and
 * dates always go through {@link dateBlock}.
 */
export class AppleScriptClient {
  constructor(private readonly debug = false) {}

  /**
   * Execute an AppleScript and return its trimmed stdout. Throws AppleScriptError on non-zero exit
   * with a friendly hint when the failure is one we recognise (Automation denied, app not running).
   */
  run(script: string): Promise<string> {
    if (this.debug) {
      console.error(`[applescript] running:\n${script}`);
    }
    return new Promise((resolve, reject) => {
      const child = spawn("osascript", [], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
      child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
      child.once("error", (err) => {
        reject(new AppleScriptError(`Failed to spawn osascript: ${err.message}`, "", null));
      });
      child.once("close", (code) => {
        if (code === 0) {
          resolve(stdout.trimEnd());
          return;
        }
        const hint = this.hintForStderr(stderr);
        reject(new AppleScriptError(
          stderr.trim() || `osascript exited with code ${code}`,
          stderr,
          code,
          hint
        ));
      });
      child.stdin.end(script);
    });
  }

  /**
   * Escape an arbitrary JavaScript string for safe interpolation inside double-quoted AppleScript
   * literals. Newlines are split out and rejoined with `linefeed` so multi-line notes survive.
   */
  static escape(s: string): string {
    if (s === "") return '""';
    const parts = s.split("\n").map((line) => {
      const escaped = line
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      return `"${escaped}"`;
    });
    return parts.join(" & linefeed & ");
  }

  /**
   * Produce a locale-safe AppleScript block that assigns a date to `varName`. Building the date
   * field-by-field instead of parsing a string avoids breakage on German/French/etc. macOS locales.
   * For all-day, time fields are zeroed so AppleScript's `allday due date` accepts the value.
   */
  static dateBlock(varName: string, when: Date, allDay: boolean): string {
    const y = when.getFullYear();
    const m = when.getMonth() + 1;
    const d = when.getDate();
    const h = allDay ? 0 : when.getHours();
    const min = allDay ? 0 : when.getMinutes();
    const s = allDay ? 0 : when.getSeconds();
    return [
      `set ${varName} to current date`,
      `set year of ${varName} to ${y}`,
      `set month of ${varName} to ${m}`,
      `set day of ${varName} to ${d}`,
      `set hours of ${varName} to ${h}`,
      `set minutes of ${varName} to ${min}`,
      `set seconds of ${varName} to ${s}`,
    ].join("\n");
  }

  /** Build the AppleScript id reference (`x-apple-reminder://<UUID>`) from a bare UUID. */
  static reminderIdRef(uuid: string): string {
    const u = uuid.trim();
    if (u.startsWith(REMINDER_ID_PREFIX)) return u;
    return `${REMINDER_ID_PREFIX}${u}`;
  }

  /**
   * Generate an AppleScript snippet that resolves a reminder reference into local variable `R`.
   * When `listName` is provided we scope the search to that list — Reminders.app's top-level
   * `whose id is` query scans every reminder in every list (~30 s on a 1500-row store) but
   * scoping it to one list is ~10× faster.
   *
   * Falls back to a global search if the list lookup misses (handles the rare case where the
   * reminder moved between lists since we read it from SQLite).
   */
  static resolveReminderBlock(uuid: string, listName?: string): string {
    const idRef = AppleScriptClient.escape(AppleScriptClient.reminderIdRef(uuid));
    if (!listName) {
      return `set R to first reminder whose id is ${idRef}`;
    }
    const list = AppleScriptClient.escape(listName);
    return `set _scopedList to first list whose name is ${list}
  set _matches to reminders of _scopedList whose id is ${idRef}
  if (count of _matches) > 0 then
    set R to item 1 of _matches
  else
    set R to first reminder whose id is ${idRef}
  end if`;
  }

  /** Pull the bare UUID out of an AppleScript reminder id. */
  static uuidFromReminderId(rid: string): string {
    const m = rid.match(UUID_RE);
    if (!m) throw new Error(`Could not extract UUID from AppleScript reminder id: ${rid}`);
    return m[0].toUpperCase();
  }

  /** Convert priority label → AppleScript numeric value. */
  static priorityInt(p: Priority): number {
    switch (p) {
      case "high":   return 1;
      case "medium": return 5;
      case "low":    return 9;
      case "none":   return 0;
    }
  }

  private hintForStderr(stderr: string): string | undefined {
    if (/-1743/.test(stderr) || /not authorized/i.test(stderr)) {
      return (
        "Reminders.app refused the request. Grant Automation permission: " +
        "System Settings → Privacy & Security → Automation → Claude → Reminders."
      );
    }
    if (/-600/.test(stderr) || /isn'?t running/i.test(stderr)) {
      return "Reminders.app isn't running. Open it once, then retry.";
    }
    if (/-1728/.test(stderr) || /Can[’']t get/.test(stderr)) {
      return "Target not found. The reminder/list may have been deleted, renamed, or moved.";
    }
    return undefined;
  }
}
