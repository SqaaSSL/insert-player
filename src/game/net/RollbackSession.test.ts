import { describe, expect, it } from 'vitest';
import { RollbackSession } from './RollbackSession.ts';
import { decodeInputPacket, encodeInputPacket, tickWord, tickWordInput, tickWordSkipsIntro } from './InputPackets.ts';
import { MatchSimulation, RoundPhase, type MatchSimConfig } from '../sim/MatchSimulation.ts';
import { EMPTY_INPUT, type FighterInput } from '../sim/FighterInput.ts';
import { SeededRng } from '../utils/SeededRng.ts';

const CONFIG: MatchSimConfig = {
  seed: 0x0ddba11,
  vsAI: false,
  cpuVsCpu: false,
  p1Name: 'Host',
  p2Name: 'Guest',
};

function scripted(rng: SeededRng, prev: FighterInput): FighterInput {
  if (rng.next() < 0.8) {
    return { ...prev, punch: rng.next() < 0.06, kick: rng.next() < 0.05, fireball: rng.next() < 0.01, uppercut: rng.next() < 0.01, super: false };
  }
  const roll = rng.next();
  return {
    ...EMPTY_INPUT,
    left: roll < 0.3,
    right: roll >= 0.3 && roll < 0.6,
    down: roll >= 0.6 && roll < 0.75,
    up: roll >= 0.75 && roll < 0.82,
    guard: roll >= 0.82 && roll < 0.9,
  };
}

/** Unreliable, delayed, reordering link between two sessions. */
class FakeLink {
  private queues: [Array<{ at: number; bytes: Uint8Array }>, Array<{ at: number; bytes: Uint8Array }>] = [[], []];
  frame = 0;
  dropped = 0;

  constructor(
    private readonly rng: SeededRng,
    private readonly latencyFrames: number,
    private readonly jitterFrames: number,
    private readonly lossRate: number,
  ) {}

  /** Send from `from` (0 = host) to the other side. */
  send(from: 0 | 1, bytes: Uint8Array): void {
    if (this.rng.next() < this.lossRate) {
      this.dropped++;
      return;
    }
    const delay = this.latencyFrames + this.rng.nextInt(0, this.jitterFrames);
    this.queues[from].push({ at: this.frame + delay, bytes });
  }

  /** Deliver everything due to `to`. */
  deliver(to: 0 | 1, sink: (bytes: Uint8Array) => void): void {
    const queue = this.queues[to === 0 ? 1 : 0];
    const due = queue.filter((item) => item.at <= this.frame);
    // Reorder a little: shuffle due packets.
    for (let i = due.length - 1; i > 0; i--) {
      const j = this.rng.nextInt(0, i);
      [due[i], due[j]] = [due[j], due[i]];
    }
    for (const item of due) sink(item.bytes);
    this.queues[to === 0 ? 1 : 0] = queue.filter((item) => item.at > this.frame);
  }
}

interface NetRun {
  host: RollbackSession;
  guest: RollbackSession;
  truth: MatchSimulation;
  link: FakeLink;
  frames: number;
  truthChecksums: Map<number, number>;
}

