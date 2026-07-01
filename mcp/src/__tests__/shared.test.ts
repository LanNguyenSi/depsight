import { describe, it, expect } from "vitest";
import { ok, errResult } from "../tools/shared.js";

describe("ok", () => {
  it("wraps data as a single text content block with no isError flag", () => {
    const result = ok({ success: true, foo: "bar" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("JSON round-trips the data through content[0].text", () => {
    const data = { a: 1, b: ["x", "y"], c: { nested: true }, d: null };
    const result = ok(data);

    expect(JSON.parse(result.content[0].text)).toEqual(data);
  });
});

describe("errResult", () => {
  it("uses the Error's message and sets isError true", () => {
    const result = errResult(new Error("boom"));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: "boom",
    });
  });

  it("stringifies a non-Error value for the message", () => {
    const result = errResult("plain string failure");

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: "plain string failure",
    });
  });
});
