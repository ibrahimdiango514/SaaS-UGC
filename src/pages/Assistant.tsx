import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, BarChart3, Megaphone, Menu, PenLine, Search, Sparkles, X,
} from 'lucide-react';
import { useAssistant } from '../ai/useAssistant';
import { Sidebar } from '../ai/Sidebar';
import { MessageList } from '../ai/MessageList';
import { Composer } from '../ai/Composer';
import type { AiMode } from '../ai/api';
import { useAuth } from '../context/AuthContext';
import { cn } from '../components/ui';
import '../ai/assistant.css';

const CLE_REPLI = 'vyora.ai.sidebar.collapsed';

/**
 * Espace assistant VYORA.
 *
 * ## Ce qui fonctionne réellement
 *
 * - conversations persistées, retrouvées par utilisateur (socle `business-grow`)
 * - historique chargé depuis le serveur, jamais reconstruit côté client
 * - envoi vers `vyora-ai` (`action: complete`), réponse enregistrée puis relue
 * - recherche locale sur le titre et le dernier message
 * - pièces jointes lues localement (texte, CSV, JSON, Markdown…)
 * - écoute d'une réponse via la voix du navigateur
 *
 * ## Ce qui n'est pas simulé
 *
 * - pas de streaming réseau : `vyora-ai` répond en une fois. L'indicateur de
 *   frappe reflète l'attente réelle, il ne fait pas défiler une réponse déjà
 *   reçue.
 * - pas de dictée vocale : l'API est absente de nombreux navigateurs et la
 *   permission micro est fermée dans `netlify.toml`.
 * - pas de réponse inventée : si le fournisseur IA est indisponible, l'écran
 *   le dit et le message reste enregistré.
 */
export default function Assistant() {
  const { user } = useAuth();
  const assistant = useAssistant();
  const [mode, setMode] = useState<AiMode>('standard');
  const [repliee, setRepliee] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CLE_REPLI) === '1';
    } catch {
      return false;
    }
  });
  const [tiroirMobile, setTiroirMobile] = useState(false);

  const basculer = useCallback(() => {
    setRepliee((prev) => {
      const suivant = !prev;
      try {
        localStorage.setItem(CLE_REPLI, suivant ? '1' : '0');
      } catch {
        /* préférence d'affichage : stockage indisponible, on continue */
      }
      return suivant;
    });
  }, []);

  // Sur mobile, la barre latérale est un tiroir : on la ferme en arrivant.
  useEffect(() => {
    const fermer = () => setTiroirMobile(false);
    window.addEventListener('popstate', fermer);
    return () => window.removeEventListener('popstate', fermer);
  }, []);

  const filActif = assistant.activeId
    ? assistant.conversations.find((c) => c.id === assistant.activeId)
    : null;

  return (
    // Cette page vit HORS du <Layout> Studio : sa coquille est la sidebar
    // VYORA AI, pas la navigation Studio. La hauteur est donc celle de la
    // fenêtre, et non celle d'un contenu inséré dans le Layout.
    <div className="flex h-[100dvh] overflow-hidden bg-ink">
      {/* Rail desktop / tiroir mobile */}
      <div className={cn('hidden lg:flex', tiroirMobile && '!flex')}>
        <Sidebar
          collapsed={repliee}
          onToggle={basculer}
          groups={assistant.groups}
          activeId={assistant.activeId}
          query={assistant.query}
          onQuery={assistant.setQuery}
          onSelect={assistant.select}
          onNew={assistant.startNew}
          onDelete={(id) => void assistant.remove(id)}
          loading={assistant.loadingList}
          {...(tiroirMobile ? { onCloseMobile: () => setTiroirMobile(false) } : {})}
        />
      </div>

      {tiroirMobile && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setTiroirMobile(false)}
          aria-label="Fermer la navigation"
        />
      )}

      {/* Zone centrale */}
      <main className="vy-ambient relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* En-tête */}
        <header className="flex items-center gap-2 border-b border-line px-3 py-2.5 sm:px-5">
          <button
            type="button"
            onClick={() => setTiroirMobile(true)}
            className="btn btn-ghost btn-sm h-9 w-9 p-0 lg:hidden"
            aria-label="Ouvrir la navigation"
          >
            <Menu size={18} />
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-sm font-semibold text-white">
              {filActif?.title || 'Nouvelle conversation'}
            </h1>
            <p className="truncate text-[0.68rem] text-slate-500">
              {user?.email ? `Connecté · ${user.email}` : 'Assistant VYORA'}
            </p>
          </div>

          {assistant.error && (
            <button
              type="button"
              onClick={assistant.clearError}
              className="flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[0.68rem] text-amber-200"
              title={assistant.error}
            >
              <AlertTriangle size={12} className="shrink-0" />
              <span className="truncate">{assistant.error}</span>
              <X size={11} className="shrink-0" />
            </button>
          )}
        </header>

        {/* Fil ou accueil */}
        <div className="vy-scroll min-h-0 flex-1 overflow-y-auto">
          {assistant.messages.length === 0 && !assistant.loadingThread && !assistant.activeId ? (
            <Accueil
              nom={user?.email?.split('@')[0] ?? ''}
              onChoisir={(texte) => void assistant.send(texte, mode, [])}
            />
          ) : (
            <MessageList
              messages={assistant.messages}
              loading={assistant.loadingThread}
              sending={assistant.sending}
            />
          )}
        </div>

        <Composer
          onSend={assistant.send}
          sending={assistant.sending}
          mode={mode}
          onModeChange={setMode}
        />
      </main>
    </div>
  );
}

