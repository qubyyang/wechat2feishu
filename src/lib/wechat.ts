import * as cheerio from "cheerio";
import { existsSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";

import { assertWechatArticleUrl, compactWhitespace } from "./safe";
import type { WechatArticle } from "./types";

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
