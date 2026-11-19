import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, HelpCircle, Loader2, XCircle } from 'lucide-react';
import { Card } from '../components/ui';
import { SUPABASE_URL } from '../lib/supabase';

/**
 * Page PUBLIQUE de suivi d'une demande de suppression de données Meta.
 *
 * ## Pourquoi cette page existe
 * Le rappel `data-deletion` de Meta doit renvoyer une URL où la personne peut
 * consulter l'état de sa demande, accompagnée d'un code de confirmation. Sans
 * cela, le rappel peut être désactivé et l'application suspendue.
 *
 * `/confidentialite` explique la procédure mais ne connaît aucune demande
 * précise : elle ne pouvait donc pas servir de page de suivi. Cette page-ci
 * interroge la route publique `deletion-status` avec le code de l'URL.
 *
 * ## Ce qu'elle montre, et ce qu'elle ne montre jamais
 * Elle affiche un **état** et des **dates**. L'Edge Function ne renvoie rien
 * d'autre : ni identifiant Meta, ni nom de client, ni jeton. Le code lui-même
 * n'est jamais réaffiché en clair dans le corps de page — il est déjà dans l'URL,
 * et le recopier ne ferait qu'élargir sa trace.
 *
 * ## Aucune authentification
 * C'est une exigence de Meta, pas un oubli. La confidentialité repose sur le
 * code : 40 caractères aléatoires, non énumérables.
 */

type Etat = {
  status: 'pending' | 'completed' | 'no_data';
  requestedAt: string | null;
  completedAt: string | null;
  hasFailure: boolean;
};

type Chargement =
  | { etat: 'vide' }
  | { etat: 'chargement' }
  | { etat: 'trouve'; donnees: Etat }
  | { etat: 'introuvable' }
  | { etat: 'code_invalide' }
  | { etat: 'erreur'; message: string };

function dateLisible(valeur: string | null): string {
  if (!valeur) return '—';
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(date);
}

