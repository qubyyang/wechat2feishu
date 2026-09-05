import JSZip from "jszip";
import { describe, expect, test, vi } from "vitest";

import {
  articleToDocx,
  articleToMhtml,
  buildManifestCsv,
  encodeMimeHeader,
  htmlToPdf,
  inlineAssetsAsDataUris,
  isPerArticleFormat,
  markdownToDocxBlocks,
  renderArticle,
  setPdfRenderer,
  toQuotedPrintable
} from "@/lib/renderers";
import type { ArticleAsset, WechatArticle } from "@/lib/types";

/** 最小合法 PNG 头，够 probeImage 读出尺寸即可 */
function pngFixture(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}

const article: WechatArticle = {
  author: "作者甲",
  html: "<h2>小标题</h2><p>正文一段</p>",
  publishedAt: "2026-09-04T00:00:00.000Z",
  sourceUrl: "https://mp.weixin.qq.com/s/demo",
  title: "测试文章"
};

function asset(overrides: Partial<ArticleAsset> = {}): ArticleAsset {
  return {
    contentType: "image/png",
    data: Buffer.from("png-bytes"),
    kind: "image",
    path: "assets/abcd1234.png",
    sourceUrl: "https://mmbiz.qpic.cn/a?wx_fmt=png",
    ...overrides
  };
}

describe("quoted-printable 编码", () => {
  test("ASCII 原样保留，等号本身被转义", () => {
    expect(toQuotedPrintable("a=b")).toBe("a=3Db");
  });

  test("中文按 UTF-8 逐字节转义", () => {
    expect(toQuotedPrintable("中")).toBe("=E4=B8=AD");
  });

  test("长行按 76 字符折行，续行以 = 结尾", () => {
    const lines = toQuotedPrintable("x".repeat(200)).split("\r\n");

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((line) => line.endsWith("="))).toBe(true);
    expect(lines.every((line) => line.length <= 76)).toBe(true);
  });
});

describe("encodeMimeHeader", () => {
  test("纯 ASCII 不编码，含中文走 RFC 2047 base64", () => {
    expect(encodeMimeHeader("Plain Title")).toBe("Plain Title");
    expect(encodeMimeHeader("中文标题")).toBe(
      `=?UTF-8?B?${Buffer.from("中文标题", "utf8").toString("base64")}?=`
    );
  });
});

describe("MHTML 拼接", () => {
  test("内嵌已下载资源，不再联网，且 Content-Location 与正文相对路径一致", () => {
    const image = asset();
    const mhtml = articleToMhtml({
      article,
      assets: [image],
      html: `<img src="./${image.path}" />`
    });

    expect(mhtml).toContain('Content-Type: multipart/related; type="text/html"');
    expect(mhtml).toContain(`Content-Location: ./${image.path}`);
    expect(mhtml).toContain(image.data.toString("base64"));
    expect(mhtml).toContain("Content-Transfer-Encoding: base64");
  });

  test("boundary 出现在每个分段与结束标记上", () => {
    const mhtml = articleToMhtml({ article, assets: [asset()], html: "<p>hi</p>" });
    const boundary = mhtml.match(/boundary="([^"]+)"/)?.[1];

    expect(boundary).toBeTruthy();
    expect(mhtml.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    expect(mhtml.split(`--${boundary}`).length - 1).toBe(3); // html + 资源 + 结束
  });

  test("没有资源时仍是合法的单段 multipart", () => {
    const mhtml = articleToMhtml({ article, assets: [], html: "<p>hi</p>" });

    expect(mhtml).toContain("Content-Type: text/html; charset=UTF-8");
    expect(mhtml).not.toContain("Content-Transfer-Encoding: base64");
  });
});

