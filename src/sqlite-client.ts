import Database, { type Database as DB } from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { List, Reminder, Section } from "./types.js";

const STORES_DIR = path.join(
  os.homedir(),
  "Library",
  "Group Containers",
  "group.com.apple.reminders",
  "Container_v1",
  "Stores"
);

// CoreData entity numbers (from Z_PRIMARYKEY on macOS 26 Reminders schema)
const ENTITY_LIST = 3;          // REMCDList
const ENTITY_HASHTAG = 32;      // REMCDHashtag (lives in ZREMCDOBJECT)

/**
 * One reminder pulled straight from one account's SQLite store. We keep enough fields here to
 * build subtask trees, merge section memberships, and project the public Reminder shape.
 */
interface RawReminderRow {
  z_pk: number;
  uuid: string;
  list_pk: number | null;
  parent_pk: number | null;
  title: string;
  notes: string | null;
  priority_raw: number;
  all_day: number;
  due_date_raw: number | null;
  completed: number;
  completion_date_raw: number | null;
  creation_date_raw: number | null;
  modification_date_raw: number | null;
  flagged: number;
  url: string | null;
}

interface RawListRow {
  z_pk: number;
  uuid: string;
  name: string;
  marked_for_deletion: number;
  z_ent: number;
  memberships_blob: Buffer | null;
}

interface RawSectionRow {
  z_pk: number;
  uuid: string;
  name: string;
  list_pk: number;
  creation_date_raw: number | null;
}

interface Membership {
  memberID: string;          // reminder UUID
  groupID?: string;          // section UUID (absent if reminder isn't in any section)
  modifiedOn?: number;
}

interface MembershipPayload {
  memberships?: Membership[];
}

/** NSDate (seconds since 2001-01-01 UTC) → ISO 8601 with ms, or null. */
function nsdateToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const ms = (value + 978307200) * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** NSDate → local YYYY-MM-DD (all-day rendering). */
function nsdateToYmd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const d = new Date((value + 978307200) * 1000);
  // All-day dates are stored at local-midnight, but display them in the user's local TZ regardless.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function priorityLabel(p: number): Reminder["priority"] {
  switch (p) {
    case 1: return "high";
    case 5: return "medium";
    case 9: return "low";
    default: return "none";
  }
}

export interface AccountStore {
  filename: string;
  db: DB;
}

export class SqliteClient {
  private readonly stores: AccountStore[];

  private constructor(stores: AccountStore[]) {
    this.stores = stores;
  }

  static defaultDir(): string {
    return process.env.REMINDERS_STORES_DIR?.trim() || STORES_DIR;
  }

  /** Discover and open every `Data-*.sqlite` store in the Reminders container. */
  static open(dir: string = SqliteClient.defaultDir()): SqliteClient {
    if (!fs.existsSync(dir)) {
      throw new Error(
        `Reminders Stores directory not found: ${dir}. Open the Reminders app at least once.`
      );
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      throw new Error(
        `Cannot list ${dir} (${(e as Error).message}). Grant Full Disk Access in System Settings → ` +
        `Privacy & Security → Full Disk Access to the app hosting this MCP.`
      );
    }
    const sqliteFiles = entries
      .filter((f) => /^Data-.*\.sqlite$/i.test(f) && !f.endsWith("-shm") && !f.endsWith("-wal"))
      .map((f) => path.join(dir, f));
    if (sqliteFiles.length === 0) {
      throw new Error(`No Data-*.sqlite files found in ${dir}`);
    }

    const stores: AccountStore[] = [];
    for (const file of sqliteFiles) {
      try {
        fs.accessSync(file, fs.constants.R_OK);
      } catch {
        // Skip files we cannot read; surface error if NONE are readable.
        continue;
      }
      try {
        const db = new Database(file, { readonly: true, fileMustExist: true });
        db.pragma("query_only = ON");
        stores.push({ filename: path.basename(file), db });
      } catch (e) {
        console.error(`[apple-reminders-mcp] Skipping ${file}: ${(e as Error).message}`);
      }
    }
    if (stores.length === 0) {
      throw new Error(
        `Could not open any Reminders SQLite store in ${dir}. ` +
        `Grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access.`
      );
    }
    return new SqliteClient(stores);
  }

  static tryOpen(dir?: string): { client: SqliteClient | null; error?: string } {
    try {
      return { client: SqliteClient.open(dir ?? SqliteClient.defaultDir()) };
    } catch (e) {
      return { client: null, error: (e as Error).message };
    }
  }

