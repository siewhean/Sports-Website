import type { NextRequest } from "next/server";
import { parseScheduleJobView } from "@/lib/phase4-schedule";
import { forwardScheduleRead } from "@/lib/phase4-schedule-command.server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return forwardScheduleRead(
    request,
    `/api/v1/schedule-jobs/${encodeURIComponent(jobId)}`,
    (value) => parseScheduleJobView(value) !== null,
  );
}
