# Setting up the `Claude Reminder Tags` Shortcut

> One-time setup to enable tag writes from the MCP. Takes ~5 minutes. Required only if you want `create_reminder({tags:...})`, `update_reminder({add_tags:...})`, or `update_reminder({remove_tags:...})` to actually create real hashtag rows.

## Why we need this

The Reminders.app AppleScript dictionary on macOS 26 doesn't expose hashtag fields, and direct SQLite writes don't propagate into the running app (see README "Why tag writes aren't supported"). A user-authored Apple Shortcut goes through Apple's first-party action set, which uses CoreData properly — so tags written through this path become real hashtag rows visible to the UI and synced to iCloud.

## What you'll build

A Shortcut named exactly **`Claude Reminder Tags`** that:

1. Receives a JSON dictionary as text input
2. Parses out a reminder UUID and two lists of tags
3. Finds the reminder by identifier
4. Adds and removes tags accordingly
5. Outputs `ok` on success

You'll only build it once. The MCP calls it via `shortcuts run`.

---

## Build steps

Open **Shortcuts.app** → click **+** to create a new Shortcut.

### Set the name

In the title bar at the top, type the name **exactly**: `Claude Reminder Tags`.
(Case-sensitive, exact spelling — the MCP looks up the shortcut by this name.)

### Set the input type

Click the settings icon (⛭) on the right sidebar → **Receive** → set to **Text** in **Shortcuts** (i.e. when this shortcut is triggered, expect text input).

### Add the actions

Drag these actions in, in this order. The action library is the panel on the right; search the action name in the search field.

#### Action 1: Get Dictionary from Input

- Search for **"Get Dictionary from Input"** and drag it in.
- It will automatically pick up "Shortcut Input" as its source.

#### Action 2: Get Dictionary Value (reminder_id)

- Search for **"Get Dictionary Value"** and drag it in below Action 1.
- Configure:
  - **Get**: `Value`
  - **for**: type the key name: `reminder_id`
  - **in Dictionary**: should auto-link to the result of Action 1 ("Dictionary")
- Click the result variable name at the bottom of the action and **rename it to `Reminder ID`** for clarity.

#### Action 3: Find Reminders

- Search for **"Find Reminders"** and drag it in.
- Click **Add Filter** → choose **Identifier**.
  - Set the filter to **Identifier** **is** `Reminder ID` (drag the Reminder ID variable from Action 2 into the value slot).
- Set **Limit** to `1`.
- Rename the result variable to `Found`.

If the **Identifier** filter is not in the dropdown:
- Fall back: filter **Title** **contains** `Reminder ID` — this is hacky but works in a pinch. Tell me and I'll work around it on the MCP side.

#### Action 4: Get Item from List

- Search **"Get Item from List"**.
- **Get**: `First Item`
- **from**: `Found` (link Action 3's output).
- Rename result to `Target`.

#### Action 5: Get Dictionary Value (add)

- Add another **"Get Dictionary Value"**.
- **Get**: `Value`
- **for**: `add`
- **in Dictionary**: link to the Dictionary from Action 1.
- Rename to `Tags To Add`.

#### Action 6: Repeat with Each (add loop)

- Search **"Repeat with Each"**.
- **Repeat with each**: link `Tags To Add` from Action 5.
- Inside the loop body:
  - Add a **"Add Tag"** action (search "Add Tag" — the one whose subtitle mentions "Reminders" or "Hashtag").
  - **Tag**: link `Repeat Item` (the per-iteration variable).
  - **to Reminder**: link `Target` from Action 4.
- The action block visually shows "End Repeat" below — leave it as is.

#### Action 7: Get Dictionary Value (remove)

- Add another **"Get Dictionary Value"**.
- **Get**: `Value`
- **for**: `remove`
- Rename to `Tags To Remove`.

#### Action 8: Repeat with Each (remove loop)

- Add another **"Repeat with Each"**.
- **Repeat with each**: `Tags To Remove`.
- Inside the loop body:
  - **"Remove Tag"** action.
  - **Tag**: `Repeat Item`.
  - **from Reminder**: `Target`.

#### Action 9: Stop and Output

- Search **"Stop and Output"**.
- **Output**: type the text `ok`.

### Save

Press **⌘S** or just close the editor — Shortcuts.app autosaves.

---

## Manual sanity test

Before letting the MCP call your new Shortcut, verify it works once manually.

1. In Reminders.app, find any open reminder you don't mind tagging. **Right-click** on it and choose **Copy Link** — this puts `x-apple-reminder://<UUID>` on your clipboard. Extract the UUID portion (the part after `://`).

2. In Terminal:

   ```sh
   echo '{"reminder_id":"<PASTE-UUID-HERE>","add":["test"],"remove":[]}' > /tmp/tag-test.json
   shortcuts run "Claude Reminder Tags" --input-path /tmp/tag-test.json
   ```

   You should see `ok` (or no output and exit code 0).

3. Switch to Reminders.app. The reminder you targeted should now have a `test` tag.

4. To remove it:

   ```sh
   echo '{"reminder_id":"<PASTE-UUID-HERE>","add":[],"remove":["test"]}' > /tmp/tag-test.json
   shortcuts run "Claude Reminder Tags" --input-path /tmp/tag-test.json
   ```

   The `test` tag should disappear in Reminders.app.

If both worked → you're done. Tell me and I'll run the MCP write-tags smoke against a throwaway reminder.

If something didn't work → tell me which step gave you trouble (action not found, wrong filter option, error from `shortcuts run`, etc.) and I'll adjust the instructions.

---

## Troubleshooting

- **"Couldn't find action 'Add Tag'"** — make sure you're on macOS 14 or later. The action shipped in iOS 17 / macOS 14. On older OSes, tag writes via Shortcuts aren't possible.
- **`shortcuts run` returns exit 1 with no output** — the Shortcut threw silently. Open the Shortcut in Shortcuts.app and click **▷ (run)** at the top to see which action fails.
- **No `Identifier` filter under Find Reminders** — falls back to title-contains; let me know and I'll adapt the MCP to pass a unique probe title instead of the UUID.
- **Tag appears in Reminders.app but doesn't sync to iPhone** — Reminders.app uses CloudKit; sync can take a few seconds. Verify with `list_reminders` after ~5 s.

---

## Removing this later

Just delete the Shortcut in Shortcuts.app (right-click → Delete). The MCP detects its absence at startup and disables the tag args automatically.
