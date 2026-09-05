import type { ExportFormat } from "./types";

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function safeDocumentTitle(value: string): string {
  const cleaned = compactWhitespace(value)
    .replace(/[\\/:*?"<>|#%{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (cleaned || "微信文章归档").slice(0, 80);
}

export function safeFilenameWithExtension(value: string, extension: string): string {
  const title = safeDocumentTitle(value).replace(/[.\s]+$/g, "").trim();
  const normalizedExtension = extension.replace(/^\.+/, "");

  return `${title || "微信文章归档"}.${normalizedExtension}`;
}

export function safeMarkdownFilename(value: string): string {
  return safeFilenameWithExtension(value, "md");
}

export function safeHtmlFilename(value: string): string {
  return safeFilenameWithExtension(value, "html");
}

const EXPORT_FORMATS: readonly ExportFormat[] = [
  "csv",
  "docx",
  "html",
  "markdown",
  "mhtml",
  "pdf"
];

/** 单篇导出不支持 csv：csv 是整批文章的汇总表，没有"单篇 csv"的语义 */
const SINGLE_ARTICLE_FORMATS: readonly ExportFormat[] = EXPORT_FORMATS.filter(
  (format) => format !== "csv"
);

export function parseExportFormat(value: unknown): ExportFormat {
  if (value === undefined || value === null || value === "") return "markdown";
  if (EXPORT_FORMATS.includes(value as ExportFormat)) return value as ExportFormat;

  throw new Error(`不支持的导出格式，仅支持 ${EXPORT_FORMATS.join(" / ")}。`);
}

export function parseSingleArticleExportFormat(value: unknown): ExportFormat {
  const format = parseExportFormat(value);

  if (!SINGLE_ARTICLE_FORMATS.includes(format)) {
    throw new Error(
      `单篇导出不支持 ${format} 格式，仅支持 ${SINGLE_ARTICLE_FORMATS.join(" / ")}。`
    );
  }

  return format;
}

export function exportFormatExtension(format: ExportFormat): string {
  return format === "markdown" ? "md" : format;
}

export function assertWechatArticleUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入有效的微信公众号文章链接。");
  }

  const isWechatHost =
    url.hostname === "mp.weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com");
  const looksLikeArticle =
    url.pathname.startsWith("/s/") || url.searchParams.has("__biz");

  if (!isWechatHost || !looksLikeArticle) {
    throw new Error("当前只支持 mp.weixin.qq.com 的公众号文章链接。");
  }

  return url;
}
