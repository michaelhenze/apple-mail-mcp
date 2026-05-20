# Phase 4: Intelligence Layer - Research

**Researched:** 2026-05-20
**Domain:** MCP server tool design, data aggregation, HTML parsing, AppleScript Sent folder access
**Confidence:** HIGH

---

## Summary

Phase 4 adds seven "intelligence" tools to the apple-mail-mcp server. The critical architectural question is whether these tools should call the Anthropic API themselves (server-side synthesis) or return rich structured data for the calling Claude to reason over (data-pass-through). Based on deep codebase inspection, this server has zero external HTTP dependencies — it is a pure AppleScript bridge with no network calls. Adding Anthropic API calls would introduce credentials management, latency, and model coupling that are entirely unnecessary: **the calling Claude IS the intelligence layer.**

The correct pattern — confirmed by inspecting the existing tool contracts and how Claude uses them — is data-pass-through. Each tool fetches, normalizes, and structures email data; Claude performs all classification, summarization, and drafting. This keeps the server stateless, free of API keys, and consistent with every existing tool.

Five of the seven tools are pure data-aggregation work (triage-inbox, find-action-items, summarize-inbox, summarize-thread, detect-waiting-for). One is a regex/HTML-extraction problem (unsubscribe-helper). One is a composition orchestration problem (draft-reply). None require server-side LLM calls.

**Primary recommendation:** Implement all seven tools as data-pass-through. Each tool fetches and structures email content; Claude applies reasoning. No external API calls, no new npm dependencies.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Inbox triage / classification | Claude (caller) | MCP server (data fetch) | Classification requires reasoning; server only fetches structured data |
| Action item extraction | Claude (caller) | MCP server (data fetch) | NLP extraction is Claude's job; server returns body text |
| Inbox summarization | Claude (caller) | MCP server (data fetch) | Summarization is Claude's job; server aggregates message list |
| Unsubscribe link extraction | MCP server (regex) | Claude (caller, fallback) | Link extraction is deterministic regex over HTML — no LLM needed |
| Reply drafting | Claude (caller) | MCP server (thread fetch + create-draft) | Draft content is Claude's job; server assembles thread context and creates draft |
| Thread summarization | Claude (caller) | MCP server (data fetch) | Summary generation is Claude's job; get-thread already exists |
| Waiting-for detection | MCP server (Sent + INBOX cross-reference) | Claude (caller, ranking) | Cross-mailbox matching is server logic; ranking/commentary is Claude |

---

## Critical Architecture Decision

### Server-Side Synthesis vs. Data-Pass-Through

**Question:** Should these tools call the Anthropic API themselves to generate triage verdicts, summaries, etc.?

**Evidence from codebase:**
- `package.json` has zero HTTP client dependencies — no `axios`, `node-fetch`, `@anthropic-ai/sdk`. [VERIFIED: package.json inspection]
- All 35+ existing tools follow a single pattern: fetch data via AppleScript, format as text, return. [VERIFIED: src/index.ts inspection]
- The server communicates over stdio (StdioServerTransport). The calling Claude already has full reasoning capabilities.
- Adding Anthropic API calls would require: `ANTHROPIC_API_KEY` in server env, error handling for API failures, latency (API round-trip inside tool execution), and model version coupling.

**What other MCP servers do:** [ASSUMED]
MCP servers designed for AI assistants almost universally use the data-pass-through pattern for "intelligence" tools. The server provides data; the model provides reasoning. This is the architectural intent of MCP.

**Decision: Data-pass-through for all seven tools.**

The calling Claude (the one that invoked the MCP tool) reads the returned structured data and applies its own reasoning. No Anthropic API calls in the server.

**Tradeoff summary:**

| Dimension | Server-Side Synthesis | Data-Pass-Through |
|-----------|----------------------|-------------------|
| Requires API key in server env | Yes | No |
| Added latency | ~1-3s per call | None |
| Model coupling (must choose a model) | Yes | No |
| Cost duplication (two LLM calls) | Yes | No |
| Consistent with existing codebase | No | Yes |
| Works with any calling AI | No | Yes |

---

## Standard Stack

### No New Dependencies Required

All seven tools can be implemented with what already exists in the codebase. This is confirmed by inspecting `package.json`. [VERIFIED: package.json inspection]

