import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  creerAccesMcp,
  isUuid,
  listerOutilsMcp,
  normalizeMcpToolName,
  proposerOutilMcp,
  type McpSql,
} from '../supabase/functions/business-grow/mcp-tools';

const MIGRATION = readFileSync('supabase/migrations/20261128100000_vyora_mcp_agent_tools.sql', 'utf8');
const CLIENT_MCP = readFileSync('supabase/functions/mcp-client/client.ts', 'utf8');

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const SERVER = '55555555-5555-4555-8555-555555555555';

/** Double SQL : enregistre les appels et répond ce qu'on lui impose. */
function sqlFactice(reponse: unknown[] | (() => Promise<never>)): McpSql & { appels: unknown[][] } {
  const appels: unknown[][] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    appels.push([strings.join('?'), ...values]);
    if (typeof reponse === 'function') return reponse();
    return Promise.resolve(reponse);
  }) as McpSql & { appels: unknown[][] };
  fn.appels = appels;
  return fn;
}

// ---------------------------------------------------------------------------
// 1. Classification lecture/écriture : copie exacte de la règle TypeScript
// ---------------------------------------------------------------------------

/**
 * Ces trois listes sont dupliquées dans la migration SQL et dans `client.ts`.
 * Le jour où l'une bouge sans l'autre, un outil destructeur peut être présenté
 * comme une lecture. Ce test compare les deux sources, mot pour mot.
 */
