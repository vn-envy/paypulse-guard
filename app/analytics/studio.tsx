"use client";

import { useEffect, useMemo, useRef } from "react";
import { AgStudioAiModule, createAiHarness, enableStudioDevValidations, studioTheme, type AgStudioApi, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import type { AnalyticsData } from "@/lib/analytics";
import { guardedLlmAdapter } from "./llm-adapter";
import { dataSources, initialReport } from "./report";

const modules = [AgStudioAiModule];
// Edit mode: assistant on the left, compose and data on the right. Filters stay in view mode,
// which keeps the canvas wide enough to read while building.
const panelsWithAi = { edit: { left: ["ai"], right: ["edit", "data"] }, view: { right: ["filters"] } } as const;
const panelsNoAi = { edit: { right: ["edit", "data"] }, view: { right: ["filters"] } } as const;
const adapter = guardedLlmAdapter();
const promptStarters = [
  { label: "Who is out of pattern?", prompt: "Which clients are paying later than they usually do? Add a chart that shows it." },
  { label: "What did the guard stop?", prompt: "Break down what the guard refused by reason and by which agent was refused. Add a chart." },
  { label: "Compare the agents", prompt: "Compare the built-in agent with agents connected over MCP: how many proposals each made and what happened to them." },
];
// One harness per Studio instance; defined once so re-renders don't reset the chat threads.
const aiSetup = (params: any) => {
  const harness = createAiHarness(params.api, { adapter, promptStarters });
  (window as any).__ai = harness;
  return harness;
};

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const theme = studioTheme.withParams({
  fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  accentColor: "#1a46a8",
  textColor: "#14213a",
  foregroundColor: "#14213a",
  subtleTextColor: "#4b5772",
  backgroundColor: "#f7f9f4",
  borderColor: "#c6cfc2",
  studioCanvasBackgroundColor: "#e9ede6",
  studioCanvasFontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  chartFontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  chartTextColor: "#14213a",
  chartPaletteFills1Color: "#1a46a8",
  chartPaletteFills2Color: "#18704a",
  chartPaletteFills3Color: "#b3261e",
  chartPaletteFills4Color: "#c58a1c",
  chartPaletteFills5Color: "#14213a",
  chartPaletteFills6Color: "#7c869b",
  gridFontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  gridHeaderBackgroundColor: "#eef2ea",
} as any);

export default function Studio({ data, mode, licenseKey, ai }: { data: AnalyticsData; mode: AgStudioMode; licenseKey: string; ai: boolean }) {
  const apiRef = useRef<AgStudioApi | null>(null);
  // Field definitions and accessors are fixed for the session; only the rows change on refresh.
  const sources = useMemo(() => dataSources(data), [data]);

  useEffect(() => {
    (window as any).__studio = apiRef.current; // handy in the browser console; read only
  });

  return (
    <AgStudioProvider licenseKey={licenseKey || undefined} modules={ai ? modules : undefined}>
      <AgStudio
        data={sources}
        initialState={initialReport}
        mode={mode}
        theme={theme}
        style={{ height: "100%", width: "100%" }}
        ai={ai ? aiSetup : undefined}
        panels={(ai ? panelsWithAi : panelsNoAi) as any}
        onApiReady={(e: any) => {
          apiRef.current = e.api;
          (window as any).__studio = e.api;
        }}
        onErrorRaised={(e: any) => console.error("[ag-studio]", e?.error ?? e)}
      />
    </AgStudioProvider>
  );
}