| Capability | Implementation | Existing In Codebase |
|------------|---------------|---------------------|
| Fetch unread messages | `listMessages()` / `searchMessages()` | Yes (Phase 2) |
| Get message body (plain + HTML) | `getMessageContent()` — returns `plainText` + `htmlContent` | Yes (Phase 2) |
| Get full thread | `getThread()` | Yes (Phase 3) |
| Extract links from HTML | Regex on `htmlContent` string — Node.js built-in | No new dep needed |
| Search Sent folder | `searchMessages(mailbox="Sent")` — resolveMailbox handles aliases | Yes (Phase 1+2) |
| Create draft from tool output | `createDraft()` | Yes (Phase 2) |

**No npm packages need to be installed for Phase 4.**

The only potential optional dependency is an HTML parser (e.g., `node-html-parser`) for more robust unsubscribe link extraction — but a targeted regex on `href` attributes in the `htmlContent` string is sufficient for the unsubscribe-helper use case and avoids adding dependencies. [ASSUMED — regex sufficiency estimate based on List-Unsubscribe header + mailto/http link patterns in newsletters]

### Package Legitimacy Audit

> No external packages are being added in Phase 4. This section is not applicable.

No new packages to audit.

---

## Per-Tool Implementation Analysis

### Tool 1: `triage-inbox`

**Purpose:** Return a structured priority list of unread messages: urgent / FYI / deletable.

**Data required per message:** id, subject, sender, dateReceived, isRead, hasAttachments, snippet (first ~200 chars of plainText). The full body per message is too expensive for 50+ messages.

**Implementation approach:**
1. Call `listMessages(mailbox="INBOX", unreadOnly=true, limit=N)` — returns `Message[]` with id/subject/sender/date/flags.
2. For each message, optionally fetch a short `plainText` snippet via `getMessageContent()`. This is O(N) AppleScript calls — expensive for large inboxes. Mitigate with a configurable `limit` (default 20) and optional `includeSnippets` boolean.
3. Format output as structured sections: one JSON-like block per message with all fields Claude needs to classify.
4. Return the formatted list. Claude classifies each message as urgent/FYI/deletable in its response.

**Output format (returned to Claude):**

```
Triage data: 18 unread messages in INBOX

[1] ID: 12345
  From: boss@company.com
  Subject: URGENT: Q2 Review Tomorrow
  Date: 2026-05-20 09:15
  Snippet: "Hi Michael, just a reminder that the Q2 review is tomorrow..."
  Has attachments: no

[2] ID: 12346
  From: newsletter@substack.com
  Subject: Weekly Digest: Top stories
  ...
```

Claude then applies triage logic. No classification in the server.

**Key parameter:** `limit` (default 20 — fetching body snippets for 50+ messages is too slow). `includeSnippets: boolean` (default true — needed for Claude to triage effectively, but expensive).

**Risk:** If `includeSnippets=true` and inbox has 50 messages, this is 50 AppleScript calls, potentially 30-60 seconds. Mitigate with a low default limit and clear documentation. [ASSUMED — latency estimate based on single getMessageContent call taking ~0.5-1s in typical AppleScript]

---

### Tool 2: `find-action-items`

**Purpose:** Scan a message or mailbox for to-dos and return a structured list.

**Body format confirmed:** `getMessageContent()` returns both `plainText` and `htmlContent`. [VERIFIED: src/services/appleMailManager.ts lines 622-674] The `plainText` field is the `content` AppleScript property — Apple Mail's rendered plain text of the message. For most emails this is sufficient for action item detection without HTML parsing.

**Implementation approach (single message mode):**
1. Call `getMessageContent(id)` to get `plainText`.
2. Return `plainText` plus metadata (subject, sender, date) as structured text.
3. Claude identifies action items and returns them labeled.

**Implementation approach (mailbox mode):**
1. Call `listMessages(mailbox, limit=N)` to get message list.
2. For each message, call `getMessageContent(id)` to get body.
3. Aggregate all bodies with message metadata as a structured block.
4. Return to Claude for extraction.

**Parameters:** `id` (single message, optional), `mailbox` (scan mailbox, optional — default INBOX), `limit` (default 10 for mailbox mode).

**Note:** Does NOT require HTML parsing. `plainText` from AppleScript's `content` property is already plain text. [VERIFIED: getMessageContent AppleScript uses `content of msg` not `source of msg`]

---

### Tool 3: `summarize-inbox`

**Purpose:** Concise daily briefing of unread mail.

