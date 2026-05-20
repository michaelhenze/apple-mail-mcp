# Phase 5: Performance & Technical Health - Research

**Researched:** 2026-05-20
**Domain:** TypeScript performance patterns, Node.js in-memory caching, filesystem persistence, npm dependency management
**Confidence:** HIGH

---

## Summary

Phase 5 has five distinct work streams: (1) a message-ID location cache to eliminate O(accounts × mailboxes) scans, (2) a lazy-count option for `listMailboxes`, (3) a persistent config file following the established template pattern, (4) dependency updates across three packages, and (5) a TTL/invalidation fix for `defaultAccount`.

All five streams are clearly scoped, low-risk changes within a single file (`appleMailManager.ts`) plus `package.json`. No new external runtime packages are required — the cache and config use built-in Node.js APIs already imported. The dependency updates introduce no breaking changes that affect the current codebase when moving within the v1.x series (SDK) or within v4.x (vitest/types).

**Primary recommendation:** Implement the cache first (highest runtime value), then config persistence (user-visible feature), then dependency updates (toolchain), and finish with `listMailboxes` lazy count and `defaultAccount` TTL fix (polish).

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Message-ID location cache | Service layer (AppleMailManager) | — | Cache lives inside the class alongside existing `this.cache`; no new tier needed |
| listMailboxes lazy count | Service layer (AppleMailManager) | MCP tool layer (index.ts) | Method signature change; tool handlers pass `includeCount` flag |
| Persistent config file | Service layer (AppleMailManager) | Filesystem (~/.config/…) | Follows template persistence pattern already in the class |
| Dependency updates | Toolchain (package.json) | — | Pure npm/build concern |
| defaultAccount TTL fix | Service layer (AppleMailManager) | — | `resolveAccount()` sets `this.defaultAccount` with no expiry |

---

## Scope Item 1: Message-ID Location Cache

### Problem: O(accounts × mailboxes) scan on every message operation

**Location in code:** Every method that needs to find a message by ID uses one of two patterns:

1. **`findMessageScript(id, operation)` (lines 1135–1158)** — the shared helper used by `markAsRead`, `markAsUnread`, `flagMessage`, `unflagMessage`, `markAsNotJunk`, `deleteMessage`. It generates an AppleScript that does:
   ```applescript
   repeat with acct in accounts
     repeat with mb in mailboxes of acct
       set matchingMsgs to (messages of mb whose id is X)
       ...
     end repeat
   end repeat
   ```

2. **`getMessageById` (lines 523–620)** — same nested-loop pattern, directly inlined.

3. **`getMessageContent` (lines 625–677)** — same nested-loop pattern, directly inlined.

4. **`replyToMessage` (lines 1035–1074)** — same nested-loop pattern, directly inlined.

5. **`forwardMessage` (lines 1085–1130)** — same nested-loop pattern, directly inlined.

6. **`moveMessage` (lines 1296–1335)** — same nested-loop pattern, directly inlined.

7. **`listAttachments` (lines 1692–1750)** — same nested-loop pattern, directly inlined.

8. **`saveAttachment` (lines 1755–1821)** — same nested-loop pattern, directly inlined.

Every single message operation runs the full account × mailbox scan even when the caller already knows where the message is.

### Cache Design

**Structure** (fits alongside existing `this.cache` object at line 184):

```typescript
private messageLocationCache = new Map<
  string,
  { mailbox: string; account: string; expiresAt: number }
>();
private readonly MESSAGE_LOCATION_TTL_MS = 5 * 60_000; // 5 minutes
```

**Why 5 minutes (not 60 s):** Message location (which mailbox) is stable between calls unless the user explicitly moves a message. A 5-minute TTL reduces scan frequency without causing stale data issues — a move operation invalidates the entry immediately. [ASSUMED]

**Cache population points** — populate/refresh after successful resolution in:
- `getMessageById` (the most common read path; already returns `mailbox` and `account`)
- `listMessages` and `searchMessages` (return `mailbox` and `account` per message)
- `moveMessage` (update cache to new location after successful move)
- `deleteMessage` (remove from cache)
- `batchDeleteMessages`, `batchMoveMessages` (update/remove per id)

**Cache miss behaviour:** Fall back to the existing nested-loop AppleScript scan (no change to current logic). On success, populate the cache.

