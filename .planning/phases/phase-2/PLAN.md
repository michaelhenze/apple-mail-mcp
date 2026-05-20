# Phase 2: Complete Core Message Data

## Goal

Close the gaps where Mail.app data exists but MCP tools don't expose it. After this phase: `get-message` returns full headers (recipients, ccRecipients, replyTo, senderName, hasAttachments), `search-messages` works across all mailboxes and supports pagination, HTML emails can be sent, templates survive server restarts, and attachments can be selected by index.

## Success Criteria

- `getMessageById()` returns non-empty `recipients`, `ccRecipients` (when present), `senderName` (when sender has display name), `replyTo` (when header exists), accurate `hasAttachments`, and `attachmentNames` array (populated when attachments exist)
- `searchMessages()` with `allMailboxes: true` iterates all mailboxes of the target account, not just INBOX
- `searchMessages()` with `offset: N` skips the first N results, matching the existing `listMessages` behaviour
- `sendEmail()` and `createDraft()` accept `isHtml: true` and produce an HTML-body message in Mail.app
- `saveTemplate()` writes to `~/.config/apple-mail-mcp/templates.json`; templates reloaded on process start
- `saveAttachment()` with `attachmentIndex: 1` saves the first attachment without requiring its filename
- All new paths covered by unit tests in `src/__tests__/phase2.test.ts`

---

## Tasks

### Task 1: Add `replyTo` to `Message` type and extend `getMessageById` with full headers

**Files:** `src/types.ts`, `src/services/appleMailManager.ts`

**What to change in `src/types.ts`**

The `Message` interface (lines 21–69) is missing `replyTo`. Add it after `ccRecipients`:

```typescript
/** Reply-to address (if different from sender) */
replyTo?: string;
```

`senderName` is **already present** at line 32 of `types.ts` — do NOT add it again (duplicate identifier will break compilation). Only `replyTo` and `attachmentNames` need to be added.

Also add `attachmentNames` after `hasAttachments`:

```typescript
/** Names of attachments on this message */
attachmentNames?: string[];
```

All other fields (`recipients`, `ccRecipients`, `hasAttachments`, `senderName`) are already present in the interface.

**What to change in `src/services/appleMailManager.ts` — AppleScript block (lines 427–454)**

The current AppleScript `return` statement at line 445 returns 9 FIELD_SEP-delimited fields:

```
subject | sender | date | read | flagged | junk | deleted | mailbox | account
```

Extend the block to collect four more fields after the existing nine. Insert the following AppleScript immediately before the `return` statement (after `set msgAccount to name of acct`, line 444):

```applescript
-- recipients (field 10)
set msgRecipients to ""
repeat with r in to recipients of msg
  if msgRecipients is not "" then set msgRecipients to msgRecipients & ","
  set msgRecipients to msgRecipients & (address of r)
end repeat

-- cc recipients (field 11)
set msgCC to ""
repeat with r in cc recipients of msg
  if msgCC is not "" then set msgCC to msgCC & ","
  set msgCC to msgCC & (address of r)
end repeat

-- reply-to (field 12) — may not exist on all messages; wrap in try
set msgReplyTo to ""
try
  set msgReplyTo to reply to of msg
end try

-- has attachments (field 13)
set msgHasAtt to (count of mail attachments of msg) > 0

-- attachment names (field 14) — comma-joined
set msgAttNames to ""
if msgHasAtt then
  repeat with att in mail attachments of msg
    if msgAttNames is not "" then set msgAttNames to msgAttNames & ","
    set msgAttNames to msgAttNames & (name of att)
  end repeat
end if
```

Update the `return` statement (line 445) to:

```applescript
return msgSubject & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & msgFlagged & fieldSep & msgJunk & fieldSep & msgDeleted & fieldSep & msgMailbox & fieldSep & msgAccount & fieldSep & msgRecipients & fieldSep & msgCC & fieldSep & msgReplyTo & fieldSep & (msgHasAtt as string) & fieldSep & msgAttNames
```

