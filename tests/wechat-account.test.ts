import JSZip from "jszip";
import { describe, expect, test, vi } from "vitest";

import {
  buildWechatAccountMarkdownZip,
  extractWechatAccountId,
  extractWechatAccountIdFromHtml,
  parseWechatPublishArticles
} from "@/lib/wechat";

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

    const result = await buildWechatAccountMarkdownZip({
      accountId: "Mzk5MDcyODQ2Mw==",
      articles: parseWechatPublishArticles(publishResponse),
      convert
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
});
