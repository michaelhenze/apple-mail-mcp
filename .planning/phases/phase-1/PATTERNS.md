# Existing Patterns

**Mapped:** 2026-05-20
**Files analyzed:** 2 (src/index.ts, src/services/appleMailManager.ts)
**Analogs found:** 5 / 6 (no existing `.email()` or `.regex()` Zod usage; no rollback pattern)

---

## Zod Schema Validation Patterns

### Finding: No `.email()` or `.regex()` usage exists anywhere in the codebase

Confirmed by reading all 986 lines of `src/index.ts`. Every schema field uses only primitive Zod
methods: `.string()`, `.number()`, `.boolean()`, `.array()`, `.optional()`, `.min()`, `.default()`,
and `.describe()`. There is no existing use of `.email()`, `.regex()`, or `.refine()`.

**Closest analog for new validation — the `min(1)` + `describe` pattern:**

File: `src/index.ts`, lines 188–197 (send-email schema):
```typescript
to: z.array(z.string()).min(1, "At least one recipient is required"),
subject: z.string().min(1, "Subject is required"),
body: z.string().min(1, "Body is required"),
cc: z.array(z.string()).optional().describe("CC recipients"),
bcc: z.array(z.string()).optional().describe("BCC recipients"),
account: z.string().optional().describe("Account to send from"),
attachments: z
  .array(z.string())
  .optional()
  .describe("Absolute file paths to attach (e.g., ['/Users/me/report.pdf'])"),
```

**Pattern to copy for new `.email()` validation** — extend the array item schema:
```typescript
// Replace: z.array(z.string())
// With:    z.array(z.string().email("Invalid email address"))
to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient is required"),
cc: z.array(z.string().email("Invalid email address")).optional().describe("CC recipients"),
bcc: z.array(z.string().email("Invalid email address")).optional().describe("BCC recipients"),
```

Apply this replacement to: `send-email` (lines 188–196), `create-draft` (lines 215–225),
`forward-message` (lines 265–267), `save-template` (lines 793–795), `use-template` (line 876).

**Pattern to copy for new `.regex()` / `.refine()` validation** — add to the `id` field:
```typescript
// Existing pattern (e.g. line 135):
id: z.string().min(1, "Message ID is required"),

// New pattern — add .regex() to enforce numeric-only IDs:
id: z.string().min(1, "Message ID is required").regex(/^\d+$/, "Message ID must be numeric"),
```

Apply this to every tool that takes `id`: `get-message` (line 135), `reply-to-message` (line 244),
`forward-message` (line 265), `mark-as-read` (line 288), `mark-as-unread` (line 303),
`flag-message` (line 321), `unflag-message` (line 339), `delete-message` (line 358),
`move-message` (line 379), `list-attachments` (line 534), `save-attachment` (line 559).

**Pattern to copy for `.refine()` cross-field validation** — use the `withErrorHandling` wrapper
pattern that already does inline conditional checking. For Zod-level cross-field checks, add
`.refine()` at the schema object level (no existing example; base it on Zod docs):
```typescript
z.object({
  oldName: z.string().min(1, "Current mailbox name is required"),
  newName: z.string().min(1, "New mailbox name is required"),
  account: z.string().optional(),
}).refine((data) => data.oldName !== data.newName, {
  message: "New name must differ from old name",
  path: ["newName"],
})
```
Note: `server.tool()` accepts a plain schema object, not a `z.object()` wrapper. The `.refine()`
must be applied at the object level and the shape extracted. Confirm SDK support before using.

---

## AppleScript Filter Patterns

### Pattern A: `whose` clause inline filter (listMessages)

File: `src/services/appleMailManager.ts`, lines 495–533

The `from` filter is injected directly into the `repeat with msg in messages of theMailbox` line
as a `whose` clause. It is built from a conditional string before the template literal:

```typescript
const safeFrom = from ? escapeForAppleScript(from) : "";
const fromFilter = from ? `whose sender contains "${safeFrom}"` : "";

// ...injected into template literal:
repeat with msg in messages of theMailbox ${fromFilter}
```

