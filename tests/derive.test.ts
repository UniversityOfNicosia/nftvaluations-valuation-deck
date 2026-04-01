import { describe, expect, it } from "vitest";
import { calculateMedian } from "../src/data/loadCollections.ts";

describe("calculateMedian", () => {
  it("returns the midpoint for odd-length arrays", () => {
    expect(calculateMedian([1, 9, 3])).toBe(3);
  });

  it("returns the average midpoint for even-length arrays", () => {
    expect(calculateMedian([2, 6, 10, 14])).toBe(8);
  });

  it("ignores undefined values", () => {
    expect(calculateMedian([undefined, 4, 10])).toBe(7);
  });
});
