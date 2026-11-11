import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface State { error: Error | null }

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('VYORA render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-screen place-items-center px-4">
          <div className="w-full max-w-lg rounded-2xl border border-rose-400/25 bg-rose-500/5 p-8 text-center">
            <AlertTriangle className="mx-auto text-rose-400" size={32} />
            <h1 className="mt-4 text-xl font-bold text-white">Une erreur d’affichage est survenue</h1>
            <p className="mt-2 text-sm text-slate-400">Rechargez la page. Si le problème persiste, contactez le support VYORA.</p>
            <p className="mt-3 break-words text-xs text-rose-300/70">{this.state.error.message}</p>
            <button onClick={() => window.location.reload()} className="btn btn-primary btn-md mt-6">Recharger l’application</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
