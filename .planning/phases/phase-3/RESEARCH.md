# Phase 3: New Productivity Tools — Research

**Researched:** 2026-05-20
**Domain:** Apple Mail AppleScript — thread traversal, archive/junk/VIP operations, stats cleanup
**Confidence:** HIGH (most findings verified by direct AppleScript execution against live Mail.app)

---

## Summary

Phase 3 adds six capabilities to the MCP server: thread retrieval, single-message archive, junk/not-junk control, VIP message listing, batch archive, and a cleaned-up get-mail-stats. All six are achievable through the existing AppleScript execution layer with no new npm dependencies.

The most important discovery is that Apple Mail's AppleScript dictionary has **no native thread/conversation object**. Thread grouping must be implemented manually using subject-line matching across mailboxes. The `message id` property (the RFC 2822 Message-ID header) is searchable via `whose message id is`, and the `all headers` string property exposes `In-Reply-To:` for more precise chain traversal — but the subject-match approach is simpler and sufficient for an ordered list UI.

Junk mail status is a read/write boolean property (`junk mail status`) already present in the codebase. The `archive-message` operation reduces to `moveMessage(id, "Archive", account)`, which the existing `MAILBOX_ALIASES` already handles. VIP is not exposed as a mailbox or message property in AppleScript — the recommended implementation uses a junk-style filter on the sender address against an in-memory or config-file VIP list.

The `get-mail-stats` `syncDetected` field is structurally misleading: the current code sets it to `true` whenever Mail.app is running with accounts, not when actual sync activity is detected. The fix is to remove the field (it cannot be truthfully populated) and simplify `get-sync-status` to report only what is observable: whether Mail.app is running and how many accounts/mailboxes are loaded.

**Primary recommendation:** Implement tools in this order: (1) junk/not-junk (simplest — one property), (2) archive-message (reuse moveMessage), (3) batch-archive (reuse batchMoveMessages), (4) get-mail-stats cleanup (remove misleading fields), (5) get-thread (subject-match approach), (6) get-vip-messages (sender-filter approach with documented limitation).

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| get-thread | API / Backend | — | Subject+header matching happens in AppleScript / TS layer; no UI needed |
| archive-message | API / Backend | — | Pure mailbox move; Archive mailbox resolved by existing resolveMailbox() |
| move-to-junk / mark-as-not-junk | API / Backend | — | Property set on message object; same pattern as read/flag status |
| get-vip-messages | API / Backend | — | Sender filter in TS; no AppleScript VIP API exists |
| batch-archive | API / Backend | — | Loop over existing archive-message; same pattern as batchMoveMessages |
| get-mail-stats improvements | API / Backend | — | Remove computed fields; simplify getSyncStatus output |

---

## Per-Tool Research

### Tool 1: `move-to-junk` / `mark-as-not-junk`

**AppleScript approach:** [VERIFIED: live AppleScript execution]
- `junk mail status` is a read/write boolean property on `message` objects.
- Already used in `getMessageById` for reading: `set msgJunk to junk mail status of msg as string`
- Setting it: `set junk mail status of msg to true` / `set junk mail status of msg to false`
- The `findMessageScript` helper already does the cross-account/mailbox search and executes an arbitrary operation on the located message. Both tools reduce to a one-line operation string passed to `findMessageScript`.

**AppleScript snippet:**
```applescript
-- move-to-junk
set junk mail status of msg to true

-- mark-as-not-junk
set junk mail status of msg to false
```

**Risks / caveats:**
- Setting `junk mail status` to `true` does NOT automatically move the message to the Junk mailbox — it only sets the flag. If the caller wants the message to also appear in Junk, a `move` to the Junk mailbox is needed. However, `move-to-junk` semantics in the roadmap say "explicit spam control" — setting the flag is the correct action; moving is a side effect that differs by account type and user preference. **Decision needed at plan time:** flag-only, or flag+move?
- `mark-as-not-junk` (setting to `false`) does not automatically move the message out of Junk folder. The caller may need to also call `move-message` to INBOX.
- Verified that `junk mail status` reads as `true` on messages in the Junk folder.
- Verified `whose junk mail status is true` works as a filter predicate.

