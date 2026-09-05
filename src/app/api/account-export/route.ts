import { NextRequest, NextResponse } from "next/server";

import { ArchiveIndexStore, filterUnarchivedArticles } from "@/lib/archive-index";
import { assertWechatBatchConfig, getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";
import { parseExportFormat, safeDocumentTitle } from "@/lib/safe";
import type { ExportFormat } from "@/lib/types";
import {
  assertWechatAccountId,
  buildWechatAccountZip,
  fetchWechatAccountArticles
} from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: string;
    format?: string;
    /** 增量模式：跳过索引中已归档的文章，默认开启 */
    incremental?: boolean;
    limit?: number;
  };
  const config = getServerConfig();
  const history = new HistoryStore(config.historyPath);
  const archiveIndex = new ArchiveIndexStore(config.archiveIndexPath);
  const accountId = body.accountId?.trim() ?? "";
  const incremental = body.incremental !== false;

  let format: ExportFormat;
  try {
    format = parseExportFormat(body.format);
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量导出失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const checkedAccountId = assertWechatAccountId(accountId);
    const credentials = assertWechatBatchConfig(config);
    const warnings: string[] = [];
    const listed = await fetchWechatAccountArticles({
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

    if (!listed.length) {
      throw new Error("没有获取到该公众号的文章列表。");
    }

    // 在抓正文之前剔除已归档文章：列表配额已经花掉了，但正文抓取才是大头
    const archivedUrls = incremental
      ? await archiveIndex.listArchivedUrls(checkedAccountId)
      : new Set<string>();
    const { skipped, unarchived } = filterUnarchivedArticles(listed, archivedUrls);

    if (!unarchived.length) {
      return NextResponse.json(
        {
          error: `本次列出的 ${listed.length} 篇文章都已归档过，没有新增内容。如需重新导出，请关闭增量模式。`
        },
        { status: 409 }
      );
    }

    if (skipped.length) {
      warnings.push(`增量模式跳过 ${skipped.length} 篇已归档文章。`);
    }

    const result = await buildWechatAccountZip({
      accountId: checkedAccountId,
      articles: unarchived,
      assetIntervalMs: config.assetIntervalMs,
      assetMaxBytes: config.assetMaxBytes,
      downloadMedia: config.downloadMedia,
      format,
      intervalMs: config.wechatArticleIntervalMs,
      onWarning: (message) => warnings.push(message)
    });

    await archiveIndex.record(
      checkedAccountId,
      result.archived.map((item) => ({
        archivedAt: new Date().toISOString(),
        filename: item.filename,
        publishedAt: item.publishedAt,
        title: item.title,
        url: item.url
      }))
    );

    const filename = `${safeDocumentTitle(checkedAccountId)}-公众号文章.zip`;
    await history.add({
      sourceUrl: `wechat-account:${checkedAccountId}`,
      status: result.successCount > 0 ? "success" : "failed",
      target: format,
      title: `${checkedAccountId} 批量导出 ${result.successCount}/${unarchived.length}${
        skipped.length ? `（增量跳过 ${skipped.length} 篇）` : ""
      }${warnings.length ? `（${warnings.length} 条提示）` : ""}`
    });

    if (warnings.length) {
      console.warn("[account-export] 抓取过程提示：\n - " + warnings.join("\n - "));
    }

    return new NextResponse(new Uint8Array(result.zip), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="wechat-account.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": "application/zip",
        "x-w2f-asset-count": String(result.assetCount),
        "x-w2f-skipped-count": String(skipped.length),
        "x-w2f-success-count": String(result.successCount)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量导出失败";

    if (accountId) {
      await history.add({
        error: message,
        sourceUrl: `wechat-account:${accountId}`,
        status: "failed",
        target: format,
        title: "批量导出失败"
      });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
