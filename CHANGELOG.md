# Changelog

## Unreleased

First version.

- Gate on Pi tool calls (`bash`, `powershell`, `write`, `edit`, credential reads, extension and
  MCP tools without a read-only hint), judged by a local `laya-serve`.
- Deterministic layer: hard-deny shapes (including credential material or an environment dump
  sent over the network, and any change to the gate's own settings), dangerous shapes, protected
  paths with symlink resolution, read-only and harmless fast paths, your safe, allowed and
  disallowed patterns.
- Two calibrated Laya questions, composed in code with per-question pass and block cut-offs.
- `uncertain` setting: unclear or missing answers block, or ask you.
- Pause after 3 blocks in a row or 20 in a session, handing decisions back to you; without a UI,
  Pi is asked to stop the agent.
- External or managed `laya-serve`, `/laya-auto-mode doctor`, decision records, footer status.
- Calibration (`scripts/calibrate.ts`, 45 tuning and 20 held-out fixtures) and end-to-end runs
  in a real Pi process (`scripts/e2e/run.ts`).
