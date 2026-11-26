/**
 * Document commercial — PDF propre, lien partageable, statut « vu ».
 *
 * ## Ce que fait ce module
 *  - il rend un document imprimable (donc « PDF » via l'impression du
 *    navigateur, sans dépendance payante) dans la LANGUE du client, avec la
 *    devise réellement utilisée et des montants qui ne mélangent jamais deux
 *    devises ;
 *  - il produit un LIEN DE PARTAGE réellement transmissible : la charge utile
 *    est encodée dans le fragment d'URL (`#…`), qui n'est jamais envoyé à un
 *    serveur. Aucun secret, aucune donnée d'un autre espace n'y figure ;
 *  - il marque un document comme « vu » quand le lien est ouvert, ce qui donne
 *    un statut utile côté vendeur.
 *
 * ## Ce que ce module ne prétend PAS faire
 * Un fragment d'URL ne prouve pas l'identité du lecteur : le statut « vu »
 * signifie « ce lien a été ouvert », pas « le client l'a lu ». On l'affiche ainsi.
 */

export type LangueDocument = 'fr' | 'en' | 'es' | 'ar';

export const LANGUES_DOCUMENT: readonly { value: LangueDocument; label: string; titre: (kind: string) => string }[] = [
  { value: 'fr', label: 'Français', titre: (kind) => kind },
  { value: 'en', label: 'English', titre: (kind) => ({ devis: 'Quote', facture: 'Invoice', commande: 'Order' } as Record<string, string>)[kind] ?? kind },
  { value: 'es', label: 'Español', titre: (kind) => ({ devis: 'Presupuesto', facture: 'Factura', commande: 'Pedido' } as Record<string, string>)[kind] ?? kind },
  { value: 'ar', label: 'العربية', titre: (kind) => ({ devis: 'عرض سعر', facture: 'فاتورة', commande: 'طلب' } as Record<string, string>)[kind] ?? kind },
];

const LIBELLES: Record<LangueDocument, Record<string, string>> = {
  fr: { designation: 'Désignation', quantite: 'Qté', prix: 'Prix unitaire', remise: 'Remise', tva: 'TVA', total: 'Total', sousTotal: 'Sous-total', taxes: 'Taxes', emis: 'Émis le', echeance: 'Échéance', client: 'Client' },
  en: { designation: 'Description', quantite: 'Qty', prix: 'Unit price', remise: 'Discount', tva: 'VAT', total: 'Total', sousTotal: 'Subtotal', taxes: 'Taxes', emis: 'Issued on', echeance: 'Due on', client: 'Customer' },
  es: { designation: 'Descripción', quantite: 'Cant.', prix: 'Precio unitario', remise: 'Descuento', tva: 'IVA', total: 'Total', sousTotal: 'Subtotal', taxes: 'Impuestos', emis: 'Emitido el', echeance: 'Vence el', client: 'Cliente' },
  ar: { designation: 'البيان', quantite: 'الكمية', prix: 'سعر الوحدة', remise: 'خصم', tva: 'ضريبة', total: 'المجموع', sousTotal: 'المجموع الفرعي', taxes: 'الضرائب', emis: 'صدر في', echeance: 'يستحق في', client: 'العميل' },
};

export interface LigneDocument {
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
}

export interface DocumentPartageable {
  kind: 'devis' | 'facture' | 'commande';
  number: string;
  issuedAt: string;
  dueDate: string;
  currency: string;
  terms: string;
  lines: readonly LigneDocument[];
  clientNom: string;
  entreprise: string;
}

function echapper(valeur: string): string {
  return valeur.replace(/[&<>"]/g, (caractere) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[caractere] ?? caractere
  ));
}

/** Montant formaté dans la devise réelle ; jamais un symbole inventé. */
export function formaterMontant(montant: number, devise: string, langue: LangueDocument = 'fr'): string {
  const locales: Record<LangueDocument, string> = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', ar: 'ar-MA' };
  try {
    return new Intl.NumberFormat(locales[langue], {
      style: 'currency', currency: devise || 'XOF', maximumFractionDigits: 2,
    }).format(montant);
  } catch {
    const nombre = new Intl.NumberFormat(locales[langue], { maximumFractionDigits: 2 }).format(montant);
    return `${nombre} ${devise}`.trim();
  }
}

function totaux(lignes: readonly LigneDocument[]) {
  let sousTotal = 0, remise = 0, taxes = 0;
  for (const ligne of lignes) {
    const brut = ligne.quantity * ligne.unitPrice;
    const reduction = brut * (ligne.discountPct / 100);
    sousTotal += brut;
    remise += reduction;
    taxes += (brut - reduction) * (ligne.taxPct / 100);
  }
  const arrondi = (valeur: number) => Math.round(valeur * 100) / 100;
  return {
    sousTotal: arrondi(sousTotal),
    remise: arrondi(remise),
    taxes: arrondi(taxes),
    total: arrondi(sousTotal - remise + taxes),
  };
}

