import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, KeyRound, Mail, Package, Pencil, PlugZap, Plus, Trash2, UserRound, Users, X } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Input, Select, Textarea, Badge, Banner, LoadingState, ErrorState, EmptyState, Tabs, ConfirmDialog } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate } from '../lib/format';
import { INTEGRATION_DEFINITIONS } from '../integrations/contracts';
import {
  createBrand, createProduct, deleteBrand, deleteProduct, getMembers, healthCheck,
  listBrands, listProducts, updateBrand, updateEmail, updatePassword, updateProduct, updateProfile, updateWorkspace,
} from '../lib/api';
import type { Brand, Product, WorkspaceMember } from '../lib/types';

export default function Settings() {
  const toast = useToast();
  const { user, profile, workspace, refreshAll } = useAuth();
  const [tab, setTab] = useState('profil');
  const [displayName, setDisplayName] = useState('');
  const [country, setCountry] = useState('ML');
  const [language, setLanguage] = useState('fr');
  const [wsName, setWsName] = useState('');
  const [wsLanguage, setWsLanguage] = useState('fr');
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [brandName, setBrandName] = useState('');
  const [productName, setProductName] = useState('');
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [brandDraft, setBrandDraft] = useState({ name: '', website_url: '', industry: '', description: '', voice_guidelines: '' });
  const [productDraft, setProductDraft] = useState({ name: '', description: '', key_benefits: '', features: '', price_amount: '', price_currency: 'XOF', product_url: '' });
  const [toDelete, setToDelete] = useState<{ id: string; kind: 'brand' | 'product'; name: string } | null>(null);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true); setError('');
    setMembers([]); setBrands([]); setProducts([]);
    setHealth(null);
    try {
      setDisplayName(profile?.display_name ?? ''); setCountry(profile?.country_code ?? 'ML'); setLanguage(profile?.preferred_language ?? 'fr');
      setWsName(workspace?.name ?? ''); setWsLanguage(workspace?.default_language ?? 'fr');
      if (workspace) {
        const [m, b, p] = await Promise.all([getMembers(workspace.id), listBrands(workspace.id), listProducts(workspace.id)]);
        if (requestId !== loadRequestRef.current) return;
        setMembers(m); setBrands(b); setProducts(p);
      }
      try {
        const status = await healthCheck();
        if (requestId === loadRequestRef.current) setHealth(status.configured);
      } catch {
        if (requestId === loadRequestRef.current) setHealth(null);
      }
    } catch (err) {
      if (requestId === loadRequestRef.current) setError(asAppError(err).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [profile, workspace]);

  useEffect(() => {
    void load();
    return () => { loadRequestRef.current += 1; };
  }, [load]);

  const onSaveProfile = async (e: FormEvent) => {
    e.preventDefault(); if (!user) return;
    setBusy('profile');
    try { await updateProfile(user.id, { display_name: displayName, country_code: country, preferred_language: language }); toast.success('Profil mis à jour.'); await refreshAll(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onSaveWorkspace = async (e: FormEvent) => {
    e.preventDefault(); if (!workspace) return;
    setBusy('ws');
    try { await updateWorkspace(workspace.id, { name: wsName, default_language: wsLanguage }); toast.success('Espace de travail mis à jour.'); await refreshAll(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) { toast.warning('8 caractères minimum.'); return; }
    if (newPassword !== confirmPassword) { toast.warning('Les mots de passe ne correspondent pas.'); return; }
    setBusy('password');
    try { await updatePassword(newPassword); setNewPassword(''); setConfirmPassword(''); toast.success('Mot de passe modifié.'); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onEmail = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('email');
    try { await updateEmail(newEmail.trim()); toast.success('E-mail mis à jour. Vérifiez votre boîte de réception.'); setNewEmail(''); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onAddBrand = async (e: FormEvent) => {
    e.preventDefault(); if (!workspace || !brandName.trim()) return;
    setBusy('brand');
    try { await createBrand({ workspace_id: workspace.id, name: brandName.trim() }); setBrandName(''); toast.success('Marque ajoutée.'); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onAddProduct = async (e: FormEvent) => {
    e.preventDefault(); if (!workspace || !productName.trim()) return;
    setBusy('product');
    try { await createProduct({ workspace_id: workspace.id, name: productName.trim() }); setProductName(''); toast.success('Produit ajouté.'); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const beginBrandEdit = (brand: Brand) => {
    setEditingBrand(brand);
    setEditingProduct(null);
    setBrandDraft({
      name: brand.name,
      website_url: brand.website_url ?? '',
      industry: brand.industry ?? '',
      description: brand.description ?? '',
      voice_guidelines: brand.voice_guidelines ?? '',
    });
  };

  const onSaveBrand = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingBrand || !brandDraft.name.trim()) return;
    setBusy('brand-edit');
    try {
      await updateBrand(editingBrand.id, {
        name: brandDraft.name.trim(),
        website_url: brandDraft.website_url.trim() || null,
        industry: brandDraft.industry.trim() || null,
        description: brandDraft.description.trim() || null,
        voice_guidelines: brandDraft.voice_guidelines.trim() || null,
      });
      setEditingBrand(null);
      toast.success('Marque mise à jour.');
      await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const beginProductEdit = (product: Product) => {
    setEditingProduct(product);
    setEditingBrand(null);
    setProductDraft({
      name: product.name,
      description: product.description ?? '',
      key_benefits: product.key_benefits.join('\n'),
      features: product.features.join('\n'),
      price_amount: product.price_amount === null ? '' : String(product.price_amount),
      price_currency: product.price_currency ?? 'XOF',
      product_url: product.product_url ?? '',
    });
  };

  const onSaveProduct = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingProduct || !productDraft.name.trim()) return;
    const rawPrice = productDraft.price_amount.trim();
    const price = rawPrice ? Number(rawPrice) : null;
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      toast.warning('Le prix doit être un nombre positif.');
      return;
    }
    setBusy('product-edit');
    try {
      await updateProduct(editingProduct.id, {
        name: productDraft.name.trim(),
        description: productDraft.description.trim() || null,
        key_benefits: productDraft.key_benefits.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        features: productDraft.features.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        price_amount: price,
        price_currency: price === null ? null : productDraft.price_currency.trim().toUpperCase() || 'XOF',
        product_url: productDraft.product_url.trim() || null,
      });
      setEditingProduct(null);
      toast.success('Produit mis à jour.');
      await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    setBusy('delete');
    try {
      if (toDelete.kind === 'brand') await deleteBrand(toDelete.id); else await deleteProduct(toDelete.id);
      toast.success('Élément supprimé.'); setToDelete(null); await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setBusy(null); }
  };

  if (loading) return <LoadingState label="Chargement des paramètres…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader eyebrow="Compte" title="Profil & paramètres" description="Gérez votre identité, votre espace de travail, la sécurité et vos catalogues." />
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: 'profil', label: 'Profil', icon: <UserRound size={14} /> },
        { id: 'espace', label: 'Espace de travail', icon: <Building2 size={14} /> },
        { id: 'securite', label: 'Sécurité', icon: <KeyRound size={14} /> },
        { id: 'catalogue', label: 'Marques & produits', icon: <Package size={14} /> },
        { id: 'integrations', label: 'Intégrations', icon: <PlugZap size={14} /> },
      ]} />

      {tab === 'profil' && (
        <Card className="max-w-2xl"><CardHeader title="Informations personnelles" description={`Compte : ${user?.email}`} />
          <form onSubmit={(e) => void onSaveProfile(e)} className="space-y-4 p-5">
            <Input label="Nom affiché" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Votre nom" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Pays" value={country} onChange={(e) => setCountry(e.target.value)}><option value="ML">Mali</option><option value="FR">France</option><option value="SN">Sénégal</option><option value="CI">Côte d’Ivoire</option></Select>
              <Select label="Langue" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="fr">Français</option><option value="en">English</option><option value="es">Español</option></Select>
            </div>
            <div className="rounded-xl border border-line bg-white/[0.03] px-4 py-3 text-xs text-slate-500">Compte créé le {formatDate(user?.created_at)} · Identifiant <span className="font-mono text-slate-400">{user?.id}</span></div>
            <Button type="submit" loading={busy === 'profile'}>Enregistrer le profil</Button>
          </form>
        </Card>
      )}

      {tab === 'espace' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Espace de travail" description="Nom et langue par défaut des nouvelles créations." />
            <form onSubmit={(e) => void onSaveWorkspace(e)} className="space-y-4 p-5">
              <Input label="Nom de l’espace" value={wsName} onChange={(e) => setWsName(e.target.value)} />
              <Select label="Langue par défaut" value={wsLanguage} onChange={(e) => setWsLanguage(e.target.value)}><option value="fr">Français</option><option value="en">English</option><option value="es">Español</option></Select>
              <Input label="Identifiant" value={workspace?.id ?? ''} disabled hint="Généré automatiquement par Supabase." />
              <Button type="submit" loading={busy === 'ws'}>Enregistrer</Button>
            </form>
          </Card>
          <Card><CardHeader title="Membres" description="Rôles effectifs dans cet espace de travail." />
            {members.length === 0 ? <EmptyState icon={<Users size={22} />} title="Aucun membre" /> : (
              <div className="divide-y divide-white/[0.06]">{members.map((m) => (
                <div key={m.id} className="flex items-center justify-between px-5 py-3"><div><p className="font-mono text-xs text-slate-300">{m.user_id.slice(0, 8)}…</p><p className="text-[11px] text-slate-500">Depuis {formatDate(m.created_at)}</p></div><Badge tone={m.member_role === 'owner' ? 'success' : 'info'}>{m.member_role}</Badge></div>
              ))}</div>
            )}
            <div className="border-t border-line p-4"><Banner tone="info" title="Invitations">L’ajout de collaborateurs est réservé à l’administration de la plateforme via les politiques RLS. Aucune invitation fictive n’est proposée.</Banner></div>
          </Card>
        </div>
      )}

      {tab === 'securite' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Mot de passe" description="Modification immédiate de votre mot de passe Supabase." />
            <form onSubmit={(e) => void onPassword(e)} className="space-y-4 p-5">
              <Input label="Nouveau mot de passe" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} hint="8 caractères minimum." />
              <Input label="Confirmer" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              <Button type="submit" loading={busy === 'password'} icon={<KeyRound size={15} />}>Modifier le mot de passe</Button>
            </form>
          </Card>
          <Card><CardHeader title="Adresse e-mail" description="Une confirmation peut être demandée par Supabase." />
            <form onSubmit={(e) => void onEmail(e)} className="space-y-4 p-5">
              <Input label="E-mail actuel" value={user?.email ?? ''} disabled />
              <Input label="Nouvelle adresse e-mail" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="nouveau@exemple.com" />
              <Button type="submit" variant="outline" loading={busy === 'email'} icon={<Mail size={15} />}>Changer l’e-mail</Button>
            </form>
          </Card>
        </div>
      )}

      {tab === 'catalogue' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Marques" description="Les marques peuvent être associées à vos projets." />
            <form onSubmit={(e) => void onAddBrand(e)} className="flex gap-2 border-b border-line p-5">
              <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Nom de la marque" />
              <Button type="submit" loading={busy === 'brand'} icon={<Plus size={15} />}>Ajouter</Button>
            </form>
            {brands.length === 0 ? <EmptyState icon={<Building2 size={22} />} title="Aucune marque" /> : (
              <div className="divide-y divide-white/[0.06]">{brands.map((b) => (
                <div key={b.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-sm text-white">{b.name}</p><p className="text-[11px] text-slate-500">{b.industry || 'Secteur non renseigné'}</p></div>
                    <div className="flex items-center">
                      <Button size="sm" variant="ghost" icon={<Pencil size={13} />} aria-label={`Modifier ${b.name}`} onClick={() => beginBrandEdit(b)} />
                      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Supprimer ${b.name}`} onClick={() => setToDelete({ id: b.id, kind: 'brand', name: b.name })} />
                    </div>
                  </div>
                  {editingBrand?.id === b.id && (
                    <form onSubmit={(e) => void onSaveBrand(e)} className="mt-4 space-y-3 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-white">Modifier la marque</h3><Button type="button" size="sm" variant="ghost" icon={<X size={14} />} aria-label="Annuler la modification" onClick={() => setEditingBrand(null)} /></div>
                      <Input label="Nom" required value={brandDraft.name} onChange={(e) => setBrandDraft({ ...brandDraft, name: e.target.value })} />
                      <Input label="Secteur" value={brandDraft.industry} onChange={(e) => setBrandDraft({ ...brandDraft, industry: e.target.value })} />
                      <Input label="Site web" type="url" value={brandDraft.website_url} onChange={(e) => setBrandDraft({ ...brandDraft, website_url: e.target.value })} />
                      <Textarea label="Description" value={brandDraft.description} onChange={(e) => setBrandDraft({ ...brandDraft, description: e.target.value })} />
                      <Textarea label="Ton de communication" value={brandDraft.voice_guidelines} onChange={(e) => setBrandDraft({ ...brandDraft, voice_guidelines: e.target.value })} />
                      <Button type="submit" loading={busy === 'brand-edit'}>Enregistrer la marque</Button>
                    </form>
                  )}
                </div>
              ))}</div>
            )}
          </Card>
          <Card><CardHeader title="Produits" description="Décrivez les produits mis en avant dans vos scripts." />
            <form onSubmit={(e) => void onAddProduct(e)} className="flex gap-2 border-b border-line p-5">
              <Input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Nom du produit" />
              <Button type="submit" loading={busy === 'product'} icon={<Plus size={15} />}>Ajouter</Button>
            </form>
            {products.length === 0 ? <EmptyState icon={<Package size={22} />} title="Aucun produit" /> : (
              <div className="divide-y divide-white/[0.06]">{products.map((p) => (
                <div key={p.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-sm text-white">{p.name}</p><p className="text-[11px] text-slate-500">{p.description || 'Description à compléter'}</p></div>
                    <div className="flex items-center">
                      <Button size="sm" variant="ghost" icon={<Pencil size={13} />} aria-label={`Modifier ${p.name}`} onClick={() => beginProductEdit(p)} />
                      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Supprimer ${p.name}`} onClick={() => setToDelete({ id: p.id, kind: 'product', name: p.name })} />
                    </div>
                  </div>
                  {editingProduct?.id === p.id && (
                    <form onSubmit={(e) => void onSaveProduct(e)} className="mt-4 space-y-3 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-white">Modifier le produit ou service</h3><Button type="button" size="sm" variant="ghost" icon={<X size={14} />} aria-label="Annuler la modification" onClick={() => setEditingProduct(null)} /></div>
                      <Input label="Nom" required value={productDraft.name} onChange={(e) => setProductDraft({ ...productDraft, name: e.target.value })} />
                      <Textarea label="Description" value={productDraft.description} onChange={(e) => setProductDraft({ ...productDraft, description: e.target.value })} />
                      <Textarea label="Bénéfices clés (un par ligne)" value={productDraft.key_benefits} onChange={(e) => setProductDraft({ ...productDraft, key_benefits: e.target.value })} />
                      <Textarea label="Caractéristiques (une par ligne)" value={productDraft.features} onChange={(e) => setProductDraft({ ...productDraft, features: e.target.value })} />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input label="Prix" type="number" min="0" step="any" value={productDraft.price_amount} onChange={(e) => setProductDraft({ ...productDraft, price_amount: e.target.value })} />
                        <Input label="Devise" maxLength={3} value={productDraft.price_currency} onChange={(e) => setProductDraft({ ...productDraft, price_currency: e.target.value })} />
                      </div>
                      <Input label="Lien produit" type="url" value={productDraft.product_url} onChange={(e) => setProductDraft({ ...productDraft, product_url: e.target.value })} />
                      <Button type="submit" loading={busy === 'product-edit'}>Enregistrer le produit</Button>
                    </form>
                  )}
                </div>
              ))}</div>
            )}
          </Card>
        </div>
      )}

      {tab === 'integrations' && (
        <div className="max-w-3xl space-y-5">
          <Card><CardHeader title="État des intégrations serveur" description="Les valeurs proviennent de reelora-health ; aucun secret n’est exposé." />
            <div className="space-y-3 p-5">
              {health === null && <Banner tone="warning" title="État indisponible">La fonction reelora-health n’a pas répondu. Vérifiez le déploiement des Edge Functions.</Banner>}
              {health && [
                ['Groq (scripts & prompts)', health.groq, 'GROQ_API_KEY'],
                ['MuAPI (génération vidéo)', health.muapi, 'MUAPI_API_KEY'],
                ['Worker MuAPI (webhook + cron)', health.worker, 'jeton stocké dans Supabase Vault'],
                ['Supabase', health.supabase, 'injecté par la plateforme'],
              ].map(([label, ok, hint]) => (
                <div key={String(label)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white/[0.03] px-4 py-3">
                  <div><p className="text-sm font-medium text-white">{label}</p><p className="text-[11px] text-slate-500">{hint}</p></div>
                  <Badge tone={ok ? 'success' : 'warning'}>{ok ? 'Configuré' : 'À configurer'}</Badge>
                </div>
              ))}
              <Banner tone="info" title="Configuration requise">Les secrets se définissent dans Supabase → Project Settings → Edge Functions → Secrets. Ils ne doivent jamais être préfixés VITE_ ni être placés dans le frontend.</Banner>
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Connecteurs sociaux et e-commerce"
              description="Architecture préparée pour les futurs comptes de ce même workspace Reelora."
            />
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              {INTEGRATION_DEFINITIONS.map((integration) => (
                <article key={integration.id} className="rounded-xl border border-line bg-white/[0.03] p-4" data-testid={`integration-${integration.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{integration.name}</p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {integration.kind === 'social' ? 'Réseau social' : 'Commerce'} · {integration.authorization === 'oauth2' ? 'OAuth 2.0' : 'Installation sécurisée'}
                      </p>
                    </div>
                    <Badge tone="neutral">Non connecté</Badge>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-slate-400">{integration.note}</p>
                  <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                    Capacités envisagées : {integration.proposedCapabilities.join(', ')}. Aucune action distante n’est activée.
                  </p>
                </article>
              ))}
            </div>
            <div className="px-5 pb-5">
              <Banner tone="info" title="Pas de connexions simulées">
                Une intégration ne sera activée qu’avec l’autorisation officielle, une persistance protégée par RLS et des tests réels. Les identifiants resteront côté serveur.
              </Banner>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer cet élément ?" danger confirmLabel="Supprimer" loading={busy === 'delete'} onClose={() => setToDelete(null)} onConfirm={() => void onDelete()}
        message={`« ${toDelete?.name ?? ''} » sera supprimé définitivement du catalogue de votre espace.`} />
    </>
  );
}
