import { NextResponse } from "next/server";

import { getConfigStatus } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getConfigStatus());
}
