import { z } from "zod";
import type { SqliteClient } from "../sqlite-client.js";
import type { Reminder } from "../types.js";
import {
  matchesDueFilter,
  matchesPriority,
  matchesStatus,
  matchesTags,
  sortReminders,
  PRIORITY_VALUES,
} from "./shared.js";

export const listRemindersInputShape = {
  list: z
    .string()
    .optional()
    .describe(
      "List name (case-insensitive) or list id (UUID) from list_lists. Omit to search across every list."
    ),
  section: z
    .string()
    .optional()
    .describe("Section name or section id (UUID) within the list. Only matches reminders that belong to that section."),
  status: z
    .enum(["open", "completed", "all"])
    .optional()
    .describe("Filter by completion state. Default: 'open'."),
  due: z
    .enum(["overdue", "today", "this_week", "no_date", "any"])
    .optional()
    .describe(
      "Due-date filter. 'overdue' = past due and not completed. 'today' = due between today's start and end. " +
      "'this_week' = due before next Monday 00:00 local. 'no_date' = reminders with no due date. " +
      "'any' or omit = no filter."
    ),
  priority: z
    .enum(PRIORITY_VALUES)
    .optional()
    .describe("Filter by priority. 'none' matches reminders with no priority set."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tag names (without leading #). Reminder is included if ANY of the listed tags matches."),
  include_subtasks: z
    .boolean()
    .optional()
    .describe(
      "When true (default), every reminder is returned with its subtask_ids[] populated and subtasks themselves " +
      "appear in the result list. When false, subtasks are filtered out — only top-level reminders are returned."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum number of reminders to return after filtering and sorting. Default 100, max 500."),
};

const inputSchema = z.object(listRemindersInputShape);
export type ListRemindersInput = z.infer<typeof inputSchema>;

export const listRemindersDescription =
  "Reads reminders from Apple Reminders with filters. Returns full reminder objects: id (UUID), list_id, " +
  "list_name, section_id, title, notes, priority (none/high/medium/low), due (ISO 8601 timed or YYYY-MM-DD all-day), " +
  "due_all_day, completed, completion_date, creation_date, modification_date, flagged, url, parent_id, " +
  "subtask_ids[], tags[]. Sort order: overdue first → ascending due → undated last.";

export async function listReminders(
  sqlite: SqliteClient,
  input: ListRemindersInput
): Promise<{ reminders: Reminder[]; total: number; truncated: boolean }> {
  const limit = input.limit ?? 100;
  const status = input.status ?? "open";
  const includeSubtasks = input.include_subtasks ?? true;

  // Resolve list filter (name OR uuid) into a UUID.
  let listUuid: string | undefined = undefined;
  if (input.list) {
    const lists = sqlite.lists();
    const match =
      lists.find((l) => l.id === input.list) ??
      lists.find((l) => l.name.toLowerCase() === input.list!.toLowerCase());
    if (!match) {
      const names = lists.map((l) => l.name).join(", ");
      throw new Error(`List '${input.list}' not found. Known lists: ${names || "(none)"}`);
    }
    listUuid = match.id;
  }

  let reminders = sqlite.reminders({ listId: listUuid, status });

  // Resolve section filter (name OR uuid).
  let sectionUuid: string | null = null;
  if (input.section) {
    const candidate = input.section;
    if (reminders.some((r) => r.section_id === candidate)) {
      sectionUuid = candidate;
    } else {
      const lists = sqlite.lists();
      for (const l of lists) {
        const s = l.sections.find(
          (sec) => sec.id === candidate || sec.name.toLowerCase() === candidate.toLowerCase()
        );
        if (s) { sectionUuid = s.id; break; }
      }
    }
    if (!sectionUuid) {
      throw new Error(`Section '${input.section}' not found. Run list_lists to see available sections.`);
    }
  }

  reminders = reminders.filter((r) =>
    matchesStatus(r, status) &&
    matchesDueFilter(r, input.due ?? "any") &&
    matchesPriority(r, input.priority) &&
    matchesTags(r, input.tags) &&
    (sectionUuid === null || r.section_id === sectionUuid)
  );

  if (!includeSubtasks) {
    reminders = reminders.filter((r) => r.parent_id === null);
  }

  const sorted = sortReminders(reminders);
  const truncated = sorted.length > limit;
  return { reminders: sorted.slice(0, limit), total: sorted.length, truncated };
}