describe("Markdown → DOCX 块结构", () => {
  test("识别标题、列表、引用与段落，忽略分隔线与空行", () => {
    expect(
      markdownToDocxBlocks("# 一级\n\n## 二级\n\n- 项目\n\n1. 有序\n\n> 引用\n\n---\n\n正文")
    ).toEqual([
      { kind: "heading", level: "Heading1", text: "一级" },
      { kind: "heading", level: "Heading2", text: "二级" },
      { kind: "listItem", ordered: false, text: "项目" },
      { kind: "listItem", ordered: true, text: "有序" },
      { kind: "quote", text: "引用" },
      { kind: "paragraph", text: "正文" }
    ]);
  });

  test("行内标记被剥离：夹在文字里的图片丢弃、链接保留文字", () => {
    expect(markdownToDocxBlocks("**粗** 与 *斜* 和 `码`")).toEqual([
      { kind: "paragraph", text: "粗 与 斜 和 码" }
    ]);
    expect(markdownToDocxBlocks("![图](a.png)看[链接](https://x)")).toEqual([
      { kind: "paragraph", text: "看链接" }
    ]);
  });

  test("独占一行的图片升级为图片块，保留 alt 与路径", () => {
    expect(markdownToDocxBlocks("正文\n\n![配图](./assets/a.png)\n\n后记")).toEqual([
      { kind: "paragraph", text: "正文" },
      { alt: "配图", kind: "image", src: "./assets/a.png" },
      { kind: "paragraph", text: "后记" }
    ]);
  });

  test("图片可以没有 alt，也可以带 title", () => {
    expect(markdownToDocxBlocks('![](a.png)')).toEqual([
      { alt: "", kind: "image", src: "a.png" }
    ]);
    expect(markdownToDocxBlocks('![图](a.png "标题")')).toEqual([
      { alt: "图", kind: "image", src: "a.png" }
    ]);
  });
});

