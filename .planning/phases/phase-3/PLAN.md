---
phase: phase-3
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/types.ts
  - src/services/appleMailManager.ts
  - src/index.ts
  - src/__tests__/phase3.test.ts
autonomous: true
requirements: [PHASE3-JUNK, PHASE3-ARCHIVE, PHASE3-BATCH-ARCHIVE, PHASE3-STATS, PHASE3-THREAD, PHASE3-VIP]

must_haves:
  truths:
    - "move-to-junk sets junk mail status flag AND moves message to Junk mailbox"
    - "mark-as-not-junk clears junk mail status flag (flag-only; move is caller responsibility)"
    - "archive-message moves any message to the account's Archive mailbox"
    - "batch-archive archives multiple messages and returns per-message results"
    - "get-thread returns all thread messages ordered by dateReceived ascending, using subject-match approach"
    - "get-vip-messages returns messages from VIP senders read from ~/Library/Mail VIP.plist, or empty list with explanation"
    - "get-sync-status no longer reports syncDetected, pendingUpload, or secondsSinceLastChange"
    - "SyncStatus interface contains only: running, accountCount, error (no fake fields)"
  artifacts:
    - path: "src/types.ts"
      provides: "Updated SyncStatus (running, accountCount, error only) and new ThreadMessage type"
    - path: "src/services/appleMailManager.ts"
      provides: "moveToJunk, markAsNotJunk, archiveMessage, batchArchiveMessages, getThread, getVipMessages, updated getSyncStatus"
    - path: "src/index.ts"
      provides: "Tool registrations: move-to-junk, mark-as-not-junk, archive-message, batch-archive, get-thread, get-vip-messages; updated get-sync-status"
    - path: "src/__tests__/phase3.test.ts"
      provides: "Unit tests covering normalizeSubject, junk/archive delegates, VIP plist parsing, SyncStatus shape"
  key_links:
    - from: "src/index.ts move-to-junk"
      to: "appleMailManager.moveToJunk"
      via: "mailManager.moveToJunk(id)"
    - from: "appleMailManager.moveToJunk"
      to: "findMessageScript"
      via: "two-step AppleScript: set flag + move to junk mailbox"
    - from: "appleMailManager.archiveMessage"
      to: "appleMailManager.moveMessage"
      via: "this.moveMessage(id, 'Archive', account)"
    - from: "appleMailManager.getThread"
      to: "normalizeSubject (exported pure fn)"
      via: "normalizeSubject(seed.subject) before AppleScript embedding"
    - from: "appleMailManager.getVipMessages"
      to: "execSync('plutil -convert json -o - <path>')"
      via: "JSON.parse of plutil output; fallback to empty on error"
---

<objective>
Implement six new productivity tools for Phase 3: junk control, archive (single + batch), thread retrieval, VIP messages, and get-sync-status cleanup.

Purpose: Cover the most common email workflows not yet supported by the MCP server.
Output: Seven new/updated methods in appleMailManager.ts, seven updated tool registrations in index.ts, simplified SyncStatus type, and a unit test file.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/phase-2/SUMMARY.md
</context>

<interfaces>
<!-- Key contracts the executor needs. No codebase exploration required. -->

From src/types.ts (current SyncStatus — to be replaced):
```typescript
export interface SyncStatus {
  syncDetected: boolean;
  pendingUpload: number;
  recentActivity: boolean;
  secondsSinceLastChange: number;
  error?: string;
}
```

From src/types.ts (BatchOperationResult — reuse for batch-archive):
```typescript
export interface BatchOperationResult {
  id: string;
  success: boolean;
  error?: string;
}
```

From src/services/appleMailManager.ts (private helpers executor needs to know about):
```typescript
// Line 52 — escapes backslashes and double-quotes for AppleScript string embedding
function escapeForAppleScript(text: string): string

// Line 89 — wraps command in `tell application "Mail" ... end tell`
function buildAppLevelScript(command: string): string

// Line 101 — MAILBOX_ALIASES["junk"] = ["Junk", "Junk Email", "Spam", "JUNK", "junk"]
//             MAILBOX_ALIASES["archive"] = ["Archive", "ARCHIVE", "archive", "All Mail"]
const MAILBOX_ALIASES: Record<string, string[]>

// Line 116 — FIELD_SEP = U+E001, RECORD_SEP = U+E002
const FIELD_SEP: string
const RECORD_SEP: string

// Line 1106 — builds full-account-scan script; operation runs with `msg` in scope
private findMessageScript(id: string, operation: string): string

// Line 1209 — moves message to resolved mailbox; uses resolveAccount + resolveMailbox
moveMessage(id: string, mailbox: string, account?: string): boolean

// Line 1283 — iterates ids, calls moveMessage per id
batchMoveMessages(ids: string[], mailbox: string, account?: string): BatchOperationResult[]

// Line 754 — parses RECORD_SEP/FIELD_SEP output into Message[]
// Expects 7+ fields per record: id, subject, sender, dateReceived, isRead, isFlagged, mailbox
// Sets account from second arg, isJunk/isDeleted/hasAttachments to defaults
private parseMessageListAllMailboxes(output: string, account: string): Message[]

// Line 264 — resolves mailbox name through exact, case-insensitive, alias matching
private resolveMailbox(mailbox: string, account: string): string

// Line 206 — returns account name, using Mail.app default or first available
private resolveAccount(account?: string): string

// Line 494 (getMessageById) — returns Message | null for a numeric id
getMessageById(id: string): Message | null
```

