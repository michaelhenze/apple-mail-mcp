# Phase 1: Security & Correctness Fixes

## Goal

Fix all P0 (correctness/data safety) and P1 (security) issues identified in CONCERNS.md.
After this phase: zero silent parameter drops, zero AppleScript injection vectors, zero path
traversal risk, all changes verified by automated tests.

Files touched by this phase:
- `src/index.ts` — Zod schemas and handler destructuring (986 lines)
- `src/services/appleMailManager.ts` — core service (1931 lines)
- `src/__tests__/security.test.ts` — new test file (created in Task 7)

---

## Success Criteria

1. `grep -c 'whose id is \${id}' src/services/appleMailManager.ts` returns 0 — all ID
   interpolations are guarded by the numeric regex.
2. `grep -c '"|||"' src/services/appleMailManager.ts` returns 0 — no plain pipe delimiter
   literals remain; only `FIELD_SEP` / `RECORD_SEP` constants are used.
3. `grep -c 'z.string().min(1, "Message ID' src/index.ts` returns 0 — all 11 `id` fields
   use the new `.regex()` schema.
4. `npm test` passes with no failures.
5. `npx tsc --noEmit` passes with no type errors.
6. `search-messages` called with `from`, `isRead`, `isFlagged` parameters returns filtered
   results (verified by reading the AppleScript output section in the test).
7. `list-messages` called with `unreadOnly: true` applies the filter (verified by test).

---

## Threat Model

### Trust Boundaries

| Boundary | Description |
|----------|-------------|
| MCP client → `src/index.ts` | All tool parameters arrive here; Zod validates before handlers run |
| `src/index.ts` → `AppleMailManager` | Validated params cross into service; service must also guard |
| `AppleMailManager` → `osascript` | AppleScript strings are built here; injection happens if unguarded |
| AI agent → filesystem | `savePath` and attachment paths reach `osascript` as POSIX paths |

### STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-1-01 | Tampering | `whose id is ${id}` in 8 AppleScript templates | mitigate | Zod `.regex(/^\d+$/)` on all 11 `id` schemas + numeric guard in `findMessageScript()` and 7 inline methods |
| T-1-02 | Tampering | `savePath` passed to `POSIX file "${safePath}"` without normalization | mitigate | `validateSavePath()` helper using `path.resolve()` + allowlist check before AppleScript build |
| T-1-03 | Tampering | Attachment paths in `sendEmail()` / `createDraft()` loops | mitigate | Same `validateSavePath()` called in attachment path loop |
| T-1-04 | Spoofing | Invalid email addresses accepted silently by `to`/`cc`/`bcc` schemas | mitigate | `emailAddressSchema` Zod refine on all 5 tools' recipient arrays |
| T-1-05 | Tampering | `|||` delimiter collision corrupts parsed message fields | mitigate | Replace with Unicode PUA sentinels `FIELD_SEP` (U+E001) / `RECORD_SEP` (U+E002) |
| T-1-06 | Denial of Service | Partial `renameMailbox` failure leaves orphan mailbox | mitigate | Rollback via `this.deleteMailbox(newName)` on move-script failure |

---

## Tasks

---

### Task 1: Safe Delimiter Replacement (Atomic)

**Priority:** P0 — data corruption  
**Files:** `src/services/appleMailManager.ts`  
**Commit must be atomic:** both AppleScript templates and TypeScript split calls in one commit.

#### Steps

**Step 1 — Add module-level constants immediately after the `MAILBOX_ALIASES` block (around line 104), before the class definition:**

```typescript
// Safe output delimiters — Unicode Private Use Area characters that cannot
// appear in real email subjects, sender names, or mailbox names.
// U+E001 = field separator (replaces "|||")
// U+E002 = record separator (replaces "|||ITEM|||")
// U+E003 = content separator (replaces "|||CONTENT|||" in getMessageContent)
// U+E004 = html separator (replaces "|||HTML|||" in getMessageContent)
const FIELD_SEP = "";
const RECORD_SEP = "";
const CONTENT_SEP = "";
const HTML_SEP = "";
```

**Step 2 — In every AppleScript template that builds delimited output, declare the
separator variables at the top of the AppleScript block and use them instead of string
literals. Pattern to apply:**

Old AppleScript (inline string literal):
```applescript
set outputText to outputText & msgId & "|||" & msgSubject & ...
if msgCount > 0 then set outputText to outputText & "|||ITEM|||"
```

