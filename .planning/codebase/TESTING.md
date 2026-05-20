# Testing

**Analysis Date:** 2026-05-20

## Test Framework & Setup

**Runner:** Vitest ^2.0.0
**Config:** `vitest.config.ts` at project root

**Key config values:**
- `globals: true` — `describe`, `it`, `expect`, `vi` are available without imports (though the test file still imports them explicitly)
- `environment: node`
- `include: ["src/**/*.test.ts"]` — discovers all `.test.ts` files under `src/`
- `coverage.provider: "v8"` (built-in Node.js coverage)
- Coverage reporters: `text`, `lcov`, `json-summary`

**Assertion library:** Vitest's built-in `expect` (Jest-compatible API)

**Mocking library:** Vitest's built-in `vi` (`vi.mock`, `vi.fn`, `vi.mocked`, `vi.clearAllMocks`)

**Path alias:** `resolve.alias` in `vitest.config.ts` maps `@` to `src/` — same alias as the TypeScript compiler, so test imports work identically to source imports.

**Pre-commit gate:** Husky + lint-staged runs `eslint --fix` and `prettier --write` on staged `src/**/*.ts` files before every commit. Tests are NOT run in the pre-commit hook; they run in `prepublishOnly`.

## How to Run Tests

```bash
npm test                  # Run all tests once (vitest run)
npm run test:watch        # Watch mode (vitest)
npm run test:coverage     # Run with coverage report (vitest run --coverage)
npm run typecheck         # Type-check without emitting (tsc --noEmit)
npm run lint              # Lint src/ with ESLint
npm run format:check      # Check formatting with Prettier
```

Coverage output lands in `coverage/` directory (excluded from git via the build config).

---

## Test File Organization

**Location:** Co-located with source in `src/utils/`. Test files sit next to the file they test:

```
src/
  utils/
    applescript.ts
    applescript.test.ts     ← only test file in the project
  services/
    appleMailManager.ts     ← no test file
  types.ts                  ← no test file
  index.ts                  ← no test file
```

**Naming:** `<module>.test.ts` — no `.spec.ts` variant is used.

**Test file header:** Files open with a JSDoc block explaining what is being tested and the mocking strategy:

```typescript
/**
 * Tests for AppleScript execution utilities
 *
 * These tests mock the child_process.execSync function to avoid
 * requiring actual AppleScript execution during testing.
 */
```

---

## Test Patterns Used

**Suite organization:** Top-level `describe` matches the exported function/class name. Nested `describe` blocks group by behavior category:

```typescript
describe("executeAppleScript", () => {
  describe("successful execution", () => { ... });
  describe("error handling", () => { ... });
  describe("input validation", () => { ... });
  describe("execution options", () => { ... });
  describe("timeout handling", () => { ... });
  describe("retry logic", () => { ... });
});
```

**AAA comments:** Individual tests use `// Arrange`, `// Act`, `// Assert` inline comments to mark the three phases:

```typescript
it("returns success result with trimmed output", () => {
  // Arrange: Mock a successful AppleScript execution
  mockExecSync.mockReturnValue("  Message Subject  \n");

  // Act: Execute a simple script
  const result = executeAppleScript('tell app "Mail" to get subject of message 1');

  // Assert: Output should be trimmed
  expect(result.success).toBe(true);
  expect(result.output).toBe("Message Subject");
  expect(result.error).toBeUndefined();
});
```

**Test names:** Descriptive sentences starting with a verb — "returns success result with trimmed output", "provides helpful message for permission errors", "uses exponential backoff between retries".

**`beforeEach` reset:** `vi.clearAllMocks()` is called in `beforeEach` to reset mock state between tests. No `afterEach` or `afterAll` hooks are used.

**Module mocking:** The entire `child_process` module is mocked at the module level:

```typescript
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ error: null })), // Mock sleep to return immediately
}));

const mockExecSync = vi.mocked(execSync);
```

`spawnSync` (used for the `sleep` function) is mocked to return immediately — this prevents real delays during retry tests.

**Simulating typed errors:** Timeout errors require setting custom properties on the Error object, which TypeScript doesn't know about by default — so the error is cast:

```typescript
const timeoutError = new Error("Command failed: SIGTERM") as Error & {
  killed: boolean;
  signal: string;
};
timeoutError.killed = true;
timeoutError.signal = "SIGTERM";
mockExecSync.mockImplementation(() => { throw timeoutError; });
```

**Stateful mock with call counter:** Retry tests use a `callCount` variable to fail on the first N calls and succeed on the final call:

```typescript
let callCount = 0;
mockExecSync.mockImplementation(() => {
  callCount++;
  if (callCount < 3) {
    throw new Error("Mail.app is not responding");
  }
  return "success";
});
```

