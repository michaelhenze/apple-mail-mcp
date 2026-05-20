---
phase: "04"
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - src/types.ts
  - src/services/appleMailManager.ts
  - src/index.ts
  - src/__tests__/phase4.test.ts
autonomous: true
requirements: [PHASE4-INTEL]
must_haves:
  truths:
    - "triage-inbox returns structured list of unread messages with id/subject/sender/date/snippet for Claude to classify"
    - "find-action-items returns message body text + metadata for a single message or mailbox scan"
    - "summarize-inbox returns unread message list (no body fetch) for daily briefing"
    - "unsubscribe-helper returns isLikelyNewsletter boolean + array of unsubscribe link URLs extracted from HTML"
    - "draft-reply returns thread context text when called without draftBody; creates a draft when draftBody is provided"
    - "summarize-thread returns all thread messages with bodies for Claude to summarise"
    - "detect-waiting-for returns list of sent messages with no replies, sorted oldest first, including daysWaiting"
    - "npx tsc --noEmit reports zero errors after phase complete"
    - "npm test reports all tests passing (104 baseline + new phase4 tests)"
  artifacts:
    - path: "src/types.ts"
      provides: "TriageMessage, ActionItemsResult, WaitingForItem interfaces"
      contains: "interface TriageMessage"
    - path: "src/services/appleMailManager.ts"
      provides: "getTriageMessages, getSummarizeInboxData, getActionItems, getUnsubscribeLinks, getDraftReplyContext, getThreadSummaryData, getWaitingFor methods"
      exports: ["getTriageMessages", "getSummarizeInboxData", "getActionItems", "getUnsubscribeLinks", "getDraftReplyContext", "getThreadSummaryData", "getWaitingFor"]
    - path: "src/index.ts"
      provides: "7 new MCP tool registrations"
      contains: "triage-inbox"
    - path: "src/__tests__/phase4.test.ts"
      provides: "Unit tests for all phase-4 logic"
      contains: "phase4"
  key_links:
    - from: "src/index.ts triage-inbox handler"
      to: "mailManager.getTriageMessages()"
      via: "direct method call"
      pattern: "getTriageMessages"
    - from: "src/index.ts detect-waiting-for handler"
      to: "mailManager.getWaitingFor()"
      via: "direct method call"
      pattern: "getWaitingFor"
    - from: "getWaitingFor"
      to: "this.searchMessages + this.getThread + this.listAccounts"
      via: "cross-reference logic in TypeScript"
      pattern: "listAccounts.*Set"
---

<objective>
Implement the Phase 4 Intelligence Layer: seven new MCP tools that fetch and structure email data for Claude to reason over. Zero new npm dependencies. All tools follow the data-pass-through pattern already established in Phases 1-3.

Purpose: Give the calling Claude assistant the structured data it needs to triage, summarize, find action items, draft replies, detect newsletters, and track waiting-for items — without any server-side LLM calls.

Output: 3 new TypeScript interfaces in src/types.ts, 7 new service methods in appleMailManager.ts, 7 new tool registrations in src/index.ts, and a full unit test suite in src/__tests__/phase4.test.ts.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/phase-3/SUMMARY.md

<interfaces>
<!-- Key types and contracts the executor needs. Extracted from src/types.ts and src/services/appleMailManager.ts. -->
<!-- Executor should use these directly — no codebase exploration needed. -->

From src/types.ts (existing interfaces):
```typescript
export interface Message {
  id: string; subject: string; sender: string; senderName?: string;
  recipients: string[]; ccRecipients?: string[]; replyTo?: string;
  bccRecipients?: string[]; dateReceived: Date; dateSent?: Date;
  isRead: boolean; isFlagged: boolean; isJunk: boolean; isDeleted: boolean;
  mailbox: string; account: string; hasAttachments: boolean; attachmentNames?: string[];
}
export interface ThreadMessage {
  id: string; subject: string; sender: string; dateReceived: Date;
  isRead: boolean; mailbox: string; account: string;
}
export interface MessageContent {
  id: string; subject: string; plainText: string; htmlContent?: string;
}
export interface Account {
  name: string; email: string; accountType?: string; enabled: boolean;
}
```

