# External Integrations

**Analysis Date:** 2026-05-20

## Protocols & Standards

**Model Context Protocol (MCP):**
- Protocol version: defined by `@modelcontextprotocol/sdk` `1.4.1`
- Server name: `"apple-mail"`, version read dynamically from `package.json`
- Server registration: `src/index.ts` — `new McpServer({ name: "apple-mail", version })`
- 35+ tools registered via `server.tool(name, schema, handler)` pattern
- All tool inputs validated with Zod schemas before execution
- Reference: `https://modelcontextprotocol.io`

**Stdio Transport:**
- Communication method: `StdioServerTransport` — stdin/stdout only
- Entry point: `src/index.ts` line `const transport = new StdioServerTransport(); await server.connect(transport);`
- No HTTP, no WebSocket, no network port — pure process I/O
- Local MCP config: `.mcp.json` → `{ "command": "node", "args": ["build/index.js"] }`

**JSON (MCP wire format):**
- MCP SDK handles all JSON serialization/deserialization
- Tool responses: `{ content: [{ type: "text", text: string }], isError?: boolean }`

## System Integrations

**Apple Mail (Mail.app):**
- Integration mechanism: AppleScript executed via macOS `osascript` CLI
- Execution layer: `src/utils/applescript.ts` — `executeAppleScript(script, options?)` function
- Shell invocation: `execSync("osascript -e '<escaped-script>'", { encoding: "utf8", timeout: 30000 })`
- All Mail.app operations (read, send, search, mailbox management) go through this bridge
- Default timeout: 30,000 ms per AppleScript call
- Retry logic: configurable `maxRetries` (default: 1 attempt, no retry); exponential backoff with 1s base delay
- Retryable conditions: timeout, "not responding", "connection invalid", "lost connection", "busy"
- Error mapping: `src/utils/applescript.ts` `ERROR_MAPPINGS` array translates raw AppleScript errors to user-friendly messages
- Debug logging: enabled via `DEBUG=1`, `DEBUG=true`, `VERBOSE=1` environment variables (logs to stderr)

**AppleScript Bridge Details:**
- Script builder functions in `src/services/appleMailManager.ts`:
  - `buildAccountScopedScript(account, command)` — wraps in `tell account "..." ... end tell`
  - `buildAppLevelScript(command)` — wraps in `tell application "Mail" ... end tell`
- String escaping: `escapeForAppleScript(text)` escapes `\` and `"` for AppleScript string literals
- Shell escaping: `escapeForShell(script)` escapes `'` using `'\''` pattern for single-quoted shell args
- Date parsing: `parseAppleScriptDate()` handles AppleScript verbose date format (`"date Saturday, December 27, 2025 at 3:44:02 PM"`)

**Apple Contacts (Contacts.app):**
- Integration mechanism: AppleScript via the same `executeAppleScript()` bridge
- Used by: `mailManager.searchContacts(query)` → `search-contacts` MCP tool
- Queries contact names and email addresses from Contacts.app
- Returns: `Contact[]` with `name`, `emails[]`, `phones[]`

**macOS Filesystem:**
- Used for: email attachment handling
- `save-attachment` tool saves attachment files to caller-specified absolute paths on disk
- `send-email` and `create-draft` accept `attachments: string[]` — absolute file paths to attach
- No sandboxing: reads/writes arbitrary paths provided by the caller
- No temp directory management — paths are pass-through to AppleScript

**macOS `sleep` Command:**
- Used internally in `src/utils/applescript.ts` `sleep()` function
- Invoked via `spawnSync("sleep", [seconds])` for retry backoff delays
- Fallback: busy-wait loop if `sleep` command fails

## External Services

**npm Registry:**
- Package published as `apple-mail-mcp` on npmjs.com
- Publish triggered by GitHub release via `.github/workflows/publish.yml`
- Auth: `NODE_AUTH_TOKEN` secret in GitHub Actions

**GitHub:**
- Source repository: `https://github.com/sweetrb/apple-mail-mcp`
- CI/CD: GitHub Actions (`.github/workflows/ci.yml`, `.github/workflows/publish.yml`)
- Issue tracker: `https://github.com/sweetrb/apple-mail-mcp/issues`

**Codecov:**
- Coverage reporting in CI: `codecov/codecov-action@v4`
- Upload file: `./coverage/lcov.info`
- Configured as non-blocking (`fail_ci_if_error: false`, `continue-on-error: true`)

**Claude Plugin Marketplace:**
- Plugin manifest: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
- Registers the server for discovery in Claude's plugin ecosystem

## Inter-process Communication

**MCP Host → Server:**
- Direction: MCP host (e.g., Claude Desktop, Claude Code) spawns `node build/index.js` as a child process
- Channel: stdin (host → server) / stdout (server → host)
- Protocol: JSON-RPC over MCP SDK

**Server → Mail.app:**
- Direction: Server spawns `osascript` as a child process for each operation
- Channel: shell command with `-e` flag containing the AppleScript
- Synchronous: `execSync()` — the MCP server blocks on each AppleScript call
- Output: stdout trimmed and returned as string; stderr captured for error parsing

**Server → Contacts.app:**
- Same mechanism as Mail.app — AppleScript via `osascript`
- Separate `tell application "Contacts"` block in the generated script

**In-memory State:**
- Email templates: stored in `AppleMailManager` instance memory (`src/services/appleMailManager.ts`)
  - Templates do not persist across server restarts
- TTL cache (60s): accounts list and per-account mailbox names cached to reduce AppleScript roundtrips
  - `this.cache.accounts` — expires after 60,000 ms
  - `this.cache.mailboxNames` — per-account Map, each entry expires after 60,000 ms
  - Cache invalidated on mailbox structure changes (create/delete/rename)
- Default account: resolved once per server session and memoized in `this.defaultAccount`

## macOS Permissions Required

The server requires these macOS automation permissions (System Settings > Privacy & Security > Automation):
- **Mail.app** — all email read/write/send operations
- **Contacts.app** — `search-contacts` tool
- Permission errors surface as: `"Permission denied. Grant automation access in System Preferences > Privacy & Security > Automation."`

---

*Integration audit: 2026-05-20*
