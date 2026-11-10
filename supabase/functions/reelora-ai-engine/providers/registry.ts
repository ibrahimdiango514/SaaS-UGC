import type { AIProviderAdapter, AIProviderKey, ModelSpec } from '../types.ts';
import { MODEL_CATALOG } from './base.ts';
import { GroqAdapter } from './groq.ts';
import { GeminiAdapter } from './gemini.ts';
import { createPreparedAdapters } from './placeholders.ts';

export interface ProviderSummary {
  providerKey: AIProviderKey;
  displayName: string;
  implemented: boolean;
  configured: boolean;
  envSecretName: string;
  modelsCount: number;
}

export class ProviderRegistry {
  private readonly adapters = new Map<AIProviderKey, AIProviderAdapter>();

  constructor(customAdapters?: AIProviderAdapter[]) {
    const list: AIProviderAdapter[] = customAdapters ?? [
      new GroqAdapter(),
      new GeminiAdapter(),
      ...createPreparedAdapters(),
    ];
    for (const adapter of list) {
      this.adapters.set(adapter.providerKey, adapter);
    }
  }

  register(adapter: AIProviderAdapter): void {
    this.adapters.set(adapter.providerKey, adapter);
  }

  get(key: AIProviderKey): AIProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  listAll(): AIProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  listSummaries(): ProviderSummary[] {
    return this.listAll().map((adapter) => ({
      providerKey: adapter.providerKey,
      displayName: adapter.displayName,
      implemented: adapter.isImplemented,
      configured: adapter.isImplemented && adapter.isConfigured(),
      envSecretName: adapter.envKeyName,
      modelsCount: adapter.listStaticModels().length,
    }));
  }

  listModels(): ModelSpec[] {
    return MODEL_CATALOG;
  }
}