From src/index.ts (response helpers and tool pattern):
```typescript
function successResponse(message: string): { content: [{ type: "text", text: string }] }
function errorResponse(message: string): { content: [...], isError: true }
function withErrorHandling<T>(handler: (p: T) => ReturnType<typeof successResponse>, errorPrefix: string)

// Numeric ID validation used on every message-ID tool:
z.string().regex(/^\d+$/, "Message ID must be numeric")

// batch tool ID array pattern:
z.array(z.string().regex(/^\d+$/, "Message ID must be numeric")).min(1, "At least one ID required")
```

From src/index.ts (get-sync-status handler, lines 1032–1051 — to be updated):
```typescript
server.tool("get-sync-status", {}, withErrorHandling(() => {
  const status = mailManager.getSyncStatus();
  // currently references status.syncDetected, status.recentActivity, status.error
  // will be updated to reference status.running, status.accountCount, status.error
}, "Error getting sync status"));
```
</interfaces>

<tasks>

<!-- =========================================================
     TASK 1: Update SyncStatus type + add ThreadMessage type
     Context cost: ~10%
     ========================================================= -->

<task type="auto" tdd="true">
  <name>Task 1: Update types — simplify SyncStatus, add ThreadMessage</name>
  <files>src/types.ts</files>
  <behavior>
    - SyncStatus interface has exactly three fields: running (boolean), accountCount (number), error (optional string)
    - SyncStatus has NO syncDetected, pendingUpload, recentActivity, or secondsSinceLastChange fields
    - New ThreadMessage interface exported with: id, subject, sender, dateReceived, isRead, mailbox, account
  </behavior>
  <action>
In src/types.ts, make two changes:

1. Replace the entire SyncStatus interface (lines 476–493) with:
```
/**
 * Status of Mail.app — whether it is running and how many accounts are loaded.
 * Note: Apple Mail's AppleScript API does not expose IMAP sync state, pending
 * upload counts, or last-sync timestamps. Only observable facts are reported.
 */
export interface SyncStatus {
  /** Whether Mail.app is currently running */
  running: boolean;

  /** Number of accounts loaded in Mail.app */
  accountCount: number;

  /** Error message if the status check failed */
  error?: string;
}
```

2. Add a new ThreadMessage interface after the Message interface (after line 75, before MessageContent):
```
/**
 * A message in an email thread, returned by get-thread.
 * Subset of Message with fields sufficient for thread display.
 */
export interface ThreadMessage {
  /** Unique identifier for the message */
  id: string;

  /** Subject line */
  subject: string;

  /** Sender email address */
  sender: string;

  /** Date received */
  dateReceived: Date;

  /** Whether the message has been read */
  isRead: boolean;

  /** Mailbox containing the message */
  mailbox: string;

  /** Account containing the message */
  account: string;
}
```

No other changes to types.ts.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit 2>&1 | head -20</automated>
  </verify>
  <done>SyncStatus has only { running, accountCount, error? }. ThreadMessage is exported. TypeScript compiles with no errors.</done>
</task>

<!-- =========================================================
     TASK 2: junk / archive / batch-archive service methods
     Context cost: ~20%
     ========================================================= -->

<task type="auto" tdd="true">
  <name>Task 2: Service methods — moveToJunk, markAsNotJunk, archiveMessage, batchArchiveMessages</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - moveToJunk(id): sets junk mail status flag to true AND moves message to Junk mailbox; returns boolean
    - markAsNotJunk(id): sets junk mail status flag to false only (flag-only, no move); returns boolean
    - archiveMessage(id, account?): delegates to this.moveMessage(id, "Archive", account); returns boolean
    - batchArchiveMessages(ids, account?): delegates to this.batchMoveMessages(ids, "Archive", account); returns BatchOperationResult[]
  </behavior>
  <action>
In src/services/appleMailManager.ts, add four methods. Insert them immediately after the unflagMessage method (after line ~1204, before the moveMessage method at line 1209). Use this exact implementation:

