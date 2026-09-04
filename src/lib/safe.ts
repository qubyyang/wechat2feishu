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

export function parseExportFormat(value: unknown): ExportFormat {
  if (value === undefined || value === null || value === "") return "markdown";
  if (value === "html" || value === "markdown") return value;

  throw new Error("不支持的导出格式，仅支持 markdown 或 html。");
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
