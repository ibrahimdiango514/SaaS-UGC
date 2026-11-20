import {invalidateCatalog,useCatalogRevision} from '../../hooks/useCatalogRevision';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardHeader } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { getUniversalCatalogSummary, syncUniversalCatalog, syncUniversalCatalogDetails, type UniversalCatalogSummary } from '../../lib/api';

/** Manual administrator operations only; the server rechecks the role. */
export function UniversalCatalogSync() {
 const catalogRevision=useCatalogRevision();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<UniversalCatalogSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const refresh = useCallback(async () => {
    try { setSummary(await getUniversalCatalogSummary()); setSummaryError(''); }
    catch { setSummary(null); setSummaryError('Impossible de lire l’état du registre.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh,catalogRevision]);
  async function run(action: 'catalog' | 'details') {
    setBusy(true); setMessage(''); setError('');
    try {
      if (action === 'catalog') {
        const r = await syncUniversalCatalog();
        setMessage(`${r.fetched} références reçues sur ${r.pages} page(s) ; ${r.result.added} ajoutée(s), ${r.result.changed} modifiée(s), ${r.result.missing} absente(s).`);
      } else {
        const r = await syncUniversalCatalogDetails();
        setMessage(`${r.attempted} fiche(s) tentée(s) : ${r.ok} enregistrée(s), ${r.http_error + r.invalid + r.network_error + r.persist_error} erreur(s).`);
      }
      invalidateCatalog();
      await refresh();
    } catch (err) { setError(asAppError(err).message); }
    finally { setBusy(false); }
  }
  return <Card>
    <CardHeader title="Registre universel MuAPI" description="Synchronisation publique administrateur : sans génération ni débit de crédits. La présence dans le catalogue ne prouve pas l’accès ni l’intégration Studio." />
    <div className="space-y-3 p-5 pt-0">
      {summary && <p className="text-xs text-slate-300">{summary.models} références présentes · {summary.details_ok} fiches disponibles · {summary.detail_errors} erreur(s) · {summary.enabled} activée(s) dans le registre universel.</p>}
      {summaryError && <p className="text-xs text-amber-300">{summaryError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('catalog')}>Synchroniser le catalogue public</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('details')}>Actualiser 10 fiches</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>Actualiser l’état</Button>
      </div>
      {busy && <p role="status" className="text-xs text-slate-400">Synchronisation en cours…</p>}
      {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
      {error && <p role="alert" className="text-xs text-rose-300">Échec de la synchronisation : {error}</p>}
    </div>
  </Card>;
}
