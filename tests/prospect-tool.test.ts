/**
 * L'agent peut-il vraiment enregistrer un prospect ?
 *
 * Ces tests couvrent la chaîne complète : proposition extraite de la réponse du
 * modèle, arguments normalisés, puis contrat SQL. Le point sensible est le
 * mensonge corrigé — avant ce correctif, aucun outil n'écrivait un
 * `growth_prospect` ; le modèle répondait « c'est noté » et la donnée n'existait
 * nulle part. Ces tests échouent si cet outil disparaît de la chaîne.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractToolProposals,
  normalizeToolProposalArguments,
} from '../supabase/functions/business-grow/intelligence';

describe('propose_prospect_save — extraction depuis la réponse du modèle', () => {
  it('reconnaît l’outil et le classe en écriture soumise à approbation', () => {
    const reponse = `J’ai préparé la fiche de Moussa Diarra.

<!--REELORA_TOOL_PROPOSALS:[{"toolName":"propose_prospect_save","summary":"Enregistrer Moussa Diarra","arguments":{"name":"Moussa Diarra","company":"Niger BTP","stage":"contacte","value":2400000,"currency":"xof"}}]-->`;

    const { cleanText, proposals } = extractToolProposals(reponse);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].toolName).toBe('propose_prospect_save');
    /*
     * Le niveau de risque n'est pas cosmétique : l'interface s'en sert pour
     * exiger un clic d'approbation. `read_only` ferait exécuter l'écriture sans
     * confirmation — d'où cette assertion explicite.
     */
    expect(proposals[0].riskLevel).toBe('write_requires_approval');
    /* Le bloc caché ne doit jamais apparaître dans le texte affiché. */
    expect(cleanText).not.toContain('REELORA_TOOL_PROPOSALS');
    expect(cleanText).toContain('Moussa Diarra');
  });

  it('normalise la devise en majuscules et la valeur en nombre', () => {
    const args = normalizeToolProposalArguments('propose_prospect_save', {
      name: 'Awa Traoré',
      company: 'Sahel Distribution',
      value: '1250000',
      currency: 'xof',
    }, 'Enregistrer Awa');

    expect(args.name).toBe('Awa Traoré');
    expect(args.value).toBe(1250000);
    expect(args.currency).toBe('XOF');
  });

  it('accepte les clés françaises envoyées par le modèle', () => {
    const args = normalizeToolProposalArguments('propose_prospect_save', {
      nom: 'Fatoumata Keïta',
      entreprise: 'Bamako Tech',
      telephone: '+223 90 00 00 00',
      etape: 'contacte',
      montant: 500000,
      devise: 'eur',
      prochaineAction: 'Rappeler mardi',
      echeance: '2026-12-01',
      note: 'Rencontrée au salon.',
    }, 'Enregistrer Fatoumata');

    expect(args).toMatchObject({
      name: 'Fatoumata Keïta',
      company: 'Bamako Tech',
      phone: '+223 90 00 00 00',
      stage: 'contacte',
      value: 500000,
      currency: 'EUR',
      nextAction: 'Rappeler mardi',
      nextActionAt: '2026-12-01',
      notes: 'Rencontrée au salon.',
    });
  });

  it('ramène une étape inconnue ou accentuée à une valeur du pipeline', () => {
    /*
     * Une étape hors liste ferait disparaître le prospect du pipeline, qui
     * filtre par étape. On vérifie le repli, pas seulement l'absence d'erreur.
     */
    expect(normalizeToolProposalArguments('propose_prospect_save', { stage: 'négociation avancée' }).stage)
      .toBe('prospect');
    expect(normalizeToolProposalArguments('propose_prospect_save', { stage: 'Qualifié' }).stage)
      .toBe('qualifie');
    expect(normalizeToolProposalArguments('propose_prospect_save', { stage: 'contact' }).stage)
      .toBe('contacte');
    expect(normalizeToolProposalArguments('propose_prospect_save', { stage: 'perdu' }).stage)
      .toBe('perdu');
  });

  it('ignore une valeur non numérique sans perdre le prospect', () => {
    /* « environ 5000 » ne doit pas faire échouer l'enregistrement entier. */
    const args = normalizeToolProposalArguments('propose_prospect_save', {
      name: 'Prospect Sans Montant',
      value: 'environ 5000',
    });
    expect(args.name).toBe('Prospect Sans Montant');
    expect(args.value).toBeUndefined();
  });

  it('refuse une valeur négative', () => {
    const args = normalizeToolProposalArguments('propose_prospect_save', {
      name: 'Prospect Négatif',
      value: -500,
    });
    expect(args.value).toBeUndefined();
  });

  it('se rabat sur le résumé quand le nom manque', () => {
    /*
     * Sans nom, la base refuse l'écriture ('prospect name required'). Mieux vaut
     * remplir depuis le résumé de la proposition que de proposer une fiche vide
     * qui échouerait au moment de l'approbation.
     */
    const args = normalizeToolProposalArguments('propose_prospect_save', {}, 'Enregistrer le prospect Ibrahim');
    expect(args.name).toBe('Enregistrer le prospect Ibrahim');
  });

  it('n’ouvre pas la liste fermée aux outils inventés', () => {
    /* Un nom inconnu est ignoré à l'extraction, jamais transmis à la base. */
    const { proposals } = extractToolProposals(
      'Texte.<!--REELORA_TOOL_PROPOSALS:[{"toolName":"delete_all_prospects","summary":"x","arguments":{}}]-->',
    );
    expect(proposals).toHaveLength(0);
  });
});

describe('propose_prospect_save — contrat avec la fonction SQL', () => {
  /**
   * Ces vérifications sont textuelles : elles ne remplacent pas l'exécution
   * réelle (faite en base), mais elles empêchent une régression silencieuse du
   * fichier de migration — par exemple la suppression de la relecture de
   * persistance, qui est la garantie anti-mensonge.
   */
  const chemin = 'supabase/migrations/20261129100000_business_grow_prospect_tool.sql';
  const sql = readFileSync(chemin, 'utf8');

  it('la migration ouvre la liste fermée au seul outil ajouté', () => {
    expect(sql).toContain("'propose_prospect_save'");
    /* La liste reste explicite : un nom arbitraire doit être refusé. */
    expect(sql).toContain("IF p_tool_name NOT IN ('propose_memory_save'");
  });

  it('la relecture de persistance est présente', () => {
    /* C'est elle qui distingue « écrit » de « écrit et vérifié ». */
    expect(sql).toContain('prospect persistence check failed');
    expect(sql).toContain("i.category='growth_prospect'");
    expect(sql).toContain("'persisted',true");
  });

  it('un échec d’écriture marque l’exécution en failed, jamais en executed', () => {
    expect(sql).toContain('PROSPECT_SAVE_FAILED');
    expect(sql).toContain("SET status='failed'");
  });

  it('la source mémoire est normalisée pour ne pas faire échouer l’écriture', () => {
    /*
     * Régression réelle rencontrée : `bg_put_scoped_memory_item` n'accepte que
     * 'manual' et 'conversation'. Un défaut à 'agent' faisait échouer toute
     * approbation avec « invalid memory item ».
     */
    expect(sql).toContain("IF p_source NOT IN ('manual','conversation') THEN p_source:='manual'; END IF;");
  });

  it('le consentement de mémoire métier reste exigé', () => {
    /* Données personnelles de tiers : pas d'écriture sans consentement. */
    expect(sql).toContain('bg_require_scoped_consent');
  });
});