From src/services/appleMailManager.ts (method signatures — positional args, not object):
```typescript
// listMessages(mailbox?, account?, limit, from?, offset, unreadOnly?)
listMessages(mailbox?: string, account?: string, limit = 50, from?: string, offset = 0, unreadOnly?: boolean): Message[]

// searchMessages positional signature:
searchMessages(query?, mailbox?, account?, limit, dateFrom?, dateTo?, from?, isRead?, isFlagged?, allMailboxes?, offset): Message[]

// getMessageContent — one AppleScript call per message
getMessageContent(id: string): MessageContent | null

// getThread — returns [] for subjects < 10 chars
getThread(id: string, account?: string): ThreadMessage[]

// createDraft — returns true on success
createDraft(to: string[], subject: string, body: string, cc?, bcc?, account?, attachments?, isHtml?): boolean

// listAccounts — returns Account[] with email field
listAccounts(): Account[]

// getUnreadCount
getUnreadCount(mailbox?: string, account?: string): number

// normalizeSubject — exported pure function
export function normalizeSubject(subject: string): string
```

Error handling pattern in src/index.ts:
```typescript
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ReturnType<typeof successResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    try { return handler(params); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`);
    }
  };
}
```

Tool registration pattern (from existing tools):
```typescript
server.tool(
  "tool-name",
  { param: z.string().optional().describe("...") },
  withErrorHandling(({ param }) => {
    const result = mailManager.methodName(param);
    return successResponse(formattedString);
  }, "Error message prefix")
);
```

File insertion points:
- src/types.ts: append 3 new interfaces after line 517 (end of SyncStatus block, before EOF)
- src/services/appleMailManager.ts: append 7 new methods before line 2576 (the closing `}` of the class, just before getSyncStatus ends)
- src/index.ts: insert 7 tool registrations between line 1251 (end of get-sync-status tool) and line 1253 (Server Startup comment)
- src/__tests__/phase4.test.ts: create new file
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add Phase 4 TypeScript interfaces to src/types.ts</name>
  <files>src/types.ts</files>
  <action>
Append three new interface blocks after the closing brace of the SyncStatus interface (currently the last interface in the file, ending around line 517). Do NOT modify any existing interfaces.

Add these interfaces under a new section comment "// ============================================================================= \n// Phase 4: Intelligence Layer\n// =============================================================================":

1. TriageMessage — extends Message metadata with a snippet field:
```
export interface TriageMessage {
  id: string;
  subject: string;
  sender: string;
  dateReceived: Date;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  mailbox: string;
  account: string;
  snippet?: string; // first ~200 chars of plainText; undefined when includeSnippets=false
}
```

2. ActionItemsResult — wraps body content for a single message in action-item extraction context:
```
export interface ActionItemsResult {
  id: string;
  subject: string;
  sender: string;
  dateReceived: Date;
  plainText: string;
}
```

3. WaitingForItem — a sent message with reply-detection fields:
```
export interface WaitingForItem {
  id: string;
  subject: string;
  sender: string;         // always the user's own address
  recipients: string[];
  dateSent: Date;
  daysWaiting: number;    // Math.floor((now - dateSent) / 86400000)
  hasReply: boolean;      // always false — only items with hasReply=false are returned
}
```

After editing, run: `npx tsc --noEmit` — it must report zero errors.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit && grep -c "interface TriageMessage\|interface ActionItemsResult\|interface WaitingForItem" src/types.ts</automated>
  </verify>
  <done>src/types.ts compiles clean; grep returns 3; all three interfaces are exported.</done>
</task>

<task type="auto">
  <name>Task 2: Add 7 service methods to AppleMailManager</name>
  <files>src/services/appleMailManager.ts</files>
  <action>
Add the import for the three new types at the top of the file in the existing `import type { ... } from "@/types.js"` block (around line 22-38). Add `TriageMessage`, `ActionItemsResult`, `WaitingForItem` to the import list.

Then append seven new methods to the `AppleMailManager` class. Insert them just before the closing `}` of the class (currently line 2576, right after `getSyncStatus` ends at line 2575). Each method is a regular class method (no `static`, no `private` unless noted).

---

Method 1: getTriageMessages

Fetches unread messages from a mailbox and optionally adds body snippets. Returns TriageMessage[].

```typescript
getTriageMessages(
  mailbox = "INBOX",
  limit = 20,
  includeSnippets = true,
  account?: string
): TriageMessage[] {
  const messages = this.listMessages(mailbox, account, limit, undefined, 0, true);
  return messages.map((msg) => {
    const entry: TriageMessage = {
      id: msg.id,
      subject: msg.subject,
      sender: msg.sender,
      dateReceived: msg.dateReceived,
      isRead: msg.isRead,
      isFlagged: msg.isFlagged,
      hasAttachments: msg.hasAttachments,
      mailbox: msg.mailbox,
      account: msg.account,
    };
    if (includeSnippets) {
      const content = this.getMessageContent(msg.id);
      if (content) {
        entry.snippet = content.plainText.slice(0, 200).replace(/\n+/g, " ").trim();
      }
    }
    return entry;
  });
}
```

---

Method 2: getSummarizeInboxData

Returns unread message metadata (no body fetch) for a daily briefing. Calls listMessages and getUnreadCount.

```typescript
getSummarizeInboxData(
  mailbox = "INBOX",
  limit = 30,
  account?: string
): { totalUnread: number; messages: Message[] } {
  const totalUnread = this.getUnreadCount(mailbox, account);
  const messages = this.listMessages(mailbox, account, limit, undefined, 0, true);
  return { totalUnread, messages };
}
```

---

Method 3: getActionItems

Fetches message body for a single message OR up to `limit` messages from a mailbox. Returns ActionItemsResult[].

```typescript
getActionItems(
  id?: string,
  mailbox = "INBOX",
  limit = 10,
  account?: string
): ActionItemsResult[] {
  if (id) {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return [];
    }
    const msg = this.getMessageById(id);
    if (!msg) return [];
    const content = this.getMessageContent(id);
    if (!content) return [];
    return [{
      id: msg.id,
      subject: msg.subject,
      sender: msg.sender,
      dateReceived: msg.dateReceived,
      plainText: content.plainText,
    }];
  }
  const messages = this.listMessages(mailbox, account, limit);
  const results: ActionItemsResult[] = [];
  for (const msg of messages) {
    const content = this.getMessageContent(msg.id);
    if (content) {
      results.push({
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        dateReceived: msg.dateReceived,
        plainText: content.plainText,
      });
    }
  }
  return results;
}
```

---

Method 4: getUnsubscribeLinks

Fetches the HTML body of a message and extracts unsubscribe/optout/remove links using two regex passes. Also detects newsletter signals via heuristics.

```typescript
getUnsubscribeLinks(id: string): {
  isLikelyNewsletter: boolean;
  newsletterSignals: string[];
  unsubscribeLinks: string[];
} {
  if (!/^\d+$/.test(id)) {
    console.error(`Invalid message ID: "${id}"`);
    return { isLikelyNewsletter: false, newsletterSignals: [], unsubscribeLinks: [] };
  }
  const content = this.getMessageContent(id);
  if (!content) {
    return { isLikelyNewsletter: false, newsletterSignals: [], unsubscribeLinks: [] };
  }

  const html = content.htmlContent ?? "";
  const links: string[] = [];

  // Pass 1: links where anchor text contains unsubscribe/optout/opt-out/remove
  const textPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:unsubscribe|opt.out|remove)[^<]*<\/a>/gi;
  // Pass 2: links where href itself contains those keywords
  const hrefPattern = /href=["']([^"']*(?:unsubscribe|optout|opt-out|remove)[^"']*)/gi;

  let match: RegExpExecArray | null;
  while ((match = textPattern.exec(html)) !== null) {
    if (!links.includes(match[1])) links.push(match[1]);
  }
  while ((match = hrefPattern.exec(html)) !== null) {
    if (!links.includes(match[1])) links.push(match[1]);
  }

  // Newsletter heuristics
  const signals: string[] = [];
  const msg = this.getMessageById(id);
  if (msg) {
    const lcSender = msg.sender.toLowerCase();
    const lcSubject = msg.subject.toLowerCase();
    if (/mailchimp|substack|constantcontact|campaignmonitor|sendgrid|klaviyo|hubspot/.test(lcSender)) {
      signals.push("Known newsletter sender domain");
    }
    if (/list-unsubscribe/i.test(html)) {
      signals.push("Contains List-Unsubscribe header in source");
    }
    if (/weekly|digest|newsletter|update|bulletin/i.test(lcSubject)) {
      signals.push("Subject contains newsletter keywords");
    }
    if (links.length > 0) {
      signals.push("Unsubscribe link found in HTML");
    }
  }

  return {
    isLikelyNewsletter: signals.length >= 2,
    newsletterSignals: signals,
    unsubscribeLinks: links,
  };
}
```

---

Method 5: getDraftReplyContext

Fetches thread context for a seed message. If `draftBody` is provided, also creates a draft reply. Returns structured context text and optional draft creation result.

```typescript
getDraftReplyContext(
  id: string,
  draftBody?: string,
  maxMessages = 5,
  bodyTruncate = 500,
  account?: string
): { context: string; draftCreated?: boolean } {
  if (!/^\d+$/.test(id)) {
    console.error(`Invalid message ID: "${id}"`);
    return { context: "Error: Invalid message ID." };
  }

  const seed = this.getMessageById(id);
  if (!seed) {
    return { context: "Error: Message not found." };
  }

  const thread = this.getThread(id, account);
  const relevant = thread.length > 0 ? thread.slice(-maxMessages) : [];

  const lines: string[] = [];
  lines.push(`Thread context for reply (${relevant.length} message(s)):`);
  lines.push("");

  if (relevant.length === 0) {
    // Fallback: show seed message only
    const content = this.getMessageContent(id);
    lines.push(`[Message] From: ${seed.sender} | ${seed.dateReceived.toISOString().slice(0, 10)}`);
    lines.push(`Subject: ${seed.subject}`);
    lines.push("---");
    lines.push(content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)");
  } else {
    for (let i = 0; i < relevant.length; i++) {
      const tm = relevant[i];
      const label = i === 0 ? "Original" : `Message ${i + 1}`;
      const content = this.getMessageContent(tm.id);
      lines.push(`[${label}] From: ${tm.sender} | ${tm.dateReceived.toISOString().slice(0, 10)}`);
      lines.push(`Subject: ${tm.subject}`);
      lines.push("---");
      lines.push(content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)");
      lines.push("");
    }
  }

  let draftCreated: boolean | undefined;
  if (draftBody !== undefined && seed.recipients.length > 0) {
    const replyTo = seed.replyTo ?? seed.sender;
    draftCreated = this.createDraft([replyTo], `Re: ${normalizeSubject(seed.subject)}`, draftBody);
  }

  return { context: lines.join("\n"), draftCreated };
}
```

---

Method 6: getThreadSummaryData

Fetches all thread messages with their bodies for Claude to summarise. Similar to getDraftReplyContext but no draft creation, higher default maxMessages.

```typescript
getThreadSummaryData(
  id: string,
  maxMessages = 20,
  bodyTruncate = 1000,
  account?: string
): string {
  if (!/^\d+$/.test(id)) {
    console.error(`Invalid message ID: "${id}"`);
    return "Error: Invalid message ID.";
  }

  const thread = this.getThread(id, account);
  if (thread.length === 0) {
    const seed = this.getMessageById(id);
    if (!seed) return "Error: Message not found.";
    const content = this.getMessageContent(id);
    return [
      `Thread data (1 message — subject too short for thread search or no thread found):`,
      "",
      `[Message] From: ${seed.sender} | ${seed.dateReceived.toISOString().slice(0, 10)}`,
      `Subject: ${seed.subject}`,
      "---",
      content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)",
    ].join("\n");
  }

  const relevant = thread.slice(-maxMessages);
  const lines: string[] = [`Thread data (${relevant.length} message(s)):`, ""];

  for (let i = 0; i < relevant.length; i++) {
    const tm = relevant[i];
    const content = this.getMessageContent(tm.id);
    lines.push(`[${i + 1}] From: ${tm.sender} | ${tm.dateReceived.toISOString().slice(0, 10)}`);
    lines.push(`Subject: ${tm.subject}`);
    lines.push("---");
    lines.push(content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)");
    lines.push("");
  }

  return lines.join("\n");
}
```

---

Method 7: getWaitingFor

Scans the Sent folder for messages with no replies. A reply is defined as: any ThreadMessage in the thread where sender is NOT one of the user's own email addresses AND dateReceived > the sent message's dateReceived.

```typescript
getWaitingFor(
  limit = 20,
  daysAgo = 2,
  account?: string
): WaitingForItem[] {
  // Build set of user's own email addresses
  const accounts = this.listAccounts();
  const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

  // Fetch recent sent messages
  const sentMessages = this.searchMessages(
    undefined,
    "Sent",
    account,
    limit + 20, // fetch extra to account for daysAgo filtering
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    0
  );

  const now = new Date();
  const thresholdMs = daysAgo * 24 * 60 * 60 * 1000;

  const waiting: WaitingForItem[] = [];

  for (const msg of sentMessages) {
    if (waiting.length >= limit) break;

    // Only consider messages older than daysAgo threshold
    const age = now.getTime() - msg.dateReceived.getTime();
    if (age < thresholdMs) continue;

    // Check for replies via thread
    const thread = this.getThread(msg.id, account);
    const hasReply = thread.some(
      (tm) =>
        !userEmails.has(tm.sender.toLowerCase()) &&
        tm.dateReceived.getTime() > msg.dateReceived.getTime()
    );

    if (!hasReply) {
      waiting.push({
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        recipients: msg.recipients,
        dateSent: msg.dateReceived, // dateReceived on sent messages = when sent
        daysWaiting: Math.floor(age / (24 * 60 * 60 * 1000)),
        hasReply: false,
      });
    }
  }

  // Sort oldest first (most overdue)
  waiting.sort((a, b) => a.dateSent.getTime() - b.dateSent.getTime());
  return waiting;
}
```

Note: `getMessageById` is an existing private method used throughout the class. Call it as `this.getMessageById(id)` — do NOT add it as a new method.

After adding all 7 methods, run: `npx tsc --noEmit` — must report zero errors.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit && grep -c "getTriageMessages\|getSummarizeInboxData\|getActionItems\|getUnsubscribeLinks\|getDraftReplyContext\|getThreadSummaryData\|getWaitingFor" src/services/appleMailManager.ts</automated>
  </verify>
  <done>TypeScript compiles clean; grep returns 7 (one match per method definition line). All 7 methods are present in the class body.</done>
</task>

<task type="auto">
  <name>Task 3: Register 7 new MCP tools in src/index.ts</name>
  <files>src/index.ts</files>
  <action>
Insert 7 new tool registrations between the end of the `get-sync-status` tool (currently ending at line 1251) and the `// ============================================================================= \n// Server Startup` comment (currently line 1253). Add a new section comment before the block: `// ============================================================================= \n// Intelligence Layer Tools (Phase 4)\n// =============================================================================`.

