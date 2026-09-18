/**
 * Gateway client.
 *
 * Everything speaks to the API through this module so the base URL and error
 * handling live in one place. In development Vite proxies /api to the gateway,
 * so a relative base works for both HTTP and the WebSocket upgrade.
 */

import type {
  AnalysisResult,
  AssistantCompletion,
  HealthInfo,
  RuntimeInfo,
  Symbol as WorkspaceSymbol,
  WorkspaceContext,
} from './types';

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

/**
 * Who is asking, for the lifetime of this tab.
 *
 * Per tab rather than per user: two tabs are two carets, and one superseding
 * the other's completions would be wrong. Regenerated on reload, which is
 * correct, because the requests from before a reload are gone anyway.
 */
const SOURCE = `editor-${Math.random().toString(36).slice(2, 10)}`;

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

  /** Completion candidates from the local engine. No model involved. */
  complete: (workspace: WorkspaceContext, prefix: string, limit = 25) =>
    request<{ items: AssistantCompletion[] }>('/api/v1/assistant/complete', {
      method: 'POST',
      body: JSON.stringify({ workspace, prefix, limit }),
    }),

  /**
   * Text for the caret, given the code on both sides of it.
   *
   * Served by the local model rather than the index: this is the one request
   * that has to invent text rather than look something up.
   */
  infill: (
    prefix: string,
    suffix: string,
    {
      maxTokens = 64,
      signal,
      candidates = 1,
      lineComment,
    }: {
      maxTokens?: number;
      signal?: AbortSignal;
      /** Sample this many and keep the best. Each one is a whole generation, so
       *  this is for a completion asked for rather than offered. */
      candidates?: number;
      /** What a line comment looks like in this file. The server stops a
       *  completion that closes a bracket the suffix closes, and without this
       *  it would count brackets inside comments. */
      lineComment?: string;
    } = {},
  ) =>
    request<{
      completion: string;
      tokens: number;
      model: string;
      seconds: number;
      superseded?: boolean;
      confidence?: number | null;
      /** Why the completion ended, when the model did not choose to: "dedent"
       *  or "bracket" for structure, or the stop sequence that matched. */
      trimmed?: string | null;
      stop?: string | null;
    }>('/api/v1/assistant/infill', {
      method: 'POST',
      // `source` identifies this tab so the model server abandons this tab's
      // previous request when a newer one arrives. Aborting is not enough on
      // its own: generation is serialised, so a request nobody wants is not
      // merely wasted, it is in front of the one that matters.
      body: JSON.stringify({
        prefix,
        suffix,
        max_tokens: maxTokens,
        source: SOURCE,
        candidates,
        line_comment: lineComment,
      }),
      signal,
    }),

  /**
   * How many tokens a piece of text is, by the model's own tokenizer.
   *
   * On demand rather than as you type: it is a round trip, and the answer only
   * changes when the file does.
   */
  tokenize: (text: string) =>
    request<{ tokens: number; characters: number; context: number }>(
      '/api/v1/assistant/tokenize',
      { method: 'POST', body: JSON.stringify({ text }) },
    ),

  /** Whether the local model is running, and what it is. */
  modelStatus: () =>
    request<{ available: boolean; model?: string; parameters?: number; reason?: string }>(
      '/api/v1/assistant/model',
    ),

  /** Every declaration in the workspace, for outline and go-to-symbol. */
  symbols: (workspace: WorkspaceContext) =>
    request<{ items: WorkspaceSymbol[] }>('/api/v1/assistant/symbols', {
      method: 'POST',
      body: JSON.stringify({ workspace }),
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
