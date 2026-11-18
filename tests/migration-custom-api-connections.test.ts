import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fous sur la persistance du connecteur API personnalisée.
 *
 * ## Ce que ces tests prouvent, et ce qu'ils ne prouvent pas
 *
 * Ils lisent le SQL, pas la base. Ils empêchent donc la **régression de la
 * déclaration**, pas celle de l'état déployé.
 *
 * La preuve sur la base a été faite séparément, par requêtes réelles contre
 * `xbuuhfwobrafcbgtdgjx` :
 *   - `pg_policies` → 1 policy de lecture, **0** d'écriture ;
 *   - `pg_proc` → les 2 RPC existent, avec les arguments attendus ;
 *   - `bg_save_custom_api_connection` appelée avec une sonde 500, 0 produit,
 *     un mapping sans nom ou une unité de prix invalide → **4 refus** ;
 *   - insertion directe d'une `base_url` contenant `user:pass@` → refus par
 *     contrainte ;
 *   - après ces essais, `custom_api_connections` compte **0 ligne** : aucun
 *     essai n'a laissé de trace.
 *
 * Ces deux niveaux sont complémentaires : le test empêche d'oublier la garde
 * lors d'une future édition, la vérification en base empêche de croire qu'un
 * fichier suffit.
 */

const MIGRATION = readFileSync(
  'supabase/migrations/20261119120000_custom_api_connections.sql',
  'utf8',
);

/** Retire les commentaires : un mot dans un commentaire n'est pas une règle. */
function sansCommentaires(sql: string): string {
  return sql
    .split('\n')
    .map((ligne) => ligne.replace(/--.*$/, ''))
    .join('\n');
}

const CODE = sansCommentaires(MIGRATION);

