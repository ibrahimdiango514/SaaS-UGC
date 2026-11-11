/**
 * VYORA Phase 4 — Studied Server-Side Render Architecture Contract.
 *
 * IMPORTANT: No server render worker or Edge Function is deployed here, and local
 * browser exports never debit credits. This module defines the deterministic
 * architecture assessment and FFmpeg job manifest contract so the UI can
 * honestly inform the user when browser encoding works locally vs when a
 * dedicated server render pipeline would be needed.
 */

import { planAudioTimeline, type AudioTimelinePlan } from './audioMixer';
import {
  DEFAULT_EXPORT_SETTINGS, exportDimensions, resolveExportPlan,
  type ExportCapabilities, type ExportSettings,
} from './exportConfig';
import { totalDuration, type EditorProject } from './types';

export interface ServerRenderRequirement {
  needed: boolean;
  serverEngineDeployed: false;
  creditsChargedForLocalExport: 0;
  reasons: string[];
  requiredInfrastructure: string[];
  requiredSecrets: string[];
}

export interface ServerRenderManifest {
  version: 1;
  projectId: string | null;
  aspect: EditorProject['aspect'];
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  container: 'mp4';
  videoCodec: 'libx264';
  audioCodec: 'aac';
  subtitlesEnabled: boolean;
  scenes: Array<{
    index: number;
    label: string;
    duration: number;
    trimStart: number;
    fitMode: 'cover' | 'contain';
    transition: string;
    transitionDuration: number;
    storagePath: string | null;
  }>;
  audioPlan: AudioTimelinePlan;
}

export function assessServerRenderNeed(
  project: EditorProject,
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  caps: ExportCapabilities,
): ServerRenderRequirement {
  const plan = resolveExportPlan(project.aspect, settings, caps);
  const reasons: string[] = [];

  if (!plan.allowed) {
    reasons.push(plan.reason || 'Le navigateur actuel ne supporte pas cette configuration d’export.');
  }
  if (settings.resolution === '4k' && caps.resolutions['4k']?.engine !== 'webcodecs') {
    reasons.push('L’export 4K fiable sans WebCodecs matériel nécessite un encodeur serveur FFmpeg.');
  }
  if (totalDuration(project) > 120) {
    reasons.push('Les montages longs (> 2 min) sont plus fiables via une file de rendu serveur FFmpeg.');
  }
  const hasRemoteNonSignedAssets = project.scenes.some(
    (s) => s.source.url && /^https?:\/\//i.test(s.source.url) && !s.source.storagePath,
  );
  if (hasRemoteNonSignedAssets) {
    reasons.push('Des médias externes sans en-tête CORS peuvent bloquer Canvas 2D côté navigateur.');
  }

  return {
    needed: !plan.allowed,
    serverEngineDeployed: false,
    creditsChargedForLocalExport: 0,
    reasons,
    requiredInfrastructure: [
      'Worker conteneurisé FFmpeg (Cloud Run / Fly.io / VPS dédié, hors Edge Functions Deno limitées en CPU/RAM)',
      'File asynchrone dédiée + stockage de sortie dans le bucket privé ugc-assets/{workspace_id}/exports/',
      'Webhook signé de complétion sans modification des règles RLS existantes',
    ],
    requiredSecrets: [
      'REELORA_RENDER_WORKER_URL (URL privée du worker FFmpeg, côté serveur uniquement)',
      'REELORA_RENDER_WORKER_TOKEN (jeton d’authentification HMAC, côté serveur uniquement)',
    ],
  };
}

export function buildServerRenderManifest(
  project: EditorProject,
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): ServerRenderManifest {
  const { width, height } = exportDimensions(project.aspect, settings.resolution);
  return {
    version: 1,
    projectId: project.projectId,
    aspect: project.aspect,
    width,
    height,
    fps: settings.fps,
    durationSeconds: totalDuration(project),
    container: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    subtitlesEnabled: project.subtitlesEnabled,
    scenes: project.scenes.map((sc, index) => ({
      index,
      label: sc.label,
      duration: sc.duration,
      trimStart: sc.trimStart,
      fitMode: sc.fitMode ?? 'cover',
      transition: sc.transition,
      transitionDuration: sc.transitionDuration ?? 0.4,
      storagePath: sc.source.storagePath ?? null,
    })),
    audioPlan: planAudioTimeline(project),
  };
}
