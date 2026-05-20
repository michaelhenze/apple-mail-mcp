---
phase: "05-performance-technical-health"
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - package-lock.json
  - src/services/appleMailManager.ts
  - src/index.ts
  - src/__tests__/phase5.test.ts
autonomous: true
requirements:
  - PERF-01
  - PERF-02
  - PERF-03
  - PERF-04
  - PERF-05

must_haves:
  truths:
    - "Dependency versions in package.json match targets: SDK ^1.29.0, vitest ^4.1.7, @vitest/coverage-v8 ^4.1.7, @types/node ^22.0.0"
    - "All 129 existing tests still pass after dependency update"
    - "resolveAccount() respects a 5-minute TTL and invalidateCache() clears the defaultAccount cache"
    - "listMailboxes(account, false) omits the expensive count of messages AppleScript and returns messageCount: 0"
    - "healthCheck() calls listMailboxes with includeCount=false"
    - "Message-ID location cache is added to this.cache.messageLocations; resolveMessageLocation() returns a hit within TTL"
    - "cacheMessageLocation() is called in getMessageById, listMessages, searchMessages, moveMessage, deleteMessage"
    - "invalidateCache() clears cache.messageLocations"
    - "~/.config/apple-mail-mcp/config.json is created on first setConfig call with correct schema"
    - "getConfig() returns defaultAccount, defaultMailbox, and timeoutMs from disk; returns {} if file absent"
    - "MCP tools get-config and set-config are registered in src/index.ts"
    - "npx tsc --noEmit passes with zero errors after all changes"
    - "Phase 5 test suite passes: cache hit/miss, lazy count, config round-trip, defaultAccount TTL"
  artifacts:
    - path: "src/services/appleMailManager.ts"
      provides: "All five performance and correctness fixes"
      contains: "messageLocations"
    - path: "src/__tests__/phase5.test.ts"
      provides: "Unit tests for Phase 5 logic"
    - path: "src/index.ts"
      provides: "get-config and set-config MCP tool registrations"
    - path: "package.json"
      provides: "Updated dependency versions"
  key_links:
    - from: "src/services/appleMailManager.ts (invalidateCache)"
      to: "cache.messageLocations"
      via: "Map.clear()"
      pattern: "messageLocations\\.clear"
    - from: "src/services/appleMailManager.ts (invalidateCache)"
      to: "defaultAccountCache"
      via: "null assignment"
      pattern: "defaultAccountCache = null"
    - from: "src/index.ts"
      to: "mailManager.getConfig / mailManager.setConfig"
      via: "MCP server.tool()"
      pattern: "get-config|set-config"
---

<objective>
Deliver five targeted improvements to appleMailManager.ts: (1) dependency updates, (2) defaultAccount TTL fix, (3) listMailboxes lazy count, (4) message-ID location cache, and (5) persistent config file with MCP tools.

Purpose: Eliminate O(accounts x mailboxes) scans on every message operation, fix a permanent-cache bug, add user-configurable defaults, and keep the toolchain current.

Output: Updated package.json, all five fixes in appleMailManager.ts, get-config/set-config tools in index.ts, and a passing phase5.test.ts.
</objective>

<execution_context>
@/Users/michaelhenze/apple-mail-mcp/.planning/../../../.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@/Users/michaelhenze/apple-mail-mcp/.planning/ROADMAP.md
@/Users/michaelhenze/apple-mail-mcp/.planning/STATE.md
@/Users/michaelhenze/apple-mail-mcp/src/services/appleMailManager.ts
@/Users/michaelhenze/apple-mail-mcp/src/index.ts
@/Users/michaelhenze/apple-mail-mcp/src/types.ts
@/Users/michaelhenze/apple-mail-mcp/package.json

<interfaces>
<!-- Key interfaces and line anchors for the executor. No codebase exploration needed. -->

From src/services/appleMailManager.ts (lines 167–228):

