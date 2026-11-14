import { RefreshCw } from 'lucide-react';
import type { AdminProviderBalance, AdminProviderSpendSummary } from '../../lib/types';
import { formatDate } from '../../lib/format';
import { Badge, Banner, Button, Card, CardHeader } from '../../components/ui';

/**
 * Fiche « Fournisseurs IA et soldes ».
 *
 * Quatre montants coexistent et ne doivent JAMAIS être confondus :
 *   1. solde MuAPI réel      (argent disponible chez le fournisseur)
 *   2. plafond VYORA         (limite que l'administration s'autorise)
 *   3. dépensé VYORA         (dépense fournisseur déjà confirmée)
 *   4. restant VYORA         (plafond - engagé)
 *
 * Le solde fournisseur n'est jamais simulé : s'il n'a pas pu être lu, la fiche
 * affiche « Non vérifié » avec la raison, jamais « 0 $ ».
 */

const usd = (amount: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 4,
}).format(amount);

const providerLabel = (provider: string) => (provider === 'muapi' ? 'MuAPI' : provider);

interface ProviderBalanceCardProps {
  balance: AdminProviderBalance | null;
  summary: AdminProviderSpendSummary | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}

function Money({
  label, value, hint, tone = 'neutral',
}: { label: string; value: string; hint?: string; tone?: 'neutral' | 'good' | 'warn' }) {
  const color = tone === 'good' ? 'text-emerald-200' : tone === 'warn' ? 'text-amber-200' : 'text-white';
  return (
    <div className="rounded-xl border border-line bg-white/[0.03] p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</p>}
    </div>
  );
}

export default function ProviderBalanceCard({ balance, summary, loading, error, onRefresh }: ProviderBalanceCardProps) {
  const verified = balance?.status === 'ok' && typeof balance?.balance_usd === 'number';
  const providerRemaining = summary?.remaining_usd ?? null;
  const cap = summary?.max_usd ?? null;
  const spent = summary?.actual_spent_usd ?? null;
  const committed = summary?.committed_usd ?? null;

  // Indicateur d'insuffisance : uniquement calculé sur des valeurs vérifiées.
  const lastQuote = summary?.by_provider?.find((entry) => entry.provider === 'muapi');
  const needsTopUp = verified && typeof lastQuote?.reserved_usd === 'number'
    && lastQuote.reserved_usd > 0 && (balance?.balance_usd ?? 0) < lastQuote.reserved_usd;

  return (
    <Card>
      <CardHeader
        title="Fournisseurs IA et soldes"
        description="Le solde fournisseur est lu côté serveur avec la clé MuAPI. Il est distinct du plafond VYORA et des crédits clients."
        action={(
          <Button variant="secondary" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Synchronisation…' : 'Actualiser le solde'}
          </Button>
        )}
      />
      {error && <div className="px-5 pb-3"><Banner tone="warning" title="Solde fournisseur indisponible">{error}</Banner></div>}

      <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
        <span className="text-sm font-semibold text-white">{providerLabel(balance?.provider ?? 'muapi')}</span>
        {balance?.status === 'ok' && <Badge tone="success">Connecté</Badge>}
        {balance?.status === 'error' && <Badge tone="warning">Erreur de lecture</Badge>}
        {(!balance || balance.status === 'unknown') && <Badge tone="neutral">Non synchronisé</Badge>}
        {balance?.account_email && <span className="text-xs text-slate-500">Compte {balance.account_email}</span>}
      </div>

      <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-4">
        <Money
          label="1 · Solde MuAPI réel"
          value={verified ? usd(balance?.balance_usd ?? 0) : 'Non vérifié'}
          hint={verified
            ? `${balance?.currency ?? 'USD'} · synchronisé le ${balance?.synced_at ? formatDate(balance.synced_at, true) : '—'}`
            : (balance?.error_message ?? 'Aucune lecture réussie du solde fournisseur.')}
          tone={verified ? ((balance?.balance_usd ?? 0) > 0 ? 'good' : 'warn') : 'warn'}
        />
        <Money
          label="2 · Plafond VYORA"
          value={cap === null ? '—' : usd(cap)}
          hint={`Seuil d'alerte ${summary?.alert_percent ?? 0} % · ${summary?.enabled ? 'tests payants autorisés' : 'tests payants désactivés'}`}
        />
        <Money
          label="3 · Dépensé VYORA"
          value={spent === null ? '—' : usd(spent)}
          hint={committed === null ? undefined : `dont ${usd(committed)} engagés (réservations et estimations)`}
        />
        <Money
          label="4 · Restant VYORA"
          value={providerRemaining === null ? '—' : usd(providerRemaining)}
          hint="Plafond moins engagements. Ne jamais lire ce montant comme le solde MuAPI."
          tone={providerRemaining === 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="space-y-3 px-5 pb-5">
        {!verified && (
          <Banner tone="warning" title="Solde fournisseur non vérifié">
            Aucun montant n'est affiché à la place du solde réel. Tant que la lecture échoue,
            VYORA bloque les appels payants : aucun débit ne peut être lancé sans solde vérifié.
          </Banner>
        )}
        {verified && (balance?.balance_usd ?? 0) <= 0 && (
          <Banner tone="warning" title="Solde MuAPI épuisé">
            Le compte MuAPI ne dispose plus de crédit. Les nouvelles générations payantes sont refusées
            côté serveur avant tout appel fournisseur. Le rechargement se fait uniquement depuis le
            portail officiel MuAPI : VYORA n'expose aucun bouton de recharge fictif.
          </Banner>
        )}
        {needsTopUp && (
          <Banner tone="warning" title="Solde insuffisant pour la prochaine génération">
            Le solde vérifié est inférieur au coût déjà réservé. La prochaine génération sera refusée
            jusqu'au rechargement du compte fournisseur.
          </Banner>
        )}
        {summary?.alert_state && summary.alert_state !== 'ok' && (
          <Banner tone="warning" title="Plafond VYORA sous surveillance">
            État des alertes : {summary.alert_state}. Le plafond reste appliqué côté serveur avant chaque appel payant.
          </Banner>
        )}
        <p className="text-[11px] leading-relaxed text-slate-500">
          La clé MuAPI reste strictement côté serveur et n'est jamais transmise au navigateur.
          La synchronisation est manuelle ici et automatique avant chaque génération payante.
          {summary?.tests_count ? ` ${summary.tests_count} test(s) enregistré(s), ${summary.blocked_count} tentative(s) bloquée(s).` : ''}
        </p>
      </div>
    </Card>
  );
}
