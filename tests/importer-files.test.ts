// @vitest-environment node
/**
 * Import de fichiers — CSV, XML, XLSX.
 *
 * Deux familles de tests, volontairement séparées :
 *   1. **fonctionnel** : un fichier correct produit les bons produits ;
 *   2. **sécurité** : un fichier hostile est refusé, avec un message clair.
 *
 * La seconde famille compte autant que la première. Un importateur qui lit un
 * XML avec un DTD externe peut exfiltrer `/etc/passwd` ; un export CSV qui
 * laisse passer `=cmd|'/C calc'!A0` exécute une commande chez celui qui ouvre
 * le fichier. Ces deux scénarios sont testés.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  MAX_FILE_BYTES,
  assertSafeXml,
  detectFileFormat,
  importDelimited,
  importFile,
  importXlsx,
  importXml,
  parseDelimited,
  sanitizeFormula,
} from '../src/business/importer/files';

const encodeur = new TextEncoder();

/* ----------------------------------- CSV ---------------------------------- */

describe('CSV — lecture conforme à RFC 4180', () => {
  it('lit un CSV simple avec en-tête', () => {
    const csv = 'name,price,currency\nSérum éclat,12000,XOF\nBaume lèvres,4500,XOF';
    const resultat = importDelimited(csv);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(2);
    expect(resultat.products[0].name).toBe('Sérum éclat');
    expect(resultat.products[0].priceMinor).toBe(12000);
  });

  it('gère les guillemets et les virgules internes', () => {
    // La cellule contenant une virgule est entre guillemets ; les guillemets
    // internes doivent être doublés (RFC 4180). Un guillemet non échappé
    // ferme la cellule, ce qui est le comportement attendu.
    const csv = 'name,description\n"Crème, format voyage","Une crème ""riche"" en vitamine C"';
    const lignes = parseDelimited(csv);
    expect(lignes[1][0]).toBe('Crème, format voyage');
    expect(lignes[1][1]).toBe('Une crème "riche" en vitamine C');
  });

  it('gère les guillemets doublés et les sauts de ligne internes', () => {
    const csv = 'name,description\nSérum,"Ligne 1\nLigne 2 avec ""citation"""';
    const lignes = parseDelimited(csv);
    expect(lignes).toHaveLength(2);
    expect(lignes[1][1]).toContain('Ligne 2 avec "citation"');
  });

  it('déduit le séparateur point-virgule (export français)', () => {
    const csv = 'Nom;Prix;Devise\nSérum;12 000;XOF';
    const resultat = importDelimited(csv);
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.products[0].priceMinor).toBe(12000);
  });

  it('déduit le séparateur tabulation', () => {
    const tsv = 'name\tprice\nSérum\t9500';
    expect(detectFileFormat(encodeur.encode(tsv), 'x.tsv')).toBe('tsv');
    const resultat = importDelimited(tsv, { separator: '\t' });
    expect(resultat.ok).toBe(true);
  });

  it('ignore le BOM UTF-8', () => {
    const csv = '\uFEFFname,price\nSérum,1000';
    const resultat = importDelimited(csv);
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.products[0].name).toBe('Sérum');
  });

  it('accepte les synonymes de colonnes français', () => {
    const csv = 'Produit;Prix;Devise;Catégorie;Lien;Photo\nSérum;9000;XOF;Soin;https://x.com/p;https://x.com/i.jpg';
    const resultat = importDelimited(csv);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products[0].categories).toHaveLength(1);
    expect(resultat.products[0].imageUrl).toBe('https://x.com/i.jpg');
  });

  it('refuse un CSV sans colonne de nom', () => {
    const resultat = importDelimited('prix,devise\n1000,XOF');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.errors[0]).toMatch(/nom/i);
  });

  it('refuse un fichier vide ou réduit à un en-tête', () => {
    expect(importDelimited('').ok).toBe(false);
    expect(importDelimited('name,price').ok).toBe(false);
  });

  it('signale les prix illisibles sans rejeter la ligne entière', () => {
    const csv = 'name,price\nSérum,prix-sur-demande';
    const resultat = importDelimited(csv);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    // Le produit est conservé, le prix devient inconnu, l'avertissement le dit.
    expect(resultat.products[0].priceMinor).toBeNull();
    expect(resultat.products[0].warnings.join(' ')).toMatch(/illisible/i);
  });
});

