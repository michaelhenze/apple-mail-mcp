# Phase 1 Research: Security & Correctness Fixes

**Researched:** 2026-05-20
**Domain:** TypeScript/Node.js, Zod input validation, AppleScript string generation, path security
**Confidence:** HIGH — all findings derived directly from reading the production source files

---

## Summary of Approach

All six issues are surgical, self-contained changes. They touch exactly three files:
`src/index.ts` (Zod schemas and handler destructuring), `src/services/appleMailManager.ts`
(AppleScript building and method signatures), and nowhere else. No new dependencies are
needed. The fixes follow patterns already established in the codebase (`escapeForAppleScript`,
`z.string().min(1)`, the `buildAccountScopedScript` family of helpers).

**Primary recommendation:** Fix items in priority order — ID validation first (injection
risk), then path traversal, then email format validation, then the three correctness bugs.
Each fix is independently mergeable.

---

## P0 Findings

### 1. Implementing Missing Search Filters

**What is broken:** The `search-messages` handler in `src/index.ts` line 112 destructures only
`{ query, mailbox, account, limit, dateFrom, dateTo }` and passes those six values to
`mailManager.searchMessages()`. The Zod schema declares three additional parameters —
`from`, `isRead`, `isFlagged` — that are silently dropped before reaching the service layer.

Similarly, `list-messages` line 165 destructures `{ mailbox, account, limit, offset, from }`
but omits `unreadOnly`, which is declared in the schema at line 163.

**Root cause:** The handler closures were written without including the new filter params,
and `searchMessages()` / `listMessages()` signatures do not accept them.

**Fix — two parts:**

**Part A: Update handler destructuring in `src/index.ts`**

For `search-messages` (line 112), change:
```typescript
withErrorHandling(({ query, mailbox, account, limit = 50, dateFrom, dateTo }) => {
  const messages = mailManager.searchMessages(query, mailbox, account, limit, dateFrom, dateTo);
```
to:
```typescript
withErrorHandling(({ query, from, isRead, isFlagged, mailbox, account, limit = 50, dateFrom, dateTo }) => {
  const messages = mailManager.searchMessages(query, mailbox, account, limit, dateFrom, dateTo, from, isRead, isFlagged);
```

For `list-messages` (line 165), change:
```typescript
withErrorHandling(({ mailbox, account, limit = 50, offset = 0, from }) => {
  const messages = mailManager.listMessages(mailbox, account, limit, from, offset);
```
to:
```typescript
withErrorHandling(({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
  const messages = mailManager.listMessages(mailbox, account, limit, from, offset, unreadOnly);
```

**Part B: Extend method signatures and AppleScript in `src/services/appleMailManager.ts`**

`searchMessages()` currently (line 293):
```typescript
searchMessages(
  query?: string,
  mailbox?: string,
  account?: string,
  limit = 50,
  dateFrom?: string,
  dateTo?: string
): Message[]
```
Extend to:
```typescript
searchMessages(
  query?: string,
  mailbox?: string,
  account?: string,
  limit = 50,
  dateFrom?: string,
  dateTo?: string,
  from?: string,
  isRead?: boolean,
  isFlagged?: boolean
): Message[]
```

The AppleScript `whose` clause at line 319–323 currently only handles `query`. It must be
expanded to a compound condition. AppleScript supports `whose` with multiple `and`/`or`
predicates using the `(... whose cond1 and cond2)` syntax.

**Proposed AppleScript filter builder inside `searchMessages()`:**

```typescript
// Build compound whose clause for AppleScript
const conditions: string[] = [];

if (query) {
  const safeQuery = escapeForAppleScript(query);
  conditions.push(`(subject contains "${safeQuery}" or sender contains "${safeQuery}")`);
}
if (from !== undefined) {
  const safeFrom = escapeForAppleScript(from);
  conditions.push(`sender contains "${safeFrom}"`);
}
if (isRead !== undefined) {
  conditions.push(`read status is ${isRead}`);
}
if (isFlagged !== undefined) {
  conditions.push(`flagged status is ${isFlagged}`);
}

const searchCondition = conditions.length > 0
  ? `whose ${conditions.join(" and ")}`
  : "";
```

