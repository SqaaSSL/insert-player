import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthStatus } from '../authState.ts';
import { Button } from '../components/Button.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';
import {
  allocateVersusMatch,
  createVersusRoom,
  declareVersusFighter,
  fetchVersusIceServers,
  fetchVersusOpponentFighter,
  joinVersusRoom,
  versusFighterPhotoHash,
  VersusRoomError,
  type VersusIceServers,
  type VersusRoomSeatInfo,
} from '../../services/VersusRooms.ts';
import { PeerTransport, type PeerTransportState } from '../../game/net/PeerTransport.ts';
import { seatToSlot, setActiveOnlineSession } from '../../game/net/onlineSession.ts';
import { DEFAULT_INPUT_DELAY } from '../../game/net/RollbackSession.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import {
  downloadArcadeFighterToLocal,
  downloadCloudFighterToLocal,
  listArcadeFighters,
  syncCloudFightersToLocal,
  type CloudFighter,
} from '../../services/CloudFighters.ts';
import { ensurePlayableSpritesUpToDate } from '../../services/CharacterPipeline.ts';
import {
  CACHE_VERSION,
  getActiveSpriteCacheScope,
  getAllCachedMetas,
  getAllSpritesForHash,
} from '../../services/SpriteCache.ts';
import { assertCompletePlayableSpriteSet } from '../../services/PlayableFighterAssets.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import { debugWarn } from '../../services/DebugLog.ts';
import { buildRosterFighterSections, type RosterFighterEntry } from './RosterPage.tsx';

interface OnlineVersusPageProps {
  authStatus: AuthStatus;
  onBack: () => void;
  onStartFight: (data: MatchSceneData) => void;
}

type RoomPhase =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'seated'; seat: VersusRoomSeatInfo; ice: VersusIceServers }
  | { kind: 'error'; message: string };

interface LobbyPeerState {
  fighterId: string | null;
  fighterName: string;
  ready: boolean;
}

/** Control-channel messages exchanged in the lobby (reliable, JSON). */
type LobbyMessage =
  | { t: 'lobby'; fighterId: string | null; fighterName: string; ready: boolean }
  | {
      t: 'start';
      seed: number;
      matchSerial: number;
      inputDelay: number;
      hostFighterId: string | null;
      guestFighterId: string | null;
      hostName: string;
      guestName: string;
    };

function isLobbyMessage(value: unknown): value is LobbyMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.t === 'lobby') {
    return (message.fighterId === null || typeof message.fighterId === 'string')
      && typeof message.fighterName === 'string' && typeof message.ready === 'boolean';
  }
  if (message.t === 'start') {
    return typeof message.seed === 'number' && typeof message.matchSerial === 'number'
      && typeof message.inputDelay === 'number'
      && (message.hostFighterId === null || typeof message.hostFighterId === 'string')
      && (message.guestFighterId === null || typeof message.guestFighterId === 'string')
      && typeof message.hostName === 'string' && typeof message.guestName === 'string';
  }
  return false;
}

function phaseLabel(state: PeerTransportState): string {
  switch (state.phase) {
    case 'idle':
      return 'Idle';
    case 'connecting':
      return 'Connecting to room…';
    case 'waiting_peer':
      return 'Waiting for your rival to join…';
    case 'negotiating':
      return 'Rival seated — negotiating a direct link…';
    case 'connected':
      return state.path === 'p2p' ? 'Connected · direct P2P' : 'Connected · relayed through the room';
    case 'closed':
      return 'Disconnected';
    case 'error':
      return state.error ?? 'Connection error';
  }
}

function rttLabel(rttMs: number | null): string {
  if (rttMs === null) return '—';
  return `${Math.round(rttMs)} ms`;
}

function rttQuality(rttMs: number | null): 'unknown' | 'great' | 'good' | 'rough' {
  if (rttMs === null) return 'unknown';
  if (rttMs < 60) return 'great';
  if (rttMs < 140) return 'good';
  return 'rough';
}

function randomSeed(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] || 0x13579bdf;
}