```typescript
  /**
   * Mark a message as junk and move it to the Junk mailbox.
   *
   * Sets `junk mail status` to true AND physically moves the message to
   * the account's Junk mailbox (resolved via MAILBOX_ALIASES["junk"]).
   * The move step is required because the AppleScript flag property alone
   * does not move the message out of INBOX.
   */
  moveToJunk(id: string): boolean {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return false;
    }
    // Step 1: set the junk flag. findMessageScript locates msg across all mailboxes.
    const flagScript = this.findMessageScript(id, "set junk mail status of msg to true");
    const flagResult = executeAppleScript(flagScript, { timeoutMs: 60000 });
    if (!flagResult.success || flagResult.output.startsWith("error:")) {
      console.error(`Failed to set junk flag: ${flagResult.error || flagResult.output}`);
      return false;
    }

    // Step 2: move to junk mailbox. resolveAccount picks the message's account
    // indirectly via moveMessage's own account resolution; "Junk" is in
    // MAILBOX_ALIASES["junk"] so resolveMailbox will match it on all account types.
    return this.moveMessage(id, "Junk");
  }

  /**
   * Clear the junk flag on a message (flag-only; does not move message to INBOX).
   *
   * After calling this, the message remains in whatever mailbox it is in.
   * Callers that want to restore the message to INBOX should also call
   * moveMessage(id, "INBOX").
   */
  markAsNotJunk(id: string): boolean {
    const script = this.findMessageScript(id, "set junk mail status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to clear junk flag: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Archive a message by moving it to the account's Archive mailbox.
   *
   * The Archive mailbox name is resolved through MAILBOX_ALIASES["archive"],
   * which includes "Archive", "ARCHIVE", "archive", "All Mail".
   * Note: On Gmail accounts, this may leave the "Inbox" label on the message
   * due to Gmail's IMAP label model. This is a known Gmail IMAP limitation.
   */
  archiveMessage(id: string, account?: string): boolean {
    return this.moveMessage(id, "Archive", account);
  }
```

After batchMoveMessages (line ~1296), add batchArchiveMessages:

```typescript
  /**
   * Archive multiple messages at once.
   *
   * @param ids - Array of message IDs to archive
   * @param account - Account containing the Archive mailbox
   * @returns Array of results for each message
   */
  batchArchiveMessages(ids: string[], account?: string): BatchOperationResult[] {
    return this.batchMoveMessages(ids, "Archive", account);
  }
```

Also update the import at the top of appleMailManager.ts: add `ThreadMessage` to the type imports from `@/types.js`. The existing import block starts at line 21.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit 2>&1 | head -20</automated>
  </verify>
  <done>TypeScript compiles. moveToJunk, markAsNotJunk, archiveMessage, batchArchiveMessages are defined as public methods on AppleMailManager. archiveMessage delegates to moveMessage. batchArchiveMessages delegates to batchMoveMessages.</done>
</task>

<!-- =========================================================
     TASK 3: getSyncStatus cleanup + get-thread service method
     Context cost: ~25%
     ========================================================= -->

<task type="auto" tdd="true">
  <name>Task 3: getSyncStatus cleanup + getThread service method with normalizeSubject</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - getSyncStatus returns { running: boolean, accountCount: number, error?: string } — no syncDetected, pendingUpload, recentActivity, secondsSinceLastChange fields
    - normalizeSubject exported pure function strips Re:/RE:/Fwd:/FW:/AW:/WG:/Aw:/Wg: prefixes recursively, trims whitespace
    - normalizeSubject("Re: Re: Hello World") === "Hello World"
    - normalizeSubject("AW: Something") === "Something"
    - normalizeSubject("plain subject") === "plain subject"
    - getThread(id, account?) returns ThreadMessage[] ordered by dateReceived ascending; empty array if seed not found
    - getThread enforces minimum base-subject length of 10 chars (returns empty array with console warning if shorter)
  </behavior>
  <action>
Two changes in src/services/appleMailManager.ts:

**Change A — Export normalizeSubject as a module-level pure function.**

Add this function immediately before the AppleMailManager class declaration (before line ~138):

```typescript
/**
 * Strips common reply/forward subject prefixes to get the base subject.
 *
 * Handles English (Re:, Fwd:, FW:), German (AW:, WG:), and mixed-case variants.
 * Applied recursively until no more prefixes remain.
 *
 * @param subject - Raw email subject line
 * @returns Normalized base subject with prefixes stripped and whitespace trimmed
 */
export function normalizeSubject(subject: string): string {
  const prefixPattern = /^(Re|RE|re|Fwd|FWD|fwd|FW|fw|AW|aw|WG|wg):\s+/;
  let normalized = subject.trim();
  let prev: string;
  do {
    prev = normalized;
    normalized = normalized.replace(prefixPattern, "").trim();
  } while (normalized !== prev);
  return normalized;
}
```

**Change B — Add getThread method to AppleMailManager.**

