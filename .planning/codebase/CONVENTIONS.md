# Coding Conventions

**Analysis Date:** 2026-05-20

## Language & Typing

**TypeScript version:** ^5.0.0 (strict mode enabled)

**Compiler settings** (`tsconfig.json`):
- `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`
- `strict: true` — enables `strictNullChecks`, `noImplicitAny`, etc.
- `declaration: true` — generates `.d.ts` files for the build output
- Path alias `@/*` maps to `src/*` (resolved at build time via `tsc-alias`)

**Type definitions:** All shared types live exclusively in `src/types.ts`. No inline type declarations in service or utility files.

**Interface vs type:** `interface` is used for all data models and parameter shapes — no `type` aliases are used. Zero enums in the codebase; string literals and boolean flags are used instead.

**`import type`:** Type-only imports use the `import type` keyword consistently:

```typescript
// src/utils/applescript.ts
import type { AppleScriptResult, AppleScriptOptions } from "@/types.js";

// src/services/appleMailManager.ts
import type {
  Message,
  MessageContent,
  Mailbox,
  Account,
  ...
} from "@/types.js";
```

**Return types:** Explicit return types are not required on functions (ESLint rule `@typescript-eslint/explicit-function-return-type` is `off`). Return types are inferred by the compiler.

**Nullability:** Methods that can fail return `null` (for objects), `false` (for booleans), or `[]` (for arrays) rather than throwing. This is enforced by convention across all public methods in `AppleMailManager`.

**Generics:** Used sparingly. `withErrorHandling<T extends Record<string, unknown>>` in `src/index.ts` is the only generic function.

---

## Naming Conventions

**Files:**
- `camelCase` for utility files: `applescript.ts`
- `PascalCase` for class/service files: `appleMailManager.ts`
- Test files mirror source with `.test.ts` suffix: `applescript.test.ts`
- Types file: singular `types.ts`

**Directories:**
- `src/services/` — class-based services
- `src/utils/` — standalone utility functions
- Flat structure; no nested subdirectories within `services/` or `utils/`

**Functions:**
- `camelCase` for all functions and methods: `executeAppleScript`, `buildAccountScopedScript`, `parseErrorMessage`
- Private class methods explicitly marked `private`: `resolveAccount`, `resolveMailbox`, `parseMessageList`, `invalidateCache`
- Boolean-returning helpers follow `is` prefix: `isDebugEnabled`, `isTimeoutError`, `isRetryableError`

**Variables and constants:**
- `camelCase` for local variables and parameters
- `SCREAMING_SNAKE_CASE` for module-level constants: `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_RETRIES`, `RETRYABLE_ERROR_PATTERNS`, `ERROR_MAPPINGS`, `MAILBOX_ALIASES`
- Class constants use `readonly` with `SCREAMING_SNAKE_CASE`: `private readonly CACHE_TTL_MS = 60_000`

**Interfaces:**
- `PascalCase` with no `I` prefix: `Message`, `AppleScriptResult`, `SendEmailParams`
- Parameter interfaces use `Params` suffix: `SearchMessagesParams`, `GetMessageParams`, `ListMessagesParams`
- Result interfaces use `Result` suffix: `AppleScriptResult`, `BatchOperationResult`, `HealthCheckResult`

**MCP tool names:**
- Kebab-case: `search-messages`, `get-message`, `send-email`, `create-draft`, `list-accounts`

---

## Error Handling Patterns

**Service layer (`AppleMailManager`):** Methods never throw. On failure they:
1. Log to `console.error` with a descriptive message and the raw error
2. Return `null` (object methods), `false` (mutation methods), or `[]` (list methods)

```typescript
// Pattern used consistently across all public methods in appleMailManager.ts
if (!result.success) {
  console.error(`Failed to send email: ${result.error}`);
  return false;
}
```

**MCP tool layer (`src/index.ts`):** All tool handlers are wrapped with `withErrorHandling`, which catches any thrown exceptions and returns a structured MCP error response:

```typescript
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ReturnType<typeof successResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    try {
      return handler(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`);
    }
  };
}
```

**Error discrimination:** `error instanceof Error` is always checked before accessing `.message`. String throws and plain-object throws are handled as fallback cases in `executeAppleScript`.

**User-facing errors:** `src/utils/applescript.ts` maintains `ERROR_MAPPINGS` — an array of `{ pattern: RegExp, message: string }` objects — to translate raw AppleScript error strings into actionable user messages. Captured groups (`$1`) are interpolated into messages.

**Logging strategy:** `console.error` is used for all error and debug output. `console.log` is never used (MCP servers communicate over stdout; only stderr is safe for logging). Debug output is gated behind `DEBUG=1` or `VERBOSE=1` environment variables via `isDebugEnabled()`.

---

## Module/Export Patterns

**ESM throughout:** The project uses `"type": "module"` in `package.json`. All imports include the `.js` extension (required for NodeNext module resolution):

```typescript
import { executeAppleScript } from "@/utils/applescript.js";
import { AppleMailManager } from "@/services/appleMailManager.js";
```

**Exports:**
- `src/types.ts` — exports all interfaces with named `export interface`
- `src/utils/applescript.ts` — exports one function: `export function executeAppleScript`
- `src/services/appleMailManager.ts` — exports one class: `export class AppleMailManager`
- `src/index.ts` — no exports; it is the entry-point binary

**No barrel files:** Each module is imported directly by path. There is no `src/index.ts` re-export barrel.

**Path alias `@/`:** Used for all internal imports. Resolves to `src/` at compile time. Never use relative paths like `../../types`.

---

## Code Organization Rules

**Section separators:** Long files (`appleMailManager.ts` at 1931 lines, `index.ts` at 986 lines) use `// ===` style section divider comments with 80-character width to group related code:

```typescript
// =============================================================================
// Message Operations
// =============================================================================
```

**Single responsibility:** Each file has one primary export:
- `types.ts` — data types only
- `applescript.ts` — AppleScript execution only
- `appleMailManager.ts` — Apple Mail business logic only
- `index.ts` — MCP server wiring only

**Private helpers inside the class:** Utility functions that are only used inside `AppleMailManager` are private methods. Module-level helpers that are reused across the class (`escapeForAppleScript`, `buildAccountScopedScript`, `buildAppLevelScript`, `parseAppleScriptDate`) are free functions above the class definition.

**Inline AppleScript templates:** Multi-line AppleScript is inlined as tagged template literals directly in the methods that use them. There is no separate script file or template directory.

**Cache pattern:** The TTL cache in `AppleMailManager` uses a `private cache` object with typed null-or-`{data, expiry}` fields. Cache invalidation is explicit: `invalidateCache()` is called after structural changes (mailbox create/delete/rename).

---

## Documentation Style

**Module-level JSDoc:** Every file starts with a `/** ... @module ... */` JSDoc block describing the module's purpose.

**Function JSDoc:** All exported and public functions have JSDoc with:
- Single-sentence description
- `@param` tags for all parameters
- `@returns` description
- `@example` code blocks for complex public APIs (e.g., `executeAppleScript`)

**Inline comments:** Used to explain non-obvious logic — shell escaping tricks, AppleScript parsing format, retry backoff math. Avoid restating what the code already says.

**Interface fields:** Every interface field in `types.ts` has a `/** ... */` JSDoc comment:

```typescript
export interface Message {
  /** Unique identifier for the message */
  id: string;
  /** Subject line of the email */
  subject: string;
  ...
}
```

**Comment format for sections:** Inline comments describing logical blocks use `//` with a space. Multi-step logic uses numbered comments: `// 1. Trim...`, `// 2. Preserve...`, `// 3. Escape...`.
