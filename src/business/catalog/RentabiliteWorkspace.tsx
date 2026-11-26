/**
 * Écran Rentabilité — marge réelle, ventes à perte, fuites d'argent.
 *
 * L'écran rend visible ce que le calcul refuse de deviner : les produits dont
 * le coût est inconnu n'ont PAS de marge affichée, et la part du chiffre
 * d'affaires concernée est annoncée en clair. Un utilisateur qui voit
 * « couverture 62 % » sait qu'il lui reste 38 % à renseigner.
 */
import { useMemo, useState } from 'react';
import { AlertOctagon, Coins, Percent, TrendingDown } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, StatCard, cn } from '../../components/ui';
import { useRecords } from '../records/useRecords';
import { CATALOG_CATEGORIES, productFromRecord } from './model';
import { CASH_CATEGORIES } from '../cash/model';
import { SALES_CATEGORIES, invoiceFromRecord } from '../sales/model';
import { expensesToCsv, expenseFromRecord } from '../cash/model';
import {
  fuitesDetectees, lignesFacturees, rapportRentabilite,
  type DepenseRecurrente, type Fuite,
} from './rentabilite';

const money = (valeur: number | null, devise: string) => valeur === null
  ? '—'
  : `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(valeur)} ${devise}`;

const TON_FUITE: Record<Fuite['type'], 'danger' | 'warning' | 'neutral'> = {
  vente_a_perte: 'danger', produit_sans_cout: 'warning', abonnement_doublon: 'neutral',
};

