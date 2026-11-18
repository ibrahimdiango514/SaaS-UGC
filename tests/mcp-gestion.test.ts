import { describe, expect, it } from 'vitest';
import {
  appliquerPermission,
  estCheminGestion,
  permissionsInitiales,
  routeGestion,
  validerCible,
  validerCreation,
  validerPermission,
  MODES_AUTH,
  MAX_NOM_SERVEUR,
} from '../supabase/functions/mcp-client/gestion';
import {
  depuisLigneGeree,
  normaliserOutilsGeres,
  nomVault,
  versJson,
  type ServeurGere,
} from '../supabase/functions/mcp-client/gestion-serveur';
import { traduireErreurSql } from '../supabase/functions/mcp-client/gestion-http';

/**
 * Règles de gestion des connexions MCP sortantes — PUR.
 *
 * Aucune base, aucun réseau, aucun secret : ces tests prouvent que le code
 * valide correctement et refuse au bon endroit.
 */

const UUID = '11111111-2222-3333-4444-555555555555';

describe('routage des routes de gestion', () => {
  it('reconnaît chaque route sous le préfixe de fonction', () => {
    for (const route of ['lister', 'creer', 'tester', 'permissions', 'revoquer']) {
      expect(routeGestion(`/functions/v1/mcp-client/gestion/${route}`)).toBe(route);
    }
  });

  it('tolère une barre oblique finale', () => {
    expect(routeGestion('/functions/v1/mcp-client/gestion/tester/')).toBe('tester');
  });

  it('une route inconnue est distinguée d’une absence de route gestion', () => {
    // Le point important : `/gestion/inconnue` NE DOIT PAS tomber dans le
    // transport MCP d'appel d'outil.
    expect(estCheminGestion('/functions/v1/mcp-client/gestion/inconnue')).toBe(true);
    expect(routeGestion('/functions/v1/mcp-client/gestion/inconnue')).toBeNull();
  });

  it('le transport MCP normal n’est pas une route de gestion', () => {
    expect(estCheminGestion('/functions/v1/mcp-client')).toBe(false);
    expect(routeGestion('/functions/v1/mcp-client')).toBeNull();
  });

  it('le préfixe de fonction n’a pas à être connu', () => {
    expect(routeGestion('/autre/montage/gestion/lister')).toBe('lister');
  });
});

