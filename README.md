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
| `create_reminder`     | Creates a reminder in a named list. Supports notes, priority, due (ISO or YYYY-MM-DD), `due_all_day`, `flagged`. |
| `update_reminder`     | Patches title / notes / priority / due / flagged. `clear_due: true` drops the date. |
| `complete_reminder`   | Sets `completed=true` and stamps `completion_date`. Recurring reminders spawn the next occurrence automatically (Apple's behavior). |
| `uncomplete_reminder` | Re-opens a completed reminder.                                       |
| `delete_reminder`     | **Destructive.** Permanently deletes by id. Returns `{ ok, id, title }`. |
| `move_reminder`       | Moves a reminder to a different list (by name or UUID).              |

### Why tag writes aren't supported here

v0.2.0 attempted tag writes by appending `#tag` tokens to the title; v0.2.1 rolled this back because **Reminders.app's hashtag extractor runs only on user input events in the UI, not on AppleScript-set strings**. Five empirical probes against the real store (`make new reminder`, post-create `set name`, tell-style `set its name`, `set body`, plus tags-property accessors) all produced reminders whose titles contained `#tag` tokens but whose `tags[]` was empty — no `ZREMCDHASHTAG` rows were created. A direct-SQLite path is on the v0.3.0 roadmap.

For now, set tags by editing the reminder in Reminders.app directly. Read tools still see all your existing hashtags correctly.

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
# Hashtag pure-function unit tests (no Reminders.app needed)
node dist/tools/hashtags.js --test

# Read smoke: scans your live store, prints summary
npm run smoke

# Write smoke: creates throwaway lists, exercises every write op + tags, deletes them
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

**v0.1.0:** read tools — lists, sections, reminders, subtasks, tags, notes, priority, due dates.
**v0.2.0:** write tools — basic CRUD. (Tag-via-title-interpolation shipped but didn't actually create hashtag rows — see "Why tag writes aren't supported here" above.)
**v0.2.1 (current):** rolled the broken tag args out so callers stop being misled.

**Roadmap:**
- **v0.3.0** — tag setting via direct SQLite writes to `ZREMCDOBJECT` (hashtag entity 32) + `ZREMCDHASHTAGLABEL`. Bypasses Reminders.app's UI-only extractor; experimental w.r.t. CloudKit sync.

**Out of scope (deferred):**
- **Subtask creation** — macOS 26's Reminders.app AppleScript dictionary doesn't expose the parent relationship at all (no `parent reminder`, no `subtasks` collection). Would need a Shortcuts bridge or direct SQLite writes.
- Section assignment
- Bulk operations
- Recurring-rule editing
- Tag rename (across every reminder using a label)

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