export function RentabiliteWorkspace({ workspaceId, onOpenCatalog }: { workspaceId: string | null; onOpenCatalog: () => void }) {
  const produitsStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);
  const facturesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  const depensesStore = useRecords(CASH_CATEGORIES.expenses, workspaceId);
  const [devise, setDevise] = useState('XOF');

  const produits = useMemo(() => produitsStore.records.map(productFromRecord), [produitsStore.records]);
  const factures = useMemo(() => facturesStore.records.map(invoiceFromRecord), [facturesStore.records]);
  const depenses: DepenseRecurrente[] = useMemo(() => depensesStore.records.map(expenseFromRecord).map((expense) => ({
    id: expense.id, label: expense.label, amount: expense.amount,
    recurrence: expense.recurrence, status: expense.status,
  })), [depensesStore.records]);

  /** Devises réellement présentes dans les factures : jamais une liste inventée. */
  const devisesDisponibles = useMemo(() => {
    const trouvees = new Set(factures.map((facture) => facture.currency.toUpperCase()).filter(Boolean));
    trouvees.add('XOF');
    return [...trouvees].sort();
  }, [factures]);

  const lignes = useMemo(() => lignesFacturees(factures, devise), [factures, devise]);
  const rapport = useMemo(() => rapportRentabilite(produits, lignes, devise), [produits, lignes, devise]);
  const fuites = useMemo(() => fuitesDetectees(rapport, depenses), [rapport, depenses]);

  const chargement = produitsStore.loading || facturesStore.loading || depensesStore.loading;
  if (chargement) return <LoadingState label="Calcul de la rentabilité…" />;
  const erreur = produitsStore.error || facturesStore.error;
  if (erreur) return <ErrorState message={erreur} onRetry={() => { void produitsStore.reload(); void facturesStore.reload(); }} />;

  if (rapport.produits.length === 0) {
    return (
      <Card data-testid="rentabilite-workspace">
        <CardHeader title="Rentabilité" description="Marge réelle par produit, calculée depuis vos coûts d’achat et vos factures." />
        <EmptyState
          icon={<Coins size={22} />}
          title={`Aucune vente facturée en ${devise}`}
          description="Dès qu’une facture non annulée contient un produit, sa marge apparaît ici. Pensez à renseigner le coût d’achat dans le catalogue : sans lui, aucune marge n’est calculable."
          action={<Button size="sm" variant="primary" onClick={onOpenCatalog}>Ouvrir le catalogue</Button>}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="rentabilite-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard label="Revenu analysé" value={money(rapport.revenuTotal, devise)} icon={<Coins size={15} />} hint="Hors taxes, net de remise" />
        <StatCard label="Marge connue" value={money(rapport.margeTotale, devise)} icon={<Percent size={15} />} tone={rapport.margeTotale < 0 ? 'amber' : 'emerald'} hint="Produits à coût renseigné" />
        <StatCard label="Couverture du coût" value={`${rapport.couvertureCout} %`} icon={<Percent size={15} />} tone={rapport.couvertureCout < 100 ? 'amber' : 'emerald'} hint="Part du CA à marge calculable" />
        <StatCard label="Ventes à perte" value={String(rapport.ventesAPerte)} icon={<TrendingDown size={15} />} tone={rapport.ventesAPerte > 0 ? 'amber' : 'emerald'} hint="Coût connu, marge négative" />
      </div>

      {devisesDisponibles.length > 1 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Devise analysée">
          {devisesDisponibles.map((code) => (
            <Button key={code} size="sm" variant={devise === code ? 'primary' : 'ghost'} aria-pressed={devise === code} onClick={() => setDevise(code)}>
              {code}
            </Button>
          ))}
        </div>
      )}

      <Card>
        <CardHeader
          title="Marge par produit"
          description="Un produit sans coût d’achat n’a pas de marge : elle est affichée « — », jamais supposée nulle."
          action={<Badge tone="neutral">{rapport.produits.length} produit(s)</Badge>}
        />
        <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
          {rapport.produits.map((produit) => (
            <li key={produit.productId} className="flex items-start justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-semibold text-white">{produit.nom}</p>
                <p className="mt-0.5 text-[10.5px] text-slate-400">
                  {produit.quantiteVendue} vendu(s) · revenu {money(produit.revenu, devise)}
                  {produit.cout !== null ? ` · coût ${money(produit.cout, devise)}` : ' · coût d’achat inconnu'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn('text-[12.5px] font-semibold', produit.marge === null ? 'text-slate-500' : produit.marge < 0 ? 'text-rose-300' : 'text-white')}>
                  {money(produit.marge, devise)}
                </p>
                {produit.tauxMarge !== null && <p className="text-[10px] text-slate-500">{produit.tauxMarge} %</p>}
                {produit.venteAPerte && <Badge tone="danger">à perte</Badge>}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Fuites d’argent"
          description="Ce qui coûte sans rien rapporter. Les montants viennent de vos données ; les ressemblances sont signalées, pas affirmées."
          action={<Badge tone={fuites.length > 0 ? 'warning' : 'success'}>{fuites.length}</Badge>}
        />
        {fuites.length === 0 ? (
          <EmptyState icon={<AlertOctagon size={22} />} title="Aucune fuite détectée" description="Aucune vente à perte, tous vos coûts sont renseignés, aucun doublon de dépense récurrente." />
        ) : (
          <ul className="liste-mobile overflow-hidden rounded-xl border border-white/[0.06]">
            {fuites.map((fuite, index) => (
              <li key={`${fuite.type}-${index}`} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 text-[12px] font-semibold text-white">{fuite.label}</p>
                  <Badge tone={TON_FUITE[fuite.type]}>{fuite.type === 'vente_a_perte' ? 'perte' : fuite.type === 'produit_sans_cout' ? 'coût manquant' : 'à vérifier'}</Badge>
                </div>
                <p className="mt-0.5 text-[10.5px] text-slate-400">{fuite.detail}</p>
                {fuite.montant !== null && <p className="mt-0.5 text-[10.5px] text-slate-300">Impact : {money(fuite.montant, devise)}</p>}
              </li>
            ))}
          </ul>
        )}
        {rapport.produitsSansCout.length > 0 && (
          <p className="mt-2 text-[10px] text-amber-200">
            {rapport.produitsSansCout.length} produit(s) vendu(s) sans coût : {rapport.produitsSansCout.slice(0, 4).join(', ')}
            {rapport.produitsSansCout.length > 4 ? '…' : ''}. Renseignez le coût d’achat pour obtenir une marge réelle.
          </p>
        )}
        {depenses.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => {
              const csv = expensesToCsv(depensesStore.records.map(expenseFromRecord));
              const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const lien = document.createElement('a');
              lien.href = url; lien.download = 'depenses-pour-audit.csv'; lien.click();
              URL.revokeObjectURL(url);
            }}
          >
            Exporter les dépenses (audit des doublons)
          </Button>
        )}
      </Card>
    </div>
  );
}