function runNetworkedMatch(options: {
  frames: number;
  latency: number;
  jitter: number;
  loss: number;
  inputDelay: number;
  seed?: number;
  skipIntroAt?: number;
}): NetRun {
  const rng = new SeededRng(options.seed ?? 1);
  const link = new FakeLink(new SeededRng(99), options.latency, options.jitter, options.loss);

  const hostSim = new MatchSimulation(CONFIG);
  const guestSim = new MatchSimulation(CONFIG);
  hostSim.start();
  guestSim.start();
  const host = new RollbackSession({ sim: hostSim, localSlot: 0, inputDelay: options.inputDelay, send: (b) => link.send(0, b) });
  const guest = new RollbackSession({ sim: guestSim, localSlot: 1, inputDelay: options.inputDelay, send: (b) => link.send(1, b) });

  // Ground truth: the inputs each side actually stamped, replayed in order.
  const hostWords = new Map<number, number>();
  const guestWords = new Map<number, number>();
  for (let t = 0; t < options.inputDelay; t++) {
    hostWords.set(t, 0);
    guestWords.set(t, 0);
  }

  let hostInput: FighterInput = EMPTY_INPUT;
  let guestInput: FighterInput = EMPTY_INPUT;
  for (let frame = 0; frame < options.frames; frame++) {
    link.frame = frame;
    link.deliver(0, (bytes) => host.receiveInputPacket(bytes));
    link.deliver(1, (bytes) => guest.receiveInputPacket(bytes));

    hostInput = scripted(rng, hostInput);
    guestInput = scripted(rng, guestInput);
    const skip = options.skipIntroAt !== undefined && frame === options.skipIntroAt;

    const hostTickBefore = host.stats().localTick;
    const guestTickBefore = guest.stats().localTick;
    host.advanceFrame(hostInput, skip);
    guest.advanceFrame(guestInput, false);
    // Record what each side stamped for its input tick (only if newly stamped).
    const hostStamp = hostTickBefore + options.inputDelay;
    if (!hostWords.has(hostStamp)) hostWords.set(hostStamp, tickWord(hostInput, skip));
    const guestStamp = guestTickBefore + options.inputDelay;
    if (!guestWords.has(guestStamp)) guestWords.set(guestStamp, tickWord(guestInput, false));

    for (const report of host.takeChecksumReports()) guest.receiveChecksumReport(report);
    for (const report of guest.takeChecksumReports()) host.receiveChecksumReport(report);
  }

  // Drain the link so both sides confirm everything they can.
  for (let extra = 0; extra < 20; extra++) {
    link.frame = options.frames + extra;
    link.deliver(0, (bytes) => host.receiveInputPacket(bytes));
    link.deliver(1, (bytes) => guest.receiveInputPacket(bytes));
    host.advanceFrame(hostInput, false);
    guest.advanceFrame(guestInput, false);
    const hs = host.stats().localTick - 1 + options.inputDelay;
    if (!hostWords.has(hs)) hostWords.set(hs, tickWord(hostInput));
    const gs = guest.stats().localTick - 1 + options.inputDelay;
    if (!guestWords.has(gs)) guestWords.set(gs, tickWord(guestInput));
    for (const report of host.takeChecksumReports()) guest.receiveChecksumReport(report);
    for (const report of guest.takeChecksumReports()) host.receiveChecksumReport(report);
  }

  const truth = new MatchSimulation(CONFIG);
  truth.start();
  const confirmed = Math.min(host.stats().confirmedTick, guest.stats().confirmedTick);
  const truthChecksums = new Map<number, number>();
  for (let tick = 0; tick < confirmed; tick++) {
    const h = hostWords.get(tick) ?? 0;
    const g = guestWords.get(tick) ?? 0;
    if (tickWordSkipsIntro(h) || tickWordSkipsIntro(g)) truth.requestIntroSkip();
    truth.step(tickWordInput(h), tickWordInput(g));
    if (truth.tick % 60 === 0) truthChecksums.set(truth.tick, truth.checksum());
  }
  return { host, guest, truth, link, frames: options.frames, truthChecksums };
}

describe('input packets', () => {
  it('round-trips words and keeps firstTick consistent when truncating', () => {
    const packet = { firstTick: 100, words: [1, 2, 3, 4, 5] };
    expect(decodeInputPacket(encodeInputPacket(packet))).toEqual(packet);
    const long = { firstTick: 0, words: Array.from({ length: 40 }, (_, i) => i) };
    const decoded = decodeInputPacket(encodeInputPacket(long))!;
    expect(decoded.words).toHaveLength(32);
    expect(decoded.firstTick).toBe(8);
    expect(decoded.words[0]).toBe(8);
    expect(decodeInputPacket(new Uint8Array([9, 0, 0, 0, 0, 0]))).toBeNull();
    const word = tickWord({ ...EMPTY_INPUT, punch: true }, true);
    expect(tickWordSkipsIntro(word)).toBe(true);
    expect(tickWordInput(word)).toEqual({ ...EMPTY_INPUT, punch: true });
  });
});