Add getThread immediately after batchArchiveMessages (after the new method from Task 2). Use this implementation:

```typescript
  /**
   * Retrieve all messages in a thread by subject matching.
   *
   * Apple Mail's AppleScript API has no native thread/conversation object.
   * This implementation finds the seed message's subject, normalizes it
   * (strips Re:/Fwd: prefixes), then searches all mailboxes in all accounts
   * for messages whose subject contains the base subject string.
   *
   * Results are sorted by dateReceived ascending.
   *
   * Limitations:
   * - Very short base subjects (< 10 chars) may return unrelated messages.
   *   getThread returns [] and logs a warning in that case.
   * - Generic subjects ("Hello") may still produce false positives.
   * - Gmail Archive label duplication does not affect this operation.
   *
   * @param id - ID of any message in the thread (the seed message)
   * @param account - Optional: limit search to this account for performance
   * @returns Thread messages ordered by dateReceived ascending, or [] on failure
   */
  getThread(id: string, account?: string): ThreadMessage[] {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return [];
    }

    // Step 1: Fetch seed message to get subject
    const seed = this.getMessageById(id);
    if (!seed) {
      console.error(`Thread seed message not found: ${id}`);
      return [];
    }

    const baseSubject = normalizeSubject(seed.subject);

    // Guard: subject too short → high false-positive risk
    if (baseSubject.length < 10) {
      console.warn(
        `getThread: base subject "${baseSubject}" is shorter than 10 characters — search skipped to avoid false positives`
      );
      return [];
    }

    const safeSubject = escapeForAppleScript(baseSubject);

    // Step 2: Build search script. If account is provided, limit to that account.
    // Otherwise iterate all accounts.
    let searchBody: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      searchBody = `
        set targetAcct to account "${safeAccount}"
        repeat with mb in mailboxes of targetAcct
          try
            set matches to (messages of mb whose subject contains "${safeSubject}")
            repeat with msg in matches
              set msgId to id of msg as string
              set msgSubj to subject of msg
              set msgSender to sender of msg
              set msgDate to date received of msg as string
              set msgRead to read status of msg as string
              set mbName to name of mb
              set acctName to name of targetAcct
              if msgCount > 0 then set outputText to outputText & recSep
              set outputText to outputText & msgId & fieldSep & msgSubj & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & mbName & fieldSep & acctName
              set msgCount to msgCount + 1
            end repeat
          end try
        end repeat
      `;
    } else {
      searchBody = `
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matches to (messages of mb whose subject contains "${safeSubject}")
              repeat with msg in matches
                set msgId to id of msg as string
                set msgSubj to subject of msg
                set msgSender to sender of msg
                set msgDate to date received of msg as string
                set msgRead to read status of msg as string
                set mbName to name of mb
                set acctName to name of acct
                if msgCount > 0 then set outputText to outputText & recSep
                set outputText to outputText & msgId & fieldSep & msgSubj & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & mbName & fieldSep & acctName
                set msgCount to msgCount + 1
              end repeat
            end try
          end repeat
        end repeat
      `;
    }

    const script = buildAppLevelScript(`
      set fieldSep to character id 57345
      set recSep to character id 57346
      set outputText to ""
      set msgCount to 0
      ${searchBody}
      return outputText
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      return [];
    }

    // Parse the 7-field records produced by parseMessageListAllMailboxes format
    // (id, subject, sender, dateReceived, isRead, mailbox, account)
    const items = result.output.split(RECORD_SEP);
    const messages: ThreadMessage[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 7) continue;
      messages.push({
        id: parts[0].trim(),
        subject: parts[1],
        sender: parts[2],
        dateReceived: parseAppleScriptDate(parts[3]),
        isRead: parts[4] === "true",
        mailbox: parts[5],
        account: parts[6],
      });
    }

    // Sort by dateReceived ascending (oldest first)
    messages.sort((a, b) => a.dateReceived.getTime() - b.dateReceived.getTime());

    // Deduplicate by id (same message may appear in multiple mailboxes, e.g. Sent + INBOX for iCloud)
    const seen = new Set<string>();
    return messages.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }
