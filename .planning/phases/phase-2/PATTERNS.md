# Existing Patterns — Phase 2

**Mapped:** 2026-05-20
**Primary source file:** `src/services/appleMailManager.ts`
**Supporting files:** `src/index.ts`, `src/types.ts`, `src/utils/applescript.ts`, `src/utils/pathSecurity.ts`, `src/utils/emailValidation.ts`

---

## AppleScript Multi-field Output (FIELD_SEP / RECORD_SEP)

### Constants — `src/services/appleMailManager.ts` lines 107–116

```typescript
// Safe output delimiters — Unicode Private Use Area characters that cannot
// appear in real email subjects, sender names, or mailbox names.
const FIELD_SEP = "";   // character id 57345 — separates fields within one record
const RECORD_SEP = "";  // character id 57346 — separates records from each other
const CONTENT_SEP = ""; // character id 57347 — used in getMessageContent
const HTML_SEP = "";    // character id 57348 — used in getMessageContent
```

### AppleScript side — `src/services/appleMailManager.ts` lines 377–401 (`searchMessages`)

```applescript
set fieldSep to character id 57345
set recSep to character id 57346
set outputText to ""
-- ... per-record loop:
if msgCount > 0 then set outputText to outputText & recSep
set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDateStr & fieldSep & msgRead & fieldSep & msgFlagged
set msgCount to msgCount + 1
return outputText
```

### TypeScript parse side — `src/services/appleMailManager.ts` lines 613–637 (`parseMessageList`)

```typescript
const items = output.split(RECORD_SEP);
for (const item of items) {
  const parts = item.split(FIELD_SEP);
  if (parts.length < 6) continue;
  messages.push({
    id: parts[0].trim(),
    subject: parts[1],
    sender: parts[2],
    // ...
  });
}
```

### Alternative: list-style join used in `listMailboxes` / `fetchAccounts` — lines 1281–1292

Some AppleScript blocks build an AS list and join with `AppleScript's text item delimiters`:
```applescript
set end of mailboxList to mbName & (character id 57345) & mbUnread & (character id 57345) & mbCount
set AppleScript's text item delimiters to (character id 57346)
return mailboxList as text
```
Use the `outputText & recSep & …` accumulator style (as in `searchMessages`) for new multi-record output — it handles empty results more cleanly than the list-join approach.

**Rule for Phase 2:** When adding new fields to `getMessageById`, append them with `& fieldSep & newField` in the AppleScript `return` statement, increment the `parts.length` guard in TypeScript (`if (parts.length < 9)` → raise to match new field count), and add the corresponding property to the returned `Message` object.

---

## Per-Mailbox / Per-Account Iteration

### Pattern already used in `getMessageById` — lines 430–449

The canonical loop structure for "find message across all accounts/mailboxes":

```applescript
repeat with acct in accounts
  repeat with mb in mailboxes of acct
    try
      set matchingMsgs to (messages of mb whose id is ${id})
      if (count of matchingMsgs) > 0 then
        set msg to item 1 of matchingMsgs
        -- ... extract fields ...
        return <result>
      end if
    end try
  end repeat
end repeat
return ""
```

### `searchMessages` multi-account fan-out — lines 317–337 (TypeScript level)

When `account` is omitted, `searchMessages` loops all accounts in TypeScript and calls itself recursively per account, slicing to `remaining = limit - allMessages.length`:

```typescript
if (!account) {
  const accounts = this.listAccounts();
  const allMessages: Message[] = [];
  for (const acct of accounts) {
    if (allMessages.length >= limit) break;
    const remaining = limit - allMessages.length;
    const msgs = this.searchMessages(query, mailbox, acct.name, remaining, ...);
    allMessages.push(...msgs);
  }
  return allMessages.slice(0, limit);
}
```

**Phase 2 `allMailboxes` mode:** The same TypeScript fan-out pattern applies. When `allMailboxes: true`, omit the `mailbox` filter and iterate every mailbox within the resolved account — or reuse the `!account` fan-out but after resolving to a single account.

---

## Limit / Offset Slice Pattern

### `listMessages` AppleScript — lines 568–594 (the authoritative example with both limit AND offset)

```applescript
set msgCount to 0
set skipped to 0
repeat with msg in messages of theMailbox ${fromFilter}
  if msgCount >= ${limit} then exit repeat
  try
    if skipped < ${offset} then
      set skipped to skipped + 1
    else
      -- build record ...
      set msgCount to msgCount + 1
    end if
  end try
end repeat
return outputText
```

