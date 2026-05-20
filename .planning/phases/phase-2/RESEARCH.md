# Phase 2 Research: Complete Core Message Data

**Researched:** 2026-05-20
**Domain:** AppleScript Mail automation, Node.js fs, TypeScript service layer
**Confidence:** HIGH — all findings derived directly from reading source files and known macOS Mail AppleScript dictionary

---

## Summary

Phase 2 closes six data-exposure gaps. Every gap follows the same pattern: the TypeScript type already defines the field, but the AppleScript that populates it is missing or incomplete. The fixes are contained — no new dependencies are required for any of the six items. The most structurally significant change is template persistence (introduces `fs`/`os` usage in `appleMailManager.ts`). The simplest changes are the offset parameter and attachment-by-index (a few lines each).

The core transport protocol (FIELD_SEP / RECORD_SEP Unicode PUA constants from Phase 1) is already correct for all new fields — no delimiter changes needed.

**Primary recommendation:** Implement features in this order — (1) getMessageById headers, (2) search allMailboxes, (3) search offset, (4) HTML send, (5) attachment index, (6) template persistence. Each builds slightly on the previous understanding but none are blocked by another.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Full message headers (senderName, recipients, ccRecipients, replyTo, hasAttachments) | Service Layer (`appleMailManager.ts`) | — | AppleScript query + TypeScript parse; no schema changes beyond `types.ts` fields that already exist |
| allMailboxes search mode | Service Layer (`appleMailManager.ts`) | MCP Layer (new param in schema) | Loop logic lives in manager; index.ts adds the `allMailboxes` Zod field |
| search-messages pagination offset | Service Layer (`appleMailManager.ts`) | MCP Layer (new param in schema) | Offset slice logic mirrors listMessages; index.ts adds the `offset` Zod field |
| HTML email sending | Service Layer (`appleMailManager.ts`) | MCP Layer (expose `isHtml` in schema) | AppleScript `content` property sets body; index.ts must add `isHtml` to send-email and create-draft schemas |
| Attachment by index | Service Layer (`appleMailManager.ts`) | MCP Layer (new `attachmentIndex` param) | AppleScript ordinal index access; index.ts adds optional param to save-attachment |
| Template persistence | Service Layer (`appleMailManager.ts`) | OS (`~/.config/apple-mail-mcp/`) | JSON file on disk; no external dependencies beyond Node.js built-ins |

---

## 1. Full Message Headers (getMessageById)

### Current State

`getMessageById()` (line 422–480 of `appleMailManager.ts`) returns 9 pipe-delimited fields:

```
subject | sender | dateReceived | isRead | isFlagged | isJunk | isDeleted | mailbox | account
```

The return value hardcodes `recipients: []` and `hasAttachments: false`. The `Message` type already declares: `senderName?`, `recipients`, `ccRecipients?`, `replyTo?` (missing from type — but the roadmap lists it), `hasAttachments`.

Note: `replyTo` is not actually present in `types.ts` as of this reading (checked lines 21–69). The roadmap says "replyTo" is a target field but the interface doesn't define it yet. The planner must add `replyTo?: string` to `Message` in `types.ts` as a Wave 0 step.

### AppleScript Properties Available

[ASSUMED] Based on the Mail AppleScript dictionary:

| Property | AppleScript name | Returns |
|----------|-----------------|---------|
| Sender display name | `sender` returns `"Name <email>"` format | Parse client-side |
| To recipients | `to recipients of msg` — a list of `recipient` objects | Each has `address` property |
| CC recipients | `cc recipients of msg` — a list of `recipient` objects | Each has `address` property |
| Reply-to | `reply to of msg` — a string address | Direct string |
| Has attachments | `(count of mail attachments of msg) > 0` | boolean via comparison |

[ASSUMED] `to recipients` and `cc recipients` are lists; iterating them in AppleScript is required to build a comma-joined string.

### Recommended Pattern

Extend the `getMessageById` AppleScript block to collect extra fields, appended after the existing 9 fields using additional FIELD_SEP-delimited positions:

