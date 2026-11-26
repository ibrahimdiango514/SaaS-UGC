import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { Badge } from '../../components/ui';
import {
  aiEngineHealth,
  type AiEngineProviderHealth,
} from '../../lib/api';
import {
  diagnostiquerMoteur,
  etatDepuisSante,
  type DiagnosticMoteur,
  type FournisseurSante,
} from './diagnostic';

/**
 * Diagnostic lisible du moteur IA central.
 *
 * ## Le défaut que ce panneau corrige
 * L'écran Admin affichait « registre indisponible » ou un code brut. Or les
 * causes possibles n'ont rien à voir entre elles : clé absente (administrateur),
 * adresse absente (administrateur), adresse locale donc injoignable, délai
 * dépassé (hébergeur), clé refusée (fournisseur), aucun modèle validé. Chacune
 * demande une action DIFFÉRENTE. Afficher « indisponible » sans l'étape
 * bloquante laissait l'utilisateur sans piste.
 *
 * ## Ce que ce panneau garantit
 * - Il affiche l'étape EXACTE et l'action à faire, en une phrase.
 * - Il ne montre ni secret, ni URL complète : au plus la FORME de l'adresse.
 * - Il n'invente aucun statut : tant que la sonde n'a pas répondu, l'état reste
 *   « inconnu », jamais « opérationnel ».
 * - Le même composant sert l'administration et l'espace Agent : une seule
 *   vérité, aucune divergence entre deux écrans.
 */
