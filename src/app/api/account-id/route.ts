import { NextRequest, NextResponse } from "next/server";

import { extractWechatAccountId } from "@/lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { url?: string };
  const url = body.url?.trim() ?? "";

  try {
    const accountId = await extractWechatAccountId(url);

    return NextResponse.json({ accountId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "公众号 ID 提取失败" },
      { status: 400 }
    );
  }
}
