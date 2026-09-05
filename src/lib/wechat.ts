import * as cheerio from "cheerio";
import JSZip from "jszip";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";

import { localizeArticleAssets } from "./assets";
import { launchChromiumPage, resolveChromeExecutable } from "./browser";
import { backoffDelay, sleep } from "./pacing";
import {
  deriveCheckpointId,
  type CheckpointArticle,
  type CheckpointIdentity,
  type CheckpointState,
  type ExportCheckpointStore
} from "./export-checkpoint";
import { buildManifestCsv, renderArticle } from "./renderers";
import {
  assertWechatArticleUrl,
  compactWhitespace,
  exportFormatExtension,
  safeFilenameWithExtension
} from "./safe";
import { markdownToSearchText } from "./search-index";
import type {
  ArticleAsset,
  ExportFormat,
  ExportProgressEvent,
  PerArticleExportFormat,
  WechatArticle,
  WechatPublishedArticle
} from "./types";

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

/** 微信后台返回码：调用太频繁 */
const RET_FREQ_CONTROL = 200013;
/** 微信后台返回码：登录态失效 */
const RET_INVALID_SESSION = 200003;

export class WechatApiError extends Error {
  readonly ret: number;

  constructor(ret: number, message: string) {
    super(message);
    this.name = "WechatApiError";
    this.ret = ret;
  }

  /** 仅频率限制值得重试；登录态失效重试无意义 */
  get retriable(): boolean {
    return this.ret === RET_FREQ_CONTROL || this.ret < 0;
  }
}

function describeWechatApiError(ret: number, errMsg?: string): string {
  if (ret === RET_INVALID_SESSION) {
    return "微信后台登录态已失效（invalid session / 200003）。请重新登录 mp.weixin.qq.com，复制新的 URL token 与 Cookie 到 .env 的 W2F_WECHAT_MP_TOKEN / W2F_WECHAT_MP_COOKIE。";
  }

  if (ret === RET_FREQ_CONTROL) {
    return "微信接口触发频率限制（freq control / 200013）。这不是代码报错，是微信对 /cgi-bin/appmsgpublish 的独立配额被耗尽：请降低批量导出的篇数与频率，等待冷却（通常数分钟，严重时到次日额度重置）后重试。可用 `npm run probe:wechat` 查询当前是否仍在限流。";
  }

  return errMsg?.trim() || `公众号文章列表获取失败（ret=${ret}）。`;
}

export { sleep } from "./pacing";

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
  if (!resolveChromeExecutable()) {
    throw new Error(
      "微信返回了安全验证页。可在 .env 中填写 W2F_CHROME_EXECUTABLE_PATH 启用浏览器抓取回退。"
    );
  }

  try {
    return await launchChromiumPage(
      async (page) => {
        await page.goto(url, { timeout: 45_000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1200);
        const html = await page.content();

        if (html.includes("secitptpage/verify") || html.includes("TCaptcha")) {
          throw new Error("微信浏览器抓取仍遇到安全验证，请稍后重试。");
        }

        return html;
      },
      { userAgent: WECHAT_UA }
    );
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error("浏览器抓取失败。");
  }
}

/** 保留再导出：既有测试直接引用了它，也让调用方不必知道 browser.ts */
export { resolvePlaywrightChromium } from "./browser";

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

