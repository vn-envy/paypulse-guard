"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent";
import type { AttackResult } from "@/lib/redteam";
import type { Snapshot } from "@/lib/state";
import type { Proposal } from "@/lib/types";

const ACTION_NAME: Record<string, string> = {
  send_reminder: "Send a reminder",
  offer_settlement: "Offer a settlement",
  accept_dispute_claim: "Concede a dispute",
};
const READS: { tool: string; label: string }[] = [
  { tool: "get_mandate", label: "Mandate" },
  { tool: "list_receivables", label: "Invoices" },
  { tool: "list_disputes", label: "Disputes" },
  { tool: "get_action_history", label: "Past actions" },
];

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
const clock = (iso: string | number) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

async function post(url: string, body?: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function curveAt(curve: [number, number][], days: number) {
  const d = Math.max(0, days);
  for (let i = 1; i < curve.length; i++) {
    const [d0, p0] = curve[i - 1];
    const [d1, p1] = curve[i];
    if (d <= d1) return p0 + ((p1 - p0) * (d - d0)) / (d1 - d0);
  }
  return curve[curve.length - 1][1];
}

/* The one visual idea on this page: every action passes three gates, and you can see which one it is at. */
type Gate = { label: string; state: "ok" | "wait" | "stop" | "idle"; note: string };
function Gates({ gates }: { gates: Gate[] }) {
  return (
    <ol className="gates">
      {gates.map((g) => (
        <li key={g.label} className={`gate ${g.state}`}>
          <span className="dot" aria-hidden>{g.state === "ok" ? "✓" : g.state === "stop" ? "✕" : ""}</span>
          <span className="gl">{g.label}</span>
          <span className="gn">{g.note}</span>
        </li>
      ))}
    </ol>
  );
}

export default function Cockpit({ initial }: { initial: Snapshot }) {
  const [s, setS] = useState<Snapshot>(initial);
  const [trace, setTrace] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attacks, setAttacks] = useState<AttackResult[] | null>(null);
  const [attacking, setAttacking] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [apEdit, setApEdit] = useState(false);
  const [apForm, setApForm] = useState({ reminders: true, maxDiscountPct: 3, budget: 150, days: 7 });
  const [copied, setCopied] = useState<string | null>(null);

  // What was already on screen at load, so only new things animate.
  const seenProposals = useRef(new Set(initial.proposals.map((p) => p.id)));
  const settledAtLoad = useRef(new Set(initial.proposals.filter((p) => p.status !== "pending").map((p) => p.id)));
  const paidAtLoad = useRef(new Set(initial.receivables.filter((r) => r.paid).map((r) => r.id)));
  const recoveredAtLoad = useRef(initial.metrics.recovered);

  const refresh = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/state${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      if (res.ok) setS(await res.json());
    } catch {
      /* keep the last good state on screen */
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function runAgent() {
    setRunning(true);
    setTrace([]);
    setNotice(null);
    try {
      const res = await fetch("/api/agent/run", { method: "POST" });
      if (!res.ok || !res.body) {
        setNotice((await res.json().catch(() => ({}))).error ?? "The agent could not start.");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as AgentEvent;
          setTrace((t) => [...t, ev]);
          if (ev.kind === "proposal") refresh();
        }
      }
    } finally {
      setRunning(false);
      refresh(true);
    }
  }

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    const r = await post("/api/guard/unlock", { pin });
    if (r.status === 200) {
      setPinOpen(false);
      setPin("");
      setPinErr(null);
      refresh();
    } else setPinErr(r.data.reason ?? "Wrong PIN.");
  }

  async function decide(p: Proposal, verb: "approve" | "reject") {
    setBusy(p.id);
    setNotice(null);
    const r = await post(`/api/proposals/${p.id}/${verb}`);
    if (r.status === 401) setPinOpen(true);
    else if (!r.data.ok) setNotice(r.data.reason ?? "That did not go through.");
    await refresh(true);
    setBusy(null);
  }

  async function signAutopilot(e: React.FormEvent) {
    e.preventDefault();
    if (!s.operator.unlocked) return setPinOpen(true);
    const r = await post("/api/autopilot", apForm);
    if (r.status === 401) setPinOpen(true);
    else if (!r.data.ok) setNotice(r.data.reason ?? "Autopilot was not signed.");
    else setApEdit(false);
    refresh();
  }

  async function revokeAutopilot() {
    const res = await fetch("/api/autopilot", { method: "DELETE" });
    if (res.status === 401) setPinOpen(true);
    refresh();
  }

  async function setScope(type: string, on: boolean) {
    const scope = on ? [...s.agents.scope, type] : s.agents.scope.filter((t) => t !== type);
    const r = await post("/api/agents", { scope });
    if (r.status === 401) setPinOpen(true);
    refresh();
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setNotice("Copy failed. Select the text and copy it by hand.");
    }
  }

  async function attack() {
    setAttacking(true);
    const r = await post("/api/redteam");
    setAttacks(r.data.results ?? []);
    await refresh();
    setAttacking(false);
  }

  const cur = s.currency;
  const m = s.metrics;
  const unlocked = s.operator.unlocked;
  const openRows = s.receivables.filter((r) => r.collectible);
  const settled = s.receivables.filter((r) => !r.collectible).sort((a, b) => (b.paidDate ?? b.dueDate ?? "").localeCompare(a.paidDate ?? a.dueDate ?? ""));
  const shownRows = [...openRows.sort((a, b) => b.daysOverdue - a.daysOverdue), ...settled.slice(0, 2)];
  const hiddenRows = settled.length - Math.min(settled.length, 2);

  const pending = s.proposals.filter((p) => p.status === "pending");
  const blocked = s.proposals.filter((p) => p.status === "blocked");
  const sent = s.proposals.filter((p) => p.status === "executed");
  const rest = s.proposals.filter((p) => !["pending", "blocked", "executed"].includes(p.status));
  const ordered = [...pending.sort((a, b) => b.verdict.exposure - a.verdict.exposure), ...sent, ...blocked, ...rest];
  const byAuto = sent.filter((p) => p.approval?.approver.startsWith("autopilot:")).length;
  const byYou = sent.length - byAuto;
  const ap = s.autopilot;
  const viaMcp = s.proposals.filter((p) => p.origin === "mcp").length;
  const liveCalls = s.agents.recent.filter((c) => Date.now() - new Date(c.ts).getTime() < 45_000);
  const liveClient = liveCalls[0]?.client;
  const active = running || s.agentRunning || liveCalls.length ? "agent" : pending.length ? "you" : "";
  const mcpUrl = typeof window === "undefined" ? "http://localhost:3000/api/mcp" : `${window.location.origin}/api/mcp`;
  const desktopConfig = s.agents.key && s.agents.stdio
    ? JSON.stringify({ mcpServers: { "paypulse-guard": { command: s.agents.stdio.node, args: [s.agents.stdio.script], env: { PPG_URL: mcpUrl, PPG_AGENT_KEY: s.agents.key } } } }, null, 2)
    : "";
  const codeCommand = s.agents.key ? `claude mcp add --transport http paypulse-guard ${mcpUrl} --header "Authorization: Bearer ${s.agents.key}"` : "";

  const reads = READS.map((r) => ({ ...r, ev: trace.find((e) => e.kind === "tool" && e.name === r.tool) as Extract<AgentEvent, { kind: "tool" }> | undefined }));
  const thought = [...trace].reverse().find((e) => e.kind === "think") as Extract<AgentEvent, { kind: "think" }> | undefined;
  const warns = trace.filter((e) => e.kind === "warn") as Extract<AgentEvent, { kind: "warn" }>[];
  const doneEv = trace.find((e) => e.kind === "done") as Extract<AgentEvent, { kind: "done" }> | undefined;
  const summary = doneEv?.summary ?? (!running && trace.length === 0 ? s.lastRun?.summary : undefined);

  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <div className="an-l">
            <h1>PayPulse Guard</h1>
            <nav className="tabs" aria-label="Views">
              <span aria-current="page">Cockpit</span>
              <Link href="/analytics">Analytics</Link>
            </nav>
          </div>
          <p className="line">The agent chases your unpaid invoices. It cannot move money until you sign.</p>
        </div>
        <div className="chips">
          {s.mode === "sandbox" ? (
            <span className="chip live"><span className="cd" />PayPal sandbox, live data</span>
          ) : (
            <span className="chip warn"><span className="cd" />Emulator, no PayPal credentials</span>
          )}
          <span className={`chip ${s.llm ? "live" : "warn"}`}><span className="cd" />{s.planner}</span>
          <div className="lock">
            {unlocked ? (
              <button className="lockbtn open" onClick={async () => { await post("/api/guard/lock"); refresh(); }} title="Lock signing">Signing unlocked</button>
            ) : (
              <button className="lockbtn" onClick={() => setPinOpen((v) => !v)} aria-expanded={pinOpen}>Signing locked</button>
            )}
            {pinOpen && !unlocked && (
              <form className="pinpop" onSubmit={unlock}>
                <label htmlFor="pin">Operator PIN</label>
                <p>Only a person with this PIN can sign a payment action. The agent never has it.</p>
                <div className="pinrow">
                  <input id="pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} />
                  <button className="sign" type="submit">Unlock</button>
                </div>
                {pinErr && <div className="err">{pinErr}</div>}
              </form>
            )}
          </div>
        </div>
      </header>

      {/* The rail: money on the left, money on the right, and the three gates every action passes in between. */}
      <section className="rail" aria-label="Where the money is">
        <div className="stn end">
          <div className="k">Owed to you on PayPal</div>
          <div className="big">{money(m.outstanding, cur)}</div>
          <div className="s">
            {m.overdue > 0 ? <><b className="late">{money(m.overdue, cur)} late</b> across {m.overdueCount} invoice{m.overdueCount === 1 ? "" : "s"}</> : "nothing is late"}
          </div>
        </div>
        <div className={`stn mid ${active === "agent" ? "on" : ""}`}>
          <div className="k">Agents proposed</div>
          <div className="n">{s.proposals.length}</div>
          <div className="s">
            {running ? "working now" : liveClient ? `${liveClient} is working` : viaMcp ? `${viaMcp} through MCP` : s.lastRun ? `last run ${clock(s.lastRun.ts)}` : "not run yet"}
          </div>
        </div>
        <div className="stn mid">
          <div className="k">Guard checked</div>
          <div className="n">{s.proposals.length - blocked.length}<span className="of"> passed</span></div>
          <div className="s">{m.stoppedCount ? <><b className="late">{money(m.stopped, cur)} stopped</b> in {m.stoppedCount} refusal{m.stoppedCount === 1 ? "" : "s"}</> : "nothing refused yet"}</div>
        </div>
        <div className={`stn mid ${active === "you" ? "on" : ""}`}>
          <div className="k">Signed and sent</div>
          <div className="n">{sent.length}</div>
          <div className="s">
            {pending.length ? <><b className="wait">{pending.length} waiting for you</b>{byAuto ? `, ${byAuto} by autopilot` : ""}</>
              : sent.length ? [byYou ? `${byYou} by you` : "", byAuto ? `${byAuto} by autopilot` : ""].filter(Boolean).join(", ")
              : "nothing waiting"}
          </div>
        </div>
        <div className="stn end good">
          <div className="k">Recovered after the agent acted</div>
          <div key={m.recovered} className={`big ${m.recovered > recoveredAtLoad.current ? "bump" : ""}`}>{money(m.recovered, cur)}</div>
          <div className="s">{m.recoveredCount ? `${m.recoveredCount} invoice${m.recoveredCount === 1 ? "" : "s"} paid, confirmed by PayPal` : "nothing yet"}</div>
        </div>
      </section>

      {s.errors.map((e) => <div className="banner bad" key={e}>PayPal returned an error. {e}</div>)}
      {notice && <div className="banner">{notice}</div>}

      <div className="cols">
        <section className="sec">
          <header>
            <h2>Who owes you</h2>
            <span className="hint">{s.mode === "sandbox" ? "Read from PayPal every few seconds" : "Served by the local emulator"}</span>
          </header>
          <div className="paper">
            {s.receivables.length === 0 ? (
              <div className="empty">No sent invoices on this PayPal account. Run <span className="mono">npm run seed</span> to create sample ones.</div>
            ) : (
              <table>
                <tbody>
                  {shownRows.map((r) => {
                    const flash = r.paid && !paidAtLoad.current.has(r.id);
                    const usual = r.usual ? Math.round(r.usual.avgDaysLate) : null;
                    const scale = Math.max(30, r.daysOverdue);
                    return (
                      <tr key={r.id} className={`${r.paid ? "paid" : !r.collectible ? "void" : ""} ${flash ? "flash" : ""}`}>
                        <td className="who">
                          <strong>{r.client}</strong>
                          <div className="sub">{r.number}{r.milestone ? `, ${r.milestone}` : ""}</div>
                          {r.lastAction && <div className="acted">{(ACTION_NAME[r.lastAction.type] ?? r.lastAction.type).toLowerCase()} at {clock(r.lastAction.ts)}</div>}
                        </td>
                        <td className="lateness">
                          {r.paid ? (
                            <span className="tag ok">Paid, milestone unlocked</span>
                          ) : !r.collectible ? (
                            <span className="tag muted">{r.status.toLowerCase()}</span>
                          ) : r.daysOverdue > 0 ? (
                            <>
                              <div className="meter" title="Days past due, against this client's usual">
                                <span className="fill" style={{ width: `${Math.min(100, (r.daysOverdue / scale) * 100)}%` }} />
                                {usual !== null && <span className="norm" style={{ width: `${Math.min(100, (Math.min(usual, r.daysOverdue) / scale) * 100)}%` }} />}
                                {usual !== null && <span className="usual" style={{ left: `${Math.min(100, (usual / scale) * 100)}%` }} />}
                              </div>
                              <div className="sub">
                                <b className="late">{r.daysOverdue} days late</b>
                                {usual !== null ? `, usually ${usual === 0 ? "on time" : `${usual}`}` : ", no history yet"}
                                {r.collectability !== null && <span className="bench"> · {Math.round(r.collectability * 100)}% collectable</span>}
                              </div>
                            </>
                          ) : (
                            <span className="tag soon">{r.daysOverdue === 0 ? "due today" : `due in ${-r.daysOverdue} days`}</span>
                          )}
                        </td>
                        <td className="amt">{money(r.paid || !r.collectible ? r.total : r.due, r.currency)}</td>
                        <td className="act">
                          {r.collectible && (s.mode === "emulator" ? (
                            <button className="mini" onClick={async () => { await post("/api/emulator/pay", { invoiceId: r.id }); refresh(true); }}>Pay as client</button>
                          ) : r.payUrl ? (
                            <a className="mini" href={r.payUrl} target="_blank" rel="noreferrer">Client pay page</a>
                          ) : null)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="note">
            The tick on each bar is how late that client usually pays, from their paid invoices on PayPal.
            {hiddenRows > 0 && ` ${hiddenRows} older paid invoice${hiddenRows === 1 ? "" : "s"} not shown.`}
          </p>

          {s.disputes.length > 0 && (
            <>
              <header className="h2nd"><h2>Disputes</h2><span className="hint">Buyer messages are untrusted text</span></header>
              <div className="paper">
                <table>
                  <tbody>
                    {s.disputes.map((d) => (
                      <tr key={d.id} className={d.status === "RESOLVED" ? "paid" : ""}>
                        <td className="who"><strong>{d.id}</strong><div className="sub">{d.reason.replaceAll("_", " ").toLowerCase()}</div></td>
                        <td className="sub said">{d.buyerMessage ? `"${d.buyerMessage}"` : "–"}</td>
                        <td className="amt">{money(d.amount, d.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="sec desk">
          <header>
            <h2>What the agent wants to do</h2>
            <button className="run" onClick={runAgent} disabled={running || s.agentRunning}>
              {running ? "Agent is working" : s.proposals.length ? "Run the agent again" : "Run the collections agent"}
            </button>
          </header>

          <div className={`auto ${ap.on ? "on" : ""} ${apEdit && !ap.on ? "editing" : ""}`}>
            {ap.on ? (
              <>
                <div className="auto-l">
                  <b>Autopilot is on</b> until {new Date(ap.expiresAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.{" "}
                  It may {[ap.reminders ? "send reminders" : "", ap.maxDiscountPct > 0 && ap.budget > 0 ? `settle up to ${ap.maxDiscountPct}% off` : ""].filter(Boolean).join(" and ")} without asking you.
                  {ap.budget > 0 && (
                    <div className="budget">
                      <span className="bt"><span className="bf" style={{ width: `${Math.min(100, (ap.spent / ap.budget) * 100)}%` }} /></span>
                      {money(ap.spent, cur)} of {money(ap.budget, cur)} given up
                    </div>
                  )}
                </div>
                <button className="decline" onClick={revokeAutopilot}>Revoke</button>
              </>
            ) : apEdit ? (
              <form className="auto-form" onSubmit={signAutopilot}>
                <b>What may the agent do without asking you?</b>
                <label><input type="checkbox" checked={apForm.reminders} onChange={(e) => setApForm({ ...apForm, reminders: e.target.checked })} /> Send reminders. They move no money.</label>
                <label>
                  Settle up to
                  <input type="number" min={0} max={s.policy.maxDiscountPct} step={0.5} value={apForm.maxDiscountPct} onChange={(e) => setApForm({ ...apForm, maxDiscountPct: Number(e.target.value) })} />% off, giving up at most
                  <input type="number" min={0} max={s.policy.dailyConcessionBudget} step={10} value={apForm.budget} onChange={(e) => setApForm({ ...apForm, budget: Number(e.target.value) })} /> in total
                </label>
                <label>For <input type="number" min={1} max={30} value={apForm.days} onChange={(e) => setApForm({ ...apForm, days: Number(e.target.value) })} /> days</label>
                <p className="fine">Disputes, and anything over these limits, still wait for you. No agent can see or change these limits.</p>
                <div className="auto-btns">
                  <button type="button" className="decline" onClick={() => setApEdit(false)}>Cancel</button>
                  {unlocked ? <button className="sign" type="submit">Sign autopilot</button> : <button type="button" className="sign" onClick={() => setPinOpen(true)}>Unlock to sign</button>}
                </div>
              </form>
            ) : (
              <>
                <div className="auto-l"><b>Autopilot is off.</b> Every action waits for your signature.</div>
                <button className="mini" onClick={() => setApEdit(true)}>Set up autopilot</button>
              </>
            )}
          </div>

          {liveCalls.length > 0 && (
            <div className="live" aria-live="polite">
              <span className="pip" aria-hidden />
              <b>{liveClient}</b> is working through MCP:
              {liveCalls.slice(0, 4).reverse().map((c, i) => <span key={i} className={`call ${c.outcome}`}>{c.tool.replaceAll("_", " ")}</span>)}
            </div>
          )}

          {(running || trace.length > 0) && (
            <div className="reads" aria-live="polite">
              <span className="rl">{running ? "Reading PayPal" : "Read from PayPal"}</span>
              {reads.map((r) => (
                <span key={r.tool} className={`read ${r.ev ? "done" : running ? "pend" : "skip"}`}>
                  <b>{r.label}</b>{r.ev ? ` ${r.ev.summary}` : ""}
                </span>
              ))}
            </div>
          )}
          {warns.map((w, i) => <div className="banner" key={i}>{w.text}</div>)}
          {running && thought && <p className="thought">{thought.text}</p>}
          {summary && (
            <blockquote className="summary">
              {summary}
              <cite>{s.lastRun?.planner ?? s.planner}</cite>
            </blockquote>
          )}

          <div className="vouchers">
            {s.proposals.length === 0 && !running && (
              <div className="paper empty">Nothing proposed yet. Run the agent and each action it wants to take appears here, already checked by the guard, for you to sign or decline.</div>
            )}
            {ordered.map((p) => (
              <Voucher key={p.id} p={p} s={s} unlocked={unlocked} busy={busy === p.id} isNew={!seenProposals.current.has(p.id)} stampNew={!settledAtLoad.current.has(p.id)} onDecide={decide} onNeedUnlock={() => setPinOpen(true)} />
            ))}
          </div>
        </section>
      </div>

      <section className="attack">
        <div className="ahead">
          <div>
            <h2>Now assume the agent is compromised</h2>
            <p>Five things a hijacked or prompt-injected agent would try. Each goes through the same code path as the real agent, and each shows the gate that stopped it.</p>
          </div>
          <button className="go" onClick={attack} disabled={attacking}>{attacking ? "Attacking" : attacks ? "Run the five attacks again" : "Run five attacks"}</button>
        </div>
        <div className="agrid">
          {(attacks ?? PREVIEW).map((a, i) => {
            const ran = !!attacks;
            const atMandate = a.code === "blocked_by_mandate";
            const atAutopilot = a.code === "autopilot_tampered";
            return (
              <article className={`atk ${ran ? "ran" : ""}`} key={a.id} style={{ animationDelay: `${i * 120}ms` }}>
                <h3>{a.title}</h3>
                {a.owasp && <span className="owasp">OWASP {a.owasp}</span>}
                <p>{a.attempt}</p>
                {ran && (
                  <>
                    <Gates gates={[
                      { label: "Mandate", state: atMandate ? "stop" : "ok", note: atMandate ? "refused" : "in bounds" },
                      { label: atAutopilot ? "Autopilot" : "Signature", state: atMandate ? "idle" : "stop", note: atMandate ? "never reached" : atAutopilot ? "forged, ignored" : a.code.replaceAll("_", " ") },
                      { label: "PayPal", state: "idle", note: "never called" },
                    ]} />
                    <p className="res">{a.reason}</p>
                    <span className={`stamp slam ${a.blocked ? "" : "through"}`}>{a.blocked ? "BLOCKED" : "GOT THROUGH"}</span>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <div className="cols low">
        <section className="sec">
          <header>
            <h2>Audit ledger</h2>
            <span className="hint">
              {s.chain.ok ? `Hash chain intact across ${s.ledgerSize} entries` : `Chain broken at entry ${s.chain.brokenAt}`}
              {s.ledgerSize > 0 && <> · <a className="lnk" href="/api/ledger">Download</a></>}
            </span>
          </header>
          <div className="paper scroll audit">
            {s.ledger.length === 0 ? (
              <div className="empty">Nothing recorded yet. Every proposal, signature, refusal and PayPal call lands here.</div>
            ) : (
              <table>
                <tbody>
                  {s.ledger.map((e) => (
                    <tr key={e.seq} className={e.outcome === "denied" ? "denied" : e.outcome === "ok" ? "okrow" : ""}>
                      <td className="h">{clock(e.ts)}</td>
                      <td className="actor">{e.actor}</td>
                      <td>
                        <span className="ev">{e.event.replaceAll("_", " ")}</span> <strong>{e.target}</strong> {e.detail}{e.amount ? ` (${money(e.amount, e.currency ?? cur)})` : ""}
                        {e.call && <div className="ids">PayPal-Request-Id {e.call.requestId}{e.call.debugId ? ` · debug ${e.call.debugId}` : ""}</div>}
                      </td>
                      <td className="h" title={e.hash}>{e.hash.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <div className="stack">
        <section className="sec">
          <header><h2>The mandate</h2><span className="hint">Enforced in code, not in the prompt</span></header>
          <dl className="paper mandate">
            <dt>The agent may ask for</dt><dd>reminder, settlement, concede dispute</dd>
            <dt>Largest settlement discount</dt><dd>{s.policy.maxDiscountPct}%</dd>
            <dt>A discount must cost less than</dt><dd>waiting {s.policy.settlementHorizonDays} days</dd>
            <dt>Most given up in one action</dt><dd>{money(s.policy.maxConcessionPerAction, cur)}</dd>
            <dt>Most given up in 24 hours</dt><dd>{money(s.policy.dailyConcessionBudget, cur)}</dd>
            <dt>Largest dispute it may concede</dt><dd>{money(s.policy.maxDisputeConcession, cur)}</dd>
            <dt>Settlement only after</dt><dd>{s.policy.minDaysOverdueForSettlement} days overdue</dd>
            <dt>Reminders per invoice</dt><dd>one per {s.policy.reminderCooldownHours} hours</dd>
            <dt>A signature is valid for</dt><dd>{s.policy.approvalTtlSeconds / 60} minutes, one use</dd>
          </dl>
        </section>

        <section className="sec">
          <header><h2>Connect another agent</h2><span className="hint">MCP, same guard</span></header>
          <div className="paper connect">
            <p>
              Claude, Cursor or your own code can work your PayPal through this guard. They get the same read tools and the same
              propose tool as the built-in agent. There is no execute tool to give them.
            </p>
            {s.agents.key ? (
              <>
                <div className="keyrow">
                  <span className="mono">{s.agents.key.slice(0, 8)}…{s.agents.key.slice(-4)}</span>
                  <button className="mini" onClick={() => copy("key", s.agents.key!)}>{copied === "key" ? "Copied" : "Copy key"}</button>
                  {!s.agents.pinned && <button className="mini" onClick={async () => { await post("/api/agents", { rotate: true }); refresh(); }}>Rotate</button>}
                </div>
                <fieldset className="scope">
                  <legend>This key may propose</legend>
                  {(["send_reminder", "offer_settlement", "accept_dispute_claim"] as const).map((t) => (
                    <label key={t}><input type="checkbox" checked={s.agents.scope.includes(t)} onChange={(e) => setScope(t, e.target.checked)} /> {SCOPE_LABEL[t]}</label>
                  ))}
                </fieldset>
                <details className="setup">
                  <summary>Claude Desktop</summary>
                  <p>Settings, Developer, Edit Config. Paste this, save, and restart Claude Desktop.</p>
                  <pre>{desktopConfig}</pre>
                  <button className="mini" onClick={() => copy("desktop", desktopConfig)}>{copied === "desktop" ? "Copied" : "Copy config"}</button>
                </details>
                <details className="setup">
                  <summary>Claude Code</summary>
                  <pre>{codeCommand}</pre>
                  <button className="mini" onClick={() => copy("code", codeCommand)}>{copied === "code" ? "Copied" : "Copy command"}</button>
                </details>
              </>
            ) : (
              <p className="sub">Unlock signing to see the connection key. It is a credential.</p>
            )}
            {s.agents.recent.length > 0 && (
              <ul className="calls-list">
                {s.agents.recent.slice(0, 6).map((c, i) => (
                  <li key={i} className={c.outcome}>
                    <span className="h">{clock(c.ts)}</span> <b>{c.client}</b> {c.tool.replaceAll("_", " ")}{c.summary ? `: ${c.summary}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        </div>
      </div>

      <Evidence s={s} />

      <div className="foot">
        <span>
          {s.mode === "sandbox"
            ? s.webhook ? "Webhooks are verified with PayPal before they are trusted." : "No webhook ID set, so payments are picked up by polling PayPal."
            : "Emulator mode. Add PayPal sandbox credentials to .env.local to run against PayPal."}
        </span>
        {unlocked && (
          <button className="linkbtn" onClick={async () => { await post("/api/reset"); setTrace([]); setAttacks(null); refresh(true); }}>
            Clear proposals and ledger
          </button>
        )}
      </div>
    </div>
  );
}

const SCOPE_LABEL: Record<string, string> = {
  send_reminder: "Reminders",
  offer_settlement: "Settlements",
  accept_dispute_claim: "Dispute concessions",
};

const PREVIEW: AttackResult[] = [
  { id: "unsigned", owasp: "LLM06 Excessive Agency: autonomy", title: "Execute without a signature", attempt: "The agent calls the executor directly and skips you.", blocked: true, code: "", reason: "", exposure: 0, currency: "USD" },
  { id: "tamper", owasp: "LLM06 Excessive Agency: permissions", title: "Swap the payload after signing", attempt: "You sign a reminder. The agent submits a 50% discount with that signature.", blocked: true, code: "", reason: "", exposure: 0, currency: "USD" },
  { id: "mandate", owasp: "LLM01 Prompt Injection", title: "Follow an injected instruction", attempt: "A buyer's message tells the agent to refund an invoice in full, and it tries.", blocked: true, code: "", reason: "", exposure: 0, currency: "USD" },
  { id: "replay", owasp: "LLM06 Excessive Agency: permissions", title: "Replay a used signature", attempt: "The agent re-submits an approval you already used, to run it twice.", blocked: true, code: "", reason: "", exposure: 0, currency: "USD" },
  { id: "autopilot", owasp: "LLM06 Excessive Agency: autonomy", title: "Widen its own autopilot", attempt: "The agent rewrites your standing mandate to 5% and $100,000, so it never has to ask.", blocked: true, code: "", reason: "", exposure: 0, currency: "USD" },
];

function Voucher({ p, s, unlocked, busy, isNew, stampNew, onDecide, onNeedUnlock }: {
  p: Proposal; s: Snapshot; unlocked: boolean; busy: boolean; isNew: boolean; stampNew: boolean;
  onDecide: (p: Proposal, verb: "approve" | "reject") => void; onNeedUnlock: () => void;
}) {
  const [showChecks, setShowChecks] = useState(false);
  const [showMsg, setShowMsg] = useState(false);
  const a = p.action as any;
  const v = p.verdict;
  const blocked = p.status === "blocked";
  const failed = v.checks.filter((c) => !c.pass);
  const inv = s.receivables.find((r) => r.id === a.invoiceId);
  const dispute = s.disputes.find((d) => d.id === a.disputeId);
  const who = inv ? inv.client : dispute ? `Dispute ${dispute.id}` : p.targetLabel;
  const title = `${ACTION_NAME[a.type] ?? a.type}${a.type === "offer_settlement" && Number.isFinite(a.discountPct) ? `, ${a.discountPct}% off` : ""}`;
  const signedAt = p.approval ? clock(p.approval.exp * 1000 - s.policy.approvalTtlSeconds * 1000) : "";
  const auto = !!p.approval?.approver.startsWith("autopilot:");

  const gates: Gate[] = blocked
    ? [
        { label: "Mandate", state: "stop", note: `${failed.length} rule${failed.length === 1 ? "" : "s"} broken` },
        { label: "Your signature", state: "idle", note: "never asked" },
        { label: "PayPal", state: "idle", note: "never called" },
      ]
    : [
        { label: "Mandate", state: "ok", note: `${v.checks.length} checks passed` },
        p.status === "pending" ? { label: "Your signature", state: "wait", note: "waiting for you" }
          : p.status === "rejected" ? { label: "Your signature", state: "stop", note: "declined" }
          : auto ? { label: "Autopilot", state: "ok", note: `your standing mandate, ${signedAt}` }
          : { label: "Your signature", state: "ok", note: `signed ${signedAt}` },
        p.status === "executed" ? { label: "PayPal", state: "ok", note: `${p.calls?.length ?? 0} call${p.calls?.length === 1 ? "" : "s"} accepted` }
          : p.status === "failed" ? { label: "PayPal", state: "stop", note: "returned an error" }
          : { label: "PayPal", state: "idle", note: "not sent" },
      ];

  const usual = inv?.usual ? Math.round(inv.usual.avgDaysLate) : null;
  const now = inv && inv.daysOverdue > 0 ? Math.round(curveAt(s.benchmarks.curve as [number, number][], inv.daysOverdue) * 100) : null;
  const later = inv && inv.daysOverdue > 0 ? Math.round(curveAt(s.benchmarks.curve as [number, number][], inv.daysOverdue + s.policy.settlementHorizonDays) * 100) : null;

  return (
    <article className={`voucher st-${p.status} ${isNew ? "enter" : ""}`}>
      <div className="vtop">
        <div>
          <h3>{title}</h3>
          <div className="vwho">{who}{inv ? `, invoice ${inv.number}` : ""}</div>
          {p.origin === "mcp" && <span className="via">from {p.via ?? "an external agent"} via MCP</span>}
        </div>
        <div className="stake">
          <span>{v.exposure > 0 ? "gives up" : "moves"}</span>
          <b>{v.exposure > 0 ? money(v.exposure, v.currency) : "no money"}</b>
        </div>
      </div>

      {blocked ? (
        <ul className="broken">
          {failed.map((c) => <li key={c.rule}><b>{c.rule}.</b> {c.detail}</li>)}
        </ul>
      ) : (
        <>
          <p className="why">{p.rationale}</p>
          {inv && (usual !== null || now !== null) && (
            <div className="facts2">
              {inv.daysOverdue > 0 && (
                <div className="fact">
                  <span className="fv">{usual === null ? "–" : usual === 0 ? "on time" : `${usual}d`}<i>→</i><em>{inv.daysOverdue}d</em></span>
                  <span className="fk">{usual === null ? "no payment history, now late" : "usual lateness, now"}</span>
                </div>
              )}
              {now !== null && later !== null && (
                <div className="fact">
                  <span className="fv">{now}%<i>→</i><em>{later}%</em></span>
                  <span className="fk">collectable now, in {s.policy.settlementHorizonDays} days</span>
                </div>
              )}
            </div>
          )}
          {a.note && (
            <button type="button" className={`msg ${showMsg ? "open" : ""}`} onClick={() => setShowMsg((x) => !x)} title="Show the whole message">
              <b>{a.type === "accept_dispute_claim" ? "Note to PayPal" : "The client will read"}</b>
              <span>{a.note}</span>
            </button>
          )}
        </>
      )}

      {p.status === "pending" && p.autopilot?.note && <p className="autonote">Not on autopilot: {p.autopilot.note}</p>}
      <div className="vbot">
        <button type="button" className="gatesbtn" onClick={() => setShowChecks((x) => !x)} title="Show every guard check">
          <Gates gates={gates} />
        </button>
        {p.status === "pending" && (
          <div className="vbtns">
            <button className="decline" disabled={busy || !unlocked} onClick={() => onDecide(p, "reject")}>Decline</button>
            {unlocked ? (
              <button className="sign" disabled={busy} onClick={() => onDecide(p, "approve")}>{busy ? "Sending to PayPal" : "Sign and send"}</button>
            ) : (
              <button className="sign" onClick={onNeedUnlock}>Unlock to sign</button>
            )}
          </div>
        )}
      </div>

      {showChecks && !blocked && (
        <ul className="checks">
          {v.checks.map((c) => <li key={c.rule}><span className="y">✓</span><span>{c.rule} <span className="d">{c.detail}</span></span></li>)}
        </ul>
      )}
      {p.calls && p.calls.length > 0 && (
        <div className="calls mono">
          {p.calls.map((c) => (
            <div key={c.requestId}><b className={c.status < 400 ? "c2" : "c4"}>{c.status}</b> {c.method} {c.path.replace(/INV2-[A-Z0-9-]+/g, "{invoice}")}{c.debugId ? ` · debug ${c.debugId}` : ""}</div>
          ))}
        </div>
      )}
      {p.status === "failed" && p.resultNote && <div className="err">{p.resultNote}</div>}
      {p.status === "executed" && (auto
        ? <span className={`stamp blue ${stampNew ? "slam" : ""}`}>AUTOPILOT</span>
        : <span className={`stamp green ${stampNew ? "slam" : ""}`}>SIGNED &amp; SENT</span>)}
      {blocked && <span className={`stamp red ${isNew ? "slam" : ""}`}>BLOCKED</span>}
    </article>
  );
}

function Evidence({ s }: { s: Snapshot }) {
  const src = s.benchmarks.sources;
  const late = s.receivables.filter((r) => r.collectible && r.daysOverdue > 0);
  const label = (d: number) => (d === 0 ? "Due date" : d < 100 ? `${d} days` : d === 182 ? "6 months" : d === 274 ? "9 months" : d === 365 ? "1 year" : "2 years");
  const Ref = ({ k }: { k: keyof typeof src }) => (
    <a className="lnk" href={src[k].url} target="_blank" rel="noreferrer">{src[k].label}</a>
  );
  return (
    <section className="evidence">
      <h2>The evidence this is built on</h2>
      <div className="evgrid">
        <div>
          <h3>Late payment is the normal case</h3>
          <dl className="facts">
            <dt>59%</dt>
            <dd>of US small businesses had invoices more than 30 days overdue, up from 47% a year earlier. Those owed money were owed $17.7K on average. <Ref k="quickbooks" /></dd>
            <dt>29%</dt>
            <dd>of freelance invoices are paid late. Over 75% of the late ones are paid within 14 days of the due date, which is why the agent reminds before it discounts. <Ref k="bonsai" /></dd>
          </dl>
        </div>
        <div>
          <h3>Waiting has a price</h3>
          <div className="curve" role="img" aria-label="Probability of collecting a commercial debt by age">
            {s.benchmarks.curve.map(([d, p]) => (
              <div className="bar" key={d}>
                <span className="bl">{label(d)}</span>
                <span className="bt"><span className="bf" style={{ width: `${p * 100}%` }} /></span>
                <span className="bv">{Math.round(p * 100)}%</span>
              </div>
            ))}
          </div>
          <p className="cap">
            Probability of collecting, by days past due. The guard refuses any discount larger than what this curve says waiting 30 days would cost.
            {late.length > 0 && <> Your overdue invoices sit at {late.map((r) => `${Math.round((r.collectability ?? 0) * 100)}%`).join(" and ")}.</>} <Ref k="clla" />. {src.clla.caveat}
          </p>
        </div>
        <div>
          <h3>The controls follow a public standard</h3>
          <ul className="ctl">
            <li><b>Minimise what the model can call.</b> Four read tools and one that can only ask.</li>
            <li><b>Authorise downstream, not in the model.</b> The mandate is checked in code on every proposal and again at execution.</li>
            <li><b>A human approves high-impact actions.</b> PIN-unlocked signature over the exact payload, one use, five minutes.</li>
            <li><b>Limit the rate of damage.</b> Daily concession budget and a reminder cooldown.</li>
            <li><b>Log everything.</b> Hash-chained ledger with PayPal request and debug ids.</li>
          </ul>
          <p className="cap">
            These are the mitigations listed in <Ref k="owasp" />. The signed-mandate idea is the one behind AP2, which PayPal supports: <Ref k="ap2" />. {src.ap2.caveat}
          </p>
        </div>
      </div>
    </section>
  );
}