**Implementation pattern:** Mirror `markAsRead` / `markAsUnread` exactly.

**Reuse:** `findMessageScript(id, "set junk mail status of msg to true")` — zero new plumbing.

---

### Tool 2: `archive-message`

**AppleScript approach:** [VERIFIED: live AppleScript execution]
- All three accounts on the test machine expose an `Archive` mailbox directly:
  - iCloud: `mailbox "Archive" of account "iCloud"` — 59 messages (spot check)
  - Google: `mailbox "Archive" of account "Google"` — 10,793 messages (Google's "All Mail" is a separate view; "Archive" is the archive action target)
  - mhenze@michael-henze.plus: `mailbox "Archive" of account "mhenze@michael-henze.plus"` — confirmed present
- The existing `MAILBOX_ALIASES` map already has `archive: ["Archive", "ARCHIVE", "archive", "All Mail"]`.
- `moveMessage(id, "Archive")` resolves the mailbox through `resolveMailbox()` using those aliases — it will find `Archive` on all three account types tested.

**Gmail complication:** [CITED: msgfiler.wordpress.com/2024/02/12]
- For Gmail/Google accounts, moving via `move msg to mailbox "Archive" of account "Google"` may leave the "Inbox" label on the message (Gmail IMAP quirk — labels vs folders). The message will appear in both INBOX and Archive in Mail.app. This is a known IMAP-level limitation with Gmail's non-standard implementation.
- **Mitigation:** Document this clearly in tool description. Moving to "All Mail" is the Gmail-native archive equivalent, but `Archive` also works from Mail.app's perspective. The user sees the expected result in the Archive view.

**Implementation pattern:**
```typescript
archiveMessage(id: string, account?: string): boolean {
  return this.moveMessage(id, "Archive", account);
}
```

No new AppleScript needed. The method is a one-line wrapper around `moveMessage`.

**Risks:** If an account has no `Archive` mailbox and none of the aliases match, the move will fail with "mailbox not found" from AppleScript. This is handled by the existing `moveMessage` error path (returns `false`). The MCP tool should return a descriptive error message in that case.

---

### Tool 3: `get-thread`

**AppleScript approach:** [VERIFIED: live AppleScript execution + research]

Apple Mail's AppleScript dictionary **does not have a thread or conversation object**. [CITED: Apple Community discussions.apple.com/thread/7289067]

Two approaches are viable:

**Approach A — Subject matching (recommended):**
1. Find the seed message by ID to get its subject.
2. Strip `Re:`, `RE:`, `Fwd:`, `FW:` prefixes to get the base subject.
3. Search all mailboxes (or optionally just the seed message's account) for messages `whose subject contains baseSubject`.
4. Sort results by `date received` in TypeScript (AppleScript doesn't have a sort primitive).
5. Return as an ordered list with per-message metadata.

Verified working:
- `subject contains` predicate works in `whose` clause
- `message id` and `date received` are accessible on each result
- Three-message thread correctly identified by subject match across INBOX + Sent Messages

**Approach B — In-Reply-To chain traversal (more precise, slower):**
1. Get seed message's `message id` (the RFC 2822 Message-ID header).
2. Extract `In-Reply-To:` from `all headers` of each candidate message.
3. Walk the chain upward and downward.

Verified working:
- `message id` property returns the RFC 2822 Message-ID (e.g., `413F59BB-...@mac.com`) [VERIFIED: live execution]
- `all headers` returns full headers as a text string [VERIFIED: live execution]
- `In-Reply-To:` is present in Sent Messages replies [VERIFIED: live execution]
- `whose message id is "<id>"` lookup works [VERIFIED: live execution]
- Performance: the `whose message id is` search on each mailbox is `O(mailboxes × messages)` per hop — too slow for multi-hop traversal

**Recommendation:** Use Approach A (subject match). It is fast (single `whose` query per mailbox), handles non-reply "same topic" threads (e.g., forwarded continuations), and matches how users think about threads.

**AppleScript for subject-based get-thread:**
```applescript
tell application "Mail"
  set fieldSep to character id 57345
  set recSep to character id 57346
  -- (1) Find seed message to get its subject
  -- (same findMessageScript loop as other tools)
  -- (2) Strip Re:/RE:/Fwd:/FW: prefix in TypeScript before calling second script
  -- (3) Search all mailboxes in all accounts
  set outputText to ""
  set msgCount to 0
  repeat with acct in accounts
    repeat with mb in mailboxes of acct
      try
        set matches to (messages of mb whose subject contains "<baseSubject>")
        repeat with msg in matches
          set msgId to id of msg as string
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDate to date received of msg as string
          set msgRead to read status of msg as string
          set mbName to name of mb
          set acctName to name of acct
          if msgCount > 0 then set outputText to outputText & recSep
          set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & mbName & fieldSep & acctName
          set msgCount to msgCount + 1
        end repeat
      end try
    end repeat
  end repeat
  return outputText
end tell
```

**Performance:** Iterates all mailboxes in all accounts. For large mail stores this is slow (60-second timeout should be sufficient; same pattern as existing `allMailboxes` search mode).

**Risks:**
- False positives: a very generic subject (e.g., "Hello") will match unrelated messages. The tool should document this.
- Subject normalization: need to strip `Re: `, `RE: `, `Fwd: `, `FW: `, `AW: ` (German "Antwort auf"), `WG: ` (German "Weitergeleitet"). [ASSUMED: may be other locale prefixes not tested]
- Scope option: allow `account` parameter to limit search to one account for speed.

**TypeScript sort:** After collecting all thread messages, sort by `dateReceived` ascending in TypeScript — no AppleScript sort needed.

---

### Tool 4: `get-vip-messages`

**AppleScript approach:** [VERIFIED: live AppleScript execution]

Apple Mail's AppleScript dictionary **does not expose VIP status as a message property or mailbox**. [CITED: Apple Community discussions.apple.com/thread/7692677]

Testing confirmed: no `VIP` mailbox exists in any account's mailbox list. The Mail.app VIP feature is implemented at the UI level (a smart view that filters by sender address) and is not reflected in the AppleScript object model.

**Feasible approaches:**

**Approach A — Read VIP senders from plist file (recommended):**
Mail.app stores VIP senders in `~/Library/Mail/V10/VIP.plist` (or similar version-dependent path). [ASSUMED: exact path varies by macOS version — needs runtime discovery]

The plist contains email addresses of VIP senders. Read this file, then filter INBOX messages using `sender contains` for each VIP address.

```typescript
// Read VIP plist using Node.js fs (or exec `plutil -convert json`)
// Then: searchMessages with from filter for each VIP address
```

**Approach B — User-provided VIP list via config:**
Store a VIP list in `~/.config/apple-mail-mcp/config.json` (planned for Phase 5). Not available in Phase 3.

**Approach C — Scan for Mail.app's VIP plist:**
```bash
find ~/Library/Mail -name "VIP.plist" 2>/dev/null
```

**Recommendation:** Approach A using the VIP plist. Read it with Node.js `fs.readFileSync` + `plutil -convert json -o - <path>` shell command, extract email addresses, then call `searchMessages` with each VIP address as a `from` filter. Return merged, deduplicated results sorted by date.

**Risks:**
- Plist path may differ across macOS versions. [ASSUMED: needs discovery at runtime]
- If plist is absent (no VIPs configured), return empty list with informative message.
- `plutil` is available on all macOS versions (built-in). [VERIFIED: standard macOS tool]
- The VIP plist parsing adds a small complexity burden; consider noting in the tool description that results depend on VIPs configured in Mail.app.

**Fallback:** If plist is not found or cannot be parsed, return an error: "No VIP senders found. Configure VIP senders in Mail.app first."

---

### Tool 5: `batch-archive`

**AppleScript approach:** [VERIFIED: pattern analysis]

Identical pattern to `batchMoveMessages`. Implementation:

```typescript
batchArchiveMessages(ids: string[], account?: string): BatchOperationResult[] {
  return this.batchMoveMessages(ids, "Archive", account);
}
```

This is a one-liner in `appleMailManager.ts`. The MCP tool registration in `index.ts` follows the same pattern as `batch-delete-messages`, `batch-move-messages`, etc.

**Risks:** Same Gmail Archive label duplication risk as `archive-message`. No new risks.

---

### Tool 6: `get-mail-stats` improvements

**Current behavior (from code analysis):** [VERIFIED: code reading]

The `getSyncStatus()` method:
- Sets `syncDetected: isRunning && accountCount > 0` — this is always `true` when Mail.app runs with accounts.
- Sets `pendingUpload: 0` (hardcoded, never a real value).
- Sets `secondsSinceLastChange: 0` (hardcoded).

The `SyncStatus` interface in `types.ts` has `syncDetected`, `pendingUpload`, `recentActivity`, `secondsSinceLastChange` fields that give a false impression of observability.

**Root cause:** Apple Mail's AppleScript dictionary does not expose any sync state, IMAP connection status, or pending operation count. These fields were placeholders that became misleading.

**Fix strategy:**
1. In `getSyncStatus()`: remove `syncDetected`, `pendingUpload`, `secondsSinceLastChange`. Return only `{ running: boolean, accountCount: number, error?: string }` or simplify to a status string.
2. In `types.ts`: deprecate or simplify `SyncStatus` interface — remove fields that cannot be truthfully populated.
3. In `index.ts` `get-sync-status` tool: update the response text to only report what is real (Mail.app running? How many accounts loaded?).
4. `getMailStats()` itself is fine — it accurately counts messages and unread. The `recentlyReceived` sub-stat is real (AppleScript date filter query). No changes needed there.

**What IS observable via AppleScript:**
- Whether Mail.app is running (System Events process list)
- Account count and mailbox count
- Message counts (already in getMailStats)
- Recently received counts (already in getRecentlyReceivedStats)

**What is NOT observable:**
- Whether IMAP sync is in progress
- Pending upload count
- Last sync timestamp

---

## Reusable Patterns from Existing Code

| Pattern | Location | Reuse in Phase 3 |
|---------|----------|-----------------|
| `findMessageScript(id, operation)` | `appleMailManager.ts:1106` | `move-to-junk`, `mark-as-not-junk` — one-line operation strings |
| `moveMessage(id, mailbox, account)` | `appleMailManager.ts:1209` | `archive-message` calls this directly |
| `batchMoveMessages(ids, mailbox, account)` | `appleMailManager.ts:1283` | `batch-archive` calls this directly |
| `searchMessages` with `from` filter | `appleMailManager.ts:314` | `get-vip-messages` calls this per VIP sender |
| `parseMessageListAllMailboxes` | `appleMailManager.ts:754` | `get-thread` returns same 7-field format |
| `buildAppLevelScript` + `FIELD_SEP`/`RECORD_SEP` | `appleMailManager.ts:89` | All new AppleScript outputs use same delimiters |
| `escapeForAppleScript` | `appleMailManager.ts:52` | Subject parameter in `get-thread` |
| `MAILBOX_ALIASES` | `appleMailManager.ts:101` | Already has `archive` alias — no change needed |
| `withErrorHandling` wrapper | `index.ts:79` | All new MCP tools use this |
| Numeric ID validation regex | `index.ts:173` | All new message-ID tools use `z.string().regex(/^\d+$/)` |
| `BatchOperationResult[]` return type | `types.ts:399` | `batch-archive` response shape |

---

## Architecture Patterns

### Recommended Project Structure Changes

No new files needed. All changes are additions to:
- `src/services/appleMailManager.ts` — new methods
- `src/index.ts` — new tool registrations
- `src/types.ts` — simplified `SyncStatus`, possibly new `ThreadMessage` type

### Pattern: New Simple Property Tool

```typescript
// In appleMailManager.ts
moveToJunk(id: string): boolean {
  const script = this.findMessageScript(id, "set junk mail status of msg to true");
  const result = executeAppleScript(script, { timeoutMs: 60000 });
  return result.success && !result.output.startsWith("error:");
}

markAsNotJunk(id: string): boolean {
  const script = this.findMessageScript(id, "set junk mail status of msg to false");
  const result = executeAppleScript(script, { timeoutMs: 60000 });
  return result.success && !result.output.startsWith("error:");
}
```

```typescript
// In index.ts
server.tool(
  "move-to-junk",
  { id: z.string().regex(/^\d+$/, "Message ID must be numeric") },
  withErrorHandling(({ id }) => {
    const success = mailManager.moveToJunk(id);
    if (!success) return errorResponse(`Failed to mark message "${id}" as junk`);
    return successResponse("Message marked as junk");
  }, "Error marking message as junk")
);
```

### Pattern: Thread Retrieval

```typescript
// In appleMailManager.ts
getThread(id: string, account?: string): Message[] {
  // Step 1: get seed message subject
  const seed = this.getMessageById(id);
  if (!seed) return [];
  
  // Step 2: normalize subject (strip reply/forward prefixes)
  const baseSubject = normalizeSubject(seed.subject);
  
  // Step 3: search all mailboxes for subject match
  const script = buildAppLevelScript(`
    set fieldSep to character id 57345
    set recSep to character id 57346
    set outputText to ""
    set msgCount to 0
    set safeSubj to "${escapeForAppleScript(baseSubject)}"
    repeat with acct in accounts
      repeat with mb in mailboxes of acct
        try
          set matches to (messages of mb whose subject contains safeSubj)
          repeat with msg in matches
            -- collect 7-field records
            ...
          end repeat
        end try
      end repeat
    end repeat
    return outputText
  `);
  
  // Step 4: parse + sort by dateReceived ascending
  const messages = this.parseMessageListAllMailboxes(result.output, "");
  return messages.sort((a, b) => 
    a.dateReceived.getTime() - b.dateReceived.getTime()
  );
}

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(Re|RE|Fwd|FW|AW|WG|Aw|Wg):\s+/i, "")
    .trim();
}
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| VIP plist parsing | Custom XML parser | `plutil -convert json -o - <path>` + `JSON.parse` |
| Thread ordering | Custom sort | Standard `Array.sort` on `dateReceived` timestamps |
| Archive mailbox discovery | Custom mailbox scanner | Existing `resolveMailbox()` + `MAILBOX_ALIASES` |
| Junk status toggle | Custom AppleScript property lookup | `findMessageScript` + `junk mail status` property |

---

## Common Pitfalls

### Pitfall 1: `junk mail status = true` does not move the message

**What goes wrong:** Setting `junk mail status of msg to true` only flags the message. It does not move it to the Junk folder. Users expecting `move-to-junk` to cause the message to disappear from INBOX will be confused.

**Why it happens:** Apple Mail's AppleScript property is a flag, not an action.

**How to avoid:** For `move-to-junk`, set the flag AND move the message to the Junk mailbox. Use a two-step operation: `set junk mail status of msg to true`, then `move msg to mailbox "<junk>" of account <acct>`. The Junk mailbox name varies by account type (iCloud: "Junk", Google: "Spam", mhenze account: "Spam").

**Resolution:** `move-to-junk` should: (1) set `junk mail status to true`, (2) move to the account's junk mailbox using `MAILBOX_ALIASES` for `junk` key (already has `["Junk", "Junk Email", "Spam", "JUNK", "junk"]`).

### Pitfall 2: AppleScript `subject contains` is a substring match, not a whole-subject match

**What goes wrong:** Searching for subject "AI" matches "Re: AI" and "Contains AI Features" and "Complain AI regulation".

**Why it happens:** `contains` is substring matching.

**How to avoid:** Use `subject contains baseSubject` where `baseSubject` is the normalized subject (e.g., `"Besichtigungen 14.5.2026 14:00 u. 15:00h"` — specific enough). Document that very short subjects may return false positives. Minimum subject length guard in TypeScript (e.g., require at least 10 characters after normalization).

### Pitfall 3: Gmail Archive leaves inbox label

**What goes wrong:** Moving to `mailbox "Archive" of account "Google"` via AppleScript does not remove Gmail's "Inbox" label. The message appears in both Archive and Inbox in Mail.app.

**Why it happens:** Gmail IMAP treats "mailboxes" as labels. Moving adds a label rather than removing the original. [CITED: msgfiler.wordpress.com/2024/02/12]

**How to avoid:** Document the limitation in the tool description. The only reliable fix is to trigger Mail.app's native Archive action via Accessibility API (System Events menu simulation) — this is significantly more complex and fragile. Recommend accepting the limitation for Phase 3.

### Pitfall 4: `mark-as-not-junk` leaves message in Junk folder

**What goes wrong:** Setting `junk mail status to false` removes the junk flag but does not move the message to INBOX.

**How to avoid:** For `mark-as-not-junk`, consider also moving the message to INBOX. Alternatively, leave the move as the caller's responsibility and document this clearly. The simpler path (flag-only) is sufficient for Phase 3.

### Pitfall 5: VIP plist path differs across macOS versions

**What goes wrong:** `~/Library/Mail/V10/VIP.plist` exists on macOS Ventura/Sonoma but the version number (V10) may change on future macOS releases.

**How to avoid:** Use a runtime `find ~/Library/Mail -name "VIP.plist" -maxdepth 3` to discover the path dynamically. Cache the found path. Return a graceful "no VIPs configured" message if not found.

### Pitfall 6: AppleScript `whose` clause on large mailboxes is slow

**What goes wrong:** `get-thread` iterates all mailboxes in all accounts with `whose subject contains`. On large accounts (9,000+ messages in INBOX), this takes several seconds per mailbox.

**How to avoid:** Add optional `account` parameter to `get-thread` to limit search scope. Default to current account only. Set 60-second timeout (same as existing `allMailboxes` search mode).

---

## Code Examples

### Junk mail status — verified working [VERIFIED: live AppleScript]

```applescript
-- Reading junk mail status (already in getMessageById)
set msgJunk to junk mail status of msg as string  -- returns "true" or "false"

-- Setting junk (new)
set junk mail status of msg to true

-- Setting not-junk (new)
set junk mail status of msg to false

-- Filtering by junk status (also works)
set junkMessages to (messages of mb whose junk mail status is true)
```

### Archive mailbox access — verified working [VERIFIED: live AppleScript]

```applescript
-- All three account types tested have accessible "Archive" mailbox
set archiveMb to mailbox "Archive" of account "iCloud"       -- works
set archiveMb to mailbox "Archive" of account "Google"       -- works
set archiveMb to mailbox "Archive" of account "mhenze@..."   -- works
-- MAILBOX_ALIASES["archive"] already includes "Archive" — resolveMailbox handles this
```

### Thread subject matching — verified working [VERIFIED: live AppleScript]

```applescript
-- Subject-based thread search
set matches to (messages of mb whose subject contains "Besichtigungen 14.5.2026")
-- Returns messages across both INBOX and Sent Messages with matching subject
```

### message id property — verified working [VERIFIED: live AppleScript]

```applescript
-- RFC 2822 Message-ID (distinct from Mail.app's internal numeric "id")
set mid to message id of msg  -- e.g., "413F59BB-CC8A-4BAC-8CE1-1C486DB4EF5C@mac.com"

-- Search by message id
set found to (messages of mb whose message id is "some-id@domain.com")
```

### In-Reply-To extraction from all headers — verified working [VERIFIED: live AppleScript]

```applescript
-- all headers returns complete header block as text
set hdrs to all headers of msg

-- In-Reply-To appears in Sent replies (verified)
-- Extract value by substring search in TypeScript or AppleScript
```

---

## State of the Art

| Old Approach | Current Approach | Notes |
|--------------|-----------------|-------|
| `syncDetected: boolean` (always true) | Remove field — report only `running: boolean` | Apple Mail has no sync API |
| No thread tool | `get-thread` via subject match | No native thread API; subject match is standard workaround |
| Manual junk via move-message | `move-to-junk` with `junk mail status` flag + move | One-click workflow |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | German `AW:` and `WG:` are the main non-English reply/forward prefixes | get-thread subject normalization | Thread matching misses locale prefixes; easy to add more patterns |
| A2 | VIP plist is at `~/Library/Mail/V*/VIP.plist` (version-agnostic glob) | get-vip-messages | Tool fails to read VIPs; fallback graceful empty response |
| A3 | `mark-as-not-junk` (flag only, no move) is acceptable without auto-move to INBOX | move-to-junk / mark-as-not-junk | Slightly confusing UX; document in tool description |
| A4 | 10-character minimum base subject guard is sufficient for false-positive protection | get-thread | Very short subjects still match unrelated messages |

---

## Implementation Order Recommendation

1. **`move-to-junk` / `mark-as-not-junk`** — Zero new AppleScript patterns. Two new TS methods, two MCP tools. ~30 min.
2. **`archive-message`** — One-line wrapper. ~15 min.
3. **`batch-archive`** — One-line wrapper. ~15 min.
4. **`get-mail-stats` / `get-sync-status` cleanup** — Remove misleading fields from `getSyncStatus`. Update types, implementation, index.ts formatting. ~30 min.
5. **`get-thread`** — New AppleScript pattern (subject-match all-mailboxes loop). New TS method + subject normalizer. ~60 min.
6. **`get-vip-messages`** — VIP plist discovery + `plutil` JSON conversion + per-sender search fan-out. ~60 min.

Total estimated: ~3.5 hours of implementation.

---

## Open Questions

1. **`move-to-junk`: flag-only or flag+move?**
   - Flag-only: simpler, mirrors `mark-as-junk` semantics in email clients
   - Flag+move: matches user expectation of message disappearing from INBOX
   - Recommendation: flag+move (more useful), but requires knowing the Junk folder name per account. `MAILBOX_ALIASES["junk"]` already has the right aliases.

2. **`get-thread` scope: one account or all accounts?**
   - All accounts is more complete but slow on large stores
   - Recommendation: default to seed message's account only; add optional `allAccounts` boolean parameter

3. **`mark-as-not-junk`: move to INBOX or flag-only?**
   - Flag-only is simple but message stays in Junk folder
   - Recommendation: flag-only with documentation; users can call `move-message` separately

4. **`get-vip-messages` scope: INBOX only or all mailboxes?**
   - All mailboxes is comprehensive but slow
   - Recommendation: INBOX only by default; add `allMailboxes` option (mirrors existing `search-messages` pattern)

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.0.0 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Capability | Behavior | Test Type | Automated Command |
|------------|----------|-----------|-------------------|
| move-to-junk | Sets `junk mail status` via findMessageScript | unit (mock executeAppleScript) | `npx vitest run src/__tests__/phase3.test.ts` |
| mark-as-not-junk | Clears `junk mail status` | unit | same |
| archive-message | Delegates to moveMessage with "Archive" | unit (spy on moveMessage) | same |
| batch-archive | Delegates to batchMoveMessages | unit | same |
| get-thread | normalizeSubject strips Re:/FW:/AW: | unit (pure function) | same |
| get-mail-stats | syncDetected removed from output | unit (check response text) | same |
| get-vip-messages | Empty result when VIP plist missing | unit (mock fs) | same |

### Sampling Rate
- **Per task commit:** `npx vitest run`
- **Phase gate:** Full suite green (currently 70 tests; Phase 3 should add ~8-12 tests)

### Wave 0 Gaps
- [ ] `src/__tests__/phase3.test.ts` — new file for Phase 3 unit tests
- [ ] `normalizeSubject` should be a pure exported utility function to enable unit testing without mocking AppleScript

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Mail.app | All tools | ✓ | macOS | — |
| plutil | get-vip-messages VIP plist | ✓ | macOS built-in | Skip VIP plist, return error |
| osascript | All tools | ✓ | macOS built-in | — |

No new npm packages required for this phase.

---

## Package Legitimacy Audit

No new packages are installed in Phase 3. All implementation uses existing project dependencies (zod, @modelcontextprotocol/sdk) and Node.js builtins (child_process for plutil, fs for plist reading).

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | All new IDs validated with existing `z.string().regex(/^\d+$/)` |
| V4 Access Control | no | No new auth paths |
| V6 Cryptography | no | No crypto operations |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| AppleScript injection via subject string in get-thread | Tampering | `escapeForAppleScript()` applied to normalized subject before embedding in script |
| Path traversal in VIP plist path | Tampering | Restrict plist discovery to `~/Library/Mail` subtree only; do not accept user-supplied path |

---

## Sources

### Primary (HIGH confidence — verified by live execution)
- AppleScript executed directly against Mail.app on this machine
  - `junk mail status` property: read/write boolean, confirmed on iCloud/Google accounts
  - `Archive` mailbox: present and accessible in all 3 test accounts
  - `message id` property: returns RFC 2822 Message-ID, searchable via `whose`
  - `all headers` property: returns full header string including `In-Reply-To:`
  - No VIP mailbox or VIP property in AppleScript object model (negative confirmed)
  - `syncDetected` misleading: confirmed the current code always returns true when Mail runs

### Secondary (MEDIUM confidence — official or well-established sources)
- [Apple Community: Mail AppleScript doesn't handle threads](https://discussions.apple.com/thread/7289067) — no native thread API
- [MacRumors: reclassify emails as Not Junk](https://forums.macrumors.com/threads/how-to-reclassify-multiple-emails-as-not-junk-in-macos-mail.2020134/) — `junk mail status` syntax confirmed
- [MsgFiler Deep Dive](https://msgfiler.wordpress.com/2024/02/12/a-deep-dive-into-filing-mail-messages-using-applescript/) — Gmail Archive label duplication issue, `set mailbox of msg` pattern
- [Apple Community: VIP mailbox](https://discussions.apple.com/thread/7692677) — AppleScript cannot mark VIP

### Tertiary (LOW confidence — ASSUMED, needs runtime validation)
- VIP plist location `~/Library/Mail/V*/VIP.plist` — path is training knowledge, not verified
- German `AW:` / `WG:` reply prefix stripping — assumed from locale knowledge

---

## Metadata

**Confidence breakdown:**
- Junk mail operations: HIGH — property verified live
- Archive mailbox: HIGH — all 3 accounts confirmed live
- Thread retrieval approach: HIGH — subject match verified live; In-Reply-To extraction verified live
- VIP plist approach: MEDIUM — plist existence assumed, execution pattern for plutil is standard macOS
- get-mail-stats cleanup: HIGH — misleading fields confirmed by code reading

**Research date:** 2026-05-20
**Valid until:** 2026-08-20 (stable Apple Mail API; low churn)