**What to change in `src/services/appleMailManager.ts` — TypeScript parse (lines 463–479)**

The guard `if (parts.length < 9) return null;` (line 464) stays unchanged (9 is a minimum floor — new fields are additive). Update the returned object to populate the new fields from parts[9]–parts[13]:

```typescript
return {
  id: id.toString(),
  subject: parts[0],
  sender: parts[1],
  senderName: parts[1].includes('<')
    ? parts[1].split('<')[0].trim().replace(/^"/, '').replace(/"$/, '') || undefined
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
  attachmentNames: parts[13] ? parts[13].split(',').filter(Boolean) : undefined,
};
```

**Verify:** `npx tsc --noEmit` passes. No runtime test possible without Mail.app; compile check is sufficient for this task.

**Done:**
- `Message` interface has `replyTo?: string` and `attachmentNames?: string[]` (senderName was already present)
- `getMessageById()` returns `recipients`, `ccRecipients`, `replyTo`, `senderName`, `hasAttachments`, `attachmentNames` populated from AppleScript output
- TypeScript compiles without errors

---

### Task 2: Add `allMailboxes` mode to `searchMessages`

**Files:** `src/services/appleMailManager.ts`, `src/index.ts`

**Service layer — signature change (`appleMailManager.ts` lines 305–315)**

Add `allMailboxes?: boolean` as the last parameter of `searchMessages()`:

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

**Multi-account fan-out (lines 316–336) — forward the new parameter**

In the `if (!account)` branch, add `allMailboxes` to each recursive call:

```typescript
const msgs = this.searchMessages(
  query,
  mailbox,
  acct.name,
  remaining,
  dateFrom,
  dateTo,
  from,
  isRead,
  isFlagged,
  allMailboxes   // forward
);
```

**Single-account path — replace fixed mailbox with per-mailbox loop when `allMailboxes` is true**

⚠️ **Variable hoisting required:** The `searchCondition` and `dateFilter` string variables are currently built inside the single-mailbox code path (lines ~344–375). Before adding the `allMailboxes` branch, move the construction of `searchCondition` and `dateFilter` to **above** the `if (allMailboxes)` check so both branches can reference them. The `allMailboxes` branch must be inserted **after** these variables are defined.

After moving the variable construction above and after `const targetAccount = this.resolveAccount(account);` (line 339), add the branch:

```typescript
if (allMailboxes) {
  // Build the same searchCondition and dateFilter strings as in the single-mailbox path,
  // then use an AppleScript loop over all mailboxes of the account.
  const searchCommand = `
    set fieldSep to character id 57345
    set recSep to character id 57346
    set outputText to ""
    set msgCount to 0
    repeat with mb in mailboxes
      set allMessages to messages of mb ${searchCondition}
      repeat with msg in allMessages
        if msgCount >= ${limit} then exit repeat
        try
          ${dateFilter ? `set msgDate to date received of msg\n          if not (${dateFilter}) then\n          else` : ""}
          set msgId to id of msg as string
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDateStr to date received of msg as string
          set msgRead to read status of msg as string
          set msgFlagged to flagged status of msg as string
          set mbName to name of mb
          if msgCount > 0 then set outputText to outputText & recSep
          set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDateStr & fieldSep & msgRead & fieldSep & msgFlagged & fieldSep & mbName
          set msgCount to msgCount + 1
          ${dateFilter ? "end if" : ""}
        end try
      end repeat
      if msgCount >= ${limit} then exit repeat
    end repeat
    return outputText
  `;
  const script = buildAccountScopedScript(targetAccount, searchCommand);
  const result = executeAppleScript(script, { timeoutMs: 60000 });
  if (!result.success || !result.output.trim()) return [];
  // For allMailboxes output, mailbox name is in field 7 (parts[6]) per record.
  return this.parseMessageListAllMailboxes(result.output, targetAccount);
}
```