Tool descriptions are critical for Claude tool selection — use the exact text below.

---

Tool 1: triage-inbox

```typescript
server.tool(
  "triage-inbox",
  {
    limit: z
      .number()
      .optional()
      .describe("Max unread messages to fetch (default: 20). Keep low if includeSnippets=true — each snippet is one AppleScript call."),
    includeSnippets: z
      .boolean()
      .optional()
      .describe("Fetch first 200 chars of body per message (default: true). Set false for faster results on large inboxes."),
    mailbox: z.string().optional().describe("Mailbox to triage (default: INBOX)"),
    account: z.string().optional().describe("Account to triage (omit for default account)"),
  },
  withErrorHandling(
    ({ limit = 20, includeSnippets = true, mailbox = "INBOX", account }) => {
      const messages = mailManager.getTriageMessages(mailbox, limit, includeSnippets, account);

      if (messages.length === 0) {
        return successResponse("Triage data: 0 unread messages found.");
      }

      const lines: string[] = [
        `Triage data: ${messages.length} unread message(s) in ${mailbox}`,
        "",
        "Classify each as: urgent / FYI / deletable",
        "═══════════════════════════════════════════",
        "",
      ];

      messages.forEach((msg, i) => {
        lines.push(`[${i + 1}] ID: ${msg.id}`);
        lines.push(`  From: ${msg.sender}`);
        lines.push(`  Subject: ${msg.subject}`);
        lines.push(`  Date: ${msg.dateReceived.toISOString().slice(0, 16).replace("T", " ")}`);
        lines.push(`  Flagged: ${msg.isFlagged ? "yes" : "no"} | Attachments: ${msg.hasAttachments ? "yes" : "no"}`);
        if (msg.snippet) lines.push(`  Snippet: "${msg.snippet}"`);
        lines.push("");
      });

      return successResponse(lines.join("\n"));
    },
    "Error triaging inbox"
  )
);
```

