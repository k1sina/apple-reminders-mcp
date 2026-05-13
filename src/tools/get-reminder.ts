import { z } from "zod";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder, ReminderWithSubtasks } from "../types.js";

export const getReminderInputShape = {
  id: z
    .string()
    .min(1)
    .describe("Reminder id (UUID) from list_reminders / search_reminders."),
  include_subtask_tree: z
    .boolean()
    .optional()
    .describe(
      "When true (default), recursively inlines the full subtask tree under `subtasks: Reminder[]`. " +
      "When false, returns only `subtask_ids[]`."
    ),
};

const inputSchema = z.object(getReminderInputShape);
export type GetReminderInput = z.infer<typeof inputSchema>;

export const getReminderDescription =
  "Returns a single reminder by UUID with notes, priority, due date, tags, flagged state, and (by " +
  "default) the full subtask tree expanded under `subtasks`. Use this after list_reminders or " +
  "search_reminders narrows things down to a single match.";

export async function getReminder(
  sqlite: SqliteClient,
  input: GetReminderInput
): Promise<{ reminder: Reminder | ReminderWithSubtasks }> {
  const includeTree = input.include_subtask_tree ?? true;
  const self = sqlite.reminder(input.id);
  if (!self) throw new Error(`Reminder '${input.id}' not found.`);

  if (!includeTree || self.subtask_ids.length === 0) {
    return { reminder: self };
  }

  const all = sqlite.reminders({ listId: self.list_id, status: "all" });
  const byId = new Map<string, Reminder>(all.map((r) => [r.id, r]));

  return { reminder: buildTree(self.id, byId) };
}

function buildTree(id: string, byId: Map<string, Reminder>): ReminderWithSubtasks {
  const r = byId.get(id);
  if (!r) throw new Error(`Reminder ${id} not found while building subtask tree.`);
  const { subtask_ids, ...rest } = r;
  return {
    ...rest,
    subtasks: subtask_ids.map((childId) => buildTree(childId, byId)),
  };
}
