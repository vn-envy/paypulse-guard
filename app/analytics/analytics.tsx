"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AnalyticsData } from "@/lib/analytics";

// AG Studio is browser-only and large: load it on this page alone, after the shell renders.
const Studio = dynamic(() => import("./studio"), { ssr: false, loading: () => <div className="studio-loading">Loading AG Studio</div> });

export default function Analytics({ initial, licenseKey, ai }: { initial: AnalyticsData; licenseKey: string; ai: boolean }) {
  const [data, setData] = useState(initial);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [live, setLive] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/analytics", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* keep the last good data */
    }
  }, []);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [live, refresh]);

  return (
    <div className="an">
      <header className="an-head">
        <div className="an-l">
          <h1>PayPulse Guard</h1>
          <nav className="tabs" aria-label="Views">
            <Link href="/">Cockpit</Link>
            <span aria-current="page">Analytics</span>
          </nav>
        </div>
        <div className="an-r">
          <span className="hint">
            {data.invoices.length} invoices, {data.actions.length} proposals, {data.refusals.length} refusals. Updated{" "}
            {new Date(data.generatedAt).toLocaleTimeString("en-GB", { hour12: false })}
          </span>
          <label className="live">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live
          </label>
          <button className="mini" onClick={refresh}>Refresh</button>
          <button className="mini" onClick={() => setMode(mode === "view" ? "edit" : "view")}>
            {mode === "view" ? "Build your own view" : "Done editing"}
          </button>
        </div>
      </header>
      <div className="studio-wrap">
        <Studio data={data} mode={mode} licenseKey={licenseKey} ai={ai} />
      </div>
    </div>
  );
}
