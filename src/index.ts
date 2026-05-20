#!/usr/bin/env node
/**
 * Apple Mail MCP Server
 *
 * A Model Context Protocol (MCP) server that provides AI assistants
 * with the ability to interact with Apple Mail on macOS.
 *
 * This server exposes tools for:
 * - Reading and searching emails
 * - Sending emails
 * - Managing mailboxes
 * - Managing multiple accounts (iCloud, Gmail, Exchange, etc.)
 *
 * Architecture:
 * - Tool definitions are declarative (schema + handler)
 * - The AppleMailManager class handles all AppleScript operations
 * - Error handling is consistent across all tools
 *
 * @module apple-mail-mcp
 * @see https://modelcontextprotocol.io
 */

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppleMailManager } from "@/services/appleMailManager.js";
import { emailAddressSchema } from "@/utils/emailValidation.js";

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// =============================================================================
// Server Initialization
// =============================================================================

/**
 * MCP server instance configured for Apple Mail operations.
 */
const server = new McpServer({
  name: "apple-mail",
  version,
  description: "MCP server for managing Apple Mail - read, search, send, and organize emails",
});

/**
 * Singleton instance of the Apple Mail manager.
 * Handles all AppleScript execution and mail operations.
 */
const mailManager = new AppleMailManager();

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Creates a successful MCP tool response.
 */
function successResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Creates an error MCP tool response.
 */
function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Wraps a tool handler with consistent error handling.
 */
function withErrorHandling<T extends Record<string, unknown>>(
  handler: (params: T) => ReturnType<typeof successResponse>,
  errorPrefix: string
) {
  return async (params: T) => {
    try {
      return handler(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(`${errorPrefix}: ${message}`);
    }
  };
}

// =============================================================================
// Message Tools
// =============================================================================

// --- search-messages ---

server.tool(
  "search-messages",
  {
    query: z.string().optional().describe("Text to search for in subject, sender, or content"),
    from: z.string().optional().describe("Filter by sender email address"),
    subject: z.string().optional().describe("Filter by subject line"),
    mailbox: z.string().optional().describe("Mailbox to search in (e.g., 'INBOX')"),
    account: z.string().optional().describe("Account to search in (omit to search all accounts)"),
    isRead: z.boolean().optional().describe("Filter by read status"),
    isFlagged: z.boolean().optional().describe("Filter by flagged status"),
    dateFrom: z.string().optional().describe("Start date filter (e.g., 'January 1, 2026')"),
    dateTo: z.string().optional().describe("End date filter (e.g., 'March 1, 2026')"),
    limit: z.number().optional().describe("Maximum number of results (default: 50)"),
    allMailboxes: z
      .boolean()
      .optional()
      .describe(
        "Search across all mailboxes in the account (not just INBOX). May be slow on large mail stores."
      ),
    offset: z
      .number()
      .optional()
      .describe("Number of results to skip (for pagination, default: 0)"),
  },
  withErrorHandling(
    ({
      query,
      from,
      isRead,
      isFlagged,
      mailbox,
      account,
      limit = 50,
      offset = 0,
      dateFrom,
      dateTo,
      allMailboxes,
    }) => {
      const messages = mailManager.searchMessages(
        query,
        mailbox,
        account,
        limit,
        dateFrom,
        dateTo,
        from,
        isRead,
        isFlagged,
        allMailboxes,
        offset
      );

      if (messages.length === 0) {
        return successResponse("No messages found matching criteria");
      }

      const messageList = messages
        .map(
          (m) =>
            `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
        )
        .join("\n");

      return successResponse(`Found ${messages.length} message(s):\n${messageList}`);
    },
    "Error searching messages"
  )
);

// --- get-message ---

server.tool(
  "get-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
    preferHtml: z.boolean().optional().describe("Return HTML source instead of plain text"),
  },
  withErrorHandling(({ id, preferHtml }) => {
    const content = mailManager.getMessageContent(id);

    if (!content) {
      return errorResponse(`Message with ID "${id}" not found`);
    }

    if (preferHtml && content.htmlContent) {
      return successResponse(`Subject: ${content.subject}\n\n${content.htmlContent}`);
    }

    return successResponse(`Subject: ${content.subject}\n\n${content.plainText}`);
  }, "Error retrieving message")
);

// --- list-messages ---

server.tool(
  "list-messages",
  {
    mailbox: z.string().optional().describe("Mailbox to list messages from (default: INBOX)"),
    account: z.string().optional().describe("Account to list messages from"),
    limit: z.number().optional().describe("Maximum number of messages (default: 50)"),
    offset: z.number().optional().describe("Number of messages to skip (for pagination)"),
    from: z.string().optional().describe("Filter by sender email address or name"),
    unreadOnly: z.boolean().optional().describe("Only show unread messages"),
  },
  withErrorHandling(({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
    const messages = mailManager.listMessages(mailbox, account, limit, from, offset, unreadOnly);

    if (messages.length === 0) {
      return successResponse("No messages found");
    }

    const messageList = messages
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender})`
      )
      .join("\n");

    return successResponse(`Found ${messages.length} message(s):\n${messageList}`);
  }, "Error listing messages")
);

// --- send-email ---

server.tool(
  "send-email",
  {
    to: z.array(emailAddressSchema).min(1, "At least one recipient is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    cc: z.array(emailAddressSchema).optional().describe("CC recipients"),
    bcc: z.array(emailAddressSchema).optional().describe("BCC recipients"),
    account: z.string().optional().describe("Account to send from"),
    attachments: z
      .array(z.string())
      .optional()
      .describe("Absolute file paths to attach (e.g., ['/Users/me/report.pdf'])"),
    isHtml: z
      .boolean()
      .optional()
      .describe(
        "Send as HTML email. When true, body is rendered as HTML markup rather than plain text."
      ),
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account, attachments, isHtml }) => {
    const success = mailManager.sendEmail(to, subject, body, cc, bcc, account, attachments, isHtml);

    if (!success) {
      return errorResponse("Failed to send email. Check Mail.app configuration.");
    }

    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";
    return successResponse(`Email sent to ${to.join(", ")}${attachInfo}`);
  }, "Error sending email")
);

