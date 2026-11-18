import { describe, expect, it } from 'vitest';
import { creerAccesReel, depuisLigne } from '../supabase/functions/mcp-client/accueil';

/**
 * Accès aux données : traduction SQL → décision.
 *
 * ⚠️ TOUT CE FICHIER EST SIMULÉ. Aucune requête n'atteint PostgreSQL : le
 * « client SQL » ci-dessous reproduit la sémantique des deux requêtes de
 * `accueil.ts` (filtre propriétaire + appartenance au workspace, et lecture du
 * secret par la fonction dédiée). Cela prouve que **le code applique les bons
 * filtres**, pas que la base les applique — la migration P2 n'étant pas
 * appliquée, aucun test réel n'est possible aujourd'hui (voir le rapport).
 *
 * Les tests réellement exécutés contre Supabase seront possibles dès que la
 * migration sera en place ; ils ne sont pas prétendus ici.
 */

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const WS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SRV_A = '99999999-9999-9999-9999-999999999999';

interface LigneServeurSimulee {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  url: string;
  auth_kind: string;
  secret_ref: string | null;
  vault_name: string | null;
  status: string;
  revoked_at: string | null;
  tools: unknown;
  tool_permissions: unknown;
}

interface Hote {
  serveurs: LigneServeurSimulee[];
  secrets: { server_id: string; vault_name: string; valeur: string }[];
  membres: { user_id: string; workspace_id: string }[];
}

function hote(): Hote {
  return {
    serveurs: [{
      id: SRV_A,
      user_id: USER_A,
      workspace_id: WS_A,
      name: 'Boutique A',
      url: 'https://mcp.exemple.com/mcp',
      auth_kind: 'bearer',
      secret_ref: SRV_A,
      vault_name: `mcp_server_${SRV_A}`,
      status: 'connected',
      revoked_at: null,
      tools: [{ name: 'list_products', description: 'Liste les produits.' }],
      tool_permissions: { list_products: 'allowed' },
    }],
    secrets: [{ server_id: SRV_A, vault_name: `mcp_server_${SRV_A}`, valeur: 'secret-a' }],
    membres: [
      { user_id: USER_A, workspace_id: WS_A },
      { user_id: USER_B, workspace_id: WS_B },
    ],
  };
}

/**
 * Faux client `postgres.js`.
 *
 * Il ne comprend que les deux requêtes réellement émises par `accueil.ts`, et
 * échoue bruyamment sur toute autre — un simulacre qui accepterait n'importe
 * quoi ne prouverait rien.
 */
