"use client";
import { useEffect, useState } from "react";

/** A clock value that is stable during render and ticks on an interval. */
export function useNow(intervalMs = 15000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function isLocked(data: { lockedUntil?: string | null; modelLocks?: Record<string, string> }, now: number): boolean {
  if (data.lockedUntil && Date.parse(data.lockedUntil) > now) return true;
  return Object.values(data.modelLocks || {}).some((t) => Date.parse(t) > now);
}
