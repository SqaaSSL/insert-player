import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './types';
import { failFinisher } from './battleMedia';
import { pollFinisher, submitFinisher } from './battleFinisherProvider';
export interface BattleFinisherParams { jobId: string }
export class BattleFinisherWorkflow extends WorkflowEntrypoint<Env, BattleFinisherParams> {
  async run(event: Readonly<WorkflowEvent<BattleFinisherParams>>, step: WorkflowStep): Promise<unknown> {
    const { jobId } = event.payload;
    try {
      const job = await step.do('submit one bounded finisher', { retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' }, () => submitFinisher(this.env, jobId));
      if (!job || job.status === 'failed' || job.status === 'ready') return { status: job?.status ?? 'removed' };
      for (let index = 0; index < 120; index++) {
        const state = await step.do(`poll and preserve finisher ${index}`, { retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, () => pollFinisher(this.env, jobId));
        if (state !== 'pending') return { status: state };
        await step.sleep(`wait for finisher ${index}`, '2 seconds');
      }
      throw new Error('generation_timeout');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'generation_failed';
      await step.do('return undelivered finisher credit', () => failFinisher(this.env, jobId, code));
      return { status: 'failed' };
    }
  }
}