**Structural difference from triage-inbox:** Same underlying data, different framing. `triage-inbox` returns per-message priority metadata. `summarize-inbox` returns a briefing paragraph. The data fetch is identical.

**Implementation approach:**
1. Call `listMessages(mailbox="INBOX", unreadOnly=true, limit=N)` — `Message[]` list.
2. Also call `getUnreadCount()` for totals.
3. Format all messages as a structured list (same as triage-inbox but without snippets — subject+sender+date is enough for a summary).
4. Return structured list. Claude produces the briefing paragraph.

**No overlap concern:** `triage-inbox` and `summarize-inbox` fetch the same data but serve different intents. The planner should implement them as separate tools (users understand "triage" as actionable, "summarize" as informational).

**Parameters:** `mailbox` (default INBOX), `limit` (default 30).

---

### Tool 4: `unsubscribe-helper`

**Purpose:** Detect newsletters, extract unsubscribe links from HTML body.

**Body format:** `htmlContent` from `getMessageContent()` is the raw HTML source (`source of msg` in AppleScript). [VERIFIED: src/services/appleMailManager.ts lines 638-643]

**Two unsubscribe signal sources:**

1. **List-Unsubscribe header** — RFC 2369 standard. Most legitimate senders include `List-Unsubscribe: <https://...>` or `List-Unsubscribe: <mailto:...>`. AppleScript's `content of msg` does NOT include raw headers. Headers are not currently fetched anywhere in the codebase. [VERIFIED: getMessageContent AppleScript — no header extraction]

2. **HTML body links** — Extract `<a href="...">` elements where the link text or surrounding context contains "unsubscribe". Regex over `htmlContent`.

**Recommended implementation:** HTML regex approach (immediately available) with List-Unsubscribe header as a future enhancement.

**HTML regex pattern for unsubscribe links:**
```
/<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*unsubscribe[^<]*<\/a>/gi
```
Also check: `href` values containing `unsubscribe`, `optout`, `opt-out`, `remove` as fallback.

**Newsletter detection heuristics (server-side, no LLM needed):**
- `sender` contains known newsletter domains (Substack, Mailchimp, etc.) — [ASSUMED]
- `htmlContent` contains `List-Unsubscribe` string anywhere in the source
- Subject patterns: "Weekly", "Digest", "Newsletter", "Update"
- These are signal-based; Claude can confirm/deny the classification

**Implementation approach:**
1. Accept `id` parameter (single message).
2. Call `getMessageContent(id)` to get `htmlContent`.
3. Run regex to extract all unsubscribe-candidate links.
4. Return: isLikelyNewsletter (boolean, based on heuristics), unsubscribeLinks array (URL strings).
5. Claude presents findings to user with confirmation step.

**Parameters:** `id` (required).

**Important edge case:** Some newsletters use `mailto:` unsubscribe links, not HTTP. The regex must handle both schemes.

---

### Tool 5: `draft-reply`

**Purpose:** Suggest a reply draft based on thread context.

**Implementation approach — two-step orchestration:**
1. The tool fetches thread context (using `getThread(id)`) — returns `ThreadMessage[]` (id, subject, sender, date, mailbox, account).
2. For each thread message, fetch body via `getMessageContent(id)`.
3. Return all thread messages with bodies as structured text.
4. Claude generates reply text from the thread context.
5. Optionally: tool can also call `createDraft()` with Claude's reply content — but this requires Claude to first call `draft-reply` to get context, then call `create-draft` separately with the generated text.

**Design choice:** `draft-reply` should return thread context for Claude to reason over. The actual draft creation happens via the existing `create-draft` tool in a second call. This keeps responsibilities clean.

Alternatively, `draft-reply` could accept an optional `draftBody` parameter: if provided, it creates the draft; if not, it returns context only. This single-tool pattern is more ergonomic for the caller.

**Recommended design:** Two-parameter mode:
- `draft-reply(id)` — returns thread context as structured text (Claude reads and generates reply)
- `draft-reply(id, draftBody="...")` — creates actual draft using `createDraft()`

**Parameters:** `id` (required — seed message ID), `draftBody` (optional — if provided, creates draft immediately).

**Data returned when no draftBody:**
```
Thread context for reply (4 messages):

[Original] From: sender@example.com | 2026-05-18
Subject: Project update
---
Body text here...

[Reply 1] From: me@gmail.com | 2026-05-19
Subject: Re: Project update
---
Body text here...
```

