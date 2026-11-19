import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initPreferences } from './styles/preferences';
import './index.css';

// Appliqué avant le premier rendu : pas de flash de thème au chargement.
initPreferences();

const root = document.getElementById('root');
if (!root) throw new Error('Élément #root introuvable dans index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
