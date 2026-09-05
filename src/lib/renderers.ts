import { createHash } from "node:crypto";

import { fitImageWidth, indexAssetsByPath, probeImage } from "./image-meta";
import type {
  ArticleAsset,
  ExportFormat,
  PerArticleExportFormat,
  WechatArticle
} from "./types";

export type RenderArticleOptions = {
  article: WechatArticle;
  /** 阶段 1 已下载的资源，MHTML 与 DOCX 直接内嵌它们，不再二次联网 */
  assets?: ArticleAsset[];
  format: PerArticleExportFormat;
  html: string;
  markdown: string;
};

export async function renderArticle({
  article,
  assets = [],
  format,
  html,
  markdown
}: RenderArticleOptions): Promise<Buffer | string> {
  switch (format) {
    case "docx":
      return articleToDocx(article, assets);
    case "html":
      return html;
    case "markdown":
      return markdown;
    case "mhtml":
      return articleToMhtml({ article, assets, html });
    case "pdf":
      // 正文里的 ./assets/xxx 在 setContent 下没有基准目录可解析，必须先内联
      return htmlToPdf(inlineAssetsAsDataUris(html, assets));
    default: {
      // 穷尽检查：新增格式忘了实现时在编译期报错
      const exhaustive: never = format;
      throw new Error(`未实现的导出格式：${String(exhaustive)}`);
    }
  }
}

/* ------------------------------- MHTML ------------------------------- */

/**
 * 手写 multipart/related 拼接。
 *
 * 相比走 CDP 的 Page.captureSnapshot，这里可以直接复用阶段 1 已经下载好的资源，
 * 不必为了生成快照再联网抓一遍图——那既慢又多花一份配额。
 */
export function articleToMhtml({
  article,
  assets,
  html
}: {
  article: WechatArticle;
  assets: ArticleAsset[];
  html: string;
}): string {
  const boundary = `----=_W2F_${createHash("sha1")
    .update(article.sourceUrl)
    .digest("hex")
    .slice(0, 24)}`;
  // 正文里的资源引用是 ./assets/xxx，MHTML 用同名的相对 Content-Location 对应
  const parts: string[] = [
    [
      "From: <Saved by w2f>",
      `Subject: ${encodeMimeHeader(article.title)}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
      ""
    ].join("\r\n"),
    [
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      `Content-Location: ${article.sourceUrl}`,
      "",
      toQuotedPrintable(html)
    ].join("\r\n")
  ];

  for (const asset of assets) {
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${asset.contentType ?? "application/octet-stream"}`,
        "Content-Transfer-Encoding: base64",
        `Content-Location: ./${asset.path}`,
        "",
        wrapBase64(asset.data.toString("base64"))
      ].join("\r\n")
    );
  }

  parts.push(`--${boundary}--`, "");

  return parts.join("\r\n");
}

/** RFC 2045 quoted-printable。中文按 UTF-8 逐字节编码，行长限制 76 字符 */
export function toQuotedPrintable(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const lines: string[] = [];
  let line = "";

  const push = (token: string) => {
    // 预留 1 个字符给软换行符 "="
    if (line.length + token.length > 75) {
      lines.push(`${line}=`);
      line = "";
    }

    line += token;
  };

  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines.push(line);
      line = "";
      continue;
    }

    if (byte === 0x0d) continue;

    const printable =
      (byte >= 0x20 && byte <= 0x3c) || (byte >= 0x3e && byte <= 0x7e);
    push(printable ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
  }

  if (line) lines.push(line);

  return lines.join("\r\n");
}

function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** 非 ASCII 的邮件头按 RFC 2047 编码，否则中文标题会乱码 */
export function encodeMimeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u007f]/.test(value)) return value;

  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/* -------------------------------- DOCX -------------------------------- */

type DocxHeadingLevel = "Heading1" | "Heading2" | "Heading3";

export type DocxBlock =
  | { alt: string; kind: "image"; src: string }
  | { kind: "heading"; level: DocxHeadingLevel; text: string }
  | { kind: "listItem"; ordered: boolean; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string };

/**
 * 从 Markdown 抽出 DOCX 需要的块结构。
 *
 * 刻意只覆盖标题 / 段落 / 列表 / 引用 / 图片这几类：公众号正文经过 sanitize
 * 之后结构本来就扁平，把 Markdown 的全部语法都映射到 docx 收益很低。
 *
 * 图片只记录引用路径，字节由调用方从已下载的 assets 里取——DOCX 生成时再去
 * 联网抓图会被微信 CDN 以防盗链拒绝，这也是早期版本干脆丢弃图片的原因。
 */
