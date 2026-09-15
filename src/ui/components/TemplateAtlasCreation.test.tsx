import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
import { CreateFighterPage } from '../routes/CreateFighterPage';
import { AnimationGrid } from './AnimationGrid';
import { PipelineProgress } from './PipelineProgress';
import { TEMPLATE_ATLAS_ANIMATION_NAMES } from '../../services/TemplateAtlasContract';
import { buildGifFramePlan } from '../../services/GifExportService';

afterEach(() => vi.unstubAllGlobals());

describe('new template character creation', () => {
  it('asks for an account rather than offering anonymous legacy generation', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const html = renderToStaticMarkup(<CreateFighterPage authStatus="signed-out" authSessionKey="test"
      onBack={() => {}} onComplete={() => {}} />);
    expect(html).toContain('Start with your account');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('creation-flow-picker');
  });
  it('offers the full character and both qualities, not legacy packs or refinement claims', () => {
    vi.stubGlobal('window', { location: { search: '?package=aura&return=aura' } });
    const html = renderToStaticMarkup(<CreateFighterPage authStatus="signed-in" authSessionKey="test"
      onBack={() => {}} onComplete={() => {}} />);
    expect(html).toContain('20 animations');
    expect(html).toContain('Rookie');
    expect(html).toContain('Champion');
    expect(html).not.toContain('name="creation-package"');
    expect(html).not.toContain('refines the animation frames individually');
  });
  it('lists all 20 pending slots before the first saved frame without claiming ready', () => {
    const html = renderToStaticMarkup(<AnimationGrid sprites={[]} animationNames={TEMPLATE_ATLAS_ANIMATION_NAMES} onSelect={() => {}} />);
    expect(html.match(/type="button"/g)).toHaveLength(20);
    expect(html.match(/animation, pending/g)).toHaveLength(20);
    expect(html).toContain('UPPERCUT');
    expect(html).toContain('FIREBALL');
    expect(html).toContain('SHRUG');
  });
  it('does not publish an invented numeric progress value when no total exists', () => {
    const html = renderToStaticMarkup(<PipelineProgress percent={null} label="Queued safely in the cloud." />);
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('Queued safely in the cloud.');
  });
  it('exports existing authored holds instead of appending a second set of holds', () => {
    const plan = buildGifFramePlan('high_kick', 21, 'template-atlas-v1');
    expect(plan).toHaveLength(21);
    expect(plan.every((frame, index) => frame.sourceIndex === index && frame.delayMs === 125)).toBe(true);
  });
});
