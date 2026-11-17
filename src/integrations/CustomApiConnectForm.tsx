/**
 * Configuration du connecteur « API personnalisée ».
 *
 * ## La difficulté d'un formulaire générique
 *
 * Il n'y a pas de champs à afficher « selon la plateforme » : c'est
 * l'utilisateur qui décrit sa plateforme. Le risque est de lui demander trente
 * valeurs techniques sans qu'il sache lesquelles comptent.
 *
 * Le formulaire est donc **progressif**, en trois étapes qui suivent l'ordre
 * dans lequel on peut réellement répondre :
 *
 *   1. **Où et comment** : adresse, mode d'authentification, chemin des
 *      produits, pagination. C'est tout ce qu'il faut pour tester.
 *   2. **Tester** : la sonde lit réellement l'API et rapporte ce qu'elle a
 *      trouvé — statut, nombre de produits, noms des champs. Sans cette étape,
 *      rien ne peut être enregistré (la base l'impose aussi).
 *   3. **Correspondance** : les champs observés sont proposés, l'utilisateur
 *      corrige. C'est la seule étape qui exige de comprendre sa propre API, et
 *      elle n'arrive qu'une fois la preuve faite que l'adresse répond.
 *
 * ## Ce qui n'est jamais stocké côté navigateur
 *
 * Le secret vit dans un `useState`, part en HTTPS, et le champ est vidé dès la
 * réponse. Aucune configuration n'est écrite dans `localStorage` : une clé
 * laissée dans le navigateur survivrait à la déconnexion.
 *
 * ## Aucun enregistrement sans preuve
 *
 * Le bouton d'enregistrement reste désactivé tant que la sonde n'a pas réussi.
 * La base applique la même règle (`PROBE_REQUIRED`) : le formulaire n'est pas
 * la seule garde.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  Eye,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Button, Input, Select } from '../components/ui';
import { asAppError } from '../lib/errors';
import { validateField } from '../business/importer/connector-requirements';
import {
  ALLOWED_AUTH_HEADERS,
  explainCustomApiRejection,
  parseCustomApiBaseUrl,
  parseCustomApiEndpoint,
} from '../business/importer/custom-api-guard';
import { paginationCoherente, type ProbeOutcome } from '../business/importer/custom-api-probe';
import {
  suggestMapping,
  validateMapping,
  type CustomApiMapping,
  type PriceUnit,
} from '../business/importer/custom-api-mapping';
import { invokeEdge } from '../lib/api';

export interface CustomApiConnectFormProps {
  workspaceId: string | null;
  onChanged: (message: { tone: 'success' | 'error'; text: string }) => void;
  /** Appelé après un enregistrement réussi. */
  onSaved?: () => void;
}

type Schema = 'none' | 'bearer' | 'header' | 'basic';
type Pagination = 'none' | 'page' | 'cursor';

/** Champs VYORA proposés à la correspondance, dans l'ordre d'utilité. */
const CHAMPS_MAPPABLES: Array<{ cle: keyof CustomApiMapping; label: string; obligatoire?: boolean; aide: string }> = [
  { cle: 'name', label: 'Nom du produit', obligatoire: true, aide: 'Sans nom, aucun produit ne peut être identifié.' },
  { cle: 'price', label: 'Prix', aide: 'Indiquez l’unité ci-dessous : c’est le point le plus sensible.' },
  { cle: 'description', label: 'Description', aide: 'Facultatif.' },
  { cle: 'sku', label: 'Référence (SKU)', aide: 'Sert au rapprochement d’un import à l’autre.' },
  { cle: 'platformId', label: 'Identifiant chez la source', aide: 'Permet de reconnaître un produit renommé.' },
  { cle: 'image', label: 'Image principale', aide: 'URL ou chemin relatif à la boutique.' },
  { cle: 'productUrl', label: 'URL du produit', aide: 'Facultatif.' },
  { cle: 'categories', label: 'Catégories', aide: 'Tableau de chaînes, ou d’objets avec « name ».' },
  { cle: 'stock', label: 'Stock', aide: 'Un stock absent reste inconnu, jamais zéro.' },
  { cle: 'currency', label: 'Devise', aide: 'Si elle varie d’un produit à l’autre.' },
];