**Risk:** Thread with many long messages may produce very large output. Add `maxMessages` param (default 5 — last 5 messages) and `bodyTruncate` (default 500 chars per message). [ASSUMED — reasonable defaults]

---

### Tool 6: `summarize-thread`

**Purpose:** Collapse a long thread into a 3-5 sentence summary with current status and open questions.

**Implementation approach:**
1. Call `getThread(id)` to get thread `ThreadMessage[]`.
2. For each thread message, call `getMessageContent(id)` to get body.
3. Format all messages with bodies as structured text (same as `draft-reply` context fetch).
4. Return to Claude with instruction framing: "Here is the full thread. Summarize in 3-5 sentences including current status and open questions."

The framing instruction can live in the tool description (visible to Claude in the MCP tool manifest) rather than in the output.

**Key difference from `draft-reply`:** No `draftBody` parameter. Always returns data only.

**Parameters:** `id` (required), `account` (optional — passed to `getThread`), `maxMessages` (optional, default 20).

**Note:** `getThread` may return 0 messages for subjects shorter than 10 characters (see Phase 3 limitation in getThread). The tool should handle this gracefully and return a clear message. [VERIFIED: src/services/appleMailManager.ts line 1429]

---

### Tool 7: `detect-waiting-for`

**Purpose:** Scan sent mail for messages where no reply has arrived, ranked by how overdue they are.

**The "no reply received" definition:**

A sent message has no reply if: after scanning all mailboxes, no message exists with a normalized subject matching `"Re: " + baseSubject` AND `dateReceived > sent message's dateReceived`.

**Implementation approach:**

1. Call `searchMessages(mailbox="Sent", limit=N)` to get recent sent messages. The `resolveMailbox()` method handles Sent/Sent Items/Sent Messages aliases. [VERIFIED: MAILBOX_ALIASES at line 105]
2. For each sent message, call `getThread(id)` to check if any replies exist.
3. A reply exists if the thread contains any message with a different sender AND `dateReceived > sent message date`.
4. Messages with no replies are "waiting-for" candidates.
5. Sort by `dateSent` ascending (oldest sent message = most overdue).
6. Return structured list with: id, subject, recipient(s), dateSent, daysWaiting.

**Key AppleScript consideration:** `searchMessages` on the Sent mailbox returns messages where `sender` is the user's own address. Thread detection via `getThread` will find replies by looking for subject matches across all mailboxes. [ASSUMED — getThread searches all mailboxes when no account specified]

**Scalability concern:** If Sent folder has 1000 messages and we check replies for each via getThread (which scans all mailboxes), this is O(N * M) AppleScript calls. Mitigate with `limit` (default 20 most recent sent messages) and a minimum `daysAgo` threshold (default: only messages sent 2+ days ago are worth checking). [ASSUMED — performance heuristic]

**Parameters:** `limit` (default 20), `daysAgo` (minimum days since sent, default 2 — ignore messages sent today/yesterday), `account` (optional).

**Reply detection logic (pure TypeScript — no extra AppleScript):**
```typescript
// threadMessages from getThread(sentMsg.id)
const hasReply = threadMessages.some(
  tm => tm.sender !== userEmail && 
        tm.dateReceived > sentMsg.dateReceived
);
```

The user's email is available from `resolveAccount()` → account → email, but the `Account` type has an `email` field. [VERIFIED: types.ts Account interface line 147] We need to fetch the user's email address for the sending account. `listAccounts()` returns `Account[]` with `email` field — use this to identify "self" messages.

---

## Data Flow Diagrams

### triage-inbox / summarize-inbox

```
Claude calls tool
    |
    v
listMessages(INBOX, unreadOnly=true, limit=N) [AppleScript]
    |
    v
[optional] getMessageContent(id) per message [AppleScript x N]
    |
    v
Format: structured text block per message
    |
    v
Return to Claude
    |
    v
Claude applies triage/summary reasoning
    |
    v
Claude responds to user
```

### unsubscribe-helper

```
Claude calls tool(id)
    |
    v
getMessageContent(id) [AppleScript]
    |-- plainText
    |-- htmlContent (raw HTML source)
    |
    v
Regex extraction (Node.js, no new deps)
    |- unsubscribe link candidates from <a href>
    |- newsletter heuristics (sender domain, keywords)
    |
    v
Return: { isLikelyNewsletter, unsubscribeLinks[], heuristics }
    |
    v
Claude presents to user with confirmation step
```

### detect-waiting-for

