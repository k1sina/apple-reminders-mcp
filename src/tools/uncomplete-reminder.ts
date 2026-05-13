import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";

export const uncompleteReminderInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder UUID."),
};

const inputSchema = z.object(uncompleteReminderInputShape);
export type UncompleteReminderInput = z.infer<typeof inputSchema>;

export const uncompleteReminderDescription =
  "WRITES TO APPLE REMINDERS: re-opens a completed reminder (sets `completed=false`, clears " +
  "`completion_date`).";

export async function uncompleteReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
  input: UncompleteReminderInput
): Promise<{ reminder: Reminder }> {
  console.error(`[WRITE] uncomplete_reminder ${JSON.stringify({ id: input.id })}`);

  const before = sqlite.reminder(input.id);
  if (!before) throw new Error(`Reminder '${input.id}' not found.`);

  const resolveBlock = AppleScriptClient.resolveReminderBlock(input.id, before.list_name || undefined);
  const script = `tell application "Reminders"
  ${resolveBlock}
  set completed of R to false
  return id of R as text
end tell`;
  await applescript.run(script);

  const after = await sqlite.reminderWithRetry(input.id);
  if (!after) throw new Error(`Reopened reminder ${input.id} but SQLite hasn't seen the commit yet.`);
  return { reminder: after };
}
