import { describe, it, expect } from "vitest";
import { homedir } from "os";
import { validateSavePath } from "@/utils/pathSecurity.js";
import { emailAddressSchema } from "@/utils/emailValidation.js";

// =============================================================================
// validateSavePath tests
// =============================================================================

describe("validateSavePath", () => {
  it("accepts path under home directory", () => {
    const home = homedir();
    expect(() => validateSavePath(`${home}/Downloads/file.pdf`)).not.toThrow();
  });

  it("returns normalized path", () => {
    const home = homedir();
    expect(validateSavePath(`${home}/Downloads/file.pdf`)).toBe(`${home}/Downloads/file.pdf`);
  });

  it("accepts /tmp paths", () => {
    expect(() => validateSavePath("/tmp/attachment.pdf")).not.toThrow();
  });

  it("expands ~/", () => {
    const result = validateSavePath("~/Downloads");
    expect(result).toBe(`${homedir()}/Downloads`);
  });

  it("rejects traversal sequences (../../etc/passwd)", () => {
    expect(() => validateSavePath("../../etc/passwd")).toThrow("must be absolute");
  });

  it("rejects absolute traversal outside home (/var/db/something)", () => {
    expect(() => validateSavePath("/var/db/something")).toThrow("outside allowed directories");
  });

  it("rejects empty string", () => {
    expect(() => validateSavePath("")).toThrow();
  });

  it("rejects /etc/passwd", () => {
    expect(() => validateSavePath("/etc/passwd")).toThrow("outside allowed directories");
  });

  it("rejects traversal from absolute path to escape home", () => {
    const home = homedir();
    // e.g. /Users/alice/../../../etc/passwd resolves outside home
    expect(() => validateSavePath(`${home}/../../../etc/passwd`)).toThrow(
      "outside allowed directories"
    );
  });
});

// =============================================================================
// emailAddressSchema tests
// =============================================================================

describe("emailAddressSchema", () => {
  const valid = (addr: string) => emailAddressSchema.safeParse(addr).success;

  it("accepts plain address", () => {
    expect(valid("user@example.com")).toBe(true);
  });

  it("accepts display-name format", () => {
    expect(valid("John Doe <john@example.com>")).toBe(true);
  });

  it("accepts subdomain address", () => {
    expect(valid("user@mail.example.co.uk")).toBe(true);
  });

  it("rejects missing @", () => {
    expect(valid("notanemail")).toBe(false);
  });

  it("rejects missing domain", () => {
    expect(valid("user@")).toBe(false);
  });

  it("rejects no TLD", () => {
    expect(valid("user@example")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(valid("")).toBe(false);
  });

  it("rejects @ only", () => {
    expect(valid("@nodomain")).toBe(false);
  });
});

// =============================================================================
// Message ID validation regex tests
// =============================================================================

describe("Message ID validation regex", () => {
  const ID_REGEX = /^\d+$/;

  it("accepts numeric ID", () => {
    expect(ID_REGEX.test("12345")).toBe(true);
  });

  it("accepts large numeric ID", () => {
    expect(ID_REGEX.test("4294967295")).toBe(true); // max uint32
  });

  it("rejects injection payload", () => {
    expect(ID_REGEX.test("0 or 1 is 1")).toBe(false);
  });

  it("rejects semicolon injection payload", () => {
    expect(ID_REGEX.test("1; delete every message")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(ID_REGEX.test("")).toBe(false);
  });

  it("rejects alphanumeric", () => {
    expect(ID_REGEX.test("abc123")).toBe(false);
  });

  it("rejects floating point", () => {
    expect(ID_REGEX.test("1.5")).toBe(false);
  });
});

// =============================================================================
// Safe delimiter constants tests
// =============================================================================

describe("Safe delimiter constants", () => {
  const FIELD_SEP = "";
  const RECORD_SEP = "";

  it("FIELD_SEP does not appear in typical email subject", () => {
    const subject = "Re: Meeting tomorrow — Q1 recap | notes | action items";
    expect(subject.includes(FIELD_SEP)).toBe(false);
  });

  it("RECORD_SEP does not appear in typical sender name", () => {
    const sender = "John O'Brien <john@example.com>";
    expect(sender.includes(RECORD_SEP)).toBe(false);
  });

  it("splitting on RECORD_SEP then FIELD_SEP parses expected fields", () => {
    const id = "12345";
    const subject = "Subject with | pipe chars";
    const sender = "Sender|||Name"; // would have broken old delimiter
    const record = `${id}${FIELD_SEP}${subject}${FIELD_SEP}${sender}`;
    const output = record; // single-record output

    const items = output.split(RECORD_SEP);
    const parts = items[0].split(FIELD_SEP);

    expect(parts[0]).toBe(id);
    expect(parts[1]).toBe(subject);
    expect(parts[2]).toBe(sender);
  });

  it("FIELD_SEP is at Unicode code point U+E001", () => {
    expect(FIELD_SEP.codePointAt(0)).toBe(0xe001);
  });

  it("RECORD_SEP is at Unicode code point U+E002", () => {
    expect(RECORD_SEP.codePointAt(0)).toBe(0xe002);
  });
});
