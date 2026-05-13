import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { SqliteClient } from "../sqlite-client.js";

export const deleteReminderInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder UUID."),
};

const inputSchema = z.object(deleteReminderInputShape);
export type DeleteReminderInput = z.infer<typeof inputSchema>;

export const deleteReminderDescription =
  "DESTRUCTIVE — DELETES A REMINDER permanently. Do not call without explicit user intent. " +
  "Returns the deleted reminder's id and title so the caller can confirm to the user.";

export async function deleteReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
  input: DeleteReminderInput
): Promise<{ ok: true; id: string; title: string }> {
  console.error(`[WRITE] delete_reminder ${JSON.stringify({ id: input.id })}`);

  const before = sqlite.reminder(input.id);
  if (!before) throw new Error(`Reminder '${input.id}' not found.`);

  const resolveBlock = AppleScriptClient.resolveReminderBlock(input.id, before.list_name || undefined);
  const script = `tell application "Reminders"
  ${resolveBlock}
  delete R
  return "deleted"
end tell`;
  await applescript.run(script);

  return { ok: true, id: input.id, title: before.title };
}