Class field declarations (insert new fields after line 190, CACHE_TTL_MS):
```typescript
// Line 167 — class AppleMailManager
private readonly TEMPLATE_FILE = join(homedir(), ".config", "apple-mail-mcp", "templates.json");
private readonly CONFIG_FILE   = join(homedir(), ".config", "apple-mail-mcp", "config.json");

// Line 177 — replace with TTL-bearing struct
// BEFORE: private defaultAccount: string | null = null;
// AFTER:
private defaultAccountCache: { value: string; expiresAt: number } | null = null;

// Line 184 — cache object, add messageLocations key
private cache = {
  accounts: null as { data: Account[]; expiry: number } | null,
  mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
  messageLocations: new Map<string, { mailbox: string; account: string; expiry: number }>(),
};

// Line 190 — existing constant stays; add two new ones after it
private readonly CACHE_TTL_MS             = 60_000;
private readonly MESSAGE_LOCATION_TTL_MS  = 5 * 60_000;   // 5 minutes
private readonly DEFAULT_ACCOUNT_TTL_MS   = 5 * 60_000;   // 5 minutes

// New config field (after TEMPLATE_FILE declaration)
private config: {
  defaultAccount?: string;
  defaultMailbox?: string;
  timeoutMs?: number;
} = {};
```

Constructor (line 171) — add loadConfig() call after loadTemplates():
```typescript
constructor() {
  this.loadTemplates();
  this.loadConfig();
}
```

invalidateCache (lines 225–228) — add two new clear lines:
```typescript
private invalidateCache(): void {
  this.cache.accounts = null;
  this.cache.mailboxNames.clear();
  this.cache.messageLocations.clear();   // NEW — Task 3
  this.defaultAccountCache = null;       // NEW — Task 2
}
```

resolveAccount (lines 235–273) — replace defaultAccount field references:
```typescript
private resolveAccount(account?: string): string {
  if (account) return account;
  // Check TTL cache
  const now = Date.now();
  if (this.defaultAccountCache && now < this.defaultAccountCache.expiresAt) {
    return this.defaultAccountCache.value;
  }
  // ... (expensive AppleScript block unchanged) ...
  // At every point that previously wrote: this.defaultAccount = matchedAccount.name;
  // now write:
  this.defaultAccountCache = { value: matchedAccount.name, expiresAt: Date.now() + this.DEFAULT_ACCOUNT_TTL_MS };
  return this.defaultAccountCache.value;
}
```

listMailboxes (line 1830) — add includeCount parameter and conditional AppleScript:
```typescript
listMailboxes(account?: string, includeCount = true): Mailbox[] {
  // ...
  const listCommand = `
    set mailboxList to {}
    repeat with mb in mailboxes
      set mbName to name of mb
      set mbUnread to unread count of mb
      ${includeCount ? "set mbCount to count of messages of mb" : "set mbCount to 0"}
      set end of mailboxList to mbName & (character id 57345) & mbUnread & (character id 57345) & mbCount
    end repeat
    ...
  `;
}
```

healthCheck (line 2405) — update call:
```typescript
// BEFORE: const mailboxes = this.listMailboxes(accounts[0].name);
// AFTER:
const mailboxes = this.listMailboxes(accounts[0].name, false);
```

Location cache helpers (add as private methods after invalidateCache):
```typescript
private resolveMessageLocation(id: string): { mailbox: string; account: string } | null {
  const now = Date.now();
  const cached = this.cache.messageLocations.get(id);
  if (cached && now < cached.expiry) {
    return { mailbox: cached.mailbox, account: cached.account };
  }
  return null;
}

private cacheMessageLocation(id: string, mailbox: string, account: string): void {
  this.cache.messageLocations.set(id, {
    mailbox,
    account,
    expiry: Date.now() + this.MESSAGE_LOCATION_TTL_MS,
  });
}
```

Config helpers (add after persistTemplates, before useTemplate at line ~2316):
```typescript
private loadConfig(): void {
  try {
    if (!existsSync(this.CONFIG_FILE)) return;
    const raw = readFileSync(this.CONFIG_FILE, "utf8");
    this.config = JSON.parse(raw) as typeof this.config;
    // If config specifies a defaultAccount, seed the TTL cache
    if (this.config.defaultAccount) {
      this.defaultAccountCache = {
        value: this.config.defaultAccount,
        expiresAt: Date.now() + this.DEFAULT_ACCOUNT_TTL_MS,
      };
    }
  } catch (err) {
    console.error(`[apple-mail-mcp] Failed to load config: ${err}`);
  }
}

private persistConfig(): void {
  try {
    const dir = join(homedir(), ".config", "apple-mail-mcp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.CONFIG_FILE, JSON.stringify(this.config, null, 2), "utf8");
  } catch (err) {
    console.error(`[apple-mail-mcp] Failed to persist config: ${err}`);
  }
}

getConfig(): { defaultAccount?: string; defaultMailbox?: string; timeoutMs?: number } {
  return { ...this.config };
}

setConfig(partial: { defaultAccount?: string; defaultMailbox?: string; timeoutMs?: number }): void {
  this.config = { ...this.config, ...partial };
  this.persistConfig();
}
```

