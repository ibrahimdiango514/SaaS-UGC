/** Server-side generation states, displayed in a stable, understandable order. */

export type TrackingTone = 'idle' | 'active' | 'success' | 'error' | 'cancelled';

export interface TrackStep {
  id: string;
  label: string;
  hint: string;
}

export const TRACK_STEPS: TrackStep[] = [
  { id: 'draft', label: 'Brouillon', hint: 'Composez votre prompt et choisissez un modèle.' },
  { id: 'queued', label: 'En attente', hint: 'Crédits réservés, tâche enregistrée.' },
  { id: 'submitting', label: 'Lancement', hint: 'Votre création est transmise au service vidéo.' },
  { id: 'processing', label: 'En cours de génération', hint: 'Le service vidéo produit votre création. Le suivi continue côté serveur.' },
  { id: 'finalizing', label: 'Traitement du résultat', hint: 'Téléchargement et stockage sécurisé dans VYORA.' },
  { id: 'succeeded', label: 'Terminé', hint: 'Votre vidéo est disponible dans la bibliothèque.' },
];

export interface TrackingState {
  stepIndex: number;
  progress: number;
  label: string;
  description: string;
  tone: TrackingTone;
  serverSide: boolean;
}

/**
 * Maps the job status coming from `reelora-video { action: "status" }` and the
 * MuAPI provider state (re-verified by the worker) to a UI step.
 * No state is invented: every value below corresponds to a real job status.
 */
export function trackingState(status: string, providerState: string | null | undefined): TrackingState {
  const provider = (providerState ?? '').toLowerCase();

  if (!status) return {
    stepIndex: 0, progress: 0, label: 'Prêt à créer', tone: 'idle', serverSide: false,
    description: 'Décrivez votre vidéo, choisissez un modèle puis confirmez le lancement.',
  };

  if (status === 'succeeded') return {
    stepIndex: 5, progress: 100, label: 'Terminé', tone: 'success', serverSide: true,
    description: 'La vidéo est prête et conservée dans votre espace de stockage privé.',
  };

  if (status === 'failed') return {
    stepIndex: 4, progress: 88, label: 'Échec de la génération', tone: 'error', serverSide: true,
    description: 'Le service vidéo a signalé un échec ou la tâche a expiré. Les crédits réservés ont été restitués.',
  };

  if (status === 'cancelled') return {
    stepIndex: 1, progress: 12, label: 'Annulé', tone: 'cancelled', serverSide: true,
    description: 'Génération annulée. Les crédits réservés ont été restitués.',
  };

  if (status === 'queued' || status === 'reserved') return {
    stepIndex: status === 'reserved' ? 2 : 1,
    progress: status === 'reserved' ? 24 : 12,
    label: status === 'reserved' ? 'Lancement' : 'En attente',
    tone: 'active', serverSide: true,
    description: 'La réservation de crédits est enregistrée. La création est lancée par le serveur.',
  };

  if (provider === 'completed') return {
    stepIndex: 4, progress: 88, label: 'Traitement du résultat', tone: 'active', serverSide: true,
    description: 'La vidéo est prête ; le service la conserve dans votre espace privé.',
  };

  if (provider === 'queued' || provider === 'pending') return {
    stepIndex: 2, progress: 32, label: 'Lancement', tone: 'active', serverSide: true,
    description: 'Votre création est acceptée et en attente de traitement.',
  };

  return {
    stepIndex: 3, progress: 62, label: 'En cours de génération', tone: 'active', serverSide: true,
    description: 'Votre vidéo est en cours de création. Vous pouvez fermer cette page : le suivi continue automatiquement.',
  };
}

export function stepStatus(index: number, state: TrackingState): 'done' | 'active' | 'pending' | 'failed' {
  if (state.tone === 'error' && index === state.stepIndex) return 'failed';
  if (index < state.stepIndex) return 'done';
  if (index === state.stepIndex && state.tone !== 'idle') return 'active';
  return 'pending';
}
