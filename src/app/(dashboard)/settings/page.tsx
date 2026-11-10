"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";

interface Strategy { strategy: "fill-first" | "round-robin"; stickyLimit: number; minRemainingSessionPercent: number; minRemainingWeeklyPercent: number }
interface SettingsData { requireApiKey: boolean; defaultStrategy: Strategy; quotaRefreshSec: number; passwordSet: boolean }

export default function SettingsPage() {
  const { data, reload } = usePoll<SettingsData>("/api/admin/settings");
  const [s, setS] = useState<SettingsData | null>(null);
  const [pw, setPw] = useState("");
  const [seen, setSeen] = useState<SettingsData | null>(null);
  if (seen !== data) {
    setSeen(data);
    setS(data);
  }
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api("/api/admin/settings", { method: "PATCH", json: patch });
      toast.success("Saved");
      void reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!s) return <PageHeader title="Settings" />;
  const d = s.defaultStrategy;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex max-w-2xl flex-col gap-6 p-4 md:p-6">
        <section className="inset-group">
          <Row label="Require an API key" hint="When off, requests from localhost are accepted without a key.">
            <Switch checked={s.requireApiKey} onCheckedChange={(v) => void save({ requireApiKey: v })} />
          </Row>
          <Row label="Quota refresh" hint="How often subscription windows are re-read, in seconds.">
            <Input type="number" min={30} className="w-24" value={s.quotaRefreshSec} onChange={(e) => setS({ ...s, quotaRefreshSec: Number(e.target.value) })} onBlur={() => void save({ quotaRefreshSec: s.quotaRefreshSec })} />
          </Row>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Default routing</h2>
          <p className="caption mb-3">Applied to every provider that has no override on the Providers page.</p>
          <div className="inset-group">
            <Row label="Strategy" hint="Fill first drains one account before the next. Round robin rotates.">
              <Select value={d.strategy} onValueChange={(v) => void save({ defaultStrategy: { ...d, strategy: v } })}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fill-first">Fill first</SelectItem>
                  <SelectItem value="round-robin">Round robin</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Sticky requests" hint="Consecutive requests one account serves before round robin moves on.">
              <Input type="number" min={1} className="w-24" value={d.stickyLimit} onChange={(e) => setS({ ...s, defaultStrategy: { ...d, stickyLimit: Number(e.target.value) } })} onBlur={() => void save({ defaultStrategy: d })} />
            </Row>
            <Row label="Stop at 5h window" hint="Skip an account once less than this percent of its 5 hour window remains. 0 disables.">
              <Input type="number" min={0} max={100} className="w-24" value={d.minRemainingSessionPercent} onChange={(e) => setS({ ...s, defaultStrategy: { ...d, minRemainingSessionPercent: Number(e.target.value) } })} onBlur={() => void save({ defaultStrategy: d })} />
            </Row>
            <Row label="Stop at weekly window" hint="Same for the 7 day window.">
              <Input type="number" min={0} max={100} className="w-24" value={d.minRemainingWeeklyPercent} onChange={(e) => setS({ ...s, defaultStrategy: { ...d, minRemainingWeeklyPercent: Number(e.target.value) } })} onBlur={() => void save({ defaultStrategy: d })} />
            </Row>
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Dashboard password</h2>
          <div className="inset-group">
            <Row label={s.passwordSet ? "Change password" : "Set a password"} hint="Leave empty and save to remove it (LAN only).">
              <div className="flex gap-2">
                <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" />
                <Button variant="outline" onClick={() => { void save({ newPassword: pw }); setPw(""); }}>Save</Button>
              </div>
            </Row>
          </div>
        </section>
      </div>
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint ? <p className="caption mt-0.5">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
