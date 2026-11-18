/**
 * Import & Connect — enveloppe d'accès.
 *
 * ## Ce que ce composant fait
 * Il montre le module à un abonné, et une présentation commerciale expliquant
 * le verrou à un non-abonné. Dans le second cas, le contenu du module n'est
 * **jamais monté** : `children` n'est pas rendu. Il n'y a donc pas de bouton
 * caché, pas de formulaire inactif, pas d'appel réseau déclenché par un écran
 * qui ne devrait pas exister.
 *
 * ## Ce qu'il ne fait pas
 * Il ne protège pas l'API. Une personne qui connaît la route peut appeler
 * l'Edge Function directement : c'est là-bas que la décision est réellement
 * appliquée (`store-import` revérifie l'abonnement avant toute action). Ce
 * composant est un affichage fidèle, pas une frontière de sécurité.
 */
import { useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge, Banner, Button, Card, CardHeader } from '../../components/ui';
import { accessGuidance, SUBSCRIPTION_PATH, type ImportAccessState } from './access';
import { useImportAccess } from './useImportAccess';

export interface ImportConnectGateProps {
  /** Le module réservé aux abonnés. */
  children: ReactNode;
  /** Session établie ? Sert à éviter un appel inutile. */
  authenticated?: boolean;
  /** Rend le module même sans abonnement — réservé aux tests et aux admins. */
  bypass?: boolean;
  /**
   * État déjà chargé par l'appelant. Évite une seconde requête quand l'écran
   * parent affiche déjà l'état de l'abonnement. Doit venir du serveur : ce
   * paramètre n'existe pas pour injecter un état fabriqué côté navigateur.
   */
  access?: ImportAccessState | null;
  loading?: boolean;
  onRetry?: () => void;
}

function Loading() {
  return (
    <div className="flex items-center gap-2 p-5 text-xs text-slate-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Vérification de votre abonnement Business Ground…
    </div>
  );
}

/** Présentation commerciale : ce que le module apporte, et ce qu'il faut pour l'ouvrir. */
function LockedView({ access, onRetry }: { access: ImportAccessState; onRetry: () => void }) {
  const guide = accessGuidance(access);
  return (
    <Card>
      <CardHeader
        title="Import & Connect"
        description="Importer et connecter vos boutiques en ligne : URL, CSV, XLSX, XML, flux produits et API officielles."
        action={<Badge status="inactif">Verrouillé</Badge>}
      />
      <div className="space-y-4 p-5">
        <Banner tone={guide.tone === 'info' ? 'info' : guide.tone === 'danger' ? 'danger' : 'warning'}
          title={guide.title}>
          {guide.detail}
        </Banner>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Réservé aux abonnés Business Ground
          </p>
          <ul className="mt-2 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
            {[
              'Détection automatique de la plateforme (WooCommerce, PrestaShop, Shopify, OpenCart, Magento…)',
              'Import par URL, sitemap, flux XML/RSS, CSV, XLSX ou XML',
              'Aperçu avant validation : quantités détectées, importées, ignorées, erreurs',
              'Boutiques connectées, historique des imports et état des synchronisations',
            ].map((ligne) => (
              <li key={ligne} className="flex gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden />
                <span>{ligne}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {guide.showSubscribe && (
            <Link to={SUBSCRIPTION_PATH} className="btn btn-primary btn-sm">
              Voir les offres Business Ground <ArrowRight size={13} />
            </Link>
          )}
          {/* Toujours proposé : après un renouvellement confirmé côté serveur,
              l'utilisateur n'a pas à recharger la page pour retrouver l'accès. */}
          <Button variant="secondary" size="sm" onClick={onRetry}>Revérifier</Button>
          <span className="text-[10px] text-slate-500">
            Aucune importation ni connexion n’a été lancée.
          </span>
        </div>

        {access.unknown && (
          <p className="text-[10px] leading-relaxed text-slate-500">
            Si vous venez de souscrire, le paiement doit être confirmé par le serveur avant
            l’ouverture de l’accès. Rouvrez cette page après confirmation.
          </p>
        )}
      </div>
    </Card>
  );
}

export function ImportConnectGate({
  children, authenticated = true, bypass = false,
  access: accessFourni, loading: loadingFourni, onRetry,
}: ImportConnectGateProps) {
  const interne = useImportAccess(authenticated && !bypass && accessFourni === undefined);
  const access = accessFourni !== undefined ? accessFourni : interne.access;
  const loading = loadingFourni ?? interne.loading;

  const reessayer = useCallback(() => {
    if (onRetry) { onRetry(); return; }
    void interne.refresh();
  }, [onRetry, interne]);

  if (bypass) return <>{children}</>;
  if (loading || access === undefined) return <Card><Loading /></Card>;
  if (!access) return <Card><Loading /></Card>;
  if (!access.allowed) return <LockedView access={access} onRetry={reessayer} />;
  return <>{children}</>;
}

/**
 * Bandeau d'état compact, pour rappeler l'état de l'abonnement en haut du
 * module ouvert. N'affiche rien d'anonyme.
 */
export function ImportAccessBanner({ access }: { access: ImportAccessState | null }) {
  if (!access) return null;
  const guide = accessGuidance(access);
  if (access.allowed) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" aria-hidden />
        <span>{guide.detail}</span>
      </div>
    );
  }
  if (access.unknown) {
    return (
      <Banner tone="warning" title={guide.title}>{guide.detail}</Banner>
    );
  }
  return (
    <Banner tone="danger" title={guide.title}>
      {guide.detail}{' '}
      <Link to={SUBSCRIPTION_PATH} className="underline">Voir les offres</Link>
    </Banner>
  );
}

/** Icône de verrou, exposée pour les entrées de navigation. */
export const ImportConnectLockIcon = Lock;
export const ImportConnectAlertIcon = ShieldAlert;
export const ImportConnectRefreshHint = Loader2;