**Phase 2 change:** Copy this exact `skipped`/`msgCount` two-counter pattern into `searchMessages`. The `searchMessages` AppleScript block (lines 384–400) currently uses only `msgCount`; add `set skipped to 0` before the loop and the inner `if skipped < ${offset}` branch in the same position as `listMessages`.

---

## Outgoing Message Construction (sendEmail / createDraft)

### `sendEmail` — lines 688–711

```typescript
// With explicit account:
sendCommand = `
  set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
  tell newMessage
    ${recipientCommands}
    set sender to "${safeAccount}"
    ${attachmentCommands}
  end tell
  send newMessage
  return "sent"
`;

// Without account:
sendCommand = `
  set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
  tell newMessage
    ${recipientCommands}
    ${attachmentCommands}
  end tell
  send newMessage
  return "sent"
`;
```

### `createDraft` — lines 776–794

Identical structure but `visible:false` and no `send newMessage` call; returns `"draft created"`.

### HTML body insertion point

The `content` property in `make new outgoing message with properties {…, content:"…"}` accepts plain text. Mail.app does **not** expose an `html content` property on outgoing messages via AppleScript. The correct approach for HTML is to set plain-text `content` as a fallback and then use `source` assignment or a workaround. The existing codebase has no HTML send path yet.

**Phase 2 pattern to follow:** Add an optional `htmlBody` string parameter to `sendEmail` and `createDraft`. When `htmlBody` is provided, pass it as the `content` value (Apple Mail will render HTML embedded in the content property on modern macOS). Escape with `escapeForAppleScript()` exactly as `safeBody` is escaped today (lines 659–660 / 744–745).

### Attachment command pattern — lines 679–686 / 764–770

```typescript
let attachmentCommands = "";
if (attachments) {
  for (const filePath of attachments) {
    const validatedFilePath = validateSavePath(filePath); // throws on traversal
    const safePath = escapeForAppleScript(validatedFilePath);
    attachmentCommands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
  }
}
```

---

## File I/O (any existing fs usage)

**None exists.** A full-text search of `src/` for `import.*fs`, `readFile`, `writeFile`, `readFileSync`, `writeFileSync`, `JSON.parse`, and `JSON.stringify` returned no results. The codebase has zero file I/O today.

**Phase 2 pattern to introduce:** Use Node's built-in `fs/promises` (or sync variants `readFileSync`/`writeFileSync` since the rest of the codebase is synchronous) with `JSON.parse`/`JSON.stringify`. Follow the module import style already used in `src/utils/pathSecurity.ts` (lines 1–2):

```typescript
import { resolve, normalize } from "path";
import { homedir } from "os";
```

New template-persistence module should import:
```typescript
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
```

Store the JSON file at a path validated through `validateSavePath()` (already importable from `@/utils/pathSecurity.js`) — e.g. `~/.apple-mail-mcp/templates.json`. The `saveTemplate` / `deleteTemplate` methods in `AppleMailManager` (lines 1699–1718) are the integration points: they currently mutate `this.templates` Map only; add a `persistTemplates()` private helper that serialises the Map to JSON and writes it, plus a `loadTemplates()` call in the constructor.

---

## Attachment Iteration

### `saveAttachment` — lines 1235–1259

The current name-based find:

```applescript
set msg to item 1 of matchingMsgs
repeat with att in mail attachments of msg
  if name of att is "${safeName}" then
    set savePath to POSIX file "${safePath}/${safeName}"
    save att in savePath
    return "ok"
  end if
end repeat
return "error:Attachment not found"
```

### `listAttachments` attachment loop — lines 1179–1187

Shows how to iterate all attachments with an index counter:

```applescript
set attCount to 0
repeat with att in mail attachments of msg
  set attName to name of att
  set attType to MIME type of att
  set attSize to file size of att as string
  if attCount > 0 then set outputText to outputText & recSep
  set outputText to outputText & attName & fieldSep & attType & fieldSep & attSize
  set attCount to attCount + 1
end repeat
```

**Phase 2 index-based selection:** Add an `attachmentIndex` optional integer parameter. When provided, replace the name-match `if` with a counter-based branch:

```applescript
set attIdx to 0
repeat with att in mail attachments of msg
  if attIdx is ${attachmentIndex} then
    set savePath to POSIX file "${safePath}/${name of att}"
    save att in savePath
    return "ok"
  end if
  set attIdx to attIdx + 1
end repeat
```