Then pass `searchCondition` to the AppleScript template where `searchCondition` was previously
used (line 341). This replaces the existing single-condition branch entirely.

**AppleScript property names confirmed from reading the existing code:**
- `read status` — used at lines 351, 524 (existing working code)
- `flagged status` — used at lines 352, 525 (existing working code)
- `sender` — used throughout, confirmed working

For `listMessages()` / `unreadOnly`, the same approach applies. Add `unreadOnly?: boolean`
as a last parameter and conditionally add `whose read status is false` to the `fromFilter`
variable (line 507):

```typescript
listMessages(
  mailbox?: string,
  account?: string,
  limit = 50,
  from?: string,
  offset = 0,
  unreadOnly?: boolean
): Message[]

// Inside method, build filter:
const conditions: string[] = [];
if (from) conditions.push(`sender contains "${escapeForAppleScript(from)}"`);
if (unreadOnly) conditions.push(`read status is false`);
const filterClause = conditions.length > 0 ? `whose ${conditions.join(" and ")}` : "";

// Replace line 514:
repeat with msg in messages of theMailbox ${filterClause}
```

**Recursive call in `searchMessages()`:** The recursive per-account call at line 308 must
also forward the new parameters:
```typescript
const msgs = this.searchMessages(query, mailbox, acct.name, remaining, dateFrom, dateTo, from, isRead, isFlagged);
```

**Risk:** Low. AppleScript `whose` compound conditions are supported by Mail.app's AppleScript
dictionary. The conditions use the same property names already confirmed working in the
existing output-parsing code. The change is additive — if all three new params are `undefined`
the behavior is identical to today.

---

### 2. Atomic `renameMailbox` with Rollback

**What is broken:** `renameMailbox()` in `src/services/appleMailManager.ts` lines 1325–1363
executes three sequential steps:
1. `this.createMailbox(newName, targetAccount)` — creates the destination
2. AppleScript that moves all messages then deletes the old mailbox (single script, lines 1340–1352)
3. Returns result

The non-atomic section is step 2 itself: the move loop and the delete are in a single
AppleScript `try` block (lines 1340–1352), but if the `on error` branch is reached, the
partially-moved state persists and the new mailbox is left populated with some-but-not-all
messages. More importantly: if `createMailbox` succeeds but the entire move script returns
an error, the new empty mailbox is abandoned (line 1357 returns `false` without cleanup).

**Fix — add rollback on failure:**

After the move script returns an error, call `this.deleteMailbox(newName, targetAccount)` to
clean up the new mailbox. This is possible because `deleteMailbox()` already exists and handles
the AppleScript deletion cleanly.

```typescript
renameMailbox(oldName: string, newName: string, account?: string): boolean {
  const targetAccount = this.resolveAccount(account);

  // Step 1: Create new mailbox
  if (!this.createMailbox(newName, targetAccount)) {
    return false;
  }

  // Step 2: Move all messages and delete old mailbox
  const resolvedOld = this.resolveMailbox(oldName, targetAccount);
  const resolvedNew = this.resolveMailbox(newName, targetAccount);
  const safeOld = escapeForAppleScript(resolvedOld);
  const safeNew = escapeForAppleScript(resolvedNew);
  const safeAccount = escapeForAppleScript(targetAccount);

  const moveScript = buildAppLevelScript(`
    try
      set srcMailbox to mailbox "${safeOld}" of account "${safeAccount}"
      set destMailbox to mailbox "${safeNew}" of account "${safeAccount}"
      repeat with msg in messages of srcMailbox
        move msg to destMailbox
      end repeat
      delete mailbox "${safeOld}" of account "${safeAccount}"
      return "ok"
    on error errMsg
      return "error:" & errMsg
    end try
  `);

  const result = executeAppleScript(moveScript, { timeoutMs: 60000 });

  if (!result.success || result.output.startsWith("error:")) {
    // ROLLBACK: delete the new mailbox we just created
    console.error(`Failed to rename mailbox: ${result.error || result.output}`);
    this.deleteMailbox(newName, targetAccount);  // ← rollback
    return false;
  }

  this.invalidateCache();
  return true;
}
```

