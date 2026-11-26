/**
 * Écran Messages préparés — modèles + réponses suggérées, aucun envoi.
 *
 * L'écran propose une situation, remplit les variables depuis les données
 * réelles (contact, facture, devis), laisse l'utilisateur corriger, puis copie
 * ou ouvre son propre outil. Les variables non remplies restent visibles en
 * `{{…}}` et sont signalées AVANT la copie : un message ne part jamais avec un
 * trou déguisé.
 */
import { useMemo, useState } from 'react';
import { Copy, MessageSquare, Send } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, Select, cn } from '../../components/ui';
import { useOptionalToast } from '../../context/ToastContext';
import { CRM_CATEGORIES, FINANCE_CATEGORIES, useRecords } from '../records/useRecords';
import { contactFromRecord } from '../crm/model';
import { SALES_CATEGORIES, computeTotals, invoiceFromRecord, quoteFromRecord } from '../sales/model';
import { computeReceivableView, paymentFromRecord, receivableFromRecord } from '../finance/model';
import {
  LANGUES as LANGUES_RELANCE, langueDuClient,
} from '../finance/relances';
import {
  MODELES, lienMailto, lienWhatsApp, remplirModele, situationSuggeree, trousDuMessage,
  type LangueMessage, type SituationMessage,
} from './messages';