**Copy this pattern** for adding `isRead` and `isFlagged` filters to `listMessages`. Compose
multiple `whose` conditions with `and`:
```typescript
const conditions: string[] = [];
if (from)       conditions.push(`sender contains "${escapeForAppleScript(from)}"`);
if (isRead !== undefined) conditions.push(`read status is ${isRead}`);
if (isFlagged !== undefined) conditions.push(`flagged status is ${isFlagged}`);
const whereClause = conditions.length > 0 ? `whose (${conditions.join(" and ")})` : "";

// In template: repeat with msg in messages of theMailbox ${whereClause}
```

### Pattern B: Per-message `if` block date filter (searchMessages)

File: `src/services/appleMailManager.ts`, lines 325–356

Date filters cannot use `whose` because `date received` comparison in `whose` is unreliable in
AppleScript. Instead the existing code builds an `if` condition string and injects it inside the
`repeat` body using conditional template interpolation:

```typescript
let dateFilter = "";
if (dateFrom || dateTo) {
  const dateChecks: string[] = [];
  if (dateFrom) {
    dateChecks.push(`date received of msg >= date "${dateFrom}"`);
  }
  if (dateTo) {
    dateChecks.push(`date received of msg <= date "${dateTo}"`);
  }
  dateFilter = dateChecks.join(" and ");
}

// In template literal — injected at lines 346 and 356:
${dateFilter ? `set msgDate to date received of msg\n          if not (${dateFilter}) then\n            -- skip message outside date range\n          else` : ""}
// ... body of message collection ...
${dateFilter ? "end if" : ""}
```

**Copy this pattern** when adding date filters to `listMessages` (which currently has none).
Note the asymmetry: `whose` for string fields (fast, server-side), `if` block for date fields.

### Pattern C: AppleScript text item delimiter accumulation (listMailboxes, fetchAccounts)

File: `src/services/appleMailManager.ts`, lines 1192–1201 and 1381–1394

Used when iterating with `repeat` and building a list before joining:
```applescript
set mailboxList to {}
repeat with mb in mailboxes
  set end of mailboxList to mbName & "|||" & mbUnread & "|||" & mbCount
end repeat
set AppleScript's text item delimiters to "|||ITEM|||"
return mailboxList as text
```

This is the **alternative accumulation pattern** — builds a list in AppleScript then joins at the
end. Contrast with Pattern D (manual string concatenation inside repeat). Prefer this form when
the full collection is always needed and order is unimportant.

### Pattern D: Manual string concatenation with guard (listMessages, searchMessages)

File: `src/services/appleMailManager.ts`, lines 509–532 (listMessages)

Used when a `limit` and `offset` must be respected:
```applescript
set outputText to ""
set msgCount to 0
repeat with msg in messages of theMailbox ${fromFilter}
  if msgCount >= ${limit} then exit repeat
  try
    -- ... collect fields ...
    if msgCount > 0 then set outputText to outputText & "|||ITEM|||"
    set outputText to outputText & msgId & "|||" & msgSubject & ...
    set msgCount to msgCount + 1
  end try
end repeat
return outputText
```

The separator is prepended *before* the item when `msgCount > 0` — this avoids a trailing
delimiter. **Copy this guard exactly** when adding new repeat loops.

---

## Output Parsing Patterns

### Primary delimiter: `|||ITEM|||` (record separator) + `|||` (field separator)

Every multi-message result in the service uses the same two-level split. All locations:

| Method | Lines | Split call |
|--------|-------|------------|
| `parseMessageList` | 552, 556 | `output.split("|||ITEM|||")` then `item.split("|||")` |
| `listAttachments` | 1121, 1125 | same |
| `listMailboxes` | 1214, 1218 | same |
| `fetchAccounts` | 1406, 1410 | same |
| `listRules` | 1472, 1476 | same |
| `searchContacts` | 1564, 1568 | same |

