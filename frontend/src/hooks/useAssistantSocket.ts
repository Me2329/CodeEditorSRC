/**
 * WebSocket lifecycle for the assistant.
 *
 * Separate from the execution socket on purpose: a long model turn must not
 * block a run, and a dropped assistant connection must not disturb the
 * terminal. Reconnects with backoff, like the execution socket.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AssistantFrame, AssistantRoute, Effort, WorkspaceContext } from '../lib/types';

export type AssistantState = 'connecting' | 'open' | 'closed';

export interface AssistantStatus {
  /** Whether the daemon answered at all. */
  available: boolean;
  /** The model configured for remote requests. */
  model: string;
  /** Whether a Claude credential was resolved. */
  remoteAvailable: boolean;
  reason: string;
}

interface Handlers {
  /** Which engine took the request, before any content arrives. */
  onRouted: (engine: 'local' | 'model', model: string) => void;
  onThinking: (text: string) => void;
  onDelta: (text: string) => void;
  onDone: (elapsedMs: number, costCents: number | null) => void;
  onError: (message: string) => void;
  onStatus: (status: AssistantStatus) => void;
}

export interface AskRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  workspace: WorkspaceContext;
  route: AssistantRoute;
  effort: Effort;
}

const RECONNECT_BASE_MS = 750;
const RECONNECT_MAX_MS = 15_000;

function socketUrl(): string {
  const base = import.meta.env.VITE_API_BASE ?? '';
  if (base) return `${base.replace(/^http/, 'ws')}/api/v1/ws/assistant`;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/v1/ws/assistant`;
}

export function useAssistantSocket(handlers: Handlers) {
  const [connection, setConnection] = useState<AssistantState>('connecting');
  const [isStreaming, setIsStreaming] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const connect = useCallback(() => {
    if (disposedRef.current) return;

    setConnection('connecting');
    const socket = new WebSocket(socketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      attemptsRef.current = 0;
      setConnection('open');
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      // A superseded socket can still deliver queued frames; dropping them
      // keeps a stale stream from writing into the current conversation.
      if (socketRef.current !== socket) return;

      let frame: AssistantFrame;
      try {
        frame = JSON.parse(event.data) as AssistantFrame;
      } catch {
        handlersRef.current.onError('The assistant sent a malformed frame.');
        return;
      }

      switch (frame.type) {
        case 'ready':
          handlersRef.current.onStatus({
            available: frame.available,
            model: frame.model,
            remoteAvailable: frame.remote_available,
            reason: frame.reason,
          });
          break;
        case 'routed':
          handlersRef.current.onRouted(frame.engine, frame.model);
          break;
        case 'thinking':
          handlersRef.current.onThinking(frame.text);
          break;
        case 'delta':
          handlersRef.current.onDelta(frame.text);
          break;
        case 'done':
          setIsStreaming(false);
          handlersRef.current.onDone(frame.elapsed_ms, frame.usage?.cost_cents ?? null);
          break;
        case 'error':
          setIsStreaming(false);
          handlersRef.current.onError(frame.message);
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setConnection('closed');
      setIsStreaming(false);
      if (disposedRef.current) return;

      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptsRef.current, RECONNECT_MAX_MS);
      attemptsRef.current += 1;
      timerRef.current = window.setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect]);

  const ask = useCallback((request: AskRequest): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      handlersRef.current.onError('Not connected to the assistant. Reconnecting…');
      return false;
    }
    setIsStreaming(true);
    socket.send(JSON.stringify({ action: 'chat', ...request }));
    return true;
  }, []);

  return { connection, isStreaming, ask };
}
