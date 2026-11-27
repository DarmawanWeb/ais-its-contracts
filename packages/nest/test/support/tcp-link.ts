import { createServer, type Server, type Socket, connect } from 'node:net';

/**
 * A TCP relay between the test's clients and a server (e.g. NATS) that can
 * stop moving bytes without closing anything, like a network partition or a
 * paused server container: `hold()` keeps every byte in both directions,
 * `release()` delivers what was held and resumes. Connections stay open
 * throughout (TCP would retransmit across a short partition).
 */
export interface TcpLink {
  /** `nats://127.0.0.1:<port>` (or another scheme) of the relay. */
  readonly url: string;
  /** Stops forwarding in both directions; bytes are kept. */
  hold(): void;
  /** Forwards what was held and resumes forwarding. */
  release(): void;
  /** Closes the relay and every relayed connection. */
  close(): Promise<void>;
}

interface Pipe {
  readonly from: Socket;
  readonly to: Socket;
  readonly held: Buffer[];
}

/** Starts a relay to `target` (`host:port`, or a `scheme://host:port` URL). */
export async function startTcpLink(target: string): Promise<TcpLink> {
  const parsed = new URL(target.includes('://') ? target : `tcp://${target}`);
  const scheme = target.includes('://') ? parsed.protocol : 'nats:';
  const pipes: Pipe[] = [];
  const sockets = new Set<Socket>();
  let holding = false;

  const relay = (pipe: Pipe): void => {
    pipe.from.on('data', (chunk: Buffer) => {
      if (holding) pipe.held.push(chunk);
      else pipe.to.write(chunk);
    });
  };

  const server: Server = createServer((client) => {
    const upstream = connect(Number(parsed.port), parsed.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    const out: Pipe = { from: client, to: upstream, held: [] };
    const back: Pipe = { from: upstream, to: client, held: [] };
    pipes.push(out, back);
    relay(out);
    relay(back);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('relay has no port');

  return {
    url: `${scheme}//127.0.0.1:${address.port}`,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const pipe of pipes) {
        for (const chunk of pipe.held.splice(0))
          if (!pipe.to.destroyed) pipe.to.write(chunk);
      }
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
