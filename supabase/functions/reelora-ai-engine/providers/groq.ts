import type {
  AIProviderAdapter,
  AIToolCallProposal,
  ModelSpec,
  ProviderRequest,
  ProviderResponse,
  ProviderVerificationResult,
} from '../types.ts';
import {
  MODEL_CATALOG,
  ProviderCallError,
  estimateUsdCost,
  readServerEnv,
} from './base.ts';

type Json = Record<string, unknown>;

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class GroqAdapter implements AIProviderAdapter {
  readonly providerKey = 'groq' as const;
  readonly displayName = 'Groq Cloud';
  readonly isImplemented = true;
  readonly envKeyName = 'GROQ_API_KEY';

  private apiKey(): string {
    return readServerEnv(this.envKeyName);
  }

  isConfigured(): boolean {
    return this.apiKey().length > 0;
  }

  listStaticModels(): ModelSpec[] {
    return MODEL_CATALOG.filter((m) => m.providerKey === 'groq');
  }

  async listRemoteModels(): Promise<string[]> {
    const key = this.apiKey();
    if (!key) {
      throw new ProviderCallError({
        code: 'NOT_CONFIGURED',
        message: 'Le secret serveur GROQ_API_KEY est absent.',
        providerKey: 'groq',
        modelId: DEFAULT_GROQ_MODEL,
      });
    }
    const res = await fetch(`${GROQ_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new ProviderCallError({
        code: res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'PROVIDER_UNAVAILABLE',
        message: `Groq /models HTTP ${res.status}`,
        providerKey: 'groq',
        modelId: DEFAULT_GROQ_MODEL,
        httpStatus: res.status,
      });
    }
    const data = await res.json() as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((item) => item.id ?? '').filter(Boolean);
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const model = req.model || DEFAULT_GROQ_MODEL;
    const key = this.apiKey();
    if (!key) {
      throw new ProviderCallError({
        code: 'NOT_CONFIGURED',
        message: 'Le secret serveur GROQ_API_KEY est absent.',
        providerKey: 'groq',
        modelId: model,
      });
    }

    const messages: Array<{ role: string; content: string; name?: string }> = [];
    if (req.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: req.systemPrompt.trim() });
    }
    for (const m of req.messages) {
      if (m.role === 'system' && req.systemPrompt) continue;
      messages.push({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      });
    }

    const body: Json = {
      model,
      messages,
      temperature: req.temperature ?? 0.5,
      max_tokens: req.maxTokens ?? 2400,
    };
    if (req.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs ?? 45000),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderCallError({
        code: isTimeout ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        message: isTimeout ? 'Délai dépassé lors de l’appel Groq.' : 'Connexion réseau impossible vers Groq.',
        providerKey: 'groq',
        modelId: model,
      });
    }

    const latencyMs = Date.now() - started;
    const rawText = await res.text();

    if (!res.ok) {
      let detail = `Groq HTTP ${res.status}`;
      let apiCode = '';
      try {
        const parsed = JSON.parse(rawText) as { error?: { message?: string; code?: string } };
        if (parsed.error?.message) detail = String(parsed.error.message).slice(0, 300);
        if (parsed.error?.code) apiCode = String(parsed.error.code);
      } catch { /* non-JSON body */ }

      if (res.status === 401 || res.status === 403) {
        throw new ProviderCallError({
          code: 'AUTH_ERROR',
          message: `Authentification Groq refusée : ${detail}`,
          providerKey: 'groq',
          modelId: model,
          httpStatus: res.status,
        });
      }
      if (res.status === 429) {
        throw new ProviderCallError({
          code: 'RATE_LIMITED',
          message: `Limite de requêtes Groq atteinte : ${detail}`,
          providerKey: 'groq',
          modelId: model,
          httpStatus: res.status,
          retryAfterSec: parseRetryAfter(res.headers),
        });
      }
      if (res.status === 404 || apiCode === 'model_not_found') {
        throw new ProviderCallError({
          code: 'MODEL_NOT_FOUND',
          message: `Modèle Groq indisponible (${model}) : ${detail}`,
          providerKey: 'groq',
          modelId: model,
          httpStatus: res.status,
        });
      }
      throw new ProviderCallError({
        code: res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'BAD_REQUEST',
        message: detail,
        providerKey: 'groq',
        modelId: model,
        httpStatus: res.status,
        retryable: res.status >= 500 || res.status === 408,
      });
    }

    let parsed: {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ProviderCallError({
        code: 'INVALID_RESPONSE',
        message: 'Réponse JSON Groq illisible.',
        providerKey: 'groq',
        modelId: model,
      });
    }

    const choice = parsed.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    const toolCalls: AIToolCallProposal[] = [];
    for (const tc of choice?.message?.tool_calls ?? []) {
      const name = tc.function?.name?.trim();
      if (!name) continue;
      let args: Record<string, unknown> = {};
      if (typeof tc.function?.arguments === 'string' && tc.function.arguments.trim()) {
        try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { args = {}; }
      }
      toolCalls.push({
        toolName: name,
        arguments: args,
        riskLevel: 'write_requires_approval',
      });
    }

    if (!text && toolCalls.length === 0) {
      throw new ProviderCallError({
        code: 'EMPTY_RESPONSE',
        message: 'Groq a renvoyé une réponse vide.',
        providerKey: 'groq',
        modelId: model,
      });
    }

    const inputTokens = Number(parsed.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(parsed.usage?.completion_tokens ?? 0);

    return {
      providerKey: 'groq',
      modelId: model,
      text,
      toolCalls,
      finishReason: choice?.finish_reason ?? 'stop',
      inputTokens,
      outputTokens,
      latencyMs,
      estimatedCostUsd: estimateUsdCost('groq', model, inputTokens, outputTokens),
    };
  }

  async verify(modelId = DEFAULT_GROQ_MODEL): Promise<ProviderVerificationResult> {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        providerKey: 'groq',
        modelId,
        configured: false,
        implemented: true,
        verified: false,
        latencyMs: 0,
        errorCode: 'NOT_CONFIGURED',
        errorMessage: 'Le secret serveur GROQ_API_KEY est absent.',
        checkedAt,
      };
    }
    const started = Date.now();
    try {
      const res = await this.generate({
        model: modelId,
        messages: [{ role: 'user', content: 'Réponds uniquement par OK.' }],
        temperature: 0,
        maxTokens: 12,
        timeoutMs: 15000,
      });
      return {
        providerKey: 'groq',
        modelId: res.modelId,
        configured: true,
        implemented: true,
        verified: true,
        latencyMs: res.latencyMs,
        checkedAt,
      };
    } catch (err) {
      const pErr = err instanceof ProviderCallError
        ? err
        : new ProviderCallError({
            code: 'PROVIDER_UNAVAILABLE',
            message: err instanceof Error ? err.message : 'Erreur Groq inconnue',
            providerKey: 'groq',
            modelId,
          });
      return {
        providerKey: 'groq',
        modelId,
        configured: true,
        implemented: true,
        verified: false,
        latencyMs: Date.now() - started,
        errorCode: pErr.code,
        errorMessage: pErr.message,
        checkedAt,
      };
    }
  }
}
