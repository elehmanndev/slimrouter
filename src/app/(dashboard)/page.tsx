"use client";

import Link from "next/link";
import { Activity, DollarSign, Plug } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, Meter, Stat } from "@/components/app/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePoll } from "@/hooks/use-poll";
import { fmtCountdown, fmtNum, fmtUsd } from "@/lib/format";
import { isLocked, useNow } from "@/hooks/use-now";
import type { QuotaSnapshot } from "@/server/quota";

interface Conn {
  id: string;
  provider: string;
  name: string;
  isActive: boolean;
  data: { lastError?: string | null; lockedUntil?: string | null; modelLocks?: Record<string, string> };
  quota: QuotaSnapshot | null;
}
interface UsageData {
  totals: { requests: number; errors: number; prompt: number; completion: number; cached: number; cost: number };
  byProvider: { key: string; requests: number; cost: number }[];
}

export default function OverviewPage() {
  const { data: conns } = usePoll<Conn[]>("/api/admin/connections", 30000);
  const { data: usage } = usePoll<UsageData>("/api/admin/usage?range=24h", 30000);
  const now = useNow();
  const active = (conns || []).filter((c) => c.isActive);
  const lowest = active
    .flatMap((c) => (c.quota?.windows || []).map((w) => ({ c, w })))
    .sort((x, y) => x.w.remainingPercent - y.w.remainingPercent)
    .slice(0, 6);
  return (
    <>
      <PageHeader title="Overview" subtitle="Last 24 hours" />
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Requests" value={fmtNum(usage?.totals.requests)} hint={`${fmtNum(usage?.totals.errors)} errors`} icon={<Activity className="size-4" />} />
          <Stat label="Tokens" value={fmtNum((usage?.totals.prompt || 0) + (usage?.totals.completion || 0))} hint={`${fmtNum(usage?.totals.cached)} cached`} />
          <Stat label="List-price value" value={fmtUsd(usage?.totals.cost)} hint="what this would cost on pay-as-you-go" icon={<DollarSign className="size-4" />} />
          <Stat label="Accounts" value={active.length} hint={`${(conns || []).length - active.length} paused`} icon={<Plug className="size-4" />} />
        </div>
        {!conns ? null : conns.length === 0 ? (
          <EmptyState title="No providers connected yet" action={<Button render={<Link href="/providers" />}>Connect a provider</Button>}>
            Sign in with a Claude, Codex or Antigravity subscription, or paste an API key. Then point your tools at this server.
          </EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="inset-group">
              <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-semibold">Tightest windows</h2>
                <Button variant="ghost" size="sm" render={<Link href="/quota" />}>
                  All quota
                </Button>
              </div>
              {lowest.length === 0 ? (
                <p className="caption px-4 py-6">No subscription quota reported yet.</p>
              ) : (
                lowest.map(({ c, w }) => (
                  <div key={`${c.id}-${w.key}`} className="flex flex-col gap-1.5 px-4 py-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="caption tabular">
                        {w.label} · {Math.round(w.remainingPercent)}% left
                      </span>
                    </div>
                    <Meter value={w.usedPercent} />
                    <span className="caption">{fmtCountdown(w.resetAt)}</span>
                  </div>
                ))
              )}
            </section>
            <section className="inset-group">
              <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-semibold">Accounts</h2>
                <Button variant="ghost" size="sm" render={<Link href="/providers" />}>
                  Manage
                </Button>
              </div>
              {(conns || []).map((c) => {
                const locked = isLocked(c.data, now);
                return (
                  <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="caption truncate">{c.provider}{c.data.lastError ? ` · ${c.data.lastError}` : ""}</p>
                    </div>
                    <Badge variant={!c.isActive ? "secondary" : locked ? "destructive" : "outline"}>{!c.isActive ? "paused" : locked ? "cooling down" : "ready"}</Badge>
                  </div>
                );
              })}
            </section>
          </div>
        )}
        <section className="surface p-4">
          <h2 className="mb-2 text-sm font-semibold">Connect a client</h2>
          <p className="caption mb-3">Every endpoint speaks the client&apos;s native dialect. Use any model id from the Models page, or a combo name.</p>
          <div className="grid gap-3 md:grid-cols-3">
            <Snippet title="Claude Code" lines={["ANTHROPIC_BASE_URL=<this host>", "ANTHROPIC_AUTH_TOKEN=sk-slim-…", "ANTHROPIC_MODEL=cc/claude-opus-5-5"]} />
            <Snippet title="Codex CLI" lines={["base_url = \"<this host>/v1\"", "env_key = \"SLIM_KEY\"", "wire_api = \"responses\""]} />
            <Snippet title="OpenAI SDK" lines={["base_url=\"<this host>/v1\"", "api_key=\"sk-slim-…\"", "model=\"cx/gpt-6-sol\""]} />
          </div>
        </section>
      </div>
    </>
  );
}

function Snippet({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/40 p-3">
      <p className="mb-1.5 text-xs font-semibold">{title}</p>
      <pre className="overflow-x-auto font-mono text-[11.5px] leading-5 text-muted-foreground">{lines.join("\n")}</pre>
    </div>
  );
}