Cache population call sites — add after successful result in each method:
- getMessageById (line ~619, after parts[8] is extracted as account):
  `this.cacheMessageLocation(id, parts[7], parts[8]);`
- listMessages (inside parseMessageList where mailbox/account are known — call after building each Message object):
  `this.cacheMessageLocation(msg.id, msg.mailbox, msg.account);`
- searchMessages (same pattern as listMessages — both call parseMessageList):
  same as listMessages (parseMessageList populates the cache via a helper call from within, or call at each return site)
- moveMessage (line ~1330, after `result.success && !result.output.startsWith("error:")`):
  `this.cacheMessageLocation(id, targetMailbox, targetAccount);`
- deleteMessage (line ~1290, after success):
  `this.cache.messageLocations.delete(id);`

For parseMessageList: If both listMessages and searchMessages route through it, add the cacheMessageLocation call inside parseMessageList so it is covered in both. Check whether parseMessageList exists or is inlined — if inlined, add the call at each success path.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Dependency updates — package.json, npm install, test suite green</name>
  <files>package.json, package-lock.json</files>
  <action>
Update package.json dependency versions exactly as follows, then run npm install and verify the test suite.

In "dependencies":
- Change `"@modelcontextprotocol/sdk": "1.4.1"` to `"@modelcontextprotocol/sdk": "^1.29.0"`

In "devDependencies":
- Change `"@types/node": "^20.0.0"` to `"@types/node": "^22.0.0"`
- Change `"@vitest/coverage-v8": "^2.1.9"` to `"@vitest/coverage-v8": "^4.1.7"`
- Change `"vitest": "^2.0.0"` to `"vitest": "^4.1.7"`

