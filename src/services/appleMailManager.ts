/**
 * Apple Mail Manager
 *
 * Handles all interactions with Apple Mail via AppleScript.
 * This is the core service layer for the MCP server.
 *
 * Architecture:
 * - Text escaping is handled by dedicated helper functions
 * - AppleScript generation uses template builders for consistency
 * - All public methods return typed results (no raw strings)
 * - Error handling is consistent across all operations
 *
 * @module services/appleMailManager
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { executeAppleScript } from "@/utils/applescript.js";
import { validateSavePath } from "@/utils/pathSecurity.js";
import type {
  Message,
  MessageContent,
  Mailbox,
  Account,
  Attachment,
  HealthCheckResult,
  MailStats,
  AccountStats,
  BatchOperationResult,
  SyncStatus,
  RecentlyReceivedStats,
  MailRule,
  Contact,
  EmailTemplate,
  ThreadMessage,
  TriageMessage,
  ActionItemsResult,
  WaitingForItem,
} from "@/types.js";

// =============================================================================
// Text Processing Utilities
// =============================================================================

/**
 * Escapes text for safe embedding in AppleScript string literals.
 *
 * AppleScript strings use double quotes, so we need to escape:
 * 1. Backslashes (\) - escaped as \\
 * 2. Double quotes (") - escaped as \"
 *
 * @param text - Raw text to escape
 * @returns Text safe for AppleScript string embedding
 */
