import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Building2, Sparkles } from 'lucide-react';
import { BusinessAssistant } from '../ai/BusinessAssistant';
import { useAuth } from '../context/AuthContext';
import '../ai/assistant.css';

/**
 * Assistant Business Grow — page dédiée, plein écran.
 *
 * ## Pourquoi une page et pas un onglet
 *
 * L'assistant existait déjà et fonctionnait, mais il vivait dans un onglet de la
 * page Business Grow : trois cartes d'indicateurs, un bandeau de quota et un
 * panneau de fournisseurs au-dessus de la conversation. Sur un écran partagé ou
 * un téléphone, il ne restait qu'une bande étroite pour la conversation — et
 * c'est précisément la zone où l'utilisateur travaille.
 *
 * Cette page ne réimplémente rien : elle monte le **même** composant
 * `BusinessAssistant`, avec le même état d'assistant (`useAssistant`) et les
 * mêmes appels serveur. Seule la mise en page change : la conversation occupe
 * l'écran, l'historique se replie dans une barre latérale.
 *
 * ## Ce qui reste inchangé, volontairement
 *
 * - aucune donnée n'est dupliquée : les conversations viennent du socle
 *   `business-grow`, exactement comme dans l'onglet précédent ;
 * - les actions sensibles passent toujours par l'approbation humaine ;
 * - le repli de la barre latérale est mémorisé d'une session à l'autre.
 *
 * ## Choix d'affichage
 *
 * La hauteur est `100dvh` moins la barre supérieure de la coquille. `dvh` (et
 * non `vh`) est indispensable sur Android : la barre d'adresse du navigateur se
 * replie au défilement, et `vh` compte une hauteur qui n'existe pas toujours —
 * d'où une zone de saisie coupée en bas de l'écran.
 *
 * La barre fait `h-16` (4rem) à TOUTES les tailles dans `Layout` : soustraire
 * 4,5rem en `lg` comme le faisait la première version laissait une bande morte
 * de 0,5rem en bas de la zone de saisie.
 */
export default function BusinessAssistantPage() {
  const { workspace, workspaceId } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [bandeau, setBandeau] = useState(true);

  // Un contexte transmis par un rapport d'agent pré-remplit le composeur.
  const draft = params.get('draft');

  const retour = useCallback(() => {
    navigate('/app/business');
  }, [navigate]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-w-0 flex-col overflow-hidden">
      {/*
        Barre de contexte compacte, et rien de plus.

        Elle ne montre QUE ce qui aide à écrire : l'entreprise active (parce que
        toutes les réponses en dépendent) et un retour vers la vue d'ensemble.
        Les indicateurs métier ont leur place dans Business Grow — les afficher
        ici reviendrait à reconstruire la page surchargée qu'on vient de quitter.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/[0.07] px-3 py-2 sm:px-5">
        <button
          type="button"
          onClick={retour}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
          aria-label="Revenir à la vue d’ensemble Business Grow"
        >
          <ArrowLeft size={14} />
          <span className="hidden sm:inline">Business Grow</span>
        </button>
        <span className="hidden h-4 w-px bg-white/10 sm:block" />
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Building2 size={13} className="shrink-0 text-cyan-300" />
          <span className="truncate font-medium text-slate-200">
            {workspace?.name || 'Aucune entreprise active'}
          </span>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-violet-300/25 bg-violet-400/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200">
          <Sparkles size={10} /> Assistant
        </span>
      </div>

      {!workspaceId && bandeau && (
        /*
          Sans entreprise, l'assistant n'a pas de périmètre : les conversations
          sont liées à un espace de travail. On l'explique au lieu de laisser un
          écran vide ou, pire, de laisser croire à une panne.
        */
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-100 sm:px-5"
        >
          <span className="min-w-0 flex-1">
            Aucune entreprise active. Créez ou sélectionnez une entreprise pour que
            l’assistant dispose d’un contexte métier.
          </span>
          <button
            type="button"
            onClick={() => navigate('/app/business')}
            className="rounded-lg border border-amber-300/30 px-2 py-1 text-[11px] font-medium transition hover:bg-amber-300/10"
          >
            Choisir une entreprise
          </button>
          <button
            type="button"
            onClick={() => setBandeau(false)}
            className="text-[11px] text-amber-200/80 underline"
          >
            Masquer
          </button>
        </div>
      )}

      {/*
        Le composant occupe tout l'espace restant. `min-h-0` est nécessaire :
        sans lui, un enfant flex refuse de rétrécir et la zone de saisie sort de
        l'écran dès que la conversation s'allonge — le défaut exact qu'on corrige.
      */}
      <div className="min-h-0 flex-1">
        <BusinessAssistant workspaceId={workspaceId} draftFromReport={draft} />
      </div>
    </div>
  );
}
