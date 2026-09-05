import { NextRequest, NextResponse } from "next/server";

import { ArchiveIndexStore, filterUnarchivedArticles } from "@/lib/archive-index";
import { assertWechatBatchConfig, getServerConfig } from "@/lib/env";
import { ExportJobStore } from "@/lib/export-jobs";
import { HistoryStore } from "@/lib/history";
import { parseExportFormat, safeDocumentTitle } from "@/lib/safe";
import type { ExportFormat, ExportProgressEvent } from "@/lib/types";
import {
  assertWechatAccountId,
  buildWechatAccountZip,
  fetchWechatAccountArticles,
  parseFilterDate,
  type WechatArticleFilter
} from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 300;

type ExportRequestBody = {
  accountId?: string;
  format?: string;
  /** 增量模式：跳过索引中已归档的文章，默认开启 */
  incremental?: boolean;
  keyword?: string;
  limit?: number;
  originalOnly?: boolean;
  publishedAfter?: string;
  publishedBefore?: string;
  /** 开启后返回 SSE 进度流，ZIP 暂存服务端并由 GET ?jobId= 领取 */
  stream?: boolean;
};

type ExportOutcome = {
  assetCount: number;
  filename: string;
  skippedCount: number;
  successCount: number;
  warnings: string[];
  zip: Buffer;
};

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

/**
 * 「已全部归档」是业务结果而非抓取故障，需要和真正的失败区分：
 * 非流式响应返回 409 而不是 400，流式响应也不应写进失败历史。
 */
class NothingToExportError extends Error {}

