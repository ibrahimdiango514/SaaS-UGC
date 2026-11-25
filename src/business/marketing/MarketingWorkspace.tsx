import { useMemo, useState } from 'react';
import {
  CalendarClock, Copy, Download, Mail, MessageCircle, Plus, Send, Smartphone, Users,
} from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, Modal, Select, Textarea } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { CRM_CATEGORIES, useRecords } from '../records/useRecords';
import {
  contactDisplayName, contactFromRecord, contactMatchesFilters, opportunityFromRecord,
  scoreContact, segmentFromRecord, taskFromRecord, todayIso,
} from '../crm/model';
import {
  CAMPAIGN_CHANNELS, CAMPAIGN_STATUSES, MARKETING_CATEGORIES, MARKETING_TEMPLATES,
  buildRecipients, campaignFromRecord, campaignToData, campaignsToCsv, computeMarketingSummary,
  inactiveClients, mailtoLink, validateCampaign, whatsappLink,
  type Campaign, type CampaignChannel, type CampaignStatus,
} from './model';

function downloadFile(name: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

function emptyCampaign(): {
  name: string; objective: string; segmentId: string; channel: CampaignChannel; status: CampaignStatus;
  plannedAt: string; templateId: string; message: string; notes: string;
} {
  return { name: '', objective: '', segmentId: '', channel: 'whatsapp', status: 'brouillon', plannedAt: '', templateId: '', message: '', notes: '' };
}

function CampaignForm({ open, initial, onClose, onSubmit }: {
  open: boolean;
  initial: Campaign | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState(() => initial ? {
    name: initial.name, objective: initial.objective, segmentId: initial.segmentId, channel: initial.channel,
    status: initial.status, plannedAt: initial.plannedAt, templateId: initial.templateId,
    message: initial.message, notes: initial.notes,
  } : emptyCampaign());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async () => {
    const errors = validateCampaign(form);
    if (errors.length) { setError(errors.join(' ')); return; }
    setBusy(true); setError('');
    try { await onSubmit(form); onClose(); }
    catch (cause) { setError(asAppError(cause).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Modifier la campagne' : 'Nouvelle campagne'} size="lg"
      description="Aucun envoi automatique. Le message est préparé pour WhatsApp, e-mail ou SMS."
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={() => void submit()}>{initial ? 'Enregistrer' : 'Créer la campagne'}</Button></>}>
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Nom" value={form.name} onChange={(event) => set({ name: event.target.value })} />
          <Input label="Objectif" value={form.objective} onChange={(event) => set({ objective: event.target.value })} placeholder="Réactiver les clients inactifs" />
          <Select label="Canal" value={form.channel} onChange={(event) => set({ channel: event.target.value as CampaignChannel })}>
            {CAMPAIGN_CHANNELS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
          <Select label="Statut" value={form.status} onChange={(event) => set({ status: event.target.value as CampaignStatus })}>
            {CAMPAIGN_STATUSES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </Select>
          <Input label="Date prévue" type="date" value={form.plannedAt} onChange={(event) => set({ plannedAt: event.target.value })} />
          <Select label="Modèle" value={form.templateId} onChange={(event) => {
            const template = MARKETING_TEMPLATES.find((entry) => entry.id === event.target.value);
            set({ templateId: event.target.value, message: template?.body ?? form.message, objective: form.objective || template?.objective || '' });
          }}>
            <option value="">Message libre</option>
            {MARKETING_TEMPLATES.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </Select>
        </div>
        <Textarea label="Message" value={form.message} onChange={(event) => set({ message: event.target.value })} hint="Variables : {{contact}}, {{entreprise}}, {{ville}}, {{produit}}, {{montant}}" />
        <Textarea label="Notes" value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
      </div>
    </Modal>
  );
}

export default function MarketingWorkspace({ workspaceId, onOpenContact }: { workspaceId: string | null; onOpenContact: (id: string) => void }) {
  const toast = useToast();
  const contactsStore = useRecords(CRM_CATEGORIES.contacts, workspaceId);
  const opportunitiesStore = useRecords(CRM_CATEGORIES.opportunities, workspaceId);
  const tasksStore = useRecords(CRM_CATEGORIES.tasks, workspaceId);
  const segmentsStore = useRecords(CRM_CATEGORIES.segments, workspaceId);
  const campaignsStore = useRecords(MARKETING_CATEGORIES.campaigns, workspaceId);

  const contacts = useMemo(() => contactsStore.records.map(contactFromRecord), [contactsStore.records]);
  const opportunities = useMemo(() => opportunitiesStore.records.map(opportunityFromRecord), [opportunitiesStore.records]);
  const tasks = useMemo(() => tasksStore.records.map(taskFromRecord), [tasksStore.records]);
  const segments = useMemo(() => segmentsStore.records.map(segmentFromRecord), [segmentsStore.records]);
  const campaigns = useMemo(() => campaignsStore.records.map(campaignFromRecord), [campaignsStore.records]);
  const summary = useMemo(() => computeMarketingSummary(campaigns, contacts), [campaigns, contacts]);
  const inactive = useMemo(() => inactiveClients(contacts), [contacts]);

  const [editor, setEditor] = useState<Campaign | null | 'new'>(null);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const segmentMembers = (segmentId: string): Set<string> => {
    const segment = segments.find((entry) => entry.id === segmentId);
    if (!segment) return new Set();
    return new Set(contacts.filter((contact) => {
      const score = scoreContact(contact, { opportunities, tasks, now: todayIso() });
      const openValue = opportunities.filter((opportunity) => opportunity.contactId === contact.id).reduce((sum, opportunity) => sum + (opportunity.amount ?? 0), 0);
      const overdueTasks = tasks.filter((task) => task.contactId === contact.id && task.status === 'a_faire' && task.dueDate && task.dueDate < todayIso()).length;
      return contactMatchesFilters(contact, segment.filters, score, openValue, overdueTasks);
    }).map((contact) => contact.id));
  };

  const save = async (data: Record<string, unknown>) => {
    if (editor && editor !== 'new') await campaignsStore.update(editor.id, data);
    else await campaignsStore.create(data, null);
    toast.success(editor && editor !== 'new' ? 'Campagne mise à jour.' : 'Campagne créée.');
  };

  const setStatus = async (campaign: Campaign, status: CampaignStatus) => {
    setBusy(campaign.id);
    try {
      await campaignsStore.update(campaign.id, { ...campaignToData(campaign), status });
      toast.success(`Campagne marquée « ${CAMPAIGN_STATUSES.find((entry) => entry.value === status)?.label} ».`);
    } catch (cause) { toast.error(asAppError(cause).message); } finally { setBusy(null); }
  };

  const recipientsFor = (campaign: Campaign) => buildRecipients(
    campaign, contacts, 'notre entreprise',
    campaign.segmentId ? segmentMembers(campaign.segmentId) : null,
  );

  if (contactsStore.loading || campaignsStore.loading) return <LoadingState label="Chargement du marketing…" />;
  const loadError = contactsStore.error || campaignsStore.error;
  if (loadError) return <ErrorState message={loadError} onRetry={() => { void contactsStore.reload(); void campaignsStore.reload(); }} />;

  return (
    <div className="space-y-4" data-testid="marketing-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {[
          ['Campagnes', String(summary.total)],
          ['Prêtes', String(summary.ready)],
          ['Planifiées', String(summary.scheduled)],
          ['Clients inactifs', String(summary.inactiveClients)],
          ['Segments CRM', String(segments.length)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 font-display text-[17px] font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white"><Send size={13} /> Préparation, pas d’envoi simulé</p>
        <p className="mt-1 text-[10.5px] text-slate-400">Les messages sont personnalisés par contact. WhatsApp et l’e-mail s’ouvrent dans votre application ; aucun fournisseur d’envoi n’est configuré par défaut.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-white">Campagnes</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadFile('campagnes.csv', campaignsToCsv(campaigns, (id) => segments.find((segment) => segment.id === id)?.name ?? ''))}>Exporter</Button>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Nouvelle campagne</Button>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <EmptyState icon={<Send size={24} />} title="Aucune campagne" description="Préparez une campagne de réactivation, de fidélisation ou une annonce à partir d’un segment CRM." action={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditor('new')}>Créer</Button>} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.07]">
          {campaigns.map((campaign) => {
            const recipients = recipientsFor(campaign);
            return (
              <div key={campaign.id} className="grid gap-1 border-b border-white/[0.04] px-3 py-2.5 text-[11.5px] last:border-0 hover:bg-white/[0.02] md:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr_auto] md:items-center">
                <div className="min-w-0">
                  <button type="button" className="truncate text-left font-medium text-white hover:text-violet-200" onClick={() => setDetail(campaign)}>{campaign.name}</button>
                  <p className="truncate text-[10px] text-slate-500">{campaign.objective || 'Sans objectif'} · {segments.find((segment) => segment.id === campaign.segmentId)?.name ?? 'Tous les contacts'}</p>
                </div>
                <span className="text-slate-400">{CAMPAIGN_CHANNELS.find((entry) => entry.value === campaign.channel)?.label}</span>
                <span><Badge tone={campaign.status === 'terminee' ? 'success' : campaign.status === 'planifiee' ? 'info' : campaign.status === 'annulee' ? 'neutral' : 'warning'}>{CAMPAIGN_STATUSES.find((entry) => entry.value === campaign.status)?.label}</Badge></span>
                <span className="text-slate-400">{recipients.length} destinataire(s){campaign.plannedAt ? ` · ${campaign.plannedAt}` : ''}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => setDetail(campaign)}>Préparer</Button>
                  {campaign.status === 'brouillon' && <Button size="sm" variant="ghost" onClick={() => void setStatus(campaign, 'prete')} disabled={busy === campaign.id}>Prête</Button>}
                  {campaign.status === 'prete' && <Button size="sm" variant="ghost" onClick={() => void setStatus(campaign, 'planifiee')} disabled={busy === campaign.id || !campaign.plannedAt}>Planifier</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white"><Users size={13} /> Clients inactifs ({inactive.length})</p>
        <p className="mt-1 text-[10.5px] text-slate-500">Aucun contact depuis 60 jours ou plus. Utilisez ce vivier pour une campagne de réactivation.</p>
        {inactive.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {inactive.slice(0, 8).map((contact) => <button key={contact.id} type="button" onClick={() => onOpenContact(contact.id)} className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-300 hover:border-violet-300/30 hover:text-white">{contactDisplayName(contact)}</button>)}
          </div>
        )}
      </div>

      {editor && <CampaignForm open initial={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSubmit={save} />}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.name ?? 'Campagne'} size="lg"
        description={detail ? `${CAMPAIGN_CHANNELS.find((entry) => entry.value === detail.channel)?.label} · ${CAMPAIGN_STATUSES.find((entry) => entry.value === detail.status)?.label}` : undefined}
        footer={<><Button variant="ghost" onClick={() => setDetail(null)}>Fermer</Button>{detail && <Button variant="outline" onClick={() => { setEditor(detail); setDetail(null); }}>Modifier</Button>}</>}>
        {detail && (() => {
          const recipients = recipientsFor(detail);
          return (
            <div className="space-y-3">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] text-slate-300">
                <p className="font-medium text-white">Message</p>
                <p className="mt-1 whitespace-pre-wrap">{detail.message}</p>
              </div>
              <div className="flex flex-wrap gap-3 text-[10.5px] text-slate-400">
                <span className="inline-flex items-center gap-1"><CalendarClock size={11} /> {detail.plannedAt || 'Non planifiée'}</span>
                <span className="inline-flex items-center gap-1"><Users size={11} /> {recipients.length} destinataire(s) avec coordonnées</span>
              </div>
              {recipients.length === 0 ? <p className="text-[11px] text-slate-500">Aucun destinataire : vérifiez le segment et les coordonnées du canal.</p> : (
                <div className="max-h-72 space-y-1 overflow-auto">
                  {recipients.slice(0, 30).map((recipient) => (
                    <div key={recipient.contactId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.05] px-2 py-1.5 text-[10.5px]">
                      <span className="min-w-0 flex-1 truncate text-slate-300" title={recipient.message}>{recipient.name}</span>
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" icon={<Copy size={11} />} onClick={() => { void navigator.clipboard?.writeText(recipient.message); toast.success('Message copié.'); }}>Copier</Button>
                        {detail.channel === 'whatsapp' && recipient.phone && <a className="btn btn-outline btn-sm" href={whatsappLink(recipient.phone, recipient.message)} target="_blank" rel="noreferrer"><MessageCircle size={11} /> WhatsApp</a>}
                        {detail.channel === 'email' && recipient.email && <a className="btn btn-outline btn-sm" href={mailtoLink(recipient.email, detail, recipient.message)}><Mail size={11} /> E-mail</a>}
                        {detail.channel === 'sms' && recipient.phone && <span className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-slate-400"><Smartphone size={11} /> {recipient.phone}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {detail.status !== 'planifiee' && <Button size="sm" variant="outline" onClick={() => void setStatus(detail, 'planifiee')}>Marquer planifiée</Button>}
                {detail.status !== 'terminee' && <Button size="sm" variant="outline" onClick={() => void setStatus(detail, 'terminee')}>Marquer terminée</Button>}
                {detail.status !== 'annulee' && <Button size="sm" variant="ghost" onClick={() => void setStatus(detail, 'annulee')}>Annuler</Button>}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
