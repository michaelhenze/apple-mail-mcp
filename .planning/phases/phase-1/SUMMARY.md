# Phase 1 Plan 1: Security & Correctness Fixes Summary

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Safe Delimiter Replacement (atomic) | 4c33c19 |
| 2 | Implement Missing Search/List Filters | 01ef2d6 |
| 3 | Atomic renameMailbox with Rollback | 09709b7 |
| 4 | Message ID Validation (injection prevention) | 90af9b3 |
| 5 | Path Traversal Prevention | 3b65d80 |
| 6 | Email Address Validation | 5827e9e |
| 7 | Unit Tests | 894f73f |

## Files Modified

- `src/services/appleMailManager.ts` — delimiter constants, filter params, rename rollback, ID guards, validateSavePath calls
- `src/index.ts` — ID schema regex, filter handler destructuring, emailAddressSchema usages

## Files Created

- `src/utils/pathSecurity.ts` — exported validateSavePath() helper
- `src/utils/emailValidation.ts` — exported emailAddressSchema Zod schema
- `src/__tests__/security.test.ts` — 29 unit tests

## Test Results

All 57 tests passed (29 new + 28 existing). Zero failures.

## Success Criteria

| Criterion | Result |
|-----------|--------|
| grep -c '"|||"' returns 0 | PASS |
| grep -c '.min(1, "Message ID' returns 0 | PASS |
| npm test passes | PASS (57/57) |
| npx tsc --noEmit passes | PASS |
| searchMessages with from/isRead/isFlagged | PASS |
| listMessages with unreadOnly | PASS |
| grep 'whose id is ${id}' returns 0 | DEVIATION (returns 8 — see below) |

## Deviations from Plan

### [Criterion deviation] grep for 'whose id is ${id}' returns 8, not 0

The plan's success criterion requires this grep to return 0, but the plan's Task 4 instructions describe adding guards *before* the buildAppLevelScript() call — leaving ${id} inside the template string. These instructions are contradictory.

Resolution: followed the guard-before-template approach from Task 4 instructions. All 8 template interpolations are protected: a non-numeric id is rejected before the template is built. The security property (no injection possible) is fully satisfied. The grep count is 8 because the literal ${id} still exists inside template string bodies.

### validateSavePath and emailAddressSchema extracted to utils upfront

Both helpers were extracted to src/utils/ immediately (Tasks 5 and 6) rather than defined inline and refactored later (as Task 7 suggests). This is a cleaner implementation path that avoids a two-pass edit cycle.
