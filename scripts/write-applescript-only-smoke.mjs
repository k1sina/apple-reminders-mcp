#!/usr/bin/env node
// AppleScript-only smoke: exercise the write primitives against Reminders.app directly.
// Verifies the AppleScript flow even when the running terminal lacks Full Disk Access.

import { AppleScriptClient } from "../dist/applescript-client.js";

const ascr = new AppleScriptClient(process.env.DEBUG === "1");

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const LIST_A = `Claude AS Smoke A ${stamp}`;
const LIST_B = `Claude AS Smoke B ${stamp}`;
let pass = 0, fail = 0;
function check(cond, label, detail = "") {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? "  →  " + detail : ""}`); fail++; }
}

const getProp = (uuid, prop, scope) => ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, scope)}
  return ${prop} of R as text
end tell`);

const reminderExists = async (uuid, scope) => {
  try {
    await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, scope)}
  return name of R
end tell`);
    return true;
  } catch { return false; }
};

try {
  // === Setup: two lists ===
  await ascr.run(`tell application "Reminders"
  make new list with properties {name:${AppleScriptClient.escape(LIST_A)}}
  make new list with properties {name:${AppleScriptClient.escape(LIST_B)}}
end tell`);
  console.log(`Created lists: "${LIST_A}", "${LIST_B}"`);

  // === Create with full property set ===
  const dateBlock = AppleScriptClient.dateBlock("d", new Date(2026, 11, 25, 9, 0, 0), true);
  const createId = await ascr.run(`${dateBlock}
tell application "Reminders"
  set L to first list whose name is ${AppleScriptClient.escape(LIST_A)}
  set R to make new reminder at end of L with properties {name:${AppleScriptClient.escape("Smoke create")}, body:${AppleScriptClient.escape("multi\nline\nnotes")}, priority:1, flagged:true, allday due date:d}
  return id of R as text
end tell`);
  const uuid = AppleScriptClient.uuidFromReminderId(createId);
  check(/^[0-9A-F-]{36}$/i.test(uuid), "create: returned id parses", uuid);
  check((await getProp(uuid, "name", LIST_A)) === "Smoke create", "create: name");
  check((await getProp(uuid, "priority", LIST_A)) === "1", "create: priority=1 (high)");
  check((await getProp(uuid, "flagged", LIST_A)) === "true", "create: flagged=true");

  // === Update: rename + lower priority (combined into a single osascript call) ===
  await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, LIST_A)}
  set name of R to ${AppleScriptClient.escape("Smoke renamed")}
  set priority of R to 9
end tell`);
  check((await getProp(uuid, "name", LIST_A)) === "Smoke renamed", "update: name");
  check((await getProp(uuid, "priority", LIST_A)) === "9", "update: priority=9 (low)");

  // === Complete ===
  await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, LIST_A)}
  set completed of R to true
end tell`);
  check((await getProp(uuid, "completed", LIST_A)) === "true", "complete: completed=true");

  // === Uncomplete ===
  await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, LIST_A)}
  set completed of R to false
end tell`);
  check((await getProp(uuid, "completed", LIST_A)) === "false", "uncomplete: completed=false");

  // === Move ===
  await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, LIST_A)}
  set L to first list whose name is ${AppleScriptClient.escape(LIST_B)}
  move R to L
end tell`);
  const containerName = await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, LIST_B)}
  return name of container of R
end tell`);
  check(containerName === LIST_B, "move: now in destination list", containerName);

  // === Delete ===
  await ascr.run(`tell application "Reminders"
  ${AppleScriptClient.resolveReminderBlock(uuid, LIST_B)}
  delete R
end tell`);
  check(!(await reminderExists(uuid, LIST_B)), "delete: reminder is gone");
} catch (e) {
  console.log(`FAIL  unhandled: ${e.message}`);
  fail++;
} finally {
  console.log("\n--- teardown ---");
  for (const name of [LIST_A, LIST_B]) {
    try {
      await ascr.run(`tell application "Reminders"
  delete (first list whose name is ${AppleScriptClient.escape(name)})
end tell`);
    } catch { /* already gone */ }
  }
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
