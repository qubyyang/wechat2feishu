import { createHash } from "node:crypto";

import type {
  ArticleAsset,
  ExportFormat,
  PerArticleExportFormat,
  WechatArticle
} from "./types";

export type RenderArticleOptions = {
  article: WechatArticle;
  /** 阶段 1 已下载的资源，MHTML 直接内嵌它们，不再二次联网 */
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
      return articleToDocx(article);
    case "html":
      return html;
    case "markdown":
      return markdown;
    case "mhtml":
      return articleToMhtml({ article, assets, html });
    case "pdf":
      return htmlToPdf(html);
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
  | { kind: "heading"; level: DocxHeadingLevel; text: string }
  | { kind: "listItem"; ordered: boolean; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string };

/**
 * 从 Markdown 抽出 DOCX 需要的块结构。
 *
 * 刻意只覆盖标题 / 段落 / 列表 / 引用这几类：公众号正文经过 sanitize 之后
 * 结构本来就扁平，把 Markdown 的全部语法都映射到 docx 收益很低。图片不进
 * DOCX——正文图片已经在 ZIP 的 assets/ 里，重复嵌入只会让文件体积翻倍。
 */
export function markdownToDocxBlocks(markdown: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "---") continue;

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

export async function articleToDocx(article: WechatArticle): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
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

  const children = [
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
