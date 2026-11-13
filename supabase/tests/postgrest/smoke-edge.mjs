// Test fumée manuel (non inclus dans run.mjs) : parcours Edge complet.
import crypto from 'node:crypto';
const { setupEnv, startServices } = await import('./env.mjs');
const { userToken } = await import('./jwt.mjs');
const env = await setupEnv({ fresh: true, log: () => {} });
const services = await startServices({ secret: env.secret, log: () => {} });
const { seedData } = env;
const T = userToken(env.secret, { sub: seedData.users.alice.id, email: 'a' });
const call = async (action, body, token = T) => {
  const r = await fetch(services.edgeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: 'bench-anon', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...body }),
  });
  return { status: r.status, json: JSON.parse(await r.text()) };
};
await call('providers.verify', { providerKey: 'groq', modelKey: 'llama-3.3-70b-versatile' });
const conv = await call('conversations.create', { title: 'Ma première analyse', workspaceId: seedData.workspaces.A });
console.log('create:', conv.status, JSON.stringify(conv.json).slice(0, 200));
const convId = conv.json?.data?.conversationId;
const msg = await call('messages.send', { conversationId: convId, content: 'Fais-moi un diagnostic rapide de mon épicerie fine à Bamako.', idempotencyKey: crypto.randomUUID(), roleKey: 'business_advisor' });
console.log('send  :', msg.status, JSON.stringify(msg.json).slice(0, 400));
const list = await call('messages.list', { conversationId: convId });
console.log('list  :', list.status, JSON.stringify(list.json).slice(0, 600));
const quota = await call('quota.status', {});
console.log('quota :', quota.status, JSON.stringify(quota.json?.data).slice(0, 250));
await services.close(); await env.pgServer.stop();
