import { NextRequest, NextResponse } from "next/server";

import { assertFeishuConfig } from "@/lib/env";
import { FeishuClient } from "@/lib/feishu";
import { HistoryStore } from "@/lib/history";
import { fetchAndConvertWechatArticle } from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { url?: string };
  const sourceUrl = body.url?.trim() ?? "";
  const config = assertFeishuConfig();
  const history = new HistoryStore(config.historyPath);

  try {
    const { article, markdown } = await fetchAndConvertWechatArticle(sourceUrl);
    const feishu = new FeishuClient({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: config.baseUrl,
      folderToken: config.folderToken
    });
    const document = await feishu.importMarkdown({
      markdown,
      title: article.title
    });
    const record = await history.add({
      documentToken: document.token,
      documentUrl: document.url,
      sourceUrl: article.sourceUrl,
      status: "success",
      target: "feishu",
      title: article.title
    });

    return NextResponse.json({
      article,
      document,
      history: record
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "转存失败";

    if (sourceUrl) {
      await history.add({
        error: message,
        sourceUrl,
        status: "failed",
        target: "feishu",
        title: "转存失败"
      });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
