import { describe, expect, test, vi } from "vitest";

import {
  assetFilename,
  classifyAssetUrl,
  guessAssetExtension,
  isDownloadableAssetUrl,
  localizeArticleAssets
} from "@/lib/assets";
import type { WechatArticle } from "@/lib/types";

function binaryResponse(contentType: string, body = "fake-bytes") {
  return {
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null)
    },
    ok: true,
    status: 200
  } as unknown as Response;
}

function article(html: string): WechatArticle {
  return { html, sourceUrl: "https://mp.weixin.qq.com/s/demo", title: "示例文章" };
}

const baseOptions = { intervalMs: 0, retryBaseMs: 0 };

describe("资源 URL 判定", () => {
  test("只有 http(s) 直链才下载，data 与相对路径跳过", () => {
    expect(isDownloadableAssetUrl("https://mmbiz.qpic.cn/a.png")).toBe(true);
    expect(isDownloadableAssetUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isDownloadableAssetUrl("./assets/a.png")).toBe(false);
  });

  test("识别语音与视频直链，普通链接不当作资源", () => {
    expect(classifyAssetUrl("https://res.wx.qq.com/voice/getvoice?mediaid=x")).toBe("audio");
    expect(classifyAssetUrl("https://mpvideo.qpic.cn/x.mp4")).toBe("video");
    expect(classifyAssetUrl("https://example.com/post")).toBeUndefined();
  });
});

describe("扩展名与文件名", () => {
  test("content-type 优先，其次 wx_fmt，最后路径后缀", () => {
    expect(guessAssetExtension("https://x/a", "image/png; charset=utf-8")).toBe("png");
    expect(guessAssetExtension("https://x/a?wx_fmt=jpeg")).toBe("jpg");
    expect(guessAssetExtension("https://x/a.webp")).toBe("webp");
    expect(guessAssetExtension("https://x/a")).toBe("bin");
  });

  test("同一 URL 生成稳定文件名，不同 URL 不冲突", () => {
    const url = "https://mmbiz.qpic.cn/a?wx_fmt=png";
    expect(assetFilename(url, "png")).toBe(assetFilename(url, "png"));
    expect(assetFilename(url, "png")).not.toBe(assetFilename(`${url}b`, "png"));
    expect(assetFilename(url, ".png")).toMatch(/^[0-9a-f]{16}\.png$/);
  });
});

describe("正文资源本地化", () => {
  test("图片被下载并改写为 ./assets 相对路径", async () => {
    const fetchImpl = vi.fn(async () => binaryResponse("image/png"));
    const result = await localizeArticleAssets({
      ...baseOptions,
      article: article('<p><img src="https://mmbiz.qpic.cn/a?wx_fmt=png" alt="图" /></p>'),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].path).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
    expect(result.article.html).toContain(`./${result.assets[0].path}`);
    expect(result.article.html).not.toContain("mmbiz.qpic.cn");
  });

  test("同一张图在同篇文章里只下载一次", async () => {
    const fetchImpl = vi.fn(async () => binaryResponse("image/jpeg"));
    const url = "https://mmbiz.qpic.cn/same?wx_fmt=jpeg";
    const result = await localizeArticleAssets({
      ...baseOptions,
      article: article(`<img src="${url}" /><img src="${url}" />`),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.assets).toHaveLength(1);
  });

  test("单张图失败不影响其余内容，失败记入 failures 且保留原链接", async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input).includes("bad")
        ? ({ arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null }, ok: false, status: 404 } as unknown as Response)
        : binaryResponse("image/png")
    );
    const result = await localizeArticleAssets({
      ...baseOptions,
      article: article(
        '<img src="https://mmbiz.qpic.cn/bad?wx_fmt=png" /><img src="https://mmbiz.qpic.cn/ok?wx_fmt=png" />'
      ),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0
    });

    expect(result.failures).toHaveLength(1);
    expect(result.assets).toHaveLength(1);
    expect(result.article.html).toContain("https://mmbiz.qpic.cn/bad?wx_fmt=png");
  });

  test("超过体积上限的资源被跳过", async () => {
    const fetchImpl = vi.fn(async () => binaryResponse("image/png", "x".repeat(64)));
    const result = await localizeArticleAssets({
      ...baseOptions,
      article: article('<img src="https://mmbiz.qpic.cn/big?wx_fmt=png" />'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 16,
      maxRetries: 0
    });

    expect(result.assets).toHaveLength(0);
    expect(result.failures[0].error).toContain("超过上限");
  });

  test("音视频默认不下载，开启后才抓", async () => {
    const html = '<a href="https://res.wx.qq.com/voice/getvoice?mediaid=x">语音</a>';
    const off = vi.fn(async () => binaryResponse("audio/mpeg"));
    await localizeArticleAssets({
      ...baseOptions,
      article: article(html),
      fetchImpl: off as unknown as typeof fetch
    });
    expect(off).not.toHaveBeenCalled();

    const on = vi.fn(async () => binaryResponse("audio/mpeg"));
    const result = await localizeArticleAssets({
      ...baseOptions,
      article: article(html),
      downloadMedia: true,
      fetchImpl: on as unknown as typeof fetch
    });
    expect(on).toHaveBeenCalledTimes(1);
    expect(result.assets[0].kind).toBe("audio");
    expect(result.assets[0].path).toMatch(/\.mp3$/);
  });

  test("封面单独本地化并返回相对路径", async () => {
    const fetchImpl = vi.fn(async () => binaryResponse("image/png"));
    const result = await localizeArticleAssets({
      ...baseOptions,
      article: article("<p>无图</p>"),
      cover: "https://mmbiz.qpic.cn/cover?wx_fmt=png",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.coverPath).toMatch(/^\.\/assets\/[0-9a-f]{16}\.png$/);
  });
});
