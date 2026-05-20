/**
 * Phase 4 unit tests — covers pure TypeScript logic added in Phase 4 Intelligence Layer.
 *
 * Suites:
 *   1. getUnsubscribeLinks — regex extraction + newsletter heuristics
 *   2. getTriageMessages — unread fetch + snippet logic
 *   3. getSummarizeInboxData — unread count + message list
 *   4. getActionItems — single message and mailbox scan modes
 *   5. getDraftReplyContext — thread context + optional draft creation
 *   6. getThreadSummaryData — full thread body fallback
 *   7. getWaitingFor — reply detection + sorting
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleMailManager } from "@/services/appleMailManager.js";
import type { Message, MessageContent, ThreadMessage, Account } from "@/types.js";

// vi.mock is hoisted; factory must not reference local variables.
vi.mock("@/utils/applescript.js", () => ({
  executeAppleScript: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// =============================================================================
// Helpers
// =============================================================================

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "123",
    subject: "Test Subject",
    sender: "sender@example.com",
    recipients: ["recipient@example.com"],
    dateReceived: new Date("2026-05-10T12:00:00Z"),
    isRead: false,
    isFlagged: false,
    isJunk: false,
    isDeleted: false,
    mailbox: "INBOX",
    account: "test@example.com",
    hasAttachments: false,
    ...overrides,
  };
}

function makeContent(overrides: Partial<MessageContent> = {}): MessageContent {
  return {
    id: "123",
    subject: "Test Subject",
    plainText: "Hello, please review and let me know by Friday.",
    htmlContent: "<html><body>Hello</body></html>",
    ...overrides,
  };
}

function makeThreadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "124",
    subject: "Test Subject",
    sender: "other@example.com",
    dateReceived: new Date("2026-05-11T12:00:00Z"),
    isRead: true,
    mailbox: "INBOX",
    account: "test@example.com",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    name: "Test Account",
    email: "user@example.com",
    enabled: true,
    ...overrides,
  };
}

// =============================================================================
// Suite 1 — getUnsubscribeLinks
// =============================================================================

describe("getUnsubscribeLinks — regex extraction", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("extracts http link when anchor text contains 'unsubscribe'", () => {
    const html = `<a href="https://example.com/unsub">Unsubscribe</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(makeMessage({ subject: "Hello" }));
    const result = manager.getUnsubscribeLinks("123");
    expect(result.unsubscribeLinks).toContain("https://example.com/unsub");
  });

  it("extracts mailto link when href contains 'unsubscribe'", () => {
    const html = `<a href="mailto:unsub@example.com?subject=unsubscribe">Click here</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(makeMessage({ subject: "Hello" }));
    const result = manager.getUnsubscribeLinks("123");
    expect(result.unsubscribeLinks.some((l) => l.includes("unsubscribe"))).toBe(true);
  });

  it("extracts link when href contains 'optout'", () => {
    const html = `<a href="https://example.com/optout?id=abc">Stop emails</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(makeMessage({ subject: "Hello" }));
    const result = manager.getUnsubscribeLinks("123");
    expect(result.unsubscribeLinks).toContain("https://example.com/optout?id=abc");
  });

  it("extracts link when href contains 'opt-out'", () => {
    const html = `<a href="https://example.com/opt-out/user123">Stop emails</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(makeMessage({ subject: "Hello" }));
    const result = manager.getUnsubscribeLinks("123");
    expect(result.unsubscribeLinks).toContain("https://example.com/opt-out/user123");
  });

  it("deduplicates links found by both passes", () => {
    // This URL would be matched by both the text pass (anchor text = "Unsubscribe")
    // and the href pass (href contains "unsubscribe").
    const html = `<a href="https://example.com/unsubscribe">Unsubscribe</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(makeMessage({ subject: "Hello" }));
    const result = manager.getUnsubscribeLinks("123");
    const url = "https://example.com/unsubscribe";
    expect(result.unsubscribeLinks.filter((l) => l === url).length).toBe(1);
  });

  it("returns empty array for HTML with no unsubscribe links", () => {
    const html = `<html><body><p>No unsubscribe link here.</p></body></html>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(makeMessage({ subject: "Hello" }));
    const result = manager.getUnsubscribeLinks("123");
    expect(result.unsubscribeLinks).toHaveLength(0);
  });

  it("returns isLikelyNewsletter=false when 0-1 signals match", () => {
    // Only one signal: unsubscribe link found
    const html = `<a href="https://example.com/unsubscribe">Unsubscribe</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(
      makeMessage({ subject: "Regular email" })
    );
    const result = manager.getUnsubscribeLinks("123");
    // Only "Unsubscribe link found in HTML" signal = 1 signal
    expect(result.isLikelyNewsletter).toBe(false);
  });

  it("returns isLikelyNewsletter=true when 2+ signals match", () => {
    // Two signals: newsletter subject keyword + unsubscribe link
    const html = `<a href="https://example.com/unsubscribe">Unsubscribe</a>`;
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ htmlContent: html }));
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(
      makeMessage({ subject: "Weekly Newsletter Update" })
    );
    const result = manager.getUnsubscribeLinks("123");
    expect(result.isLikelyNewsletter).toBe(true);
    expect(result.newsletterSignals.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Suite 2 — getTriageMessages
// =============================================================================

describe("getTriageMessages", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("calls listMessages with unreadOnly=true", () => {
    const listSpy = vi.spyOn(manager, "listMessages").mockReturnValue([]);
    manager.getTriageMessages("INBOX", 20, false);
    expect(listSpy).toHaveBeenCalledWith("INBOX", undefined, 20, undefined, 0, true);
  });

  it("calls getMessageContent per message when includeSnippets=true", () => {
    const msg = makeMessage();
    vi.spyOn(manager, "listMessages").mockReturnValue([msg]);
    const contentSpy = vi
      .spyOn(manager, "getMessageContent")
      .mockReturnValue(makeContent({ plainText: "Short body." }));
    manager.getTriageMessages("INBOX", 20, true);
    expect(contentSpy).toHaveBeenCalledWith(msg.id);
  });

  it("does NOT call getMessageContent when includeSnippets=false", () => {
    const msg = makeMessage();
    vi.spyOn(manager, "listMessages").mockReturnValue([msg]);
    const contentSpy = vi.spyOn(manager, "getMessageContent").mockReturnValue(null);
    manager.getTriageMessages("INBOX", 20, false);
    expect(contentSpy).not.toHaveBeenCalled();
  });

  it("truncates snippet to 200 chars", () => {
    const longBody = "A".repeat(300);
    const msg = makeMessage();
    vi.spyOn(manager, "listMessages").mockReturnValue([msg]);
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ plainText: longBody }));
    const result = manager.getTriageMessages("INBOX", 20, true);
    expect(result[0].snippet).toBeDefined();
    expect(result[0].snippet!.length).toBeLessThanOrEqual(200);
  });
});

// =============================================================================
// Suite 3 — getSummarizeInboxData
// =============================================================================

describe("getSummarizeInboxData", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("calls getUnreadCount and returns totalUnread", () => {
    const unreadSpy = vi.spyOn(manager, "getUnreadCount").mockReturnValue(42);
    vi.spyOn(manager, "listMessages").mockReturnValue([]);
    const result = manager.getSummarizeInboxData("INBOX", 30);
    expect(unreadSpy).toHaveBeenCalledWith("INBOX", undefined);
    expect(result.totalUnread).toBe(42);
  });

  it("calls listMessages with unreadOnly=true", () => {
    vi.spyOn(manager, "getUnreadCount").mockReturnValue(5);
    const listSpy = vi.spyOn(manager, "listMessages").mockReturnValue([]);
    manager.getSummarizeInboxData("INBOX", 30);
    expect(listSpy).toHaveBeenCalledWith("INBOX", undefined, 30, undefined, 0, true);
  });
});

// =============================================================================
// Suite 4 — getActionItems
// =============================================================================

describe("getActionItems", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("calls getMessageContent for the given id (single message mode)", () => {
    const msg = makeMessage({ id: "999" });
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(msg);
    const contentSpy = vi
      .spyOn(manager, "getMessageContent")
      .mockReturnValue(makeContent({ id: "999" }));
    manager.getActionItems("999");
    expect(contentSpy).toHaveBeenCalledWith("999");
  });

  it("calls listMessages then getMessageContent per message (mailbox mode)", () => {
    const msgs = [makeMessage({ id: "1" }), makeMessage({ id: "2" })];
    const listSpy = vi.spyOn(manager, "listMessages").mockReturnValue(msgs);
    const contentSpy = vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent());
    manager.getActionItems(undefined, "INBOX", 10);
    expect(listSpy).toHaveBeenCalled();
    expect(contentSpy).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Suite 5 — getDraftReplyContext
// =============================================================================

describe("getDraftReplyContext", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("returns context string with thread messages", () => {
    const seed = makeMessage({ id: "100", recipients: ["me@example.com"] });
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(seed);
    vi.spyOn(manager, "getThread").mockReturnValue([
      makeThreadMessage({ id: "100", sender: "sender@example.com" }),
      makeThreadMessage({ id: "101", sender: "me@example.com" }),
    ]);
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent({ plainText: "Body text" }));
    const { context } = manager.getDraftReplyContext("100");
    expect(context).toContain("Thread context for reply");
    expect(context).toContain("sender@example.com");
  });

  it("calls createDraft when draftBody is provided", () => {
    const seed = makeMessage({ id: "100", recipients: ["me@example.com"] });
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(seed);
    vi.spyOn(manager, "getThread").mockReturnValue([makeThreadMessage()]);
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent());
    const draftSpy = vi.spyOn(manager, "createDraft").mockReturnValue(true);
    manager.getDraftReplyContext("100", "Here is my reply.");
    expect(draftSpy).toHaveBeenCalled();
  });

  it("does NOT call createDraft when draftBody is undefined", () => {
    const seed = makeMessage({ id: "100", recipients: ["me@example.com"] });
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(seed);
    vi.spyOn(manager, "getThread").mockReturnValue([makeThreadMessage()]);
    vi.spyOn(manager, "getMessageContent").mockReturnValue(makeContent());
    const draftSpy = vi.spyOn(manager, "createDraft").mockReturnValue(true);
    manager.getDraftReplyContext("100", undefined);
    expect(draftSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Suite 6 — getThreadSummaryData
// =============================================================================

describe("getThreadSummaryData", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("returns fallback single-message context when getThread returns []", () => {
    const seed = makeMessage({ id: "200" });
    vi.spyOn(manager, "getThread").mockReturnValue([]);
    vi.spyOn(manager as never, "getMessageById").mockReturnValue(seed);
    vi.spyOn(manager, "getMessageContent").mockReturnValue(
      makeContent({ plainText: "Single message body" })
    );
    const result = manager.getThreadSummaryData("200");
    expect(result).toContain("1 message");
    expect(result).toContain("Single message body");
  });
});

// =============================================================================
// Suite 7 — getWaitingFor
// =============================================================================

describe("getWaitingFor", () => {
  let manager: AppleMailManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AppleMailManager();
  });

  it("builds userEmails set from listAccounts", () => {
    const accountsSpy = vi
      .spyOn(manager, "listAccounts")
      .mockReturnValue([makeAccount({ email: "user@example.com" })]);
    vi.spyOn(manager, "searchMessages").mockReturnValue([]);
    manager.getWaitingFor(20, 2);
    expect(accountsSpy).toHaveBeenCalled();
  });

  it("filters out messages newer than daysAgo threshold", () => {
    vi.spyOn(manager, "listAccounts").mockReturnValue([makeAccount()]);
    // Message sent 1 day ago — below daysAgo=2 threshold
    const recentMsg = makeMessage({
      id: "300",
      dateReceived: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    vi.spyOn(manager, "searchMessages").mockReturnValue([recentMsg]);
    const threadSpy = vi.spyOn(manager, "getThread").mockReturnValue([]);
    const result = manager.getWaitingFor(20, 2);
    expect(result).toHaveLength(0);
    // getThread should not be called for messages below the threshold
    expect(threadSpy).not.toHaveBeenCalled();
  });

  it("marks message as waiting when no thread reply from non-self sender exists", () => {
    vi.spyOn(manager, "listAccounts").mockReturnValue([makeAccount({ email: "user@example.com" })]);
    const sentMsg = makeMessage({
      id: "400",
      sender: "user@example.com",
      dateReceived: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    vi.spyOn(manager, "searchMessages").mockReturnValue([sentMsg]);
    // Thread only has messages from self — no external reply
    vi.spyOn(manager, "getThread").mockReturnValue([
      makeThreadMessage({
        sender: "user@example.com",
        dateReceived: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      }),
    ]);
    const result = manager.getWaitingFor(20, 2);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("400");
    expect(result[0].hasReply).toBe(false);
  });

  it("skips message when thread contains reply from non-self sender after sent date", () => {
    vi.spyOn(manager, "listAccounts").mockReturnValue([makeAccount({ email: "user@example.com" })]);
    const sentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const sentMsg = makeMessage({
      id: "500",
      sender: "user@example.com",
      dateReceived: sentDate,
    });
    vi.spyOn(manager, "searchMessages").mockReturnValue([sentMsg]);
    // Thread has a reply from an external sender after the sent date
    vi.spyOn(manager, "getThread").mockReturnValue([
      makeThreadMessage({
        sender: "other@example.com",
        dateReceived: new Date(sentDate.getTime() + 60 * 60 * 1000), // 1 hour later
      }),
    ]);
    const result = manager.getWaitingFor(20, 2);
    expect(result).toHaveLength(0);
  });

  it("sorts result oldest-first", () => {
    vi.spyOn(manager, "listAccounts").mockReturnValue([makeAccount({ email: "user@example.com" })]);
    const olderMsg = makeMessage({
      id: "600",
      dateReceived: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    const newerMsg = makeMessage({
      id: "601",
      dateReceived: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    });
    vi.spyOn(manager, "searchMessages").mockReturnValue([newerMsg, olderMsg]);
    vi.spyOn(manager, "getThread").mockReturnValue([]);
    const result = manager.getWaitingFor(20, 2);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].daysWaiting).toBeGreaterThan(result[1].daysWaiting);
  });
});
