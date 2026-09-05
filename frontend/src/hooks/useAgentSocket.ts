/**
 * WebSocket lifecycle for the agent.
 *
 * A third socket, separate from execution and chat, because an agent task runs
 * for minutes and must not be disturbed by a run finishing or a chat reply
 * arriving.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentFrame, AgentMode, Effort, WorkspaceContext } from '../lib/types';

export type AgentConnection = 'connecting' | 'open' | 'closed';

export interface AgentStatus {
  available: boolean;
  model: string;
  remoteAvailable: boolean;
  reason: string;
}

interface Handlers {
  onFrame: (frame: AgentFrame) => void;
  onStatus: (status: AgentStatus) => void;
}

export interface AgentRunRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  workspace: WorkspaceContext;
  mode: AgentMode;
  effort: Effort;
  maxSteps: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20_000;

function socketUrl(): string {
  const base = import.meta.env.VITE_API_BASE ?? '';
  if (base) return `${base.replace(/^http/, 'ws')}/api/v1/ws/agent`;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/v1/ws/agent`;
}

export function useAgentSocket(handlers: Handlers) {
  const [connection, setConnection] = useState<AgentConnection>('connecting');
  const [isRunning, setIsRunning] = useState(false);

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
      // A superseded socket may still deliver queued frames; they belong to a
      // run that is no longer on screen.
      if (socketRef.current !== socket) return;

      let frame: AgentFrame;
      try {
        frame = JSON.parse(event.data) as AgentFrame;
      } catch {
        handlersRef.current.onFrame({
          type: 'failed',
          message: 'The agent sent a malformed frame.',
        });
        return;
      }

      if (frame.type === 'ready') {
        handlersRef.current.onStatus({
          available: frame.available,
          model: frame.model,
          remoteAvailable: frame.remote_available,
          reason: frame.reason,
        });
        return;
      }
      if (frame.type === 'finished' || frame.type === 'failed') {
        setIsRunning(false);
      }
      handlersRef.current.onFrame(frame);
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setConnection('closed');
      setIsRunning(false);
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

  const run = useCallback((request: AgentRunRequest): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      handlersRef.current.onFrame({
        type: 'failed',
        message: 'Not connected to the agent. Reconnecting…',
      });
      return false;
    }
    setIsRunning(true);
    socket.send(
      JSON.stringify({
        action: 'run',
        messages: request.messages,
        workspace: request.workspace,
        mode: request.mode,
        effort: request.effort,
        max_steps: request.maxSteps,
      }),
    );
    return true;
  }, []);

  const cancel = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'cancel' }));
    }
  }, []);

  return { connection, isRunning, run, cancel };
}
