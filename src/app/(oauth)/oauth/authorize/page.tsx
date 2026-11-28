"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

interface Key { id: string; name: string; isActive: boolean; allowedMcp: string[] | null }
interface Server { name: string; enabled: boolean }

/**
 * Consent page for claude.ai / Claude Desktop connectors. The dashboard login gates it (proxy),
 * and the owner binds the connector to one client key, so it gets exactly that key's MCP access.
 */
function Consent() {
  const params = useSearchParams();
  const query = params.toString();
  const [info, setInfo] = useState<{ clientName: string | null; redirectHost: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [keyId, setKeyId] = useState("");
  const [newName, setNewName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api<{ clientName: string | null; redirectHost: string }>(`/api/oauth-server/describe?q=${encodeURIComponent(query)}`);
        setInfo(d);
        setNewName(`${d.clientName || "Connector"} (${d.redirectHost})`);
        const k = await api<Key[]>("/api/admin/keys");
        const withMcp = k.filter((x) => x.isActive && x.allowedMcp?.length);
        setKeys(withMcp);
        if (withMcp.length) setKeyId(withMcp[0].id);
        const s = await api<{ servers: Server[] }>("/api/admin/mcp/servers");
        setServers(s.servers.filter((x) => x.enabled));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [query]);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      const body = decision === "deny" ? { query, decision } : mode === "existing" ? { query, decision, apiKeyId: keyId } : { query, decision, newKeyName: newName, allowedMcp: picked };
      const r = await api<{ redirect: string }>("/api/admin/mcp/connectors", { method: "POST", json: body });
      window.location.href = r.redirect;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (error) return <p className="surface max-w-md p-6 text-sm text-destructive">{error}</p>;
  if (!info) return <p className="caption">Checking the request…</p>;
  const canApprove = mode === "existing" ? !!keyId : !!newName.trim() && picked.length > 0;
  return (
    <div className="surface flex w-full max-w-lg flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Waypoints className="size-5" /></div>
        <div>
          <h1 className="font-semibold tracking-tight">Connect {info.clientName || "an MCP client"}</h1>
          <p className="caption">It will reach your MCP servers through slimrouter and return to {info.redirectHost}.</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant={mode === "new" ? "default" : "outline"} onClick={() => setMode("new")}>New key for this connector</Button>
        <Button size="sm" variant={mode === "existing" ? "default" : "outline"} disabled={!keys.length} onClick={() => setMode("existing")}>Use an existing key</Button>
      </div>
      {mode === "existing" ? (
        <div className="flex flex-col gap-1">
          {keys.map((k) => (
            <label key={k.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name="key" checked={keyId === k.id} onChange={() => setKeyId(k.id)} />
              <span>{k.name}</span>
              <span className="caption">{k.allowedMcp?.includes("*") ? "all servers" : k.allowedMcp?.join(", ")}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5"><Label>Key name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
          <div className="flex flex-col gap-1">
            <Label>Servers it may use</Label>
            <label className="flex items-center gap-2 text-sm"><Switch checked={picked.includes("*")} onCheckedChange={(v) => setPicked(v ? ["*"] : [])} />All, including servers added later</label>
            {!picked.includes("*") ? (
              <div className="inset-group max-h-64 overflow-y-auto">
                {servers.map((s) => (
                  <label key={s.name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <Switch checked={picked.includes(s.name)} onCheckedChange={(v) => setPicked((p) => (v ? [...p, s.name] : p.filter((x) => x !== s.name)))} />
                    <span className="font-mono">{s.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void decide("deny")}>Deny</Button>
        <Button disabled={busy || !canApprove} onClick={() => void decide("approve")}>Allow</Button>
      </div>
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Suspense fallback={null}>
        <Consent />
      </Suspense>
    </main>
  );
}