```

**Change C — Replace getSyncStatus (lines 2217–2279).**

Replace the entire getSyncStatus method with:

```typescript
  /**
   * Check whether Mail.app is running and how many accounts are loaded.
   *
   * Note: Apple Mail's AppleScript API does not expose IMAP sync state,
   * pending upload counts, or last-sync timestamps. This method reports
   * only what is directly observable.
   */
  getSyncStatus(): SyncStatus {
    const script = buildAppLevelScript(`
      set accountCount to count of accounts
      return "running" & (character id 57345) & accountCount
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      return {
        running: false,
        accountCount: 0,
        error: result.error ?? "AppleScript execution failed",
      };
    }

    // Mail.app not running: osascript returns an error, caught above.
    // If we reach here, Mail.app responded — it is running.
    const parts = result.output.split(FIELD_SEP);
    const accountCount = parseInt(parts[1]) || 0;

    return {
      running: true,
      accountCount,
    };
  }
```

No other changes to appleMailManager.ts in this task.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>TypeScript compiles. normalizeSubject is exported. getThread is a public method. getSyncStatus returns SyncStatus with only { running, accountCount, error? }.</done>
</task>

<!-- =========================================================
     TASK 4: getVipMessages service method
     Context cost: ~20%
     ========================================================= -->

<task type="auto" tdd="true">
  <name>Task 4: Service method — getVipMessages</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - getVipMessages() discovers VIP.plist via `find ~/Library/Mail -name "VIP.plist" -maxdepth 3`
    - If plist not found, returns { messages: [], vipSenders: [], error: "No VIP senders..." }
    - Converts plist to JSON via `plutil -convert json -o - <path>` using execSync
    - Extracts email addresses from plist JSON (expects EmailAddresses array of strings)
    - For each VIP sender address, calls this.searchMessages with { from: address, mailbox: "INBOX", limit: 50 }
    - Merges results, deduplicates by message id, sorts by dateReceived descending
    - Returns { messages: Message[], vipSenders: string[], error?: string }
  </behavior>
  <action>
Add getVipMessages to src/services/appleMailManager.ts.

First, add the Node.js execSync import. At line 16, the existing import is:
```
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
```
Change it to also import execSync from child_process. Add a new line immediately after line 16:
```typescript
import { execSync } from "child_process";
```

Then add this method to the AppleMailManager class, after getThread:

```typescript
  /**
   * Retrieve messages from VIP senders configured in Mail.app.
   *
   * Apple Mail's AppleScript API does not expose VIP status as a message
   * property or mailbox. VIP senders are stored in a plist file at
   * ~/Library/Mail/V*/VIP.plist. This method:
   *  1. Discovers the plist via `find ~/Library/Mail -name "VIP.plist" -maxdepth 3`
   *  2. Converts it to JSON via `plutil -convert json -o -`
   *  3. Extracts sender email addresses from EmailAddresses array
   *  4. Searches INBOX for each VIP sender and merges results
   *
   * If no VIP.plist is found (no VIPs configured in Mail.app), returns
   * an empty message list with an explanatory error string.
   *
   * @param limit - Max messages per VIP sender (default 50)
   * @returns Object with messages array, vipSenders array, and optional error
   */
  getVipMessages(limit = 50): { messages: Message[]; vipSenders: string[]; error?: string } {
    // Step 1: Discover VIP.plist path (macOS version-agnostic)
    let plistPath: string;
    try {
      const findOutput = execSync(
        "find ~/Library/Mail -name 'VIP.plist' -maxdepth 3 2>/dev/null",
        { encoding: "utf8", timeout: 5000 }
      ).trim();
      if (!findOutput) {
        return {
          messages: [],
          vipSenders: [],
          error:
            "No VIP senders found. Configure VIP senders in Mail.app (Mailbox > Add VIP) first.",
        };
      }
      // Use the first result if multiple are found
      plistPath = findOutput.split("\n")[0].trim();
    } catch {
      return {
        messages: [],
        vipSenders: [],
        error: "Failed to locate VIP.plist. Ensure Mail.app is configured.",
      };
    }

    // Step 2: Parse VIP plist as JSON via plutil (built-in macOS tool)
    let vipSenders: string[] = [];
    try {
      const jsonOutput = execSync(`plutil -convert json -o - "${plistPath}"`, {
        encoding: "utf8",
        timeout: 5000,
      });
      const parsed = JSON.parse(jsonOutput) as Record<string, unknown>;
      // VIP.plist structure: { EmailAddresses: ["addr1@example.com", ...] }
      if (Array.isArray(parsed["EmailAddresses"])) {
        vipSenders = (parsed["EmailAddresses"] as unknown[])
          .filter((e): e is string => typeof e === "string" && e.includes("@"))
          .map((e) => e.toLowerCase());
      }
    } catch {
      return {
        messages: [],
        vipSenders: [],
        error: "Failed to parse VIP.plist. The file may be malformed.",
      };
    }

    if (vipSenders.length === 0) {
      return {
        messages: [],
        vipSenders: [],
        error: "VIP.plist found but contains no email addresses.",
      };
    }

    // Step 3: Search INBOX for each VIP sender, merge and deduplicate
    const seen = new Set<string>();
    const allMessages: Message[] = [];

    for (const sender of vipSenders) {
      const results = this.searchMessages({ from: sender, mailbox: "INBOX", limit });
      for (const msg of results) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          allMessages.push(msg);
        }
      }
    }

    // Sort by dateReceived descending (newest first)
    allMessages.sort((a, b) => b.dateReceived.getTime() - a.dateReceived.getTime());

    return { messages: allMessages, vipSenders };
  }
```

Note: `this.searchMessages` already accepts `{ from, mailbox, limit }` — this is the existing method at line 314. No new AppleScript is needed.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>TypeScript compiles. getVipMessages is a public method. execSync imported from child_process.</done>
</task>

<!-- =========================================================
     TASK 5: Register all new tools in index.ts + update get-sync-status
     Context cost: ~20%
     ========================================================= -->

<task type="auto">
  <name>Task 5: Register new MCP tools in index.ts and update get-sync-status</name>
  <files>src/index.ts</files>
  <action>
In src/index.ts, make the following additions and changes:

**A. Add six new tool registrations.**

Insert before the "// === Diagnostics Tools ===" comment block (before line ~968). Add each tool in the order below. All tools follow the existing pattern of `server.tool(name, schema, withErrorHandling(handler, errorPrefix))`.

```typescript
// =============================================================================
// Junk Mail Tools
// =============================================================================

// --- move-to-junk ---

server.tool(
  "move-to-junk",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("Unique message ID (from list-messages or search-messages)"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.moveToJunk(id);
    if (!success) {
      return errorResponse(
        `Failed to mark message "${id}" as junk. The message may not exist or the Junk mailbox may be unavailable.`
      );
    }
    return successResponse(`Message "${id}" marked as junk and moved to Junk mailbox.`);
  }, "Error marking message as junk")
);

// --- mark-as-not-junk ---

server.tool(
  "mark-as-not-junk",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("Unique message ID (from list-messages or search-messages)"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.markAsNotJunk(id);
    if (!success) {
      return errorResponse(
        `Failed to clear junk flag on message "${id}". The message may not exist.`
      );
    }
    return successResponse(
      `Message "${id}" junk flag cleared. The message remains in its current mailbox — use move-message to restore it to INBOX if needed.`
    );
  }, "Error clearing junk flag")
);

// =============================================================================
// Archive Tools
// =============================================================================

// --- archive-message ---

server.tool(
  "archive-message",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("Unique message ID (from list-messages or search-messages)"),
    account: z
      .string()
      .optional()
      .describe("Account whose Archive mailbox to use (omit to use default account)"),
  },
  withErrorHandling(({ id, account }) => {
    const success = mailManager.archiveMessage(id, account);
    if (!success) {
      return errorResponse(
        `Failed to archive message "${id}". The Archive mailbox may be unavailable for this account.`
      );
    }
    return successResponse(
      `Message "${id}" archived. Note: Gmail accounts may leave the Inbox label due to Gmail's IMAP label model.`
    );
  }, "Error archiving message")
);

