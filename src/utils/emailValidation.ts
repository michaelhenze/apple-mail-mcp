import { z } from "zod";

/**
 * Validates an email address, accepting both bare addresses and display-name format.
 *
 * Accepts:
 *   user@example.com                  (bare RFC 5321 address)
 *   "John Doe <john@example.com>"     (display-name format used by Mail.app)
 *
 * Does NOT use z.string().email() because Zod v3's built-in email validator
 * rejects display-name format per RFC 5321, but Mail.app documents and accepts
 * this format for all send operations.
 */
export const emailAddressSchema = z.string().refine(
  (addr) => {
    // Extract address from "Name <addr@domain>" format if present
    const angleMatch = addr.match(/<([^>]+)>$/);
    const emailPart = angleMatch ? angleMatch[1] : addr.trim();
    // Require: non-whitespace-non-at chars @ non-whitespace-non-at chars . non-whitespace-non-at chars
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPart);
  },
  { message: "Invalid email address format" }
);
