import { NextRequest, NextResponse } from "next/server";

import {
  NothingToExportError,
  parseArticleFilter,
  recordAccountExportFailure,
  runAccountExport
} from "@/lib/account-export";
import { getServerConfig } from "@/lib/env";
import { ExportJobStore } from "@/lib/export-jobs";
import { parseExportFormat } from "@/lib/safe";
import type { ExportFormat, ExportProgressEvent } from "@/lib/types";
import { assertWechatAccountId, type WechatArticleFilter } from "@/lib/wechat";

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

        const outcome = await runAccountExport({
          accountId: options.accountId,
          filter: options.filter,
          format: options.format,
          incremental: options.body.incremental,
          limit: options.body.limit,
          onProgress: send
        });
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
          await recordAccountExportFailure(
            options.accountId,
            options.format,
            message
          ).catch(() => undefined);
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
      filter,
      format,
      incremental: body.incremental,
      limit: body.limit
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

    await recordAccountExportFailure(checkedAccountId, format, message);

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
