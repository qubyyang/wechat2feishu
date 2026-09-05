import JSZip from "jszip";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildWechatAccountZip,
  extractWechatAccountId,
  extractWechatAccountIdFromHtml,
  fetchWechatAccountArticles,
  parseWechatPublishArticles,
  WechatApiError
} from "@/lib/wechat";

function jsonResponse(payload: unknown, status = 200) {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status
  } as unknown as Response;
}

function pagePayload(titles: string[], total = titles.length) {
  return {
    base_resp: { err_msg: "ok", ret: 0 },
    publish_page: JSON.stringify({
      publish_list: titles.map((title, index) => ({
        publish_info: JSON.stringify({
          appmsgex: [
            { create_time: 1710000000 + index, link: `https://mp.weixin.qq.com/s/${title}`, title }
          ]
        })
      })),
      total_count: total
    })
  };
}

function freqControlResponse() {
  return jsonResponse({ base_resp: { err_msg: "freq control", ret: 200013 } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const publishResponse = {
  publish_page: JSON.stringify({
    total_count: 3,
    publish_list: [
      {
        publish_info: JSON.stringify({
          appmsgex: [
            {
              aid: "1",
              cover: "https://example.com/cover-a.png",
              create_time: 1710000000,
              link: "https://mp.weixin.qq.com/s/a",
              title: "第一篇"
            },
            {
              aid: "2",
              cover: "https://example.com/cover-b.png",
              create_time: 1710000100,
              link: "https://mp.weixin.qq.com/s/b",
              title: "第二篇"
            }
          ]
        })
      },
      {
        publish_info: JSON.stringify({
          appmsgex: [
            {
              aid: "3",
              create_time: 1710000200,
              link: "https://mp.weixin.qq.com/s/c",
              title: "第三篇"
            }
          ]
        })
      }
    ]
  })
};

describe("WeChat account helpers", () => {
  test("extracts the account id from a canonical article URL", async () => {
    const accountId = await extractWechatAccountId(
      "https://mp.weixin.qq.com/s?__biz=Mzk5MDcyODQ2Mw==&mid=123&idx=1"
    );

    expect(accountId).toBe("Mzk5MDcyODQ2Mw==");
  });

  test("extracts the account id from article html for short links", () => {
    const html = `
      <html>
        <script>var biz = "Mzk5MDcyODQ2Mw==";</script>
        <a href="/s?__biz=ignored">ignored</a>
      </html>
    `;

    expect(extractWechatAccountIdFromHtml(html)).toBe("Mzk5MDcyODQ2Mw==");
  });

  test("parses appmsgpublish payloads into article links", () => {
    expect(parseWechatPublishArticles(publishResponse)).toEqual([
      {
        cover: "https://example.com/cover-a.png",
        publishedAt: "2024-03-09T16:00:00.000Z",
        title: "第一篇",
        url: "https://mp.weixin.qq.com/s/a"
      },
      {
        cover: "https://example.com/cover-b.png",
        publishedAt: "2024-03-09T16:01:40.000Z",
        title: "第二篇",
        url: "https://mp.weixin.qq.com/s/b"
      },
      {
        cover: undefined,
        publishedAt: "2024-03-09T16:03:20.000Z",
        title: "第三篇",
        url: "https://mp.weixin.qq.com/s/c"
      }
    ]);
  });

  test("builds a zip of markdown files and records failed articles", async () => {
    const convert = vi
      .fn()
      .mockResolvedValueOnce({
        article: {
          html: "<p>ok</p>",
          sourceUrl: "https://mp.weixin.qq.com/s/a",
          title: "第一篇"
        },
        markdown: "第一篇内容"
      })
      .mockRejectedValueOnce(new Error("安全验证"))
      .mockResolvedValueOnce({
        article: {
          html: "<p>ok</p>",
          sourceUrl: "https://mp.weixin.qq.com/s/c",
          title: "第三篇"
        },
        markdown: "第三篇内容"
      });

    const result = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles: parseWechatPublishArticles(publishResponse),
      convert,
      downloadAssets: false,
      intervalMs: 0
    });
    const zip = await JSZip.loadAsync(result.zip);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(Object.keys(zip.files).sort()).toEqual([
      "001-第一篇.md",
      "003-第三篇.md",
      "_errors.md",
      "manifest.json"
    ]);
    await expect(zip.file("001-第一篇.md")?.async("string")).resolves.toBe(
      "第一篇内容"
    );
    await expect(zip.file("_errors.md")?.async("string")).resolves.toContain(
      "安全验证"
    );
  });

  test("reports per-article progress and a final packaging event", async () => {
    const convert = vi
      .fn()
      .mockResolvedValueOnce({
        article: {
          html: "<p>ok</p>",
          sourceUrl: "https://mp.weixin.qq.com/s/a",
          title: "第一篇"
        },
        markdown: "第一篇内容"
      })
      .mockRejectedValueOnce(new Error("触发了安全验证"))
      .mockResolvedValueOnce({
        article: {
          html: "<p>ok</p>",
          sourceUrl: "https://mp.weixin.qq.com/s/c",
          title: "第三篇"
        },
        markdown: "第三篇内容"
      });
    const events: Array<{ current?: number; failed?: number; stage: string }> = [];

    await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles: parseWechatPublishArticles(publishResponse),
      convert,
      downloadAssets: false,
      intervalMs: 0,
      onProgress: (event) =>
        events.push({ current: event.current, failed: event.failed, stage: event.stage })
    });

    // 失败的第二篇同样要推进计数，否则前端进度条会卡住
    expect(events).toEqual([
      { current: 1, failed: 0, stage: "article" },
      { current: 2, failed: 1, stage: "article" },
      { current: 3, failed: 1, stage: "article" },
      { current: 3, failed: 1, stage: "packaging" }
    ]);
  });

  test("builds a zip of standalone html files when format is html", async () => {
    const convert = vi.fn().mockResolvedValue({
      article: {
        html: "<p>正文内容</p>",
        sourceUrl: "https://mp.weixin.qq.com/s/a",
        title: "第一篇"
      },
      markdown: "不该被使用"
    });

    const result = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles: parseWechatPublishArticles(publishResponse).slice(0, 1),
      convert,
      downloadAssets: false,
      format: "html",
      intervalMs: 0
    });
    const zip = await JSZip.loadAsync(result.zip);

    expect(result.successCount).toBe(1);
    expect(Object.keys(zip.files).sort()).toEqual([
      "001-第一篇.html",
      "manifest.json"
    ]);
    await expect(zip.file("001-第一篇.html")?.async("string")).resolves.toContain(
      "<!doctype html>"
    );
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.format).toBe("html");
    expect(manifest.items[0].filename).toBe("001-第一篇.html");
  });

  test("开启资源本地化时图片进 assets/ 目录且正文改为相对路径", async () => {
    const convert = vi.fn().mockResolvedValue({
      article: {
        html: '<p><img src="https://mmbiz.qpic.cn/pic?wx_fmt=png" /></p>',
        sourceUrl: "https://mp.weixin.qq.com/s/a",
        title: "第一篇"
      },
      markdown: "占位"
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer,
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        ok: true,
        status: 200
      }))
    );

    const result = await buildWechatAccountZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles: parseWechatPublishArticles(publishResponse).slice(0, 1),
      assetIntervalMs: 0,
      convert,
      intervalMs: 0
    });
    const zip = await JSZip.loadAsync(result.zip);
    const names = Object.keys(zip.files).sort();

    expect(result.assetCount).toBeGreaterThanOrEqual(1);
    expect(names.some((name) => /^assets\/[0-9a-f]{16}\.png$/.test(name))).toBe(true);
    await expect(zip.file("001-第一篇.md")?.async("string")).resolves.toContain("./assets/");
  });
});

