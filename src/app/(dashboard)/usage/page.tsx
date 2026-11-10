"use client";

import { useState } from "react";
import { PageHeader } from "@/components/app/page-header";
import { Stat } from "@/components/app/stat";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { usePoll } from "@/hooks/use-poll";
import { fmtNum, fmtRelative, fmtUsd } from "@/lib/format";

interface Row { key: string; requests: number; errors: number; prompt: number; completion: number; cached: number; cost: number }
interface UsageData {
  totals: Row;
  byProvider: Row[];
  byModel: Row[];
  byConnection: Row[];
  byKey: Row[];
  series: { bucket: string; requests: number; cost: number; tokens: number }[];
  recent: { id: number; ts: string; provider: string; model: string; requested_model: string | null; status: string; http_status: number | null; prompt_tokens: number; completion_tokens: number; cached_tokens: number; cost: number; duration_ms: number; error: string | null }[];
}
interface Conn { id: string; name: string }
interface Key { id: string; name: string }

export default function UsagePage() {
  const [range, setRange] = useState("24h");
  const usage = usePoll<UsageData>(`/api/admin/usage?range=${range}`, 30000);
  const conns = usePoll<Conn[]>("/api/admin/connections");
  const keys = usePoll<Key[]>("/api/admin/keys");
  const nameOf = (list: { id: string; name: string }[] | null, id: string) => list?.find((x) => x.id === id)?.name || (id ? id.slice(0, 8) : "local");
  const d = usage.data;
  const max = Math.max(1, ...(d?.series || []).map((s) => s.requests));
  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Requests through this gateway"
        actions={
          <Tabs value={range} onValueChange={(v) => setRange(v as string)}>
            <TabsList>
              <TabsTrigger value="24h">24h</TabsTrigger>
              <TabsTrigger value="7d">7d</TabsTrigger>
              <TabsTrigger value="30d">30d</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Requests" value={fmtNum(d?.totals.requests)} hint={`${fmtNum(d?.totals.errors)} errors`} />
          <Stat label="Input tokens" value={fmtNum(d?.totals.prompt)} hint={`${d?.totals.prompt ? Math.round(((d.totals.cached || 0) / d.totals.prompt) * 100) : 0}% from cache`} />
          <Stat label="Output tokens" value={fmtNum(d?.totals.completion)} />
          <Stat label="List-price value" value={fmtUsd(d?.totals.cost)} hint="pay-as-you-go equivalent" />
        </div>
        <section className="surface p-4">
          <h2 className="mb-3 text-sm font-semibold">Requests over time</h2>
          <div className="flex h-32 items-end gap-[3px]">
            {(d?.series || []).map((s) => (
              <div key={s.bucket} className="group relative flex-1" title={`${s.bucket}: ${s.requests} requests, ${fmtUsd(s.cost)}`}>
                <div className="rounded-t-sm bg-primary/80 transition group-hover:bg-primary" style={{ height: `${Math.max(2, (s.requests / max) * 120)}px` }} />
              </div>
            ))}
            {!d?.series.length ? <p className="caption self-center">No requests in this range.</p> : null}
          </div>
        </section>
        <div className="grid gap-4 lg:grid-cols-2">
          <Breakdown title="By model" rows={d?.byModel || []} />
          <Breakdown title="By provider" rows={d?.byProvider || []} />
          <Breakdown title="By account" rows={(d?.byConnection || []).map((r) => ({ ...r, key: nameOf(conns.data, r.key) }))} />
          <Breakdown title="By API key" rows={(d?.byKey || []).map((r) => ({ ...r, key: nameOf(keys.data, r.key) }))} />
        </div>
        <section className="surface overflow-hidden">
          <div className="px-4 py-3"><h2 className="text-sm font-semibold">Recent requests</h2></div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(d?.recent || []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="caption whitespace-nowrap">{fmtRelative(r.ts)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.requested_model && r.requested_model !== r.model ? `${r.requested_model} → ` : ""}{r.provider}/{r.model}</TableCell>
                  <TableCell className="tabular text-right">{fmtNum(r.prompt_tokens)}</TableCell>
                  <TableCell className="tabular text-right">{fmtNum(r.completion_tokens)}</TableCell>
                  <TableCell className="tabular text-right">{fmtUsd(r.cost)}</TableCell>
                  <TableCell className="tabular text-right">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "–"}</TableCell>
                  <TableCell>{r.status === "ok" ? <Badge variant="outline">ok</Badge> : <Badge variant="destructive" title={r.error || ""}>{r.http_status || "err"}</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Row[] }) {
  const total = Math.max(1, rows.reduce((a, r) => a + r.requests, 0));
  return (
    <section className="inset-group">
      <div className="px-4 py-3"><h2 className="text-sm font-semibold">{title}</h2></div>
      {rows.length === 0 ? <p className="caption px-4 py-4">Nothing yet.</p> : null}
      {rows.slice(0, 8).map((r) => (
        <div key={r.key} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex justify-between text-sm">
              <span className="truncate font-medium">{r.key || "–"}</span>
              <span className="caption tabular">{fmtNum(r.requests)} req · {fmtUsd(r.cost)}</span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/70" style={{ width: `${(r.requests / total) * 100}%` }} /></div>
          </div>
        </div>
      ))}
    </section>
  );
}
