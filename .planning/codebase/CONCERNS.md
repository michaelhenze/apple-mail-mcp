# Technical Concerns

**Analysis Date:** 2026-05-20

---

## Security Risks

### Message ID Injection into AppleScript

**Risk:** Message IDs are interpolated directly into AppleScript without escaping.
**Files:** `src/services/appleMailManager.ts` lines 387, 445, 763, 814, 851, 956, 1091, 1151

In every method that operates on a message by ID, the raw `id` value is embedded directly:
```applescript
set matchingMsgs to (messages of mb whose id is ${id})
```
If `id` contains AppleScript-special characters or a crafted string, this can break the script or inject arbitrary AppleScript. In practice, Mail.app message IDs are integers, but since the parameter is typed `z.string()` with only `min(1)` validation, the MCP schema does not enforce numeric-only input. An AI agent (or adversary) could pass a non-integer value.

**Fix:** Validate that `id` is numeric-only at the MCP schema layer (`z.string().regex(/^\d+$/)`) before it reaches AppleScript, or cast to integer with `parseInt` and reject NaN.

---

### Attachment Path Traversal

**Risk:** The `save-attachment` tool accepts a `savePath` parameter with no path validation.
**Files:** `src/services/appleMailManager.ts` lines 1142–1180, `src/index.ts` lines 558–572