// --- batch-archive ---

server.tool(
  "batch-archive",
  {
    ids: z
      .array(z.string().regex(/^\d+$/, "Message ID must be numeric"))
      .min(1, "At least one message ID required")
      .describe("Array of message IDs to archive"),
    account: z
      .string()
      .optional()
      .describe("Account whose Archive mailbox to use (omit to use default account)"),
  },
  withErrorHandling(({ ids, account }) => {
    const results = mailManager.batchArchiveMessages(ids, account);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    const lines: string[] = [`Archived ${succeeded}/${results.length} messages.`];
    if (failed.length > 0) {
      lines.push(`Failed: ${failed.map((r) => r.id).join(", ")}`);
    }

    return successResponse(lines.join("\n"));
  }, "Error batch archiving messages")
);

// =============================================================================
// Thread Tools
// =============================================================================

// --- get-thread ---

server.tool(
  "get-thread",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("ID of any message in the thread (seed message)"),
    account: z
      .string()
      .optional()
      .describe(
        "Limit thread search to this account (faster). Omit to search all accounts (slower, more complete)."
      ),
  },
  withErrorHandling(({ id, account }) => {
    const messages = mailManager.getThread(id, account);

    if (messages.length === 0) {
      return successResponse(
        `No thread found for message "${id}". The subject may be too short or the message may not exist.`
      );
    }

    const lines: string[] = [
      `Thread: ${messages.length} message${messages.length === 1 ? "" : "s"} (oldest first)`,
      ``,
    ];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const dateStr = m.dateReceived.toLocaleString();
      const readStatus = m.isRead ? "Read" : "Unread";
      lines.push(`[${i + 1}] ID: ${m.id}  ${readStatus}`);
      lines.push(`    From: ${m.sender}`);
      lines.push(`    Subject: ${m.subject}`);
      lines.push(`    Date: ${dateStr}`);
      lines.push(`    Mailbox: ${m.mailbox} (${m.account})`);
      lines.push(``);
    }

    return successResponse(lines.join("\n").trimEnd());
  }, "Error getting thread")
);