```
Claude calls tool(limit, daysAgo)
    |
    v
searchMessages(mailbox="Sent", limit=limit) [AppleScript]
    |
    v
Filter: dateReceived < (now - daysAgo days) [TypeScript]
    |
    v
For each sent message:
    getThread(id) [AppleScript]
    Check for replies (sender != me, date > sent date) [TypeScript]
    |
    v
Collect messages with no replies
Sort by dateSent ascending (oldest = most overdue)
    |
    v
Return structured list: id, subject, to, dateSent, daysWaiting
    |
    v
Claude presents ranked list to user
```

---

## Existing Infrastructure Available

| Method | Location | Returns | Phase 4 Use |
|--------|----------|---------|-------------|
| `listMessages()` | appleMailManager.ts | `Message[]` | triage-inbox, summarize-inbox |
| `getMessageContent()` | appleMailManager.ts | `MessageContent` with `plainText` + `htmlContent` | find-action-items, unsubscribe-helper, draft-reply, summarize-thread |
| `searchMessages()` | appleMailManager.ts | `Message[]` | detect-waiting-for (Sent folder) |
| `getThread()` | appleMailManager.ts | `ThreadMessage[]` | draft-reply, summarize-thread, detect-waiting-for |
| `getUnreadCount()` | appleMailManager.ts | `number` | summarize-inbox |
| `createDraft()` | appleMailManager.ts | `boolean` | draft-reply (when draftBody provided) |
| `listAccounts()` | appleMailManager.ts | `Account[]` (with email) | detect-waiting-for (identify self) |
| `resolveMailbox()` | appleMailManager.ts (private) | `string` | Sent folder resolution — already used internally |
| `normalizeSubject()` | appleMailManager.ts (exported) | `string` | detect-waiting-for, duplicate filtering |

**Confirmed: `htmlContent` is raw HTML source** — AppleScript `source of msg` returns the full raw HTML of the email. Available via `getMessageContent().htmlContent`. [VERIFIED: appleMailManager.ts lines 638-643]

**Confirmed: `plainText` is Mail.app rendered content** — AppleScript `content of msg` returns Mail.app's plain text rendering. Available via `getMessageContent().plainText`. [VERIFIED: appleMailManager.ts lines 636-637]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Thread retrieval | Custom subject-match scanner | `getThread()` (Phase 3) |
| Draft creation | New AppleScript draft logic | `createDraft()` (Phase 2) |
| Subject normalization | Custom prefix stripper | `normalizeSubject()` (exported from appleMailManager.ts) |
| Sent folder name resolution | Hard-coded "Sent" | `resolveMailbox("Sent", account)` (already handles aliases: "Sent", "Sent Items", "Sent Messages") |
| Message triage classification | Server-side LLM call | Return data to calling Claude |
| HTML parsing library | `node-html-parser` or `cheerio` | Targeted regex on `htmlContent` string |
| Link extraction | DOM walking | `/<a[^>]+href=["']([^"']+)["'][^>]*>/gi` regex |

---

## Common Pitfalls

### Pitfall 1: Expensive Body Fetch for Inbox Scans

**What goes wrong:** `getMessageContent()` makes one full AppleScript execution per message. For triage-inbox with 50 messages and `includeSnippets=true`, this is 50+ round-trips to AppleScript — potentially 30-90 seconds.

**Why it happens:** There is no batch content fetch in the current AppleScript layer. Each `getMessageContent` call spawns a separate `osascript` process.

**How to avoid:** Default limits of 15-20 for tools that fetch bodies. Provide `includeSnippets: boolean` option (default true) with documentation. For triage-inbox and summarize-inbox, the subject/sender/date alone is often sufficient for Claude to triage.

**Warning signs:** Tool timeout (current `executeAppleScript` default timeout), user reporting slow responses.

### Pitfall 2: getThread Returns Empty for Short Subjects

**What goes wrong:** `getThread()` returns `[]` and logs a warning for subjects shorter than 10 characters. `summarize-thread` and `draft-reply` silently fail.

**Why it happens:** Phase 3 deliberately gates on 10-char minimum to avoid false positives. [VERIFIED: appleMailManager.ts line 1429]

**How to avoid:** All tools that call `getThread()` must check for empty return and surface a clear message: "Thread retrieval skipped — subject too short to search safely."

### Pitfall 3: detect-waiting-for Misidentifies Own Replies

