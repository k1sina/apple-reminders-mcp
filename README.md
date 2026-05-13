# apple-reminders-mcp

MCP server for Apple Reminders on macOS. **Reads** the full structure — lists, sections, tasks, subtasks, tags, notes, priority, due dates, flags — and **writes** basic CRUD (create / update / complete / uncomplete / delete / move between lists). Read path is SQLite-direct; write path is AppleScript via `osascript`.

## How it works

```
                                          ┌─▶ Data-*.sqlite (read)
Claude ──(MCP/stdio)──▶ apple-reminders ──┤
                                          └─▶ osascript → Reminders.app (writes)
```

**Reads** go directly to the local Reminders SQLite stores at
`~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-*.sqlite`.
Each iCloud account / source has its own file; the server opens them all and unions the result. SQLite is the only path that exposes **tags, subtasks, and sections** — features the AppleScript bridge doesn't surface.

**Writes** go through `osascript` to Reminders.app, which commits the change to the local SQLite immediately (so a post-write read sees fresh data). We never write to SQLite directly — that would fight CloudKit sync.

## Read tools

| Tool               | Returns                                                              |
|--------------------|----------------------------------------------------------------------|
| `list_lists`       | All lists with their section structure                              |
| `list_reminders`   | Reminders filtered by list/section/status/due/priority/tags         |
| `get_reminder`     | One reminder by UUID, with full subtask tree expanded               |
| `search_reminders` | Substring search across titles and notes                            |
| `list_tags`        | Every distinct hashtag with usage counts                            |
| `describe_stores`  | Diagnostic: which SQLite files are open and how many rows in each   |

Sort order: overdue → ascending due → undated last (ties broken alphabetically by title).

## Write tools

All write tools return the full updated `Reminder` object (except `delete_reminder`, which returns `{ ok, id, title }` since the reminder is gone).

