# Design

Why the gate is shaped the way it is. The measurements behind each choice are in
[calibration.md](./calibration.md); failure modes and trust boundaries are in
[security.md](./security.md).

## The constraint: a fast, honest, weak judge

Laya is a non-autoregressive decision model: a state and typed questions go in, calibrated
probabilities come out of one forward pass. That makes it a good fit for a gate (no text to
parse, nothing to inject through its output, a few hundred milliseconds on a CPU, nothing leaves
the machine) and a poor fit for nuance. Its own model card says the base checkpoints are near
chance zero-shot on its decision benchmark, that yes/no (`noul`) answers can follow their labels
rather than the input, that it ships over-confident, and that the English checkpoint reads
about 320 tokens of state per question.

So the design puts as much as possible where it does not depend on Laya, and asks Laya only what
it measurably answers.

## Two layers

```
tool_call
  ├─ 0. auto mode off                               → run
  ├─ 1. hard-deny, or a change to the gate's settings → block       ┐
  ├─ 2. your disallowed pattern                     → block          │ Laya never
  ├─ 3. your allowed pattern                        → run, recorded  │ sees these
  ├─ 4. your safe commands; read-only and harmless  → run            │
  ├─ 5. in-project write/edit, unprotected; reads   → run            ┘
  ├─ 6. paused after repeated blocks (and a UI)     → ask you
  └─ 7. Laya: one request, two questions
         ├ clearly not asked for                    → block
         ├ flagged and not clearly asked for        → unclear
         ├ "check first", and not clearly asked for → block
         ├ unclear / unavailable / not read in full → block or ask (`uncertain`)
         └ otherwise                                → run
```

Hard-deny runs first and its verdict never reaches Laya, so a mis-calibrated answer cannot
resurrect `rm -rf ~`. It covers catastrophic shapes (root and home deletion, disk formatting,
force pushes to main), credential material or an environment dump sent over the network, and
any change to the gate's own settings.

The deterministic layer also decides what Laya is asked about. A call is **flagged** when it
matches a known dangerous shape (`git reset --hard`, `npm publish`, `curl … | sh`, a write to a
shell profile, …), writes to a protected path (`.env`, `.git/`, `.github/workflows/`, `AGENTS.md`,
anything outside the project), or reads credential material. Everything else that is not on the
known-safe list is judged without the flag.

## The questions

Two two-option `choice` questions with neutral keys (`A`/`B`), never `noul`:

1. **"Did the user ask for this tool call, or is it a necessary step of what they asked for?"**
   This carries the decision. It separated "should run" from "should block" almost perfectly on
   the tuning set (AUROC 0.98).
2. **"Would a careful engineer run this without checking with the user first?"** A weaker signal
   (0.86). It blocks only when emphatic and when the request is not clearly behind the call. It
   is mostly there because asking it alongside the first question made the first question
   sharper.

Questions about secrets, effects outside the machine and prompt injection were tried in several
wordings and did not separate safe calls from unsafe ones, so those hazards are handled by hard
rules instead. Asking a question Laya cannot answer does not add safety; it adds noise to every
decision.

## Composition, in code

Each question has two cut-offs on the probability of its safe answer: `p ≥ pass` is a clear safe
answer, `p ≤ reject` a clear unsafe one, and between them is the middle band. They are not
symmetric around 0.5 because Laya's clusters are not. Then:

- a clear "not asked for" blocks, flagged or not;
- for a flagged call, the middle band is unclear: the request has to clearly cover a risky shape;
- for an ordinary call, the middle band runs: agents take small steps on their own initiative,
  and an auto mode that stops for those defeats itself;
- an emphatic "check first" blocks unless the request clearly covers the call.

The model never weighs concerns against each other; the code does, the same way every time.

## What Laya is shown

```json
{ "proposed_tool_call": "bash: npm publish", "user_request": "Fix the typo in README.md" }
```

Nothing else. Laya serialises the state as JSON in key order and cuts from the end when it is too
long, so the call goes first. It is sensitive to irrelevant detail (the name of the working
directory moved answers by up to 0.2), so the working directory is left out and in-project paths
are shown relative to it.

Only user messages are used, never the agent's text, tool output or file contents. A bare "ok, go
ahead" is skipped in favour of the message that said what to do. By default only the latest
substantive message is used; `requestMessages` raises that, judging the call against each
message separately (one batched request) and taking the clearest match. Calibration shows why
the default is 1: each extra message lets more unrequested calls through.

A call longer than `maxActionCharacters`, or one Laya reports it had to cut in a way that might
reach the call itself, is never allowed on Laya's word: it is unclear.

## Failing closed, and handing back

Anything that is not a clear answer resolves the same way: the `uncertain` setting, `block` by
default or `ask`. That includes an unreachable server, a timeout, a malformed or mismatched
answer (the checkpoint that answered is checked against the one requested, because `laya-serve`
quietly falls back to automatic routing for a name it does not know), a cancelled turn, and a
call Laya could not read in full. `downloaded script execution` is always unclear: whether a
script on the internet is trustworthy is not something a classifier can read from the command.

Like Claude Code's auto mode, the gate stops deciding after repeated blocks: three in a row or
twenty in a session (configurable) and every judged call goes to you until `/laya-auto-mode
reset`. Without a UI it keeps blocking and sets Pi's `terminate` hint, so a print-mode run stops
instead of looping on blocked calls. Hard-deny blocks do not count; they never need a person.

## Running Laya

`external` mode talks to a `laya-serve` you run, which can be shared by every Pi session and
stays warm. `managed` mode starts one per session with the settings a laptop wants rather than
`laya-serve`'s server defaults: bound to 127.0.0.1 on a free port, a random API key, only the
configured checkpoint loaded, TensorFlow probing disabled. It is not detached, so it shares Pi's
process group, and it is stopped on `session_shutdown`. A tool call waits up to a minute for a
managed server that is still starting, then fails closed.

The `server` block can only come from the global settings file. Every other setting can be
overridden by a trusted project's `.pi/laya-auto-mode.json`; an untrusted project's file is
ignored.

## Prior art

| Source | Taken |
|---|---|
| [pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode) | layering, the dangerous-shape catalogue, protected paths, two-sided thresholds, records out of context, measuring the gate rather than the engine |
| [pi-automode](https://github.com/czottmann/pi-automode) and its [Jev backend](https://github.com/czottmann/pi-automode/pull/49) | Claude Code semantics: user messages only, protected self-configuration, deny reasons the agent can act on |
| Claude Code's auto mode | the classifier as a gate on every non-trivial action, and handing back to the user after repeated blocks |

The Jev backend's single `choice` question over every deny rule was not copied: Laya degrades
past about 20 options, which share a small token budget.
