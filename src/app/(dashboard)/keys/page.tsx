"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

interface Key { id: string; keyPrefix: string; name: string; isActive: boolean; allowedModels: string[] | null; createdAt: string; lastUsedAt: string | null }

export default function KeysPage() {
  const keys = usePoll<Key[]>("/api/admin/keys");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="API keys" subtitle="Clients authenticate to this gateway with these" actions={<Button size="sm" onClick={() => setCreating(true)}><Plus className="size-3.5" />New key</Button>} />
      <div className="flex flex-col gap-4 p-4 md:p-6">
        {revealed ? (
          <div className="surface flex flex-col gap-2 border-primary/40 p-4">
            <p className="text-sm font-medium">Copy your key now. It is shown only once.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[13px]">{revealed}</code>
              <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(revealed); toast.success("Copied"); }}><Copy className="size-3.5" />Copy</Button>
              <Button variant="ghost" size="sm" onClick={() => setRevealed(null)}>Done</Button>
            </div>
          </div>
        ) : null}
        {keys.data && keys.data.length === 0 ? (
          <EmptyState title="No API keys yet" action={<Button size="sm" onClick={() => setCreating(true)}>Create a key</Button>}>Each client app gets its own key so usage can be attributed.</EmptyState>
        ) : (
          <div className="inset-group">
            {(keys.data || []).map((k) => (
              <div key={k.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{k.name} <span className="caption font-mono">{k.keyPrefix}…</span></p>
                  <p className="caption">
                    created {fmtRelative(k.createdAt)} · {k.lastUsedAt ? `used ${fmtRelative(k.lastUsedAt)}` : "never used"}
                    {k.allowedModels?.length ? ` · limited to ${k.allowedModels.join(", ")}` : ""}
                  </p>
                </div>
                {!k.isActive ? <Badge variant="secondary">disabled</Badge> : null}
                <Switch checked={k.isActive} onCheckedChange={(v) => void api(`/api/admin/keys/${k.id}`, { method: "PATCH", json: { isActive: v } }).then(keys.reload)} />
                <Button variant="ghost" size="icon-sm" onClick={() => { if (confirm(`Delete ${k.name}?`)) void api(`/api/admin/keys/${k.id}`, { method: "DELETE" }).then(keys.reload); }}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
          </div>
        )}
      </div>
      {creating ? (
        <CreateDialog onClose={() => setCreating(false)} onDone={(plain) => { setCreating(false); setRevealed(plain); void keys.reload(); }} />
      ) : null}
    </>
  );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: (plaintext: string) => void }) {
  const [name, setName] = useState("");
  const [allowed, setAllowed] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>Optionally restrict it to a list of model or combo names.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5"><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on laptop" /></div>
          <div className="grid gap-1.5"><Label>Allowed models (comma separated, empty = all)</Label><Input value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="claude-opus-5-5, cx/gpt-6-sol" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !name.trim()} onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ plaintext: string }>("/api/admin/keys", { method: "POST", json: { name, allowedModels: allowed.split(",").map((s) => s.trim()).filter(Boolean) } });
              onDone(r.plaintext);
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
