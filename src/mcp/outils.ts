/**
 * Liste des outils MCP affichée dans l'interface VYORA.
 *
 * ## Pourquoi cette liste existe séparément
 *
 * Le catalogue réel vit dans `supabase/functions/vyora-mcp/core.ts`. Le bundle
 * client ne peut pas l'importer : la Edge Function s'exécute sous Deno avec des
 * conventions différentes, et l'importer tirerait du code serveur dans le
 * navigateur.
 *
 * La liste est donc recopiée — et `tests/mcp-tools-parity.test.ts` vérifie
 * qu'elle reste **identique** au catalogue serveur, nom pour nom et portée pour
 * portée. Sans ce test, l'interface pourrait annoncer un outil qui n'existe pas
 * (ou en oublier un), c'est-à-dire exactement le mensonge à éviter.
 */
export interface OutilAffiche {
  /** Nom exact attendu par `tools/call`. */
  nom: string;
  /** Libellé lisible, sans jargon. */
  libelle: string;
  /** `true` pour un outil qui modifie des données. */
  ecriture: boolean;
}

export const OUTILS_AFFICHES: readonly OutilAffiche[] = [
  { nom: 'vyora_account_info', libelle: 'Mon compte VYORA', ecriture: false },
  { nom: 'vyora_stores_list', libelle: 'Mes boutiques connectées', ecriture: false },
  { nom: 'vyora_products_list', libelle: 'Parcourir mon catalogue', ecriture: false },
  { nom: 'vyora_product_get', libelle: 'Lire la fiche d’un produit', ecriture: false },
  { nom: 'vyora_imports_list', libelle: 'Mon historique d’importation', ecriture: false },
  { nom: 'vyora_import_previews_list', libelle: 'Mes aperçus d’import', ecriture: false },
  { nom: 'vyora_integrations_status', libelle: 'État de mes intégrations', ecriture: false },
  { nom: 'vyora_projects_list', libelle: 'Mes projets vidéo', ecriture: false },
  { nom: 'vyora_generations_list', libelle: 'Mes générations', ecriture: false },
  { nom: 'vyora_history_list', libelle: 'Mon historique d’usage', ecriture: false },
  { nom: 'vyora_integrations_list', libelle: 'Mes intégrations', ecriture: false },
  { nom: 'vyora_product_create', libelle: 'Créer un produit', ecriture: true },
  { nom: 'vyora_project_create', libelle: 'Créer un projet vidéo', ecriture: true },
];

/** Sous-ensemble lecture seule : ce qu'un jeton `read` peut réellement appeler. */
export const OUTILS_LECTURE_AFFICHES = OUTILS_AFFICHES.filter((o) => !o.ecriture);
