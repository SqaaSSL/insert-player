import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { generateId } from './auth';
import { settleGenerationPurchase } from './billing';
import {
  persistGeneratedSource,
  persistGeneratedSprite,
} from './generatedAssets';
import { mintGenerationJobToken } from './generationAuth';
import { generationFailureDetails } from './generationFailure';
import {
  parseProviderDailyQuotaSignal,
  providerDailyQuotaFailureMessage,
  recordProviderDailyQuota,
  type ProviderCapacityWindow,
} from './providerCapacity';
import { maxTier } from './tiers';
import type { Env, Fighter, GenerationJob } from './types';
import { stripTrailingSlashes } from './url';

interface FighterGenerationParams {
  jobId: string;
}

interface NormalizationReference {
  targetDrawHeight?: number;
  targetDrawWidth?: number;
  baselineRatio?: number;
}

interface SourcePair {
  cleanKey: string;
  rawKey: string;
}

interface GenerationSources {
  side: SourcePair;
  upright: SourcePair;
  crouch: SourcePair;
  crouchNormalizationReference?: NormalizationReference;
}

interface ArcadeGenerationPromptRow {
  generation_prompt: string | null;
}

interface ProcessorSourceResult {
  rawBase64: string;
  cleanedBase64: string;
  normalizationReference?: NormalizationReference;
}

interface ProcessorSpriteResult {
  imageBase64: string;
  rawBase64: string;
  gridCols: number;
  gridRows: number;
  frameCount: number;
  frameW: number;
  frameH: number;
  usedScale: number;
}

interface AnimationDefinition {
  name: string;
  motion: string;
  frames: number;
  base: 'standing' | 'crouched';
}

