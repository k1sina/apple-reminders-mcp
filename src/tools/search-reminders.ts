import { z } from "zod";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";
import { matchesStatus, sortReminders } from "./shared.js";

export const searchRemindersInputShape = {
  query: z
    .string()
    .min(1)
    .describe("Substring to match against title and notes (case-insensitive)."),
  status: z
    .enum(["open", "completed", "all"])
    .optional()
    .describe("Filter by completion state. Default: 'open'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum results. Default 50, max 500."),
};

const inputSchema = z.object(searchRemindersInputShape);
export type SearchRemindersInput = z.infer<typeof inputSchema>;

export const searchRemindersDescription =
  "Case-insensitive substring search across reminder titles and notes in every list. Returns the " +
  "same full Reminder shape as list_reminders. Useful when you don't know which list a reminder lives in.";

export async function searchReminders(
  sqlite: SqliteClient,
  input: SearchRemindersInput
): Promise<{ reminders: Reminder[]; total: number; truncated: boolean }> {
  const limit = input.limit ?? 50;
  const status = input.status ?? "open";
  const q = input.query.toLowerCase();

  const all = sqlite.reminders({ status });
  const matches = all.filter((r) =>
    matchesStatus(r, status) &&
    (r.title.toLowerCase().includes(q) || (r.notes ?? "").toLowerCase().includes(q))
  );
  const sorted = sortReminders(matches);
  const truncated = sorted.length > limit;
  return { reminders: sorted.slice(0, limit), total: sorted.length, truncated };
}
