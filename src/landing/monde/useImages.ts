import { useEffect, useState } from 'react';

/**
 * Charge des images locales sans Suspense.
 *
 * ## Pourquoi pas `useTexture`
 * `useTexture` suspend le rendu : le canvas entier disparaît jusqu'à ce que la
 * dernière image soit arrivée. Ici le téléphone et son écran sont dessinés
 * immédiatement ; les visuels de plans apparaissent quand ils sont prêts. Une
 * image manquante ne doit jamais vider la scène.
 */
export function useImages(urls: readonly string[]): Array<HTMLImageElement | null> {
  const [images, setImages] = useState<Array<HTMLImageElement | null>>(() =>
    urls.map(() => null),
  );

  useEffect(() => {
    let vivant = true;
    const chargees: Array<HTMLImageElement | null> = urls.map(() => null);

    const promesses = urls.map(
      (url, index) =>
        new Promise<void>((resoudre) => {
          const image = new Image();
          image.decoding = 'async';
          image.onload = () => {
            chargees[index] = image;
            resoudre();
          };
          image.onerror = () => resoudre();
          image.src = url;
        }),
    );

    void Promise.all(promesses).then(() => {
      if (vivant) setImages([...chargees]);
    });

    return () => {
      vivant = false;
    };
  }, [urls]);

  return images;
}