const ANIMATIONS: AnimationDefinition[] = [
  { name: 'idle', motion: 'idle fighting stance with very subtle weight shifting and breathing sway, fists raised, feet planted — the character barely moves, just alive and ready', frames: 8, base: 'standing' },
  { name: 'walk', motion: 'combat-ready forward walk cycle to the right with both fists raised in a consistent guard, upper body steady and ready, deliberate fighting-game footwork, no casual civilian arm swing', frames: 16, base: 'standing' },
  { name: 'high_punch', motion: 'quick grounded standing jab punch extending the lead arm forward while both feet stay planted, then retracting to stance', frames: 7, base: 'standing' },
  { name: 'high_kick', motion: 'powerful grounded standing roundhouse kick swinging the right leg in a high arc while the support foot stays planted, then returning to stance', frames: 7, base: 'standing' },
  { name: 'low_punch', motion: 'quick low jab punch from an extreme low-profile crouch, extending the right arm forward while staying low throughout, with hips dropped very low and thighs near-parallel to the ground, then retracting', frames: 7, base: 'crouched' },
  { name: 'low_kick', motion: 'low grounded sweep kick extending the right leg along the floor from an extreme low-profile crouch while staying low throughout, with hips dropped very low and thighs near-parallel to the ground, then retracting', frames: 7, base: 'crouched' },
  { name: 'jump', motion: 'four clear jump key poses: grounded anticipation, airborne lift-off, apex airborne pose, and grounded landing recovery, with the character staying the same size in frame and not physically traveling upward inside the frame', frames: 4, base: 'standing' },
  { name: 'crouch', motion: 'transitioning from standing fighting stance down into an extreme low-profile crouch with visibly dropped hips, bent knees, thighs near-parallel to the ground, a tightly compressed torso, and a much lower head position by the final frame, while keeping the head facing the same direction', frames: 4, base: 'crouched' },
  { name: 'hit', motion: 'four clear hit-reaction key poses: impact, recoil, stagger, and grounded recovery without falling or becoming airborne', frames: 4, base: 'standing' },
  { name: 'ko', motion: 'eight clear key poses of falling backward into a compact knocked-out pose that stays fully inside each frame, ending diagonally on the ground with bent knees', frames: 8, base: 'standing' },
  { name: 'victory', motion: 'big arcade-style victory celebration with an unmistakably triumphant winning pose: chest lifted, shoulders back, chin up, one or both arms raised or pumping in triumph, then settling into a proud champion hold facing right', frames: 8, base: 'standing' },
];
const SPRITE_PROCESSING_VERSION = 5;
const STEP_CONFIG = {
  retries: { limit: 5, delay: '30 seconds' as const, backoff: 'exponential' as const },
  timeout: '3 hours' as const,
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 3 * 8192;
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = '';
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(normalized.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function boundedErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Generation failed';
}

export class FighterGenerationWorkflow extends WorkflowEntrypoint<Env, FighterGenerationParams> {
  private async loadJob(jobId: string): Promise<GenerationJob> {
    const job = await this.env.DB.prepare(
      'SELECT * FROM generation_jobs WHERE id = ?'
    ).bind(jobId).first<GenerationJob>();
    if (!job) throw new Error('Generation job not found');
    return job;
  }

  private async loadFighter(job: GenerationJob): Promise<Fighter> {
    const fighter = await this.env.DB.prepare(
      'SELECT * FROM fighters WHERE id = ? AND owner_user_id = ?'
    ).bind(job.fighter_id, job.user_id).first<Fighter>();
    if (!fighter) throw new Error('Generation fighter not found');
    return fighter;
  }

  private async loadAssetBase64(key: string | null): Promise<string> {
    if (!key) throw new Error('Required generation asset key is missing');
    const object = await this.env.SPRITES.get(key);
    if (!object) throw new Error('Required generation asset is missing');
    return arrayBufferToBase64(await object.arrayBuffer());
  }

  private async callProcessor<T>(
    job: GenerationJob,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    if (!this.env.IMAGE_PROCESSOR) throw new Error('Image processor binding is unavailable');
    const apiBaseUrl = stripTrailingSlashes(this.env.GENERATION_API_BASE_URL?.trim() ?? '');
    if (!apiBaseUrl || !/^https:\/\//i.test(apiBaseUrl)) {
      throw new Error('Generation API base URL is unavailable');
    }
    const generationToken = await mintGenerationJobToken(this.env, {
      jobId: job.id,
      userId: job.user_id,
      providerSessionId: job.provider_session_id,
    });
    const container = this.env.IMAGE_PROCESSOR.getByName(job.id);
    const response = await container.fetch(new Request(`http://image-processor${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        apiBaseUrl,
        generationToken,
        providerSessionId: job.provider_session_id,
      }),
    }));
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      let errorCode = '';
      try {
        const parsed = JSON.parse(detail) as { code?: unknown };
        errorCode = typeof parsed.code === 'string' ? parsed.code : '';
      } catch {
        // The bounded response text below remains the diagnostic for non-JSON failures.
      }
      if (response.status === 422 && errorCode === 'provider_content_blocked') {
        throw new NonRetryableError('The image provider declined this transformation without returning an image');
      }
      if (response.status === 422 && errorCode === 'official_quality_rejected') {
        throw new NonRetryableError(`Official roster quality gate rejected the generated asset: ${detail}`);
      }
      if (response.status === 429 && errorCode === 'provider_daily_quota_exhausted') {
        const signal = parseProviderDailyQuotaSignal(detail);
        if (!signal) {
          throw new NonRetryableError('The image processor returned an invalid daily-capacity signal');
        }
        let window: ProviderCapacityWindow;
        try {
          window = await recordProviderDailyQuota(this.env, signal);
        } catch (error) {
          console.error(JSON.stringify({
            event: 'provider_capacity_window_write_failed',
            provider: signal.provider,
            model: signal.model,
            error: boundedErrorMessage(error),
          }));
          window = {
            provider: signal.provider,
            model: signal.model,
            reason: 'daily_quota_exhausted',
            retryAtEpoch: Math.floor(Date.now() / 1_000) + signal.retryAfterSeconds,
          };
        }
        throw new NonRetryableError(providerDailyQuotaFailureMessage(window));
      }
      throw new Error(`Image processor ${path} failed with ${response.status}: ${detail}`);
    }
    return response.json<T>();
  }

  private async loadArcadeGenerationPrompt(fighterId: string): Promise<string | undefined> {
    const row = await this.env.DB.prepare(`
      SELECT generation_prompt
      FROM arcade_fighters
      WHERE fighter_id = ? AND status IN ('draft', 'active')
      LIMIT 1
    `).bind(fighterId).first<ArcadeGenerationPromptRow>();
    const prompt = row?.generation_prompt?.trim();
    return prompt || undefined;
  }

  private async recordProgress(
    job: GenerationJob,
    stage: string,
    progressCurrent: number,
    detail: string,
  ): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE generation_jobs
        SET status = 'running', stage = ?, progress_current = MAX(progress_current, ?),
            started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
        WHERE id = ? AND status IN ('queued', 'running')
      `).bind(stage, progressCurrent, job.id),
      this.env.DB.prepare(`
        INSERT INTO generation_job_events (id, job_id, stage, status, detail)
        VALUES (?, ?, ?, 'succeeded', ?)
      `).bind(generateId(), job.id, stage, detail.slice(0, 300)),
    ]);
  }

  private async generateSourcePair(
    job: GenerationJob,
    params: {
      operation: 'repose' | 'upright' | 'crouch';
      cleanKind: 'side' | 'upright' | 'crouch';
      rawKind: 'side_raw' | 'upright_raw' | 'crouch_raw';
      inputKey: string;
      normalizationSourceKey?: string;
      generationPrompt?: string;
      progressCurrent: number;
    },
  ): Promise<SourcePair & { normalizationReference?: NormalizationReference }> {
    const result = await this.callProcessor<ProcessorSourceResult>(job, '/v1/generate-source', {
      requestScope: `job:${job.id}:source:${params.cleanKind}`,
      operation: params.operation,
      imageBase64: await this.loadAssetBase64(params.inputKey),
      generationPrompt: params.generationPrompt,
      normalizationSourceBase64: params.normalizationSourceKey
        ? await this.loadAssetBase64(params.normalizationSourceKey)
        : undefined,
    });
    const [clean, raw] = await Promise.all([
      persistGeneratedSource(this.env, {
        jobId: job.id,
        userId: job.user_id,
        fighterId: job.fighter_id,
        kind: params.cleanKind,
        bytes: base64ToArrayBuffer(result.cleanedBase64),
      }),
      persistGeneratedSource(this.env, {
        jobId: job.id,
        userId: job.user_id,
        fighterId: job.fighter_id,
        kind: params.rawKind,
        bytes: base64ToArrayBuffer(result.rawBase64),
      }),
    ]);
    await this.recordProgress(
      job,
      `source:${params.cleanKind}`,
      params.progressCurrent,
      `${params.cleanKind} source archived`,
    );
    return {
      cleanKey: clean.blobKey,
      rawKey: raw.blobKey,
      normalizationReference: result.normalizationReference,
    };
  }

  private async currentSources(job: GenerationJob): Promise<GenerationSources> {
    const fighter = await this.loadFighter(job);
    if (
      !fighter.side_view_blob_key || !fighter.side_view_raw_blob_key ||
      !fighter.upright_view_blob_key || !fighter.upright_view_raw_blob_key ||
      !fighter.crouch_view_blob_key || !fighter.crouch_view_raw_blob_key
    ) {
      throw new Error('Canonical source views are incomplete');
    }
    return {
      side: { cleanKey: fighter.side_view_blob_key, rawKey: fighter.side_view_raw_blob_key },
      upright: { cleanKey: fighter.upright_view_blob_key, rawKey: fighter.upright_view_raw_blob_key },
      crouch: { cleanKey: fighter.crouch_view_blob_key, rawKey: fighter.crouch_view_raw_blob_key },
    };
  }

  private async measureCrouchReference(job: GenerationJob, uprightCleanKey: string): Promise<NormalizationReference | undefined> {
    const result = await this.callProcessor<{ normalizationReference?: NormalizationReference }>(
      job,
      '/v1/measure-crouch-reference',
      { imageBase64: await this.loadAssetBase64(uprightCleanKey) },
    );
    return result.normalizationReference;
  }

  private async generateSprite(
    job: GenerationJob,
    sources: GenerationSources,
    animation: AnimationDefinition,
    progressCurrent: number,
    generationPrompt?: string,
  ): Promise<{ animationName: string; versionId: string }> {
    const isCrouchFamily = animation.name === 'crouch' || animation.base === 'crouched';
    const primaryKey = animation.name === 'crouch'
      ? sources.upright.rawKey
      : animation.base === 'crouched'
        ? sources.crouch.rawKey
        : sources.side.cleanKey;
    const secondaryKey = animation.name === 'crouch' ? sources.crouch.rawKey : null;
    const normalizationReference = isCrouchFamily && sources.crouchNormalizationReference?.baselineRatio
      ? { baselineRatio: sources.crouchNormalizationReference.baselineRatio }
      : undefined;
    const result = await this.callProcessor<ProcessorSpriteResult>(job, '/v1/generate-sprite', {
      requestScope: `job:${job.id}:sprite:${animation.name}`,
      tier: job.tier,
      animation,
      primaryBase64: await this.loadAssetBase64(primaryKey),
      secondaryBase64: secondaryKey ? await this.loadAssetBase64(secondaryKey) : undefined,
      generationPrompt,
      normalizationReference,
    });
    const persisted = await persistGeneratedSprite(this.env, {
      jobId: job.id,
      userId: job.user_id,
      fighterId: job.fighter_id,
      tier: job.tier,
      animationName: animation.name,
      bytes: base64ToArrayBuffer(result.imageBase64),
      rawBytes: base64ToArrayBuffer(result.rawBase64),
      frameWidth: result.frameW,
      frameHeight: result.frameH,
      frameCount: result.frameCount,
      processingVersion: SPRITE_PROCESSING_VERSION,
    });
    await this.recordProgress(
      job,
      `sprite:${animation.name}`,
      progressCurrent,
      `${animation.name} ${job.tier} version archived`,
    );
    return { animationName: animation.name, versionId: persisted.versionId };
  }

  async run(event: Readonly<WorkflowEvent<FighterGenerationParams>>, step: WorkflowStep): Promise<unknown> {
    const jobId = event.payload.jobId;
    let job: GenerationJob | null = null;
    try {
      const activeJob = await step.do('initialize generation', STEP_CONFIG, async (): Promise<GenerationJob> => {
        const loaded = await this.loadJob(jobId);
        if (loaded.status === 'succeeded') return loaded;
        if (!['queued', 'running'].includes(loaded.status)) {
          throw new Error(`Generation job is not runnable (${loaded.status})`);
        }
        await this.env.DB.batch([
          this.env.DB.prepare(`
            UPDATE generation_jobs
            SET status = 'running', stage = 'initializing',
                started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
            WHERE id = ? AND status IN ('queued', 'running')
          `).bind(loaded.id),
          this.env.DB.prepare(`
            INSERT INTO generation_job_events (id, job_id, stage, status, detail)
            VALUES (?, ?, 'initializing', 'running', 'Durable generation started')
          `).bind(generateId(), loaded.id),
        ]);
        return { ...loaded, status: 'running', stage: 'initializing' };
      });
      job = activeJob;
      if (activeJob.status === 'succeeded') return { jobId, status: 'succeeded' };

      if (activeJob.operation === 'fighter_generation') {
        const fighter = await this.loadFighter(activeJob);
        if (!fighter.original_blob_key) throw new Error('Original source photo is missing');
        const generationPrompt = await step.do(
          'load official Arcade generation prompt',
          STEP_CONFIG,
          () => this.loadArcadeGenerationPrompt(activeJob.fighter_id),
        );
        const side = await step.do('generate canonical side source', STEP_CONFIG, () => this.generateSourcePair(activeJob, {
          operation: 'repose',
          cleanKind: 'side',
          rawKind: 'side_raw',
          inputKey: fighter.original_blob_key!,
          generationPrompt,
          progressCurrent: 1,
        }));
        const upright = await step.do('generate canonical upright source', STEP_CONFIG, () => this.generateSourcePair(activeJob, {
          operation: 'upright',
          cleanKind: 'upright',
          rawKind: 'upright_raw',
          inputKey: side.rawKey,
          generationPrompt,
          progressCurrent: 2,
        }));
        const crouch = await step.do('generate canonical crouch source', STEP_CONFIG, () => this.generateSourcePair(activeJob, {
          operation: 'crouch',
          cleanKind: 'crouch',
          rawKind: 'crouch_raw',
          inputKey: upright.rawKey,
          normalizationSourceKey: upright.cleanKey,
          generationPrompt,
          progressCurrent: 3,
        }));
        const sources: GenerationSources = {
          side,
          upright,
          crouch,
          crouchNormalizationReference: crouch.normalizationReference,
        };
        for (let index = 0; index < ANIMATIONS.length; index += 1) {
          const animation = ANIMATIONS[index];
          await step.do(
            `generate ${animation.name} ${activeJob.tier} sprite`,
            STEP_CONFIG,
            () => this.generateSprite(activeJob, sources, animation, index + 4, generationPrompt),
          );
        }
      } else if (activeJob.operation === 'fighter_upgrade') {
        const generationPrompt = await step.do(
          'load official Arcade upgrade prompt',
          STEP_CONFIG,
          () => this.loadArcadeGenerationPrompt(activeJob.fighter_id),
        );
        const sources = await step.do('load canonical upgrade sources', STEP_CONFIG, () => this.currentSources(activeJob));
        sources.crouchNormalizationReference = await step.do(
          'measure upgrade crouch reference',
          STEP_CONFIG,
          () => this.measureCrouchReference(activeJob, sources.upright.cleanKey),
        );
        for (let index = 0; index < ANIMATIONS.length; index += 1) {
          const animation = ANIMATIONS[index];
          await step.do(
            `generate ${animation.name} ${activeJob.tier} sprite`,
            STEP_CONFIG,
            () => this.generateSprite(activeJob, sources, animation, index + 1, generationPrompt),
          );
        }
      } else if (activeJob.operation === 'fighter_retry_animation') {
        const animation = ANIMATIONS.find((entry) => entry.name === activeJob.target_name);
        if (!animation) throw new Error('Retry animation target is unavailable');
        const generationPrompt = await step.do(
          'load official Arcade animation retry prompt',
          STEP_CONFIG,
          () => this.loadArcadeGenerationPrompt(activeJob.fighter_id),
        );
        const sources = await step.do('load canonical retry sources', STEP_CONFIG, () => this.currentSources(activeJob));
        if (animation.name === 'crouch' || animation.base === 'crouched') {
          sources.crouchNormalizationReference = await step.do(
            'measure retry crouch reference',
            STEP_CONFIG,
            () => this.measureCrouchReference(activeJob, sources.upright.cleanKey),
          );
        }
        await step.do(
          `retry ${animation.name} ${activeJob.tier} sprite`,
          STEP_CONFIG,
          () => this.generateSprite(activeJob, sources, animation, 1, generationPrompt),
        );
      } else {
        const fighter = await this.loadFighter(activeJob);
        const target = activeJob.target_name;
        const generationPrompt = await step.do(
          'load official Arcade source retry prompt',
          STEP_CONFIG,
          () => this.loadArcadeGenerationPrompt(activeJob.fighter_id),
        );
        if (target === 'side') {
          if (!fighter.original_blob_key) throw new Error('Original source photo is missing');
          await step.do('retry canonical side source', STEP_CONFIG, () => this.generateSourcePair(activeJob, {
            operation: 'repose',
            cleanKind: 'side',
            rawKind: 'side_raw',
            inputKey: fighter.original_blob_key!,
            generationPrompt,
            progressCurrent: 1,
          }));
        } else if (target === 'upright') {
          if (!fighter.side_view_raw_blob_key) throw new Error('Side source is missing');
          await step.do('retry canonical upright source', STEP_CONFIG, () => this.generateSourcePair(activeJob, {
            operation: 'upright',
            cleanKind: 'upright',
            rawKind: 'upright_raw',
            inputKey: fighter.side_view_raw_blob_key!,
            generationPrompt,
            progressCurrent: 1,
          }));
        } else if (target === 'crouch') {
          if (!fighter.upright_view_blob_key || !fighter.upright_view_raw_blob_key) {
            throw new Error('Upright source is missing');
          }
          await step.do('retry canonical crouch source', STEP_CONFIG, () => this.generateSourcePair(activeJob, {
            operation: 'crouch',
            cleanKind: 'crouch',
            rawKind: 'crouch_raw',
            inputKey: fighter.upright_view_raw_blob_key!,
            normalizationSourceKey: fighter.upright_view_blob_key!,
            generationPrompt,
            progressCurrent: 1,
          }));
        } else {
          throw new Error('Retry source target is unavailable');
        }
      }

      await step.do('commit generation purchase', STEP_CONFIG, async () => {
        const fighter = await this.loadFighter(activeJob);
        const completedEventId = activeJob.id;
        const completedDetail = activeJob.target_name
          ? `${activeJob.target_name} ${activeJob.operation} completed`
          : 'Fighter generation completed';
        const settlement = await settleGenerationPurchase(
          this.env,
          activeJob.user_id,
          activeJob.charge_id,
          true,
          activeJob.fighter_id,
          [
            this.env.DB.prepare(`
              UPDATE fighters
              SET quality_tier = ?, updated_at = datetime('now')
              WHERE id = ? AND owner_user_id = ?
                AND EXISTS (
                  SELECT 1 FROM generation_charges
                  WHERE id = ? AND user_id = ? AND status = 'committed'
                )
            `).bind(
              maxTier(fighter.quality_tier, activeJob.tier),
              activeJob.fighter_id,
              activeJob.user_id,
              activeJob.charge_id,
              activeJob.user_id,
            ),
            this.env.DB.prepare(`
              UPDATE generation_jobs
              SET status = 'succeeded', stage = 'complete', progress_current = progress_total,
                  error_code = NULL, error_message = NULL, finished_at = datetime('now'),
                  updated_at = datetime('now')
              WHERE id = ? AND status IN ('queued', 'running')
                AND EXISTS (
                  SELECT 1 FROM generation_charges
                  WHERE id = ? AND user_id = ? AND status = 'committed'
                )
            `).bind(activeJob.id, activeJob.charge_id, activeJob.user_id),
            this.env.DB.prepare(`
              INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
              SELECT ?, ?, 'complete', 'succeeded', ?
              WHERE EXISTS (
                SELECT 1 FROM generation_charges
                WHERE id = ? AND user_id = ? AND status = 'committed'
              )
            `).bind(completedEventId, activeJob.id, completedDetail, activeJob.charge_id, activeJob.user_id),
          ],
        );
        if (!settlement || settlement.status !== 'committed') {
          throw new Error('Generation purchase could not be committed');
        }
        return { status: 'succeeded' };
      });
      return { jobId, status: 'succeeded' };
    } catch (error) {
      const message = boundedErrorMessage(error);
      console.error(JSON.stringify({ event: 'generation_workflow_failed', jobId, error: message }));
      job = await step.do('load failed generation context', STEP_CONFIG, () => this.loadJob(jobId));
      if (job.status === 'succeeded') return { jobId, status: 'succeeded' };
      if (job) {
        await step.do('settle failed generation', STEP_CONFIG, async () => {
          const settlement = await settleGenerationPurchase(
            this.env,
            job!.user_id,
            job!.charge_id,
            false,
            job!.fighter_id,
          );
          const releasedBeforeProviderStart = settlement?.status === 'refunded';
          const failure = generationFailureDetails(message, releasedBeforeProviderStart);
          await this.env.DB.batch([
            this.env.DB.prepare(`
              UPDATE generation_jobs
              SET status = 'failed', stage = 'failed', error_code = ?,
                  error_message = ?,
                  finished_at = datetime('now'), updated_at = datetime('now')
              WHERE id = ? AND status IN ('queued', 'running')
            `).bind(
              failure.errorCode,
              failure.errorMessage,
              job!.id,
            ),
            this.env.DB.prepare(`
              INSERT INTO generation_job_events (id, job_id, stage, status, detail)
              VALUES (?, ?, 'failed', 'failed', ?)
            `).bind(generateId(), job!.id, message),
          ]);
          return { status: 'failed' };
        });
      }
      return { jobId, status: 'failed' };
    }
  }
}
