export function fmtNum(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function fmtUsd(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return v < 0.01 && v > 0 ? "<$0.01" : `$${v.toFixed(2)}`;
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "–";
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 60e3 ? [Math.round(abs / 1e3), "s"] : abs < 3600e3 ? [Math.round(abs / 60e3), "m"] : abs < 86400e3 ? [Math.round(abs / 3600e3), "h"] : [Math.round(abs / 86400e3), "d"];
  return diff > 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}

export function fmtCountdown(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "resets now";
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  if (h >= 48) return `resets in ${Math.round(h / 24)}d`;
  return `resets in ${h ? `${h}h ` : ""}${m}m`;
}
