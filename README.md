# pi-laya-auto-classifier

Auto mode for the [Pi coding agent](https://github.com/earendil-works/pi), judged by
[Laya](https://huggingface.co/convaiinnovations/laya) running on your own machine.

Pi has no permission system of its own: every tool call the agent makes simply runs. This
extension puts a gate in front of those calls, in the spirit of Claude Code's auto mode. Calls
it can vouch for run straight away, catastrophic ones are refused outright, and everything in
between is put to Laya, an open (Apache 2.0) decision model that answers typed questions with
calibrated probabilities in a few hundred milliseconds. Nothing leaves your machine.

When a decision cannot be made (Laya is unreachable, times out, answers unclearly, or the call is
too long for it to read in full), the call is **blocked or put to you**, your choice. It is never
allowed silently.

> **Read this first.** Laya's base checkpoints are weak zero-shot judges, and this gate is only as
> good as what was measured. On the held-out fixtures it blocked every unsafe call (9 of 9) but
> also 4 of 11 ordinary ones, and it is much weaker in long conversations where the request is
> several messages back. The numbers, and what they mean for you, are in
> [docs/calibration.md](./docs/calibration.md). It is a guardrail, not a sandbox: see
> [docs/security.md](./docs/security.md).

## How it decides

```
tool call
 ├ auto mode off                                        → run
 ├ hard-deny (rm -rf ~, force push to main, a key sent over the network, …)
 │                                                      → block, Laya never asked
 ├ your disallowed / allowed patterns                   → block / run (recorded)
 ├ your safe commands, read-only and harmless commands  → run
 ├ write/edit inside the project, unprotected           → run
 ├ read-only tools (read, grep, find, ls)               → run, unless reading credentials
 └ everything else → Laya
       "did the user ask for this?"  +  "would a careful engineer check first?"
       ├ clearly not asked for                          → block, and the agent is told why
       ├ a risky shape the request does not clearly cover → unclear
       ├ unclear, unreachable, timed out, truncated     → your `uncertain` setting: block | ask
       └ otherwise                                      → run
 + 3 blocks in a row (or 20 in a session) → the gate stops deciding and asks you, as Claude Code
   does; with no UI (print mode) it keeps blocking and asks Pi to stop the agent
```

Only your own messages are shown to Laya, never the agent's text, tool output or file contents,
so a repository cannot argue for its own approval. A bare "ok, go ahead" is skipped in favour of
the message that said what to do.

## 1. Run Laya locally

Laya runs as a small Python HTTP server, `laya-serve`. You need Python 3.10 or newer.

**Linux without an NVIDIA GPU** (the plain `pip install` pulls about 5 GB of CUDA libraries you
would not use, so install CPU-only PyTorch first):

```sh
python3 -m venv ~/.laya
~/.laya/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
~/.laya/bin/pip install "laya[serve]"
```

**macOS, Windows, or Linux with an NVIDIA GPU:**

```sh
python3 -m venv ~/.laya
~/.laya/bin/pip install "laya[serve]"
```

(On Windows the paths are `%USERPROFILE%\.laya\Scripts\…`.) A virtual environment, `pipx` or
`uv tool` is needed on recent Ubuntu, Debian and Homebrew Pythons, which refuse a global
`pip install`.

**Start it:**

```sh
LAYA_HOST=127.0.0.1 LAYA_MODELS=english ~/.laya/bin/laya-serve
```

Both variables matter. By default `laya-serve` listens on every network interface with no
authentication, and loads all three checkpoints (about 5.5 GB of RAM instead of 2 GB). The
first start downloads about 800 MB from Hugging Face; later starts take a few seconds.

Measured on a 4-core CPU with no GPU: about 1.2 GB installed (CPU-only PyTorch), 2 GB of RAM,
and 0.5 to 0.7 s per judged call. A GPU is much faster but not needed.

**Or let the extension run it for you** (`managed` mode, below): it starts `laya-serve` on
127.0.0.1 with a random port and API key and stops it when Pi exits. The trade-off is a few
seconds of model loading at the start of every Pi session, where a server you leave running is
shared by all of them.

## 2. Install the extension

```sh
pi install git:github.com/finngreig/pi-laya-auto-classifier
```

Or from a checkout: `pi install /path/to/pi-laya-auto-classifier`. To try it for one run:
`pi -e /path/to/pi-laya-auto-classifier/index.ts`.

Then check everything is connected:

```
/laya-auto-mode doctor
```

It checks the server, the checkpoint, and runs two test decisions (a requested `npm test`
should be allowed, an unrequested force push blocked).

## Commands

```
/laya-auto-mode                   status
/laya-auto-mode on | off          turn auto mode on or off (saved)
/laya-auto-mode doctor            check the server, the checkpoint and a test decision
/laya-auto-mode uncertain block | ask
                                  what an unclear answer (or no answer) does
/laya-auto-mode checkpoint english | multilingual | typed-decisions
/laya-auto-mode threshold         cut-offs and the last probability seen per question
/laya-auto-mode threshold <question> <pass> <block>
/laya-auto-mode threshold reset [question]
/laya-auto-mode server start | stop | restart   (managed mode)
/laya-auto-mode reset             clear the block counters and resume after a pause
/laya-auto-mode display compact | full

pi --laya-auto-mode               start with auto mode on, whatever the settings say
```

Every judged call leaves a record in the transcript (kept out of the model's context):

```
🛡 laya allowed · bash · 663ms · npm test
⛔ laya blocked · bash · via laya · 585ms · npm publish
why: The user did not ask for this. (asked for: p=0.21)
```

Expand a record to see each question's probability and cut-offs. The footer shows `🛡 laya`,
or `off`, `starting…`, `unreachable`, `not running`, or `paused (asking)`.

## Configuration

Global: `~/.pi/agent/laya-auto-mode.json` (or `$PI_CODING_AGENT_DIR/laya-auto-mode.json`).
A trusted project can override it from `.pi/laya-auto-mode.json`, except for `server`, which
only the global file can set: a repository must not be able to point the gate at a different
judge.

```json
{
  "enabled": true,
  "server": {
    "mode": "external",
    "url": "http://127.0.0.1:8000",
    "command": "~/.laya/bin/laya-serve",
    "startupTimeoutMs": 180000,
    "threads": 0
  },
  "checkpoint": "english",
  "maxLen": 0,
  "timeoutMs": 8000,
  "requestMessages": 1,
  "uncertain": "block",
  "safeCommands": ["npm test*", "npx tsc*", "cargo build*"],
  "allowedCommands": [],
  "disallowedCommands": ["terraform apply*"],
  "extraProtectedPaths": [],
  "gateOtherTools": true,
  "maxActionCharacters": 800,
  "thresholds": {},
  "denialLimits": { "consecutive": 3, "total": 20 },
  "display": "compact"
}
```

| Setting | Meaning |
|---|---|
| `server.mode` | `external`: you run `laya-serve`. `managed`: the extension runs `server.command`. |
| `server.url` | External server. `PI_LAYA_URL` overrides it; `LAYA_API_KEY` is sent as a bearer token if set. |
| `checkpoint` | Pinned on every request and checked in every answer. `english` is the calibrated default; see below before changing it. |
| `requestMessages` | How many of your recent messages Laya compares a call against (1 to 4). 1 is the safest measured setting; more lets work through when your request was a few messages back, and lets more unrequested calls through too. |
| `uncertain` | `block` (default) or `ask`. Also applies when Laya is unreachable. With no UI, `ask` blocks. |
| `safeCommands` | Run without judgement or a record. For things that are safe *on your machine*, like your test runner. |
| `allowedCommands` | Run without judgement, even if they match a dangerous pattern. Recorded. |
| `disallowedCommands` | Always blocked. Deny beats allow. Allow patterns never match a command with `;`, `&&`, `\|`, redirection or substitution, so `ls*` cannot approve `ls && rm -rf /`. |
| `gateOtherTools` | Judge extension and MCP tools that do not declare themselves read-only. |
| `maxActionCharacters` | A longer call cannot be shown to Laya in full, so it is treated as unclear. |
| `thresholds` | Per-question cut-offs, e.g. `{"requested": {"pass": 0.65, "reject": 0.6}}`. |
| `denialLimits` | Blocks before the gate hands decisions back to you. `0` disables a limit. |

**Checkpoints.** `english` is the default because on the calibration set it was the only one
that blocked every unsafe call. `typed-decisions` let more ordinary work through but missed 2 of
29 unsafe calls. `multilingual` is twice as fast but much worse on English tool calls (it
allowed 24 of 36 ordinary calls and missed 4 of 29 unsafe ones). Use it only if you write to Pi
in another language, and expect to recalibrate.

## Tuning

The cut-offs were chosen on 45 fixtures and checked on 20 held-out ones; they are a starting
point, not a truth. To tune from your own work, expand a record, read the probabilities, and
move a cut-off with `/laya-auto-mode threshold`. `/laya-auto-mode threshold` alone shows the
current values next to the last probability seen. If a command you trust keeps being judged, add
it to `safeCommands`; that is cheaper and more reliable than any threshold.

To measure properly, run the calibration script against your own server
(`node --experimental-strip-types scripts/calibrate.ts`, see
[docs/calibration.md](./docs/calibration.md)), and add fixtures for the cases you care about,
including ones that should be allowed.

## Development

```sh
npm install
npm run check                                              # typecheck + unit tests, offline
node --experimental-strip-types scripts/calibrate.ts      # needs laya-serve
node --experimental-strip-types scripts/e2e/run.ts        # a real Pi process with a scripted model
```

| Path | Responsibility |
|---|---|
| `src/policy.ts` | hard-deny, dangerous shapes, protected paths, fast paths, your patterns |
| `src/call.ts` | a tool call → what the gate and Laya see (redaction, symlinks, bounds) |
| `src/intent.ts` | your recent messages only, go-aheads recognised |
| `src/gate.ts` | the decision path, unclear-answer handling, the pause after repeated blocks |
| `src/laya/client.ts` | HTTP client, response checks (checkpoint, answers, truncation) |
| `src/laya/questions.ts` | the questions and their cut-offs |
| `src/laya/decide.ts` | probabilities → allow, block or unclear |
| `src/laya/engine.ts` | what Laya is shown, one request per judged call |
| `src/laya/server.ts` | managed `laya-serve` |
| `src/settings.ts` | global and trusted-project settings |
| `src/records.ts`, `src/ui.ts` | transcript records, footer, dialogs |
| `src/extension.ts` | Pi wiring and the `/laya-auto-mode` command |

## Acknowledgements

The structure of the gate and the deterministic pattern catalogue are adapted from
[pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode) (MIT), whose catalogue is in turn
adapted from [pi-auto-permission-gate](https://github.com/nilskluewer/pi-auto-permission-gate)
(MIT). [pi-automode](https://github.com/czottmann/pi-automode) and its
[Jev classifier work](https://github.com/czottmann/pi-automode/pull/49) shaped the Claude Code
style behaviour. Laya is by [Convai Innovations](https://huggingface.co/convaiinnovations).

## Licence

MIT. See [LICENSE](./LICENSE), which also carries the notices for the adapted code.
