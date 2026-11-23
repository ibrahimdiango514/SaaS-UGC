import { useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, ClipboardList, Copy, Download, FileSpreadsheet, Filter,
  Layers, Mail, MessageCircle, Pencil, Phone, Plus, Search, Target, Trash2, Upload,
  UserCheck, Users,
} from 'lucide-react';
import {
  Badge, Button, EmptyState, Input, Modal, Select, Textarea, cn,
} from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import {
  CONTACT_SOURCES, CONTACT_TYPES, MESSAGE_TEMPLATES, OPPORTUNITY_STAGES, PRIORITY_LABELS,
  TASK_TYPES, contactDisplayName, csvEscape, guessMapping, mailtoLink, buildContactsFromRows,
  detectDuplicates, normalizeEmail, phonesMatch, renderTemplate, whatsappLink,
  type ActionItem, type Contact, type CrmSegment, type CrmTask, type ImportRowResult,
  type Opportunity, type OpportunityStage, type Priority, type SegmentFilters,
} from './model';

const money = (value: number | null, currency = 'XOF') => value === null
  ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

function downloadCsv(name: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function contactOptionLabel(contact: Contact): string {
  return `${contactDisplayName(contact)}${contact.company ? ` · ${contact.company}` : ''}`;
}

/* -------------------------------------------------------------------------- */
/* Pipeline Kanban                                                            */
/* -------------------------------------------------------------------------- */

export function PipelinePanel({
  opportunities, contacts, onStageChange, onCreate, onEdit,
}: {
  opportunities: Opportunity[];
  contacts: Contact[];
  onStageChange: (opportunity: Opportunity, stage: OpportunityStage) => void;
  onCreate: () => void;
  onEdit: (opportunity: Opportunity) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [hiddenClosed, setHiddenClosed] = useState(false);
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const visibleStages = hiddenClosed ? OPPORTUNITY_STAGES.filter((stage) => stage.open) : OPPORTUNITY_STAGES;

  return (
    <section className="space-y-3" data-testid="crm-pipeline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold text-white">Pipeline commercial</h2>
          <p className="text-xs text-slate-400">Glissez une opportunité entre les étapes. Une opportunité gagnée ne crée jamais de créance automatiquement.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setHiddenClosed((value) => !value)}>
            {hiddenClosed ? 'Afficher Gagné / Perdu' : 'Masquer Gagné / Perdu'}
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={onCreate}>Nouvelle opportunité</Button>
        </div>
      </div>
      <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
        {visibleStages.map((stage) => {
          const items = opportunities.filter((opportunity) => opportunity.stage === stage.value);
          const total = items.every((opportunity) => opportunity.amount !== null)
            ? items.reduce((sum, opportunity) => sum + (opportunity.amount ?? 0), 0)
            : null;
          return (
            <div key={stage.value}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData('text/plain') || dragging;
                const opportunity = opportunities.find((item) => item.id === id);
                if (opportunity && opportunity.stage !== stage.value) onStageChange(opportunity, stage.value);
                setDragging(null);
              }}
              className="w-[250px] shrink-0 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5"
              data-testid={`crm-stage-${stage.value}`}>
              <div className="flex items-center justify-between gap-2 px-1">
                <p className={cn('text-[11px] font-semibold', stage.tone)}>{stage.label}</p>
                <span className="text-[10px] text-slate-500">{items.length}</span>
              </div>
              <p className="px-1 pb-2 text-[10px] text-slate-500">{total === null ? 'Montant incomplet' : money(total)}</p>
              <div className="space-y-2">
                {items.map((opportunity) => {
                  const contact = contactById.get(opportunity.contactId);
                  return (
                    <article key={opportunity.id} draggable
                      onDragStart={(event) => { setDragging(opportunity.id); event.dataTransfer.setData('text/plain', opportunity.id); }}
                      className="cursor-grab rounded-lg border border-white/[0.08] bg-[#0b1220] p-2.5 active:cursor-grabbing">
                      <p className="truncate text-xs font-semibold text-white">{opportunity.title || 'Opportunité sans titre'}</p>
                      <p className="truncate text-[10px] text-slate-500">{contact ? contactOptionLabel(contact) : 'Contact non relié'}</p>
                      <p className="mt-1 text-[11px] font-semibold text-cyan-100">{money(opportunity.amount, opportunity.currency)}</p>
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <span className="text-[9px] text-slate-500">{opportunity.probability ?? 0} % · {opportunity.expectedCloseAt || 'sans date'}</span>
                        <button type="button" aria-label="Modifier l’opportunité" onClick={() => onEdit(opportunity)} className="text-slate-500 hover:text-white"><Pencil size={11} /></button>
                      </div>
                      <Select aria-label={`Étape de ${opportunity.title}`} value={opportunity.stage}
                        onChange={(event) => onStageChange(opportunity, event.target.value as OpportunityStage)}
                        className="mt-1.5 py-1 text-[10px]">
                        {OPPORTUNITY_STAGES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                      </Select>
                    </article>
                  );
                })}
                {!items.length && <p className="px-1 py-4 text-center text-[10px] text-slate-600">Aucune opportunité</p>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Centre d'action                                                            */
/* -------------------------------------------------------------------------- */

const ACTION_LABELS: Record<ActionItem['kind'], string> = {
  relance_retard: 'Relance en retard',
  rappeler_aujourdhui: 'À rappeler',
  prospect_chaud: 'Prospect chaud',
  opportunite_stagnante: 'Opportunité stagnante',
  sans_prochaine_action: 'Sans prochaine action',
  client_inactif: 'Client inactif',
  client_a_risque: 'Client à risque',
  nouveau_contact: 'Nouveau contact',
  tache_aujourdhui: 'Tâche du jour',
  promesse_non_respectee: 'Promesse non respectée',
  creance_en_retard: 'Créance en retard',
};

export function ActionCenterPanel({
  actions, contacts, onOpenContact, onPlan, onOpenFinance,
}: {
  actions: ActionItem[];
  contacts: Contact[];
  onOpenContact: (contactId: string) => void;
  onPlan: (action: ActionItem) => void;
  onOpenFinance: () => void;
}) {
  const [kind, setKind] = useState<'toutes' | ActionItem['kind']>('toutes');
  const [severity, setSeverity] = useState<'toutes' | ActionItem['severity']>('toutes');
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const visible = actions.filter((action) => (kind === 'toutes' || action.kind === kind)
    && (severity === 'toutes' || action.severity === severity));
  const kinds = Array.from(new Set(actions.map((action) => action.kind)));

  return (
    <section className="space-y-3" data-testid="crm-actions">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold text-white">Centre d’action commercial</h2>
          <p className="text-xs text-slate-400">Chaque action est calculée depuis vos contacts, tâches et opportunités réelles.</p>
        </div>
        <div className="flex gap-2">
          <Select aria-label="Filtrer par type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="py-1.5 text-xs">
            <option value="toutes">Tous les types</option>
            {kinds.map((entry) => <option key={entry} value={entry}>{ACTION_LABELS[entry]}</option>)}
          </Select>
          <Select aria-label="Filtrer par urgence" value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} className="py-1.5 text-xs">
            <option value="toutes">Toutes urgences</option>
            <option value="urgente">Urgentes</option>
            <option value="elevee">Élevées</option>
            <option value="normale">Normales</option>
          </Select>
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyState icon={<Check size={22} />} title="Rien d’urgent pour le moment" description="Les relances en retard, prospects chauds et opportunités stagnantes apparaîtront ici dès qu’ils existeront." />
      ) : (
        <div className="space-y-2">
          {visible.map((action) => {
            const contact = contactById.get(action.contactId);
            return (
              <article key={action.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                      action.severity === 'urgente' ? 'bg-rose-400/15 text-rose-200'
                        : action.severity === 'elevee' ? 'bg-amber-400/15 text-amber-200' : 'bg-white/10 text-slate-300')}>
                      {action.severity === 'urgente' ? 'Urgent' : action.severity === 'elevee' ? 'Élevé' : 'Normal'}
                    </span>
                    <span className="text-[9px] uppercase tracking-wide text-slate-500">{ACTION_LABELS[action.kind]}</span>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-white">{action.title}</p>
                  <p className="text-[11px] text-slate-400">{action.detail}{contact ? ` · ${contactOptionLabel(contact)}` : ''}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {action.amount !== null && action.amount !== undefined && <span className="text-[11px] font-semibold text-cyan-100">{money(action.amount)}</span>}
                  <Button size="sm" variant="ghost" onClick={() => onOpenContact(action.contactId)}>Fiche</Button>
                  {action.kind === 'creance_en_retard' || action.kind === 'promesse_non_respectee'
                    ? <Button size="sm" variant="outline" onClick={onOpenFinance}>Recouvrement</Button>
                    : <Button size="sm" variant="outline" onClick={() => onPlan(action)}>{action.actionLabel}</Button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tâches                                                                      */
/* -------------------------------------------------------------------------- */

type TaskView = 'aujourdhui' | 'retard' | 'avenir' | 'terminees' | 'toutes';

export function TasksPanel({
  tasks, contacts, onComplete, onReopen, onCreate, onEdit, onDelete,
}: {
  tasks: CrmTask[];
  contacts: Contact[];
  onComplete: (task: CrmTask) => void;
  onReopen: (task: CrmTask) => void;
  onCreate: () => void;
  onEdit: (task: CrmTask) => void;
  onDelete: (task: CrmTask) => void;
}) {
  const [view, setView] = useState<TaskView>('aujourdhui');
  const [query, setQuery] = useState('');
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const today = new Date().toISOString().slice(0, 10);
  const visible = tasks.filter((task) => {
    const due = task.dueDate;
    if (view === 'terminees' && task.status !== 'termine') return false;
    if (view !== 'terminees' && view !== 'toutes' && task.status !== 'a_faire') return false;
    if (view === 'aujourdhui' && due !== today) return false;
    if (view === 'retard' && !(due && due < today)) return false;
    if (view === 'avenir' && !(due && due > today)) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${task.title} ${task.notes} ${contactById.get(task.contactId) ? contactDisplayName(contactById.get(task.contactId)!) : ''}`
      .toLowerCase().includes(needle);
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return (
    <section className="space-y-3" data-testid="crm-tasks">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold text-white">Tâches et suivi commercial</h2>
          <p className="text-xs text-slate-400">Appels, WhatsApp, e-mails, rendez-vous et relances reliés aux contacts réels.</p>
        </div>
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={onCreate}>Nouvelle tâche</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {([
          ['aujourdhui', 'Aujourd’hui'], ['retard', 'En retard'], ['avenir', 'À venir'],
          ['terminees', 'Terminées'], ['toutes', 'Toutes'],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setView(id)}
            className={cn('studio-chip', view === id && 'border-cyan-400/45 bg-cyan-400/10 text-cyan-100')}>
            {label}
            <span className="text-[9px] opacity-70">{tasks.filter((task) => {
              if (id === 'terminees') return task.status === 'termine';
              if (id === 'toutes') return true;
              if (task.status !== 'a_faire') return false;
              if (id === 'aujourdhui') return task.dueDate === today;
              if (id === 'retard') return Boolean(task.dueDate && task.dueDate < today);
              return Boolean(task.dueDate && task.dueDate > today);
            }).length}</span>
          </button>
        ))}
        <div className="ml-auto flex min-w-[180px] items-center gap-1.5 rounded-lg border border-white/10 px-2">
          <Search size={12} className="text-slate-500" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher…" aria-label="Rechercher une tâche"
            className="w-full bg-transparent py-1.5 text-xs text-white outline-none placeholder:text-slate-600" />
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyState icon={<ClipboardList size={22} />} title="Aucune tâche dans cette vue" description="Planifiez une action pour ne pas oublier un suivi." />
      ) : (
        <div className="space-y-2">
          {visible.map((task) => {
            const contact = contactById.get(task.contactId);
            const overdue = task.status === 'a_faire' && task.dueDate && task.dueDate < today;
            return (
              <article key={task.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge status={task.type} tone={task.status === 'termine' ? 'success' : overdue ? 'danger' : 'neutral'}>
                        {TASK_TYPES.find((entry) => entry.value === task.type)?.label ?? task.type}
                      </Badge>
                      <span className="text-[10px] text-slate-500">{task.dueDate || 'sans date'}{task.dueTime ? ` · ${task.dueTime}` : ''}</span>
                      <span className={cn('text-[10px] font-semibold',
                        task.priority === 'urgente' ? 'text-rose-300' : task.priority === 'elevee' ? 'text-amber-300' : 'text-slate-500')}>
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                    </div>
                    <p className={cn('mt-1 text-sm font-semibold', task.status === 'termine' ? 'text-slate-400 line-through' : 'text-white')}>{task.title}</p>
                    <p className="text-[11px] text-slate-400">{contact ? contactOptionLabel(contact) : 'Sans contact'}{task.owner ? ` · ${task.owner}` : ''}</p>
                    {task.notes && <p className="mt-1 text-[11px] text-slate-500">{task.notes}</p>}
                    {task.outcome && <p className="mt-1 rounded bg-emerald-400/[0.06] px-2 py-1 text-[11px] text-emerald-100">Résultat : {task.outcome}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    {task.status === 'a_faire'
                      ? <Button size="sm" variant="outline" icon={<Check size={12} />} onClick={() => onComplete(task)}>Terminer</Button>
                      : <Button size="sm" variant="ghost" onClick={() => onReopen(task)}>Rouvrir</Button>}
                    <Button size="sm" variant="ghost" aria-label="Modifier la tâche" onClick={() => onEdit(task)}><Pencil size={12} /></Button>
                    <Button size="sm" variant="ghost" aria-label="Supprimer la tâche" onClick={() => onDelete(task)}><Trash2 size={12} /></Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Relances intelligentes                                                     */
/* -------------------------------------------------------------------------- */

export function RemindersPanel({ contacts }: { contacts: Contact[] }) {
  const toast = useToast();
  const [contactId, setContactId] = useState('');
  const [templateId, setTemplateId] = useState(MESSAGE_TEMPLATES[0].id);
  const [channel, setChannel] = useState<'whatsapp' | 'email' | 'sms'>(MESSAGE_TEMPLATES[0].channel);
  const [message, setMessage] = useState('');
  const [variables, setVariables] = useState({ product: '', amount: '', date: '' });
  const contact = contacts.find((item) => item.id === contactId) ?? null;
  const template = MESSAGE_TEMPLATES.find((entry) => entry.id === templateId) ?? MESSAGE_TEMPLATES[0];

  const generate = (nextContact = contact, nextTemplate = template) => {
    if (!nextContact) { toast.warning('Choisissez d’abord un contact.'); return; }
    const text = renderTemplate(nextTemplate.body, {
      contact: contactDisplayName(nextContact),
      entreprise: nextContact.company,
      responsable: nextContact.owner || 'Votre équipe',
      produit: variables.product,
      montant: variables.amount,
      date: variables.date || nextContact.nextActionAt,
    });
    setMessage(text);
    setChannel(nextTemplate.channel);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.success('Message copié. Aucun envoi automatique n’a été effectué.');
    } catch {
      toast.warning('Copie impossible sur cet appareil. Sélectionnez le texte manuellement.');
    }
  };

  return (
    <section className="space-y-3" data-testid="crm-reminders">
      <div>
        <h2 className="font-display text-lg font-semibold text-white">Relances préparées</h2>
        <p className="text-xs text-slate-400">Les messages sont générés et copiés. Aucun envoi automatique : vous validez et ouvrez votre application.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <Select label="Contact" value={contactId} onChange={(event) => { setContactId(event.target.value); const next = contacts.find((item) => item.id === event.target.value); if (next) generate(next); }}>
            <option value="">Choisir un contact…</option>
            {contacts.map((item) => <option key={item.id} value={item.id}>{contactOptionLabel(item)}</option>)}
          </Select>
          <Select label="Modèle" value={templateId} onChange={(event) => { setTemplateId(event.target.value); const next = MESSAGE_TEMPLATES.find((entry) => entry.id === event.target.value); if (next) generate(contact, next); }}>
            {MESSAGE_TEMPLATES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </Select>
          <Select label="Canal" value={channel} onChange={(event) => setChannel(event.target.value as typeof channel)}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">E-mail</option>
            <option value="sms">SMS</option>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Produit" value={variables.product} onChange={(event) => setVariables({ ...variables, product: event.target.value })} />
            <Input label="Montant" value={variables.amount} onChange={(event) => setVariables({ ...variables, amount: event.target.value })} />
            <Input label="Date" type="date" value={variables.date} onChange={(event) => setVariables({ ...variables, date: event.target.value })} />
          </div>
          <Button variant="outline" onClick={() => generate()} disabled={!contactId}>Générer le message</Button>
        </div>
        <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <Textarea label="Message (modifiable)" rows={9} value={message} onChange={(event) => setMessage(event.target.value)}
            placeholder="Choisissez un contact et un modèle pour générer un message." />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copy()} disabled={!message}>Copier</Button>
            {contact?.whatsapp || contact?.phone ? (
              <a className="btn btn-outline btn-sm" href={whatsappLink(contact.whatsapp || contact.phone, message)} target="_blank" rel="noreferrer">
                <MessageCircle size={12} /> Ouvrir WhatsApp
              </a>
            ) : null}
            {contact?.email ? (
              <a className="btn btn-outline btn-sm" href={mailtoLink(contact.email, `Message pour ${contactDisplayName(contact)}`, message)}>
                <Mail size={12} /> Ouvrir l’e-mail
              </a>
            ) : null}
            {contact?.phone ? (
              <a className="btn btn-ghost btn-sm" href={`tel:${contact.phone.replace(/\s/g, '')}`}><Phone size={12} /> Appeler</a>
            ) : null}
          </div>
          <p className="text-[10px] text-slate-500">Les variables non renseignées restent visibles entre crochets : complétez-les avant l’envoi.</p>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Segments                                                                   */
/* -------------------------------------------------------------------------- */

export function SegmentBar({
  filters, onChange, resultCount, segments, onSave, onApply, onDelete,
}: {
  filters: SegmentFilters;
  onChange: (filters: SegmentFilters) => void;
  resultCount: number;
  segments: CrmSegment[];
  onSave: (name: string) => Promise<void>;
  onApply: (segment: CrmSegment) => void;
  onDelete: (segment: CrmSegment) => void;
}) {
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3" data-testid="crm-segments">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-lg border border-white/10 px-2">
          <Search size={12} className="text-slate-500" />
          <input value={filters.query} onChange={(event) => onChange({ ...filters, query: event.target.value })}
            placeholder="Rechercher un contact, une entreprise, une ville…" aria-label="Rechercher un contact"
            className="w-full bg-transparent py-1.5 text-xs text-white outline-none placeholder:text-slate-600" />
        </div>
        <Select aria-label="Type de contact" value={filters.type} onChange={(event) => onChange({ ...filters, type: event.target.value as SegmentFilters['type'] })} className="w-auto py-1.5 text-xs">
          <option value="tous">Tous types</option>
          {CONTACT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        </Select>
        <Select aria-label="Source" value={filters.source} onChange={(event) => onChange({ ...filters, source: event.target.value })} className="w-auto py-1.5 text-xs">
          <option value="">Toutes sources</option>
          {CONTACT_SOURCES.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
        </Select>
        <Select aria-label="Priorité" value={filters.priority} onChange={(event) => onChange({ ...filters, priority: event.target.value as SegmentFilters['priority'] })} className="w-auto py-1.5 text-xs">
          <option value="toutes">Toutes priorités</option>
          <option value="urgente">Urgente</option><option value="elevee">Élevée</option>
          <option value="normale">Normale</option><option value="faible">Faible</option>
        </Select>
        <Button size="sm" variant="ghost" icon={<Filter size={12} />} onClick={() => setOpen((value) => !value)}>
          Filtres avancés
        </Button>
        <span className="text-[10px] text-slate-500">{resultCount} contact(s)</span>
      </div>
      {open && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="Tag" value={filters.tag} onChange={(event) => onChange({ ...filters, tag: event.target.value })} placeholder="vip" />
          <Input label="Responsable" value={filters.owner} onChange={(event) => onChange({ ...filters, owner: event.target.value })} />
          <Input label="Ville" value={filters.city} onChange={(event) => onChange({ ...filters, city: event.target.value })} />
          <Input label="Pays" value={filters.country} onChange={(event) => onChange({ ...filters, country: event.target.value })} />
          <Input label="Inactif depuis (jours)" type="number" min={0} value={filters.inactiveDays ?? ''} onChange={(event) => onChange({ ...filters, inactiveDays: event.target.value === '' ? null : Number(event.target.value) })} />
          <Input label="Score minimum" type="number" min={0} max={100} value={filters.minScore ?? ''} onChange={(event) => onChange({ ...filters, minScore: event.target.value === '' ? null : Number(event.target.value) })} />
          <Input label="Valeur ouverte min." type="number" min={0} value={filters.minOpenValue ?? ''} onChange={(event) => onChange({ ...filters, minOpenValue: event.target.value === '' ? null : Number(event.target.value) })} />
          <div className="flex flex-col gap-1.5 pt-1">
            <label className="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={filters.hasOpenOpportunity} onChange={(event) => onChange({ ...filters, hasOpenOpportunity: event.target.checked })} /> Opportunité ouverte</label>
            <label className="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={filters.hasOverdueTask} onChange={(event) => onChange({ ...filters, hasOverdueTask: event.target.checked })} /> Tâche en retard</label>
            <label className="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={filters.atRisk} onChange={(event) => onChange({ ...filters, atRisk: event.target.checked })} /> Client à risque</label>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nom du segment à sauvegarder"
          aria-label="Nom du segment" className="min-w-[160px] flex-1 rounded-lg border border-white/10 bg-transparent px-2 py-1.5 text-xs text-white outline-none placeholder:text-slate-600" />
        <Button size="sm" variant="outline" icon={<Layers size={12} />} disabled={!name.trim()}
          onClick={() => { const value = name.trim(); if (!value) return; void onSave(value).then(() => setName('')).catch((error) => { throw error; }); }}>
          Sauvegarder
        </Button>
        {segments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {segments.map((segment) => (
              <span key={segment.id} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-slate-300">
                <button type="button" onClick={() => onApply(segment)} className="hover:text-white">{segment.name}</button>
                <button type="button" aria-label={`Supprimer ${segment.name}`} onClick={() => onDelete(segment)} className="text-slate-500 hover:text-rose-300"><Trash2 size={10} /></button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Import CSV et doublons                                                     */
/* -------------------------------------------------------------------------- */

export function ImportPanel({
  contacts, onCreate, onUpdate, legacyProspects, onImportLegacy, onExport,
}: {
  contacts: Contact[];
  onCreate: (data: Record<string, unknown>) => Promise<string>;
  onUpdate: (id: string, data: Record<string, unknown>) => Promise<void>;
  legacyProspects: Array<{ id: string; name: string; company: string; email: string; phone: string; stage: string; value: number | null; currency: string; nextAction: string; nextActionAt: string; notes: string }>;
  onImportLegacy: () => Promise<void>;
  onExport: () => void;
}) {
  const toast = useToast();
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<'ajout' | 'mise_a_jour'>('ajout');
  const [preview, setPreview] = useState<ImportRowResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ created: number; updated: number; skipped: number; failed: number } | null>(null);

  const readFile = async (file: File) => {
    setReport(null);
    const text = await file.text();
    const { parseCsv } = await import('./model');
    const parsed = parseCsv(text);
    if (!parsed.length) { toast.error('Fichier vide ou illisible.'); return; }
    setHeaders(parsed[0]);
    setRows(parsed.slice(1).slice(0, 5000));
    const guessed = guessMapping(parsed[0]);
    setMapping(Object.fromEntries(Object.entries(guessed).map(([index, key]) => [index, key])));
    setPreview(null);
  };

  const runPreview = () => {
    const typedMapping = Object.fromEntries(Object.entries(mapping).map(([index, key]) => [Number(index), key])) as Record<number, keyof Contact | 'ignore'>;
    setPreview(buildContactsFromRows(rows, typedMapping));
  };

  const existingFor = (data: Record<string, unknown>): Contact | null => {
    const email = normalizeEmail(data.email);
    const phone = String(data.phone ?? data.whatsapp ?? '');
    return contacts.find((contact) => (email && contact.email === email) || (phone && phonesMatch(phone, contact.phone || contact.whatsapp))) ?? null;
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    let created = 0; let updated = 0; let skipped = 0; let failed = 0;
    try {
      for (const row of preview) {
        if (!row.data) { skipped += 1; continue; }
        const existing = existingFor(row.data);
        try {
          if (mode === 'mise_a_jour' && existing) {
            await onUpdate(existing.id, { ...row.data });
            updated += 1;
          } else if (existing) {
            skipped += 1;
          } else {
            await onCreate(row.data);
            created += 1;
          }
        } catch {
          failed += 1;
        }
      }
      setReport({ created, updated, skipped, failed });
      toast.success(`Import terminé : ${created} créé(s), ${updated} mis à jour, ${skipped} ignoré(s), ${failed} en échec.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" data-testid="crm-import">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold text-white">Import et export</h2>
          <p className="text-xs text-slate-400">CSV analysé dans votre navigateur. Aucune donnée n’est envoyée à un tiers. L’import partiel conserve les lignes valides.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={onExport}>Exporter les contacts</Button>
          {legacyProspects.length > 0 && (
            <Button size="sm" variant="outline" icon={<UserCheck size={12} />}
              onClick={() => { void onImportLegacy().catch((error) => toast.error(asAppError(error).message)); }}>
              Importer {legacyProspects.length} prospect(s) existant(s)
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <label className="field">
            <span className="field-label">Fichier CSV</span>
            <input type="file" accept=".csv,text/csv,text/plain" aria-label="Fichier CSV"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }}
              className="input py-2 text-xs" />
            <span className="field-hint">Séparateurs acceptés : virgule, point-virgule ou tabulation. Première ligne = en-têtes.</span>
          </label>
          <Select label="Mode d’import" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="ajout">Ajouter uniquement les nouveaux contacts</option>
            <option value="mise_a_jour">Mettre à jour les contacts reconnus</option>
          </Select>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" icon={<FileSpreadsheet size={12} />} onClick={runPreview} disabled={!rows.length}>Prévisualiser</Button>
            <Button size="sm" variant="primary" icon={<Upload size={12} />} onClick={() => void runImport()} disabled={!preview || busy} loading={busy}>Importer</Button>
          </div>
          {report && (
            <div className="rounded-lg border border-white/10 bg-black/20 p-2 text-[11px] text-slate-300">
              Créés : <strong className="text-emerald-200">{report.created}</strong> · Mis à jour : <strong className="text-cyan-200">{report.updated}</strong> ·
              Ignorés : <strong>{report.skipped}</strong> · En échec : <strong className="text-rose-200">{report.failed}</strong>
            </div>
          )}
        </div>
        <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <p className="text-xs font-semibold text-white">Correspondance des colonnes</p>
          {!headers.length ? <p className="text-[11px] text-slate-500">Choisissez un fichier pour détecter les colonnes.</p> : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {headers.map((header, index) => (
                <div key={`${header}-${index}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">{header || `Colonne ${index + 1}`}</span>
                  <select aria-label={`Colonne ${header || index + 1}`} value={mapping[index] ?? 'ignore'}
                    onChange={(event) => setMapping({ ...mapping, [index]: event.target.value })}
                    className="rounded-lg border border-white/10 bg-[#0b1220] px-2 py-1 text-[10px] text-white">
                    <option value="ignore">Ignorer</option>
                    <option value="firstName">Prénom</option><option value="lastName">Nom</option>
                    <option value="company">Entreprise</option><option value="jobTitle">Fonction</option>
                    <option value="phone">Téléphone</option><option value="whatsapp">WhatsApp</option>
                    <option value="email">E-mail</option><option value="address">Adresse</option>
                    <option value="city">Ville</option><option value="country">Pays</option>
                    <option value="source">Source</option><option value="type">Type</option>
                    <option value="tags">Tags</option><option value="owner">Responsable</option>
                    <option value="notes">Notes</option><option value="lastContactAt">Dernier contact</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {preview && (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <p className="mb-2 text-xs font-semibold text-white">Aperçu ({preview.filter((row) => row.data).length} ligne(s) valide(s), {preview.filter((row) => row.errors.length).length} en erreur)</p>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="text-slate-500"><tr><th className="py-1">Ligne</th><th>Contact</th><th>Entreprise</th><th>E-mail</th><th>Statut</th></tr></thead>
              <tbody>
                {preview.slice(0, 20).map((row) => (
                  <tr key={row.row} className="border-t border-white/[0.05] text-slate-300">
                    <td className="py-1">{row.row}</td>
                    <td>{[row.data?.firstName, row.data?.lastName].filter(Boolean).join(' ') || '—'}</td>
                    <td>{String(row.data?.company ?? '—')}</td>
                    <td>{String(row.data?.email ?? '—')}</td>
                    <td className={row.errors.length ? 'text-rose-300' : existingFor(row.data ?? {}) ? 'text-amber-300' : 'text-emerald-300'}>
                      {row.errors.length ? row.errors[0] : existingFor(row.data ?? {}) ? 'Doublon détecté' : 'Prêt'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export function DuplicatesPanel({ contacts, onMerge }: {
  contacts: Contact[];
  onMerge: (kept: Contact, duplicate: Contact, choices: Record<string, 'left' | 'right' | 'combine'>) => Promise<void>;
}) {
  const [open, setOpen] = useState<Contact[] | null>(null);
  const [choices, setChoices] = useState<Record<string, 'left' | 'right' | 'combine'>>({});
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => detectDuplicates(contacts).slice(0, 50), [contacts]);
  const fields: Array<{ key: keyof Contact; label: string }> = [
    { key: 'firstName', label: 'Prénom' }, { key: 'lastName', label: 'Nom' },
    { key: 'company', label: 'Entreprise' }, { key: 'phone', label: 'Téléphone' },
    { key: 'email', label: 'E-mail' }, { key: 'city', label: 'Ville' },
    { key: 'owner', label: 'Responsable' }, { key: 'notes', label: 'Notes' },
  ];

  return (
    <section className="space-y-3" data-testid="crm-duplicates">
      <div>
        <h2 className="font-display text-lg font-semibold text-white">Doublons potentiels</h2>
        <p className="text-xs text-slate-400">Aucune fusion automatique. Chaque rapprochement indique pourquoi il est proposé, et vous choisissez les données conservées.</p>
      </div>
      {candidates.length === 0 ? (
        <EmptyState icon={<Users size={22} />} title="Aucun doublon détecté" description="La détection compare les e-mails, les téléphones normalisés, les noms et les entreprises." />
      ) : (
        <div className="space-y-2">
          {candidates.map((candidate) => (
            <article key={`${candidate.left.id}-${candidate.right.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">{contactDisplayName(candidate.left)} <ArrowRight size={11} className="inline" /> {contactDisplayName(candidate.right)}</p>
                <p className="text-[11px] text-slate-400">{candidate.reasons.join(' · ')}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  candidate.confidence >= 80 ? 'bg-rose-400/15 text-rose-200' : candidate.confidence >= 60 ? 'bg-amber-400/15 text-amber-200' : 'bg-white/10 text-slate-300')}>
                  Confiance {candidate.confidence} %
                </span>
                <Button size="sm" variant="outline" onClick={() => { setOpen([candidate.left, candidate.right]); setChoices({}); }}>Comparer et fusionner</Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title="Fusionner deux fiches" size="lg"
        description="Choisissez la valeur conservée pour chaque champ. La fiche de droite est ensuite supprimée : son historique est réaffecté à la fiche conservée."
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(null)}>Annuler</Button>
          <Button variant="danger" loading={busy} onClick={() => {
            if (!open) return;
            setBusy(true);
            void onMerge(open[0], open[1], choices)
              .then(() => { setOpen(null); setChoices({}); })
              .catch((error) => { throw error; })
              .finally(() => setBusy(false));
          }}>Fusionner définitivement</Button>
        </>}>
        {open && (
          <div className="space-y-2">
            {fields.map((field) => {
              const left = String(open[0][field.key] ?? '');
              const right = String(open[1][field.key] ?? '');
              if (!left && !right) return null;
              return (
                <div key={field.key} className="grid grid-cols-[90px_1fr_1fr] items-center gap-2 text-[11px]">
                  <span className="text-slate-500">{field.label}</span>
                  <button type="button" onClick={() => setChoices({ ...choices, [field.key]: 'left' })}
                    className={cn('rounded border px-2 py-1 text-left', (choices[field.key] ?? (left ? 'left' : 'right')) === 'left' ? 'border-cyan-400/40 bg-cyan-400/10 text-white' : 'border-white/10 text-slate-400')}>
                    {left || '—'}
                  </button>
                  <button type="button" onClick={() => setChoices({ ...choices, [field.key]: 'right' })}
                    className={cn('rounded border px-2 py-1 text-left', choices[field.key] === 'right' ? 'border-cyan-400/40 bg-cyan-400/10 text-white' : 'border-white/10 text-slate-400')}>
                    {right || '—'}
                  </button>
                </div>
              );
            })}
            <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-2 text-[11px] text-amber-100">
              <AlertTriangle size={12} className="mr-1 inline" />
              Vérifiez le contact à conserver : la fusion ne propose pas d’annulation automatique.
            </p>
          </div>
        )}
      </Modal>
    </section>
  );
}

export function SegmentExport({ contacts, filename }: { contacts: Contact[]; filename: string }) {
  return (
    <Button size="sm" variant="ghost" icon={<Download size={12} />}
      onClick={() => downloadCsv(filename, ['Prénom,Nom,Entreprise,E-mail,Téléphone,Ville,Statut', ...contacts.map((contact) => [
        contact.firstName, contact.lastName, contact.company, contact.email, contact.phone, contact.city, contact.status,
      ].map(csvEscape).join(','))].join('\r\n'))}>
      Exporter ce segment
    </Button>
  );
}

export function ScoreChip({ score, priority }: { score: number; priority: Priority }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
      priority === 'urgente' ? 'bg-rose-400/15 text-rose-200'
        : priority === 'elevee' ? 'bg-amber-400/15 text-amber-200'
          : priority === 'normale' ? 'bg-cyan-400/15 text-cyan-200' : 'bg-white/10 text-slate-300')}>
      <Target size={10} /> {score} · {PRIORITY_LABELS[priority]}
    </span>
  );
}

export { downloadCsv, contactOptionLabel };
