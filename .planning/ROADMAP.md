# Apple Mail MCP — Roadmap

**Project:** apple-mail-mcp
**Current version:** 1.1.1
**Branch base:** feature/attachment-support

---

## Milestone: v2.0 — Full-Featured Mail Assistant

Complete the Apple Mail MCP server from a functional prototype to a production-quality mail assistant: correct data, rich tools, intelligent features, and solid performance.

---

## Phase 1: Security & Correctness Fixes ✅ COMPLETE

**Goal:** Fix all P0/P1 issues from CONCERNS.md — zero silent parameter drops, zero AppleScript injection vectors, zero path traversal risk.

**Status:** Complete (8 commits, 57/57 tests passing)

**Delivered:**
- Safe delimiter replacement (||| → Unicode PUA constants)
- Missing filters wired through (from, isRead, isFlagged, unreadOnly)
- Atomic renameMailbox with rollback
- Message ID numeric validation
- Path traversal prevention in save-attachment
- Email address validation on recipient fields
- 29 security unit tests

---

## Phase 2: Complete Core Message Data

**Goal:** Close the gaps where Mail.app data exists but the MCP tools don't expose it. After this phase every tool returns complete, accurate data.

**Scope:**
- `get-message` returns full headers: senderName, recipients, ccRecipients, replyTo, hasAttachments, attachmentNames
- `search-messages` gains `allMailboxes` mode (search beyond INBOX)
- `search-messages` gains `offset` parameter for pagination (matches list-messages)
- `send-email` / `create-draft` wire up `isHtml` for HTML email body support
- `save-attachment` gains `attachmentIndex` parameter for index-based selection
- Email templates persisted to `~/.config/apple-mail-mcp/templates.json` (survive restarts)

**Estimated complexity:** Medium — mostly filling in existing AppleScript patterns

---

## Phase 3: New Productivity Tools

**Goal:** Add high-value tools that cover common email workflows not yet supported.

**Scope:**
- `get-thread` — return full email thread as ordered list of messages with context
- `archive-message` — move to account's native Archive folder (one-click)
- `move-to-junk` / `mark-as-not-junk` — explicit spam control
- `get-vip-messages` — read Apple Mail VIP folder / VIP-flagged messages
- `batch-archive` — archive multiple messages in one call (like existing batch-delete)
- `get-mail-stats` improvements — fix misleading syncDetected field, remove fake sync data

**Estimated complexity:** Medium — new AppleScript patterns needed for thread traversal and VIP

---

## Phase 4: Intelligence Layer

**Goal:** Add Claude-powered tools that synthesize email content into actionable output — features that only make sense in an AI-assistant context.

**Scope:**
- `triage-inbox` — structured priority list of unread messages: urgent / FYI / deletable
- `find-action-items` — scan a message or mailbox for to-dos and return structured list
- `summarize-inbox` — concise daily briefing of unread mail (ideal as a morning start tool)
- `unsubscribe-helper` — detect newsletters, extract unsubscribe links from HTML body
- `draft-reply` — suggest a reply draft based on thread context (uses existing get-message + create-draft)

**Estimated complexity:** Medium-low for the Claude-side logic; depends on Phase 2's full message data

---

## Phase 5: Performance & Technical Health

**Goal:** Make the server fast and maintainable. Address the P2/P3 items from CONCERNS.md.

**Scope:**
- Message-ID location cache: after any message op, cache `(id → mailbox, account)` with TTL — eliminates O(accounts × mailboxes) scan on every operation
- `listMailboxes` lazy count: skip `count of messages` when only folder list is needed
- Persistent configuration file (`~/.config/apple-mail-mcp/config.json`) for default account, default mailbox, timeouts
- Dependency updates: `@modelcontextprotocol/sdk` 1.4.1 → latest, `vitest` v2 → v4, `@types/node` → ^22
- `defaultAccount` cache TTL / invalidation fix

**Estimated complexity:** Medium for cache layer; Low for dependency updates

---

## Phase Order Rationale

1. ✅ **Phase 1** — Security/correctness first (foundation)
2. **Phase 2** — Complete data model (Phase 4 depends on full message headers)
3. **Phase 3** — New tools (builds on reliable data from Phase 2)
4. **Phase 4** — Intelligence layer (needs full message data from Phase 2)
5. **Phase 5** — Performance (can run anytime, but cache is most valuable after tools are complete)

Phases 3 and 4 can run in parallel if desired.
