"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ExternalLink, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, Meter } from "@/components/app/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { fmtCountdown, fmtRelative } from "@/lib/format";
import { isLocked, useNow } from "@/hooks/use-now";
import type { QuotaSnapshot } from "@/server/quota";

interface ProviderInfo {
  id: string;
  alias: string;
  name: string;
  auth: "oauth" | "apikey";
  color: string;
  apiKeyUrl: string | null;
  customBaseUrl: boolean;
  hasQuota: boolean;
  models: { id: string; name: string }[];
}
interface Conn {
  id: string;
  provider: string;
  authType: "oauth" | "apikey";
  name: string;
  email: string | null;
  priority: number;
  isActive: boolean;
  data: { lastError?: string | null; lockedUntil?: string | null; modelLocks?: Record<string, string>; expiresAt?: string | null; apiKeyPreview?: string | null; planType?: string | null; lastUsedAt?: string | null };
  quota: QuotaSnapshot | null;
}
interface Strategy {
  strategy: "fill-first" | "round-robin";
  stickyLimit: number;
  minRemainingSessionPercent: number;
  minRemainingWeeklyPercent: number;
}
interface SettingsData {
  defaultStrategy: Strategy;
  providerStrategies: Record<string, Strategy>;
}

export default function ProvidersPage() {
  const providers = usePoll<ProviderInfo[]>("/api/admin/providers");
  const conns = usePoll<Conn[]>("/api/admin/connections", 20000);
  const settings = usePoll<SettingsData>("/api/admin/settings");
  const [adding, setAdding] = useState<ProviderInfo | null>(null);
  const grouped = useMemo(() => {
    const map = new Map<string, Conn[]>();
    for (const c of conns.data || []) map.set(c.provider, [...(map.get(c.provider) || []), c]);
    return map;
  }, [conns.data]);
  const reload = () => {
    void conns.reload();
    void settings.reload();
  };
  return (
    <>
      <PageHeader title="Providers" subtitle="Subscriptions and API keys, grouped by provider" actions={<Button variant="outline" size="sm" onClick={reload}><RefreshCw className="size-3.5" />Refresh</Button>} />
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold">Connect</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(providers.data || []).map((p) => (
              <button key={p.id} onClick={() => setAdding(p)} className="surface group flex items-center gap-3 p-3 text-left transition hover:border-primary/40 hover:bg-accent/40 active:scale-[0.99]">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: p.color }}>
                  {p.alias.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="caption block">{p.auth === "oauth" ? "Sign in with subscription" : "Paste API key"}</span>
                </span>
                <Plus className="size-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </section>
        {conns.data && conns.data.length === 0 ? <EmptyState title="Nothing connected">Pick a provider above to add your first account.</EmptyState> : null}
        {[...grouped.entries()].map(([providerId, list]) => {
          const p = providers.data?.find((x) => x.id === providerId);
          const strat = settings.data?.providerStrategies[providerId] || settings.data?.defaultStrategy;
          return <ProviderGroup key={providerId} provider={p} providerId={providerId} list={list} strategy={strat} defaults={settings.data?.defaultStrategy} onChange={reload} />;
        })}
      </div>
      {adding ? <AddDialog provider={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); }} /> : null}
    </>
  );
}