**Asserting internal call shape:** Tests inspect `mockExecSync.mock.calls[0][0]` (the command string) and `mockExecSync.mock.calls[0][1]` (the options object) to verify the correct shell command and options were passed to `execSync`:

```typescript
const calledCommand = mockExecSync.mock.calls[0][0] as string;
expect(calledCommand).toContain("Rob'\\''s");

const options = mockExecSync.mock.calls[0][1] as { timeout: number };
expect(options.timeout).toBe(30000);
```

---

## What's Well Tested

The single test file `src/utils/applescript.test.ts` has 411 lines covering 31 test cases for `executeAppleScript`. Coverage is thorough across:

**Happy path:**
- Successful execution returns trimmed output (`result.success === true`)
- Multi-line scripts preserve newlines (required for AppleScript `tell` blocks)
- Single quotes in scripts are escaped for shell safety

**Error handling:**
- Non-zero exit codes return `{ success: false, output: "", error: "..." }`
- AppleScript `execution error: ...` format is parsed and the error code stripped
- Known error patterns produce user-friendly messages (permission denied, mailbox not found, account not found, message not found, send failed)
- String throws and plain-object throws are handled without crashing

**Input validation:**
- Empty string returns early with `"Cannot execute empty AppleScript"` and never calls `execSync`
- Whitespace-only string is treated the same as empty

**Execution options:**
- Default 30-second timeout is passed to `execSync`
- Custom `timeoutMs` overrides the default
- UTF-8 encoding is set on all calls

**Timeout handling:**
- `SIGTERM`-killed processes produce a message containing `"timed out after N seconds"`
- Custom `timeoutMs` value appears in the timeout error message

**Retry logic (9 test cases):**
- Default `maxRetries: 1` means no retries — `execSync` is called exactly once
- All retryable error patterns trigger retries: "not responding", "timed out", "connection is invalid", "lost connection", "busy"
- Non-retryable errors (e.g., "syntax error") do not retry even when `maxRetries > 1`
- Retries on timeout errors (`killed === true`)
- All retries exhausted returns the last error
- Exponential backoff is exercised (no timing assertion; just verifies correct call count)

---

## Coverage Gaps

**`src/services/appleMailManager.ts` — 0% test coverage**

This is the largest file (1931 lines, ~44 public methods) and has no tests at all. The vitest config explicitly acknowledges this with a comment:

> `// Note: src/services/*.ts excluded - requires Mail.app integration, not unit testable`

The coverage threshold (`src/utils/**/*.ts`) only enforces coverage on the `utils/` subtree. Service-layer coverage is excluded from thresholds entirely.

Untested surface area in `appleMailManager.ts` includes:
- `searchMessages` — query building, date filter generation, multi-account fan-out
- `listMessages` — pagination via `offset`, `from` filter
- `getMessageById` / `getMessageContent` — message parsing from `|||`-delimited output
- `sendEmail` / `createDraft` — recipient command building, attachment command building, account-scoping branch
- `replyToMessage` / `forwardMessage`
- `markAsRead`, `markAsUnread`, `flagMessage`, `unflagMessage`, `deleteMessage`
- `batchDeleteMessages`, `batchMoveMessages`, and all other batch operations
- `listMailboxes`, `createMailbox`, `renameMailbox`, `deleteMailbox`
- `listAccounts`, `listRules`, `setRuleEnabled`
- `searchContacts`
- `saveTemplate`, `listTemplates`, `getTemplate`, `useTemplate`
- `checkHealth`, `getMailStats`, `getSyncStatus`, `getRecentlyReceivedStats`
- `resolveAccount` — default account discovery via outgoing message trick
- `resolveMailbox` — alias resolution with `MAILBOX_ALIASES`
- `getCachedAccounts`, `getCachedMailboxNames` — TTL cache logic
- `parseMessageList` — the `|||ITEM|||` / `|||` delimited parser

**`src/index.ts` — 0% test coverage**

No tests for the MCP tool registration layer. Untested:
- `successResponse` / `errorResponse` helper functions
- `withErrorHandling` wrapper (error path behavior)
- Individual tool handler logic (field mapping, null-checks, response formatting)
- Server startup and transport wiring

**`src/types.ts` — not testable**

Pure type definitions; no runtime behavior to test.

---

## Coverage Configuration

Thresholds are only enforced on the `src/utils/**/*.ts` subtree:

```typescript
// vitest.config.ts
thresholds: {
  "src/utils/**/*.ts": {
    statements: 90,
    branches: 75,
    functions: 100,
    lines: 90,
  },
},
```

The `src/services/` and `src/index.ts` paths have no enforced thresholds. A CI run will pass as long as the `utils/` coverage thresholds are met.