```applescript
-- After existing 9 fields, collect header extras
set msgRecipients to ""
repeat with r in to recipients of msg
  if msgRecipients is not "" then set msgRecipients to msgRecipients & ","
  set msgRecipients to msgRecipients & (address of r)
end repeat

set msgCC to ""
repeat with r in cc recipients of msg
  if msgCC is not "" then set msgCC to msgCC & ","
  set msgCC to msgCC & (address of r)
end repeat

set msgReplyTo to ""
try
  set msgReplyTo to reply to of msg
end try

set msgHasAtt to (count of mail attachments of msg) > 0

-- Return extended: original 9 fields + recipients + cc + replyTo + hasAttachments
return msgSubject & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & msgFlagged & fieldSep & msgJunk & fieldSep & msgDeleted & fieldSep & msgMailbox & fieldSep & msgAccount & fieldSep & msgRecipients & fieldSep & msgCC & fieldSep & msgReplyTo & fieldSep & (msgHasAtt as string)
```

TypeScript parse side (parts[9] through parts[12]):

```typescript
return {
  id: id.toString(),
  subject: parts[0],
  sender: parts[1],
  // senderName: parse "Display Name <email>" from parts[1]
  senderName: parts[1].includes('<')
    ? parts[1].split('<')[0].trim().replace(/^"/, '').replace(/"$/, '')
    : undefined,
  recipients: parts[9] ? parts[9].split(',').filter(Boolean) : [],
  ccRecipients: parts[10] ? parts[10].split(',').filter(Boolean) : undefined,
  replyTo: parts[11] || undefined,
  dateReceived: parseAppleScriptDate(parts[2]),
  isRead: parts[3] === 'true',
  isFlagged: parts[4] === 'true',
  isJunk: parts[5] === 'true',
  isDeleted: parts[6] === 'true',
  mailbox: parts[7],
  account: parts[8],
  hasAttachments: parts[12] === 'true',
};
```

### Risks

- [ASSUMED] `reply to of msg` may throw or return empty for messages without a Reply-To header. Wrap in `try ... end try` in AppleScript (already shown above).
- [ASSUMED] Sender display name parsing ("Name <email>") is best-effort; names with embedded `<` are edge cases.
- Parts count changes from 9 to 13 — the existing guard `if parts.length < 9` must become `if parts.length < 9` (keep lenient; new fields are additive).

---

## 2. Search All Mailboxes

### Current State

`searchMessages()` lines 305–413. When `account` is provided, it targets exactly one mailbox:

```typescript
const requestedMailbox = mailbox || "INBOX";
const targetMailbox = this.resolveMailbox(requestedMailbox, targetAccount);
```

There is no way to search across all mailboxes without specifying each by name.

### Existing Per-Account Recursion (lines 317–336)

When `account` is omitted, the method already iterates all accounts recursively:

```typescript
if (!account) {
  const accounts = this.listAccounts();
  for (const acct of accounts) {
    const msgs = this.searchMessages(query, mailbox, acct.name, remaining, ...);
    allMessages.push(...msgs);
  }
  return allMessages.slice(0, limit);
}
```

The key observation: this recursion still passes `mailbox` through unchanged, so each per-account call still targets one mailbox (default "INBOX").

### Recommended Pattern

Add `allMailboxes?: boolean` to `searchMessages()` signature. When `true` and an account is resolved, replace the single-mailbox AppleScript with a loop over all mailboxes:

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
  isFlagged?: boolean,
  allMailboxes?: boolean   // NEW
): Message[]
```

For the per-account case when `allMailboxes` is `true`:

```applescript
set fieldSep to character id 57345
set recSep to character id 57346
set outputText to ""
set msgCount to 0
repeat with mb in mailboxes
  set theMailbox to mb
  set allMessages to messages of theMailbox <searchCondition>
  repeat with msg in allMessages
    if msgCount >= <limit> then exit repeat
    try
      ...same field collection as existing single-mailbox block...
      set mbName to name of mb
      set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDateStr & fieldSep & msgRead & fieldSep & msgFlagged & fieldSep & mbName
      set msgCount to msgCount + 1
    end try
  end repeat
  if msgCount >= <limit> then exit repeat