export function markdownToDocxBlocks(markdown: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "---") continue;

    // 独占一行的图片才升级为图片块；夹在文字里的图片仍按行内处理（会被剥掉）
    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (image?.[2]) {
      blocks.push({ alt: image[1] ?? "", kind: "image", src: image[2] });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading?.[2]) {
      blocks.push({
        kind: "heading",
        level: `Heading${heading[1].length}` as DocxHeadingLevel,
        text: stripInlineMarkdown(heading[2])
      });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ kind: "quote", text: stripInlineMarkdown(quote[1] ?? "") });
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.*)$/);
    if (unordered?.[1]) {
      blocks.push({ kind: "listItem", ordered: false, text: stripInlineMarkdown(unordered[1]) });
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.*)$/);
    if (ordered?.[1]) {
      blocks.push({ kind: "listItem", ordered: true, text: stripInlineMarkdown(ordered[1]) });
      continue;
    }

    const text = stripInlineMarkdown(line);
    if (text) blocks.push({ kind: "paragraph", text });
  }

  return blocks;
}

/** 去掉行内 Markdown 标记，只保留可读文本（图片整体丢弃，链接保留文字） */
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** DOCX 正文可用宽度（A4 减去左右页边距），单位 EMU 换算前的像素基准 */
const DOCX_CONTENT_WIDTH_PX = 600;

export async function articleToDocx(
  article: WechatArticle,
  assets: ArticleAsset[] = []
): Promise<Buffer> {
  const { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } = await import("docx");
  const assetIndex = indexAssetsByPath(assets);
  const meta = [
    article.author ? `作者：${article.author}` : undefined,
    article.publishedAt ? `发布时间：${article.publishedAt}` : undefined,
    `原文链接：${article.sourceUrl}`
  ].filter((value): value is string => Boolean(value));

  const headingMap = {
    Heading1: HeadingLevel.HEADING_1,
    Heading2: HeadingLevel.HEADING_2,
    Heading3: HeadingLevel.HEADING_3
  } as const;

  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, text: article.title }),
    ...meta.map(
      (text) =>
        new Paragraph({ children: [new TextRun({ color: "767676", size: 18, text })] })
    ),
    new Paragraph({ text: "" })
  ];

  // 正文块由 markdown 推导，见 markdownToDocxBlocks 的取舍说明
  for (const block of markdownToDocxBlocks(article.html ? htmlToPlainMarkdown(article.html) : "")) {
    switch (block.kind) {
      case "heading":
        children.push(new Paragraph({ heading: headingMap[block.level], text: block.text }));
        break;
      case "image": {
        const asset = assetIndex.get(block.src);
        const probed = asset ? probeImage(asset.data) : undefined;

        // 资源没下载成功、或格式 docx 不认（svg/webp），降级成 alt 文字占位，
        // 保留正文顺序，而不是让读者以为原文就没有这张图
        if (!asset || !probed) {
          const hint = block.alt || "图片";
          children.push(
            new Paragraph({
              children: [new TextRun({ color: "999999", italics: true, size: 18, text: `［${hint}未能嵌入］` })]
            })
          );
          break;
        }

        const size = fitImageWidth(probed, DOCX_CONTENT_WIDTH_PX);
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                altText: block.alt
                  ? { description: block.alt, name: block.alt, title: block.alt }
                  : undefined,
                data: asset.data,
                transformation: size,
                type: probed.type
              })
            ]
          })
        );
        break;
      }
      case "listItem":
        children.push(
          new Paragraph({
            bullet: block.ordered ? undefined : { level: 0 },
            numbering: block.ordered ? { level: 0, reference: "w2f-ordered" } : undefined,
            text: block.text
          })
        );
        break;
      case "quote":
        children.push(new Paragraph({ style: "IntenseQuote", text: block.text }));
        break;
      default:
        children.push(new Paragraph({ text: block.text }));
    }
  }

  const document = new Document({
    numbering: {
      config: [
        {
          levels: [{ format: "decimal", level: 0, text: "%1." }],
          reference: "w2f-ordered"
        }
      ]
    },
    sections: [{ children }]
  });

  return Buffer.from(await Packer.toBuffer(document));
}