New AppleScript (character id references):
```applescript
set fieldSep to character id 57345
set recSep to character id 57346
set outputText to outputText & msgId & fieldSep & msgSubject & ...
if msgCount > 0 then set outputText to outputText & recSep
```

Apply this substitution at every location listed below.

**Locations with `"|||ITEM|||"` record separator in AppleScript:**

| Method | AppleScript line (approx) | Action |
|--------|--------------------------|--------|
| `searchMessages()` | line 353 | Replace `"|||ITEM|||"` with `recSep`; add `set recSep to character id 57346` at top of `searchCommand` block |
| `listMessages()` | line 526 | Same |
| `listAttachments()` | line 1100 | Same |
| `listMailboxes()` | line 1200 | Uses `set AppleScript's text item delimiters to "|||ITEM|||"` — change to `set AppleScript's text item delimiters to (character id 57346)` |
| `fetchAccounts()` | line 1393 | Same as `listMailboxes` — change text item delimiter |
| `listRules()` | line ~1462 | Same as `listMailboxes` |
| `searchContacts()` | line ~1553 | Same as `listMailboxes` |

**Locations with `"|||"` field separator in AppleScript:**

| Method | AppleScript line (approx) | Change |
|--------|--------------------------|--------|
| `searchMessages()` | line 354 | Replace each `"|||"` with `fieldSep` |
| `listMessages()` | line 527 | Same |
| `getMessageById()` | line ~399 | Replace `"|||"` in return statement with `fieldSep`; add `set fieldSep to character id 57345` |
| `listAttachments()` | line 1101 | Same |
| `listMailboxes()` | line 1198 | Replace `"|||"` with `(character id 57345)` — use direct character id since this is the list-accumulation pattern |
| `fetchAccounts()` | line 1391 | Same |
| `listRules()` | line ~1460 | Same |
| `searchContacts()` | line ~1549 | Same |

**For `getMessageContent()` (lines 454, 472, 476) — uses distinct `|||CONTENT|||` and `|||HTML|||`:**

AppleScript return (line 454):
```applescript
-- Old:
return msgSubject & "|||CONTENT|||" & msgContent & "|||HTML|||" & htmlContent
-- New (add at top of script block):
set contentSep to character id 57347
set htmlSep to character id 57348
return msgSubject & contentSep & msgContent & htmlSep & htmlContent
```

**Step 3 — Update all TypeScript `.split()` calls to use the new constants:**

| Method | Old call | New call |
|--------|----------|---------|
| `parseMessageList()` line 552 | `output.split("|||ITEM|||")` | `output.split(RECORD_SEP)` |
| `parseMessageList()` line 556 | `item.split("|||")` | `item.split(FIELD_SEP)` |
| `getMessageById()` line 417 | `result.output.split("|||")` | `result.output.split(FIELD_SEP)` |
| `getMessageContent()` line 472 | `result.output.split("|||HTML|||")` | `result.output.split(HTML_SEP)` |
| `getMessageContent()` line 476 | `contentPart.split("|||CONTENT|||")` | `contentPart.split(CONTENT_SEP)` |
| `listAttachments()` line 1121 | `result.output.split("|||ITEM|||")` | `result.output.split(RECORD_SEP)` |
| `listAttachments()` line 1125 | `item.split("|||")` | `item.split(FIELD_SEP)` |
| `listMailboxes()` line 1214 | `result.output.split("|||ITEM|||")` | `result.output.split(RECORD_SEP)` |
| `listMailboxes()` line 1218 | `item.split("|||")` | `item.split(FIELD_SEP)` |
| `fetchAccounts()` line 1406 | `result.output.split("|||ITEM|||")` | `result.output.split(RECORD_SEP)` |
| `fetchAccounts()` line 1410 | `item.split("|||")` | `item.split(FIELD_SEP)` |
| `listRules()` line ~1472 | `result.output.split("|||ITEM|||")` | `result.output.split(RECORD_SEP)` |
| `listRules()` line ~1476 | `item.split("|||")` | `item.split(FIELD_SEP)` |
| `searchContacts()` line ~1564 | `result.output.split("|||ITEM|||")` | `result.output.split(RECORD_SEP)` |
| `searchContacts()` line ~1568 | `item.split("|||")` | `item.split(FIELD_SEP)` |

**Step 4 — Verify completeness before committing:**
```bash
grep -n '"|||"' src/services/appleMailManager.ts
grep -n '"|||ITEM|||"' src/services/appleMailManager.ts
grep -n '"|||CONTENT|||"' src/services/appleMailManager.ts
grep -n '"|||HTML|||"' src/services/appleMailManager.ts
```
All four commands must return zero matches. If any match remains, fix it before committing.