const HTML_EXPORT_STYLES = `
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        padding: 2rem 1rem;
        background: #faf9f6;
        color: #262626;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        line-height: 1.75;
      }
      article {
        max-width: 720px;
        margin: 0 auto;
      }
      h1 {
        font-size: 1.6rem;
        line-height: 1.4;
        margin: 0 0 0.75rem;
      }
      .meta {
        color: #78716c;
        font-size: 0.85rem;
        margin: 0.25rem 0;
      }
      .meta a {
        color: #57534e;
      }
      .content {
        margin-top: 1.5rem;
        overflow-wrap: break-word;
      }
      .content img {
        max-width: 100%;
        height: auto;
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #1c1c1c;
          color: #e7e5e4;
        }
        .meta,
        .meta a {
          color: #a8a29e;
        }
      }
`;

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 生成可直接在浏览器打开的 standalone HTML 归档文档 */
export function articleToHtml(article: WechatArticle): string {
  const metaLines = [
    article.author ? `作者：${escapeHtmlText(article.author)}` : undefined,
    article.publishedAt ? `发布时间：${escapeHtmlText(article.publishedAt)}` : undefined
  ].filter(Boolean);
  const metaHtml = metaLines.length ? `<p class="meta">${metaLines.join(" · ")}</p>` : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="source-url" content="${escapeHtmlText(article.sourceUrl)}" />
    <title>${escapeHtmlText(article.title)}</title>
    <style>${HTML_EXPORT_STYLES}    </style>
  </head>
  <body>
    <article>
      <h1>${escapeHtmlText(article.title)}</h1>
      ${metaHtml}
      <p class="meta"><a href="${escapeHtmlText(article.sourceUrl)}" target="_blank" rel="noreferrer">原文链接</a></p>
      <div class="content">
${article.html}
      </div>
    </article>
  </body>
</html>
`;
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

export type WechatArticleFilter = {
  /** 标题关键词，大小写不敏感；多个词之间是「且」的关系 */
  keyword?: string;
  /** 只保留原创文章。列表接口没标原创的条目会被剔除 */
  originalOnly?: boolean;
  /** 发布时间下界（含），ISO 字符串或 YYYY-MM-DD */
  publishedAfter?: string;
  /** 发布时间上界（含当天），ISO 字符串或 YYYY-MM-DD */
  publishedBefore?: string;
};

export type FetchWechatAccountArticlesOptions = WechatAccountCredentials & {
  accountId: string;
  filter?: WechatArticleFilter;
  intervalMs?: number;
  limit?: number;
  maxRetries?: number;
  /** 每翻完一页上报一次已列出的文章数 */
  onProgress?: (event: ExportProgressEvent) => void;
  onWarning?: (message: string) => void;
  pageSize?: number;
  retryBaseMs?: number;
};

/** 把 YYYY-MM-DD 或 ISO 串解析为毫秒时间戳；`endOfDay` 用于让上界包含当天 */
export function parseFilterDate(
  value: string | undefined,
  endOfDay = false
): number | undefined {
  if (!value?.trim()) return undefined;

  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const parsed = new Date(dateOnly && endOfDay ? `${trimmed}T23:59:59.999Z` : trimmed);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析日期：${value}。请使用 YYYY-MM-DD 或完整 ISO 时间。`);
  }

  return parsed.getTime();
}

export function matchesWechatArticleFilter(
  article: WechatPublishedArticle,
  filter: WechatArticleFilter | undefined
): boolean {
  if (!filter) return true;

  if (filter.originalOnly && !article.isOriginal) return false;

  const keyword = filter.keyword?.trim().toLowerCase();
  if (keyword) {
    const title = article.title.toLowerCase();
    if (!keyword.split(/\s+/).every((token) => title.includes(token))) return false;
  }

  const after = parseFilterDate(filter.publishedAfter);
  const before = parseFilterDate(filter.publishedBefore, true);

  if (after === undefined && before === undefined) return true;

  // 没有发布时间的条目无法判定，在启用了时间筛选时一律剔除，避免混入意外结果
  if (!article.publishedAt) return false;

  const publishedAt = new Date(article.publishedAt).getTime();
  if (Number.isNaN(publishedAt)) return false;
  if (after !== undefined && publishedAt < after) return false;
  if (before !== undefined && publishedAt > before) return false;

  return true;
}

