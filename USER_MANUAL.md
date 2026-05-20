# Apple Mail MCP — User Manual

**Version:** 2.0  
**Platform:** macOS (Apple Mail + AppleScript)  
**Works with:** Claude (and any MCP-compatible AI assistant)

---

## What is Apple Mail MCP?

Apple Mail MCP is a bridge between your AI assistant and Apple Mail. Once installed, you can ask Claude to read, send, search, organise, and analyse your email — entirely on your Mac. No data leaves your machine.

**Example things you can ask:**

- *"Check my inbox for anything urgent"*
- *"Send a reply to the last email from Sarah"*
- *"Archive everything from newsletters this week"*
- *"Find emails about the Q3 report and summarise the thread"*
- *"What am I still waiting for a reply on?"*

---

## Installation

### Quick start (Claude Code)

```bash
# In your terminal with Claude Code running:
/plugin install apple-mail-mcp
```

### Manual installation

```bash
npm install -g apple-mail-mcp
```

Then add to your Claude Code MCP config (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "apple-mail-mcp"
    }
  }
}
```

### Permissions

The first time you use any tool, macOS will ask you to grant automation permission to Terminal (or your app) to control Mail. Click **OK**. This is required for all AppleScript operations.

---

## Configuration

### Persistent config file

Settings are stored at `~/.config/apple-mail-mcp/config.json` and survive server restarts.

**Read current config:**
> *"Show me the current apple-mail-mcp config"* → uses `get-config`

**Update config:**
> *"Set my default mail account to work@company.com"* → uses `set-config`

| Setting | Description | Default |
|---------|-------------|---------|
| `defaultAccount` | Account used when none is specified | Mail.app's default send account |
| `defaultMailbox` | Mailbox used when none is specified | `INBOX` |
| `timeoutMs` | AppleScript timeout in milliseconds | `30000` |

---

## Tool Reference

Tools are grouped by category. For each tool, the key parameters are shown. All tools require Mail.app to be running.

---

### Reading Mail

#### `list-messages`
List messages in a mailbox.

| Parameter | Type | Description |
|-----------|------|-------------|
| `mailbox` | string | Folder name (default: `INBOX`) |
| `account` | string | Account name (omit for default) |
| `limit` | number | Max messages to return (default: 50) |
| `offset` | number | Skip N messages (for pagination) |
| `from` | string | Filter by sender |
| `unreadOnly` | boolean | Only show unread messages |

**Examples:**
- *"List my last 20 unread emails"*
- *"Show me emails from john@acme.com in my Work inbox"*
- *"Give me the next 50 messages after the first batch"* (uses `offset`)

---

#### `search-messages`
Search across mailboxes with multiple filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Text to search in subject/sender/body |
| `from` | string | Filter by sender address |
| `mailbox` | string | Specific mailbox to search |
| `account` | string | Specific account to search |
| `isRead` | boolean | Filter by read status |
| `isFlagged` | boolean | Filter by flagged status |
| `dateFrom` | string | Start date (e.g. `"January 1, 2026"`) |
| `dateTo` | string | End date |
| `allMailboxes` | boolean | Search all folders, not just INBOX |
| `limit` | number | Max results (default: 50) |
| `offset` | number | Skip N results (pagination) |

**Examples:**
- *"Search for emails about the contract from last month"*
- *"Find all unread flagged emails"*
- *"Search across all my folders for anything mentioning the invoice"*

> ⚠️ `allMailboxes: true` can be slow on large mail stores.

---

#### `get-message`
Read the full content of a specific message.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID (from list/search) |
| `preferHtml` | boolean | Return HTML source instead of plain text |

**Example:** *"Read message 12345"*

Returns: subject, sender, recipients, date, body, plus `replyTo`, `ccRecipients`, `hasAttachments`, `attachmentNames` when present.

---

#### `get-thread`
Retrieve an entire email thread (conversation) in chronological order.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | ID of any message in the thread |
| `account` | string | Limit search to one account (faster) |

**Example:** *"Show me the full thread for that email from Alice"*

Returns all messages matching the same subject (normalised — ignores Re:/Fwd: prefixes), sorted oldest-first.

---

#### `get-unread-count`
Get a count of unread messages.

| Parameter | Type | Description |
|-----------|------|-------------|
| `mailbox` | string | Specific mailbox (omit for all) |
| `account` | string | Specific account |

**Example:** *"How many unread emails do I have?"*

---

#### `get-vip-messages`
Get messages from Apple Mail VIP senders.

> Reads VIP sender addresses from Mail.app's VIP.plist and searches for their messages.

**Example:** *"Check if any of my VIPs have emailed me"*

---

### Sending & Composing

> **Safety tip:** For important emails, always use `create-draft` first so you can review before sending.

#### `send-email`
Send an email immediately.

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | string[] | Recipient addresses (required) |
| `subject` | string | Subject line (required) |
| `body` | string | Message body (required) |
| `cc` | string[] | CC recipients |
| `bcc` | string[] | BCC recipients |
| `account` | string | Send from this account |
| `attachments` | string[] | Absolute file paths to attach |
| `isHtml` | boolean | Treat body as HTML markup |

**Example:** *"Send an email to team@company.com with subject 'Meeting notes' and the following body: ..."*

---

#### `create-draft`
Save a draft for review in Mail.app before sending.

Same parameters as `send-email`. The draft will appear in Mail.app's Drafts folder.

**Example:** *"Draft a reply to that invoice email — I want to review it first"*

---

#### `reply-to-message`
Reply to an existing message.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID to reply to |
| `body` | string | Reply text |
| `replyAll` | boolean | Reply to all recipients (default: false) |
| `send` | boolean | Send immediately (default: true, set false to save as draft) |

**Example:** *"Reply to message 12345 saying I'll be there at 3pm"*

---

#### `forward-message`
Forward a message to new recipients.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID to forward |
| `to` | string[] | Forward recipients |
| `body` | string | Optional preface text |
| `send` | boolean | Send immediately (default: true) |

---

#### `draft-reply`
Fetch thread context to help Claude compose a reply draft.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | ID of the message to reply to |
| `account` | string | Account (optional) |

Returns the full thread and creates a blank draft. Claude will then suggest a reply body which you can accept, edit, or discard.

**Example:** *"Help me draft a reply to Sarah's last email — keep it professional and brief"*

---

### Managing Messages

#### `mark-as-read` / `mark-as-unread`
Toggle read status on a single message. Requires message `id`.

#### `flag-message` / `unflag-message`
Toggle the flag on a single message. Requires message `id`.

#### `delete-message`
Move a message to Trash. Requires message `id`. Can be recovered from Trash in Mail.app.

#### `move-message`
Move a message to a different mailbox.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID |
| `mailbox` | string | Destination folder name |
| `account` | string | Account (if ambiguous) |

**Example:** *"Move message 12345 to the Projects folder"*

---

#### `archive-message`
Move a message to the account's native Archive folder (one click).

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID |
| `account` | string | Account (optional) |

> Gmail note: due to Gmail's IMAP label model, the Inbox label may persist. Use `move-message` to `[Gmail]/All Mail` if needed.

---

#### `move-to-junk`
Mark a message as junk **and** move it to the Junk mailbox.

#### `mark-as-not-junk`
Clear the junk flag on a message. The message stays in its current mailbox — use `move-message` to restore it to INBOX.

---

### Batch Operations

All batch tools accept an `ids` array and return a per-message success/fail summary.

| Tool | What it does |
|------|-------------|
| `batch-delete-messages` | Delete multiple messages |
| `batch-move-messages` | Move multiple messages to a folder (also requires `mailbox`) |
| `batch-mark-as-read` | Mark multiple messages as read |
| `batch-mark-as-unread` | Mark multiple messages as unread |
| `batch-flag-messages` | Flag multiple messages |
| `batch-unflag-messages` | Unflag multiple messages |
| `batch-archive` | Archive multiple messages |

**Example:** *"Archive all those newsletter emails we just found"*

---

### Attachments

#### `list-attachments`
List all attachments on a message.

Returns: filename, MIME type, and size (KB) for each attachment.

#### `save-attachment`
Save an attachment to disk.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID |
| `attachmentName` | string | Filename to save (required unless using index) |
| `attachmentIndex` | number | 1-based index (alternative to name) |
| `savePath` | string | Directory to save to (e.g. `/Users/me/Downloads`) |

**Examples:**
- *"Save the PDF attachment from message 12345 to my Downloads folder"*
- *"Save the first attachment from that email"* (uses `attachmentIndex: 1`)

---

### Mailbox Management

#### `list-mailboxes`
List all folders for an account, including unread counts.

#### `create-mailbox`
Create a new folder.

#### `rename-mailbox`
Rename an existing folder.

#### `delete-mailbox`
Delete a folder. Mail.app will warn if it contains messages.

**Example:** *"Create a folder called 'Archive 2025'"*

---

### Accounts & Rules

#### `list-accounts`
List all configured Mail accounts by name.

#### `list-rules`
List all Mail rules with their enabled/disabled status.

#### `enable-rule` / `disable-rule`
Toggle a rule by name.

**Example:** *"Disable my Newsletter rule temporarily"*

---

### Contacts

#### `search-contacts`
Search Apple Contacts by name or email. Returns name, email addresses, and phone numbers.

**Example:** *"Find Sarah's email address in my contacts"*

---

### Email Templates

Templates are saved to `~/.config/apple-mail-mcp/templates.json` and survive server restarts.

#### `save-template`
Save a reusable email template.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Template display name |
| `subject` | string | Email subject |
| `body` | string | Email body |
| `to` | string[] | Default recipients (optional) |
| `cc` | string[] | Default CC (optional) |
| `id` | string | Provide to update existing template |

#### `list-templates`
List all saved templates with their IDs.

#### `get-template`
Read a template's full content by ID.

#### `use-template`
Create a draft from a template, optionally overriding recipients, subject, or body.

#### `delete-template`
Delete a template by ID.

**Example workflow:**
1. *"Save a template called 'Weekly Update' with subject 'Weekly Status' and body..."*
2. *"Create a draft from the Weekly Update template, sending to manager@company.com"*

---

### Intelligence Tools

These tools fetch and structure data for Claude to analyse. No external API calls are made — all processing happens in your conversation.

---

#### `triage-inbox`
Fetch unread messages with snippets, ready for Claude to categorise as urgent / FYI / deletable.

| Parameter | Type | Description |
|-----------|------|-------------|
| `mailbox` | string | Mailbox to triage (default: INBOX) |
| `account` | string | Account (optional) |
| `limit` | number | Max messages (default: 20) |
| `includeSnippets` | boolean | Include body preview (default: true — set false for speed) |

**Example:** *"Triage my inbox and tell me what needs attention today"*

---

#### `find-action-items`
Fetch a message's content for Claude to extract to-dos and commitments.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID |

**Example:** *"What action items are in that email from the project kickoff?"*

---

#### `summarize-inbox`
Fetch unread messages for Claude to produce a concise daily briefing.

| Parameter | Type | Description |
|-----------|------|-------------|
| `mailbox` | string | Mailbox (default: INBOX) |
| `account` | string | Account (optional) |
| `limit` | number | Max messages (default: 20) |
| `includeSnippets` | boolean | Include body previews (default: true) |

**Example:** *"Give me a morning briefing of my unread mail"*

---

#### `summarize-thread`
Fetch a thread for Claude to collapse into a concise summary with current status and open questions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | ID of any message in the thread |
| `account` | string | Account (optional) |

**Example:** *"Summarise the back-and-forth about the contract renewal"*

---

#### `unsubscribe-helper`
Extract unsubscribe links from an email's HTML body.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Message ID |

Returns: detected unsubscribe URLs, newsletter signal (whether the email looks like a newsletter), and sender details.

**Example:** *"Help me unsubscribe from that newsletter"*

---

#### `detect-waiting-for`
Scan your Sent folder for messages where no reply has arrived, ranked by how overdue they are.

| Parameter | Type | Description |
|-----------|------|-------------|
| `account` | string | Account to check (optional) |
| `limit` | number | Max sent messages to scan (default: 50) |
| `minDaysWaiting` | number | Only show items older than N days (default: 2) |

**Example:** *"What am I still waiting for a reply on?"*

---

### Status & Health

#### `get-mail-stats`
Return total message counts and recently received message counts per account.

#### `get-sync-status`
Check whether Mail.app is running and how many accounts are configured.

Returns: `running` (boolean), `accountCount` (number).

#### `health-check`
Verify that the MCP server can communicate with Mail.app. Useful for diagnosing connection issues.

---

## Common Workflows

### Morning email triage
> *"Give me a morning briefing — summarise my unread mail and flag anything urgent"*

Claude will use `summarize-inbox` to fetch your messages and produce a prioritised briefing.

---

### Clean up a cluttered inbox
> *"Search for all newsletter emails from the past month and archive them"*

Claude will use `search-messages` to find them, then `batch-archive` to move them all at once.

---

### Catch up on a long thread
> *"Summarise the thread about the Q3 roadmap — I've been away for a week"*

Claude will use `get-thread` to retrieve all messages, then summarise the key decisions and open questions.

---

### Follow up on sent mail
> *"What emails have I sent in the last two weeks that haven't had a reply?"*

Claude will use `detect-waiting-for` to scan your Sent folder and return a ranked list.

---

### Save and reuse a response template
> *"Save this as a template called 'Out of Office': Subject: Out of office, Body: I'm away until..."*  
> Later: *"Send an out-of-office reply to that email using my template"*

---

### Extract and save an attachment
> *"Find the invoice email from Acme Corp and save the PDF to my Desktop"*

Claude will use `search-messages` to find the email, `list-attachments` to identify the file, and `save-attachment` to save it.

---

## Tips & Troubleshooting

### Mail.app must be running
All tools require Mail.app to be open. If you get a "Mail.app not responding" error, open Mail.app and try again.

### Message IDs
Message IDs are numeric strings (e.g. `"12345"`). They are stable within a session but may change if Mail.app rebuilds its database. Always fetch IDs fresh with `list-messages` or `search-messages` before operating on them.

### Multi-account setups
- Most tools accept an optional `account` parameter. Omit it to use your default account.
- Use `list-accounts` to see account names exactly as Mail.app knows them (names are case-sensitive).
- `search-messages` without an `account` searches all accounts.

### Performance
- `allMailboxes: true` on `search-messages` scans every folder — can be slow on large mail stores.
- `includeSnippets: false` on `triage-inbox` and `summarize-inbox` skips body fetching and is significantly faster for large inboxes.
- Message location is cached for 5 minutes — repeated operations on the same message are fast.

### HTML emails
- Pass `isHtml: true` to `send-email` or `create-draft` when your body contains HTML markup.
- Use `preferHtml: true` on `get-message` to receive the raw HTML source of an email.

### Gmail accounts
Gmail uses IMAP labels rather than real folders. `archive-message` moves to the Archive label but may not remove the Inbox label. Use `move-message` to `[Gmail]/All Mail` for reliable archiving on Gmail.

### Templates
Templates are stored at `~/.config/apple-mail-mcp/templates.json`. They persist across server restarts. If you delete this file, all templates are lost.

### Permissions reset
If macOS revokes automation permission, go to **System Settings → Privacy & Security → Automation** and re-enable access for your terminal app to control Mail.

---

## Tool Quick Reference

| Category | Tools |
|----------|-------|
| **Reading** | `list-messages`, `search-messages`, `get-message`, `get-thread`, `get-unread-count`, `get-vip-messages` |
| **Sending** | `send-email`, `create-draft`, `reply-to-message`, `forward-message`, `draft-reply` |
| **Managing** | `mark-as-read`, `mark-as-unread`, `flag-message`, `unflag-message`, `delete-message`, `move-message`, `archive-message`, `move-to-junk`, `mark-as-not-junk` |
| **Batch** | `batch-delete-messages`, `batch-move-messages`, `batch-mark-as-read`, `batch-mark-as-unread`, `batch-flag-messages`, `batch-unflag-messages`, `batch-archive` |
| **Attachments** | `list-attachments`, `save-attachment` |
| **Mailboxes** | `list-mailboxes`, `create-mailbox`, `rename-mailbox`, `delete-mailbox` |
| **Accounts** | `list-accounts` |
| **Rules** | `list-rules`, `enable-rule`, `disable-rule` |
| **Contacts** | `search-contacts` |
| **Templates** | `save-template`, `list-templates`, `get-template`, `use-template`, `delete-template` |
| **Intelligence** | `triage-inbox`, `find-action-items`, `summarize-inbox`, `summarize-thread`, `unsubscribe-helper`, `detect-waiting-for` |
| **Status** | `get-mail-stats`, `get-sync-status`, `health-check` |
| **Config** | `get-config`, `set-config` |