export default function DeletionStatusPage() {
  const [parametres] = useSearchParams();
  const code = (parametres.get('code') ?? '').trim();
  const [resultat, setResultat] = useState<Chargement>({ etat: 'vide' });

  const charger = useCallback(async () => {
    if (!code) {
      setResultat({ etat: 'vide' });
      return;
    }
    setResultat({ etat: 'chargement' });
    try {
      const url = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/meta-lifecycle/deletion-status?code=${encodeURIComponent(code)}`;
      const reponse = await fetch(url, { headers: { accept: 'application/json' } });
      if (reponse.status === 404) {
        setResultat({ etat: 'introuvable' });
        return;
      }
      if (reponse.status === 400) {
        setResultat({ etat: 'code_invalide' });
        return;
      }
      if (!reponse.ok) {
        setResultat({ etat: 'erreur', message: `Le service a répondu ${reponse.status}.` });
        return;
      }
      const donnees = (await reponse.json()) as Etat;
      if (!donnees || typeof donnees.status !== 'string') {
        setResultat({ etat: 'erreur', message: 'Réponse inattendue du service.' });
        return;
      }
      setResultat({ etat: 'trouve', donnees });
    } catch {
      // Panne réseau : ne jamais laisser croire que la demande n'existe pas.
      setResultat({ etat: 'erreur', message: 'Impossible de joindre le service. Réessayez dans un instant.' });
    }
  }, [code]);

  useEffect(() => { void charger(); }, [charger]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="font-bold tracking-[0.12em] text-white">VYORA</span>
          </Link>
          <Link to="/confidentialite" className="text-xs text-slate-400 hover:text-white">Politique de confidentialité</Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-3xl font-bold text-white">Suivi d’une demande de suppression</h1>
        <p className="mt-2 text-sm text-slate-500">
          Cette page indique où en est la demande de suppression de données que vous avez adressée à Meta.
        </p>

        <Card className="mt-8 p-7">
          {resultat.etat === 'vide' && (
            <div className="flex items-start gap-3">
              <HelpCircle size={20} className="mt-0.5 shrink-0 text-slate-400" />
              <div>
                <p className="text-sm font-semibold text-white">Aucun code fourni</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  Ouvrez le lien que Meta vous a communiqué : il contient votre code de confirmation.
                  Si vous ne l’avez plus, adressez une nouvelle demande depuis <span className="text-slate-200">Facebook → Paramètres → Applications et sites web</span>,
                  puis utilisez le lien fourni à ce moment-là.
                </p>
              </div>
            </div>
          )}

          {resultat.etat === 'chargement' && (
            <div className="flex items-center gap-3 text-sm text-slate-400" role="status">
              <Loader2 size={18} className="animate-spin" />
              Vérification de votre demande…
            </div>
          )}

          {resultat.etat === 'code_invalide' && (
            <div className="flex items-start gap-3">
              <XCircle size={20} className="mt-0.5 shrink-0 text-amber-400" />
              <div>
                <p className="text-sm font-semibold text-white">Code invalide</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  Le lien utilisé est incomplet ou mal formé. Recopiez le code tel qu’il figure dans la réponse de Meta,
                  ou rouvrez le lien d’origine.
                </p>
              </div>
            </div>
          )}

          {resultat.etat === 'introuvable' && (
            <div className="flex items-start gap-3">
              <HelpCircle size={20} className="mt-0.5 shrink-0 text-slate-400" />
              <div>
                <p className="text-sm font-semibold text-white">Aucune demande ne correspond à ce code</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  Vérifiez que le code a été recopié en entier. S’il est exact et que cette page reste vide,
                  votre demande n’a pas encore été reçue par VYORA : comptez quelques minutes après l’envoi depuis Facebook.
                </p>
              </div>
            </div>
          )}

          {resultat.etat === 'erreur' && (
            <div className="flex items-start gap-3">
              <XCircle size={20} className="mt-0.5 shrink-0 text-red-400" />
              <div>
                <p className="text-sm font-semibold text-white">Vérification impossible</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">{resultat.message}</p>
                <button onClick={() => void charger()} className="mt-3 text-sm font-medium text-brand-400 hover:text-brand-300">
                  Réessayer
                </button>
              </div>
            </div>
          )}

          {resultat.etat === 'trouve' && <EtatAffiche donnees={resultat.donnees} />}
        </Card>

        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          Cette page ne contient aucune donnée de compte : elle affiche uniquement l’état d’avancement associé au code.
          Pour toute question, écrivez au support VYORA depuis l’adresse e-mail de votre compte.
        </p>
      </main>
    </div>
  );
}

function EtatAffiche({ donnees }: { donnees: Etat }) {
  if (donnees.status === 'completed') {
    return (
      <div className="flex items-start gap-3">
        <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-400" />
        <div>
          <p className="text-sm font-semibold text-white">Demande traitée</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            Les données détenues par VYORA pour ce compte Meta ont été supprimées : connexions, jetons d’accès,
            sélections de Pages et de numéros, messages et événements reçus. L’autorisation accordée à VYORA
            n’existe plus côté VYORA.
          </p>
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-slate-500">Reçue le</dt><dd className="text-slate-300">{dateLisible(donnees.requestedAt)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-slate-500">Traitée le</dt><dd className="text-slate-300">{dateLisible(donnees.completedAt)}</dd></div>
          </dl>
          {donnees.hasFailure && (
            <p className="mt-3 text-xs text-amber-400">
              Une tentative antérieure n’a pas abouti ; la présente demande, elle, est bien terminée.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (donnees.status === 'no_data') {
    return (
      <div className="flex items-start gap-3">
        <Clock size={20} className="mt-0.5 shrink-0 text-slate-400" />
        <div>
          <p className="text-sm font-semibold text-white">Aucune donnée à supprimer</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            VYORA ne détenait aucune donnée d’intégration Meta pour ce compte au moment de la demande.
            Aucune donnée n’a donc été conservée, et rien ne reste à supprimer de notre côté.
          </p>
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-slate-500">Reçue le</dt><dd className="text-slate-300">{dateLisible(donnees.requestedAt)}</dd></div>
          </dl>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <Clock size={20} className="mt-0.5 shrink-0 text-amber-400" />
      <div>
        <p className="text-sm font-semibold text-white">Demande en attente de traitement</p>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          Votre demande a été reçue et sera traitée sous peu. Revenez sur cette page dans quelques minutes
          pour vérifier qu’elle est bien terminée.
        </p>
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Reçue le</dt><dd className="text-slate-300">{dateLisible(donnees.requestedAt)}</dd></div>
        </dl>
        <button onClick={() => window.location.reload()} className="mt-3 text-sm font-medium text-brand-400 hover:text-brand-300">
          Actualiser
        </button>
      </div>
    </div>
  );
}
