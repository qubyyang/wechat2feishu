import { describe, expect, test } from "vitest";

import { safeMarkdownFilename } from "@/lib/safe";

describe("safe filename helpers", () => {
  test("creates a markdown filename from an article title", () => {
    expect(safeMarkdownFilename(" A/B: C#D?. ")).toBe("A B C D.md");
  });
});
