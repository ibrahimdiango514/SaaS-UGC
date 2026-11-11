import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import { ProtectedRoute, AdminRoute } from './components/Routes';
import Landing from './pages/Landing';
import Legal from './pages/Legal';
import NotFound from './pages/NotFound';

const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const AuthCallback = lazy(() => import('./pages/AuthCallback'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const Avatars = lazy(() => import('./pages/Avatars'));
const Scripts = lazy(() => import('./pages/Scripts'));
const Prompts = lazy(() => import('./pages/Prompts'));
const Presets = lazy(() => import('./pages/Presets'));
const Subscription = lazy(() => import('./pages/Subscription'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const VideoStudio = lazy(() => import('./studio/VideoStudio'));
const GenerationStudio = lazy(() => import('./studio/GenerationStudio'));
const VideoEditor = lazy(() => import('./studio/VideoEditor'));
const PreparedSpace = lazy(() => import('./studio/components/PreparedSpace').then(({ PreparedSpace: component }) => ({ default: component })));
const StudioGenerations = lazy(() => import('./studio/StudioPages').then(({ StudioGenerations: component }) => ({ default: component })));
const StudioLegacy = lazy(() => import('./studio/StudioPages').then(({ StudioLegacy: component }) => ({ default: component })));
const StudioProjects = lazy(() => import('./studio/StudioPages').then(({ StudioProjects: component }) => ({ default: component })));
const StudioSaved = lazy(() => import('./studio/StudioPages').then(({ StudioSaved: component }) => ({ default: component })));
const BusinessGrow = lazy(() => import('./business/BusinessGrow'));

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <Suspense fallback={<div role="status" className="p-6 text-sm text-slate-400">Chargement de l’espace…</div>}>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/connexion" element={<Login />} />
                <Route path="/inscription" element={<Signup />} />
                <Route path="/mot-de-passe-oublie" element={<ForgotPassword />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route path="/confidentialite" element={<Legal kind="confidentialite" />} />
                <Route path="/conditions" element={<Legal kind="conditions" />} />

                <Route element={<ProtectedRoute />}>
                  <Route element={<Layout />}>
                    <Route path="/app">
                      <Route index element={<Dashboard />} />
                      <Route path="projets" element={<StudioProjects />} />
                      <Route path="projets/:id" element={<ProjectDetail />} />
                      <Route path="studio" element={<GenerationStudio />} />
                      <Route path="business" element={<BusinessGrow />} />
                      <Route path="studio/classique" element={<VideoStudio />} />
                      <Route path="studio/montage" element={<VideoEditor />} />
                      <Route path="studio/avance" element={<StudioLegacy />} />
                      <Route path="studio/generations" element={<StudioGenerations />} />
                      <Route path="studio/projects" element={<StudioProjects />} />
                      <Route path="studio/saved" element={<StudioSaved />} />
                      <Route path="studio/espace/:section" element={<PreparedSpace />} />
                      <Route path="avatars" element={<Avatars />} />
                      <Route path="scripts" element={<Scripts />} />
                      <Route path="prompts" element={<Prompts />} />
                      <Route path="presets" element={<Presets />} />
                      <Route path="bibliotheque" element={<StudioSaved />} />
                      <Route path="historique" element={<StudioGenerations />} />
                      <Route path="abonnement" element={<Subscription />} />
                      <Route path="parametres" element={<Settings />} />
                    </Route>
                    <Route element={<AdminRoute />}>
                      <Route path="/admin" element={<Admin />} />
                      <Route path="/app/admin" element={<Navigate to="/admin" replace />} />
                    </Route>
                  </Route>
                </Route>

                <Route path="/dashboard" element={<Navigate to="/app" replace />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