end repeat
return outputText
```

Note: when iterating all mailboxes, the mailbox name must be included in the output so `parseMessageList` can set `mailbox` correctly per record. The current 6-field format does not include mailbox name — a 7th field must be added for the allMailboxes case, or the parse function must be parameterized.

**Simpler alternative:** add the mailbox name as field 7 always (in all search output), not just for `allMailboxes` mode. `parseMessageList` already receives `mailbox` as a parameter (used when parsing single-mailbox results) — for multi-mailbox results the per-record field 7 would override it. This keeps parsing consistent.

### Schema Change in index.ts

```typescript
allMailboxes: z.boolean().optional().describe(
  "Search all mailboxes instead of just INBOX (or the specified mailbox)"
),
```

Recursion pass-through: the no-account recursion loop must also forward `allMailboxes`:

```typescript
const msgs = this.searchMessages(
  query, mailbox, acct.name, remaining,
  dateFrom, dateTo, from, isRead, isFlagged,
  allMailboxes   // add
);
```

### Risks

- Searching all mailboxes across all accounts can be very slow on large mail stores. The 60s timeout should be kept; a note in the tool description warning about performance is appropriate.
- The AppleScript `whose` clause is not supported inside a `repeat with mb in mailboxes` loop at the mailbox-object level in the same way — it must be applied to `messages of mb`. This is the same pattern as the existing code; it works. [ASSUMED]

---

## 3. search-messages Pagination (offset parameter)

### Current State

`listMessages()` has `offset` (line 552) implemented as a skip counter in the AppleScript repeat loop (lines 575–590). `searchMessages()` has no `offset`.

### Where limit is applied in searchMessages

The limit is applied by the AppleScript `if msgCount >= ${limit} then exit repeat` guard (line 386). The TypeScript side never slices — it receives already-limited output.

### Recommended Pattern

Add `offset = 0` to `searchMessages()` signature and replicate the exact same AppleScript skip counter pattern from `listMessages`:

```applescript
set skipped to 0
repeat with msg in allMessages
  if msgCount >= <limit> then exit repeat
  try
    if skipped < <offset> then
      set skipped to skipped + 1
    else
      ...collect fields...
      set msgCount to msgCount + 1
    end if
  end try
end repeat
```

### Edge Case: Per-Account Recursion with Offset

When no account is provided, the method recurses per account. With offset added, the recursion must still accumulate across accounts. The current recursion does:

```typescript
const remaining = limit - allMessages.length;
const msgs = this.searchMessages(query, mailbox, acct.name, remaining, ...);
allMessages.push(...msgs);
```

Offset semantics with multi-account recursion is ambiguous: should offset skip across the combined result set, or per-account? The correct behavior is to skip globally — offset `10` means skip the first 10 messages across all accounts combined.

**Recommended implementation:** Pass `offset` into the per-account recursive calls, but track how many have been consumed:

```typescript
let globalSkipped = 0;
for (const acct of accounts) {
  const acctOffset = Math.max(0, offset - globalSkipped);
  const msgs = this.searchMessages(
    query, mailbox, acct.name, remaining,
    dateFrom, dateTo, from, isRead, isFlagged,
    allMailboxes, acctOffset
  );
  globalSkipped += acctOffset + msgs.length; // rough approximation
  allMessages.push(...msgs);
}
```

This is approximate because we don't know how many messages were in each account before filtering. A cleaner approach: pass `offset = 0` to each account call and handle the global offset at the outer level by collecting more and slicing:

```typescript
// simpler: collect offset+limit, then slice in TypeScript
const msgs = this.searchMessages(query, mailbox, acct.name, limit + offset, ...no offset...);
// after loop: allMessages.slice(offset, offset + limit)
```

**Recommendation:** Use the simpler post-slice approach for multi-account mode. For single-account mode, pass offset through to AppleScript for efficiency (avoids fetching unwanted messages).

### Schema Change in index.ts

```typescript
offset: z.number().optional().describe("Number of results to skip (for pagination)"),
```

---

## 4. HTML Email Sending

### Current State

`sendEmail()` and `createDraft()` both use:

```applescript
set newMessage to make new outgoing message with properties {subject:"...", content:"...", visible:true}
```

`content` is the plain-text body. `SendEmailParams` already has `isHtml?: boolean` (types.ts line 233) but it is not passed to `sendEmail()` or `createDraft()` method signatures, and is not in the MCP schemas.

### AppleScript HTML Support

[ASSUMED] Apple Mail's `make new outgoing message` does not accept HTML directly in the `content` property — `content` is plain text. The AppleScript dictionary does not expose a direct "set HTML body" property on `outgoing message`.

The standard workaround for sending HTML via AppleScript is to use `make new body part`:

```applescript
set newMessage to make new outgoing message with properties {subject:"...", visible:false}
tell newMessage
  make new body part at beginning of body parts with properties {
    content: "<html><body>...</body></html>",
    mime type: "text/html"
  }
  ...recipients...
