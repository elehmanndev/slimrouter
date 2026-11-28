"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Plus, RotateCw, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

interface Status { state: "idle" | "connecting" | "ready" | "error"; error: string | null; tools: number; connectedAt: string | null; version: string | null }
interface HttpCfg { url: string; headers: Record<string, string>; tools: Record<string, { enabled: boolean }>; timeoutMs: number }
interface StdioCfg { command: string; args: string[]; env: Record<string, string>; cwd?: string; tools: Record<string, { enabled: boolean }>; timeoutMs: number }
type Server =
  | { name: string; transport: "http"; config: HttpCfg; description: string | null; enabled: boolean; status: Status; last24h: { calls: number; errors: number; avg_ms: number } | null }
  | { name: string; transport: "stdio"; config: StdioCfg; description: string | null; enabled: boolean; status: Status; last24h: { calls: number; errors: number; avg_ms: number } | null };

const stateTone: Record<Status["state"], "default" | "secondary" | "destructive" | "outline"> = { ready: "default", connecting: "outline", idle: "secondary", error: "destructive" };

export default function McpPage() {
  const list = usePoll<{ sessions: number; servers: Server[] }>("/api/admin/mcp/servers", 10_000);
  const [editing, setEditing] = useState<Server | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const servers = list.data?.servers || [];
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <>
      <PageHeader
        title="MCP servers"
        subtitle={`${servers.length} servers · ${list.data?.sessions ?? 0} client sessions`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}><Upload className="size-3.5" />Import from mcphub</Button>
            <Button size="sm" onClick={() => setEditing("new")}><Plus className="size-3.5" />Add server</Button>
          </div>
        }
      />
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <div className="surface flex flex-col gap-1 p-4 text-sm">
          <p className="font-medium">How clients connect</p>
          <p className="caption">All servers a key may reach, tools prefixed with the server name: <span className="font-mono">{origin}/mcp</span></p>
          <p className="caption">One server with its original tool names, a drop-in for an mcphub URL: <span className="font-mono">{origin}/mcp/&lt;name&gt;</span></p>
          <p className="caption">Authenticate with a client key (<span className="font-mono">Authorization: Bearer sk-slim-…</span>) whose MCP access includes the server. Set it under API keys.</p>
        </div>
        {list.data && servers.length === 0 ? (
          <EmptyState title="No MCP servers yet" action={<Button size="sm" onClick={() => setImporting(true)}>Import from mcphub</Button>}>Add remote servers by URL or local ones by command, or import an mcphub settings file.</EmptyState>
        ) : (
          <div className="inset-group">
            {servers.map((s) => <ServerRow key={s.name} s={s} onEdit={() => setEditing(s)} onChange={list.reload} />)}
          </div>
        )}
      </div>
      {editing ? <EditDialog server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload(); }} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} onDone={() => { setImporting(false); void list.reload(); }} /> : null}
    </>
  );
}

function ServerRow({ s, onEdit, onChange }: { s: Server; onEdit: () => void; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const target = s.transport === "http" ? s.config.url : [s.config.command, ...s.config.args].join(" ");
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" className="text-muted-foreground" onClick={() => setOpen(!open)} aria-label="Tools">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            <span className="font-mono">{s.name}</span> <Badge variant="outline">{s.transport}</Badge> <Badge variant={stateTone[s.status.state]}>{s.status.state}{s.status.state === "ready" ? ` · ${s.status.tools} tools` : ""}</Badge>
          </p>
          <p className="caption truncate font-mono">{target}</p>
          <p className="caption truncate">
            {s.description || ""}
            {s.last24h ? ` · ${s.last24h.calls} calls, ${s.last24h.errors} errors, ${Math.round(s.last24h.avg_ms)} ms avg (24 h)` : ""}
            {s.status.connectedAt ? ` · up ${fmtRelative(s.status.connectedAt)}` : ""}
          </p>
          {s.status.error ? <p className="truncate text-xs text-destructive">{s.status.error}</p> : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Restart" onClick={async () => {
          const r = await api<{ error?: string }>(`/api/admin/mcp/servers/${s.name}`, { method: "PATCH", json: { action: "restart" } }).catch((e: Error) => ({ error: e.message }));
          if (r.error) toast.error(r.error); else toast.success(`${s.name} restarted`);
          onChange();
        }}><RotateCw className="size-3.5" /></Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        <Switch checked={s.enabled} onCheckedChange={(v) => void api(`/api/admin/mcp/servers/${s.name}`, { method: "PATCH", json: { enabled: v } }).then(onChange)} />
        <Button variant="ghost" size="icon-sm" aria-label="Delete" onClick={() => { if (confirm(`Delete MCP server ${s.name}?`)) void api(`/api/admin/mcp/servers/${s.name}`, { method: "DELETE" }).then(onChange); }}><Trash2 className="size-3.5" /></Button>
      </div>
      {open ? <ToolList name={s.name} /> : null}
    </div>
  );
}

