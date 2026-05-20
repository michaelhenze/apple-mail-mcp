<!-- refreshed: 2026-05-20 -->
# Directory Structure

**Analysis Date:** 2026-05-20

## Root Level

```
apple-mail-mcp/
├── src/                    # TypeScript source — the only code to edit
│   ├── index.ts            # MCP server entry point, all tool registrations
│   ├── types.ts            # All TypeScript interfaces and type definitions
│   ├── services/
│   │   └── appleMailManager.ts  # Core service: all mail operations via AppleScript
│   └── utils/
│       ├── applescript.ts       # executeAppleScript() utility
│       └── applescript.test.ts  # Unit tests for the utility
├── build/                  # Compiled JS output (generated, do not edit)
├── scripts/
│   └── jxa-comparison.ts   # Developer reference only (JXA vs AppleScript comparison)
├── skills/
│   └── apple-mail/
│       └── skill.md        # Claude skill definition for the MCP tools
├── .planning/
│   └── codebase/           # GSD analysis documents (this directory)
├── .github/
│   ├── workflows/          # CI workflow definitions
│   └── ISSUE_TEMPLATE/     # GitHub issue templates
├── .claude-plugin/         # Claude plugin configuration
├── .devcontainer/          # Dev container configuration
├── .husky/                 # Git hooks (pre-commit: lint-staged)
├── package.json            # Node.js manifest, npm scripts, dependencies
├── tsconfig.json           # TypeScript compiler config (NodeNext, ES2022, @/* alias)
├── vitest.config.ts        # Test runner configuration
├── eslint.config.js        # ESLint flat config
├── .prettierrc             # Prettier formatting rules
├── .nvmrc                  # Node.js version pin (Node 22)
├── .mcp.json               # MCP server declaration for Claude Desktop
├── CLAUDE.md               # Agent usage instructions (checked in)
├── README.md               # Public documentation
└── CHANGELOG.md            # Version history
```

## Directory Purposes

**`src/`:**
- Purpose: All TypeScript source files. This is the only directory to edit.
- Contains: Entry point, service classes, utilities, type definitions, tests
- Key files: `index.ts`, `services/appleMailManager.ts`, `utils/applescript.ts`, `types.ts`

**`src/services/`:**
- Purpose: Business logic layer. One file per major external system.
- Contains: `AppleMailManager` class — the single service that handles all Apple Mail interactions
- Note: Currently one service; new integrations (e.g., Calendar) would go here as separate files

**`src/utils/`:**
- Purpose: Low-level utilities shared across services.
- Contains: `executeAppleScript()` function and its tests
- Note: Utilities should have no dependencies on `services/` (only on `types`)

**`build/`:**
- Purpose: TypeScript compiler output. Mirrors `src/` structure.
- Generated: Yes — produced by `npm run build` (`tsc && tsc-alias`)
- Committed: Yes (required for npm publish and direct `npx` execution)
- Key file: `build/index.js` is the actual executable

**`skills/apple-mail/`:**
- Purpose: Claude skill definition consumed by Claude clients using the MCP server
- Contains: `skill.md` — documents available tools, usage patterns, and guidelines for the AI assistant
- Note: This is a runtime artifact for AI agents, not application code

**`scripts/`:**
- Purpose: Developer reference / one-off scripts
- Contains: `jxa-comparison.ts` — comparison of JXA vs AppleScript approaches (reference only, not run in CI)

**`.planning/codebase/`:**
- Purpose: GSD codebase analysis documents consumed by plan-phase and execute-phase commands
- Generated: Yes — produced by `/gsd:map-codebase`
- Committed: Yes

## Key Files (with 1-line purpose each)

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server startup, tool registration (35+ tools), and response helpers |
| `src/types.ts` | All TypeScript interfaces: `Message`, `Mailbox`, `Account`, `Attachment`, `AppleScriptResult`, `HealthCheckResult`, `MailStats`, `EmailTemplate`, `SyncStatus`, `BatchOperationResult`, etc. |
| `src/services/appleMailManager.ts` | `AppleMailManager` class: builds and executes all AppleScript, owns TTL cache and in-memory template store |
| `src/utils/applescript.ts` | `executeAppleScript()`: runs `osascript`, handles retries, timeout, shell escaping, and error parsing |
| `src/utils/applescript.test.ts` | Unit tests for `executeAppleScript()` using `vi.mock("child_process")` |
| `build/index.js` | Compiled entry point — the actual executable registered as the `apple-mail-mcp` bin |
| `package.json` | Declares `main`, `bin`, `engines: node>=20`, `os: darwin`, dependencies, and npm scripts |
| `tsconfig.json` | TypeScript config: `NodeNext` module resolution, `@/*` path alias mapping to `src/*`, strict mode |
| `vitest.config.ts` | Vitest test runner config |
| `eslint.config.js` | ESLint flat config for TypeScript |
| `.mcp.json` | MCP server declaration for Claude Desktop auto-discovery |
| `skills/apple-mail/skill.md` | AI assistant usage guide for the MCP tools |
| `CLAUDE.md` | Critical agent instructions: backslash escaping, ID lookup, workflow patterns |

## File Organization Conventions

**One concern per file:**
- `index.ts` owns only MCP wiring (no business logic)
- `appleMailManager.ts` owns only Apple Mail operations (no MCP types)
- `applescript.ts` owns only osascript execution (no mail semantics)

**Type definitions are centralized:**
All interfaces live in `src/types.ts`. Service and utility files import types from there; they do not define their own interfaces.

**Tests co-located with implementation:**
`src/utils/applescript.test.ts` sits next to `src/utils/applescript.ts`. Tests are excluded from the TypeScript build via `tsconfig.json` `"exclude"`.

**Path alias `@/*`:**
The `@/*` alias resolves to `src/*` (configured in `tsconfig.json` and resolved at build time by `tsc-alias`). Use `@/services/appleMailManager.js` not relative paths like `../../services/appleMailManager.js`. Note: import paths in source use the `.js` extension even for `.ts` files (required by NodeNext module resolution).

**Naming:**
- Files: `camelCase.ts` for utilities, `camelCase.ts` for services (e.g., `appleMailManager.ts`, `applescript.ts`)
- Classes: `PascalCase` (e.g., `AppleMailManager`)
- Exported functions: `camelCase` (e.g., `executeAppleScript`)

## Where to Add New Code

**New MCP tool:**
- Add `server.tool("tool-name", { ...zodSchema }, withErrorHandling(...))` block in `src/index.ts`
- Group with related tools under the appropriate section comment (Message Tools, Mailbox Tools, etc.)
- Implement backing method on `AppleMailManager` in `src/services/appleMailManager.ts`

**New Apple Mail operation:**
- Add a public method to `AppleMailManager` in `src/services/appleMailManager.ts`
- Build the AppleScript using `buildAppLevelScript()` or `buildAccountScopedScript()`
- Escape all user input with `escapeForAppleScript()`
- Return a typed value from `src/types.ts` — never throw

**New type:**
- Add the interface to `src/types.ts` under the appropriate section
- Export it for consumption by services and the entry point

**New utility:**
- Add a new file under `src/utils/`
- Do not import from `src/services/` (utilities must not depend on services)

**New external system integration** (e.g., Calendar.app):
- Create `src/services/calendarManager.ts` following the `AppleMailManager` pattern
- Instantiate it in `src/index.ts` alongside `mailManager`
- Add its types to `src/types.ts`

---

*Structure analysis: 2026-05-20*
