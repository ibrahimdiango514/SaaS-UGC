/**
 * VYORA — panneau d'import de boutique.
 *
 * ## Parcours, en trois étapes visibles
 *
 *   1. **Choisir la source** : URL de boutique, ou fichier (CSV/XLSX/XML).
 *   2. **Prévisualiser** : produits, prix, images, catégories, variantes,
 *      doublons et avertissements. Rien n'est encore écrit.
 *   3. **Confirmer** : l'écriture n'a lieu qu'après un clic explicite, et le
 *      décompte des produits réellement créés est rapporté tel quel.
 *
 * ## Import par URL : toujours via le serveur
 *
 * Le navigateur ne contacte **jamais** la boutique : il ne peut ni résoudre le
 * DNS ni épingler une IP. L'URL part vers l'Edge Function `store-import`
 * (`relay.ts`), qui valide, résout, contrôle chaque adresse avant connexion,
 * lit le catalogue et renvoie un aperçu. La confirmation renvoie le
 * `previewId` émis par le serveur — le navigateur ne peut donc pas écrire un
 * catalogue qu'il n'a pas prévisualisé.
 *
 * ## Ce que l'interface ne fait pas
 *
 * - Aucune requête réseau directe vers la boutique (import fichier = lecture
 *   locale ; import URL = serveur).
 * - Aucun produit affiché tant que la prévisualisation n'a pas réussi.
 * - Aucune écriture sans confirmation explicite.
 * - Aucun produit créé pendant l'aperçu, ni côté navigateur ni côté serveur.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, FileSpreadsheet, Globe, ImageOff, Link2, Loader2, Package, Upload, X,
} from 'lucide-react';
import { Button, cn } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { createProduct } from '../../lib/api';
import {
  formatPreviewPrice, runFileImport, type ImportBatch,
} from './pipeline';
import { PLATFORM_LABELS } from './platform';
import { importStore, previewStore, type StorePreview } from './relay';

export interface StoreImportPanelProps {
  workspaceId: string | null;
  /** Catalogue existant, pour la détection de doublons. */
  existing: Array<{ id: string; name: string }>;
  /** Appelé après une écriture réussie, pour rafraîchir la liste. */
  onImported: () => void | Promise<void>;
  onClose: () => void;
}

type Étape = 'source' | 'apercu' | 'ecriture';