/** Écran d'accueil personnalisé, affiché quand aucune conversation n'est ouverte. */
function Accueil({ nom, onChoisir }: { nom: string; onChoisir: (texte: string) => void }) {
  const suggestions = [
    {
      icon: <Megaphone size={16} />,
      titre: 'Préparer une campagne',
      texte: 'Propose-moi trois angles de campagne pour un produit lifestyle, avec un titre et une accroche par angle.',
    },
    {
      icon: <BarChart3 size={16} />,
      titre: 'Analyser des chiffres',
      texte: 'Explique-moi comment interpréter une baisse de 12 % du panier moyen sur un mois, et quelles hypothèses vérifier en priorité.',
    },
    {
      icon: <PenLine size={16} />,
      titre: 'Rédiger un texte',
      texte: 'Écris une description produit de 120 mots pour une boutique en ligne, ton professionnel et concret.',
    },
    {
      icon: <Search size={16} />,
      titre: 'Cadrer un problème',
      texte: 'Aide-moi à structurer un plan d’action en trois étapes pour améliorer la fidélisation client.',
    },
  ];

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-4 py-10 sm:px-6">
      <div className="vy-enter">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-brand-400/25 bg-brand-500/10 px-3 py-1 text-[0.7rem] text-brand-200">
          <Sparkles size={13} />
          Assistant VYORA
        </div>

        <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
          {nom ? `Bonjour ${nom}.` : 'Bonjour.'}
          <span className="block bg-gradient-to-r from-brand-300 via-brand-200 to-accent bg-clip-text text-transparent">
            Que souhaitez-vous accomplir ?
          </span>
        </h2>

        <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-400">
          Décrivez votre besoin en langage naturel. Vos conversations sont
          enregistrées et rattachées à votre compte.
        </p>

        <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
          {suggestions.map((s) => (
            <button key={s.titre} type="button" onClick={() => onChoisir(s.texte)} className="vy-suggestion">
              <span className="mt-0.5 text-brand-300">{s.icon}</span>
              <span className="min-w-0">
                <span className="block font-medium text-slate-200">{s.titre}</span>
                <span className="mt-0.5 block text-xs leading-snug text-slate-500">{s.texte}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
