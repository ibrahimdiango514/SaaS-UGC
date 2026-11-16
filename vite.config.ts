import { execFileSync } from 'node:child_process';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_SUPABASE_URL, isLocalBusinessGrowFunctionUrl } from './src/lib/public-config';

/**
 * Identifie la révision réellement construite.
 *
 * Un déploiement peut sembler réussi alors que le CDN sert encore l'ancien
 * HTML. Exposer le SHA du commit dans la page permet de vérifier en une
 * requête ce que le site public sert vraiment, sans accès au tableau de bord.
 *
 * Ordre de résolution : SHA annoncé par le CI d'hébergement, puis `git`.
 * Repli `dev` en local : c'est une absence d'information, pas une valeur
 * inventée — jamais de faux SHA.
 */
export function buildRevision(env: Record<string, string>): string {
  const fromCi = (env.COMMIT_REF || env.VITE_COMMIT_REF || '').trim();
  if (/^[0-9a-f]{7,40}$/.test(fromCi)) return fromCi.slice(0, 7);
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    return /^[0-9a-f]{7}$/.test(sha) ? sha : 'dev';
  } catch {
    return 'dev';
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // `execFileSync` lit `process.env` : on lui passe l'environnement fusionné
  // (variables du shell + fichier .env) pour couvrir Netlify comme le local.
  const revision = buildRevision({ ...process.env, ...env } as Record<string, string>);
  const localFunction = command === 'serve' ? env.VITE_BUSINESS_GROW_FUNCTION_URL?.trim() : undefined;
  if (localFunction && !isLocalBusinessGrowFunctionUrl(localFunction)) {
    throw new Error('VITE_BUSINESS_GROW_FUNCTION_URL doit cibler localhost:54321/functions/v1/business-grow.');
  }
  const target = localFunction
    ? new URL(localFunction).origin
    : (env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');

  // Même contrat que le relais Netlify : destination fixe, JWT utilisateur et
  // clé publique uniquement, jamais de secret serveur ni d'Origin/cookies du site.
  // Le navigateur appelle un chemin same-origin, même pour Supabase local.
  const businessProxy = (): ProxyOptions => ({
    target,
    changeOrigin: true,
    proxyTimeout: 43_000,
    rewrite: () => '/functions/v1/business-grow',
    configure(proxy) {
      proxy.on('proxyReq', (request) => {
        const allowed = new Set(['host', 'authorization', 'apikey', 'content-type', 'content-length', 'transfer-encoding']);
        for (const name of request.getHeaderNames()) {
          if (!allowed.has(name.toLowerCase())) request.removeHeader(name);
        }
      });
      proxy.on('proxyRes', (response) => {
        delete response.headers['set-cookie'];
        response.headers['cache-control'] = 'no-store';
      });
      proxy.on('error', (_error, _request, response) => {
        if (response && 'writeHead' in response && !response.headersSent && !response.writableEnded) {
          response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ error: {
            code: 'BUSINESS_GROW_RELAY_UNAVAILABLE',
            message: 'Le relais de développement ne peut pas joindre Business Grow.',
          } }));
        }
      });
    },
  });
  const proxy = () => ({ '^/api/business-grow(?:\\?.*)?$': businessProxy() });

  return {
    plugins: [
      react(),
      // Injecte la balise de révision dans le HTML produit : `dist/index.html`
      // est la seule preuve publique de ce qui est réellement publié.
      {
        name: 'vyora-build-revision',
        transformIndexHtml(html: string) {
          return html.replace(
            '</head>',
            `  <meta name="vyora-revision" content="${revision}" />\n  </head>`,
          );
        },
      },
    ],
    server: { host: '0.0.0.0', port: 5173, allowedHosts: true, proxy: proxy() },
    preview: { host: '0.0.0.0', port: 4173, allowedHosts: true, proxy: proxy() },
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
