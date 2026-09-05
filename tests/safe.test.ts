import { describe, expect, test } from "vitest";

import {
  parseExportFormat,
  parseSingleArticleExportFormat,
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

  test("accepts every supported format", () => {
    expect(parseExportFormat("markdown")).toBe("markdown");
    expect(parseExportFormat("html")).toBe("html");
    expect(parseExportFormat("pdf")).toBe("pdf");
    expect(parseExportFormat("docx")).toBe("docx");
    expect(parseExportFormat("mhtml")).toBe("mhtml");
    expect(parseExportFormat("csv")).toBe("csv");
  });

  test("rejects anything else", () => {
    expect(() => parseExportFormat("epub")).toThrow(/不支持的导出格式/);
    expect(() => parseExportFormat(123)).toThrow(/不支持的导出格式/);
  });

  test("single article export rejects csv", () => {
    expect(parseSingleArticleExportFormat("pdf")).toBe("pdf");
    expect(() => parseSingleArticleExportFormat("csv")).toThrow(/单篇导出不支持/);
  });
});
