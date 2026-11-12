import type { LucideIcon } from 'lucide-react';
import {
  Aperture, AudioLines, Bot, Clapperboard, Film, Image as ImageIcon, Layers3,
  Mic2, PersonStanding, Scissors, Sparkles, WandSparkles, Workflow,
} from 'lucide-react';

export type SectionStatus = 'live' | 'prepared';

export interface StudioSection {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
  status: SectionStatus;
  route: string;
  /** Roadmap group: displayed as a clearly-labelled "préparé" space. */
  group: 'creation' | 'library' | 'roadmap';
}

/**
 * `live` means a real, working route backed by the existing backend.
 * `prepared` means the navigation/architecture exists but generation is NOT
 * implemented; the UI must never present it as operational.
 */
export const STUDIO_SECTIONS: StudioSection[] = [
  {
    id: 'video', label: 'Video Studio', shortLabel: 'Vidéo', icon: Clapperboard, status: 'live',
    route: '/app/studio', group: 'creation',
    description: 'Création vidéo, modèles compatibles, crédits et suivi en temps réel.',
  },
  {
    id: 'generations', label: 'My Generations', shortLabel: 'Générations', icon: Sparkles, status: 'live',
    route: '/app/historique', group: 'library',
    description: 'Toutes les tâches de génération, leur statut et les crédits utilisés.',
  },
  {
    id: 'projects', label: 'My Projects', shortLabel: 'Projets', icon: Layers3, status: 'live',
    route: '/app/projets', group: 'library',
    description: 'Vos projets existants et leurs scripts, scènes et vidéos.',
  },
  {
    id: 'saved', label: 'Mes créations enregistrées', shortLabel: 'Enregistrées', icon: Film, status: 'live',
    route: '/app/bibliotheque', group: 'library',
    description: 'Fichiers conservés dans Supabase Storage privé, lecture et téléchargement.',
  },
  {
    id: 'image', label: 'Image Studio', shortLabel: 'Image', icon: ImageIcon, status: 'prepared',
    route: '/app/studio/espace/image', group: 'creation',
    description: 'Espace réservé à la génération d’images. Aucun modèle d’image n’est intégré : aucune génération ne peut être lancée ici pour le moment.',
  },
  {
    id: 'avatar', label: 'Avatar Studio', shortLabel: 'Avatar', icon: PersonStanding, status: 'prepared',
    route: '/app/studio/espace/avatar', group: 'creation',
    description: 'Espace réservé aux avatars parlants. La création avec audio n’est pas encore disponible.',
  },
  {
    id: 'video-to-video', label: 'Video to Video', shortLabel: 'V→V', icon: Film, status: 'live',
    route: '/app/studio?mode=video-source', group: 'creation',
    description: 'Transformation d’une vidéo source par un modèle vidéo → vidéo du catalogue, avec import de la vidéo, devis serveur et suivi du rendu.',
  },
  {
    id: 'image-generation', label: 'Image Generation', shortLabel: 'Images IA', icon: WandSparkles, status: 'prepared',
    route: '/app/studio/espace/image-generation', group: 'roadmap', description: 'Architecture modulaire préparée, service IA non encore disponible.',
  },
  {
    id: 'audio', label: 'Audio Studio', shortLabel: 'Audio', icon: AudioLines, status: 'prepared',
    route: '/app/studio/espace/audio', group: 'roadmap', description: 'Architecture modulaire préparée, service IA non encore disponible.',
  },
  {
    id: 'clipping', label: 'AI Clipping', shortLabel: 'Clipping', icon: Scissors, status: 'prepared',
    route: '/app/studio/espace/clipping', group: 'roadmap', description: 'Découpe intelligente : non développée.',
  },
  {
    id: 'lip-sync', label: 'Lip Sync', shortLabel: 'Lip Sync', icon: Mic2, status: 'live',
    route: '/app/studio?mode=audio-source', group: 'creation',
    description: 'Synchronisation d’un visage sur une piste audio : import de l’image et de l’audio, devis serveur et suivi du rendu.',
  },
  {
    id: 'vibe-motion', label: 'Vibe Motion', shortLabel: 'Motion', icon: Aperture, status: 'prepared',
    route: '/app/studio/espace/vibe-motion', group: 'roadmap', description: 'Mouvements stylisés : non développés.',
  },
  {
    id: 'body-swap', label: 'Body Swap', shortLabel: 'Body Swap', icon: PersonStanding, status: 'prepared',
    route: '/app/studio/espace/body-swap', group: 'roadmap', description: 'Échange de corps : non développé.',
  },
  {
    id: 'cinema', label: 'Cinema Studio', shortLabel: 'Cinéma', icon: Clapperboard, status: 'prepared',
    route: '/app/studio/espace/cinema', group: 'roadmap', description: 'Direction cinématographique : non développée.',
  },
  {
    id: 'marketing', label: 'Marketing Studio', shortLabel: 'Marketing', icon: Sparkles, status: 'prepared',
    route: '/app/studio/espace/marketing', group: 'roadmap', description: 'Déclinaisons marketing : non développées.',
  },
  {
    id: 'workflows', label: 'Workflows', shortLabel: 'Workflows', icon: Workflow, status: 'prepared',
    route: '/app/studio/espace/workflows', group: 'roadmap', description: 'Automatisations : non développées.',
  },
  {
    id: 'agents', label: 'Agents', shortLabel: 'Agents', icon: Bot, status: 'prepared',
    route: '/app/studio/espace/agents', group: 'roadmap', description: 'Agents créatifs : non développés.',
  },
  {
    id: 'storyboarding', label: 'Storyboarding', shortLabel: 'Storyboard', icon: Layers3, status: 'prepared',
    route: '/app/studio/espace/storyboarding', group: 'roadmap', description: 'Plans et storyboards : non développés.',
  },
];

export const NAV_SECTIONS = STUDIO_SECTIONS.filter((s) => s.group !== 'roadmap');
export const ROADMAP_SECTIONS = STUDIO_SECTIONS.filter((s) => s.group === 'roadmap');