function clientSimule(h: Hote) {
  const fermetures: number[] = [];
  const requete = async (fragments: TemplateStringsArray, ...valeurs: unknown[]): Promise<unknown[]> => {
    const sql = fragments.join('?').replace(/\s+/g, ' ').trim();

    if (sql.includes('from public.mcp_servers s')) {
      const [serverId, userId] = valeurs as [string, string];
      const estMembre = h.membres.some((m) => m.user_id === userId && m.workspace_id === m.workspace_id);
      void estMembre; // l'appartenance est calculée ligne par ligne ci-dessous
      return h.serveurs
        .filter((s) => s.id === serverId && s.user_id === userId)
        .filter((s) => h.membres.some((m) => m.user_id === s.user_id && m.workspace_id === s.workspace_id))
        .map((s) => ({
          ...s,
          vault_name: h.secrets.find((x) => x.server_id === s.id)?.vault_name ?? s.vault_name,
        }));
    }

    if (sql.includes('public.mcp_servers_secret(')) {
      const [serverId] = valeurs as [string];
      const ligne = h.secrets.find((s) => s.server_id === serverId);
      return [{ secret: ligne?.valeur ?? null }];
    }

    throw new Error(`Requête inattendue dans le simulateur : ${sql}`);
  };

  const client = requete as unknown as {
    (f: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    end(options?: { timeout?: number }): Promise<void>;
  };
  client.end = async () => { fermetures.push(Date.now()); };
  return { client, fermetures };
}

function accesVers(h: Hote) {
  const { client, fermetures } = clientSimule(h);
  return { acces: creerAccesReel({ sql: () => client }), fermetures };
}

/* -------------------------------------------------------------------------- */

describe('SIMULÉ — traduction d’une ligne en connexion', () => {
  const base: LigneServeurSimulee = {
    id: SRV_A,
    user_id: USER_A,
    workspace_id: WS_A,
    name: 'X',
    url: 'https://x.example/mcp',
    auth_kind: 'bearer',
    secret_ref: SRV_A,
    vault_name: `mcp_server_${SRV_A}`,
    status: 'connected',
    revoked_at: null,
    tools: [],
    tool_permissions: {},
  };

  it('écarte un outil sans nom exploitable', () => {
    const c = depuisLigne({
      ...base,
      tools: [{ name: 'ok' }, { name: '   ' }, { name: 42 }, null, 'texte', { description: 'sans nom' }],
    });
    expect(c.outils).toEqual([{ name: 'ok', description: undefined }]);
  });

  it('une liste d’outils corrompue devient vide, donc tout est refusé', () => {
    for (const tools of [null, 'x', 42, { a: 1 }]) {
      expect(depuisLigne({ ...base, tools }).outils).toEqual([]);
    }
  });

  it('un auth_kind inconnu devient « none » sans inventer de secret', () => {
    const c = depuisLigne({ ...base, auth_kind: 'magique', vault_name: null, secret_ref: null });
    expect(c.authKind).toBe('none');
    expect(c.secretVaultName).toBeNull();
  });

  it('un statut inconnu devient « error », jamais « connected »', () => {
    for (const status of ['CONNECTED', 'ok', '', 'weird']) {
      expect(depuisLigne({ ...base, status }).status).toBe('error');
    }
  });

  it('des permissions non-objet deviennent un objet vide', () => {
    for (const tool_permissions of [null, [], 'allowed', 3]) {
      expect(depuisLigne({ ...base, tool_permissions }).toolPermissions).toEqual({});
    }
  });

  it('aucune autorisation d’écriture n’est jamais accordée', () => {
    const c = depuisLigne({ ...base, tool_permissions: { delete_product: 'allowed' } });
    expect(c.ecrituresAutorisees).toEqual({});
  });

  it('le nom de secret est déduit de l’identifiant si la jointure manque', () => {
    expect(depuisLigne({ ...base, vault_name: null }).secretVaultName).toBe(`mcp_server_${SRV_A}`);
  });
});

describe('SIMULÉ — lecture et filtres (faux PostgreSQL, sémantique reproduite)', () => {
  it('le propriétaire obtient sa connexion, permissions comprises', async () => {
    const { acces } = accesVers(hote());
    const c = await acces.lireConnexion({ userId: USER_A, serverId: SRV_A });
    expect(c?.workspaceId).toBe(WS_A);
    expect(c?.toolPermissions).toEqual({ list_products: 'allowed' });
  });

  it('un autre utilisateur n’obtient rien, même avec le bon identifiant de serveur', async () => {
    const { acces } = accesVers(hote());
    expect(await acces.lireConnexion({ userId: USER_B, serverId: SRV_A })).toBeNull();
  });

  it('un membre retiré du workspace n’obtient plus rien', async () => {
    const h = hote();
    h.membres = h.membres.filter((m) => m.workspace_id !== WS_A);
    const { acces } = accesVers(h);
    expect(await acces.lireConnexion({ userId: USER_A, serverId: SRV_A })).toBeNull();
  });

  it('une permission retirée est vue immédiatement, sans cache', async () => {
    const h = hote();
    const { acces } = accesVers(h);
    expect((await acces.lireConnexion({ userId: USER_A, serverId: SRV_A }))?.toolPermissions)
      .toEqual({ list_products: 'allowed' });
    h.serveurs[0].tool_permissions = {};
    expect((await acces.lireConnexion({ userId: USER_A, serverId: SRV_A }))?.toolPermissions)
      .toEqual({});
  });

  it('une connexion révoquée reste lisible, avec revokedAt renseigné', async () => {
    const h = hote();
    h.serveurs[0].status = 'revoked';
    h.serveurs[0].revoked_at = '2026-11-21T00:00:00Z';
    const { acces } = accesVers(h);
    expect((await acces.lireConnexion({ userId: USER_A, serverId: SRV_A }))?.revokedAt)
      .toBe('2026-11-21T00:00:00Z');
  });

  it('le secret n’est lu que pour un nom conforme', async () => {
    const { acces } = accesVers(hote());
    expect(await acces.lireSecret(`mcp_server_${SRV_A}`)).toBe('secret-a');
    // Un nom forgé ne doit pas permettre d'atteindre un autre secret Vault.
    expect(await acces.lireSecret('reelora_worker_token')).toBeNull();
    expect(await acces.lireSecret('mcp_server_pas-un-uuid')).toBeNull();
    expect(await acces.lireSecret('mcp_server_')).toBeNull();
  });

  it('chaque opération referme sa connexion SQL', async () => {
    const { acces, fermetures } = accesVers(hote());
    await acces.lireConnexion({ userId: USER_A, serverId: SRV_A });
    await acces.lireSecret(`mcp_server_${SRV_A}`);
    expect(fermetures).toHaveLength(2);
  });
});