function ProviderGroup({ provider, providerId, list, strategy, defaults, onChange }: { provider?: ProviderInfo; providerId: string; list: Conn[]; strategy?: Strategy; defaults?: Strategy; onChange: () => void }) {
  const [local, setLocal] = useState<Strategy | undefined>(strategy);
  const [seen, setSeen] = useState(strategy);
  if (seen !== strategy) {
    setSeen(strategy);
    setLocal(strategy);
  }
  const save = async (patch: Partial<Strategy>) => {
    const next = { ...(local || defaults!), ...patch };
    setLocal(next);
    try {
      const current = await api<SettingsData>("/api/admin/settings");
      await api("/api/admin/settings", { method: "PATCH", json: { providerStrategies: { ...current.providerStrategies, [providerId]: next } } });
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const move = async (c: Conn, dir: -1 | 1) => {
    const sorted = [...list].sort((a, b) => a.priority - b.priority);
    const i = sorted.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    await api(`/api/admin/connections/${sorted[i].id}`, { method: "PATCH", json: { priority: sorted[j].priority } });
    await api(`/api/admin/connections/${sorted[j].id}`, { method: "PATCH", json: { priority: sorted[i].priority } });
    onChange();
  };
  return (
    <section className="inset-group">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: provider?.color || "#888" }}>
          {(provider?.alias || providerId).slice(0, 2).toUpperCase()}
        </span>
        <h2 className="text-sm font-semibold">{provider?.name || providerId}</h2>
        <span className="caption">{list.length} account{list.length === 1 ? "" : "s"}</span>
        {local ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={local.strategy} onValueChange={(v) => void save({ strategy: v as Strategy["strategy"] })}>
              <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fill-first">Fill first</SelectItem>
                <SelectItem value="round-robin">Round robin</SelectItem>
              </SelectContent>
            </Select>
            {local.strategy === "round-robin" ? (
              <label className="caption flex items-center gap-1.5">
                sticky
                <Input type="number" min={1} className="h-8 w-16" value={local.stickyLimit} onChange={(e) => setLocal({ ...local, stickyLimit: Number(e.target.value) || 1 })} onBlur={() => void save({ stickyLimit: local.stickyLimit })} />
              </label>
            ) : null}
            {provider?.hasQuota ? (
              <>
                <label className="caption flex items-center gap-1.5">
                  stop at 5h
                  <Input type="number" min={0} max={100} className="h-8 w-16" value={local.minRemainingSessionPercent} onChange={(e) => setLocal({ ...local, minRemainingSessionPercent: Number(e.target.value) })} onBlur={() => void save({ minRemainingSessionPercent: local.minRemainingSessionPercent })} />%
                </label>
                <label className="caption flex items-center gap-1.5">
                  weekly
                  <Input type="number" min={0} max={100} className="h-8 w-16" value={local.minRemainingWeeklyPercent} onChange={(e) => setLocal({ ...local, minRemainingWeeklyPercent: Number(e.target.value) })} onBlur={() => void save({ minRemainingWeeklyPercent: local.minRemainingWeeklyPercent })} />%
                </label>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {[...list]
        .sort((a, b) => a.priority - b.priority)
        .map((c, i) => (
          <ConnectionRow key={c.id} c={c} index={i} count={list.length} onMove={(d) => void move(c, d)} onChange={onChange} />
        ))}
    </section>
  );
}

function ConnectionRow({ c, index, count, onMove, onChange }: { c: Conn; index: number; count: number; onMove: (d: -1 | 1) => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const locked = isLocked(c.data, now);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex flex-col">
          <Button variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp className="size-3" /></Button>
          <Button variant="ghost" size="icon-xs" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown className="size-3" /></Button>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {c.name} <span className="caption">#{c.priority}</span>
          </p>
          <p className="caption truncate">
            {c.authType === "oauth" ? c.email || "subscription" : c.data.apiKeyPreview}
            {c.data.planType ? ` · ${c.data.planType}` : ""}
            {c.data.lastUsedAt ? ` · used ${fmtRelative(c.data.lastUsedAt)}` : ""}
          </p>
          {c.data.lastError ? <p className="truncate text-xs text-destructive">{c.data.lastError}</p> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {(c.quota?.windows || []).filter((w) => ["session", "weekly"].includes(w.key) || w.key.endsWith("_session") || w.key.endsWith("_weekly")).slice(0, 4).map((w) => (
          <div key={w.key} className="flex items-center gap-2">
            <span className="caption w-28 shrink-0 truncate">{w.label}</span>
            <Meter value={w.usedPercent} className="flex-1" />
            <span className="caption tabular w-28 shrink-0 text-right">{Math.round(w.remainingPercent)}% · {fmtCountdown(w.resetAt).replace("resets ", "")}</span>
          </div>
        ))}
        {c.quota?.error && !c.quota.windows.length ? <p className="caption">{c.quota.error}</p> : null}
      </div>
      <div className="flex items-center gap-1.5">
        {locked ? <Badge variant="destructive">cooling down</Badge> : null}
        <Switch checked={c.isActive} disabled={busy} onCheckedChange={(v) => void run(() => api(`/api/admin/connections/${c.id}`, { method: "PATCH", json: { isActive: v } }))} aria-label="Active" />
        <Button variant="ghost" size="icon-sm" disabled={busy} title="Test" onClick={() => void run(async () => {
          const r = await api<{ ok: boolean; status: number; ms: number; error: string | null; model: string }>(`/api/admin/connections/${c.id}/test`, { method: "POST" });
          if (r.ok) toast.success(`${r.model} answered in ${r.ms} ms`);
          else throw new Error(`${r.status}: ${r.error || "failed"}`);
        })}><Zap className="size-3.5" /></Button>
        <Button variant="ghost" size="icon-sm" disabled={busy} title="Refresh quota" onClick={() => void run(() => api(`/api/admin/connections/${c.id}/quota`, { method: "POST" }))}><RefreshCw className="size-3.5" /></Button>
        {locked ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => api(`/api/admin/connections/${c.id}`, { method: "PATCH", json: { clearLocks: true } }), "Cooldown cleared")}>Clear</Button> : null}
        <Button variant="ghost" size="icon-sm" disabled={busy} title="Remove" onClick={() => { if (confirm(`Remove ${c.name}?`)) void run(() => api(`/api/admin/connections/${c.id}`, { method: "DELETE" }), "Removed"); }}><Trash2 className="size-3.5" /></Button>
      </div>
    </div>
  );
}

function AddDialog({ provider, onClose, onDone }: { provider: ProviderInfo; onClose: () => void; onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState<{ authorizeUrl: string; state: string; redirectUri: string; manualPaste: boolean } | null>(null);
  const [code, setCode] = useState("");
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "slimrouter-oauth" && e.data.ok) {
        toast.success(`${provider.name} connected`);
        onDone();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onDone, provider.name]);
  // Poll the server for the outcome so nothing has to be pasted when the callback reaches us.
  useEffect(() => {
    if (!oauth) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await api<{ status: string; name?: string; message?: string }>(`/api/admin/oauth/status?state=${encodeURIComponent(oauth.state)}`);
        if (s.status === "done") {
          toast.success(`Connected ${s.name || provider.name}`);
          onDone();
          return;
        }
        if (s.status === "error") {
          toast.error(s.message || "Sign-in failed");
          return;
        }
      } catch {
        /* keep polling */
      }
      setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [oauth, onDone, provider.name]);
  // Watch the clipboard: when the user copies the dead localhost URL or the code, finish automatically.
  useEffect(() => {
    if (!oauth) return;
    let stop = false;
    let last = "";
    const check = async () => {
      if (stop) return;
      try {
        if (document.hasFocus()) {
          const text = (await navigator.clipboard.readText()).trim();
          if (text && text !== last) {
            last = text;
            const extracted = extractCode(text);
            const looksLikeCode = /^https?:\/\/localhost/.test(text) || (extracted.includes("#") && extracted.length > 40);
            if (looksLikeCode) {
              setCode(extracted);
              setBusy(true);
              try {
                const c = await api<{ name: string }>("/api/admin/oauth/complete", { method: "POST", json: { code: extracted, state: oauth.state } });
                toast.success(`Connected ${c.name}`);
                onDone();
                return;
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }
          }
        }
      } catch {
        /* clipboard permission denied: the paste box still works */
      }
      setTimeout(check, 1000);
    };
    const t = setTimeout(check, 1000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [oauth, onDone]);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<typeof oauth & object>("/api/admin/oauth/start", { method: "POST", json: { provider: provider.id, origin: location.origin } });
      setOauth(r);
      window.open(r!.authorizeUrl, "slimrouter-oauth", "width=600,height=760");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const complete = async () => {
    setBusy(true);
    try {
      const c = await api<{ name: string }>("/api/admin/oauth/complete", { method: "POST", json: { code, state: oauth?.state } });
      toast.success(`Connected ${c.name}`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveKey = async () => {
    setBusy(true);
    try {
      await api("/api/admin/connections", { method: "POST", json: { provider: provider.id, apiKey, name, baseUrl } });
      toast.success(`${provider.name} added`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const codexHint = provider.id === "codex";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider.name}</DialogTitle>
          <DialogDescription>
            {provider.auth === "oauth" ? "Signs in exactly like the official CLI. Tokens stay in this server's database." : "The key is stored locally and only sent to the provider."}
          </DialogDescription>
        </DialogHeader>
        {provider.auth === "apikey" ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-1.5">
              <Label>API key</Label>
              <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoFocus />
              {provider.apiKeyUrl ? (
                <a className="caption inline-flex items-center gap-1 hover:underline" href={provider.apiKeyUrl} target="_blank" rel="noreferrer">
                  Get a key <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
            {provider.customBaseUrl ? (
              <div className="grid gap-1.5">
                <Label>Base URL</Label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://ollama:11434/v1" />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label>Name (optional)</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work key" />
            </div>
          </div>
        ) : !oauth ? (
          <div className="flex flex-col gap-2 text-sm">
            {codexHint ? <p className="caption">Codex redirects to localhost:1455. Run this dashboard on the same machine as your browser, or paste the full callback URL below after signing in.</p> : null}
            {provider.id === "claude" ? <p className="caption">Same as 9router: after you approve, Claude sends you to a localhost page that will not load. Copy that page&apos;s address and come back here.</p> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="caption">A sign-in window opened. If it did not, <a className="underline" href={oauth.authorizeUrl} target="_blank" rel="noreferrer">open it here</a>.</p>
            {oauth.redirectUri.startsWith("http://localhost") ? (
              <p className="caption">
                After approving you land on a <span className="font-mono">{new URL(oauth.redirectUri).host}</span> page that cannot load. Copy its address (Ctrl+L, Ctrl+C) and come back here: it finishes by itself.
              </p>
            ) : (
              <p className="caption">Finish the sign-in in that window; this dialog closes on its own.</p>
            )}
            <div className="grid gap-1.5">
              <Label>{oauth.manualPaste ? "Or paste the code / URL" : "Or paste the callback URL / code"}</Label>
              <Input value={code} onChange={(e) => setCode(extractCode(e.target.value))} placeholder={oauth.redirectUri.startsWith("http://localhost") ? `${oauth.redirectUri}?code=…` : "code#state"} autoFocus />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {provider.auth === "apikey" ? (
            <Button disabled={busy || !apiKey.trim()} onClick={() => void saveKey()}>Add</Button>
          ) : !oauth ? (
            <Button disabled={busy} onClick={() => void start()}>Sign in</Button>
          ) : (
            <Button disabled={busy || !code.trim()} onClick={() => void complete()}>Finish</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function extractCode(v: string): string {
  const s = v.trim();
  if (/^https?:\/\//.test(s)) {
    try {
      const u = new URL(s);
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (code) return state ? `${code}#${state}` : code;
    } catch {
      /* fall through */
    }
  }
  return s;
}