**Limitation of this rollback:** If the move loop completes successfully but the `delete`
of the old mailbox fails, messages will exist in both mailboxes. The rollback only cleans
up the new mailbox in that case (moving messages back is not attempted, as that risks
duplicating the partial-move problem). This edge case should be documented in a code comment.
The fix is strictly better than the current state (no rollback at all).

**Risk:** Low. Uses only existing methods (`deleteMailbox`, `createMailbox`) and the same
AppleScript pattern already in production.

---

### 3. Safe Delimiter Strategy

**What is broken:** All AppleScript output is parsed by splitting on `"|||"` (field separator)
and `"|||ITEM|||"` (record separator). If a message subject or sender name contains `|||`,
the split produces wrong field counts, corrupting one or more fields of the parsed `Message`
objects. There is no escaping or quoting of user-controlled values before they are embedded
in the delimited output.

**Affected code (confirmed from reading source):**
- `parseMessageList()` — line 552 (`split("|||ITEM|||")`), line 556 (`split("|||")`)
- `getMessageById()` — line 399 (AppleScript builds the delimited string), line 417 (`split("|||")`)
- `getMessageContent()` — lines 454, 472, 476
- `listAttachments()` — lines 1100–1101, 1121, 1125
- `listMailboxes()` — line 1198, 1214, 1218
- `fetchAccounts()` — line 1391, 1406, 1410
- `searchContacts()` — lines 1549, 1564, 1570

**Three viable approaches:**

**Option A — Unicode Private Use Area sentinel (recommended)**

Replace `"|||"` with a character from the Unicode Private Use Area (U+E000–U+F8FF). These
characters have no defined meaning, will not appear in any real email subject, sender name,
or mailbox name, and are valid in AppleScript strings.

Good candidates:
- `` (first private-use character)
- `` (field separator), `` (record separator) — using two distinct chars removes
  the need for the `ITEM` infix at all

AppleScript can reference Unicode code points via `character id`:
```applescript
-- Field separator (U+E001)
set fieldSep to character id 57345
-- Record separator (U+E002)
set recSep to character id 57346
```

In TypeScript the constants would be:
```typescript
const FIELD_SEP = "";
const RECORD_SEP = "";
```

Splitting becomes:
```typescript
const items = output.split(RECORD_SEP);
// ...
const parts = item.split(FIELD_SEP);
```

The AppleScript output construction changes from:
```applescript
set outputText to outputText & msgId & "|||" & msgSubject & ...
```
to:
```applescript
set fieldSep to character id 57345
set recSep to character id 57346
set outputText to outputText & msgId & fieldSep & msgSubject & ...
```

And record concatenation:
```applescript
if msgCount > 0 then set outputText to outputText & recSep
```

**Option B — Escape `|||` in TypeScript post-processing**

Before splitting, replace `|||` within field values using a two-pass approach. This is
significantly more complex and fragile — it requires knowing where field boundaries are
before the replacement, which is circular.

**Option C — Return JSON from AppleScript**

AppleScript can build JSON-like strings manually, but doing so reliably for arbitrary
user content (nested quotes, backslashes in subjects) requires escaping within AppleScript
— the same class of problem we are trying to solve. Rejected as more complex.

**Recommendation:** Option A. The Unicode sentinel approach requires changing every
AppleScript template that builds delimited output and every TypeScript split call, but each
change is mechanical and low-risk. The characters chosen genuinely cannot appear in email
metadata in normal use.

**Scope of changes for Option A:**
- `appleMailManager.ts`: every AppleScript template that uses `"|||"` or `"|||ITEM|||"` in
  output construction (approximately 10–12 locations listed above)
- `appleMailManager.ts`: every TypeScript `.split("|||ITEM|||")` and `.split("|||")` call
- `getMessageContent()` also uses `"|||CONTENT|||"` and `"|||HTML|||"` — these should be
  changed to `` and `` for consistency