**What goes wrong:** The Sent folder may contain both outgoing messages AND your own replies (when you replied to yourself). Thread detection using `sender != userEmail` breaks if `userEmail` is fetched from the wrong account.

**Why it happens:** Multi-account setups. The sent message's `account` field identifies which account sent it. Use `listAccounts()` to build an email → account name map, then match by account.

**How to avoid:** Fetch `listAccounts()` once, build a Set of user's email addresses, filter thread messages using that Set.

### Pitfall 4: HTML Regex Missing Obfuscated Unsubscribe Links

**What goes wrong:** Some newsletters encode unsubscribe URLs across multiple lines, inside table cells with complex attributes, or use CSS classes instead of link text for "Unsubscribe" labels.

**Why it happens:** HTML email bodies are notoriously complex and inconsistently structured.

**How to avoid:** Use both text-match approach (link text contains "unsubscribe") AND href-match approach (href contains "unsubscribe", "optout", "opt-out"). Return ALL candidate links with context, let Claude help the user confirm the right one.

### Pitfall 5: draft-reply Thread Body Overflow

**What goes wrong:** A thread with 20 messages each 2KB body = 40KB returned to Claude, hitting context limits or causing very slow tool calls.

**Why it happens:** No truncation in the thread body fetch loop.

**How to avoid:** Default `maxMessages=5` (last 5 messages), `bodyTruncate=500` chars per message. These are sufficient for Claude to understand thread context and draft a reply.

### Pitfall 6: Tool Description Framing Matters

**What goes wrong:** Claude uses the wrong tool for an intent (e.g., uses `summarize-inbox` when user wants actionable triage).

**Why it happens:** MCP tool descriptions drive Claude's tool selection. Vague descriptions cause wrong choices.

**How to avoid:** Write precise, intent-differentiated descriptions:
- `triage-inbox`: "Returns structured data for each unread message so you can classify them as urgent/FYI/deletable. Use when the user wants to process their inbox."
- `summarize-inbox`: "Returns unread message data for a concise morning briefing. Use when the user wants an overview, not action items."

---

## Architecture Patterns

### Pattern 1: Structured Data Return (All Tools)

All seven tools return structured plain text that Claude can parse and reason over. Format is consistent with existing tools (natural language with clear labeling).

```typescript
// In src/index.ts — tool handler pattern (same as all existing tools)
server.tool(
  "triage-inbox",
  {
    limit: z.number().optional().describe("Max unread messages to fetch (default: 20)"),
    includeSnippets: z.boolean().optional().describe("Fetch body snippets (default: true, slower)"),
    mailbox: z.string().optional().describe("Mailbox to triage (default: INBOX)"),
  },
  withErrorHandling(({ limit = 20, includeSnippets = true, mailbox = "INBOX" }) => {
    // ... data fetch ...
    return successResponse(formattedText);
  }, "Error triaging inbox")
);
```

### Pattern 2: HTML Link Extraction (unsubscribe-helper)

```typescript
// No external dependency — regex on htmlContent string
function extractUnsubscribeLinks(html: string): string[] {
  const links: string[] = [];
  // Match links where text contains unsubscribe variants
  const textPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:unsubscribe|opt.out|remove)[^<]*<\/a>/gi;
  // Match links where href contains unsubscribe variants  
  const hrefPattern = /href=["']([^"']*(?:unsubscribe|optout|opt-out|remove)[^"']*)/gi;
  
  let match;
  while ((match = textPattern.exec(html)) !== null) links.push(match[1]);
  while ((match = hrefPattern.exec(html)) !== null) {
    if (!links.includes(match[1])) links.push(match[1]);
  }
  return links;
}
```

### Pattern 3: detect-waiting-for Cross-Reference

```typescript
// TypeScript logic — no extra AppleScript
function hasReply(threadMessages: ThreadMessage[], sentMsg: Message, userEmails: Set<string>): boolean {
  return threadMessages.some(
    tm => !userEmails.has(tm.sender.toLowerCase()) &&
          tm.dateReceived.getTime() > sentMsg.dateReceived.getTime()
  );
}
```

### Recommended Project Structure (no changes needed)

All Phase 4 tools follow the same pattern as every prior phase:
- New method(s) on `AppleMailManager` in `src/services/appleMailManager.ts`
- New tool registration(s) in `src/index.ts`
- New test suite `src/__tests__/phase4.test.ts`
- Type additions to `src/types.ts` if needed

