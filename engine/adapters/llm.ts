// engine/adapters/llm.ts — OpenAI-compatible ModelGateway implementation.
// The loop's ONLY source of model calls; every call is counted against the run
// budget. Budgets live on the INSTANCE (one per run) — previously module-level
// globals, which made the pipeline impossible to test without live network.
//
// Retry policy (AGENTS.md): transient errors (429, 5xx, network) retry ONCE with
// backoff; deterministic errors (4xx, bad key) throw immediately — never retry-storm.
import type { ModelGateway } from "../ports.ts";

export interface LlmError extends Error { status?: number }

const RETRYABLE_STATUS = (s: number) => s === 429 || s === 408 || (s >= 500 && s <= 599);

export class Budget {
  private used = 0;
  constructor(private cap: number = Infinity) {}
  spend(n: number): void { this.used += Math.max(0, n); }
  spent(): number { return this.used; }
  left(): number { return Math.max(0, this.cap - this.used); }
}

export interface LlmGatewayOpts {
  apiKey?: string;
  baseUrl?: string;
  budget: Budget;
  /** ms per HTTP attempt; default 120s. */
  timeoutMs?: number;
  /** injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export function createLlmGateway(opts: LlmGatewayOpts): ModelGateway {
  const key = opts.apiKey ?? process.env.LLM_API_KEY ?? "";
  const base = (opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));

  // one attempt; throws Error with .status for HTTP errors so the caller can classify
  async function attempt(body: Record<string, unknown>, model: string): Promise<{ text: string; tokens: number }> {
    if (!key) throw new Error("LLM_API_KEY not set — copy .env.example to .env and fill it in. (kill-switch: set enabled:false in config.yml to stop the loop)");
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e: Error) => {
      // network / timeout failures are transient by classification
      const err: LlmError = new Error(`LLM network error (${model}): ${e.message}`);
      err.status = e.name === "TimeoutError" ? 408 : 0;
      throw err;
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err: LlmError = new Error(`LLM ${res.status} (${model}): ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const tokens = data.usage?.total_tokens ?? estimateTokens(JSON.stringify(body) + text);
    return { text, tokens };
  }

  return {
    async call(o) {
      const body: Record<string, unknown> = {
        model: o.model,
        temperature: o.temperature ?? 0.2,
        messages: [
          { role: "system", content: o.system },
          { role: "user", content: o.user },
        ],
      };
      if (o.maxTokens) body.max_tokens = o.maxTokens;
      if (o.json) body.response_format = { type: "json_object" };

      let lastErr: unknown;
      for (let tries = 0; tries <= 1; tries++) {
        try {
          const { text, tokens } = await attempt(body, o.model);
          opts.budget.spend(tokens);
          return { text, tokens_used: tokens, model: o.model };
        } catch (e) {
          lastErr = e;
          const status = (e as LlmError).status;
          // deterministic (non-429/5xx/network) errors never retry
          if (status === undefined || !RETRYABLE_STATUS(status)) throw e;
          if (tries === 0) await sleep(2_000); // one backoff, then one retry — escalate after
        }
      }
      throw lastErr;
    },
    budgetSpent: () => opts.budget.spent(),
    budgetLeft: () => opts.budget.left(),
  };
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4); // fallback accounting — never trust it for budget alone
}
