// engine/llm.ts — OpenAI-compatible model-call wrapper with token accounting.
// The loop's ONLY source of model calls; every call is counted against the run budget.

export interface LlmResult {
  text: string;
  tokens_used: number;
  model: string;
}

let budgetUsed = 0;
let budgetCap = Infinity;

export function setBudget(cap: number): void {
  budgetCap = cap;
  budgetUsed = 0;
}
export function budgetSpent(): number { return budgetUsed; }
export function budgetLeft(): number { return Math.max(0, budgetCap - budgetUsed); }

function env(): { key: string; base: string } {
  const key = process.env.LLM_API_KEY ?? "";
  const base = process.env.LLM_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  if (!key) throw new Error("LLM_API_KEY not set — copy .env.example to .env and fill it in. (kill-switch: set enabled:false in config.yml to stop the loop)");
  return { key, base: base.replace(/\/$/, "") };
}

export async function llmCall(opts: {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
}): Promise<LlmResult> {
  const { key, base } = env();
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature ?? 0.2,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status} (${opts.model}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json() as {
    choices: { message: { content: string } }[];
    usage?: { total_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const tokens = data.usage?.total_tokens ?? estimateTokens(opts.system + opts.user + text);
  budgetUsed += tokens;
  return { text, tokens_used: tokens, model: opts.model };
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4); // fallback accounting — never trust it for budget alone
}

export function parseJsonLoose<T>(text: string): T {
  // strip code fences, find first {...}
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON object in model output: ${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
