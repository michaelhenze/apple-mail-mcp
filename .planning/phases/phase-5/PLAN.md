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
    - "resolveAccount() respects a 5-minute TTL and invalidateCache() clears the defaultAccountCache"
    - "listMailboxes(account, false) omits the expensive count of messages AppleScript and returns messageCount: 0"
    - "healthCheck() calls listMailboxes with includeCount=false"
    - "Message-ID location cache is added to this.cache.messageLocations; resolveMessageLocation() returns a hit within TTL"
    - "cacheMessageLocation() is called in getMessageById, listMessages/parseMessageList, searchMessages, moveMessage, and deleteMessage"
    - "invalidateCache() clears cache.messageLocations"
    - "When getCachedLocation returns a hit, the message op does not execute the O(N×M) nested AppleScript loop — findMessageScript routes to a targeted single-mailbox AppleScript"
    - "When the targeted AppleScript fails (cache stale), findMessageScript falls back to the full scan and repopulates the cache"
    - "~/.config/apple-mail-mcp/config.json is created on first setConfig call with correct schema"
    - "getConfig() returns defaultAccount, defaultMailbox, and timeoutMs from disk; returns {} if file absent"
    - "MCP tools get-config and set-config are registered in src/index.ts"
    - "npx tsc --noEmit passes with zero errors after all changes"
    - "Phase 5 test suite passes: cache hit/miss TTL, fast-path scan-skip, lazy count, config round-trip, defaultAccount TTL"
  artifacts:
    - path: "src/services/appleMailManager.ts"
      provides: "All five performance and correctness fixes including cache fast-path"
      contains: "messageLocations"
    - path: "src/__tests__/phase5.test.ts"
      provides: "Unit tests for Phase 5 logic"
    - path: "src/index.ts"
      provides: "get-config and set-config MCP tool registrations"
    - path: "package.json"
      provides: "Updated dependency versions"
  key_links:
    - from: "src/services/appleMailManager.ts (findMessageScript)"
      to: "resolveMessageLocation"
      via: "cache hit check before AppleScript generation"
      pattern: "resolveMessageLocation"
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
Deliver five targeted improvements to appleMailManager.ts: (1) dependency updates, (2) defaultAccount TTL fix + listMailboxes lazy count, (3) message-ID location cache infrastructure, (4) cache fast-path — the actual O(1) scan-skip in findMessageScript, and (5) persistent config file with get-config/set-config MCP tools.

Purpose: Eliminate O(accounts x mailboxes) scans on every message operation by routing cached-location hits to targeted single-mailbox AppleScript instead of the nested repeat loop. Fix a permanent-cache bug. Add user-configurable defaults accessible via MCP tools. Keep the toolchain current.

Output: Updated package.json, all five fixes in appleMailManager.ts, get-config/set-config tools in index.ts, and a passing phase5.test.ts with 145+ total tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/michaelhenze/apple-mail-mcp/.planning/ROADMAP.md
@/Users/michaelhenze/apple-mail-mcp/.planning/STATE.md
@/Users/michaelhenze/apple-mail-mcp/src/services/appleMailManager.ts
@/Users/michaelhenze/apple-mail-mcp/src/index.ts
@/Users/michaelhenze/apple-mail-mcp/src/types.ts
@/Users/michaelhenze/apple-mail-mcp/package.json

<interfaces>
<!-- Key interfaces and line anchors the executor needs. No codebase exploration required. -->

From src/services/appleMailManager.ts — current field declarations (lines 167–190):

```typescript
// Line 168
private readonly TEMPLATE_FILE = join(homedir(), ".config", "apple-mail-mcp", "templates.json");

// Constructor at line 170
constructor() {
  this.loadTemplates();
}

// Line 177
private defaultAccount: string | null = null;   // REPLACE with defaultAccountCache struct

// Lines 184–187 — cache object
private cache = {
  accounts: null as { data: Account[]; expiry: number } | null,
  mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
  // ADD: messageLocations key here
};

// Line 190
private readonly CACHE_TTL_MS = 60_000;
```

From src/services/appleMailManager.ts — invalidateCache (lines 225–228):
```typescript
private invalidateCache(): void {
  this.cache.accounts = null;
  this.cache.mailboxNames.clear();
  // ADD: this.cache.messageLocations.clear();
  // ADD: this.defaultAccountCache = null;
}
```

