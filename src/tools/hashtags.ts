/**
 * Pure helpers for manipulating `#tag` tokens inside a Reminders title.
 *
 * Reminders.app auto-extracts `#tag` patterns from a reminder's title and creates the
 * corresponding `ZREMCDHASHTAG` rows in its SQLite store. We exploit that here: to add or
 * remove a tag on an existing reminder, we edit the title string itself.
 *
 * Tag tokens follow Reminders.app's own grammar: `#` followed by one or more Unicode letters,
 * digits, or underscores. Matching is case-insensitive on input but the title's original casing
 * is preserved on the way out.
 */

const TAG_TOKEN_RE = /#([\p{L}\p{N}_]+)/gu;
// Word-boundary tag matcher for surgical removal. We require either start-of-string or whitespace
// before the `#` so that mid-word `#` characters in user text aren't accidentally chewed up.
const TAG_REMOVE_RE_TEMPLATE = "(?:^|\\s)#TAG(?=\\s|$)";

/** Return the set of tag names (lowercased, without #) present in the title. Deduplicated, sorted. */
export function extractTags(title: string): string[] {
  const seen = new Set<string>();
  for (const m of title.matchAll(TAG_TOKEN_RE)) {
    const name = m[1];
    if (name) seen.add(name.toLowerCase());
  }
  return Array.from(seen).sort();
}

/** Append `#tag` tokens to the title for tags not already present (case-insensitive). */
export function addTagsToTitle(title: string, tags: string[]): string {
  const existing = new Set(extractTags(title));
  const newOnes = tags
    .map((t) => stripLeadingHash(t).trim())
    .filter((t) => t.length > 0)
    .filter((t) => !existing.has(t.toLowerCase()));
  if (newOnes.length === 0) return title;
  const suffix = newOnes.map((t) => `#${t}`).join(" ");
  return (title.trimEnd() + " " + suffix).trimEnd();
}

/** Remove `#tag` tokens from the title (case-insensitive, word-boundary). Collapse whitespace. */
export function removeTagsFromTitle(title: string, tags: string[]): string {
  let out = title;
  for (const raw of tags) {
    const tag = stripLeadingHash(raw).trim();
    if (!tag) continue;
    // Escape regex special chars in the tag (most won't have any but be safe with unicode).
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(TAG_REMOVE_RE_TEMPLATE.replace("TAG", escaped), "giu");
    out = out.replace(re, " ");
  }
  // Collapse internal multi-space runs to single space and trim ends.
  return out.replace(/[ \t]+/g, " ").trim();
}

function stripLeadingHash(s: string): string {
  return s.startsWith("#") ? s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// Self-tests — gated on `--test` so we don't hit `node:test` at import time.
// Run via:  node dist/tools/hashtags.js --test
// ---------------------------------------------------------------------------

if (process.argv.includes("--test")) {
  // Top-level await requires ESM; dynamic import for compat.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  void (async (): Promise<void> => {
    const { test } = await import("node:test");
    const assertModule = await import("node:assert/strict");
    const assert: typeof assertModule.default = assertModule.default;

    test("extractTags: basic + dedup + lowercased", () => {
      assert.deepEqual(extractTags("Buy milk #shopping"), ["shopping"]);
      assert.deepEqual(extractTags("plan #Work and #work today"), ["work"]);
      assert.deepEqual(extractTags("no tags here"), []);
      assert.deepEqual(extractTags("#a #b #c"), ["a", "b", "c"]);
    });

    test("extractTags: unicode letters + digits + underscores", () => {
      assert.deepEqual(extractTags("call #ramón about #2026 #plan_b").sort(), ["2026", "plan_b", "ramón"]);
    });

    test("addTagsToTitle: appends absent, skips present", () => {
      assert.equal(addTagsToTitle("Buy milk", ["shopping"]), "Buy milk #shopping");
      assert.equal(addTagsToTitle("Buy milk #shopping", ["shopping"]), "Buy milk #shopping");
      assert.equal(addTagsToTitle("Buy milk #shopping", ["urgent"]), "Buy milk #shopping #urgent");
      assert.equal(addTagsToTitle("call #Ramón", ["ramón"]), "call #Ramón");
      assert.equal(addTagsToTitle("plan stuff", ["a", "b"]), "plan stuff #a #b");
    });

    test("addTagsToTitle: leading-# input is normalised", () => {
      assert.equal(addTagsToTitle("hi", ["#foo"]), "hi #foo");
    });

    test("addTagsToTitle: empty / whitespace-only tags are ignored", () => {
      assert.equal(addTagsToTitle("hi", ["", "   ", "ok"]), "hi #ok");
    });

    test("removeTagsFromTitle: strips, collapses whitespace", () => {
      assert.equal(removeTagsFromTitle("Buy milk #shopping", ["shopping"]), "Buy milk");
      assert.equal(removeTagsFromTitle("Buy milk #shopping #urgent", ["shopping"]), "Buy milk #urgent");
      assert.equal(removeTagsFromTitle("Buy #x milk #y now", ["x", "y"]), "Buy milk now");
      assert.equal(removeTagsFromTitle("#a #b #c", ["a", "c"]), "#b");
    });

    test("removeTagsFromTitle: case-insensitive", () => {
      assert.equal(removeTagsFromTitle("plan #Work", ["work"]), "plan");
    });

    test("removeTagsFromTitle: does not eat # inside non-tag tokens", () => {
      // We only strip tokens preceded by whitespace or start-of-string. Embedded `#` (rare) survives.
      assert.equal(removeTagsFromTitle("look#here #foo", ["foo"]), "look#here");
    });

    test("removeTagsFromTitle: missing tag is a no-op", () => {
      assert.equal(removeTagsFromTitle("Buy milk", ["shopping"]), "Buy milk");
    });

    test("round-trip: remove then add restores tag set", () => {
      const original = "Buy milk #shopping #urgent";
      const stripped = removeTagsFromTitle(original, ["shopping"]);
      const restored = addTagsToTitle(stripped, ["shopping"]);
      assert.deepEqual(extractTags(restored).sort(), ["shopping", "urgent"]);
    });
  })();
}

// Touch `assert` reference paths for the TS narrower (no-op at runtime).
export const __internal_self_check__ = { extractTags, addTagsToTitle, removeTagsFromTitle };
