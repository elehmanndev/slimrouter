"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";

interface Model { id: string; owned_by: string }
interface Combo { id: string; name: string; models: string[]; strategy: "fallback" | "round-robin" }

export default function ModelsPage() {
  const models = usePoll<Model[]>("/api/admin/models");
  const combos = usePoll<Combo[]>("/api/admin/combos");
  const [editing, setEditing] = useState<Combo | null | "new">(null);
  const byProvider = useMemo(() => {
    const m = new Map<string, Model[]>();
    for (const x of models.data || []) if (x.owned_by !== "combo") m.set(x.owned_by, [...(m.get(x.owned_by) || []), x]);
    return m;
  }, [models.data]);
  const copy = (s: string) => {
    void navigator.clipboard.writeText(s);
    toast.success(`Copied ${s}`);
  };
  const reload = () => {
    void models.reload();
    void combos.reload();
  };
  return (
    <>
      <PageHeader title="Models & combos" subtitle="Everything a client can ask for by name" actions={<Button size="sm" onClick={() => setEditing("new")}><Plus className="size-3.5" />New combo</Button>} />
      <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="mb-2 text-sm font-semibold">Combos</h2>
            <p className="caption mb-3">A combo is a model name that tries its members in order (fallback) or rotates between them (round robin). Name one after the model your tool expects, for example claude-opus-5-5.</p>
            {combos.data && combos.data.length === 0 ? (
              <EmptyState title="No combos yet" action={<Button size="sm" onClick={() => setEditing("new")}>Create one</Button>} />
            ) : (
              <div className="inset-group">
                {(combos.data || []).map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <button className="truncate font-mono text-sm font-medium hover:underline" onClick={() => copy(c.name)}>{c.name}</button>
                        <Badge variant="outline">{c.strategy}</Badge>
                      </div>
                      <p className="caption truncate">{c.models.join("  →  ")}</p>
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditing(c)}><Pencil className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => { if (confirm(`Delete ${c.name}?`)) void api(`/api/admin/combos/${c.id}`, { method: "DELETE" }).then(reload); }}><Trash2 className="size-3.5" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Provider models</h2>
          <p className="caption mb-3">Only connected providers are listed. Click to copy the id.</p>
          {byProvider.size === 0 ? <EmptyState title="Connect a provider to see its models" /> : null}
          <div className="flex flex-col gap-3">
            {[...byProvider.entries()].map(([prov, list]) => (
              <div key={prov} className="inset-group">
                <div className="px-4 py-2"><span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{prov}</span></div>
                {list.map((m) => (
                  <button key={m.id} onClick={() => copy(m.id)} className="flex w-full items-center justify-between px-4 py-2 text-left font-mono text-[13px] hover:bg-accent/50">
                    <span className="truncate">{m.id}</span>
                    <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
      {editing ? <ComboDialog combo={editing === "new" ? null : editing} options={(models.data || []).map((m) => m.id)} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} /> : null}
    </>
  );
}

function ComboDialog({ combo, options, onClose, onDone }: { combo: Combo | null; options: string[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(combo?.name || "");
  const [strategy, setStrategy] = useState<Combo["strategy"]>(combo?.strategy || "fallback");
  const [members, setMembers] = useState<string[]>(combo?.models || []);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(combo ? `/api/admin/combos/${combo.id}` : "/api/admin/combos", { method: combo ? "PUT" : "POST", json: { name, strategy, models: members } });
      toast.success("Saved");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const available = options.filter((o) => !members.includes(o) && o !== name);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{combo ? "Edit combo" : "New combo"}</DialogTitle>
          <DialogDescription>Members are tried top to bottom. Other combos can be members too.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-opus-5-5" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label>Strategy</Label>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as Combo["strategy"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fallback">Fallback (in order)</SelectItem>
                <SelectItem value="round-robin">Round robin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Members</Label>
            <div className="inset-group">
              {members.map((m, i) => (
                <div key={m} className="flex items-center gap-2 px-3 py-2 font-mono text-[13px]">
                  <span className="caption w-4">{i + 1}</span>
                  <span className="flex-1 truncate">{m}</span>
                  <Button variant="ghost" size="icon-xs" onClick={() => setMembers(members.filter((x) => x !== m))}><X className="size-3" /></Button>
                </div>
              ))}
              <div className="flex gap-2 p-2">
                <Select value={pick} onValueChange={(v) => setPick(v || "")}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Add a model or combo" /></SelectTrigger>
                  <SelectContent>
                    {available.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button variant="outline" disabled={!pick} onClick={() => { setMembers([...members, pick]); setPick(""); }}><Check className="size-3.5" />Add</Button>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !name.trim() || !members.length} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
