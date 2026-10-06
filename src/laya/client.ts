/**
 * HTTP client for `laya-serve` (`POST /v1/systemone`, `POST /v1/systemone/batch`,
 * `GET /health`).
 *
 * Every failure becomes a typed result, never an exception, and a 200 is not
 * taken as an answer until it has been checked: every question answered, every
 * option given a probability, and the checkpoint that answered is the one that
 * was asked for. `laya-serve` quietly falls back to automatic routing for a model
 * name it does not know, so that last check is what keeps a typo in the settings
 * from swapping the judge.
 */

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface LayaRequest {
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, ChoiceQuestion>>;
  /** Checkpoint to pin: `english`, `multilingual` or `typed-decisions`. */
  readonly model: string;
  readonly maxLen?: number;
}

export type LayaFailureReason =
  | "unreachable"
  | "timeout"
  | "cancelled"
  | "busy"
  | "unauthorised"
  | "http_error"
  | "malformed"
  | "wrong_checkpoint";

export interface LayaAnswers {
  readonly ok: true;
  /** Probability per option, per question. */
  readonly probabilities: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The checkpoint that answered, from `routing.model`. */
  readonly checkpoint: string;
  /** Laya had to cut the state to fit at least one question. */
  readonly truncated: boolean;
  readonly stateTokens?: number;
  readonly stateTokensDropped?: number;
  readonly latencyMs: number;
}

export interface LayaFailure {
  readonly ok: false;
  readonly reason: LayaFailureReason;
  readonly detail: string;
  readonly latencyMs: number;
}

export type LayaResult = LayaAnswers | LayaFailure;

export interface HealthResult {
  readonly ok: boolean;
  readonly detail: string;
  /** Checkpoints resident in memory, when the server reports them. */
  readonly loaded?: readonly string[];
  readonly device?: string;
}

export interface CallOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface LayaBatchRequest extends Omit<LayaRequest, "state"> {
  readonly states: readonly Readonly<Record<string, unknown>>[];
}

export type LayaItem = Omit<LayaAnswers, "ok" | "latencyMs">;

export type LayaBatchResult =
  | { readonly ok: true; readonly items: readonly LayaItem[]; readonly latencyMs: number }
  | LayaFailure;

export interface LayaClient {
  readonly baseUrl: string;
  predict(request: LayaRequest, options: CallOptions): Promise<LayaResult>;
  /** The same questions over several states, in one forward pass (`/v1/systemone/batch`). */
  predictBatch(request: LayaBatchRequest, options: CallOptions): Promise<LayaBatchResult>;
  health(options: CallOptions): Promise<HealthResult>;
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`, matching `LAYA_API_KEY` on the server. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Probabilities are rounded to four places by the server, so the sum is checked loosely. */
const SUM_TOLERANCE = 0.02;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check a `/v1/systemone` body against the request that produced it.
 * Returns the problem, or the parsed answers.
 */
export function validateResponse(
  body: unknown,
  request: Pick<LayaRequest, "model" | "questions">,
): { ok: true; value: Omit<LayaAnswers, "ok" | "latencyMs"> } | { ok: false; reason: LayaFailureReason; detail: string } {
  if (!isRecord(body)) return { ok: false, reason: "malformed", detail: "the response is not a JSON object" };

  const routing = body.routing;
  if (!isRecord(routing) || typeof routing.model !== "string") {
    return {
      ok: false,
      reason: "malformed",
      detail: "the response has no routing report, so the answering checkpoint cannot be checked (is LAYA_JEV_STRICT set?)",
    };
  }
  if (routing.model !== request.model) {
    return {
      ok: false,
      reason: "wrong_checkpoint",
      detail: `asked for the ${request.model} checkpoint but ${routing.model} answered`,
    };
  }

  const answers = body.answers;
  if (!isRecord(answers)) return { ok: false, reason: "malformed", detail: "the response has no answers" };

  const probabilities: Record<string, Record<string, number>> = {};
  for (const [questionId, question] of Object.entries(request.questions)) {
    const answer = answers[questionId];
    if (!isRecord(answer) || answer.type !== "choice" || !isRecord(answer.probabilities)) {
      return { ok: false, reason: "malformed", detail: `no choice answer for ${questionId}` };
    }
    const options = Object.keys(question.criteria);
    const values: Record<string, number> = {};
    let sum = 0;
    for (const option of options) {
      const p = answer.probabilities[option];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
        return { ok: false, reason: "malformed", detail: `${questionId} has no usable probability for option ${option}` };
      }
      values[option] = p;
      sum += p;
    }
    if (Object.keys(answer.probabilities).length !== options.length || Math.abs(sum - 1) > SUM_TOLERANCE) {
      return { ok: false, reason: "malformed", detail: `${questionId}'s probabilities do not match its options` };
    }
    probabilities[questionId] = values;
  }

  const usage = isRecord(body.usage) ? body.usage : {};
  const stateTokens = typeof usage.state_tokens === "number" ? usage.state_tokens : undefined;
  const dropped = typeof usage.state_tokens_dropped === "number" ? usage.state_tokens_dropped : undefined;
  return {
    ok: true,
    value: {
      probabilities,
      checkpoint: routing.model,
      truncated: usage.truncated === true || (dropped ?? 0) > 0,
      ...(stateTokens === undefined ? {} : { stateTokens }),
      ...(dropped === undefined ? {} : { stateTokensDropped: dropped }),
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return causeText ? `${error.message} (${causeText})` : error.message;
  }
  return String(error);
}

