/**
 * VYORA Growth OS — Lot I : marketing et fidélisation.
 *
 * Une campagne prépare un message par contact à partir d'un segment CRM. Aucun
 * envoi automatique n'existe : l'utilisateur copie, ouvre son application
 * externe ou marque la campagne comme planifiée. Les résultats ne sont affichés
 * que si des données réelles existent.
 */

import { dateOnly, daysBetween, todayIso } from '../crm/model';
import type { Contact } from '../crm/model';

export type CampaignChannel = 'whatsapp' | 'email' | 'sms';
export type CampaignStatus = 'brouillon' | 'prete' | 'planifiee' | 'terminee' | 'annulee';

export interface Campaign {
  id: string;
  name: string;
  objective: string;
  segmentId: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  plannedAt: string;
  templateId: string;
  message: string;
  notes: string;
  createdAt: string;
}

export interface CampaignRecipient {
  contactId: string;
  name: string;
  phone: string;
  email: string;
  message: string;
}

export const CAMPAIGN_CHANNELS: readonly { value: CampaignChannel; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'E-mail' },
  { value: 'sms', label: 'SMS' },
];

export const CAMPAIGN_STATUSES: readonly { value: CampaignStatus; label: string }[] = [
  { value: 'brouillon', label: 'Brouillon' },
  { value: 'prete', label: 'Prête à envoyer' },
  { value: 'planifiee', label: 'Planifiée' },
  { value: 'terminee', label: 'Terminée' },
  { value: 'annulee', label: 'Annulée' },
];

export const MARKETING_TEMPLATES: readonly { id: string; name: string; objective: string; body: string }[] = [
  { id: 'reactivation', name: 'Réactivation', objective: 'Réactiver un client inactif', body: 'Bonjour {{contact}}, cela fait un moment que nous n’avons pas eu de vos nouvelles. Nous avons de nouvelles offres qui pourraient vous intéresser. — {{entreprise}}' },
  { id: 'fidelisation', name: 'Remerciement fidélité', objective: 'Fidéliser un client actif', body: 'Bonjour {{contact}}, merci pour votre confiance. Nous réservons une attention particulière à nos clients fidèles comme vous. — {{entreprise}}' },
  { id: 'nouveaute', name: 'Nouveauté', objective: 'Annoncer une nouveauté', body: 'Bonjour {{contact}}, nous avons le plaisir de vous présenter notre nouveauté : {{produit}}. Contactez-nous pour en savoir plus. — {{entreprise}}' },
  { id: 'anniversaire', name: 'Anniversaire', objective: 'Marquer une occasion', body: 'Bonjour {{contact}}, toute l’équipe {{entreprise}} vous souhaite un très bel anniversaire.' },
  { id: 'feedback', name: 'Demande de feedback', objective: 'Recueillir un avis', body: 'Bonjour {{contact}}, votre avis compte pour nous. Pourriez-vous nous dire ce que vous avez pensé de {{produit}} ? — {{entreprise}}' },
];

