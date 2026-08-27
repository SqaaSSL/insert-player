import { useMemo, type ReactNode } from 'react';
import type { CachedMeta, CachedSprite } from '../../services/SpriteCache.ts';
import { AnimationGrid } from './AnimationGrid.tsx';
import { SourceViewsPanel } from './SourceViewsPanel.tsx';
import { SpritePreviewSurface } from './SpritePreviewSurface.tsx';
import { DebugFeed } from './DebugFeed.tsx';
import { Button } from './Button.tsx';
import {
  animLabel,
  getSourceBlob,
  type PreviewSelection,
  type PreviewSpriteLike,
  type SourceKey,
} from '../shared/fighterPreview.ts';
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import { downloadBlob } from '../shared/downloadBlob.ts';

export interface FighterPreviewState {
  previewSprite: PreviewSpriteLike | null;
  previewSourceBlob: Blob | null;
  previewBlob: Blob | null;
  selectedAnimName: string | null;
}

/** Shared preview-selection state derivation for Gallery and Create. */
export function useFighterPreview(
  meta: CachedMeta | null,
  sprites: readonly CachedSprite[],
  selection: PreviewSelection,
): FighterPreviewState {
  const previewSprite = useMemo<PreviewSpriteLike | null>(() => {
    if (!meta || selection.kind !== 'animation') return null;
    const cached = sprites.find((item) => item.animationName === selection.animationName);
    if (cached) {
      return {
        blob: cached.pngBlob,
        rawBlob: cached.rawPngBlob,
        frameWidth: cached.frameWidth,
        frameHeight: cached.frameHeight,
        frameCount: cached.frameCount,
      };
    }
    const failed = meta.failedAnimationArtifacts?.[selection.animationName];
    if (!failed) return null;
    return {
      blob: failed.pngBlob,
      rawBlob: failed.rawPngBlob,
      frameWidth: failed.frameWidth,
      frameHeight: failed.frameHeight,
      frameCount: failed.frameCount,
      failed: true,
      reason: failed.reason,
    };
  }, [meta, selection, sprites]);

  const previewSourceBlob = useMemo(() => {
    if (!meta || selection.kind !== 'source') return null;
    return getSourceBlob(meta, selection.source);
  }, [meta, selection]);

  return {
    previewSprite,
    previewSourceBlob,
    previewBlob: selection.kind === 'source' ? previewSourceBlob : previewSprite?.blob ?? null,
    selectedAnimName: selection.kind === 'animation' ? selection.animationName : null,
  };
}

interface SourceRetryActions {
  side?: () => void | Promise<void>;
  upright?: () => void | Promise<void>;
  crouch?: () => void | Promise<void>;
}

interface FighterPreviewColumnProps {
  meta: CachedMeta | null;
  sprites: readonly CachedSprite[];
  selection: PreviewSelection;
  onSelectionChange: (selection: PreviewSelection) => void;
  /** Animations currently being generated/retried (shows spinner tiles). */
  generating?: ReadonlySet<string>;
  loading: boolean;
  loadingLabel: string;
  emptyLabel?: string;
  /** Filename stem for downloads. */
  safeName: string;
  onSaveGif?: () => void;
  saveGifDisabled?: boolean;
  /** Page-specific buttons appended to the preview action bar (e.g. Retry). */
  extraActions?: ReactNode;
  /** Source retry wiring (Gallery only). */
  sourceRetry?: {
    actions: SourceRetryActions;
    regeneratingSource?: SourceKey | null;
    creditCost?: number;
    busy?: boolean;
  };
  /** Extra content inside the sources panel (e.g. intro video card). */
  sourcePanelExtra?: ReactNode;
}

/**
 * The shared fighter workspace column set: source views + animation grid on
 * the side, sprite preview surface with download actions as the main panel.
 */
export function FighterPreviewColumn({
  meta,
  sprites,
  selection,
  onSelectionChange,
  generating,
  loading,
  loadingLabel,
  emptyLabel,
  safeName,
  onSaveGif,
  saveGifDisabled,
  extraActions,
  sourceRetry,
  sourcePanelExtra,
}: FighterPreviewColumnProps) {
  const { previewSprite, previewSourceBlob, previewBlob, selectedAnimName } = useFighterPreview(
    meta,
    sprites,
    selection,
  );
  const previewSourceUrl = useObjectUrl(previewSourceBlob);
  const hasCachedSelectedSprite = Boolean(
    selectedAnimName && sprites.some((item) => item.animationName === selectedAnimName),
  );

  return (
    <section className="gallery-layout">
      <div className="gallery-column--side">
        <div className="gallery-panel gallery-panel--sources">
          <SourceViewsPanel
            meta={meta}
            selectedSource={selection.kind === 'source' ? selection.source : null}
            onSelectSource={(source) => onSelectionChange({ kind: 'source', source })}
            regeneratingSource={sourceRetry?.regeneratingSource}
            retryCreditCost={sourceRetry?.creditCost}
            onRetry={sourceRetry?.actions}
            busy={sourceRetry?.busy}
          />
          {sourcePanelExtra}
        </div>

        <div className="gallery-panel gallery-panel--anims">
          <h3>Animations</h3>
          <AnimationGrid
            sprites={[...sprites]}
            failedArtifacts={meta?.failedAnimationArtifacts ?? null}
            generating={generating}
            selectedName={selectedAnimName}
            onSelect={(animationName) => onSelectionChange({ kind: 'animation', animationName })}
          />
          <DebugFeed />
        </div>
      </div>

      <div className="gallery-panel gallery-panel--preview">
        <div className="gallery-preview__header">
          <div>
            <p className="gallery-eyebrow">Preview</p>
            <h3>
              {selection.kind === 'source'
                ? selection.source.toUpperCase()
                : animLabel(selection.animationName)}
            </h3>
          </div>
        </div>

        <div className="gallery-preview__surface">
          <SpritePreviewSurface
            sourceImageUrl={selection.kind === 'source' ? previewSourceUrl : null}
            sprite={selection.kind === 'animation' ? previewSprite : null}
            loading={loading}
            loadingLabel={loadingLabel}
            emptyLabel={
              emptyLabel ?? (selection.kind === 'source' ? 'Missing source' : 'No preview for this animation yet')
            }
          />
        </div>

        {previewBlob || hasCachedSelectedSprite || previewSprite?.rawBlob || extraActions ? (
          <div className="gallery-actions">
            {previewBlob ? (
              <Button
                onClick={() =>
                  downloadBlob(
                    previewBlob,
                    `${safeName}_${selection.kind === 'source' ? selection.source : selection.animationName}.png`,
                  )
                }
              >
                Save PNG
              </Button>
            ) : null}
            {hasCachedSelectedSprite && onSaveGif ? (
              <Button disabled={saveGifDisabled} onClick={onSaveGif}>
                Save GIF
              </Button>
            ) : null}
            {previewSprite?.rawBlob ? (
              <Button
                onClick={() => downloadBlob(previewSprite.rawBlob!, `${safeName}_${selectedAnimName}_RAW.png`)}
              >
                Save RAW
              </Button>
            ) : null}
            {extraActions}
          </div>
        ) : null}
      </div>
    </section>
  );
}
