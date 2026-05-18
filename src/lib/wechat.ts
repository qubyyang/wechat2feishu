import * as cheerio from "cheerio";
import JSZip from "jszip";
import { existsSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";

import {
  assertWechatArticleUrl,
  compactWhitespace,
  safeMarkdownFilename
} from "./safe";
import type { WechatArticle, WechatPublishedArticle } from "./types";

const WECHAT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49";

const noiseSelectors = [
  "script",
  "style",
  "iframe",
  "noscript",
  ".advertisement",
  ".js_ad_area",
  ".js_ad_link",
  ".rich_media_tool",
  ".reward_area",
  ".profile_container",
  "mp-common-profile",
  "[data-type='ad']"
];

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9+/_=-]{8,}$/;
const APPMSGPUBLISH_ENDPOINT = "https://mp.weixin.qq.com/cgi-bin/appmsgpublish";

function readMetaVar(html: string, name: string): string | undefined {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*['"]([^'"]*)['"]`));
  return match?.[1] ? compactWhitespace(decodeHtmlEntities(match[1])) : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function fetchWechatHtml(url: string): Promise<string> {
  assertWechatArticleUrl(url);

  const response = await fetch(url, {
    headers: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      "user-agent": WECHAT_UA
    }
  });

  if (!response.ok) {
    throw new Error(`公众号页面抓取失败：HTTP ${response.status}`);
  }

  const html = await response.text();
  if (html.includes("secitptpage/verify") || html.includes("TCaptcha")) {
    return fetchWechatHtmlWithBrowser(url);
  }

  return html;
}

async function fetchWechatHtmlWithBrowser(url: string): Promise<string> {
  const executablePath = resolveChromeExecutable();

  if (!executablePath) {
    throw new Error(
      "微信返回了安全验证页。可在 .env 中填写 W2F_CHROME_EXECUTABLE_PATH 启用浏览器抓取回退。"
    );
  }

  try {
    const { chromium } = await importPlaywright();
    const browser = await chromium.launch({
      executablePath,
      headless: true
    });

    try {
      const page = await browser.newPage({ userAgent: WECHAT_UA });
      await page.goto(url, { timeout: 45_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const html = await page.content();

      if (html.includes("secitptpage/verify") || html.includes("TCaptcha")) {
        throw new Error("微信浏览器抓取仍遇到安全验证，请稍后重试。");
      }

      return html;
    } finally {
      await browser.close();
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error("浏览器抓取失败。");
  }
}

function resolveChromeExecutable(): string | undefined {
  const configured = process.env.W2F_CHROME_EXECUTABLE_PATH?.trim();
  if (configured) {
    return configured;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

async function importPlaywright(): Promise<{
  chromium: {
    launch(options: {
      executablePath: string;
      headless: boolean;
    }): Promise<{
      close(): Promise<void>;
      newPage(options: {
        userAgent: string;
      }): Promise<{
        content(): Promise<string>;
        goto(
          url: string,
          options: { timeout: number; waitUntil: "domcontentloaded" }
        ): Promise<unknown>;
        waitForTimeout(timeout: number): Promise<void>;
      }>;
    }>;
  };
}> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<unknown>;

  return dynamicImport("playwright-core") as ReturnType<typeof importPlaywright>;
}

export function extractWechatArticle(html: string, sourceUrl: string): WechatArticle {
  const $ = cheerio.load(html);
  const content = $("#js_content").first();

  if (!content.length) {
    throw new Error("没有在页面中找到公众号正文区域。");
  }

  content.find(noiseSelectors.join(",")).remove();
  content.find("img").each((_, node) => {
    const image = $(node);
    const src = image.attr("data-src") ?? image.attr("src") ?? "";
    const normalizedSrc = decodeHtmlEntities(src).replace(/&amp;/g, "&");

    if (normalizedSrc) {
      image.attr("src", normalizedSrc);
    }

    image.removeAttr("data-src");
    image.removeAttr("srcset");
    image.removeAttr("style");
  });
  content.find("*").each((_, node) => {
    const element = $(node);
    element.removeAttr("style");
    element.removeAttr("class");
    element.removeAttr("id");
    element.removeAttr("data-tool");
    element.removeAttr("data-pm-slice");
  });

  const title =
    compactWhitespace($("#activity-name").first().text()) ||
    readMetaVar(html, "msg_title") ||
    "未命名公众号文章";
  const author =
    compactWhitespace($("#js_name").first().text()) ||
    readMetaVar(html, "nickname") ||
    undefined;
  const publishedAt =
    compactWhitespace($("#publish_time").first().text()) ||
    readMetaVar(html, "ct") ||
    undefined;

  const cleaned = sanitizeHtml(content.html() ?? "", {
    allowedAttributes: {
      a: ["href", "name", "target"],
      img: ["alt", "src", "title"]
    },
    allowedSchemes: ["data", "http", "https"],
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "article",
      "figure",
      "figcaption",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "img",
      "section",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr"
    ],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank" })
    }
  });

  return {
    author,
    html: cleaned,
    publishedAt,
    sourceUrl,
    title
  };
}

export function articleToMarkdown(article: WechatArticle): string {
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx"
  });

  const body = turndown.turndown(article.html).replace(/\n{3,}/g, "\n\n").trim();
  const metadata = [
    article.author ? `作者：${article.author}` : undefined,
    article.publishedAt ? `发布时间：${article.publishedAt}` : undefined,
    `原文链接：${article.sourceUrl}`,
    "",
    "---",
    ""
  ].filter(Boolean);

  return `${metadata.join("\n")}\n${body}\n`;
}

export async function fetchAndConvertWechatArticle(url: string): Promise<{
  article: WechatArticle;
  markdown: string;
}> {
  const normalizedUrl = assertWechatArticleUrl(url).toString();
  const html = await fetchWechatHtml(normalizedUrl);
  const article = extractWechatArticle(html, normalizedUrl);
  const markdown = articleToMarkdown(article);

  return { article, markdown };
}

export function assertWechatAccountId(value: string): string {
  const accountId = value.trim();

  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("请输入有效的公众号 ID（通常是文章链接中的 __biz 参数）。");
  }

  return accountId;
}

export function extractWechatAccountIdFromHtml(html: string): string {
  const fromMetaVar = readMetaVar(html, "biz");
  if (fromMetaVar) {
    return assertWechatAccountId(fromMetaVar);
  }

  const patterns = [
    /__biz=([A-Za-z0-9%+/_=-]+)/,
    /["']__biz["']\s*:\s*["']([^"']+)["']/,
    /biz\s*:\s*["']([^"']+)["']/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const raw = match?.[1];
    if (!raw) continue;

    return assertWechatAccountId(decodeURIComponent(decodeHtmlEntities(raw)));
  }

  throw new Error("没有在文章页面中找到公众号 ID。");
}

export async function extractWechatAccountId(url: string): Promise<string> {
  const normalizedUrl = assertWechatArticleUrl(url);
  const fromUrl = normalizedUrl.searchParams.get("__biz");

  if (fromUrl) {
    return assertWechatAccountId(fromUrl);
  }

  const html = await fetchWechatHtml(normalizedUrl.toString());
  return extractWechatAccountIdFromHtml(html);
}

export type WechatAccountCredentials = {
  cookie: string;
  token: string;
};

export type FetchWechatAccountArticlesOptions = WechatAccountCredentials & {
  accountId: string;
  limit?: number;
};

export async function fetchWechatAccountArticles({
  accountId,
  cookie,
  limit = 20,
  token
}: FetchWechatAccountArticlesOptions): Promise<WechatPublishedArticle[]> {
  const fakeid = assertWechatAccountId(accountId);
  const max = clampArticleLimit(limit);
  const articles: WechatPublishedArticle[] = [];
  const seen = new Set<string>();

  for (let begin = 0; articles.length < max; begin += 5) {
    const payload = await fetchWechatPublishPage({
      begin,
      cookie,
      fakeid,
      token
    });
    const pageArticles = parseWechatPublishArticles(payload);

    for (const article of pageArticles) {
      if (seen.has(article.url)) continue;

      seen.add(article.url);
      articles.push(article);

      if (articles.length >= max) break;
    }

    if (pageArticles.length < 5) break;
  }

  return articles;
}

function clampArticleLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.floor(value), 1), 100);
}

async function fetchWechatPublishPage({
  begin,
  cookie,
  fakeid,
  token
}: {
  begin: number;
  cookie: string;
  fakeid: string;
  token: string;
}): Promise<unknown> {
  if (!token.trim() || !cookie.trim()) {
    throw new Error(
      "请先在 .env 中填写 W2F_WECHAT_MP_TOKEN 和 W2F_WECHAT_MP_COOKIE。"
    );
  }

  const url = new URL(APPMSGPUBLISH_ENDPOINT);
  const params: Record<string, string> = {
    ajax: "1",
    begin: String(begin),
    count: "5",
    f: "json",
    fakeid,
    free_publish_type: "1",
    lang: "zh_CN",
    query: "",
    search_field: "null",
    sub: "list",
    sub_action: "list_ex",
    token,
    type: "101_1"
  };

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      cookie,
      "user-agent": WECHAT_UA
    }
  });

  if (!response.ok) {
    throw new Error(`公众号文章列表获取失败：HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    base_resp?: { err_msg?: string; ret?: number };
  };
  const ret = payload.base_resp?.ret;

  if (typeof ret === "number" && ret !== 0) {
    throw new Error(payload.base_resp?.err_msg ?? "公众号文章列表获取失败。");
  }

  return payload;
}

