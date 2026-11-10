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

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export class GeminiAdapter implements AIProviderAdapter {
  readonly providerKey = 'gemini' as const;
  readonly displayName = 'Google Gemini';
  readonly isImplemented = true;
  readonly envKeyName = 'GEMINI_API_KEY';

  // Supports primary GEMINI_API_KEY and standard Google alias GOOGLE_AI_API_KEY.
  // Never appended as a query param so secrets never leak in URL logs.
  private apiKey(): string {
    return readServerEnv('GEMINI_API_KEY') || readServerEnv('GOOGLE_AI_API_KEY');
  }

  isConfigured(): boolean {
    return this.apiKey().length > 0;
  }

  listStaticModels(): ModelSpec[] {
    return MODEL_CATALOG.filter((m) => m.providerKey === 'gemini');
  }

  async listRemoteModels(): Promise<string[]> {
    const key = this.apiKey();
    if (!key) {
      throw new ProviderCallError({
        code: 'NOT_CONFIGURED',
        message: 'Le secret serveur GEMINI_API_KEY est absent.',
        providerKey: 'gemini',
        modelId: DEFAULT_GEMINI_MODEL,
      });
    }
    const res = await fetch(`${GEMINI_BASE}/models`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new ProviderCallError({
        code: res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'PROVIDER_UNAVAILABLE',
        message: `Gemini /models HTTP ${res.status}`,
        providerKey: 'gemini',
        modelId: DEFAULT_GEMINI_MODEL,
        httpStatus: res.status,
      });
    }
    const data = await res.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const model = (req.model || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
    const key = this.apiKey();
    if (!key) {
      throw new ProviderCallError({
        code: 'NOT_CONFIGURED',
        message: 'Le secret serveur GEMINI_API_KEY est absent.',
        providerKey: 'gemini',
        modelId: model,
      });
    }

    const systemParts: string[] = [];
    if (req.systemPrompt?.trim()) systemParts.push(req.systemPrompt.trim());

    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    for (const m of req.messages) {
      if (m.role === 'system') {
        if (m.content.trim() && !req.systemPrompt) systemParts.push(m.content.trim());
        continue;
      }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Bonjour' }] });
    }

    const body: Json = {
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.5,
        maxOutputTokens: req.maxTokens ?? 2400,
        ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = [{
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs ?? 45000),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderCallError({
        code: isTimeout ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        message: isTimeout ? 'Délai dépassé lors de l’appel Gemini.' : 'Connexion réseau impossible vers Gemini.',
        providerKey: 'gemini',
        modelId: model,
      });
    }

    const latencyMs = Date.now() - started;
    const rawText = await res.text();

    if (!res.ok) {
      let detail = `Gemini HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(rawText) as { error?: { message?: string; status?: string } };
        if (parsed.error?.message) detail = String(parsed.error.message).slice(0, 300);
      } catch { /* non-JSON body */ }

      if (res.status === 401 || res.status === 403) {
        throw new ProviderCallError({
          code: 'AUTH_ERROR',
          message: `Authentification Gemini refusée : ${detail}`,
          providerKey: 'gemini',
          modelId: model,
          httpStatus: res.status,
        });
      }
      if (res.status === 429) {
        throw new ProviderCallError({
          code: 'RATE_LIMITED',
          message: `Quota ou limite de débit Gemini atteint : ${detail}`,
          providerKey: 'gemini',
          modelId: model,
          httpStatus: res.status,
        });
      }
      if (res.status === 404) {
        throw new ProviderCallError({
          code: 'MODEL_NOT_FOUND',
          message: `Modèle Gemini introuvable (${model}) : ${detail}`,
          providerKey: 'gemini',
          modelId: model,
          httpStatus: res.status,
        });
      }
      throw new ProviderCallError({
        code: res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'BAD_REQUEST',
        message: detail,
        providerKey: 'gemini',
        modelId: model,
        httpStatus: res.status,
        retryable: res.status >= 500 || res.status === 408,
      });
    }

    let parsed: {
      candidates?: Array<{
        finishReason?: string;
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ProviderCallError({
        code: 'INVALID_RESPONSE',
        message: 'Réponse JSON Gemini illisible.',
        providerKey: 'gemini',
        modelId: model,
      });
    }

    if (parsed.promptFeedback?.blockReason) {
      throw new ProviderCallError({
        code: 'SAFETY_BLOCKED',
        message: `Contenu bloqué par la politique Gemini (${parsed.promptFeedback.blockReason}).`,
        providerKey: 'gemini',
        modelId: model,
      });
    }

    const candidate = parsed.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();

    const toolCalls: AIToolCallProposal[] = [];
    for (const part of parts) {
      if (part.functionCall?.name) {
        toolCalls.push({
          toolName: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
          riskLevel: 'write_requires_approval',
        });
      }
    }

    if (!text && toolCalls.length === 0) {
      const reason = candidate?.finishReason ?? 'EMPTY';
      throw new ProviderCallError({
        code: reason === 'SAFETY' ? 'SAFETY_BLOCKED' : 'EMPTY_RESPONSE',
        message: `Gemini n’a retourné aucun texte (${reason}).`,
        providerKey: 'gemini',
        modelId: model,
      });
    }

    const inputTokens = Number(parsed.usageMetadata?.promptTokenCount ?? 0);
    const outputTokens = Number(parsed.usageMetadata?.candidatesTokenCount ?? 0);

    return {
      providerKey: 'gemini',
      modelId: model,
      text,
      toolCalls,
      finishReason: candidate?.finishReason ?? 'STOP',
      inputTokens,
      outputTokens,
      latencyMs,
      estimatedCostUsd: estimateUsdCost('gemini', model, inputTokens, outputTokens),
    };
  }

  async verify(modelId = DEFAULT_GEMINI_MODEL): Promise<ProviderVerificationResult> {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        providerKey: 'gemini',
        modelId,
        configured: false,
        implemented: true,
        verified: false,
        latencyMs: 0,
        errorCode: 'NOT_CONFIGURED',
        errorMessage: 'Le secret serveur GEMINI_API_KEY est absent.',
        checkedAt,
      };
    }
    const started = Date.now();
    try {
      const res = await this.generate({
        model: modelId,
        messages: [{ role: 'user', content: 'Réponds uniquement par OK.' }],
        temperature: 0,
        maxTokens: 16,
        timeoutMs: 15000,
      });
      return {
        providerKey: 'gemini',
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
            message: err instanceof Error ? err.message : 'Erreur Gemini inconnue',
            providerKey: 'gemini',
            modelId,
          });
      return {
        providerKey: 'gemini',
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
