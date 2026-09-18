/**
 * WebSocket lifecycle for interactive execution.
 *
 * One socket is kept open for the session and reused across runs, so a run
 * starts without a handshake. It reconnects with backoff when the gateway
 * restarts, and surfaces connection state so the UI can say what is happening
 * instead of silently doing nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { executionSocketUrl } from '../lib/api';
import type { ExecutionLimits, RunMeta, ServerFrame, VirtualFile } from '../lib/types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface RunOutcome {
  code: number;
  durationMs: number;
  truncated: boolean;
  aborted: boolean;
  meta: RunMeta | null;
}

interface Handlers {
  /** Called for every stdout/stderr chunk, in arrival order. */
  onOutput: (stream: 'stdout' | 'stderr', content: string) => void;
  onAccepted?: (label: string) => void;
  onFinished: (outcome: RunOutcome) => void;
  onError: (message: string) => void;
  onReady?: (isolationTier: string, backend: string) => void;
}

export interface RunRequest {
  language: string;
  files: VirtualFile[];
  entry?: string;
  stdin?: string;
  /** Passed to the program as argv, never through a shell. */
  args?: string[];
  limits?: Partial<ExecutionLimits>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function useExecutionSocket(handlers: Handlers) {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [isRunning, setIsRunning] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  // Handlers are re-created on every render by callers; keeping them in a ref
  // means the socket is not torn down and rebuilt each time.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const connect = useCallback(() => {
    if (disposedRef.current) return;

    setConnection('connecting');
    const socket = new WebSocket(executionSocketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      attemptsRef.current = 0;
      setConnection('open');
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      // A socket that has been superseded may still deliver frames it had in
      // flight when it was closed. React's StrictMode makes that routine in
      // development, where every effect is mounted twice. Frames from an old
      // socket would double every console line, so they are dropped here.
      if (socketRef.current !== socket) return;

      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        handlersRef.current.onError('Received a malformed frame from the gateway.');
        return;
      }

      switch (frame.type) {
        case 'ready':
          handlersRef.current.onReady?.(frame.isolation_tier, frame.backend);
          break;
        case 'accepted':
          handlersRef.current.onAccepted?.(frame.label);
          break;
        case 'stdout':
        case 'stderr':
          handlersRef.current.onOutput(frame.type, frame.content);
          break;
        case 'exit':
          setIsRunning(false);
          handlersRef.current.onFinished({
            code: frame.code,
            durationMs: frame.execution_time,
            truncated: frame.truncated ?? false,
            aborted: frame.aborted ?? false,
            meta: frame.meta ?? null,
          });
          break;
        case 'error':
          setIsRunning(false);
          handlersRef.current.onError(frame.message);
          break;
        case 'aborting':
        case 'idle':
          break;
      }
    };

    socket.onclose = () => {
      // Only the live socket drives state and reconnection.
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setConnection('closed');
      setIsRunning(false);
      if (disposedRef.current) return;

      // Exponential backoff, capped, so a gateway restart reconnects quickly
      // while a gateway that is down does not spin.
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptsRef.current, RECONNECT_MAX_MS);
      attemptsRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    socket.onerror = () => {
      // onclose always follows, and it owns the reconnect. Reporting here too
      // would double up the message the user sees.
    };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect]);

  const run = useCallback((request: RunRequest): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      handlersRef.current.onError('Not connected to the gateway. Reconnecting…');
      return false;
    }

    setIsRunning(true);
    socket.send(
      JSON.stringify({
        action: 'execute',
        language: request.language,
        entry: request.entry,
        stdin: request.stdin ?? '',
        args: request.args ?? [],
        files: request.files.map((file) => ({ name: file.name, content: file.content })),
        ...(request.limits ? { limits: request.limits } : {}),
      }),
    );
    return true;
  }, []);

  const abort = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'abort' }));
    }
  }, []);

  return { connection, isRunning, run, abort };
}
