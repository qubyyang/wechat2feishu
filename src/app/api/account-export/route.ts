import { NextRequest, NextResponse } from "next/server";

import { ArchiveIndexStore, filterUnarchivedArticles } from "@/lib/archive-index";
import { assertWechatBatchConfig, getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";
import { parseExportFormat, safeDocumentTitle } from "@/lib/safe";
import type { ExportFormat } from "@/lib/types";
import {
  assertWechatAccountId,
  buildWechatAccountZip,
  fetchWechatAccountArticles,
  parseFilterDate,
  type WechatArticleFilter
} from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 只保留真正生效的筛选条件，全空时返回 undefined 以走原有的快路径 */
function parseArticleFilter(input: {
  keyword?: string;
  originalOnly?: boolean;
  publishedAfter?: string;
  publishedBefore?: string;
}): WechatArticleFilter | undefined {
  const filter: WechatArticleFilter = {
    keyword: input.keyword?.trim() || undefined,
    originalOnly: input.originalOnly === true ? true : undefined,
    publishedAfter: input.publishedAfter?.trim() || undefined,
    publishedBefore: input.publishedBefore?.trim() || undefined
  };

  // 提前解析一次，让非法日期在抓取前就报错，而不是浪费配额之后才失败
  const after = parseFilterDate(filter.publishedAfter);
  const before = parseFilterDate(filter.publishedBefore, true);

  if (after !== undefined && before !== undefined && after > before) {
    throw new Error("起始日期不能晚于结束日期。");
  }

  return Object.values(filter).some((value) => value !== undefined) ? filter : undefined;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: string;
    format?: string;
    /** 增量模式：跳过索引中已归档的文章，默认开启 */
    incremental?: boolean;
    keyword?: string;
    limit?: number;
    originalOnly?: boolean;
    publishedAfter?: string;
    publishedBefore?: string;
  };
  const config = getServerConfig();
  const history = new HistoryStore(config.historyPath);
  const archiveIndex = new ArchiveIndexStore(config.archiveIndexPath);
  const accountId = body.accountId?.trim() ?? "";
  const incremental = body.incremental !== false;

  let format: ExportFormat;
  let filter: WechatArticleFilter | undefined;
  try {
    format = parseExportFormat(body.format);
    filter = parseArticleFilter(body);
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
      filter,
      intervalMs: config.wechatListIntervalMs,
      limit: body.limit,
      maxRetries: config.wechatMaxRetries,
      onWarning: (message) => warnings.push(message),
      pageSize: config.wechatListPageSize,
      retryBaseMs: config.wechatRetryBaseMs,
      token: credentials.wechatMpToken
    });

    if (!listed.length) {
      throw new Error(
        filter
          ? "没有符合筛选条件的文章。请放宽关键词或时间范围后重试。"
          : "没有获取到该公众号的文章列表。"
      );
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
