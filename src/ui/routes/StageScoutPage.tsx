import { useCallback, useEffect, useRef, useState } from 'react';
import {
  captureGoogleStreetView,
  hasGoogleMapsBrowserKey,
  loadGoogleMaps,
  streetViewFovForZoom,
  streetViewStageLabel,
  streetViewStageSource,
  type StreetViewCaptureFrame,
} from '../../services/GoogleMapsPlatform.ts';
import {
  createDirectPhotoStage,
  createPhotoStage,
  type PhotoStageCreationResult,
} from '../../services/StageBackgroundService.ts';
import type { CachedStageBackground } from '../../services/SpriteCache.ts';
import { STAGE_FORGE_CREDIT_COST } from '../../shared/StageForgePricing.ts';
import { Button } from '../components/Button.tsx';
import { ConfirmDialog, Modal } from '../components/Modal.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';
import { useObjectUrl } from '../shared/useObjectUrl.ts';

const BENIDORM_CENTER: google.maps.LatLngLiteral = { lat: 38.5411, lng: -0.1225 };

interface StageScoutPageProps {
  onBack: () => void;
  onComplete: () => void;
}

type ScoutView = 'map' | 'street-view';
type BusyAction = 'capture' | 'forge' | 'direct' | null;

interface PanoramaMetadata {
  panoId: string;
  imageDate: string | null;
  copyright: string | null;
}

interface StageCreationSuccess {
  stage: CachedStageBackground;
  mode: 'forge' | 'direct';
  creditsCharged: number;
  creditsBalance?: number;
  billingMode: PhotoStageCreationResult['billingMode'] | 'free';
}