describe("WeChat appmsgpublish 频控处理", () => {
  const credentials = { cookie: "cookie", token: "token" };

  test("遇到 freq control 会退避重试，成功后继续抓取", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(freqControlResponse())
      .mockResolvedValueOnce(jsonResponse(pagePayload(["a", "b"])));
    vi.stubGlobal("fetch", fetchMock);

    const articles = await fetchWechatAccountArticles({
      ...credentials,
      accountId: "Mzk5MDcyODQ2Mw==",
      intervalMs: 0,
      limit: 2,
      maxRetries: 2,
      retryBaseMs: 0
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(articles.map((article) => article.title)).toEqual(["a", "b"]);
  });

  test("重试耗尽后抛出包含 200013 说明的错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(freqControlResponse()));

    await expect(
      fetchWechatAccountArticles({
        ...credentials,
        accountId: "Mzk5MDcyODQ2Mw==",
        intervalMs: 0,
        maxRetries: 1,
        retryBaseMs: 0
      })
    ).rejects.toThrow(/200013/);
  });

  test("登录态失效（200003）不重试，提示重新登录", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ base_resp: { err_msg: "invalid session", ret: 200003 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWechatAccountArticles({
        ...credentials,
        accountId: "Mzk5MDcyODQ2Mw==",
        intervalMs: 0,
        maxRetries: 3,
        retryBaseMs: 0
      })
    ).rejects.toThrow(WechatApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("中途持续限流时降级返回已抓到的部分列表", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pagePayload(["a", "b"], 10)))
      .mockResolvedValue(freqControlResponse());
    vi.stubGlobal("fetch", fetchMock);
    const warnings: string[] = [];

    const articles = await fetchWechatAccountArticles({
      ...credentials,
      accountId: "Mzk5MDcyODQ2Mw==",
      intervalMs: 0,
      limit: 10,
      maxRetries: 0,
      onWarning: (message) => warnings.push(message),
      pageSize: 2
    });

    expect(articles.map((article) => article.title)).toEqual(["a", "b"]);
    expect(warnings.join("\n")).toContain("第 2 页中断");
  });

  test("分页之间按配置的间隔限速", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pagePayload(["a", "b"], 10)))
      .mockResolvedValueOnce(jsonResponse(pagePayload(["c"], 10)));
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = Date.now();
    await fetchWechatAccountArticles({
      ...credentials,
      accountId: "Mzk5MDcyODQ2Mw==",
      intervalMs: 120,
      limit: 10,
      pageSize: 2
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });
});
