#!/usr/bin/env node
// Inspection only: never connects to Supabase and never runs SQL.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.cwd(), 'supabase/migrations');
const refs = ['xbuuhfwobrafcbgtdgjx'];
let blocked = 0;
for (const name of readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(dir, name), 'utf8');
  const reasons = [];
  if (refs.some(ref => sql.includes(ref))) reasons.push('référence explicite au projet de production');
  if (/\bcron\.schedule\s*\(/i.test(sql)) reasons.push('création de tâche planifiée');
  if (/\bnet\.http_(?:get|post|delete)\s*\(/i.test(sql)) reasons.push('appel réseau potentiel');
  if (reasons.length) { blocked++; console.log(`${name}: ${reasons.join(', ')}`); }
}
if (blocked) {
  console.error(`${blocked} migration(s) nécessitent une revue/neutralisation avant installation isolée. Aucun SQL exécuté.`);
  process.exitCode = 1;
} else console.log('Aucune référence ou tâche potentiellement dangereuse détectée ; une revue complète reste nécessaire.');
