# Devpost submission text (draft)

Replace the bracketed parts. Keep claims to what the repo and video show.

**Tagline:** Let any AI agent chase your PayPal invoices, inside limits it can't change.

**Prize categories to tick:** Best Use of Agentic Commerce, Best Use of PayPal + AI, AG Grid sponsor prize (plus the main prizes). Check the AG Grid prize page for any extra entry requirement (for example a separate form or a note naming the AG product used) and follow it.

## Inspiration
[One or two sentences in your own words: your experience invoicing clients, or watching freelancers chase payments. Real beats polished.]
Late payment is the normal case, not the exception: 59% of US small businesses had invoices more than 30 days overdue this year, up from 47%, with $17.7K owed on average (Intuit QuickBooks, 2026 Small Business Late Payments Report). For freelancers, 29% of invoices are paid late (Bonsai, 100,000+ freelancers).
Agents are good at the chasing. The blocker is trust: an agent that can concede a dispute or discount an invoice can also be talked into giving money away. We wanted to find out how little you have to trust the model if the system around it is built properly.

## What it does
PayPulse Guard reads your unpaid invoices and open disputes from PayPal. An LLM agent decides what each one needs (a reminder, a firmer reminder, a small settlement discount, conceding a tiny dispute) and writes the client message. It cannot execute any of it. Each proposal is checked by a guard against a mandate in code. Then one of three things happens:
- it is outside the mandate, so it is blocked, and the agent is told exactly why;
- it is inside the limits the owner pre-signed (autopilot: say, reminders plus up to 3% off and $150 a week), so it runs on PayPal straight away;
- otherwise it waits for the owner's signature, which covers that exact payload and nothing else.

The same guard is exposed as an MCP server, so Claude, Cursor or any other agent can do the chasing with a key that can only propose. When the client pays, the invoice flips to paid and the recovered total goes up. An "Attack the guard" panel shows five ways a compromised agent would try to get around all this, including rewriting its own autopilot, and each one being refused.

## What this solves for PayPal
PayPal already gives agents its tools: an official MCP server and Agent Toolkit covering invoices, refunds and disputes. It also backs AP2, whose answer to "the user is not there" is a signed mandate that bounds what an agent may do. On the merchant side, though, an agent holds whatever its token allows: no budget, no per-action signature, nothing between a hijacked dispute message and a refund. That is what stops a merchant switching on an agent that can give money away.

PayPulse Guard is the missing layer, merchant side: limits in code, a signed budget for unattended work, a signature for everything else, a tamper-evident audit trail, and an MCP endpoint so it works for any agent. Collections is the first use because late payment is the most common small-business cash problem and the money already sits in PayPal Invoicing. Every recovered invoice is paid through PayPal.

## How we built it
- **PayPal:** Invoicing v2 (list, get, create, send, remind, cancel), Customer Disputes v1 (list, accept-claim), webhook signature verification, `PayPal-Request-Id` idempotency on every write. Sandbox only.
- **AI:** [model name] through an OpenAI-compatible tool-calling loop. Four read-only tools and one `propose_action` tool. The guard's verdict is returned to the model as the tool result, so it can revise a blocked proposal.
- **Autopilot (standing mandates):** reminders on/off, a discount cap, a total budget and an expiry, HMAC-signed in an operator session. The guard re-verifies the signature, expiry and remaining budget on every use, in routing and again in the executor. Disputes are never covered. Same idea as AP2's Intent Mandate for "human not present" tasks, applied to the merchant side.
- **MCP server:** Streamable HTTP endpoint written by hand (JSON-RPC, no SDK), plus a zero-dependency stdio bridge for Claude Desktop. Bearer agent key, per-key scope, Origin check, and no execute tool. Tested with the official MCP TypeScript SDK client over both transports.
- **Evidence in the loop:** each client's usual lateness computed from their paid PayPal invoices; a public collectability curve (Commercial Law League of America) on every overdue invoice; the guard refuses any discount larger than what that curve says waiting 30 days would cost.
- **Standards:** controls map one-to-one to the mitigations in OWASP LLM06:2025 Excessive Agency; the five attacks are tagged with the OWASP risk they demonstrate. Same signed-mandate principle as AP2, which PayPal supports (not an AP2 implementation).
- **Guard:** mandate checks in plain TypeScript, SHA-256 of a canonical payload, HMAC approval bound to proposal id + payload hash + expiry, one use, mandate re-checked against live PayPal state at execution.
- **Ledger:** append-only and hash-chained.
- **Analytics (AG Studio 3.1):** a dashboard over four related tables (invoices, agent proposals, guard refusals, ledger) served live from the same store as the cockpit, with cross-filtering, page filters and a theme matched to the app. "Build your own view" opens Studio's editor and its AI assistant. We wrote an `AgLlmAdapter` that runs Studio's agent harness (lead, data, page and widget agents) on our own OpenAI-compatible model through a server route, so the browser never holds the LLM key; the assistant only has Studio's tools and no path to PayPal or the guard.
- **App:** Next.js and AG Studio. No PayPal, LLM or MCP SDKs: every PayPal, LLM and MCP call is plain `fetch`.

## Challenges
[Fill in what actually bit you once you have run against the sandbox. Candidates: back-dating invoices so they show as overdue; a sent PayPal invoice cannot simply be discounted, so a settlement is a replacement invoice plus a cancel, which means handling a partial failure; making the injected-instruction case deterministic enough to demo.]

## What we're proud of
No agent ever holds a write capability, ours or anyone else's, so prompt injection becomes a nuisance, not a loss. Autonomy is something the owner grants in signed, bounded pieces, not something the agent has by default. And the demo proves it by attacking itself.

## What we learned
[Yours.]

## What's next
- The guard in front of PayPal's own MCP server and Agent Toolkit, so any PayPal agent gets limits, budgets and signatures without changing its tools.
- Real operator accounts and passkey signing in place of a PIN; signing from your phone.
- Refunds and dispute evidence under the same mandates, and `make-offer` for inquiry-stage disputes.
- Payment plans through partial payments.
- Each client's payment history plus collectability is also an underwriting signal. Longer term it could decide which invoices are worth paying out early.

## Sources
- Intuit QuickBooks, 2026 Small Business Late Payments Report: https://quickbooks.intuit.com/r/small-business-data/small-business-late-payments-report-2026/
- Bonsai, late freelance payments: https://www.hellobonsai.com/blog/late-freelance-payment
- Commercial Law League of America, collectability chart: https://clla.org/wp-content/uploads/2023/Resources/Collectability-Chart-1.pdf
- OWASP LLM06:2025 Excessive Agency: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- PayPal on AP2: https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/
- AP2 mandates: https://ap2-protocol.org/
- PayPal's MCP server and Agent Toolkit: https://www.infoq.com/news/2025/04/paypal-mcp-ai-toolkit

## Pre-existing work
The project was created during the submission period. [If the repo has earlier history, say what changed.]

## Before you submit
- [ ] Public GitHub repo, MIT `LICENSE` visible in the About box
- [ ] README run instructions work from a clean clone
- [ ] Video under 3:00, public on YouTube, recorded in sandbox mode
- [ ] Model / AI service named and its role explained (the "AI" bullet above)
- [ ] Hosted URL or clear local instructions; include the operator PIN for judges
- [ ] Rotate the agent key after recording if it appears on screen
- [ ] AG Grid prize: the video shows the Analytics page, and the text names AG Studio (above)