**Verification:**
```bash
npx tsc --noEmit
grep -c '"|||"' src/services/appleMailManager.ts   # must output 0
grep -c '"|||ITEM|||"' src/services/appleMailManager.ts  # must output 0
```

**Done:** No pipe-delimiter string literals remain in `appleMailManager.ts`. TypeScript
compiles cleanly. All split calls reference `FIELD_SEP`, `RECORD_SEP`, `CONTENT_SEP`, or
`HTML_SEP` constants.

---

### Task 2: Implement Missing Search/List Filters

**Priority:** P0 — silent parameter drops  
**Files:** `src/index.ts` (lines 112, 165), `src/services/appleMailManager.ts` (lines 293–373, 495–545)

#### Steps

**Step 1 — Fix `search-messages` handler destructuring in `src/index.ts` (line 112).**

Current (line 112):
```typescript
withErrorHandling(({ query, mailbox, account, limit = 50, dateFrom, dateTo }) => {
  const messages = mailManager.searchMessages(query, mailbox, account, limit, dateFrom, dateTo);
```

Replace with:
```typescript
withErrorHandling(({ query, from, isRead, isFlagged, mailbox, account, limit = 50, dateFrom, dateTo }) => {
  const messages = mailManager.searchMessages(query, mailbox, account, limit, dateFrom, dateTo, from, isRead, isFlagged);
```

**Step 2 — Fix `list-messages` handler destructuring in `src/index.ts` (line 165).**

Current (line 165):
```typescript
withErrorHandling(({ mailbox, account, limit = 50, offset = 0, from }) => {
  const messages = mailManager.listMessages(mailbox, account, limit, from, offset);
```

Replace with:
```typescript
withErrorHandling(({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
  const messages = mailManager.listMessages(mailbox, account, limit, from, offset, unreadOnly);
```

**Step 3 — Extend `searchMessages()` signature in `appleMailManager.ts` (lines 293–300).**

Current signature:
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

New signature (append three optional params at the end):
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

**Step 4 — Update the recursive per-account call in `searchMessages()` (line 308).**

Current (line 308):
```typescript
const msgs = this.searchMessages(query, mailbox, acct.name, remaining, dateFrom, dateTo);
```

Replace with:
```typescript
const msgs = this.searchMessages(query, mailbox, acct.name, remaining, dateFrom, dateTo, from, isRead, isFlagged);
```

**Step 5 — Replace the single-condition `searchCondition` builder in `searchMessages()` with a
compound conditions array (lines 318–322).**

Current (lines 318–322):
```typescript
let searchCondition = "";
if (query) {
  const safeQuery = escapeForAppleScript(query);
  searchCondition = `whose subject contains "${safeQuery}" or sender contains "${safeQuery}"`;
}
```

Replace with:
```typescript
const searchConditions: string[] = [];

if (query) {
  const safeQuery = escapeForAppleScript(query);
  searchConditions.push(`(subject contains "${safeQuery}" or sender contains "${safeQuery}")`);
}
if (from !== undefined) {
  const safeFrom = escapeForAppleScript(from);
  searchConditions.push(`sender contains "${safeFrom}"`);
}
if (isRead !== undefined) {
  searchConditions.push(`read status is ${isRead}`);
}
if (isFlagged !== undefined) {
  searchConditions.push(`flagged status is ${isFlagged}`);
}

const searchCondition = searchConditions.length > 0
  ? `whose (${searchConditions.join(" and ")})`
  : "";
```

**Step 6 — Extend `listMessages()` signature (lines 495–500) and replace the `fromFilter`
builder with a compound clause builder.**

Current signature (lines 495–500):
```typescript
listMessages(
  mailbox?: string,
  account?: string,
  limit = 50,
  from?: string,
  offset = 0
): Message[]
```

New signature:
```typescript
listMessages(
  mailbox?: string,
  account?: string,
  limit = 50,
  from?: string,
  offset = 0,
  unreadOnly?: boolean
): Message[]
```

Current filter builder (lines 506–507):
```typescript
const safeFrom = from ? escapeForAppleScript(from) : "";
const fromFilter = from ? `whose sender contains "${safeFrom}"` : "";
```

Replace with:
```typescript
const listConditions: string[] = [];
if (from) {
  listConditions.push(`sender contains "${escapeForAppleScript(from)}"`);
}
if (unreadOnly) {
  listConditions.push(`read status is false`);
}
const fromFilter = listConditions.length > 0
  ? `whose (${listConditions.join(" and ")})`
  : "";
```

