import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Business Grow integration boundaries', () => {
  it('keeps provider endpoints and credentials out of browser code', () => {
    const api = read('src/business/api.ts');

    expect(api).toContain("functions.invoke('business-grow'");
    expect(api).not.toMatch(/api\.groq\.com|generativelanguage\.googleapis\.com/i);
    expect(api).not.toMatch(/BUSINESS_GROW_.*API_KEY|GROQ_API_KEY|GEMINI_API_KEY/);
  });

  it('does not call Studio credit or quota operations from the Business Grow server', () => {
    const edge = [
      read('supabase/functions/business-grow/index.ts'),
      read('supabase/functions/business-grow/handler.ts'),
      read('supabase/functions/business-grow/providers.ts'),
    ].join('\n');

    expect(edge).not.toMatch(/reelora_(?:charge|refund|reserve).*credit|reelora_.*quota/i);
    expect(edge).not.toMatch(/credits_balance|credits_cost|monthly_credits/i);
  });

  it('keeps Business Grow usage accounting in its own schema and tables', () => {
    const design = read('docs/business-grow-sql-design.md');
    const usageTable = design.match(/CREATE TABLE saas_business\.usage_events \([\s\S]*?\n\);/i);

    expect(usageTable?.[0]).toContain('attempt_id');
    expect(usageTable?.[0]).toContain('provider_cost_micros');
    expect(usageTable?.[0]).not.toMatch(/credits_balance|credits_cost|monthly_credits/i);
    expect(design).toContain('ALTER TABLE saas_business.conversations FORCE ROW LEVEL SECURITY;');
    expect(design).toContain('ALTER TABLE saas_business.ai_requests FORCE ROW LEVEL SECURITY;');
  });

  it('keeps both Business Grow SQL migrations isolated from Studio credit/quota tables and enforced by RLS', () => {
    const m1 = read('supabase/migrations/20261110000001_business_grow_saas_business.sql');
    const m2 = read('supabase/migrations/20261110000002_business_grow_ai_extensions.sql');
    const intelligence = read('supabase/functions/business-grow/intelligence.ts');

    for (const content of [m1, m2, intelligence]) {
      expect(content).not.toMatch(/saas_ugc\.credit_ledger|saas_ugc\.ugc_wallets|reelora_reserve_credits|reelora_charge_credits|credits_balance|monthly_credits/i);
    }

    expect(m1).toContain('CREATE SCHEMA saas_business AUTHORIZATION bg_owner;');
    expect(m1).toContain('ALTER TABLE saas_business.integration_connections FORCE ROW LEVEL SECURITY;');
    expect(m2).toContain('ALTER TABLE saas_business.wallets FORCE ROW LEVEL SECURITY;');
    expect(m2).toContain('ALTER TABLE saas_business.credit_ledger FORCE ROW LEVEL SECURITY;');
    expect(m2).toContain('ALTER TABLE saas_business.user_routing_preferences FORCE ROW LEVEL SECURITY;');
    expect(m2).toContain('ALTER TABLE saas_business.tool_executions FORCE ROW LEVEL SECURITY;');
    expect(m2).toContain('bg_get_workspace_context');
    expect(m2).not.toMatch(/INSERT INTO saas_ugc|UPDATE saas_ugc|DELETE FROM saas_ugc/i);
  });
});
