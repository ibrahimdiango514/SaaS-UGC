import { Link } from 'react-router-dom';
import { Clapperboard } from 'lucide-react';
import { Card } from '../components/ui';

const CONTENT: Record<string, { title: string; sections: { h: string; p: string }[] }> = {
  confidentialite: {
    title: 'Politique de confidentialité',
    sections: [
      { h: 'Données collectées', p: 'Reelora traite votre adresse e-mail, votre nom affiché, vos projets, scripts, avatars, prompts, vidéos générées et les événements de consommation de crédits nécessaires au fonctionnement du service.' },
      { h: 'Hébergement', p: 'Les données sont stockées dans le projet Supabase européen (région eu-central-1). Les fichiers vidéo sont conservés dans le bucket privé ugc-assets, accessible uniquement via des URL signées ou une session autorisée.' },
      { h: 'Sécurité', p: 'Chaque table est protégée par des politiques RLS. Les clés d’API Groq et MuAPI, le jeton du worker et la clé service_role Supabase ne sont accessibles qu’aux fonctions serveur, jamais au navigateur.' },
      { h: 'Sous-traitants IA', p: 'Lorsque vous lancez une génération, le strict nécessaire (script, prompt, image de référence éventuelle et paramètres du modèle) est transmis à MuAPI. Aucun fournisseur n’est contacté si son secret serveur n’est pas configuré.' },
      { h: 'Vos droits', p: 'Vous pouvez modifier votre profil, supprimer vos projets, avatars, prompts et créations depuis l’application. Pour toute demande relative à vos données, contactez le support Reelora.' },
    ],
  },
  conditions: {
    title: 'Conditions d’utilisation',
    sections: [
      { h: 'Objet', p: 'Reelora est un logiciel de création de contenus UGC assistés par IA. Le service est fourni en l’état, avec les intégrations tierces activées par l’administrateur de la plateforme.' },
      { h: 'Compte', p: 'Vous êtes responsable de la confidentialité de vos identifiants et de l’exactitude des informations de votre compte. Un administrateur peut suspendre un compte en cas d’usage abusif.' },
      { h: 'Contenus & avatars', p: 'Vous garantissez disposer des droits nécessaires sur les images, voix, marques et textes que vous fournissez. Les avatars de synthèse doivent être utilisés de manière transparente et conforme à la réglementation applicable.' },
      { h: 'Crédits & quotas', p: 'Chaque génération consomme des crédits selon le catalogue en vigueur. Les crédits réservés sont restitués en cas d’échec ou d’annulation. Les limites mensuelles dépendent de votre formule.' },
      { h: 'Disponibilité des services tiers', p: 'La génération dépend de fournisseurs externes (Groq pour le texte, MuAPI pour la vidéo). Reelora ne produit aucun résultat fictif : si un fournisseur est indisponible ou non configuré, la tâche échoue explicitement et les crédits sont restitués.' },
    ],
  },
};

export default function Legal({ kind }: { kind: 'confidentialite' | 'conditions' }) {
  const doc = CONTENT[kind];
  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2"><Clapperboard size={18} className="text-brand-400" /><span className="font-bold text-white">Reelora.</span></Link>
          <Link to="/" className="text-xs text-slate-400 hover:text-white">Retour à l’accueil</Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-12">
        <h1 className="text-3xl font-bold text-white">{doc.title}</h1>
        <p className="mt-2 text-sm text-slate-500">Dernière mise à jour : {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</p>
        <Card className="mt-8 space-y-7 p-7">
          {doc.sections.map((s) => (
            <section key={s.h}><h2 className="text-base font-semibold text-white">{s.h}</h2><p className="mt-2 text-sm leading-relaxed text-slate-400">{s.p}</p></section>
          ))}
        </Card>
      </main>
    </div>
  );
}
