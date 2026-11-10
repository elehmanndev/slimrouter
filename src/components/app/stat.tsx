import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stat({ label, value, hint, className, icon }: { label: string; value: ReactNode; hint?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn("surface flex flex-col gap-1 p-4", className)}>
      <div className="flex items-center justify-between">
        <span className="caption font-medium uppercase tracking-wide text-[11px]">{label}</span>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <div className="tabular text-2xl font-semibold tracking-tight">{value}</div>
      {hint ? <div className="caption">{hint}</div> : null}
    </div>
  );
}

export function Meter({ value, tone = "auto", className }: { value: number; tone?: "auto" | "primary" | "success" | "warning" | "destructive"; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const auto = v >= 90 ? "bg-destructive" : v >= 70 ? "bg-warning" : "bg-primary";
  const color = tone === "auto" ? auto : tone === "primary" ? "bg-primary" : tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-destructive";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="surface flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      {children ? <p className="caption max-w-md">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
