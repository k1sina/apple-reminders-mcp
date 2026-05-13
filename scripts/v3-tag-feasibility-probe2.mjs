#!/usr/bin/env node
// v0.3.0 feasibility probe #2: does poking the parent reminder via AppleScript after a raw
// SQLite INSERT make Reminders.app pick up the new hashtag row?
//
// Steps:
//   1. Create a throwaway reminder via AppleScript in Inbox
//   2. INSERT a hashtag-application row linking it to label "wait" (Z_PK=5)
//   3. Touch the reminder via AppleScript — set its body to itself ("re-save")
//   4. Pause 15s for visual inspection in Reminders.app
//   5. Try a second poke variant — toggle flagged on/off
//   6. Pause 10s again
//   7. Cleanup

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { AppleScriptClient } from "../dist/applescript-client.js";

const STORES_DIR = join(homedir(), "Library", "Group Containers",
  "group.com.apple.reminders", "Container_v1", "Stores");

function osa(script) {
  const r = spawnSync("osascript", ["-"], { input: script, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`osascript failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const nsDateNow = () => Date.now() / 1000 - 978307200;
const uuidToBytes = (uuid) => Buffer.from(uuid.replace(/-/g, ""), "hex");

// --- 1. Create throwaway reminder ---
const probeName = `v3 probe2 ${Date.now()}`;
const createOut = osa(`tell application "Reminders"
  set L to first list whose name is "Inbox"
  set R to make new reminder at end of L with properties {name:"${probeName}", body:"initial body"}
  return id of R as text
end tell`);
const uuid = AppleScriptClient.uuidFromReminderId(createOut);
console.log(`reminder: ${probeName} (${uuid})`);

// --- 2. Locate + INSERT ---
const files = readdirSync(STORES_DIR)
  .filter((f) => /^Data-.*\.sqlite$/i.test(f) && !f.endsWith("-shm") && !f.endsWith("-wal"))
  .map((f) => join(STORES_DIR, f));

let dbPath, reminderPk, accountPk;
for (const f of files) {
  const db = new Database(f, { readonly: true });
  try {
    const row = db.prepare("SELECT Z_PK, ZACCOUNT FROM ZREMCDREMINDER WHERE ZCKIDENTIFIER=?")
      .get(uuid);
    if (row) { dbPath = f; reminderPk = row.Z_PK; accountPk = row.ZACCOUNT; break; }
  } finally { db.close(); }
}
console.log(`store=${dbPath.split("/").pop()} Z_PK=${reminderPk} ZACCOUNT=${accountPk}`);

const rw = new Database(dbPath, { readonly: false });
const labelPk = rw.prepare("SELECT Z_PK FROM ZREMCDHASHTAGLABEL WHERE ZNAME=?").get("wait").Z_PK;
const newCkId = randomUUID().toUpperCase();
rw.transaction(() => {
  const maxPk = rw.prepare("SELECT MAX(Z_PK) AS m FROM ZREMCDOBJECT").get().m;
  const pk = maxPk + 1;
  rw.prepare(`INSERT INTO ZREMCDOBJECT
    (Z_PK, Z_ENT, Z_OPT, ZCKDIRTYFLAGS, ZMARKEDFORDELETION, ZACCOUNT, ZTYPE1,
     ZHASHTAGLABEL, ZREMINDER3, ZCREATIONDATE, ZCKIDENTIFIER, ZIDENTIFIER)
    VALUES (?, 32, 1, 1, 0, ?, 0, ?, ?, ?, ?, ?)`)
    .run(pk, accountPk, labelPk, reminderPk, nsDateNow(), newCkId, uuidToBytes(newCkId));
  rw.prepare("UPDATE Z_PRIMARYKEY SET Z_MAX=? WHERE Z_ENT=13").run(pk);
  console.log(`inserted entity-32 row at Z_PK=${pk}`);
})();
rw.close();

// --- 3. Poke variant A: re-set body to itself ---
console.log("\n>>> POKE A: set body of R to (body of R) <<<");
osa(`tell application "Reminders"
  set R to first reminder whose id is "x-apple-reminder://${uuid}"
  set body of R to (body of R as text)
end tell`);
console.log("Sleeping 15s — check Reminders.app: does '#wait' appear on the reminder?");
await new Promise((r) => setTimeout(r, 15_000));

// --- 4. Poke variant B: toggle flagged ---
console.log("\n>>> POKE B: toggle flagged true/false <<<");
osa(`tell application "Reminders"
  set R to first reminder whose id is "x-apple-reminder://${uuid}"
  set flagged of R to true
  set flagged of R to false
end tell`);
console.log("Sleeping 10s — check again");
await new Promise((r) => setTimeout(r, 10_000));

// --- 5. Poke variant C: set name to (name) ---
console.log("\n>>> POKE C: set name of R to (name of R) <<<");
osa(`tell application "Reminders"
  set R to first reminder whose id is "x-apple-reminder://${uuid}"
  set name of R to (name of R as text)
end tell`);
console.log("Sleeping 10s — final check");
await new Promise((r) => setTimeout(r, 10_000));

// --- 6. Cleanup ---
osa(`tell application "Reminders"
  delete (first reminder whose id is "x-apple-reminder://${uuid}")
end tell`);
console.log("\nCleanup: reminder deleted.");
console.log("\nReport back: at which (if any) of POKE A/B/C did the #wait tag appear in Reminders.app's UI?");
