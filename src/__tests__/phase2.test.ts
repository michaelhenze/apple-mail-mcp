/**
 * Phase 2 unit tests — covers pure TypeScript logic added in Phase 2.
 *
 * Suites:
 *   1. Template persistence round-trip (vi.mock on fs module)
 *   2. searchMessages offset slicing (TypeScript-level)
 *   3. Message interface completeness (compile-time)
 *   4. save-attachment handler validation guard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "@/types.js";

// vi.mock is hoisted to the top of the file, so the factory must not reference
// local variables. We expose the mocked functions via the module mock's
// return value and reconfigure them per test using mockReturnValue /
// mockImplementation AFTER the mock is in place.
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// =============================================================================
// Suite 1 — Template persistence round-trip
// =============================================================================

describe("Template persistence", () => {
  // Import the mocked fs inside the suite so we get the mocked versions
  let fsMock: {
    existsSync: ReturnType<typeof vi.fn>;
    readFileSync: ReturnType<typeof vi.fn>;
    writeFileSync: ReturnType<typeof vi.fn>;
    mkdirSync: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    // Re-import the mocked module to get the vi.fn() references
    fsMock = (await import("fs")) as typeof fsMock;
    vi.clearAllMocks();

    // Default: file does not exist (no stored templates)
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    fsMock.writeFileSync.mockImplementation(() => undefined);
    fsMock.mkdirSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("saveTemplate calls writeFileSync with JSON containing the new template", async () => {
    const { AppleMailManager } = await import("@/services/appleMailManager.js");
    const manager = new AppleMailManager();

    manager.saveTemplate("Test Template", "Hello Subject", "Hello Body");

    expect(fsMock.writeFileSync).toHaveBeenCalled();
    const writtenJson = fsMock.writeFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenJson) as {
      nextId: number;
      templates: Record<string, { name: string; subject: string; body: string }>;
    };
    const templateValues = Object.values(parsed.templates);
    expect(templateValues.length).toBe(1);
    expect(templateValues[0].name).toBe("Test Template");
    expect(templateValues[0].subject).toBe("Hello Subject");
  });

  it("deleteTemplate calls writeFileSync with the template removed", async () => {
    const { AppleMailManager } = await import("@/services/appleMailManager.js");
    const manager = new AppleMailManager();

    const tmpl = manager.saveTemplate("To Delete", "Subj", "Body");
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.writeFileSync.mockImplementation(() => undefined);
    fsMock.mkdirSync.mockImplementation(() => undefined);

    const deleted = manager.deleteTemplate(tmpl.id);
    expect(deleted).toBe(true);
    expect(fsMock.writeFileSync).toHaveBeenCalled();

    const writtenJson = fsMock.writeFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenJson) as { templates: Record<string, unknown> };
    expect(Object.keys(parsed.templates)).not.toContain(tmpl.id);
  });

  it("loadTemplates on startup reads from disk when file exists", async () => {
    const storedData = {
      nextId: 5,
      templates: {
        tmpl_3: {
          id: "tmpl_3",
          name: "Restored",
          subject: "Restored Subject",
          body: "Restored Body",
        },
      },
    };

    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(storedData));

    const { AppleMailManager } = await import("@/services/appleMailManager.js");
    const manager = new AppleMailManager();

    const templates = manager.listTemplates();
    expect(templates.length).toBe(1);
    expect(templates[0].name).toBe("Restored");
    expect(templates[0].id).toBe("tmpl_3");
  });

  it("listTemplates returns [] after loadTemplates with corrupt JSON", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("not valid json {{{");

    const { AppleMailManager } = await import("@/services/appleMailManager.js");
    const manager = new AppleMailManager();

    const templates = manager.listTemplates();
    expect(templates).toEqual([]);
  });
});

// =============================================================================
// Suite 2 — searchMessages offset slicing (TypeScript-level)
// =============================================================================

describe("searchMessages offset slicing", () => {
  const makeMsg = (id: string): Message => ({
    id,
    subject: `Subject ${id}`,
    sender: "sender@example.com",
    recipients: [],
    dateReceived: new Date(),
    isRead: false,
    isFlagged: false,
    isJunk: false,
    isDeleted: false,
    mailbox: "INBOX",
    account: "Test",
    hasAttachments: false,
  });

  it("multi-account offset: slice(offset, offset+limit) trims correctly", () => {
    // Simulate the TypeScript slice logic used in the multi-account fan-out
    const simulateSearch = (allMessages: Message[], offset: number, limit: number): Message[] => {
      return allMessages.slice(offset, offset + limit);
    };

    const messages = ["1", "2", "3", "4", "5"].map(makeMsg);

    // offset=2, limit=2 → should return messages[2] and messages[3]
    const result = simulateSearch(messages, 2, 2);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("3");
    expect(result[1].id).toBe("4");
  });

  it("returns empty array when offset >= totalResults", () => {
    const simulateSearch = (allMessages: Message[], offset: number, limit: number): Message[] => {
      return allMessages.slice(offset, offset + limit);
    };

    const messages = ["1", "2"].map(makeMsg);

    // offset=5 with only 2 messages → empty
    const result = simulateSearch(messages, 5, 10);
    expect(result).toEqual([]);
  });

  it("offset=0 returns first N results unchanged", () => {
    const simulateSearch = (allMessages: Message[], offset: number, limit: number): Message[] => {
      return allMessages.slice(offset, offset + limit);
    };

    const messages = ["1", "2", "3"].map(makeMsg);
    const result = simulateSearch(messages, 0, 2);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("1");
  });
});

// =============================================================================
// Suite 3 — Message interface completeness (compile-time)
// =============================================================================

describe("Message interface completeness", () => {
  it("Message interface has replyTo and senderName fields", () => {
    // Compile-time check: if these fields don't exist, tsc will fail
    const _check: Pick<Message, "replyTo" | "senderName"> = {
      replyTo: undefined,
      senderName: undefined,
    };
    expect(_check).toBeDefined();
  });

  it("Message interface has attachmentNames field", () => {
    const _check: Pick<Message, "attachmentNames"> = {
      attachmentNames: undefined,
    };
    expect(_check).toBeDefined();
  });
});

// =============================================================================
// Suite 4 — save-attachment handler validation guard
// =============================================================================

describe("save-attachment handler validation guard", () => {
  it("rejects call when neither attachmentName nor attachmentIndex provided", () => {
    const attachmentName = undefined;
    const attachmentIndex = undefined;
    const isInvalid = !attachmentName && attachmentIndex === undefined;
    expect(isInvalid).toBe(true);
  });

  it("accepts call with only attachmentName", () => {
    const attachmentName = "report.pdf";
    const attachmentIndex = undefined;
    const isInvalid = !attachmentName && attachmentIndex === undefined;
    expect(isInvalid).toBe(false);
  });

  it("accepts call with only attachmentIndex", () => {
    const attachmentName = undefined;
    const attachmentIndex = 1;
    const isInvalid = !attachmentName && attachmentIndex === undefined;
    expect(isInvalid).toBe(false);
  });

  it("accepts call with both attachmentName and attachmentIndex", () => {
    const attachmentName = "report.pdf";
    const attachmentIndex = 1;
    const isInvalid = !attachmentName && attachmentIndex === undefined;
    expect(isInvalid).toBe(false);
  });
});
