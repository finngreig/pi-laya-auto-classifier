/**
 * A scripted model for end-to-end runs of the gate inside a real Pi process.
 *
 * Load it next to the extension, and Pi's agent loop issues exactly the tool
 * calls listed in E2E_SCRIPT, one per turn, then stops. Every call goes through
 * Pi's real `tool_call` path, so this checks the wiring that unit tests stub out:
 * registration, settings loading, the gate, records, and what the agent is told.
 *
 *   E2E_SCRIPT='[{"name":"bash","arguments":{"command":"npm test"}}]' \
 *     pi -p --mode json --no-session --model scripted/gate-test \
 *       -e ./index.ts -e ./scripts/e2e/scripted-model.ts "Run the tests"
 *
 * Not part of the published package.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export default function scriptedModel(pi: ExtensionAPI): void {
  const script = JSON.parse(process.env.E2E_SCRIPT ?? "[]") as ScriptedCall[];
  const faux = fauxProvider({ provider: "scripted", models: [{ id: "gate-test", name: "Scripted gate test" }] });
  faux.setResponses([
    ...script.map((call, index) =>
      fauxAssistantMessage(fauxToolCall(call.name, call.arguments as Parameters<typeof fauxToolCall>[1], { id: `call_${index}` }), {
        stopReason: "toolUse",
      }),
    ),
    fauxAssistantMessage(fauxText("done")),
  ]);
  pi.registerProvider(faux.provider);
}
