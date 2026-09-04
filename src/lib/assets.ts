import { createHash } from "node:crypto";

import { backoffDelay, sleep } from "./pacing";
import type { ArticleAsset, LocalizedArticleAssets, WechatArticle } from "./types";

/** 正文里可下载的音频（mpvoice 转出的直链） */
const VOICE_URL_PATTERN = /^https?:\/\/res\.wx\.qq\.com\/voice\/getvoice\b/i;
/** 正文里可下载的视频直链（腾讯视频 iframe 不在此列，它只是预览页） */
const VIDEO_URL_PATTERN = /^https?:\/\/[^\s]*mpvideo\.qpic\.cn\/[^\s]*/i;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4"
};

const WX_FMT_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);

export type AssetKind = "audio" | "image" | "video";

export type DownloadAssetOptions = {
  fetchImpl?: typeof fetch;
  maxBytes: number;
  url: string;
};

export function classifyAssetUrl(url: string): AssetKind | undefined {
  if (VOICE_URL_PATTERN.test(url)) return "audio";
  if (VIDEO_URL_PATTERN.test(url)) return "video";
  return undefined;
}

/** 只处理可直连下载的远程资源；data: 内联与相对路径原样保留 */
export function isDownloadableAssetUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * 资源文件名取 URL 的 sha1 前 16 位，保证：
 * 1）同一张图在多篇文章间只存一份；2）不受微信 URL 里超长查询串影响。
 */
export function assetFilename(url: string, extension: string): string {
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return `${digest}.${extension.replace(/^\.+/, "")}`;
}

export function guessAssetExtension(url: string, contentType?: string): string {
  const normalizedType = contentType?.split(";")[0]?.trim().toLowerCase();
  const fromContentType = normalizedType ? EXTENSION_BY_CONTENT_TYPE[normalizedType] : undefined;

  if (fromContentType) return fromContentType;

  try {
    const wxFmt = new URL(url).searchParams.get("wx_fmt")?.toLowerCase();
    if (wxFmt && WX_FMT_EXTENSIONS.has(wxFmt)) {
      return wxFmt === "jpeg" ? "jpg" : wxFmt;
    }

    const fromPath = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase();
    if (fromPath) return fromPath;
  } catch {
    // URL 解析失败时落到默认扩展名
  }

  if (normalizedType?.startsWith("audio/")) return "mp3";
  if (normalizedType?.startsWith("video/")) return "mp4";

  return "bin";
}

export async function downloadAsset({
  fetchImpl = fetch,
  maxBytes,
  url
}: DownloadAssetOptions): Promise<{ contentType?: string; data: Buffer }> {
  const response = await fetchImpl(url, {
    headers: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      referer: "https://mp.weixin.qq.com/"
    }
  });

  if (!response.ok) {
    throw new Error(`资源下载失败：HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`资源体积 ${declaredLength} 字节超过上限 ${maxBytes} 字节。`);
  }

  const data = Buffer.from(await response.arrayBuffer());

  if (data.byteLength > maxBytes) {
    throw new Error(`资源体积 ${data.byteLength} 字节超过上限 ${maxBytes} 字节。`);
  }

  return { contentType: response.headers?.get?.("content-type") ?? undefined, data };
}

export type LocalizeArticleAssetsOptions = {
  article: WechatArticle;
  /** ZIP 内资源目录名，正文引用写成 `./<dir>/<file>` */
  assetsDir?: string;
  cover?: string;
  /** 音视频默认不下载，体积大且常触发额外风控 */
  downloadMedia?: boolean;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  maxBytes?: number;
  maxRetries?: number;
  onWarning?: (message: string) => void;
  retryBaseMs?: number;
};

/**
 * 把文章正文里的远程资源下载到本地，并把引用改写为 `./assets/xxx` 相对路径。
 *
 * 下载是**串行**的，每次之间 sleep(intervalMs)。图片走 mmbiz.qpic.cn，配额与
 * /cgi-bin/appmsgpublish 大概率独立，但按项目规矩仍然统一限速，禁止并发裸抓。
 */
export async function localizeArticleAssets({
  article,
  assetsDir = "assets",
  cover,
  downloadMedia = false,
  fetchImpl = fetch,
  intervalMs = 300,
  maxBytes = 20 * 1024 * 1024,
  maxRetries = 1,
  onWarning,
  retryBaseMs = 1000
}: LocalizeArticleAssetsOptions): Promise<LocalizedArticleAssets> {
  const assets: ArticleAsset[] = [];
  const failures: Array<{ error: string; url: string }> = [];
  const resolved = new Map<string, string>();
  const skipped = new Set<string>();
  let downloadCount = 0;

  const localize = async (rawUrl: string, kind: AssetKind): Promise<string | undefined> => {
    const url = rawUrl.trim();

    if (!isDownloadableAssetUrl(url)) return undefined;
    if (skipped.has(url)) return undefined;
    if (resolved.has(url)) return resolved.get(url);
    if (kind !== "image" && !downloadMedia) {
      skipped.add(url);
      return undefined;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (downloadCount > 0 || attempt > 0) {
        await sleep(attempt > 0 ? backoffDelay(attempt - 1, retryBaseMs) : intervalMs);
      }

      downloadCount += 1;

      try {
        const { contentType, data } = await downloadAsset({ fetchImpl, maxBytes, url });
        const path = `${assetsDir}/${assetFilename(url, guessAssetExtension(url, contentType))}`;

        assets.push({ contentType, data, kind, path, sourceUrl: url });
        resolved.set(url, `./${path}`);

        return `./${path}`;
      } catch (error) {
        if (attempt < maxRetries) continue;

        const message = error instanceof Error ? error.message : "资源下载失败";
        failures.push({ error: message, url });
        skipped.add(url);
        onWarning?.(`资源下载失败（${message}）：${url}`);
      }
    }

    return undefined;
  };

  const html = await rewriteHtmlAssets(article.html, localize);
  const coverPath = cover ? await localize(cover, "image") : undefined;

  return {
    article: { ...article, html },
    assets,
    coverPath,
    failures
  };
}

/**
 * 用正则而非 cheerio 改写：正文此时已经过 sanitize-html，属性形状可控，
 * 而重新 load/serialize 一次 DOM 会丢掉换行等排版细节。
 */
async function rewriteHtmlAssets(
  html: string,
  localize: (url: string, kind: AssetKind) => Promise<string | undefined>
): Promise<string> {
  const replacements = new Map<string, string>();
  const imageUrls = matchAll(html, /<img\b[^>]*?\bsrc="([^"]+)"/gi);
  const anchorUrls = matchAll(html, /<a\b[^>]*?\bhref="([^"]+)"/gi);

  for (const url of imageUrls) {
    const localPath = await localize(decodeAttribute(url), "image");
    if (localPath) replacements.set(url, localPath);
  }

  for (const url of anchorUrls) {
    const decoded = decodeAttribute(url);
    const kind = classifyAssetUrl(decoded);
    if (!kind) continue;

    const localPath = await localize(decoded, kind);
    if (localPath) replacements.set(url, localPath);
  }

  if (!replacements.size) return html;

  return html.replace(/(\b(?:src|href)=")([^"]+)(")/gi, (match, prefix, url, suffix) => {
    const localPath = replacements.get(url);
    return localPath ? `${prefix}${localPath}${suffix}` : match;
  });
}

function matchAll(html: string, pattern: RegExp): string[] {
  const urls = new Set<string>();

  for (const match of html.matchAll(pattern)) {
    if (match[1]) urls.add(match[1]);
  }

  return [...urls];
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