/** A fighter the opponent can fetch: synced to the cloud, or an official Arcade fighter. */
function isShareableEntry(entry: RosterFighterEntry): boolean {
  return Boolean(entry.cloudFighterId) && entry.animationCount > 0;
}

export function OnlineVersusPage({ authStatus, onBack, onStartFight }: OnlineVersusPageProps) {
  const [room, setRoom] = useState<RoomPhase>({ kind: 'idle' });
  const [codeInput, setCodeInput] = useState('');
  const [transportState, setTransportState] = useState<PeerTransportState | null>(null);
  const [copied, setCopied] = useState(false);
  const [roster, setRoster] = useState<RosterFighterEntry[]>([]);
  const [rosterStatus, setRosterStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [peer, setPeer] = useState<LobbyPeerState | null>(null);
  const [launchStatus, setLaunchStatus] = useState<string | null>(null);
  const transportRef = useRef<PeerTransport | null>(null);
  const handedOffRef = useRef(false);
  const launchingRef = useRef(false);
  const localLobbyRef = useRef<LobbyPeerState>({ fighterId: null, fighterName: 'Fighter', ready: false });

  const signedIn = authStatus === 'signed-in';
  const selected = useMemo(() => roster.find((entry) => entry.key === selectedKey) ?? null, [roster, selectedKey]);

  // ------------------------------------------------------------- roster

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRosterStatus('loading');
      try {
        const scope = getActiveSpriteCacheScope();
        const context = captureApiRequestContext();
        const arcade = await listArcadeFighters().catch(() => [] as CloudFighter[]);
        let metas = (await getAllCachedMetas(scope)).filter(
          (meta) => meta.version === CACHE_VERSION && meta.status === 'ready',
        );
        if (signedIn) {
          try {
            await syncCloudFightersToLocal(metas, context);
            metas = (await getAllCachedMetas(scope)).filter(
              (meta) => meta.version === CACHE_VERSION && meta.status === 'ready',
            );
          } catch (err) {
            debugWarn('[OnlineVersus] Cloud roster sync failed:', err instanceof Error ? err.message : err);
          }
        }
        if (cancelled) return;
        const sections = buildRosterFighterSections(metas, arcade);
        const entries = [...sections.owned, ...sections.official].filter(isShareableEntry);
        setRoster(entries);
        setRosterStatus('ready');
        setSelectedKey((current) => current ?? entries[0]?.key ?? null);
      } catch (err) {
        if (cancelled) return;
        debugWarn('[OnlineVersus] Roster load failed:', err instanceof Error ? err.message : err);
        setRosterStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // ---------------------------------------------------------- transport

  const teardown = useCallback(() => {
    if (!handedOffRef.current) transportRef.current?.close();
    transportRef.current = null;
    setTransportState(null);
    setPeer(null);
    setReady(false);
    localLobbyRef.current = { ...localLobbyRef.current, ready: false };
  }, []);

  useEffect(() => teardown, [teardown]);

  const sendLobbyState = useCallback(() => {
    const transport = transportRef.current;
    if (!transport) return;
    const local = localLobbyRef.current;
    transport.sendControl({ t: 'lobby', ...local } satisfies LobbyMessage);
  }, []);

  const launchMatch = useCallback(async (
    start: Extract<LobbyMessage, { t: 'start' }>,
    seat: VersusRoomSeatInfo,
  ) => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    const transport = transportRef.current;
    if (!transport) {
      launchingRef.current = false;
      return;
    }
    const context = captureApiRequestContext();
    const scope = getActiveSpriteCacheScope();
    const localSlot = seatToSlot(seat.seat);
    try {
      setLaunchStatus('Preparing fighters…');
      // Own fighter: make the local playable set current.
      const own = roster.find((entry) => entry.cloudFighterId === (localSlot === 0 ? start.hostFighterId : start.guestFighterId)) ?? null;
      let ownHash: string | undefined;
      if (own) {
        if (own.kind === 'arcade' && own.cloud) {
          await downloadArcadeFighterToLocal(own.cloud, context);
        } else {
          await ensurePlayableSpritesUpToDate(own.photoHash);
        }
        assertCompletePlayableSpriteSet(await getAllSpritesForHash(own.photoHash, scope), own.name);
        ownHash = own.photoHash;
      }
      // Opponent fighter: fetch through the room and cache it locally.
      const opponentId = localSlot === 0 ? start.guestFighterId : start.hostFighterId;
      let opponentHash: string | undefined;
      if (opponentId) {
        setLaunchStatus('Downloading your rival…');
        const manifest = await fetchVersusOpponentFighter(seat.roomCode, context);
        if (!manifest || manifest.id !== opponentId) {
          throw new Error('Your rival has not shared a playable fighter yet.');
        }
        const scoped: CloudFighter = { ...manifest, photoHash: versusFighterPhotoHash(manifest.id) };
        await downloadCloudFighterToLocal(scoped, context, { includeArchivedVersions: false, includeRawAssets: false });
        assertCompletePlayableSpriteSet(await getAllSpritesForHash(scoped.photoHash!, scope), manifest.name);
        opponentHash = scoped.photoHash;
      }
      const hostHash = localSlot === 0 ? ownHash : opponentHash;
      const guestHash = localSlot === 0 ? opponentHash : ownHash;

      setLaunchStatus('Starting match…');
      handedOffRef.current = true;
      setActiveOnlineSession({
        transport,
        roomCode: seat.roomCode,
        seat: seat.seat,
        localSlot,
        inputDelay: start.inputDelay,
        fighterIds: [start.hostFighterId, start.guestFighterId],
      });
      onStartFight({
        vsAI: false,
        cpuVsCpu: false,
        p1PhotoHash: hostHash,
        p2PhotoHash: guestHash,
        p1CloudFighterId: start.hostFighterId,
        p2CloudFighterId: start.guestFighterId,
        p1Name: start.hostName,
        p2Name: start.guestName,
        seed: start.seed >>> 0,
        online: {
          roomCode: seat.roomCode,
          localSlot,
          matchSerial: start.matchSerial,
          inputDelay: start.inputDelay,
        },
      });
    } catch (err) {
      launchingRef.current = false;
      handedOffRef.current = false;
      const message = err instanceof Error ? err.message : 'Could not start the match';
      setLaunchStatus(null);
      setRoom({ kind: 'error', message });
      debugWarn('[OnlineVersus] Launch failed:', message);
    }
  }, [onStartFight, roster]);

  const openTransport = useCallback((seat: VersusRoomSeatInfo, ice: VersusIceServers) => {
    teardown();
    handedOffRef.current = false;
    launchingRef.current = false;
    const transport = new PeerTransport({
      socketUrl: seat.socketUrl,
      seat: seat.seat,
      roomCode: seat.roomCode,
      iceServers: ice.iceServers,
    });
    transportRef.current = transport;
    transport.onState((state) => {
      setTransportState(state);
      if (!state.peerPresent) setPeer(null);
    });
    transport.onControl((payload) => {
      if (!isLobbyMessage(payload)) return;
      if (payload.t === 'lobby') {
        setPeer({ fighterId: payload.fighterId, fighterName: payload.fighterName, ready: payload.ready });
        return;
      }
      if (seat.seat === 'guest') void launchMatch(payload, seat);
    });
    transport.connect();
  }, [launchMatch, teardown]);

  // Re-announce our lobby state whenever the peer (re)connects.
  useEffect(() => {
    if (transportState?.phase === 'connected') sendLobbyState();
  }, [transportState?.phase, transportState?.peerPresent, sendLobbyState]);

  // Host: both ready → allocate the match and start.
  useEffect(() => {
    if (room.kind !== 'seated' || room.seat.seat !== 'host') return;
    if (!ready || !peer?.ready || !transportState || transportState.phase !== 'connected') return;
    if (launchingRef.current) return;
    const seat = room.seat;
    const local = localLobbyRef.current;
    (async () => {
      try {
        setLaunchStatus('Both ready — starting…');
        const matchSerial = await allocateVersusMatch(seat.roomCode);
        const start: Extract<LobbyMessage, { t: 'start' }> = {
          t: 'start',
          seed: randomSeed(),
          matchSerial,
          inputDelay: DEFAULT_INPUT_DELAY,
          hostFighterId: local.fighterId,
          guestFighterId: peer.fighterId,
          hostName: local.fighterName,
          guestName: peer.fighterName,
        };
        transportRef.current?.sendControl(start);
        await launchMatch(start, seat);
      } catch (err) {
        setLaunchStatus(null);
        setRoom({ kind: 'error', message: err instanceof Error ? err.message : 'Could not start the match' });
      }
    })();
  }, [room, ready, peer, transportState, launchMatch]);

  // ------------------------------------------------------------ actions

  const runRoomAction = useCallback(async (label: string, action: () => Promise<VersusRoomSeatInfo>) => {
    setRoom({ kind: 'busy', label });
    try {
      const [seat, ice] = await Promise.all([action(), fetchVersusIceServers()]);
      setRoom({ kind: 'seated', seat, ice });
      openTransport(seat, ice);
    } catch (err) {
      const message = err instanceof VersusRoomError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Something went wrong';
      setRoom({ kind: 'error', message });
    }
  }, [openTransport]);

  const onCreate = () => {
    void runRoomAction('Creating room…', () => createVersusRoom());
  };

  const onJoin = () => {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    void runRoomAction('Joining room…', () => joinVersusRoom(code));
  };

  const onLeave = () => {
    teardown();
    setRoom({ kind: 'idle' });
    setCopied(false);
    setLaunchStatus(null);
  };

  const onToggleReady = async () => {
    if (room.kind !== 'seated') return;
    const next = !ready;
    const fighterId = selected?.cloudFighterId ?? null;
    try {
      if (next) {
        setLaunchStatus('Sharing your fighter with the room…');
        await declareVersusFighter(room.seat.roomCode, fighterId);
        setLaunchStatus(null);
      }
      localLobbyRef.current = { fighterId, fighterName: selected?.name ?? 'Fighter', ready: next };
      setReady(next);
      sendLobbyState();
    } catch (err) {
      setLaunchStatus(null);
      setRoom({ kind: 'error', message: err instanceof Error ? err.message : 'Could not share fighter' });
    }
  };

  const onCopyCode = async () => {
    if (room.kind !== 'seated') return;
    try {
      await navigator.clipboard.writeText(room.seat.roomCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const quality = transportState ? rttQuality(transportState.rttMs) : 'unknown';
  const connected = transportState?.phase === 'connected';

  return (
    <div className="roster-app online-versus">
      <header className="roster-hero">
        <div>
          <h1>Online Versus</h1>
          <p className="roster-hero__copy">
            Fight a friend from their own home. One of you creates a room and shares the code; the other joins.
            Pick a fighter, hit Ready, and the match starts on both machines at once — only your inputs travel.
          </p>
        </div>
        <div className="roster-hero__actions">
          <Button variant="ghost" onClick={onBack}>Back</Button>
        </div>
      </header>

      {!signedIn ? (
        <StatusMessage severity="warn">Sign in to create or join an online room.</StatusMessage>
      ) : null}

      {room.kind === 'error' ? <StatusMessage severity="error">{room.message}</StatusMessage> : null}
      {room.kind === 'busy' ? <StatusMessage severity="progress">{room.label}</StatusMessage> : null}
      {launchStatus ? <StatusMessage severity="progress">{launchStatus}</StatusMessage> : null}

      {room.kind !== 'seated' ? (
        <div className="online-versus__lobby">
          <section className="gallery-panel online-versus__panel">
            <h3>Host a room</h3>
            <p className="roster-hero__copy">You will be Player 1. Share the six-letter code with your rival.</p>
            <Button variant="primary" size="lg" disabled={!signedIn || room.kind === 'busy'} onClick={onCreate}>
              Create room
            </Button>
          </section>
          <section className="gallery-panel online-versus__panel">
            <h3>Join a room</h3>
            <p className="roster-hero__copy">Enter the code your rival shared. You will be Player 2.</p>
            <label className="online-versus__field">
              <span>Room code</span>
              <input
                className="online-versus__code-input"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={8}
                placeholder="ABC234"
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onJoin();
                }}
              />
            </label>
            <Button variant="primary" size="lg" disabled={!signedIn || room.kind === 'busy' || codeInput.trim().length < 6} onClick={onJoin}>
              Join room
            </Button>
          </section>
        </div>
      ) : (
        <div className="online-versus__lobby">
          <section className="gallery-panel online-versus__panel online-versus__room">
            <div className="online-versus__room-header">
              <div>
                <h3>{room.seat.seat === 'host' ? 'You are hosting' : 'You joined'} · Player {room.seat.seat === 'host' ? '1' : '2'}</h3>
                <p className="roster-hero__copy">Room code</p>
              </div>
              <Button variant="ghost" onClick={onLeave}>Leave room</Button>
            </div>
            <div className="online-versus__code-row">
              <code className="online-versus__code" aria-label="Room code">{room.seat.roomCode}</code>
              <Button onClick={() => void onCopyCode()}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>

            <dl className="online-versus__stats">
              <div>
                <dt>Status</dt>
                <dd>{transportState ? phaseLabel(transportState) : 'Starting…'}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>
                  {transportState?.path === 'p2p' ? 'Direct (WebRTC)' : transportState?.path === 'relay' ? 'Relay (room)' : '—'}
                </dd>
              </div>
              <div>
                <dt>Ping</dt>
                <dd className={`online-versus__rtt is-${quality}`}>{rttLabel(transportState?.rttMs ?? null)}</dd>
              </div>
              <div>
                <dt>TURN</dt>
                <dd>{room.ice.turn === 'configured' ? 'available' : 'STUN only'}</dd>
              </div>
              <div>
                <dt>Rival</dt>
                <dd>
                  {!transportState?.peerPresent
                    ? 'not here yet'
                    : peer
                      ? `${peer.fighterName} · ${peer.ready ? 'READY' : 'choosing'}`
                      : 'choosing'}
                </dd>
              </div>
            </dl>
          </section>

          <section className="gallery-panel online-versus__panel">
            <h3>Your fighter</h3>
            {rosterStatus === 'loading' ? <StatusMessage severity="progress">Loading your roster…</StatusMessage> : null}
            {rosterStatus === 'error' ? <StatusMessage severity="error">Could not load your roster.</StatusMessage> : null}
            {rosterStatus === 'ready' && roster.length === 0 ? (
              <StatusMessage severity="warn">
                No shareable fighters yet. Online play needs a fighter synced to your account or an official Arcade fighter.
              </StatusMessage>
            ) : null}
            <ul className="online-versus__roster" role="listbox" aria-label="Your fighter">
              {roster.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={entry.key === selectedKey}
                    className={`online-versus__fighter${entry.key === selectedKey ? ' is-selected' : ''}`}
                    disabled={ready}
                    onClick={() => setSelectedKey(entry.key)}
                  >
                    {entry.previewUrl ? (
                      <img className="online-versus__fighter-image" src={entry.previewUrl} alt="" />
                    ) : (
                      <span className="online-versus__fighter-image online-versus__fighter-image--empty" aria-hidden="true" />
                    )}
                    <span className="online-versus__fighter-meta">
                      <strong>{entry.name}</strong>
                      <small>{entry.kind === 'arcade' ? 'Arcade' : 'Yours'} · {entry.qualityTier}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="online-versus__actions">
              <Button
                variant="primary"
                size="lg"
                disabled={!connected || !selected || Boolean(launchStatus)}
                onClick={() => void onToggleReady()}
              >
                {ready ? 'Not ready' : 'Ready'}
              </Button>
            </div>
            <p className="roster-hero__copy online-versus__hint">
              {!connected
                ? 'Keep this page open while your rival joins.'
                : ready && !peer?.ready
                  ? 'Waiting for your rival to hit Ready…'
                  : ready && peer?.ready
                    ? 'Starting…'
                    : 'Pick a fighter and hit Ready. The host starts the match once both are ready.'}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