end tell
```

[ASSUMED] This approach works for Mail.app 16+ (macOS Ventura and later). It creates a proper MIME multipart message with the HTML part.

An alternative that is sometimes cited is setting `content` to the HTML string and relying on Mail.app to detect it — but this is unreliable and may result in raw HTML being displayed as plain text.

**Verified pattern to test:** The `make new body part` approach with `mime type: "text/html"` is the documented AppleScript way. [ASSUMED based on training knowledge — should be manually verified on the target system before shipping.]

### Recommended Implementation

Add `isHtml?: boolean` parameter to `sendEmail()` and `createDraft()`:

```typescript
sendEmail(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[],
  account?: string,
  attachments?: string[],
  isHtml?: boolean   // NEW
): boolean
```

Conditionally branch the AppleScript body-creation strategy:

```typescript
const bodyCommand = isHtml
  ? `
    set newMessage to make new outgoing message with properties {subject:"${safeSubject}", visible:${visible}}
    tell newMessage
      make new body part at beginning of body parts with properties {content:"${safeBody}", mime type:"text/html"}
      ${recipientCommands}
      ${attachmentCommands}
    end tell
  `
  : `
    set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:${visible}}
    tell newMessage
      ${recipientCommands}
      ${attachmentCommands}
    end tell
  `;
```

### Schema Changes in index.ts

Add to both `send-email` and `create-draft` tool schemas:

```typescript
isHtml: z.boolean().optional().describe(
  "Whether the body contains HTML markup (default: false — plain text)"
),
```

Pass through in handlers:

```typescript
const success = mailManager.sendEmail(to, subject, body, cc, bcc, account, attachments, isHtml);
```

### Risks

- [ASSUMED] `make new body part` behavior may vary by macOS version. The implementation should fall back gracefully to plain text if the command fails.
- HTML in the `safeBody` variable: the existing `escapeForAppleScript()` function escapes `\` and `"`. For HTML content, this is correct — no additional escaping needed for `<`, `>`, `&` since AppleScript string literals are not XML.
- Very long HTML bodies may cause AppleScript string literal size issues. This is an existing risk with plain text too, and not new to Phase 2.

---

## 5. Persistent Email Templates

### Current State

Templates are stored in a `Map<string, EmailTemplate>` on the `AppleMailManager` instance (line 1679). `nextTemplateId` is a counter starting at 1. All state is lost on server restart.

`EmailTemplate` interface (types.ts lines 445–463):

```typescript
export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  to?: string[];
  cc?: string[];
}
```

### Recommended Persistence Approach

