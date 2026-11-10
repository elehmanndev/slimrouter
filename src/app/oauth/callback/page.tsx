"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

function Callback() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Finishing sign-in…");
  useEffect(() => {
    const id = setTimeout(run, 0);
    return () => clearTimeout(id);
    function run() {
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error_description") || params.get("error");
    if (error) {
      setStatus("error");
      setMessage(error);
      return;
    }
    if (!code) {
      setStatus("error");
      setMessage("No authorization code in the callback URL.");
      return;
    }
    api<{ name: string }>("/api/admin/oauth/complete", { method: "POST", json: { code, state } })
      .then((c) => {
        setStatus("done");
        setMessage(`Connected ${c.name}. You can close this window.`);
        try {
          window.opener?.postMessage({ type: "slimrouter-oauth", ok: true }, location.origin);
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (window.opener) window.close();
          else router.push("/providers");
        }, 1200);
      })
      .catch((e: Error) => {
        setStatus("error");
        setMessage(e.message);
      });
    }
  }, [params, router]);
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="surface flex max-w-md items-center gap-3 p-6">
        {status === "working" ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : status === "done" ? <CheckCircle2 className="size-5 text-success" /> : <CircleAlert className="size-5 text-destructive" />}
        <p className="text-sm">{message}</p>
      </div>
    </main>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}
