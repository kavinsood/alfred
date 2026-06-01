import { describe, it, expect } from "vitest";
import {
  expectString,
  expectFiniteNumber,
  expectEnum,
  parsePosition,
  parseOperator,
} from "../operator-parse.js";

describe("expectString", () => {
  it("accepts non-empty string", () => {
    expect(expectString("hello", "test")).toBe("hello");
  });

  it("rejects undefined", () => {
    expect(() => expectString(undefined, "test")).toThrow("must be a non-empty string");
  });

  it("rejects empty string", () => {
    expect(() => expectString("", "test")).toThrow("must be a non-empty string");
  });

  it("rejects whitespace-only string", () => {
    expect(() => expectString("   ", "test")).toThrow("must be a non-empty string");
  });

  it("rejects number", () => {
    expect(() => expectString(42, "test")).toThrow("must be a non-empty string");
  });

  it("rejects null", () => {
    expect(() => expectString(null, "test")).toThrow("must be a non-empty string");
  });
});

describe("expectFiniteNumber", () => {
  it("accepts integer", () => {
    expect(expectFiniteNumber(5, "test")).toBe(5);
  });

  it("accepts float", () => {
    expect(expectFiniteNumber(3.14, "test")).toBe(3.14);
  });

  it("accepts zero", () => {
    expect(expectFiniteNumber(0, "test")).toBe(0);
  });

  it("rejects string '3' (no coercion)", () => {
    expect(() => expectFiniteNumber("3", "test")).toThrow("must be a finite number");
  });

  it("rejects NaN", () => {
    expect(() => expectFiniteNumber(NaN, "test")).toThrow("must be a finite number");
  });

  it("rejects Infinity", () => {
    expect(() => expectFiniteNumber(Infinity, "test")).toThrow("must be a finite number");
  });

  it("rejects null (no coercion to 0)", () => {
    expect(() => expectFiniteNumber(null, "test")).toThrow("must be a finite number");
  });

  it("rejects empty string (no coercion to 0)", () => {
    expect(() => expectFiniteNumber("", "test")).toThrow("must be a finite number");
  });

  it("rejects boolean true (no coercion to 1)", () => {
    expect(() => expectFiniteNumber(true, "test")).toThrow("must be a finite number");
  });

  it("rejects undefined", () => {
    expect(() => expectFiniteNumber(undefined, "test")).toThrow("must be a finite number");
  });
});

describe("expectEnum", () => {
  const ROLES = ["intro", "thesis", "section_lead"] as const;

  it("accepts valid enum value", () => {
    expect(expectEnum("intro", "test", ROLES)).toBe("intro");
  });

  it("rejects invalid enum value", () => {
    expect(() => expectEnum("paragraph", "test", ROLES)).toThrow("must be one of");
  });

  it("rejects undefined", () => {
    expect(() => expectEnum(undefined, "test", ROLES)).toThrow("must be one of");
  });

  it("rejects number", () => {
    expect(() => expectEnum(1, "test", ROLES)).toThrow("must be one of");
  });
});

describe("parsePosition", () => {
  it("accepts kind=after with paragraph_id", () => {
    expect(parsePosition({ kind: "after", paragraph_id: "p1" }, "test")).toEqual({
      kind: "after",
      paragraph_id: "p1",
    });
  });

  it("accepts kind=at where=start", () => {
    expect(parsePosition({ kind: "at", where: "start" }, "test")).toEqual({
      kind: "at",
      where: "start",
    });
  });

  it("accepts kind=at where=end", () => {
    expect(parsePosition({ kind: "at", where: "end" }, "test")).toEqual({
      kind: "at",
      where: "end",
    });
  });

  it("rejects null", () => {
    expect(() => parsePosition(null, "test")).toThrow("must be an object");
  });

  it("rejects undefined", () => {
    expect(() => parsePosition(undefined, "test")).toThrow("must be an object");
  });

  it("rejects missing kind", () => {
    expect(() => parsePosition({ paragraph_id: "p1" }, "test")).toThrow('must be "after" or "at"');
  });

  it("rejects kind=after with empty paragraph_id", () => {
    expect(() => parsePosition({ kind: "after", paragraph_id: "" }, "test")).toThrow(
      "must be a non-empty string"
    );
  });

  it("rejects kind=at with invalid where", () => {
    expect(() => parsePosition({ kind: "at", where: "middle" }, "test")).toThrow(
      'must be "start" or "end"'
    );
  });

  it("rejects unknown kind (no silent default to end)", () => {
    expect(() => parsePosition({ kind: "before", paragraph_id: "p1" }, "test")).toThrow(
      'must be "after" or "at"'
    );
  });
});

describe("parseOperator", () => {
  it("parses valid split", () => {
    expect(parseOperator("split", { paragraph_id: "p1", after_sentence_index: 2 })).toEqual({
      kind: "split",
      paragraph_id: "p1",
      after_sentence_index: 2,
    });
  });

  it("parses valid delete", () => {
    expect(parseOperator("delete", { paragraph_id: "p1" })).toEqual({
      kind: "delete",
      paragraph_id: "p1",
    });
  });

  it("parses valid move", () => {
    expect(parseOperator("move", {
      paragraph_id: "p1",
      target_position: { kind: "at", where: "start" },
    })).toEqual({
      kind: "move",
      paragraph_id: "p1",
      target_position: { kind: "at", where: "start" },
    });
  });

  it("throws on unknown operator name", () => {
    expect(() => parseOperator("explode", { paragraph_id: "p1" })).toThrow(
      'unknown tool name "explode"'
    );
  });

  it("throws on split with string index (no coercion)", () => {
    expect(() => parseOperator("split", { paragraph_id: "p1", after_sentence_index: "2" })).toThrow(
      "must be a finite number"
    );
  });

  it("throws on hoist with invalid target_role", () => {
    expect(() => parseOperator("hoist", {
      paragraph_id: "p1",
      target_role: "paragraph",
      target_position: { kind: "at", where: "start" },
    })).toThrow("must be one of");
  });
});
