import { z } from "zod";
import { ShortcutsError } from "../shortcuts-client.js";
import type { ShortcutsClient } from "../shortcuts-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";

export const setTagsInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder UUID from list_reminders / search_reminders / get_reminder."),
  add: z
    .array(z.string())
    .optional()
    .describe("Tag names to add (without `#`)."),
  remove: z
    .array(z.string())
    .optional()
    .describe("Tag names to remove (without `#`)."),
};

const inputSchema = z.object(setTagsInputShape);
export type SetTagsInput = z.infer<typeof inputSchema>;

export const setTagsDescription =
  "WRITES TO APPLE REMINDERS: adds and/or removes hashtags on a reminder. " +
  "Goes through the `Claude Reminder Tags` Apple Shortcut (see SHORTCUT_SETUP.md). " +
  "Tags are real hashtag rows — they appear in Reminders.app's UI and sync to iCloud. " +
  "Returns the full updated Reminder.";

export async function setTags(
  sqlite: SqliteClient,
  shortcuts: ShortcutsClient,
  input: SetTagsInput
): Promise<{ reminder: Reminder }> {
  console.error(`[WRITE] set_tags ${JSON.stringify({ id: input.id, add: input.add ?? [], remove: input.remove ?? [] })}`);

  const before = sqlite.reminder(input.id);
  if (!before) throw new Error(`Reminder '${input.id}' not found.`);

  const add = (input.add ?? []).filter((t) => t.trim().length > 0);
  const remove = (input.remove ?? []).filter((t) => t.trim().length > 0);
  if (add.length === 0 && remove.length === 0) return { reminder: before };

  try {
    await shortcuts.setTags(input.id, add, remove);
  } catch (err) {
    const reason = err instanceof ShortcutsError
      ? `${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`
      : err instanceof Error ? err.message : String(err);
    throw new Error(`Tag change on ${input.id} failed: ${reason}`);
  }

  const after = await sqlite.reminderWithTagWait(input.id, add, remove);
  if (!after) throw new Error(`Tag change on ${input.id} applied but SQLite hasn't caught up yet.`);
  return { reminder: after };
}