/** 把清洗后的 HTML 折成朴素 Markdown，仅供 DOCX 取块结构使用 */
function htmlToPlainMarkdown(html: string): string {
  return html
    // 图片先转成独占一行的 Markdown 图片，后续才能被识别成图片块
    .replace(/<\s*img\b[^>]*>/gi, (tag: string) => {
      const src = tag.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = src?.[2] ?? src?.[3] ?? src?.[4];
      if (!url) return "\n";

      const alt = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i);

      return `\n![${(alt?.[2] ?? alt?.[3] ?? "").replace(/[[\]]/g, "")}](${url})\n`;
    })
    .replace(/<\s*h([1-3])[^>]*>([\s\S]*?)<\s*\/\s*h\1\s*>/gi, (_, level: string, text: string) =>
      `\n${"#".repeat(Number(level))} ${stripTags(text)}\n`
    )
    .replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_, text: string) => `\n- ${stripTags(text)}\n`)
    .replace(/<\s*blockquote[^>]*>([\s\S]*?)<\s*\/\s*blockquote\s*>/gi, (_, text: string) =>
      `\n> ${stripTags(text)}\n`
    )
    .replace(/<\s*(?:p|div|section|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/* --------------------------------- PDF --------------------------------- */

/**
 * 把正文里指向本地资源的引用换成 data: URI。
 *
 * PDF 走 `page.setContent()`，页面没有真实的 base URL，`./assets/x.png` 这类
 * 相对路径一律解析失败；而直接放行原始的 mmbiz 地址又会被微信防盗链挡掉。
 * 图片字节此刻就在内存里，内联是唯一不再联网也能出图的做法。
 */
export function inlineAssetsAsDataUris(html: string, assets: ArticleAsset[]): string {
  if (!assets.length) return html;

  const index = indexAssetsByPath(assets);

  return html.replace(
    /\b(src|href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, attribute: string, _quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
      const reference = doubleQuoted ?? singleQuoted ?? "";
      const asset = index.get(reference);

      if (!asset) return match;

      const type = asset.contentType ?? "application/octet-stream";

      return `${attribute}="data:${type};base64,${asset.data.toString("base64")}"`;
    }
  );
}

export type PdfRenderer = (html: string) => Promise<Buffer>;

let pdfRenderer: PdfRenderer | undefined;

/** 供测试注入，避免单测真的去拉起浏览器 */
export function setPdfRenderer(renderer: PdfRenderer | undefined): void {
  pdfRenderer = renderer;
}

/**
 * 复用已有的 playwright-core，不引入新依赖。
 *
 * 注意 playwright-core **不自带浏览器**，依赖 W2F_CHROME_EXECUTABLE_PATH 或
 * resolveChromeExecutable() 的自动探测；找不到时给出可操作的报错而不是崩栈。
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  if (pdfRenderer) return pdfRenderer(html);

  const { launchChromiumPage } = await import("./browser");

  return launchChromiumPage(async (page) => {
    await page.setContent(html, { timeout: 45_000, waitUntil: "networkidle" });

    return Buffer.from(
      await page.pdf({
        format: "A4",
        margin: { bottom: "16mm", left: "14mm", right: "14mm", top: "16mm" },
        printBackground: true
      })
    );
  });
}

/* --------------------------------- CSV --------------------------------- */

export type CsvRow = {
  assetCount?: number;
  error?: string;
  filename?: string;
  publishedAt?: string;
  status: "failed" | "success";
  title: string;
  url: string;
};

/** 从 manifest 数据直接生成，无需新依赖 */
export function buildManifestCsv(rows: CsvRow[]): string {
  const header = ["序号", "标题", "发布时间", "状态", "文件名", "资源数", "原文链接", "错误"];
  const lines = [header.map(escapeCsvCell).join(",")];

  rows.forEach((row, index) => {
    lines.push(
      [
        String(index + 1),
        row.title,
        row.publishedAt ?? "",
        row.status === "success" ? "成功" : "失败",
        row.filename ?? "",
        row.assetCount === undefined ? "" : String(row.assetCount),
        row.url,
        row.error ?? ""
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  });

  // BOM 让 Excel 正确识别 UTF-8，否则中文全是乱码
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

function escapeCsvCell(value: string): string {
  // 前导 =/+/-/@ 会被 Excel 当公式执行，加单引号前缀阻断注入
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;

  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function isPerArticleFormat(format: ExportFormat): format is PerArticleExportFormat {
  return format !== "csv";
}
