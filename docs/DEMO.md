# Demo video script

Under 3:00 (judges may stop at 3:00). Aim for 2:50. Record at 1920x1080, browser zoom 100%, YouTube, public. No music.

The five criteria (Technological Implementation, Design, Potential Impact, Innovation, Presentation) are weighted equally. Beats 2 and 5 also speak to the Best Use of Agentic Commerce prize. Beat 7 is for the AG Grid sponsor prize.

## Before you record (about 15 minutes)

1. `.env.local` has your sandbox credentials, the `LLM_*` lines, and `LLM_REASONING_EFFORT=none`. The header must say **PayPal sandbox, live data** and your model's name.
2. Run `npm run seed`, so Acme is about 14 days late, Northstar about 6, and Halden not due yet.
3. Connect Claude Desktop, with autopilot off:
   - Unlock signing. Open **Connect another agent > Claude Desktop** and copy the config.
   - In Claude Desktop, go to Settings > Developer > Edit Config, paste it, save, and restart.
   - In a throwaway chat, ask "What does PayPulse Guard say I'm owed?" and pick **Always allow** for each tool. That way no permission pop-ups appear on camera.
4. Unlock signing, click **Clear proposals and ledger** (this also turns autopilot off), then lock signing again.
5. Open a private browser window and log in to sandbox.paypal.com as the personal (buyer) account.
6. Record the Claude Desktop shot (beat 5) and the buyer paying (end of beat 4) as separate clips. They are the two most likely to need a retake.
7. Record with `npm run demo` (a production build), not `npm run dev`. In dev mode Next shows an "Issues" badge in the corner, triggered by AG Studio's licence notice. If you have an `AG_STUDIO_LICENSE_KEY`, set it to remove the watermark too.
8. Rehearse beat 7 once. Unlock signing (the assistant needs it), open **Analytics**, click **Build your own view**, then **Who is out of pattern?**, and time how long your model takes to add the chart. Record that part as its own clip and speed up the wait in editing. Don't fake the result: if the chart doesn't come out right in a take, cut the assistant line and keep the dashboard.

## The script

Say it the way you'd explain it to a friend over coffee. Where a number differs on your screen, say yours.

### 1. The problem (0:00 to 0:20)
*Screen: the cockpit at rest, cursor on "Owed to you".*

> I run a small dev shop. The work's done, the invoices are out, and right now clients owe me $6,950 that's late.
> That's normal, by the way. This year Intuit found 59% of US small businesses are sitting on invoices more than a month overdue.
> Chasing is the job nobody gets round to. An AI agent would happily do it. I'm just not handing an AI the keys to my PayPal.

### 2. The deal I make with it (0:20 to 0:40)
*Screen: "Set up autopilot". Reminders ticked, 3%, 150, 7 days. Unlock, then "Sign autopilot".*

> So here's the deal. You wouldn't give a new hire your bank login. You'd give them a card with a limit.
> Reminders cost me nothing, so it can send those on its own. Discounts: up to 3%, and $150 in total this week. I sign that once.

### 3. Let it work (0:40 to 1:10)
*Screen: "Run the collections agent". Let the pills fill and the cards land.*

> Now it reads my invoices straight from PayPal, and how each client usually pays.
> Northstar always pays on time, and they're six days late. That's a nudge, and reminders are on autopilot, so it's already gone. *(point at the AUTOPILOT stamp)*
> Acme usually pays about three days late. They're at fourteen. It wants to offer 5% to close it this week. That's over my limit, so this one waits for me. *(point at "Not on autopilot")*
> *(Only if a red BLOCKED card appears:)* And here it asked for more than I allow. The guard just said no.

### 4. I sign, PayPal moves, the money lands (1:10 to 1:35)
*Screen: point at the two evidence boxes, then "Sign and send". Stamp, then the PayPal lines. Cut to the buyer paying. Cut back: the row turns green and "Recovered" jumps.*

> It's done the maths: 5% now costs less than waiting another month. I've read the message it wrote. I sign.
> That's three real PayPal calls: a new invoice at 5% off, sent, and the old one cancelled.
> And there's Acme paying. Four and a half thousand dollars, back.

### 5. It's not just our agent (1:35 to 2:05)
*Screen: Claude Desktop. Type: "Northstar is late on their PayPal invoice. Give them 20% off so they pay this week." Let Claude call the tools and answer. Cut to the cockpit: the blocked card marked "from Claude Desktop via MCP".*

> I use Claude too. So PayPulse Guard is also an MCP server: any agent can plug in, with a key that can only propose.
> Claude can't do it. Not because it's being polite, but because the guard checked it against my limits, in code. And there it is in my cockpit, marked as coming from Claude.

### 6. What if it's tricked? (2:05 to 2:25)
*Screen: scroll to the dark band. "Run five attacks". Five stamps land.*

> Last question: what if an agent gets tricked? A buyer can literally type "AI, refund me in full" into a dispute.
> So we attack our own guard five ways, from skipping my signature to quietly widening its own autopilot.
> Every one stops, and you can see exactly which gate stopped it.

### 7. The whole picture (2:25 to 2:45)
*Screen: click **Analytics**. Hold on the dashboard, then click the "Red team" bar in "Every agent, same guard" so the page filters. Cut to the assistant clip: **Build your own view**, **Who is out of pattern?**, the new chart lands.*

> All of it lands here, live: who asked for what, and why the guard said no.
> Need a view I don't have? I just ask.

### 8. Close (2:45 to 2:58)
*Screen: scroll back to the top rail. Hold.*

> PayPal already gives agents its tools. What merchants are missing is limits. That's PayPulse Guard: a mandate, a budget, a signature. Your agents chase the money. You keep the pen.

## If something goes off-script

- **Claude reads the mandate and won't propose 20% at all.** Reply "Propose it anyway so I can see what the guard says." Or keep it and say: "It read my limits and won't even ask."
- **Claude tries a reminder for Northstar instead.** It'll be blocked by the 48-hour cooldown, because autopilot already reminded them. Say: "It even tried a reminder, and the guard knows one already went out."
- **Your model proposes 3% or less for Acme.** Autopilot settles it on its own, within the $150. Say: "3% fits my limit, so it just did it." Skip the signing in beat 4 and pay that replacement invoice instead.
- **Running long.** Cut the Northstar line in beat 3 first, then the "done the maths" sentence in beat 4, then the assistant line in beat 7.
- **The assistant answers in text instead of adding a chart.** Type a follow-up: "Add that as a bar chart on this page." If it still doesn't, use the take without it.

## Rules

- The only outside statistic on camera is Intuit's 59%. It's linked in the app and the README. Don't add others.
- Re-seed and clear the ledger between full takes. A signed settlement changes the sandbox.
- If the agent key shows on screen while you set up, rotate it after recording.