describe('validation de création', () => {
  const valide = {
    workspaceId: UUID,
    nom: 'Mon serveur',
    url: 'https://exemple.example/mcp',
    authKind: 'bearer',
    secret: 'jeton-de-test',
  };

  it('accepte une demande complète', () => {
    const r = validerCreation(valide);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.demande.url).toBe('https://exemple.example/mcp');
      expect(r.demande.authKind).toBe('bearer');
    }
  });

  it('refuse un corps non objet', () => {
    expect(validerCreation(null).ok).toBe(false);
    expect(validerCreation([1, 2]).ok).toBe(false);
    expect(validerCreation('texte').ok).toBe(false);
  });

  it('refuse un workspace qui n’est pas un UUID', () => {
    const r = validerCreation({ ...valide, workspaceId: 'pas-un-uuid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('workspace_id_invalide');
  });

  it('refuse un nom vide ou trop long', () => {
    expect(validerCreation({ ...valide, nom: '   ' }).ok).toBe(false);
    expect(validerCreation({ ...valide, nom: 'x'.repeat(MAX_NOM_SERVEUR + 1) }).ok).toBe(false);
  });

  it('refuse http:// — et le dit', () => {
    const r = validerCreation({ ...valide, url: 'http://exemple.example/mcp' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('url_non_https');
      expect(r.message).toContain('https');
    }
  });

  it('refuse un mode d’authentification inconnu', () => {
    const r = validerCreation({ ...valide, authKind: 'magie' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('auth_kind_invalide');
  });

  it('accepte les quatre modes alignés sur la contrainte SQL', () => {
    for (const mode of MODES_AUTH) {
      const corps = mode === 'none'
        ? { ...valide, authKind: mode, secret: undefined }
        : { ...valide, authKind: mode };
      expect(validerCreation(corps).ok).toBe(true);
    }
  });

  it('exige un secret dès que l’authentification n’est pas « none »', () => {
    const r = validerCreation({ ...valide, authKind: 'api_key', secret: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('secret_requis');
  });

  it('refuse un secret fourni en mode « none »', () => {
    const r = validerCreation({ ...valide, authKind: 'none', secret: 'inutile' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('secret_non_autorise');
  });

  it('ignore un userId fourni dans le corps', () => {
    // Le corps ne doit jamais choisir l'identité : la demande produite ne
    // contient aucun champ d'identité.
    const r = validerCreation({ ...valide, userId: UUID, user_id: UUID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.demande)).not.toContain('userId');
      expect(Object.keys(r.demande)).not.toContain('user_id');
    }
  });

  it('refuse un secret démesuré', () => {
    const r = validerCreation({ ...valide, secret: 'x'.repeat(9000) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('secret_trop_long');
  });
});

describe('validation de cible', () => {
  it('accepte un UUID de serveur', () => {
    expect(validerCible({ serverId: UUID }).ok).toBe(true);
    expect(validerCible({ server_id: UUID }).ok).toBe(true);
  });

  it('refuse tout le reste', () => {
    expect(validerCible({ serverId: 'x' }).ok).toBe(false);
    expect(validerCible({}).ok).toBe(false);
    expect(validerCible(null).ok).toBe(false);
  });
});

describe('permissions — fail-closed', () => {
  const outils = ['list_products', 'get_order'];

  it('accepte un outil réellement découvert', () => {
    const r = validerPermission({ outil: 'list_products', etat: 'allowed' }, outils);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.demande).toEqual({ outil: 'list_products', etat: 'allowed' });
  });

  it('refuse d’accorder une permission sur un outil NON découvert', () => {
    // Sans ce contrôle, on pourrait préparer une autorisation pour un outil
    // qu'un serveur distant ajouterait plus tard.
    const r = validerPermission({ outil: 'delete_everything', etat: 'allowed' }, outils);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.code).toBe('outil_inconnu');
    }
  });

  it('refuse un état arbitraire', () => {
    const r = validerPermission({ outil: 'list_products', etat: 'yes' }, outils);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('etat_invalide');
  });

  it('n’accepte pas « pending » en entrée', () => {
    // `pending` est un état interne produit par la découverte, jamais un choix.
    const r = validerPermission({ outil: 'list_products', etat: 'pending' }, outils);
    expect(r.ok).toBe(false);
  });

  it('n’expose AUCUN chemin pour accorder une écriture', () => {
    // La demande produite ne porte que deux champs. Un `ecritureAutorisee`
    // envoyé par le client ne peut donc pas être transmis.
    const r = validerPermission(
      { outil: 'list_products', etat: 'allowed', ecritureAutorisee: true, ecriture_autorisee: true },
      outils,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.demande).sort()).toEqual(['etat', 'outil']);
      expect(JSON.stringify(r.demande)).not.toContain('ecriture');
    }
  });

  it('refuse un nom d’outil vide ou démesuré', () => {
    expect(validerPermission({ outil: '', etat: 'allowed' }, outils).ok).toBe(false);
    expect(validerPermission({ outil: 'x'.repeat(300), etat: 'allowed' }, outils).ok).toBe(false);
  });
});

describe('fusion des permissions', () => {
  it('ajoute une permission sans écraser les autres', () => {
    const fusion = appliquerPermission({ get_order: 'allowed' }, 'list_products', 'denied');
    expect(fusion).toEqual({ get_order: 'allowed', list_products: 'denied' });
  });

  it('une valeur corrompue devient un objet vide (donc tout est refusé)', () => {
    expect(appliquerPermission('corrompu', 'x', 'allowed')).toEqual({ x: 'allowed' });
    expect(appliquerPermission([1, 2], 'x', 'denied')).toEqual({ x: 'denied' });
    expect(appliquerPermission(null, 'x', 'allowed')).toEqual({ x: 'allowed' });
  });
});

describe('permissions initiales après découverte', () => {
  const outils = [{ name: 'list_products' }, { name: 'get_order' }];

  it('tout est « pending » : découvrir n’accorde RIEN', () => {
    expect(permissionsInitiales(outils, undefined)).toEqual({
      list_products: 'pending',
      get_order: 'pending',
    });
  });

  it('conserve un choix explicite déjà fait', () => {
    const r = permissionsInitiales(outils, { list_products: 'allowed', get_order: 'denied' });
    expect(r).toEqual({ list_products: 'allowed', get_order: 'denied' });
  });

  it('ramène une valeur inattendue à « pending », jamais à « allowed »', () => {
    const r = permissionsInitiales(outils, { list_products: 'peut-etre', get_order: true });
    expect(r).toEqual({ list_products: 'pending', get_order: 'pending' });
  });

  it('un outil disparu du serveur ne conserve pas sa permission', () => {
    const r = permissionsInitiales([{ name: 'list_products' }], { list_products: 'allowed', supprime: 'allowed' });
    expect(r).toEqual({ list_products: 'allowed' });
    expect(r).not.toHaveProperty('supprime');
  });
});

describe('traduction des lignes SQL', () => {
  const ligne = {
    id: UUID,
    workspace_id: 'ws-1',
    name: 'Serveur',
    url: 'https://exemple.example/mcp',
    auth_kind: 'bearer',
    has_secret: true,
    status: 'connected',
    protocol_version: '2025-06-18',
    server_name: 'exemple',
    server_version: '1.0',
    tools: [{ name: 'list_products', description: 'Liste.' }],
    tool_permissions: { list_products: 'allowed' },
    last_checked_at: '2026-11-21T00:00:00Z',
    last_error: null,
    created_at: '2026-11-21T00:00:00Z',
    revoked_at: null,
  };

  it('traduit une ligne complète', () => {
    const s = depuisLigneGeree(ligne);
    expect(s.nom).toBe('Serveur');
    expect(s.aSecret).toBe(true);
    expect(s.outils).toEqual([{ name: 'list_products', description: 'Liste.' }]);
  });

  it('écarte un outil sans nom exploitable', () => {
    expect(normaliserOutilsGeres([{ description: 'sans nom' }, { name: '' }, { name: 'ok' }]))
      .toEqual([{ name: 'ok', description: undefined }]);
  });

  it('une liste d’outils corrompue devient vide', () => {
    expect(normaliserOutilsGeres('nawak')).toEqual([]);
    expect(normaliserOutilsGeres(null)).toEqual([]);
  });

  it('des permissions corrompues deviennent un objet vide', () => {
    const s = depuisLigneGeree({ ...ligne, tool_permissions: [1, 2] });
    expect(s.toolPermissions).toEqual({});
  });

  it('le nom Vault suit la convention de la migration', () => {
    expect(nomVault(UUID)).toBe(`mcp_server_${UUID}`);
  });
});

describe('sérialisation vers le navigateur — liste blanche', () => {
  const serveur: ServeurGere = {
    id: UUID,
    workspaceId: 'ws-1',
    nom: 'Serveur',
    url: 'https://exemple.example/mcp',
    authKind: 'bearer',
    aSecret: true,
    status: 'connected',
    protocolVersion: '2025-06-18',
    serverName: 'exemple',
    serverVersion: '1.0',
    outils: [{ name: 'list' }],
    toolPermissions: { list: 'allowed' },
    dernierTestAt: null,
    derniereErreur: null,
    createdAt: '2026-11-21T00:00:00Z',
    revokedAt: null,
  };

  it('ne contient aucun champ de secret', () => {
    const json = versJson(serveur);
    const texte = JSON.stringify(json);
    expect(json).not.toHaveProperty('secret');
    expect(json).not.toHaveProperty('secretRef');
    expect(texte).not.toContain('vault');
    expect(texte).not.toContain('mcp_server_');
  });

  it('expose seulement un booléen « aSecret »', () => {
    expect(versJson(serveur).aSecret).toBe(true);
  });

  it('n’ajoute JAMAIS un champ inconnu présent sur l’objet', () => {
    // Liste blanche, pas liste noire : si un champ secret apparaissait un jour
    // sur le type, il ne fuiterait pas par accident.
    const piege = { ...serveur, secret: 'fuite', token: 'fuite' } as unknown as ServeurGere;
    const json = versJson(piege);
    expect(json).not.toHaveProperty('secret');
    expect(json).not.toHaveProperty('token');
  });
});

describe('traduction des erreurs SQL', () => {
  it('traduit les codes connus sans exposer le SQL', () => {
    const r = traduireErreurSql('ERROR: workspace_forbidden CONTEXT: ...');
    expect(r.status).toBe(403);
    expect(r.code).toBe('workspace_forbidden');
    expect(r.message).not.toContain('CONTEXT');
  });

  it('ne relaie jamais un message SQL brut', () => {
    const r = traduireErreurSql('ERROR: relation "public.mcp_servers" does not exist');
    expect(r.status).toBe(500);
    expect(r.message).not.toContain('relation');
    expect(r.message).not.toContain('mcp_servers');
  });

  it('distingue révocation et serveur introuvable', () => {
    expect(traduireErreurSql('server_revoked').status).toBe(409);
    expect(traduireErreurSql('server_not_found').status).toBe(404);
  });
});

/**
 * Invariant de sérialisation JSONB.
 *
 * Trouvé en production : `/gestion/tester` renvoyait un 500 opaque. La cause
 * n'était ni le DNS ni le réseau, mais le double encodage JSON — `::jsonb` sur
 * une chaîne produite par `JSON.stringify` fait envoyer une CHAÎNE, refusée par
 * la contrainte `mcp_servers_tools_array`. Ces tests rejouent la requête telle
 * qu'elle est construite et vérifient ce que la base recevrait réellement.
 */
describe('gestion-serveur — les paramètres jsonb partent en texte', () => {
  /** Enregistre chaque requête : fragments littéraux + valeurs liées. */
  function sqlEspion(reponses: unknown[][]) {
    const requetes: Array<{ sql: string; valeurs: unknown[] }> = [];
    let index = 0;
    const tag = Object.assign(
      (fragments: TemplateStringsArray, ...valeurs: unknown[]) => {
        requetes.push({ sql: fragments.join('?'), valeurs });
        return Promise.resolve(reponses[index++] ?? []);
      },
      { end: () => Promise.resolve() },
    );
    return { sql: tag, requetes };
  }

  /**
   * Indices des paramètres liés à un cast `::jsonb` direct avec une valeur non
   * nulle. `?::jsonb` (et non `?::text::jsonb`) fait encoder la valeur une
   * seconde fois par le pilote : c'est exactement le défaut observé.
   */
  function castsJsonbBrutsNonNuls(requete: { sql: string; valeurs: unknown[] }): number[] {
    const fautifs: number[] = [];
    const positions = [...requete.sql.matchAll(/\?/g)].map((m) => m.index ?? 0);
    for (const [index, position] of positions.entries()) {
      const suite = requete.sql.slice(position);
      if (suite.startsWith('?::jsonb') && requete.valeurs[index] != null) fautifs.push(index);
    }
    return fautifs;
  }

  it('enregistrerDecouverte envoie tools comme un tableau JSON, jamais comme une chaîne', async () => {
    // 1re requête : permissions existantes ; les suivantes : les deux appels.
    const { sql, requetes } = sqlEspion([[{ tool_permissions: {} }], [], []]);
    const { creerAccesGestion } = await import('../supabase/functions/mcp-client/gestion-serveur');
    const acces = creerAccesGestion({ sql: (() => sql) as never });

    await acces.enregistrerDecouverte({
      userId: UUID,
      serverId: UUID,
      status: 'connected',
      protocolVersion: '2025-06-18',
      serverName: 'Microsoft Learn',
      serverVersion: '1.0.0',
      outils: [{ name: 'microsoft_docs_search', description: 'Recherche' }],
      erreur: null,
    });

    const sonde = requetes.find((r) => r.sql.includes('mcp_servers_record_probe'));
    expect(sonde).toBeDefined();
    // Le cast doit être `::text::jsonb` : c'est lui qui empêche le double encodage.
    expect(sonde!.sql).toContain('::text::jsonb');
    expect(castsJsonbBrutsNonNuls(sonde!)).toEqual([]);

    // La valeur liée est une chaîne, et son contenu redevient un TABLEAU.
    const outils = sonde!.valeurs.find((v) => typeof v === 'string' && v.startsWith('[{'));
    expect(typeof outils).toBe('string');
    expect(Array.isArray(JSON.parse(outils as string))).toBe(true);
  });

  it('set_permissions envoie un objet JSON, jamais une chaîne encodée deux fois', async () => {
    const { sql, requetes } = sqlEspion([[{ tool_permissions: {} }], [], []]);
    const { creerAccesGestion } = await import('../supabase/functions/mcp-client/gestion-serveur');
    const acces = creerAccesGestion({ sql: (() => sql) as never });

    await acces.enregistrerDecouverte({
      userId: UUID,
      serverId: UUID,
      status: 'connected',
      protocolVersion: '2025-06-18',
      serverName: 'X',
      serverVersion: '1',
      outils: [{ name: 'outil_a' }],
      erreur: null,
    });

    for (const requete of requetes) {
      // Aucune requête ne doit lier une valeur NON NULLE à un cast jsonb direct.
      // (`null::jsonb` reste correct : NULL satisfait la contrainte.)
      expect(castsJsonbBrutsNonNuls(requete)).toEqual([]);
    }
    const perms = requetes.find((r) => r.sql.includes('mcp_servers_set_permissions'));
    expect(perms).toBeDefined();
    const valeur = perms!.valeurs.find((v) => typeof v === 'string' && v.startsWith('{'));
    expect(typeof valeur).toBe('string');
    // `{"outil_a":{"etat":"pending"}}` — un objet, pas une chaîne.
    expect(typeof JSON.parse(valeur as string)).toBe('object');
  });
});
