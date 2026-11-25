/**
 * SORAHNEX — « Connexions MCP », la page qui réunit les deux sens du protocole.
 *
 * ## Deux sections, deux sens opposés
 *
 *   A. **Connecter SORAHNEX à mes IA** — SORAHNEX est le SERVEUR MCP. L'utilisateur
 *      donne son URL à ChatGPT, Claude Code ou un autre client, et reçoit un
 *      jeton qu'il colle chez ce client. L'utilisateur est le client, SORAHNEX la
 *      ressource.
 *   B. **Connecter mes applications à SORAHNEX** — SORAHNEX est le CLIENT MCP. Il
 *      appelle un CRM, une boutique, un outil marketing. L'utilisateur autorise
 *      SORAHNEX à agir, outil par outil.
 *
 * Mélanger les deux dans un seul flux est la source d'erreur la plus fréquente :
 * on ne sait plus qui détient le jeton. La séparation est donc visuelle ET
 * structurelle (deux composants distincts, jamais fusionnés).
 *
 * ## Aucun partage d'état entre les sections
 *
 * Chaque section charge ses propres données et n'affiche que les connexions de
 * l'utilisateur connecté : l'isolation vient du serveur (le `userId` est résolu
 * depuis le jeton GoTrue, jamais depuis le corps), pas de cet écran.
 */
import { Bot, Boxes } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { McpConnectionsPage } from './McpConnectionsPage';
import { MesServeursMcpPage } from './MesServeursMcpPage';

function TitreSection({
  id,
  icone,
  eyebrow,
  titre,
  description,
}: {
  id: string;
  icone: React.ReactNode;
  eyebrow: string;
  titre: string;
  description: string;
}) {
  return (
    <div id={id} className="scroll-mt-24 border-t border-white/[0.08] pt-6 first:border-0 first:pt-0">
      <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
        {icone}
        {eyebrow}
      </p>
      <h2 className="mt-1.5 text-lg font-semibold text-white">{titre}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">{description}</p>
    </div>
  );
}

export function ConnexionsMcpPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="SORAHNEX · MCP"
        title="Connexions MCP"
        description="Deux directions, deux réglages distincts : ce que vos IA peuvent faire dans SORAHNEX, et ce que SORAHNEX peut faire dans vos applications."
      />

      {/* --------------------------- A. Entrant --------------------------- */}
      <section aria-labelledby="section-ia" className="space-y-4">
        <TitreSection
          id="section-ia"
          icone={<Bot className="h-3.5 w-3.5" />}
          eyebrow="Section A · SORAHNEX est le serveur"
          titre="Connecter SORAHNEX à mes IA"
          description="Vos assistants (ChatGPT, Claude Code, autres clients MCP) accèdent à vos données SORAHNEX avec un jeton que vous créez et révoquez ici. Chaque jeton ne voit que vos données, et son usage est journalisé."
        />
        <McpConnectionsPage sansEnTete />
      </section>

      {/* --------------------------- B. Sortant --------------------------- */}
      <section aria-labelledby="section-applications" className="space-y-4">
        <TitreSection
          id="section-applications"
          icone={<Boxes className="h-3.5 w-3.5" />}
          eyebrow="Section B · SORAHNEX est le client"
          titre="Connecter mes applications à SORAHNEX"
          description="Vos CRM, boutiques et outils marketing exposent leurs outils en MCP ; SORAHNEX les découvre et n'exécute que ceux que vous autorisez, un par un. Les écritures restent désactivées."
        />
        <MesServeursMcpPage sansEnTete />
      </section>
    </div>
  );
}

export default ConnexionsMcpPage;