// =============================================================================
// VIP Tools
// =============================================================================

// --- get-vip-messages ---

server.tool(
  "get-vip-messages",
  {
    limit: z
      .number()
      .optional()
      .describe("Max messages per VIP sender to retrieve (default: 50)"),
  },
  withErrorHandling(({ limit }) => {
    const { messages, vipSenders, error } = mailManager.getVipMessages(limit ?? 50);

    if (error && messages.length === 0) {
      return successResponse(`VIP messages: none\n\n${error}`);
    }

    const lines: string[] = [
      `VIP Senders (${vipSenders.length}): ${vipSenders.join(", ")}`,
      `Messages from VIP senders: ${messages.length}`,
      ``,
    ];

    for (const m of messages) {
      const dateStr = m.dateReceived.toLocaleString();
      const readStatus = m.isRead ? "Read" : "Unread";
      lines.push(`ID: ${m.id}  [${readStatus}]`);
      lines.push(`  From: ${m.sender}`);
      lines.push(`  Subject: ${m.subject}`);
      lines.push(`  Date: ${dateStr}`);
      lines.push(`  Mailbox: ${m.mailbox}`);
      lines.push(``);
    }

    return successResponse(lines.join("\n").trimEnd());
  }, "Error getting VIP messages")
);
```

**B. Update the get-sync-status handler** (lines 1032–1051).

Replace the existing get-sync-status tool registration with:

```typescript
// --- get-sync-status ---

server.tool(
  "get-sync-status",
  {},
  withErrorHandling(() => {
    const status = mailManager.getSyncStatus();

    const lines: string[] = [];
    lines.push(`Mail Sync Status`);
    lines.push(`═══════════════════`);

    if (status.error) {
      lines.push(`Status: ${status.error}`);
    } else {
      lines.push(`Mail.app: ${status.running ? "Running" : "Not running"}`);
      lines.push(`Accounts loaded: ${status.accountCount}`);
      lines.push(``);
      lines.push(
        `Note: Apple Mail does not expose IMAP sync state via AppleScript. Only running status and account count are observable.`
      );
    }

    return successResponse(lines.join("\n"));
  }, "Error getting sync status")
);
```

No other changes to index.ts.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>TypeScript compiles. All six new tools (move-to-junk, mark-as-not-junk, archive-message, batch-archive, get-thread, get-vip-messages) are registered. get-sync-status handler uses status.running and status.accountCount only.</done>
</task>

<!-- =========================================================
     TASK 6: Unit tests
     Context cost: ~20%
     ========================================================= -->

<task type="auto">
  <name>Task 6: Write unit tests for Phase 3</name>
  <files>src/__tests__/phase3.test.ts</files>
  <action>
Create src/__tests__/phase3.test.ts with the following tests. Use the same module-level vi.mock pattern from phase2.test.ts (vi.mock('child_process', ...) for VIP plist tests).

The file should cover these test suites:

**Suite 1: normalizeSubject (pure function tests)**

Import normalizeSubject from `@/services/appleMailManager.js`. Test:
- Strips "Re: " prefix
- Strips "RE: " prefix
- Strips "Fwd: " prefix
- Strips "FW: " prefix
- Strips "AW: " prefix (German)
- Strips "WG: " prefix (German)
- Strips multiple nested prefixes: "Re: Re: Hello World" → "Hello World"
- Leaves plain subject unchanged
- Trims whitespace
- Short subject (< 10 chars) passes through unchanged (normalizeSubject does not guard length — that is the caller's job)

**Suite 2: AppleMailManager junk/archive delegates**

These tests mock `executeAppleScript` using vi.mock('@/utils/applescript.js', ...). For each test, configure the mock to return `{ success: true, output: "ok" }`.

- moveToJunk calls executeAppleScript twice (flag + move) and returns true on double-ok
- moveToJunk returns false when first executeAppleScript call fails
- markAsNotJunk calls findMessageScript with "set junk mail status of msg to false" (verify the script string contains that substring)
- archiveMessage delegates to moveMessage: spy on moveMessage, verify it is called with ("123", "Archive", undefined)
- batchArchiveMessages delegates to batchMoveMessages: spy on batchMoveMessages, verify called with (["1","2"], "Archive", undefined)

Note: Since moveToJunk has a two-step operation (flag script + move script via moveMessage), the test for archiveMessage can use vi.spyOn on the AppleMailManager instance. For moveToJunk, mock executeAppleScript at module level and configure it to return success for both calls.

**Suite 3: SyncStatus shape**

Mock executeAppleScript to return `{ success: true, output: "running1" }` (where  is FIELD_SEP). Then:
- getSyncStatus returns object with `running: true`
- getSyncStatus returns object with `accountCount: 1`
- getSyncStatus does NOT have a `syncDetected` property
- getSyncStatus does NOT have a `pendingUpload` property

Also test failure path: mock returns `{ success: false, error: "timeout" }` → getSyncStatus returns `{ running: false, accountCount: 0, error: "timeout" }`.

**Suite 4: getVipMessages (mock execSync + searchMessages)**

Use module-level vi.mock('child_process', () => ({ execSync: vi.fn() })).

- When execSync (find) returns empty string: returns { messages: [], vipSenders: [], error: "No VIP senders found..." }
- When execSync (plutil) returns valid JSON `{"EmailAddresses":["vip@example.com"]}`: vipSenders contains "vip@example.com"
- When execSync throws: returns { messages: [], vipSenders: [], error: "Failed to locate VIP.plist..." }
- When plist JSON has no EmailAddresses array: returns { messages: [], vipSenders: [], error: "VIP.plist found but contains no email addresses." }
- After successful VIP address extraction, searchMessages is called per sender (spy on mailManager.searchMessages returning [])

All tests must pass with `npx vitest run src/__tests__/phase3.test.ts`.

The test file must start with:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeSubject } from "@/services/appleMailManager.js";
import { AppleMailManager } from "@/services/appleMailManager.js";
```

