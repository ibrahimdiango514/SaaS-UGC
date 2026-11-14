// VYORA — point d'entrée du bundle de production des trois fonctions de paiement.
//
// Les sources `vyora-payments/index.ts`, `vyora-saspay-webhook/index.ts` et
// `vyora-payments-reconcile/index.ts` importent ce dossier : le canal de
// déploiement disponible n'achemine ni une source multi-fichiers ni un texte
// long. Ce module regroupe donc les trois gestionnaires dans UN bundle
// (`supabase/functions/vyora-saspay.edge.js`), et chaque fonction déployée est
// un chargeur court (`<fonction>/loader.ts`) qui désigne son gestionnaire par
// `globalThis.__vyoraSaspayFunction`.
//
// Aucune logique ici : la même fabrique que `index.ts`, avec le même
// environnement. Un nom inconnu arrête le démarrage au lieu de servir un
// gestionnaire par défaut.
import {
  createPaymentsHandler,
  createReconcileHandler,
  createWebhookHandler,
  readPaymentsEnv,
} from './http.ts';

type Handler = (request: Request) => Promise<Response>;
type DenoLike = { env: { get(key: string): string | undefined }; serve(handler: Handler): void };

const scope = globalThis as unknown as { Deno: DenoLike; __vyoraSaspayFunction?: unknown };
const env = readPaymentsEnv((key) => scope.Deno.env.get(key) ?? '');

const name = scope.__vyoraSaspayFunction;
if (name === 'vyora-payments') scope.Deno.serve(createPaymentsHandler({ env }));
else if (name === 'vyora-saspay-webhook') scope.Deno.serve(createWebhookHandler({ env }));
else if (name === 'vyora-payments-reconcile') scope.Deno.serve(createReconcileHandler({ env }));
else throw new Error('vyora_saspay_unknown_function');