---

Tool 2: find-action-items

```typescript
server.tool(
  "find-action-items",
  {
    id: z
      .string()
      .optional()
      .describe("Message ID to scan (single message mode). Provide this OR mailbox, not both."),
    mailbox: z
      .string()
      .optional()
      .describe("Mailbox to scan for action items (default: INBOX). Used when id is not provided."),
    limit: z
      .number()
      .optional()
      .describe("Max messages to scan in mailbox mode (default: 10). Each message is one AppleScript call."),
    account: z.string().optional().describe("Account to scan (omit for default account)"),
  },
  withErrorHandling(
    ({ id, mailbox = "INBOX", limit = 10, account }) => {
      const results = mailManager.getActionItems(id, mailbox, limit, account);

      if (results.length === 0) {
        return successResponse("No messages found for action-item extraction.");
      }

      const lines: string[] = [
        `Action item source data: ${results.length} message(s)`,
        "",
        "Extract to-dos, deadlines, and requests from the bodies below.",
        "═══════════════════════════════════════════════════════════════",
        "",
      ];

      results.forEach((item, i) => {
        lines.push(`[${i + 1}] ID: ${item.id}`);
        lines.push(`  From: ${item.sender}`);
        lines.push(`  Subject: ${item.subject}`);
        lines.push(`  Date: ${item.dateReceived.toISOString().slice(0, 16).replace("T", " ")}`);
        lines.push("  Body:");
        lines.push(item.plainText.split("\n").map((l) => `    ${l}`).join("\n"));
        lines.push("");
      });

      return successResponse(lines.join("\n"));
    },
    "Error finding action items"
  )
);
```

