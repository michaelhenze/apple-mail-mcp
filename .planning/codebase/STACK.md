# Technology Stack

**Analysis Date:** 2026-05-20

## Runtime & Language

**Primary Language:** TypeScript 5.x (`^5.0.0`)
- Strict mode enabled (`"strict": true` in `tsconfig.json`)
- Target: ES2022 (`"target": "ES2022"`)
- Module system: NodeNext ESM (`"module": "NodeNext"`, `"moduleResolution": "NodeNext"`)
- All source files in `src/` with `.ts` extension
- Path alias `@/*` maps to `src/*`

**Runtime:** Node.js
- Minimum version: `>=20.0.0` (package.json `engines`)
- Pinned via Volta: `22.13.1` (`.volta` in `package.json`)
- `.nvmrc` pins: `22.13.1`
- Platform constraint: `"os": ["darwin"]` — macOS only

## Frameworks & Libraries

**Core MCP Framework:**
- `@modelcontextprotocol/sdk` `1.4.1` — The Model Context Protocol SDK
  - Used via `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
  - Transport: `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
  - Server communicates exclusively over stdin/stdout

**Schema Validation:**
- `zod` `^3.22.4` — Runtime schema validation for all MCP tool parameters
  - Imported as `z` in `src/index.ts`
  - Every tool input is validated with Zod schemas before execution

## Build & Tooling

**Compiler:**
- `typescript` `^5.0.0` — TypeScript compiler (`tsc`)
- `tsc-alias` `^1.8.10` — Resolves `@/*` path aliases in compiled output (run after `tsc`)
- Build command: `npm run build` → `tsc && tsc-alias`
- Output directory: `build/` with `.js` and `.d.ts` files

**Linting:**
- `eslint` `^9.0.0` with flat config (`eslint.config.js`)
- `typescript-eslint` `^8.51.0` — TypeScript-aware lint rules
- `@typescript-eslint/eslint-plugin` `^8.0.0`
- `@typescript-eslint/parser` `^8.0.0`
- `globals` `^17.0.0` — Global variable definitions for Node/ES2022 environments
- Key rules: `no-unused-vars` (error), `no-explicit-any` (warn)

**Formatting:**
- `prettier` `^3.0.0`
- Config in `.prettierrc`: double quotes, semicolons, 2-space indent, 100-char print width, ES5 trailing commas

**Git Hooks:**
- `husky` `^9.1.7` — Git hook management
- `lint-staged` `^16.2.7` — Runs eslint + prettier on staged `src/**/*.ts` files pre-commit
- Hook defined in `.husky/pre-commit`

**Path Resolution:**
- `tsconfig-paths` `^4.2.0` — Supports `@/*` aliases in ts-node (dev environment)

## Package Management

**Manager:** npm
- Lockfile: `package-lock.json` present and committed
- `npm ci` used in CI for reproducible installs
- Published to npm registry (package name: `apple-mail-mcp`)
- `prepublishOnly`: runs `lint`, `test`, and `build` before every publish

## Testing

**Framework:** Vitest `^2.0.0`
- Config: `vitest.config.ts`
- Environment: `node`
- Coverage provider: `@vitest/coverage-v8` `^2.1.9`
- Coverage reporters: `text`, `lcov`, `json-summary`
- Test files: `src/**/*.test.ts`
- Coverage thresholds enforced on `src/utils/**/*.ts`: 90% statements/lines, 75% branches, 100% functions
- `src/services/` excluded from coverage thresholds (requires live Mail.app)

**Run Commands:**
```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

## Key Dependencies (with versions and purpose)

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | `1.4.1` | MCP server, tool registration, stdio transport |
| `zod` | `^3.22.4` | Input validation schemas for all 35+ MCP tools |
| `typescript` | `^5.0.0` | (dev) Type checking and compilation |
| `vitest` | `^2.0.0` | (dev) Unit test runner |
| `@vitest/coverage-v8` | `^2.1.9` | (dev) Code coverage via V8 |
| `eslint` | `^9.0.0` | (dev) Static analysis |
| `typescript-eslint` | `^8.51.0` | (dev) TypeScript-aware lint rules |
| `prettier` | `^3.0.0` | (dev) Code formatting |
| `tsc-alias` | `^1.8.10` | (dev) Path alias resolution in build output |
| `husky` | `^9.1.7` | (dev) Git hook management |
| `lint-staged` | `^16.2.7` | (dev) Pre-commit lint/format |
| `tsconfig-paths` | `^4.2.0` | (dev) Path alias support for ts-node |
| `globals` | `^17.0.0` | (dev) Environment globals for ESLint |

## Configuration Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | TypeScript compiler options |
| `vitest.config.ts` | Test runner configuration |
| `eslint.config.js` | ESLint flat config |
| `.prettierrc` | Prettier formatting rules |
| `.nvmrc` | Node version pin (nvm) |
| `package.json` `.volta` | Node version pin (Volta) |
| `.husky/pre-commit` | Pre-commit git hook |
| `.mcp.json` | Local MCP server registration (`node build/index.js`) |

## CI/CD

**Platform:** GitHub Actions
- CI workflow: `.github/workflows/ci.yml` — runs on `macos-latest` for Node 20 and 22
- Publish workflow: `.github/workflows/publish.yml` — triggered on GitHub release, publishes to npm
- Coverage uploaded to Codecov on Node 22 runs

---

*Stack analysis: 2026-05-20*