export function StageScoutPage({ onBack, onComplete }: StageScoutPageProps) {
  const mapsConfigured = hasGoogleMapsBrowserKey();
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const panoramaElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const streetViewServiceRef = useRef<google.maps.StreetViewService | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const metadataRef = useRef<PanoramaMetadata | null>(null);
  const locationLabelRef = useRef('Benidorm, Spain');
  const stageNameEditedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const mapsAuthFailedRef = useRef(false);

  const [query, setQuery] = useState('Benidorm, Spain');
  const [locationLabel, setLocationLabel] = useState('Benidorm, Spain');
  const [stageName, setStageName] = useState('BENIDORM');
  const [status, setStatus] = useState('Loading Google Maps and Street View coverage...');
  const [mapReady, setMapReady] = useState(false);
  const [mapsAuthFailed, setMapsAuthFailed] = useState(false);
  const [hasPanorama, setHasPanorama] = useState(false);
  const [activeView, setActiveView] = useState<ScoutView>('map');
  const [liveFrame, setLiveFrame] = useState<StreetViewCaptureFrame | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [capturedFrame, setCapturedFrame] = useState<StreetViewCaptureFrame | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [forgeConfirmationOpen, setForgeConfirmationOpen] = useState(false);
  const [forgeError, setForgeError] = useState<string | null>(null);
  const [creationSuccess, setCreationSuccess] = useState<StageCreationSuccess | null>(null);
  const capturedUrl = useObjectUrl(capturedBlob);
  const createdStageUrl = useObjectUrl(creationSuccess?.stage.pngBlob ?? null);

  const setResolvedLocation = useCallback((label: string) => {
    const normalized = label.replace(/\s+/g, ' ').trim() || 'Street View location';
    locationLabelRef.current = normalized;
    setLocationLabel(normalized);
    if (!stageNameEditedRef.current) setStageName(streetViewStageLabel(normalized));
  }, []);

  const readCurrentFrame = useCallback((): StreetViewCaptureFrame | null => {
    const panorama = panoramaRef.current;
    const panoId = panorama?.getPano();
    const position = panorama?.getPosition();
    const pov = panorama?.getPov();
    if (!panorama || !panoId || !position || !pov) return null;
    const metadata = metadataRef.current?.panoId === panoId ? metadataRef.current : null;
    return {
      panoId,
      latitude: position.lat(),
      longitude: position.lng(),
      heading: pov.heading,
      pitch: pov.pitch,
      fov: streetViewFovForZoom(panorama.getZoom()),
      locationLabel: locationLabelRef.current,
      imageDate: metadata?.imageDate ?? null,
      copyright: metadata?.copyright ?? null,
    };
  }, []);

  const syncLiveFrame = useCallback(() => {
    const next = readCurrentFrame();
    if (next) setLiveFrame(next);
  }, [readCurrentFrame]);

  const readPanoramaMetadata = useCallback(async (panoId: string) => {
    const service = streetViewServiceRef.current;
    if (!service) return;
    try {
      const result = await service.getPanorama({ pano: panoId });
      if (panoramaRef.current?.getPano() !== panoId) return;
      metadataRef.current = {
        panoId,
        imageDate: result.data.imageDate ?? null,
        copyright: result.data.copyright ?? null,
      };
      const description = result.data.location?.description || result.data.location?.shortDescription;
      if (description) setResolvedLocation(description);
      syncLiveFrame();
    } catch {
      metadataRef.current = { panoId, imageDate: null, copyright: null };
      syncLiveFrame();
    }
  }, [setResolvedLocation, syncLiveFrame]);

  const openNearestPanorama = useCallback(async (
    location: google.maps.LatLng | google.maps.LatLngLiteral,
    radius: number,
    preferredLabel?: string,
  ) => {
    const service = streetViewServiceRef.current;
    const panorama = panoramaRef.current;
    const map = mapRef.current;
    if (!service || !panorama || !map || mapsAuthFailedRef.current) return;

    const requestId = ++requestSequenceRef.current;
    setStatus('Scanning the nearby blue Street View coverage...');
    try {
      const result = await service.getPanorama({
        location,
        radius,
        preference: google.maps.StreetViewPreference.NEAREST,
      });
      if (requestId !== requestSequenceRef.current || mapsAuthFailedRef.current) return;
      const panoLocation = result.data.location;
      if (!panoLocation?.pano || !panoLocation.latLng) throw new Error('Street View returned no panorama.');

      metadataRef.current = {
        panoId: panoLocation.pano,
        imageDate: result.data.imageDate ?? null,
        copyright: result.data.copyright ?? null,
      };
      panorama.setPano(panoLocation.pano);
      panorama.setPov({
        heading: result.data.tiles.centerHeading ?? 0,
        pitch: 0,
      });
      panorama.setZoom(1);
      panorama.setVisible(true);
      map.panTo(panoLocation.latLng);
      map.setZoom(Math.max(map.getZoom() ?? 16, 16));
      setResolvedLocation(
        preferredLabel || panoLocation.description || panoLocation.shortDescription || 'Street View location',
      );
      setHasPanorama(true);
      setActiveView('street-view');
      setCapturedBlob(null);
      setCapturedFrame(null);
      setStatus('Street View ready. Frame the arena, then capture this view.');
      window.requestAnimationFrame(syncLiveFrame);
    } catch {
      if (requestId !== requestSequenceRef.current || mapsAuthFailedRef.current) return;
      setHasPanorama(false);
      setActiveView('map');
      setLiveFrame(null);
      setStatus('No panorama found here. Click a blue Street View line or search another nearby spot.');
    }
  }, [setResolvedLocation, syncLiveFrame]);

  useEffect(() => {
    if (!mapsConfigured) {
      setStatus('Stage Scout is not configured in this environment. Add the restricted Google Maps browser key.');
      return;
    }

    let cancelled = false;
    mapsAuthFailedRef.current = false;
    setMapsAuthFailed(false);
    let animationFrame = 0;
    const listeners: google.maps.MapsEventListener[] = [];
    let coverage: google.maps.StreetViewCoverageLayer | null = null;
    const onMapsAuthFailure = () => {
      mapsAuthFailedRef.current = true;
      requestSequenceRef.current += 1;
      setMapsAuthFailed(true);
      setMapReady(false);
      setHasPanorama(false);
      setLiveFrame(null);
      setStatus('Google Maps rejected this browser key. Check its API and HTTP referrer restrictions.');
    };
    window.addEventListener('insert-player:maps-auth-failure', onMapsAuthFailure);

    void loadGoogleMaps().then(async (maps) => {
      const mapElement = mapElementRef.current;
      const panoramaElement = panoramaElementRef.current;
      if (cancelled || !mapElement || !panoramaElement) return;

      const [{ Map }, streetViewLibrary, { Geocoder }] = await Promise.all([
        maps.importLibrary('maps') as Promise<google.maps.MapsLibrary>,
        maps.importLibrary('streetView') as Promise<google.maps.StreetViewLibrary>,
        maps.importLibrary('geocoding') as Promise<google.maps.GeocodingLibrary>,
      ]);
      if (cancelled || mapsAuthFailedRef.current) return;

      const map = new Map(mapElement, {
        center: BENIDORM_CENTER,
        zoom: 15,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        clickableIcons: false,
        gestureHandling: 'cooperative',
      });
      const panorama = new streetViewLibrary.StreetViewPanorama(panoramaElement, {
        addressControl: true,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false,
        panControl: true,
        linksControl: true,
        zoomControl: true,
        visible: false,
      });
      const service = new streetViewLibrary.StreetViewService();
      coverage = new streetViewLibrary.StreetViewCoverageLayer();
      coverage.setMap(map);

      mapRef.current = map;
      panoramaRef.current = panorama;
      streetViewServiceRef.current = service;
      geocoderRef.current = new Geocoder();
      setMapReady(true);

      const scheduleFrameSync = () => {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = window.requestAnimationFrame(syncLiveFrame);
      };
      listeners.push(
        map.addListener('click', (event: google.maps.MapMouseEvent) => {
          if (!event.latLng) return;
          void openNearestPanorama(event.latLng, 80);
        }),
        panorama.addListener('pov_changed', scheduleFrameSync),
        panorama.addListener('zoom_changed', scheduleFrameSync),
        panorama.addListener('position_changed', scheduleFrameSync),
        panorama.addListener('pano_changed', () => {
          scheduleFrameSync();
          const panoId = panorama.getPano();
          if (panoId) void readPanoramaMetadata(panoId);
        }),
      );

      void openNearestPanorama(BENIDORM_CENTER, 500, 'Benidorm, Spain');
    }).catch((error: unknown) => {
      if (cancelled || mapsAuthFailedRef.current) return;
      const message = error instanceof Error ? error.message : 'Google Maps could not be loaded.';
      setStatus(message);
    });

    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
      window.cancelAnimationFrame(animationFrame);
      listeners.forEach((listener) => listener.remove());
      window.removeEventListener('insert-player:maps-auth-failure', onMapsAuthFailure);
      coverage?.setMap(null);
      panoramaRef.current?.setVisible(false);
      mapRef.current = null;
      panoramaRef.current = null;
      streetViewServiceRef.current = null;
      geocoderRef.current = null;
    };
  }, [mapsConfigured, openNearestPanorama, readPanoramaMetadata, syncLiveFrame]);

  const searchForPlace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const geocoder = geocoderRef.current;
    const map = mapRef.current;
    const cleaned = query.trim();
    if (!geocoder || !map || !cleaned || busyAction) return;

    setStatus(`Searching for ${cleaned}...`);
    try {
      const result = await geocoder.geocode({ address: cleaned });
      const match = result.results[0];
      if (!match) throw new Error('No matching place found.');
      map.setCenter(match.geometry.location);
      map.setZoom(16);
      setResolvedLocation(match.formatted_address || cleaned);
      await openNearestPanorama(
        match.geometry.location,
        500,
        match.formatted_address || cleaned,
      );
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'That place could not be found.');
    }
  };

  const captureCurrentView = async () => {
    const frame = readCurrentFrame();
    if (!frame || busyAction) {
      setStatus('Choose a Street View panorama before capturing.');
      return;
    }
    setBusyAction('capture');
    setStatus('Capturing the exact Street View angle...');
    try {
      const blob = await captureGoogleStreetView(frame);
      setCapturedBlob(blob);
      setCapturedFrame(frame);
      setStatus('Frame captured. Forge it with AI or use the photo directly.');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Street View capture failed.');
    } finally {
      setBusyAction(null);
    }
  };

  const createStage = async (mode: 'forge' | 'direct') => {
    if (!capturedBlob || !capturedFrame || busyAction) return;
    const action: BusyAction = mode === 'forge' ? 'forge' : 'direct';
    setBusyAction(action);
    if (mode === 'forge') setForgeError(null);
    setStatus(mode === 'forge'
      ? 'Forging this real place into a fighting stage...'
      : 'Preparing this Street View photo as a stage...');
    try {
      const source = streetViewStageSource(capturedFrame);
      if (mode === 'forge') {
        const result = await createPhotoStage(capturedBlob, stageName, source);
        setCreationSuccess({
          stage: result.stage,
          mode,
          creditsCharged: result.creditsCharged,
          creditsBalance: result.creditsBalance,
          billingMode: result.billingMode,
        });
      } else {
        const stage = await createDirectPhotoStage(capturedBlob, stageName, source);
        setCreationSuccess({
          stage,
          mode,
          creditsCharged: 0,
          billingMode: 'free',
        });
      }
      setForgeConfirmationOpen(false);
      setStatus('Stage saved. Choose what to do next.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The stage could not be created.';
      setStatus(message);
      if (mode === 'forge') setForgeError(message);
    } finally {
      setBusyAction(null);
    }
  };

  const keepScouting = () => {
    setCreationSuccess(null);
    setCapturedBlob(null);
    setCapturedFrame(null);
    setStatus('Stage saved. Search for another spot or capture a new angle.');
  };

  const showView = (view: ScoutView) => {
    setActiveView(view);
    window.requestAnimationFrame(() => {
      if (typeof google === 'undefined') return;
      if (view === 'map' && mapRef.current) google.maps.event.trigger(mapRef.current, 'resize');
      if (view === 'street-view' && panoramaRef.current) {
        google.maps.event.trigger(panoramaRef.current, 'resize');
        panoramaRef.current.focus();
      }
    });
  };

  const working = busyAction !== null;
  const frameSummary = liveFrame
    ? `${Math.round(liveFrame.heading)}° · ${Math.round(liveFrame.pitch)}° pitch · ${Math.round(liveFrame.fov)}° FOV`
    : 'Choose a panorama to unlock capture';

  return (
    <main className="stage-scout">
      <header className="stage-scout__header">
        <div>
          <span className="stage-scout__eyebrow">Real World Arena Builder</span>
          <h1>Stage Scout</h1>
          <p>Search any place, step into Street View, and lock the exact angle for your next arena.</p>
        </div>
        <Button onClick={onBack} disabled={working}>Back</Button>
      </header>

      <form className="stage-scout__search" onSubmit={searchForPlace}>
        <label htmlFor="stage-scout-place">Find a real place</label>
        <div className="stage-scout__search-row">
          <input
            id="stage-scout-place"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Benidorm Old Town, Shibuya Crossing, Dubai Marina..."
            autoComplete="street-address"
            disabled={!mapReady || working}
          />
          <Button type="submit" variant="primary" disabled={!mapReady || !query.trim() || working}>
            Search Spot
          </Button>
        </div>
        <div className="stage-scout__legend">
          <span><i aria-hidden="true" /> Blue lines have Street View</span>
          <span>Click a line to enter nearby imagery</span>
        </div>
      </form>

      <div className={`stage-scout__workspace${hasPanorama ? ' has-panorama' : ''}`}>
        <div className="stage-scout__view-switch" aria-label="Stage Scout view">
          <button
            type="button"
            className={activeView === 'map' ? 'is-active' : ''}
            aria-pressed={activeView === 'map'}
            onClick={() => showView('map')}
          >
            Coverage Map
          </button>
          <button
            type="button"
            className={activeView === 'street-view' ? 'is-active' : ''}
            aria-pressed={activeView === 'street-view'}
            disabled={!hasPanorama}
            onClick={() => showView('street-view')}
          >
            Street View
          </button>
        </div>

        <section className={`stage-scout__map-panel${activeView === 'map' ? ' is-active' : ''}`} aria-label="Street View coverage map">
          <div ref={mapElementRef} className="stage-scout__map" />
          {!mapReady ? (
            <div className="stage-scout__canvas-state">
              <strong>
                {mapsAuthFailed ? 'Maps Key Rejected' : mapsConfigured ? 'Loading Coverage' : 'Maps Key Required'}
              </strong>
              <span>
                {mapsAuthFailed
                  ? 'Allow this exact site URL in the browser key restrictions, then reload.'
                  : mapsConfigured
                  ? 'Connecting to Google Maps and Street View...'
                  : 'Configure the restricted browser key to enable real-world stage scouting.'}
              </span>
            </div>
          ) : null}
        </section>

        <section className={`stage-scout__pano-panel${activeView === 'street-view' ? ' is-active' : ''}`} aria-label="Street View stage framing">
          <div ref={panoramaElementRef} className="stage-scout__panorama" />
          {hasPanorama ? (
            <div className="stage-scout__reticle" aria-hidden="true">
              <span />
              <span />
              <i />
            </div>
          ) : (
            <div className="stage-scout__canvas-state">
              <strong>Pick a blue line</strong>
              <span>Street View will open here for framing.</span>
            </div>
          )}
        </section>
      </div>

      <section className="stage-scout__capture-panel" aria-label="Capture and create stage">
        <div className="stage-scout__capture-copy">
          <span className="stage-scout__location">{locationLabel}</span>
          <strong>{frameSummary}</strong>
          <span role="status" aria-live="polite">{status}</span>
        </div>
        <Button
          variant="primary"
          size="lg"
          disabled={!liveFrame || working}
          onClick={() => void captureCurrentView()}
        >
          {busyAction === 'capture' ? 'Capturing...' : capturedBlob ? 'Recapture View' : 'Capture This View'}
        </Button>
      </section>

      {capturedBlob && capturedFrame ? (
        <section className="stage-scout__forge-panel">
          <div className="stage-scout__snapshot">
            {capturedUrl ? <img src={capturedUrl} alt={`Captured Street View at ${locationLabel}`} /> : null}
            <span>Captured Frame</span>
          </div>
          <div className="stage-scout__forge-controls">
            <label htmlFor="stage-scout-name">Stage name</label>
            <input
              id="stage-scout-name"
              value={stageName}
              maxLength={42}
              disabled={working}
              onChange={(event) => {
                stageNameEditedRef.current = true;
                setStageName(event.target.value);
              }}
            />
            <p>Forge Stage creates custom AI artwork for 1 credit. Use Photo keeps the captured view and is free.</p>
            <div className="stage-scout__forge-actions">
              <Button
                variant="primary"
                size="lg"
                disabled={working || !stageName.trim()}
                onClick={() => {
                  setForgeError(null);
                  setForgeConfirmationOpen(true);
                }}
              >
                {busyAction === 'forge' ? 'Forging...' : `Forge Stage · ${STAGE_FORGE_CREDIT_COST} Credit`}
              </Button>
              <Button
                size="lg"
                disabled={working || !stageName.trim()}
                onClick={() => void createStage('direct')}
              >
                {busyAction === 'direct' ? 'Preparing...' : 'Use Photo · Free'}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {forgeConfirmationOpen ? (
        <ConfirmDialog
          title="Forge this stage?"
          confirmLabel={`Spend ${STAGE_FORGE_CREDIT_COST} Credit`}
          cancelLabel="Keep Framing"
          onConfirm={() => void createStage('forge')}
          onCancel={() => {
            setForgeError(null);
            setForgeConfirmationOpen(false);
          }}
          busy={busyAction === 'forge'}
        >
          <p>
            Stage Forge will turn this Street View frame into custom fighting-game artwork.
            {' '}{STAGE_FORGE_CREDIT_COST} credit is reserved now and consumed when AI generation starts.
            If generation cannot start, it is released automatically.
          </p>
          {forgeError ? <StatusMessage severity="error">{forgeError}</StatusMessage> : null}
        </ConfirmDialog>
      ) : null}

      {creationSuccess ? (
        <Modal title="Stage Ready" onClose={keepScouting} showClose={false}>
          {createdStageUrl ? (
            <div className="stage-scout__success-preview">
              <img src={createdStageUrl} alt={`${creationSuccess.stage.label} stage preview`} />
              <span>{creationSuccess.mode === 'forge' ? 'AI Forged' : 'Direct Photo'}</span>
            </div>
          ) : null}
          <div className="stage-scout__success-copy">
            <strong>{creationSuccess.stage.label}</strong>
            <p>Your stage is saved in Gallery and ready for a fight.</p>
            <div className="stage-scout__success-receipt" aria-label="Stage creation receipt">
              <span>
                {creationSuccess.billingMode === 'cache'
                  ? 'Already forged · 0 credits used'
                  : creationSuccess.billingMode === 'local'
                    ? 'Local preview · 0 cloud credits used'
                    : creationSuccess.mode === 'forge'
                      ? `${creationSuccess.creditsCharged} credit used`
                      : 'Free · 0 credits used'}
              </span>
              {typeof creationSuccess.creditsBalance === 'number' ? (
                <span>{creationSuccess.creditsBalance} credits remaining</span>
              ) : null}
            </div>
          </div>
          <div className="asf-modal__actions">
            <Button onClick={keepScouting}>Keep Scouting</Button>
            <Button variant="primary" onClick={onComplete}>View in Gallery</Button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