---

Tool 3: summarize-inbox

```typescript
server.tool(
  "summarize-inbox",
  {
    mailbox: z.string().optional().describe("Mailbox to summarize (default: INBOX)"),
    limit: z
      .number()
      .optional()
      .describe("Max unread messages to include in briefing data (default: 30)"),
    account: z.string().optional().describe("Account to summarize (omit for all accounts)"),
  },
  withErrorHandling(
    ({ mailbox = "INBOX", limit = 30, account }) => {
      const { totalUnread, messages } = mailManager.getSummarizeInboxData(mailbox, limit, account);

      const lines: string[] = [
        `Inbox briefing data: ${totalUnread} total unread in ${mailbox}`,
        `Showing ${messages.length} message(s)`,
        "",
        "Produce a concise morning briefing summarizing who wrote, about what, and any notable patterns.",
        "═══════════════════════════════════════════════════════════════════════════════════════════════",
        "",
      ];

      messages.forEach((msg, i) => {
        lines.push(`[${i + 1}] From: ${msg.sender}`);
        lines.push(`    Subject: ${msg.subject}`);
        lines.push(`    Date: ${msg.dateReceived.toISOString().slice(0, 16).replace("T", " ")}`);
        lines.push(`    Flagged: ${msg.isFlagged ? "yes" : "no"} | Attachments: ${msg.hasAttachments ? "yes" : "no"}`);
        lines.push("");
      });

      return successResponse(lines.join("\n"));
    },
    "Error summarizing inbox"
  )
);
```

