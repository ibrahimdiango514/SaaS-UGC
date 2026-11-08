import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, Coins, CreditCard, FileClock, Settings2, Shield, Users, Zap } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Input, Select, Badge, Modal, Banner, LoadingState, ErrorState, EmptyState, Tabs, StatCard } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { asAppError } from '../lib/errors';
import { formatDate, formatMoney, statusLabel, truncate } from '../lib/format';
import {
  adminAdjustCredits, adminConfirmRecharge, adminCreatePromo, adminListAuditLogs,
  adminListRecharges, adminListSettings, adminListUsers, adminOverview, adminSetAccountStatus,
  adminSetPlan, adminSetRole, adminSetSetting, adminUpdateService, listPlans, listServices,
} from '../lib/api';
import type { AdminOverview, AdminUser, Plan, RechargeOrder, ServiceCatalogItem } from '../lib/types';

type AuditLog = { id: string; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; created_at: string; actor_user_id: string };
type Setting = { setting_key: string; setting_value: Record<string, unknown>; description: string | null };

export default function Admin() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [recharges, setRecharges] = useState<RechargeOrder[]>([]);
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creditsModal, setCreditsModal] = useState<AdminUser | null>(null);
  const [delta, setDelta] = useState(25);
  const [reason, setReason] = useState('Ajustement manuel');
  const [promoCode, setPromoCode] = useState('');
  const [promoCredits, setPromoCredits] = useState(25);
  const [promoMax, setPromoMax] = useState(100);
  const [editingService, setEditingService] = useState<ServiceCatalogItem | null>(null);
  const [serviceCost, setServiceCost] = useState(0);
  const [serviceActive, setServiceActive] = useState(true);
  const [editingSetting, setEditingSetting] = useState<Setting | null>(null);
  const [settingValue, setSettingValue] = useState('{}');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [o, u, r, s, p, st, l] = await Promise.all([
        adminOverview(), adminListUsers(), adminListRecharges(), listServices(), listPlans(), adminListSettings(), adminListAuditLogs(),
      ]);
      setOverview(o); setUsers(Array.isArray(u) ? u : []); setRecharges(r); setServices(s); setPlans(p); setSettings(st); setLogs(l as AuditLog[]);
    } catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try { await fn(); toast.success(success); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onCredits = async (e: FormEvent) => {
    e.preventDefault(); if (!creditsModal) return;
    await run('credits', () => adminAdjustCredits(creditsModal.id, delta, reason), 'Crédits ajustés.');
    setCreditsModal(null);
  };

  const onPromo = async (e: FormEvent) => {
    e.preventDefault();
    if (!promoCode.trim()) { toast.warning('Renseignez un code.'); return; }
    await run('promo', () => adminCreatePromo(promoCode.trim(), promoCredits, promoMax), 'Code promotionnel créé.');
    setPromoCode('');
  };

  const onService = async (e: FormEvent) => {
    e.preventDefault(); if (!editingService) return;
    await run('service', () => adminUpdateService(editingService.service_key, serviceCost, serviceActive), 'Service mis à jour.');
    setEditingService(null);
  };

  const onSetting = async (e: FormEvent) => {
    e.preventDefault(); if (!editingSetting) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(settingValue) as Record<string, unknown>; } catch { toast.error('JSON invalide.'); return; }
    await run('setting', () => adminSetSetting(editingSetting.setting_key, parsed), 'Paramètre enregistré.');
    setEditingSetting(null);
  };

  const filteredUsers = users.filter((u) => `${u.email} ${u.display_name ?? ''}`.toLowerCase().includes(search.toLowerCase()));

  if (loading && !overview) return <LoadingState label="Chargement de l’administration…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader eyebrow="Administration" title="Console d’administration" description="Utilisateurs, rôles, formules, crédits, services et journal d’audit."
        actions={<Button variant="ghost" size="sm" onClick={() => void load()}>Actualiser</Button>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Vue d’ensemble', icon: <Activity size={14} /> },
        { id: 'users', label: `Utilisateurs (${users.length})`, icon: <Users size={14} /> },
        { id: 'recharges', label: 'Recharges', icon: <CreditCard size={14} /> },
        { id: 'services', label: 'Services', icon: <Zap size={14} /> },
        { id: 'settings', label: 'Paramètres', icon: <Settings2 size={14} /> },
        { id: 'audit', label: 'Journal', icon: <FileClock size={14} /> },
      ]} />

      {tab === 'overview' && overview && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Utilisateurs" value={overview.users} icon={<Users size={19} />} />
            <StatCard label="Projets" value={overview.projects} icon={<Shield size={19} />} tone="cyan" />
            <StatCard label="Vidéos réussies" value={overview.jobs_succeeded} icon={<Zap size={19} />} hint={`${overview.jobs_failed} échec(s)`} tone="emerald" />
            <StatCard label="Crédits en circulation" value={overview.credits_available} icon={<Coins size={19} />} hint={`${overview.credits_charged} consommés`} tone="amber" />
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card><CardHeader title="Tâches par statut" />
              <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">{Object.entries(overview.jobs_by_status ?? {}).length === 0 ? <p className="col-span-full text-sm text-slate-500">Aucune tâche.</p> : Object.entries(overview.jobs_by_status).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-line bg-white/[0.03] p-3"><Badge status={k}>{statusLabel(k)}</Badge><p className="mt-2 text-xl font-bold text-white">{v}</p></div>
              ))}</div>
            </Card>
            <Card><CardHeader title="Usage du mois" description={`${overview.pending_recharges} recharge(s) en attente · ${overview.assets} fichier(s) stocké(s)`} />
              <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">{Object.entries(overview.usage_this_month ?? {}).length === 0 ? <p className="col-span-full text-sm text-slate-500">Aucune consommation ce mois.</p> : Object.entries(overview.usage_this_month).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-slate-500">{k}</p><p className="mt-1 text-xl font-bold text-white">{v}</p></div>
              ))}</div>
            </Card>
          </div>
          <div className="mt-5"><Banner tone="info" title="Demandes de formule">Les demandes de changement de formule apparaissent dans les notifications des administrateurs et se traitent depuis l’onglet Utilisateurs.</Banner></div>
        </>
      )}

      {tab === 'users' && (
        <Card><CardHeader title="Utilisateurs & rôles" description="Actions réelles sur les tables Supabase, journalisées." action={<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher…" className="max-w-xs" />} />
          {filteredUsers.length === 0 ? <EmptyState icon={<Users size={22} />} title="Aucun utilisateur" /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Utilisateur</th><th>Formule</th><th>Statut</th><th>Crédits</th><th>Rôle</th><th>Actions</th></tr></thead>
              <tbody>{filteredUsers.map((u) => (
                <tr key={u.id}>
                  <td><p className="font-medium text-white">{u.display_name || u.email.split('@')[0]}</p><p className="text-xs text-slate-500">{u.email}</p><p className="text-[10px] text-slate-600">{formatDate(u.created_at)} · {u.projects} projets · {u.videos} vidéos</p></td>
                  <td><Select value={u.plan_key ?? 'free'} onChange={(e) => void run(`plan-${u.id}`, () => adminSetPlan(u.id, e.target.value), 'Formule modifiée.')} className="w-auto min-w-[110px]">{plans.map((p) => <option key={p.plan_key} value={p.plan_key}>{p.display_name}</option>)}</Select></td>
                  <td><Badge status={u.subscription_status ?? 'active'}>{statusLabel(u.subscription_status)}</Badge></td>
                  <td className="font-semibold text-amber-300">{u.credits}</td>
                  <td><Badge tone={u.roles.includes('admin') ? 'success' : 'neutral'}>{u.roles.includes('admin') ? 'admin' : 'user'}</Badge></td>
                  <td><div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" icon={<Coins size={12} />} onClick={() => { setCreditsModal(u); setDelta(25); }}>Crédits</Button>
                    <Button size="sm" variant="ghost" loading={busy === `role-${u.id}`} onClick={() => void run(`role-${u.id}`, () => adminSetRole(u.id, u.roles.includes('admin') ? 'user' : 'admin'), 'Rôle modifié.')}>{u.roles.includes('admin') ? 'Retirer admin' : 'Promouvoir'}</Button>
                    <Button size="sm" variant="ghost" loading={busy === `status-${u.id}`} onClick={() => void run(`status-${u.id}`, () => adminSetAccountStatus(u.id, u.subscription_status === 'suspended' ? 'active' : 'suspended'), 'Statut modifié.')}>{u.subscription_status === 'suspended' ? 'Réactiver' : 'Suspendre'}</Button>
                  </div></td>
                </tr>
              ))}</tbody></table></div>
          )}
        </Card>
      )}

      {tab === 'recharges' && (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card><CardHeader title="Commandes de recharge" description="Confirmer crédite réellement le portefeuille de l’utilisateur." />
              {recharges.length === 0 ? <EmptyState icon={<CreditCard size={22} />} title="Aucune commande" /> : (
                <div className="divide-y divide-white/[0.06]">{recharges.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <div><p className="text-sm font-semibold text-white">{formatMoney(r.amount_minor, r.currency)} → {r.credits_to_grant} crédits</p><p className="text-[11px] text-slate-500">{formatDate(r.created_at, true)} · {r.country_code} · {r.provider}</p></div>
                    <div className="flex items-center gap-2"><Badge status={r.status}>{statusLabel(r.status)}</Badge>
                      {['pending', 'processing'].includes(r.status) && <Button size="sm" variant="outline" loading={busy === `confirm-${r.id}`} onClick={() => void run(`confirm-${r.id}`, () => adminConfirmRecharge(r.id, `Manuel ${new Date().toISOString()}`), 'Recharge confirmée.')}>Confirmer</Button>}
                    </div>
                  </div>
                ))}</div>
              )}
            </Card>
            <Card><CardHeader title="Créer un code promotionnel" />
              <form onSubmit={(e) => void onPromo(e)} className="space-y-4 p-5">
                <Input label="Code" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} placeholder="NOUVEAU2026" />
                <div className="grid grid-cols-2 gap-3"><Input label="Crédits offerts" type="number" min={1} max={10000} value={promoCredits} onChange={(e) => setPromoCredits(Number(e.target.value))} /><Input label="Utilisations max" type="number" min={1} max={100000} value={promoMax} onChange={(e) => setPromoMax(Number(e.target.value))} /></div>
                <Button type="submit" loading={busy === 'promo'} icon={<Zap size={15} />}>Créer le code</Button>
              </form>
            </Card>
          </div>
        </>
      )}

      {tab === 'services' && (
        <Card><CardHeader title="Catalogue des services" description="Coût en crédits et disponibilité de chaque opération." />
          <div className="table-wrap"><table className="table"><thead><tr><th>Service</th><th>Coût</th><th>Statut</th><th>Action</th></tr></thead>
            <tbody>{services.map((s) => <tr key={s.service_key}><td><p className="font-medium text-white">{s.display_name}</p><p className="text-[11px] text-slate-500">{s.service_key} · {truncate(s.description, 80)}</p></td><td>{s.credits_cost} crédits</td><td><Badge tone={s.active ? 'success' : 'danger'}>{s.active ? 'Actif' : 'Inactif'}</Badge></td><td><Button size="sm" variant="outline" onClick={() => { setEditingService(s); setServiceCost(s.credits_cost); setServiceActive(s.active); }}>Modifier</Button></td></tr>)}</tbody></table></div>
        </Card>
      )}

      {tab === 'settings' && (
        <Card><CardHeader title="Paramètres de la plateforme" description="Valeurs JSON réellement utilisées par le backend." />
          {settings.length === 0 ? <EmptyState icon={<Settings2 size={22} />} title="Aucun paramètre" /> : (
            <div className="divide-y divide-white/[0.06]">{settings.map((s) => (
              <div key={s.setting_key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">{s.setting_key}</p><p className="truncate font-mono text-[11px] text-slate-500">{JSON.stringify(s.setting_value)}</p></div>
                <Button size="sm" variant="outline" onClick={() => { setEditingSetting(s); setSettingValue(JSON.stringify(s.setting_value, null, 2)); }}>Modifier</Button>
              </div>
            ))}</div>
          )}
        </Card>
      )}

      {tab === 'audit' && (
        <Card><CardHeader title="Journal d’audit" description="100 dernières actions administratives et remboursements de quota." />
          {logs.length === 0 ? <EmptyState icon={<FileClock size={22} />} title="Aucune entrée" /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Action</th><th>Cible</th><th>Détails</th></tr></thead>
              <tbody>{logs.map((l) => <tr key={l.id}><td className="whitespace-nowrap text-xs">{formatDate(l.created_at, true)}</td><td><Badge tone="info">{l.action}</Badge></td><td className="text-xs">{l.target_type ?? '—'} {l.target_id ? truncate(l.target_id, 12) : ''}</td><td className="max-w-xs truncate font-mono text-[11px] text-slate-500">{JSON.stringify(l.details)}</td></tr>)}</tbody></table></div>
          )}
        </Card>
      )}

      <Modal open={Boolean(creditsModal)} onClose={() => setCreditsModal(null)} title="Ajuster les crédits" description={creditsModal?.email}
        footer={<><Button variant="ghost" onClick={() => setCreditsModal(null)}>Annuler</Button><Button type="submit" form="credits-form" loading={busy === 'credits'}>Appliquer</Button></>}>
        <form id="credits-form" onSubmit={(e) => void onCredits(e)} className="space-y-4">
          <Input label="Variation (négative pour retirer)" type="number" min={-100000} max={100000} value={delta} onChange={(e) => setDelta(Number(e.target.value))} />
          <Input label="Motif" value={reason} onChange={(e) => setReason(e.target.value)} />
        </form>
      </Modal>

      <Modal open={Boolean(editingService)} onClose={() => setEditingService(null)} title="Modifier le service" description={editingService?.display_name}
        footer={<><Button variant="ghost" onClick={() => setEditingService(null)}>Annuler</Button><Button type="submit" form="service-form" loading={busy === 'service'}>Enregistrer</Button></>}>
        <form id="service-form" onSubmit={(e) => void onService(e)} className="space-y-4">
          <Input label="Coût en crédits" type="number" min={0} max={100000} value={serviceCost} onChange={(e) => setServiceCost(Number(e.target.value))} />
          <Select label="Disponibilité" value={serviceActive ? 'active' : 'inactive'} onChange={(e) => setServiceActive(e.target.value === 'active')}><option value="active">Actif</option><option value="inactive">Inactif</option></Select>
        </form>
      </Modal>

      <Modal open={Boolean(editingSetting)} onClose={() => setEditingSetting(null)} title="Modifier le paramètre" description={editingSetting?.setting_key}
        footer={<><Button variant="ghost" onClick={() => setEditingSetting(null)}>Annuler</Button><Button type="submit" form="setting-form" loading={busy === 'setting'}>Enregistrer</Button></>}>
        <form id="setting-form" onSubmit={(e) => void onSetting(e)} className="space-y-4">
          <label className="field"><span className="field-label">Valeur JSON</span><textarea value={settingValue} onChange={(e) => setSettingValue(e.target.value)} className="input min-h-[180px] font-mono text-xs" /></label>
        </form>
      </Modal>
    </>
  );
}
