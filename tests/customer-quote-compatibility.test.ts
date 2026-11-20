import { describe, expect, it } from 'vitest';
import { customerQuote } from '../supabase/functions/_shared/customer-quote';
import { buildBundle, renderLoader, renderSeedSql } from '../scripts/build-edge-loader.mjs';

describe('privacy release compatibility', () => {
  it('keeps old clients off the branch that formats a missing supplier cost as zero', () => {
    const result = customerQuote({ available: true, error_code: null });
    expect(result?.available).toBe(false);
    expect(result?.verified).toBe(true);
    expect(result?.billing_units.length).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/cost|USD|currency|margin|markup|pricing_basis/);
  });
  it('never echoes supplier diagnostics', () => {
    expect(customerQuote({ available: false, error_code: 'SECRET_PROVIDER_PRICE' })?.error_code).toBeNull();
    expect(customerQuote(null)).toBeNull();
  });
  it('pins the new video loader to a separate immutable artifact namespace', () => {
    const built = buildBundle(process.cwd(), 'reelora-video');
    const name = `reelora-video-${built.sha256}`;
    const loader = renderLoader(name, built);
    const sql = renderSeedSql(name, built);
    expect(loader).toContain(`const NAME = "${name}"`);
    expect(sql).not.toContain("where name = 'reelora-video';");
    expect(sql).toContain(`where name = '${name}';`);
    expect(loader).toContain(built.sha256);
  });
});
