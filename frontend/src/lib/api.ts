/**
 * Gateway client.
 *
 * Everything speaks to the API through this module so the base URL and error
 * handling live in one place. In development Vite proxies /api to the gateway,
 * so a relative base works for both HTTP and the WebSocket upgrade.
 */

import type { AnalysisResult, HealthInfo, RuntimeInfo } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (cause) {
    throw new ApiError(
      'Cannot reach the CodeCraft gateway. Is the backend running on port 8000?',
      0,
    );
  }

  if (!response.ok) {
    // FastAPI reports errors as {detail: ...}; fall back to the status text.
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') {
        detail = body.detail;
      } else if (Array.isArray(body.detail) && body.detail.length > 0) {
        const first = body.detail[0] as { loc?: unknown[]; msg?: string };
        const where = Array.isArray(first.loc) ? first.loc.join('.') : 'request';
        detail = `${where}: ${first.msg ?? 'is invalid'}`;
      }
    } catch {
      // Body was not JSON; the status text stands.
    }
    throw new ApiError(detail, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthInfo>('/api/v1/health'),

  runtimes: () => request<RuntimeInfo[]>('/api/v1/runtimes'),

  template: (language: string) =>
    request<{ language: string; entry: string; template: string }>(
      `/api/v1/runtimes/${encodeURIComponent(language)}/template`,
    ),

  analyze: (language: string, source: string) =>
    request<AnalysisResult>('/api/v1/analyze', {
      method: 'POST',
      body: JSON.stringify({ language, source }),
    }),
};

/** Absolute ws:// or wss:// URL for the execution socket. */
export function executionSocketUrl(): string {
  if (API_BASE) {
    return `${API_BASE.replace(/^http/, 'ws')}/api/v1/ws/execute`;
  }
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/v1/ws/execute`;
}
