import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import { ProtectedRoute, AdminRoute } from './components/Routes';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import AuthCallback from './pages/AuthCallback';
import Legal from './pages/Legal';
import NotFound from './pages/NotFound';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import Avatars from './pages/Avatars';
import Scripts from './pages/Scripts';
import Prompts from './pages/Prompts';
import Presets from './pages/Presets';
import Subscription from './pages/Subscription';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import VideoStudio from './studio/VideoStudio';
import GenerationStudio from './studio/GenerationStudio';
import VideoEditor from './studio/VideoEditor';
import { PreparedSpace } from './studio/components/PreparedSpace';
import { StudioGenerations, StudioLegacy, StudioProjects, StudioSaved } from './studio/StudioPages';

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/connexion" element={<Login />} />
              <Route path="/inscription" element={<Signup />} />
              <Route path="/mot-de-passe-oublie" element={<ForgotPassword />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/confidentialite" element={<Legal kind="confidentialite" />} />
              <Route path="/conditions" element={<Legal kind="conditions" />} />

              <Route element={<ProtectedRoute />}>
                <Route path="/app" element={<Layout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="projets" element={<StudioProjects />} />
                  <Route path="projets/:id" element={<ProjectDetail />} />
                  <Route path="studio" element={<GenerationStudio />} />
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
                  <Route element={<AdminRoute />}>
                    <Route path="admin" element={<Admin />} />
                  </Route>
                </Route>
              </Route>

              <Route path="/dashboard" element={<Navigate to="/app" replace />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
