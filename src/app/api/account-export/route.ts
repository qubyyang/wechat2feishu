import { NextRequest, NextResponse } from "next/server";

import { assertWechatBatchConfig, getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";
import { safeDocumentTitle } from "@/lib/safe";
import {
  assertWechatAccountId,
  buildWechatAccountMarkdownZip,
  fetchWechatAccountArticles
} from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: string;
    limit?: number;
  };
  const config = getServerConfig();
  const history = new HistoryStore(config.historyPath);
  const accountId = body.accountId?.trim() ?? "";

  try {
    const checkedAccountId = assertWechatAccountId(accountId);
    const credentials = assertWechatBatchConfig(config);
    const warnings: string[] = [];
    const articles = await fetchWechatAccountArticles({
      accountId: checkedAccountId,
      cookie: credentials.wechatMpCookie,
      intervalMs: config.wechatListIntervalMs,
      limit: body.limit,
      maxRetries: config.wechatMaxRetries,
      onWarning: (message) => warnings.push(message),
      pageSize: config.wechatListPageSize,
      retryBaseMs: config.wechatRetryBaseMs,
      token: credentials.wechatMpToken
    });

    if (!articles.length) {
      throw new Error("没有获取到该公众号的文章列表。");
    }

    const result = await buildWechatAccountMarkdownZip({
      accountId: checkedAccountId,
      articles,
      intervalMs: config.wechatArticleIntervalMs
    });
    const filename = `${safeDocumentTitle(checkedAccountId)}-公众号文章.zip`;
    await history.add({
      sourceUrl: `wechat-account:${checkedAccountId}`,
      status: result.successCount > 0 ? "success" : "failed",
      target: "markdown",
      title: `${checkedAccountId} 批量导出 ${result.successCount}/${articles.length}${
        warnings.length ? `（${warnings.length} 条限流提示）` : ""
      }`
    });

    if (warnings.length) {
      console.warn("[account-export] 抓取过程提示：\n - " + warnings.join("\n - "));
    }

    return new NextResponse(new Uint8Array(result.zip), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="wechat-account.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": "application/zip"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量导出失败";

    if (accountId) {
      await history.add({
        error: message,
        sourceUrl: `wechat-account:${accountId}`,
        status: "failed",
        target: "markdown",
        title: "批量导出失败"
      });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