---

Tool 4: unsubscribe-helper

```typescript
server.tool(
  "unsubscribe-helper",
  {
    id: z.string().describe("Message ID to inspect for unsubscribe links"),
  },
  withErrorHandling(
    ({ id }) => {
      const result = mailManager.getUnsubscribeLinks(id);

      const lines: string[] = [
        `Unsubscribe analysis for message ${id}`,
        "═══════════════════════════════════════",
        "",
        `Likely newsletter: ${result.isLikelyNewsletter ? "YES" : "NO"}`,
      ];

      if (result.newsletterSignals.length > 0) {
        lines.push("");
        lines.push("Newsletter signals:");
        result.newsletterSignals.forEach((s) => lines.push(`  - ${s}`));
      }

      lines.push("");
      if (result.unsubscribeLinks.length === 0) {
        lines.push("No unsubscribe links found in HTML body.");
        lines.push("The email may use a mailto: link or a button not detectable by link regex.");
      } else {
        lines.push(`Unsubscribe link(s) found (${result.unsubscribeLinks.length}):`);
        result.unsubscribeLinks.forEach((link, i) => lines.push(`  [${i + 1}] ${link}`));
        lines.push("");
        lines.push("Confirm with the user which link to use before opening.");
      }

      return successResponse(lines.join("\n"));
    },
    "Error analyzing unsubscribe links"
  )
);
```

---

Tool 5: draft-reply

```typescript
server.tool(
  "draft-reply",
  {
    id: z
      .string()
      .describe("Message ID of the email to reply to (any message in the thread)"),
    draftBody: z
      .string()
      .optional()
      .describe(
        "Reply text to use as the draft body. If provided, creates a draft immediately. If omitted, returns thread context for you to compose the reply."
      ),
    maxMessages: z
      .number()
      .optional()
      .describe("Max thread messages to include in context (default: 5, most recent)"),
    bodyTruncate: z
      .number()
      .optional()
      .describe("Max characters per message body in context (default: 500)"),
    account: z
      .string()
      .optional()
      .describe("Account to scope thread search to (omit to search all accounts)"),
  },
  withErrorHandling(
    ({ id, draftBody, maxMessages = 5, bodyTruncate = 500, account }) => {
      const { context, draftCreated } = mailManager.getDraftReplyContext(
        id,
        draftBody,
        maxMessages,
        bodyTruncate,
        account
      );

      const lines: string[] = [];

      if (draftBody !== undefined) {
        lines.push(
          draftCreated
            ? `Draft reply created successfully. Review it in Mail.app before sending.`
            : `Failed to create draft. Check that Mail.app has the message and that the recipient address is valid.`
        );
        lines.push("");
      }

      lines.push(context);

      if (draftBody === undefined) {
        lines.push("");
        lines.push(
          "To create the draft, call draft-reply again with the same id and your reply text in the draftBody parameter."
        );
      }

      return successResponse(lines.join("\n"));
    },
    "Error preparing draft reply"
  )
);
```

---

Tool 6: summarize-thread

