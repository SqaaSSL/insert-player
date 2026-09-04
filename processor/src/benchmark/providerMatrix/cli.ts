import {
  ANIMATIONS,
  PROVIDER_MATRIX_RUN_ID,
  RENDERERS,
  STRATEGIES,
} from './catalog.ts';
import { executePlan, planSummary } from './runtime.ts';
import type { AnimationId, RendererId, StrategyId } from './contract.ts';

function valueArg(name: string): string | undefined {
  return process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function parseRenderer(value: string | undefined): RendererId | undefined {
  if (value === undefined) return undefined;
  if (!RENDERERS.some((renderer) => renderer.id === value)) throw new Error(`Unknown renderer: ${value}`);
  return value as RendererId;
}

function parseStrategy(value: string | undefined): StrategyId | undefined {
  if (value === undefined) return undefined;
  if (!(value in STRATEGIES)) throw new Error(`Unknown strategy: ${value}`);
  return value as StrategyId;
}

function parseAnimation(value: string | undefined): AnimationId {
  const selected = value ?? 'high_kick';
  if (!(selected in ANIMATIONS)) throw new Error(`Unknown animation: ${selected}`);
  return selected as AnimationId;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const rendererId = parseRenderer(valueArg('--renderer'));
  const strategyId = parseStrategy(valueArg('--strategy'));
  const animationId = parseAnimation(valueArg('--animation'));
  if (!execute) {
    process.stdout.write(`${JSON.stringify(await planSummary(rendererId, strategyId, animationId), null, 2)}\n`);
    return;
  }
  if (!rendererId || !strategyId) throw new Error('--renderer and --strategy are required for paid execution.');
  const maxCost = Number(valueArg('--max-cost'));
  const throughFrameRaw = valueArg('--through-frame');
  const throughFrame = throughFrameRaw === undefined ? undefined : Number(throughFrameRaw);
  if (!Number.isFinite(maxCost) || maxCost <= 0) throw new Error('--max-cost must be a positive number.');
  if (throughFrame !== undefined && (!Number.isInteger(throughFrame) || throughFrame < 1)) throw new Error('--through-frame must be an integer >= 1.');
  const report = await executePlan({
    rendererId,
    strategyId,
    animationId,
    throughFrame,
    confirmation: valueArg('--confirm') ?? '',
    maxCostUsd: maxCost,
  });
  process.stdout.write(`${JSON.stringify({ runId: PROVIDER_MATRIX_RUN_ID, report }, null, 2)}\n`);
}

await main();
