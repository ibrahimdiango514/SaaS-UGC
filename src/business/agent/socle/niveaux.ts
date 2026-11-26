/**
 * Niveaux d'autonomie de l'agent Business Grow.
 *
 * Le principe est FERMÉ par défaut : « je prépare, tu valides ». Rien ne
 * s'exécute tout seul tant que l'utilisateur n'a pas explicitement monté le
 * niveau d'une action, et les actions qui touchent l'argent, un client ou un
 * envoi ne peuvent JAMAIS passer en automatique sur un simple réglage global :
 * elles exigent une règle écrite, nommée et activée.
 *
 * Ce fichier est volontairement pur (aucun accès réseau, aucune base) : la
 * décision d'autoriser une action est testable sans infrastructure.
 */

export type NiveauAutonomie = 'lecture' | 'preparation' | 'automatique';

/** Ce qu'une action peut toucher. Sert uniquement à décider qui doit valider. */
export type SensibiliteAction = 'argent' | 'client' | 'envoi' | 'interne';

export const NIVEAUX: readonly { value: NiveauAutonomie; label: string; description: string }[] = [
  { value: 'lecture', label: 'Lecture seule', description: 'L’agent lit et analyse, ne prépare aucune écriture.' },
  { value: 'preparation', label: 'Je prépare, tu valides', description: 'L’agent prépare l’action ; rien n’est écrit sans votre accord.' },
  { value: 'automatique', label: 'Automatique sur règle', description: 'L’agent exécute seul, uniquement dans le cadre d’une règle que vous avez écrite et activée.' },
];

/**
 * Sensibilités qui ne peuvent pas devenir automatiques par un simple réglage :
 * il faut en plus une règle active et nommée (`regleId`).
 */
export const SENSIBILITES_PROTEGEES: readonly SensibiliteAction[] = ['argent', 'client', 'envoi'];

export interface ReglageAutonomie {
  /** Niveau choisi pour cette action par l'utilisateur. */
  niveau: NiveauAutonomie;
  /** Règle écrite qui autorise l'automatique (obligatoire pour les sensibilités protégées). */
  regleId?: string | null;
}

export interface DecisionAutonomie {
  /** L'action a-t-elle le droit de s'exécuter sans validation humaine ? */
  executionSansValidation: boolean;
  /** Faut-il recueillir une validation avant d'écrire quoi que ce soit ? */
  validationRequise: boolean;
  /** Explication lisible, affichée dans l'interface : jamais un code opaque. */
  raison: string;
  niveauEffectif: NiveauAutonomie;
}

/** Niveau appliqué quand rien n'a été configuré : le plus prudent qui agit. */
export const NIVEAU_PAR_DEFAUT: NiveauAutonomie = 'preparation';

/**
 * Calcule la décision pour une action donnée.
 *
 * - `lecture`      : jamais d'écriture, donc jamais de validation d'écriture.
 * - `preparation`  : l'action est préparée puis validée (défaut).
 * - `automatique`  : n'est accordé que si la sensibilité n'est pas protégée, ou
 *                    si une règle écrite est fournie.
 */
export function deciderAutonomie(
  sensibilite: SensibiliteAction,
  reglage: ReglageAutonomie | null | undefined,
): DecisionAutonomie {
  const demande = reglage?.niveau ?? NIVEAU_PAR_DEFAUT;

  if (demande === 'lecture') {
    return {
      executionSansValidation: false,
      validationRequise: false,
      niveauEffectif: 'lecture',
      raison: 'Niveau « lecture seule » : l’agent n’écrit rien, il n’y a donc rien à valider.',
    };
  }

  if (demande === 'preparation') {
    return {
      executionSansValidation: false,
      validationRequise: true,
      niveauEffectif: 'preparation',
      raison: 'Niveau par défaut : l’action est préparée et attend votre validation.',
    };
  }

  // Niveau « automatique » demandé : on vérifie ce que l'action peut toucher.
  const protegee = SENSIBILITES_PROTEGEES.includes(sensibilite);
  const regle = typeof reglage?.regleId === 'string' && reglage.regleId.trim().length > 0;

  if (protegee && !regle) {
    return {
      executionSansValidation: false,
      validationRequise: true,
      niveauEffectif: 'preparation',
      raison:
        'Cette action touche ' + libelleSensibilite(sensibilite) +
        ' : elle reste soumise à votre validation tant qu’aucune règle écrite ne l’autorise.',
    };
  }

  return {
    executionSansValidation: true,
    validationRequise: false,
    niveauEffectif: 'automatique',
    raison: regle
      ? 'Automatique autorisé par la règle « ' + reglage!.regleId + ' ».'
      : 'Automatique autorisé : cette action ne touche ni l’argent, ni un client, ni un envoi.',
  };
}

export function libelleSensibilite(sensibilite: SensibiliteAction): string {
  switch (sensibilite) {
    case 'argent': return 'l’argent';
    case 'client': return 'un client';
    case 'envoi': return 'un envoi';
    default: return 'des données internes';
  }
}

/** Un niveau est-il connu ? Sert à valider ce qui vient d'un enregistrement. */
export function normaliserNiveau(valeur: unknown): NiveauAutonomie {
  return valeur === 'lecture' || valeur === 'automatique' ? valeur : NIVEAU_PAR_DEFAUT;
}