The variable is named `fromFilter` to preserve the template literal reference at line 514
(`repeat with msg in messages of theMailbox ${fromFilter}`). No change to that line needed.

**Verification:**
```bash
npx tsc --noEmit
```

**Done:** `searchMessages` and `listMessages` type-check with the new signatures. The handler
destructuring in `src/index.ts` no longer silently drops `from`, `isRead`, `isFlagged`, or
`unreadOnly`. The compound `whose` clause uses only AppleScript property names already
confirmed working in the codebase (`sender`, `read status`, `flagged status`).

---

### Task 3: Atomic `renameMailbox` with Rollback

**Priority:** P0 — data safety  
**Files:** `src/services/appleMailManager.ts` (lines 1325–1363)

#### Steps

**Step 1 — In `renameMailbox()`, locate the failure branch at lines 1356–1358:**

Current (lines 1356–1358):
```typescript
if (!result.success || result.output.startsWith("error:")) {
  console.error(`Failed to rename mailbox: ${result.error || result.output}`);
  return false;
}
```

Replace with:
```typescript
if (!result.success || result.output.startsWith("error:")) {
  console.error(`Failed to rename mailbox: ${result.error || result.output}`);
  // ROLLBACK: Delete the new mailbox we just created to restore original state.
  // Note: If the move loop ran partially before failing, some messages may exist
  // in both mailboxes at this point. We delete the new mailbox only; the old
  // mailbox retains its full original set. This is strictly better than leaving
  // an empty new mailbox orphaned.
  this.deleteMailbox(newName, targetAccount);
  return false;
}
```

No other changes to `renameMailbox()` are needed. The `createMailbox`, `executeAppleScript`,
and `deleteMailbox` calls already exist and follow the established patterns.

**Verification:**
```bash
npx tsc --noEmit
```

**Done:** On move-script failure, `deleteMailbox(newName)` is called before returning
`false`, cleaning up the orphan mailbox. A comment documents the partial-move edge case.

---

### Task 4: Message ID Validation (AppleScript Injection)

**Priority:** P1 — security  
**Files:** `src/index.ts` (11 schema definitions), `src/services/appleMailManager.ts`
(`findMessageScript()` + 7 methods with inline `whose id is ${id}` patterns)

#### Steps

**Step 1 — In `src/index.ts`, update all 11 `id` schema fields from `.min(1, ...)` to
`.regex(/^\d+$/, ...)`.**

Locate every occurrence of the pattern `id: z.string().min(1, "Message ID is required")`
(there are exactly 11 occurrences at the following lines):

| Tool | Line | Current | Replace with |
|------|------|---------|-------------|
| `get-message` | 135 | `z.string().min(1, "Message ID is required")` | `z.string().regex(/^\d+$/, "Message ID must be numeric")` |
| `reply-to-message` | 244 | same | same |
| `forward-message` | 265 | same | same |
| `mark-as-read` | 288 | same | same |
| `mark-as-unread` | 303 | same | same |
| `flag-message` | 324 | same | same |
| `unflag-message` | 339 | same | same |
| `delete-message` | 360 | same | same |
| `move-message` | 378 | same | same |
| `list-attachments` | 534 | same | same |
| `save-attachment` | 559 | same | same |

The `.min(1)` is implied by `.regex(/^\d+$/)` (empty string does not match `\d+`), so it
can be removed. Keep the error message as the `.regex()` second argument.

**Step 2 — Add numeric guard at the top of `findMessageScript()` in
`appleMailManager.ts` (line 845).**

Current method opening:
```typescript
private findMessageScript(id: string, operation: string): string {
  return buildAppLevelScript(`