function escapeForAppleScript(text: string): string {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Parses AppleScript date representation to JavaScript Date.
 *
 * AppleScript returns dates in a verbose format like:
 * "date Saturday, December 27, 2025 at 3:44:02 PM"
 *
 * @param appleScriptDate - Date string from AppleScript
 * @returns Parsed Date, or current date if parsing fails
 */
function parseAppleScriptDate(appleScriptDate: string): Date {
  const withoutPrefix = appleScriptDate.replace(/^date\s+/, "");
  const normalized = withoutPrefix.replace(" at ", " ");
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Builds an AppleScript command scoped to a specific account.
 */
function buildAccountScopedScript(account: string, command: string): string {
  return `
    tell application "Mail"
      tell account "${escapeForAppleScript(account)}"
        ${command}
      end tell
    end tell
  `;
}

/**
 * Builds an AppleScript command at the application level.
 */
function buildAppLevelScript(command: string): string {
  return `
    tell application "Mail"
      ${command}
    end tell
  `;
}

/**
 * Common mailbox name variations across different account types.
 * Maps normalized (lowercase) names to possible actual names.
 */
const MAILBOX_ALIASES: Record<string, string[]> = {
  inbox: ["INBOX", "Inbox", "inbox"],
  sent: ["Sent", "Sent Items", "Sent Messages", "SENT", "sent"],
  drafts: ["Drafts", "DRAFTS", "drafts", "Draft"],
  trash: ["Trash", "Deleted Items", "Deleted Messages", "TRASH", "trash"],
  junk: ["Junk", "Junk Email", "Spam", "JUNK", "junk"],
  archive: ["Archive", "ARCHIVE", "archive", "All Mail"],
};

// Safe output delimiters — Unicode Private Use Area characters that cannot
// appear in real email subjects, sender names, or mailbox names.
// U+E001 = field separator (replaces pipe-pipe-pipe delimiter)
// U+E002 = record separator (replaces pipe-pipe-pipe ITEM pipe-pipe-pipe delimiter)
// U+E003 = content separator (replaces pipe-pipe-pipe CONTENT pipe-pipe-pipe in getMessageContent)
// U+E004 = html separator (replaces pipe-pipe-pipe HTML pipe-pipe-pipe in getMessageContent)
const FIELD_SEP = "";
const RECORD_SEP = "";
const CONTENT_SEP = "";
const HTML_SEP = "";

// =============================================================================
// Subject Normalization
// =============================================================================

/**
 * Strips common reply/forward subject prefixes to get the base subject.
 *
 * Handles English (Re:, Fwd:, FW:), German (AW:, WG:), and mixed-case variants.
 * Applied recursively until no more prefixes remain.
 *
 * @param subject - Raw email subject line
 * @returns Normalized base subject with prefixes stripped and whitespace trimmed
 */
export function normalizeSubject(subject: string): string {
  const prefixPattern = /^(Re|RE|re|Fwd|FWD|fwd|FW|fw|AW|aw|WG|wg):\s+/;
  let normalized = subject.trim();
  let prev: string;
  do {
    prev = normalized;
    normalized = normalized.replace(prefixPattern, "").trim();
  } while (normalized !== prev);
  return normalized;
}

// =============================================================================
// Apple Mail Manager Class
// =============================================================================

/**
 * Manager class for Apple Mail operations.
 *
 * Provides methods for:
 * - Reading and searching messages
 * - Sending emails
 * - Managing mailboxes
 * - Listing accounts
 *
 * All operations are synchronous since they rely on AppleScript
 * execution via osascript. Error handling is consistent: methods
 * return null/false/empty-array on failure rather than throwing.
 */
export class AppleMailManager {
  private readonly TEMPLATE_FILE = join(homedir(), ".config", "apple-mail-mcp", "templates.json");

  constructor() {
    this.loadTemplates();
  }

  /**
   * Default account used when no account is specified.
   */
  private defaultAccount: string | null = null;

  /**
   * TTL cache for expensive AppleScript queries that rarely change.
   * Caches account list and per-account mailbox names to avoid
   * redundant AppleScript roundtrips on every tool call.
   */
  private cache = {
    accounts: null as { data: Account[]; expiry: number } | null,
    mailboxNames: new Map<string, { data: string[]; expiry: number }>(),
  };

  /** Cache TTL in milliseconds (60 seconds). */
  private readonly CACHE_TTL_MS = 60_000;

  /**
   * Returns cached accounts or fetches fresh data if cache is expired/empty.
   */
  private getCachedAccounts(): Account[] {
    const now = Date.now();
    if (this.cache.accounts && now < this.cache.accounts.expiry) {
      return this.cache.accounts.data;
    }
    const accounts = this.fetchAccounts();
    this.cache.accounts = { data: accounts, expiry: now + this.CACHE_TTL_MS };
    return accounts;
  }

  /**
   * Returns cached mailbox names for an account, or fetches fresh.
   * This caches only the name list used by resolveMailbox(), not the
   * full Mailbox objects with counts (which change frequently).
   */
  private getCachedMailboxNames(account: string): string[] {
    const now = Date.now();
    const cached = this.cache.mailboxNames.get(account);
    if (cached && now < cached.expiry) {
      return cached.data;
    }
    const names = this.fetchMailboxNames(account);
    this.cache.mailboxNames.set(account, { data: names, expiry: now + this.CACHE_TTL_MS });
    return names;
  }

  /**
   * Invalidate all caches. Call after operations that change
   * mailbox structure (create/delete/rename mailbox).
   */
  private invalidateCache(): void {
    this.cache.accounts = null;
    this.cache.mailboxNames.clear();
  }

  /**
   * Resolves the account to use for an operation.
   * Queries Mail.app's configured default send account, then falls back
   * to the first available account.
   */
  private resolveAccount(account?: string): string {
    if (account) return account;
    if (this.defaultAccount) return this.defaultAccount;

    // Query Mail.app's default send account by inspecting a temporary outgoing message
    const defaultResult = executeAppleScript(
      buildAppLevelScript(`
        set newMsg to make new outgoing message
        set fromAddr to sender of newMsg
        delete newMsg
        return fromAddr
      `)
    );

    if (defaultResult.success && defaultResult.output.trim()) {
      // sender returns "Name <email>" — match to account by email address
      const senderOutput = defaultResult.output.trim();
      const emailMatch = senderOutput.match(/<([^>]+)>/);
      const defaultEmail = emailMatch ? emailMatch[1] : senderOutput;

      const accounts = this.getCachedAccounts();
      const matchedAccount = accounts.find(
        (a) => a.email.toLowerCase() === defaultEmail.toLowerCase()
      );
      if (matchedAccount) {
        this.defaultAccount = matchedAccount.name;
        return this.defaultAccount;
      }
    }

    // Fall back to first available account
    const accounts = this.getCachedAccounts();
    if (accounts.length > 0) {
      this.defaultAccount = accounts[0].name;
      return this.defaultAccount;
    }

    return "iCloud"; // Last resort fallback
  }

  /**
   * Resolves a mailbox name to its actual name in the account.
   *
   * Different account types (IMAP, Exchange, iCloud) use different
   * mailbox naming conventions:
   * - IMAP/Gmail: "INBOX", "Sent", "Drafts"
   * - Exchange: "Inbox", "Sent Items", "Deleted Items"
   * - iCloud: "INBOX", "Sent", "Trash"
   *
   * This method tries to find a matching mailbox by:
   * 1. Exact match
   * 2. Case-insensitive match
   * 3. Known aliases (e.g., "Sent" -> "Sent Items")
   *
   * @param mailbox - Requested mailbox name
   * @param account - Account to search in
   * @returns Actual mailbox name, or original if not found
   */
  private resolveMailbox(mailbox: string, account: string): string {
    const actualMailboxes = this.getCachedMailboxNames(account);
    if (actualMailboxes.length === 0) {
      return mailbox; // Fall back to original
    }

    // 1. Try exact match
    if (actualMailboxes.includes(mailbox)) {
      return mailbox;
    }

    // 2. Try case-insensitive match
    const lowerMailbox = mailbox.toLowerCase();
    const caseMatch = actualMailboxes.find((mb) => mb.toLowerCase() === lowerMailbox);
    if (caseMatch) {
      return caseMatch;
    }

    // 3. Try known aliases
    const aliases = MAILBOX_ALIASES[lowerMailbox];
    if (aliases) {
      for (const alias of aliases) {
        if (actualMailboxes.includes(alias)) {
          return alias;
        }
        // Also try case-insensitive alias match
        const aliasMatch = actualMailboxes.find((mb) => mb.toLowerCase() === alias.toLowerCase());
        if (aliasMatch) {
          return aliasMatch;
        }
      }
    }

    // No match found, return original and let AppleScript handle the error
    return mailbox;
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Search for messages matching criteria.
   *
   * @param query - Text to search for in subject or sender
   * @param mailbox - Mailbox to search in (e.g., "INBOX")
   * @param account - Account to search in
   * @param limit - Maximum number of results
   * @returns Array of matching messages
   */
  searchMessages(
    query?: string,
    mailbox?: string,
    account?: string,
    limit = 50,
    dateFrom?: string,
    dateTo?: string,
    from?: string,
    isRead?: boolean,
    isFlagged?: boolean,
    allMailboxes?: boolean,
    offset = 0
  ): Message[] {
    // If no account specified, search across all accounts
    if (!account) {
      const accounts = this.listAccounts();
      const allMessages: Message[] = [];
      for (const acct of accounts) {
        if (allMessages.length >= offset + limit) break;
        const remaining = offset + limit - allMessages.length;
        const msgs = this.searchMessages(
          query,
          mailbox,
          acct.name,
          remaining,
          dateFrom,
          dateTo,
          from,
          isRead,
          isFlagged,
          allMailboxes,
          0 // offset=0 per account; global slice below
        );
        allMessages.push(...msgs);
      }
      return allMessages.slice(offset, offset + limit);
    }

    const targetAccount = this.resolveAccount(account);

    // Build compound search conditions
    const searchConditions: string[] = [];

    if (query) {
      const safeQuery = escapeForAppleScript(query);
      searchConditions.push(`(subject contains "${safeQuery}" or sender contains "${safeQuery}")`);
    }
    if (from !== undefined) {
      const safeFrom = escapeForAppleScript(from);
      searchConditions.push(`sender contains "${safeFrom}"`);
    }
    if (isRead !== undefined) {
      searchConditions.push(`read status is ${isRead}`);
    }
    if (isFlagged !== undefined) {
      searchConditions.push(`flagged status is ${isFlagged}`);
    }

    const searchCondition =
      searchConditions.length > 0 ? `whose (${searchConditions.join(" and ")})` : "";

    // Build date filter AppleScript
    let dateFilter = "";
    if (dateFrom || dateTo) {
      const dateChecks: string[] = [];
      if (dateFrom) {
        dateChecks.push(`date received of msg >= date "${dateFrom}"`);
      }
      if (dateTo) {
        dateChecks.push(`date received of msg <= date "${dateTo}"`);
      }
      dateFilter = dateChecks.join(" and ");
    }

    if (allMailboxes) {
      const searchCommand = `
        set fieldSep to character id 57345
        set recSep to character id 57346
        set outputText to ""
        set msgCount to 0
        set skipped to 0
        repeat with mb in mailboxes
          set allMsgs to messages of mb ${searchCondition}
          repeat with msg in allMsgs
            if msgCount >= ${limit} then exit repeat
            try
              ${
                dateFilter
                  ? `set msgDate to date received of msg
              if not (${dateFilter}) then
              else`
                  : ""
              }
              if skipped < ${offset} then
                set skipped to skipped + 1
              else
                set msgId to id of msg as string
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set msgDateStr to date received of msg as string
                set msgRead to read status of msg as string
                set msgFlagged to flagged status of msg as string
                set mbName to name of mb
                if msgCount > 0 then set outputText to outputText & recSep
                set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDateStr & fieldSep & msgRead & fieldSep & msgFlagged & fieldSep & mbName
                set msgCount to msgCount + 1
              end if
              ${dateFilter ? "end if" : ""}
            end try
          end repeat
          if msgCount >= ${limit} then exit repeat
        end repeat
        return outputText
      `;
      const script = buildAccountScopedScript(targetAccount, searchCommand);
      const result = executeAppleScript(script, { timeoutMs: 60000 });
      if (!result.success || !result.output.trim()) return [];
      return this.parseMessageListAllMailboxes(result.output, targetAccount);
    }

    const requestedMailbox = mailbox || "INBOX";
    const targetMailbox = this.resolveMailbox(requestedMailbox, targetAccount);

    const searchCommand = `
      set fieldSep to character id 57345
      set recSep to character id 57346
      set outputText to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set allMessages to messages of theMailbox ${searchCondition}
      set msgCount to 0
      set skipped to 0
      repeat with msg in allMessages
        if msgCount >= ${limit} then exit repeat
        try
          ${
            dateFilter
              ? `set msgDate to date received of msg
          if not (${dateFilter}) then
            -- skip message outside date range
          else`
              : ""
          }
          if skipped < ${offset} then
            set skipped to skipped + 1
          else
            set msgId to id of msg as string
            set msgSubject to subject of msg
            set msgSender to sender of msg
            set msgDateStr to date received of msg as string
            set msgRead to read status of msg as string
            set msgFlagged to flagged status of msg as string
            if msgCount > 0 then set outputText to outputText & recSep
            set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDateStr & fieldSep & msgRead & fieldSep & msgFlagged
            set msgCount to msgCount + 1
          end if
          ${dateFilter ? "end if" : ""}
        end try
      end repeat
      return outputText
    `;

    const script = buildAccountScopedScript(targetAccount, searchCommand);
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success) {
      console.error(`Failed to search messages: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    return this.parseMessageList(result.output, targetMailbox, targetAccount);
  }

  /**
   * Get a message by ID.
   *
   * Note: Mail.app message IDs are unique per mailbox. This method searches
   * all mailboxes in all accounts to find the message.
   */
  getMessageById(id: string): Message | null {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return null;
    }
    const script = buildAppLevelScript(`
      try
        set fieldSep to character id 57345
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set msgDate to date received of msg as string
                set msgRead to read status of msg as string
                set msgFlagged to flagged status of msg as string
                set msgJunk to junk mail status of msg as string
                set msgDeleted to deleted status of msg as string
                set msgMailbox to name of mb
                set msgAccount to name of acct
                -- recipients (field 10)
                set msgRecipients to ""
                try
                  repeat with r in to recipients of msg
                    if msgRecipients is not "" then set msgRecipients to msgRecipients & ","
                    set msgRecipients to msgRecipients & (address of r)
                  end repeat
                end try
                -- cc recipients (field 11)
                set msgCC to ""
                try
                  repeat with r in cc recipients of msg
                    if msgCC is not "" then set msgCC to msgCC & ","
                    set msgCC to msgCC & (address of r)
                  end repeat
                end try
                -- reply-to (field 12) — may not exist on all messages; wrap in try
                set msgReplyTo to ""
                try
                  set msgReplyTo to reply to of msg
                end try
                -- has attachments (field 13)
                set msgHasAtt to (count of mail attachments of msg) > 0
                -- attachment names (field 14) — comma-joined
                set msgAttNames to ""
                if msgHasAtt then
                  try
                    repeat with att in mail attachments of msg
                      if msgAttNames is not "" then set msgAttNames to msgAttNames & ","
                      set msgAttNames to msgAttNames & (name of att)
                    end repeat
                  end try
                end if
                return msgSubject & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & msgFlagged & fieldSep & msgJunk & fieldSep & msgDeleted & fieldSep & msgMailbox & fieldSep & msgAccount & fieldSep & msgRecipients & fieldSep & msgCC & fieldSep & msgReplyTo & fieldSep & (msgHasAtt as string) & fieldSep & msgAttNames
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 }); // Longer timeout for search

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get message ${id}: ${result.error}`);
      return null;
    }

    const parts = result.output.split(FIELD_SEP);
    if (parts.length < 9) return null;

    return {
      id: id.toString(),
      subject: parts[0],
      sender: parts[1],
      senderName: parts[1].includes("<")
        ? parts[1].split("<")[0].trim().replace(/^"/, "").replace(/"$/, "") || undefined
        : undefined,
      recipients: parts[9] ? parts[9].split(",").filter(Boolean) : [],
      ccRecipients: parts[10] ? parts[10].split(",").filter(Boolean) : undefined,
      replyTo: parts[11] || undefined,
      dateReceived: parseAppleScriptDate(parts[2]),
      isRead: parts[3] === "true",
      isFlagged: parts[4] === "true",
      isJunk: parts[5] === "true",
      isDeleted: parts[6] === "true",
      mailbox: parts[7],
      account: parts[8],
      hasAttachments: parts[12] === "true",
      attachmentNames: parts[13] ? parts[13].split(",").filter(Boolean) : undefined,
    };
  }

  /**
   * Get the content of a message.
   */
  getMessageContent(id: string): MessageContent | null {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return null;
    }
    const script = buildAppLevelScript(`
      try
        set contentSep to character id 57347
        set htmlSep to character id 57348
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set msgSubject to subject of msg
                set msgContent to content of msg
                set htmlContent to ""
                try
                  set htmlContent to source of msg
                end try
                return msgSubject & contentSep & msgContent & htmlSep & htmlContent
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get message content: ${result.error}`);
      return null;
    }

    const htmlSplit = result.output.split(HTML_SEP);
    const contentPart = htmlSplit[0];
    const htmlContent = htmlSplit.length > 1 ? htmlSplit[1] : undefined;

    const parts = contentPart.split(CONTENT_SEP);
    if (parts.length < 2) return null;

    return {
      id: id.toString(),
      subject: parts[0],
      plainText: parts[1],
      htmlContent: htmlContent || undefined,
    };
  }

  /**
   * List messages in a mailbox.
   *
   * @param mailbox - Mailbox to list from (default: INBOX)
   * @param account - Account to list from
   * @param limit - Maximum number of messages
   * @returns Array of messages
   */
  listMessages(
    mailbox?: string,
    account?: string,
    limit = 50,
    from?: string,
    offset = 0,
    unreadOnly?: boolean
  ): Message[] {
    const targetAccount = this.resolveAccount(account);
    const requestedMailbox = mailbox || "INBOX";
    const targetMailbox = this.resolveMailbox(requestedMailbox, targetAccount);

    const listConditions: string[] = [];
    if (from) {
      listConditions.push(`sender contains "${escapeForAppleScript(from)}"`);
    }
    if (unreadOnly) {
      listConditions.push(`read status is false`);
    }
    const fromFilter = listConditions.length > 0 ? `whose (${listConditions.join(" and ")})` : "";

    const listCommand = `
      set fieldSep to character id 57345
      set recSep to character id 57346
      set outputText to ""
      set theMailbox to mailbox "${escapeForAppleScript(targetMailbox)}"
      set msgCount to 0
      set skipped to 0
      repeat with msg in messages of theMailbox ${fromFilter}
        if msgCount >= ${limit} then exit repeat
        try
          if skipped < ${offset} then
            set skipped to skipped + 1
          else
            set msgId to id of msg as string
            set msgSubject to subject of msg
            set msgSender to sender of msg
            set msgDate to date received of msg as string
            set msgRead to read status of msg as string
            set msgFlagged to flagged status of msg as string
            if msgCount > 0 then set outputText to outputText & recSep
            set outputText to outputText & msgId & fieldSep & msgSubject & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & msgFlagged
            set msgCount to msgCount + 1
          end if
        end try
      end repeat
      return outputText
    `;

    const script = buildAccountScopedScript(targetAccount, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list messages: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    return this.parseMessageList(result.output, targetMailbox, targetAccount);
  }

  /**
   * Parse message list output from AppleScript.
   */
  private parseMessageList(output: string, mailbox: string, account: string): Message[] {
    const items = output.split(RECORD_SEP);
    const messages: Message[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 6) continue;

      messages.push({
        id: parts[0].trim(),
        subject: parts[1],
        sender: parts[2],
        recipients: [],
        dateReceived: parseAppleScriptDate(parts[3]),
        isRead: parts[4] === "true",
        isFlagged: parts[5] === "true",
        isJunk: false,
        isDeleted: false,
        mailbox,
        account,
        hasAttachments: false,
      });
    }

    return messages;
  }

  /**
   * Parse message list from allMailboxes search output.
   * Each record has 7 fields: id, subject, sender, date, read, flagged, mailbox
   */
  private parseMessageListAllMailboxes(output: string, account: string): Message[] {
    const items = output.split(RECORD_SEP);
    const messages: Message[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 7) continue;

      messages.push({
        id: parts[0].trim(),
        subject: parts[1],
        sender: parts[2],
        recipients: [],
        dateReceived: parseAppleScriptDate(parts[3]),
        isRead: parts[4] === "true",
        isFlagged: parts[5] === "true",
        isJunk: false,
        isDeleted: false,
        mailbox: parts[6],
        account,
        hasAttachments: false,
      });
    }

    return messages;
  }

  /**
   * Send an email.
   *
   * @param to - Recipient email addresses
   * @param subject - Email subject
   * @param body - Email body (plain text)
   * @param cc - CC recipients
   * @param bcc - BCC recipients
   * @param account - Account to send from
   * @returns true if sent successfully
   */
  sendEmail(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string,
    attachments?: string[],
    isHtml?: boolean
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScript(body);
    const contentBody = isHtml ? escapeForAppleScript(body) : safeBody;

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }
    if (cc) {
      for (const addr of cc) {
        recipientCommands += `make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }
    if (bcc) {
      for (const addr of bcc) {
        recipientCommands += `make new bcc recipient at end of bcc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }

    // Build attachment additions
    let attachmentCommands = "";
    if (attachments) {
      for (const filePath of attachments) {
        const validatedFilePath = validateSavePath(filePath); // throws on traversal
        const safePath = escapeForAppleScript(validatedFilePath);
        attachmentCommands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
      }
    }

    let sendCommand: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      sendCommand = isHtml
        ? `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", visible:true}
        tell newMessage
          make new body part at beginning of body parts with properties {content:"${contentBody}", mime type:"text/html"}
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `
        : `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `;
    } else {
      sendCommand = isHtml
        ? `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", visible:true}
        tell newMessage
          make new body part at beginning of body parts with properties {content:"${contentBody}", mime type:"text/html"}
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `
        : `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:true}
        tell newMessage
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        send newMessage
        return "sent"
      `;
    }

    const script = buildAppLevelScript(sendCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to send email: ${result.error}`);
      return false;
    }

    return result.output.includes("sent");
  }

  /**
   * Create a draft email (saved to Drafts folder, not sent).
   *
   * @param to - Recipient email addresses
   * @param subject - Email subject
   * @param body - Email body (plain text)
   * @param cc - CC recipients
   * @param bcc - BCC recipients
   * @param account - Account to create draft in
   * @returns true if draft created successfully
   */
  createDraft(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    account?: string,
    attachments?: string[],
    isHtml?: boolean
  ): boolean {
    const safeSubject = escapeForAppleScript(subject);
    const safeBody = escapeForAppleScript(body);
    const contentBody = isHtml ? escapeForAppleScript(body) : safeBody;

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }
    if (cc) {
      for (const addr of cc) {
        recipientCommands += `make new cc recipient at end of cc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }
    if (bcc) {
      for (const addr of bcc) {
        recipientCommands += `make new bcc recipient at end of bcc recipients with properties {address:"${escapeForAppleScript(addr)}"}\n`;
      }
    }

    // Build attachment additions
    let attachmentCommands = "";
    if (attachments) {
      for (const filePath of attachments) {
        const validatedFilePath = validateSavePath(filePath); // throws on traversal
        const safePath = escapeForAppleScript(validatedFilePath);
        attachmentCommands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
      }
    }

    let draftCommand: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      draftCommand = isHtml
        ? `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", visible:false}
        tell newMessage
          make new body part at beginning of body parts with properties {content:"${contentBody}", mime type:"text/html"}
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        return "draft created"
      `
        : `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          set sender to "${safeAccount}"
          ${attachmentCommands}
        end tell
        return "draft created"
      `;
    } else {
      draftCommand = isHtml
        ? `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", visible:false}
        tell newMessage
          make new body part at beginning of body parts with properties {content:"${contentBody}", mime type:"text/html"}
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        return "draft created"
      `
        : `
        set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
        tell newMessage
          ${recipientCommands}
          ${attachmentCommands}
        end tell
        return "draft created"
      `;
    }

    const script = buildAppLevelScript(draftCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to create draft: ${result.error}`);
      return false;
    }

    return result.output.includes("draft created");
  }

  /**
   * Reply to a message.
   *
   * @param id - Message ID to reply to
   * @param body - Reply body
   * @param replyAll - If true, reply to all recipients
   * @param send - If true, send immediately; if false, save as draft
   * @returns true if reply created/sent successfully
   */
  replyToMessage(id: string, body: string, replyAll = false, send = true): boolean {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return false;
    }
    const safeBody = escapeForAppleScript(body);
    const replyAllClause = replyAll ? " with reply to all" : "";
    const sendAction = send ? "send theReply" : "";

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theReply to reply msg with opening window${replyAllClause}
                set content of theReply to "${safeBody}" & return & return & content of theReply
                ${sendAction}
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

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to reply to message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Forward a message.
   *
   * @param id - Message ID to forward
   * @param to - Recipients to forward to
   * @param body - Optional body to prepend
   * @param send - If true, send immediately; if false, save as draft
   * @returns true if forward created/sent successfully
   */
  forwardMessage(id: string, to: string[], body?: string, send = true): boolean {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return false;
    }
    const safeBody = body ? escapeForAppleScript(body) : "";
    const sendAction = send ? "send theForward" : "";

    // Build recipient additions
    let recipientCommands = "";
    for (const addr of to) {
      recipientCommands += `make new to recipient at end of to recipients of theForward with properties {address:"${escapeForAppleScript(addr)}"}\n`;
    }

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set theForward to forward msg with opening window
                ${recipientCommands}
                ${safeBody ? `set content of theForward to "${safeBody}" & return & return & content of theForward` : ""}
                ${sendAction}
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

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to forward message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Helper to find and operate on a message by ID.
   */
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
                ${operation}
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

  /**
   * Mark a message as read.
   */
  markAsRead(id: string): boolean {
    const script = this.findMessageScript(id, "set read status of msg to true");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to mark message as read: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Mark a message as unread.
   */
  markAsUnread(id: string): boolean {
    const script = this.findMessageScript(id, "set read status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to mark message as unread: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Flag a message.
   */
  flagMessage(id: string): boolean {
    const script = this.findMessageScript(id, "set flagged status of msg to true");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to flag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Unflag a message.
   */
  unflagMessage(id: string): boolean {
    const script = this.findMessageScript(id, "set flagged status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to unflag message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Mark a message as junk and move it to the Junk mailbox.
   *
   * Sets `junk mail status` to true AND physically moves the message to
   * the account's Junk mailbox (resolved via MAILBOX_ALIASES["junk"]).
   * The move step is required because the AppleScript flag property alone
   * does not move the message out of INBOX.
   */
  moveToJunk(id: string): boolean {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return false;
    }
    // Step 1: set the junk flag. findMessageScript locates msg across all mailboxes.
    const flagScript = this.findMessageScript(id, "set junk mail status of msg to true");
    const flagResult = executeAppleScript(flagScript, { timeoutMs: 60000 });
    if (!flagResult.success || flagResult.output.startsWith("error:")) {
      console.error(`Failed to set junk flag: ${flagResult.error || flagResult.output}`);
      return false;
    }

    // Step 2: move to junk mailbox. resolveAccount picks the message's account
    // indirectly via moveMessage's own account resolution; "Junk" is in
    // MAILBOX_ALIASES["junk"] so resolveMailbox will match it on all account types.
    return this.moveMessage(id, "Junk");
  }

  /**
   * Clear the junk flag on a message (flag-only; does not move message to INBOX).
   *
   * After calling this, the message remains in whatever mailbox it is in.
   * Callers that want to restore the message to INBOX should also call
   * moveMessage(id, "INBOX").
   */
  markAsNotJunk(id: string): boolean {
    const script = this.findMessageScript(id, "set junk mail status of msg to false");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to clear junk flag: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Archive a message by moving it to the account's Archive mailbox.
   *
   * The Archive mailbox name is resolved through MAILBOX_ALIASES["archive"],
   * which includes "Archive", "ARCHIVE", "archive", "All Mail".
   * Note: On Gmail accounts, this may leave the "Inbox" label on the message
   * due to Gmail's IMAP label model. This is a known Gmail IMAP limitation.
   */
  archiveMessage(id: string, account?: string): boolean {
    return this.moveMessage(id, "Archive", account);
  }

  /**
   * Delete a message.
   */
  deleteMessage(id: string): boolean {
    const script = this.findMessageScript(id, "delete msg");
    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to delete message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  /**
   * Move a message to a different mailbox.
   */
  moveMessage(id: string, mailbox: string, account?: string): boolean {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return false;
    }
    const targetAccount = this.resolveAccount(account);
    const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
    const safeMailbox = escapeForAppleScript(targetMailbox);
    const safeAccount = escapeForAppleScript(targetAccount);

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set destMailbox to mailbox "${safeMailbox}" of account "${safeAccount}"
                move msg to destMailbox
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

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to move message: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Delete multiple messages at once.
   *
   * @param ids - Array of message IDs to delete
   * @returns Array of results for each message
   */
  batchDeleteMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.deleteMessage(id);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to delete message",
      });
    }

    return results;
  }

  /**
   * Move multiple messages to a mailbox at once.
   *
   * @param ids - Array of message IDs to move
   * @param mailbox - Destination mailbox name
   * @param account - Account containing the destination mailbox
   * @returns Array of results for each message
   */
  batchMoveMessages(ids: string[], mailbox: string, account?: string): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];

    for (const id of ids) {
      const success = this.moveMessage(id, mailbox, account);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to move message",
      });
    }

    return results;
  }

  /**
   * Archive multiple messages at once.
   *
   * @param ids - Array of message IDs to archive
   * @param account - Account containing the Archive mailbox
   * @returns Array of results for each message
   */
  batchArchiveMessages(ids: string[], account?: string): BatchOperationResult[] {
    return this.batchMoveMessages(ids, "Archive", account);
  }

  /**
   * Retrieve all messages in a thread by subject matching.
   *
   * Apple Mail's AppleScript API has no native thread/conversation object.
   * This implementation finds the seed message's subject, normalizes it
   * (strips Re:/Fwd: prefixes), then searches all mailboxes in all accounts
   * for messages whose subject contains the base subject string.
   *
   * Results are sorted by dateReceived ascending.
   *
   * Limitations:
   * - Very short base subjects (< 10 chars) may return unrelated messages.
   *   getThread returns [] and logs a warning in that case.
   * - Generic subjects ("Hello") may still produce false positives.
   * - Gmail Archive label duplication does not affect this operation.
   *
   * @param id - ID of any message in the thread (the seed message)
   * @param account - Optional: limit search to this account for performance
   * @returns Thread messages ordered by dateReceived ascending, or [] on failure
   */
  getThread(id: string, account?: string): ThreadMessage[] {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return [];
    }

    // Step 1: Fetch seed message to get subject
    const seed = this.getMessageById(id);
    if (!seed) {
      console.error(`Thread seed message not found: ${id}`);
      return [];
    }

    const baseSubject = normalizeSubject(seed.subject);

    // Guard: subject too short → high false-positive risk
    if (baseSubject.length < 10) {
      console.warn(
        `getThread: base subject "${baseSubject}" is shorter than 10 characters — search skipped to avoid false positives`
      );
      return [];
    }

    const safeSubject = escapeForAppleScript(baseSubject);

    // Step 2: Build search script. If account is provided, limit to that account.
    // Otherwise iterate all accounts.
    let searchBody: string;
    if (account) {
      const safeAccount = escapeForAppleScript(account);
      searchBody = `
        set targetAcct to account "${safeAccount}"
        repeat with mb in mailboxes of targetAcct
          try
            set matches to (messages of mb whose subject contains "${safeSubject}")
            repeat with msg in matches
              set msgId to id of msg as string
              set msgSubj to subject of msg
              set msgSender to sender of msg
              set msgDate to date received of msg as string
              set msgRead to read status of msg as string
              set mbName to name of mb
              set acctName to name of targetAcct
              if msgCount > 0 then set outputText to outputText & recSep
              set outputText to outputText & msgId & fieldSep & msgSubj & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & mbName & fieldSep & acctName
              set msgCount to msgCount + 1
            end repeat
          end try
        end repeat
      `;
    } else {
      searchBody = `
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matches to (messages of mb whose subject contains "${safeSubject}")
              repeat with msg in matches
                set msgId to id of msg as string
                set msgSubj to subject of msg
                set msgSender to sender of msg
                set msgDate to date received of msg as string
                set msgRead to read status of msg as string
                set mbName to name of mb
                set acctName to name of acct
                if msgCount > 0 then set outputText to outputText & recSep
                set outputText to outputText & msgId & fieldSep & msgSubj & fieldSep & msgSender & fieldSep & msgDate & fieldSep & msgRead & fieldSep & mbName & fieldSep & acctName
                set msgCount to msgCount + 1
              end repeat
            end try
          end repeat
        end repeat
      `;
    }

    const script = buildAppLevelScript(`
      set fieldSep to character id 57345
      set recSep to character id 57346
      set outputText to ""
      set msgCount to 0
      ${searchBody}
      return outputText
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      return [];
    }

    // Parse the 7-field records produced by parseMessageListAllMailboxes format
    // (id, subject, sender, dateReceived, isRead, mailbox, account)
    const items = result.output.split(RECORD_SEP);
    const messages: ThreadMessage[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 7) continue;
      messages.push({
        id: parts[0].trim(),
        subject: parts[1],
        sender: parts[2],
        dateReceived: parseAppleScriptDate(parts[3]),
        isRead: parts[4] === "true",
        mailbox: parts[5],
        account: parts[6],
      });
    }

    // Sort by dateReceived ascending (oldest first)
    messages.sort((a, b) => a.dateReceived.getTime() - b.dateReceived.getTime());

    // Deduplicate by id (same message may appear in multiple mailboxes, e.g. Sent + INBOX for iCloud)
    const seen = new Set<string>();
    return messages.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  /**
   * Retrieve messages from VIP senders configured in Mail.app.
   *
   * Apple Mail's AppleScript API does not expose VIP status as a message
   * property or mailbox. VIP senders are stored in a plist file at
   * ~/Library/Mail/V{version}/VIP.plist. This method:
   *  1. Discovers the plist via `find ~/Library/Mail -name "VIP.plist" -maxdepth 3`
   *  2. Converts it to JSON via `plutil -convert json -o -`
   *  3. Extracts sender email addresses from EmailAddresses array
   *  4. Searches INBOX for each VIP sender and merges results
   *
   * If no VIP.plist is found (no VIPs configured in Mail.app), returns
   * an empty message list with an explanatory error string.
   *
   * @param limit - Max messages per VIP sender (default 50)
   * @returns Object with messages array, vipSenders array, and optional error
   */
  getVipMessages(limit = 50): { messages: Message[]; vipSenders: string[]; error?: string } {
    // Step 1: Discover VIP.plist path (macOS version-agnostic)
    let plistPath: string;
    try {
      const findOutput = execSync("find ~/Library/Mail -name 'VIP.plist' -maxdepth 3 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      if (!findOutput) {
        return {
          messages: [],
          vipSenders: [],
          error:
            "No VIP senders found. Configure VIP senders in Mail.app (Mailbox > Add VIP) first.",
        };
      }
      // Use the first result if multiple are found
      plistPath = findOutput.split("\n")[0].trim();
    } catch {
      return {
        messages: [],
        vipSenders: [],
        error: "Failed to locate VIP.plist. Ensure Mail.app is configured.",
      };
    }

    // Step 2: Parse VIP plist as JSON via plutil (built-in macOS tool)
    let vipSenders: string[] = [];
    try {
      const jsonOutput = execSync(`plutil -convert json -o - "${plistPath}"`, {
        encoding: "utf8",
        timeout: 5000,
      });
      const parsed = JSON.parse(jsonOutput) as Record<string, unknown>;
      // VIP.plist structure: { EmailAddresses: ["addr1@example.com", ...] }
      if (Array.isArray(parsed["EmailAddresses"])) {
        vipSenders = (parsed["EmailAddresses"] as unknown[])
          .filter((e): e is string => typeof e === "string" && e.includes("@"))
          .map((e) => e.toLowerCase());
      }
    } catch {
      return {
        messages: [],
        vipSenders: [],
        error: "Failed to parse VIP.plist. The file may be malformed.",
      };
    }

    if (vipSenders.length === 0) {
      return {
        messages: [],
        vipSenders: [],
        error: "VIP.plist found but contains no email addresses.",
      };
    }

    // Step 3: Search INBOX for each VIP sender, merge and deduplicate
    const seen = new Set<string>();
    const allMessages: Message[] = [];

    for (const sender of vipSenders) {
      const results = this.searchMessages(
        undefined,
        "INBOX",
        undefined,
        limit,
        undefined,
        undefined,
        sender
      );
      for (const msg of results) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          allMessages.push(msg);
        }
      }
    }

    // Sort by dateReceived descending (newest first)
    allMessages.sort((a, b) => b.dateReceived.getTime() - a.dateReceived.getTime());

    return { messages: allMessages, vipSenders };
  }

  /**
   * Mark multiple messages as read at once.
   */
  batchMarkAsRead(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.markAsRead(id);
      results.push({ id, success, error: success ? undefined : "Failed to mark message as read" });
    }
    return results;
  }

  /**
   * Mark multiple messages as unread at once.
   */
  batchMarkAsUnread(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.markAsUnread(id);
      results.push({
        id,
        success,
        error: success ? undefined : "Failed to mark message as unread",
      });
    }
    return results;
  }

  /**
   * Flag multiple messages at once.
   */
  batchFlagMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.flagMessage(id);
      results.push({ id, success, error: success ? undefined : "Failed to flag message" });
    }
    return results;
  }

  /**
   * Unflag multiple messages at once.
   */
  batchUnflagMessages(ids: string[]): BatchOperationResult[] {
    const results: BatchOperationResult[] = [];
    for (const id of ids) {
      const success = this.unflagMessage(id);
      results.push({ id, success, error: success ? undefined : "Failed to unflag message" });
    }
    return results;
  }

  /**
   * List attachments for a message.
   */
  listAttachments(id: string): Attachment[] {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return [];
    }
    const script = buildAppLevelScript(`
      try
        set fieldSep to character id 57345
        set recSep to character id 57346
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                set msg to item 1 of matchingMsgs
                set outputText to ""
                set attCount to 0
                repeat with att in mail attachments of msg
                  set attName to name of att
                  set attType to MIME type of att
                  set attSize to file size of att as string
                  if attCount > 0 then set outputText to outputText & recSep
                  set outputText to outputText & attName & fieldSep & attType & fieldSep & attSize
                  set attCount to attCount + 1
                end repeat
                return outputText
              end if
            end try
          end repeat
        end repeat
        return ""
      on error errMsg
        return ""
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split(RECORD_SEP);
    const attachments: Attachment[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 3) continue;

      attachments.push({
        id: `${id}-${parts[0]}`,
        name: parts[0],
        mimeType: parts[1],
        size: parseInt(parts[2]) || 0,
      });
    }

    return attachments;
  }

  /**
   * Save an attachment from a message to disk.
   */
  saveAttachment(
    id: string,
    attachmentName: string,
    savePath: string,
    attachmentIndex?: number
  ): boolean {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return false;
    }
    const validatedPath = validateSavePath(savePath); // throws on bad path
    const safeName = escapeForAppleScript(attachmentName);
    const safePath = escapeForAppleScript(validatedPath);

    const attachmentAccess =
      attachmentIndex !== undefined
        ? `
                set msg to item 1 of matchingMsgs
                set attCount to count of mail attachments of msg
                if ${attachmentIndex} > attCount then
                  return "error:Attachment index ${attachmentIndex} out of range (message has " & attCount & " attachment(s))"
                end if
                set att to mail attachment ${attachmentIndex} of msg
                set attName to name of att
                set attSavePath to POSIX file "${safePath}/" & attName
                save att in attSavePath
                return "ok"
        `
        : `
                set msg to item 1 of matchingMsgs
                repeat with att in mail attachments of msg
                  if name of att is "${safeName}" then
                    set attSavePath to POSIX file "${safePath}/${safeName}"
                    save att in attSavePath
                    return "ok"
                  end if
                end repeat
                return "error:Attachment not found"
        `;

    const script = buildAppLevelScript(`
      try
        repeat with acct in accounts
          repeat with mb in mailboxes of acct
            try
              set matchingMsgs to (messages of mb whose id is ${id})
              if (count of matchingMsgs) > 0 then
                ${attachmentAccess}
              end if
            end try
          end repeat
        end repeat
        return "error:Message not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to save attachment: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Mailbox Operations
  // ===========================================================================

  /**
   * List all mailboxes for an account.
   */
  listMailboxes(account?: string): Mailbox[] {
    const targetAccount = this.resolveAccount(account);

    const listCommand = `
      set mailboxList to {}
      repeat with mb in mailboxes
        set mbName to name of mb
        set mbUnread to unread count of mb
        set mbCount to count of messages of mb
        set end of mailboxList to mbName & (character id 57345) & mbUnread & (character id 57345) & mbCount
      end repeat
      set AppleScript's text item delimiters to (character id 57346)
      return mailboxList as text
    `;

    const script = buildAccountScopedScript(targetAccount, listCommand);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list mailboxes: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    const items = result.output.split(RECORD_SEP);
    const mailboxes: Mailbox[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 3) continue;

      mailboxes.push({
        name: parts[0],
        account: targetAccount,
        unreadCount: parseInt(parts[1]) || 0,
        messageCount: parseInt(parts[2]) || 0,
      });
    }

    return mailboxes;
  }

  /**
   * Get unread count for a mailbox.
   */
  getUnreadCount(mailbox?: string, account?: string): number {
    const targetAccount = this.resolveAccount(account);

    let command: string;
    if (mailbox) {
      const targetMailbox = this.resolveMailbox(mailbox, targetAccount);
      const safeMailbox = escapeForAppleScript(targetMailbox);
      command = `return unread count of mailbox "${safeMailbox}"`;
    } else {
      // Get total unread across all mailboxes
      command = `
        set total to 0
        repeat with mb in mailboxes
          set total to total + (unread count of mb)
        end repeat
        return total
      `;
    }

    const script = buildAccountScopedScript(targetAccount, command);
    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to get unread count: ${result.error}`);
      return 0;
    }

    return parseInt(result.output) || 0;
  }

  /**
   * Create a new mailbox.
   */
  createMailbox(name: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const safeName = escapeForAppleScript(name);
    const safeAccount = escapeForAppleScript(targetAccount);

    const script = buildAppLevelScript(`
      try
        make new mailbox with properties {name:"${safeName}"} at account "${safeAccount}"
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to create mailbox: ${result.error || result.output}`);
      return false;
    }

    this.invalidateCache();
    return true;
  }

  /**
   * Delete a mailbox.
   */
  deleteMailbox(name: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);
    const targetMailbox = this.resolveMailbox(name, targetAccount);
    const safeName = escapeForAppleScript(targetMailbox);
    const safeAccount = escapeForAppleScript(targetAccount);

    const script = buildAppLevelScript(`
      try
        delete mailbox "${safeName}" of account "${safeAccount}"
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to delete mailbox: ${result.error || result.output}`);
      return false;
    }

    this.invalidateCache();
    return true;
  }

  /**
   * Rename a mailbox by creating a new one, moving messages, and deleting the old one.
   */
  renameMailbox(oldName: string, newName: string, account?: string): boolean {
    const targetAccount = this.resolveAccount(account);

    // Create the new mailbox
    if (!this.createMailbox(newName, targetAccount)) {
      return false;
    }

    // Move all messages from old to new
    const resolvedOld = this.resolveMailbox(oldName, targetAccount);
    const resolvedNew = this.resolveMailbox(newName, targetAccount);
    const safeOld = escapeForAppleScript(resolvedOld);
    const safeNew = escapeForAppleScript(resolvedNew);
    const safeAccount = escapeForAppleScript(targetAccount);

    const moveScript = buildAppLevelScript(`
      try
        set srcMailbox to mailbox "${safeOld}" of account "${safeAccount}"
        set destMailbox to mailbox "${safeNew}" of account "${safeAccount}"
        repeat with msg in messages of srcMailbox
          move msg to destMailbox
        end repeat
        delete mailbox "${safeOld}" of account "${safeAccount}"
        return "ok"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(moveScript, { timeoutMs: 60000 });

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to rename mailbox: ${result.error || result.output}`);
      // ROLLBACK: Delete the new mailbox we just created to restore original state.
      // Note: If the move loop ran partially before failing, some messages may exist
      // in both mailboxes at this point. We delete the new mailbox only; the old
      // mailbox retains its full original set. This is strictly better than leaving
      // an empty new mailbox orphaned.
      this.deleteMailbox(newName, targetAccount);
      return false;
    }

    this.invalidateCache();
    return true;
  }

  // ===========================================================================
  // Account Operations
  // ===========================================================================

  /**
   * List all mail accounts (uses cache).
   */
  listAccounts(): Account[] {
    return this.getCachedAccounts();
  }

  /**
   * Fetches account list directly from Mail.app via AppleScript.
   * Used internally by the cache; prefer getCachedAccounts() or listAccounts().
   */
  private fetchAccounts(): Account[] {
    const script = buildAppLevelScript(`
      set accountList to {}
      repeat with acct in accounts
        set acctName to name of acct
        set acctEmail to email addresses of acct
        set acctEnabled to enabled of acct
        set emailStr to ""
        if (count of acctEmail) > 0 then
          set emailStr to item 1 of acctEmail
        end if
        set end of accountList to acctName & (character id 57345) & emailStr & (character id 57345) & acctEnabled
      end repeat
      set AppleScript's text item delimiters to (character id 57346)
      return accountList as text
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      console.error(`Failed to list accounts: ${result.error}`);
      return [];
    }

    if (!result.output.trim()) return [];

    const items = result.output.split(RECORD_SEP);
    const accounts: Account[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 3) continue;

      accounts.push({
        name: parts[0],
        email: parts[1],
        enabled: parts[2] === "true",
      });
    }

    return accounts;
  }

  /**
   * Fetches mailbox names for an account directly from Mail.app.
   * Used internally by the cache; prefer getCachedMailboxNames().
   */
  private fetchMailboxNames(account: string): string[] {
    const script = buildAccountScopedScript(
      account,
      `
      set mbNames to {}
      repeat with mb in mailboxes
        set end of mbNames to name of mb
      end repeat
      return mbNames
    `
    );

    const result = executeAppleScript(script);
    if (!result.success || !result.output) {
      return [];
    }

    return result.output.split(", ").map((s) => s.trim());
  }

  // ===========================================================================
  // Mail Rules
  // ===========================================================================

  /**
   * List all mail rules.
   */
  listRules(): MailRule[] {
    const script = buildAppLevelScript(`
      set ruleList to {}
      repeat with r in rules
        set ruleName to name of r
        set ruleEnabled to enabled of r
        set end of ruleList to ruleName & (character id 57345) & (ruleEnabled as string)
      end repeat
      set AppleScript's text item delimiters to (character id 57346)
      return ruleList as text
    `);

    const result = executeAppleScript(script);

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split(RECORD_SEP);
    const rules: MailRule[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 2) continue;
      rules.push({
        name: parts[0],
        enabled: parts[1] === "true",
      });
    }

    return rules;
  }

  /**
   * Enable or disable a mail rule.
   */
  setRuleEnabled(ruleName: string, enabled: boolean): boolean {
    const safeName = escapeForAppleScript(ruleName);

    const script = buildAppLevelScript(`
      try
        repeat with r in rules
          if name of r is "${safeName}" then
            set enabled of r to ${enabled}
            return "ok"
          end if
        end repeat
        return "error:Rule not found"
      on error errMsg
        return "error:" & errMsg
      end try
    `);

    const result = executeAppleScript(script);

    if (!result.success || result.output.startsWith("error:")) {
      console.error(`Failed to set rule state: ${result.error || result.output}`);
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Contacts Integration
  // ===========================================================================

  /**
   * Search contacts by name or email.
   */
  searchContacts(query: string): Contact[] {
    const safeQuery = escapeForAppleScript(query);

    const script = `
      tell application "Contacts"
        set matchedContacts to {}
        set foundPeople to (every person whose name contains "${safeQuery}") & (every person whose value of emails contains "${safeQuery}")

        -- Deduplicate by tracking IDs
        set seenIds to {}
        repeat with p in foundPeople
          set pid to id of p
          if seenIds does not contain pid then
            set end of seenIds to pid
            set pName to name of p
            set pEmails to ""
            repeat with e in emails of p
              if pEmails is not "" then set pEmails to pEmails & ","
              set pEmails to pEmails & (value of e)
            end repeat
            set pPhones to ""
            repeat with ph in phones of p
              if pPhones is not "" then set pPhones to pPhones & ","
              set pPhones to pPhones & (value of ph)
            end repeat
            set end of matchedContacts to pName & (character id 57345) & pEmails & (character id 57345) & pPhones
          end if
        end repeat

        set AppleScript's text item delimiters to (character id 57346)
        return matchedContacts as text
      end tell
    `;

    const result = executeAppleScript(script);

    if (!result.success || !result.output.trim()) {
      return [];
    }

    const items = result.output.split(RECORD_SEP);
    const contacts: Contact[] = [];

    for (const item of items) {
      const parts = item.split(FIELD_SEP);
      if (parts.length < 3) continue;
      contacts.push({
        name: parts[0],
        emails: parts[1] ? parts[1].split(",").filter(Boolean) : [],
        phones: parts[2] ? parts[2].split(",").filter(Boolean) : [],
      });
    }

    return contacts;
  }

  // ===========================================================================
  // Email Templates
  // ===========================================================================

  private templates: Map<string, EmailTemplate> = new Map();
  private nextTemplateId = 1;

  /**
   * List all stored templates.
   */
  listTemplates(): EmailTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get a template by ID.
   */
  getTemplate(id: string): EmailTemplate | null {
    return this.templates.get(id) || null;
  }

  /**
   * Create or update a template.
   */
  saveTemplate(
    name: string,
    subject: string,
    body: string,
    to?: string[],
    cc?: string[],
    id?: string
  ): EmailTemplate {
    const templateId = id || `tmpl_${this.nextTemplateId++}`;
    const template: EmailTemplate = { id: templateId, name, subject, body, to, cc };
    this.templates.set(templateId, template);
    this.persistTemplates();
    return template;
  }

  /**
   * Delete a template.
   */
  deleteTemplate(id: string): boolean {
    const deleted = this.templates.delete(id);
    if (deleted) this.persistTemplates();
    return deleted;
  }

  /**
   * Load templates from disk. Called in constructor.
   */
  private loadTemplates(): void {
    try {
      if (!existsSync(this.TEMPLATE_FILE)) return;
      const raw = readFileSync(this.TEMPLATE_FILE, "utf8");
      const data = JSON.parse(raw) as {
        nextId: number;
        templates: Record<string, EmailTemplate>;
      };
      this.templates = new Map(Object.entries(data.templates));
      this.nextTemplateId = data.nextId;
    } catch (err) {
      // Corrupt or unreadable — start fresh, do not crash
      console.error(`[apple-mail-mcp] Failed to load templates: ${err}`);
    }
  }

  /**
   * Persist templates to disk.
   */
  private persistTemplates(): void {
    try {
      const dir = join(homedir(), ".config", "apple-mail-mcp");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = {
        nextId: this.nextTemplateId,
        templates: Object.fromEntries(this.templates),
      };
      writeFileSync(this.TEMPLATE_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error(`[apple-mail-mcp] Failed to persist templates: ${err}`);
    }
  }

  /**
   * Use a template to create a draft.
   */
  useTemplate(
    id: string,
    overrides?: { to?: string[]; cc?: string[]; subject?: string; body?: string }
  ): boolean {
    const template = this.templates.get(id);
    if (!template) return false;

    const to = overrides?.to || template.to || [];
    const cc = overrides?.cc || template.cc;
    const subject = overrides?.subject || template.subject;
    const body = overrides?.body || template.body;

    if (to.length === 0) return false;

    return this.createDraft(to, subject, body, cc);
  }

  // ===========================================================================
  // Diagnostics
  // ===========================================================================

  /**
   * Run health check on Mail.app connectivity.
   */
  healthCheck(): HealthCheckResult {
    const checks: HealthCheckResult["checks"] = [];

    // Check 1: Mail.app is accessible
    const mailCheck = executeAppleScript('tell application "Mail" to return "ok"');
    if (mailCheck.success && mailCheck.output === "ok") {
      checks.push({
        name: "mail_app",
        passed: true,
        message: "Mail.app is accessible",
      });
    } else {
      const errorHint = mailCheck.error?.includes("not authorized")
        ? " (check Automation permissions in System Preferences)"
        : "";
      checks.push({
        name: "mail_app",
        passed: false,
        message: `Mail.app is not accessible${errorHint}`,
      });
      return { healthy: false, checks };
    }

    // Check 2: AppleScript permissions
    const permCheck = executeAppleScript('tell application "Mail" to get name of account 1');
    if (permCheck.success) {
      checks.push({
        name: "permissions",
        passed: true,
        message: "AppleScript automation permissions granted",
      });
    } else {
      const isPermError =
        permCheck.error?.includes("not authorized") || permCheck.error?.includes("not permitted");
      checks.push({
        name: "permissions",
        passed: !isPermError,
        message: isPermError
          ? "AppleScript permissions denied. Grant access in System Preferences > Privacy & Security > Automation"
          : `Permission check returned: ${permCheck.error}`,
      });
      if (isPermError) {
        return { healthy: false, checks };
      }
    }

    // Check 3: At least one account accessible
    const accounts = this.listAccounts();
    if (accounts.length > 0) {
      const accountNames = accounts.map((a) => a.name).join(", ");
      checks.push({
        name: "accounts",
        passed: true,
        message: `Found ${accounts.length} account(s): ${accountNames}`,
      });
    } else {
      checks.push({
        name: "accounts",
        passed: false,
        message: "No Mail accounts found. Set up an account in Mail.app first.",
      });
      return { healthy: false, checks };
    }

    // Check 4: Basic operations work
    const mailboxes = this.listMailboxes(accounts[0].name);
    checks.push({
      name: "operations",
      passed: true,
      message: `Basic operations working (${mailboxes.length} mailbox(es) in ${accounts[0].name})`,
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Get mail statistics.
   */
  getMailStats(): MailStats {
    const accounts = this.listAccounts();
    const accountStats: AccountStats[] = [];
    let totalMessages = 0;
    let totalUnread = 0;

    for (const account of accounts) {
      const mailboxes = this.listMailboxes(account.name);
      let accountMessages = 0;
      let accountUnread = 0;

      const mailboxStats = mailboxes.map((mb) => {
        accountMessages += mb.messageCount;
        accountUnread += mb.unreadCount;
        return {
          name: mb.name,
          messageCount: mb.messageCount,
          unreadCount: mb.unreadCount,
        };
      });

      totalMessages += accountMessages;
      totalUnread += accountUnread;

      accountStats.push({
        name: account.name,
        totalMessages: accountMessages,
        unreadMessages: accountUnread,
        mailboxCount: mailboxes.length,
        mailboxes: mailboxStats,
      });
    }

    // Get recently received stats
    const recentlyReceived = this.getRecentlyReceivedStats();

    return {
      totalMessages,
      totalUnread,
      accounts: accountStats,
      recentlyReceived,
    };
  }

  /**
   * Get counts of recently received messages.
   *
   * Only counts messages in INBOX for performance (scanning all mailboxes
   * is too slow for large accounts).
   *
   * @returns Counts of messages received in last 24h, 7d, and 30d
   */
  getRecentlyReceivedStats(): RecentlyReceivedStats {
    // Get message counts for different time periods
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Format dates for AppleScript comparison
    const formatDate = (d: Date): string => {
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      return `date "${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}"`;
    };

    // Only scan INBOX for performance - scanning all mailboxes is too slow
    const script = buildAppLevelScript(`
      set last24h to 0
      set last7d to 0
      set last30d to 0
      set oneDayAgo to ${formatDate(oneDayAgo)}
      set sevenDaysAgo to ${formatDate(sevenDaysAgo)}
      set thirtyDaysAgo to ${formatDate(thirtyDaysAgo)}

      repeat with acct in accounts
        try
          -- Try common inbox names
          set inboxNames to {"INBOX", "Inbox", "inbox"}
          repeat with inboxName in inboxNames
            try
              set theInbox to mailbox inboxName of acct
              set last24h to last24h + (count of (messages of theInbox whose date received >= oneDayAgo))
              set last7d to last7d + (count of (messages of theInbox whose date received >= sevenDaysAgo))
              set last30d to last30d + (count of (messages of theInbox whose date received >= thirtyDaysAgo))
              exit repeat
            end try
          end repeat
        end try
      end repeat

      return (last24h as string) & (character id 57345) & (last7d as string) & (character id 57345) & (last30d as string)
    `);

    const result = executeAppleScript(script, { timeoutMs: 60000 });

    if (!result.success || !result.output.trim()) {
      console.error(`Failed to get recently received stats: ${result.error}`);
      return { last24h: 0, last7d: 0, last30d: 0 };
    }

    const parts = result.output.split(FIELD_SEP);
    if (parts.length < 3) {
      return { last24h: 0, last7d: 0, last30d: 0 };
    }

    return {
      last24h: parseInt(parts[0]) || 0,
      last7d: parseInt(parts[1]) || 0,
      last30d: parseInt(parts[2]) || 0,
    };
  }

  /**
   * Check whether Mail.app is running and how many accounts are loaded.
   *
   * Note: Apple Mail's AppleScript API does not expose IMAP sync state,
   * pending upload counts, or last-sync timestamps. This method reports
   * only what is directly observable.
   */
  getSyncStatus(): SyncStatus {
    const script = buildAppLevelScript(`
      set accountCount to count of accounts
      return "running" & (character id 57345) & accountCount
    `);

    const result = executeAppleScript(script);

    if (!result.success) {
      return {
        running: false,
        accountCount: 0,
        error: result.error ?? "AppleScript execution failed",
      };
    }

    // Mail.app not running: osascript returns an error, caught above.
    // If we reach here, Mail.app responded — it is running.
    const parts = result.output.split(FIELD_SEP);
    const accountCount = parseInt(parts[1]) || 0;

    return {
      running: true,
      accountCount,
    };
  }

  // ===========================================================================
  // Phase 4: Intelligence Layer
  // ===========================================================================

  getTriageMessages(
    mailbox = "INBOX",
    limit = 20,
    includeSnippets = true,
    account?: string
  ): TriageMessage[] {
    const messages = this.listMessages(mailbox, account, limit, undefined, 0, true);
    return messages.map((msg) => {
      const entry: TriageMessage = {
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        dateReceived: msg.dateReceived,
        isRead: msg.isRead,
        isFlagged: msg.isFlagged,
        hasAttachments: msg.hasAttachments,
        mailbox: msg.mailbox,
        account: msg.account,
      };
      if (includeSnippets) {
        const content = this.getMessageContent(msg.id);
        if (content) {
          entry.snippet = content.plainText.slice(0, 200).replace(/\n+/g, " ").trim();
        }
      }
      return entry;
    });
  }

  getSummarizeInboxData(
    mailbox = "INBOX",
    limit = 30,
    account?: string
  ): { totalUnread: number; messages: Message[] } {
    const totalUnread = this.getUnreadCount(mailbox, account);
    const messages = this.listMessages(mailbox, account, limit, undefined, 0, true);
    return { totalUnread, messages };
  }

  getActionItems(
    id?: string,
    mailbox = "INBOX",
    limit = 10,
    account?: string
  ): ActionItemsResult[] {
    if (id) {
      if (!/^\d+$/.test(id)) {
        console.error(`Invalid message ID: "${id}"`);
        return [];
      }
      const msg = this.getMessageById(id);
      if (!msg) return [];
      const content = this.getMessageContent(id);
      if (!content) return [];
      return [
        {
          id: msg.id,
          subject: msg.subject,
          sender: msg.sender,
          dateReceived: msg.dateReceived,
          plainText: content.plainText,
        },
      ];
    }
    const messages = this.listMessages(mailbox, account, limit);
    const results: ActionItemsResult[] = [];
    for (const msg of messages) {
      const content = this.getMessageContent(msg.id);
      if (content) {
        results.push({
          id: msg.id,
          subject: msg.subject,
          sender: msg.sender,
          dateReceived: msg.dateReceived,
          plainText: content.plainText,
        });
      }
    }
    return results;
  }

  getUnsubscribeLinks(id: string): {
    isLikelyNewsletter: boolean;
    newsletterSignals: string[];
    unsubscribeLinks: string[];
  } {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return { isLikelyNewsletter: false, newsletterSignals: [], unsubscribeLinks: [] };
    }
    const content = this.getMessageContent(id);
    if (!content) {
      return { isLikelyNewsletter: false, newsletterSignals: [], unsubscribeLinks: [] };
    }

    const html = content.htmlContent ?? "";
    const links: string[] = [];

    // Pass 1: links where anchor text contains unsubscribe/optout/opt-out/remove
    const textPattern =
      /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:unsubscribe|opt.out|remove)[^<]*<\/a>/gi;
    // Pass 2: links where href itself contains those keywords
    const hrefPattern = /href=["']([^"']*(?:unsubscribe|optout|opt-out|remove)[^"']*)/gi;

    let match: RegExpExecArray | null;
    while ((match = textPattern.exec(html)) !== null) {
      if (!links.includes(match[1])) links.push(match[1]);
    }
    while ((match = hrefPattern.exec(html)) !== null) {
      if (!links.includes(match[1])) links.push(match[1]);
    }

    // Newsletter heuristics
    const signals: string[] = [];
    const msg = this.getMessageById(id);
    if (msg) {
      const lcSender = msg.sender.toLowerCase();
      const lcSubject = msg.subject.toLowerCase();
      if (
        /mailchimp|substack|constantcontact|campaignmonitor|sendgrid|klaviyo|hubspot/.test(lcSender)
      ) {
        signals.push("Known newsletter sender domain");
      }
      if (/list-unsubscribe/i.test(html)) {
        signals.push("Contains List-Unsubscribe header in source");
      }
      if (/weekly|digest|newsletter|update|bulletin/i.test(lcSubject)) {
        signals.push("Subject contains newsletter keywords");
      }
      if (links.length > 0) {
        signals.push("Unsubscribe link found in HTML");
      }
    }

    return {
      isLikelyNewsletter: signals.length >= 2,
      newsletterSignals: signals,
      unsubscribeLinks: links,
    };
  }

  getDraftReplyContext(
    id: string,
    draftBody?: string,
    maxMessages = 5,
    bodyTruncate = 500,
    account?: string
  ): { context: string; draftCreated?: boolean } {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return { context: "Error: Invalid message ID." };
    }

    const seed = this.getMessageById(id);
    if (!seed) {
      return { context: "Error: Message not found." };
    }

    const thread = this.getThread(id, account);
    const relevant = thread.length > 0 ? thread.slice(-maxMessages) : [];

    const lines: string[] = [];
    lines.push(`Thread context for reply (${relevant.length} message(s)):`);
    lines.push("");

    if (relevant.length === 0) {
      // Fallback: show seed message only
      const content = this.getMessageContent(id);
      lines.push(
        `[Message] From: ${seed.sender} | ${seed.dateReceived.toISOString().slice(0, 10)}`
      );
      lines.push(`Subject: ${seed.subject}`);
      lines.push("---");
      lines.push(content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)");
    } else {
      for (let i = 0; i < relevant.length; i++) {
        const tm = relevant[i];
        const label = i === 0 ? "Original" : `Message ${i + 1}`;
        const content = this.getMessageContent(tm.id);
        lines.push(`[${label}] From: ${tm.sender} | ${tm.dateReceived.toISOString().slice(0, 10)}`);
        lines.push(`Subject: ${tm.subject}`);
        lines.push("---");
        lines.push(content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)");
        lines.push("");
      }
    }

    let draftCreated: boolean | undefined;
    if (draftBody !== undefined && seed.recipients.length > 0) {
      const replyTo = seed.replyTo ?? seed.sender;
      draftCreated = this.createDraft(
        [replyTo],
        `Re: ${normalizeSubject(seed.subject)}`,
        draftBody
      );
    }

    return { context: lines.join("\n"), draftCreated };
  }

  getThreadSummaryData(
    id: string,
    maxMessages = 20,
    bodyTruncate = 1000,
    account?: string
  ): string {
    if (!/^\d+$/.test(id)) {
      console.error(`Invalid message ID: "${id}"`);
      return "Error: Invalid message ID.";
    }

    const thread = this.getThread(id, account);
    if (thread.length === 0) {
      const seed = this.getMessageById(id);
      if (!seed) return "Error: Message not found.";
      const content = this.getMessageContent(id);
      return [
        `Thread data (1 message — subject too short for thread search or no thread found):`,
        "",
        `[Message] From: ${seed.sender} | ${seed.dateReceived.toISOString().slice(0, 10)}`,
        `Subject: ${seed.subject}`,
        "---",
        content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)",
      ].join("\n");
    }

    const relevant = thread.slice(-maxMessages);
    const lines: string[] = [`Thread data (${relevant.length} message(s)):`, ""];

    for (let i = 0; i < relevant.length; i++) {
      const tm = relevant[i];
      const content = this.getMessageContent(tm.id);
      lines.push(`[${i + 1}] From: ${tm.sender} | ${tm.dateReceived.toISOString().slice(0, 10)}`);
      lines.push(`Subject: ${tm.subject}`);
      lines.push("---");
      lines.push(content ? content.plainText.slice(0, bodyTruncate) : "(body unavailable)");
      lines.push("");
    }

    return lines.join("\n");
  }

  getWaitingFor(limit = 20, daysAgo = 2, account?: string): WaitingForItem[] {
    // Build set of user's own email addresses
    const accounts = this.listAccounts();
    const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

    // Fetch recent sent messages
    const sentMessages = this.searchMessages(
      undefined,
      "Sent",
      account,
      limit + 20, // fetch extra to account for daysAgo filtering
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      0
    );

    const now = new Date();
    const thresholdMs = daysAgo * 24 * 60 * 60 * 1000;

    const waiting: WaitingForItem[] = [];

    for (const msg of sentMessages) {
      if (waiting.length >= limit) break;

      // Only consider messages older than daysAgo threshold
      const age = now.getTime() - msg.dateReceived.getTime();
      if (age < thresholdMs) continue;

      // Check for replies via thread
      const thread = this.getThread(msg.id, account);
      const hasReply = thread.some(
        (tm) =>
          !userEmails.has(tm.sender.toLowerCase()) &&
          tm.dateReceived.getTime() > msg.dateReceived.getTime()
      );

      if (!hasReply) {
        waiting.push({
          id: msg.id,
          subject: msg.subject,
          sender: msg.sender,
          recipients: msg.recipients,
          dateSent: msg.dateReceived, // dateReceived on sent messages = when sent
          daysWaiting: Math.floor(age / (24 * 60 * 60 * 1000)),
          hasReply: false,
        });
      }
    }

    // Sort oldest first (most overdue)
    waiting.sort((a, b) => a.dateSent.getTime() - b.dateSent.getTime());
    return waiting;
  }
}
