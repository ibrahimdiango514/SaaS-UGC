// Arrêter l'instance de banc démarrée par `node start.mjs`.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const STATE = join(fileURLToPath(new URL('.', import.meta.url)), '.state.json');

if (!existsSync(STATE)) {
  console.log('Aucune instance démarrée (pas de .state.json).');
  process.exit(0);
}

const state = JSON.parse(readFileSync(STATE, 'utf8'));
try {
  process.kill(state.pid, 0);
} catch {
  console.log(`Instance (pid ${state.pid}) déjà arrêtée — nettoyage de l'état.`);
  await import('node:fs').then((fs) => { try { fs.unlinkSync(STATE); } catch {} });
  process.exit(0);
}

console.log(`Arrêt de l'instance (pid ${state.pid})…`);
process.kill(state.pid, 'SIGTERM');

// Attend la disparition du processus (5 s max), puis force.
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try { process.kill(state.pid, 0); } catch { console.log('✓ Instance arrêtée proprement.'); process.exit(0); }
}
try { process.kill(state.pid, 'SIGKILL'); } catch {}
console.log('Instance forcée (SIGKILL).');
process.exit(0);