```
src/
├── index.ts                  # Add 7 tool registrations
├── types.ts                  # Add TriageEntry, WaitingForEntry types if desired
├── services/
│   └── appleMailManager.ts   # Add 6-7 new methods
└── __tests__/
    └── phase4.test.ts        # New test suite
```

---

## Recommended Implementation Order

Ordered by data dependency and incremental testability:

| Order | Tool | Depends On | Rationale |
|-------|------|-----------|-----------|
| 1 | `summarize-inbox` | `listMessages` | Simplest — no body fetch, just message list formatting |
| 2 | `triage-inbox` | `listMessages` + `getMessageContent` | Adds optional body snippet fetch |
| 3 | `find-action-items` | `getMessageContent` | Single message body fetch, clean boundaries |
| 4 | `unsubscribe-helper` | `getMessageContent` (htmlContent) | Adds HTML regex — isolatable, testable in pure TS |
| 5 | `summarize-thread` | `getThread` + `getMessageContent` | Thread-aware body aggregation |
| 6 | `draft-reply` | `getThread` + `getMessageContent` + `createDraft` | Extends summarize-thread with draft creation |
| 7 | `detect-waiting-for` | `searchMessages(Sent)` + `getThread` + `listAccounts` | Most complex cross-reference logic |

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|-----------------|--------|
| Fetch message body separately from metadata | Phase 2 wired both `plainText` and `htmlContent` into `getMessageContent()` | Phase 4 can get all needed content in one call |
| Thread traversal required custom logic | Phase 3 `getThread()` handles subject normalization and deduplication | Phase 4 `draft-reply` and `summarize-thread` call `getThread()` directly |
| Sent folder aliases handled inconsistently | Phase 1 `resolveMailbox()` + `MAILBOX_ALIASES` handles "Sent", "Sent Items", "Sent Messages" | `detect-waiting-for` can use `searchMessages(mailbox="Sent")` safely |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.0.0 |
| Config file | none (detected via package.json scripts) |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map

| Tool | Behavior | Test Type | Notes |
|------|----------|-----------|-------|
| `extractUnsubscribeLinks` | Extracts http/mailto links from HTML | Unit | Pure function — testable without AppleScript mock |
| `triage-inbox` handler | Returns formatted message list | Unit | Mock `listMessages` + `getMessageContent` |
| `find-action-items` handler | Returns message body + metadata | Unit | Mock `getMessageContent` |
| `summarize-inbox` handler | Returns unread message list | Unit | Mock `listMessages` |
| `unsubscribe-helper` handler | Returns links + newsletter signals | Unit | Mock `getMessageContent`, test regex inline |
| `draft-reply` (data mode) | Returns thread context | Unit | Mock `getThread` + `getMessageContent` |
| `draft-reply` (create mode) | Creates draft, returns confirmation | Unit | Mock `createDraft` |
| `summarize-thread` handler | Returns all thread messages with bodies | Unit | Mock `getThread` + `getMessageContent` |
| `detect-waiting-for` | Returns unanswered sent messages | Unit | Mock `searchMessages` + `getThread` + `listAccounts` |
| Newsletter heuristics | Detects Mailchimp/Substack patterns | Unit | Pure TS, no mocks needed |

### Wave 0 Gaps

- [ ] `src/__tests__/phase4.test.ts` — new test suite, does not exist yet

### Sampling Rate
- **Per task commit:** `npm test`
- **Phase gate:** All tests green before marking phase complete

---

## Open Questions

1. **`draft-reply` — one tool or two?**
   - What we know: Having `draft-reply(id)` return context AND `draft-reply(id, draftBody)` create a draft in one tool is ergonomic but puts two responsibilities in one tool.
   - What's unclear: Whether users prefer calling `create-draft` separately after getting context, or want the draft creation in the same tool invocation.
   - Recommendation: Single tool with optional `draftBody` param. If present, create draft and return confirmation. If absent, return thread context. This matches the `reply-to-message` pattern (has `send: boolean` optional param).

2. **`triage-inbox` body fetch — opt-in or opt-out?**
   - What we know: Body fetch is O(N) AppleScript calls, slow for large inboxes. Subject+sender alone may be sufficient for Claude to triage.
   - What's unclear: What the user's typical inbox size is.
   - Recommendation: `includeSnippets: boolean` (default `true`) with explicit documentation about performance. Limit default to 20 messages.

