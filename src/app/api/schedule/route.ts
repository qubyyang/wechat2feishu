import { NextRequest, NextResponse } from "next/server";

import { getScheduleConfig, runScheduleTick, ScheduleStateStore } from "@/lib/schedule";

export const runtime = "nodejs";
export const maxDuration = 300;

type ScheduleRequestBody = {
  accountId?: string;
  /** 忽略间隔限制立即执行 */
  force?: boolean;
};

/** 返回当前计划与各账号的最近一次执行状态 */
export async function GET() {
  const config = getScheduleConfig();
  const state = await new ScheduleStateStore(config.statePath).read();

  return NextResponse.json({
    accounts: config.accountIds.map((accountId) => ({
      ...state.accounts[accountId],
      accountId
    })),
    archiveDir: config.archiveDir,
    enabled: config.enabled,
    format: config.format,
    intervalMs: config.intervalMs,
    lastTickAt: state.lastTickAt,
    limit: config.limit
  });
}

/**
 * 触发一轮调度。本服务**不内置 cron 守护进程**（详见 schedule.ts 的取舍说明），
 * 由外部定时器按分钟粒度打这个接口即可，是否真正执行由到期判定决定。
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as ScheduleRequestBody;
  const config = getScheduleConfig();

  if (!config.accountIds.length) {
    return NextResponse.json(
      { error: "请先在 .env 中通过 W2F_SCHEDULE_ACCOUNTS 配置要定时归档的公众号 ID。" },
      { status: 400 }
    );
  }

  try {
    const results = await runScheduleTick({
      config,
      force: body.force === true,
      onlyAccountId: body.accountId?.trim() || undefined
    });

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "定时归档执行失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