// --- create-draft ---

server.tool(
  "create-draft",
  {
    to: z.array(emailAddressSchema).min(1, "At least one recipient is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    cc: z.array(emailAddressSchema).optional().describe("CC recipients"),
    bcc: z.array(emailAddressSchema).optional().describe("BCC recipients"),
    account: z.string().optional().describe("Account to create draft in"),
    attachments: z
      .array(z.string())
      .optional()
      .describe("Absolute file paths to attach (e.g., ['/Users/me/report.pdf'])"),
    isHtml: z
      .boolean()
      .optional()
      .describe(
        "Create as HTML email. When true, body is rendered as HTML markup rather than plain text."
      ),
  },
  withErrorHandling(({ to, subject, body, cc, bcc, account, attachments, isHtml }) => {
    const success = mailManager.createDraft(
      to,
      subject,
      body,
      cc,
      bcc,
      account,
      attachments,
      isHtml
    );

    if (!success) {
      return errorResponse("Failed to create draft. Check Mail.app configuration.");
    }

    const attachInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";
    return successResponse(`Draft created for ${to.join(", ")}${attachInfo}`);
  }, "Error creating draft")
);

// --- reply-to-message ---

server.tool(
  "reply-to-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
    body: z.string().min(1, "Reply body is required"),
    replyAll: z.boolean().optional().default(false).describe("Reply to all recipients"),
    send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
  },
  withErrorHandling(({ id, body, replyAll, send }) => {
    const success = mailManager.replyToMessage(id, body, replyAll, send);

    if (!success) {
      return errorResponse(`Failed to reply to message "${id}"`);
    }

    return successResponse(send ? "Reply sent" : "Reply saved as draft");
  }, "Error replying to message")
);

// --- forward-message ---

server.tool(
  "forward-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
    to: z.array(emailAddressSchema).min(1, "At least one recipient is required"),
    body: z.string().optional().describe("Optional message to prepend"),
    send: z.boolean().optional().default(true).describe("Send immediately (false = save as draft)"),
  },
  withErrorHandling(({ id, to, body, send }) => {
    const success = mailManager.forwardMessage(id, to, body, send);

    if (!success) {
      return errorResponse(`Failed to forward message "${id}"`);
    }

    return successResponse(
      send ? `Message forwarded to ${to.join(", ")}` : "Forward saved as draft"
    );
  }, "Error forwarding message")
);

// --- mark-as-read ---

server.tool(
  "mark-as-read",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.markAsRead(id);

    if (!success) {
      return errorResponse(`Failed to mark message "${id}" as read`);
    }

    return successResponse("Message marked as read");
  }, "Error marking message as read")
);

// --- mark-as-unread ---

server.tool(
  "mark-as-unread",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.markAsUnread(id);

    if (!success) {
      return errorResponse(`Failed to mark message "${id}" as unread`);
    }

    return successResponse("Message marked as unread");
  }, "Error marking message as unread")
);

// --- flag-message ---

server.tool(
  "flag-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.flagMessage(id);

    if (!success) {
      return errorResponse(`Failed to flag message "${id}"`);
    }

    return successResponse("Message flagged");
  }, "Error flagging message")
);

// --- unflag-message ---

server.tool(
  "unflag-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.unflagMessage(id);

    if (!success) {
      return errorResponse(`Failed to unflag message "${id}"`);
    }

    return successResponse("Message unflagged");
  }, "Error unflagging message")
);

// --- delete-message ---

server.tool(
  "delete-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.deleteMessage(id);

    if (!success) {
      return errorResponse(`Failed to delete message "${id}"`);
    }

    return successResponse("Message deleted");
  }, "Error deleting message")
);

// --- move-message ---

server.tool(
  "move-message",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
  },
  withErrorHandling(({ id, mailbox, account }) => {
    const success = mailManager.moveMessage(id, mailbox, account);

    if (!success) {
      return errorResponse(`Failed to move message to "${mailbox}"`);
    }

    return successResponse(`Message moved to "${mailbox}"`);
  }, "Error moving message")
);

// --- batch-delete-messages ---

server.tool(
  "batch-delete-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchDeleteMessages(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully deleted ${successCount} message(s)`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to delete all ${failCount} message(s)`);
    } else {
      return successResponse(`Deleted ${successCount} message(s), ${failCount} failed`);
    }
  }, "Error batch deleting messages")
);

