import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fous sur `mcp_account_info` (abonnement, plan, crédits).
 *
 * ## Pourquoi ce test existe
 *
 * L'outil `vyora_account_info` renvoyait `credits: null, plan: null` : un client
 * MCP n'apprenait rien, et un modèle qui reçoit `null` a deux réactions, toutes
 * deux fausses — inventer un chiffre, ou déclarer le compte vide.
 *
 * En corrigeant, trois erreurs ont été commises puis rattrapées en interrogeant
 * la production. Chacune a coûté une migration ; ce test les empêche de revenir :
 *
 *   1. lire `saas_business.subscriptions` (table d'un AUTRE produit, vide) ;
 *   2. ignorer le statut `cancelled` (orthographe réelle en base) ;
 *   3. lire `saas_business.wallets` au lieu de `saas_ugc.ugc_wallets`
 *      (un utilisateur avait 5 crédits réels et 37 dans l'autre table).
 *
 * ## Ce que le test ne prouve pas
 *
 * Il lit le SQL, pas la base. La preuve que les chiffres sont justes a été
 * faite en production : `mcp_account_info` comparée ligne à ligne à
 * `ugc_wallets.available_balance`, puis un appel `tools/call` réel sur le
 * serveur déployé (HTTP 200, plan « Découverte », crédits réels).
 */

const FINALE = readFileSync(
  'supabase/migrations/20261121093000_mcp_account_info_wallet_fix.sql',
  'utf8',
);

const TOUTES = [
  'supabase/migrations/20261121091000_mcp_account_info_real.sql',
  'supabase/migrations/20261121092000_mcp_account_info_ugc_sources.sql',
  'supabase/migrations/20261121093000_mcp_account_info_wallet_fix.sql',
].map((chemin) => ({ chemin, sql: readFileSync(chemin, 'utf8') }));

/** Retire les commentaires : une source citée en commentaire n'est pas lue. */
function sansCommentaires(sql: string): string {
  return sql
    .split('\n')
    .map((ligne) => ligne.replace(/--.*$/, ''))
    .join('\n');
}

const CODE = sansCommentaires(FINALE);

describe('mcp_account_info — sources de données', () => {
  it('lit le portefeuille VYORA, pas celui de Business Grow', () => {
    expect(CODE).toMatch(/from\s+saas_ugc\.ugc_wallets\s+w/i);
    // La régression coûteuse : des chiffres cohérents mais appartenant à un
    // autre produit du même projet Supabase.
    expect(CODE).not.toMatch(/from\s+saas_business\.wallets/i);
  });

  it('lit les abonnements et les plans UGC', () => {
    expect(CODE).toMatch(/from\s+saas_ugc\.ugc_subscriptions\s+s/i);
    expect(CODE).toMatch(/from\s+saas_ugc\.ugc_plans\s+p/i);
    expect(CODE).not.toMatch(/from\s+saas_business\.subscriptions/i);
  });

  it('accepte les deux orthographes de « résilié »', () => {
    // `cancelled` est la valeur réelle ; `canceled` est gardée par prudence.
    expect(CODE).toContain("'cancelled'");
    expect(CODE).toContain("'canceled'");
  });

  it('expose la source dans la réponse pour la traçabilité', () => {
    expect(CODE).toContain("'source', 'saas_ugc.ugc_wallets'");
  });

  it('ne renvoie plus jamais des crédits et un plan figés à null', () => {
    // La forme exacte de la régression d'origine.
    expect(CODE).not.toMatch(/'credits',\s*null,\s*'plan',\s*null/);
  });

  it('garde la même signature et le même type de retour', () => {
    // `create or replace` avec une signature qui change ⇒ erreur 42P13.
    for (const { chemin, sql } of TOUTES) {
      const code = sansCommentaires(sql);
      expect(code, chemin).toMatch(/create or replace function public\.mcp_account_info\(p_user_id uuid\)/i);
      expect(code, chemin).toMatch(/returns jsonb/i);
    }
  });
});

describe('mcp_account_info — droits', () => {
  it('refuse un identifiant utilisateur absent', () => {
    expect(CODE).toMatch(/if p_user_id is null then/i);
    expect(CODE).toContain('user_required');
  });

  it('est réservée au serveur (service_role)', () => {
    // Accorder la fonction à `authenticated` permettrait de sonder le compte
    // d'un autre utilisateur en devinant un UUID.
    expect(CODE).toMatch(/revoke all on function public\.mcp_account_info\(uuid\) from public, anon, authenticated/i);
    expect(CODE).toMatch(/grant execute on function public\.mcp_account_info\(uuid\) to service_role/i);
  });

  it('n’expose aucun identifiant de facturation externe', () => {
    for (const fuite of ['external_customer_id', 'external_subscription_id', 'billing_provider']) {
      expect(CODE).not.toContain(fuite);
    }
  });

  it('calcule « actif » au lieu de recopier le statut', () => {
    // Un statut `active` dont la période est échue n'ouvre aucun droit.
    expect(CODE).toMatch(/v_sub\.status in \('active', 'trialing'\)/i);
    expect(CODE).toMatch(/v_sub\.current_period_end > now\(\)/i);
  });
});

describe('description de l’outil', () => {
  const CORE = readFileSync('supabase/functions/vyora-mcp/core.ts', 'utf8');

  it('annonce les champs réellement renvoyés', () => {
    expect(CORE).toContain('abonnement');
    expect(CORE).toContain('crédits VYORA');
    // « null signifie aucune ligne » : la distinction qui empêche un modèle
    // de raconter que le compte est vide.
    expect(CORE).toContain('aucune ligne');
  });
});
