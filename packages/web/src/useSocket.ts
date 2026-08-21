import { useEffect, useRef } from 'react';
import type { ClientFrame, ServerFrame } from '@arena/shared';
import { useArena } from './store';

const URL = import.meta.env.VITE_ARENA_WS ?? `ws://${location.hostname}:8787`;

/**
 * The feed.
 *
 * Reconnects on its own, because the one thing worse than a demo that fails is
 * a demo that fails and stays failed after you restart the server.
 */
export function useSocket() {
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(URL);
      socket.current = ws;

      ws.onopen = () => useArena.getState().setConnected(true);
      ws.onmessage = (message) => {
        try {
          useArena.getState().ingest(JSON.parse(message.data as string) as ServerFrame);
        } catch {
          // A malformed frame is not worth tearing the view down for.
        }
      };
      ws.onclose = () => {
        useArena.getState().setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1200);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    const onLoadRun = (event: Event) => {
      send({ kind: 'load-run', runId: (event as CustomEvent<string>).detail });
    };
    window.addEventListener('arena:load-run', onLoadRun);

    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.removeEventListener('arena:load-run', onLoadRun);
      socket.current?.close();
    };
  }, []);

  const send = (frame: ClientFrame) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  return { send };
}
