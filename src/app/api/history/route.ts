import { NextResponse } from "next/server";

import { getServerConfig } from "@/lib/env";
import { HistoryStore } from "@/lib/history";

export const runtime = "nodejs";

export async function GET() {
  const store = new HistoryStore(getServerConfig().historyPath);
  return NextResponse.json({ records: await store.list() });
}

export async function DELETE() {
  const store = new HistoryStore(getServerConfig().historyPath);
  await store.clear();
  return NextResponse.json({ ok: true });
}
