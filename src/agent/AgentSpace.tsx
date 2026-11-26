import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Lock, Sparkles } from 'lucide-react';
import { Button, Card, CardHeader, LoadingState } from '../components/ui';
import {
  SUBSCRIPTION_PATH,
  accessGuidance,
  loadImportAccess,
  type ImportAccessState,
} from '../business/import-connect/access';
import { HistoriqueAgent } from '../business/agent/HistoriqueAgent';
import { BusinessAssistant } from '../ai/BusinessAssistant';
import { useAuth } from '../context/AuthContext';
import {
  AGENT_SPACE_CAPABILITIES,
  AGENT_SPACE_NAV,
  agentSectionFromPath,
} from './agentSpace';
import { AgentSpaceLayout, AgentSpaceTabs } from './AgentSpaceLayout';

/**
 * Espace Agent IA — route `/app/agent/*`.
 *
 * ## Règle d'accès, en un seul endroit
 * L'accès est celui de l'abonnement **SORAHNEX Grow**, déjà appliqué par
 * `public.vyora_import_connect_access()` : catalogue d'abonnements et quotas
 * serveur existants, aucun second système. Ce module ne réimplémente pas la
 * règle, il en lit le résultat.
 *
 * ## Ce que fait l'écran verrouillé
 * Il affiche ce que l'espace permet et mène aux formules. Il ne charge AUCUNE
 * donnée de l'agent : ni conversation, ni journal. Afficher un historique
 * au-dessus d'un accès refusé laisserait croire que l'accès est ouvert.
 *
 * ## Pourquoi le serveur reste seul juge
 * Une interface se contourne. Les Edge Functions `business-grow` vérifient les
 * droits à chaque appel ; le verrou ci-dessous est un affichage honnête, pas
 * une protection.
 */
export function AgentSpace() {
  const location = useLocation();
  const { workspaceId, workspace } = useAuth();
  const section = agentSectionFromPath(location.pathname);
  const [access, setAccess] = useState<ImportAccessState | null>(null);

  const chargerAcces = useCallback(async () => {
    setAccess(await loadImportAccess());
  }, []);

  useEffect(() => { void chargerAcces(); }, [chargerAcces]);

  const guidance = useMemo(() => (access ? accessGuidance(access) : null), [access]);
  const verrouille = access !== null && access.allowed !== true;
  const enVerification = access === null;

  // Nom réel de l'entreprise active : lu du contexte, jamais inventé.
  const nomEntreprise = workspace?.name?.trim() || null;

  return (
    <AgentSpaceLayout active={section} workspaceName={nomEntreprise} locked={verrouille}>
      {enVerification ? (
        <Card><LoadingState label="Vérification de votre abonnement SORAHNEX Grow…" /></Card>
      ) : verrouille ? (
        <AgentSpaceLocked guidance={guidance} />
      ) : (
        <>
          <AgentSpaceTabs active={section} />
          {section === 'conversation' ? <AgentSpaceConversation workspaceId={workspaceId} /> : null}
          {section === 'historique' ? <AgentSpaceHistorique workspaceId={workspaceId} /> : null}
          {section === 'capacites' ? <AgentSpaceCapabilities /> : null}
        </>
      )}
    </AgentSpaceLayout>
  );
}

/**
 * Écran verrouillé : ce que l'espace apporte, puis le chemin vers les formules.
 *
 * Le motif affiché est celui que le SERVEUR a renvoyé (`accessGuidance`) :
 * « abonnement expiré » et « paiement en échec » n'appellent pas la même action,
 * et les confondre en « accès refusé » serait plus simple mais faux.
 */
function AgentSpaceLocked({ guidance }: { guidance: ReturnType<typeof accessGuidance> | null }) {
  return (
    <div className="space-y-4" data-testid="agent-space-locked">
      <Card>
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-300/15 text-amber-200 ring-1 ring-amber-300/25">
            <Lock size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">
              {guidance?.title ?? 'Abonnement SORAHNEX Grow requis'}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
              {guidance?.detail ?? 'L’espace Agent IA est inclus dans l’abonnement SORAHNEX Grow.'}
            </p>
            {guidance?.showSubscribe ? (
              <Link to={SUBSCRIPTION_PATH} className="mt-3 inline-flex">
                <Button size="sm" icon={<ArrowRight size={14} />}>Voir les formules Grow</Button>
              </Link>
            ) : null}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Ce que l’espace Agent permet"
          description="Inclus dans l’abonnement SORAHNEX Grow. Aucune donnée n’est chargée tant que l’abonnement n’est pas actif."
        />
        <ul className="grid gap-2 sm:grid-cols-2">
          {AGENT_SPACE_CAPABILITIES.map((item) => (
            <li key={item.titre} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-white">
                <CheckCircle2 size={13} className="text-cyan-300" aria-hidden />
                {item.titre}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{item.detail}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Conversation : le chat existant, sans duplication de logique. */
function AgentSpaceConversation({ workspaceId }: { workspaceId: string | null }) {
  return (
    <div data-testid="agent-space-conversation">
      <BusinessAssistant workspaceId={workspaceId} />
    </div>
  );
}

/** Historique de l'agent : le composant existant, celui de Grow. */
function AgentSpaceHistorique({ workspaceId }: { workspaceId: string | null }) {
  return (
    <div data-testid="agent-space-historique">
      <HistoriqueAgent workspaceId={workspaceId} />
    </div>
  );
}

/** Capacités déclarées : ce que l'agent peut faire, et sous quelles conditions. */
function AgentSpaceCapabilities() {
  const sections = AGENT_SPACE_NAV;
  return (
    <div className="space-y-4" data-testid="agent-space-capacites">
      <Card>
        <CardHeader
          title="Autonomie : « je prépare, tu valides » par défaut"
          description="Le mode automatique n’existe que sur une règle nommée par vous. Argent, client et envoi restent soumis à votre validation."
        />
        <ul className="space-y-2">
          {AGENT_SPACE_CAPABILITIES.map((item) => (
            <li key={item.titre} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-white">
                <Sparkles size={13} className="text-cyan-300" aria-hidden />
                {item.titre}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{item.detail}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Navigation de l’espace" description="Chaque entrée mène à un écran réel." />
        <ul className="space-y-1.5">
          {sections.map((item) => (
            <li key={item.key} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-3 py-2">
              <span className="text-[12px] text-slate-200">{item.label}</span>
              <Link to={item.path} className="text-[11px] text-cyan-300 underline">Ouvrir</Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