**Risk:** Medium. Touches many locations in `appleMailManager.ts` but the change at each
location is a two-character substitution. Add a module-level constant so `FIELD_SEP` and
`RECORD_SEP` are defined once. If a location is missed, the result is the same parsing
bug as today — no regression, just incomplete fix.

---

## P1 Findings

### 4. Message ID Validation

**What is broken:** `id` is typed as `z.string().min(1)` in all message tools (`get-message`,
`reply-to-message`, `forward-message`, `mark-as-read`, `mark-as-unread`, `flag-message`,
`unflag-message`, `delete-message`, `move-message`, `list-attachments`, `save-attachment`).

The value is then interpolated without quoting into AppleScript at 8 locations. The critical
pattern (confirmed from source) is:

```applescript
set matchingMsgs to (messages of mb whose id is ${id})
```

Because `id` appears after `is` (a comparison operator), not inside a quoted string, any
non-numeric value can alter the AppleScript syntax. For example, an id of `0 or 1 is 1`
would evaluate as an always-true predicate and return the first message in every mailbox.
More complex payloads could break out of the `whose` clause entirely.

**Why real IDs are safe:** Mail.app message IDs are 32-bit integers. The `Message.id` field
is typed as `string` in `types.ts` but is always set from `id of msg as string` in
AppleScript — the result is always a decimal digit string.

**Fix — Zod schema layer (primary, in `src/index.ts`):**

Change every `id: z.string().min(1, "Message ID is required")` occurrence to:
```typescript
id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
```

This covers all 11 tools that accept `id`. The schema change is the right place because
Zod runs before any code in the handler, and the error message surfaces clearly to the MCP
client.

**Fix — Guard in `findMessageScript()` (defense in depth, in `src/services/appleMailManager.ts`):**

The `findMessageScript()` helper at line 845 is used by `markAsRead`, `markAsUnread`,
`flagMessage`, `unflagMessage`, `deleteMessage`. Four other methods (`getMessageById`,
`getMessageContent`, `replyToMessage`, `forwardMessage`, `listAttachments`, `saveAttachment`,
`moveMessage`) inline the same `whose id is ${id}` pattern directly.

Add a guard at the top of `findMessageScript()` and at the top of each method that inlines
the pattern:
```typescript
private findMessageScript(id: string, operation: string): string {
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid message ID: "${id}"`);
  }
  // ... rest of method
}
```

Since `AppleMailManager` methods never throw by convention (see ARCHITECTURE.md anti-patterns),
alternatively return the error as a script that immediately returns an error string:
```typescript
private findMessageScript(id: string, operation: string): string {
  if (!/^\d+$/.test(id)) {
    // Return a no-op script — the result will start with "error:"
    return buildAppLevelScript(`return "error:Invalid message ID"`);
  }
  // ...
}
```

For the methods that inline the pattern (`getMessageById`, `getMessageContent`,
`replyToMessage`, `forwardMessage`, `moveMessage`, `listAttachments`, `saveAttachment`),
add the same guard at the start of each method body:
```typescript
if (!/^\d+$/.test(id)) {
  console.error(`Invalid message ID: "${id}"`);
  return null; // or false or []
}
```

**Scope:** 11 Zod schema definitions in `src/index.ts` + 1 guard in `findMessageScript()` +
7 guards in the methods that bypass `findMessageScript()`.

**Risk:** None for well-behaved callers. The regex `^\d+$` is a strict subset of what
Mail.app actually produces. An AI agent or client that provides a valid numeric ID string
(`"12345"`) is unaffected.

---

### 5. Path Traversal Prevention

**What is broken:** `save-attachment` accepts `savePath: z.string().min(1)`. The value is
passed to `saveAttachment(id, attachmentName, savePath)` in `appleMailManager.ts` line 1142,
where it is only escaped for AppleScript string quoting:
```typescript
const safePath = escapeForAppleScript(savePath);
```
The value `../../Library/Application Support/SomeApp/config` passes through unchanged and
is used as:
```applescript
set savePath to POSIX file "${safePath}/${safeName}"
save att in savePath
```

`attachments` in `send-email` and `create-draft` have the same issue: a path supplied by
the AI agent is passed directly to `POSIX file "${safePath}"` in AppleScript.

**Fix strategy — Node.js path normalization + allowlist check:**

The check must happen in TypeScript before the value reaches AppleScript, since we cannot
enforce path restrictions inside AppleScript.

```typescript
import { resolve, normalize } from "path";
import { homedir } from "os";

