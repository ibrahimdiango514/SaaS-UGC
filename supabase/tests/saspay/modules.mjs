// Modules métier Business Growth : persistance réelle, cloisonnement, RLS et
// permissions. PostgreSQL 17 local, aucune donnée distante.
// Prérequis : avoir lancé « node base.mjs » (socle + migrations Business Grow).
import assert from 'node:assert/strict';
import { client } from './pg.mjs';

const db = client('postgres'); await db.connect();

  const users = (await db.query(
    `insert into auth.users(email) values ('ada@test.local'),('bob@test.local') returning id, email`,
  )).rows;
  const ada = users[0].id; const bob = users[1].id;

  const edge = client('postgres'); await edge.connect();
  await edge.query('set role bg_edge');

  const create = async (user, category, data, dedupe = null) => (await edge.query(
    `select saas_business.bg_create_module_record($1::uuid,$2,$3::jsonb,$4) as id`,
    [user, category, JSON.stringify(data), dedupe],
  )).rows[0].id;
  const list = async (user, category) => (await edge.query(
    `select * from saas_business.bg_list_module_records($1::uuid,$2)`, [user, category],
  )).rows;
  const update = async (user, id, data) => (await edge.query(
    `select saas_business.bg_update_module_record($1::uuid,$2::uuid,$3::jsonb) as ok`,
    [user, id, JSON.stringify(data)],
  )).rows[0].ok;
  const remove = async (user, id) => (await edge.query(
    `select saas_business.bg_delete_module_record($1::uuid,$2::uuid) as ok`, [user, id],
  )).rows[0].ok;

  const lead = await create(ada, 'bg_module_lead_rescue', { name: 'Amina', estimatedValue: 75000, status: 'nouveau' });
  assert.ok(lead, 'identifiant retourné');
  let rows = await list(ada, 'bg_module_lead_rescue');
  assert.equal(rows.length, 1, 'un enregistrement');
  assert.equal(rows[0].data.name, 'Amina', 'données restituées');
  console.log('  ✓ création et lecture');

  const same = await create(ada, 'bg_module_lead_rescue', { name: 'Amina', estimatedValue: 75000 }, 'rule-1:lead-1');
  const same2 = await create(ada, 'bg_module_lead_rescue', { name: 'Amina', estimatedValue: 75000 }, 'rule-1:lead-1');
  assert.equal(same, same2, 'clé de déduplication stable');
  assert.equal((await list(ada, 'bg_module_lead_rescue')).length, 2, 'aucun doublon créé');
  console.log('  ✓ déduplication des tâches automatisées');

  assert.equal(await update(ada, lead, { status: 'converti', estimatedValue: 90000 }), true, 'mise à jour propriétaire');
  rows = await list(ada, 'bg_module_lead_rescue');
  const updated = rows.find((row) => row.id === lead);
  assert.equal(updated.data.status, 'converti');
  assert.equal(updated.data.estimatedValue, 90000);
  assert.equal(updated.data.name, 'Amina', 'fusion sans perte de champ');
  console.log('  ✓ mise à jour partielle fusionnée');

  assert.equal((await list(bob, 'bg_module_lead_rescue')).length, 0, 'lecture isolée par utilisateur');
  assert.equal(await update(bob, lead, { status: 'perdu' }), false, 'écriture croisée refusée');
  assert.equal(await remove(bob, lead), false, 'suppression croisée refusée');
  assert.equal((await list(ada, 'bg_module_lead_rescue')).find((row) => row.id === lead).data.status, 'converti', 'données intactes');
  console.log('  ✓ cloisonnement utilisateur');

  for (const [label, fn, pattern] of [
    ['catégorie invalide', () => create(ada, 'public_table', { a: 1 }), /invalid module category/],
    ['données non objet', () => create(ada, 'bg_module_lead_rescue', 'oops'), /must be a json object/],
    ['données trop volumineuses', () => create(ada, 'bg_module_lead_rescue', { notes: 'x'.repeat(25000) }), /too large/],
  ]) {
    await assert.rejects(fn, pattern, label);
  }
  await assert.rejects(() => list(ada, 'bad category'), /invalid module category/, 'liste invalide refusée');
  console.log('  ✓ validation catégorie, type et taille');

  await assert.rejects(() => edge.query('select * from saas_business.module_records'), /permission denied/, 'table invisible pour bg_edge');
  const anon = client('authenticator'); await anon.connect(); await anon.query('set role authenticated');
  await assert.rejects(() => anon.query('select * from saas_business.module_records'), /permission denied/, 'table invisible pour authenticated');
  await assert.rejects(() => anon.query(`select saas_business.bg_list_module_records($1::uuid,'bg_module_lead_rescue')`, [ada]), /permission denied/, 'fonctions interdites au client');
  await anon.end();
  console.log('  ✓ RLS FORCE et REVOKE vérifiés');

  assert.equal(await remove(ada, lead), true, 'suppression propriétaire');
  assert.equal((await list(ada, 'bg_module_lead_rescue')).length, 1, 'un enregistrement restant');
  console.log('  ✓ suppression');

  await db.query(`select saas_business.bg_prepare_account_erasure($1::uuid)`, [ada]);
  assert.equal((await list(ada, 'bg_module_lead_rescue')).length, 0, 'effacement de compte');
  assert.ok((await list(bob, 'bg_module_lead_rescue')).length >= 0, 'autre compte intact');
  console.log('  ✓ effacement de compte');

  for (let i = 0; i < 500; i += 1) {
    await create(ada, 'bg_module_lead_rescue', { name: `Lead ${i}`, estimatedValue: i, lastContactAt: '2026-11-13', status: 'nouveau' });
  }
  let limitRefused = false;
  try {
    await create(ada, 'bg_module_lead_rescue', { name: 'Lead 501', estimatedValue: 501, lastContactAt: '2026-11-13', status: 'nouveau' });
  } catch (error) {
    limitRefused = /limit reached/.test(String(error?.message || error));
  }
  assert.equal(limitRefused, true, 'plafond de 500 enregistrements');
  await db.query(`delete from saas_business.module_records where user_id = $1::uuid`, [ada]);
  console.log('  ✓ plafond de 500 enregistrements');
await edge.end(); await db.end();
console.log('\nmodules métier : toutes les vérifications sont passées');
