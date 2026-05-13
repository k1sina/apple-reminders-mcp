import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";
import { addTagsToTitle, removeTagsFromTitle } from "./hashtags.js";
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
      "Hashtag names to add (without `#`). Appended to the title as ` #tag` for any not already " +
      "present. Combined with `title`: tags are merged into the new title."
    ),
  remove_tags: z
    .array(z.string())
    .optional()
    .describe(
      "Hashtag names to remove (without `#`). Strips `#tag` tokens from the title. " +
      "Combined with `add_tags`: removals happen first, then additions."
    ),
};

const inputSchema = z.object(updateReminderInputShape);
export type UpdateReminderInput = z.infer<typeof inputSchema>;

export const updateReminderDescription =
  "WRITES TO APPLE REMINDERS: updates fields on an existing reminder (title, notes, priority, " +
  "due date, flagged, tags). Pass only the fields you want changed. " +
  "Use `add_tags` / `remove_tags` to toggle hashtags (they live as `#tag` suffixes in the title " +
  "— Reminders.app's auto-extraction handles the rest). `clear_due: true` is destructive — do " +
  "not call without explicit user intent. Returns the full updated Reminder.";

export async function updateReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
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

  // Resolve the effective title: caller-supplied or fall back to the existing one. We mutate it
  // for tag changes too — even when the caller didn't pass `title`, an add/remove_tags op needs
  // to write the modified title back.
  const baseTitle = input.title ?? before.title;
  const hasTagOps = (input.add_tags && input.add_tags.length > 0) ||
                    (input.remove_tags && input.remove_tags.length > 0);
  let nextTitle = baseTitle;
  if (input.remove_tags && input.remove_tags.length > 0) {
    nextTitle = removeTagsFromTitle(nextTitle, input.remove_tags);
  }
  if (input.add_tags && input.add_tags.length > 0) {
    nextTitle = addTagsToTitle(nextTitle, input.add_tags);
  }
  if (input.title !== undefined || (hasTagOps && nextTitle !== before.title)) {
    lines.push(`set name of R to ${AppleScriptClient.escape(nextTitle)}`);
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

  if (lines.length === 0) {
    // No-op — just return the current state.
    return { reminder: before };
  }

  const resolveBlock = AppleScriptClient.resolveReminderBlock(input.id, before.list_name || undefined);
  const script = `${dateBlock}tell application "Reminders"
  ${resolveBlock}
  ${lines.join("\n  ")}
  return id of R as text
end tell`;

  await applescript.run(script);

  // When tags changed, wait for the hashtag-extraction side-effect to land.
  const expectedTagPresence = input.add_tags ?? [];
  const after = expectedTagPresence.length > 0
    ? await sqlite.reminderWithTagWait(input.id, expectedTagPresence)
    : await sqlite.reminderWithRetry(input.id);
  if (!after) throw new Error(`Updated reminder ${input.id} but SQLite hasn't seen the commit yet.`);
  return { reminder: after };
}
