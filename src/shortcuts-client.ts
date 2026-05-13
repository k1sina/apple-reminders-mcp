import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

const SHORTCUT_NAME_DEFAULT = "Claude Reminder Tags";

export class ShortcutsError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ShortcutsError";
  }
}

/**
 * Thin wrapper around macOS's `shortcuts` CLI.
 *
 * The MCP relies on a user-authored Shortcut named `Claude Reminder Tags` (configurable via
 * `SHORTCUT_TAG_NAME`) that consumes a JSON dictionary like
 *
 *     { "reminder_id": "<UUID>", "add": ["foo","bar"], "remove": ["baz"] }
 *
 * and applies the tag changes via Apple's first-party "Add Tag"/"Remove Tag" actions, which go
 * through Reminders.app's CoreData stack — the only path that actually creates real hashtag rows
 * the UI and CloudKit see.
 *
 * Setup instructions live in SHORTCUT_SETUP.md.
 */
export class ShortcutsClient {
  constructor(readonly shortcutName: string = ShortcutsClient.resolveDefaultName()) {}

  static resolveDefaultName(): string {
    return process.env.SHORTCUT_TAG_NAME?.trim() || SHORTCUT_NAME_DEFAULT;
  }

  /**
   * Return true if the named Shortcut is installed. Used at MCP startup to surface a warning when
   * the user hasn't followed SHORTCUT_SETUP.md — read tools and AppleScript-based writes still
   * work, only tag args become unavailable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileP("/usr/bin/shortcuts", ["list"], { timeout: 5_000 });
      return stdout.split(/\r?\n/).some((name) => name.trim() === this.shortcutName);
    } catch {
      return false;
    }
  }

  /**
   * Invoke the tag Shortcut. Resolves on exit 0; rejects with a hinted ShortcutsError otherwise.
   *
   * The input JSON is written to a temp file because `shortcuts run` doesn't accept stdin or
   * `--input` text directly — only `--input-path <file>`.
   */
  async setTags(reminderUuid: string, addTags: string[], removeTags: string[]): Promise<void> {
    if (addTags.length === 0 && removeTags.length === 0) return;

    const payload = JSON.stringify({
      reminder_id: reminderUuid,
      add: addTags.map(stripHashPrefix).filter((t) => t.length > 0),
      remove: removeTags.map(stripHashPrefix).filter((t) => t.length > 0),
    });

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "apple-reminders-mcp-"));
    const inputFile = path.join(tmpDir, "input.json");
    try {
      await fs.promises.writeFile(inputFile, payload, "utf8");
      await this.runShortcut(inputFile);
    } finally {
      // Best-effort cleanup; ignore unlink failures (e.g. file already gone on EPERM).
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  private runShortcut(inputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/shortcuts", [
        "run",
        this.shortcutName,
        "--input-path", inputFile,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
      child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
      child.once("error", (err) => {
        reject(new ShortcutsError(`Failed to spawn 'shortcuts': ${err.message}`, "", null));
      });
      child.once("close", (code) => {
        if (code === 0) { resolve(); return; }

        const combined = (stderr.trim() || stdout.trim() || `exit ${code}`);
        let hint: string | undefined;
        if (/not found|no shortcut/i.test(combined)) {
          hint = `Shortcut "${this.shortcutName}" not found. Follow SHORTCUT_SETUP.md to create it ` +
            `(takes ~5 min), or set SHORTCUT_TAG_NAME to override the expected name.`;
        }
        reject(new ShortcutsError(combined, stderr, code, hint));
      });
    });
  }
}

function stripHashPrefix(s: string): string {
  const trimmed = s.trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}