```

Replace with (defense-in-depth guard before the template build):
```typescript
private findMessageScript(id: string, operation: string): string {
  if (!/^\d+$/.test(id)) {
    return buildAppLevelScript(`return "error:Invalid message ID"`);
  }
  return buildAppLevelScript(`
```

**Step 3 — Add the same guard at the top of each method that inlines `whose id is ${id}`
without going through `findMessageScript()`.**

The 7 methods to guard (confirmed by grep: lines 387, 445, 763, 814, 956, 1091, 1151):

For methods that return `Message | null` (`getMessageById` line 381, `getMessageContent`
line 439), add at the top of the method body:
```typescript
if (!/^\d+$/.test(id)) {
  console.error(`Invalid message ID: "${id}"`);
  return null;
}
```

For methods that return `boolean` (`replyToMessage` line 753, `forwardMessage` line 799,
`moveMessage` line 945):
```typescript
if (!/^\d+$/.test(id)) {
  console.error(`Invalid message ID: "${id}"`);
  return false;
}
```

For methods that return `Attachment[]` (`listAttachments` — locate method, around line 1078):
```typescript
if (!/^\d+$/.test(id)) {
  console.error(`Invalid message ID: "${id}"`);
  return [];
}
```

For `saveAttachment` (line 1142) that returns `boolean`:
```typescript
if (!/^\d+$/.test(id)) {
  console.error(`Invalid message ID: "${id}"`);
  return false;
}
```

**Verification:**
```bash
npx tsc --noEmit
grep -c 'z.string().min(1, "Message ID' src/index.ts   # must output 0
grep -c '\.regex.*\\\\d' src/index.ts                   # must output 11
```

**Done:** All 11 Zod schemas reject non-numeric IDs at the schema layer. All 8 service
methods with `whose id is ${id}` are guarded at the service layer. A crafted non-numeric
ID cannot reach the AppleScript interpolation point.

---

### Task 5: Path Traversal Prevention

**Priority:** P1 — security  
**Files:** `src/services/appleMailManager.ts` (new helper + 3 call sites)

#### Steps

**Step 1 — Add `import` statements at the top of `appleMailManager.ts`.**

After the existing `import { executeAppleScript }` line at line 16, add:
```typescript
import { resolve, normalize } from "path";
import { homedir } from "os";
```

**Step 2 — Add `validateSavePath()` helper function inside `appleMailManager.ts` after
the `escapeForAppleScript` function block (after line 51) and before `parseAppleScriptDate`.**

```typescript
/**
 * Validates that a file path is absolute and confined to allowed directories.
 *
 * Resolves all `../` sequences using `path.resolve()` before checking against
 * the allowlist. This prevents traversal attacks regardless of nesting depth.
 *
 * Allowed roots: user home directory and /tmp.
 *
 * @param rawPath - Raw path string from caller
 * @returns Normalized absolute path
 * @throws Error if path is relative or outside allowed directories
 */
function validateSavePath(rawPath: string): string {
  if (!rawPath) {
    throw new Error("Path must not be empty");
  }
  // Expand ~/
  const expandedPath = rawPath.startsWith("~/")
    ? rawPath.replace("~/", `${homedir()}/`)
    : rawPath;

  // Reject relative paths (after ~ expansion)
  if (!expandedPath.startsWith("/")) {
    throw new Error(`Path must be absolute, got: "${rawPath}"`);
  }

  const resolved = resolve(normalize(expandedPath));
  const home = homedir();
  const allowed = [home, "/tmp"];
  const isAllowed = allowed.some(
    (root) => resolved === root || resolved.startsWith(`${root}/`)
  );

  if (!isAllowed) {
    throw new Error(
      `Path "${resolved}" is outside allowed directories (home directory or /tmp)`
    );
  }

  return resolved;
}
```

**Step 3 — Call `validateSavePath()` in `saveAttachment()` (line 1142), before the
`escapeForAppleScript` call.**

Current (lines 1142–1144):
```typescript
saveAttachment(id: string, attachmentName: string, savePath: string): boolean {
  const safeName = escapeForAppleScript(attachmentName);
  const safePath = escapeForAppleScript(savePath);
```

Replace the first two assignment lines with:
```typescript
saveAttachment(id: string, attachmentName: string, savePath: string): boolean {
  if (!/^\d+$/.test(id)) {
    console.error(`Invalid message ID: "${id}"`);
    return false;
  }
  const validatedPath = validateSavePath(savePath);  // throws on bad path
  const safeName = escapeForAppleScript(attachmentName);
  const safePath = escapeForAppleScript(validatedPath);
```

Note: The ID guard from Task 4 is placed here too for completeness since `saveAttachment`
is listed in the Task 4 guard table above.

**Step 4 — Validate attachment paths in `sendEmail()` (lines 618–623).**

Current (lines 618–623):
```typescript
if (attachments) {
  for (const filePath of attachments) {
    const safePath = escapeForAppleScript(filePath);
    attachmentCommands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
  }
}
```

Replace with:
```typescript
if (attachments) {
  for (const filePath of attachments) {
    const validatedFilePath = validateSavePath(filePath);  // throws on traversal
    const safePath = escapeForAppleScript(validatedFilePath);
    attachmentCommands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
  }
}
```

**Step 5 — Validate attachment paths in `createDraft()` (lines 700–708, parallel structure
to `sendEmail`).**

Apply the exact same substitution as Step 4 in the `createDraft()` attachment loop.

**Verification:**
```bash
npx tsc --noEmit
```
Manually confirm `validateSavePath("../../etc/passwd")` throws (covered by Task 7 unit test).

**Done:** `validateSavePath()` is defined and called in `saveAttachment()`, `sendEmail()`,
and `createDraft()`. Paths outside `~/` and `/tmp` throw before reaching AppleScript. The
`path.resolve()` call handles `../` regardless of nesting depth.

---

### Task 6: Email Address Validation

**Priority:** P1 — security/correctness  
**Files:** `src/index.ts` (new constant + 5 tool schemas)

#### Steps

**Step 1 — Add `emailAddressSchema` constant to `src/index.ts`.**

Place it after the imports block (after line 27, before the server initialization at line 40):

```typescript
// =============================================================================
// Shared Validation Schemas
// =============================================================================

/**
 * Validates an email address, accepting both bare addresses and display-name format.
 *
 * Accepts:
 *   user@example.com                  (bare RFC 5321 address)
 *   "John Doe <john@example.com>"     (display-name format used by Mail.app)
 *
 * Does NOT use z.string().email() because Zod v3's built-in email validator
 * rejects display-name format per RFC 5321, but Mail.app documents and accepts
 * this format for all send operations.
 */
const emailAddressSchema = z.string().refine(
  (addr) => {
    // Extract address from "Name <addr@domain>" format if present
    const angleMatch = addr.match(/<([^>]+)>$/);
    const emailPart = angleMatch ? angleMatch[1] : addr.trim();
    // Require: non-whitespace-non-at chars @ non-whitespace-non-at chars . non-whitespace-non-at chars
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPart);
  },
  { message: "Invalid email address format" }
);
```

**Step 2 — Apply `emailAddressSchema` to all recipient array fields across 5 tools.**

For each tool listed below, replace `z.array(z.string())` (or `z.array(z.string()).optional()`)
with `z.array(emailAddressSchema)` (or `z.array(emailAddressSchema).optional()`). The
`.min()` and `.describe()` chaining on the outer array stays unchanged.

| Tool | Field | Line (approx) | Current | New |
|------|-------|---------------|---------|-----|
| `send-email` | `to` | 188 | `z.array(z.string()).min(1, ...)` | `z.array(emailAddressSchema).min(1, ...)` |
| `send-email` | `cc` | 191 | `z.array(z.string()).optional()` | `z.array(emailAddressSchema).optional()` |
| `send-email` | `bcc` | 192 | `z.array(z.string()).optional()` | `z.array(emailAddressSchema).optional()` |
| `create-draft` | `to` | 216 | same | same |
| `create-draft` | `cc` | 219 | same | same |
| `create-draft` | `bcc` | 220 | same | same |
| `forward-message` | `to` | 266 | same | same |
| `save-template` | `to` | 794 | same | same |
| `save-template` | `cc` | 795 | same | same |
| `use-template` | `to` | 877 | same | same |
| `use-template` | `cc` | 878 | same | same |

**Note:** `reply-to-message` has no `to`/`cc`/`bcc` fields (it replies to the original
sender). Do not add email validation to `reply-to-message`.

**Verification:**
```bash
npx tsc --noEmit
grep -c 'emailAddressSchema' src/index.ts  # must be >= 12 (1 def + 11 usages)
```

**Done:** All five tools that accept recipient addresses validate format at the Zod layer.
Both `user@example.com` and `Name <user@example.com>` formats are accepted. Invalid strings
(no `@`, no domain, empty) are rejected before reaching the service layer.

---

### Task 7: Unit Tests

**Priority:** Required by phase success criteria  
**Files:** `src/__tests__/security.test.ts` (new file)

#### Steps

**Step 1 — Create `src/__tests__/` directory and `security.test.ts`.**

Use the existing test pattern from `src/utils/applescript.test.ts`: vitest, `describe/it/expect`
style, no mocking required for pure-function tests.

**Step 2 — Write tests for `validateSavePath()` helper.**

Since `validateSavePath` is not exported from `appleMailManager.ts` (it is a module-level
function), test it indirectly via the `AppleMailManager` class methods, OR refactor it into
`src/utils/pathSecurity.ts` and export it for direct testing.

Preferred approach: Extract `validateSavePath` to `src/utils/pathSecurity.ts` (a small new
file), export it, and import it in both `appleMailManager.ts` and the test. This also
makes the function reusable.

File: `src/utils/pathSecurity.ts`:
```typescript
import { resolve, normalize } from "path";
import { homedir } from "os";

export function validateSavePath(rawPath: string): string {
  // ... (same implementation as Task 5)
}
```

Then in `appleMailManager.ts`, replace the local `validateSavePath` definition with:
```typescript
import { validateSavePath } from "@/utils/pathSecurity.js";
```

Test cases for `validateSavePath`:
```typescript
describe("validateSavePath", () => {
  it("accepts path under home directory", () => {
    const home = homedir();
    expect(() => validateSavePath(`${home}/Downloads/file.pdf`)).not.toThrow();
  });

  it("returns normalized path", () => {
    const home = homedir();
    expect(validateSavePath(`${home}/Downloads/file.pdf`)).toBe(`${home}/Downloads/file.pdf`);
  });

  it("accepts /tmp paths", () => {
    expect(() => validateSavePath("/tmp/attachment.pdf")).not.toThrow();
  });

  it("expands ~/", () => {
    const result = validateSavePath("~/Downloads");
    expect(result).toBe(`${homedir()}/Downloads`);
  });

  it("rejects traversal sequences (../../etc/passwd)", () => {
    expect(() => validateSavePath("../../etc/passwd")).toThrow("must be absolute");
  });

  it("rejects absolute traversal outside home (/var/db/something)", () => {
    expect(() => validateSavePath("/var/db/something")).toThrow("outside allowed directories");
  });

  it("rejects empty string", () => {
    expect(() => validateSavePath("")).toThrow();
  });

  it("rejects /etc/passwd", () => {
    expect(() => validateSavePath("/etc/passwd")).toThrow("outside allowed directories");
  });
});
```

**Step 3 — Write tests for `emailAddressSchema`.**

Since `emailAddressSchema` is a module-scope `const` in `src/index.ts`, extract it to
`src/utils/emailValidation.ts`, export it, import it in `src/index.ts`, and test it directly.

File: `src/utils/emailValidation.ts`:
```typescript
import { z } from "zod";

export const emailAddressSchema = z.string().refine(
  (addr) => {
    const angleMatch = addr.match(/<([^>]+)>$/);
    const emailPart = angleMatch ? angleMatch[1] : addr.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPart);
  },
  { message: "Invalid email address format" }
);
```

In `src/index.ts`, replace the inline constant definition with:
```typescript
import { emailAddressSchema } from "@/utils/emailValidation.js";
```

Test cases for `emailAddressSchema`:
```typescript
describe("emailAddressSchema", () => {
  const valid = (addr: string) => emailAddressSchema.safeParse(addr).success;

  it("accepts plain address", () => {
    expect(valid("user@example.com")).toBe(true);
  });

  it("accepts display-name format", () => {
    expect(valid("John Doe <john@example.com>")).toBe(true);
  });

  it("accepts subdomain address", () => {
    expect(valid("user@mail.example.co.uk")).toBe(true);
  });

  it("rejects missing @", () => {
    expect(valid("notanemail")).toBe(false);
  });

  it("rejects missing domain", () => {
    expect(valid("user@")).toBe(false);
  });

  it("rejects no TLD", () => {
    expect(valid("user@example")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(valid("")).toBe(false);
  });

  it("rejects @ only", () => {
    expect(valid("@nodomain")).toBe(false);
  });
});
```

**Step 4 — Write tests for message ID regex.**

```typescript
describe("Message ID validation regex", () => {
  const ID_REGEX = /^\d+$/;

  it("accepts numeric ID", () => {
    expect(ID_REGEX.test("12345")).toBe(true);
  });

  it("accepts large numeric ID", () => {
    expect(ID_REGEX.test("4294967295")).toBe(true); // max uint32
  });

  it("rejects injection payload", () => {
    expect(ID_REGEX.test("0 or 1 is 1")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(ID_REGEX.test("")).toBe(false);
  });

  it("rejects alphanumeric", () => {
    expect(ID_REGEX.test("abc123")).toBe(false);
  });

  it("rejects floating point", () => {
    expect(ID_REGEX.test("1.5")).toBe(false);
  });
});
```

**Step 5 — Write tests for delimiter constant correctness.**

```typescript
describe("Safe delimiter constants", () => {
  const FIELD_SEP = "";
  const RECORD_SEP = "";

  it("FIELD_SEP does not appear in typical email subject", () => {
    const subject = "Re: Meeting tomorrow — Q1 recap | notes | action items";
    expect(subject.includes(FIELD_SEP)).toBe(false);
  });

  it("RECORD_SEP does not appear in typical sender name", () => {
    const sender = "John O'Brien <john@example.com>";
    expect(sender.includes(RECORD_SEP)).toBe(false);
  });

  it("splitting on RECORD_SEP then FIELD_SEP parses expected fields", () => {
    const id = "12345";
    const subject = "Subject with | pipe chars";
    const sender = "Sender|||Name"; // would have broken old delimiter
    const record = `${id}${FIELD_SEP}${subject}${FIELD_SEP}${sender}`;
    const output = record; // single-record output

    const items = output.split(RECORD_SEP);
    const parts = items[0].split(FIELD_SEP);

    expect(parts[0]).toBe(id);
    expect(parts[1]).toBe(subject);
    expect(parts[2]).toBe(sender);
  });
});
```

**Step 6 — Ensure `vitest` configuration covers `src/__tests__/`.**

Check `package.json` or `vitest.config.ts` to confirm the test glob includes
`src/**/*.test.ts`. If not, update the config. The existing test at
`src/utils/applescript.test.ts` confirms vitest is already configured for this project.

**Verification:**
```bash
npm test
```
All tests must pass. Zero failures.

**Done:** `src/__tests__/security.test.ts` exists with tests for `validateSavePath`,
`emailAddressSchema`, ID regex, and delimiter constants. `npm test` passes.

---

## Execution Order

Tasks must be executed in the following order. Each task must compile and pass tests
before the next begins. Tasks 1–3 are P0 (correctness); Tasks 4–6 are P1 (security);
Task 7 is the final verification harness.

```
Task 1: Safe Delimiter Replacement          (appleMailManager.ts — many locations, atomic commit)
   ↓
Task 2: Implement Missing Filters           (index.ts + appleMailManager.ts — additive)
   ↓
Task 3: Atomic renameMailbox Rollback       (appleMailManager.ts — 3 lines added)
   ↓
Task 4: Message ID Validation               (index.ts + appleMailManager.ts — schema + guards)
   ↓
Task 5: Path Traversal Prevention           (appleMailManager.ts — new helper + 3 call sites)
   ↓
Task 6: Email Address Validation            (index.ts — new constant + 11 field updates)
   ↓
Task 7: Unit Tests                          (new files — validates Tasks 1, 4, 5, 6)
```

Tasks 2, 3, 4, 5, 6 are independently mergeable after Task 1 completes.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Task 1 partial application (some templates updated, some not) | Medium | Parsing breaks for updated methods while old methods still produce `|||` | Run all four grep commands before committing; every command must return 0 |
| `character id 57345` produces wrong character in some AppleScript versions | Low | All output splits return single-element arrays | Pre-flight: echo `character id 57345` in Script Editor to confirm U+E001 |
| `whose (compound and clause)` rejected by Mail.app on older macOS | Low | Search returns empty results | Verified pattern already used in codebase at line 507; compound `whose` supported since macOS 10.14 |
| `validateSavePath` blocks legitimate cross-device paths (e.g., external drive at `/Volumes/`) | Medium | `saveAttachment` fails for files on external volumes | Widen the allowlist in `validateSavePath` to also include `/Volumes/` if this becomes a user-reported issue |
| Zod `.refine()` on `emailAddressSchema` blocks valid unusual addresses (IPv6, punycode) | Low | User sees validation rejection for valid address | The regex is intentionally permissive (`[^\s@]+`); genuinely unusual addresses should pass |
| TypeScript `import { resolve, normalize } from "path"` requires module resolution change | Low | Compile error | Use `import path from "path"; const { resolve, normalize } = path;` as fallback if named imports fail |

---

## Commit Strategy

Each task must be committed separately with a message matching:

```
fix(phase-1): task N — <short description>
```

Examples:
- `fix(phase-1): task 1 — replace pipe delimiters with Unicode PUA constants`
- `fix(phase-1): task 2 — wire from/isRead/isFlagged filters through to AppleScript`
- `fix(phase-1): task 3 — rollback new mailbox on renameMailbox failure`
- `fix(phase-1): task 4 — enforce numeric-only message IDs at schema and service layers`
- `fix(phase-1): task 5 — add validateSavePath to block path traversal`
- `fix(phase-1): task 6 — add emailAddressSchema for recipient validation`
- `test(phase-1): task 7 — unit tests for security and correctness fixes`

Task 1 is the highest-risk commit; all others are low-risk and independently revertable.
