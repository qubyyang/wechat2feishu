import { NextRequest, NextResponse } from "next/server";

import { getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";
import { parseExportFormat, safeHtmlFilename, safeMarkdownFilename } from "@/lib/safe";
import type { ExportFormat } from "@/lib/types";
import { articleToHtml, fetchAndConvertWechatArticle } from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    format?: string;
    url?: string;
  };
  const sourceUrl = body.url?.trim() ?? "";
  const history = new HistoryStore(getServerConfig().historyPath);

  let format: ExportFormat;
  try {
    format = parseExportFormat(body.format);
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const { article, markdown } = await fetchAndConvertWechatArticle(sourceUrl);
    const filename =
      format === "html" ? safeHtmlFilename(article.title) : safeMarkdownFilename(article.title);
    await history.add({
      sourceUrl: article.sourceUrl,
      status: "success",
      target: format,
      title: article.title
    });

    if (format === "html") {
      return new NextResponse(articleToHtml(article), {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="wechat-article.html"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "content-type": "text/html; charset=utf-8"
        }
      });
    }

    return new NextResponse(markdown, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="wechat-article.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": "text/markdown; charset=utf-8"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";

    if (sourceUrl) {
      await history.add({
        error: message,
        sourceUrl,
        status: "failed",
        target: format,
        title: "导出失败"
      });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