// --- batch-move-messages ---

server.tool(
  "batch-move-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
    mailbox: z.string().min(1, "Destination mailbox is required"),
    account: z.string().optional().describe("Account containing the destination mailbox"),
  },
  withErrorHandling(({ ids, mailbox, account }) => {
    const results = mailManager.batchMoveMessages(ids, mailbox, account);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully moved ${successCount} message(s) to "${mailbox}"`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to move all ${failCount} message(s)`);
    } else {
      return successResponse(
        `Moved ${successCount} message(s) to "${mailbox}", ${failCount} failed`
      );
    }
  }, "Error batch moving messages")
);

// --- batch-mark-as-read ---

server.tool(
  "batch-mark-as-read",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchMarkAsRead(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully marked ${successCount} message(s) as read`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to mark all ${failCount} message(s) as read`);
    } else {
      return successResponse(`Marked ${successCount} message(s) as read, ${failCount} failed`);
    }
  }, "Error batch marking messages as read")
);

// --- batch-mark-as-unread ---

server.tool(
  "batch-mark-as-unread",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchMarkAsUnread(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully marked ${successCount} message(s) as unread`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to mark all ${failCount} message(s) as unread`);
    } else {
      return successResponse(`Marked ${successCount} message(s) as unread, ${failCount} failed`);
    }
  }, "Error batch marking messages as unread")
);

// --- batch-flag-messages ---

server.tool(
  "batch-flag-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchFlagMessages(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully flagged ${successCount} message(s)`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to flag all ${failCount} message(s)`);
    } else {
      return successResponse(`Flagged ${successCount} message(s), ${failCount} failed`);
    }
  }, "Error batch flagging messages")
);

// --- batch-unflag-messages ---

server.tool(
  "batch-unflag-messages",
  {
    ids: z.array(z.string()).min(1, "At least one message ID is required"),
  },
  withErrorHandling(({ ids }) => {
    const results = mailManager.batchUnflagMessages(ids);
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      return successResponse(`Successfully unflagged ${successCount} message(s)`);
    } else if (successCount === 0) {
      return errorResponse(`Failed to unflag all ${failCount} message(s)`);
    } else {
      return successResponse(`Unflagged ${successCount} message(s), ${failCount} failed`);
    }
  }, "Error batch unflagging messages")
);

// --- list-attachments ---

server.tool(
  "list-attachments",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
  },
  withErrorHandling(({ id }) => {
    const attachments = mailManager.listAttachments(id);

    if (attachments.length === 0) {
      return successResponse("No attachments found");
    }

    const attachmentList = attachments
      .map((a) => {
        const sizeKb = Math.round(a.size / 1024);
        return `  - ${a.name} (${a.mimeType}, ${sizeKb} KB)`;
      })
      .join("\n");

    return successResponse(`Found ${attachments.length} attachment(s):\n${attachmentList}`);
  }, "Error listing attachments")
);

// --- save-attachment ---

server.tool(
  "save-attachment",
  {
    id: z.string().regex(/^\d+$/, "Message ID must be numeric"),
    attachmentName: z
      .string()
      .optional()
      .describe("Attachment filename. Required if attachmentIndex is not provided."),
    attachmentIndex: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "1-based attachment index (alternative to attachmentName — useful when two attachments share a filename)"
      ),
    savePath: z.string().min(1, "Save directory path is required"),
  },
  withErrorHandling(({ id, attachmentName, attachmentIndex, savePath }) => {
    if (!attachmentName && attachmentIndex === undefined) {
      return errorResponse("Either attachmentName or attachmentIndex must be provided");
    }
    const success = mailManager.saveAttachment(id, attachmentName ?? "", savePath, attachmentIndex);

    if (!success) {
      const label = attachmentName || `attachment #${attachmentIndex}`;
      return errorResponse(`Failed to save ${label}`);
    }

    const savedAs = attachmentName || `attachment #${attachmentIndex}`;
    return successResponse(`Attachment "${savedAs}" saved to ${savePath}`);
  }, "Error saving attachment")
);

// =============================================================================
// Mailbox Tools
// =============================================================================

// --- list-mailboxes ---

server.tool(
  "list-mailboxes",
  {
    account: z.string().optional().describe("Account to list mailboxes from"),
  },
  withErrorHandling(({ account }) => {
    const mailboxes = mailManager.listMailboxes(account);

    if (mailboxes.length === 0) {
      return successResponse("No mailboxes found");
    }

    const mailboxList = mailboxes.map((m) => `  - ${m.name} (${m.unreadCount} unread)`).join("\n");

    return successResponse(`Found ${mailboxes.length} mailbox(es):\n${mailboxList}`);
  }, "Error listing mailboxes")
);

// --- get-unread-count ---

server.tool(
  "get-unread-count",
  {
    mailbox: z.string().optional().describe("Mailbox to check (default: all)"),
    account: z.string().optional().describe("Account to check"),
  },
  withErrorHandling(({ mailbox, account }) => {
    const count = mailManager.getUnreadCount(mailbox, account);
    const location = mailbox ? ` in "${mailbox}"` : "";

    return successResponse(`${count} unread message(s)${location}`);
  }, "Error getting unread count")
);

