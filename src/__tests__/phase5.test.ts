/**
 * Phase 5 unit tests — covers performance and correctness improvements added in Phase 5.
 *
 * Suites:
 *   1. Message location cache — resolveMessageLocation, cacheMessageLocation, invalidateCache
 *   2. Cache fast-path — findMessageScript generates targeted vs nested-loop AppleScript
 *   3. defaultAccount TTL — resolveAccount caches and expires correctly
 *   4. listMailboxes lazy count — includeCount=false omits expensive AppleScript
 *   5. Persistent config — loadConfig, persistConfig, getConfig, setConfig
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppleMailManager } from "@/services/appleMailManager.js";
import { executeAppleScript } from "@/utils/applescript.js";
import { existsSync, readFileSync, writeFileSync } from "fs";

// vi.mock is hoisted; factory must not reference local variables.
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// =============================================================================
// Suite 1 — Message location cache
// =============================================================================

describe("Message location cache", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    manager = new AppleMailManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolveMessageLocation returns null on cold cache", () => {
    const result = (
      manager as never as { resolveMessageLocation: (id: string) => unknown }
    ).resolveMessageLocation("999");
    expect(result).toBeNull();
  });

  it("resolveMessageLocation returns {mailbox, account} after cacheMessageLocation is called", () => {
    (
      manager as never as {
        cacheMessageLocation: (id: string, mailbox: string, account: string) => void;
      }
    ).cacheMessageLocation("42", "INBOX", "iCloud");
    const result = (
      manager as never as {
        resolveMessageLocation: (id: string) => { mailbox: string; account: string } | null;
      }
    ).resolveMessageLocation("42");
    expect(result).toEqual({ mailbox: "INBOX", account: "iCloud" });
  });

  it("resolveMessageLocation returns null after TTL has expired", () => {
    vi.useFakeTimers();
    (
      manager as never as {
        cacheMessageLocation: (id: string, mailbox: string, account: string) => void;
      }
    ).cacheMessageLocation("77", "Sent", "Gmail");

    // Advance past the 5-minute TTL
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const result = (
      manager as never as { resolveMessageLocation: (id: string) => unknown }
    ).resolveMessageLocation("77");
    expect(result).toBeNull();
  });

  it("invalidateCache() clears messageLocations so resolveMessageLocation returns null", () => {
    (
      manager as never as {
        cacheMessageLocation: (id: string, mailbox: string, account: string) => void;
      }
    ).cacheMessageLocation("55", "Drafts", "Work");
    (manager as never as { invalidateCache: () => void }).invalidateCache();
    const result = (
      manager as never as { resolveMessageLocation: (id: string) => unknown }
    ).resolveMessageLocation("55");
    expect(result).toBeNull();
  });
});

// =============================================================================
// Suite 2 — Cache fast-path
// =============================================================================

describe("Cache fast-path", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    manager = new AppleMailManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("findMessageScript with a cache HIT generates targeted AppleScript (mailbox and account in script)", () => {
    // Seed the cache
    (
      manager as never as {
        cacheMessageLocation: (id: string, mailbox: string, account: string) => void;
      }
    ).cacheMessageLocation("999", "INBOX", "iCloud");

    const script = (
      manager as never as { findMessageScript: (id: string, op: string) => string }
    ).findMessageScript("999", "set read status of msg to true");

    expect(script).toContain('mailbox "INBOX"');
    expect(script).toContain('account "iCloud"');
  });

  it("findMessageScript with a cache HIT also includes full-scan fallback in same script", () => {
    (
      manager as never as {
        cacheMessageLocation: (id: string, mailbox: string, account: string) => void;
      }
    ).cacheMessageLocation("999", "INBOX", "iCloud");

    const script = (
      manager as never as { findMessageScript: (id: string, op: string) => string }
    ).findMessageScript("999", "set read status of msg to true");

    // Targeted section should be first
    expect(script).toContain('mailbox "INBOX"');
    // Full-scan fallback must also be present
    expect(script).toContain("repeat with acct in accounts");
  });

  it("findMessageScript with a cache MISS generates nested-loop AppleScript", () => {
    // No cache seeded — resolveMessageLocation returns null
    const script = (
      manager as never as { findMessageScript: (id: string, op: string) => string }
    ).findMessageScript("888", "set read status of msg to true");

    expect(script).toContain("repeat with acct in accounts");
    // Should NOT contain a targeted mailbox-of-account lookup at the top level
    expect(script).not.toContain('account "');
  });

  it("findMessageScript with invalid ID returns error script immediately", () => {
    const script = (
      manager as never as { findMessageScript: (id: string, op: string) => string }
    ).findMessageScript("not-a-number", "set read status of msg to true");
    expect(script).toContain("Invalid message ID");
  });
});

// =============================================================================
// Suite 3 — defaultAccount TTL
// =============================================================================

describe("defaultAccount TTL", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    manager = new AppleMailManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolveAccount uses cached value within TTL (executeAppleScript called only once for two calls)", () => {
    vi.useFakeTimers();

    // Seed the defaultAccountCache directly (as if resolveAccount already ran once)
    (
      manager as never as {
        defaultAccountCache: { value: string; expiresAt: number } | null;
      }
    ).defaultAccountCache = {
      value: "iCloud",
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    // Call resolveAccount — should use the cache and NOT call executeAppleScript
    (manager as never as { resolveAccount: (account?: string) => string }).resolveAccount();
    expect(vi.mocked(executeAppleScript)).not.toHaveBeenCalled();
  });

  it("resolveAccount calls executeAppleScript again after TTL expires", () => {
    vi.useFakeTimers();

    vi.mocked(executeAppleScript).mockReturnValue({
      success: true,
      output: "",
      error: undefined,
    });

    (manager as never as { resolveAccount: (account?: string) => string }).resolveAccount();
    const callsAfterFirst = vi.mocked(executeAppleScript).mock.calls.length;

    // Advance past the 5-minute TTL
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    (manager as never as { resolveAccount: (account?: string) => string }).resolveAccount();
    expect(vi.mocked(executeAppleScript).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("invalidateCache() clears defaultAccountCache so next resolveAccount re-queries", () => {
    vi.useFakeTimers();

    vi.mocked(executeAppleScript).mockReturnValue({
      success: true,
      output: "",
      error: undefined,
    });

    (manager as never as { resolveAccount: (account?: string) => string }).resolveAccount();
    const callsAfterFirst = vi.mocked(executeAppleScript).mock.calls.length;

    // Invalidate the cache
    (manager as never as { invalidateCache: () => void }).invalidateCache();

    // Next call must re-query (even within TTL window)
    (manager as never as { resolveAccount: (account?: string) => string }).resolveAccount();
    expect(vi.mocked(executeAppleScript).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

// =============================================================================
// Suite 4 — listMailboxes lazy count
// =============================================================================

describe("listMailboxes lazy count", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    manager = new AppleMailManager();
  });

  it("listMailboxes(account, false) does NOT generate AppleScript with 'count of messages of mb'", () => {
    let capturedScript = "";
    vi.mocked(executeAppleScript).mockImplementation((script) => {
      capturedScript = typeof script === "string" ? script : "";
      return { success: true, output: "", error: undefined };
    });

    manager.listMailboxes("iCloud", false);

    expect(capturedScript).not.toContain("count of messages of mb");
    expect(capturedScript).toContain("set mbCount to 0");
  });

  it("listMailboxes(account, true) DOES generate AppleScript with 'count of messages of mb'", () => {
    let capturedScript = "";
    vi.mocked(executeAppleScript).mockImplementation((script) => {
      capturedScript = typeof script === "string" ? script : "";
      return { success: true, output: "", error: undefined };
    });

    manager.listMailboxes("iCloud", true);

    expect(capturedScript).toContain("count of messages of mb");
  });

  it("listMailboxes() with no second arg defaults to includeCount=true (backward compatible)", () => {
    let capturedScript = "";
    vi.mocked(executeAppleScript).mockImplementation((script) => {
      capturedScript = typeof script === "string" ? script : "";
      return { success: true, output: "", error: undefined };
    });

    manager.listMailboxes("iCloud");

    expect(capturedScript).toContain("count of messages of mb");
  });
});

// =============================================================================
// Suite 5 — Persistent config
// =============================================================================

describe("Persistent config", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    manager = new AppleMailManager();
  });

  it("loadConfig() on missing file leaves config as {}", () => {
    // existsSync already returns false (from beforeEach)
    const config = manager.getConfig();
    expect(config).toEqual({});
  });

  it("loadConfig() on valid JSON sets config fields correctly", () => {
    const configData = { defaultAccount: "iCloud", defaultMailbox: "INBOX", timeoutMs: 30000 };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(configData));

    // Re-create manager so loadConfig() runs with the mock in place
    const mgr = new AppleMailManager();
    const config = mgr.getConfig();

    expect(config.defaultAccount).toBe("iCloud");
    expect(config.defaultMailbox).toBe("INBOX");
    expect(config.timeoutMs).toBe(30000);
  });

  it("loadConfig() on corrupt JSON logs error and leaves config as {}", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{ not valid json }");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mgr = new AppleMailManager();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to load config"));
    const config = mgr.getConfig();
    expect(config).toEqual({});

    consoleSpy.mockRestore();
  });

  it("setConfig merges partial into existing config without overwriting unrelated keys", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ defaultAccount: "iCloud", timeoutMs: 60000 })
    );
    const mgr = new AppleMailManager();

    // Update only timeoutMs
    mgr.setConfig({ timeoutMs: 30000 });

    const config = mgr.getConfig();
    expect(config.defaultAccount).toBe("iCloud"); // unchanged
    expect(config.timeoutMs).toBe(30000); // updated
  });

  it("setConfig calls writeFileSync with the config file path", () => {
    manager.setConfig({ defaultAccount: "Work" });

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining("config.json"),
      expect.stringContaining('"defaultAccount"'),
      "utf8"
    );
  });

  it("getConfig returns a shallow copy (mutating return value does not affect internal state)", () => {
    manager.setConfig({ defaultAccount: "iCloud" });

    const copy = manager.getConfig() as { defaultAccount?: string };
    copy.defaultAccount = "Tampered";

    const fresh = manager.getConfig();
    expect(fresh.defaultAccount).toBe("iCloud"); // internal state unchanged
  });
});