  /** Filenames of every opened store (diagnostics). */
  storeFilenames(): string[] {
    return this.stores.map((s) => s.filename);
  }

  close(): void {
    for (const s of this.stores) {
      try { s.db.close(); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Public projections
  // ---------------------------------------------------------------------------

  /** All non-deleted, regular (non-smart) lists across every account, with their sections. */
  lists(): List[] {
    const out: List[] = [];
    for (const store of this.stores) {
      const lists = this.queryLists(store.db);
      const sectionsByListPk = this.querySectionsByListPk(store.db);
      for (const l of lists) {
        out.push({
          id: l.uuid,
          name: l.name,
          color: null,                 // Color column is a BLOB (binary plist) — skip for v1.
          source: "Reminders",         // Multi-store; we don't read account titles in v1.
          allows_modifications: true,
          sections: sectionsByListPk.get(l.z_pk) ?? [],
        });
      }
    }
    // Stable sort by name for predictable output.
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * All reminders across every account, optionally filtered by list UUID and completion status.
   * Subtasks are included (with parent_id wired) — caller decides whether to filter or nest them.
   */
  reminders(opts: { listId?: string; status?: "open" | "completed" | "all" } = {}): Reminder[] {
    const status = opts.status ?? "open";
    const want = opts.listId;
    const out: Reminder[] = [];

    for (const store of this.stores) {
      const lists = this.queryLists(store.db);
      const listByPk = new Map(lists.map((l) => [l.z_pk, l]));

      // If a specific list was requested, only emit reminders whose list belongs to this store.
      if (want) {
        const exists = lists.some((l) => l.uuid === want);
        if (!exists) continue;
      }

      const wantedListPks = want
        ? new Set(lists.filter((l) => l.uuid === want).map((l) => l.z_pk))
        : null;

      const rawRows = this.queryReminders(store.db, wantedListPks, status);
      if (rawRows.length === 0) continue;

      // Section membership: parse the JSON blob on each list once, key by (listPk, reminderUuid).
      // A reminder moved between lists can leave stale entries in its old list's memberships JSON;
      // we must only honor memberships from the reminder's *current* list.
      const sectionByListPkAndReminderUuid = new Map<number, Map<string, string>>();
      for (const l of lists) {
        if (!l.memberships_blob) continue;
        if (wantedListPks && !wantedListPks.has(l.z_pk)) continue;
        try {
          const payload = JSON.parse(l.memberships_blob.toString("utf8")) as MembershipPayload;
          const perList = new Map<string, string>();
          for (const m of payload.memberships ?? []) {
            if (m.memberID && m.groupID) {
              perList.set(m.memberID, m.groupID);
            }
          }
          sectionByListPkAndReminderUuid.set(l.z_pk, perList);
        } catch { /* corrupt or empty — skip */ }
      }

      // Build the set of valid section UUIDs known to exist (not deleted) so we can drop dangling
      // groupID references to deleted sections.
      const validSectionUuids = new Set<string>();
      for (const sections of this.querySectionsByListPk(store.db).values()) {
        for (const s of sections) validSectionUuids.add(s.id);
      }

      const tagsByReminderPk = this.queryTagsByReminderPk(store.db);

      // Parent PK → UUID lookup so we can set parent_id without a self-join in SQL.
      const uuidByPk = new Map<number, string>();
      for (const r of rawRows) uuidByPk.set(r.z_pk, r.uuid);

      // Group subtask UUIDs under parents.
      const subtaskIdsByParentPk = new Map<number, string[]>();
      for (const r of rawRows) {
        if (r.parent_pk !== null) {
          const list = subtaskIdsByParentPk.get(r.parent_pk) ?? [];
          list.push(r.uuid);
          subtaskIdsByParentPk.set(r.parent_pk, list);
        }
      }

      for (const r of rawRows) {
        const list = r.list_pk !== null ? listByPk.get(r.list_pk) : undefined;
        const allDay = r.all_day === 1;
        const ownListMemberships = r.list_pk !== null ? sectionByListPkAndReminderUuid.get(r.list_pk) : undefined;
        const sectionUuid = ownListMemberships?.get(r.uuid);
        const resolvedSection = sectionUuid && validSectionUuids.has(sectionUuid) ? sectionUuid : null;
        out.push({
          id: r.uuid,
          list_id: list?.uuid ?? "",
          list_name: list?.name ?? "",
          section_id: resolvedSection,
          title: r.title,
          notes: r.notes,
          priority: priorityLabel(r.priority_raw),
          due: allDay ? nsdateToYmd(r.due_date_raw) : nsdateToIso(r.due_date_raw),
          due_all_day: allDay,
          completed: r.completed === 1,
          completion_date: nsdateToIso(r.completion_date_raw),
          creation_date: nsdateToIso(r.creation_date_raw),
          modification_date: nsdateToIso(r.modification_date_raw),
          flagged: r.flagged === 1,
          url: r.url,
          parent_id: r.parent_pk !== null ? uuidByPk.get(r.parent_pk) ?? null : null,
          subtask_ids: subtaskIdsByParentPk.get(r.z_pk) ?? [],
          tags: tagsByReminderPk.get(r.z_pk) ?? [],
        });
      }
    }
    return out;
  }

  /** Single reminder lookup by UUID across all stores. */
  reminder(uuid: string): Reminder | null {
    return this.reminders({ status: "all" }).find((r) => r.id === uuid) ?? null;
  }

  /** Same as {@link reminder} but with a small retry loop — used immediately after a write so that
   *  we see Reminders.app's commit even if it's a few ms late landing in the WAL. */
  async reminderWithRetry(uuid: string, attempts = 6, delayMs = 100): Promise<Reminder | null> {
    for (let i = 0; i < attempts; i++) {
      const r = this.reminder(uuid);
      if (r) return r;
      if (i + 1 < attempts) await new Promise((res) => setTimeout(res, delayMs));
    }
    return null;
  }

  /**
   * Poll until the reminder's hashtag rows have caught up. Reminders.app extracts `#tag` tokens
   * from a freshly-set title asynchronously; this helper gives that extraction up to ~1.5 s
   * before we return a reminder whose `tags` array still looks stale.
   *
   * `expectedTags` and the reminder's `tags` are compared case-insensitively. Tags the caller
   * didn't ask about are ignored. If we time out we still return the latest reminder so the
   * caller can return SOMETHING — Reminders.app will catch up on the next read.
   */
  async reminderWithTagWait(
    uuid: string,
    expectedTags: string[],
    attempts = 15,
    delayMs = 100
  ): Promise<Reminder | null> {
    const expected = new Set(expectedTags.map((t) => t.toLowerCase()));
    let last: Reminder | null = null;
    for (let i = 0; i < attempts; i++) {
      last = this.reminder(uuid);
      if (last) {
        const present = new Set(last.tags.map((t) => t.toLowerCase()));
        if ([...expected].every((t) => present.has(t))) return last;
      }
      if (i + 1 < attempts) await new Promise((res) => setTimeout(res, delayMs));
    }
    return last;
  }

  /** Look up a list by exact UUID or case-insensitive name. Returns null if not found. */
  findListByNameOrUuid(query: string): List | null {
    const lists = this.lists();
    const byId = lists.find((l) => l.id === query);
    if (byId) return byId;
    const byName = lists.find((l) => l.name.toLowerCase() === query.toLowerCase());
    return byName ?? null;
  }

  /** Tag vocabulary with usage counts across all accounts. */
  tagUsage(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const store of this.stores) {
      const rows = store.db
        .prepare(
          `SELECT l.ZNAME AS name, COUNT(*) AS c
           FROM ZREMCDOBJECT o
           JOIN ZREMCDHASHTAGLABEL l ON l.Z_PK = o.ZHASHTAGLABEL
           JOIN ZREMCDREMINDER r ON r.Z_PK = o.ZREMINDER3
           WHERE o.Z_ENT = ${ENTITY_HASHTAG}
             AND o.ZMARKEDFORDELETION = 0
             AND r.ZMARKEDFORDELETION = 0
             AND l.ZNAME IS NOT NULL
           GROUP BY l.ZNAME`
        )
        .all() as Array<{ name: string; c: number }>;
      for (const row of rows) {
        counts.set(row.name, (counts.get(row.name) ?? 0) + row.c);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Diagnostic: shape of every store. */
  describe(): Array<{ file: string; counts: Record<string, number> }> {
    return this.stores.map((s) => {
      const counts: Record<string, number> = {};
      for (const t of ["ZREMCDREMINDER", "ZREMCDBASELIST", "ZREMCDBASESECTION", "ZREMCDHASHTAGLABEL", "ZREMCDOBJECT"]) {
        try {
          const row = s.db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number };
          counts[t] = row.c;
        } catch {
          counts[t] = -1;
        }
      }
      return { file: s.filename, counts };
    });
  }

  // ---------------------------------------------------------------------------
  // Per-store queries
  // ---------------------------------------------------------------------------

  private queryLists(db: DB): RawListRow[] {
    return db
      .prepare(
        `SELECT Z_PK AS z_pk, ZCKIDENTIFIER AS uuid, ZNAME AS name,
                ZMARKEDFORDELETION AS marked_for_deletion, Z_ENT AS z_ent,
                ZMEMBERSHIPSOFREMINDERSINSECTIONSASDATA AS memberships_blob
         FROM ZREMCDBASELIST
         WHERE ZMARKEDFORDELETION = 0
           AND Z_ENT = ${ENTITY_LIST}
           AND ZNAME IS NOT NULL
           AND ZCKIDENTIFIER IS NOT NULL`
      )
      .all() as RawListRow[];
  }

  private querySectionsByListPk(db: DB): Map<number, Section[]> {
    const rows = db
      .prepare(
        `SELECT Z_PK AS z_pk, ZCKIDENTIFIER AS uuid, ZDISPLAYNAME AS name,
                ZLIST AS list_pk, ZCREATIONDATE AS creation_date_raw
         FROM ZREMCDBASESECTION
         WHERE ZMARKEDFORDELETION = 0
           AND ZDISPLAYNAME IS NOT NULL
           AND ZCKIDENTIFIER IS NOT NULL
           AND ZLIST IS NOT NULL`
      )
      .all() as RawSectionRow[];

    const out = new Map<number, Section[]>();
    for (const r of rows) {
      const list = out.get(r.list_pk) ?? [];
      list.push({
        id: r.uuid,
        name: r.name,
        // Use creation date as a stable ordering proxy — Reminders doesn't expose explicit ordering.
        ordering: r.creation_date_raw ?? 0,
      });
      out.set(r.list_pk, list);
    }
    for (const [k, v] of out) {
      v.sort((a, b) => a.ordering - b.ordering || a.name.localeCompare(b.name));
      // Re-number ordering to 0..N-1 for cleaner output.
      v.forEach((s, i) => { s.ordering = i; });
      out.set(k, v);
    }
    return out;
  }

  private queryReminders(
    db: DB,
    listPks: Set<number> | null,
    status: "open" | "completed" | "all"
  ): RawReminderRow[] {
    let where = "ZMARKEDFORDELETION = 0";
    if (status === "open") where += " AND ZCOMPLETED = 0";
    else if (status === "completed") where += " AND ZCOMPLETED = 1";

    if (listPks && listPks.size > 0) {
      const placeholders = Array.from(listPks).map(() => "?").join(",");
      where += ` AND ZLIST IN (${placeholders})`;
    }

    const sql = `
      SELECT Z_PK AS z_pk, ZCKIDENTIFIER AS uuid, ZLIST AS list_pk,
             ZPARENTREMINDER AS parent_pk,
             COALESCE(ZTITLE, '') AS title, ZNOTES AS notes,
             COALESCE(ZPRIORITY, 0) AS priority_raw,
             COALESCE(ZALLDAY, 0) AS all_day,
             ZDUEDATE AS due_date_raw,
             COALESCE(ZCOMPLETED, 0) AS completed,
             ZCOMPLETIONDATE AS completion_date_raw,
             ZCREATIONDATE AS creation_date_raw,
             ZLASTMODIFIEDDATE AS modification_date_raw,
             COALESCE(ZFLAGGED, 0) AS flagged,
             NULL AS url
      FROM ZREMCDREMINDER
      WHERE ${where}
        AND ZCKIDENTIFIER IS NOT NULL
    `;
    const params = listPks ? Array.from(listPks) : [];
    return db.prepare(sql).all(...params) as RawReminderRow[];
  }

  private queryTagsByReminderPk(db: DB): Map<number, string[]> {
    const rows = db
      .prepare(
        `SELECT o.ZREMINDER3 AS rem_pk, l.ZNAME AS name
         FROM ZREMCDOBJECT o
         JOIN ZREMCDHASHTAGLABEL l ON l.Z_PK = o.ZHASHTAGLABEL
         WHERE o.Z_ENT = ${ENTITY_HASHTAG}
           AND o.ZMARKEDFORDELETION = 0
           AND o.ZREMINDER3 IS NOT NULL
           AND l.ZNAME IS NOT NULL`
      )
      .all() as Array<{ rem_pk: number; name: string }>;
    const out = new Map<number, string[]>();
    for (const r of rows) {
      const list = out.get(r.rem_pk) ?? [];
      list.push(r.name);
      out.set(r.rem_pk, list);
    }
    for (const [k, v] of out) out.set(k, Array.from(new Set(v)).sort());
    return out;
  }
}
