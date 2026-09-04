import { describe, expect, test } from "vitest";

import {
  parseExportFormat,
  safeFilenameWithExtension,
  safeHtmlFilename,
  safeMarkdownFilename
} from "@/lib/safe";

describe("safe filename helpers", () => {
  test("creates a markdown filename from an article title", () => {
    expect(safeMarkdownFilename(" A/B: C#D?. ")).toBe("A B C D.md");
  });

  test("creates an html filename from an article title", () => {
    expect(safeHtmlFilename(" A/B: C#D?. ")).toBe("A B C D.html");
  });

  test("builds filenames with a custom extension and tolerates leading dots", () => {
    expect(safeFilenameWithExtension("标题", ".txt")).toBe("标题.txt");
  });

  test("falls back to a default name when the title is empty", () => {
    expect(safeHtmlFilename("???")).toBe("微信文章归档.html");
  });
});

describe("parseExportFormat", () => {
  test("defaults to markdown when unset", () => {
    expect(parseExportFormat(undefined)).toBe("markdown");
    expect(parseExportFormat("")).toBe("markdown");
  });

  test("accepts markdown and html", () => {
    expect(parseExportFormat("markdown")).toBe("markdown");
    expect(parseExportFormat("html")).toBe("html");
  });

  test("rejects anything else", () => {
    expect(() => parseExportFormat("pdf")).toThrow(/markdown 或 html/);
    expect(() => parseExportFormat(123)).toThrow(/markdown 或 html/);
  });
});
