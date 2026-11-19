import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dictée vocale du chat — transcription réelle par le navigateur.
 *
 * ## Ce qui est utilisé, et pourquoi
 *
 * L'API `SpeechRecognition` (préfixée `webkitSpeechRecognition` sur Chrome,
 * Edge, Samsung Internet et la plupart des navigateurs Android) transcrit la
 * parole **sur l'appareil ou via le service du navigateur**. Ce n'est pas une
 * simulation : le texte produit est un vrai résultat de reconnaissance vocale.
 *
 * Aucun service payant, aucune clé, aucun envoi de notre côté — et donc aucun
 * coût, aucune donnée audio qui transite par nos serveurs. C'est le seul choix
 * honnête aujourd'hui : il n'existe pas d'Edge de transcription déployée dans ce
 * dépôt, et brancher un fournisseur payant sans clé configurée aurait produit un
 * bouton qui échoue en silence.
 *
 * ## Ce qui n'est pas promis
 *
 * - **Firefox** n'implémente pas l'API : `disponible` vaut `false`, le bouton
 *   n'est pas affiché et la raison est exposée (`raisonIndisponible`).
 * - **Safari** l'implémente partiellement ; la dictée peut s'arrêter seule et
 *   être relancée par l'utilisateur. On ne masque pas ces interruptions.
 * - La **ponctuation** dépend du navigateur. Le texte reste modifiable avant
 *   envoi : c'est pour cela qu'on écrit dans le composeur au lieu d'envoyer
 *   directement.
 *
 * ## Permission micro
 *
 * `netlify.toml` porte `microphone=(self)` : sans cette ouverture, le navigateur
 * refuserait sans même demander l'accord. Le refus explicite de l'utilisateur
 * (`NotAllowedError`) est traité comme un état normal, pas comme une panne : le
 * message le dit et propose de réessayer.
 */

/** Sous-ensemble de l'API navigateur réellement utilisé. */
interface MoteurDictee {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: DicteeResultat) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

interface DicteeResultat {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
}

type ConstructeurDictee = new () => MoteurDictee;

function obtenirConstructeur(): ConstructeurDictee | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: ConstructeurDictee;
    webkitSpeechRecognition?: ConstructeurDictee;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface EtatDictee {
  /** L'API existe dans ce navigateur. */
  disponible: boolean;
  /** Pourquoi elle ne l'est pas — affiché à l'utilisateur, jamais masqué. */
  raisonIndisponible: string | null;
  /** Une écoute est en cours. */
  ecoute: boolean;
  /** Texte intermédiaire (non final) affiché pendant la parole. */
  provisoire: string;
  /** Message d'erreur lisible, ou `null`. */
  erreur: string | null;
  demarrer: () => void;
  arreter: () => void;
  effacerErreur: () => void;
}

/**
 * @param onTexte Appelé à chaque fragment FINAL. Le composeur l'insère à la
 * position du curseur ; on ne remplace jamais ce que l'utilisateur a déjà écrit.
 */
export function useDictee(onTexte: (texte: string) => void, langue = 'fr-FR'): EtatDictee {
  const [disponible] = useState(() => obtenirConstructeur() !== null);
  const [raisonIndisponible] = useState<string | null>(() => {
    if (typeof window === 'undefined') return 'La dictée n’est pas disponible côté serveur.';
    if (obtenirConstructeur()) return null;
    /*
     * Message précis plutôt que « non supporté » : sans cela, un utilisateur sur
     * Firefox conclut que l'application est cassée. On nomme la cause et une
     * alternative réelle.
     */
    return 'Ce navigateur ne propose pas la dictée vocale. Chrome, Edge et Samsung Internet sur Android la prennent en charge ; vous pouvez aussi saisir votre message au clavier.';
  });
  const [ecoute, setEcoute] = useState(false);
  const [provisoire, setProvisoire] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const moteurRef = useRef<MoteurDictee | null>(null);
  // Une écoute interrompue par le navigateur (`onend`) ne doit pas relancer
  // indéfiniment : on ne relance que si l'utilisateur n'a pas demandé l'arrêt.
  const arretDemandeRef = useRef(false);
  const rappelRef = useRef(onTexte);
  rappelRef.current = onTexte;

  const arreter = useCallback(() => {
    arretDemandeRef.current = true;
    setEcoute(false);
    setProvisoire('');
    try {
      moteurRef.current?.stop();
    } catch {
      /* déjà arrêté : rien à faire */
    }
  }, []);

  // Couper le micro au démontage : quitter la page pendant une écoute ne doit
  // jamais laisser un périphérique actif en arrière-plan.
  useEffect(() => () => {
    arretDemandeRef.current = true;
    try {
      moteurRef.current?.abort();
    } catch {
      /* rien */
    }
  }, []);

  const demarrer = useCallback(() => {
    const Constructeur = obtenirConstructeur();
    if (!Constructeur) return;
    setErreur(null);
    arretDemandeRef.current = false;

    // Une instance par session d'écoute : réutiliser la précédente après une
    // erreur donne des comportements différents selon les navigateurs.
    let moteur: MoteurDictee;
    try {
      moteur = new Constructeur();
    } catch {
      setErreur('Impossible de démarrer la dictée dans ce navigateur.');
      return;
    }

    moteur.lang = langue;
    // `continuous` n'est honoré que par certains navigateurs ; quand il ne l'est
    // pas, `onend` survient après une pause et on ne relance pas tout seul (ce
    // serait du repérage incontrôlé du micro). L'utilisateur relance d'un clic.
    moteur.continuous = true;
    moteur.interimResults = true;
    moteur.maxAlternatives = 1;

    moteur.onstart = () => setEcoute(true);

    moteur.onresult = (event) => {
      let final = '';
      let intermediaire = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const alternatif = event.results[i];
        const texte = alternatif?.[0]?.transcript ?? '';
        if (alternatif?.isFinal) final += texte;
        else intermediaire += texte;
      }
      setProvisoire(intermediaire);
      if (final.trim()) {
        // Un espace de séparation : la dictée s'insère dans un texte existant.
        rappelRef.current(final.trim());
      }
    };

    moteur.onerror = (event) => {
      const code = event?.error ?? '';
      setEcoute(false);
      setProvisoire('');
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        /*
         * Refus de permission. Ce n'est pas une panne : on explique comment
         * revenir en arrière, sans harceler ni redemander en boucle.
         */
        setErreur('Micro refusé. Autorisez le microphone pour ce site dans les réglages du navigateur, puis réessayez.');
      } else if (code === 'no-speech') {
        setErreur('Aucune parole détectée. Réessayez en parlant plus près du micro.');
      } else if (code === 'audio-capture') {
        setErreur('Aucun microphone détecté sur cet appareil.');
      } else if (code === 'network') {
        setErreur('La reconnaissance vocale a besoin du réseau et n’a pas pu joindre son service.');
      } else if (code === 'aborted') {
        // Arrêt volontaire : aucun message.
        setErreur(null);
      } else {
        setErreur('La dictée s’est interrompue. Vous pouvez réessayer.');
      }
    };

    moteur.onend = () => {
      setEcoute(false);
      setProvisoire('');
      moteurRef.current = null;
    };

    moteurRef.current = moteur;
    try {
      moteur.start();
      setEcoute(true);
    } catch {
      // `start()` lève si une écoute est déjà active ; on ne masque pas l'état.
      setErreur('La dictée est déjà en cours.');
    }
  }, [langue]);

  return {
    disponible,
    raisonIndisponible,
    ecoute,
    provisoire,
    erreur,
    demarrer,
    arreter,
    effacerErreur: () => setErreur(null),
  };
}
