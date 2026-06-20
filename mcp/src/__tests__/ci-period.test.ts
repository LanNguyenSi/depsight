import { describe, it, expect } from "vitest";
import { ciPeriodSchema } from "../tools/ci.js";

describe("CI period schema", () => {
  it("accepts numeric literal 1", () => {
    expect(ciPeriodSchema.parse(1)).toBe(1);
  });

  it("accepts numeric literal 7", () => {
    expect(ciPeriodSchema.parse(7)).toBe(7);
  });

  it("accepts numeric literal 30", () => {
    expect(ciPeriodSchema.parse(30)).toBe(30);
  });

  it("accepts undefined (optional)", () => {
    expect(ciPeriodSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects string '30' (old enum form)", () => {
    expect(() => ciPeriodSchema.parse("30")).toThrow();
  });

  it("rejects arbitrary number like 14", () => {
    expect(() => ciPeriodSchema.parse(14)).toThrow();
  });
});