export async function fetchWechatAccountArticles({
  accountId,
  cookie,
  filter,
  intervalMs = 3000,
  limit = 20,
  maxRetries = 3,
  onProgress,
  onWarning,
  pageSize = 5,
  retryBaseMs = 6000,
  token
}: FetchWechatAccountArticlesOptions): Promise<WechatPublishedArticle[]> {
  const fakeid = assertWechatAccountId(accountId);
  const max = clampArticleLimit(limit);
  const size = clampPageSize(pageSize);
  // 筛选会让命中率下降，允许多翻几页；但仍设硬上限，避免为一个空筛选把配额翻完
  const pageCap = filter
    ? Math.ceil(max / size) + 20
    : Math.ceil(max / size) + 5;
  const publishedAfter = parseFilterDate(filter?.publishedAfter);
  const articles: WechatPublishedArticle[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (let page = 0; page < pageCap && articles.length < max; page += 1) {
    if (page > 0) {
      await sleep(intervalMs);
    }

    let payload: unknown;

    try {
      payload = await fetchWechatPublishPageWithRetry({
        begin: page * size,
        cookie,
        count: size,
        fakeid,
        maxRetries,
        onWarning,
        retryBaseMs,
        token
      });
    } catch (error) {
      // 已经拿到部分列表时降级返回，避免整批归零
      if (!articles.length) throw error;

      const message = error instanceof Error ? error.message : "未知错误";
      onWarning?.(
        `文章列表在第 ${page + 1} 页中断（${message}）。已保留前 ${articles.length} 篇。`
      );
      break;
    }

    const pageArticles = parseWechatPublishArticles(payload);

    for (const article of pageArticles) {
      if (seen.has(article.url)) continue;

      seen.add(article.url);
      scanned += 1;

      if (!matchesWechatArticleFilter(article, filter)) continue;

      articles.push(article);

      if (articles.length >= max) break;
    }

    // 列表按发布时间倒序，整页都早于时间下界时继续翻页只会浪费配额
    if (publishedAfter !== undefined && isPageEntirelyBefore(pageArticles, publishedAfter)) {
      onWarning?.(`已翻到早于起始日期的文章，提前结束列表抓取（共扫描 ${scanned} 篇）。`);
      break;
    }

    // 总量取决于还能翻多少页，翻页途中无法确定，因此只报 current
    onProgress?.({
      current: articles.length,
      message: `已列出 ${articles.length} 篇文章（扫描 ${scanned} 篇）`,
      stage: "listing"
    });

    if (pageArticles.length < size) break;
  }

  return articles;
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(Math.max(Math.floor(value), 1), 20);
}

/** 整页都早于时间下界时可以提前收工（列表按发布时间倒序） */
function isPageEntirelyBefore(
  pageArticles: WechatPublishedArticle[],
  publishedAfter: number
): boolean {
  if (!pageArticles.length) return false;

  return pageArticles.every((article) => {
    if (!article.publishedAt) return false;

    const timestamp = new Date(article.publishedAt).getTime();
    return Number.isFinite(timestamp) && timestamp < publishedAfter;
  });
}

async function fetchWechatPublishPageWithRetry({
  maxRetries,
  onWarning,
  retryBaseMs,
  ...options
}: Parameters<typeof fetchWechatPublishPage>[0] & {
  maxRetries: number;
  onWarning?: (message: string) => void;
  retryBaseMs: number;
}): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1, retryBaseMs);
      onWarning?.(`微信接口限流，${Math.round(delay / 1000)}s 后第 ${attempt + 1} 次重试…`);
      await sleep(delay);
    }

    try {
      return await fetchWechatPublishPage(options);
    } catch (error) {
      lastError = error;

      if (!(error instanceof WechatApiError) || !error.retriable) throw error;
      if (attempt === maxRetries) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("公众号文章列表获取失败。");
}

function clampArticleLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.floor(value), 1), 100);
}

