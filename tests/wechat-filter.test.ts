import { afterEach, describe, expect, test, vi } from "vitest";

import {
  fetchWechatAccountArticles,
  matchesWechatArticleFilter,
  parseFilterDate,
  parseWechatPublishArticles
} from "@/lib/wechat";
import type { WechatPublishedArticle } from "@/lib/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function article(
  overrides: Partial<WechatPublishedArticle> & { title: string }
): WechatPublishedArticle {
  return { url: `https://mp.weixin.qq.com/s/${overrides.title}`, ...overrides };
}

function jsonResponse(payload: unknown) {
  return { json: async () => payload, ok: true, status: 200 } as unknown as Response;
}

/** 构造一页列表，日期从 base 起逐日递减，模拟微信的倒序返回 */
function pagePayload(
  entries: Array<{ createTime: number; isOriginal?: number; title: string }>
) {
  return {
    base_resp: { err_msg: "ok", ret: 0 },
    publish_page: JSON.stringify({
      publish_list: entries.map((entry) => ({
        publish_info: JSON.stringify({
          appmsgex: [
            {
              create_time: entry.createTime,
              is_original: entry.isOriginal,
              link: `https://mp.weixin.qq.com/s/${entry.title}`,
              title: entry.title
            }
          ]
        })
      }))
    })
  };
}

describe("parseFilterDate", () => {
  test("YYYY-MM-DD 的上界包含当天最后一毫秒", () => {
    expect(parseFilterDate("2026-09-04")).toBe(Date.parse("2026-09-04T00:00:00.000Z"));
    expect(parseFilterDate("2026-09-04", true)).toBe(
      Date.parse("2026-09-04T23:59:59.999Z")
    );
  });

  test("空值返回 undefined，非法值抛出可读错误", () => {
    expect(parseFilterDate(undefined)).toBeUndefined();
    expect(parseFilterDate("   ")).toBeUndefined();
    expect(() => parseFilterDate("昨天")).toThrow("无法解析日期");
  });
});

describe("matchesWechatArticleFilter", () => {
  const sample = article({
    isOriginal: true,
    publishedAt: "2026-06-15T00:00:00.000Z",
    title: "AI 算力 硬件周报"
  });

  test("没有筛选条件时全部通过", () => {
    expect(matchesWechatArticleFilter(sample, undefined)).toBe(true);
    expect(matchesWechatArticleFilter(sample, {})).toBe(true);
  });

  test("关键词大小写不敏感，多词之间是「且」", () => {
    expect(matchesWechatArticleFilter(sample, { keyword: "ai" })).toBe(true);
    expect(matchesWechatArticleFilter(sample, { keyword: "AI 周报" })).toBe(true);
    expect(matchesWechatArticleFilter(sample, { keyword: "AI 芯片" })).toBe(false);
  });

  test("时间区间为闭区间", () => {
    expect(
      matchesWechatArticleFilter(sample, {
        publishedAfter: "2026-06-15",
        publishedBefore: "2026-06-15"
      })
    ).toBe(true);
    expect(matchesWechatArticleFilter(sample, { publishedAfter: "2026-06-16" })).toBe(false);
    expect(matchesWechatArticleFilter(sample, { publishedBefore: "2026-06-14" })).toBe(false);
  });

  test("启用时间筛选后，缺发布时间的文章被剔除", () => {
    const undated = article({ title: "无日期" });

    expect(matchesWechatArticleFilter(undated, {})).toBe(true);
    expect(matchesWechatArticleFilter(undated, { publishedAfter: "2020-01-01" })).toBe(false);
  });

  test("originalOnly 会剔除非原创与原创状态未知的条目", () => {
    expect(matchesWechatArticleFilter(sample, { originalOnly: true })).toBe(true);
    expect(
      matchesWechatArticleFilter(article({ isOriginal: false, title: "转载" }), {
        originalOnly: true
      })
    ).toBe(false);
    expect(
      matchesWechatArticleFilter(article({ title: "未知" }), { originalOnly: true })
    ).toBe(false);
  });
});

describe("原创标记解析", () => {
  test("同时识别 is_original 与 copyright_type，都缺失时为 undefined", () => {
    const [original, copyright, unknown] = parseWechatPublishArticles({
      app_msg_list: [
        { create_time: 1, is_original: 1, link: "https://mp.weixin.qq.com/s/a", title: "a" },
        { copyright_type: 1, create_time: 2, link: "https://mp.weixin.qq.com/s/b", title: "b" },
        { create_time: 3, link: "https://mp.weixin.qq.com/s/c", title: "c" }
      ]
    });

    expect(original.isOriginal).toBe(true);
    expect(copyright.isOriginal).toBe(true);
    expect(unknown.isOriginal).toBeUndefined();
  });
});

describe("fetchWechatAccountArticles 的筛选行为", () => {
  test("关键词不匹配的文章不计入 limit，会继续翻页补足", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          pagePayload([
            { createTime: 1750000000, title: "周报-A" },
            { createTime: 1749900000, title: "杂谈-B" }
          ])
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          pagePayload([
            { createTime: 1749800000, title: "杂谈-C" },
            { createTime: 1749700000, title: "周报-D" }
          ])
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const articles = await fetchWechatAccountArticles({
      accountId: "Mzk5MDcyODQ2Mw==",
      cookie: "cookie",
      filter: { keyword: "周报" },
      intervalMs: 0,
      limit: 2,
      pageSize: 2,
      retryBaseMs: 0,
      token: "token"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(articles.map((item) => item.title)).toEqual(["周报-A", "周报-D"]);
  });

  test("整页都早于起始日期时提前结束翻页，不再消耗配额", async () => {
    const warnings: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          pagePayload([
            { createTime: Math.floor(Date.parse("2026-06-20T00:00:00Z") / 1000), title: "新" },
            { createTime: Math.floor(Date.parse("2026-06-19T00:00:00Z") / 1000), title: "次新" }
          ])
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          pagePayload([
            { createTime: Math.floor(Date.parse("2026-01-02T00:00:00Z") / 1000), title: "旧1" },
            { createTime: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000), title: "旧2" }
          ])
        )
      )
      .mockResolvedValue(jsonResponse(pagePayload([])));
    vi.stubGlobal("fetch", fetchMock);

    const articles = await fetchWechatAccountArticles({
      accountId: "Mzk5MDcyODQ2Mw==",
      cookie: "cookie",
      filter: { publishedAfter: "2026-06-01" },
      intervalMs: 0,
      limit: 50,
      onWarning: (message) => warnings.push(message),
      pageSize: 2,
      retryBaseMs: 0,
      token: "token"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(articles.map((item) => item.title)).toEqual(["新", "次新"]);
    expect(warnings.join()).toContain("提前结束列表抓取");
  });

  test("筛选后一篇都没命中时返回空数组，而不是抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(pagePayload([{ createTime: 1750000000, title: "杂谈" }])))
    );

    await expect(
      fetchWechatAccountArticles({
        accountId: "Mzk5MDcyODQ2Mw==",
        cookie: "cookie",
        filter: { keyword: "周报" },
        intervalMs: 0,
        limit: 5,
        pageSize: 2,
        retryBaseMs: 0,
        token: "token"
      })
    ).resolves.toEqual([]);
  });
});
