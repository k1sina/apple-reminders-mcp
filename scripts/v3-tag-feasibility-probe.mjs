#!/usr/bin/env node
// v0.3.0 feasibility probe — does inserting a ZREMCDOBJECT entity-32 row actually create
// a tag that Reminders.app + our read MCP recognize?
//
// Steps:
//   1. Create a throwaway reminder via AppleScript in Inbox
//   2. Resolve its Z_PK in the right Data-*.sqlite store
//   3. INSERT one hashtag-application row linking it to existing label "wait" (Z_PK=5)
//   4. Bump Z_PRIMARYKEY counter for entity 13 (REMCDObject)
//   5. Read back via SqliteClient — does .tags include "wait"?
//   6. Delete the reminder (test cleanup)
//
// Authorized scope: ONE feasibility test, throwaway reminder only. No multi-row writes.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { AppleScriptClient } from "../dist/applescript-client.js";
import { SqliteClient } from "../dist/sqlite-client.js";

const STORES_DIR = join(homedir(), "Library", "Group Containers",
  "group.com.apple.reminders", "Container_v1", "Stores");

// -----------------------------------------------------------------------------
function osa(script) {
  const r = spawnSync("osascript", ["-"], { input: script, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`osascript failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function nsDateNow() {
  // NSDate seconds since 2001-01-01 UTC
  return Date.now() / 1000 - 978307200;
}

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}
// -----------------------------------------------------------------------------

console.log("=== 1. Create throwaway reminder ===");
const probeName = `v3 SQLite-tag probe ${Date.now()}`;
const createOut = osa(`tell application "Reminders"
  set L to first list whose name is "Inbox"
  set R to make new reminder at end of L with properties {name:"${probeName}"}
  return id of R as text
end tell`);
const reminderUuid = AppleScriptClient.uuidFromReminderId(createOut);
console.log(`reminder UUID = ${reminderUuid}`);

// -----------------------------------------------------------------------------
console.log("\n=== 2. Locate it in Data-*.sqlite ===");
const sqliteFiles = readdirSync(STORES_DIR)
  .filter((f) => /^Data-.*\.sqlite$/i.test(f) && !f.endsWith("-shm") && !f.endsWith("-wal"))
  .map((f) => join(STORES_DIR, f));

let dbPath = null;
let reminderPk = null;
let accountPk = null;
for (const file of sqliteFiles) {
  try {
    const db = new Database(file, { readonly: true });
    const row = db.prepare(
      "SELECT Z_PK, ZACCOUNT FROM ZREMCDREMINDER WHERE ZCKIDENTIFIER = ? AND ZMARKEDFORDELETION=0"
    ).get(reminderUuid);
    db.close();
    if (row) {
      dbPath = file;
      reminderPk = row.Z_PK;
      accountPk = row.ZACCOUNT;
      break;
    }
  } catch (e) {
    console.error(`  skip ${file}: ${e.message}`);
  }
}
if (!dbPath) throw new Error("Reminder created but not found in any store yet — retry needed.");
console.log(`store = ${dbPath.split("/").pop()}`);
console.log(`reminder Z_PK = ${reminderPk}, ZACCOUNT = ${accountPk}`);

// -----------------------------------------------------------------------------
console.log("\n=== 3. Resolve label \"wait\" Z_PK ===");
const rwDb = new Database(dbPath, { readonly: false });
const label = rwDb.prepare(
  "SELECT Z_PK, ZNAME FROM ZREMCDHASHTAGLABEL WHERE ZNAME = ? LIMIT 1"
).get("wait");
if (!label) throw new Error("Label 'wait' not found in label table");
console.log(`label Z_PK = ${label.Z_PK}, name = ${label.ZNAME}`);

// -----------------------------------------------------------------------------
console.log("\n=== 4. INSERT hashtag-application row + bump Z_PRIMARYKEY ===");
const newCkId = randomUUID().toUpperCase();
const newCkIdBytes = uuidToBytes(newCkId);
const now = nsDateNow();

rwDb.transaction(() => {
  const maxRow = rwDb.prepare("SELECT MAX(Z_PK) AS m FROM ZREMCDOBJECT").get();
  const newPk = (maxRow.m ?? 0) + 1;
  console.log(`  inserting at Z_PK = ${newPk}, ZCKIDENTIFIER = ${newCkId}`);

  rwDb.prepare(`
    INSERT INTO ZREMCDOBJECT
      (Z_PK, Z_ENT, Z_OPT,
       ZCKDIRTYFLAGS, ZMARKEDFORDELETION,
       ZACCOUNT, ZTYPE1,
       ZHASHTAGLABEL, ZREMINDER3,
       ZCREATIONDATE, ZCKIDENTIFIER, ZIDENTIFIER)
    VALUES
      (?, 32, 1,
       1, 0,
       ?, 0,
       ?, ?,
       ?, ?, ?)
  `).run(newPk, accountPk, label.Z_PK, reminderPk, now, newCkId, newCkIdBytes);

  // Update Z_PRIMARYKEY counter for entity 13 (REMCDObject — the supertable)
  rwDb.prepare("UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_ENT = 13").run(newPk);

  console.log("  INSERT + counter bump complete");
})();
rwDb.close();

// -----------------------------------------------------------------------------
console.log("\n=== 5. Read back via SqliteClient ===");
// Wait a beat to let WAL settle.
await new Promise((r) => setTimeout(r, 500));
const ro = SqliteClient.open();
const r = ro.reminder(reminderUuid);
console.log(`  tags reported = ${JSON.stringify(r?.tags ?? null)}`);
ro.close();

// -----------------------------------------------------------------------------
console.log("\n=== 6. Cleanup — delete reminder ===");
console.log("  Leaving the reminder in place for 5 seconds — open Reminders.app and check if the");
console.log("  tag 'wait' shows on it...");
await new Promise((r) => setTimeout(r, 5000));

osa(`tell application "Reminders"
  delete (first reminder whose id is "x-apple-reminder://${reminderUuid}")
end tell`);
console.log("  deleted");

console.log("\nProbe complete.");