describe('RollbackSession', () => {
  it('keeps two peers on a perfect link identical, tick for tick', () => {
    const run = runNetworkedMatch({ frames: 1_200, latency: 0, jitter: 0, loss: 0, inputDelay: 2 });
    expect(run.host.isDesynced).toBe(false);
    expect(run.guest.isDesynced).toBe(false);
    expect(run.host.stats().rollbacks).toBe(0);
    expect(run.host.stats().confirmedTick).toBeGreaterThan(1_100);
    expect(run.host.sim.checksum()).toBe(run.guest.sim.checksum());
  });

  it('survives latency, jitter and 10% packet loss with rollbacks and converges to the ground truth', () => {
    const run = runNetworkedMatch({ frames: 2_400, latency: 4, jitter: 3, loss: 0.1, inputDelay: 2, skipIntroAt: 40 });
    const hs = run.host.stats();
    const gs = run.guest.stats();
    expect(run.host.isDesynced).toBe(false);
    expect(run.guest.isDesynced).toBe(false);
    expect(hs.rollbacks + gs.rollbacks).toBeGreaterThan(0);
    expect(run.link.dropped).toBeGreaterThan(0);
    // 4–7 frames of latency with a 2-frame input delay forces stalls (the
    // 8-tick prediction cap), so throughput is below 1:1 — by design.
    expect(hs.confirmedTick).toBeGreaterThan(1_500);
    expect(hs.stalls).toBeGreaterThan(0);
    expect(run.host.sim.phase).not.toBe(RoundPhase.INTRO);
    // Fight actually happened.
    expect(run.host.sim.p1.health + run.host.sim.p2.health).toBeLessThan(2_000);

    // Independent replay of the confirmed input log: every interval digest
    // both peers retained must equal the truth's at that tick.
    const confirmed = Math.min(hs.confirmedTick, gs.confirmedTick);
    expect(run.truth.tick).toBe(confirmed);
    let compared = 0;
    for (const [tick, digest] of run.truthChecksums) {
      const h = run.host.localChecksumAt(tick);
      const g = run.guest.localChecksumAt(tick);
      if (h !== undefined) { expect(h).toBe(digest); compared++; }
      if (g !== undefined) { expect(g).toBe(digest); compared++; }
    }
    expect(compared).toBeGreaterThan(4);
  });

  it('stalls instead of running away when the peer goes silent', () => {
    const sim = new MatchSimulation(CONFIG);
    sim.start();
    const sent: Uint8Array[] = [];
    const session = new RollbackSession({ sim, localSlot: 0, inputDelay: 2, maxRollback: 8, send: (b) => sent.push(b) });
    let stalls = 0;
    for (let i = 0; i < 40; i++) {
      if (session.advanceFrame(EMPTY_INPUT).stalled) stalls++;
    }
    // 2 pre-agreed empty ticks + 8 predictions, then everything stalls.
    expect(session.stats().localTick).toBe(10);
    expect(stalls).toBe(30);
    expect(sent.length).toBe(40);
  });

  it('detects a genuine divergence through the checksum exchange', () => {
    const run = runNetworkedMatch({ frames: 300, latency: 1, jitter: 0, loss: 0, inputDelay: 2 });
    expect(run.host.isDesynced).toBe(false);
    // Forge a wrong digest for a confirmed interval tick.
    const confirmed = run.host.stats().confirmedTick;
    const tick = Math.floor(confirmed / 60) * 60;
    run.host.receiveChecksumReport({ tick, checksum: 0xdeadbeef });
    expect(run.host.isDesynced).toBe(true);
    expect(run.host.stats().desyncTick).toBe(tick);
    expect(run.host.advanceFrame(EMPTY_INPUT).stalled).toBe(true);
  });
});
