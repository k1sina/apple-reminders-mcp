import { z } from "zod";
import { AppleScriptClient } from "../applescript-client.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";

export const moveReminderInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder UUID."),
  to_list: z
    .string()
    .min(1)
    .describe("Destination list — exact UUID or case-insensitive name."),
};

const inputSchema = z.object(moveReminderInputShape);
export type MoveReminderInput = z.infer<typeof inputSchema>;

export const moveReminderDescription =
  "WRITES TO APPLE REMINDERS: moves a reminder to a different list. Mildly destructive — do not " +
  "call without explicit user intent. Returns the full updated Reminder.";

export async function moveReminder(
  sqlite: SqliteClient,
  applescript: AppleScriptClient,
  input: MoveReminderInput
): Promise<{ reminder: Reminder }> {
  console.error(`[WRITE] move_reminder ${JSON.stringify({ id: input.id, to_list: input.to_list })}`);

  const before = sqlite.reminder(input.id);
  if (!before) throw new Error(`Reminder '${input.id}' not found.`);

  const dest = sqlite.findListByNameOrUuid(input.to_list);
  if (!dest) {
    const known = sqlite.lists().map((l) => l.name).join(", ");
    throw new Error(`List '${input.to_list}' not found. Known lists: ${known || "(none)"}`);
  }
  if (dest.id === before.list_id) {
    // No-op — already there.
    return { reminder: before };
  }

  const resolveBlock = AppleScriptClient.resolveReminderBlock(input.id, before.list_name || undefined);
  const destName = AppleScriptClient.escape(dest.name);
  // AppleScript supports `move <reminder> to <list>` since macOS 13.
  const script = `tell application "Reminders"
  ${resolveBlock}
  set L to first list whose name is ${destName}
  move R to L
  return id of R as text
end tell`;
  await applescript.run(script);

  const after = await sqlite.reminderWithRetry(input.id);
  if (!after) throw new Error(`Moved reminder ${input.id} but SQLite hasn't seen the commit yet.`);
  return { reminder: after };
}
