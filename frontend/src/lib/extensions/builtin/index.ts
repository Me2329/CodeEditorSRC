/**
 * The extensions bundled with the editor.
 *
 * All of them ship enabled, and all of them can be turned off. They are
 * ordinary extensions using the same public contract a third-party one would:
 * if something here cannot be expressed through a contribution point, that is a
 * gap in the contract rather than a reason to reach past it.
 */

import type { Extension } from '../types';

import { formatPack } from './format';
import { keywordHelp } from './keywords';
import { lintPack } from './lint';
import { snippetPack } from './snippets';
import { statusPack } from './status';
import { textToolkit } from './text-toolkit';
import { themePack } from './themes';

export const BUILTIN_EXTENSIONS: readonly Extension[] = [
  textToolkit,
  snippetPack,
  lintPack,
  formatPack,
  statusPack,
  themePack,
  keywordHelp,
];

export { formatPack, keywordHelp, lintPack, snippetPack, statusPack, textToolkit, themePack };