describe('CSV — injection de formule neutralisée', () => {
  it('préfixe les cellules qui commencent par un opérateur', () => {
    for (const danger of ['=cmd|\'/C calc\'!A0', '+1+1', '-2+3', '@SUM(A1)', '\t=1+1']) {
      const neutralise = sanitizeFormula(danger);
      expect(neutralise.startsWith("'")).toBe(true);
      expect(neutralise.slice(1)).toBe(danger);
    }
  });

  it('ne touche pas une valeur normale', () => {
    expect(sanitizeFormula('Sérum éclat')).toBe('Sérum éclat');
    expect(sanitizeFormula('12000')).toBe('12000');
  });

  it('un nom de produit commençant par « = » reste un texte, pas une formule', () => {
    // Le contenu importé est affiché, jamais évalué : la normalisation retire
    // les balises et conserve la chaîne. On vérifie qu'aucun exécutable n'est
    // produit et que la valeur est bien traitée comme du texte.
    const resultat = importDelimited('name,price\n=1+1,1000');
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      expect(typeof resultat.products[0].name).toBe('string');
      expect(resultat.products[0].name).toBe('=1+1');
    }
  });
});

/* ----------------------------------- XML ---------------------------------- */

describe('XML — lecture des flux produits', () => {
  const flux = `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <product>
    <title>Sérum éclat</title>
    <description>Un sérum vitaminé</description>
    <price>12000</price>
    <currency>XOF</currency>
    <link>https://boutique.com/products/serum</link>
    <image_link>https://cdn.boutique.com/serum.jpg</image_link>
    <category>Soin</category>
  </product>
  <product>
    <title>Baume lèvres</title>
    <price>4500</price>
  </product>
</catalog>`;

  it('extrait les produits d’un flux XML', () => {
    const resultat = importXml(flux);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(2);
    expect(resultat.products[0].name).toBe('Sérum éclat');
    expect(resultat.products[0].priceMinor).toBe(12000);
    expect(resultat.products[0].currency).toBe('XOF');
    expect(resultat.products[1].name).toBe('Baume lèvres');
  });

  it('reconnaît les variantes de nommage (item, entry, offer)', () => {
    for (const balise of ['item', 'entry', 'offer']) {
      const xml = `<rss><${balise}><title>Produit</title><price>100</price></${balise}></rss>`;
      const resultat = importXml(xml);
      expect(resultat.ok, balise).toBe(true);
    }
  });

  it('décode les entités XML prédéfinies', () => {
    const xml = '<catalog><product><title>Crème &amp; Sérum</title><price>100</price></product></catalog>';
    const resultat = importXml(xml);
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.products[0].name).toBe('Crème & Sérum');
  });

  it('refuse un XML sans élément produit', () => {
    const resultat = importXml('<catalog><autre>rien</autre></catalog>');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.errors[0]).toMatch(/Aucun élément produit/i);
  });
});