describe("DOCX 生成", () => {
  test("产出可识别的 docx（zip 魔数）且包含正文", async () => {
    const buffer = await articleToDocx(article);

    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  test("把已下载的图片内嵌进 word/media，并保留正文前后顺序", async () => {
    const buffer = await articleToDocx(
      {
        html: '<p>前言</p><img src="./assets/a.png" alt="配图" /><p>后记</p>',
        sourceUrl: "https://mp.weixin.qq.com/s/img",
        title: "带图文章"
      },
      [
        {
          contentType: "image/png",
          data: pngFixture(800, 400),
          kind: "image",
          path: "assets/a.png",
          sourceUrl: "https://mmbiz.qpic.cn/a"
        }
      ]
    );
    const zip = await JSZip.loadAsync(buffer);
    // zip 里同时存在 "word/media/" 目录项，只数真实文件
    const media = Object.entries(zip.files).filter(
      ([name, entry]) => name.startsWith("word/media/") && !entry.dir
    );
    const document = await zip.file("word/document.xml")?.async("string");

    expect(media).toHaveLength(1);
    expect(document).toContain("<w:drawing>");
    expect(document).toContain("前言");
    expect(document).toContain("后记");
    // 800px 宽被压到正文宽度 600px，等比后高 300px；docx 以 EMU 记录（1px = 9525）
    expect(document).toContain(`cx="${600 * 9525}" cy="${300 * 9525}"`);
  });

  test("资源缺失或格式不受支持时降级为占位文字，不丢正文顺序", async () => {
    const buffer = await articleToDocx(
      {
        html: '<p>a</p><img src="./assets/missing.png" alt="丢失的图" /><p>b</p>',
        sourceUrl: "https://mp.weixin.qq.com/s/miss",
        title: "缺图文章"
      },
      []
    );
    const zip = await JSZip.loadAsync(buffer);
    const media = Object.entries(zip.files).filter(
      ([name, entry]) => name.startsWith("word/media/") && !entry.dir
    );
    const document = await zip.file("word/document.xml")?.async("string");

    expect(media).toHaveLength(0);
    expect(document).toContain("未能嵌入");
    expect(document).toContain("丢失的图");
  });

  test("webp 这类 docx 不支持的格式同样走占位降级", async () => {
    const buffer = await articleToDocx(
      {
        html: '<img src="./assets/a.webp" alt="动图" />',
        sourceUrl: "https://mp.weixin.qq.com/s/webp",
        title: "webp"
      },
      [
        {
          data: Buffer.from("RIFF____WEBPVP8 ", "ascii"),
          kind: "image",
          path: "assets/a.webp",
          sourceUrl: "https://mmbiz.qpic.cn/w"
        }
      ]
    );
    const zip = await JSZip.loadAsync(buffer);

    expect(
      Object.entries(zip.files).filter(
        ([name, entry]) => name.startsWith("word/media/") && !entry.dir
      )
    ).toHaveLength(0);
    expect(await zip.file("word/document.xml")?.async("string")).toContain("未能嵌入");
  });
});

describe("PDF 资源内联", () => {
  test("把 ./assets 引用换成 data URI，setContent 下才能出图", () => {
    const html = inlineAssetsAsDataUris(
      '<img src="./assets/a.png"><img src=\'assets/a.png\'>',
      [
        {
          contentType: "image/png",
          data: Buffer.from("abc"),
          kind: "image",
          path: "assets/a.png",
          sourceUrl: "https://mmbiz.qpic.cn/a"
        }
      ]
    );

    expect(html).toBe(
      '<img src="data:image/png;base64,YWJj"><img src="data:image/png;base64,YWJj">'
    );
  });

  test("未收录的引用与外链保持原样", () => {
    const html = '<img src="https://example.com/x.png"><a href="https://x">链接</a>';

    expect(
      inlineAssetsAsDataUris(html, [
        {
          data: Buffer.from("abc"),
          kind: "image",
          path: "assets/a.png",
          sourceUrl: "https://mmbiz.qpic.cn/a"
        }
      ])
    ).toBe(html);
  });

  test("没有资源时原样返回，不做无谓的正则扫描", () => {
    expect(inlineAssetsAsDataUris("<p>纯文字</p>", [])).toBe("<p>纯文字</p>");
  });
});

describe("CSV 清单", () => {
  test("带 BOM、CRLF 换行，并按序号编号", () => {
    const csv = buildManifestCsv([
      { publishedAt: "2026-09-04", status: "success", title: "第一篇", url: "https://a" }
    ]);

    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("1,第一篇,2026-09-04,成功");
  });

  test("含逗号、引号、换行的单元格被正确转义", () => {
    const csv = buildManifestCsv([
      { status: "failed", title: 'a,b"c\nd', url: "https://a" }
    ]);

    expect(csv).toContain('"a,b""c\nd"');
  });

  test("前导 = 的标题加单引号前缀，阻断 Excel 公式注入", () => {
    const csv = buildManifestCsv([
      { status: "success", title: "=1+1", url: "https://a" }
    ]);

    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/,=1\+1,/);
  });
});

describe("PDF 渲染", () => {
  test("可注入渲染器，正常返回 Buffer", async () => {
    const renderer = vi.fn(async () => Buffer.from("%PDF-1.4"));
    setPdfRenderer(renderer);

    try {
      await expect(htmlToPdf("<p>hi</p>")).resolves.toEqual(Buffer.from("%PDF-1.4"));
      expect(renderer).toHaveBeenCalledWith("<p>hi</p>");
    } finally {
      setPdfRenderer(undefined);
    }
  });
});

describe("renderArticle 分派", () => {
  test("各格式返回对应产物类型", async () => {
    setPdfRenderer(async () => Buffer.from("%PDF"));

    try {
      const base = { article, html: "<p>H</p>", markdown: "M" } as const;

      await expect(renderArticle({ ...base, format: "markdown" })).resolves.toBe("M");
      await expect(renderArticle({ ...base, format: "html" })).resolves.toBe("<p>H</p>");
      await expect(renderArticle({ ...base, format: "pdf" })).resolves.toEqual(
        Buffer.from("%PDF")
      );
      await expect(renderArticle({ ...base, format: "mhtml" })).resolves.toContain(
        "multipart/related"
      );
      await expect(
        renderArticle({ ...base, format: "docx" }).then((value) =>
          (value as Buffer).subarray(0, 2).toString("latin1")
        )
      ).resolves.toBe("PK");
    } finally {
      setPdfRenderer(undefined);
    }
  });
});

describe("isPerArticleFormat", () => {
  test("只有 csv 不是逐篇格式", () => {
    expect(isPerArticleFormat("csv")).toBe(false);
    expect(isPerArticleFormat("markdown")).toBe(true);
    expect(isPerArticleFormat("pdf")).toBe(true);
  });
});
