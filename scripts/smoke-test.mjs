#!/usr/bin/env node
// Quick end-to-end check against the live Reminders SQLite. Prints summary; non-zero exit on error.
import { SqliteClient } from "../dist/sqlite-client.js";

const sqlite = SqliteClient.open();

console.log("=== Stores ===");
console.log(JSON.stringify(sqlite.describe(), null, 2));

console.log("\n=== Lists ===");
const lists = sqlite.lists();
for (const l of lists) {
  console.log(`- ${l.name} (${l.id.slice(0, 8)}…) — ${l.sections.length} section(s)`);
  for (const s of l.sections) console.log(`    · ${s.name}`);
}

console.log(`\n=== Tag vocabulary ===`);
const tags = sqlite.tagUsage();
console.log(tags.map((t) => `${t.tag}(${t.count})`).join(", "));

console.log("\n=== Open reminders summary ===");
const open = sqlite.reminders({ status: "open" });
console.log(`Total open: ${open.length}`);
const overdue = open.filter((r) => {
  if (!r.due) return false;
  return new Date(r.due).getTime() < Date.now();
});
console.log(`Overdue: ${overdue.length}`);
const withSubtasks = open.filter((r) => r.subtask_ids.length > 0);
console.log(`Have subtasks: ${withSubtasks.length}`);
const tagged = open.filter((r) => r.tags.length > 0);
console.log(`Tagged: ${tagged.length}`);
const sectioned = open.filter((r) => r.section_id !== null);
console.log(`In sections: ${sectioned.length}`);

console.log("\n=== Sample tagged reminder ===");
if (tagged.length > 0) {
  console.log(JSON.stringify(tagged[0], null, 2));
}

console.log("\n=== Sample reminder with subtasks ===");
if (withSubtasks.length > 0) {
  const parent = withSubtasks[0];
  console.log(`Parent: ${parent.title} — has ${parent.subtask_ids.length} subtasks`);
  const subs = sqlite.reminders({ status: "all" }).filter((r) => parent.subtask_ids.includes(r.id));
  for (const s of subs) console.log(`  · ${s.title} (completed=${s.completed})`);
}

console.log("\n=== Sample sectioned reminder ===");
if (sectioned.length > 0) {
  const s = sectioned[0];
  const list = lists.find((l) => l.id === s.list_id);
  const section = list?.sections.find((sec) => sec.id === s.section_id);
  console.log(`${s.title} — list=${list?.name}, section=${section?.name ?? "(unknown)"}`);
}

console.log("\nOK");
