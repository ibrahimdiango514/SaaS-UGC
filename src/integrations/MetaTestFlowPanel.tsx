/**
 * VYORA — panneau du parcours WhatsApp de TEST.
 *
 * ## Ce que ce panneau affiche
 * L'état RÉEL, tel que le serveur le rend : le parcours est-il ouvert, quels
 * identifiants Meta sont imposés, la connexion existe-t-elle, le compte est-il
 * abonné aux webhooks, et quelle est la dernière erreur.
 *
 * ## Ce qu'il n'affiche jamais
 * Aucun jeton, aucune valeur de secret, et aucun état « Connecté » qui ne
 * viendrait pas du serveur. Les identifiants Meta affichés (WABA, numéro) sont
 * publics par nature : ils figurent dans l'URL de tout appel Graph. Les montrer
 * permet de repérer une faute de recopie — la cause n°1 d'un parcours muet.
 *
 * ## Pourquoi un panneau séparé
 * Le parcours client (Embedded Signup) et le parcours de test écrivent la même
 * fiche produit. Les mélanger dans un seul composant rendrait illisible ce qui
 * prouve quoi. Ici, la frontière est visible : ce bloc disparaît entièrement
 * quand le serveur ferme le parcours (interrupteur `META_TEST_FLOW_ENABLED`),
 * sans que le parcours client en soit affecté.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, FlaskConical, Loader2, Unplug } from 'lucide-react';
import { Button } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  connectMetaTestFlow,
  disconnectMetaTestFlow,
  readMetaTestFlow,
  type MetaTestFlowStatus,
} from './meta/api';

export function MetaTestFlowPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string | null;
  /** Prévient la fiche parente qu'une connexion a changé. */
  onChanged?: (etat: { tone: 'success' | 'error'; text: string }) => void;
}) {
  const [etat, setEtat] = useState<MetaTestFlowStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const relire = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setEtat(await readMetaTestFlow(workspaceId));
      setErreur(null);
    } catch (e) {
      /*
       * Un client non administrateur reçoit 404 : on n'affiche alors RIEN,
       * pas même un message d'erreur. Afficher « parcours réservé à
       * l'administrateur » révélerait son existence, ce que le serveur a
       * précisément évité en répondant 404 plutôt que 403.
       */
      setEtat(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    void relire();
  }, [relire]);

  if (!etat) return null;

  const flux = etat.testFlow;
  const connexion = etat.connection;
  const estConnexionTest = connexion?.flow === 'test-number';

  const connecter = async () => {
    if (!workspaceId) return;
    setBusy('connect');
    setNotice(null);
    setErreur(null);
    try {
      const r = await connectMetaTestFlow(workspaceId);
      setNotice(
        r.warning
          ? `Connecté à ${r.displayPhoneNumber ?? r.phoneNumberId}. ${r.warning}`
          : `Connecté à ${r.displayPhoneNumber ?? r.phoneNumberId}. Le compte est abonné aux webhooks : un message envoyé à ce numéro doit apparaître dans la boîte de réception.`,
      );
      onChanged?.({ tone: 'success', text: 'Parcours de test connecté.' });
      await relire();
    } catch (e) {
      const err = asAppError(e);
      setErreur(err.message);
      onChanged?.({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const deconnecter = async () => {
    if (!workspaceId) return;
    setBusy('disconnect');
    setNotice(null);
    setErreur(null);
    try {
      await disconnectMetaTestFlow(workspaceId);
      setNotice('Connexion de test retirée. Le parcours client n’a pas été touché.');
      onChanged?.({ tone: 'success', text: 'Connexion de test retirée.' });
      await relire();
    } catch (e) {
      const err = asAppError(e);
      setErreur(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-amber-400/20 bg-amber-500/[0.04] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-100">
        <FlaskConical size={12} className="shrink-0" />
        Parcours de test — numéro fourni par Meta
      </p>

      <p className="text-[11px] leading-relaxed text-slate-400">
        Réservé à l’administrateur propriétaire. Il utilise uniquement les identifiants configurés
        sur le serveur : aucun numéro saisi ici n’est pris en compte. Le parcours client
        (Embedded Signup) reste disponible et inchangé.
      </p>

      {/* Pourquoi le parcours est fermé — sans jamais citer de secret. */}
      {!flux.available && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400">
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-300" />
          {flux.reason ?? 'Parcours de test indisponible.'}
        </p>
      )}

      {flux.available && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-slate-500">Compte WhatsApp</dt>
          <dd className="font-mono text-slate-300">{flux.wabaId}</dd>
          <dt className="text-slate-500">Numéro</dt>
          <dd className="font-mono text-slate-300">
            {flux.displayPhoneNumber ? `${flux.displayPhoneNumber} · ` : ''}
            {flux.phoneNumberId}
          </dd>
          {connexion && (
            <>
              <dt className="text-slate-500">État</dt>
              <dd className={estConnexionTest ? 'text-emerald-200' : 'text-slate-300'}>
                {connexion.status}
                {estConnexionTest ? ' (connexion de test)' : ' (parcours client)'}
              </dd>
              <dt className="text-slate-500">Webhooks</dt>
              <dd className={connexion.webhookSubscribed ? 'text-emerald-200' : 'text-rose-200'}>
                {connexion.webhookSubscribed ? 'abonné' : 'non abonné — aucun message ne sera reçu'}
              </dd>
            </>
          )}
        </dl>
      )}

      {connexion?.lastError && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-200">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {connexion.lastError}
        </p>
      )}

      {erreur && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-200">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreur}
        </p>
      )}

      {notice && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-emerald-200">
          <Check size={11} className="mt-0.5 shrink-0" /> {notice}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {flux.available && !connexion && (
          <Button size="sm" disabled={busy !== null} loading={busy === 'connect'} onClick={() => { void connecter(); }}>
            Connecter le numéro de test
          </Button>
        )}
        {connexion && estConnexionTest && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            loading={busy === 'disconnect'}
            onClick={() => { void deconnecter(); }}
            icon={<Unplug size={13} />}
          >
            Retirer la connexion de test
          </Button>
        )}
        {busy === null && !flux.available && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { void relire(); }}
            icon={<Loader2 size={13} />}
          >
            Relire l’état
          </Button>
        )}
      </div>
    </div>
  );
}
