/**
 * Hook d'accès au module Import & Connect.
 *
 * ## Ce qu'il garantit
 * - L'état vient TOUJOURS du serveur, jamais d'une valeur locale, d'un cache
 *   persistant ou d'un paramètre d'URL.
 * - Il est relu à chaque montage : revenir sur le module après une expiration
 *   affiche le refus, sans redémarrage.
 * - En cas d'échec, l'état est `unknown` et l'accès est refusé (pas d'ouverture
 *   par défaut).
 *
 * ## Ce qu'il ne fait pas
 * Il ne décide pas si une opération est autorisée. Les boutons qu'il désactive
 * sont un confort ; le serveur revérifie chaque appel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadImportAccess, unknownAccess, type ImportAccessState,
} from './access';

export interface ImportAccessHandle {
  access: ImportAccessState | null;
  loading: boolean;
  /** Relit les droits — utile après un paiement ou un renouvellement. */
  refresh: () => Promise<void>;
}

export function useImportAccess(enabled = true): ImportAccessHandle {
  const [access, setAccess] = useState<ImportAccessState | null>(null);
  const [loading, setLoading] = useState(enabled);
  // Évite un `setState` après démontage (changement d'onglet pendant l'appel).
  const vivant = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const etat = await loadImportAccess();
    if (!vivant.current) return;
    setAccess(etat);
    setLoading(false);
  }, []);

  useEffect(() => {
    vivant.current = true;
    if (!enabled) {
      // Sans session établie, on ne prétend rien : état inconnu, accès fermé.
      setAccess(unknownAccess('Session requise pour vérifier l’abonnement.'));
      setLoading(false);
      return () => { vivant.current = false; };
    }
    void refresh();
    return () => { vivant.current = false; };
  }, [enabled, refresh]);

  return { access, loading, refresh };
}