export function MoteurIaDiagnostic({
  variante = 'admin',
  onRelancer,
}: {
  /** `admin` ajoute la fiche de mise en service ; `agent` reste compact. */
  variante?: 'admin' | 'agent';
  /** Relance de la sonde côté serveur (administration seulement). */
  onRelancer?: () => Promise<void>;
}) {
  const [fournisseur, setFournisseur] = useState<AiEngineProviderHealth | null>(null);
  const [registreLisible, setRegistreLisible] = useState<boolean | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState('');
  const [relance, setRelance] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur('');
    try {
      const sante = await aiEngineHealth();
      const entrees = Object.entries(sante?.providers ?? {});
      // Le fournisseur central est celui du registre ; s'il n'y en a qu'un,
      // c'est lui. Aucun nom n'est codé en dur : le registre décide.
      const central = entrees.find(([cle]) => cle === 'freellmapi') ?? entrees[0] ?? null;
      setFournisseur(central ? central[1] : null);
      setRegistreLisible(entrees.length > 0);
    } catch (e) {
      setRegistreLisible(false);
      setFournisseur(null);
      setErreur(e instanceof Error && e.message ? e.message : 'Sonde illisible.');
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => { void charger(); }, [charger]);

  const relancer = useCallback(async () => {
    if (!onRelancer) return;
    setRelance(true);
    try {
      await onRelancer();
      await charger();
    } catch (e) {
      setErreur(e instanceof Error && e.message ? e.message : 'Relance impossible.');
    } finally {
      setRelance(false);
    }
  }, [onRelancer, charger]);

  /*
   * `registreLisible === null` = la sonde n'a pas encore répondu. On n'en
   * déduit AUCUN diagnostic : afficher « registre indisponible » avant la
   * réponse serait un chiffre inventé.
   */
  const diagnostic: DiagnosticMoteur | null = registreLisible === null
    ? null
    : diagnostiquerMoteur(etatDepuisSante(fournisseur as FournisseurSante | null, registreLisible));

  const ton = diagnostic?.pret ? 'success' : diagnostic ? 'danger' : 'neutral';
  const Icone = diagnostic?.pret ? CheckCircle2 : diagnostic ? AlertTriangle : HelpCircle;

  return (
    <section
      className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
      data-testid="moteur-ia-diagnostic"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Moteur IA</p>
          <div className="mt-1.5 flex items-start gap-2">
            <Icone
              size={16}
              className={diagnostic?.pret ? 'mt-0.5 shrink-0 text-emerald-300' : 'mt-0.5 shrink-0 text-amber-300'}
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-white" data-testid="moteur-ia-message">
                {chargement && !diagnostic
                  ? 'Sonde en cours…'
                  : (diagnostic?.message ?? 'État inconnu : la sonde n’a pas répondu.')}
              </p>
              {diagnostic && !diagnostic.pret ? (
                <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400" data-testid="moteur-ia-action">
                  {diagnostic.action}
                </p>
              ) : null}
              {erreur ? (
                <p className="mt-1 text-[11px] text-rose-300">{erreur}</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={ton === 'neutral' ? 'neutral' : ton}>
            {diagnostic?.pret ? 'Opérationnel' : diagnostic ? 'Bloqué' : 'Inconnu'}
          </Badge>
          {onRelancer ? (
            <button
              type="button"
              onClick={() => void relancer()}
              disabled={relance || chargement}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-medium text-slate-200 disabled:opacity-50"
            >
              <RefreshCw size={13} className={relance ? 'animate-spin' : undefined} aria-hidden />
              Relancer la sonde
            </button>
          ) : null}
        </div>
      </div>

      {/* Détail d'observation : ce que la sonde a RÉELLEMENT vu. */}
      {fournisseur ? (
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-[11px] text-slate-400 sm:grid-cols-2" data-testid="moteur-ia-details">
          <div className="flex justify-between gap-2"><dt>Clé fournisseur</dt><dd className={fournisseur.configured ? 'text-emerald-300' : 'text-rose-300'}>{fournisseur.configured ? 'présente' : 'absente'}</dd></div>
          <div className="flex justify-between gap-2"><dt>Adresse de base</dt><dd className={fournisseur.base_url_configured ? 'text-emerald-300' : 'text-rose-300'}>{formeLisible(fournisseur.base_url_form)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Fournisseur activé</dt><dd className={fournisseur.enabled === false ? 'text-amber-300' : 'text-slate-200'}>{fournisseur.enabled === false ? 'non' : 'oui'}</dd></div>
          <div className="flex justify-between gap-2"><dt>Modèles au catalogue</dt><dd>{fournisseur.catalog_models ?? '—'}</dd></div>
          <div className="flex justify-between gap-2"><dt>Modèles validés</dt><dd>{fournisseur.verified_models ?? '—'}</dd></div>
          <div className="flex justify-between gap-2"><dt>Dernier code</dt><dd className="font-mono text-[10.5px]">{fournisseur.error_code ?? '—'}</dd></div>
        </dl>
      ) : null}

      {variante === 'admin' ? <FicheMiseEnService /> : null}
    </section>
  );
}

/** Forme de l'adresse en clair — jamais sa valeur, qui peut porter un jeton. */
function formeLisible(forme: AiEngineProviderHealth['base_url_form']): string {
  switch (forme) {
    case 'publique': return 'publique (HTTPS)';
    case 'locale': return 'locale — injoignable depuis le cloud';
    case 'privee': return 'privée — injoignable depuis le cloud';
    case 'illisible': return 'illisible';
    case 'absente': return 'absente';
    default: return 'inconnue';
  }
}

/**
 * Fiche de mise en service, en trois étapes.
 *
 * Elle ne promet aucun résultat : elle décrit l'ordre des opérations, dont
 * deux dépendent de l'administrateur et une du fournisseur. Aucune valeur de
 * secret n'est affichée, seulement les NOMS des variables à créer.
 */
function FicheMiseEnService() {
  const etapes = [
    {
      titre: 'Héberger FreeLLMAPI sur une adresse publique HTTPS',
      detail: 'Une adresse localhost ou privée n’est jamais joignable depuis le cloud : Edge Functions ne sortent pas sur votre réseau local.',
    },
    {
      titre: 'Renseigner les secrets Supabase',
      detail: 'FREE_LLM_API_KEY (la clé d’instance) et FREE_LLM_API_BASE_URL (l’adresse HTTPS, souvent terminée par /v1). Aucune valeur n’est affichée ici.',
    },
    {
      titre: 'Relancer la sonde, puis activer le fournisseur',
      detail: 'L’activation est proposée explicitement après une sonde réussie : elle n’est jamais automatique.',
    },
  ] as const;

  return (
    <div className="mt-4 rounded-lg border border-white/[0.07] bg-black/20 p-3" data-testid="moteur-ia-fiche">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
        <ShieldAlert size={13} className="text-violet-200" aria-hidden />
        Rendre FreeLLMAPI joignable
      </p>
      <ol className="mt-2 space-y-2">
        {etapes.map((etape, index) => (
          <li key={etape.titre} className="flex gap-2 text-[11px] leading-relaxed">
            <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-violet-400/15 text-[9px] font-semibold text-violet-200">
              {index + 1}
            </span>
            <span className="min-w-0 text-slate-400">
              <span className="font-medium text-slate-200">{etape.titre}</span>
              {' — '}
              {etape.detail}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
