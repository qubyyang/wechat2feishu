import { NextRequest, NextResponse } from "next/server";

import { getServerConfig } from "@/lib/env";
import { SearchIndexStore } from "@/lib/search-index";

export const runtime = "nodejs";

/** 一次最多返回多少条，避免超大结果集把响应撑爆 */
const MAX_LIMIT = 50;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const query = params.get("q")?.trim() ?? "";
  const accountId = params.get("accountId")?.trim() || undefined;
  const config = getServerConfig();
  const store = new SearchIndexStore(config.searchIndexPath);

  // 空查询返回索引概况，前端首次加载时据此判断要不要显示检索框
  if (!query) {
    return NextResponse.json({ accounts: await store.stats(), hits: [], query: "" });
  }

  const limitRaw = Number(params.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LIMIT)
    : 20;

  return NextResponse.json({
    accounts: await store.stats(),
    hits: await store.search(query, { accountId, limit }),
    query
  });
}