**Cache-aware script generation:** For operations that use `findMessageScript`, add a method `findMessageScriptWithCache(id, operation)` that:
1. Looks up `messageLocationCache.get(id)`
2. If hit and not expired: generate a targeted AppleScript scoped to `mailbox X of account Y` (O(1) instead of O(N×M))
3. If miss: run the full scan, populate cache on success

**Targeted AppleScript pattern (cache hit):**
```applescript
tell application "Mail"
  try
    set mb to mailbox "INBOX" of account "iCloud"
    set matchingMsgs to (messages of mb whose id is 12345)
    if (count of matchingMsgs) > 0 then
      set msg to item 1 of matchingMsgs
      -- operation here
      return "ok"
    end if
  end try
  -- cache stale: fall back to full scan
  repeat with acct in accounts
    ...
  end repeat
end tell
```

**Invalidation rules:**
- `deleteMessage(id)` → remove `id` from cache
- `moveMessage(id, newMailbox)` → update cache entry to `{mailbox: newMailbox, account: ...}`
- `invalidateCache()` (called by `createMailbox`/`deleteMailbox`/`renameMailbox`) → also clear `messageLocationCache`

### Key Observation: `getMessageById` Already Returns Location

`getMessageById` returns a `Message` with `mailbox` and `account` fields (lines 615–616). Every caller that has called `getMessageById` already has the location. The cache lets subsequent operations on the same ID skip the scan.

---

## Scope Item 2: `listMailboxes` Lazy Count

### Current Code (lines 1830–1871)

```typescript
listMailboxes(account?: string): Mailbox[] {
  // ...
  const listCommand = `
    set mailboxList to {}
    repeat with mb in mailboxes
      set mbName to name of mb
      set mbUnread to unread count of mb
      set mbCount to count of messages of mb   ← EXPENSIVE on large mailboxes
      ...
    end repeat
  `;
}
```

`count of messages of mb` forces AppleScript to enumerate all messages in every mailbox, even when the caller only needs folder names. This is called inside `getMailStats()` (lines 2421–2443) which iterates every account, compounding the cost.

### Callers that need counts

| Caller | Needs messageCount? |
|--------|---------------------|
| `getMailStats()` (line 2428) | YES — uses `mb.messageCount` and `mb.unreadCount` |
| `healthCheck()` (line 2405) | NO — uses only `mailboxes.length` |
| `resolveMailbox()` → `getCachedMailboxNames()` | NO — uses `fetchMailboxNames()` (separate method, never calls `listMailboxes`) |
| MCP `list-mailboxes` tool | YES — user expects counts |

### Proposed Change

Add an `includeCount` parameter defaulting to `true` for backward compatibility:

```typescript
listMailboxes(account?: string, includeCount = true): Mailbox[] {
```

When `includeCount` is `false`, the AppleScript omits `set mbCount to count of messages of mb` and returns `messageCount: 0`.

`healthCheck()` becomes: `this.listMailboxes(account, false)` — no count needed, faster.

The `list-mailboxes` MCP tool in `index.ts` continues to call `listMailboxes()` with default `includeCount: true`.

**Note:** `unreadCount` uses `unread count of mb` which is a cached property in Mail.app (not a full scan), so it is cheap and should always be returned. Only `count of messages of mb` is the expensive operation. [ASSUMED based on Mail.app behaviour; unread count is known to be a stored property]

---

## Scope Item 3: Persistent Configuration File

### Template Pattern (lines 168, 2278–2311) — Established

The template persistence pattern is the model to follow exactly:

```typescript
// Field declaration
private readonly TEMPLATE_FILE = join(homedir(), ".config", "apple-mail-mcp", "templates.json");

// Constructor call
this.loadTemplates();

// loadTemplates() — called in constructor, silently ignores corrupt file
private loadTemplates(): void {
  try {
    if (!existsSync(this.TEMPLATE_FILE)) return;
    const raw = readFileSync(this.TEMPLATE_FILE, "utf8");
    const data = JSON.parse(raw) as { ... };
    // assign to this.* fields
  } catch (err) {
    console.error(`[apple-mail-mcp] Failed to load templates: ${err}`);
  }
}

// persistTemplates() — called after every mutation
private persistTemplates(): void {
  try {
    const dir = join(homedir(), ".config", "apple-mail-mcp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.TEMPLATE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`[apple-mail-mcp] Failed to persist templates: ${err}`);
  }
}
```

