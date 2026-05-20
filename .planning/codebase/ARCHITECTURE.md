<!-- refreshed: 2026-05-20 -->
# Architecture

**Analysis Date:** 2026-05-20

## System Overview

```text
┌──────────────────────────────────────────────────────────────┐
│                   MCP Client (e.g., Claude)                  │
│            communicates via Model Context Protocol           │
└────────────────────────┬─────────────────────────────────────┘
                         │ stdio (JSON-RPC)
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   MCP Server Layer                           │
│                   `src/index.ts`                             │
│  - McpServer instance (SDK: @modelcontextprotocol/sdk)       │
│  - 35+ tool registrations (each with Zod schema + handler)   │
│  - withErrorHandling() wrapper on every tool                 │
│  - successResponse() / errorResponse() helpers               │
└────────────────────────┬─────────────────────────────────────┘
                         │ method calls
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   Service Layer                              │
│       `src/services/appleMailManager.ts`                     │
│  - AppleMailManager class (singleton instance in index.ts)   │
│  - Builds AppleScript strings                                │
│  - TTL cache for accounts & mailbox names (60s)              │
│  - In-memory template store (Map<string, EmailTemplate>)     │
│  - Returns typed results; never throws to callers            │
└────────────────────────┬─────────────────────────────────────┘
                         │ executeAppleScript()
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   AppleScript Utility                        │
│               `src/utils/applescript.ts`                     │
│  - executeAppleScript(script, options) → AppleScriptResult   │
│  - Runs osascript via execSync (synchronous)                 │
│  - Retry logic with exponential backoff                      │
│  - Error parsing & user-friendly messages                    │
└────────────────────────┬─────────────────────────────────────┘
                         │ osascript child_process
                         ▼
┌──────────────────────────────────────────────────────────────┐
│               macOS System Layer                             │
│  - Apple Mail.app (AppleScript automation)                   │
│  - Contacts.app (for search-contacts tool)                   │
│  - System Events (for sync status checks)                    │
└──────────────────────────────────────────────────────────────┘
```

## Core Components

| Component | File | Responsibility |
|-----------|------|----------------|
| MCP Server entry point | `src/index.ts` | Tool registration, Zod schema validation, response formatting, error wrapping |
| AppleMailManager | `src/services/appleMailManager.ts` | All mail operations, AppleScript building, TTL caching, template storage |
| executeAppleScript | `src/utils/applescript.ts` | osascript execution, retry logic, error parsing, shell escaping |
| Type definitions | `src/types.ts` | All TypeScript interfaces (Message, Mailbox, Account, Attachment, etc.) |

## Data Flow

### Primary Request Path (e.g., `list-messages`)

1. MCP client sends JSON-RPC tool call over **stdio** to the server process
2. `McpServer` in `src/index.ts` receives the call, validates params against the Zod schema
3. The `withErrorHandling()` wrapper in `src/index.ts` invokes the inline handler
4. The handler calls `mailManager.listMessages(mailbox, account, limit, from, offset)` on the singleton `AppleMailManager`
5. `AppleMailManager.listMessages()` calls `resolveAccount()` (uses 60s TTL cache) and `resolveMailbox()` (uses 60s TTL cache)
6. An AppleScript string is assembled via `buildAccountScopedScript()` in `src/services/appleMailManager.ts`
7. `executeAppleScript(script)` in `src/utils/applescript.ts` runs `osascript -e '...'` via `execSync`
8. Raw stdout is returned as `AppleScriptResult.output` — a pipe-delimited string (`|||` field separator, `|||ITEM|||` record separator)
9. `parseMessageList()` splits the string into typed `Message[]` objects
10. The handler formats the array into a human-readable string and returns `successResponse(text)`
11. The MCP SDK serializes the response back to the client over stdio

### Error Path

