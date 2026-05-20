/**
 * Phase 3 unit tests — covers pure TypeScript logic added in Phase 3.
 *
 * Suites:
 *   1. normalizeSubject (pure function)
 *   2. AppleMailManager junk/archive delegates
 *   3. SyncStatus shape (simplified)
 *   4. getVipMessages (mock execSync + searchMessages)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeSubject } from "@/services/appleMailManager.js";
import { AppleMailManager } from "@/services/appleMailManager.js";

// vi.mock is hoisted; factory must not reference local variables.
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// fs must also be mocked since AppleMailManager constructor calls loadTemplates
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// =============================================================================
// Suite 1 — normalizeSubject (pure function)
// =============================================================================

describe("normalizeSubject", () => {
  it('strips "Re: " prefix', () => {
    expect(normalizeSubject("Re: Hello World")).toBe("Hello World");
  });

  it('strips "RE: " prefix', () => {
    expect(normalizeSubject("RE: Hello World")).toBe("Hello World");
  });

  it('strips "Fwd: " prefix', () => {
    expect(normalizeSubject("Fwd: Hello World")).toBe("Hello World");
  });

  it('strips "FW: " prefix', () => {
    expect(normalizeSubject("FW: Hello World")).toBe("Hello World");
  });

  it('strips "AW: " prefix (German reply)', () => {
    expect(normalizeSubject("AW: Something")).toBe("Something");
  });

  it('strips "WG: " prefix (German forward)', () => {
    expect(normalizeSubject("WG: Something")).toBe("Something");
  });

  it("strips multiple nested prefixes recursively", () => {
    expect(normalizeSubject("Re: Re: Hello World")).toBe("Hello World");
  });

  it("strips mixed nested prefixes recursively", () => {
    expect(normalizeSubject("Re: Fwd: Re: Deep Subject")).toBe("Deep Subject");
  });

  it("leaves plain subject unchanged", () => {
    expect(normalizeSubject("plain subject")).toBe("plain subject");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSubject("  Hello World  ")).toBe("Hello World");
  });

  it("passes through short subject unchanged (length guard is caller responsibility)", () => {
    expect(normalizeSubject("Hi")).toBe("Hi");
  });

  it("strips prefix from short subject without applying length guard", () => {
    expect(normalizeSubject("Re: Hi")).toBe("Hi");
  });
});

// =============================================================================
// Suite 2 — AppleMailManager junk/archive delegates
// =============================================================================

describe("AppleMailManager junk/archive delegates", () => {
  let executeAppleScriptMock: ReturnType<typeof vi.fn>;
  let manager: AppleMailManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    const applescriptModule = await import("@/utils/applescript.js");
    executeAppleScriptMock = applescriptModule.executeAppleScript as ReturnType<typeof vi.fn>;

    // Default: success response
    executeAppleScriptMock.mockReturnValue({ success: true, output: "ok" });

    manager = new AppleMailManager();
  });

  it("moveToJunk calls executeAppleScript twice (flag + move) and returns true", () => {
    // Both calls return success
    executeAppleScriptMock.mockReturnValue({ success: true, output: "ok" });

    const result = manager.moveToJunk("123");

    // Should have been called at least twice (flag step + move step)
    expect(executeAppleScriptMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toBe(true);
  });

  it("moveToJunk returns false when the flag step fails", () => {
    executeAppleScriptMock.mockReturnValueOnce({ success: false, error: "script error" });

    const result = manager.moveToJunk("123");

    expect(result).toBe(false);
    // Should NOT have called the move step
    expect(executeAppleScriptMock.mock.calls.length).toBe(1);
  });

  it("moveToJunk returns false for non-numeric ID without calling executeAppleScript", () => {
    const result = manager.moveToJunk("not-a-number");

    expect(result).toBe(false);
    expect(executeAppleScriptMock).not.toHaveBeenCalled();
  });

  it("markAsNotJunk script contains 'set junk mail status of msg to false'", () => {
    executeAppleScriptMock.mockReturnValue({ success: true, output: "ok" });

    manager.markAsNotJunk("456");

    expect(executeAppleScriptMock).toHaveBeenCalledOnce();
    const scriptArg = executeAppleScriptMock.mock.calls[0][0] as string;
    expect(scriptArg).toContain("set junk mail status of msg to false");
  });

  it("markAsNotJunk returns true on success", () => {
    executeAppleScriptMock.mockReturnValue({ success: true, output: "ok" });

    const result = manager.markAsNotJunk("456");

    expect(result).toBe(true);
  });

  it("markAsNotJunk returns false on failure", () => {
    executeAppleScriptMock.mockReturnValue({ success: false, error: "timeout" });

    const result = manager.markAsNotJunk("456");

    expect(result).toBe(false);
  });

  it("archiveMessage delegates to moveMessage with Archive mailbox", () => {
    const moveSpy = vi.spyOn(manager, "moveMessage").mockReturnValue(true);

    manager.archiveMessage("123");

    expect(moveSpy).toHaveBeenCalledWith("123", "Archive", undefined);
  });

  it("archiveMessage passes account parameter through to moveMessage", () => {
    const moveSpy = vi.spyOn(manager, "moveMessage").mockReturnValue(true);

    manager.archiveMessage("123", "myaccount@example.com");

    expect(moveSpy).toHaveBeenCalledWith("123", "Archive", "myaccount@example.com");
  });

  it("batchArchiveMessages delegates to batchMoveMessages with Archive mailbox", () => {
    const batchMoveSpy = vi.spyOn(manager, "batchMoveMessages").mockReturnValue([
      { id: "1", success: true },
      { id: "2", success: true },
    ]);

    manager.batchArchiveMessages(["1", "2"]);

    expect(batchMoveSpy).toHaveBeenCalledWith(["1", "2"], "Archive", undefined);
  });
});

// =============================================================================
// Suite 3 — SyncStatus shape (simplified)
// =============================================================================

describe("SyncStatus shape", () => {
  let executeAppleScriptMock: ReturnType<typeof vi.fn>;
  let manager: AppleMailManager;

  // FIELD_SEP = U+E001 (character id 57345)
  const FIELD_SEP = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    const applescriptModule = await import("@/utils/applescript.js");
    executeAppleScriptMock = applescriptModule.executeAppleScript as ReturnType<typeof vi.fn>;

    manager = new AppleMailManager();
  });

  it("getSyncStatus returns running: true when Mail.app responds", () => {
    executeAppleScriptMock.mockReturnValue({
      success: true,
      output: `running${FIELD_SEP}1`,
    });

    const status = manager.getSyncStatus();

    expect(status.running).toBe(true);
  });

  it("getSyncStatus returns accountCount from AppleScript output", () => {
    executeAppleScriptMock.mockReturnValue({
      success: true,
      output: `running${FIELD_SEP}3`,
    });

    const status = manager.getSyncStatus();

    expect(status.accountCount).toBe(3);
  });

  it("getSyncStatus does NOT have a syncDetected property", () => {
    executeAppleScriptMock.mockReturnValue({
      success: true,
      output: `running${FIELD_SEP}1`,
    });

    const status = manager.getSyncStatus();

    expect(status).not.toHaveProperty("syncDetected");
  });

  it("getSyncStatus does NOT have a pendingUpload property", () => {
    executeAppleScriptMock.mockReturnValue({
      success: true,
      output: `running${FIELD_SEP}1`,
    });

    const status = manager.getSyncStatus();

    expect(status).not.toHaveProperty("pendingUpload");
  });

  it("getSyncStatus does NOT have a recentActivity property", () => {
    executeAppleScriptMock.mockReturnValue({
      success: true,
      output: `running${FIELD_SEP}1`,
    });

    const status = manager.getSyncStatus();

    expect(status).not.toHaveProperty("recentActivity");
  });

  it("getSyncStatus returns running: false and error when AppleScript fails", () => {
    executeAppleScriptMock.mockReturnValue({
      success: false,
      error: "timeout",
    });

    const status = manager.getSyncStatus();

    expect(status.running).toBe(false);
    expect(status.accountCount).toBe(0);
    expect(status.error).toBe("timeout");
  });
});

// =============================================================================
// Suite 4 — getVipMessages (mock execSync + searchMessages)
// =============================================================================

describe("getVipMessages", () => {
  let execSyncMock: ReturnType<typeof vi.fn>;
  let executeAppleScriptMock: ReturnType<typeof vi.fn>;
  let manager: AppleMailManager;

  beforeEach(async () => {
    vi.clearAllMocks();

    const childProcessModule = await import("child_process");
    execSyncMock = childProcessModule.execSync as ReturnType<typeof vi.fn>;

    const applescriptModule = await import("@/utils/applescript.js");
    executeAppleScriptMock = applescriptModule.executeAppleScript as ReturnType<typeof vi.fn>;
    executeAppleScriptMock.mockReturnValue({ success: true, output: "" });

    manager = new AppleMailManager();
  });

  it("returns empty list with error when find returns empty string (no VIP.plist)", () => {
    execSyncMock.mockReturnValue("");

    const result = manager.getVipMessages();

    expect(result.messages).toEqual([]);
    expect(result.vipSenders).toEqual([]);
    expect(result.error).toContain("No VIP senders found");
  });

  it("returns empty list with error when execSync throws (find fails)", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("command not found");
    });

    const result = manager.getVipMessages();

    expect(result.messages).toEqual([]);
    expect(result.vipSenders).toEqual([]);
    expect(result.error).toContain("Failed to locate VIP.plist");
  });

  it("extracts email addresses from valid VIP.plist JSON", () => {
    // First call: find — returns a path
    execSyncMock.mockReturnValueOnce("/Users/test/Library/Mail/V10/VIP.plist\n");
    // Second call: plutil — returns valid JSON
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ EmailAddresses: ["vip@example.com", "boss@company.com"] })
    );

    // searchMessages will be called per VIP sender — mock it to return []
    vi.spyOn(manager, "searchMessages").mockReturnValue([]);

    const result = manager.getVipMessages();

    expect(result.vipSenders).toContain("vip@example.com");
    expect(result.vipSenders).toContain("boss@company.com");
  });

  it("returns error when plist JSON has no EmailAddresses array", () => {
    execSyncMock.mockReturnValueOnce("/Users/test/Library/Mail/V10/VIP.plist\n");
    execSyncMock.mockReturnValueOnce(JSON.stringify({ SomeOtherKey: [] }));

    const result = manager.getVipMessages();

    expect(result.messages).toEqual([]);
    expect(result.vipSenders).toEqual([]);
    expect(result.error).toContain("VIP.plist found but contains no email addresses");
  });

  it("calls searchMessages once per VIP sender address", () => {
    execSyncMock.mockReturnValueOnce("/Users/test/Library/Mail/V10/VIP.plist\n");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ EmailAddresses: ["alice@example.com", "bob@example.com"] })
    );

    const searchSpy = vi.spyOn(manager, "searchMessages").mockReturnValue([]);

    manager.getVipMessages();

    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns error when plutil parse fails (malformed plist)", () => {
    execSyncMock.mockReturnValueOnce("/Users/test/Library/Mail/V10/VIP.plist\n");
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("plutil: error");
    });

    const result = manager.getVipMessages();

    expect(result.messages).toEqual([]);
    expect(result.vipSenders).toEqual([]);
    expect(result.error).toContain("Failed to parse VIP.plist");
  });

  it("filters out non-email entries from EmailAddresses array", () => {
    execSyncMock.mockReturnValueOnce("/Users/test/Library/Mail/V10/VIP.plist\n");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ EmailAddresses: ["valid@example.com", "not-an-email", 42] })
    );

    const searchSpy = vi.spyOn(manager, "searchMessages").mockReturnValue([]);

    const result = manager.getVipMessages();

    // Only the valid email should be in vipSenders
    expect(result.vipSenders).toEqual(["valid@example.com"]);
    // searchMessages called only once (for the valid email)
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });
});