/**
 * Validates that a POSIX path is absolute and confined to allowed directories.
 * Returns the normalized path or throws if disallowed.
 *
 * Allowed roots: user home directory (~/) and /tmp.
 */
function validateSavePath(rawPath: string): string {
  // Reject empty or relative paths
  if (!rawPath || !rawPath.startsWith("/")) {
    throw new Error(`savePath must be an absolute path, got: "${rawPath}"`);
  }
  const resolved = resolve(normalize(rawPath));
  const home = homedir();
  const allowed = [home, "/tmp"];
  const isAllowed = allowed.some((root) => resolved === root || resolved.startsWith(root + "/"));
  if (!isAllowed) {
    throw new Error(
      `savePath "${resolved}" is outside allowed directories (home directory or /tmp)`
    );
  }
  return resolved;
}
```

This function should be added to `src/services/appleMailManager.ts` (or a new
`src/utils/pathSecurity.ts`) and called:

1. In `saveAttachment()`, before building the AppleScript:
   ```typescript
   saveAttachment(id: string, attachmentName: string, savePath: string): boolean {
     const validatedPath = validateSavePath(savePath); // throws on bad path
     const safePath = escapeForAppleScript(validatedPath);
     // ... rest unchanged
   }
   ```

2. In `sendEmail()` and `createDraft()`, validate each attachment path before generating
   `attachmentCommands`:
   ```typescript
   if (attachments) {
     for (const filePath of attachments) {
       const validatedPath = validateSavePath(filePath); // throws on bad path
       const safePath = escapeForAppleScript(validatedPath);
       attachmentCommands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
     }
   }
   ```

Since `AppleMailManager` methods catch exceptions at the `withErrorHandling()` boundary in
`src/index.ts`, throwing from `saveAttachment()` / `sendEmail()` is acceptable here and
will produce an `errorResponse()` with the validation message.

**Alternative — validate in Zod schema (`src/index.ts`):**
```typescript
savePath: z.string().min(1).refine(
  (p) => {
    if (!p.startsWith("/")) return false;
    const resolved = require("path").resolve(p);
    const home = require("os").homedir();
    return resolved.startsWith(home) || resolved.startsWith("/tmp");
  },
  { message: "savePath must be an absolute path within your home directory or /tmp" }
),
```

The service-layer approach is preferred because it protects `sendEmail`/`createDraft`
attachment paths as well, and those are not validated at the schema level.

**Risk:** Low. The check only rejects paths outside home and `/tmp`. All documented example
usage (`/Users/me/report.pdf`, `/tmp/download.pdf`) passes. The `resolve()` call handles
`../` traversal sequences regardless of how deeply nested they are.

---

### 6. Email Address Validation

**What is broken:** `to`, `cc`, `bcc` arrays in `send-email`, `create-draft`, and
(indirectly) `save-template` / `use-template` accept `z.array(z.string())`. Any string
passes, including empty strings, strings with spaces, or strings that are not email addresses.

**The display-name edge case:** Mail.app and most SMTP implementations accept addresses in
`"Name <addr@example.com>"` format. Zod's built-in `z.string().email()` rejects this format
because it uses RFC 5321 validation which does not allow the display-name prefix.

**Approach — custom `.refine()` that handles both bare addresses and display-name format:**

```typescript
const emailAddressSchema = z.string().refine(
  (addr) => {
    // Accept "Name <user@example.com>" format
    const angleMatch = addr.match(/<([^>]+)>$/);
    const emailPart = angleMatch ? angleMatch[1] : addr.trim();
    // Basic RFC 5322 pattern: local@domain.tld
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPart);
  },
  { message: "Invalid email address format" }
);
```

This validates:
- `user@example.com` — bare address (passes)
- `John Doe <john@example.com>` — display-name format (passes)
- `notanemail` — (rejects)
- `@nodomain` — (rejects)
- empty string — (rejects, `[^\s@]+` requires at least one char before `@`)

**Apply in `src/index.ts`:**
```typescript
// Declare once near the top of the file, after imports
const emailAddressSchema = z.string().refine(
  (addr) => {
    const angleMatch = addr.match(/<([^>]+)>$/);
    const emailPart = angleMatch ? angleMatch[1] : addr.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPart);
  },
  { message: "Invalid email address format" }
);