// --- create-mailbox ---

server.tool(
  "create-mailbox",
  {
    name: z.string().min(1, "Mailbox name is required"),
    account: z.string().optional().describe("Account to create the mailbox in"),
  },
  withErrorHandling(({ name, account }) => {
    const success = mailManager.createMailbox(name, account);

    if (!success) {
      return errorResponse(`Failed to create mailbox "${name}"`);
    }

    return successResponse(`Mailbox "${name}" created`);
  }, "Error creating mailbox")
);

// --- delete-mailbox ---

server.tool(
  "delete-mailbox",
  {
    name: z.string().min(1, "Mailbox name is required"),
    account: z.string().optional().describe("Account containing the mailbox"),
  },
  withErrorHandling(({ name, account }) => {
    const success = mailManager.deleteMailbox(name, account);

    if (!success) {
      return errorResponse(`Failed to delete mailbox "${name}"`);
    }

    return successResponse(`Mailbox "${name}" deleted`);
  }, "Error deleting mailbox")
);

// --- rename-mailbox ---

server.tool(
  "rename-mailbox",
  {
    oldName: z.string().min(1, "Current mailbox name is required"),
    newName: z.string().min(1, "New mailbox name is required"),
    account: z.string().optional().describe("Account containing the mailbox"),
  },
  withErrorHandling(({ oldName, newName, account }) => {
    const success = mailManager.renameMailbox(oldName, newName, account);

    if (!success) {
      return errorResponse(`Failed to rename mailbox "${oldName}" to "${newName}"`);
    }

    return successResponse(`Mailbox renamed from "${oldName}" to "${newName}"`);
  }, "Error renaming mailbox")
);

// =============================================================================
// Account Tools
// =============================================================================

// --- list-accounts ---