function ToolList({ name }: { name: string }) {
  const tools = usePoll<{ name: string; description: string | null; enabled: boolean }[]>(`/api/admin/mcp/servers/${name}/tools`);
  if (tools.error) return <p className="px-12 pb-3 text-xs text-destructive">{tools.error}</p>;
  if (!tools.data) return <p className="caption px-12 pb-3">Connecting…</p>;
  return (
    <div className="flex flex-col gap-1 px-12 pb-3">
      {tools.data.map((t) => (
        <label key={t.name} className="flex items-center gap-2 text-sm">
          <Switch checked={t.enabled} onCheckedChange={(v) => void api(`/api/admin/mcp/servers/${name}/tools`, { method: "PATCH", json: { tool: t.name, enabled: v } }).then(tools.reload)} />
          <span className="font-mono">{t.name}</span>
          <span className="caption truncate">{t.description}</span>
        </label>
      ))}
    </div>
  );
}

const pairsToText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
function textToPairs(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

function EditDialog({ server, onClose, onDone }: { server: Server | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(server?.name || "");
  const [transport, setTransport] = useState<"http" | "stdio">(server?.transport || "http");
  const [description, setDescription] = useState(server?.description || "");
  const [url, setUrl] = useState(server?.transport === "http" ? server.config.url : "");
  const [headers, setHeaders] = useState(server?.transport === "http" ? pairsToText(server.config.headers) : "");
  const [command, setCommand] = useState(server?.transport === "stdio" ? server.config.command : "");
  const [args, setArgs] = useState(server?.transport === "stdio" ? server.config.args.join("\n") : "");
  const [env, setEnv] = useState(server?.transport === "stdio" ? pairsToText(server.config.env) : "");
  const [timeout, setTimeoutSec] = useState(String(Math.round((server?.config.timeoutMs ?? 120_000) / 1000)));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const timeoutMs = Math.max(1, Number(timeout) || 120) * 1000;
    const tools = server?.config.tools || {};
    const config = transport === "http" ? { url, headers: textToPairs(headers), tools, timeoutMs } : { command, args: args.split("\n").filter((a) => a.length), env: textToPairs(env), tools, timeoutMs };
    const body = { name, transport, description: description || null, config, enabled: server?.enabled ?? true };
    try {
      if (server) await api(`/api/admin/mcp/servers/${server.name}`, { method: "PATCH", json: body });
      else await api("/api/admin/mcp/servers", { method: "POST", json: body });
      toast.success(`${name} saved`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{server ? `Edit ${server.name}` : "Add MCP server"}</DialogTitle>
          <DialogDescription>Secrets are stored here and never shown again: leave ••••  to keep the current value.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Name</Label><Input value={name} disabled={!!server} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="opm-sql" /></div>
            <div className="grid gap-1.5">
              <Label>Transport</Label>
              <Select value={transport} onValueChange={(v) => setTransport(v as "http" | "stdio")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">Remote (Streamable HTTP)</SelectItem>
                  <SelectItem value="stdio">Local command (stdio)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5"><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          {transport === "http" ? (
            <>
              <div className="grid gap-1.5"><Label>URL</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></div>
              <div className="grid gap-1.5"><Label>Headers (one Name=value per line)</Label><textarea className="min-h-20 rounded-lg border bg-transparent px-3 py-2 font-mono text-xs" value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization=Bearer …" /></div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5"><Label>Command</Label><Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></div>
              <div className="grid gap-1.5"><Label>Arguments (one per line)</Label><textarea className="min-h-20 rounded-lg border bg-transparent px-3 py-2 font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/data"} /></div>
              <div className="grid gap-1.5"><Label>Environment (one NAME=value per line)</Label><textarea className="min-h-20 rounded-lg border bg-transparent px-3 py-2 font-mono text-xs" value={env} onChange={(e) => setEnv(e.target.value)} /></div>
            </>
          )}
          <div className="grid gap-1.5"><Label>Tool call timeout (seconds)</Label><Input type="number" min={1} value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} className="w-32" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !name || (transport === "http" ? !url : !command)} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PlanRow { name: string; action: "create" | "update" | "skip"; transport: string | null; enabled: boolean; reason: string | null }

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [pathMap, setPathMap] = useState("");
  const [plan, setPlan] = useState<{ servers: PlanRow[]; keyHints: { name: string; servers: string[] | "all" }[] } | null>(null);
  const [skip, setSkip] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async (apply: boolean) => {
    setBusy(true);
    try {
      const settings = JSON.parse(text);
      const r = await api<{ servers: PlanRow[]; keyHints: { name: string; servers: string[] | "all" }[]; applied?: string[] }>("/api/admin/mcp/import", { method: "POST", json: { settings, pathMap: textToPairs(pathMap), skip, apply } });
      if (apply) {
        toast.success(`Imported ${r.applied?.length ?? 0} servers`);
        onDone();
      } else setPlan(r);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from mcphub</DialogTitle>
          <DialogDescription>Paste mcp_settings.json. Names are kept, so /mcp/&lt;name&gt; replaces the mcphub URL one to one. Nothing changes until you import.</DialogDescription>
        </DialogHeader>
        {!plan ? (
          <div className="flex flex-col gap-3">
            <textarea className="min-h-48 rounded-lg border bg-transparent px-3 py-2 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "mcpServers": { … } }' />
            <div className="grid gap-1.5"><Label>Path mapping for local commands (mcphub path=slimrouter path, one per line)</Label><textarea className="min-h-16 rounded-lg border bg-transparent px-3 py-2 font-mono text-xs" value={pathMap} onChange={(e) => setPathMap(e.target.value)} placeholder={"/mcp-servers=/mcp-servers\n/app/data=/data/mcp"} /></div>
          </div>
        ) : (
          <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {plan.servers.map((s) => (
              <label key={s.name} className="flex items-center gap-2 text-sm">
                <Switch checked={s.action !== "skip" && !skip.includes(s.name)} disabled={s.action === "skip"} onCheckedChange={(v) => setSkip((p) => (v ? p.filter((x) => x !== s.name) : [...p, s.name]))} />
                <span className="font-mono">{s.name}</span>
                <Badge variant="outline">{s.transport ?? "—"}</Badge>
                <Badge variant={s.action === "skip" ? "secondary" : "default"}>{s.action}</Badge>
                {!s.enabled ? <Badge variant="secondary">disabled in mcphub</Badge> : null}
                {s.reason ? <span className="caption">{s.reason}</span> : null}
              </label>
            ))}
            {plan.keyHints.length ? (
              <div className="caption mt-2">
                <p className="font-medium text-foreground">mcphub keys (set the same access on your slimrouter keys)</p>
                {plan.keyHints.map((k) => <p key={k.name}>{k.name}: {k.servers === "all" ? "all servers" : k.servers.join(", ")}</p>)}
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {!plan ? <Button disabled={busy || !text.trim()} onClick={() => void run(false)}>Preview</Button> : <Button disabled={busy} onClick={() => void run(true)}>Import</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
