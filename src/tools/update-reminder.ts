import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { ShortcutsClient } from "../shortcuts-client.js";
import { ShortcutsError } from "../shortcuts-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";
import { PRIORITY_VALUES, parseDueInput } from "./shared.js";

export const updateReminderInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder UUID from list_reminders / search_reminders / get_reminder."),
  title: z
    .string()
    .min(1)
    .optional()
    .describe("New title."),
  notes: z
    .string()
    .optional()
    .describe("Replace the notes body. Pass an empty string to clear."),
  priority: z
    .enum(PRIORITY_VALUES)
    .optional()
    .describe("Priority. Pass 'none' to clear."),
  due: z
    .string()
    .optional()
    .describe("New due date — ISO 8601 (timed) or `YYYY-MM-DD` (all-day)."),
  due_all_day: z
    .boolean()
    .optional()
    .describe("Force all-day interpretation for the `due` input. Auto-inferred otherwise."),
  flagged: z
    .boolean()
    .optional()
    .describe("Toggle the flagged state."),
  clear_due: z
    .boolean()
    .optional()
    .describe(
      "DESTRUCTIVE — clears the due date (sets to missing value). Cannot be combined with `due`."
    ),
  add_tags: z
    .array(z.string())
    .optional()
    .describe(
      "Hashtag names to add (without `#`). Applied via the `Claude Reminder Tags` Apple Shortcut. " +
      "Requires the Shortcut to be installed (see SHORTCUT_SETUP.md)."
    ),
  remove_tags: z
    .array(z.string())
    .optional()
    .describe(
      "Hashtag names to remove (without `#`). Applied via the same Shortcut as add_tags. " +
      "Same tag in both add_tags and remove_tags resolves as: removes happen first, then adds " +
      "(so the tag ends up added)."
    ),
};

const inputSchema = z.object(updateReminderInputShape);
export type UpdateReminderInput = z.infer<typeof inputSchema>;

export const updateReminderDescription =
  "WRITES TO APPLE REMINDERS: updates fields on an existing reminder (title, notes, priority, " +
  "due date, flagged, tags). Pass only the fields you want changed. `clear_due: true` is destructive — " +
  "do not call without explicit user intent. Returns the full updated Reminder. " +
  "Tag changes (`add_tags`/`remove_tags`) route through an Apple Shortcut — see SHORTCUT_SETUP.md.";

export async function updateReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
  shortcuts: ShortcutsClient,
  input: UpdateReminderInput
): Promise<{ reminder: Reminder }> {
  console.error(`[WRITE] update_reminder ${JSON.stringify({ id: input.id, keys: Object.keys(input).filter((k) => k !== "id") })}`);

  if (input.clear_due && input.due) {
    throw new Error("`clear_due` and `due` are mutually exclusive — pass one or the other.");
  }

  const before = sqlite.reminder(input.id);
  if (!before) throw new Error(`Reminder '${input.id}' not found.`);

  // Build a series of `set X of R to Y` lines.
  const lines: string[] = [];
  let dateBlock = "";

  if (input.title !== undefined) {
    lines.push(`set name of R to ${AppleScriptClient.escape(input.title)}`);
  }
  if (input.notes !== undefined) {
    lines.push(`set body of R to ${AppleScriptClient.escape(input.notes)}`);
  }
  if (input.priority !== undefined) {
    lines.push(`set priority of R to ${AppleScriptClient.priorityInt(input.priority)}`);
  }
  if (input.flagged !== undefined) {
    lines.push(`set flagged of R to ${input.flagged ? "true" : "false"}`);
  }
  if (input.clear_due === true) {
    // Clearing both forms covers all-day and timed variants — Reminders accepts either.
    lines.push(`set due date of R to missing value`);
    lines.push(`try`);
    lines.push(`  set allday due date of R to missing value`);
    lines.push(`end try`);
  }
  if (input.due) {
    const { date, allDay } = parseDueInput(input.due, input.due_all_day);
    dateBlock = AppleScriptClient.dateBlock("d", date, allDay) + "\n";
    const prop = allDay ? "allday due date" : "due date";
    lines.push(`set ${prop} of R to d`);
  }

  const addTags = (input.add_tags ?? []).filter((t) => t.trim().length > 0);
  const removeTags = (input.remove_tags ?? []).filter((t) => t.trim().length > 0);
  const hasTagChanges = addTags.length > 0 || removeTags.length > 0;

  // AppleScript side first (title/notes/priority/due/flagged).
  if (lines.length > 0) {
    const resolveBlock = AppleScriptClient.resolveReminderBlock(input.id, before.list_name || undefined);
    const script = `${dateBlock}tell application "Reminders"
  ${resolveBlock}
  ${lines.join("\n  ")}
  return id of R as text
end tell`;
    await applescript.run(script);
  } else if (!hasTagChanges) {
    // Nothing at all to do — return current state.
    return { reminder: before };
  }

  // Tag changes via the Shortcut (separate pipeline).
  if (hasTagChanges) {
    try {
      await shortcuts.setTags(input.id, addTags, removeTags);
    } catch (err) {
      const reason = err instanceof ShortcutsError
        ? `${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`
        : err instanceof Error ? err.message : String(err);
      throw new Error(
        `Tag change on reminder ${input.id} failed: ${reason}\n` +
        `Other updates (title/notes/etc.) already applied.`
      );
    }
  }

  const after = hasTagChanges
    ? await sqlite.reminderWithTagWait(input.id, addTags, removeTags)
    : await sqlite.reminderWithRetry(input.id);
  if (!after) throw new Error(`Updated reminder ${input.id} but SQLite hasn't seen the commit yet.`);
  return { reminder: after };
}
