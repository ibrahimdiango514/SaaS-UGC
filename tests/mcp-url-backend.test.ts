// @vitest-environment jsdom
/**
 * Régression P6e : sans `VITE_SUPABASE_URL`, les routes MCP doivent viser le
 * projet Supabase public — jamais une URL relative servie par l'hébergeur du
 * front (qui répond une page HTML 200 et fait croire à une liste vide).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('URL du backend MCP sans variable d\u2019environnement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('les routes de gestion restent absolues vers le projet Supabase', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.resetModules();
    const { urlGestion } = await import('../src/mcp/serveurs');
    const url = urlGestion('lister');
    expect(url).toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/gestion/lister');
    expect(url.startsWith('/')).toBe(false);
  });

  it("l'URL affichée du serveur vyora-mcp reste absolue", async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.resetModules();
    const { MCP_SERVER_URL } = await import('../src/mcp/api');
    expect(MCP_SERVER_URL).toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp');
  });

  it('une variable fournie est respectée', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://exemple.supabase.co');
    vi.resetModules();
    const { urlGestion } = await import('../src/mcp/serveurs');
    expect(urlGestion('creer')).toBe('https://exemple.supabase.co/functions/v1/mcp-client/gestion/creer');
  });
});