1. `executeAppleScript()` catches `execSync` exceptions
2. `parseErrorMessage()` maps raw AppleScript errors to user-friendly strings
3. Transient errors (timeout, busy, connection lost) trigger exponential-backoff retries (default: 1 attempt, configurable)
4. The `AppleScriptResult` with `success: false` propagates up to `AppleMailManager`
5. Most manager methods return `null` / `false` / `[]` on failure, log to `console.error`
6. The `withErrorHandling()` wrapper in `src/index.ts` catches any thrown exceptions and returns `errorResponse()`

### Multi-Account Search Flow

When `account` is omitted from `search-messages`:
1. `AppleMailManager.searchMessages()` calls `this.listAccounts()` (cached)
2. Iterates each account, calling `searchMessages(query, mailbox, acctName, remaining, ...)` recursively
3. Results are aggregated up to the `limit` cap

## Design Patterns

### Declarative Tool Registration
Every MCP tool in `src/index.ts` follows the same structure:
```typescript
server.tool(
  "tool-name",
  { param: z.string().describe("...") },   // Zod schema — validated by SDK
  withErrorHandling(({ param }) => {        // handler wrapped for errors
    const result = mailManager.someMethod(param);
    return result ? successResponse("...") : errorResponse("...");
  }, "Error prefix for catch block")
);
```
This pattern means tool definitions are self-contained: schema + handler in one declaration.

### Manager as Synchronous Facade
`AppleMailManager` presents a synchronous API (`listMessages()`, `sendEmail()`, etc.) that hides the complexity of AppleScript string building, caching, and error handling. All public methods return typed values (`Message[]`, `boolean`, `null`) — they never throw.

### Pipe-Delimited Text Protocol
AppleScript can only return strings. The manager and AppleScript snippets use a custom text encoding:
- `|||` separates fields within a record
- `|||ITEM|||` separates records in a list
- Special delimiter variants for content: `|||CONTENT|||`, `|||HTML|||`

Parsing is done in TypeScript after execution, not inside AppleScript.

### TTL Cache for Expensive Queries
`AppleMailManager` maintains a 60-second in-memory cache:
```typescript
private cache = {
  accounts: null as { data: Account[]; expiry: number } | null,
  mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
};
```
- `getCachedAccounts()` / `getCachedMailboxNames(account)` check expiry before fetching
- `invalidateCache()` is called after any mailbox structure change (create/delete/rename)
- Template storage is a separate `Map<string, EmailTemplate>` — in-memory only, resets on server restart

### AppleScript Builder Functions
Rather than scattered inline template literals, `appleMailManager.ts` uses builder functions:
- `buildAppLevelScript(command)` — wraps in `tell application "Mail" ... end tell`
- `buildAccountScopedScript(account, command)` — wraps in `tell application "Mail" / tell account "..."/ end tell / end tell`
- `escapeForAppleScript(text)` — escapes `\` and `"` for AppleScript string literals
- `findMessageScript(id, operation)` — generates the nested account/mailbox loop used by all single-message operations

### Retry with Exponential Backoff
`executeAppleScript()` supports configurable retries. The default is `maxRetries: 1` (no retries). When `maxRetries > 1`, transient errors (timeout, busy, connection lost) trigger a retry with `retryDelayMs * 2^(attempt-1)` delay.

## Key Abstractions

**`Message`** (`src/types.ts:21`):
Core data model representing an email. Contains `id`, `subject`, `sender`, `dateReceived`, `isRead`, `isFlagged`, `mailbox`, `account`. The `id` field is the Apple Mail numeric message ID (as a string).

**`AppleScriptResult`** (`src/types.ts:160`):
The universal return type from `executeAppleScript()`. Either `{ success: true, output: string }` or `{ success: false, output: "", error: string }`. Acts as a lightweight Result type.

**`withErrorHandling()`** (`src/index.ts:78`):
Higher-order function that wraps every tool handler. Catches any thrown exception and converts it to an `errorResponse`. Means tool handlers don't need try/catch themselves.

**`MAILBOX_ALIASES`** (`src/services/appleMailManager.ts:97`):
Map of normalized mailbox names to provider-specific variations (e.g., `"trash"` → `["Trash", "Deleted Items", "Deleted Messages", ...]`). Used by `resolveMailbox()` to normalize mailbox names across account types.

