import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthStatus } from '../authState.ts';
import { Button } from '../components/Button.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';
import {
  allocateVersusMatch,
  createVersusRoom,
  createVersusInvitation,
  declareVersusFighter,
  fetchVersusIceServers,
  fetchVersusOpponentFighter,
  joinVersusRoom,
  joinVersusInvitation,
  versusRoomRequestContext,
  versusFighterPhotoHash,
  VersusRoomError,
  type VersusIceServers,
  type VersusInvitationInfo,
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
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import {
  clearPendingVersusInvite,
  getOrCreateVersusGuestId,
  normalizeVersusRoomCode,
  readPendingVersusInvite,
  sanitizeVersusRoomCodeInput,
  storePendingVersusInvite,
  versusInviterNameFromSearch,
  versusInvitedFighterNameFromSearch,
  versusInviteTokenFromSearch,
} from '../shared/versusInvite.ts';

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

type CopyFeedback = {
  target: 'code' | 'invite';
  status: 'copied' | 'failed';
};

type InvitationPhase =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'ready'; invitation: VersusInvitationInfo }
  | { kind: 'error'; message: string };

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

interface FighterPickerProps {
  roster: RosterFighterEntry[];
  status: 'loading' | 'ready' | 'error';
  selectedKey: string | null;
  disabled: boolean;
  guestMode?: boolean;
  onSelect: (key: string) => void;
}

function FighterPreview({
  entry,
  className,
}: {
  entry: RosterFighterEntry | null;
  className: string;
}) {
  const localUrl = useObjectUrl(entry?.previewBlob ?? null);
  const previewUrl = localUrl ?? entry?.previewUrl ?? null;

  return previewUrl ? (
    <img className={className} src={previewUrl} alt="" />
  ) : (
    <span className={`${className} online-versus__fighter-image--empty`} aria-hidden="true" />
  );
}