describe('XML — XXE et expansion d’entités refusées', () => {
  it('refuse un DOCTYPE, même bénin', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE catalog SYSTEM "file:///etc/passwd"><catalog><product><title>x</title></product></catalog>';
    const controle = assertSafeXml(xml);
    expect(controle.ok).toBe(false);
    if (!controle.ok) expect(controle.error).toMatch(/DOCTYPE/);
  });

  it('refuse une entité externe, vecteur classique de lecture de fichier', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/shadow">]>
<catalog><product><title>&xxe;</title></product></catalog>`;
    const resultat = importXml(xml);
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.errors[0]).toMatch(/sécurité|entités/i);
  });

  it('refuse l’expansion en cascade (« billion laughs »)', () => {
    const xml = `<!DOCTYPE lolz [
      <!ENTITY lol "lol">
      <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
    ]>
    <catalog><product><title>&lol2;</title></product></catalog>`;
    const resultat = importXml(xml);
    expect(resultat.ok).toBe(false);
  });

  it('laisse passer un XML sans DTD mais avec caractères accentués', () => {
    const xml = '<catalog><product><title>Café éclat</title></product></catalog>';
    expect(assertSafeXml(xml).ok).toBe(true);
  });
});

/* ---------------------------------- XLSX ---------------------------------- */

/** Construit un XLSX minimal (ZIP stocké) pour tester la lecture réelle. */
function buildXlsx(sheetXml: string, extra: Array<{ nom: string; contenu: string }> = []): Uint8Array {
  const fichiers: Array<{ nom: string; contenu: Uint8Array }> = [
    { nom: '[Content_Types].xml', contenu: encodeur.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { nom: 'xl/workbook.xml', contenu: encodeur.encode('<?xml version="1.0"?><workbook><sheets><sheet name="Produits" sheetId="1"/></sheets></workbook>') },
    { nom: 'xl/worksheets/sheet1.xml', contenu: encodeur.encode(sheetXml) },
    ...extra.map((f) => ({ nom: f.nom, contenu: encodeur.encode(f.contenu) })),
  ];

  // ZIP en mode « stocké » (méthode 0) : plus simple à produire, et le lecteur
  // accepte les deux méthodes.
  const morceaux: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const fichier of fichiers) {
    const nom = Buffer.from(fichier.nom, 'utf8');
    const donnees = Buffer.from(fichier.contenu);
    const crc = crc32(donnees);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(donnees.length, 18);
    local.writeUInt32LE(donnees.length, 22);
    local.writeUInt16LE(nom.length, 26);
    local.writeUInt16LE(0, 28);
    morceaux.push(local, nom, donnees);

    const entree = Buffer.alloc(46);
    entree.writeUInt32LE(0x02014b50, 0);
    entree.writeUInt16LE(20, 4);
    entree.writeUInt16LE(20, 6);
    entree.writeUInt16LE(0, 8);
    entree.writeUInt16LE(0, 10);
    entree.writeUInt16LE(0, 12);
    entree.writeUInt16LE(0, 14);
    entree.writeUInt32LE(crc, 16);
    entree.writeUInt32LE(donnees.length, 20);
    entree.writeUInt32LE(donnees.length, 24);
    entree.writeUInt16LE(nom.length, 28);
    entree.writeUInt16LE(0, 30);
    entree.writeUInt16LE(0, 32);
    entree.writeUInt16LE(0, 34);
    entree.writeUInt16LE(0, 36);
    entree.writeUInt32LE(0, 38);
    entree.writeUInt32LE(offset, 42);
    central.push(entree, nom);

    offset += local.length + nom.length + donnees.length;
  }
  const centralBuffer = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(fichiers.length, 8);
  fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(centralBuffer.length, 12);
  fin.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...morceaux, centralBuffer, fin]));
}

let tableCrc: number[] | null = null;
function crc32(data: Buffer): number {
  if (!tableCrc) {
    tableCrc = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tableCrc[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const octet of data) crc = tableCrc[(crc ^ octet) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const feuille = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>Nom</t></is></c><c r="B1" t="inlineStr"><is><t>Prix</t></is></c><c r="C1" t="inlineStr"><is><t>Devise</t></is></c></row>
  <row r="2"><c r="A2" t="inlineStr"><is><t>Sérum éclat</t></is></c><c r="B2"><v>12000</v></c><c r="C2" t="inlineStr"><is><t>XOF</t></is></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>Baume lèvres</t></is></c><c r="B3"><v>4500</v></c><c r="C3" t="inlineStr"><is><t>XOF</t></is></c></row>
</sheetData></worksheet>`;

describe('XLSX — lecture réelle d’un classeur', () => {
  it('détecte un classeur par sa signature ZIP, pas son extension', () => {
    expect(detectFileFormat(buildXlsx(feuille), 'fichier.csv')).toBe('xlsx');
  });

  it('extrait les lignes et les normalise', async () => {
    const resultat = await importXlsx(buildXlsx(feuille), { reference: 'classeur.xlsx' });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.format).toBe('xlsx');
    expect(resultat.products).toHaveLength(2);
    expect(resultat.products[0].name).toBe('Sérum éclat');
    expect(resultat.products[0].priceMinor).toBe(12000);
  });

  it('accepte aussi une entrée compressée en deflate', async () => {
    // Certains producteurs de XLSX compressent réellement : on vérifie que le
    // chemin `deflate-raw` fonctionne, pas seulement le mode stocké.
    const contenu = encodeur.encode(feuille);
    const compresse = new Uint8Array(deflateRawSync(Buffer.from(contenu)));
    const nom = Buffer.from('xl/worksheets/sheet1.xml', 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // méthode deflate
    local.writeUInt32LE(crc32(Buffer.from(contenu)), 14);
    local.writeUInt32LE(compresse.length, 18);
    local.writeUInt32LE(contenu.length, 22);
    local.writeUInt16LE(nom.length, 26);
    const zip = new Uint8Array(Buffer.concat([local, nom, Buffer.from(compresse)]));

    const resultat = await importXlsx(zip);
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.products).toHaveLength(2);
  });

  it('lit les chaînes partagées (mode réel d’Excel et LibreOffice)', async () => {
    // Sans sharedStrings, tout le texte d'un vrai classeur serait perdu : les
    // noms de produits seraient lus comme des index numériques.
    const sharedStrings = `<?xml version="1.0"?>
<sst count="6">
  <si><t>Nom</t></si>
  <si><t>Prix</t></si>
  <si><t>Sérum éclat</t></si>
  <si><t>Baume lèvres</t></si>
</sst>`;
    const feuillePartagee = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
  <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12000</v></c></row>
  <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>4500</v></c></row>
</sheetData></worksheet>`;

    const resultat = await importXlsx(buildXlsx(feuillePartagee, [
      { nom: 'xl/sharedStrings.xml', contenu: sharedStrings },
    ]));
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(2);
    // Le nom vient bien de la table de chaînes, pas de l'index 2.
    expect(resultat.products[0].name).toBe('Sérum éclat');
    expect(resultat.products[1].name).toBe('Baume lèvres');
    expect(resultat.products[0].priceMinor).toBe(12000);
  });

  it('un index de chaîne hors limites ne produit pas de nom inventé', async () => {
    const feuilleCassee = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c></row>
  <row r="2"><c r="A2" t="s"><v>99</v></c><c r="B2"><v>1000</v></c></row>
</sheetData></worksheet>`;
    const resultat = await importXlsx(buildXlsx(feuilleCassee, [
      { nom: 'xl/sharedStrings.xml', contenu: '<sst><si><t>Nom</t></si></sst>' },
    ]));
    // La ligne est écartée faute de nom : aucun produit vide n'est créé.
    expect(resultat.ok).toBe(false);
  });

  it('refuse un ZIP qui n’est pas un classeur', async () => {
    const resultat = await importXlsx(encodeur.encode('PK\x03\x04pas-un-vrai-zip'));
    expect(resultat.ok).toBe(false);
  });

  it('refuse un classeur sans feuille exploitable', async () => {
    const vide = buildXlsx('<worksheet><sheetData></sheetData></worksheet>');
    const resultat = await importXlsx(vide);
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.errors[0]).toMatch(/en-tête|feuille/i);
  });
});

