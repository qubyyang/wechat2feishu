import { describe, expect, test } from "vitest";

import {
  articleToMarkdown,
  extractWechatArticle,
  resolvePlaywrightChromium
} from "@/lib/wechat";

const sampleWechatHtml = `
<!doctype html>
<html>
  <head><title>ignored</title></head>
  <body>
    <h1 id="activity-name">  极致打磨，让微信灵感瞬时归档。 </h1>
    <span id="js_name">AI 编程瓜哥</span>
    <em id="publish_time">2026年1月13日 09:49</em>
    <div id="js_content">
      <p>第一段正文，带有 <strong>重点</strong>。</p>
      <section class="advertisement">广告位</section>
      <p>第二段正文。</p>
      <img data-src="https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png" alt="产品截图" />
      <script>window.bad = true</script>
    </div>
  </body>
</html>
`;

describe("WeChat article extraction", () => {
  test("extracts article metadata and cleans noisy nodes", () => {
    const article = extractWechatArticle(sampleWechatHtml, "https://mp.weixin.qq.com/s/demo");

    expect(article.title).toBe("极致打磨，让微信灵感瞬时归档。");
    expect(article.author).toBe("AI 编程瓜哥");
    expect(article.sourceUrl).toBe("https://mp.weixin.qq.com/s/demo");
    expect(article.html).toContain("第一段正文");
    expect(article.html).toContain("https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png");
    expect(article.html).not.toContain("广告位");
    expect(article.html).not.toContain("window.bad");
  });

  test("converts a cleaned article to markdown with source attribution", () => {
    const article = extractWechatArticle(sampleWechatHtml, "https://mp.weixin.qq.com/s/demo");
    const markdown = articleToMarkdown(article);

    expect(markdown).not.toContain("# 极致打磨，让微信灵感瞬时归档。");
    expect(markdown.startsWith("作者：AI 编程瓜哥")).toBe(true);
    expect(markdown).toContain("作者：AI 编程瓜哥");
    expect(markdown).toContain("第一段正文，带有 **重点**。");
    expect(markdown).toContain("![产品截图](https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png)");
    expect(markdown).toContain("原文链接：https://mp.weixin.qq.com/s/demo");
  });
});

describe("playwright-core 加载兼容", () => {
  const chromium = { launch: () => Promise.resolve({}) };

  test("兼容 CJS default 导出的形状", () => {
    expect(resolvePlaywrightChromium({ default: { chromium } })).toBe(chromium);
  });

  test("兼容具名导出的形状", () => {
    expect(resolvePlaywrightChromium({ chromium })).toBe(chromium);
  });

  test("缺失时返回 undefined 而不是抛错", () => {
    expect(resolvePlaywrightChromium({})).toBeUndefined();
    expect(resolvePlaywrightChromium(undefined)).toBeUndefined();
  });
});