export function StoreImportPanel({ workspaceId, existing, onImported, onClose }: StoreImportPanelProps) {
  const [étape, setÉtape] = useState<Étape>('source');
  const [lot, setLot] = useState<ImportBatch | null>(null);
  const [erreurs, setErreurs] = useState<string[]>([]);
  const [avertissements, setAvertissements] = useState<string[]>([]);
  const [chargement, setChargement] = useState(false);
  const [écriture, setÉcriture] = useState(false);
  const [résultat, setRésultat] = useState<{ créés: number; échecs: Array<{ nom: string; raison: string }> } | null>(null);
  const [glisser, setGlisser] = useState(false);
  const fichierInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  /** Aperçu renvoyé par le serveur : seule source d'une écriture par URL. */
  const [apercuServeur, setApercuServeur] = useState<StorePreview | null>(null);

  /**
   * L'aperçu par URL passe par l'Edge Function `store-import`, seule à disposer
   * d'un résolveur DNS et d'une connexion épinglée sur l'IP validée. Aucun appel
   * direct à la boutique n'est possible depuis le navigateur.
   */
  const relaisDisponible = typeof window !== 'undefined';

  const réinitialiser = useCallback(() => {
    setLot(null);
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    setÉtape('source');
  }, []);

  const traiterFichier = async (fichier: File) => {
    setChargement(true);
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    try {
      const octets = new Uint8Array(await fichier.arrayBuffer());
      const résultat = await runFileImport(octets, fichier.name, { existing });
      if (!résultat.ok) {
        setErreurs(résultat.errors);
        setLot(null);
        return;
      }
      setLot(résultat.batch);
      setAvertissements(résultat.batch.warnings);
      setÉtape('apercu');
    } catch (erreur) {
      setErreurs([asAppError(erreur).message]);
    } finally {
      setChargement(false);
    }
  };

  /**
   * Aperçu d'une boutique par URL — **aucune écriture**.
   *
   * L'URL part au serveur qui la valide, résout le DNS, contrôle chaque adresse
   * avant connexion et lit le catalogue public. Le navigateur n'ouvre aucune
   * connexion vers la boutique.
   */
  const prévisualiserUrl = async () => {
    if (!workspaceId) {
      setErreurs(['Sélectionnez une entreprise avant d’importer.']);
      return;
    }
    const saisie = url.trim();
    if (!saisie) {
      setErreurs(['Saisissez l’adresse de votre boutique (https://…).']);
      return;
    }
    setChargement(true);
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    setApercuServeur(null);
    setLot(null);
    try {
      const apercu = await previewStore({ workspaceId, url: saisie });
      setApercuServeur(apercu);
      setAvertissements(apercu.warnings);
      setÉtape('apercu');
    } catch (erreur) {
      setErreurs([asAppError(erreur).message]);
    } finally {
      setChargement(false);
    }
  };

  /**
   * Confirmation de l'import par URL.
   *
   * Envoie le `previewId` émis par le serveur : le navigateur ne peut pas
   * écrire un catalogue qu'il n'a pas prévisualisé, et un aperçu ne se rejoue
   * pas. Les produits retenus sont ceux que le serveur a marqués importables.
   */
  const confirmerUrl = async () => {
    if (!apercuServeur || !workspaceId) return;
    setÉcriture(true);
    setÉtape('ecriture');
    try {
      const sélection = apercuServeur.products.filter((p) => p.importable).map((p) => p.index);
      const résultat = await importStore({
        workspaceId,
        previewId: apercuServeur.previewId,
        selection: sélection,
      });
      setRésultat({
        créés: résultat.created,
        échecs: résultat.failed.map((f) => ({ nom: f.name, raison: f.reason })),
      });
      setApercuServeur(null);
      if (résultat.created > 0) await onImported();
    } catch (erreur) {
      // Aperçu expiré ou consommé : on renvoie vers un nouvel aperçu.
      setErreurs([asAppError(erreur).message]);
      setApercuServeur(null);
      setÉtape('source');
    } finally {
      setÉcriture(false);
    }
  };

  const surDépôt = async (événement: React.DragEvent<HTMLDivElement>) => {
    événement.preventDefault();
    setGlisser(false);
    const fichier = événement.dataTransfer.files?.[0];
    if (fichier) await traiterFichier(fichier);
  };

  /**
   * Écriture.
   *
   * Un produit en échec n'interrompt pas les suivants : on rapporte le détail.
   * Les doublons internes au lot sont ignorés à l'écriture (le premier garde la
   * place) ; les doublons du catalogue existant sont créés, car l'utilisateur a
   * pu le décider explicitement en confirmant.
   */
  const écrire = async () => {
    if (!lot || !workspaceId) return;
    setÉcriture(true);
    setÉtape('ecriture');
    const doublonsInternes = new Set(lot.duplicates.filter((d) => d.kind === 'in-batch').map((d) => d.index));
    const échecs: Array<{ nom: string; raison: string }> = [];
    let créés = 0;

    for (const [index, produit] of lot.products.entries()) {
      if (doublonsInternes.has(index)) continue;
      try {
        await createProduct({
          workspace_id: workspaceId,
          name: produit.name,
          description: produit.description || null,
          price_amount: produit.priceMinor === null
            ? null
            : (['XOF', 'XAF', 'JPY', 'KRW', 'CLP'].includes(produit.currency)
              ? produit.priceMinor
              : produit.priceMinor / 100),
          price_currency: produit.currency,
          product_url: produit.productUrl,
          key_benefits: produit.categories.slice(0, 8),
        });
        créés += 1;
      } catch (erreur) {
        échecs.push({ nom: produit.name, raison: asAppError(erreur).message });
      }
    }

    setRésultat({ créés, échecs });
    setÉcriture(false);
    if (créés > 0) await onImported();
  };

  const aperçu = useMemo(() => lot?.products.slice(0, 40) ?? [], [lot]);
  const total = lot?.summary.total ?? 0;
  const àCréer = lot ? lot.summary.importable : 0;

  return (
    <div className="rounded-2xl border border-cyan-300/20 bg-cyan-400/[0.03] p-4" data-testid="store-importer">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-cyan-100">
            <Package size={14} /> Importer un catalogue
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Rien n’est enregistré avant votre confirmation. Les prix, images et
            catégories sont vérifiés avant l’aperçu.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-slate-500 transition hover:text-white" aria-label="Fermer l’import">
          <X size={16} />
        </button>
      </div>

      {erreurs.length > 0 && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2.5 text-[11px] text-rose-100">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={13} /> Import impossible</p>
          <ul className="mt-1 space-y-0.5">
            {erreurs.map((erreur) => <li key={erreur}>· {erreur}</li>)}
          </ul>
        </div>
      )}

      {/* Étape 1 — source */}
      {étape === 'source' && (
        <div className="mt-3 space-y-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setGlisser(true); }}
            onDragLeave={() => setGlisser(false)}
            onDrop={(e) => void surDépôt(e)}
            className={cn(
              'rounded-xl border border-dashed px-4 py-6 text-center transition',
              glisser ? 'border-cyan-300/60 bg-cyan-400/[0.08]' : 'border-white/15 bg-black/20',
            )}
          >
            <FileSpreadsheet size={22} className="mx-auto text-cyan-300/80" />
            <p className="mt-2 text-xs text-slate-300">Déposez un fichier CSV, XLSX ou XML</p>
            <p className="mt-0.5 text-[10px] text-slate-500">8 Mio maximum · aucune formule n’est évaluée</p>
            <input
              ref={fichierInput}
              type="file"
              accept=".csv,.tsv,.xlsx,.xml,text/csv,application/xml,text/xml"
              className="sr-only"
              onChange={(e) => {
                const fichier = e.target.files?.[0];
                if (fichier) void traiterFichier(fichier);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              loading={chargement}
              onClick={() => fichierInput.current?.click()}
              icon={<Upload size={13} />}
            >
              Choisir un fichier
            </Button>
          </div>

          <div className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
              <Globe size={13} className="text-slate-500" /> Importer depuis une URL de boutique
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Lecture effectuée par le serveur VYORA : vérification DNS, refus des
              adresses internes et connexion épinglée sur l’adresse contrôlée.
              Votre navigateur ne contacte jamais la boutique.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="url"
                inputMode="url"
                value={url}
                onChange={(événement) => setUrl(événement.target.value)}
                onKeyDown={(événement) => {
                  if (événement.key === 'Enter') {
                    événement.preventDefault();
                    void prévisualiserUrl();
                  }
                }}
                placeholder="https://ma-boutique.com"
                aria-label="Adresse de la boutique"
                disabled={chargement || !workspaceId || !relaisDisponible}
                className="min-w-0 flex-1 rounded-lg border border-white/[0.09] bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/40 focus:outline-none disabled:opacity-50"
                data-testid="store-url-input"
              />
              <Button
                size="sm"
                variant="outline"
                loading={chargement}
                disabled={!workspaceId || !url.trim()}
                onClick={() => void prévisualiserUrl()}
                icon={<Link2 size={13} />}
                data-testid="store-url-preview"
              >
                Prévisualiser
              </Button>
            </div>
            {!workspaceId && (
              <p className="mt-1.5 text-[10px] text-amber-200">
                Sélectionnez une entreprise pour importer dans son catalogue.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Étape 2 (URL) — aperçu renvoyé par le serveur, aucune écriture */}
      {étape === 'apercu' && apercuServeur && (
        <div className="mt-3" data-testid="store-url-preview-panel">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-cyan-100">
              {PLATFORM_LABELS[apercuServeur.origin.platform]}
            </span>
            <span className="text-slate-400">{apercuServeur.summary.total} produit(s) détecté(s)</span>
            {apercuServeur.summary.duplicateInBatch > 0 && (
              <span className="text-amber-200">{apercuServeur.summary.duplicateInBatch} doublon(s) dans la source</span>
            )}
            {apercuServeur.summary.duplicateExisting > 0 && (
              <span className="text-amber-200">{apercuServeur.summary.duplicateExisting} déjà dans votre catalogue</span>
            )}
            {apercuServeur.summary.unpriced > 0 && (
              <span className="text-slate-500">{apercuServeur.summary.unpriced} sans prix (à compléter)</span>
            )}
          </div>

          {avertissements.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100">
              {avertissements.slice(0, 4).map((avertissement) => <p key={avertissement}>· {avertissement}</p>)}
            </div>
          )}

          <ul className="vy-scroll mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1" data-testid="store-url-preview">
            {apercuServeur.products.slice(0, 40).map((produit) => (
              <li
                key={`${produit.index}-${produit.name}`}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-2.5 py-2',
                  produit.duplicate ? 'border-amber-400/20 bg-amber-400/[0.04]' : 'border-white/[0.07] bg-black/20',
                )}
                data-testid={`store-url-preview-${produit.index}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white/[0.05] text-slate-600">
                  <Package size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{produit.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                    <span className={produit.price ? 'text-slate-300' : 'text-amber-300/80'}>
                      {produit.price || 'prix à compléter'}
                    </span>
                    {produit.productUrl && (
                      <a
                        href={produit.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-cyan-300/80 underline underline-offset-2"
                      >
                        <Link2 size={9} /> fiche
                      </a>
                    )}
                  </p>
                  {produit.warnings.length > 0 && (
                    <p className="mt-0.5 text-[10px] text-amber-200/80">{produit.warnings.join(' · ')}</p>
                  )}
                  {produit.duplicate && (
                    <p className="mt-0.5 text-[10px] text-amber-300">
                      {produit.duplicate === 'in-batch'
                        ? 'Doublon dans la source — ne sera pas créé deux fois'
                        : 'Existe déjà dans votre catalogue — sera créé si vous confirmez'}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {apercuServeur.products.length > 40 && (
            <p className="mt-1 text-[10px] text-slate-500">
              Aperçu limité à 40 produits sur {apercuServeur.summary.total}.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={écriture || !workspaceId || apercuServeur.summary.importable === 0}
              onClick={() => void confirmerUrl()}
              icon={<Check size={13} />}
              data-testid="store-url-confirm"
            >
              Importer {apercuServeur.summary.importable} produit(s)
            </Button>
            <Button size="sm" variant="ghost" onClick={réinitialiser} icon={<ArrowLeft size={13} />}>
              Changer de source
            </Button>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            Aucun produit n’a été créé à cette étape. L’import n’a lieu qu’après votre
            confirmation, et l’aperçu expire au bout de dix minutes.
          </p>
        </div>
      )}

      {/* Étape 2 — aperçu */}
      {étape === 'apercu' && lot && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-cyan-100">
              {lot.origin.kind === 'file' ? lot.origin.reference : PLATFORM_LABELS[lot.origin.platform]}
            </span>
            <span className="text-slate-400">{lot.summary.total} produit(s) détecté(s)</span>
            {lot.summary.duplicateInBatch > 0 && (
              <span className="text-amber-200">{lot.summary.duplicateInBatch} doublon(s) dans le fichier</span>
            )}
            {lot.summary.duplicateExisting > 0 && (
              <span className="text-amber-200">{lot.summary.duplicateExisting} déjà dans votre catalogue</span>
            )}
            {lot.summary.unpriced > 0 && (
              <span className="text-slate-500">{lot.summary.unpriced} sans prix (à compléter)</span>
            )}
          </div>

          {avertissements.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100">
              {avertissements.slice(0, 4).map((avertissement) => <p key={avertissement}>· {avertissement}</p>)}
            </div>
          )}

          <ul className="vy-scroll mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1" data-testid="import-preview">
            {aperçu.map((produit, index) => {
              const doublon = lot.duplicates.find((d) => d.index === index);
              return (
                <li
                  key={`${produit.fingerprint}-${index}`}
                  className={cn(
                    'flex items-start gap-2.5 rounded-lg border px-2.5 py-2',
                    doublon ? 'border-amber-400/20 bg-amber-400/[0.04]' : 'border-white/[0.07] bg-black/20',
                  )}
                  data-testid={`import-preview-${index}`}
                >
                  {produit.imageUrl ? (
                    // Aperçu distant : l'URL a déjà été validée en https par la
                    // normalisation. `loading="lazy"` évite 40 requêtes d'un coup.
                    <img
                      src={produit.imageUrl}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-9 w-9 shrink-0 rounded object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white/[0.05] text-slate-600">
                      <ImageOff size={13} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white">{produit.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                      <span className={produit.priceMinor === null ? 'text-amber-300/80' : 'text-slate-300'}>
                        {formatPreviewPrice(produit)}
                      </span>
                      {produit.categories.length > 0 && <span>· {produit.categories.slice(0, 2).join(', ')}</span>}
                      {produit.variants.length > 0 && <span>· {produit.variants.length} variante(s)</span>}
                      {produit.productUrl && (
                        <a
                          href={produit.productUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-cyan-300/80 underline underline-offset-2"
                        >
                          <Link2 size={9} /> fiche
                        </a>
                      )}
                    </p>
                    {produit.warnings.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-amber-200/80">{produit.warnings.join(' · ')}</p>
                    )}
                    {doublon && (
                      <p className="mt-0.5 text-[10px] text-amber-300">
                        {doublon.kind === 'in-batch'
                          ? 'Doublon dans le fichier — ne sera pas créé deux fois'
                          : 'Existe déjà dans votre catalogue — sera créé si vous confirmez'}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {lot.products.length > aperçu.length && (
            <p className="mt-1 text-[10px] text-slate-500">
              Aperçu limité à {aperçu.length} produits sur {total}. Tous seront importés.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={écriture || !workspaceId}
              onClick={() => void écrire()}
              icon={<Check size={13} />}
              data-testid="import-confirm"
            >
              Importer {àCréer} produit(s)
            </Button>
            <Button size="sm" variant="ghost" onClick={réinitialiser} icon={<ArrowLeft size={13} />}>
              Changer de source
            </Button>
          </div>
        </div>
      )}

      {/* Étape 3 — écriture */}
      {étape === 'ecriture' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-300">
          {écriture ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} className="text-emerald-400" />}
          {écriture ? 'Import en cours…' : 'Import terminé.'}
        </div>
      )}

      {résultat && (
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5 text-[11px]" data-testid="import-result">
          <p className="text-emerald-200">{résultat.créés} produit(s) créé(s) dans votre catalogue.</p>
          {résultat.échecs.length > 0 && (
            <>
              <p className="mt-1 text-rose-200">{résultat.échecs.length} produit(s) non créé(s) :</p>
              <ul className="mt-0.5 space-y-0.5 text-rose-100/80">
                {résultat.échecs.slice(0, 5).map((échec) => (
                  <li key={échec.nom}>· {échec.nom} : {échec.raison}</li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={réinitialiser}>Importer une autre source</Button>
            <Button size="sm" variant="ghost" onClick={onClose}>Terminer</Button>
          </div>
        </div>
      )}
    </div>
  );
}