3. **`detect-waiting-for` — what counts as a "reply"?**
   - What we know: Thread matching uses subject prefix normalization via `normalizeSubject()`. A "reply" is any message in the thread from a different sender, after the sent date.
   - What's unclear: BCC replies (user replies via a different account), auto-responses (vacation messages).
   - Recommendation: Use the simple heuristic (different sender, later date). False positives (auto-replies counted as replies) are acceptable — the user can review the list.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js built-in `fs`, `path`, `os` | Template system (already used) | Yes | N/A | — |
| `osascript` | All AppleScript execution | Yes (macOS) | macOS 25.4.0 | — |
| `execSync` (child_process) | getVipMessages (Phase 3) | Yes | Node.js built-in | — |
| vitest | Test runner | Yes | ^2.0.0 (package.json) | — |

No missing dependencies.

---

## Security Domain

The seven new tools are read-mostly data aggregation tools with one write operation (`draft-reply` with `draftBody`).

| ASVS Category | Applies | Control |
|---------------|---------|---------|
| V5 Input Validation | Yes | Message IDs validated with `/^\d+$/` regex (existing pattern) |
| V5 HTML injection | No | HTML is read and link-extracted, never rendered or injected back |
| V5 Input truncation | Yes | `bodyTruncate` and `limit` params prevent context overflow |
| V4 Access Control | No | Local AppleScript — no network, no auth tokens |
| V6 Cryptography | No | No credentials, no encryption needed |

**Draft creation (draft-reply):** Uses existing `createDraft()` which is already tested and secured. The `draftBody` parameter is plain text that goes through `escapeForAppleScript()` before being embedded in AppleScript. [VERIFIED: sendEmail/createDraft use escapeForAppleScript]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Regex approach sufficient for unsubscribe link extraction (no HTML parser library needed) | unsubscribe-helper | Some newsletters with complex HTML may not yield links; tool returns empty array instead of partial results |
| A2 | MCP servers for AI assistants use data-pass-through pattern, not server-side synthesis | Architecture Decision | No material risk — decision is correct regardless of what other servers do |
| A3 | triage-inbox body fetch ~0.5-1s per message | Pitfall 1 | If faster, default limit can be higher; if slower, user experience suffers |
| A4 | Default maxMessages=5 and bodyTruncate=500 sufficient for draft-reply context | draft-reply | If too small, Claude may lack context; can be tuned by user |
| A5 | detect-waiting-for default limit=20, daysAgo=2 are reasonable | detect-waiting-for | If wrong, easily configurable by caller |
| A6 | Newsletter sender domain detection by heuristics (Mailchimp, Substack patterns) | unsubscribe-helper | Heuristics are best-effort; Claude provides fallback classification |

---

## Sources

### Primary (HIGH confidence)
- `/Users/michaelhenze/apple-mail-mcp/src/services/appleMailManager.ts` — all method signatures, AppleScript patterns, data return shapes
- `/Users/michaelhenze/apple-mail-mcp/src/types.ts` — Message, MessageContent, ThreadMessage, Account interfaces
- `/Users/michaelhenze/apple-mail-mcp/src/index.ts` — all 35 existing tool registrations, withErrorHandling pattern
- `/Users/michaelhenze/apple-mail-mcp/package.json` — zero HTTP client dependencies confirmed
- `/Users/michaelhenze/apple-mail-mcp/.planning/phases/phase-2/SUMMARY.md` — Phase 2 deliverables confirmed
- `/Users/michaelhenze/apple-mail-mcp/.planning/phases/phase-3/SUMMARY.md` — Phase 3 deliverables confirmed

### Secondary (MEDIUM confidence)
- AppleScript `content of msg` returning plain text and `source of msg` returning HTML — confirmed by code inspection of getMessageContent

### Tertiary (LOW confidence)
- None — all architectural claims are supported by direct codebase inspection

---

## Metadata

**Confidence breakdown:**
- Architecture decision (data-pass-through): HIGH — confirmed by zero HTTP dependencies in package.json and single-pattern codebase
- Per-tool data requirements: HIGH — confirmed by direct inspection of MessageContent, ThreadMessage, Message types
- HTML regex for unsubscribe: MEDIUM — regex pattern is straightforward but HTML email complexity means edge cases exist
- detect-waiting-for reply detection logic: HIGH — getThread + sender comparison is deterministic
- Performance estimates: LOW — based on reasoning about AppleScript overhead, not measured

**Research date:** 2026-05-20
**Valid until:** 2026-06-20 (stable codebase, no external dependencies)
