import { NextRequest, NextResponse } from "next/server";

import { getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";
import { safeMarkdownFilename } from "@/lib/safe";
import { fetchAndConvertWechatArticle } from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { url?: string };
  const sourceUrl = body.url?.trim() ?? "";
  const history = new HistoryStore(getServerConfig().historyPath);

  try {
    const { article, markdown } = await fetchAndConvertWechatArticle(sourceUrl);
    const filename = safeMarkdownFilename(article.title);
    await history.add({
      sourceUrl: article.sourceUrl,
      status: "success",
      target: "markdown",
      title: article.title
    });

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
        target: "markdown",
        title: "导出失败"
      });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