From src/services/appleMailManager.ts — resolveAccount (lines 235–273):
Three sites that write this.defaultAccount — replace all with defaultAccountCache struct writes.
Early-return check at line 237: `if (this.defaultAccount) return this.defaultAccount;`
→ replace with TTL-aware check.

From src/services/appleMailManager.ts — findMessageScript (lines 1135–1158):
```typescript
private findMessageScript(id: string, operation: string): string {
  if (!/^\d+$/.test(id)) {
    return buildAppLevelScript(`return "error:Invalid message ID"`);
  }
  return buildAppLevelScript(`
    try
      repeat with acct in accounts
        repeat with mb in mailboxes of acct
          try
            set matchingMsgs to (messages of mb whose id is ${id})
            if (count of matchingMsgs) > 0 then
              set msg to item 1 of matchingMsgs
              ${operation}  // <-- operation string injected here
              return "ok"
            end if
          end try
        end repeat
      end repeat
      return "error:Message not found"
    on error errMsg
      return "error:" & errMsg
    end try
  `);
}
```
Called by: markAsRead, markAsUnread, flagMessage, unflagMessage, markAsNotJunk, deleteMessage.

From src/services/appleMailManager.ts — listMailboxes (lines 1830–1871):
Current signature: `listMailboxes(account?: string): Mailbox[]`
The AppleScript template literal contains: `set mbCount to count of messages of mb`

From src/services/appleMailManager.ts — healthCheck (line 2405):
`const mailboxes = this.listMailboxes(accounts[0].name);`  // needs , false

From src/services/appleMailManager.ts — persistTemplates (lines 2297–2311):
Template pattern to follow exactly for loadConfig/persistConfig.

From src/index.ts — last tool registration (around line 1517):
```typescript
server.tool("detect-waiting-for", { ... }, withErrorHandling(...));
```
Server start (line 1573): `const transport = new StdioServerTransport();`
Add new tools between line ~1565 and line 1573.

Zod import: `import { z } from "zod";` already present at top of index.ts (line 26).
mailManager instance: `const mailManager = new AppleMailManager();` at line 51.
successResponse/errorResponse helpers are in scope at line 60.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Dependency updates — package.json, npm install, test suite green</name>
  <files>package.json, package-lock.json</files>
  <action>
Update package.json dependency versions, run npm install, and verify the test suite.

In "dependencies":
- Change `"@modelcontextprotocol/sdk": "1.4.1"` to `"@modelcontextprotocol/sdk": "^1.29.0"`

In "devDependencies":
- Change `"@types/node": "^20.0.0"` to `"@types/node": "^22.0.0"`
- Change `"@vitest/coverage-v8": "^2.1.9"` to `"@vitest/coverage-v8": "^4.1.7"`
- Change `"vitest": "^2.0.0"` to `"vitest": "^4.1.7"`