export function parseWechatPublishArticles(payload: unknown): WechatPublishedArticle[] {
  const root = asRecord(payload);
  const appMsgList = root.app_msg_list;

  if (Array.isArray(appMsgList)) {
    return appMsgList.map(parseLegacyArticle).filter(isWechatPublishedArticle);
  }

  const publishPage = parseMaybeJson(root.publish_page);
  const publishList = asRecord(publishPage).publish_list;

  if (!Array.isArray(publishList)) {
    return [];
  }

  return publishList
    .flatMap((item) => {
      const publishInfo = parseMaybeJson(asRecord(item).publish_info);
      const appmsgex = asRecord(publishInfo).appmsgex;

      if (!Array.isArray(appmsgex)) return [];

      return appmsgex.map(parsePublishedArticle);
    })
    .filter(isWechatPublishedArticle);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseLegacyArticle(value: unknown): Partial<WechatPublishedArticle> {
  const record = asRecord(value);

  return parsePublishedArticle({
    cover: record.cover,
    create_time: record.create_time ?? record.update_time,
    link: record.link,
    title: record.title
  });
}

function parsePublishedArticle(value: unknown): Partial<WechatPublishedArticle> {
  const record = asRecord(value);
  const rawUrl = stringValue(record.link) ?? stringValue(record.url);
  const title = stringValue(record.title);

  return {
    cover: stringValue(record.cover),
    publishedAt: timestampToIso(record.create_time ?? record.update_time),
    title: title ? compactWhitespace(title) : undefined,
    url: rawUrl ? decodeHtmlEntities(rawUrl) : undefined
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampToIso(value: unknown): string | undefined {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;

  return new Date(timestamp * 1000).toISOString();
}

function isWechatPublishedArticle(
  value: Partial<WechatPublishedArticle>
): value is WechatPublishedArticle {
  return Boolean(value.title && value.url);
}

export type BuildWechatAccountMarkdownZipOptions = {
  accountId: string;
  articles: WechatPublishedArticle[];
  convert?: typeof fetchAndConvertWechatArticle;
};

export async function buildWechatAccountMarkdownZip({
  accountId,
  articles,
  convert = fetchAndConvertWechatArticle
}: BuildWechatAccountMarkdownZipOptions): Promise<{
  failureCount: number;
  successCount: number;
  zip: Buffer;
}> {
  const zip = new JSZip();
  const failures: Array<{ error: string; title: string; url: string }> = [];
  const manifest: Array<{
    filename?: string;
    publishedAt?: string;
    status: "failed" | "success";
    title: string;
    url: string;
  }> = [];

  for (const [index, listedArticle] of articles.entries()) {
    try {
      const { article, markdown } = await convert(listedArticle.url);
      const filename = numberedMarkdownFilename(index + 1, article.title);
      zip.file(filename, markdown);
      manifest.push({
        filename,
        publishedAt: listedArticle.publishedAt,
        status: "success",
        title: article.title,
        url: article.sourceUrl
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "下载失败";
      failures.push({
        error: message,
        title: listedArticle.title,
        url: listedArticle.url
      });
      manifest.push({
        publishedAt: listedArticle.publishedAt,
        status: "failed",
        title: listedArticle.title,
        url: listedArticle.url
      });
    }
  }

  if (failures.length) {
    zip.file(
      "_errors.md",
      failures
        .map((failure) => `- ${failure.title}\n  - ${failure.url}\n  - ${failure.error}`)
        .join("\n")
    );
  }

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        accountId: assertWechatAccountId(accountId),
        articleCount: articles.length,
        generatedAt: new Date().toISOString(),
        items: manifest
      },
      null,
      2
    )
  );

  return {
    failureCount: failures.length,
    successCount: manifest.filter((item) => item.status === "success").length,
    zip: await zip.generateAsync({ type: "nodebuffer" })
  };
}

function numberedMarkdownFilename(index: number, title: string): string {
  const filename = safeMarkdownFilename(title);
  const stem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;

  return `${String(index).padStart(3, "0")}-${stem}.md`;
}
