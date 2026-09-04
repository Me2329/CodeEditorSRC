/** Shared shapes for the gateway's REST and WebSocket surfaces. */

export type RuntimeCategory = 'native' | 'interpreted' | 'managed' | 'web';

export interface RuntimeInfo {
  id: string;
  label: string;
  category: RuntimeCategory | string;
  /** Monaco's own language id, which does not always match the runtime id. */
  monaco: string;
  extension: string;
  entry: string;
  /** Whether this host has the toolchain installed. */
  installed: boolean;
  /** False for runtimes rendered in the browser, such as the HTML preview. */
  executable: boolean;
  notes?: string;
  /**
   * The toolchain binary this host resolved for the runtime, e.g. "lua5.4"
   * where the preferred "luajit" is absent. Null when none is installed.
   */
  toolchain?: string | null;
}

export interface HealthInfo {
  status: string;
  version: string;
  isolation_tier: 'nsjail' | 'userns' | 'rlimit' | 'unknown' | string;
  supervisor: string;
  rate_limiter: string;
  analyzer: boolean;
  runtimes_total: number;
  runtimes_installed: number;
}

export interface VirtualFile {
  id: string;
  name: string;
  /** Monaco language id for this file, derived from its extension. */
  language: string;
  content: string;
}

export interface ExecutionLimits {
  wall_seconds: number;
  cpu_seconds: number;
  memory_mb: number;
  max_procs: number;
  allow_net: boolean;
}

export interface RunMeta {
  language: string;
  label: string;
  status: string;
  isolation: {
    tier: string;
    cgroup_v2: boolean;
    privileges_dropped: boolean;
    network: boolean;
  };
  limits: {
    memory_mb: number;
    cpu_seconds: number;
    wall_seconds: number;
    max_procs: number;
  };
  compile: { ran: boolean; exit_code: number; duration_ms: number };
  run: { exit_code: number; duration_ms: number };
}

export type ServerFrame =
  | { type: 'ready'; isolation_tier: string; backend: string }
  | { type: 'accepted'; language: string; label: string; remaining_quota: number }
  | { type: 'stdout'; content: string }
  | { type: 'stderr'; content: string }
  | { type: 'aborting' }
  | { type: 'idle' }
  | { type: 'error'; message: string }
  | {
      type: 'exit';
      code: number;
      execution_time: number;
      truncated?: boolean;
      aborted?: boolean;
      meta?: RunMeta | null;
    };

export interface AstNode {
  kind: string;
  name: string;
  detail: string;
  line: number;
  end_line: number;
  children: AstNode[];
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  rule: string;
  message: string;
  line: number;
  column: number;
}

export interface Symbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  detail: string;
}

export interface AnalysisResult {
  language: string;
  metrics: {
    total_lines: number;
    code_lines: number;
    comment_lines: number;
    blank_lines: number;
    characters: number;
    tokens: number;
    declarations: number;
    max_nesting_depth: number;
    cyclomatic_complexity: number;
  };
  diagnostics: Diagnostic[];
  ast: AstNode | null;
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

/** Where a chat request should be answered from. */
export type AssistantRoute = 'auto' | 'local' | 'remote';

/** How much effort the model should spend, mirroring output_config.effort. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface WorkspaceContext {
  language: string;
  files: { name: string; content: string }[];
  active_file: string;
  line: number;
  column: number;
  selection: string;
}

export interface AssistantUsage {
  input_tokens: number;
  output_tokens: number;
  /** Cost of the turn in US cents, from the model's published rates. */
  cost_cents: number;
}

export type AssistantFrame =
  | {
      type: 'ready';
      available: boolean;
      model: string;
      remote_available: boolean;
      reason: string;
    }
  | { type: 'routed'; engine: 'local' | 'model'; model: string }
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: AssistantUsage | null; elapsed_ms: number }
  | { type: 'error'; message: string };

export interface AssistantCompletion {
  label: string;
  kind: string;
  detail: string;
  score: number;
}