describe('classification lecture/écriture alignée sur mcp-client', () => {
  function extraireListe(source: string, nom: string): string[] {
    const debut = source.indexOf(`const ${nom} = [`);
    expect(debut, `liste ${nom} introuvable`).toBeGreaterThan(-1);
    const fin = source.indexOf('];', debut);
    const corps = source.slice(debut, fin);
    return [...corps.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }

  function extraireSql(nomCte: string): string[] {
    const debut = MIGRATION.indexOf(`with ecriture(v) as`);
    const reel = nomCte === 'ecriture' ? debut : MIGRATION.indexOf(`lecture(v) as (`, debut);
    expect(reel, `CTE ${nomCte} introuvable`).toBeGreaterThan(-1);
    const fin = MIGRATION.indexOf(']::text[])', reel);
    return [...MIGRATION.slice(reel, fin).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }

  it('les verbes d’écriture sont identiques dans le SQL et dans client.ts', () => {
    const ts = extraireListe(CLIENT_MCP, 'VERBES_ECRITURE');
    const sql = extraireSql('ecriture');
    expect(ts.length).toBeGreaterThan(80);
    // L'ordre n'importe pas (on teste l'appartenance), l'ensemble oui.
    expect([...sql].sort()).toEqual([...ts].sort());
  });

  it('les verbes de lecture sont identiques dans le SQL et dans client.ts', () => {
    const ts = extraireListe(CLIENT_MCP, 'VERBES_LECTURE');
    const sql = extraireSql('lecture');
    expect(ts.length).toBeGreaterThan(20);
    expect([...sql].sort()).toEqual([...ts].sort());
  });

  it('la classification SQL reste fail-closed : un nom inconnu est une écriture', () => {
    // `else true` : l'absence de signal n'est PAS une preuve d'innocuité.
    expect(MIGRATION).toMatch(/when lit_nom then false[\s\S]{0,200}else true/);
    // Un verbe d'écriture l'emporte, y compris en composition.
    expect(MIGRATION).toMatch(/when ecrit_nom or ecrit_desc then true/);
  });
});

// ---------------------------------------------------------------------------
// 2. Garde-fous de la migration
// ---------------------------------------------------------------------------

describe('migration des outils MCP pour les agents', () => {
  it('ne référence aucune colonne inexistante', () => {
    // `public.mcp_servers` n'a ni `tool_writes` ni `ecritures_autorisees`.
    // S'appuyer dessus ferait échouer la migration à l'application.
    expect(MIGRATION).not.toMatch(/tool_writes/);
    expect(MIGRATION).not.toMatch(/ecritures_autorisees/);
  });

  it('n’accorde l’exécution qu’au rôle Edge Business Grow', () => {
    // La migration MCP d'origine n'accorde qu'à `service_role`. Ces fonctions-ci
    // sont appelées par `bg_edge` : sans GRANT explicite, elles sont
    // inutilisables, et le pont resterait mort.
    const grants = [...MIGRATION.matchAll(/grant execute on function ([^\n]+?) to (\w+);/g)];
    expect(grants.length).toBeGreaterThanOrEqual(7);
    for (const [, , role] of grants) expect(role).toBe('bg_edge');
    // Aucun accès depuis les rôles clients.
    for (const ligne of MIGRATION.split('\n').filter((l) => l.startsWith('grant execute'))) {
      expect(ligne).not.toMatch(/to (public|anon|authenticated|service_role)/);
    }
  });

  it('révoque les rôles clients avant chaque octroi', () => {
    const revokes = [...MIGRATION.matchAll(/revoke all on function [^\n]+?\n?\s*from ([^;]+);/g)];
    expect(revokes.length).toBeGreaterThanOrEqual(7);
    for (const [, cibles] of revokes) {
      expect(cibles).toMatch(/public/);
      expect(cibles).toMatch(/anon/);
      expect(cibles).toMatch(/authenticated/);
    }
  });

  it('ne fait sortir aucune requête réseau du SQL', () => {
    // Le SQL pose `approved` + `requires_external_execution` ; c'est l'Edge
    // `mcp-client` qui appelle, sous son propre contrôle SSRF. Une fonction SQL
    // qui appellerait le réseau serait un contournement de cette porte.
    expect(MIGRATION).not.toMatch(/http_post|pg_net|net\.http/);
    expect(MIGRATION).toMatch(/requires_external_execution = true/);
  });

  it('route les exécutions MCP dans le seul point d’entrée existant', () => {
    // Router ailleurs laisserait un client ancien appeler l'ancien chemin et
    // refuser les outils MCP : la fonctionnalité serait morte pour lui.
    const corps = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function saas_business.bg_agent_resolve_scoped_tool('),
    );
    expect(corps).toMatch(/if v_mcp_server is not null then/);
    expect(corps).toMatch(/return saas_business\.bg_resolve_mcp_tool\(/);
    expect(corps).toMatch(/return saas_business\.bg_agent_resolve_tool\(/);
    // L'appartenance est revérifiée AVANT la bifurcation.
    expect(corps.indexOf('c.workspace_id = p_workspace_id')).toBeLessThan(
      corps.indexOf('bg_resolve_mcp_tool('),
    );
  });

  it('refuse un outil d’écriture au moment de la proposition', () => {
    const corps = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function saas_business.bg_create_mcp_tool_execution('),
      MIGRATION.indexOf('create or replace function saas_business.bg_resolve_mcp_tool('),
    );
    expect(corps).toMatch(/and not saas_business\.bg_mcp_tool_is_write\(/);
    // Le refus reste générique : il ne confirme pas l'existence d'un serveur.
    expect(corps).toMatch(/raise exception 'mcp tool not allowed'/);
    expect(corps).not.toMatch(/tool_writes/);
  });

  it('revérifie la permission au moment de l’approbation', () => {
    const corps = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function saas_business.bg_resolve_mcp_tool('),
      MIGRATION.indexOf('create or replace function saas_business.bg_finish_mcp_tool('),
    );
    // Le serveur a pu être révoqué entre la proposition et l'approbation.
    expect(corps).toMatch(/MCP_TOOL_NO_LONGER_ALLOWED/);
    expect(corps).toMatch(/s\.revoked_at is null/);
    expect(corps).toMatch(/status = 'connected'/);
    expect(corps).toMatch(/tool_permissions ->> v_tool\.tool_name\) = 'allowed'/);
  });
});

// ---------------------------------------------------------------------------
// 3. Module applicatif
// ---------------------------------------------------------------------------

describe('normalizeMcpToolName', () => {
  it('accepte un nom technique simple', () => {
    expect(normalizeMcpToolName('get_orders')).toBe('get_orders');
    expect(normalizeMcpToolName('docs.search')).toBe('docs.search');
    expect(normalizeMcpToolName('ns:outil-1')).toBe('ns:outil-1');
    expect(normalizeMcpToolName('  get_orders  ')).toBe('get_orders');
  });

  it('refuse ce qui ne peut pas être affiché sans risque', () => {
    expect(normalizeMcpToolName(null)).toBeNull();
    expect(normalizeMcpToolName(42)).toBeNull();
    expect(normalizeMcpToolName('')).toBeNull();
    expect(normalizeMcpToolName('   ')).toBeNull();
    // Espaces, sauts de ligne, caractères de contrôle : un nom d'outil distant
    // finit dans un écran d'approbation, donc il ne doit rien pouvoir y injecter.
    expect(normalizeMcpToolName('get orders')).toBeNull();
    expect(normalizeMcpToolName('get\norders')).toBeNull();
    expect(normalizeMcpToolName('get\u0000orders')).toBeNull();
    expect(normalizeMcpToolName('supprime;drop')).toBeNull();
    expect(normalizeMcpToolName('x'.repeat(121))).toBeNull();
  });

  it('accepte exactement la limite de longueur', () => {
    expect(normalizeMcpToolName('x'.repeat(120))).toBe('x'.repeat(120));
  });
});

describe('isUuid', () => {
  it('n’accepte qu’un identifiant complet', () => {
    expect(isUuid(USER)).toBe(true);
    expect(isUuid('pas-un-uuid')).toBe(false);
    expect(isUuid(`${USER.slice(0, 35)}`)).toBe(false);
    expect(isUuid(`${USER}0`)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe('listerOutilsMcp', () => {
  it('renvoie le catalogue normalisé', async () => {
    const sql = sqlFactice([{
      outils: [
        { server_id: SERVER, server_name: 'Boutique', tool_name: 'get_orders', description: 'Liste', executable: true },
      ],
    }]);
    const outils = await listerOutilsMcp(sql, USER, WORKSPACE);
    expect(outils).toEqual([{
      serverId: SERVER,
      serverName: 'Boutique',
      toolName: 'get_orders',
      description: 'Liste',
      executable: true,
    }]);
    // L'isolation est appliquée par la base : on lui passe bien les DEUX clés.
    expect(sql.appels[0]).toContain(USER);
    expect(sql.appels[0]).toContain(WORKSPACE);
  });

  it('écarte les entrées hostiles venues d’un serveur tiers', async () => {
    const sql = sqlFactice([{
      outils: [
        // Identifiant forgé : ne doit jamais devenir un lien vers un serveur.
        { server_id: 'pas-un-uuid', server_name: 'X', tool_name: 'get_orders', executable: true },
        // Nom d'outil non conforme.
        { server_id: SERVER, server_name: 'X', tool_name: 'get orders\ndrop', executable: true },
        // Entrée qui n'est pas un objet.
        'texte libre',
        // Celle-ci est valide.
        { server_id: SERVER, server_name: 'B', tool_name: 'list_items', description: 'ok', executable: true },
      ],
    }]);
    const outils = await listerOutilsMcp(sql, USER, WORKSPACE);
    expect(outils).toHaveLength(1);
    expect(outils[0].toolName).toBe('list_items');
  });

  it('ne fait jamais confiance au drapeau `executable` implicite', async () => {
    const sql = sqlFactice([{
      outils: [{ server_id: SERVER, server_name: 'B', tool_name: 'get_x' }],
    }]);
    const outils = await listerOutilsMcp(sql, USER, WORKSPACE);
    // Absent ⇒ `false` : on n'ouvre pas une exécution par omission.
    expect(outils[0].executable).toBe(false);
  });

  it('tronque les textes trop longs plutôt que de les relayer tels quels', async () => {
    const sql = sqlFactice([{
      outils: [{
        server_id: SERVER,
        server_name: 'n'.repeat(500),
        tool_name: 'get_x',
        description: 'd'.repeat(5000),
        executable: true,
      }],
    }]);
    const [outil] = await listerOutilsMcp(sql, USER, WORKSPACE);
    expect(outil.serverName.length).toBe(200);
    expect(outil.description.length).toBe(500);
  });

  it('renvoie une liste vide si la base est indisponible', async () => {
    const sql = sqlFactice(() => Promise.reject(new Error('connexion perdue')));
    await expect(listerOutilsMcp(sql, USER, WORKSPACE)).resolves.toEqual([]);
  });

  it('renvoie une liste vide sur une réponse inattendue', async () => {
    for (const reponse of [[], [{}], [{ outils: 'pas-un-tableau' }], [{ outils: null }]]) {
      const sql = sqlFactice(reponse);
      await expect(listerOutilsMcp(sql, USER, WORKSPACE)).resolves.toEqual([]);
    }
  });

  it('n’interroge pas la base avec un identifiant invalide', async () => {
    const sql = sqlFactice([]);
    expect(await listerOutilsMcp(sql, 'pas-un-uuid', WORKSPACE)).toEqual([]);
    expect(await listerOutilsMcp(sql, USER, 'pas-un-uuid')).toEqual([]);
    expect(sql.appels).toHaveLength(0);
  });
});

describe('proposerOutilMcp', () => {
  const base = {
    userId: USER,
    conversationId: CONVERSATION,
    requestId: REQUEST,
    serverId: SERVER,
    toolName: 'get_orders',
    arguments: { limit: 10 },
  };

  it('transmet la proposition et renvoie son identifiant', async () => {
    const id = '99999999-9999-4999-8999-999999999999';
    const sql = sqlFactice([{ id }]);
    await expect(proposerOutilMcp(sql, base)).resolves.toBe(id);
    const appel = sql.appels[0];
    expect(appel).toContain(USER);
    expect(appel).toContain(CONVERSATION);
    expect(appel).toContain(REQUEST);
    expect(appel).toContain(SERVER);
    expect(appel).toContain('get_orders');
    // Les arguments sont sérialisés : un objet ne traverse pas tel quel.
    expect(appel.some((v) => typeof v === 'string' && v.includes('"limit":10'))).toBe(true);
  });

  it('renvoie null sans interroger la base si un identifiant est invalide', async () => {
    const sql = sqlFactice([{ id: 'x' }]);
    for (const champ of ['userId', 'conversationId', 'requestId', 'serverId'] as const) {
      await expect(proposerOutilMcp(sql, { ...base, [champ]: 'invalide' })).resolves.toBeNull();
    }
    expect(sql.appels).toHaveLength(0);
  });

  it('renvoie null sur un nom d’outil non conforme', async () => {
    const sql = sqlFactice([{ id: 'x' }]);
    await expect(proposerOutilMcp(sql, { ...base, toolName: 'get orders' })).resolves.toBeNull();
    await expect(proposerOutilMcp(sql, { ...base, toolName: 'delete;drop' })).resolves.toBeNull();
    expect(sql.appels).toHaveLength(0);
  });

  it('refuse une charge au-delà du plafond SQL, sans aller-retour', async () => {
    const sql = sqlFactice([{ id: 'x' }]);
    const enorme = { texte: 'a'.repeat(12_001) };
    await expect(proposerOutilMcp(sql, { ...base, arguments: enorme })).resolves.toBeNull();
    expect(sql.appels).toHaveLength(0);
  });

  it('renvoie null quand la base refuse la proposition', async () => {
    // Permission absente, serveur révoqué, outil d'écriture, autre entreprise :
    // la base lève, et ce n'est pas une panne à propager.
    const sql = sqlFactice(() => Promise.reject(new Error('mcp tool not allowed')));
    await expect(proposerOutilMcp(sql, base)).resolves.toBeNull();
  });

  it('renvoie null si la base ne renvoie pas d’identifiant exploitable', async () => {
    for (const reponse of [[], [{}], [{ id: null }], [{ id: 'pas-un-uuid' }]]) {
      const sql = sqlFactice(reponse);
      await expect(proposerOutilMcp(sql, base)).resolves.toBeNull();
    }
  });

  it('remplace des arguments non-objet par un objet vide', async () => {
    const sql = sqlFactice([{ id: '99999999-9999-4999-8999-999999999999' }]);
    await proposerOutilMcp(sql, { ...base, arguments: ['a'] as unknown as Record<string, unknown> });
    expect(sql.appels[0].some((v) => typeof v === 'string' && v === '{}')).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// 4. Branchement réel : la panne reste silencieuse
// ---------------------------------------------------------------------------

describe('creerAccesMcp', () => {
  const appel = {
    userId: USER,
    conversationId: CONVERSATION,
    requestId: REQUEST,
    serverId: SERVER,
    toolName: 'get_orders',
    arguments: {},
  };

  it('ne tente aucune connexion tant qu’on ne l’interroge pas', () => {
    let ouvertures = 0;
    const acces = creerAccesMcp({
      env: () => 'postgres://exemple',
      postgres: () => { ouvertures += 1; return sqlFactice([]); },
    });
    expect(acces).toBeDefined();
    // Le simple fait de construire l'accès ne doit rien ouvrir : un Business
    // Grow sans MCP ne doit pas payer une connexion au démarrage.
    expect(ouvertures).toBe(0);
  });

  it('reste muet quand la base n’est pas configurée', async () => {
    const acces = creerAccesMcp({ env: () => undefined, postgres: () => sqlFactice([]) });
    await expect(acces.listerOutils(USER, WORKSPACE)).resolves.toEqual([]);
    await expect(acces.proposerOutil(appel)).resolves.toBeNull();
  });

  it('reste muet quand le pilote SQL est absent', async () => {
    // `__bgPostgres` est posé par le chargeur ; s'il manque, l'accès MCP tombe,
    // mais le reste de Business Grow doit continuer de répondre.
    const acces = creerAccesMcp({ env: () => 'postgres://exemple' });
    await expect(acces.listerOutils(USER, WORKSPACE)).resolves.toEqual([]);
    await expect(acces.proposerOutil(appel)).resolves.toBeNull();
  });

  it('réutilise la même connexion pour plusieurs appels', async () => {
    let ouvertures = 0;
    const sql = sqlFactice([{ outils: [] }]);
    const acces = creerAccesMcp({
      env: () => 'postgres://exemple',
      postgres: () => { ouvertures += 1; return sql; },
    });
    await acces.listerOutils(USER, WORKSPACE);
    await acces.listerOutils(USER, WORKSPACE);
    expect(ouvertures).toBe(1);
  });

  it('applique les options de connexion attendues', async () => {
    let recues: Record<string, unknown> | null = null;
    const acces = creerAccesMcp({
      env: (nom) => (nom === 'SUPABASE_DB_URL' ? 'postgres://repli' : undefined),
      postgres: (_url: string, options: Record<string, unknown>) => { recues = options; return sqlFactice([]); },
    });
    await acces.listerOutils(USER, WORKSPACE);
    expect(recues).toMatchObject({ max: 1, ssl: 'require', prepare: false });
    // Le repli sur `SUPABASE_DB_URL` est celui de `index.ts`.
    const options = recues as unknown as { connection?: { application_name?: string } };
    expect(options.connection?.application_name).toBe('reelora-business-grow-edge-mcp');
  });
});