## Entry Points

**Server process entry:**
- File: `src/index.ts` (compiled to `build/index.js`, declared as `bin.apple-mail-mcp` in `package.json`)
- Startup: Creates `McpServer`, creates singleton `AppleMailManager`, registers all tools, connects `StdioServerTransport`, starts listening

**CLI invocation:**
```
npx apple-mail-mcp
# or after global install:
apple-mail-mcp
```
The process communicates exclusively over stdin/stdout using the MCP JSON-RPC protocol.

## Architectural Constraints

- **Synchronous execution:** All AppleScript runs via `execSync`, blocking the Node.js event loop. This is intentional — MCP tool calls are inherently request/response and AppleScript has no async API.
- **macOS only:** Hard-coded `"os": ["darwin"]` in `package.json`. The `osascript` binary is macOS-only.
- **Single-process:** The server is a single Node.js process. The `AppleMailManager` singleton holds all state (cache, templates, `defaultAccount`).
- **Template persistence:** Email templates are stored in the `AppleMailManager` instance's `Map` — they are lost when the server process restarts.
- **No circular imports:** `index.ts` imports from `services/` and `utils/`; `services/` imports from `utils/` and `types`; `utils/` imports from `types` only. Strictly layered.
- **Global state:** `defaultAccount` is a mutable field on the singleton. It is lazily resolved on first use and cached for the lifetime of the process.

## Anti-Patterns

### Do Not Use Raw execSync in New Code

**What happens:** Calling `execSync` or `spawnSync` directly in `appleMailManager.ts` rather than through `executeAppleScript()`.
**Why it's wrong:** Bypasses timeout handling, retry logic, error parsing, and debug logging.
**Do this instead:** Always call `executeAppleScript(script, options)` from `src/utils/applescript.ts`.

### Do Not Throw in AppleMailManager Methods

**What happens:** Throwing an exception from a public method of `AppleMailManager`.
**Why it's wrong:** The contract is that manager methods return `null`/`false`/`[]` on failure. Throwing bypasses the caller's success check and hits the `withErrorHandling()` catch block with a less specific message.
**Do this instead:** Log with `console.error`, return a failure value, let callers check the return value.

### Do Not Embed Unescaped User Input in AppleScript Strings

**What happens:** Passing a raw user string directly into an AppleScript template literal without `escapeForAppleScript()`.
**Why it's wrong:** User input containing `"` or `\` breaks the AppleScript string literal and causes silent failures or injection.
**Do this instead:** Always call `escapeForAppleScript(text)` before embedding strings in AppleScript: `src/services/appleMailManager.ts:48`.

## Error Handling

**Strategy:** Errors are caught at two layers and converted to structured responses rather than propagating as exceptions.

**Patterns:**
- `executeAppleScript()` catches all `execSync` exceptions, returns `AppleScriptResult` with `success: false`
- `AppleMailManager` methods check `result.success` and `result.output.startsWith("error:")`, log to `console.error`, return null/false/empty
- `withErrorHandling()` in `src/index.ts` is the final safety net — catches anything the manager lets through and returns a formatted `errorResponse`
- AppleScript itself uses `try ... on error errMsg ... return "error:" & errMsg end try` to surface errors as output rather than exit codes

## Cross-Cutting Concerns

**Logging:** `console.error` only — all log output goes to stderr, keeping stdout clean for the MCP JSON-RPC stream. Debug logging available via `DEBUG=1` or `VERBOSE=1` env vars (implemented in `src/utils/applescript.ts`).

**Validation:** Input validation is done at the MCP layer with Zod schemas (in `src/index.ts`). The manager layer does no additional validation — it trusts the caller.

**Authentication:** No auth within the server itself. Security is enforced by macOS: the process must have been granted Automation permission to control Mail.app via System Preferences > Privacy & Security > Automation.

---

*Architecture analysis: 2026-05-20*
