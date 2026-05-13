import type { SqliteClient } from "../sqlite-client.js";
import type { List } from "../types.js";

export const listListsInputShape = {};

export const listListsDescription =
  "Lists every Reminders list across every account on this Mac, with section structure included. " +
  "Returns id (UUID), name, color, source, allows_modifications, and sections[]. Use the returned " +
  "id (or name) as the `list` argument to list_reminders. Smart lists are excluded.";

export async function listLists(
  sqlite: SqliteClient,
  _input: Record<string, never>
): Promise<{ lists: List[] }> {
  return { lists: sqlite.lists() };
}