server.tool(
  "list-accounts",
  {},
  withErrorHandling(() => {
    const accounts = mailManager.listAccounts();

    if (accounts.length === 0) {
      return successResponse("No Mail accounts found");
    }

    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} account(s):\n${accountList}`);
  }, "Error listing accounts")
);

// =============================================================================
// Mail Rules Tools
// =============================================================================

// --- list-rules ---

server.tool(
  "list-rules",
  {},
  withErrorHandling(() => {
    const rules = mailManager.listRules();

    if (rules.length === 0) {
      return successResponse("No mail rules found");
    }

    const ruleList = rules
      .map((r) => `  - ${r.name} [${r.enabled ? "enabled" : "disabled"}]`)
      .join("\n");

    return successResponse(`Found ${rules.length} rule(s):\n${ruleList}`);
  }, "Error listing rules")
);

// --- enable-rule ---

server.tool(
  "enable-rule",
  {
    name: z.string().min(1, "Rule name is required"),
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, true);

    if (!success) {
      return errorResponse(`Failed to enable rule "${name}"`);
    }

    return successResponse(`Rule "${name}" enabled`);
  }, "Error enabling rule")
);

// --- disable-rule ---

server.tool(
  "disable-rule",
  {
    name: z.string().min(1, "Rule name is required"),
  },
  withErrorHandling(({ name }) => {
    const success = mailManager.setRuleEnabled(name, false);

    if (!success) {
      return errorResponse(`Failed to disable rule "${name}"`);
    }

    return successResponse(`Rule "${name}" disabled`);
  }, "Error disabling rule")
);

// =============================================================================
// Contacts Tools
// =============================================================================

// --- search-contacts ---

server.tool(
  "search-contacts",
  {
    query: z.string().min(1, "Search query is required"),
  },
  withErrorHandling(({ query }) => {
    const contacts = mailManager.searchContacts(query);

    if (contacts.length === 0) {
      return successResponse("No contacts found");
    }

    const contactList = contacts
      .map((c) => {
        const emails = c.emails.length > 0 ? c.emails.join(", ") : "no email";
        return `  - ${c.name} (${emails})`;
      })
      .join("\n");

    return successResponse(`Found ${contacts.length} contact(s):\n${contactList}`);
  }, "Error searching contacts")
);

// =============================================================================
// Email Template Tools
// =============================================================================

// --- save-template ---

server.tool(
  "save-template",
  {
    name: z.string().min(1, "Template name is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    to: z.array(emailAddressSchema).optional().describe("Default recipients"),
    cc: z.array(emailAddressSchema).optional().describe("Default CC recipients"),
    id: z.string().optional().describe("Template ID (for updating existing template)"),
  },
  withErrorHandling(({ name, subject, body, to, cc, id }) => {
    const template = mailManager.saveTemplate(name, subject, body, to, cc, id);

    return successResponse(`Template "${template.name}" saved with ID: ${template.id}`);
  }, "Error saving template")
);

// --- list-templates ---

server.tool(
  "list-templates",
  {},
  withErrorHandling(() => {
    const templates = mailManager.listTemplates();

    if (templates.length === 0) {
      return successResponse("No templates saved");
    }

    const templateList = templates
      .map((t) => `  - [${t.id}] ${t.name} — "${t.subject}"`)
      .join("\n");

    return successResponse(`Found ${templates.length} template(s):\n${templateList}`);
  }, "Error listing templates")
);

// --- get-template ---

server.tool(
  "get-template",
  {
    id: z.string().min(1, "Template ID is required"),
  },
  withErrorHandling(({ id }) => {
    const template = mailManager.getTemplate(id);

    if (!template) {
      return errorResponse(`Template "${id}" not found`);
    }

    const lines = [
      `Name: ${template.name}`,
      `Subject: ${template.subject}`,
      template.to ? `To: ${template.to.join(", ")}` : null,
      template.cc ? `CC: ${template.cc.join(", ")}` : null,
      `\n${template.body}`,
    ]
      .filter(Boolean)
      .join("\n");

    return successResponse(lines);
  }, "Error getting template")
);

// --- delete-template ---

server.tool(
  "delete-template",
  {
    id: z.string().min(1, "Template ID is required"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.deleteTemplate(id);

    if (!success) {
      return errorResponse(`Template "${id}" not found`);
    }

    return successResponse(`Template "${id}" deleted`);
  }, "Error deleting template")
);

// --- use-template ---

server.tool(
  "use-template",
  {
    id: z.string().min(1, "Template ID is required"),
    to: z.array(emailAddressSchema).optional().describe("Override recipients"),
    cc: z.array(emailAddressSchema).optional().describe("Override CC recipients"),
    subject: z.string().optional().describe("Override subject"),
    body: z.string().optional().describe("Override body"),
  },
  withErrorHandling(({ id, to, cc, subject, body }) => {
    const success = mailManager.useTemplate(id, { to, cc, subject, body });

    if (!success) {
      return errorResponse(`Failed to use template "${id}". Template not found or no recipients.`);
    }

    return successResponse(`Draft created from template "${id}"`);
  }, "Error using template")
);

// =============================================================================
// Junk Mail Tools
// =============================================================================

// --- move-to-junk ---

server.tool(
  "move-to-junk",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("Unique message ID (from list-messages or search-messages)"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.moveToJunk(id);
    if (!success) {
      return errorResponse(
        `Failed to mark message "${id}" as junk. The message may not exist or the Junk mailbox may be unavailable.`
      );
    }
    return successResponse(`Message "${id}" marked as junk and moved to Junk mailbox.`);
  }, "Error marking message as junk")
);

// --- mark-as-not-junk ---

server.tool(
  "mark-as-not-junk",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("Unique message ID (from list-messages or search-messages)"),
  },
  withErrorHandling(({ id }) => {
    const success = mailManager.markAsNotJunk(id);
    if (!success) {
      return errorResponse(
        `Failed to clear junk flag on message "${id}". The message may not exist.`
      );
    }
    return successResponse(
      `Message "${id}" junk flag cleared. The message remains in its current mailbox — use move-message to restore it to INBOX if needed.`
    );
  }, "Error clearing junk flag")
);

// =============================================================================
// Archive Tools
// =============================================================================

// --- archive-message ---

server.tool(
  "archive-message",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("Unique message ID (from list-messages or search-messages)"),
    account: z
      .string()
      .optional()
      .describe("Account whose Archive mailbox to use (omit to use default account)"),
  },
  withErrorHandling(({ id, account }) => {
    const success = mailManager.archiveMessage(id, account);
    if (!success) {
      return errorResponse(
        `Failed to archive message "${id}". The Archive mailbox may be unavailable for this account.`
      );
    }
    return successResponse(
      `Message "${id}" archived. Note: Gmail accounts may leave the Inbox label due to Gmail's IMAP label model.`
    );
  }, "Error archiving message")
);

// --- batch-archive ---

server.tool(
  "batch-archive",
  {
    ids: z
      .array(z.string().regex(/^\d+$/, "Message ID must be numeric"))
      .min(1, "At least one message ID required")
      .describe("Array of message IDs to archive"),
    account: z
      .string()
      .optional()
      .describe("Account whose Archive mailbox to use (omit to use default account)"),
  },
  withErrorHandling(({ ids, account }) => {
    const results = mailManager.batchArchiveMessages(ids, account);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    const lines: string[] = [`Archived ${succeeded}/${results.length} messages.`];
    if (failed.length > 0) {
      lines.push(`Failed: ${failed.map((r) => r.id).join(", ")}`);
    }

    return successResponse(lines.join("\n"));
  }, "Error batch archiving messages")
);

// =============================================================================
// Thread Tools
// =============================================================================

// --- get-thread ---

server.tool(
  "get-thread",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Message ID must be numeric")
      .describe("ID of any message in the thread (seed message)"),
    account: z
      .string()
      .optional()
      .describe(
        "Limit thread search to this account (faster). Omit to search all accounts (slower, more complete)."
      ),
  },
  withErrorHandling(({ id, account }) => {
    const messages = mailManager.getThread(id, account);

    if (messages.length === 0) {
      return successResponse(
        `No thread found for message "${id}". The subject may be too short or the message may not exist.`
      );
    }

    const lines: string[] = [
      `Thread: ${messages.length} message${messages.length === 1 ? "" : "s"} (oldest first)`,
      ``,
    ];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const dateStr = m.dateReceived.toLocaleString();
      const readStatus = m.isRead ? "Read" : "Unread";
      lines.push(`[${i + 1}] ID: ${m.id}  ${readStatus}`);
      lines.push(`    From: ${m.sender}`);
      lines.push(`    Subject: ${m.subject}`);
      lines.push(`    Date: ${dateStr}`);
      lines.push(`    Mailbox: ${m.mailbox} (${m.account})`);
      lines.push(``);
    }

    return successResponse(lines.join("\n").trimEnd());
  }, "Error getting thread")
);

