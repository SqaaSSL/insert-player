import type { Server } from 'node:http';

interface ShutdownOptions {
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
  waitForRequests?: () => Promise<unknown>;
  exit?: (code: number) => void;
}

/** PID 1 must explicitly exit after draining; a default re-raised signal can be ignored. */
export function installGracefulShutdown(server: Pick<Server, 'close'>, {
  signals = process,
  waitForRequests = async () => {},
  exit = code => process.exit(code),
}: ShutdownOptions = {}): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Node 22 closes idle keep-alive connections and stops accepting new ones.
    // No application deadline: Cloudflare owns the outer shutdown grace period.
    server.close(() => {
      // A disconnected HTTP client does not mean its provider operation finished.
      void waitForRequests().then(() => exit(0), () => exit(1));
    });
  };
  // Keep both listeners installed while draining, including repeated signals.
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);
  return () => {
    signals.off('SIGTERM', stop);
    signals.off('SIGINT', stop);
  };
}