Do NOT change zod (stays at ^3.22.4 — installed version 3.25.76 satisfies SDK 1.29.0's peer dep of ^3.25).

After editing package.json, run:
  npm install

If npm warns about missing peer `@cfworker/json-schema`, log the warning and continue — it is an optional validation backend not used by this project. Only add `--legacy-peer-deps` or install the package as devDependency if npm exits with a non-zero code (error, not warning).

Run the full test suite to confirm all 129 existing tests still pass:
  npm test

Known safe breakages from vitest v2→v4 to watch for:
- `invocationCallOrder` numbering starts at 1 instead of 0 — fix the assertion if encountered
- `vi.restoreAllMocks()` scope change — tests use `vi.clearAllMocks()` so this should not apply

After tests pass, run the TypeScript compiler:
  npx tsc --noEmit

Fix any new type errors surfaced by @types/node@22 (likely none — all used APIs are stable since Node 14).
  </action>
  <verify>
    <automated>npm test && npx tsc --noEmit</automated>
  </verify>
  <done>package.json shows the four updated versions; npm test reports 129 passed, 0 failed; npx tsc --noEmit exits 0.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: defaultAccount TTL fix + listMailboxes lazy count</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - resolveAccount() with no argument and an expired defaultAccountCache (expiresAt in the past) re-runs the expensive AppleScript lookup rather than returning the stale value
    - resolveAccount() with a fresh defaultAccountCache (expiresAt in the future) returns the cached value without running AppleScript
    - invalidateCache() sets defaultAccountCache to null
    - listMailboxes(account, false) generates AppleScript containing "set mbCount to 0" (not "count of messages of mb")
    - listMailboxes(account, true) generates AppleScript containing "count of messages of mb"
    - listMailboxes() with no second argument defaults to includeCount=true (backward compatible)
  </behavior>
  <action>
Apply both changes to src/services/appleMailManager.ts. Grep for exact current line numbers before editing.

CHANGE 1 — defaultAccount TTL fix:

Replace the private field declaration (search for `private defaultAccount: string | null = null`):
  BEFORE: `private defaultAccount: string | null = null;`
  AFTER:  `private defaultAccountCache: { value: string; expiresAt: number } | null = null;`

Add a new constant after CACHE_TTL_MS (search for `private readonly CACHE_TTL_MS`):
  `private readonly DEFAULT_ACCOUNT_TTL_MS = 5 * 60_000; // 5 minutes`

Rewrite resolveAccount() — it is at lines 235–273. The method currently has three sites that assign `this.defaultAccount`. Replace ALL references as follows:

  Early-return check — BEFORE:
    `if (this.defaultAccount) return this.defaultAccount;`
  AFTER:
    ```typescript
    const now = Date.now();
    if (this.defaultAccountCache && now < this.defaultAccountCache.expiresAt) {
      return this.defaultAccountCache.value;
    }
    ```

  Assignment sites — every `this.defaultAccount = <name>;` becomes:
    `this.defaultAccountCache = { value: <name>, expiresAt: Date.now() + this.DEFAULT_ACCOUNT_TTL_MS };`

  Return sites — every `return this.defaultAccount;` becomes:
    `return this.defaultAccountCache!.value;`

Update invalidateCache() to add alongside the existing two clear lines:
  `this.defaultAccountCache = null;`

CHANGE 2 — listMailboxes lazy count:

Change the method signature (search for `listMailboxes(account?: string): Mailbox[]`):
  BEFORE: `listMailboxes(account?: string): Mailbox[]`
  AFTER:  `listMailboxes(account?: string, includeCount = true): Mailbox[]`

Inside the listCommand template string in listMailboxes, replace the static line:
  BEFORE: `set mbCount to count of messages of mb`
  AFTER (TypeScript ternary injected into template literal):
    `${includeCount ? "set mbCount to count of messages of mb" : "set mbCount to 0"}`

Update the healthCheck() caller (search for `const mailboxes = this.listMailboxes(accounts[0].name)`):
  BEFORE: `const mailboxes = this.listMailboxes(accounts[0].name);`
  AFTER:  `const mailboxes = this.listMailboxes(accounts[0].name, false);`

The getMailStats() call `this.listMailboxes(account.name)` must remain unchanged — it needs messageCount for stats output.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test passes; the string literal "count of messages of mb" inside the listMailboxes AppleScript is wrapped in the TypeScript ternary (not a bare string); healthCheck passes false as the second argument to listMailboxes.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Message-ID location cache — infrastructure + population</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - resolveMessageLocation(id) returns null on cold cache
    - resolveMessageLocation(id) returns {mailbox, account} after cacheMessageLocation is called with that id
    - resolveMessageLocation(id) returns null when the cache entry is expired (expiresAt <= Date.now())
    - cacheMessageLocation(id, mailbox, account) stores an entry with expiry = Date.now() + MESSAGE_LOCATION_TTL_MS
    - invalidateCache() clears all messageLocations entries
    - After deleteMessage succeeds, cache.messageLocations no longer contains an entry for that id
    - After moveMessage succeeds, the cache entry for id has mailbox = targetMailbox
    - getMessageById populates the cache on success
  </behavior>
  <action>
Add the location cache infrastructure and wire it into all affected methods.

STEP A — Extend the cache object (line 184):
  Add a third key to the existing cache object literal:
    `messageLocations: new Map<string, { mailbox: string; account: string; expiry: number }>(),`

STEP B — Add new constant after DEFAULT_ACCOUNT_TTL_MS:
  `private readonly MESSAGE_LOCATION_TTL_MS = 5 * 60_000; // 5 minutes`

STEP C — Add two private helper methods directly after invalidateCache():
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
  Add `this.cache.messageLocations.clear();` alongside the existing two clear lines.

STEP E — Populate cache in getMessageById (around line 619):
  After the message object is constructed from parsed parts (parts[7] = mailbox, parts[8] = account), add before the return statement:
  `this.cacheMessageLocation(id, parts[7], parts[8]);`

STEP F — Populate cache in listMessages and searchMessages:
  Search for the private parseMessageList method. If it exists and both listMessages/searchMessages route through it, add inside parseMessageList after each Message object is built:
  `this.cacheMessageLocation(msg.id, msg.mailbox, msg.account);`
  If there is no shared parseMessageList and each method builds messages inline, add the call at each message-construction site in both methods.

STEP G — Update deleteMessage (around line 1281):
  After confirming result.success and before `return true`, add:
  `this.cache.messageLocations.delete(id);`

STEP H — Update moveMessage (around line 1327):
  After confirming result.success, obtain targetMailbox and targetAccount from local variables in scope, then add before `return true`:
  `this.cacheMessageLocation(id, targetMailbox, targetAccount);`
  (Grep the moveMessage method body to confirm the variable names for the resolved mailbox and account — they may be named resolvedMailbox, targetMailbox, or similar.)
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test passes; grep confirms "messageLocations" appears in the cache object declaration, invalidateCache, resolveMessageLocation, cacheMessageLocation, getMessageById, deleteMessage, and moveMessage.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Cache fast-path — skip the O(N×M) scan when location is cached</name>
  <files>src/services/appleMailManager.ts</files>
  <behavior>
    - When resolveMessageLocation(id) returns a cache hit, findMessageScript generates an AppleScript that targets mailbox "X" of account "Y" directly — no "repeat with acct in accounts / repeat with mb in mailboxes" loop
    - When resolveMessageLocation(id) returns null (cache miss), findMessageScript generates the existing nested-loop AppleScript (no regression)
    - When the targeted script returns "error:Message not found" (cache stale — message was moved externally), findMessageScript falls back to the full scan and calls cacheMessageLocation with the new location on success
    - The six callers of findMessageScript (markAsRead, markAsUnread, flagMessage, unflagMessage, markAsNotJunk, deleteMessage) automatically benefit from the fast-path with no changes to their call sites
  </behavior>
  <action>
Modify findMessageScript to check the location cache before generating AppleScript. This is the core performance win: a cache hit eliminates the O(accounts × mailboxes) nested loop.

Read findMessageScript at lines 1135–1158 carefully before editing. The current implementation is:

```typescript
private findMessageScript(id: string, operation: string): string {
  if (!/^\d+$/.test(id)) {
    return buildAppLevelScript(`return "error:Invalid message ID"`);
  }
  return buildAppLevelScript(`
    try
      repeat with acct in accounts
        repeat with mb in mailboxes of acct
          ...nested loop AppleScript...
        end repeat
      end repeat
      return "error:Message not found"
    on error errMsg
      return "error:" & errMsg
    end try
  `);
}
```

Replace findMessageScript with a new implementation that:

1. Validates the id (keep the existing `!/^\d+$/.test(id)` guard — return early with error script if invalid).

2. Calls `this.resolveMessageLocation(id)` to check the cache.

3. If cache HIT — generate a targeted AppleScript that:
   - Uses `escapeForAppleScript(location.mailbox)` and `escapeForAppleScript(location.account)` for the targeted lookup
   - Tries the direct lookup first inside a `try` block
   - If the message is found in that mailbox, executes the operation and returns "ok"
   - If the message is NOT found in that mailbox (cache stale), falls through to the full nested-loop scan
   - After the full scan succeeds, there is no way to call back into TypeScript from AppleScript — accept this: the AppleScript fall-through itself will find the message; the cache will be repopulated on the NEXT call to getMessageById or when markAsRead/etc. is called again after an explicit getMessageById
   - IMPORTANT: The fallback must be inside the SAME AppleScript string so it executes as a single osascript call without a round-trip

   The targeted AppleScript structure:
   ```applescript
   tell application "Mail"
     try
       set targetMb to mailbox "<escaped_mailbox>" of account "<escaped_account>"
       set matchingMsgs to (messages of targetMb whose id is <id>)
       if (count of matchingMsgs) > 0 then
         set msg to item 1 of matchingMsgs
         <operation>
         return "ok"
       end if
     end try
     -- Cache miss or stale: fall back to full scan
     try
       repeat with acct in accounts
         repeat with mb in mailboxes of acct
           try
             set matchingMsgs to (messages of mb whose id is <id>)
             if (count of matchingMsgs) > 0 then
               set msg to item 1 of matchingMsgs
               <operation>
               return "ok"
             end if
           end try
         end repeat
       end repeat
       return "error:Message not found"
     on error errMsg
       return "error:" & errMsg
     end try
   end tell
   ```

4. If cache MISS — generate the existing nested-loop AppleScript (unchanged from current implementation).

Use `buildAppLevelScript` for the outer `tell application "Mail"` wrapper in both the cache-hit and cache-miss paths (or construct the outer tell block manually with escaping — either is acceptable as long as the escaping is consistent).

Use `escapeForAppleScript` (already defined at line 57 of the file) for mailbox and account name injection.

After implementing, run `npx tsc --noEmit` to catch any TypeScript errors before proceeding.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test passes; the findMessageScript method body contains a call to resolveMessageLocation; the fast-path AppleScript contains a targeted `mailbox "..." of account "..."` lookup followed by a full-scan fallback; no existing tests regress.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: Persistent config file + get-config and set-config MCP tools</name>
  <files>src/services/appleMailManager.ts, src/index.ts</files>
  <behavior>
    - loadConfig() on missing file leaves this.config as {} without throwing
    - loadConfig() on a valid config.json sets this.config to the parsed object
    - loadConfig() on a corrupt JSON file logs an error and leaves this.config as {} without throwing
    - loadConfig() when config.defaultAccount is set seeds defaultAccountCache with a fresh TTL
    - setConfig({ defaultAccount: "iCloud" }) persists {defaultAccount: "iCloud"} to CONFIG_FILE
    - setConfig({ timeoutMs: 30000 }) merges into existing config without clearing other keys
    - getConfig() returns a shallow copy of this.config (mutations to the returned object do not affect this.config)
    - MCP tool get-config returns the current config as a formatted JSON string in the tool response text
    - MCP tool set-config accepts optional defaultAccount, defaultMailbox, timeoutMs and calls mailManager.setConfig, then returns the updated config
  </behavior>
  <action>
Add config persistence to AppleMailManager and register two MCP tools in src/index.ts.

IN src/services/appleMailManager.ts:

STEP A — Add CONFIG_FILE path constant after TEMPLATE_FILE (line 168):
  `private readonly CONFIG_FILE = join(homedir(), ".config", "apple-mail-mcp", "config.json");`

STEP B — Add config field declaration after CONFIG_FILE:
  ```typescript
  private config: {
    defaultAccount?: string;
    defaultMailbox?: string;
    timeoutMs?: number;
  } = {};
  ```

STEP C — Update constructor to call loadConfig after loadTemplates:
  ```typescript
  constructor() {
    this.loadTemplates();
    this.loadConfig();
  }
  ```

STEP D — Add four methods after persistTemplates (around line 2311). Follow the exact error-handling style of loadTemplates/persistTemplates:

  ```typescript
  private loadConfig(): void {
    try {
      if (!existsSync(this.CONFIG_FILE)) return;
      const raw = readFileSync(this.CONFIG_FILE, "utf8");
      this.config = JSON.parse(raw) as typeof this.config;
      // Seed the TTL cache from config as a preference hint
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

Add two new tool registrations after the detect-waiting-for tool (around line 1565) and before `const transport = new StdioServerTransport();` (line 1573). The `z`, `server`, and `mailManager` variables are already in scope.

Tool 1 — get-config:
  ```typescript
  server.tool(
    "get-config",
    "Get the current persistent configuration for apple-mail-mcp (defaultAccount, defaultMailbox, timeoutMs). Returns {} if no config file exists yet.",
    {},
    withErrorHandling(() => {
      const config = mailManager.getConfig();
      return successResponse(JSON.stringify(config, null, 2));
    }, "Error getting config")
  );
  ```

Tool 2 — set-config:
  ```typescript
  server.tool(
    "set-config",
    "Update one or more persistent configuration values. Only provided fields are changed; omitted fields retain their current values.",
    {
      defaultAccount: z.string().optional().describe("Default Mail account name to use when none is specified"),
      defaultMailbox: z.string().optional().describe("Default mailbox name (e.g. INBOX) to use when none is specified"),
      timeoutMs: z.number().int().positive().optional().describe("AppleScript timeout in milliseconds (e.g. 60000)"),
    },
    withErrorHandling(({ defaultAccount, defaultMailbox, timeoutMs }) => {
      mailManager.setConfig({ defaultAccount, defaultMailbox, timeoutMs });
      const updated = mailManager.getConfig();
      return successResponse(`Config updated:\n${JSON.stringify(updated, null, 2)}`);
    }, "Error setting config")
  );
  ```

Use `withErrorHandling` and `successResponse` helpers (already defined in index.ts at lines 60–83) rather than raw async arrow functions — this matches the pattern of all other tools in the file.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm test</automated>
  </verify>
  <done>npx tsc --noEmit exits 0; npm test passes; grep confirms "get-config" and "set-config" are present in src/index.ts; grep confirms "CONFIG_FILE", "loadConfig", "getConfig", and "setConfig" are present in src/services/appleMailManager.ts.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6: Phase 5 unit tests</name>
  <files>src/__tests__/phase5.test.ts</files>
  <behavior>
    Suite "Message location cache":
    - resolveMessageLocation returns null on cold cache
    - resolveMessageLocation returns {mailbox, account} after cacheMessageLocation is called
    - resolveMessageLocation returns null after TTL has expired (use vi.setSystemTime)
    - invalidateCache() clears messageLocations (resolveMessageLocation returns null after invalidate)

    Suite "Cache fast-path":
    - When resolveMessageLocation returns a hit, findMessageScript generates AppleScript containing the literal mailbox name and account name in a targeted lookup (does NOT contain "repeat with acct in accounts" as the first search path)
    - When resolveMessageLocation returns null (miss), findMessageScript generates AppleScript containing "repeat with acct in accounts"

    Suite "defaultAccount TTL":
    - resolveAccount uses cached value within TTL (executeAppleScript is called only once for two resolveAccount calls within TTL)
    - resolveAccount calls executeAppleScript again after TTL expires (vi.setSystemTime advances past expiresAt)
    - invalidateCache() clears defaultAccountCache so next resolveAccount call re-queries

    Suite "listMailboxes lazy count":
    - listMailboxes(account, false) captures AppleScript that does NOT contain "count of messages of mb"
    - listMailboxes(account, true) captures AppleScript that DOES contain "count of messages of mb"

    Suite "Persistent config":
    - loadConfig() on missing file leaves config as {}
    - loadConfig() on valid JSON sets config fields correctly
    - loadConfig() on corrupt JSON logs error and leaves config as {}
    - setConfig merges partial into existing config without overwriting unrelated keys
    - setConfig calls persistConfig which calls writeFileSync with the config file path
    - getConfig returns a shallow copy (mutating the returned object does not affect internal state)
  </behavior>
  <action>
Create src/__tests__/phase5.test.ts following the Phase 4 test pattern. Before writing, read src/__tests__/phase4.test.ts to confirm the exact import style, vi.mock placement, and beforeEach structure, then replicate it.

Key implementation notes:

Use `vi.mock('@/utils/applescript.js', ...)` at module level for tests that need to intercept AppleScript calls (same pattern as prior phases).

Use `vi.useFakeTimers()` and `vi.setSystemTime()` for TTL expiry tests. Always call `vi.useRealTimers()` in afterEach.

To test private methods (resolveMessageLocation, cacheMessageLocation, findMessageScript), access via `(manager as any).methodName(args)`.

For the cache fast-path test — capture the generated script string by intercepting executeAppleScript:
  ```typescript
  let capturedScript = "";
  vi.mocked(executeAppleScript).mockImplementation((script) => {
    capturedScript = typeof script === "string" ? script : "";
    return { success: true, output: "ok", error: undefined };
  });
  // Seed the cache first
  (manager as any).cacheMessageLocation("999", "INBOX", "iCloud");
  // Call a method that uses findMessageScript
  (manager as any).findMessageScript("999", "set read status of msg to true");
  // Assert the generated script targets the cached mailbox directly
  expect(capturedScript).toContain('mailbox "INBOX"');
  expect(capturedScript).toContain('account "iCloud"');
  // Also assert the full-scan fallback is present as a fallback path
  expect(capturedScript).toContain("repeat with acct in accounts");
  ```

For config tests — mock the 'fs' module:
  ```typescript
  vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
  });
  ```
  Configure `vi.mocked(existsSync)` and `vi.mocked(readFileSync)` per test.

For defaultAccount TTL tests — mock executeAppleScript to return a valid sender string matching an account; call resolveAccount() twice within TTL and assert executeAppleScript call count = 1; then advance time past DEFAULT_ACCOUNT_TTL_MS and call again and assert call count = 2.

Test count target: at least 16 tests across 5 suites (matching the behavior blocks above). All must pass.

Run after creation:
  npm test -- --reporter=verbose
  </action>
  <verify>
    <automated>npm test -- --reporter=verbose 2>&1 | grep -E "phase5|Tests:|passed|failed"</automated>
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
| location cache → findMessageScript | Cached mailbox/account strings are injected into AppleScript; must be escaped |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-05-01 | Tampering | config.json → defaultAccount → AppleScript | mitigate | config.defaultAccount seeds defaultAccountCache; when used, it is passed through resolveAccount() → buildAccountScopedScript() → escapeForAppleScript(); existing escaping handles injection; no additional change needed |
| T-05-02 | Tampering | set-config tool → defaultMailbox → AppleScript | mitigate | defaultMailbox is passed through resolveMailbox() → buildAccountScopedScript() → escapeForAppleScript(); existing escaping sufficient |
| T-05-03 | Denial of Service | timeoutMs config | mitigate | In set-config, timeoutMs is validated as `z.number().int().positive()` at the MCP tool layer (Zod schema) before reaching the service layer |
| T-05-04 | Information Disclosure | config.json on disk | accept | File lives in user's home directory (~/.config/), readable by the process owner only under normal macOS permissions; no new risk vs. existing templates.json |
| T-05-05 | Tampering | location cache → findMessageScript AppleScript injection | mitigate | Cached mailbox and account strings are passed through escapeForAppleScript() before being embedded in the targeted AppleScript — same escaping applied to all account/mailbox name injections throughout the file |
| T-05-06 | Tampering | location cache poisoning on move | mitigate | moveMessage clears and re-populates the cache entry to the new location after a successful move; deleteMessage removes the entry; stale entries expire after 5 minutes via TTL check in resolveMessageLocation; targeted AppleScript includes a full-scan fallback if targeted lookup returns no message |
| T-05-SC | Tampering | npm/pip/cargo installs | mitigate | No new runtime packages added; @cfworker/json-schema (if installed) is devDependency only — verify via npmjs.com if prompted during install |
</threat_model>

<verification>
After all six tasks complete, run the full suite:

  npm test
  npx tsc --noEmit
  npm run lint

Expected: all tests pass (145+), zero TypeScript errors, zero lint errors.

Key behavioral checks (automated via test suite):
- findMessageScript with a warm cache generates targeted AppleScript (not bare nested loop) — covered in phase5.test.ts
- findMessageScript with a cold cache generates the nested-loop AppleScript — covered in phase5.test.ts
- listMailboxes(account, false) does not contain "count of messages of mb" — covered in phase5.test.ts
- Config round-trip via setConfig → loadConfig → getConfig returns same values — covered in phase5.test.ts
</verification>

<success_criteria>
- package.json: @modelcontextprotocol/sdk at ^1.29.0, vitest and @vitest/coverage-v8 at ^4.1.7, @types/node at ^22.0.0
- All 129 pre-existing tests continue to pass after dependency update
- resolveAccount() has TTL logic; invalidateCache() nulls defaultAccountCache
- listMailboxes(account, false) conditionally omits count of messages of mb; healthCheck passes false
- cache.messageLocations exists on the cache object; resolveMessageLocation and cacheMessageLocation are implemented; invalidateCache clears it; getMessageById, moveMessage, and deleteMessage update it
- findMessageScript checks resolveMessageLocation before generating AppleScript; cache hit produces targeted single-mailbox script with full-scan fallback inline
- CONFIG_FILE path, loadConfig, persistConfig, getConfig, setConfig are present in AppleMailManager
- get-config and set-config tools are registered in src/index.ts using withErrorHandling and successResponse helpers
- src/__tests__/phase5.test.ts exists with at least 16 tests across 5 suites, all passing
- Total test count is 145 or more
- npx tsc --noEmit exits 0
</success_criteria>

<output>
Create `.planning/phases/phase-5/05-01-SUMMARY.md` when done, following the template established in prior phases. Include: tasks completed, files changed, test count before/after, any deviations from this plan.
</output>
