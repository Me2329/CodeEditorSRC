/**
 * The extension host, as a React hook.
 *
 * The host itself is deliberately not a React thing: it outlives renders, holds
 * the registry, and is testable without a DOM. This hook owns one instance,
 * keeps the editor host it talks to current, and re-renders when the registry
 * changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ExtensionHost, NOOP_HOST } from '../lib/extensions/host';
import { BUILTIN_EXTENSIONS } from '../lib/extensions/builtin';
import type {
  ActivationEvent,
  EditorContext,
  EditorHost,
  ExtensionState,
} from '../lib/extensions/types';
import type { Diagnostic, VirtualFile } from '../lib/types';

export interface UseExtensions {
  host: ExtensionHost;
  extensions: ExtensionState[];
  setEnabled(id: string, enabled: boolean): void;
  /** Diagnostics from every enabled linter for this file. */
  lint(file: VirtualFile | null, language: string): Diagnostic[];
}

export function useExtensions(editorHost: EditorHost, language: string): UseExtensions {
  // One host for the life of the component, created lazily so the constructor
  // does not run on every render.
  const hostRef = useRef<ExtensionHost | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new ExtensionHost(NOOP_HOST);
    hostRef.current.registerAll(BUILTIN_EXTENSIONS);
  }
  const host = hostRef.current;

  const [extensions, setExtensions] = useState<ExtensionState[]>(() => host.list());

  // The editor host closes over React state, so it is a new object every
  // render. Handing it over rather than recreating the extension host keeps the
  // registry stable while the callbacks stay current.
  useEffect(() => {
    host.setHost(editorHost);
  }, [host, editorHost]);

  useEffect(() => {
    const subscription = host.subscribe(() => setExtensions(host.list()));
    void host.fire('onStartup');
    return () => subscription.dispose();
  }, [host]);

  // Wake language-specific extensions when the user opens that kind of file.
  useEffect(() => {
    if (language) void host.fire(`onLanguage:${language}` as ActivationEvent);
  }, [host, language]);

  const setEnabled = useCallback(
    (id: string, enabled: boolean) => host.setEnabled(id, enabled),
    [host],
  );

  const lint = useCallback(
    (file: VirtualFile | null, fileLanguage: string) =>
      file ? host.lint(file, fileLanguage) : [],
    // Recomputed when the registry changes, so disabling a linter clears its
    // diagnostics rather than leaving them on screen until the next keystroke.
    [host, extensions],
  );

  return useMemo(
    () => ({ host, extensions, setEnabled, lint }),
    [host, extensions, setEnabled, lint],
  );
}

/** Build the snapshot handed to commands and status bar items. */
export function editorContextFrom(
  files: readonly VirtualFile[],
  activeFile: VirtualFile | null,
  language: string,
  selection: string,
  line: number,
  column: number,
): EditorContext {
  return { files, activeFile, language, selection, line, column };
}
