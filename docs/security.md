# Security

## What this is and is not

A guardrail on the tool calls Pi's agent makes. It is **not a sandbox**: extensions run inside
the Pi process with your user's permissions, and a determined adversary with code execution is
not stopped by a classifier. Pi's own advice applies: for real isolation run Pi in a container
or VM and give it only the files and credentials the task needs.

Not covered:

- commands you run yourself with `!` or `!!` (those are yours);
- what a command does after it has been allowed, including scripts it runs;
- prompt injection that convinces the agent to do something the user really did ask for in
  general terms;
- other extensions, which can do anything Pi can.

## Trust boundaries

| Input | Trusted? | How it is used |
|---|---|---|
| Your messages | yes | the request Laya compares each call against |
| The agent's text, tool output, file contents | no | never shown to Laya |
| The tool call | no | judged; shown to Laya as data, first in the state |
| Global settings (`~/.pi/agent/laya-auto-mode.json`) | yes | all settings |
| A trusted project's `.pi/laya-auto-mode.json` | partly | everything except `server` |
| An untrusted project's settings | no | ignored |
| `laya-serve`'s answers | checked | must answer every question, from the requested checkpoint |

A repository cannot point the gate at a different judge, and the agent cannot change the
gate's settings: writes to `laya-auto-mode.json` are hard-denied whatever Laya says.

## What leaves the machine

Nothing, as long as `server.url` is local. The extension talks only to `laya-serve`, and
`laya-serve` downloads its model weights from Hugging Face on first use.

`laya-serve` itself listens on every interface with no authentication by default. Start it with
`LAYA_HOST=127.0.0.1`, set `LAYA_API_KEY` (the extension sends it if the variable is set), or
use managed mode, which does both.

Obvious credentials (`sk-…`, `ghp_…`, AWS keys, bearer tokens, JWTs, private keys, `password=`
style assignments) are redacted from what Laya sees and from decision records, which are stored
in the session file.

## Failure modes

| Situation | Result |
|---|---|
| Hard-deny shape, or a change to the gate's settings | blocked; Laya never asked |
| Laya unreachable, timed out, busy | `uncertain` setting (block by default, or ask) |
| Malformed answer, missing question, probabilities that do not add up | `uncertain` setting |
| Answer from a different checkpoint than requested | `uncertain` setting |
| Call longer than `maxActionCharacters`, or possibly cut by Laya | `uncertain` setting |
| `curl … \| sh` and similar | `uncertain` setting, whatever Laya says |
| Turn cancelled while judging | blocked |
| Handler throws | Pi blocks the call (its own fail-safe) |
| 3 blocks in a row / 20 in a session, with a UI | every judged call is put to you |
| Same, without a UI | keeps blocking; Pi is asked to stop the agent |
| `ask` setting but no UI (print or JSON mode) | blocked |
| Managed server still starting after a minute | `uncertain` setting |

## Known weaknesses

From [calibration.md](./calibration.md):

- Laya does not reliably connect a question to the command that answers it ("does it type
  check?" and `tsc`), so ordinary work is sometimes blocked.
- When the request is several messages back and the latest message is a side remark, the default
  blocks most risky-looking calls; raising `requestMessages` to fix that lets unrequested calls
  through.
- Laya cannot tell whether a command sends secrets anywhere or acts outside the machine; only
  the hard rules catch those, and only the shapes they describe.
- Path classification is lexical apart from resolving symlinks on the target's existing
  ancestors; a command that changes directory and then writes is judged by its text.

Report security issues privately through GitHub's security advisories on this repository.