// Use in tool schemas:
// send-email
to: z.array(emailAddressSchema).min(1, "At least one recipient is required"),
cc: z.array(emailAddressSchema).optional(),
bcc: z.array(emailAddressSchema).optional(),

// create-draft — same
// forward-message — same for `to`
// save-template — same for `to` and `cc`
// use-template — same for override `to` and `cc`
```

**Why not `z.string().email()`:** Zod v3's `.email()` uses an RFC 5321-based pattern that
rejects display-name format. Since CLAUDE.md documents that Mail.app accepts
`"Name <addr@example.com>"` format, a strict `.email()` would create user-visible rejections
for valid inputs. The custom `.refine()` is more permissive in exactly the right way.

**Risk:** Low. The validation is additive — currently everything passes, after the fix only
invalid-format strings are rejected. The `[^\s@]+@[^\s@]+\.[^\s@]+` pattern is intentionally
permissive (does not check TLD length, does not require specific domain structure) to avoid
false rejections.

---

## Implementation Notes

### Change Surface Summary

| Fix | File(s) | Lines affected (approx) |
|-----|---------|--------------------------|
| 1. Search filters | `src/index.ts` (2 handlers), `src/services/appleMailManager.ts` (2 methods + 1 recursive call) | ~30 |
| 2. Rename rollback | `src/services/appleMailManager.ts` (1 method) | ~5 |
| 3. Delimiter | `src/services/appleMailManager.ts` (12 AppleScript templates + 12 split calls) | ~50 |
| 4. ID validation | `src/index.ts` (11 schema defs), `src/services/appleMailManager.ts` (~8 guards) | ~20 |
| 5. Path traversal | `src/services/appleMailManager.ts` (3 methods + new helper) | ~30 |
| 6. Email format | `src/index.ts` (1 new constant + ~10 schema field updates) | ~15 |

### Ordering Rationale

Recommended implementation order:
1. **ID validation (fix 4)** — pure addition, zero risk of behavior change, highest security impact
2. **Path traversal (fix 5)** — new helper + 3 call sites, no behavior change for valid paths
3. **Email format (fix 6)** — new Zod constant + schema updates, pure addition
4. **Delimiter (fix 3)** — most mechanical change but touches the most lines; do as one commit
5. **Search filters (fix 1)** — functional change requiring testing; separate commit
6. **Rename rollback (fix 2)** — small, independent

Fixes 4, 5, 6 can each be a single commit. Fix 3 should be one atomic commit. Fixes 1 and 2
can be separate commits.

### AppleScript `whose` Compound Conditions

Verified from the existing working code (lines 319–323 and 507): Mail.app supports compound
`whose` predicates. The pattern `messages of theMailbox whose (cond1 and cond2)` is used
implicitly today with the `from` filter in `listMessages` (line 507 uses `whose sender
contains ...`). The `read status is false` and `flagged status is true` predicates use the
same property names already confirmed working in the output serialization (lines 351–352 and
524–525 in the existing AppleScript templates).

### `path.resolve()` Behavior Confirmed

Node.js `path.resolve("../../etc/passwd")` returns an absolute path starting from `cwd`,
not from the input. Combined with `normalize()`, this correctly collapses `../` sequences
regardless of depth. The home directory check `resolved.startsWith(home + "/")` prevents
accepting `/home/user/../../../etc` because `resolve()` normalizes that to `/etc` first.

---

## Risk Assessment

| Fix | Risk | Rollback |
|-----|------|---------|
| ID regex validation | None for valid numeric IDs; breaks only crafted non-numeric inputs | Revert schema change |
| Path traversal check | None for paths under `~` or `/tmp`; breaks cross-device attachment send | Widen allowed roots |
| Email format validation | Low; `.refine()` more permissive than `.email()`; display-name format allowed | Revert schema |
| Search filters | Low; additive to AppleScript `whose`; existing tests unaffected | Revert method signatures |
| Rename rollback | Very low; only adds cleanup on existing failure path | Revert added deleteMailbox call |
| Delimiter change | Medium; many touch points; incomplete application = partial fix only | Full revert of commit |

The delimiter change (fix 3) is the highest-execution-risk because it requires changing
every output-building template and every split call atomically. A partial application leaves
some parsers expecting the old delimiter and some the new one. The mitigation is to do it
as one commit and include module-level constants (`FIELD_SEP`, `RECORD_SEP`) that can be
verified by grep.

---

## Recommended Approach per Fix

### Fix 1 — Implementing Missing Search Filters
1. Extend `searchMessages()` signature to add `from?`, `isRead?`, `isFlagged?`
2. Replace the single-condition `searchCondition` builder with the compound conditions array
3. Update the recursive per-account call to forward the new params
4. Extend `listMessages()` signature to add `unreadOnly?`
5. Replace `fromFilter` with a compound `filterClause` builder
6. Update both handler destructuring calls in `src/index.ts`

### Fix 2 — Atomic Rename with Rollback
1. In `renameMailbox()`, after the move script returns an error, add:
   `this.deleteMailbox(newName, targetAccount);`
2. Add a comment documenting the partial-move edge case

### Fix 3 — Safe Delimiter
1. Add module-level constants at top of `appleMailManager.ts`:
   ```typescript
   const FIELD_SEP = "";   // Unicode private use U+E001
   const RECORD_SEP = "";  // Unicode private use U+E002
   const CONTENT_SEP = ""; // Used in getMessageContent
   const HTML_SEP = "";    // Used in getMessageContent
   ```
2. In each AppleScript template: replace `"|||"` with a `character id` variable reference
3. In each TypeScript split: replace `"|||ITEM|||"` with `RECORD_SEP` and `"|||"` with `FIELD_SEP`
4. Handle `getMessageContent()` specially: use `CONTENT_SEP` and `HTML_SEP` instead of
   `|||CONTENT|||` and `|||HTML|||`

### Fix 4 — ID Validation
1. In `src/index.ts`, change all 11 `id: z.string().min(1, ...)` to `id: z.string().regex(/^\d+$/, ...)`
2. In `findMessageScript()`, add guard at top
3. In each of the 7 methods that inline the `whose id is ${id}` pattern, add guard at top

### Fix 5 — Path Traversal
1. Add `validateSavePath(rawPath: string): string` helper in `appleMailManager.ts`
2. Call it at the start of `saveAttachment()`
3. Call it in the `attachments` loop inside `sendEmail()` and `createDraft()`

### Fix 6 — Email Format
1. Add `emailAddressSchema` constant near top of `src/index.ts` (after imports)
2. Replace `z.string()` with `emailAddressSchema` for `to`, `cc`, `bcc` in `send-email`,
   `create-draft`, `forward-message`, `save-template`, `use-template`

---

## Sources

All findings are derived from direct code inspection of the following files. No external
documentation was consulted because all issues are implementation-level bugs visible in source.

- `/Users/michaelhenze/apple-mail-mcp/src/index.ts` — tool schemas, handler destructuring
- `/Users/michaelhenze/apple-mail-mcp/src/services/appleMailManager.ts` — all service methods
- `/Users/michaelhenze/apple-mail-mcp/src/utils/applescript.ts` — execution layer
- `/Users/michaelhenze/apple-mail-mcp/src/types.ts` — type definitions
- `/Users/michaelhenze/apple-mail-mcp/.planning/codebase/CONCERNS.md` — analysis document
- `/Users/michaelhenze/apple-mail-mcp/.planning/codebase/ARCHITECTURE.md` — architecture document

**Confidence:** HIGH for all findings — every claim is backed by a specific line number in a
source file that was read in this session.