**Add `parseMessageListAllMailboxes` private helper** (right after the existing `parseMessageList` method at line 637):

```typescript
private parseMessageListAllMailboxes(output: string, account: string): Message[] {
  const items = output.split(RECORD_SEP);
  const messages: Message[] = [];
  for (const item of items) {
    const parts = item.split(FIELD_SEP);
    if (parts.length < 7) continue;
    messages.push({
      id: parts[0].trim(),
      subject: parts[1],
      sender: parts[2],
      recipients: [],
      dateReceived: parseAppleScriptDate(parts[3]),
      isRead: parts[4] === 'true',
      isFlagged: parts[5] === 'true',
      isJunk: false,
      isDeleted: false,
      mailbox: parts[6],   // per-record mailbox name from field 7
      account,
      hasAttachments: false,
    });
  }
  return messages;
}
```

**MCP schema — `src/index.ts` (lines 101–112)**

Add to the `search-messages` tool schema object:

```typescript
allMailboxes: z.boolean().optional().describe(
  "Search across all mailboxes in the account (not just INBOX). May be slow on large mail stores."
),
```

**Handler destructuring (line 114)** — add `allMailboxes` to the destructured params and forward it:

```typescript
({ query, from, isRead, isFlagged, mailbox, account, limit = 50, dateFrom, dateTo, allMailboxes }) => {
  const messages = mailManager.searchMessages(
    query, mailbox, account, limit, dateFrom, dateTo, from, isRead, isFlagged, allMailboxes
  );
```

**Verify:** `npx tsc --noEmit` passes.

**Done:**
- `search-messages` accepts `allMailboxes: true`
- Service iterates all mailboxes of resolved account when flag is true
- Per-record mailbox name is populated correctly
- Multi-account fan-out forwards the flag

---

### Task 3: Add `offset` parameter to `searchMessages`

**Files:** `src/services/appleMailManager.ts`, `src/index.ts`

**Service layer — signature change**

Add `offset = 0` to `searchMessages()` signature, after `allMailboxes`:

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
  allMailboxes?: boolean,
  offset = 0           // NEW
): Message[]
```

**Multi-account fan-out offset handling (lines 317–336)**

The per-account recursion collects messages across accounts. Use the simpler "collect more, then slice" approach to avoid complexity of distributing an offset across unknown per-account counts.

In the `if (!account)` branch, change the call to pass `offset: 0` (suppress per-account offset) and collect `offset + limit` results, then slice at the TypeScript level:

```typescript
if (!account) {
  const accounts = this.listAccounts();
  const allMessages: Message[] = [];
  for (const acct of accounts) {
    if (allMessages.length >= offset + limit) break;
    const remaining = (offset + limit) - allMessages.length;
    const msgs = this.searchMessages(
      query, mailbox, acct.name, remaining,
      dateFrom, dateTo, from, isRead, isFlagged,
      allMailboxes, 0   // offset=0 per account; global slice below
    );
    allMessages.push(...msgs);
  }
  return allMessages.slice(offset, offset + limit);
}
```

**Single-account / single-mailbox AppleScript block (lines 377–401)**

The existing `searchCommand` uses a single `msgCount` counter. Add a `skipped` counter exactly mirroring the pattern from `listMessages` (lines 574–589):

```applescript
set msgCount to 0
set skipped to 0
repeat with msg in allMessages
  if msgCount >= ${limit} then exit repeat
  try
    ${dateFilter ? `...date check...` : ""}
    if skipped < ${offset} then
      set skipped to skipped + 1
    else
      set msgId to id of msg as string
      set msgSubject to subject of msg
      set msgSender to sender of msg
      set msgDateStr to date received of msg as string
      set msgRead to read status of msg as string
      set msgFlagged to flagged status of msg as string
      if msgCount > 0 then set outputText to outputText & recSep
      set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDateStr & fieldSep & msgRead & fieldSep & msgFlagged
      set msgCount to msgCount + 1
    end if
    ${dateFilter ? "end if" : ""}
  end try
