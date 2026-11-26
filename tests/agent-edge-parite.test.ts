import { describe, expect, it } from 'vitest';
import {
  NOMS_OUTILS_AGENT,
  OUTILS_A_SENSIBILITE_PROTEGEE,
  STATUTS_JOURNAL,
} from '../supabase/functions/business-grow/handler.ts';
import { OUTILS } from '../src/business/agent/socle/outils';
import { SENSIBILITES_PROTEGEES } from '../src/business/agent/socle/niveaux';

/**
 * Parité entre le socle applicatif et l'Edge Function.
 *
 * ## Le problème que ce test empêche
 * L'Edge ne peut pas importer `src/business/agent/socle/*` : son bundle est
 * construit depuis `supabase/functions`, et le chargeur épinglé exécute un
 * artefact figé. Les noms d'outils et les sensibilités protégées sont donc
 * écrits DEUX fois : dans le socle (utilisé par les écrans) et dans le handler
 * (utilisé pour refuser une écriture).
 *
 * Si les deux listes divergent, la conséquence est asymétrique et silencieuse :
 * un outil ajouté au socle serait refusé par le serveur (panne visible), mais un
 * outil retiré du socle resterait ACCEPTÉ par le serveur — donc une écriture
 * autorisée sur une action que l'interface ne sait plus préparer. C'est ce sens
 * silencieux que ce test rend impossible.
 */
describe('parité Edge ↔ socle de l’agent', () => {
  it('connaît exactement les mêmes outils que le socle', () => {
    const socle = OUTILS.map((outil) => outil.nom).sort();
    expect([...NOMS_OUTILS_AGENT].sort()).toEqual(socle);
  });

  it('protège exactement les mêmes sensibilités que le socle', () => {
    // Les outils sensibles du serveur doivent correspondre, outil par outil, à
    // ceux que le socle marque comme protégés. Un écart rendrait une action
    // « automatique » là où l'interface exige une règle.
    const attendus = OUTILS
      .filter((outil) => SENSIBILITES_PROTEGEES.includes(outil.sensibilite))
      .map((outil) => outil.nom)
      .sort();
    expect([...OUTILS_A_SENSIBILITE_PROTEGEE].sort()).toEqual(attendus);
  });

  it('n’autorise aucun outil inconnu dans le journal', () => {
    // Une entrée de journal qui nomme un outil inexistant rendrait l'historique
    // illisible et le bouton Annuler inopérant.
    for (const nom of STATUTS_JOURNAL) {
      expect(['proposee', 'validee', 'refusee', 'executee', 'echouee', 'annulee']).toContain(nom);
    }
    expect(STATUTS_JOURNAL).toHaveLength(6);
  });
});
