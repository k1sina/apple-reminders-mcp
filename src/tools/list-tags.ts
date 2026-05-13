import type { SqliteClient } from "../sqlite-client.js";

export const listTagsInputShape = {};

export const listTagsDescription =
  "Returns every distinct hashtag in use across all Reminders with a per-tag usage count, sorted " +
  "by count descending. Use this to discover the user's tag vocabulary before filtering with " +
  "list_reminders(tags: [...]).";

export async function listTags(
  sqlite: SqliteClient,
  _input: Record<string, never>
): Promise<{ tags: Array<{ tag: string; count: number }> }> {
  return { tags: sqlite.tagUsage() };
}
