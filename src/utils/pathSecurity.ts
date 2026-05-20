import { resolve, normalize } from "path";
import { homedir } from "os";

/**
 * Validates that a file path is absolute and confined to allowed directories.
 *
 * Resolves all `../` sequences using `path.resolve()` before checking against
 * the allowlist. This prevents traversal attacks regardless of nesting depth.
 *
 * Allowed roots: user home directory and /tmp.
 *
 * @param rawPath - Raw path string from caller
 * @returns Normalized absolute path
 * @throws Error if path is relative or outside allowed directories
 */
export function validateSavePath(rawPath: string): string {
  if (!rawPath) {
    throw new Error("Path must not be empty");
  }
  // Expand ~/
  const expandedPath = rawPath.startsWith("~/") ? rawPath.replace("~/", `${homedir()}/`) : rawPath;

  // Reject relative paths (after ~ expansion)
  if (!expandedPath.startsWith("/")) {
    throw new Error(`Path must be absolute, got: "${rawPath}"`);
  }

  const resolved = resolve(normalize(expandedPath));
  const home = homedir();
  const allowed = [home, "/tmp"];
  const isAllowed = allowed.some((root) => resolved === root || resolved.startsWith(`${root}/`));

  if (!isAllowed) {
    throw new Error(`Path "${resolved}" is outside allowed directories (home directory or /tmp)`);
  }

  return resolved;
}
