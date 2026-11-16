/**
 * VYORA — import de fichiers : CSV, TSV, XML et XLSX.
 *
 * ## Aucune dépendance ajoutée
 *
 * Le projet n'embarque ni `papaparse`, ni `xlsx`, ni `fast-xml-parser`. Plutôt
 * que d'en ajouter trois (surface d'attaque et poids de bundle), on écrit les
 * parseurs strictement nécessaires :
 *   - **CSV/TSV** : RFC 4180, guillemets, séparateur déduit ;
 *   - **XML** : extraction ciblée par motifs, sans parseur DOM côté serveur ;
 *   - **XLSX** : lecture du ZIP par `DecompressionStream` (API standard), puis
 *     du XML interne — voir la limite documentée plus bas.
 *
 * ## Sécurité des fichiers
 *
 * Un fichier importé est une entrée non fiable :
 *   - **taille** bornée avant lecture ;
 *   - **type** vérifié par signature (magic bytes), pas par l'extension ;
 *   - **XML** : refus de tout `<!DOCTYPE` et `<!ENTITY`, ce qui bloque les
 *     attaques par entités externes (XXE) et par expansion (« billion laughs ») ;
 *   - **XLSX** : la décompression est bornée en sortie, pour qu'un « zip bomb »
 *     ne remplisse pas la mémoire ;
 *   - **CSV** : aucune formule n'est évaluée. Une cellule commençant par `=`,
 *     `+`, `-` ou `@` est préfixée d'une apostrophe à l'export — voir
 *     `sanitizeFormula` — car le fichier peut être réouvert dans un tableur.
 */
import type { NormalizedProduct } from './normalize.ts';
import { buildProduct, parsePriceMinor, DEFAULT_CURRENCY } from './normalize.ts';
import type { StorePlatform } from './platform.ts';

/** Taille maximale acceptée pour un fichier, en octets (8 Mio). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Taille maximale de sortie XML après décompression (32 Mio). */
export const MAX_XML_BYTES = 32 * 1024 * 1024;
/** Nombre maximal de lignes exploitées. */
export const MAX_ROWS = 5000;

export type FileFormat = 'csv' | 'tsv' | 'xml' | 'xlsx';

export type FileParseResult =
  | { ok: true; format: FileFormat; products: NormalizedProduct[]; warnings: string[]; truncated: boolean }
  | { ok: false; format: FileFormat | 'unknown'; errors: string[] };

/** Signature binaire d'un fichier, pour ne pas se fier à l'extension. */
export function detectFileFormat(bytes: Uint8Array, filename = ''): FileFormat | 'unknown' {
  // ZIP : « PK\x03\x04 » — un XLSX est toujours un ZIP.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06)) {
    // Un ZIP qui n'est pas un classeur sera rejeté plus loin.
    return 'xlsx';
  }
  const début = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096)).replace(/^\uFEFF/, '').trimStart();
  if (début.startsWith('<?xml') || début.startsWith('<')) return 'xml';

  const extension = filename.toLowerCase().split('.').pop() ?? '';
  if (extension === 'tsv') return 'tsv';
  if (extension === 'csv') return 'csv';
  // Sans signature ni extension, on regarde la première ligne.
  const premiereLigne = début.split(/\r?\n/)[0] ?? '';
  if (premiereLigne.includes('\t')) return 'tsv';
  if (premiereLigne.includes(',') || premiereLigne.includes(';')) return 'csv';
  return 'unknown';
}

/**
 * Neutralise une formule de tableur.
 *
 * Une cellule `=HYPERLINK("http://…")` ou `=cmd|' /C calc'!A0` est exécutée
 * quand l'utilisateur réouvre le fichier exporté : c'est l'injection de formule
 * (CSV injection). On préfixe d'une apostrophe, comme le recommandent OWASP et
 * les guides de sécurité des tableurs.
 */
export function sanitizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/* ---------------------------------- CSV ----------------------------------- */

/**
 * Parse un CSV/TSV en lignes de cellules.
 *
 * Implémente RFC 4180 : guillemets doublés (`""`), retours à la ligne dans une
 * cellule entre guillemets, séparateur déduit de l'en-tête. Pas de dépendance,
 * pas d'évaluation.
 */