function FighterPicker({ roster, status, selectedKey, disabled, guestMode = false, onSelect }: FighterPickerProps) {
  return (
    <>
      {status === 'loading' ? (
        <StatusMessage severity="progress">
          {guestMode ? 'Loading Arcade fighters…' : 'Loading your roster…'}
        </StatusMessage>
      ) : null}
      {status === 'error' ? (
        <StatusMessage severity="error">
          {guestMode ? 'Could not load the Arcade fighters.' : 'Could not load your roster.'}
        </StatusMessage>
      ) : null}
      {status === 'ready' && roster.length === 0 ? (
        <StatusMessage severity="warn">
          {guestMode
            ? 'No Arcade fighters are available right now.'
            : 'No shareable fighters yet. Online play needs a fighter synced to your account or an official Arcade fighter.'}
        </StatusMessage>
      ) : null}
      <ul className="online-versus__roster" role="listbox" aria-label="Choose your fighter">
        {roster.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              role="option"
              aria-selected={entry.key === selectedKey}
              className={`online-versus__fighter${entry.key === selectedKey ? ' is-selected' : ''}`}
              disabled={disabled}
              onClick={() => onSelect(entry.key)}
            >
              <FighterPreview entry={entry} className="online-versus__fighter-image" />
              <span className="online-versus__fighter-meta">
                <strong>{entry.name}</strong>
                <small>{entry.kind === 'arcade' ? 'Arcade' : 'Yours'} · {entry.qualityTier}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ConnectionStats({
  transportState,
  ice,
  peer,
}: {
  transportState: PeerTransportState | null;
  ice: VersusIceServers;
  peer: LobbyPeerState | null;
}) {
  const quality = transportState ? rttQuality(transportState.rttMs) : 'unknown';
  return (
    <dl className="online-versus__stats">
      <div>
        <dt>Status</dt>
        <dd>{transportState ? phaseLabel(transportState) : 'Starting…'}</dd>
      </div>
      <div>
        <dt>Path</dt>
        <dd>{transportState?.path === 'p2p' ? 'Direct' : transportState?.path === 'relay' ? 'Relay' : '—'}</dd>
      </div>
      <div>
        <dt>Ping</dt>
        <dd className={`online-versus__rtt is-${quality}`}>{rttLabel(transportState?.rttMs ?? null)}</dd>
      </div>
      <div>
        <dt>TURN</dt>
        <dd>{ice.turn === 'configured' ? 'Available' : 'STUN only'}</dd>
      </div>
      <div>
        <dt>Rival</dt>
        <dd>
          {!transportState?.peerPresent
            ? 'Not here yet'
            : peer
              ? `${peer.fighterName} · ${peer.ready ? 'READY' : 'choosing'}`
              : 'Choosing'}
        </dd>
      </div>
    </dl>
  );
}

export function OnlineVersusPage({ authStatus, onBack, onStartFight }: OnlineVersusPageProps) {
  const invitationFromUrl = typeof window === 'undefined'
    ? null
    : versusInviteTokenFromSearch(window.location.search);
  const inviterNameFromUrl = typeof window === 'undefined'
    ? null
    : versusInviterNameFromSearch(window.location.search);
  const invitedFighterNameFromUrl = typeof window === 'undefined'
    ? null
    : versusInvitedFighterNameFromSearch(window.location.search);
  const [incomingInvitation] = useState(() => {
    const pending = readPendingVersusInvite();
    const token = invitationFromUrl ?? pending?.token ?? null;
    return {
      token,
      inviterName: inviterNameFromUrl ?? (pending?.token === token ? pending.inviterName ?? null : null),
      fighterName: invitedFighterNameFromUrl,
    };
  });
  const invitedToken = incomingInvitation.token;
  const inviterName = incomingInvitation.inviterName;
  const invitedFighterName = incomingInvitation.fighterName;
  const [invitationGuestId] = useState(() => (
    invitedToken ? getOrCreateVersusGuestId(invitedToken) : null
  ));
  const [room, setRoom] = useState<RoomPhase>({ kind: 'idle' });
  const [codeInput, setCodeInput] = useState('');
  const [transportState, setTransportState] = useState<PeerTransportState | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const [invitationPhase, setInvitationPhase] = useState<InvitationPhase>({ kind: 'idle' });
  const [roster, setRoster] = useState<RosterFighterEntry[]>([]);
  const [rosterStatus, setRosterStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [peer, setPeer] = useState<LobbyPeerState | null>(null);
  const [launchStatus, setLaunchStatus] = useState<string | null>(null);
  const transportRef = useRef<PeerTransport | null>(null);
  const handedOffRef = useRef(false);
  const launchingRef = useRef(false);
  const inviteJoinAttemptedRef = useRef(false);
  const invitationRequestKeyRef = useRef<string | null>(null);
  const localLobbyRef = useRef<LobbyPeerState>({ fighterId: null, fighterName: 'Fighter', ready: false });

  const signedIn = authStatus === 'signed-in';
  const guestInvite = Boolean(
    invitedToken && (authStatus === 'signed-out' || authStatus === 'local'),
  );
  const selected = useMemo(() => roster.find((entry) => entry.key === selectedKey) ?? null, [roster, selectedKey]);
  const joinCode = useMemo(() => normalizeVersusRoomCode(codeInput), [codeInput]);

  useEffect(() => {
    if (invitationFromUrl) storePendingVersusInvite(invitationFromUrl, inviterNameFromUrl);
  }, [invitationFromUrl, inviterNameFromUrl]);

  const prepareInvitation = useCallback(async (
    roomCode: string,
    fighterId: string,
  ): Promise<VersusInvitationInfo | null> => {
    const requestKey = `${roomCode}:${fighterId}`;
    invitationRequestKeyRef.current = requestKey;
    setInvitationPhase({ kind: 'creating' });
    setCopyFeedback((current) => current?.target === 'invite' ? null : current);
    try {
      const invitation = await createVersusInvitation(roomCode, fighterId);
      if (invitationRequestKeyRef.current === requestKey) {
        setInvitationPhase({ kind: 'ready', invitation });
      }
      return invitation;
    } catch (err) {
      if (invitationRequestKeyRef.current === requestKey) {
        setInvitationPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Could not create invitation link',
        });
      }
      return null;
    }
  }, []);

  useEffect(() => {
    setInvitationPhase((current) => {
      if (current.kind === 'idle' || current.kind === 'creating') return current;
      if (current.kind === 'ready' && current.invitation.fighter.id === selected?.cloudFighterId) return current;
      invitationRequestKeyRef.current = null;
      return { kind: 'idle' };
    });
    setCopyFeedback((current) => current?.target === 'invite' ? null : current);
  }, [selected?.cloudFighterId]);

  const hostRoomCode = room.kind === 'seated' && room.seat.seat === 'host'
    ? room.seat.roomCode
    : null;

  // Keep the challenge link aligned with the host's fighter if they change
  // their selection while waiting for a rival.
  useEffect(() => {
    const fighterId = selected?.cloudFighterId;
    if (!hostRoomCode || !fighterId) return;
    const requestKey = `${hostRoomCode}:${fighterId}`;
    if (invitationRequestKeyRef.current === requestKey) return;
    const timeout = window.setTimeout(() => {
      void prepareInvitation(hostRoomCode, fighterId);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [hostRoomCode, prepareInvitation, selected?.cloudFighterId]);

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
        const availableSections = guestInvite
          ? sections.official
          : [...sections.owned, ...sections.official];
        const entries = availableSections.filter(isShareableEntry);
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
  }, [guestInvite, signedIn]);

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
    const context = versusRoomRequestContext(seat);
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
        allocateNextMatchSerial: seat.seat === 'host'
          ? () => allocateVersusMatch(seat.roomCode, versusRoomRequestContext(seat))
          : undefined,
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
        const matchSerial = await allocateVersusMatch(seat.roomCode, versusRoomRequestContext(seat));
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
      const seat = await action();
      const ice = await fetchVersusIceServers(versusRoomRequestContext(seat));
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

  const onCreateChallenge = () => {
    const fighterId = selected?.cloudFighterId;
    if (!fighterId) return;
    clearPendingVersusInvite();
    setCopyFeedback(null);
    setRoom({ kind: 'busy', label: `Creating ${selected.name}'s challenge…` });
    void (async () => {
      try {
        const context = captureApiRequestContext();
        const seat = await createVersusRoom(context);
        const ice = await fetchVersusIceServers(versusRoomRequestContext(seat, context));
        setRoom({ kind: 'seated', seat, ice });
        openTransport(seat, ice);
        void prepareInvitation(seat.roomCode, fighterId);
      } catch (err) {
        const message = err instanceof VersusRoomError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not create challenge';
        setInvitationPhase({ kind: 'idle' });
        setRoom({ kind: 'error', message });
      }
    })();
  };

  const onJoin = () => {
    if (!joinCode) return;
    setCodeInput(joinCode);
    clearPendingVersusInvite();
    void runRoomAction('Joining room…', () => joinVersusRoom(joinCode));
  };

  const acceptInvitation = useCallback(() => {
    if (!invitedToken || authStatus === 'loading') return;
    inviteJoinAttemptedRef.current = true;
    clearPendingVersusInvite();
    void runRoomAction(
      'Opening the challenge…',
      () => joinVersusInvitation(invitedToken, signedIn ? null : invitationGuestId),
    );
  }, [authStatus, invitationGuestId, invitedToken, runRoomAction, signedIn]);

  useEffect(() => {
    if (authStatus === 'loading' || !invitedToken || room.kind !== 'idle' || inviteJoinAttemptedRef.current) return;
    acceptInvitation();
  }, [acceptInvitation, authStatus, invitedToken, room.kind]);

  const onLeave = () => {
    teardown();
    invitationRequestKeyRef.current = null;
    setRoom({ kind: 'idle' });
    setCopyFeedback(null);
    setInvitationPhase({ kind: 'idle' });
    setLaunchStatus(null);
  };

  const onToggleReady = async () => {
    if (room.kind !== 'seated') return;
    const next = !ready;
    const fighterId = selected?.cloudFighterId ?? null;
    try {
      if (next) {
        setLaunchStatus('Sharing your fighter with the room…');
        await declareVersusFighter(
          room.seat.roomCode,
          fighterId,
          versusRoomRequestContext(room.seat),
        );
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

  const copyRoomValue = async (target: CopyFeedback['target'], value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback({ target, status: 'copied' });
    } catch {
      setCopyFeedback({ target, status: 'failed' });
    }
  };

  const onCopyCode = async () => {
    if (room.kind !== 'seated') return;
    await copyRoomValue('code', room.seat.roomCode);
  };

  const onCopyInvite = async () => {
    if (room.kind !== 'seated' || room.seat.seat !== 'host' || !selected?.cloudFighterId) return;
    if (invitationPhase.kind === 'ready') {
      const expiresAt = Date.parse(invitationPhase.invitation.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        await copyRoomValue('invite', invitationPhase.invitation.url);
        return;
      }
    }
    const invitation = await prepareInvitation(room.seat.roomCode, selected.cloudFighterId);
    if (invitation) {
      await copyRoomValue('invite', invitation.url);
    }
  };

  const connected = transportState?.phase === 'connected';
  const inviteOpponent = inviterName ?? 'Your friend';
  const copyFeedbackText = copyFeedback?.status === 'copied'
    ? copyFeedback.target === 'invite'
      ? 'Invite link copied. Send it to your rival.'
      : 'Room code copied.'
    : copyFeedback?.target === 'invite'
      ? 'Copy failed. Select the invitation link and copy it manually.'
      : copyFeedback
        ? 'Copy failed. Select the room code and copy it manually.'
        : '';

  return (
    <div className="roster-app online-versus">
      <header className={`roster-hero${invitedToken ? ' online-versus__invite-hero' : ''}`}>
        <div>
          {invitedToken ? <p className="online-versus__eyebrow">Private Online Versus</p> : null}
          <h1>{invitedToken ? 'Challenge incoming' : 'Online Versus'}</h1>
          <p className="roster-hero__copy">
            {invitedToken
              ? `${inviteOpponent}${invitedFighterName ? ` is bringing ${invitedFighterName}` : ' is waiting for you'}. Pick a fighter and enter the match.`
              : 'Choose your fighter, create a private challenge, then send the link. Room codes remain as a backup.'}
          </p>
          {guestInvite ? (
            <div className="online-versus__guest-benefits" aria-label="Guest mode benefits">
              <span>Guest mode</span>
              <span>No account needed</span>
              <span>Play now</span>
            </div>
          ) : null}
        </div>
        <div className="roster-hero__actions">
          <Button variant="ghost" onClick={onBack}>Back</Button>
        </div>
      </header>

      {!signedIn && !invitedToken ? (
        <StatusMessage severity="warn">
          Sign in to create a challenge or join with a room code. Invitation links can be played as a guest.
        </StatusMessage>
      ) : null}

      {room.kind === 'error' && !invitedToken ? <StatusMessage severity="error">{room.message}</StatusMessage> : null}
      {room.kind === 'busy' && !invitedToken ? <StatusMessage severity="progress">{room.label}</StatusMessage> : null}
      {launchStatus ? <StatusMessage severity="progress">{launchStatus}</StatusMessage> : null}

      {room.kind !== 'seated' ? (
        invitedToken ? (
          <section className="gallery-panel online-versus__arrival" aria-live="polite">
            <div className="online-versus__arrival-seat" aria-hidden="true">
              <span>Player</span>
              <strong>P2</strong>
              <small>Seat open</small>
            </div>
            <div className="online-versus__arrival-copy">
              <p className="online-versus__eyebrow">
                {room.kind === 'busy' ? 'Reserving your seat' : room.kind === 'error' ? 'Could not enter' : 'Invitation ready'}
              </p>
              <h2>
                {room.kind === 'busy'
                  ? 'Opening the arena…'
                  : room.kind === 'error'
                    ? 'The challenge did not open'
                    : `Fight ${inviteOpponent}`}
              </h2>
              <p className="roster-hero__copy">
                {room.kind === 'error'
                  ? room.message
                  : guestInvite
                    ? 'You are joining as Player 2. Choose any Arcade fighter and play without creating an account.'
                    : 'Your Player 2 seat is ready. Choose your fighter as soon as the room opens.'}
              </p>
              {room.kind !== 'busy' ? (
                <Button variant="primary" size="lg" onClick={acceptInvitation}>
                  {room.kind === 'error' ? 'Try challenge again' : 'Enter challenge'}
                </Button>
              ) : (
                <div className="online-versus__arrival-progress" role="status">Connecting Player 2…</div>
              )}
            </div>
          </section>
        ) : (
          <div className="online-versus__setup">
          <section className="gallery-panel online-versus__panel online-versus__builder">
            <div className="online-versus__section-head">
              <div>
                <p className="online-versus__eyebrow">Create a private challenge</p>
                <h2>1. Choose your fighter</h2>
                <p className="roster-hero__copy">
                  This fighter will lead the invitation preview and wait for your rival in the room.
                </p>
              </div>
              <span className="online-versus__player-badge">Player 1</span>
            </div>

            <FighterPicker
              roster={roster}
              status={rosterStatus}
              selectedKey={selectedKey}
              disabled={!signedIn || room.kind === 'busy'}
              onSelect={setSelectedKey}
            />

            <div className="online-versus__challenge-action">
              <div className="online-versus__selection">
                <FighterPreview entry={selected} className="online-versus__selection-image" />
                <div className="online-versus__selection-copy">
                  <span>Selected fighter</span>
                  <strong>{selected?.name ?? 'Choose a fighter'}</strong>
                  <p>
                    {selected
                      ? `${selected.name} will appear on the social card and in your challenge link.`
                      : 'Select one fighter to build your invitation.'}
                  </p>
                </div>
              </div>
              <Button
                variant="primary"
                size="lg"
                disabled={!signedIn || room.kind === 'busy' || !selected?.cloudFighterId}
                onClick={onCreateChallenge}
              >
                {room.kind === 'busy' ? 'Creating challenge…' : '2. Create challenge'}
              </Button>
            </div>
          </section>

          <aside className="gallery-panel online-versus__panel online-versus__join-panel">
            <p className="online-versus__eyebrow">Joining a friend?</p>
            <h2>Open their invite link</h2>
            <p className="roster-hero__copy">
              The link seats you as Player 2. Guests can choose an Arcade fighter and play immediately—no account required.
            </p>
            <div className="online-versus__join-divider"><span>Room code backup</span></div>
            <label className="online-versus__field">
              <span>Room code</span>
              <input
                className="online-versus__code-input"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={6}
                placeholder="ABC234"
                value={codeInput}
                onChange={(event) => setCodeInput(sanitizeVersusRoomCodeInput(event.target.value))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onJoin();
                }}
              />
            </label>
            <Button variant="secondary" size="lg" disabled={!signedIn || room.kind === 'busy' || !joinCode} onClick={onJoin}>
              Join with code
            </Button>
          </aside>
          </div>
        )
      ) : (
        <div className="online-versus__lobby">
          <section className="gallery-panel online-versus__panel online-versus__room">
            <div className="online-versus__room-header">
              <div>
                <p className="online-versus__eyebrow">
                  {room.seat.seat === 'host'
                    ? 'Challenge created · Player 1'
                    : `${inviteOpponent}'s challenge · Player 2${guestInvite ? ' · Guest' : ''}`}
                </p>
                <h2>{room.seat.seat === 'host' ? 'Send the challenge' : 'Choose your fighter'}</h2>
                <p className="roster-hero__copy">
                  {room.seat.seat === 'host'
                    ? 'Your room is open. Share the invitation link, then keep this page open while your rival joins.'
                    : guestInvite
                      ? 'You are in. No account needed: choose an Arcade fighter, then hit Ready.'
                      : 'You are in. Pick the fighter you want to bring, then get ready.'}
                </p>
              </div>
              <Button variant="ghost" onClick={onLeave}>Leave room</Button>
            </div>

            {room.seat.seat === 'host' ? (
              <div className="online-versus__share-stage">
                <div className="online-versus__share-head">
                  <div>
                    <p id="online-versus-invite-label" className="online-versus__eyebrow">Your invitation</p>
                    <h3>{selected ? `${selected.name} awaits a challenger` : 'Preparing your fighter'}</h3>
                  </div>
                  <span className={`online-versus__share-state is-${invitationPhase.kind}`}>
                    {invitationPhase.kind === 'ready' ? 'Ready to send' : invitationPhase.kind === 'error' ? 'Needs retry' : 'Building link'}
                  </span>
                </div>
                {invitationPhase.kind === 'ready' ? (
                  <div className="online-versus__invite-row">
                    <input
                      id="online-versus-invite-link"
                      className="online-versus__invite-input"
                      type="url"
                      readOnly
                      value={invitationPhase.invitation.url}
                      onFocus={(event) => event.currentTarget.select()}
                      aria-labelledby="online-versus-invite-label"
                      aria-describedby="online-versus-invite-help"
                    />
                    <Button variant="primary" size="lg" onClick={() => void onCopyInvite()}>
                      {copyFeedback?.target === 'invite' && copyFeedback.status === 'copied' ? 'Link copied' : 'Copy invite link'}
                    </Button>
                  </div>
                ) : invitationPhase.kind === 'error' ? (
                  <Button variant="primary" size="lg" disabled={!selected?.cloudFighterId} onClick={() => void onCopyInvite()}>
                    Retry invite link
                  </Button>
                ) : (
                  <div className="online-versus__invite-progress" role="status" aria-live="polite">
                    Building the fighter card and invitation link…
                  </div>
                )}
                <p id="online-versus-invite-help" className="online-versus__invite-help">
                  {invitationPhase.kind === 'error'
                    ? invitationPhase.message
                    : selected && invitationPhase.kind === 'ready'
                      ? `It says ${invitationPhase.invitation.inviter.displayName} invited them and features ${selected.name}. They can open it and play as a guest.`
                      : selected
                        ? `The social preview will identify you and feature ${selected.name}.`
                        : 'Preparing your character-aware invitation.'}
                </p>
              </div>
            ) : null}

            <p
              className={`online-versus__copy-feedback${copyFeedback?.status === 'failed' ? ' is-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {copyFeedbackText}
            </p>

            {room.seat.seat === 'host' ? (
              <>
                <details className="online-versus__code-fallback">
                  <summary>Use room code instead</summary>
                  <p className="online-versus__invite-help">
                    If the link cannot be opened, your rival can enter this six-character code manually.
                  </p>
                  <div className="online-versus__code-row">
                    <code className="online-versus__code" aria-label="Room code">{room.seat.roomCode}</code>
                    <Button onClick={() => void onCopyCode()}>
                      {copyFeedback?.target === 'code' && copyFeedback.status === 'copied' ? 'Code copied' : 'Copy code'}
                    </Button>
                  </div>
                </details>
                <ConnectionStats transportState={transportState} ice={room.ice} peer={peer} />
              </>
            ) : null}
          </section>

          <section className="gallery-panel online-versus__panel online-versus__fighter-panel">
            <div className="online-versus__fighter-panel-head">
              <h3>Your fighter</h3>
              {guestInvite ? <span className="online-versus__guest-badge">Guest · Player 2</span> : null}
            </div>
            {guestInvite ? (
              <p className="online-versus__guest-note">
                Pick any Arcade fighter. You can make your own fighter after the match if you decide to create an account.
              </p>
            ) : null}
            <FighterPicker
              roster={roster}
              status={rosterStatus}
              selectedKey={selectedKey}
              disabled={ready || invitationPhase.kind === 'creating'}
              guestMode={guestInvite}
              onSelect={setSelectedKey}
            />
            <div className="online-versus__actions">
              <Button
                variant="primary"
                size="lg"
                disabled={!connected || !selected || Boolean(launchStatus)}
                onClick={() => void onToggleReady()}
              >
                {ready ? 'Not ready' : guestInvite ? 'Ready to fight' : 'Ready'}
              </Button>
            </div>
            <p className="roster-hero__copy online-versus__hint">
              {!connected
                ? guestInvite ? `Connecting to ${inviteOpponent}…` : 'Keep this page open while your rival joins.'
                : ready && !peer?.ready
                  ? 'Waiting for your rival to hit Ready…'
                  : ready && peer?.ready
                    ? 'Starting…'
                    : 'Pick a fighter and hit Ready. The host starts the match once both are ready.'}
            </p>
            {room.seat.seat === 'guest' ? (
              <details className="online-versus__connection-details">
                <summary>Connection details</summary>
                <ConnectionStats transportState={transportState} ice={room.ice} peer={peer} />
              </details>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
