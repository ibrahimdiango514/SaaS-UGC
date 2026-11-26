/**
 * Écran « Du chiffre à la vidéo ».
 *
 * L'utilisateur voit les chiffres réels qui vont servir au brief, corrige le
 * texte, puis ouvre Studio. Le bouton affiche explicitement « sans débit » :
 * un brief n'engendre aucune dépense, la génération reste dans Studio où le
 * devis est présenté avant tout crédit consommé.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clapperboard, Copy, ExternalLink } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, Select } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import { useRecords } from '../records/useRecords';
import { SALES_CATEGORIES, invoiceFromRecord } from '../sales/model';
import { CATALOG_CATEGORIES, productFromRecord } from '../catalog/model';
import { construireBriefStudio, chiffresParProduit } from './briefStudio';

export function BriefStudioWorkspace({ workspaceId, nomEntreprise }: {
  workspaceId: string | null;
  nomEntreprise: string;
}) {
  const toast = useOptionalToast();
  const invoicesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  const catalogStore = useRecords(CATALOG_CATEGORIES.products, workspaceId);
  const [produit, setProduit] = useState('');
  const [angle, setAngle] = useState('');
  const [cible, setCible] = useState('');

  const invoices = useMemo(() => invoicesStore.records.map(invoiceFromRecord), [invoicesStore.records]);
  const produits = useMemo(() => catalogStore.records.map(productFromRecord), [catalogStore.records]);
  const chiffres = useMemo(() => chiffresParProduit(invoices, produits), [invoices, produits]);

  const brief = useMemo(() => construireBriefStudio({
    invoices, produits, nomEntreprise, produitChoisi: produit, angleChoisi: angle, cible,
  }), [invoices, produits, nomEntreprise, produit, angle, cible]);

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(brief.texte);
      toast?.success('Brief copié.');
    } catch {
      toast?.error('Copie impossible : sélectionnez le texte et copiez-le à la main.');
    }
  };

  if (invoicesStore.loading || catalogStore.loading) {
    return <Card><CardHeader title="Du chiffre à la vidéo" description="Lecture de vos factures et du catalogue…" /></Card>;
  }

  return (
    <Card data-testid="brief-studio-workspace">
      <CardHeader
        title="Du chiffre à la vidéo"
        description="Un brief construit sur vos chiffres réels, puis Studio. Aucune génération et aucun débit depuis cet écran."
        action={<Badge tone={chiffres.length > 0 ? 'success' : 'warning'}>{chiffres.length} produit(s) facturé(s)</Badge>}
      />

      {chiffres.length === 0 ? (
        <EmptyState
          icon={<Clapperboard size={22} />}
          title="Aucun produit facturé à mettre en avant"
          description="Le brief se construit sur des factures réelles. Sans facture, aucun chiffre n’est inventé : choisissez un produit ou enregistrez d’abord une vente."
        />
      ) : (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <Select label="Produit mis en avant" value={produit} onChange={(event) => setProduit(event.target.value)}>
              <option value="">Le plus vendu ({chiffres[0].produit})</option>
              {chiffres.map((chiffre) => (
                <option key={chiffre.produit} value={chiffre.produit}>
                  {chiffre.produit} — {chiffre.quantite} vendu(s)
                </option>
              ))}
            </Select>
            <label className="text-[10.5px] text-slate-400">
              Cible
              <input
                type="text"
                value={cible}
                onChange={(event) => setCible(event.target.value)}
                placeholder="Ex. : clientes 25-40 ans, ville"
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white placeholder:text-slate-600"
              />
            </label>
            <label className="text-[10.5px] text-slate-400">
              Angle (laissez vide pour une proposition)
              <input
                type="text"
                value={angle}
                onChange={(event) => setAngle(event.target.value)}
                placeholder="Ex. : montrer l’usage au quotidien"
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white placeholder:text-slate-600"
              />
            </label>
          </div>

          <div className="mb-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Chiffres réellement utilisés</p>
            {brief.sources.length > 0 ? (
              <ul className="space-y-0.5">
                {brief.sources.map((source) => <li key={source} className="text-[11.5px] text-slate-300">· {source}</li>)}
              </ul>
            ) : (
              <p className="text-[11.5px] text-slate-400">Aucun chiffre vérifiable pour ce produit.</p>
            )}
            {brief.manques.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 border-t border-white/[0.06] pt-1.5">
                {brief.manques.map((manque) => (
                  <li key={manque} className="text-[10.5px] text-amber-200/80">· {manque}</li>
                ))}
              </ul>
            )}
          </div>

          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-2.5 text-[11.5px] leading-relaxed text-slate-200">
            {brief.texte}
          </pre>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" icon={<Copy size={12} />} onClick={() => void copier()}>Copier le brief</Button>
            <Link
              to="/app/studio"
              state={brief.state}
              className="btn btn-primary btn-sm"
              data-testid="ouvrir-studio-sans-debit"
            >
              Ouvrir dans Studio UGC (sans débit) <ExternalLink size={12} className="ml-1 inline" />
            </Link>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            Le brief ne consomme aucun crédit. La génération vidéo se fait dans Studio, où le coût est affiché avant validation.
          </p>
        </>
      )}
    </Card>
  );
}