describe('migration — table de configuration', () => {
  it('crée la table rattachée à la connexion, avec cascade', () => {
    expect(CODE).toMatch(/create table if not exists saas_business\.custom_api_connections/i);
    // Une déconnexion supprime la connexion : la configuration doit suivre,
    // sinon elle resterait orpheline et invisible.
    expect(CODE).toMatch(/references saas_business\.integration_connections\(id\) on delete cascade/i);
    expect(CODE).toMatch(/unique \(connection_id\)/i);
  });

  it('impose HTTPS sur l’adresse de base', () => {
    expect(CODE).toMatch(/base_url text not null check \(base_url like 'https:\/\/%'/i);
  });

  it('interdit une adresse portant un secret', () => {
    const contrainte = CODE.slice(CODE.indexOf('custom_api_connections_no_secret_in_url'));
    expect(contrainte).toMatch(/base_url not like '%\?%'/i);
    expect(contrainte).toMatch(/base_url not like '%@%'/i);
    expect(contrainte).toMatch(/base_url not like '%#%'/i);
  });

  it('n’a AUCUNE colonne susceptible de contenir un secret', () => {
    /*
     * Le premier jet prévoyait `custom_headers`. Postgres a refusé la
     * sous-requête du CHECK, ce qui a conduit à supprimer la colonne : des
     * en-têtes sans valeur n'ont pas d'usage, et une colonne qui ne peut
     * légitimement contenir qu'une valeur interdite ne doit pas exister.
     */
    expect(CODE).not.toMatch(/^\s*custom_headers\s/m);
    expect(CODE).not.toMatch(/^\s*api_key\s/m);
    expect(CODE).not.toMatch(/^\s*secret\s/m);
    expect(CODE).not.toMatch(/^\s*token\s/m);
    // Le nom du secret Vault vit dans `integration_connections`, pas ici.
    expect(CODE).not.toMatch(/^\s*credential_ref\s/m);
  });

  it('force la lecture seule par contrainte', () => {
    expect(CODE).toMatch(/read_only boolean not null default true check \(read_only is true\)/i);
  });

  it('exige l’unité de prix, sans valeur par défaut', () => {
    // Deviner l'unité produit un facteur 100 d'écart, silencieusement.
    expect(CODE).toMatch(/price_unit text not null check \(price_unit in \('major', 'minor'\)\)/i);
    expect(CODE).not.toMatch(/price_unit text not null default/i);
  });
});

describe('migration — isolation et droits', () => {
  it('active RLS et n’autorise que la lecture au propriétaire', () => {
    expect(CODE).toMatch(/alter table saas_business\.custom_api_connections enable row level security/i);
    expect(CODE).toMatch(/create policy custom_api_connections_owner_read[\s\S]*?for select to authenticated[\s\S]*?user_id = \(select auth\.uid\(\)\)/i);
  });

  it('n’accorde aucune policy d’écriture', () => {
    // Toute écriture passe par les RPC, qui vérifient l'appartenance,
    // l'abonnement et la preuve de sonde.
    expect(CODE).not.toMatch(/for (insert|update|delete|all) to authenticated/i);
    expect(CODE).toMatch(/revoke all on saas_business\.custom_api_connections from anon, authenticated/i);
  });

  it('retire les RPC du rôle public et anon', () => {
    expect(CODE).toMatch(/revoke all on function saas_business\.bg_save_custom_api_connection[\s\S]*?from public, anon/i);
    expect(CODE).toMatch(/revoke all on function saas_business\.bg_read_custom_api_connection[\s\S]*?from public, anon/i);
  });
});

describe('migration — enregistrement conditionné à une preuve', () => {
  it('exige une sonde 2xx et au moins un produit', () => {
    expect(CODE).toMatch(/connect_invalid:PROBE_REQUIRED/);
    expect(CODE).toMatch(/connect_invalid:NO_PRODUCTS_FOUND/);
    expect(CODE).toMatch(/p_probe_status < 200 or p_probe_status >= 300/i);
    expect(CODE).toMatch(/p_products_found < 1/i);
  });

  it('exige un mapping nommé', () => {
    expect(CODE).toMatch(/connect_invalid:MAPPING_NAME_REQUIRED/);
  });

  it('délègue l’écriture d’état à la RPC commune', () => {
    /*
     * Point central : la validation du connecteur, l'appartenance à
     * l'entreprise, l'abonnement payant et le journal de vérification sont
     * appliqués par `bg_connect_integration`. Les réimplémenter ici créerait
     * deux vérités, dont une finirait par diverger.
     */
    expect(CODE).toMatch(/saas_business\.bg_connect_integration\(/);
    expect(CODE).toMatch(/array\['catalog'\]/);
  });

  it('ne réimplémente ni l’abonnement ni le verrou d’entreprise', () => {
    // Ces règles appartiennent à `bg_connect_integration`, déjà testée.
    expect(CODE).not.toMatch(/bg_import_access/);
    expect(CODE).not.toMatch(/bg_lock_workspace_access/);
  });
});

describe('migration — lecture sans secret', () => {
  it('ne rend jamais le nom du secret Vault', () => {
    const lecture = CODE.slice(CODE.indexOf('bg_read_custom_api_connection'));
    expect(lecture).not.toMatch(/'credential_ref'/);
    expect(lecture).not.toMatch(/credential_ref,/);
  });

  it('rend l’état et la configuration affichable', () => {
    for (const champ of ['baseUrl', 'authScheme', 'productsPath', 'paginationKind', 'priceUnit', 'readOnly', 'connected']) {
      expect(CODE, champ).toContain(`'${champ}'`);
    }
  });
});

describe('migration — contrôles finaux', () => {
  it('vérifie l’absence de policy d’écriture dans un bloc de contrôle', () => {
    expect(CODE).toMatch(/une policy d''écriture existe sur custom_api_connections/i);
  });

  it('déclare le fournisseur en lecture seule', () => {
    expect(CODE).toMatch(/values \('custom-api', 'api-key', array\['read'\], true\)/i);
  });
});
