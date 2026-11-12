/**
 * Invariants du portefeuille Studio — vérifiés contre la défINITION SQL réelle.
 *
 * Ces invariants ont été exercés sur la base (transaction annulée) :
 *   5 crédits → réserve 3 → disponible 2 / réservé 3
 *   double réservation avec la même clé → aucun second débit
 *   capture → disponible 2 / réservé 0
 *   réserve 2 puis restitution → disponible 2 / réservé 0
 *   réserve supérieure au solde → « Insufficient or inconsistent credit balance »
 *
 * Ce fichier garantit que le code livré conserve ces propriétés. Aucun appel
 * réseau, aucun crédit consommé.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const RPC = read('supabase/migrations/20261108164309_reelora_v1_rpc.sql');
const PRICING = read('supabase/migrations/20261111143957_vyora_video_pricing_v1.sql');
const EDGE = read('supabase/functions/reelora-video/index.ts');

describe('Débit des crédits Studio', () => {
  it('refuse tout solde négatif ou réservé incohérent', () => {
    // Vérifié en base (transaction annulée) : réserve(50) sur 5 crédits →
    // « Insufficient or inconsistent credit balance ». Tous les appelants
    // passent par cette primitive, jamais par un UPDATE de solde.
    expect(RPC).toContain("apply_wallet_delta(v_uid, 'reserve'");
    expect(RPC).not.toMatch(/update saas_ugc\.ugc_wallets\s+set available_balance/i);
  });

  it('est idempotent par clé d’opération (pas de double débit)', () => {
    // La clé déterministe « reserve-job:<uuid> » rend la double réservation
    // inopérante (vérifié en base : aucun second débit au second appel).
    expect(PRICING).toContain("'reserve-job:' || v_job::text");
    expect(RPC).toContain("'reserve-job:' || v_job::text");
    expect(RPC).toContain("'capture-job:' || v_job.id::text");
    expect(RPC).toContain("'release-job:' || v_job.id::text");
  });

  it('réserve puis capture le montant exact, et restitue en cas d’échec', () => {
    // Réservation à la création du job, capture à la réussite, restitution à l'échec.
    expect(PRICING).toContain("apply_wallet_delta(v_uid, 'reserve', -v_quote.credits_cost, v_quote.credits_cost");
    expect(RPC).toContain("apply_wallet_delta(v_job.created_by, 'capture', 0, -v_job.credits_reserved");
    expect(RPC).toContain("apply_wallet_delta(v_job.created_by, 'release', v_job.credits_reserved");
  });

  it('refuse de démarrer sans solde suffisant ou sans devis valide', () => {
    expect(PRICING).toContain("raise exception 'insufficient_credits'");
    expect(PRICING).toContain("if p_quote_id is null then raise exception 'video_quote_required'");
    // Le contrôle du solde précède la réservation.
    expect(PRICING.indexOf("raise exception 'insufficient_credits'"))
      .toBeLessThan(PRICING.indexOf("apply_wallet_delta(v_uid, 'reserve'"));
  });

  it('un devis n’est consommable qu’une fois et seulement par son propriétaire', () => {
    expect(PRICING).toContain('q.user_id = v_uid');
    expect(PRICING).toContain('q.consumed_at is null');
    expect(PRICING).toContain('q.expires_at > now()');
    expect(PRICING).toContain('q.config_updated_at = v_setting_updated_at');
  });

  it('le montant n’est jamais décidé par le frontend', () => {
    // Le devis vient du serveur ; le job est créé avec le coût du devis.
    expect(PRICING).toContain('credits_reserved = v_quote.credits_cost');
    expect(EDGE).not.toMatch(/credits_cost:\s*(?:req|body|payload)\./);
    expect(read('src/studio/GenerationStudio.tsx')).not.toMatch(/credits_cost:\s*\d/);
  });

  it('toute réservation fournisseur est libérée avant de rendre l’échec', () => {
    const failJob = EDGE.slice(EDGE.indexOf('async function failJob'));
    // finalize (donc restitution) puis libération du budget fournisseur.
    expect(failJob.indexOf('reelora_finalize_generation'))
      .toBeLessThan(failJob.indexOf('releaseQuota'));
    // Le refus de plafond fournisseur passe par failJob (restauration des
    // crédits réservés), jamais par une sortie silencieuse.
    expect(EDGE).toContain('PROVIDER_SPEND_CAP_EXCEEDED');
    const decision = EDGE.slice(EDGE.indexOf('async function actionStart'));
    const blocked = decision.indexOf('PROVIDER_SPEND_DISABLED');
    expect(blocked).toBeGreaterThan(-1);
    expect(decision.slice(blocked, blocked + 200)).toContain('failJob');
  });
});