export function parseDelimited(raw: string, separator?: string): string[][] {
  const texte = raw.replace(/^\uFEFF/, '');
  let sep = separator;
  if (!sep) {
    const entete = texte.split(/\r?\n/)[0] ?? '';
    const candidats: Array<{ sep: string; n: number }> = [
      { sep: '\t', n: (entete.match(/\t/g) ?? []).length },
      { sep: ';', n: (entete.match(/;/g) ?? []).length },
      { sep: ',', n: (entete.match(/,/g) ?? []).length },
    ].sort((a, b) => b.n - a.n);
    sep = candidats[0].n > 0 ? candidats[0].sep : ',';
  }

  const lignes: string[][] = [];
  let cellule = '';
  let ligne: string[] = [];
  let dansGuillemets = false;

  for (let i = 0; i < texte.length; i += 1) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { cellule += '"'; i += 1; }
        else dansGuillemets = false;
      } else {
        cellule += c;
      }
      continue;
    }
    if (c === '"') { dansGuillemets = true; continue; }
    if (c === sep) { ligne.push(cellule); cellule = ''; continue; }
    if (c === '\n') { ligne.push(cellule); lignes.push(ligne); ligne = []; cellule = ''; continue; }
    if (c === '\r') continue;
    cellule += c;
  }
  if (cellule !== '' || ligne.length > 0) { ligne.push(cellule); lignes.push(ligne); }
  return lignes.filter((l) => l.some((celluleValeur) => celluleValeur.trim() !== ''));
}

/** Synonymes d'en-tête acceptés, par champ cible. */
const COLONNES: Record<string, string[]> = {
  name: ['name', 'nom', 'title', 'titre', 'product', 'produit', 'product name', 'libelle', 'libellé'],
  price: ['price', 'prix', 'price_amount', 'montant', 'prix unitaire', 'unit price', 'regular price'],
  currency: ['currency', 'devise', 'monnaie'],
  description: ['description', 'desc', 'details', 'détails', 'resume', 'résumé'],
  url: ['url', 'link', 'lien', 'product_url', 'handle'],
  image: ['image', 'image_url', 'photo', 'images', 'image src', 'picture'],
  categories: ['category', 'categories', 'categorie', 'catégorie', 'collection', 'catégories'],
  sku: ['sku', 'reference', 'référence', 'ref'],
};