// =============================================================================
// VIP Tools
// =============================================================================

// --- get-vip-messages ---

server.tool(
  "get-vip-messages",
  {
    limit: z.number().optional().describe("Max messages per VIP sender to retrieve (default: 50)"),
  },
  withErrorHandling(({ limit }) => {
    const { messages, vipSenders, error } = mailManager.getVipMessages(limit ?? 50);

    if (error && messages.length === 0) {
      return successResponse(`VIP messages: none\n\n${error}`);
    }

    const lines: string[] = [
      `VIP Senders (${vipSenders.length}): ${vipSenders.join(", ")}`,
      `Messages from VIP senders: ${messages.length}`,
      ``,
    ];

    for (const m of messages) {
      const dateStr = m.dateReceived.toLocaleString();
      const readStatus = m.isRead ? "Read" : "Unread";
      lines.push(`ID: ${m.id}  [${readStatus}]`);
      lines.push(`  From: ${m.sender}`);
      lines.push(`  Subject: ${m.subject}`);
      lines.push(`  Date: ${dateStr}`);
      lines.push(`  Mailbox: ${m.mailbox}`);
      lines.push(``);
    }

    return successResponse(lines.join("\n").trimEnd());
  }, "Error getting VIP messages")
);

// =============================================================================
// Diagnostics Tools
// =============================================================================

// --- health-check ---

