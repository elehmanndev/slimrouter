"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export function usePoll<T>(path: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    const first = setTimeout(load, 0);
    const t = intervalMs > 0 ? setInterval(load, intervalMs) : null;
    return () => {
      alive.current = false;
      clearTimeout(first);
      if (t) clearInterval(t);
    };
  }, [load, intervalMs]);
  return { data, error, loading, reload: load };
}