`savePath` is escaped for AppleScript string quoting via `escapeForAppleScript` (which only handles `\` and `"`), but this does not prevent path traversal. A path like `../../Library/Application Support/some-app` would be passed through as-is. An AI-driven workflow could be manipulated into saving attachments to sensitive directories.

**Fix:** Validate `savePath` is an absolute path within expected directories, or at minimum normalize and check it doesn't traverse above a baseline directory. The `attachments` parameter in `send-email`/`create-draft` has the same issue — any POSIX file path is accepted.

---

### No Email Address Validation

**Risk:** Recipient email addresses (`to`, `cc`, `bcc`) are accepted as plain strings with no format validation.
**Files:** `src/index.ts` lines 188–192, 216–220

The schema uses `z.array(z.string())` rather than `z.array(z.string().email())`. Malformed addresses could cause silent send failures or, if an address contained special characters, unexpected behavior in the AppleScript recipient construction.

**Fix:** Change recipient schema to `z.string().email()` or add a `.refine()` with basic email format check.

---

### Contacts.app Script Injection

**Risk:** The `search-contacts` query is embedded in AppleScript using `escapeForAppleScript`, which handles backslashes and double quotes. However, the resulting string is placed inside `every person whose name contains "${safeQuery}"`. If a query contains AppleScript control characters beyond `"` and `\`, behavior is undefined.
**Files:** `src/services/appleMailManager.ts` lines 1524–1578

This is lower severity than the ID injection above (no code execution path evident), but the escaping function was designed primarily for string literals and may not cover all edge cases in the `whose ... contains` filter context.

---

## Technical Debt

### Silent Parameter Dropping in `search-messages`

**What:** The `search-messages` MCP tool declares four filter parameters — `from`, `isRead`, `isFlagged` — in its Zod schema, but the tool handler only passes `query`, `mailbox`, `account`, `limit`, `dateFrom`, and `dateTo` to `searchMessages()`.
**Files:** `src/index.ts` line 112, `src/services/appleMailManager.ts` line 293

```typescript
// index.ts — from, isRead, isFlagged are declared but destructured params omit them
withErrorHandling(({ query, mailbox, account, limit = 50, dateFrom, dateTo }) => {
```

The `from`, `isRead`, and `isFlagged` filters are silently ignored. Users or AI agents who pass these filters will receive results as if no filter was applied, with no warning.

**Fix:** Either implement these filters in `searchMessages()` or remove them from the schema to avoid misleading documentation.

---

### `unreadOnly` Parameter in `list-messages` Is a No-Op

**What:** The `list-messages` tool schema declares `unreadOnly: z.boolean().optional()`, but the handler destructures `{ mailbox, account, limit, offset, from }` — `unreadOnly` is never extracted or used.
**Files:** `src/index.ts` lines 163–166

This is a documented feature that does nothing. Users relying on it will see all messages, not just unread ones.

**Fix:** Either implement `unreadOnly` filtering in `listMessages()` or remove the parameter from the schema.

---

### `renameMailbox` Is Not Atomic

**What:** `renameMailbox` is implemented as three sequential steps: create new mailbox, move all messages, delete old mailbox. If the move step fails partway through or the delete fails, the mail data is left in an inconsistent state (messages in both folders, or the old folder persists alongside the new one).
**Files:** `src/services/appleMailManager.ts` lines 1325–1363

There is no rollback logic. On failure, the method returns `false` but the partial state remains.

**Fix:** Add rollback logic — if the move/delete step fails, delete the newly created mailbox and report the error clearly.

---

### `batch*` Operations Are Serial, Not Batched

**What:** All six batch methods (`batchDeleteMessages`, `batchMoveMessages`, `batchMarkAsRead`, `batchMarkAsUnread`, `batchFlagMessages`, `batchUnflagMessages`) loop over IDs one-by-one, each spawning a full AppleScript session that searches all mailboxes of all accounts.
**Files:** `src/services/appleMailManager.ts` lines 992–1080

For a batch of N messages, the cost is O(N × accounts × mailboxes). A batch of 20 messages on an account with 10 mailboxes runs 20 independent AppleScript executions that each scan 10 mailboxes. This defeats the purpose of batching.

**Fix:** Implement AppleScript-level bulk operations within a single `tell application "Mail"` block for each batch operation, or at minimum cache the per-ID mailbox location after the first lookup.

---

### `parseAppleScriptDate` Falls Back to `new Date()` on Parse Failure

**What:** When `parseAppleScriptDate` fails to parse an AppleScript date string, it returns `new Date()` (the current time) instead of null or an error.
**Files:** `src/services/appleMailManager.ts` lines 62–67

```typescript
return isNaN(parsed.getTime()) ? new Date() : parsed;
```

This means messages with unparseable dates will silently display as if received right now, making date-based filtering and display incorrect.

**Fix:** Return `null` and have callers handle the missing date, or throw so the error is visible.

---

### Email Templates Are In-Memory Only

**What:** Templates are stored in `private templates: Map<string, EmailTemplate>` on the `AppleMailManager` class instance.
**Files:** `src/services/appleMailManager.ts` lines 1584–1643

Templates are lost every time the MCP server process restarts. The README and CLAUDE.md both document this limitation, but it is a significant gap for any workflow that expects templates to persist across sessions.

**Fix:** Persist templates to a local JSON file in a platform-appropriate location (e.g., `~/.config/apple-mail-mcp/templates.json`).

---

### `defaultAccount` Is Cached Permanently Until Process Restart

**What:** `resolveAccount()` caches `this.defaultAccount` with no TTL and never invalidates it, not even when `invalidateCache()` is called.
**Files:** `src/services/appleMailManager.ts` lines 127, 175–179, 185–223

If the user changes their default Mail account during a session, the cached default will continue to be used. `invalidateCache()` only clears `this.cache.accounts` and `this.cache.mailboxNames`, not `this.defaultAccount`.

**Fix:** Either expire `defaultAccount` with a TTL similar to the account cache, or invalidate it in `invalidateCache()`.

---

### `fetchMailboxNames` Parses AppleScript List with Simple String Split

**What:** AppleScript returns a list as a comma-space-separated string when coerced to text. The `fetchMailboxNames` method splits on `", "`.
**Files:** `src/services/appleMailManager.ts` lines 1427–1445

If a mailbox name contains `", "` (unlikely but possible), the parse will break. A more robust approach would be to return a delimited format like `"|||ITEM|||"` (used elsewhere) or use a record/list format.

---

## Error Handling Gaps

### `getMessageById` Does Not Populate `recipients` or `hasAttachments`

**What:** `getMessageById` returns a `Message` object with `recipients: []` and `hasAttachments: false` always, regardless of actual data.
**Files:** `src/services/appleMailManager.ts` lines 420–433

The same is true for `parseMessageList` used by `listMessages` and `searchMessages` — `recipients`, `hasAttachments`, `isJunk`, `isDeleted` are all hardcoded to `[]`/`false`.

These fields are defined in the `Message` interface (`src/types.ts`) but are never populated. Consumers relying on them receive incorrect data.

---

### Batch Operations Report Generic Errors

**What:** When a batch operation fails on a specific message, the error field is always the generic string `"Failed to delete message"` / `"Failed to move message"` etc., never the underlying AppleScript error.
**Files:** `src/services/appleMailManager.ts` lines 992–1080

The underlying `deleteMessage`, `moveMessage`, etc. only return `boolean` and log the actual error via `console.error`. The `BatchOperationResult.error` field never carries the actual reason.

**Fix:** Change the single-item operation return type to `{ success: boolean; error?: string }` and propagate the error text into batch results.

---

### `getSyncStatus` Is a Proxy With No Real Sync Data

**What:** `getSyncStatus()` cannot actually detect sync activity — Mail.app does not expose sync state via AppleScript. The implementation simply checks whether Mail.app is running and has accounts configured, then sets `syncDetected: true` unconditionally.
**Files:** `src/services/appleMailManager.ts` lines 1868–1930

The returned `SyncStatus` fields `pendingUpload` and `secondsSinceLastChange` are always `0`. The function comment says "Mail.app doesn't expose sync status directly through AppleScript" — the tool should clearly document this limitation in its MCP description rather than returning misleading fields.

---

### `getMailStats` Has No Timeout Override

**What:** `getMailStats()` calls `listMailboxes()` once per account (which in turn runs `count of messages of mb` for every mailbox), then calls `getRecentlyReceivedStats()` which adds another AppleScript call. All of these use the default 30-second timeout each.

For a user with 3 accounts and 20 mailboxes each, this is 4 AppleScript executions with no coordinating timeout budget. The total wall-clock time could exceed 2 minutes for large mailboxes.
**Files:** `src/services/appleMailManager.ts` lines 1733–1775

---

## Performance Concerns

### Every Message Lookup Scans All Accounts and Mailboxes

**What:** `getMessageById`, `getMessageContent`, `replyToMessage`, `forwardMessage`, `markAsRead`, `markAsUnread`, `flagMessage`, `unflagMessage`, `deleteMessage`, `moveMessage`, `listAttachments`, `saveAttachment` all use `findMessageScript` or inline equivalents that iterate `repeat with acct in accounts → repeat with mb in mailboxes of acct`.
**Files:** `src/services/appleMailManager.ts` lines 845–865 (and all callers)

For a 3-account, 30-mailbox setup, each single-message operation makes 90 lookup attempts. There is no index or fast-path.

**Improvement path:** After any message is retrieved, cache its `(id → mailbox, account)` location with a short TTL. Subsequent operations can go directly to the known mailbox.

---

### `listMailboxes` Counts All Messages via AppleScript

**What:** The `listMailboxes` implementation runs `set mbCount to count of messages of mb` for every mailbox in the account. This forces Mail.app to load the message count for every mailbox synchronously.
**Files:** `src/services/appleMailManager.ts` lines 1192–1199

For accounts with many mailboxes or very large mailboxes (e.g., an Archive with 50k messages), this can be extremely slow. `getMailStats` calls `listMailboxes` for every account, compounding the problem.

---

### `searchMessages` Without Account Defaults to INBOX

**What:** When `searchMessages` is called without an account, it recursively calls itself per-account, each time targeting `mailbox || "INBOX"`. If the user does not specify a mailbox, each per-account sub-call searches only the INBOX, silently skipping other mailboxes.
**Files:** `src/services/appleMailManager.ts` lines 302–312, 315

This is a behavioral inconsistency: searching with `account=undefined, mailbox=undefined` searches all-account INBOXes, not all mailboxes of all accounts, which is what users would expect from "search all accounts."

---

## Dependency Risks

### `@modelcontextprotocol/sdk` Is Severely Outdated

**Current:** `1.4.1` | **Latest:** `1.29.0`
**File:** `package.json`

The MCP SDK has released 25 minor versions since the pinned version. MCP is an actively evolving protocol and SDK updates often include protocol breaking changes, new transport features, and security patches. Being 25 versions behind creates a significant update risk — the jump from 1.4.1 to 1.29.0 may require non-trivial migration work the longer it is deferred.

**Risk level:** High. Protocol compatibility with newer Claude clients may degrade over time.

---

### `vitest` and `@vitest/coverage-v8` Are Two Major Versions Behind

**Current:** `2.1.9` | **Latest:** `4.1.7`
**File:** `package.json`

Two major version gaps may introduce breaking API changes during upgrade. Test infrastructure becoming stale makes it harder to adopt new testing patterns.

---

### `zod` Is One Major Version Behind

**Current:** `3.25.76` | **Latest:** `4.4.3`
**File:** `package.json`

Zod v4 introduces breaking changes to the API. The current version is functional but will require migration effort to adopt v4's performance improvements and new features. Staying on v3 long-term is viable, but should be a deliberate decision.

---

### `@types/node` Pinned to v20 Range, Volta Node Is 22

**Current:** `@types/node: ^20.0.0` | **Volta Node:** `22.13.1`
**File:** `package.json`

The TypeScript type definitions for Node.js are pinned to the v20 range while the actual runtime is Node 22. Some v22 APIs may be untyped or incorrectly typed. This is low severity currently but should be updated to `^22.0.0`.

---

## Missing Features / Gaps

### No Email Search in Non-INBOX Mailboxes by Default

The `search-messages` tool defaults to searching only the `INBOX` (via `mailbox || "INBOX"` in `appleMailManager.ts` line 315). There is no "search all mailboxes" mode without specifying each mailbox explicitly. Full-text cross-mailbox search is a fundamental email feature.

### No Message Pagination in `search-messages`

`search-messages` accepts `limit` but has no `offset` parameter. Combined with Mail.app's lack of an indexed search API, there is no way to page through large result sets. `list-messages` has `offset`, but `search-messages` does not.

### `get-message` Does Not Return Sender Name, Recipients, or Attachment List

The `get-message` tool returns subject and body only. The `Message` type has `senderName`, `recipients`, `ccRecipients`, and `hasAttachments` fields, but none are populated. A complete message view would include all headers.

### No HTML Email Sending

`sendEmail` and `createDraft` accept a `body` string and an `isHtml?: boolean` parameter on the `SendEmailParams` type, but `isHtml` is not present in the MCP tool schema (`src/index.ts` lines 185–209) and the AppleScript implementation does not use it. Plain text is the only supported outbound format.

### No Attachment Download by Index

`save-attachment` requires matching by filename. If a message has two attachments with the same name, only the first match is saved. There is no index-based selection.

### No Persistent Configuration

There is no way to configure server-level defaults (default account, default mailbox, template storage path) without modifying source code. Configuration should be loadable from a file at startup.

---

## Maintenance Concerns

### `appleMailManager.ts` Is a 1,931-Line God Class

All Apple Mail operations, caching, template management, contacts, diagnostics, and statistics live in a single class.
**File:** `src/services/appleMailManager.ts`

This makes it difficult to test individual concerns in isolation, adds cognitive load when adding new features, and means any change risks unexpected interactions. There are no tests for this class at all (the only test file covers `applescript.ts`).

### Zero Test Coverage for `appleMailManager.ts` and `index.ts`

**Files:** `src/services/appleMailManager.ts`, `src/index.ts`
**Coverage config:** `vitest.config.ts` line 24: `"src/services/*.ts"` is excluded from coverage thresholds entirely.

The only tested file is `src/utils/applescript.ts`. The entire business logic layer (message operations, mailbox management, email composition, contacts) has no automated tests. The note in the config says "requires Mail.app integration, not unit testable," but the core parsing logic (`parseMessageList`, `parseAppleScriptDate`, `parseErrorMessage`, AppleScript builders) is pure TypeScript and fully unit-testable without Mail.app.

### AppleScript Output Parsing Relies on Fragile String Delimiters

All data is serialized from AppleScript to TypeScript via string concatenation with `"|||"` and `"|||ITEM|||"` delimiters. If any email subject, sender name, or mailbox name contains `|||`, the parsing will produce incorrect field splits.

**Files:** `src/services/appleMailManager.ts` throughout (lines 352–354, 395–399, 449–454, 524–527, 1100–1102, 1196–1199, etc.)

No escaping or quoting of the `|||` sentinel is applied to user-controlled values before they are concatenated. This is a latent data correctness bug.

**Example vulnerable path:** A message subject containing `"Hello |||ITEM||| World"` would split the output incorrectly when parsed by `result.output.split("|||ITEM|||")`.

### `SECURITY.md` References Version `0.x.x` but Package Is `1.1.1`

**File:** `SECURITY.md` line 7

The supported versions table shows `0.x.x` as supported, which is stale since the package is now at v1.1.1. Minor documentation debt, but reflects inconsistent maintenance.

---

## Priority Recommendations

**P0 — Correctness / Data Safety:**
1. Fix the silent parameter dropping for `from`, `isRead`, `isFlagged` in `search-messages` and `unreadOnly` in `list-messages` — these are documented features that silently do nothing.
2. Fix `renameMailbox` non-atomicity — partial failure leaves mail data in inconsistent state.
3. Fix the `|||` delimiter collision — messages with `|||` in subject/sender will produce corrupt parse results.

**P1 — Security:**
4. Add numeric-only validation on message ID inputs to prevent AppleScript injection.
5. Add path validation on `savePath` in `save-attachment` to prevent path traversal.
6. Add email format validation (`z.string().email()`) on recipient fields.

**P2 — Dependency Health:**
7. Update `@modelcontextprotocol/sdk` from `1.4.1` to latest — 25 minor versions of drift is a protocol compatibility risk.
8. Update `vitest` to a current major version.

**P3 — Performance:**
9. Add per-message ID location cache to avoid scanning all accounts/mailboxes on every operation.
10. Investigate whether `listMailboxes` can skip `count of messages` (which is slow) when a simple folder list is all that's needed.

**P4 — Test Coverage:**
11. Add unit tests for `parseMessageList`, `parseAppleScriptDate`, `escapeForAppleScript`, and the AppleScript builder functions — these are pure TypeScript with no Mail.app dependency.
12. Persist email templates to disk.

---

*Concerns audit: 2026-05-20*