Canonical parsing block (from `parseMessageList`, lines 551–572):
```typescript
private parseMessageList(output: string, mailbox: string, account: string): Message[] {
  const items = output.split("|||ITEM|||");
  const messages: Message[] = [];

  for (const item of items) {
    const parts = item.split("|||");
    if (parts.length < 6) continue;

    messages.push({
      id: parts[0].trim(),
      subject: parts[1],
      sender: parts[2],
      recipients: [],
      dateReceived: parseAppleScriptDate(parts[3]),
      isRead: parts[4] === "true",
      isFlagged: parts[5] === "true",
      // ...
    });
  }
  return messages;
}
```

**Bug to fix:** `|||` is also the prefix of `|||ITEM|||`. Calling `item.split("|||")` on a raw
output that hasn't been pre-split on `"|||ITEM|||"` would incorrectly tokenize — but since the
outer split happens first, items arriving at `split("|||")` will never contain `"|||ITEM|||"`.
The risk is if field content contains `|||`. The fix is to use a longer/unique delimiter pair,
e.g. `\x00ITEM\x00` and `\x00FLD\x00`, or to sanitize field values in AppleScript before
concatenating. **When replacing delimiters**, change both the AppleScript template string
literals and the corresponding TypeScript `.split()` calls in the same commit.

### Single-record delimiters: `|||CONTENT|||` and `|||HTML|||`

File: `src/services/appleMailManager.ts`, lines 454, 472, 476

Used only in `getMessageContent` for two-field structured output:
```typescript
// AppleScript returns:
// subject |||CONTENT||| plainText |||HTML||| htmlSource

const htmlSplit = result.output.split("|||HTML|||");
const contentPart = htmlSplit[0];
const htmlContent = htmlSplit.length > 1 ? htmlSplit[1] : undefined;

const parts = contentPart.split("|||CONTENT|||");
if (parts.length < 2) return null;
```

**Note:** Split order matters here — `|||HTML|||` must be split first or it will be included in
`contentPart`. This order must be preserved when renaming delimiters.

### Single-record plain `|||` split

File: `src/services/appleMailManager.ts`, lines 399, 417 (`getMessageById`); lines 1846, 1918

Used for single-message lookups that return one row of fields, no `ITEM` separator needed:
```typescript
const parts = result.output.split("|||");
if (parts.length < 9) return null;
```

---

## Error Handling Patterns

### Pattern: AppleScript `on error` + `"error:"` prefix + TypeScript check

This is the universal service-layer error protocol. AppleScript returns `"error:" & errMsg` on
failure; TypeScript checks `result.output.startsWith("error:")`.

File: `src/services/appleMailManager.ts`, lines 1273–1290 (`createMailbox`):
```typescript
const script = buildAppLevelScript(`
  try
    make new mailbox with properties {name:"${safeName}"} at account "${safeAccount}"
    return "ok"
  on error errMsg
    return "error:" & errMsg
  end try
`);

const result = executeAppleScript(script);

if (!result.success || result.output.startsWith("error:")) {
  console.error(`Failed to create mailbox: ${result.error || result.output}`);
  return false;
}
```

The same `try / on error / return "error:" & errMsg` + `.startsWith("error:")` guard appears at:
lines 1296–1319 (`deleteMailbox`), lines 1340–1358 (`renameMailbox`), lines 1142–1178
(`saveAttachment`).

### No rollback pattern exists in the codebase

`renameMailbox` (lines 1325–1363) is the closest thing to a multi-step operation, but it has
**no rollback**. If the `moveScript` fails after `createMailbox` succeeds, the new empty mailbox
is left behind and the old one remains intact with its messages — a partial failure state.

**Pattern to implement rollback** — copy the two-step structure and add cleanup on failure:
```typescript
renameMailbox(oldName: string, newName: string, account?: string): boolean {
  const targetAccount = this.resolveAccount(account);

  // Step 1: Create new mailbox
  if (!this.createMailbox(newName, targetAccount)) {
    return false;
  }

  // Step 2: Move messages + delete old
  // ... build and run moveScript ...
  const result = executeAppleScript(moveScript, { timeoutMs: 60000 });

  if (!result.success || result.output.startsWith("error:")) {
    console.error(`Failed to rename mailbox: ${result.error || result.output}`);
    // ROLLBACK: delete the newly created mailbox to restore original state
    this.deleteMailbox(newName, targetAccount);
    return false;
  }

  this.invalidateCache();
  return true;
}
```

