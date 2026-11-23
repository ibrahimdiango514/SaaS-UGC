import { useCallback, useEffect, useRef, useState } from 'react';
import { businessGrowApi, type BusinessModuleRecord } from '../api';

export interface RecordCollection {
  records: BusinessModuleRecord[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (data: Record<string, unknown>, dedupeKey?: string | null) => Promise<string>;
  update: (recordId: string, data: Record<string, unknown>) => Promise<void>;
  remove: (recordId: string) => Promise<void>;
}

/**
 * Lecture et écriture d'une catégorie de module métier, scopée à l'entreprise.
 *
 * Le serveur reste l'autorité : chaque écriture est relue depuis la base, et la
 * collection n'est mise à jour qu'après la réponse du serveur. Une réponse
 * perdue n'est jamais interprétée comme un succès.
 */
export function useRecords(category: string, workspaceId: string | null): RecordCollection {
  const [records, setRecords] = useState<BusinessModuleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const sequence = useRef(0);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; sequence.current++; };
  }, []);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    if (!workspaceId) {
      setRecords([]);
      setLoading(false);
      setError('Aucune entreprise active.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await businessGrowApi.listModuleRecords(category, workspaceId);
      if (activeRef.current && current === sequence.current) {
        setRecords(result.records ?? []);
      }
    } catch (cause) {
      if (activeRef.current && current === sequence.current) {
        setError(cause instanceof Error ? cause.message : 'Impossible de charger ces données.');
      }
    } finally {
      if (activeRef.current && current === sequence.current) setLoading(false);
    }
  }, [category, workspaceId]);

  useEffect(() => {
    setRecords([]);
    void load();
  }, [load]);

  const create = useCallback(async (data: Record<string, unknown>, dedupeKey?: string | null) => {
    if (!workspaceId) throw new Error('Aucune entreprise active.');
    const result = await businessGrowApi.createModuleRecord(category, data, dedupeKey ?? null, workspaceId);
    await load();
    return result.recordId;
  }, [category, load, workspaceId]);

  const update = useCallback(async (recordId: string, data: Record<string, unknown>) => {
    if (!workspaceId) throw new Error('Aucune entreprise active.');
    await businessGrowApi.updateModuleRecord(category, recordId, data, workspaceId);
    await load();
  }, [category, load, workspaceId]);

  const remove = useCallback(async (recordId: string) => {
    if (!workspaceId) throw new Error('Aucune entreprise active.');
    await businessGrowApi.deleteModuleRecord(category, recordId, workspaceId);
    await load();
  }, [category, load, workspaceId]);

  return { records, loading, error, reload: load, create, update, remove };
}

export const CRM_CATEGORIES = {
  contacts: 'bg_module_crm_contacts',
  opportunities: 'bg_module_crm_opportunities',
  tasks: 'bg_module_crm_tasks',
  activities: 'bg_module_crm_activities',
  segments: 'bg_module_crm_segments',
} as const;

export const FINANCE_CATEGORIES = {
  receivables: 'bg_module_receivables',
  payments: 'bg_module_receivable_payments',
  reminders: 'bg_module_receivable_reminders',
  promises: 'bg_module_payment_promises',
  disputes: 'bg_module_receivable_disputes',
} as const;
