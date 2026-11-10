"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, Meter } from "@/components/app/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePoll } from "@/hooks/use-poll";
import { fmtCountdown, fmtRelative } from "@/lib/format";
import type { QuotaSnapshot } from "@/server/quota";

interface Entry { connection: { id: string; provider: string; name: string; email: string | null; isActive: boolean }; quota: QuotaSnapshot | null }

export default function QuotaPage() {
  const [force, setForce] = useState(false);
  const { data, reload, loading } = usePoll<Entry[]>(`/api/admin/quota${force ? "?force=1" : ""}`, 60000);
  return (
    <>
      <PageHeader title="Quota" subtitle="Subscription windows per account" actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => { setForce(true); void reload().then(() => setForce(false)); }}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />Refresh now</Button>} />
      <div className="grid gap-4 p-4 md:p-6 lg:grid-cols-2 2xl:grid-cols-3">
        {data && data.length === 0 ? <EmptyState title="No subscription accounts">Quota is read for Claude, Codex and Antigravity sign-ins.</EmptyState> : null}
        {(data || []).map(({ connection: c, quota: q }) => (
          <section key={c.id} className="surface flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="caption truncate">{c.provider}{q?.plan ? ` · ${q.plan}` : ""}{q ? ` · read ${fmtRelative(q.fetchedAt)}` : ""}</p>
              </div>
              {!c.isActive ? <Badge variant="secondary">paused</Badge> : null}
            </div>
            {q?.error && !q.windows.length ? <p className="text-sm text-destructive">{q.error}</p> : null}
            {!q ? <p className="caption">Not read yet.</p> : null}
            {(q?.windows || []).map((w) => (
              <div key={w.key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm">{w.label}</span>
                  <span className="tabular text-sm font-semibold">{Math.round(w.remainingPercent)}% <span className="caption font-normal">left</span></span>
                </div>
                <Meter value={w.usedPercent} />
                <span className="caption">{fmtCountdown(w.resetAt) || "no reset time reported"}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