async function runAccountExport(options: {
  accountId: string;
  body: ExportRequestBody;
  filter: WechatArticleFilter | undefined;
  format: ExportFormat;
  onProgress?: (event: ExportProgressEvent) => void;
}): Promise<ExportOutcome> {
  const { accountId, body, filter, format, onProgress } = options;
  const config = getServerConfig();
  const archiveIndex = new ArchiveIndexStore(config.archiveIndexPath);
  const incremental = body.incremental !== false;
  const credentials = assertWechatBatchConfig(config);
  const warnings: string[] = [];

  onProgress?.({ message: "正在获取文章列表…", stage: "listing" });

  const listed = await fetchWechatAccountArticles({
    accountId,
    cookie: credentials.wechatMpCookie,
    filter,
    intervalMs: config.wechatListIntervalMs,
    limit: body.limit,
    maxRetries: config.wechatMaxRetries,
    onProgress,
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
    ? await archiveIndex.listArchivedUrls(accountId)
    : new Set<string>();
  const { skipped, unarchived } = filterUnarchivedArticles(listed, archivedUrls);

  if (!unarchived.length) {
    throw new NothingToExportError(
      `本次列出的 ${listed.length} 篇文章都已归档过，没有新增内容。如需重新导出，请关闭增量模式。`
    );
  }

  if (skipped.length) {
    warnings.push(`增量模式跳过 ${skipped.length} 篇已归档文章。`);
  }

  const result = await buildWechatAccountZip({
    accountId,
    articles: unarchived,
    assetIntervalMs: config.assetIntervalMs,
    assetMaxBytes: config.assetMaxBytes,
    downloadMedia: config.downloadMedia,
    format,
    intervalMs: config.wechatArticleIntervalMs,
    onProgress,
    onWarning: (message) => warnings.push(message)
  });

  await archiveIndex.record(
    accountId,
    result.archived.map((item) => ({
      archivedAt: new Date().toISOString(),
      filename: item.filename,
      publishedAt: item.publishedAt,
      title: item.title,
      url: item.url
    }))
  );

  const history = new HistoryStore(config.historyPath);
  await history.add({
    sourceUrl: `wechat-account:${accountId}`,
    status: result.successCount > 0 ? "success" : "failed",
    target: format,
    title: `${accountId} 批量导出 ${result.successCount}/${unarchived.length}${
      skipped.length ? `（增量跳过 ${skipped.length} 篇）` : ""
    }${warnings.length ? `（${warnings.length} 条提示）` : ""}`
  });

  if (warnings.length) {
    console.warn("[account-export] 抓取过程提示：\n - " + warnings.join("\n - "));
  }

  return {
    assetCount: result.assetCount,
    filename: `${safeDocumentTitle(accountId)}-公众号文章.zip`,
    skippedCount: skipped.length,
    successCount: result.successCount,
    warnings,
    zip: result.zip
  };
}

async function recordFailure(accountId: string, format: ExportFormat, message: string) {
  if (!accountId) return;

  const history = new HistoryStore(getServerConfig().historyPath);
  await history.add({
    error: message,
    sourceUrl: `wechat-account:${accountId}`,
    status: "failed",
    target: format,
    title: "批量导出失败"
  });
}

function zipHeaders(filename: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="wechat-account.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "content-type": "application/zip"
  };
}

/**
 * SSE 分支。进度事件是文本、ZIP 是二进制，两者无法共用一条响应，
 * 因此打包完成后落盘暂存，最后一个 done 事件带上 jobId 让前端二次拉取。
 */
function streamResponse(options: {
  accountId: string;
  body: ExportRequestBody;
  filter: WechatArticleFilter | undefined;
  format: ExportFormat;
}): NextResponse {
  const encoder = new TextEncoder();
  const config = getServerConfig();
  const jobs = new ExportJobStore(config.exportJobDir, config.exportJobTtlMs);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ExportProgressEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // 顺带回收上一轮没被领走的暂存包，避免磁盘无限增长
        await jobs.sweep().catch(() => 0);

        const outcome = await runAccountExport({ ...options, onProgress: send });
        const meta = await jobs.save(outcome.zip, outcome.filename);

        send({
          current: outcome.successCount,
          jobId: meta.jobId,
          message: `导出完成，共 ${outcome.successCount} 篇文章`,
          stage: "done",
          warnings: outcome.warnings
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "批量导出失败";

        if (!(error instanceof NothingToExportError)) {
          await recordFailure(options.accountId, options.format, message).catch(
            () => undefined
          );
        }

        send({ message, stage: "error" });
      } finally {
        closed = true;
        controller.close();
      }
    }
  });

  return new NextResponse(stream, {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      // 反代缓冲会把进度事件攒到最后一起吐出来，等于没有进度
      "x-accel-buffering": "no"
    }
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as ExportRequestBody;
  const accountId = body.accountId?.trim() ?? "";

  let checkedAccountId: string;
  let filter: WechatArticleFilter | undefined;
  let format: ExportFormat;
  try {
    format = parseExportFormat(body.format);
    filter = parseArticleFilter(body);
    checkedAccountId = assertWechatAccountId(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量导出失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (body.stream === true) {
    return streamResponse({ accountId: checkedAccountId, body, filter, format });
  }

  try {
    const outcome = await runAccountExport({
      accountId: checkedAccountId,
      body,
      filter,
      format
    });

    return new NextResponse(new Uint8Array(outcome.zip), {
      headers: {
        ...zipHeaders(outcome.filename),
        "x-w2f-asset-count": String(outcome.assetCount),
        "x-w2f-skipped-count": String(outcome.skippedCount),
        "x-w2f-success-count": String(outcome.successCount)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量导出失败";

    if (error instanceof NothingToExportError) {
      return NextResponse.json({ error: message }, { status: 409 });
    }

    await recordFailure(checkedAccountId, format, message);

    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** 领取流式导出暂存的 ZIP。一次性消费，取走即删 */
export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() ?? "";
  const config = getServerConfig();
  const jobs = new ExportJobStore(config.exportJobDir, config.exportJobTtlMs);
  const job = await jobs.take(jobId);

  if (!job) {
    return NextResponse.json(
      { error: "导出结果不存在或已过期，请重新导出。" },
      { status: 404 }
    );
  }

  return new NextResponse(new Uint8Array(job.zip), { headers: zipHeaders(job.filename) });
}
