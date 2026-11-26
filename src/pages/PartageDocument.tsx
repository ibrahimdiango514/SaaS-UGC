/**
 * Page publique de consultation d'un document partagé.
 *
 * Elle ne lit RIEN en base et n'appelle aucune API : le document vient
 * entièrement du fragment d'URL, que le navigateur ne transmet pas au serveur.
 * Conséquence utile : un lien partagé ne peut pas exposer les données d'une
 * autre entreprise, même si l'URL est devinée — il n'y a pas de requête à
 * détourner.
 *
 * Le statut « vu » est enregistré côté vendeur quand il ouvre lui-même le lien
 * depuis l'application ; ici, on affiche seulement le document au destinataire.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Badge, Button, Card } from '../components/ui';
import {
  LANGUES_DOCUMENT, documentDepuisPartage, documentImprimable,
  type DocumentPartageable, type LangueDocument,
} from '../business/sales/document';

export default function PartageDocument() {
  const location = useLocation();
  const document: DocumentPartageable | null = useMemo(
    () => documentDepuisPartage(location.hash),
    [location.hash],
  );
  const [langue, setLangue] = useState<LangueDocument>('fr');

  useEffect(() => {
    if (document) window.document.title = `${document.kind} ${document.number}`;
  }, [document]);

  if (!document) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <Card>
          <h1 className="text-lg font-semibold text-white">Lien incomplet</h1>
          <p className="mt-2 text-sm text-slate-400">
            Ce lien ne contient aucun document lisible. Il a peut-être été tronqué par
            la messagerie qui l’a transmis : demandez à votre interlocuteur de le renvoyer
            en entier, ou de vous envoyer le document en PDF.
          </p>
        </Card>
      </div>
    );
  }

  const html = documentImprimable(document, langue);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6" data-testid="partage-document">
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-white">
              {document.kind === 'facture' ? 'Facture' : document.kind === 'devis' ? 'Devis' : 'Commande'} {document.number}
            </h1>
            <p className="text-[11px] text-slate-400">{document.entreprise}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">Document partagé</Badge>
            <select
              value={langue}
              onChange={(event) => setLangue(event.target.value as LangueDocument)}
              aria-label="Langue du document"
              className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white"
            >
              {LANGUES_DOCUMENT.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Impression / « Enregistrer en PDF » : aucun service externe.
                const fenetre = window.open('', '_blank', 'noopener,noreferrer');
                if (!fenetre) return;
                fenetre.document.write(html);
                fenetre.document.close();
                fenetre.focus();
              }}
            >
              Version imprimable
            </Button>
          </div>
        </div>

        <div
          className="overflow-hidden rounded-xl border border-white/[0.06] bg-white p-4 text-[#111]"
          // Le HTML est produit par `documentImprimable`, qui échappe chaque
          // valeur avec `echapper()` : aucune donnée n'est injectée brute.
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <p className="mt-2 text-[10px] text-slate-500">
          Ce document est contenu dans le lien lui-même : il n’est pas stocké sur un serveur
          de partage et n’ouvre l’accès à aucune autre donnée.
        </p>
      </Card>
    </div>
  );
}
