---
phase: "05-performance-technical-health"
plan: "01"
subsystem: "appleMailManager, index"
tags: ["performance", "caching", "config", "dependencies"]
dependency_graph:
  requires: ["phase-3", "phase-4"]
  provides: ["message-location-cache", "config-persistence", "get-config-tool", "set-config-tool"]
  affects: ["findMessageScript", "resolveAccount", "listMailboxes", "deleteMessage", "moveMessage"]
tech_stack:
  added: []
  patterns: ["TTL-aware cache", "location cache fast-path", "config persistence"]
key_files:
  created:
    - src/__tests__/phase5.test.ts
  modified:
    - package.json
    - package-lock.json
    - src/services/appleMailManager.ts
    - src/index.ts
decisions:
  - "defaultAccount cache uses { value, expiresAt } struct rather than bare string to enable TTL eviction"
  - "findMessageScript cache fast-path includes full-scan fallback inline in same AppleScript to avoid extra osascript round-trip on stale cache"
  - "listMailboxes defaults includeCount=true for backward compatibility; healthCheck passes false"
  - "Config persistence follows identical pattern to template persistence (existsSync/readFileSync/writeFileSync/mkdirSync)"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-20"
  tasks_completed: 6
  files_changed: 5
---

# Phase 5 Plan 01: Performance & Technical Health Summary

One-liner: TTL-aware defaultAccount cache, O(1) message-location fast-path via inline targeted AppleScript, lazy mailbox count, persistent JSON config with MCP tools, and toolchain update to SDK 1.29 / vitest 4.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Dependency updates | 7ac5567 | package.json, package-lock.json |
| 2 | defaultAccount TTL + listMailboxes lazy count | ccef787 | appleMailManager.ts |
| 3 | Message-ID location cache infrastructure | 9e8f6c2 | appleMailManager.ts |
| 4 | Cache fast-path in findMessageScript | 94c42ea | appleMailManager.ts |
| 5 | Persistent config + get-config/set-config MCP tools | 7541451 | appleMailManager.ts, index.ts |
| 6 | Phase 5 unit tests | e34b584 | src/__tests__/phase5.test.ts |

## Test Results

- Before: 129 tests across 5 test files
- After: 149 tests across 6 test files (+20 new phase 5 tests)
- All 149 tests pass; `npx tsc --noEmit` exits 0; `npm run lint` exits 0

## What Was Built

### Task 1: Dependency Updates
- `@modelcontextprotocol/sdk`: 1.4.1 → ^1.29.0
- `vitest`: ^2.0.0 → ^4.1.7
- `@vitest/coverage-v8`: ^2.1.9 → ^4.1.7
- `@types/node`: ^20.0.0 → ^22.0.0
- No peer dependency errors; all 129 existing tests passed immediately

### Task 2: defaultAccount TTL Fix + listMailboxes Lazy Count
- Replaced `private defaultAccount: string | null` with `private defaultAccountCache: { value: string; expiresAt: number } | null`
- Added `DEFAULT_ACCOUNT_TTL_MS = 5 * 60_000` constant
- `invalidateCache()` now also nulls `defaultAccountCache`
- `listMailboxes(account?, includeCount=true)` — when `false`, injects `set mbCount to 0` instead of the expensive `count of messages of mb`
- `healthCheck()` now passes `false` to avoid the expensive count during connectivity checks

### Task 3: Message-ID Location Cache Infrastructure
- Added `messageLocations: new Map<string, { mailbox, account, expiry }>()` to `this.cache`
- Added `MESSAGE_LOCATION_TTL_MS = 5 * 60_000` constant
- Added `resolveMessageLocation(id)` and `cacheMessageLocation(id, mailbox, account)` private helpers
- `invalidateCache()` clears `messageLocations`
- Population sites: `getMessageById`, `parseMessageList`, `parseMessageListAllMailboxes`
- Eviction/update sites: `deleteMessage` (removes entry), `moveMessage` (updates to new location)

