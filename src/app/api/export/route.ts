import { NextRequest, NextResponse } from "next/server";

import { localizeArticleAssets } from "@/lib/assets";
import { getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";
import { renderArticle } from "@/lib/renderers";
import {
  exportFormatExtension,
  parseSingleArticleExportFormat,
  safeFilenameWithExtension
} from "@/lib/safe";
import type { ExportFormat, PerArticleExportFormat } from "@/lib/types";
import { articleToHtml, fetchAndConvertWechatArticle } from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 120;

const CONTENT_TYPES: Record<PerArticleExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mhtml: "message/rfc822",
  pdf: "application/pdf"
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    format?: string;
    url?: string;
  };
  const sourceUrl = body.url?.trim() ?? "";
  const config = getServerConfig();
  const history = new HistoryStore(config.historyPath);

  let format: ExportFormat;
  try {
    format = parseSingleArticleExportFormat(body.format);
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const perArticleFormat = format as PerArticleExportFormat;

  try {
    const converted = await fetchAndConvertWechatArticle(sourceUrl);
    let article = converted.article;
    let assets = undefined;

    // 只有 MHTML 需要内嵌资源，其余格式没必要为此多花一轮下载
    if (perArticleFormat === "mhtml") {
      const localized = await localizeArticleAssets({
        article,
        intervalMs: config.assetIntervalMs,
        maxBytes: config.assetMaxBytes
      });

      article = localized.article;
      assets = localized.assets;
    }

    const rendered = await renderArticle({
      article,
      assets,
      format: perArticleFormat,
      html: articleToHtml(article),
      markdown: converted.markdown
    });
    const filename = safeFilenameWithExtension(
      article.title,
      exportFormatExtension(perArticleFormat)
    );

    await history.add({
      sourceUrl: article.sourceUrl,
      status: "success",
      target: format,
      title: article.title
    });

    const payload =
      typeof rendered === "string" ? rendered : new Uint8Array(rendered);

    return new NextResponse(payload, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="wechat-article.${exportFormatExtension(perArticleFormat)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": CONTENT_TYPES[perArticleFormat]
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
