import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../components/ui';

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-4 text-center">
      <div>
        <p className="text-7xl font-black text-white/10">404</p>
        <h1 className="mt-2 text-2xl font-bold text-white">Page introuvable</h1>
        <p className="mt-2 text-sm text-slate-400">La page demandée n’existe pas ou a été déplacée.</p>
        <Link to="/" className="btn btn-primary btn-md mt-6"><ArrowLeft size={15} /> Retour à l’accueil</Link>
        <div className="mt-3"><Button variant="ghost" size="sm" onClick={() => window.history.back()}>Revenir en arrière</Button></div>
      </div>
    </div>
  );
}
