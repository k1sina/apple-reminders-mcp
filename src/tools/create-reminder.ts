import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";
import { addTagsToTitle } from "./hashtags.js";
import { PRIORITY_VALUES, parseDueInput } from "./shared.js";

export const createReminderInputShape = {
  list: z
    .string()
    .min(1)
    .describe("Target list — exact UUID or case-insensitive name. Use list_lists to discover."),
  title: z
    .string()
    .min(1)
    .describe("Reminder title (required)."),
  notes: z
    .string()
    .optional()
    .describe("Body notes. Multi-line OK."),
  priority: z
    .enum(PRIORITY_VALUES)
    .optional()
    .describe("Priority. 'none' (default), 'high', 'medium', or 'low'."),
  due: z
    .string()
    .optional()
    .describe(
      "Due date. ISO 8601 (`2026-05-15T14:00:00`) for timed reminders, or `YYYY-MM-DD` for all-day. " +
      "Local timezone is assumed when no offset is provided."
    ),
  due_all_day: z
    .boolean()
    .optional()
    .describe("Force all-day interpretation. Auto-inferred from the `due` format if omitted."),
  flagged: z
    .boolean()
    .optional()
    .describe("Mark the reminder as flagged."),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Hashtag names (without `#`). Each is appended to the title as ` #tag` if not already " +
      "present. Reminders.app auto-extracts them into proper hashtag rows."
    ),
};

const inputSchema = z.object(createReminderInputShape);
export type CreateReminderInput = z.infer<typeof inputSchema>;

export const createReminderDescription =
  "WRITES TO APPLE REMINDERS: creates a new reminder in the given list. Pass `tags` to apply " +
  "hashtags (they become visible as `#tag` suffixes in the title — Reminders.app's normal " +
  "behavior). Returns the full Reminder object. Do not call without explicit user intent.";

export async function createReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
  input: CreateReminderInput
): Promise<{ reminder: Reminder }> {
  console.error(`[WRITE] create_reminder ${JSON.stringify({ list: input.list, title: input.title })}`);

  const list = sqlite.findListByNameOrUuid(input.list);
  if (!list) {
    const known = sqlite.lists().map((l) => l.name).join(", ");
    throw new Error(`List '${input.list}' not found. Known lists: ${known || "(none)"}`);
  }

  // Apply tags by interpolating them into the title — Reminders.app extracts `#token`
  // patterns on save into ZREMCDHASHTAG rows.
  const titleWithTags = input.tags && input.tags.length > 0
    ? addTagsToTitle(input.title, input.tags)
    : input.title;

  // Build the `with properties { ... }` clause.
  const props: string[] = [`name:${AppleScriptClient.escape(titleWithTags)}`];
  if (input.notes !== undefined && input.notes !== "") {
    props.push(`body:${AppleScriptClient.escape(input.notes)}`);
  }
  if (input.priority !== undefined && input.priority !== "none") {
    props.push(`priority:${AppleScriptClient.priorityInt(input.priority)}`);
  }
  if (input.flagged === true) {
    // `flagged` is a property on `reminder` since macOS 14; if it isn't recognised on this OS,
    // osascript will surface the error and we'll fall back without it.
    props.push("flagged:true");
  }

  // Date block (locale-safe) — referenced from the properties via a variable.
  let dateBlock = "";
  if (input.due) {
    const { date, allDay } = parseDueInput(input.due, input.due_all_day);
    dateBlock = AppleScriptClient.dateBlock("d", date, allDay) + "\n";
    const prop = allDay ? "allday due date" : "due date";
    props.push(`${prop}:d`);
  }

  const escapedListName = AppleScriptClient.escape(list.name);
  const script = `${dateBlock}tell application "Reminders"
  set L to first list whose name is ${escapedListName}
  set R to make new reminder at end of L with properties {${props.join(", ")}}
  return id of R as text
end tell`;

  const newId = await applescript.run(script);
  const uuid = AppleScriptClient.uuidFromReminderId(newId);

  // If tags were requested, give Reminders.app a moment to materialise its hashtag rows.
  const reminder = input.tags && input.tags.length > 0
    ? await sqlite.reminderWithTagWait(uuid, input.tags)
    : await sqlite.reminderWithRetry(uuid);
  if (!reminder) {
    throw new Error(
      `Created reminder ${uuid} but SQLite hasn't seen it yet. ` +
      `Try list_reminders shortly — Reminders.app may still be syncing.`
    );
  }
  return { reminder };
}