/**
 * Document imprimable propre, dans la langue du client, prêt pour « Enregistrer
 * en PDF » du navigateur. Le sens d'écriture suit la langue (arabe = RTL).
 */
export function documentImprimable(document: DocumentPartageable, langue: LangueDocument = 'fr'): string {
  const libelles = LIBELLES[langue];
  const direction = langue === 'ar' ? 'rtl' : 'ltr';
  const titre = LANGUES_DOCUMENT.find((item) => item.value === langue)?.titre(document.kind) ?? document.kind;
  const somme = totaux(document.lines);
  const lignes = document.lines.map((ligne) => {
    const brut = ligne.quantity * ligne.unitPrice;
    const net = brut * (1 - ligne.discountPct / 100) * (1 + ligne.taxPct / 100);
    return `<tr>
      <td>${echapper(ligne.description)}</td>
      <td class="num">${ligne.quantity}</td>
      <td class="num">${echapper(formaterMontant(ligne.unitPrice, document.currency, langue))}</td>
      <td class="num">${ligne.discountPct}%</td>
      <td class="num">${ligne.taxPct}%</td>
      <td class="num">${echapper(formaterMontant(net, document.currency, langue))}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html lang="${langue}" dir="${direction}"><head><meta charset="utf-8">
<title>${echapper(titre)} ${echapper(document.number)}</title>
<style>
  @page { margin: 18mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; padding: 24px; }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #555; font-size: 12.5px; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 22px; }
  th, td { border-bottom: 1px solid #e2e2e2; padding: 7px 6px; font-size: 12.5px; text-align: ${direction === 'rtl' ? 'right' : 'left'}; }
  .num { text-align: ${direction === 'rtl' ? 'left' : 'right'}; white-space: nowrap; }
  tfoot td { font-weight: 600; border: none; padding: 4px 6px; }
  .total td { font-size: 14px; border-top: 2px solid #111; }
  .pied { margin-top: 26px; font-size: 11.5px; color: #666; }
  @media print { body { padding: 0; } }
</style></head><body>
<header>
  <div>
    <h1>${echapper(titre)} ${echapper(document.number)}</h1>
    <p class="meta">${echapper(document.entreprise)}</p>
    <p class="meta">${echapper(libelles.client)} : ${echapper(document.clientNom || '—')}</p>
  </div>
  <div>
    <p class="meta">${echapper(libelles.emis)} ${echapper(document.issuedAt || '—')}</p>
    ${document.dueDate ? `<p class="meta">${echapper(libelles.echeance)} ${echapper(document.dueDate)}</p>` : ''}
  </div>
</header>
<table>
  <thead><tr>
    <th>${echapper(libelles.designation)}</th>
    <th class="num">${echapper(libelles.quantite)}</th>
    <th class="num">${echapper(libelles.prix)}</th>
    <th class="num">${echapper(libelles.remise)}</th>
    <th class="num">${echapper(libelles.tva)}</th>
    <th class="num">${echapper(libelles.total)}</th>
  </tr></thead>
  <tbody>${lignes}</tbody>
  <tfoot>
    <tr><td colspan="5">${echapper(libelles.sousTotal)}</td><td class="num">${echapper(formaterMontant(somme.sousTotal, document.currency, langue))}</td></tr>
    <tr><td colspan="5">${echapper(libelles.remise)}</td><td class="num">-${echapper(formaterMontant(somme.remise, document.currency, langue))}</td></tr>
    <tr><td colspan="5">${echapper(libelles.taxes)}</td><td class="num">${echapper(formaterMontant(somme.taxes, document.currency, langue))}</td></tr>
    <tr class="total"><td colspan="5">${echapper(libelles.total)}</td><td class="num">${echapper(formaterMontant(somme.total, document.currency, langue))}</td></tr>
  </tfoot>
</table>
${document.terms ? `<p class="pied">${echapper(document.terms)}</p>` : ''}
</body></html>`;
}

/* -------------------------------------------------------------- partage */

const VERSION_PARTAGE = 1;

/** Charge utile compacte : aucune donnée d'un autre espace, aucun secret. */
export interface ChargePartage {
  v: number;
  kind: DocumentPartageable['kind'];
  n: string;
  d: string;
  e: string;
  c: string;
  cl: string;
  en: string;
  t: string;
  /** Lignes : [description, quantité, prix, remise, tva]. */
  l: Array<[string, number, number, number, number]>;
}

export function chargeDeDocument(document: DocumentPartageable): ChargePartage {
  return {
    v: VERSION_PARTAGE,
    kind: document.kind,
    n: document.number,
    d: document.issuedAt,
    e: document.dueDate,
    c: document.currency,
    cl: document.clientNom,
    en: document.entreprise,
    t: document.terms,
    // On borne : un lien trop long devient illisible dans un message.
    l: document.lines.slice(0, 60).map((ligne) => ([
      String(ligne.description).slice(0, 200),
      ligne.quantity, ligne.unitPrice, ligne.discountPct, ligne.taxPct,
    ])),
  };
}

/** Encodage URL sûr de l'UTF-8 (pas de `btoa` sur des accents). */
function encoderUtf8(texte: string): string {
  const octets = new TextEncoder().encode(texte);
  let binaire = '';
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decoderUtf8(base64url: string): string {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binaire = atob(base64 + '==='.slice((base64.length + 3) % 4));
  const octets = Uint8Array.from(binaire, (caractere) => caractere.charCodeAt(0));
  return new TextDecoder().decode(octets);
}

/**
 * Lien partageable.
 *
 * La charge est dans le FRAGMENT : elle n'est pas transmise au serveur, ce qui
 * évite d'exposer un document commercial dans des journaux d'accès. Le lien ne
 * contient que le document, jamais d'identifiant de session ni de secret.
 */
export function lienPartageable(document: DocumentPartageable, base = ''): string {
  const charge = encoderUtf8(JSON.stringify(chargeDeDocument(document)));
  const racine = base || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${racine}/partage/document#${charge}`;
}

/** Relit un lien partagé ; `null` si la charge est absente ou invalide. */
export function documentDepuisPartage(fragment: string): DocumentPartageable | null {
  const brut = (fragment ?? '').trim().replace(/^#/, '');
  if (!brut) return null;
  try {
    const charge = JSON.parse(decoderUtf8(brut)) as ChargePartage;
    if (!charge || charge.v !== VERSION_PARTAGE) return null;
    if (!['devis', 'facture', 'commande'].includes(charge.kind)) return null;
    if (!Array.isArray(charge.l)) return null;
    const lignes: LigneDocument[] = charge.l.slice(0, 60).map((ligne) => ({
      description: String(ligne[0] ?? '').slice(0, 200),
      quantity: Number.isFinite(Number(ligne[1])) ? Number(ligne[1]) : 0,
      unitPrice: Number.isFinite(Number(ligne[2])) ? Number(ligne[2]) : 0,
      discountPct: Number.isFinite(Number(ligne[3])) ? Number(ligne[3]) : 0,
      taxPct: Number.isFinite(Number(ligne[4])) ? Number(ligne[4]) : 0,
    }));
    return {
      kind: charge.kind,
      number: String(charge.n ?? '').slice(0, 60),
      issuedAt: String(charge.d ?? '').slice(0, 10),
      dueDate: String(charge.e ?? '').slice(0, 10),
      currency: String(charge.c ?? '').slice(0, 8),
      terms: String(charge.t ?? '').slice(0, 1000),
      lines: lignes,
      clientNom: String(charge.cl ?? '').slice(0, 160),
      entreprise: String(charge.en ?? '').slice(0, 160),
    };
  } catch {
    return null;
  }
}

/** Statuts visibles côté vendeur, y compris le statut « vu ». */
export type StatutDocument = 'brouillon' | 'envoye' | 'vu' | 'paye' | 'en_retard' | 'accepte' | 'refuse';

export const STATUTS_DOCUMENT: readonly { value: StatutDocument; label: string }[] = [
  { value: 'brouillon', label: 'Brouillon' },
  { value: 'envoye', label: 'Envoyé' },
  { value: 'vu', label: 'Vu' },
  { value: 'accepte', label: 'Accepté' },
  { value: 'refuse', label: 'Refusé' },
  { value: 'paye', label: 'Payé' },
  { value: 'en_retard', label: 'En retard' },
];

/**
 * Le passage à « vu » ne peut pas écraser un statut plus avancé.
 *
 * Un client qui rouvre un lien déjà payé ne doit pas faire retomber la facture
 * en « vu » : la progression est à sens unique.
 */
export function marquerVu(statut: string): StatutDocument {
  if (['paye', 'en_retard', 'accepte', 'refuse', 'vu'].includes(statut)) {
    return statut as StatutDocument;
  }
  return 'vu';
}

/** Enregistrement de marquage « vu », par document, pour éviter les doublons. */
export function cleMarquageVu(kind: string, documentId: string): string {
  return `vu:${kind}:${documentId}`;
}
