import type {
  AIProviderAdapter,
  AIProviderKey,
  ModelSpec,
  ProviderRequest,
  ProviderResponse,
  ProviderVerificationResult,
} from '../types.ts';
import { MODEL_CATALOG, ProviderCallError, readServerEnv } from './base.ts';

class PreparedProviderAdapter implements AIProviderAdapter {
  readonly providerKey: AIProviderKey;
  readonly displayName: string;
  readonly isImplemented = false;
  readonly envKeyName: string;

  constructor(providerKey: AIProviderKey, displayName: string, envKeyName: string) {
    this.providerKey = providerKey;
    this.displayName = displayName;
    this.envKeyName = envKeyName;
  }

  isConfigured(): boolean {
    return readServerEnv(this.envKeyName).length > 0;
  }

  listStaticModels(): ModelSpec[] {
    return MODEL_CATALOG.filter((m) => m.providerKey === this.providerKey);
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    throw new ProviderCallError({
      code: 'NOT_IMPLEMENTED',
      message: `L’adaptateur ${this.displayName} est préparé dans l’architecture mais non encore activé.`,
      providerKey: this.providerKey,
      modelId: req.model || this.listStaticModels()[0]?.modelId || this.providerKey,
    });
  }

  async verify(modelId?: string): Promise<ProviderVerificationResult> {
    const model = modelId || this.listStaticModels()[0]?.modelId || this.providerKey;
    return {
      providerKey: this.providerKey,
      modelId: model,
      configured: this.isConfigured(),
      implemented: false,
      verified: false,
      latencyMs: 0,
      errorCode: 'NOT_IMPLEMENTED',
      errorMessage: `Fournisseur ${this.displayName} préparé pour extension ultérieure (non activé).`,
      checkedAt: new Date().toISOString(),
    };
  }
}

export function createPreparedAdapters(): AIProviderAdapter[] {
  return [
    new PreparedProviderAdapter('openai', 'OpenAI', 'OPENAI_API_KEY'),
    new PreparedProviderAdapter('anthropic', 'Anthropic Claude', 'ANTHROPIC_API_KEY'),
    new PreparedProviderAdapter('deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY'),
    new PreparedProviderAdapter('mistral', 'Mistral AI', 'MISTRAL_API_KEY'),
  ];
}