/* --------------------------- point d'entrée unique ------------------------ */

describe('importFile — détection et bornes', () => {
  it('refuse un fichier vide', async () => {
    const resultat = await importFile(new Uint8Array(), 'vide.csv');
    expect(resultat.ok).toBe(false);
  });

  it('refuse un fichier au-delà de la limite de taille', async () => {
    const gros = new Uint8Array(MAX_FILE_BYTES + 1);
    gros.set(encodeur.encode('name,price\n'), 0);
    const resultat = await importFile(gros, 'gros.csv');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.errors[0]).toMatch(/volumineux/i);
  });

  it('refuse un format non reconnu sans deviner', async () => {
    const resultat = await importFile(encodeur.encode('données binaires \x00\x01'), 'fichier.bin');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.errors[0]).toMatch(/Format non reconnu/i);
  });

  it('route correctement vers chaque parseur', async () => {
    const csv = await importFile(encodeur.encode('name,price\nSérum,1000'), 'a.csv');
    expect(csv.ok && csv.format).toBe('csv');

    const xml = await importFile(encodeur.encode('<catalog><product><title>Sérum</title></product></catalog>'), 'a.xml');
    expect(xml.ok && xml.format).toBe('xml');

    const xlsx = await importFile(buildXlsx(feuille), 'a.xlsx');
    expect(xlsx.ok && xlsx.format).toBe('xlsx');
  });
});