```typescript
server.tool(
  "summarize-thread",
  {
    id: z
      .string()
      .describe("Message ID of any message in the thread to summarize"),
    maxMessages: z
      .number()
      .optional()
      .describe("Max thread messages to include (default: 20, most recent)"),
    bodyTruncate: z
      .number()
      .optional()
      .describe("Max characters per message body (default: 1000)"),
    account: z
      .string()
      .optional()
      .describe("Account to scope thread search to (omit to search all accounts)"),
  },
  withErrorHandling(
    ({ id, maxMessages = 20, bodyTruncate = 1000, account }) => {
      const threadData = mailManager.getThreadSummaryData(id, maxMessages, bodyTruncate, account);

      const lines: string[] = [
        `Thread summary data for message ${id}`,
        "",
        "Summarize this thread in 3-5 sentences: current status, key decisions, and open questions.",
        "═══════════════════════════════════════════════════════════════════════════════════════════",
        "",
        threadData,
      ];

      return successResponse(lines.join("\n"));
    },
    "Error summarizing thread"
  )
);
```

---

Tool 7: detect-waiting-for

```typescript
server.tool(
  "detect-waiting-for",
  {
    limit: z
      .number()
      .optional()
      .describe("Max sent messages to check for replies (default: 20). Each check calls getThread — keep limit reasonable."),
    daysAgo: z
      .number()
      .optional()
      .describe("Only check messages sent at least this many days ago (default: 2 — ignore very recent sends)"),
    account: z
      .string()
      .optional()
      .describe("Account to scan Sent folder for (omit for default account)"),
  },
  withErrorHandling(
    ({ limit = 20, daysAgo = 2, account }) => {
      const items = mailManager.getWaitingFor(limit, daysAgo, account);

      if (items.length === 0) {
        return successResponse(
          `No waiting-for items found. All sent messages in the last ${limit} (sent ${daysAgo}+ days ago) have received replies.`
        );
      }

      const lines: string[] = [
        `Waiting-for list: ${items.length} sent message(s) with no reply`,
        "Sorted oldest first (most overdue at top)",
        "═══════════════════════════════════════════",
        "",
      ];

      items.forEach((item, i) => {
        lines.push(`[${i + 1}] ID: ${item.id}`);
        lines.push(`  Subject: ${item.subject}`);
        lines.push(`  To: ${item.recipients.join(", ")}`);
        lines.push(`  Sent: ${item.dateSent.toISOString().slice(0, 10)}`);
        lines.push(`  Days waiting: ${item.daysWaiting}`);
        lines.push("");
      });

      return successResponse(lines.join("\n"));
    },
    "Error detecting waiting-for items"
  )
);
```

After inserting all 7 tools, run: `npx tsc --noEmit` — must report zero errors. Then run: `npm test` — baseline 104 tests must still pass.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npx tsc --noEmit && npm test 2>&1 | tail -5</automated>
  </verify>
  <done>TypeScript compiles clean; all 104 baseline tests pass; grep confirms all 7 tool names appear in src/index.ts.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Write unit tests in src/__tests__/phase4.test.ts</name>
  <files>src/__tests__/phase4.test.ts</files>
  <behavior>
    - extractUnsubscribeLinks (pure regex logic extracted inline): extracts http link when anchor text contains "unsubscribe"
    - extractUnsubscribeLinks: extracts mailto link when href contains "unsubscribe"
    - extractUnsubscribeLinks: extracts link when href contains "optout"
    - extractUnsubscribeLinks: extracts link when href contains "opt-out"
    - extractUnsubscribeLinks: deduplicates links found by both passes
    - extractUnsubscribeLinks: returns empty array for HTML with no unsubscribe links
    - getUnsubscribeLinks: returns isLikelyNewsletter=false when 0-1 signals match
    - getUnsubscribeLinks: returns isLikelyNewsletter=true when 2+ signals match
    - getTriageMessages: calls listMessages with unreadOnly=true
    - getTriageMessages: calls getMessageContent per message when includeSnippets=true
    - getTriageMessages: does NOT call getMessageContent when includeSnippets=false
    - getTriageMessages: truncates snippet to 200 chars
    - getSummarizeInboxData: calls getUnreadCount and returns totalUnread
    - getSummarizeInboxData: calls listMessages with unreadOnly=true
    - getActionItems (single message): calls getMessageContent for the given id
    - getActionItems (mailbox mode): calls listMessages then getMessageContent per message
    - getDraftReplyContext: returns context string with thread messages
    - getDraftReplyContext: calls createDraft when draftBody is provided
    - getDraftReplyContext: does NOT call createDraft when draftBody is undefined
    - getThreadSummaryData: returns fallback single-message context when getThread returns []
    - getWaitingFor: filters out messages newer than daysAgo threshold
    - getWaitingFor: marks message as waiting when no thread reply from non-self sender exists
    - getWaitingFor: skips message when thread contains reply from non-self sender after sent date
    - getWaitingFor: builds userEmails set from listAccounts
    - getWaitingFor: sorts result oldest-first
  </behavior>
  <action>