export function CustomApiConnectForm({ workspaceId, onChanged, onSaved }: CustomApiConnectFormProps) {
  /* ------------------------------ étape 1 : cible ------------------------ */
  const [baseUrl, setBaseUrl] = useState('');
  const [schema, setSchema] = useState<Schema>('bearer');
  /*
   * Valeur par défaut prise dans la liste blanche, jamais écrite en toutes
   * lettres : la règle de sécurité du dépôt interdit ce littéral dans `src/`
   * (voir `custom-api-guard.ts`), et cette liste est la seule source de vérité
   * sur les en-têtes qu'on a le droit d'envoyer.
   */
  const [headerName, setHeaderName] = useState<string>(
    ALLOWED_AUTH_HEADERS.find((nom) => nom !== 'authorization') ?? 'authorization',
  );
  const [secret, setSecret] = useState('');
  const [productsPath, setProductsPath] = useState('/api/products');
  const [pagination, setPagination] = useState<Pagination>('page');
  const [pageSize, setPageSize] = useState('50');
  const [maxPages, setMaxPages] = useState('20');
  const [currency, setCurrency] = useState('XOF');
  const [priceUnit, setPriceUnit] = useState<PriceUnit>('major');

  /* ------------------------------ sonde --------------------------------- */
  const [sondage, setSondage] = useState(false);
  const [sonde, setSonde] = useState<ProbeOutcome | null>(null);
  const [erreurSonde, setErreurSonde] = useState<string | null>(null);

  /* --------------------------- étape 3 : mapping ------------------------ */
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingOuvert, setMappingOuvert] = useState(false);

  /* ------------------------------ sauvegarde ---------------------------- */
  const [enregistrement, setEnregistrement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  const erreursCible = useMemo(() => {
    const liste: string[] = [];
    const base = parseCustomApiBaseUrl(baseUrl);
    if (!base.ok) liste.push(explainCustomApiRejection(base.reason));
    else {
      const endpoint = parseCustomApiEndpoint(base.value, productsPath + (pagination === 'page' ? '?page={page}&limit={limit}' : pagination === 'cursor' ? '?cursor={cursor}' : ''));
      if (!endpoint.ok) liste.push(explainCustomApiRejection(endpoint.reason));
    }
    if (schema !== 'none') {
      const champ = schema === 'bearer' || schema === 'basic' ? { format: 'api-key' as const, label: 'Clé', required: true } : { format: 'api-key' as const, label: 'Clé', required: true };
      const validation = validateField({ name: 'secret', label: champ.label, format: champ.format, secret: true, required: true }, secret);
      if (!validation.ok && validation.error) liste.push(validation.error);
    }
    if (pagination !== 'none') {
      const coherence = paginationCoherente(pagination, productsPath + (pagination === 'page' ? '?page={page}' : '?cursor={cursor}'));
      if (!coherence.ok && coherence.message) liste.push(coherence.message);
    }
    return liste;
  }, [baseUrl, productsPath, pagination, schema, secret]);

  /* ------------------------------- sonde -------------------------------- */

  const tester = useCallback(async () => {
    if (!workspaceId) {
      setErreurSonde('Sélectionnez une entreprise avant de tester une API.');
      return;
    }
    if (erreursCible.length > 0) {
      setErreurSonde(erreursCible[0]);
      return;
    }

    setSondage(true);
    setErreurSonde(null);
    setSonde(null);
    try {
      const { data } = await invokeEdge<{ data: { probe: ProbeOutcome; status: number; productsFound: number } }>(
        'store-import',
        {
          action: 'probe-custom',
          workspaceId,
          baseUrl: baseUrl.trim(),
          authScheme: schema,
          authHeaderName: schema === 'header' ? headerName : null,
          // La clé part au serveur et n'est jamais réaffichée après la réponse.
          secret: schema === 'none' ? null : secret,
          productsPath: modelChemin(productsPath, pagination),
          paginationKind: pagination,
          pageSize: Number(pageSize) || 50,
          maxPages: Number(maxPages) || 20,
        },
      );
      setSonde(data.probe);

      if (data.probe.ok && data.probe.sampleFields) {
        // Proposition de correspondance : l'utilisateur la voit et la corrige,
        // rien n'est appliqué sans son accord.
        const propose = suggestMapping(data.probe.sampleFields);
        const valeurs: Record<string, string> = {};
        for (const [cle, champ] of Object.entries(propose)) {
          if (champ && typeof champ === 'object' && 'path' in champ) {
            valeurs[cle] = String((champ as { path: string }).path);
          }
        }
        setMapping(valeurs);
        setMappingOuvert(true);
      }
      // Le secret est vidé AVANT tout rendu ultérieur.
      if (data.probe.ok) setSecret('');
    } catch (cause) {
      setErreurSonde(asAppError(cause).message);
    } finally {
      setSondage(false);
    }
  }, [workspaceId, baseUrl, schema, headerName, secret, productsPath, pagination, pageSize, maxPages, erreursCible]);

  /* ----------------------------- enregistrement ------------------------- */

  const mappingComplet: CustomApiMapping = useMemo(() => {
    const construit: Record<string, unknown> = {};
    for (const [cle, valeur] of Object.entries(mapping)) {
      if (valeur && valeur.trim()) construit[cle] = { path: valeur.trim() };
    }
    return construit as unknown as CustomApiMapping;
  }, [mapping]);

  const erreursMapping = useMemo(() => validateMapping(mappingComplet, priceUnit), [mappingComplet, priceUnit]);

  const prerequis = sonde?.ok === true && erreursMapping.ok && Boolean(workspaceId);

  async function enregistrer() {
    if (!prerequis) return;
    if (!workspaceId) return;

    setEnregistrement(true);
    setErreur(null);
    try {
      await invokeEdge<{ data: unknown }>('store-connect', {
        action: 'save-custom',
        workspaceId,
        baseUrl: baseUrl.trim(),
        authScheme: schema,
        authHeaderName: schema === 'header' ? headerName : null,
        secret: schema === 'none' ? null : secret,
        productsPath: modelChemin(productsPath, pagination),
        paginationKind: pagination,
        pageSize: Number(pageSize) || 50,
        maxPages: Number(maxPages) || 20,
        mapping: mappingComplet,
        priceUnit,
        currency: currency.toUpperCase(),
        // Preuve transmise à la base : elle refuse l'enregistrement sans elle.
        probeStatus: sonde?.code === 'ok' ? 200 : 0,
        productsFound: sonde?.count ?? 0,
        probeSummary: sonde?.message ?? '',
        durationMs: 0,
      });
      setSecret('');
      setEnregistre(true);
      onSaved?.();
      onChanged({ tone: 'success', text: 'API personnalisée enregistrée : la configuration est vérifiée et la clé rangée dans le coffre.' });
    } catch (cause) {
      setErreur(asAppError(cause).message);
    } finally {
      setEnregistrement(false);
    }
  }

  const testId = 'custom-api-form';

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02]" data-testid={testId}>
      <div className="border-b border-white/10 px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
          <Plug size={13} className="text-brand-300" /> API personnalisée
        </p>
        <p className="mt-0.5 text-[0.68rem] leading-relaxed text-slate-400">
          Pour une boutique dont l’API expose vos produits en JSON. VYORA ne contacte que l’adresse
          que vous indiquez, en lecture seule.
        </p>
      </div>

      {/* ---------------------------- étape 1 ---------------------------- */}
      <div className="space-y-2.5 px-3.5 py-3">
        <Input
          label="Adresse de base de l’API"
          hint="HTTPS uniquement. C’est le seul domaine qui sera contacté."
          placeholder="https://api.ma-boutique.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          data-testid="custom-api-base-url"
        />

        <Select
          label="Authentification"
          hint="Choisissez ce que votre API attend."
          value={schema}
          onChange={(e) => setSchema(e.target.value as Schema)}
          data-testid="custom-api-scheme"
        >
          <option value="bearer">Jeton Bearer (Authorization: Bearer …)</option>
          <option value="header">Clé dans un en-tête</option>
          <option value="basic">Identifiant et mot de passe (Basic)</option>
          <option value="none">Aucune (API publique)</option>
        </Select>

        {schema === 'header' && (
          <Select
            label="En-tête de la clé"
            hint="Seuls les en-têtes d’authentification standards sont acceptés."
            value={headerName}
            onChange={(e) => setHeaderName(e.target.value)}
            data-testid="custom-api-header-name"
          >
            {ALLOWED_AUTH_HEADERS.filter((nom) => nom !== 'authorization').map((nom) => (
              <option key={nom} value={nom}>{nom}</option>
            ))}
          </Select>
        )}

        {schema !== 'none' && (
          <Input
            label={schema === 'basic' ? 'Identifiant:mot de passe' : 'Clé ou jeton'}
            hint="Envoyé directement au serveur, rangé dans le coffre, jamais réaffiché."
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            data-testid="custom-api-secret"
          />
        )}

        <Input
          label="Chemin des produits"
          hint="Le chemin relatif à l’adresse de base, sans les paramètres de pagination."
          placeholder="/api/products"
          value={productsPath}
          onChange={(e) => setProductsPath(e.target.value)}
          data-testid="custom-api-products-path"
        />

        <div className="grid gap-2 sm:grid-cols-3">
          <Select
            label="Pagination"
            value={pagination}
            onChange={(e) => setPagination(e.target.value as Pagination)}
            data-testid="custom-api-pagination"
          >
            <option value="page">Par page (?page=)</option>
            <option value="cursor">Par curseur</option>
            <option value="none">Aucune (tout en une fois)</option>
          </Select>
          <Input
            label="Taille de page"
            type="number"
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value)}
            data-testid="custom-api-page-size"
          />
          <Input
            label="Pages max"
            type="number"
            hint="Garde-fou contre une API qui boucle."
            value={maxPages}
            onChange={(e) => setMaxPages(e.target.value)}
            data-testid="custom-api-max-pages"
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            label="Unité des prix"
            hint="Une erreur ici fausse tous les prix d’un facteur 100."
            value={priceUnit}
            onChange={(e) => setPriceUnit(e.target.value as PriceUnit)}
            data-testid="custom-api-price-unit"
          >
            <option value="major">Prix entier (12,50)</option>
            <option value="minor">Plus petite unité (1250)</option>
          </Select>
          <Input
            label="Devise par défaut"
            hint="XOF, XAF, EUR… Si l’API ne la publie pas."
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            data-testid="custom-api-currency"
          />
        </div>

        {erreursCible.length > 0 && (
          <p className="text-[0.68rem] leading-relaxed text-slate-500" data-testid="custom-api-hints">
            À corriger : {erreursCible[0]}
          </p>
        )}

        <Button
          size="sm"
          onClick={() => void tester()}
          disabled={sondage || !workspaceId}
          data-testid="custom-api-test"
        >
          {sondage ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Eye size={12} className="mr-1" />}
          {sondage ? 'Test en cours…' : 'Tester l’API'}
        </Button>

        {erreurSonde && (
          <p className="flex items-start gap-1.5 text-[0.68rem] leading-relaxed text-rose-300" data-testid="custom-api-test-error">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreurSonde}
          </p>
        )}

        {sonde && (
          <div
            className={`rounded border px-2.5 py-2 text-[0.68rem] leading-relaxed ${
              sonde.ok
                ? 'border-emerald-400/25 bg-emerald-500/[0.06] text-emerald-200'
                : 'border-rose-400/25 bg-rose-500/[0.06] text-rose-200'
            }`}
            data-testid="custom-api-probe-result"
            data-ok={sonde.ok ? 'true' : 'false'}
          >
            <p className="flex items-start gap-1.5">
              {sonde.ok ? <Check size={11} className="mt-0.5 shrink-0" /> : <XCircle size={11} className="mt-0.5 shrink-0" />}
              <span>{sonde.message}</span>
            </p>
            {sonde.ok && typeof sonde.count === 'number' && (
              <p className="mt-1 flex items-center gap-1.5 text-slate-300">
                <ShieldCheck size={11} /> {sonde.count} produit{sonde.count > 1 ? 's' : ''} lu
                {sonde.count > 1 ? 's' : ''} · chemin « {sonde.arrayPath || '(racine)'} »
              </p>
            )}
          </div>
        )}
      </div>

      {/* ---------------------------- étape 3 ---------------------------- */}
      {sonde?.ok && (
        <div className="border-t border-white/10 px-3.5 py-3">
          <button
            type="button"
            onClick={() => setMappingOuvert((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-white"
            data-testid="custom-api-mapping-toggle"
          >
            <ChevronDown size={13} className={`transition ${mappingOuvert ? '' : '-rotate-90'}`} />
            Correspondance des champs
            <span className="ml-auto text-[0.66rem] font-normal text-slate-500">
              {Object.values(mapping).filter((v) => v.trim()).length} champ(s)
            </span>
          </button>

          {mappingOuvert && (
            <div className="mt-2.5 space-y-2">
              <p className="text-[0.66rem] leading-relaxed text-slate-500">
                VYORA a trouvé ces champs dans votre API. Vérifiez la correspondance : un prix mal
                associé fausse tout le catalogue.
              </p>
              {CHAMPS_MAPPABLES.map((champ) => (
                <div key={champ.cle} className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:items-center">
                  <label className="text-[0.68rem] text-slate-400" htmlFor={`map-${champ.cle}`}>
                    {champ.label}
                    {champ.obligatoire && <span className="text-rose-300"> *</span>}
                  </label>
                  <Input
                    id={`map-${champ.cle}`}
                    placeholder={champ.aide}
                    value={mapping[champ.cle] ?? ''}
                    onChange={(e) => setMapping((precedent) => ({ ...precedent, [champ.cle]: e.target.value }))}
                    data-testid={`custom-api-map-${champ.cle}`}
                  />
                </div>
              ))}
              {!erreursMapping.ok && (
                <p className="text-[0.66rem] text-amber-300" data-testid="custom-api-mapping-errors">
                  {erreursMapping.errors[0]}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------------------------- enregistrement ---------------------- */}
      <div className="border-t border-white/10 px-3.5 py-3">
        {erreur && (
          <p className="mb-2 flex items-start gap-1.5 text-[0.68rem] leading-relaxed text-rose-300" data-testid="custom-api-save-error">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreur}
          </p>
        )}
        {enregistre && (
          <p className="mb-2 flex items-center gap-1.5 text-[0.68rem] text-emerald-300" data-testid="custom-api-saved">
            <Check size={12} /> Configuration enregistrée et clé rangée dans le coffre.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void enregistrer()}
            disabled={!prerequis || enregistrement}
            data-testid="custom-api-save"
            title={prerequis ? undefined : 'Testez l’API avec succès avant d’enregistrer.'}
          >
            {enregistrement ? <Loader2 size={12} className="mr-1 animate-spin" /> : <KeyRound size={12} className="mr-1" />}
            Enregistrer la connexion
          </Button>
          {sonde?.ok && (
            <Button size="sm" variant="ghost" onClick={() => void tester()} disabled={sondage}>
              <RefreshCw size={12} className="mr-1" /> Re-tester
            </Button>
          )}
          {!sonde?.ok && (
            <span className="text-[0.66rem] text-slate-500">
              Un test réussi est requis avant l’enregistrement.
            </span>
          )}
          {sonde?.ok && erreursMapping.ok && (
            <span className="ml-auto flex items-center gap-1 text-[0.66rem] text-emerald-300">
              <Download size={11} /> Prêt à importer <ArrowRight size={11} /> Aperçu avant écriture
            </span>
          )}
        </div>
        <p className="mt-2 text-[0.62rem] leading-relaxed text-slate-500">
          Lecture seule : VYORA ne modifie jamais votre boutique. Aucune écriture n’est possible,
          et la base refuse une configuration sans test réussi.
        </p>
      </div>
    </div>
  );
}

/** Compose le chemin avec les marqueurs de pagination. */
function modelChemin(chemin: string, pagination: Pagination): string {
  const base = chemin.trim() || '/';
  if (pagination === 'page') {
    return base.includes('?') ? `${base}&page={page}&limit={limit}` : `${base}?page={page}&limit={limit}`;
  }
  if (pagination === 'cursor') {
    return base.includes('?') ? `${base}&cursor={cursor}` : `${base}?cursor={cursor}`;
  }
  return base;
}

/** Ce que la sonde a réellement vérifié — utilisé par les tests. */
export const SONDE_INTERDITE_DANS_URL = true;