The rollback call is `this.deleteMailbox(newName, targetAccount)` — this method already exists
(lines 1296–1320) and follows the same `"error:"` pattern, so its return value can be checked
if a rollback-failure warning is needed.

### Tool-layer error handling: `withErrorHandling` wrapper

File: `src/index.ts`, lines 78–90:
```typescript
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ReturnType<typeof successResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    try {
      return handler(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`);
    }
  };
}
```

Zod validation errors thrown by the MCP SDK before the handler runs are **not** caught by this
wrapper — they are rejected at the schema layer. The wrapper only catches runtime exceptions
inside the handler body.

---

## Path Validation Patterns

### Finding: No path normalization or security checks exist

`saveAttachment` (`src/services/appleMailManager.ts`, lines 1142–1179) accepts `savePath`
directly from the caller and passes it through `escapeForAppleScript()` only (which escapes
backslashes and double quotes). There is no:
- `path.resolve()` / `path.normalize()` call
- `~/` expansion
- Directory traversal check (`../`)
- Absolute-path enforcement

The `save-attachment` tool schema (line 561) uses only `z.string().min(1, ...)`.

**Pattern to add** — path validation using Node's built-in `path` module, inserted before the
AppleScript call in `saveAttachment`:
```typescript
import path from "path";
import os from "os";

// Expand ~ to home directory
const expandedPath = savePath.startsWith("~/")
  ? path.join(os.homedir(), savePath.slice(2))
  : savePath;

// Enforce absolute path
const resolvedPath = path.resolve(expandedPath);
```

For the Zod schema in `src/index.ts` line 561, add a `.refine()` that rejects relative paths:
```typescript
savePath: z.string()
  .min(1, "Save directory path is required")
  .refine((p) => path.isAbsolute(p) || p.startsWith("~/"), {
    message: "savePath must be an absolute path or start with ~/",
  }),
```

---

## Files That Need Changes (with line ranges)

### `src/index.ts`

| Change | Lines | Pattern to Apply |
|--------|-------|-----------------|
| Add `.email()` to `to`/`cc`/`bcc` array items in `send-email` | 188–196 | `.email()` extension of existing `z.array(z.string())` |
| Add `.email()` to `to`/`cc`/`bcc` in `create-draft` | 215–225 | same |
| Add `.email()` to `to` in `forward-message` | 265–267 | same |
| Add `.email()` to `to`/`cc` in `save-template` | 793–795 | same |
| Add `.email()` to `to`/`cc` in `use-template` | 876 | same |
| Add `.regex(/^\d+$/)` to `id` in `get-message` | 135 | `z.string().min(1, ...).regex(...)` |
| Add `.regex(/^\d+$/)` to `id` in all single-message tools | 244, 265, 288, 303, 321, 339, 358, 379, 534, 559 | same |
| Add `.refine()` path check to `savePath` in `save-attachment` | 561 | New `.refine()` — no analog |
| Add `.refine()` name inequality check to `rename-mailbox` | 657–659 | New `.refine()` on `z.object()` — no analog |

### `src/services/appleMailManager.ts`

| Change | Lines | Pattern to Apply |
|--------|-------|-----------------|
| Add rollback `this.deleteMailbox(newName, targetAccount)` in `renameMailbox` | 1356–1358 | `deleteMailbox` call (lines 1296–1320) |
| Add `isRead`/`isFlagged` filter to `listMessages` `whose` clause | 506–508 | `fromFilter` pattern at lines 506–507 |
| Add date filter to `listMessages` | 509–533 | `dateFilter` pattern from `searchMessages` lines 325–336, 346, 356 |
| Replace `|||ITEM|||` / `|||` delimiters with collision-safe values | All `split("|||ITEM|||")` and `split("|||")` calls; all AppleScript literals | All locations listed in Output Parsing table above |
| Expand `~/` and validate absolute path in `saveAttachment` | 1142–1144 | No analog — new `path`/`os` import pattern |