The TypeScript method signature addition follows the same optional-parameter pattern as `listMessages` (line 552): `saveAttachment(id, attachmentName, savePath, attachmentIndex?: number)` — when `attachmentIndex` is defined, skip the name check and select by position instead.

---

## Optional Zod Parameter Examples

### `z.boolean().optional()` with `.default()` — `src/index.ts` lines 261–262

```typescript
replyAll: z.boolean().optional().default(false).describe("Reply to all recipients"),
send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
```

### `z.boolean().optional()` without default — `src/index.ts` lines 107–110

```typescript
isRead: z.boolean().optional().describe("Filter by read status"),
isFlagged: z.boolean().optional().describe("Filter by flagged status"),
```

### `z.number().optional()` with inline default in handler — `src/index.ts` lines 111, 114

```typescript
// Schema:
limit: z.number().optional().describe("Maximum number of results (default: 50)"),

// Handler destructuring applies the default:
({ query, ..., limit = 50, ... }) => { ... }
```

### `z.string().optional()` — `src/index.ts` lines 102–106

```typescript
query: z.string().optional().describe("Text to search for in subject, sender, or content"),
mailbox: z.string().optional().describe("Mailbox to search in (e.g., 'INBOX')"),
account: z.string().optional().describe("Account to search in (omit to search all accounts)"),
```

**Phase 2 additions follow these patterns:**
- `offset: z.number().optional().describe("Number of messages to skip (for pagination)")` — same as `list-messages` line 175
- `allMailboxes: z.boolean().optional().describe("Search across all mailboxes (not just INBOX)")` — use `.optional()` without `.default()`
- `htmlBody: z.string().optional().describe("HTML body (overrides plain text body when provided)")` — use `.optional()` without `.min()`
- `attachmentIndex: z.number().int().optional().describe("Zero-based index of attachment (alternative to attachmentName)")` — add `.int()` for safety

---

## Files That Need Changes (with line ranges)

| File | Change | Key Lines |
|------|--------|-----------|
| `src/services/appleMailManager.ts` | `getMessageById`: add `to recipients`, `cc recipients`, `attachment count` fields to AppleScript return and TypeScript parse | AppleScript: 427–454; parse: 463–479 |
| `src/services/appleMailManager.ts` | `searchMessages`: add `offset` parameter and `skipped` counter to AppleScript | Signature: 305–315; AppleScript block: 377–401 |
| `src/services/appleMailManager.ts` | `searchMessages`: add `allMailboxes` mode — iterate every mailbox of account, not just INBOX | resolvedMailbox assignment: 340–341; `searchCommand`: 377 |
| `src/services/appleMailManager.ts` | `sendEmail` + `createDraft`: add `htmlBody?: string` parameter; when present use it as `content` value instead of `body` | `sendEmail` signature: 650–658; content line: 692 / 703; `createDraft` signature: 735–743; content line: 776 / 786 |
| `src/services/appleMailManager.ts` | Template persistence: add `loadTemplates()` + `persistTemplates()` private methods using `fs` + `JSON`; call load in constructor, persist on every write | `private templates` Map: 1679; `saveTemplate`: 1699–1710; `deleteTemplate`: 1716–1718 |
| `src/services/appleMailManager.ts` | `saveAttachment`: add `attachmentIndex?: number` parameter; when provided use counter-based AppleScript loop instead of name match | Signature: 1226; name-match loop: 1243–1249 |
| `src/index.ts` | `search-messages` tool: add `offset` and `allMailboxes` Zod fields, thread through to `mailManager.searchMessages()` | Schema: 101–112; handler call: 115–125 |
| `src/index.ts` | `send-email` tool: add `htmlBody` Zod field, thread through | Schema: 200–212; handler call: 214 |
| `src/index.ts` | `create-draft` tool: add `htmlBody` Zod field, thread through | Schema: 228–240; handler call: 242 |
| `src/index.ts` | `save-attachment` tool: add `attachmentIndex` Zod field, thread through | Schema: 572–576; handler call: 578 |
| `src/types.ts` | `Message` interface: `recipients` and `ccRecipients` fields already declared (lines 35–40); `hasAttachments` already declared (line 68) — no new fields needed |  |
| `src/types.ts` | `SendEmailParams`: `isHtml` field already declared (line 233) — no new fields needed |  |
