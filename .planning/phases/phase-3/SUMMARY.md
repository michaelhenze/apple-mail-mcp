---
phase: phase-3
plan: "01"
subsystem: appleMailManager + index
tags: [junk-control, archive, thread, vip, sync-status, typescript, applescript]
dependency_graph:
  requires: [phase-2]
  provides: [move-to-junk, mark-as-not-junk, archive-message, batch-archive, get-thread, get-vip-messages, simplified-sync-status]
  affects: [src/types.ts, src/services/appleMailManager.ts, src/index.ts]
tech_stack:
  added: [child_process.execSync, plutil (macOS built-in)]
  patterns: [subject-normalization, two-step-junk-flag, plist-discovery-via-find]
key_files:
  created: [src/__tests__/phase3.test.ts]
  modified: [src/types.ts, src/services/appleMailManager.ts, src/index.ts]
decisions:
  - "searchMessages takes positional args not object — getVipMessages uses positional call"
  - "Tasks 2+3+4 committed together to satisfy ESLint no-unused-vars"
  - "JSDoc V*/VIP.plist rewritten as V{version}/VIP.plist to avoid block-comment termination"
metrics:
  duration: "~25 minutes"
  completed: "2026-05-20"
  tasks_completed: 6
  files_changed: 4
---

# Phase 3 Plan 01: Productivity Tools Summary

**One-liner:** Six new productivity MCP tools (junk control, archive, batch-archive, thread retrieval, VIP messages) plus SyncStatus cleanup with honest three-field type.

## What Was Accomplished

- Replaced 4-field fake SyncStatus with { running, accountCount, error? }
- Added ThreadMessage interface for thread display
- moveToJunk: two-step flag + physical move to Junk mailbox
- markAsNotJunk: flag-only clear (no move)
- archiveMessage: delegates to moveMessage("Archive")
- batchArchiveMessages: delegates to batchMoveMessages("Archive")
- Exported normalizeSubject pure function (recursive prefix stripping)
- getThread: subject-match, 7-field parsing, sorted ascending, deduplicated
- getVipMessages: find + plutil plist discovery, INBOX search per sender
- Updated getSyncStatus to return simplified type
- Registered 6 new MCP tools; updated get-sync-status handler
- 34 new unit tests (104 total, 0 failures)

## Files Changed

- src/types.ts — Replace SyncStatus, add ThreadMessage
- src/services/appleMailManager.ts — 7 new methods, export normalizeSubject, execSync import
- src/index.ts — 6 tool registrations, update get-sync-status handler
- src/__tests__/phase3.test.ts — Created, 34 tests

## Test Results

Test Files: 4 passed | Tests: 104 passed (0 failures)

## Deviations from Plan

1. [Rule 3 - Blocking] searchMessages takes positional args not object. Fixed call signature in getVipMessages.
2. [Rule 3 - Blocking] V*/VIP.plist in JSDoc caused TypeScript parse error. Fixed by writing V{version}/VIP.plist.
3. [Rule 3 - Blocking] ESLint no-unused-vars prevented Task 2 standalone commit. Fixed by implementing Tasks 2+3+4 together before committing.

## Known Stubs

None.

## Self-Check: PASSED

- TypeScript: 0 errors
- Tests: 104/104 pass
- All 6 tools registered
- SyncStatus has no fake fields
- normalizeSubject exported
- getThread, getVipMessages, moveToJunk, markAsNotJunk, archiveMessage, batchArchiveMessages all present
