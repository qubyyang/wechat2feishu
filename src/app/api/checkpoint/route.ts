import { NextRequest, NextResponse } from "next/server";

import { getServerConfig } from "@/lib/env";
import { ExportCheckpointStore } from "@/lib/export-checkpoint";

export const runtime = "nodejs";

/** 列出可续传的未完成导出。过期检查点在列举时顺带清理 */
export async function GET() {
  const config = getServerConfig();

  if (!config.checkpointEnabled) {
    return NextResponse.json({ checkpoints: [], enabled: false });
  }

  const store = new ExportCheckpointStore(config.checkpointDir);

  return NextResponse.json({
    checkpoints: await store.list({ ttlMs: config.checkpointTtlMs }),
    enabled: true
  });
}

/** 丢弃某个检查点，用于用户明确想重新完整抓取的场景 */
export async function DELETE(request: NextRequest) {
  const checkpointId = request.nextUrl.searchParams.get("checkpointId")?.trim() ?? "";

  if (!checkpointId) {
    return NextResponse.json({ error: "缺少 checkpointId。" }, { status: 400 });
  }

  const config = getServerConfig();

  try {
    await new ExportCheckpointStore(config.checkpointDir).discardById(checkpointId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除失败。" },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
