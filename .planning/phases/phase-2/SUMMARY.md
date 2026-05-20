---
phase: phase-2
plan: PLAN
subsystem: core-message-data
tags: [message-headers, search, html-email, templates, attachments, persistence]
dependency_graph:
  requires: [phase-1]
  provides: [full-message-headers, search-pagination, html-email, template-persistence, attachment-by-index]
  affects: [src/types.ts, src/services/appleMailManager.ts, src/index.ts]
tech_stack:
  added: [fs, os, path (Node builtins for template persistence)]
  patterns: [conditional-applescript-branches, skipped-counter-pagination, vi-mock-module-level]
key_files:
  created: [src/__tests__/phase2.test.ts]
  modified: [src/types.ts, src/services/appleMailManager.ts, src/index.ts]
decisions:
  - Used module-level vi.mock('fs') with vi.fn() references configured per-test
  - allMailboxes branch builds separate AppleScript with per-mailbox loop
  - offset in multi-account fan-out uses collect-then-slice approach
metrics:
  duration: ~25 minutes
  completed: 2026-05-20
  tasks_completed: 7
  files_changed: 4
---

# Phase 2 Plan: Complete Core Message Data — Summary

Full-header retrieval, cross-mailbox search, pagination, HTML sending, template persistence, and index-based attachment saving — all gaps from the initial implementation are now closed.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Add replyTo/attachmentNames to Message type and extend getMessageById | cce68b5 |
| 2 | Add allMailboxes mode to searchMessages | 422d10d |
| 3 | Add offset parameter to searchMessages for pagination | 29b87e7 |
| 4 | Add isHtml to send-email and create-draft | c8b409b |
| 5 | Persist email templates to ~/.config/apple-mail-mcp/templates.json | a7d9961 |
| 6 | Add attachmentIndex (1-based) to save-attachment | ef9f67f |
| 7 | Unit tests for all Phase 2 logic | 72ba00d |

## Files Changed

- src/types.ts: replyTo and attachmentNames added to Message interface
- src/services/appleMailManager.ts: getMessageById extended; searchMessages offset+allMailboxes added; sendEmail/createDraft isHtml added; template persistence with constructor+loadTemplates+persistTemplates; saveAttachment attachmentIndex added
- src/index.ts: search-messages, send-email, create-draft, save-attachment schemas updated
- src/__tests__/phase2.test.ts: 13 new tests across 4 suites

## Test Results

Test Files: 3 passed | Tests: 70 passed (0 failed)

## Deviations from Plan

**[Rule 1 - Bug] vi.spyOn cannot redeclare ESM named exports**
- Found during: Task 7
- Issue: vi.spyOn(fs, "existsSync") throws Cannot redefine property in ESM context
- Fix: Switched to module-level vi.mock('fs', () => ({ existsSync: vi.fn(), ... })) with per-test configuration
- Files modified: src/__tests__/phase2.test.ts
- Commit: 72ba00d

## Known Stubs

None — all new fields are wired to real AppleScript output.

## Self-Check: PASSED

- src/types.ts — replyTo and attachmentNames fields present
- src/services/appleMailManager.ts — all method signatures updated
- src/index.ts — all schema updates present
- src/__tests__/phase2.test.ts — created, 13 tests pass
- All 7 commits present in git log
- npx tsc --noEmit passes
- npx vitest run — 70 tests pass, 0 failures