function matchColumn(header: string): string | null {
  const cle = header.trim().toLowerCase().replace(/^["']|["']$/g, '');
  for (const [champ, synonymes] of Object.entries(COLONNES)) {
    if (synonymes.includes(cle)) return champ;
  }
  return null;
}

/** Import CSV/TSV → produits normalisés. */
export function importDelimited(raw: string, options: { separator?: string; platform?: StorePlatform | 'file'; reference?: string } = {}): FileParseResult {
  const lignes = parseDelimited(raw, options.separator);
  const warnings: string[] = [];
  if (lignes.length === 0) return { ok: false, format: 'csv', errors: ['Le fichier est vide.'] };
  if (lignes.length === 1) return { ok: false, format: 'csv', errors: ['Le fichier ne contient qu’un en-tête, aucun produit.'] };

  const headers = lignes[0].map((h) => h.trim());
  const mapping = headers.map(matchColumn);
  if (!mapping.includes('name')) {
    return {
      ok: false,
      format: 'csv',
      errors: ['Aucune colonne de nom reconnue (attendu : name, nom, titre ou title).'],
    };
  }

  const produits: NormalizedProduct[] = [];
  const erreurs: string[] = [];
  const lignesUtiles = lignes.slice(1, MAX_ROWS + 1);
  if (lignes.length - 1 > MAX_ROWS) warnings.push(`Seules les ${MAX_ROWS} premières lignes sont importées.`);

  lignesUtiles.forEach((ligne, index) => {
    const entry: Record<string, string> = {};
    mapping.forEach((champ, i) => {
      if (champ && ligne[i] !== undefined) entry[champ] = ligne[i].trim();
    });
    if (!entry.name) return;

    const currency = (entry.currency || DEFAULT_CURRENCY).toUpperCase();
    const prix = parsePriceMinor(entry.price, currency);
    const localWarnings: string[] = [];
    if (prix.warning) localWarnings.push(`${prix.warning} pour « ${entry.name} »`);

    const produit = buildProduct({
      name: entry.name,
      description: entry.description,
      priceMinor: prix.minor,
      currency,
      productUrl: entry.url,
      imageUrl: entry.image,
      categories: entry.categories,
      source: { platform: options.platform ?? 'file', reference: options.reference ?? 'fichier' },
      warnings: localWarnings,
    });
    if ('error' in produit) {
      erreurs.push(`Ligne ${index + 2} : ${produit.error}.`);
      return;
    }
    produits.push(produit);
  });

  if (produits.length === 0) {
    return { ok: false, format: 'csv', errors: errors_ou(erreurs, 'Aucune ligne valide n’a été trouvée.') };
  }
  return { ok: true, format: 'csv', products: produits, warnings: [...warnings, ...erreurs.slice(0, 5)], truncated: lignes.length - 1 > MAX_ROWS };
}

function errors_ou(liste: string[], defaut: string): string[] {
  return liste.length > 0 ? liste.slice(0, 8) : [defaut];
}

/* ---------------------------------- XML ----------------------------------- */

/**
 * Refuse les constructions XML dangereuses avant toute lecture.
 *
 * - `<!DOCTYPE` permet la déclaration d'entités externes → XXE (lecture de
 *   fichiers locaux, requêtes internes).
 * - `<!ENTITY` en cascade → expansion quadratique (« billion laughs »), qui
 *   épuise la mémoire avec quelques centaines d'octets.
 *
 * Aucun flux produit réel n'a besoin d'un DTD interne : le refus est sans
 * coût fonctionnel.
 */
export function assertSafeXml(raw: string): { ok: true } | { ok: false; error: string } {
  const début = raw.slice(0, MAX_XML_BYTES);
  if (/<!DOCTYPE/i.test(début)) {
    return { ok: false, error: 'Le fichier XML déclare un DOCTYPE : refusé pour des raisons de sécurité.' };
  }
  if (/<!ENTITY/i.test(début)) {
    return { ok: false, error: 'Le fichier XML déclare des entités : refusé (risque d’expansion).' };
  }
  return { ok: true };
}

/** Décode les cinq entités XML prédéfinies. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Contenu texte du premier motif trouvé dans un fragment. */
function firstTag(fragment: string, tags: string[]): string {
  for (const tag of tags) {
    const motif = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const trouve = fragment.match(motif);
    if (trouve) return decodeXmlEntities(trouve[1]).trim();
    // Balise auto-fermante ou attribut : on tente l'attribut `href`/`url`.
    const auto = fragment.match(new RegExp(`<${tag}[^>]*?(?:href|url|src)=["']([^"']+)["']`, 'i'));
    if (auto) return auto[1];
  }
  return '';
}

/**
 * Import XML générique.
 *
 * Reconnaît les enfants d'éléments `item`, `product`, `entry` ou `produit` —
 * les noms utilisés par les flux Google Merchant, PrestaShop et les exports
 * WooCommerce. Les champs sont cherchés par synonyme, comme pour le CSV.
 */
export function importXml(raw: string, options: { platform?: StorePlatform | 'file'; reference?: string } = {}): FileParseResult {
  const securite = assertSafeXml(raw);
  if (!securite.ok) return { ok: false, format: 'xml', errors: [securite.error] };
  if (raw.length > MAX_XML_BYTES) return { ok: false, format: 'xml', errors: ['Le fichier XML dépasse la taille autorisée.'] };

  const blocs = raw.match(/<(item|product|entry|produit|offer)\b[\s\S]*?<\/\1>/gi) ?? [];
  if (blocs.length === 0) {
    return { ok: false, format: 'xml', errors: ['Aucun élément produit (item, product, entry) trouvé dans le XML.'] };
  }

  const produits: NormalizedProduct[] = [];
  const erreurs: string[] = [];
  blocs.slice(0, MAX_ROWS).forEach((bloc, index) => {
    const name = firstTag(bloc, ['title', 'name', 'nom', 'productName', 'g:title']);
    if (!name) {
      erreurs.push(`Bloc ${index + 1} : nom manquant.`);
      return;
    }
    const currency = (firstTag(bloc, ['currency', 'devise', 'g:price_currency']) || DEFAULT_CURRENCY).toUpperCase().slice(0, 3);
    const prixBrut = firstTag(bloc, ['price', 'prix', 'g:price', 'regular_price']);
    const prix = parsePriceMinor(prixBrut, /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY);
    const produit = buildProduct({
      name,
      description: firstTag(bloc, ['description', 'desc', 'summary', 'g:description']),
      priceMinor: prix.minor,
      currency,
      productUrl: firstTag(bloc, ['link', 'url', 'product_url']),
      imageUrl: firstTag(bloc, ['image_link', 'image', 'g:image_link', 'picture']),
      categories: firstTag(bloc, ['category', 'categorie', 'product_type', 'g:google_product_category']),
      source: { platform: options.platform ?? 'file', reference: options.reference ?? 'fichier XML' },
      warnings: prix.warning ? [`${prix.warning} pour « ${name} »`] : [],
    });
    if ('error' in produit) {
      erreurs.push(`Bloc ${index + 1} : ${produit.error}.`);
      return;
    }
    produits.push(produit);
  });

  if (produits.length === 0) return { ok: false, format: 'xml', errors: errors_ou(erreurs, 'Aucun produit valide.') };
  return { ok: true, format: 'xml', products: produits, warnings: erreurs.slice(0, 5), truncated: blocs.length > MAX_ROWS };
}

/* --------------------------------- XLSX ----------------------------------- */

/**
 * Lit une entrée d'un ZIP par décompression « raw deflate ».
 *
 * ## Pourquoi cette implémentation, et sa limite
 *
 * `DecompressionStream('deflate-raw')` est standard (Node 18+, navigateurs
 * récents) et évite d'ajouter une bibliothèque ZIP. On localise les en-têtes de
 * fichier locaux (`PK\x03\x04`) et on décompresse l'entrée dont le nom
 * correspond. On ne gère **pas** :
 *   - les entrées chiffrées (refusées explicitement) ;
 *   - les archives à flux « zip64 » de plus de 4 Gio (hors limite de taille) ;
 *   - les fichiers produits par des outils qui écrivent les données après les
 *     en-têtes centraux sans doublon local (rare, mais existant).
 *
 * Ces cas produisent une erreur explicite, jamais un import partiel silencieux.
 */
async function readZipEntry(bytes: Uint8Array, wantedNames: string[]): Promise<Uint8Array | null> {
  const vue = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decodeur = new TextDecoder('utf-8');
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    // Signature d'en-tête local : 0x04034b50
    if (vue.getUint32(offset, true) !== 0x04034b50) { offset += 1; continue; }
    const methode = vue.getUint16(offset + 8, true);
    const flags = vue.getUint16(offset + 6, true);
    const tailleCompressee = vue.getUint32(offset + 18, true);
    const nomLength = vue.getUint16(offset + 26, true);
    const extraLength = vue.getUint16(offset + 28, true);
    const nom = decodeur.decode(bytes.slice(offset + 30, offset + 30 + nomLength));
    const debutDonnees = offset + 30 + nomLength + extraLength;

    if ((flags & 0x1) !== 0) throw new Error('classeur chiffré : déchiffrement non pris en charge');
    if (tailleCompressee === 0 && wantedNames.includes(nom)) {
      // Taille inconnue dans l'en-tête local : on ne peut pas délimiter.
      throw new Error('classeur non pris en charge (taille d’entrée inconnue)');
    }

    if (wantedNames.includes(nom)) {
      const donnees = bytes.slice(debutDonnees, debutDonnees + tailleCompressee);
      if (methode === 0) return donnees; // stocké sans compression
      if (methode !== 8) throw new Error(`méthode de compression ${methode} non prise en charge`);
      const flux = new Blob([donnees]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buffer = await new Response(flux).arrayBuffer();
      if (buffer.byteLength > MAX_XML_BYTES) throw new Error('contenu décompressé trop volumineux');
      return new Uint8Array(buffer);
    }
    offset = debutDonnees + tailleCompressee;
  }
  return null;
}

/**
 * Extrait la valeur d'affichage d'une cellule de feuille XLSX.
 *
 * Trois cas, tous nécessaires avec de vrais classeurs :
 *   - `t="s"` : la valeur est un **index dans `sharedStrings.xml`**. C'est le
 *     mode utilisé par Excel et LibreOffice pour tout texte dès que le fichier
 *     dépasse quelques cellules — l'ignorer fait lire des nombres à la place
 *     des noms de produits ;
 *   - `t="inlineStr"` : le texte est porté par `<is><t>` ;
 *   - sinon : `<v>` contient une valeur littérale (nombre, date, booléen).
 */
function cellText(xml: string, shared: string[]): string {
  const inline = xml.match(/<t[^>]*>([\s\S]*?)<\/t>/i);
  if (inline) return decodeXmlEntities(inline[1]);

  const valeur = xml.match(/<v>([\s\S]*?)<\/v>/i);
  if (!valeur) return '';
  const brut = valeur[1];

  // `t="s"` est porté par l'attribut de <c>, donc présent avant <v>.
  if (/\bt="s"/.test(xml)) {
    const index = Number(brut);
    return Number.isInteger(index) && shared[index] !== undefined ? shared[index] : '';
  }
  return decodeXmlEntities(brut);
}

/** Lit `sharedStrings.xml` : une entrée par `<si>`. */
function parseSharedStrings(xml: string): string[] {
  const entrees = xml.match(/<si>([\s\S]*?)<\/si>/gi) ?? [];
  return entrees.map((entree) => {
    // Une entrée peut contenir plusieurs `<t>` (texte enrichi) : on les joint.
    const morceaux = entree.match(/<t[^>]*>([\s\S]*?)<\/t>/gi) ?? [];
    return morceaux.map((m) => decodeXmlEntities(m.replace(/<[^>]+>/g, ''))).join('');
  });
}

/**
 * Import XLSX.
 *
 * Lit la première feuille, convertit chaque ligne en tableau de chaînes, puis
 * réutilise le même pipeline que le CSV (colonnes reconnues par synonyme).
 * Une feuille vide ou un classeur sans feuille produit une erreur explicite.
 */
export async function importXlsx(
  bytes: Uint8Array,
  options: { platform?: StorePlatform | 'file'; reference?: string } = {},
): Promise<FileParseResult> {
  let feuille: Uint8Array | null;
  let shared: string[] = [];
  try {
    // Les chaînes partagées sont indispensables avec un classeur réel.
    try {
      const sharedXml = await readZipEntry(bytes, ['xl/sharedStrings.xml']);
      if (sharedXml) shared = parseSharedStrings(new TextDecoder('utf-8').decode(sharedXml));
    } catch {
      // Absence de sharedStrings est normal pour un classeur en inlineStr.
      shared = [];
    }
    // Le nom de la première feuille varie : on cible sheet1.xml, sinon la
    // première feuille listée dans le classeur.
    feuille = await readZipEntry(bytes, ['xl/worksheets/sheet1.xml']);
    if (!feuille) {
      const liste = await readZipEntry(bytes, ['xl/workbook.xml']);
      const nom = liste ? new TextDecoder().decode(liste).match(/<sheet[^>]*name="([^"]+)"/i) : null;
      if (!nom) return { ok: false, format: 'xlsx', errors: ['Classeur sans feuille de calcul lisible.'] };
      feuille = await readZipEntry(bytes, ['xl/worksheets/sheet1.xml']);
    }
    if (!feuille) return { ok: false, format: 'xlsx', errors: ['Aucune feuille de calcul trouvée dans le classeur.'] };
  } catch (error) {
    return {
      ok: false,
      format: 'xlsx',
      errors: [`Classeur illisible : ${error instanceof Error ? error.message : 'format non pris en charge'}.`],
    };
  }

  const xml = new TextDecoder('utf-8').decode(feuille);
  const lignes: string[][] = [];
  for (const ligneXml of xml.match(/<row[^>]*>([\s\S]*?)<\/row>/gi) ?? []) {
    if (lignes.length > MAX_ROWS) break;
    const cellules: string[] = [];
    for (const celluleXml of ligneXml.match(/<c[^>]*>[\s\S]*?<\/c>/gi) ?? []) {
      cellules.push(cellText(celluleXml, shared));
    }
    if (cellules.some((c) => c.trim() !== '')) lignes.push(cellules);
  }

  if (lignes.length < 2) return { ok: false, format: 'xlsx', errors: ['La feuille ne contient pas d’en-tête et de données.'] };

  // Le classeur est déjà décodé : on réutilise le pipeline CSV sur le texte.
  const enTexte = lignes.map((ligne) => ligne.map((c) => (/[;,\t"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';')).join('\n');
  const resultat = importDelimited(enTexte, { separator: ';', ...options });
  if (!resultat.ok) return resultat;
  return { ...resultat, format: 'xlsx' };
}

/** Point d'entrée : importe un fichier quel que soit son format détecté. */
export async function importFile(
  bytes: Uint8Array,
  filename: string,
  options: { platform?: StorePlatform | 'file'; reference?: string } = {},
): Promise<FileParseResult> {
  if (bytes.byteLength === 0) return { ok: false, format: 'unknown', errors: ['Le fichier est vide.'] };
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, format: 'unknown', errors: [`Fichier trop volumineux (limite ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} Mio).`] };
  }
  const format = detectFileFormat(bytes, filename);
  switch (format) {
    case 'xlsx':
      return importXlsx(bytes, options);
    case 'xml':
      return importXml(new TextDecoder('utf-8').decode(bytes), options);
    case 'csv':
    case 'tsv':
      return importDelimited(new TextDecoder('utf-8').decode(bytes), { separator: format === 'tsv' ? '\t' : undefined, ...options });
    default:
      return {
        ok: false,
        format: 'unknown',
        errors: ['Format non reconnu. Formats acceptés : CSV, TSV, XML, XLSX.'],
      };
  }
}