### Task 4: Cache Fast-Path in findMessageScript
- On cache HIT: generates targeted AppleScript using `mailbox "X" of account "Y"` directly
- The targeted path includes an inline full-scan fallback in the same AppleScript string (single osascript call)
- On cache MISS: generates the existing nested-loop AppleScript unchanged
- All six callers (markAsRead, markAsUnread, flagMessage, unflagMessage, markAsNotJunk, deleteMessage) benefit automatically
- Security: cached mailbox and account strings pass through `escapeForAppleScript()` before injection (T-05-05 mitigated)

### Task 5: Persistent Config + MCP Tools
- `CONFIG_FILE = ~/.config/apple-mail-mcp/config.json`
- `private config: { defaultAccount?, defaultMailbox?, timeoutMs? } = {}`
- `loadConfig()` called in constructor after `loadTemplates()`; seeds `defaultAccountCache` when `config.defaultAccount` is present
- `persistConfig()` follows identical pattern to `persistTemplates()`
- `getConfig()` returns shallow copy; `setConfig(partial)` merges and persists
- `get-config` MCP tool: returns current config as formatted JSON
- `set-config` MCP tool: Zod validates `timeoutMs` as `z.number().int().positive()` (T-05-03 mitigated)

### Task 6: Phase 5 Unit Tests (20 tests across 5 suites)
1. Message location cache: cold cache null, warm hit, TTL expiry, invalidateCache
2. Cache fast-path: HIT generates targeted script + fallback, MISS generates nested loop, invalid ID guard
3. defaultAccount TTL: cache hit skips executeAppleScript, TTL expiry re-queries, invalidate clears
4. listMailboxes lazy count: false omits count, true includes count, default is true
5. Persistent config: missing file, valid JSON, corrupt JSON, setConfig merge, writeFileSync path, getConfig shallow copy

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test logic for defaultAccount TTL assertion**
- **Found during:** Task 6
- **Issue:** The original test tried to count executeAppleScript calls across both the outgoing-message query and the account-list fallback, but the mock setup (tab-separated account data) didn't match the actual FIELD_SEP/RECORD_SEP format used by `fetchAccounts()`, causing the cache never to be populated and the test to fail
- **Fix:** Simplified the test to directly seed `defaultAccountCache` on the manager instance and assert that `executeAppleScript` is not called on a subsequent `resolveAccount()` within TTL — this tests the exact TTL behavior with no coupling to account-list parsing
- **Files modified:** src/__tests__/phase5.test.ts
- **Commit:** e34b584

**2. [Rule 2 - Missing] Unused import removed**
- **Found during:** Task 6
- **Issue:** `mkdirSync` imported but not directly used in test file (it's mocked but not referenced by name in test assertions)
- **Fix:** Removed from import statement; lint passed
- **Files modified:** src/__tests__/phase5.test.ts
- **Commit:** e34b584

## Threat Surface Scan

No new network endpoints or trust boundaries introduced. Config file uses the same `~/.config/apple-mail-mcp/` directory as templates (T-05-04 accepted). Injection threats T-05-01, T-05-02, T-05-05 mitigated via `escapeForAppleScript()`. T-05-03 mitigated via Zod schema on `timeoutMs`. T-05-06 mitigated via cache eviction on delete/move and TTL expiry.

## Self-Check: PASSED

- [x] `src/__tests__/phase5.test.ts` exists
- [x] `src/services/appleMailManager.ts` contains `messageLocations`, `defaultAccountCache`, `CONFIG_FILE`, `loadConfig`, `getConfig`, `setConfig`, `resolveMessageLocation`, `cacheMessageLocation`
- [x] `src/index.ts` contains `get-config` and `set-config`
- [x] `package.json` shows `@modelcontextprotocol/sdk: ^1.29.0`, `vitest: ^4.1.7`
- [x] Commits 7ac5567, ccef787, 9e8f6c2, 94c42ea, 7541451, e34b584 all exist in git log
- [x] Total tests: 149 (all passing)
- [x] `npx tsc --noEmit` exits 0
- [x] `npm run lint` exits 0
