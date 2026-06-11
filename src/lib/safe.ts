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

export function safeMarkdownFilename(value: string): string {
  const title = safeDocumentTitle(value).replace(/[.\s]+$/g, "").trim();

  return `${title || "微信文章归档"}.md`;
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