Create /Users/michaelhenze/apple-mail-mcp/src/__tests__/phase4.test.ts as a new file.

Use vitest (the existing test framework — no jest imports). Use vi.spyOn to mock AppleMailManager methods. Follow the exact same mock/spy pattern already established in src/__tests__/phase3.test.ts and earlier test files (read phase3.test.ts first to confirm the import and setup style).

The test file must:
1. Import `{ describe, it, expect, vi, beforeEach }` from "vitest"
2. Import `{ AppleMailManager }` from "@/services/appleMailManager.js"
3. Create a fresh `new AppleMailManager()` instance in each `describe` block's `beforeEach`
4. Use `vi.spyOn(manager, 'methodName').mockReturnValue(...)` for mocking — the same pattern used in phase3.test.ts
5. Test the regex logic for unsubscribe link extraction by calling `getUnsubscribeLinks` with a mocked `getMessageContent` that returns controlled HTML
6. For `getWaitingFor` tests, mock `listAccounts`, `searchMessages`, and `getThread`

Cover all behaviors listed in the `<behavior>` block above (25 test cases minimum).

After creating the file, run: `npm test` — all tests (104 baseline + new) must pass.
  </action>
  <verify>
    <automated>cd /Users/michaelhenze/apple-mail-mcp && npm test 2>&1 | grep -E "Tests:|passed|failed"</automated>
  </verify>
  <done>npm test output shows all tests passing with a count higher than 104. Zero failures. src/__tests__/phase4.test.ts exists with at least 25 test cases.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Apple Mail → MCP server | Message content (subject, body, HTML) from Mail.app is untrusted user data. Never eval or execute it. |
| MCP server → Claude | Structured text returned to the caller. No HTML rendering occurs on this side. |
| draftBody parameter → createDraft | User-supplied draft text passes through escapeForAppleScript before embedding in AppleScript. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-01 | Tampering | getUnsubscribeLinks / HTML regex | accept | HTML body is read-only; regex extracts URLs, never executes them. Links are returned as strings for user confirmation before any action. |
| T-04-02 | Information Disclosure | getActionItems / plainText return | accept | plainText is already accessible via get-message. Phase 4 aggregates it; no new exposure surface. |
| T-04-03 | Tampering | getDraftReplyContext / draftBody | mitigate | draftBody passes through existing escapeForAppleScript() in createDraft() before AppleScript embedding. No additional escaping needed — escapeForAppleScript already handles backslashes and quotes. |
| T-04-04 | Denial of Service | getTriageMessages / includeSnippets=true | mitigate | Default limit=20 caps AppleScript calls. Documented in tool description. User can set includeSnippets=false for large inboxes. |
| T-04-05 | Denial of Service | getWaitingFor / O(N) getThread calls | mitigate | Default limit=20 caps getThread calls. daysAgo=2 reduces candidates from very large Sent folders. |
| T-04-06 | Spoofing | getWaitingFor / self-reply detection | mitigate | Build Set from listAccounts().map(a => a.email.toLowerCase()). Comparison is case-insensitive to handle mixed-case sender addresses. |
| T-04-SC | Tampering | npm/pip/cargo installs | accept | No new packages installed in Phase 4. Supply chain threat does not apply. |
</threat_model>

<verification>
Run the following after all 4 tasks complete:

```bash
cd /Users/michaelhenze/apple-mail-mcp
npx tsc --noEmit
npm test
grep -c "server.tool" src/index.ts   # should be 42 (35 existing + 7 new)
grep -c "interface TriageMessage\|interface ActionItemsResult\|interface WaitingForItem" src/types.ts  # should be 3
```

All checks must pass before marking phase complete.
</verification>

<success_criteria>
- npx tsc --noEmit exits 0 with zero errors
- npm test shows all tests passing (baseline 104 + new phase4 tests, 0 failures)
- All 7 tools appear in src/index.ts: triage-inbox, find-action-items, summarize-inbox, unsubscribe-helper, draft-reply, summarize-thread, detect-waiting-for
- All 7 service methods appear in src/services/appleMailManager.ts
- All 3 new interfaces appear in src/types.ts
- src/__tests__/phase4.test.ts exists with at least 25 test cases
- No new entries in package.json dependencies (zero new npm packages)
</success_criteria>

<output>
Create `.planning/phases/phase-4/04-01-SUMMARY.md` when done, following the summary template.
</output>