Write to `~/.config/apple-mail-mcp/templates.json` using Node.js built-in `fs` (no new dependencies). Load on class initialization. Persist on every write (save/delete).

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
```

Template file structure (JSON):

```json
{
  "nextId": 4,
  "templates": {
    "tmpl_1": { "id": "tmpl_1", "name": "...", "subject": "...", "body": "...", "to": [...] },
    "tmpl_2": { "id": "tmpl_2", ... }
  }
}
```

Config directory path:

```typescript
private readonly TEMPLATE_FILE = join(homedir(), '.config', 'apple-mail-mcp', 'templates.json');
```

Initialization (in class constructor or lazy `initTemplates()`):

```typescript
private loadTemplates(): void {
  try {
    if (!existsSync(this.TEMPLATE_FILE)) return;
    const raw = readFileSync(this.TEMPLATE_FILE, 'utf8');
    const data = JSON.parse(raw) as { nextId: number; templates: Record<string, EmailTemplate> };
    this.templates = new Map(Object.entries(data.templates));
    this.nextTemplateId = data.nextId;
  } catch (err) {
    // Corrupt or unreadable file — start fresh, do not crash
    console.error(`Failed to load templates: ${err}`);
  }
}

private persistTemplates(): void {
  try {
    const dir = join(homedir(), '.config', 'apple-mail-mcp');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = {
      nextId: this.nextTemplateId,
      templates: Object.fromEntries(this.templates),
    };
    writeFileSync(this.TEMPLATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to persist templates: ${err}`);
  }
}
```

Call `loadTemplates()` in the class constructor (must add a constructor to `AppleMailManager`). Call `persistTemplates()` at the end of `saveTemplate()` and `deleteTemplate()`.

### Sync vs Async

Use `fs` synchronous APIs (`readFileSync`, `writeFileSync`). The entire codebase is synchronous (execSync for AppleScript). Using async `fs.promises` would require making `saveTemplate` and `deleteTemplate` async, which would ripple through the MCP handlers. Synchronous file I/O on a config file of a few KB is negligible — the 30–60s AppleScript calls dominate by orders of magnitude.

### Template ID Stability

The existing ID scheme `tmpl_${nextTemplateId++}` is already stable across saves because `nextTemplateId` will be persisted in the JSON. Template IDs created before persistence was added will be regenerated on first save (acceptable one-time migration).

### Risks

- File permission errors: catch and log (don't crash). Templates will silently not persist if the write fails, which is the existing behavior.
- Concurrent writes: not a risk — single-process, synchronous.
- The class currently has no constructor. Adding one requires care to ensure no existing initialization logic is broken (there isn't any — fields are all class-field initializers).

---

## 6. save-attachment by Index

### Current State

`saveAttachment()` (lines 1226–1269) matches by filename:

```applescript
repeat with att in mail attachments of msg
  if name of att is "${safeName}" then
    set savePath to POSIX file "${safePath}/${safeName}"
    save att in savePath
    return "ok"
  end if
end repeat
return "error:Attachment not found"
```

The current MCP schema for `save-attachment`:

```typescript
{
  id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  attachmentName: z.string().min(1, "Attachment name is required"),
  savePath: z.string().min(1, "Save directory path is required"),
}
```

`attachmentName` is required with no fallback when two attachments share a name.

### AppleScript Ordinal Access

[ASSUMED] AppleScript's `mail attachments` is an ordered list. Ordinal access by 1-based index is valid:

```applescript
set att to mail attachment 1 of msg   -- first attachment
set att to mail attachment 2 of msg   -- second attachment
```

Or equivalently:

```applescript
set att to item <N> of (mail attachments of msg)
```

The first form is idiomatic and preferred.

### Recommended Pattern

Add optional `attachmentIndex?: number` to `saveAttachment()` and the MCP schema. When provided, use index-based access; when omitted, fall back to the existing name-match loop.

TypeScript method signature:

```typescript
saveAttachment(
  id: string,
  attachmentName: string,
  savePath: string,
  attachmentIndex?: number   // NEW — 1-based
): boolean
```

AppleScript branch:

```typescript
const attachmentAccess = attachmentIndex !== undefined
  ? `
    set attCount to count of mail attachments of msg
    if ${attachmentIndex} > attCount then
      return "error:Attachment index ${attachmentIndex} out of range (message has " & attCount & " attachment(s))"
    end if
    set att to mail attachment ${attachmentIndex} of msg
    set attName to name of att
    set savePath to POSIX file "${safePath}/" & attName
    save att in savePath
    return "ok"
  `
  : `
    repeat with att in mail attachments of msg
      if name of att is "${safeName}" then
        set savePath to POSIX file "${safePath}/${safeName}"
        save att in savePath
        return "ok"
      end if
    end repeat
    return "error:Attachment not found"
  `;
```

### Schema Change in index.ts

Make `attachmentName` optional when `attachmentIndex` is provided:

```typescript
{
  id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  attachmentName: z.string().optional().describe(
    "Attachment filename (required if attachmentIndex not provided)"
  ),
  attachmentIndex: z.number().int().min(1).optional().describe(
    "1-based attachment index (use when two attachments share a filename)"
  ),
  savePath: z.string().min(1, "Save directory path is required"),
}
```

Add a `.refine()` to enforce at least one of the two:

```typescript
.refine(
  (data) => data.attachmentName || data.attachmentIndex !== undefined,
  { message: "Either attachmentName or attachmentIndex must be provided" }
)
```

Note: Zod's `.refine()` on `server.tool()` schema objects (plain object notation) may not be directly supported — the schema object is passed as-is to the MCP SDK. Check whether the SDK accepts a Zod object with `.refine()`. If not, validate manually in the handler body before calling `mailManager.saveAttachment()`.

### Risks

- [ASSUMED] `mail attachment N of msg` may throw `can't get mail attachment N` if N exceeds count. The bounds check in the AppleScript handles this.
- When `attachmentIndex` is used, `savePath` must be `dir/name_of_att` where `name_of_att` comes from `name of att` at runtime, not from the TypeScript caller. The AppleScript above captures `attName` and builds the path — this is correct.
- The response message in the handler currently echoes `attachmentName` back to the user. When index is used, the handler should read the name from the service or just say "Attachment ${attachmentIndex} saved to ${savePath}".

---

## Implementation Notes & Risks

### FIELD_SEP / RECORD_SEP Consistency

All six features use the existing `FIELD_SEP` (U+E001) and `RECORD_SEP` (U+E002) constants. In AppleScript these are always written as `character id 57345` and `character id 57346` respectively (not as inline string literals). New AppleScript blocks must follow this pattern — do not use the TypeScript constant values directly in template literals.

### parseMessageList Not Affected by Items 2–3

`parseMessageList()` (lines 612–637) is called by both `listMessages` and `searchMessages`. For `allMailboxes` mode (item 2), the mailbox name per record must be embedded in the output as field 7, and `parseMessageList` must use it in preference to the passed-in `mailbox` parameter. This is a targeted extension, not a rewrite.

For pagination (item 3), `parseMessageList` is unchanged — the offset filtering is entirely in AppleScript before data is returned.

### No New npm Dependencies

None of the six items requires a new package:
- Template persistence: Node.js built-in `fs` and `os` modules
- HTML sending: AppleScript language feature
- All others: AppleScript + existing TypeScript patterns

### Constructor Addition for Template Persistence

`AppleMailManager` has no constructor currently (uses class-field initializers). Adding a constructor just to call `loadTemplates()` is clean and non-breaking. Alternatively, use a lazy-load pattern triggered by the first template operation — but a constructor is simpler and explicit.

### Test Coverage Expectations

Phase 1 established the pattern: unit tests live in `src/__tests__/` (security.test.ts) and `src/utils/*.test.ts`. New Phase 2 tests should follow the same location convention. AppleScript calls should be mocked (the pattern from `applescript.test.ts` uses `vi.mock`). Key behaviors to test:
- `getMessageById` returns populated `recipients`, `ccRecipients`, `senderName`, `hasAttachments`
- Template `saveTemplate` → process restart simulation → `listTemplates` shows persisted templates
- `searchMessages` with `offset=5` skips first 5 results
- `saveAttachment` with `attachmentIndex=1` hits index-based AppleScript branch

---

## Recommended Approach per Feature

| Feature | Files Changed | Complexity | Risk |
|---------|--------------|-----------|------|
| Full message headers | `appleMailManager.ts` (getMessageById), `types.ts` (add replyTo field) | Low | Low — additive fields |
| allMailboxes search | `appleMailManager.ts` (searchMessages), `index.ts` (schema), `types.ts` (SearchMessagesParams) | Medium | Medium — AppleScript loop + parse alignment |
| search offset | `appleMailManager.ts` (searchMessages), `index.ts` (schema) | Low | Low — mirrors listMessages pattern exactly |
| HTML send | `appleMailManager.ts` (sendEmail, createDraft), `index.ts` (schema x2) | Low-Medium | Medium — AppleScript body part API [ASSUMED]; needs live test |
| Attachment by index | `appleMailManager.ts` (saveAttachment), `index.ts` (schema) | Low | Low — ordinal access is standard AppleScript |
| Template persistence | `appleMailManager.ts` (constructor, new methods) | Low | Low — pure Node.js fs, well-understood pattern |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `to recipients of msg` and `cc recipients of msg` are iterable lists with `address` property | Section 1 | Would need different AppleScript property name; fix is a one-line change |
| A2 | `reply to of msg` is a string address property on Message in Mail's AppleScript dictionary | Section 1 | Property may not exist; the `try...end try` wrapper ensures graceful fallback to "" |
| A3 | AppleScript `whose` clause works on `messages of mb` inside a `repeat with mb in mailboxes` loop | Section 2 | If not, allMailboxes must filter in the AppleScript `repeat with msg` loop instead (slightly more code) |
| A4 | `make new body part at beginning of body parts with properties {content:..., mime type:"text/html"}` is the correct AppleScript pattern for HTML email | Section 4 | Could silently produce malformed email or fail; fallback to plain text is safe |
| A5 | `mail attachment N of msg` (1-based ordinal) is valid AppleScript syntax for index-based attachment access | Section 6 | Use `item N of (mail attachments of msg)` as fallback — equivalent |

---

## Sources

### Primary (HIGH confidence — direct codebase reading)
- `/Users/michaelhenze/apple-mail-mcp/src/services/appleMailManager.ts` — all AppleScript patterns, FIELD_SEP/RECORD_SEP usage, method signatures
- `/Users/michaelhenze/apple-mail-mcp/src/index.ts` — all MCP tool schemas (Zod), handler patterns
- `/Users/michaelhenze/apple-mail-mcp/src/types.ts` — TypeScript interfaces (Message, EmailTemplate, SendEmailParams)
- `/Users/michaelhenze/apple-mail-mcp/src/utils/pathSecurity.ts` — validateSavePath pattern (used in saveAttachment)
- `/Users/michaelhenze/apple-mail-mcp/.planning/ROADMAP.md` — phase scope definition
- `/Users/michaelhenze/apple-mail-mcp/.planning/codebase/ARCHITECTURE.md` — design patterns and constraints

### Secondary (MEDIUM confidence)
- Node.js documentation for `fs.readFileSync`, `fs.writeFileSync`, `fs.mkdirSync`, `os.homedir` — standard built-ins, stable API

### Tertiary (LOW confidence — training knowledge, not verified against live system)
- AppleScript Mail dictionary for `to recipients`, `cc recipients`, `reply to`, `make new body part`, `mail attachment N` — marked [ASSUMED] throughout; all should be verified with a live AppleScript test before finalizing the implementation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all built-ins
- Architecture: HIGH — derived directly from source files
- AppleScript patterns: MEDIUM/ASSUMED — training knowledge; live verification recommended for items 1, 4, 6 before considering tasks done
- Pitfalls: HIGH — identified by reading actual code, not speculation

**Research date:** 2026-05-20
**Valid until:** 2026-07-20 (stable codebase; AppleScript API does not change across minor macOS updates)