async function fetchWechatPublishPage({
  begin,
  cookie,
  count = 5,
  fakeid,
  token
}: {
  begin: number;
  cookie: string;
  count?: number;
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
    count: String(count),
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
      referer: url.toString(),
      "user-agent": WECHAT_UA
    }
  });

  if (!response.ok) {
    throw new WechatApiError(
      response.status === 429 ? RET_FREQ_CONTROL : -1,
      `公众号文章列表获取失败：HTTP ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    base_resp?: { err_msg?: string; ret?: number };
  };
  const ret = payload.base_resp?.ret;

  if (typeof ret === "number" && ret !== 0) {
    throw new WechatApiError(ret, describeWechatApiError(ret, payload.base_resp?.err_msg));
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
    copyright_type: record.copyright_type,
    cover: record.cover,
    create_time: record.create_time ?? record.update_time,
    is_original: record.is_original,
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
    isOriginal: parseIsOriginal(record),
    publishedAt: timestampToIso(record.create_time ?? record.update_time),
    title: title ? compactWhitespace(title) : undefined,
    url: rawUrl ? decodeHtmlEntities(rawUrl) : undefined
  };
}

/**
 * 微信在不同接口版本里用过多个字段表达原创：`is_original`（0/1）与
 * `copyright_type`（1 表示原创）。两个都不存在时返回 undefined 表示「未知」，
 * 由调用方决定是否当作非原创处理。
 */
function parseIsOriginal(record: Record<string, unknown>): boolean | undefined {
  const isOriginal = record.is_original;
  if (typeof isOriginal === "boolean") return isOriginal;
  if (typeof isOriginal === "number") return isOriginal === 1;
  if (typeof isOriginal === "string" && isOriginal.trim()) return isOriginal.trim() === "1";

  const copyrightType = record.copyright_type;
  if (typeof copyrightType === "number") return copyrightType === 1;
  if (typeof copyrightType === "string" && copyrightType.trim()) {
    return copyrightType.trim() === "1";
  }

  return undefined;
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

export type BuildWechatAccountZipOptions = {
  accountId: string;
  articles: WechatPublishedArticle[];
  /** ZIP 内资源目录名 */
  assetsDir?: string;
  /** 资源下载间隔，独立于正文抓取间隔 */
  assetIntervalMs?: number;
  assetMaxBytes?: number;
  /**
   * 断点续传。传入后每抓完一篇立即落盘，重试时命中的分片直接从磁盘复用，
   * 既不打微信接口也不参与限速等待。
   */
  checkpoint?: {
    identity: CheckpointIdentity;
    state: CheckpointState;
    store: ExportCheckpointStore;
  };
  convert?: typeof fetchAndConvertWechatArticle;
  /** 是否把正文图片等资源下载进 ZIP */
  downloadAssets?: boolean;
  downloadMedia?: boolean;
  format?: ExportFormat;
  intervalMs?: number;
  /** 每篇文章处理完毕后上报一次进度 */
  onProgress?: (event: ExportProgressEvent) => void;
  onWarning?: (message: string) => void;
};

export async function buildWechatAccountZip({
  accountId,
  articles,
  assetIntervalMs = 300,
  assetMaxBytes = 20 * 1024 * 1024,
  assetsDir = "assets",
  checkpoint,
  convert = fetchAndConvertWechatArticle,
  downloadAssets = true,
  downloadMedia = false,
  format = "markdown",
  intervalMs = 1200,
  onProgress,
  onWarning
}: BuildWechatAccountZipOptions): Promise<{
  archived: Array<{ filename: string; publishedAt?: string; title: string; url: string }>;
  /** 供全文检索索引使用的正文纯文本，正文已在此处拿到，不需要事后再抓一次 */
  documents: Array<{ publishedAt?: string; text: string; title: string; url: string }>;
  assetCount: number;
  failureCount: number;
  /** 本次从检查点复用、未重新抓取的文章数 */
  resumedCount: number;
  successCount: number;
  zip: Buffer;
}> {
  const zip = new JSZip();
  const documents: Array<{ publishedAt?: string; text: string; title: string; url: string }> = [];
  const failures: Array<{ error: string; title: string; url: string }> = [];
  const writtenAssets = new Set<string>();
  let resumedCount = 0;
  const manifest: Array<{
    assetCount?: number;
    coverPath?: string;
    filename?: string;
    publishedAt?: string;
    status: "failed" | "success";
    title: string;
    url: string;
  }> = [];

  for (const [index, listedArticle] of articles.entries()) {
    // 检查点命中：内容已在磁盘上，既不打接口也无需限速等待
    const cached = checkpoint?.state.articles[listedArticle.url];

    if (cached && cached.status === "success" && cached.filename) {
      const restored = await restoreFromCheckpoint({
        cached,
        checkpoint,
        format,
        zip,
        writtenAssets
      });

      if (restored) {
        resumedCount += 1;
        documents.push({
          publishedAt: cached.publishedAt,
          text: cached.searchText,
          title: cached.title,
          url: cached.url
        });
        manifest.push({
          assetCount: cached.assetPaths.length,
          filename: format === "csv" ? undefined : cached.filename,
          publishedAt: cached.publishedAt,
          status: "success",
          title: cached.title,
          url: cached.url
        });
        onProgress?.({
          current: index + 1,
          failed: failures.length,
          message: `已复用 ${index + 1}/${articles.length} 篇：${cached.title}`,
          stage: "article",
          total: articles.length
        });
        continue;
      }
    }

    // 正文页同样有频控，逐篇限速，首篇不延迟
    if (index > 0) {
      await sleep(intervalMs);
    }

    try {
      const converted = await convert(listedArticle.url);
      let article = converted.article;
      let markdown = converted.markdown;
      let coverPath: string | undefined;
      let articleAssets: ArticleAsset[] = [];

      if (downloadAssets) {
        const localized = await localizeArticleAssets({
          article,
          assetsDir,
          cover: listedArticle.cover,
          downloadMedia,
          intervalMs: assetIntervalMs,
          maxBytes: assetMaxBytes,
          onWarning
        });

        article = localized.article;
        // 只有正文确实被改写过才重新生成 Markdown，避免丢掉上游 convert 的产物
        if (localized.article.html !== converted.article.html) {
          markdown = articleToMarkdown(article);
        }
        coverPath = localized.coverPath;
        articleAssets = localized.assets;

        for (const asset of localized.assets) {
          if (writtenAssets.has(asset.path)) continue;

          writtenAssets.add(asset.path);
          zip.file(asset.path, asset.data);
        }
      }

      // csv 是整批汇总，不产出单篇文件；此时正文仍按 markdown 渲染以填充清单
      const perArticleFormat: PerArticleExportFormat =
        format === "csv" ? "markdown" : format;
      const rendered = await renderArticle({
        article,
        assets: articleAssets,
        format: perArticleFormat,
        html: articleToHtml(article),
        markdown
      });
      const filename = numberedArticleFilename(index + 1, article.title, perArticleFormat);

      if (format !== "csv") {
        zip.file(filename, rendered);
      }

      documents.push({
        publishedAt: listedArticle.publishedAt,
        text: markdownToSearchText(markdown),
        title: article.title,
        url: article.sourceUrl
      });

      // 抓一篇存一篇。攒到最后再写等于把「中断即全丢」的问题原样搬回来
      if (checkpoint) {
        await checkpoint.store.recordArticle({
          article: {
            assetPaths: articleAssets.map((asset) => asset.path),
            filename,
            publishedAt: listedArticle.publishedAt,
            searchText: markdownToSearchText(markdown),
            status: "success",
            title: article.title,
            url: listedArticle.url
          },
          assets: articleAssets.map((asset) => ({ data: asset.data, path: asset.path })),
          identity: checkpoint.identity,
          rendered: Buffer.isBuffer(rendered) ? rendered : Buffer.from(rendered),
          state: checkpoint.state
        });
      }

      manifest.push({
        assetCount: articleAssets.length,
        coverPath,
        filename: format === "csv" ? undefined : filename,
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

    // 无论成败都上报，前端才能看到进度条持续推进而不是卡在失败那一篇
    onProgress?.({
      current: index + 1,
      failed: failures.length,
      message: `已处理 ${index + 1}/${articles.length} 篇：${listedArticle.title}`,
      stage: "article",
      total: articles.length
    });
  }

  onProgress?.({
    current: articles.length,
    failed: failures.length,
    message: "正在打包 ZIP…",
    stage: "packaging",
    total: articles.length
  });

  // csv 是整批汇总表，作为 ZIP 里唯一的产物
  if (format === "csv") {
    zip.file(
      "articles.csv",
      buildManifestCsv(
        manifest.map((item) => ({
          assetCount: item.assetCount,
          error: failures.find((failure) => failure.url === item.url)?.error,
          filename: item.filename,
          publishedAt: item.publishedAt,
          status: item.status,
          title: item.title,
          url: item.url
        }))
      )
    );
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
        assetCount: writtenAssets.size,
        assetsDir: downloadAssets ? assetsDir : undefined,
        format,
        generatedAt: new Date().toISOString(),
        items: manifest
      },
      null,
      2
    )
  );

  return {
    documents,
    archived: manifest
      .filter((item) => item.status === "success")
      .map((item) => ({
        filename: item.filename ?? "",
        publishedAt: item.publishedAt,
        title: item.title,
        url: item.url
      })),
    assetCount: writtenAssets.size,
    failureCount: failures.length,
    resumedCount,
    successCount: manifest.filter((item) => item.status === "success").length,
    zip: await zip.generateAsync({ type: "nodebuffer" })
  };
}

/**
 * 从检查点还原一篇文章的产物。
 *
 * 任何一块缺失（渲染结果或某个资源）都返回 false，让调用方回退到重新抓取——
 * 拿半份内容拼出的 ZIP 比重抓一次更糟：用户拿到的是一个看似成功、实则缺图的包。
 */
async function restoreFromCheckpoint(options: {
  cached: CheckpointArticle;
  checkpoint: NonNullable<BuildWechatAccountZipOptions["checkpoint"]>;
  format: ExportFormat;
  writtenAssets: Set<string>;
  zip: JSZip;
}): Promise<boolean> {
  const { cached, checkpoint, format, writtenAssets, zip } = options;
  const checkpointId = deriveCheckpointId(checkpoint.identity);

  if (!cached.filename) return false;

  const rendered = await checkpoint.store.readArticle(checkpointId, cached.filename);
  if (!rendered) return false;

  const restoredAssets: Array<{ data: Buffer; path: string }> = [];

  for (const assetPath of cached.assetPaths) {
    if (writtenAssets.has(assetPath)) continue;

    const data = await checkpoint.store.readAsset(checkpointId, assetPath);
    if (!data) return false;

    restoredAssets.push({ data, path: assetPath });
  }

  // 全部就位后再写入 zip，避免中途返回 false 时留下半份资源
  for (const asset of restoredAssets) {
    writtenAssets.add(asset.path);
    zip.file(asset.path, asset.data);
  }

  if (format !== "csv") {
    zip.file(cached.filename, rendered);
  }

  return true;
}

function numberedArticleFilename(
  index: number,
  title: string,
  format: PerArticleExportFormat
): string {
  const filename = safeFilenameWithExtension(title, exportFormatExtension(format));

  return `${String(index).padStart(3, "0")}-${filename}`;
}