| Tool                  | What it does                                                          |
|-----------------------|-----------------------------------------------------------------------|
| `create_reminder`     | Creates a reminder in a named list. Supports notes, priority, due (ISO or YYYY-MM-DD), `due_all_day`, `flagged`, **`tags`** (v0.3.0 — Shortcuts-based). |
| `update_reminder`     | Patches title / notes / priority / due / flagged. `clear_due: true` drops the date. **`add_tags` / `remove_tags`** (v0.3.0 — Shortcuts-based). |
| `complete_reminder`   | Sets `completed=true` and stamps `completion_date`. Recurring reminders spawn the next occurrence automatically (Apple's behavior). |
| `uncomplete_reminder` | Re-opens a completed reminder.                                       |
| `delete_reminder`     | **Destructive.** Permanently deletes by id. Returns `{ ok, id, title }`. |
| `move_reminder`       | Moves a reminder to a different list (by name or UUID).              |
| `set_tags`            | Adds and/or removes hashtags via the Shortcut. v0.3.0. See SHORTCUT_SETUP.md. |

### Tag writes (v0.3.0): via Apple Shortcuts

Tag writes from outside Reminders.app are **not** possible via AppleScript (the extractor only runs on UI input) or direct SQLite (Reminders.app's CoreData layer never re-reads the store at runtime) on macOS 26. Both paths were probed end-to-end — see "Investigation history" below.

The MCP routes tag writes through a user-authored **Apple Shortcut** that calls Apple's first-party "Add Tag to Reminder" / "Remove Tag from Reminder" actions. Those actions go through Reminders.app's CoreData stack and produce real hashtag rows that appear in the UI and sync to iCloud.

**One-time setup:** follow [SHORTCUT_SETUP.md](./SHORTCUT_SETUP.md) to build a Shortcut named `Claude Reminder Tags`. Takes ~5 minutes.

The MCP detects the Shortcut's presence at startup:
- If present → tag args on `create_reminder` / `update_reminder` / `set_tags` work.
- If absent → those tools fail with a clear error pointing at SHORTCUT_SETUP.md. Everything else (read tools, AppleScript writes) keeps working.

### Investigation history

The reason this needs a Shortcut at all:

1. **AppleScript title interpolation** (v0.2.0, rolled back in v0.2.1). Reminders.app's hashtag extractor runs only on UI input events. Five probe variants (`make new reminder` with `#tag` in name, post-create `set name`, tell-style `set its name`, `set body`, plus direct `tags` / `hashtags` accessors) all produced reminders whose titles contained `#tag` tokens but whose `ZREMCDHASHTAG` rows were never created.

2. **Direct SQLite INSERT into `ZREMCDOBJECT` entity-32** (probed before v0.3.0, abandoned). The row inserts cleanly and any external SQLite reader sees the tag, but Reminders.app's UI never refreshes — its `NSManagedObjectContext` caches relationships in memory. Three "poke" variants to force a CoreData refetch (re-save body, toggle flagged, re-set name to itself) all left the UI unchanged. Same wall blocks `cloudd` from pushing the row to iCloud.

Probe scripts are preserved under `scripts/v3-tag-feasibility-probe*.mjs`.

Every write logs a `[WRITE] <tool> <args>` line to stderr for auditability.

## Install

Requires macOS 13+, Node 20+.

```sh
cd apple-reminders
npm install
npm run build
```

## Permissions (one-time)

The host app (Claude Desktop / Claude Code / your terminal) needs **two** TCC grants:

1. **Full Disk Access** — required for read tools.
   System Settings → Privacy & Security → Full Disk Access → toggle the host app on.

2. **Automation → Reminders** — required for write tools.
   The first write call triggers a system prompt ("Claude.app wants to control Reminders.app"). Click **OK**.
   If denied / dismissed: System Settings → Privacy & Security → Automation → expand the host app → toggle **Reminders** on.

The two grants are independent. Read tools work with only FDA; write tools work with only Automation; both grants together unlock everything.

## Connect to Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-reminders": {
      "command": "node",
      "args": ["/Users/YOU/Projects/ai-assistant/apple-reminders/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

Add to `~/.claude.json` — same shape as above.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `REMINDERS_STORES_DIR` | `~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores` | Override stores directory (e.g. point at a copy for testing) |

## Sanity checks

```sh
# Read smoke: scans your live store, prints summary
npm run smoke

# Write smoke: creates throwaway lists, exercises every write op, deletes them
npm run smoke:write

# Boot the MCP (Ctrl-C; you should see "Listening on stdio.")
node dist/index.js

# Interactive UI for every tool
npx @modelcontextprotocol/inspector node dist/index.js
```

The write smoke takes a few minutes on a large store — Reminders.app's `whose id` lookups are
O(n-in-list). The MCP scopes lookups by the reminder's containing list (~10× speedup), but each
mutation is still ~3–30 s of `osascript` round-trip on a multi-thousand-reminder DB.

## Data shape

```ts
type Priority = "none" | "high" | "medium" | "low";

interface Section {
  id: string;          // UUID
  name: string;
  ordering: number;    // 0..N-1 by creation date within the list
}

interface List {
  id: string;          // UUID
  name: string;
  color: string | null;
  source: string;      // "Reminders"
  allows_modifications: boolean;
  sections: Section[];
}

interface Reminder {
  id: string;                       // UUID — stable, survives renames and list moves
  list_id: string;
  list_name: string;
  section_id: string | null;
  title: string;
  notes: string | null;
  priority: Priority;
  due: string | null;               // ISO 8601 (timed) or YYYY-MM-DD (all-day)
  due_all_day: boolean;
  completed: boolean;
  completion_date: string | null;
  creation_date: string | null;
  modification_date: string | null;
  flagged: boolean;
  url: string | null;
  parent_id: string | null;
  subtask_ids: string[];            // direct children only
  tags: string[];                   // hashtag names without leading #
}
```

`get_reminder` additionally returns `subtasks: Reminder[]` (full tree) when `include_subtask_tree` is true (default).

## Scope

- **v0.1.0** — read tools (lists, sections, reminders, subtasks, tags, notes, priority, due dates).
- **v0.2.0** — write tools (basic CRUD). Shipped a tag-via-title-interpolation experiment that turned out not to create real hashtag rows.
- **v0.2.1** — rolled the broken tag args out.
- **v0.2.2** — documents the macOS 26 wall on AppleScript / SQLite tag writes; removes dead code.
- **v0.3.0 (current)** — tag writes restored, routed through a user-authored Apple Shortcut. New `set_tags` tool. `tags` / `add_tags` / `remove_tags` args back on `create_reminder` / `update_reminder`.

**Out of scope on macOS 26 (Reminders.app dictionary doesn't expose them):**
- Subtask creation (no `parent reminder` or `subtasks` collection)
- Section assignment
- Recurring-rule editing

**Out of scope by choice:**
- Bulk operations (defer until concrete use cases appear)
- Tag rename across every reminder using a label

## Architecture notes

- **Multiple stores**: Reminders splits data into one `Data-*.sqlite` per account. We open them all and unioning results. UUIDs (`ZCKIDENTIFIER`) are the cross-store identifiers.
- **Hashtags**: stored in `ZREMCDOBJECT` (entity 32), one row per `(reminder, tag)` pair. Joined to `ZREMCDHASHTAGLABEL` for tag names.
- **Sections**: section membership lives in a JSON blob (`ZMEMBERSHIPSOFREMINDERSINSECTIONSASDATA`) on each list row, mapping `memberID` (reminder UUID) → `groupID` (section UUID). We filter against the reminder's *current* list to avoid stale references after moves.
- **Dates**: stored as Cocoa `NSDate` (seconds since 2001-01-01 UTC). Converted to ISO 8601, or YYYY-MM-DD when `ZALLDAY=1`.
- **Subtasks**: `ZPARENTREMINDER` FK on `ZREMCDREMINDER` points at the parent's row PK.

## Troubleshooting

- **`Could not open any Reminders SQLite store`** — Full Disk Access is not granted to the host process. System Settings → Privacy & Security → Full Disk Access → toggle Claude (or your terminal) on, then restart.
- **Write tools fail with `-1743` / "Not authorized to send Apple events"** — Automation permission is not granted for Reminders. System Settings → Privacy & Security → Automation → expand Claude → toggle Reminders on.
- **Write tools fail with `-600` / "isn't running"** — open Reminders.app at least once.
- **A list or reminder is missing** — call `describe_stores` to see how many rows each file has. If your iCloud account file has 0 rows, sync isn't done yet — open the Reminders app once.
- **Writes are slow** — Reminders.app's `whose id is` AppleScript predicate is O(n) over the matched list. Expected ~3–30 s per write on a multi-thousand-reminder store.
- **Apple changed the schema** — the queries use named columns (e.g. `ZREMCDREMINDER.ZTITLE`); a schema rename will surface as a clear SQLite error at MCP startup. Run `bash scripts/discover-schema.sh` to inspect your live schema and open an issue.

## License

MIT.
