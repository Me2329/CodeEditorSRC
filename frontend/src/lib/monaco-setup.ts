/**
 * Bundle Monaco locally instead of loading it from a CDN.
 *
 * `@monaco-editor/react` defaults to fetching the editor from jsdelivr at
 * runtime. That is unacceptable here for two reasons: CodeCraft Studio is meant
 * to run on airgapped and self-hosted networks where no third-party CDN is
 * reachable, and a CDN outage would leave the IDE with no editor at all.
 *
 * Pointing the loader at the npm package makes the editor part of our own
 * bundle. Its language workers are wired up explicitly, since Vite needs each
 * one imported with the `?worker` suffix to emit it as a separate chunk.
 *
 * Import this module once, before the editor renders.
 */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        // Every other language uses Monaco's tokenizer, which needs only the
        // base editor worker.
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
