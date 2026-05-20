---
phase: "04"
plan: "01"
subsystem: intelligence-layer
tags: [mcp-tools, typescript, data-passthrough, triage, summarization, action-items]
dependency_graph:
  requires: [phase-3]
  provides: [triage-inbox, find-action-items, summarize-inbox, unsubscribe-helper, draft-reply, summarize-thread, detect-waiting-for]
  affects: [src/types.ts, src/services/appleMailManager.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [data-passthrough, vi.spyOn mocking, regex link extraction, Set-based self-email detection]
key_files:
  created:
    - src/__tests__/phase4.test.ts
  modified:
    - src/types.ts
    - src/services/appleMailManager.ts
    - src/index.ts
decisions:
  - getWaitingFor uses listAccounts() to build Set<string> for case-insensitive self-reply exclusion
  - getUnsubscribeLinks uses two-pass regex (anchor text + href) with deduplication
  - includeSnippets guard in getTriageMessages caps AppleScript calls for large inboxes
  - No new npm dependencies — pure data-passthrough pattern maintained
metrics:
  duration: "~12 minutes"
  completed: "2026-05-20T19:42:10Z"
  tasks_completed: 4
  files_changed: 4
---

# Phase 4 Plan 1: Intelligence Layer Summary

**One-liner:** Seven data-passthrough MCP tools for inbox triage, action-item extraction, summarization, unsubscribe detection, draft composition, thread summarization, and waiting-for tracking — all structured for Claude to reason over without server-side LLM calls.

## What Was Accomplished

Phase 4 adds the Intelligence Layer to the Apple Mail MCP server. All seven tools follow the established data-passthrough architecture: they fetch and structure email data, then return it as formatted text for the calling Claude assistant to synthesize.

### Tools Added

| Tool | Purpose |
|------|---------|
| `triage-inbox` | Fetches unread messages with optional 200-char snippets; prompts Claude to classify as urgent/FYI/deletable |
| `find-action-items` | Returns full message body text for single message or mailbox scan; prompts Claude to extract to-dos |
| `summarize-inbox` | Returns unread metadata (no body fetch) for daily briefing; prompts Claude for concise summary |
| `unsubscribe-helper` | Extracts unsubscribe URLs from HTML via two-pass regex; detects newsletter signals |
| `draft-reply` | Returns thread context for composition; optionally creates draft when `draftBody` is provided |
| `summarize-thread` | Returns all thread messages with bodies; prompts Claude for 3-5 sentence summary |
| `detect-waiting-for` | Scans Sent folder for messages with no external replies; sorts oldest-first |

## Files Changed

- **src/types.ts** — Added `TriageMessage`, `ActionItemsResult`, `WaitingForItem` interfaces under Phase 4 section
- **src/services/appleMailManager.ts** — Added 7 service methods; updated type imports
- **src/index.ts** — Registered 7 MCP tools under Intelligence Layer section comment
- **src/__tests__/phase4.test.ts** — Created with 25 test cases across 7 suites

## Test Results

```
Test Files  5 passed (5)
     Tests  129 passed (129)   (104 baseline + 25 new Phase 4 tests)
```

Zero failures. Zero regressions.

## Commits

| Hash | Task | Description |
|------|------|-------------|
| a6aec91 | Task 1 | Add TriageMessage, ActionItemsResult, WaitingForItem interfaces |
| eed5e83 | Task 2 | Add 7 service methods to AppleMailManager |
| 0885573 | Task 3 | Register 7 intelligence layer MCP tools in index.ts |
| 9829c30 | Task 4 | Unit tests for Phase 4 intelligence layer (25 tests) |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All 7 tools wire directly to real AppleMailManager methods.

## Threat Flags

No new security surface introduced. All threat mitigations from the plan's threat register are implemented:

- **T-04-03**: `draftBody` passes through existing `escapeForAppleScript()` inside `createDraft()` — no additional escaping needed
- **T-04-04**: Default `limit=20` and `includeSnippets` guard cap AppleScript calls in `getTriageMessages`
- **T-04-05**: Default `limit=20` and `daysAgo=2` threshold cap `getThread` calls in `getWaitingFor`
- **T-04-06**: `userEmails` Set built from `listAccounts().map(a => a.email.toLowerCase())` for case-insensitive self-reply detection

## Self-Check: PASSED

- src/types.ts: 3 new interfaces confirmed (grep count = 3)
- src/services/appleMailManager.ts: 7 new methods confirmed (grep count = 7)
- src/index.ts: 7 new tool names confirmed present
- src/__tests__/phase4.test.ts: 25 tests, all passing
- npx tsc --noEmit: 0 errors
- npm test: 129/129 passed
- Commits a6aec91, eed5e83, 0885573, 9829c30: all confirmed in git log
