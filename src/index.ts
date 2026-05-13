#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppleScriptClient } from "./applescript-client.js";
import { SqliteClient } from "./sqlite-client.js";
import {
  listLists,
  listListsDescription,
  listListsInputShape,
} from "./tools/list-lists.js";
import {
  listReminders,
  listRemindersDescription,
  listRemindersInputShape,
} from "./tools/list-reminders.js";
import {
  getReminder,
  getReminderDescription,
  getReminderInputShape,
} from "./tools/get-reminder.js";
import {
  searchReminders,
  searchRemindersDescription,
  searchRemindersInputShape,
} from "./tools/search-reminders.js";
import {
  listTags,
  listTagsDescription,
  listTagsInputShape,
} from "./tools/list-tags.js";
import {
  createReminder,
  createReminderDescription,
  createReminderInputShape,
} from "./tools/create-reminder.js";
import {
  updateReminder,
  updateReminderDescription,
  updateReminderInputShape,
} from "./tools/update-reminder.js";
import {
  completeReminder,
  completeReminderDescription,
  completeReminderInputShape,
} from "./tools/complete-reminder.js";
import {
  uncompleteReminder,
  uncompleteReminderDescription,
  uncompleteReminderInputShape,
} from "./tools/uncomplete-reminder.js";
import {
  deleteReminder,
  deleteReminderDescription,
  deleteReminderInputShape,
} from "./tools/delete-reminder.js";
import {
  moveReminder,
  moveReminderDescription,
  moveReminderInputShape,
} from "./tools/move-reminder.js";

async function main(): Promise<void> {
  let sqlite: SqliteClient;
  try {
    sqlite = SqliteClient.open();
  } catch (e) {
    console.error(`[apple-reminders-mcp] ${(e as Error).message}`);
    process.exit(1);
  }

  const files = sqlite.storeFilenames();
  const counts = sqlite.describe();
  const total = counts.reduce((acc, c) => acc + (c.counts.ZREMCDREMINDER ?? 0), 0);
  console.error(
    `[apple-reminders-mcp] Opened ${files.length} store(s): ${files.join(", ")} — ${total} reminder rows.`
  );

  const applescript = new AppleScriptClient(process.env.DEBUG === "1");

  const server = new McpServer({
    name: "apple-reminders-mcp",
    version: "0.1.0",
  });

  function ok<T>(data: T) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  server.registerTool(
    "list_lists",
    {
      description: listListsDescription,
      inputSchema: listListsInputShape,
    },
    async (input) => ok(await listLists(sqlite, input))
  );

  server.registerTool(
    "list_reminders",
    {
      description: listRemindersDescription,
      inputSchema: listRemindersInputShape,
    },
    async (input) => ok(await listReminders(sqlite, input))
  );

  server.registerTool(
    "get_reminder",
    {
      description: getReminderDescription,
      inputSchema: getReminderInputShape,
    },
    async (input) => ok(await getReminder(sqlite, input))
  );

  server.registerTool(
    "search_reminders",
    {
      description: searchRemindersDescription,
      inputSchema: searchRemindersInputShape,
    },
    async (input) => ok(await searchReminders(sqlite, input))
  );

  server.registerTool(
    "list_tags",
    {
      description: listTagsDescription,
      inputSchema: listTagsInputShape,
    },
    async (input) => ok(await listTags(sqlite, input))
  );

  server.registerTool(
    "describe_stores",
    {
      description:
        "Diagnostic: returns the SQLite store files this server has opened and their row counts. " +
        "Useful when troubleshooting a missing list or reminder.",
      inputSchema: {},
    },
    async () => ok({ stores: sqlite.describe() })
  );

  // ---------- WRITE TOOLS ----------

  server.registerTool(
    "create_reminder",
    { description: createReminderDescription, inputSchema: createReminderInputShape },
    async (input) => ok(await createReminder(sqlite, applescript, input))
  );

  server.registerTool(
    "update_reminder",
    { description: updateReminderDescription, inputSchema: updateReminderInputShape },
    async (input) => ok(await updateReminder(sqlite, applescript, input))
  );

  server.registerTool(
    "complete_reminder",
    { description: completeReminderDescription, inputSchema: completeReminderInputShape },
    async (input) => ok(await completeReminder(sqlite, applescript, input))
  );

  server.registerTool(
    "uncomplete_reminder",
    { description: uncompleteReminderDescription, inputSchema: uncompleteReminderInputShape },
    async (input) => ok(await uncompleteReminder(sqlite, applescript, input))
  );

  server.registerTool(
    "delete_reminder",
    { description: deleteReminderDescription, inputSchema: deleteReminderInputShape },
    async (input) => ok(await deleteReminder(sqlite, applescript, input))
  );

  server.registerTool(
    "move_reminder",
    { description: moveReminderDescription, inputSchema: moveReminderInputShape },
    async (input) => ok(await moveReminder(sqlite, applescript, input))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[apple-reminders-mcp] Listening on stdio.");
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[apple-reminders-mcp] Fatal: ${reason}`);
  process.exit(1);
});
