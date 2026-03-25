# agent-trace-replay

An OpenClaw skill that lets you record, visualize, replay, and debug AI agent runs in plain English. When a multi-step agent fails, instead of re-running from scratch, you fork the trace at the broken step, apply a natural language fix, and see exactly what would have happened differently — in seconds.

---

## Installation

**1. Install dependencies**
```bash
npm run install:all
```

**2. Configure environment**
```bash
cp .env.example .env
# Fill in your API keys
```

**3. Start both servers**
```bash
npm run dev
# Support agent → http://localhost:3001
# Trace webapp  → http://localhost:3002
```

---

## OpenClaw Commands

**Show a trace**
```
show-trace run_cs_4821
```
Reads all steps from Redis and prints a formatted timeline with status icons, durations, and failure markers.

**Diagnose a failure**
```
diagnose run_cs_4821
```
Sends the full trace to Contextual AI for root-cause analysis, checks Civic for replay authorization, and returns a plain-English explanation of what went wrong and why.

**Replay from a step**
```
replay run_cs_4821 from_step=5 change="fix the retrieval to get the 2024 refund policy"
```
Parses the natural language `change` using FriendliAI, re-executes from step 5 with the fix applied, stores the replayed trace, and shows a diff of what changed.

**Compare original vs replay**
```
compare run_cs_4821
```
Side-by-side diff of every step that changed between the original run and the replay, with before/after output and timing.

---

## Demo Walkthrough

### Act 1 — Generate the failure
1. Open `http://localhost:3001` — the customer support chat
2. Type: **"I was charged twice for my subscription, I need a refund"**
3. The agent runs 14 steps. Step 5 retrieves the *2022* policy (no refunds) instead of the *2024* policy (refunds allowed within 90 days)
4. The agent wrongly denies the refund. 5 downstream steps cascade into failure
5. Note the **Run ID** shown below the response

### Act 2 — Diagnose with OpenClaw
1. Open `http://localhost:3002` — the trace visualizer
2. Enter the run_id and click **Load**
3. Watch all 14 steps animate in. Red steps show the failure cascade
4. In the OpenClaw sidebar, type: **"diagnose this failure"**
5. Contextual AI explains: wrong policy doc retrieved → 5 downstream steps wrong → customer wrongly denied

### Act 3 — Replay the fix
1. In the OpenClaw sidebar, type: **"replay from step 5, fix the retrieval to get the 2024 policy"**
2. FriendliAI parses the instruction → replay executes with the correct doc
3. The right panel fills with green checkmarks. The final response now approves the refund
4. Type **"compare original vs replay"** to see the full before/after diff

---

## Sponsors & Usage

| Sponsor | Role |
|---------|------|
| **FriendliAI** | Intent classification, query rewriting, answer generation, tone check, escalation, sentiment, audit log — and parsing natural language replay instructions |
| **Redis (ioredis)** | Stores all trace steps with 24h TTL. Key pattern: `trace:{run_id}:step:{n}`. Replay stored under `trace:{run_id}:replay:step:{n}` |
| **Contextual AI** | Retrieves policy documents during agent execution; also analyzes the full trace during diagnosis to explain root cause in plain English |
| **Civic** | Verifies user identity and confirms replay authorization before a trace can be forked |
| **Apify** | Scrapes live support forum data during agent execution; the scraped history creates the contradiction step (customer previously got a refund) |

---

## How It Works

```
                         ┌─────────────────────────────┐
User query               │   Customer Support Agent    │
───────────────────────► │   (support-agent port 3001) │
                         └────────────┬────────────────┘
                                      │ 14 steps execute
                                      ▼
                         ┌─────────────────────────────┐
                         │          Redis              │
                         │  trace:{id}:step:1..14      │
                         │  trace:{id}:metadata        │
                         └────────┬────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
    ┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
    │  OpenClaw Skill  │  │  Contextual  │  │  Webapp          │
    │  show-trace      │  │  AI          │  │  (port 3002)     │
    │  diagnose     ───┼─►│  diagnosis   │  │  polls Redis     │
    │  replay       ───┼─►│  FriendliAI  │  │  live timeline   │
    │  compare         │  │  replay LLM  │  │  split view      │
    └──────────────────┘  └──────────────┘  └──────────────────┘
              │
              ▼
    trace:{id}:replay:step:1..14
    (stored back in Redis)
```

---

## Project Structure

```
ReplayAI/
├── support-agent/         # Express server — generates traces
│   ├── index.js           # 14-step agent pipeline
│   ├── package.json
│   └── public/
│       └── index.html     # Chat UI
├── skill/                 # OpenClaw skill (TypeScript)
│   ├── skill.json
│   ├── index.ts           # Router + CLI entry
│   ├── tools/
│   │   ├── show-trace.ts
│   │   ├── diagnose.ts
│   │   ├── replay.ts
│   │   └── compare.ts
│   ├── utils/
│   │   ├── redis.ts
│   │   ├── friendli.ts
│   │   └── contextual.ts
│   └── tsconfig.json
├── webapp/                # Trace visualization
│   ├── index.html         # Real-time timeline UI
│   ├── server.js          # Express proxy + OpenClaw router
│   └── package.json
├── package.json           # Root scripts
└── .env.example
```