server.tool(
  "health-check",
  {},
  withErrorHandling(() => {
    const result = mailManager.healthCheck();

    const statusIcon = result.healthy ? "✓" : "✗";
    const statusText = result.healthy ? "All checks passed" : "Issues detected";

    const checkLines = result.checks
      .map((c) => {
        const icon = c.passed ? "✓" : "✗";
        return `  ${icon} ${c.name}: ${c.message}`;
      })
      .join("\n");

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}`);
  }, "Error running health check")
);

// --- get-mail-stats ---

server.tool(
  "get-mail-stats",
  {},
  withErrorHandling(() => {
    const stats = mailManager.getMailStats();

    const lines: string[] = [];
    lines.push(`📊 Mail Statistics`);
    lines.push(`══════════════════`);
    lines.push(`Total messages: ${stats.totalMessages}`);
    lines.push(`Unread messages: ${stats.totalUnread}`);
    lines.push(``);

    if (stats.recentlyReceived) {
      lines.push(`📥 Recently Received:`);
      lines.push(`  Last 24 hours: ${stats.recentlyReceived.last24h}`);
      lines.push(`  Last 7 days: ${stats.recentlyReceived.last7d}`);
      lines.push(`  Last 30 days: ${stats.recentlyReceived.last30d}`);
      lines.push(``);
    }

    if (stats.accounts.length > 0) {
      lines.push(`📁 By Account:`);
      for (const account of stats.accounts) {
        lines.push(
          `  ${account.name}: ${account.totalMessages} messages (${account.unreadMessages} unread)`
        );
      }
    }

    return successResponse(lines.join("\n"));
  }, "Error getting mail statistics")
);

// --- get-sync-status ---

server.tool(
  "get-sync-status",
  {},
  withErrorHandling(() => {
    const status = mailManager.getSyncStatus();

    const lines: string[] = [];
    lines.push(`Mail Sync Status`);
    lines.push(`═══════════════════`);

    if (status.error) {
      lines.push(`Status: ${status.error}`);
    } else {
      lines.push(`Mail.app: ${status.running ? "Running" : "Not running"}`);
      lines.push(`Accounts loaded: ${status.accountCount}`);
      lines.push(``);
      lines.push(
        `Note: Apple Mail does not expose IMAP sync state via AppleScript. Only running status and account count are observable.`
      );
    }

    return successResponse(lines.join("\n"));
  }, "Error getting sync status")
);

// =============================================================================
// Intelligence Layer Tools (Phase 4)
// =============================================================================

server.tool(
  "triage-inbox",
  {
    limit: z
      .number()
      .optional()
      .describe(
        "Max unread messages to fetch (default: 20). Keep low if includeSnippets=true — each snippet is one AppleScript call."
      ),
    includeSnippets: z
      .boolean()
      .optional()
      .describe(
        "Fetch first 200 chars of body per message (default: true). Set false for faster results on large inboxes."
      ),
    mailbox: z.string().optional().describe("Mailbox to triage (default: INBOX)"),
    account: z.string().optional().describe("Account to triage (omit for default account)"),
  },
  withErrorHandling(({ limit = 20, includeSnippets = true, mailbox = "INBOX", account }) => {
    const messages = mailManager.getTriageMessages(mailbox, limit, includeSnippets, account);

    if (messages.length === 0) {
      return successResponse("Triage data: 0 unread messages found.");
    }

    const lines: string[] = [
      `Triage data: ${messages.length} unread message(s) in ${mailbox}`,
      "",
      "Classify each as: urgent / FYI / deletable",
      "═══════════════════════════════════════════",
      "",
    ];

    messages.forEach((msg, i) => {
      lines.push(`[${i + 1}] ID: ${msg.id}`);
      lines.push(`  From: ${msg.sender}`);
      lines.push(`  Subject: ${msg.subject}`);
      lines.push(`  Date: ${msg.dateReceived.toISOString().slice(0, 16).replace("T", " ")}`);
      lines.push(
        `  Flagged: ${msg.isFlagged ? "yes" : "no"} | Attachments: ${msg.hasAttachments ? "yes" : "no"}`
      );
      if (msg.snippet) lines.push(`  Snippet: "${msg.snippet}"`);
      lines.push("");
    });

    return successResponse(lines.join("\n"));
  }, "Error triaging inbox")
);

server.tool(
  "find-action-items",
  {
    id: z
      .string()
      .optional()
      .describe("Message ID to scan (single message mode). Provide this OR mailbox, not both."),
    mailbox: z
      .string()
      .optional()
      .describe("Mailbox to scan for action items (default: INBOX). Used when id is not provided."),
    limit: z
      .number()
      .optional()
      .describe(
        "Max messages to scan in mailbox mode (default: 10). Each message is one AppleScript call."
      ),
    account: z.string().optional().describe("Account to scan (omit for default account)"),
  },
  withErrorHandling(({ id, mailbox = "INBOX", limit = 10, account }) => {
    const results = mailManager.getActionItems(id, mailbox, limit, account);

    if (results.length === 0) {
      return successResponse("No messages found for action-item extraction.");
    }

    const lines: string[] = [
      `Action item source data: ${results.length} message(s)`,
      "",
      "Extract to-dos, deadlines, and requests from the bodies below.",
      "═══════════════════════════════════════════════════════════════",
      "",
    ];

    results.forEach((item, i) => {
      lines.push(`[${i + 1}] ID: ${item.id}`);
      lines.push(`  From: ${item.sender}`);
      lines.push(`  Subject: ${item.subject}`);
      lines.push(`  Date: ${item.dateReceived.toISOString().slice(0, 16).replace("T", " ")}`);
      lines.push("  Body:");
      lines.push(
        item.plainText
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
      lines.push("");
    });

    return successResponse(lines.join("\n"));
  }, "Error finding action items")
);

server.tool(
  "summarize-inbox",
  {
    mailbox: z.string().optional().describe("Mailbox to summarize (default: INBOX)"),
    limit: z
      .number()
      .optional()
      .describe("Max unread messages to include in briefing data (default: 30)"),
    account: z.string().optional().describe("Account to summarize (omit for all accounts)"),
  },
  withErrorHandling(({ mailbox = "INBOX", limit = 30, account }) => {
    const { totalUnread, messages } = mailManager.getSummarizeInboxData(mailbox, limit, account);

    const lines: string[] = [
      `Inbox briefing data: ${totalUnread} total unread in ${mailbox}`,
      `Showing ${messages.length} message(s)`,
      "",
      "Produce a concise morning briefing summarizing who wrote, about what, and any notable patterns.",
      "═══════════════════════════════════════════════════════════════════════════════════════════════",
      "",
    ];

    messages.forEach((msg, i) => {
      lines.push(`[${i + 1}] From: ${msg.sender}`);
      lines.push(`    Subject: ${msg.subject}`);
      lines.push(`    Date: ${msg.dateReceived.toISOString().slice(0, 16).replace("T", " ")}`);
      lines.push(
        `    Flagged: ${msg.isFlagged ? "yes" : "no"} | Attachments: ${msg.hasAttachments ? "yes" : "no"}`
      );
      lines.push("");
    });

    return successResponse(lines.join("\n"));
  }, "Error summarizing inbox")
);

server.tool(
  "unsubscribe-helper",
  {
    id: z.string().describe("Message ID to inspect for unsubscribe links"),
  },
  withErrorHandling(({ id }) => {
    const result = mailManager.getUnsubscribeLinks(id);

    const lines: string[] = [
      `Unsubscribe analysis for message ${id}`,
      "═══════════════════════════════════════",
      "",
      `Likely newsletter: ${result.isLikelyNewsletter ? "YES" : "NO"}`,
    ];

    if (result.newsletterSignals.length > 0) {
      lines.push("");
      lines.push("Newsletter signals:");
      result.newsletterSignals.forEach((s) => lines.push(`  - ${s}`));
    }

    lines.push("");
    if (result.unsubscribeLinks.length === 0) {
      lines.push("No unsubscribe links found in HTML body.");
      lines.push("The email may use a mailto: link or a button not detectable by link regex.");
    } else {
      lines.push(`Unsubscribe link(s) found (${result.unsubscribeLinks.length}):`);
      result.unsubscribeLinks.forEach((link, i) => lines.push(`  [${i + 1}] ${link}`));
      lines.push("");
      lines.push("Confirm with the user which link to use before opening.");
    }

    return successResponse(lines.join("\n"));
  }, "Error analyzing unsubscribe links")
);

server.tool(
  "draft-reply",
  {
    id: z.string().describe("Message ID of the email to reply to (any message in the thread)"),
    draftBody: z
      .string()
      .optional()
      .describe(
        "Reply text to use as the draft body. If provided, creates a draft immediately. If omitted, returns thread context for you to compose the reply."
      ),
    maxMessages: z
      .number()
      .optional()
      .describe("Max thread messages to include in context (default: 5, most recent)"),
    bodyTruncate: z
      .number()
      .optional()
      .describe("Max characters per message body in context (default: 500)"),
    account: z
      .string()
      .optional()
      .describe("Account to scope thread search to (omit to search all accounts)"),
  },
  withErrorHandling(({ id, draftBody, maxMessages = 5, bodyTruncate = 500, account }) => {
    const { context, draftCreated } = mailManager.getDraftReplyContext(
      id,
      draftBody,
      maxMessages,
      bodyTruncate,
      account
    );

    const lines: string[] = [];

    if (draftBody !== undefined) {
      lines.push(
        draftCreated
          ? `Draft reply created successfully. Review it in Mail.app before sending.`
          : `Failed to create draft. Check that Mail.app has the message and that the recipient address is valid.`
      );
      lines.push("");
    }

    lines.push(context);

    if (draftBody === undefined) {
      lines.push("");
      lines.push(
        "To create the draft, call draft-reply again with the same id and your reply text in the draftBody parameter."
      );
    }

    return successResponse(lines.join("\n"));
  }, "Error preparing draft reply")
);

server.tool(
  "summarize-thread",
  {
    id: z.string().describe("Message ID of any message in the thread to summarize"),
    maxMessages: z
      .number()
      .optional()
      .describe("Max thread messages to include (default: 20, most recent)"),
    bodyTruncate: z.number().optional().describe("Max characters per message body (default: 1000)"),
    account: z
      .string()
      .optional()
      .describe("Account to scope thread search to (omit to search all accounts)"),
  },
  withErrorHandling(({ id, maxMessages = 20, bodyTruncate = 1000, account }) => {
    const threadData = mailManager.getThreadSummaryData(id, maxMessages, bodyTruncate, account);

    const lines: string[] = [
      `Thread summary data for message ${id}`,
      "",
      "Summarize this thread in 3-5 sentences: current status, key decisions, and open questions.",
      "═══════════════════════════════════════════════════════════════════════════════════════════",
      "",
      threadData,
    ];

    return successResponse(lines.join("\n"));
  }, "Error summarizing thread")
);

server.tool(
  "detect-waiting-for",
  {
    limit: z
      .number()
      .optional()
      .describe(
        "Max sent messages to check for replies (default: 20). Each check calls getThread — keep limit reasonable."
      ),
    daysAgo: z
      .number()
      .optional()
      .describe(
        "Only check messages sent at least this many days ago (default: 2 — ignore very recent sends)"
      ),
    account: z
      .string()
      .optional()
      .describe("Account to scan Sent folder for (omit for default account)"),
  },
  withErrorHandling(({ limit = 20, daysAgo = 2, account }) => {
    const items = mailManager.getWaitingFor(limit, daysAgo, account);

    if (items.length === 0) {
      return successResponse(
        `No waiting-for items found. All sent messages in the last ${limit} (sent ${daysAgo}+ days ago) have received replies.`
      );
    }

    const lines: string[] = [
      `Waiting-for list: ${items.length} sent message(s) with no reply`,
      "Sorted oldest first (most overdue at top)",
      "═══════════════════════════════════════════",
      "",
    ];

    items.forEach((item, i) => {
      lines.push(`[${i + 1}] ID: ${item.id}`);
      lines.push(`  Subject: ${item.subject}`);
      lines.push(`  To: ${item.recipients.join(", ")}`);
      lines.push(`  Sent: ${item.dateSent.toISOString().slice(0, 10)}`);
      lines.push(`  Days waiting: ${item.daysWaiting}`);
      lines.push("");
    });

    return successResponse(lines.join("\n"));
  }, "Error detecting waiting-for items")
);

server.tool(
  "get-config",
  "Get the current persistent configuration for apple-mail-mcp (defaultAccount, defaultMailbox, timeoutMs). Returns {} if no config file exists yet.",
  {},
  withErrorHandling(() => {
    const config = mailManager.getConfig();
    return successResponse(JSON.stringify(config, null, 2));
  }, "Error getting config")
);

server.tool(
  "set-config",
  "Update one or more persistent configuration values. Only provided fields are changed; omitted fields retain their current values.",
  {
    defaultAccount: z
      .string()
      .optional()
      .describe("Default Mail account name to use when none is specified"),
    defaultMailbox: z
      .string()
      .optional()
      .describe("Default mailbox name (e.g. INBOX) to use when none is specified"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("AppleScript timeout in milliseconds (e.g. 60000)"),
  },
  withErrorHandling(({ defaultAccount, defaultMailbox, timeoutMs }) => {
    mailManager.setConfig({ defaultAccount, defaultMailbox, timeoutMs });
    const updated = mailManager.getConfig();
    return successResponse(`Config updated:\n${JSON.stringify(updated, null, 2)}`);
  }, "Error setting config")
);

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Initialize and start the MCP server.
 */
const transport = new StdioServerTransport();
await server.connect(transport);