export function MessagesWorkspace({ workspaceId }: { workspaceId: string | null }) {
  const toast = useOptionalToast();
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const invoicesStore = useRecords(SALES_CATEGORIES.invoices, workspaceId);
  const quotesStore = useRecords(SALES_CATEGORIES.quotes, workspaceId);
  const receivablesStore = useRecords(FINANCE_CATEGORIES.receivables, workspaceId);
  const paymentsStore = useRecords(FINANCE_CATEGORIES.payments, workspaceId);

  const [situation, setSituation] = useState<SituationMessage>('devis_sans_reponse');
  const [contactId, setContactId] = useState<string>('');
  const [langue, setLangue] = useState<LangueMessage | 'auto'>('auto');
  const [surcharges, setSurcharges] = useState<Record<string, string>>({});
  const [texte, setTexte] = useState<string | null>(null);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const invoices = useMemo(() => invoicesStore.records.map(invoiceFromRecord), [invoicesStore.records]);
  const quotes = useMemo(() => quotesStore.records.map(quoteFromRecord), [quotesStore.records]);
  const receivables = useMemo(() => receivablesStore.records.map(receivableFromRecord), [receivablesStore.records]);
  const payments = useMemo(() => paymentsStore.records.map(paymentFromRecord), [paymentsStore.records]);

  const contact = contacts.find((candidat) => candidat.id === contactId) ?? null;
  const factureEnRetard = useMemo(() => receivables
    .map((receivable) => computeReceivableView(receivable, payments))
    .filter((vue) => vue.effectiveStatus === 'en_retard')
    .sort((a, b) => b.daysOverdue - a.daysOverdue)[0], [receivables, payments]);
  const devisEnAttente = quotes.find((devis) => devis.status === 'envoye') ?? null;
  const derniereFacture = invoices[0] ?? null;

  const suggestion = situationSuggeree({
    devisSansReponse: quotes.filter((devis) => devis.status === 'envoye').length,
    facturesEnRetard: receivables.filter((receivable) => computeReceivableView(receivable, payments).effectiveStatus === 'en_retard').length,
    litigeOuvert: receivables.some((receivable) => receivable.status === 'litige'),
  });

  /** Variables réellement disponibles pour la situation choisie. */
  const valeurs = useMemo(() => {
    const nom = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ');
    const montant = (valeur: number | null, devise: string): string => {
      if (valeur === null || !Number.isFinite(valeur)) return '';
      try {
        return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(valeur) + (devise ? ` ${devise}` : '');
      } catch { return String(valeur); }
    };
    return {
      client: nom || (contact?.company ?? ''),
      numero: situation === 'devis_sans_reponse' ? (devisEnAttente?.number ?? '')
        : situation === 'confirmation_commande' ? (derniereFacture?.number ?? '')
          : (factureEnRetard?.receivable.reference ?? derniereFacture?.number ?? ''),
      montant: situation === 'devis_sans_reponse'
        ? (devisEnAttente ? montant(computeTotals(devisEnAttente.lines).total, devisEnAttente.currency) : '')
        : montant(factureEnRetard ? factureEnRetard.balance : null, derniereFacture?.currency ?? ''),
      echeance: factureEnRetard?.receivable.dueDate ?? '',
      validite: devisEnAttente?.expiresAt ?? '',
      nouvelle_date: '',
      ...surcharges,
    } as Record<string, string>;
  }, [contact, situation, devisEnAttente, factureEnRetard, derniereFacture, surcharges]);

  const langueEffective: LangueMessage = langue === 'auto'
    ? (langueDuClient(contact) === 'fr' ? 'fr' : 'en')
    : langue;

  const modele = MODELES.find((item) => item.situation === situation) ?? MODELES[0];
  const rendu = texte ?? remplirModele(situation, langueEffective, valeurs);
  const trous = trousDuMessage(rendu);

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(rendu);
      toast?.success('Message copié. Collez-le dans votre outil d’envoi.');
    } catch {
      toast?.error('Copie impossible : sélectionnez le texte et copiez-le à la main.');
    }
  };

  if (contactsStore.loading || invoicesStore.loading) {
    return <Card><CardHeader title="Messages préparés" description="Lecture de vos contacts et documents…" /></Card>;
  }

  return (
    <Card data-testid="messages-workspace">
      <CardHeader
        title="Messages préparés"
        description="Des textes justes, remplis avec vos vraies données. Aucun envoi automatique : pas de connecteur de messagerie."
        action={<Badge tone="neutral">{MODELES.length} modèles</Badge>}
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <Select
          label="Situation"
          value={situation}
          onChange={(event) => { setSituation(event.target.value as SituationMessage); setTexte(null); }}
        >
          {MODELES.map((item) => <option key={item.situation} value={item.situation}>{item.label}</option>)}
        </Select>
        <Select
          label="Destinataire"
          value={contactId}
          onChange={(event) => { setContactId(event.target.value); setTexte(null); }}
        >
          <option value="">— Aucun contact précis —</option>
          {contacts.slice(0, 200).map((item) => (
            <option key={item.id} value={item.id}>
              {[item.firstName, item.lastName].filter(Boolean).join(' ') || item.company || item.email || 'Contact'}
            </option>
          ))}
        </Select>
        <Select
          label="Langue"
          value={langue}
          onChange={(event) => { setLangue(event.target.value as LangueMessage | 'auto'); setTexte(null); }}
        >
          <option value="auto">Langue du client ({LANGUES_RELANCE.find((l) => l.value === langueDuClient(contact))?.label ?? 'Français'})</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </Select>
      </div>

      <p className="mb-2 text-[10.5px] text-slate-500">
        {modele.quand}
        {suggestion && suggestion !== situation && (
          <> · Situation suggérée d’après vos données : <strong className="text-slate-300">{MODELES.find((m) => m.situation === suggestion)?.label}</strong></>
        )}
      </p>

      {modele.variables.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {modele.variables.map((variable) => (
            <label key={variable} className="flex items-center gap-1 text-[10.5px] text-slate-400">
              {variable}
              <input
                type="text"
                value={surcharges[variable] ?? valeurs[variable] ?? ''}
                onChange={(event) => {
                  setSurcharges((actuel) => ({ ...actuel, [variable]: event.target.value }));
                  setTexte(null);
                }}
                aria-label={`Variable ${variable}`}
                className="w-32 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 text-white"
              />
            </label>
          ))}
        </div>
      )}

      <textarea
        value={rendu}
        onChange={(event) => setTexte(event.target.value)}
        rows={10}
        aria-label="Message préparé"
        className="w-full rounded-lg border border-white/10 bg-black/30 p-2.5 text-[12px] leading-relaxed text-slate-200"
      />

      {trous.length > 0 && (
        <p className="mt-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2 py-1.5 text-[10.5px] text-amber-200/90">
          À compléter avant envoi : {trous.map((trou) => `« ${trou} »`).join(', ')}. Un texte parti avec un trou est réparable ; un nom inventé ne l’est pas.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" icon={<Copy size={12} />} onClick={() => void copier()}>Copier</Button>
        <Button
          size="sm"
          variant="outline"
          icon={<Send size={12} />}
          disabled={!contact?.email}
          title={contact?.email ? 'Ouvre votre messagerie, n’envoie rien' : 'Aucune adresse e-mail pour ce contact'}
          onClick={() => {
            if (!contact?.email) return;
            window.open(lienMailto(contact.email, modele.label, rendu), '_blank', 'noopener');
          }}
        >
          Ouvrir dans ma messagerie
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={<MessageSquare size={12} />}
          disabled={!contact?.whatsapp}
          title={contact?.whatsapp ? 'Ouvre WhatsApp avec le texte, sans envoi automatique' : 'Aucun numéro WhatsApp pour ce contact'}
          onClick={() => {
            const lien = lienWhatsApp(contact?.whatsapp ?? '', rendu);
            if (lien) window.open(lien, '_blank', 'noopener');
          }}
        >
          Ouvrir dans WhatsApp
        </Button>
      </div>

      <p className="mt-2 text-[10px] text-slate-500">
        Aucun message n’est envoyé par l’application : les boutons ouvrent VOTRE logiciel avec le texte déjà rempli. Aucun connecteur WhatsApp, Meta ou Google n’est utilisé.
      </p>

      {contacts.length === 0 && (
        <div className="mt-3">
          <EmptyState
            icon={<MessageSquare size={20} />}
            title="Aucun contact"
            description="Ajoutez un contact dans Clients pour remplir automatiquement le nom, l’e-mail et le numéro."
          />
        </div>
      )}
      <span className={cn('sr-only')} aria-hidden="true">{MODELES.map((item) => item.situation).join(',')}</span>
    </Card>
  );
}