export const MARKETING_CATEGORIES = {
  campaigns: 'bg_module_marketing_campaigns',
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function campaignFromRecord(record: { id: string; data: Record<string, unknown>; created_at?: string }): Campaign {
  const data = record.data ?? {};
  return {
    id: record.id,
    name: str(data.name, 160) || 'Campagne sans nom',
    objective: str(data.objective, 240),
    segmentId: str(data.segmentId, 64),
    channel: oneOf<CampaignChannel>(data.channel, ['whatsapp', 'email', 'sms'], 'whatsapp'),
    status: oneOf<CampaignStatus>(data.status, ['brouillon', 'prete', 'planifiee', 'terminee', 'annulee'], 'brouillon'),
    plannedAt: dateOnly(data.plannedAt),
    templateId: str(data.templateId, 60),
    message: str(data.message, 2000),
    notes: str(data.notes, 1000),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

export function campaignToData(campaign: Campaign): Record<string, unknown> {
  return {
    name: campaign.name, objective: campaign.objective, segmentId: campaign.segmentId,
    channel: campaign.channel, status: campaign.status, plannedAt: campaign.plannedAt,
    templateId: campaign.templateId, message: campaign.message, notes: campaign.notes,
  };
}

export function renderCampaignMessage(template: string, contact: Pick<Contact, 'firstName' | 'lastName' | 'company' | 'city'>, companyName: string, extra: { produit?: string; montant?: string } = {}): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.company || 'Madame, Monsieur';
  return template
    .replace(/\{\{contact\}\}/g, name)
    .replace(/\{\{entreprise\}\}/g, companyName || contact.company || 'notre entreprise')
    .replace(/\{\{ville\}\}/g, contact.city)
    .replace(/\{\{produit\}\}/g, extra.produit ?? 'nos produits')
    .replace(/\{\{montant\}\}/g, extra.montant ?? '');
}

export function buildRecipients(
  campaign: Campaign,
  contacts: readonly Contact[],
  companyName: string,
  segmentContactIds: ReadonlySet<string> | null,
): CampaignRecipient[] {
  return contacts
    .filter((contact) => contact.status !== 'archive')
    .filter((contact) => !segmentContactIds || segmentContactIds.has(contact.id))
    .filter((contact) => campaign.channel === 'email' ? Boolean(contact.email) : Boolean(contact.whatsapp || contact.phone))
    .map((contact) => ({
      contactId: contact.id,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.company || 'Contact',
      phone: contact.whatsapp || contact.phone,
      email: contact.email,
      message: renderCampaignMessage(campaign.message, contact, companyName),
    }));
}

export function whatsappLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function mailtoLink(email: string, campaign: Campaign, message: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(campaign.name)}&body=${encodeURIComponent(message)}`;
}

export function inactiveClients(contacts: readonly Contact[], days = 60, today = todayIso()): Contact[] {
  return contacts.filter((contact) => {
    if (contact.type !== 'client' || contact.status === 'archive') return false;
    const elapsed = contact.lastContactAt ? daysBetween(contact.lastContactAt, today) : null;
    return elapsed === null || elapsed >= days;
  });
}

export function validateCampaign(campaign: Pick<Campaign, 'name' | 'message' | 'plannedAt' | 'status'>): string[] {
  const errors: string[] = [];
  if (!campaign.name.trim()) errors.push('Le nom de la campagne est obligatoire.');
  if (!campaign.message.trim()) errors.push('Le message est vide.');
  if (campaign.status === 'planifiee' && !dateOnly(campaign.plannedAt)) errors.push('Une campagne planifiée doit avoir une date.');
  if (campaign.message.length > 2000) errors.push('Le message dépasse 2 000 caractères.');
  return errors;
}

export interface MarketingSummary {
  total: number;
  ready: number;
  scheduled: number;
  completed: number;
  inactiveClients: number;
  campaignsWithoutDate: number;
}

export function computeMarketingSummary(campaigns: readonly Campaign[], contacts: readonly Contact[]): MarketingSummary {
  return {
    total: campaigns.length,
    ready: campaigns.filter((campaign) => campaign.status === 'prete').length,
    scheduled: campaigns.filter((campaign) => campaign.status === 'planifiee').length,
    completed: campaigns.filter((campaign) => campaign.status === 'terminee').length,
    inactiveClients: inactiveClients(contacts).length,
    campaignsWithoutDate: campaigns.filter((campaign) => campaign.status === 'planifiee' && !campaign.plannedAt).length,
  };
}

export function campaignsToCsv(campaigns: readonly Campaign[], segmentName: (id: string) => string): string {
  const esc = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Nom', 'Objectif', 'Segment', 'Canal', 'Statut', 'Date prévue'];
  return [header.join(','), ...campaigns.map((campaign) => [
    campaign.name, campaign.objective, segmentName(campaign.segmentId), campaign.channel,
    campaign.status, campaign.plannedAt,
  ].map(esc).join(','))].join('\r\n');
}
