#!/usr/bin/env node
// End-to-end test of every write tool against the LIVE Reminders database.
// Creates a throwaway list, exercises each operation, asserts SQLite state, then tears down.
// Run after `npm run build`. Requires Automation permission for Reminders.app.

import { AppleScriptClient } from "../dist/applescript-client.js";
import { SqliteClient } from "../dist/sqlite-client.js";
import { createReminder } from "../dist/tools/create-reminder.js";
import { updateReminder } from "../dist/tools/update-reminder.js";
import { completeReminder } from "../dist/tools/complete-reminder.js";
import { uncompleteReminder } from "../dist/tools/uncomplete-reminder.js";
import { deleteReminder } from "../dist/tools/delete-reminder.js";
import { moveReminder } from "../dist/tools/move-reminder.js";

const sqlite = SqliteClient.open();
const applescript = new AppleScriptClient(process.env.DEBUG === "1");

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const LIST_A = `Claude MCP Test A ${stamp}`;
const LIST_B = `Claude MCP Test B ${stamp}`;
let passed = 0;
let failed = 0;

function assert(cond, label, detail = "") {
  if (cond) {
    console.log(`PASS  ${label}`);
    passed++;
  } else {
    console.log(`FAIL  ${label}${detail ? "  →  " + detail : ""}`);
    failed++;
  }
}

async function createList(name) {
  await applescript.run(`tell application "Reminders"
  make new list with properties {name:"${name}"}
end tell`);
}

async function deleteList(name) {
  try {
    await applescript.run(`tell application "Reminders"
  delete (first list whose name is "${name}")
end tell`);
  } catch (e) {
    // Ignore — list may already be gone or never created.
  }
}

async function waitForListInSqlite(name, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const found = sqlite.lists().find((l) => l.name === name);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`SQLite never saw list "${name}"`);
}

try {
  console.log(`Using throwaway lists: "${LIST_A}", "${LIST_B}"`);

  await createList(LIST_A);
  await waitForListInSqlite(LIST_A);
  await createList(LIST_B);
  await waitForListInSqlite(LIST_B);

  // 1. create_reminder
  const c1 = await createReminder(sqlite, applescript, {
    list: LIST_A,
    title: "Smoke #1 (basic)",
    notes: "Multi-line\nnote\nbody",
    priority: "high",
    flagged: true,
  });
  assert(c1.reminder.title === "Smoke #1 (basic)", "create_reminder: title");
  assert(c1.reminder.notes === "Multi-line\nnote\nbody", "create_reminder: notes (multiline)");
  assert(c1.reminder.priority === "high", "create_reminder: priority");
  assert(c1.reminder.flagged === true, "create_reminder: flagged");
  assert(c1.reminder.list_name === LIST_A, "create_reminder: in target list");

  // 2. create_reminder with all-day due date
  const c2 = await createReminder(sqlite, applescript, {
    list: LIST_A,
    title: "Smoke #2 (due all-day)",
    due: "2026-12-25",
  });
  assert(c2.reminder.due === "2026-12-25", "create_reminder: all-day due", c2.reminder.due);
  assert(c2.reminder.due_all_day === true, "create_reminder: due_all_day=true");

  // 3. create_reminder with timed due
  const c3 = await createReminder(sqlite, applescript, {
    list: LIST_A,
    title: "Smoke #3 (timed due)",
    due: "2026-11-15T14:30:00",
  });
  assert(c3.reminder.due_all_day === false, "create_reminder: due_all_day=false for timed");
  assert(typeof c3.reminder.due === "string" && c3.reminder.due.includes("T"), "create_reminder: timed due ISO");

  // 4. update_reminder — rename + change priority
  const u1 = await updateReminder(sqlite, applescript, {
    id: c1.reminder.id,
    title: "Smoke #1 (renamed)",
    priority: "low",
  });
  assert(u1.reminder.title === "Smoke #1 (renamed)", "update_reminder: rename");
  assert(u1.reminder.priority === "low", "update_reminder: priority change");
  assert(u1.reminder.flagged === true, "update_reminder: unspecified field preserved (flagged)");

  // 5. update_reminder — clear_due
  const u2 = await updateReminder(sqlite, applescript, {
    id: c2.reminder.id,
    clear_due: true,
  });
  assert(u2.reminder.due === null, "update_reminder: clear_due", `got ${u2.reminder.due}`);

  // 6. complete_reminder
  const cm1 = await completeReminder(sqlite, applescript, { id: c1.reminder.id });
  assert(cm1.reminder.completed === true, "complete_reminder: completed=true");
  assert(cm1.reminder.completion_date !== null, "complete_reminder: completion_date populated");

  // 7. uncomplete_reminder
  const uc1 = await uncompleteReminder(sqlite, applescript, { id: c1.reminder.id });
  assert(uc1.reminder.completed === false, "uncomplete_reminder: completed=false");

  // 8. move_reminder
  const mv1 = await moveReminder(sqlite, applescript, {
    id: c3.reminder.id,
    to_list: LIST_B,
  });
  assert(mv1.reminder.list_name === LIST_B, "move_reminder: list_name updated", mv1.reminder.list_name);

  // 9. delete_reminder
  const del1 = await deleteReminder(sqlite, applescript, { id: c2.reminder.id });
  assert(del1.ok === true && del1.id === c2.reminder.id, "delete_reminder: returns ok + id");
  // Confirm it's actually gone — wait briefly for the WAL to flush.
  await new Promise((r) => setTimeout(r, 300));
  assert(sqlite.reminder(c2.reminder.id) === null, "delete_reminder: gone from SQLite");
} catch (e) {
  console.log(`FAIL  unhandled error: ${e.message}`);
  failed++;
} finally {
  console.log("\n--- teardown ---");
  await deleteList(LIST_A);
  await deleteList(LIST_B);
}

console.log(`\nResults: ${passed} pass, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
