import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";

export const completeReminderInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder UUID from list_reminders / search_reminders / get_reminder."),
};

const inputSchema = z.object(completeReminderInputShape);
export type CompleteReminderInput = z.infer<typeof inputSchema>;

export const completeReminderDescription =
  "WRITES TO APPLE REMINDERS: marks the reminder as completed (sets `completed=true` and stamps " +
  "`completion_date` to now). Reversible via uncomplete_reminder. NOTE: completing a recurring " +
  "reminder spawns the next occurrence automatically — that's Apple's behavior.";

export async function completeReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
  input: CompleteReminderInput
): Promise<{ reminder: Reminder }> {
  console.error(`[WRITE] complete_reminder ${JSON.stringify({ id: input.id })}`);

  const before = sqlite.reminder(input.id);
  if (!before) throw new Error(`Reminder '${input.id}' not found.`);

  const resolveBlock = AppleScriptClient.resolveReminderBlock(input.id, before.list_name || undefined);
  const script = `tell application "Reminders"
  ${resolveBlock}
  set completed of R to true
  return id of R as text
end tell`;
  await applescript.run(script);

  const after = await sqlite.reminderWithRetry(input.id);
  if (!after) throw new Error(`Completed reminder ${input.id} but SQLite hasn't seen the commit yet.`);
  return { reminder: after };
}