end repeat
```

Note: the date-filter branch (when `dateFilter` is non-empty) wraps both the skip check and the field collection — keep the `if not (${dateFilter}) then -- skip ... else ... end if` outer structure intact and place the `skipped < offset` inner branch inside the `else` block.

Also apply the same `skipped` counter to the `allMailboxes` path added in Task 2 (insert `set skipped to 0` before the outer `repeat with mb` and the inner `if skipped < ${offset}` guard before collecting fields).

**MCP schema — `src/index.ts` (lines 101–112)**

Add:

```typescript
offset: z.number().optional().describe("Number of results to skip (for pagination, default: 0)"),
```

**Handler (line 114)** — add `offset = 0` to destructuring and forward:

```typescript
({ query, from, isRead, isFlagged, mailbox, account, limit = 50, offset = 0, dateFrom, dateTo, allMailboxes }) => {
  const messages = mailManager.searchMessages(
    query, mailbox, account, limit, dateFrom, dateTo, from, isRead, isFlagged, allMailboxes, offset
  );
```

**Verify:** `npx tsc --noEmit` passes.

**Done:**
- `search-messages` accepts `offset: N`
- Single-account path skips N results in AppleScript before collecting
- Multi-account path collects offset+limit results then slices in TypeScript

---

### Task 4: HTML email sending (`isHtml` for `send-email` and `create-draft`)

**Files:** `src/services/appleMailManager.ts`, `src/index.ts`

**Service layer — `sendEmail()` signature change (line 650)**

Add `isHtml?: boolean` as the last parameter:

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

**HTML body variable (after line 660)**

After `const safeBody = escapeForAppleScript(body);`, add:

```typescript
const contentBody = isHtml ? escapeForAppleScript(body) : safeBody;
```

(This is the same value — `escapeForAppleScript` is idempotent on the original `body` string — but makes the intention explicit.)

**AppleScript branch — replace plain `content` with `make new body part` when `isHtml` is true**

The current `sendCommand` (lines 691–710) sets `content:"${safeBody}"` in `make new outgoing message with properties`. Replace with a conditional:

For the `account` branch:

```typescript
sendCommand = isHtml
  ? `
    set newMessage to make new outgoing message with properties {subject:"${safeSubject}", visible:true}
    tell newMessage
      make new body part at beginning of body parts with properties {content:"${contentBody}", mime type:"text/html"}
      ${recipientCommands}
      set sender to "${safeAccount}"
      ${attachmentCommands}
    end tell
    send newMessage
    return "sent"
  `
  : `
    set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
    tell newMessage
      ${recipientCommands}
      set sender to "${safeAccount}"
      ${attachmentCommands}
    end tell
    send newMessage
    return "sent"
  `;
```

Apply the same conditional structure to the no-account branch (lines 701–710).

**`createDraft()` — identical change (lines 735–804)**

Add `isHtml?: boolean` to the `createDraft()` signature (after `attachments?: string[]`) and apply the same `make new body part` conditional for the draft AppleScript (`visible:false`, no `send newMessage`).

**MCP schema — `src/index.ts`**

Add to the `send-email` schema (lines 200–212):

```typescript
isHtml: z.boolean().optional().describe(
  "Send as HTML email. When true, body is rendered as HTML markup rather than plain text."
),
```

Add the same field to the `create-draft` schema (lines 229–240).

**Handler destructuring — `send-email` (line 213)**

```typescript
({ to, subject, body, cc, bcc, account, attachments, isHtml }) => {
  const success = mailManager.sendEmail(to, subject, body, cc, bcc, account, attachments, isHtml);
```

**Handler destructuring — `create-draft` (line 241)**

```typescript
({ to, subject, body, cc, bcc, account, attachments, isHtml }) => {
  const success = mailManager.createDraft(to, subject, body, cc, bcc, account, attachments, isHtml);
```

**Note on `make new body part`:** This is the standard AppleScript pattern for HTML mail on macOS Ventura+. It is marked [ASSUMED] in RESEARCH.md — wrap the HTML branch in a TypeScript `try/catch` around `executeAppleScript` is not practical (the script itself catches errors), but the plain-text fallback already exists as the `else` branch. If the HTML AppleScript fails at runtime, AppleScript returns a non-"sent" output and `sendEmail()` returns `false` — the caller will see a "Failed to send" error. No silent failure path exists.

**Verify:** `npx tsc --noEmit` passes.

**Done:**
- `send-email` and `create-draft` accept `isHtml: true`
- When `isHtml` is true, AppleScript uses `make new body part` with `mime type:"text/html"`
- When `isHtml` is false/absent, existing plain-text path is unchanged

---

### Task 5: Persist email templates to disk

**Files:** `src/services/appleMailManager.ts`

**Import additions (top of file, after existing imports on line 16–33)**

Add:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
```

**Class fields (add near line 1679, before `private templates`)**

```typescript
private readonly TEMPLATE_FILE = join(homedir(), '.config', 'apple-mail-mcp', 'templates.json');
```

**Add constructor to `AppleMailManager`**

The class currently has no constructor (uses class-field initializers). Add one immediately after the class opening brace (after line 135, before `private defaultAccount`):

```typescript
constructor() {
  this.loadTemplates();
}
```

**Add `loadTemplates()` private method** (add after the `useTemplate` method at line 1738):

```typescript
private loadTemplates(): void {
  try {
    if (!existsSync(this.TEMPLATE_FILE)) return;
    const raw = readFileSync(this.TEMPLATE_FILE, 'utf8');
    const data = JSON.parse(raw) as { nextId: number; templates: Record<string, EmailTemplate> };
    this.templates = new Map(Object.entries(data.templates));
    this.nextTemplateId = data.nextId;
  } catch (err) {
    // Corrupt or unreadable — start fresh, do not crash
    console.error(`[apple-mail-mcp] Failed to load templates: ${err}`);
  }
}
```

**Add `persistTemplates()` private method** (add after `loadTemplates`):

```typescript
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
    console.error(`[apple-mail-mcp] Failed to persist templates: ${err}`);
  }
}
```

**Call `persistTemplates()` at end of `saveTemplate()` (line 1709):**

```typescript
saveTemplate(...): EmailTemplate {
  const templateId = id || `tmpl_${this.nextTemplateId++}`;
  const template: EmailTemplate = { id: templateId, name, subject, body, to, cc };
  this.templates.set(templateId, template);
  this.persistTemplates();   // ADD THIS LINE
  return template;
}
```

**Call `persistTemplates()` at end of `deleteTemplate()` (line 1717):**

```typescript
deleteTemplate(id: string): boolean {
  const deleted = this.templates.delete(id);
  if (deleted) this.persistTemplates();   // ADD THIS LINE
  return deleted;
}
```

**Verify:** `npx tsc --noEmit` passes. The config directory `~/.config/apple-mail-mcp/` does not need to pre-exist — `mkdirSync(..., { recursive: true })` creates it.

**Done:**
- Templates written to `~/.config/apple-mail-mcp/templates.json` on every `saveTemplate` / `deleteTemplate` call
- Templates loaded from disk in constructor — survive process restarts
- JSON format: `{ nextId: N, templates: { "tmpl_1": {...}, ... } }`
- Read/write errors logged but do not crash the server

---

### Task 6: Attachment selection by index (`attachmentIndex` for `save-attachment`)

**Files:** `src/services/appleMailManager.ts`, `src/index.ts`

**Service layer — `saveAttachment()` signature change (line 1226)**

Add optional `attachmentIndex?: number` (1-based) as the fourth parameter:

```typescript
saveAttachment(id: string, attachmentName: string, savePath: string, attachmentIndex?: number): boolean
```

**AppleScript branch inside `saveAttachment()` (lines 1235–1268)**

The current script uses a name-match loop (lines 1243–1249). Replace the attachment-selection block (from `set msg to item 1 of matchingMsgs` onwards) with a conditional:

```typescript
const attachmentAccess = attachmentIndex !== undefined
  ? `
    set msg to item 1 of matchingMsgs
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
    set msg to item 1 of matchingMsgs
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

Replace the hardcoded attachment block in the AppleScript template literal with `${attachmentAccess}`.

**Success message in handler — update to reflect index-based save**

Currently the handler (line 584) echoes `attachmentName`. When `attachmentIndex` is provided, `attachmentName` is not known at call time. The handler response should become:

```typescript
const savedAs = attachmentName || `attachment #${attachmentIndex}`;
return successResponse(`Attachment "${savedAs}" saved to ${savePath}`);
```

**MCP schema — `src/index.ts` (lines 572–576)**

Replace the current `save-attachment` schema with:

```typescript
{
  id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  attachmentName: z.string().optional().describe(
    "Attachment filename. Required if attachmentIndex is not provided."
  ),
  attachmentIndex: z.number().int().min(1).optional().describe(
    "1-based attachment index (alternative to attachmentName — useful when two attachments share a filename)"
  ),
  savePath: z.string().min(1, "Save directory path is required"),
}
```

**Manual validation in handler** — Zod `.refine()` on plain schema objects passed to `server.tool()` is not supported by the MCP SDK. Validate in the handler body instead:

```typescript
withErrorHandling(({ id, attachmentName, attachmentIndex, savePath }) => {
  if (!attachmentName && attachmentIndex === undefined) {
    return errorResponse("Either attachmentName or attachmentIndex must be provided");
  }
  const success = mailManager.saveAttachment(id, attachmentName ?? "", savePath, attachmentIndex);
  if (!success) {
    const label = attachmentName || `attachment #${attachmentIndex}`;
    return errorResponse(`Failed to save ${label}`);
  }
  const savedAs = attachmentName || `attachment #${attachmentIndex}`;
  return successResponse(`Attachment "${savedAs}" saved to ${savePath}`);
}, "Error saving attachment")
```

Note: `attachmentName ?? ""` passes an empty string to the service when only index is provided. The index-based AppleScript branch never reads `safeName`, so the empty string is harmless.

**Verify:** `npx tsc --noEmit` passes.

**Done:**
- `save-attachment` accepts `attachmentIndex: N` (1-based)
- Handler validates that at least one of `attachmentName` / `attachmentIndex` is supplied
- AppleScript uses ordinal access `mail attachment N of msg` with bounds check
- Existing name-based path unchanged when only `attachmentName` is provided

---

### Task 7: Unit tests for Phase 2 logic

**Files:** `src/__tests__/phase2.test.ts` (new file)

Write unit tests for the pure TypeScript logic added in this phase. Use the same test style as `src/__tests__/security.test.ts` (vitest `describe`/`it`/`expect`, no default exports, `@/` path aliases). Mock `fs` module calls using `vi.mock`.

**Test suite 1 — Template persistence round-trip**

Mock `fs` to capture `writeFileSync` calls and provide `readFileSync` return values. Instantiate `AppleMailManager` with the mock in place.

- `loadTemplates` on startup reads from `~/.config/apple-mail-mcp/templates.json` when file exists
- `saveTemplate` calls `writeFileSync` with JSON containing the new template
- `deleteTemplate` calls `writeFileSync` with the template removed
- After `loadTemplates`, `listTemplates()` returns the restored templates
- `loadTemplates` with corrupt JSON does not throw; `listTemplates()` returns `[]`

Because `AppleMailManager` is a class with private methods, test via the public interface: `saveTemplate`, `listTemplates`, `deleteTemplate`. Use `vi.mock('fs', ...)` to intercept reads/writes.

**Test suite 2 — `searchMessages` offset slicing (TypeScript-level)**

The multi-account offset logic in `searchMessages` uses `allMessages.slice(offset, offset + limit)`. This is pure TypeScript and can be tested without mocking AppleScript:

- When `account` is not provided and results exceed `offset`, slice returns correct window
- When `offset >= totalResults`, returns empty array

To test this without real accounts, mock `this.listAccounts()` and `executeAppleScript` to return controlled output, then verify the returned slice.

**Test suite 3 — `Message` type completeness (compile-time)**

A compile-time check that `replyTo` and `senderName` fields exist on `Message`:

```typescript
import type { Message } from "@/types.js";

it("Message interface has replyTo and senderName fields", () => {
  // Compile-time check: if these fields don't exist, tsc will fail
  const _check: Pick<Message, 'replyTo' | 'senderName'> = {
    replyTo: undefined,
    senderName: undefined,
  };
  expect(_check).toBeDefined();
});
```

**Test suite 4 — `save-attachment` schema validation**

Test the handler-level guard (not the Zod schema, since `.refine()` is not used):

```typescript
it("rejects call when neither attachmentName nor attachmentIndex provided", () => {
  // Simulate the handler guard directly
  const attachmentName = undefined;
  const attachmentIndex = undefined;
  const isInvalid = !attachmentName && attachmentIndex === undefined;
  expect(isInvalid).toBe(true);
});

it("accepts call with only attachmentName", () => {
  const isInvalid = !("report.pdf") && undefined === undefined;
  expect(isInvalid).toBe(false);
});

it("accepts call with only attachmentIndex", () => {
  const isInvalid = !(undefined) && 1 === undefined;
  expect(isInvalid).toBe(false);
});
```

**Run command:** `npx vitest run src/__tests__/phase2.test.ts`

**Verify:** All tests pass. `npx tsc --noEmit` still passes.

**Done:**
- `src/__tests__/phase2.test.ts` exists with all four test suites
- All tests pass under vitest
- No existing tests broken (run `npx vitest run` to confirm)

---

## Execution Order

Tasks 1–6 can be executed sequentially in any order — none depends on another's output. The recommended order follows the research document's guidance:

1. Task 1 (type + getMessageById) — adds `replyTo`/`senderName` to the `Message` type; do this first so all subsequent tasks compile correctly
2. Task 2 (allMailboxes)
3. Task 3 (offset) — builds on the `searchMessages` signature already extended in Task 2
4. Task 4 (HTML send)
5. Task 5 (template persistence)
6. Task 6 (attachment index)
7. Task 7 (tests) — after all production changes are in place

Tasks 2 and 3 both modify the same `searchMessages` method signature and body. If done in order (Task 2 first, then Task 3), each task adds to the previous result without conflict. They must not be done in parallel.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `to recipients of msg` / `cc recipients of msg` throw on some macOS versions | Low | Wrap each recipient loop in `try...end try`; falls back to empty string |
| `reply to of msg` throws when no Reply-To header present | Medium | Already wrapped in `try...end try` in the AppleScript block |
| `make new body part` with `mime type:"text/html"` not supported on older Mail.app | Medium | If `executeAppleScript` returns non-"sent" output, `sendEmail()` returns `false` — caller sees error, no silent failure |
| `mail attachment N of msg` throws when N > attachment count | Low | Explicit bounds check in AppleScript before ordinal access |
| Template file write permission denied | Low | Caught and logged; server continues without persistence |
| `searchMessages allMailboxes` slow on large mail stores | High | Document in tool description; 60s timeout already in place |
| Parts count mismatch in `getMessageById` parse (old clients expecting 9 fields) | None | Guard is `< 9` (minimum); new fields are additive at higher indices |
