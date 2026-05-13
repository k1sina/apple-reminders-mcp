#!/usr/bin/env bash
# Dump the live Reminders SQLite schema for development. Run only after Full Disk Access has been
# granted to your terminal. Output is consumed when iterating on sqlite-client.ts.
set -euo pipefail

DB="${REMINDERS_SQLITE_PATH:-$HOME/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-local.sqlite}"

if [ ! -r "$DB" ]; then
  echo "ERROR: cannot read $DB" >&2
  echo "Grant Full Disk Access to this terminal in System Settings → Privacy & Security → Full Disk Access." >&2
  exit 1
fi

echo "=== DB path ==="
echo "$DB"
echo

echo "=== Tables ==="
sqlite3 "$DB" ".tables"
echo

echo "=== Reminder-related tables (schema) ==="
for t in $(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%REMINDER%' OR name LIKE '%LIST%' OR name LIKE '%SECTION%' OR name LIKE '%HASHTAG%' OR name LIKE '%TAG%' OR name LIKE 'Z\\_%' ESCAPE '\\') ORDER BY name"); do
  echo "--- $t ---"
  sqlite3 "$DB" ".schema $t"
  echo
done

echo "=== Sample reminder row (first non-null) ==="
sqlite3 "$DB" "SELECT * FROM ZREMCDREMINDER LIMIT 1" 2>/dev/null || sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%REMINDER%'"

echo
echo "=== Sample list row ==="
sqlite3 "$DB" "SELECT * FROM ZREMCDLIST LIMIT 1" 2>/dev/null || true

echo
echo "=== Sample section row ==="
sqlite3 "$DB" "SELECT * FROM ZREMCDSECTION LIMIT 1" 2>/dev/null || true

echo
echo "=== Sample hashtag rows ==="
sqlite3 "$DB" "SELECT * FROM ZREMCDHASHTAG LIMIT 5" 2>/dev/null || true

echo
echo "=== Row counts ==="
for t in ZREMCDREMINDER ZREMCDLIST ZREMCDSECTION ZREMCDHASHTAG ZREMCDOBJECT; do
  c=$(sqlite3 "$DB" "SELECT COUNT(*) FROM $t" 2>/dev/null || echo "(missing)")
  echo "$t: $c"
done