All imports (`readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, `homedir`, `join`) are already at the top of the file (lines 16–19).

### Config File Design

**Path:** `~/.config/apple-mail-mcp/config.json` (same directory as `templates.json`)

**Field declarations:**

```typescript
private readonly CONFIG_FILE = join(homedir(), ".config", "apple-mail-mcp", "config.json");

private config: {
  defaultAccount?: string;
  defaultMailbox?: string;
  timeoutMs?: number;
} = {};
```

**File format:**

```json
{
  "defaultAccount": "iCloud",
  "defaultMailbox": "INBOX",
  "timeoutMs": 60000
}
```

**Config fields rationale:**

| Field | Why include | Current hardcode location |
|-------|------------|--------------------------|
| `defaultAccount` | User may want to pin default without relying on Mail.app's order | `resolveAccount()` sets `this.defaultAccount` at runtime |
| `defaultMailbox` | Useful for users who primarily work in a non-INBOX folder | Hardcoded `"INBOX"` in `listMessages`, `searchMessages` |
| `timeoutMs` | Power users on slow IMAP may want longer timeouts | `{ timeoutMs: 60000 }` passed to many `executeAppleScript` calls |

**Interaction with `defaultAccount` field:** If `config.defaultAccount` is set on load, assign it to `this.defaultAccount` in the constructor before the existing `resolveAccount` logic runs. This means the config-file default takes precedence over Mail.app's configured send account. [ASSUMED — needs user confirmation on precedence preference]

**MCP tool:** A `get-config` / `set-config` MCP tool is out of scope for Phase 5 — the config file is a power-user feature editable directly. [ASSUMED — no tool layer needed unless roadmap says otherwise]

---

## Scope Item 4: Dependency Updates

### Current vs Target Versions

| Package | Current | Target | Registry | Confidence |
|---------|---------|--------|----------|------------|
| `@modelcontextprotocol/sdk` | `1.4.1` (pinned) | `^1.29.0` | npm | [VERIFIED: npm registry] |
| `vitest` | `^2.0.0` | `^4.1.7` | npm | [VERIFIED: npm registry] |
| `@vitest/coverage-v8` | `^2.1.9` | `^4.1.7` | npm | [VERIFIED: npm registry] |
| `@types/node` | `^20.0.0` | `^22.0.0` | npm | [VERIFIED: npm registry] |

**Note:** `zod` is currently on `^3.22.4` (installed: `3.25.76`). The SDK 1.29.0 peer dep is `^3.25 || ^4.0`. The project's current pin `^3.22.4` allows resolving to `3.25.76` which satisfies `^3.25`. No zod version bump is required. [VERIFIED: npm registry — SDK peer dep, installed zod version]

### Breaking Change Analysis

#### `@modelcontextprotocol/sdk` 1.4.1 → 1.29.0

**Import paths:** `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js` still resolve via the `'./*'` wildcard export in 1.29.0. No import changes needed. [VERIFIED: npm registry — exports map]

**New dependencies in 1.29.0:** The SDK gains several new runtime dependencies (`@hono/node-server`, `express`, `jose`, `hono`, `pkce-challenge`, etc.) for OAuth and HTTP transport features that are not used by this project. These add to `node_modules` size but do not affect the stdio transport used here.

**`@cfworker/json-schema` peer dep:** New in 1.29.0. It is listed as a peer dependency but is optional — it is only required if using the AJV or cfworker schema validation backends. This project uses Zod directly. npm may warn about missing peer dep; add `--legacy-peer-deps` if needed or install `@cfworker/json-schema` as devDependency. [ASSUMED — verify whether npm install warns during update]

**API surface used by this project:**
- `McpServer` from `server/mcp.js` — stable across 1.x [ASSUMED]
- `StdioServerTransport` from `server/stdio.js` — stable across 1.x [ASSUMED]
- `.tool(name, description, schema, handler)` registration pattern — stable across 1.x [ASSUMED]

**Recommended:** Update `package.json` from pinned `"1.4.1"` to `"^1.29.0"`, run `npm install`, run full test suite.

#### `vitest` 2.x → 4.x

**Config file:** No changes required. The current `vitest.config.ts` uses `globals: true`, `environment: 'node'`, `include`, and `coverage` with v8 thresholds — all of these are unchanged in v4. [CITED: vitest.dev/guide/migration.html]

**Breaking changes that do NOT apply to this project:**
- `workspace` → `projects` rename: project does not use workspace config
- Pool configuration changes: project does not configure pool options
- Browser mode changes: project uses node environment
- `coverage.all` removal: project does not set `coverage.all`

**Breaking changes that DO apply:**
- `invocationCallOrder` now starts at `1` instead of `0` in mock call tracking. Phase 4 tests use `vi.fn()` mocks but do not assert `invocationCallOrder` (confirmed by reading test files). No changes needed. [ASSUMED — visual scan of test files; planner should verify]
- `vi.restoreAllMocks()` now only affects manual spies, not auto-mocked modules. Existing tests use `vi.mock()` module mocking plus `vi.fn()`. The `beforeEach` in tests calls `vi.clearAllMocks()` not `vi.restoreAllMocks()`. No impact. [ASSUMED]

**`@vitest/coverage-v8` must match vitest major version.** Both must be updated together to `^4.1.7`.

**Recommended update command:**
```bash
npm install --save-dev vitest@^4.1.7 @vitest/coverage-v8@^4.1.7 @types/node@^22.0.0
npm install @modelcontextprotocol/sdk@^1.29.0
```

#### `@types/node` ^20.0.0 → ^22.0.0

The project already uses Node.js 22.13.1 (pinned in Volta config). Updating `@types/node` to `^22.0.0` aligns types with the runtime. No API changes — this is a type accuracy improvement only. [VERIFIED: npm registry — node 22.x types latest: 22.15.x]

**Potential issue:** Node 22 `@types/node` may surface previously-hidden type errors if the codebase uses APIs added after Node 20. The codebase uses `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, `execSync`, `homedir`, `join` — all stable since Node 14+. Low risk. [ASSUMED]

---

## Scope Item 5: `defaultAccount` Cache TTL / Invalidation Fix

### Current Behaviour (lines 235–273)

`resolveAccount(account?: string)` sets `this.defaultAccount` on first call and never clears it:

```typescript
private defaultAccount: string | null = null;   // line 177

private resolveAccount(account?: string): string {
  if (account) return account;
  if (this.defaultAccount) return this.defaultAccount;   // ← no TTL check

  // Expensive: creates a temporary outgoing message to query Mail.app
  const defaultResult = executeAppleScript(buildAppLevelScript(`
    set newMsg to make new outgoing message
    set fromAddr to sender of newMsg
    delete newMsg
    return fromAddr
  `));

  if (defaultResult.success && ...) {
    this.defaultAccount = matchedAccount.name;   // ← set once, never expires
    return this.defaultAccount;
  }
  // ...
}
```

**The bug:** `defaultAccount` is populated once per process lifetime. If the user changes their default send account in Mail.app, the MCP server will not pick it up until restarted. Additionally, `invalidateCache()` (line 225) clears `this.cache.accounts` and `this.cache.mailboxNames` but does NOT clear `this.defaultAccount`.

### Fix

Two changes:

1. **Add TTL** — store expiry timestamp alongside the value:
   ```typescript
   private defaultAccountCache: { value: string; expiresAt: number } | null = null;
   ```
   TTL: 5 minutes (same as `CACHE_TTL_MS` for consistency, or a separate constant). [ASSUMED]

2. **Invalidate in `invalidateCache()`**:
   ```typescript
   private invalidateCache(): void {
     this.cache.accounts = null;
     this.cache.mailboxNames.clear();
     this.defaultAccountCache = null;  // ← add this
   }
   ```

`resolveAccount` checks `defaultAccountCache?.expiresAt > Date.now()` instead of `this.defaultAccount`.

**Backward compatibility:** The `private defaultAccount` field can be kept as an alias or removed. Since it is `private`, removal is safe.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TTL cache | Custom class with setInterval | Plain `Map<id, {data, expiresAt}>` checked at read time | No background GC needed; entries are evicted lazily; already the pattern used by `this.cache.accounts` |
| Config file format | Custom parser | `JSON.parse` + `JSON.stringify` | Already used for templates; no new dependency |
| Dependency updates | Manual version reconciliation | `npm install pkg@version` | npm handles peer dep resolution |

---

## Common Pitfalls

### Pitfall 1: Cache Poisoning on Move
**What goes wrong:** Message is moved to a different mailbox but cache still holds the old location. Subsequent ops target the wrong mailbox and fail silently (AppleScript returns "Message not found").
**Why it happens:** `moveMessage` updates location but cache is not refreshed.
**How to avoid:** After successful `moveMessage(id, newMailbox)`, update `messageLocationCache.set(id, { mailbox: newMailbox, account: targetAccount, expiresAt: now + TTL })`.
**Warning signs:** Operations returning "Message not found" immediately after a move.

### Pitfall 2: Cache Miss on Full-Scan Race
**What goes wrong:** Two concurrent calls for the same ID both miss cache and both run the full scan. This is harmless (last write wins) but wastes resources.
**Why it happens:** Node.js is single-threaded but AppleScript calls are synchronous blocking. Concurrency is not possible. This pitfall does not apply.

### Pitfall 3: `listMailboxes(includeCount=false)` Used Where Counts Are Needed
**What goes wrong:** `getMailStats()` accidentally called with `includeCount: false` and returns zeros.
**How to avoid:** Default value `includeCount = true`; only `healthCheck()` explicitly passes `false`.

### Pitfall 4: Config File Overriding Dynamic Mail.app State
**What goes wrong:** User sets `defaultAccount: "iCloud"` in config but later switches to a new Gmail account. The config file overrides the dynamic resolution.
**How to avoid:** Config file sets a preference, not an override. Document that config values are hints — `resolveAccount()` should still fall back to dynamic resolution if the config-specified account no longer exists.
**Warning signs:** "Account not found" errors on send after account setup changes.

### Pitfall 5: vitest v4 `@vitest/coverage-v8` Version Mismatch
**What goes wrong:** `vitest@4.x` installed but `@vitest/coverage-v8@2.x` left behind. Coverage run fails with peer dependency error.
**How to avoid:** Always update both packages together in a single `npm install` command.

### Pitfall 6: SDK 1.29.0 `@cfworker/json-schema` Peer Dep Warning
**What goes wrong:** `npm install @modelcontextprotocol/sdk@^1.29.0` warns about missing peer `@cfworker/json-schema`.
**How to avoid:** Either ignore the warning (the dep is only used for optional schema validation backends not used here) or install it as a devDependency.

---

## Architecture Patterns

### Recommended Project Structure (no change)

The cache additions are purely additive private fields and private methods on `AppleMailManager`. No new files required.

### Pattern: Lazy Expiry Cache (existing pattern, extend it)

The existing cache at lines 184–187:

```typescript
private cache = {
  accounts: null as { data: Account[]; expiry: number } | null,
  mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
};
```

Extend by adding `messageLocations` to this same object:

```typescript
private cache = {
  accounts: null as { data: Account[]; expiry: number } | null,
  mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
  messageLocations: new Map<string, { mailbox: string; account: string; expiry: number }>(),
};
```

This keeps all TTL caches grouped, uses the existing `CACHE_TTL_MS` constant (or a new `MESSAGE_LOCATION_TTL_MS`), and participates in `invalidateCache()`.

### Pattern: Cache-Aware Script Fallback

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
    expiry: Date.now() + MESSAGE_LOCATION_TTL_MS,
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No message location cache | Add in-process TTL cache | Phase 5 | Eliminates repeat scans for frequently-accessed messages |
| `count of messages` always | Skip when `includeCount=false` | Phase 5 | Faster `healthCheck` and any future folder-list-only calls |
| `defaultAccount` permanent | TTL + invalidation | Phase 5 | Picks up Mail.app account changes without restart |
| Pinned SDK 1.4.1 | Range `^1.29.0` | Phase 5 | Gets OAuth, HTTP transport, and security fixes |
| vitest 2.x | vitest 4.x | Phase 5 | vite 6 alignment, maintained toolchain |

---

## Implementation Order (Recommended)

1. **Message-ID location cache** — highest runtime impact, pure additive change
2. **`defaultAccount` TTL fix** — touches `resolveAccount()` which is exercised by every op; do before cache to avoid resetting work
3. **Persistent config file** — user-visible, follows template pattern exactly
4. **`listMailboxes` lazy count** — small method signature change, update `healthCheck()` caller
5. **Dependency updates** — last, so a broken build does not block other tasks; update all three in one commit

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.x (upgrading to 4.x in this phase) |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npm test` |
| Full suite command | `npm run test:coverage` |

### Current Test Count

129 tests across 5 files (as of Phase 4 complete).

### Phase 5 Test Strategy

`AppleMailManager` service methods are not unit-testable without Mail.app (as established in prior phases — `src/services/*.ts` is excluded from coverage thresholds). Phase 5 tests should follow the Phase 4 pattern: mock `executeAppleScript` and test the pure TypeScript logic added.

| Area | Test Approach | File |
|------|---------------|------|
| `resolveMessageLocation` / `cacheMessageLocation` helpers | Unit test with mock messages | `src/__tests__/phase5.test.ts` |
| Config loading with valid/corrupt/missing file | Unit test using `vi.mock('fs')` | `src/__tests__/phase5.test.ts` |
| `listMailboxes(account, false)` skips count fields | Unit test with mock AppleScript | `src/__tests__/phase5.test.ts` |
| `defaultAccount` expiry | Unit test with `vi.setSystemTime` | `src/__tests__/phase5.test.ts` |
| Dependency update regression | Full test suite green | existing files |

### Wave 0 Gaps

- [ ] `src/__tests__/phase5.test.ts` — create new test file following Phase 4 pattern

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All | Yes | 22.13.1 (Volta) | — |
| npm | Dependency updates | Yes | (bundled with Node) | — |
| TypeScript | Build | Yes | ^5.0.0 (installed) | — |
| `~/.config/apple-mail-mcp/` dir | Config persistence | Created on first write | — | `mkdirSync({ recursive: true })` already used |

---

## Open Questions

1. **Config file: should `defaultAccount` in config override or seed?**
   - What we know: `resolveAccount()` currently sets `this.defaultAccount` via Mail.app API on first call
   - What's unclear: If user sets `defaultAccount: "Gmail"` in config but Mail.app default is "iCloud", which wins?
   - Recommendation: Config is a preference hint. Use it as the initial value but validate it exists in account list; fall back to Mail.app resolution if not found. [ASSUMED]

2. **Message-ID cache TTL value**
   - What we know: Messages can be moved between mailboxes, but this is a relatively rare user action
   - What's unclear: Whether 5 minutes is too long for active workflows
   - Recommendation: 5 minutes is reasonable; make it configurable via the config file in the same phase [ASSUMED]

3. **SDK peer dep `@cfworker/json-schema`**
   - What we know: Listed as peer dep in 1.29.0
   - What's unclear: Whether `npm install` warns or errors; whether `--legacy-peer-deps` is needed
   - Recommendation: Run the install and check; if warning only, document and proceed; if error, add as devDependency

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `unread count of mb` is a cheap cached property in Mail.app (not a full message scan) | Scope Item 2 | If wrong, `listMailboxes(includeCount=false)` saves less than expected; no functional impact |
| A2 | SDK 1.29.0 `.tool()` registration API is backward-compatible with 1.4.1 usage | Scope Item 4 | Would require API call changes in `src/index.ts`; risk LOW given semver |
| A3 | `vitest` test files do not assert `invocationCallOrder` | Scope Item 4 | If wrong, one or more tests would fail after upgrade; fixable |
| A4 | `vi.clearAllMocks()` (used in tests) behaviour is unchanged in vitest v4 | Scope Item 4 | If wrong, mock state bleed between tests; fixable |
| A5 | 5-minute TTL is appropriate for message location cache | Scope Item 1 | If too long: stale-location errors after moves; mitigated by explicit invalidation on moveMessage |
| A6 | Config file `defaultAccount` should act as preference hint, not hard override | Scope Item 3 | If user expects hard override: unexpected fallback to Mail.app account; document clearly |

---

## Sources

### Primary (HIGH confidence)
- `src/services/appleMailManager.ts` — direct code inspection, all line references verified
- npm registry — `npm view` commands for all package versions and peer deps [VERIFIED: npm registry]

### Secondary (MEDIUM confidence)
- [vitest.dev/guide/migration.html](https://vitest.dev/guide/migration.html) — vitest v2→v4 breaking changes [CITED]
- `@modelcontextprotocol/sdk@1.29.0` exports map — via `npm view` [VERIFIED: npm registry]

### Tertiary (LOW confidence)
- WebSearch result summary for MCP SDK breaking changes (1.4→1.29 specific changelog not directly accessible in this session; inferred from exports map and semver)

---

## Metadata

**Confidence breakdown:**
- Scope 1 (cache): HIGH — all scan methods located in code; cache design follows existing pattern
- Scope 2 (lazy count): HIGH — `listMailboxes` fully read; callers identified
- Scope 3 (config): HIGH — template pattern exists and is fully documented in code
- Scope 4 (deps): MEDIUM — versions verified via npm; breaking changes partially ASSUMED for SDK API surface
- Scope 5 (defaultAccount TTL): HIGH — bug confirmed by reading `resolveAccount()` and `invalidateCache()`

**Research date:** 2026-05-20
**Valid until:** 2026-06-20 (stable ecosystem; dependency versions may update)