export function createLayaClient(options: ClientOptions): LayaClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  async function send(
    path: string,
    init: RequestInit,
    call: CallOptions,
  ): Promise<{ ok: true; status: number; text: string } | { ok: false; reason: LayaFailureReason; detail: string }> {
    if (call.signal?.aborted) return { ok: false, reason: "cancelled", detail: "the turn was cancelled" };
    const timeout = AbortSignal.timeout(call.timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal });
      return { ok: true, status: response.status, text: await response.text() };
    } catch (error) {
      if (call.signal?.aborted) return { ok: false, reason: "cancelled", detail: "the turn was cancelled" };
      if (timeout.aborted) return { ok: false, reason: "timeout", detail: `no answer within ${call.timeoutMs}ms` };
      return { ok: false, reason: "unreachable", detail: `cannot reach ${baseUrl}: ${describeError(error)}` };
    }
  }

  /** POST a JSON body and return the parsed JSON, or a typed failure. */
  async function post(
    path: string,
    payload: unknown,
    call: CallOptions,
  ): Promise<{ ok: true; body: unknown } | { ok: false; reason: LayaFailureReason; detail: string }> {
    const body = JSON.stringify(payload);
    let sent = await send(path, { method: "POST", body }, call);
    // A full admission queue answers 503 at once; one retry covers a burst of
    // parallel tool calls without turning an overloaded server into a long wait.
    if (sent.ok && sent.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      sent = await send(path, { method: "POST", body }, call);
    }
    if (!sent.ok) return sent;
    if (sent.status === 401 || sent.status === 403) {
      return { ok: false, reason: "unauthorised", detail: "the server rejected the API key (set LAYA_API_KEY to the key laya-serve was started with)" };
    }
    if (sent.status === 503) return { ok: false, reason: "busy", detail: "the server is busy" };
    if (sent.status < 200 || sent.status >= 300) {
      return { ok: false, reason: "http_error", detail: `HTTP ${sent.status}: ${sent.text.slice(0, 300)}` };
    }
    try {
      return { ok: true, body: JSON.parse(sent.text) };
    } catch {
      return { ok: false, reason: "malformed", detail: "the response is not JSON" };
    }
  }

  return {
    baseUrl,

    async predict(request, call) {
      const started = now();
      const sent = await post(
        "/v1/systemone",
        { state: request.state, questions: request.questions, model: request.model, ...(request.maxLen ? { max_len: request.maxLen } : {}) },
        call,
      );
      const latencyMs = now() - started;
      if (!sent.ok) return { ...sent, latencyMs };
      const checked = validateResponse(sent.body, request);
      return checked.ok ? { ok: true, ...checked.value, latencyMs } : { ...checked, latencyMs };
    },

    async predictBatch(request, call) {
      const started = now();
      const sent = await post(
        "/v1/systemone/batch",
        { states: request.states, questions: request.questions, model: request.model, ...(request.maxLen ? { max_len: request.maxLen } : {}) },
        call,
      );
      const latencyMs = now() - started;
      if (!sent.ok) return { ...sent, latencyMs };
      const results = isRecord(sent.body) && Array.isArray(sent.body.results) ? sent.body.results : undefined;
      if (!results || results.length !== request.states.length) {
        return { ok: false, reason: "malformed", detail: "the batch response does not have one result per state", latencyMs };
      }
      const items: LayaItem[] = [];
      for (const result of results) {
        const checked = validateResponse(result, request);
        if (!checked.ok) return { ...checked, latencyMs };
        items.push(checked.value);
      }
      return { ok: true, items, latencyMs };
    },

    async health(call) {
      const sent = await send("/health", { method: "GET" }, call);
      if (!sent.ok) return { ok: false, detail: sent.detail };
      if (sent.status !== 200) return { ok: false, detail: `HTTP ${sent.status}` };
      try {
        const body = JSON.parse(sent.text) as Record<string, unknown>;
        if (body.status !== "ok") return { ok: false, detail: `status ${String(body.status)}` };
        const loaded = Array.isArray(body.loaded) ? body.loaded.filter((x): x is string => typeof x === "string") : undefined;
        return {
          ok: true,
          detail: "ok",
          ...(loaded ? { loaded } : {}),
          ...(typeof body.device === "string" ? { device: body.device } : {}),
        };
      } catch {
        return { ok: false, detail: "the health response is not JSON" };
      }
    },
  };
}