Do NOT change zod (stays at ^3.22.4 — installed version 3.25.76 satisfies SDK 1.29.0's peer dep of ^3.25).

After editing package.json, run:
```
npm install
```

If npm warns about missing peer `@cfworker/json-schema`, ignore the warning — it is an optional validation backend not used by this project. If npm errors (not warns), install it as devDependency:
```
npm install --save-dev @cfworker/json-schema
```

Then run the full test suite to confirm all 129 existing tests still pass:
```
npm test
```

If any test fails, read the failure output carefully. Known safe breakages from vitest v2→v4:
- `invocationCallOrder` numbering starts at 1 instead of 0 — fix the assertion if encountered
- `vi.restoreAllMocks()` scope change — tests use `vi.clearAllMocks()` so this should not apply

After tests pass, run the TypeScript compiler:
```
npx tsc --noEmit
```

Fix any new type errors surfaced by @types/node@22 (likely none — all used APIs are stable since Node 14).
  </action>
  <verify>
    <automated>npm test && npx tsc --noEmit</automated>
  </verify>
  <done>package.json shows updated versions; npm test reports 129 passed, 0 failed; npx tsc --noEmit exits 0.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: defaultAccount TTL fix + listMailboxes lazy count</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - resolveAccount() with no argument and an expired defaultAccountCache (expiresAt in the past) re-runs the expensive AppleScript lookup rather than returning the stale value
    - resolveAccount() with a fresh defaultAccountCache (expiresAt in the future) returns the cached value without running AppleScript
    - invalidateCache() sets defaultAccountCache to null
    - listMailboxes(account, false) generates AppleScript with "set mbCount to 0" (not "count of messages of mb")
    - listMailboxes(account, true) generates AppleScript with "count of messages of mb"
    - listMailboxes() with no second argument defaults to includeCount=true
  </behavior>
  <action>
Apply both changes to src/services/appleMailManager.ts. Read the exact current line numbers before editing by searching for the relevant method signatures.

CHANGE 1 — defaultAccount TTL fix:

Replace the private field declaration at line 177:
  BEFORE: `private defaultAccount: string | null = null;`
  AFTER:  `private defaultAccountCache: { value: string; expiresAt: number } | null = null;`

Add a new constant after CACHE_TTL_MS (line 190):
  `private readonly DEFAULT_ACCOUNT_TTL_MS = 5 * 60_000; // 5 minutes`

Rewrite resolveAccount() (lines 235–273). The method body contains three assignment sites that previously wrote `this.defaultAccount`. Replace ALL three with:
  `this.defaultAccountCache = { value: <resolved_name>, expiresAt: Date.now() + this.DEFAULT_ACCOUNT_TTL_MS };`
  and replace the early-return check `if (this.defaultAccount)` with:
  ```typescript
  const now = Date.now();
  if (this.defaultAccountCache && now < this.defaultAccountCache.expiresAt) {
    return this.defaultAccountCache.value;
  }
  ```
  Replace every `return this.defaultAccount;` with `return this.defaultAccountCache!.value;`

The three assignment sites in resolveAccount() are:
  1. After `matchedAccount` found via email match — was `this.defaultAccount = matchedAccount.name;`
  2. After fallback to `accounts[0]` — was `this.defaultAccount = accounts[0].name;`
  3. (If any other site references `this.defaultAccount` in resolveAccount) — check with grep

Update invalidateCache() (line 225) to add:
  `this.defaultAccountCache = null;`
  alongside the existing two clear lines.

CHANGE 2 — listMailboxes lazy count:

Change the method signature at line 1830:
  BEFORE: `listMailboxes(account?: string): Mailbox[]`
  AFTER:  `listMailboxes(account?: string, includeCount = true): Mailbox[]`

Inside the listCommand template string, replace the static line:
  BEFORE: `set mbCount to count of messages of mb`
  AFTER:  use a TypeScript ternary to inject different AppleScript depending on includeCount:
    `${includeCount ? "set mbCount to count of messages of mb" : "set mbCount to 0"}`

Update the healthCheck() caller at line 2405:
  BEFORE: `const mailboxes = this.listMailboxes(accounts[0].name);`
  AFTER:  `const mailboxes = this.listMailboxes(accounts[0].name, false);`

getMailStats() at line 2428 calls `this.listMailboxes(account.name)` — leave this call unchanged (needs messageCount and unreadCount for stats; default includeCount=true is correct).
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test shows all tests passing; the string "count of messages of mb" does not appear in the listMailboxes method body (it is wrapped in the conditional), and the healthCheck call passes false as the second argument.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Message-ID location cache</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - resolveMessageLocation(id) returns null on cache miss
    - resolveMessageLocation(id) returns {mailbox, account} when a cache entry exists and expiresAt > Date.now()
    - resolveMessageLocation(id) returns null when expiresAt <= Date.now() (expired entry)
    - cacheMessageLocation(id, mailbox, account) stores an entry with expiry = Date.now() + MESSAGE_LOCATION_TTL_MS
    - invalidateCache() clears all messageLocations entries
    - After deleteMessage succeeds, cache.messageLocations no longer has an entry for that id
    - After moveMessage succeeds, cache.messageLocations entry for id has mailbox = targetMailbox
    - getMessageById populates the cache on success (parts[7] = mailbox, parts[8] = account)
  </behavior>
  <action>
Add the location cache infrastructure and wire it into all affected methods. Read current line numbers before editing.

STEP A — Extend the cache object (line 184):
  BEFORE:
    ```typescript
    private cache = {
      accounts: null as { data: Account[]; expiry: number } | null,
      mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
    };
    ```
  AFTER:
    ```typescript
    private cache = {
      accounts: null as { data: Account[]; expiry: number } | null,
      mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
      messageLocations: new Map<string, { mailbox: string; account: string; expiry: number }>(),
    };
    ```

STEP B — Add new constant after DEFAULT_ACCOUNT_TTL_MS:
    `private readonly MESSAGE_LOCATION_TTL_MS = 5 * 60_000; // 5 minutes`

STEP C — Add two private helper methods after invalidateCache():
    ```typescript
    private resolveMessageLocation(id: string): { mailbox: string; account: string } | null {
      const now = Date.now();
      const cached = this.cache.messageLocations.get(id);
      if (cached && now < cached.expiry) {
        return { mailbox: cached.mailbox, account: cached.account };
      }
      return null;
    }

    private cacheMessageLocation(id: string, mailbox: string, account: string): void {
      this.cache.messageLocations.set(id, {
        mailbox,
        account,
        expiry: Date.now() + this.MESSAGE_LOCATION_TTL_MS,
      });
    }
    ```

STEP D — Update invalidateCache() to clear messageLocations:
    Add `this.cache.messageLocations.clear();` inside invalidateCache().

STEP E — Populate cache in getMessageById (around line 619):
    After the `return { id: ..., subject: ..., mailbox: parts[7], account: parts[8], ... }` block is built but before it is returned, add:
    `this.cacheMessageLocation(id, parts[7], parts[8]);`
    Then return the message object.

STEP F — Populate cache in parseMessageList or inline in listMessages/searchMessages:
    Search for the private parseMessageList method (if it exists). If it returns Message objects with mailbox and account fields set, add `this.cacheMessageLocation(msg.id, msg.mailbox, msg.account)` for each message before it is pushed to the result array.
    If listMessages and searchMessages each parse inline without parseMessageList, add the cacheMessageLocation call at each message-construction site.

STEP G — Update deleteMessage (around line 1281):
    After confirming success (`if (!result.success || result.output.startsWith("error:"))`), add before the `return true`:
    `this.cache.messageLocations.delete(id);`

STEP H — Update moveMessage (around line 1327):
    After confirming success, add before `return true`:
    `this.cacheMessageLocation(id, targetMailbox, targetAccount);`

Do NOT add cache-hit fast paths to the AppleScript generation in this task — the cache is used for population only in Phase 5. The O(1) lookup optimisation described in RESEARCH.md is a follow-up. Keeping this scope prevents the 40% context risk of rewriting 8 AppleScript bodies.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test passes; grep confirms "messageLocations" appears in cache object, invalidateCache, resolveMessageLocation, cacheMessageLocation, getMessageById, deleteMessage, and moveMessage.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Persistent config file + get-config and set-config MCP tools</name>
  <files>src/services/appleMailManager.ts, src/index.ts</files>
  <behavior>
    - loadConfig() on missing file leaves this.config as {} without throwing
    - loadConfig() on a valid config.json sets this.config to the parsed object
    - loadConfig() on a corrupt JSON file logs an error and leaves this.config as {} without throwing
    - loadConfig() when config.defaultAccount is set seeds defaultAccountCache with a fresh TTL
    - setConfig({ defaultAccount: "iCloud" }) persists {defaultAccount: "iCloud"} to CONFIG_FILE
    - setConfig({ timeoutMs: 30000 }) merges into existing config without clearing other keys
    - getConfig() returns a shallow copy of this.config (mutations to the returned object do not affect this.config)
    - MCP tool get-config returns the current config as a JSON string in the tool response text
    - MCP tool set-config accepts optional defaultAccount, defaultMailbox, timeoutMs and calls mailManager.setConfig
  </behavior>
  <action>
Add config persistence to AppleMailManager and register two MCP tools.

IN src/services/appleMailManager.ts:

STEP A — Add CONFIG_FILE path constant after TEMPLATE_FILE (line 168):
    `private readonly CONFIG_FILE = join(homedir(), ".config", "apple-mail-mcp", "config.json");`

STEP B — Add config field declaration after the CONFIG_FILE declaration:
    ```typescript
    private config: {
      defaultAccount?: string;
      defaultMailbox?: string;
      timeoutMs?: number;
    } = {};
    ```

STEP C — Update constructor (line 170) to call loadConfig after loadTemplates:
    ```typescript
    constructor() {
      this.loadTemplates();
      this.loadConfig();
    }
    ```

STEP D — Add four methods after persistTemplates (around line 2311). Follow the same error-handling style as loadTemplates/persistTemplates exactly:

    ```typescript
    private loadConfig(): void {
      try {
        if (!existsSync(this.CONFIG_FILE)) return;
        const raw = readFileSync(this.CONFIG_FILE, "utf8");
        this.config = JSON.parse(raw) as typeof this.config;
        if (this.config.defaultAccount) {
          this.defaultAccountCache = {
            value: this.config.defaultAccount,
            expiresAt: Date.now() + this.DEFAULT_ACCOUNT_TTL_MS,
          };
        }
      } catch (err) {
        console.error(`[apple-mail-mcp] Failed to load config: ${err}`);
      }
    }

    private persistConfig(): void {
      try {
        const dir = join(homedir(), ".config", "apple-mail-mcp");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.CONFIG_FILE, JSON.stringify(this.config, null, 2), "utf8");
      } catch (err) {
        console.error(`[apple-mail-mcp] Failed to persist config: ${err}`);
      }
    }

    getConfig(): { defaultAccount?: string; defaultMailbox?: string; timeoutMs?: number } {
      return { ...this.config };
    }

    setConfig(partial: { defaultAccount?: string; defaultMailbox?: string; timeoutMs?: number }): void {
      this.config = { ...this.config, ...partial };
      this.persistConfig();
    }
    ```

IN src/index.ts:

Find the last registered tool (likely one of the Phase 4 intelligence tools) and append two new tool registrations after it, before any server.connect() call.

Tool 1 — get-config:
    ```typescript
    server.tool(
      "get-config",
      "Get the current persistent configuration (defaultAccount, defaultMailbox, timeoutMs).",
      {},
      async () => {
        const config = mailManager.getConfig();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(config, null, 2),
            },
          ],
        };
      }
    );
    ```

Tool 2 — set-config:
    ```typescript
    server.tool(
      "set-config",
      "Update one or more persistent configuration values. Only provided fields are changed.",
      {
        defaultAccount: z.string().optional().describe("Default Mail account name to use when none is specified"),
        defaultMailbox: z.string().optional().describe("Default mailbox name (e.g. INBOX) to use when none is specified"),
        timeoutMs: z.number().int().positive().optional().describe("AppleScript timeout in milliseconds (e.g. 60000)"),
      },
      async ({ defaultAccount, defaultMailbox, timeoutMs }) => {
        mailManager.setConfig({ defaultAccount, defaultMailbox, timeoutMs });
        const updated = mailManager.getConfig();
        return {
          content: [
            {
              type: "text",
              text: `Config updated:\n${JSON.stringify(updated, null, 2)}`,
            },
          ],
        };
      }
    );
    ```

Verify that the `z` import and `mailManager` variable are already in scope at the top of index.ts before adding these tools — they are, from prior phases.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test passes; grep confirms "get-config" and "set-config" are present in src/index.ts; grep confirms "CONFIG_FILE" and "loadConfig" are present in src/services/appleMailManager.ts.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: Phase 5 unit tests</name>
  <files>src/__tests__/phase5.test.ts</files>
  <behavior>
    Suite "Message location cache":
    - resolveMessageLocation returns null on cold cache
    - resolveMessageLocation returns {mailbox, account} after cacheMessageLocation is called
    - resolveMessageLocation returns null after TTL has expired (use vi.setSystemTime)
    - invalidateCache() clears messageLocations

    Suite "defaultAccount TTL":
    - resolveAccount uses cached value within TTL (AppleScript not called again)
    - resolveAccount calls AppleScript again after TTL expires (vi.setSystemTime advances past expiresAt)
    - invalidateCache() clears defaultAccountCache so next resolveAccount call re-queries

    Suite "listMailboxes lazy count":
    - listMailboxes(account, false) generates AppleScript that does NOT contain "count of messages of mb"
    - listMailboxes(account, true) generates AppleScript that contains "count of messages of mb"

    Suite "Persistent config":
    - loadConfig() on missing file leaves config as {}
    - loadConfig() on valid JSON sets config fields correctly
    - loadConfig() on corrupt JSON logs error and leaves config as {}
    - setConfig merges partial into existing config
    - setConfig calls persistConfig which writes to CONFIG_FILE
    - getConfig returns a copy (mutating result does not change internal state)
  </behavior>
  <action>
Create src/__tests__/phase5.test.ts following the established Phase 4 test pattern. Read src/__tests__/phase4.test.ts first to confirm the exact import style, vi.mock placement, and beforeEach structure used in that file, then replicate it.

Key implementation notes:

- Use `vi.mock('fs', ...)` at module level for config file tests (same as Phase 2 pattern — see Phase 2 SUMMARY: "module-level vi.mock('fs') with vi.fn() references configured per-test").
- Use `vi.useFakeTimers()` and `vi.setSystemTime()` for TTL expiry tests; restore with `vi.useRealTimers()` in afterEach.
- To test private methods (resolveMessageLocation, cacheMessageLocation), access them via `(manager as any).resolveMessageLocation(id)` etc.
- To test listMailboxes AppleScript content without calling Mail.app, mock `executeAppleScript` to capture the script argument:
    ```typescript
    let capturedScript = "";
    vi.mocked(executeAppleScript).mockImplementation((script) => {
      capturedScript = script;
      return { success: true, output: "", error: undefined };
    });
    manager.listMailboxes("iCloud", false);
    expect(capturedScript).not.toContain("count of messages of mb");
    ```
- For config tests, mock `existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync` from 'fs'.
- For defaultAccount TTL: mock executeAppleScript to return a fake sender address; call resolveAccount() twice with a time advance between calls; assert execute was called exactly once in the first scenario (within TTL) and twice in the second (after TTL).

Test count target: at least 16 tests across 4 suites (matching the behavior blocks above). All must pass.

Run after creation:
    `npm test -- --reporter=verbose`
  </action>
  <verify>
    <automated>npm test -- --reporter=verbose 2>&1 | grep -E "phase5|PASS|FAIL|Tests:"</automated>
  </verify>
  <done>npm test passes with all Phase 5 tests green; total test count is at least 145 (129 existing + 16 new); npx tsc --noEmit exits 0.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| config file → AppleMailManager | JSON from ~/.config/apple-mail-mcp/config.json is read by the process; corrupt or adversarially crafted config values flow into resolveAccount() and listMailboxes() |
| MCP client → set-config tool | An MCP client can write arbitrary strings to defaultAccount/defaultMailbox fields that are subsequently used in AppleScript via resolveAccount → escapeForAppleScript |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-05-01 | Tampering | config.json → defaultAccount | mitigate | config.defaultAccount is passed through resolveAccount() which then passes it to buildAccountScopedScript() → escapeForAppleScript(); the existing escaping handles injection; no additional change needed |
| T-05-02 | Tampering | set-config tool → defaultMailbox | mitigate | defaultMailbox is passed through resolveMailbox() → buildAccountScopedScript() → escapeForAppleScript(); existing escaping sufficient |
| T-05-03 | Denial of Service | timeoutMs config | mitigate | In setConfig, timeoutMs is validated as `z.number().int().positive()` at the MCP layer; Zod schema enforces positive integer before reaching the service layer |
| T-05-04 | Information Disclosure | config.json on disk | accept | File is in user's home directory (~/.config/), readable by the user only under normal macOS permissions; no new risk vs. existing templates.json |
| T-05-05 | Tampering | messageLocations cache poisoning on move | mitigate | moveMessage clears and re-populates the cache entry to the new location after a successful move; deleteMessage removes the entry; stale entries expire after 5 minutes via TTL check in resolveMessageLocation |
| T-05-SC | Tampering | npm/pip/cargo installs | mitigate | No new runtime packages added in this phase; @cfworker/json-schema (if installed) is a devDependency only — verify via npmjs.com if prompted during install |
</threat_model>

<verification>
After all five tasks complete, run the full suite:

```bash
npm test
npx tsc --noEmit
npm run lint
```

Expected: all tests pass (145+), zero TypeScript errors, zero lint errors.

Manual spot-checks (not blocking):
- Confirm `~/.config/apple-mail-mcp/config.json` is created after first `set-config` call (run server, call tool)
- Confirm `healthCheck` response time improves (listMailboxes no longer counts messages in health path)
</verification>

<success_criteria>
- package.json: @modelcontextprotocol/sdk at ^1.29.0, vitest and @vitest/coverage-v8 at ^4.1.7, @types/node at ^22.0.0
- All 129 pre-existing tests continue to pass after dependency update
- resolveAccount() has TTL logic; invalidateCache() nulls defaultAccountCache
- listMailboxes(account, false) conditionally omits count of messages of mb; healthCheck passes false
- cache.messageLocations exists on the cache object; resolveMessageLocation and cacheMessageLocation are implemented; invalidateCache clears it; getMessageById, moveMessage, and deleteMessage update it
- CONFIG_FILE path, loadConfig, persistConfig, getConfig, setConfig are present in AppleMailManager
- get-config and set-config tools are registered in src/index.ts
- src/__tests__/phase5.test.ts exists with at least 16 tests, all passing
- npx tsc --noEmit exits 0
</success_criteria>

<output>
Create `.planning/phases/phase-5/05-01-SUMMARY.md` when done, following the template established in prior phases. Include: tasks completed, files changed, test count before/after, any deviations from this plan.
</output>