Use `vi.mock` at module level for external dependencies. Configure mock implementations in `beforeEach` blocks inside each suite as needed.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx vitest run src/__tests__/phase3.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>All Phase 3 tests pass. Total test count increases from 70 to at least 80. npx vitest run passes with 0 failures across all test files.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| MCP tool parameter → AppleScript | All user-supplied strings (message IDs, account names, subjects) cross into AppleScript strings |
| AppleMailManager → filesystem | VIP plist path derived from `find` output; subject strings embedded in AppleScript |
| execSync → shell | `plutil` is invoked with a path from `find` output |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-3-01 | Tampering | get-thread: subject embedded in AppleScript | mitigate | `escapeForAppleScript(baseSubject)` applied before embedding; already standard in codebase |
| T-3-02 | Tampering | get-vip-messages: plist path from `find` output | mitigate | Path is derived from `find ~/Library/Mail -maxdepth 3` (no user input); path is not user-supplied; plutil receives it via double-quoted interpolation |
| T-3-03 | Information Disclosure | get-vip-messages exposes VIP sender addresses in response text | accept | VIP addresses are the user's own configuration; MCP server is local-only, no network egress |
| T-3-04 | Denial of Service | get-thread: large mail stores cause 60s timeout | accept | 60s timeout already applied; same pattern as existing allMailboxes search |
| T-3-05 | Spoofing | move-to-junk: non-numeric ID accepted | mitigate | `z.string().regex(/^\d+$/)` validation in index.ts schema + `!/^\d+$/.test(id)` guard in service method |
| T-3-SC | Tampering | npm/pip/cargo installs | accept | No new packages installed in Phase 3; only Node.js built-ins (child_process) used |
</threat_model>

<verification>
After all tasks are complete, run the full verification sequence:

1. TypeScript: `cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit`
   Expected: zero errors

2. All tests: `cd /Users/michaelhenze/apple-mail-mcp && npx vitest run`
   Expected: all tests pass, total count >= 80

3. Spot-check new exports: `grep -n "export function normalizeSubject\|getThread\|getVipMessages\|moveToJunk\|markAsNotJunk\|archiveMessage\|batchArchiveMessages" /Users/michaelhenze/apple-mail-mcp/src/services/appleMailManager.ts`
   Expected: all seven symbols present

4. Verify SyncStatus has no fake fields: `grep -n "syncDetected\|pendingUpload\|secondsSinceLastChange" /Users/michaelhenze/apple-mail-mcp/src/types.ts`
   Expected: zero matches

5. Verify tool registrations: `grep -n '"move-to-junk"\|"mark-as-not-junk"\|"archive-message"\|"batch-archive"\|"get-thread"\|"get-vip-messages"' /Users/michaelhenze/apple-mail-mcp/src/index.ts`
   Expected: six matches
</verification>

<success_criteria>
- TypeScript compiles with zero errors after all tasks
- All tests pass (>= 80 total; 0 failures)
- normalizeSubject is exported and pure (no AppleScript calls)
- SyncStatus interface has only { running, accountCount, error? }
- Six new MCP tools registered: move-to-junk, mark-as-not-junk, archive-message, batch-archive, get-thread, get-vip-messages
- get-sync-status handler references status.running and status.accountCount only
- moveToJunk performs two-step operation: flag + move
- archiveMessage is a one-line delegate to moveMessage
- batchArchiveMessages is a one-line delegate to batchMoveMessages
- getVipMessages returns graceful empty response when VIP.plist is absent
- No TODO comments or unimplemented stubs in delivered code
</success_criteria>

<output>
Create `.planning/phases/phase-3/SUMMARY.md` when done.
</output>
