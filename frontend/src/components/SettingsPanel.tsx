/**
 * Settings dialog.
 *
 * Only display and editing choices live here. Execution limits are requested,
 * not set: the server clamps them, and the panel says so rather than implying
 * the browser is in charge.
 */

import { motion } from 'framer-motion';
import { X } from 'lucide-react';

import { THEMES, type Preferences, type ThemeId } from '../lib/preferences';

interface Props {
  open: boolean;
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  onReset: () => void;
  onClose: () => void;
}

export function SettingsPanel({ open, preferences, onChange, onReset, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="max-h-[84vh] w-[min(560px,92vw)] overflow-y-auto rounded-xl border border-slate-700/80 bg-charcoal shadow-2xl"
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-slate-800 bg-charcoal px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="space-y-5 p-4">
          <Section title="Appearance">
            <Row label="Theme">
              <select
                value={preferences.theme}
                onChange={(event) => onChange('theme', event.target.value as ThemeId)}
                className="w-44 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-accent"
              >
                {THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </Row>
            <Slider
              label="Font size"
              value={preferences.fontSize}
              min={9}
              max={28}
              suffix="px"
              onChange={(value) => onChange('fontSize', value)}
            />
            <Toggle
              label="Font ligatures"
              hint="Render -> and != as single glyphs"
              checked={preferences.fontLigatures}
              onChange={(value) => onChange('fontLigatures', value)}
            />
          </Section>

          <Section title="Editor">
            <Slider
              label="Tab size"
              value={preferences.tabSize}
              min={1}
              max={8}
              suffix=" spaces"
              onChange={(value) => onChange('tabSize', value)}
            />
            <Toggle
              label="Word wrap"
              checked={preferences.wordWrap}
              onChange={(value) => onChange('wordWrap', value)}
            />
            <Toggle
              label="Minimap"
              checked={preferences.minimap}
              onChange={(value) => onChange('minimap', value)}
            />
            <Toggle
              label="Line numbers"
              checked={preferences.lineNumbers}
              onChange={(value) => onChange('lineNumbers', value)}
            />
            <Toggle
              label="Show whitespace"
              checked={preferences.renderWhitespace}
              onChange={(value) => onChange('renderWhitespace', value)}
            />
            <Slider
              label="Ruler column"
              value={preferences.rulerColumn}
              min={0}
              max={160}
              step={10}
              suffix={preferences.rulerColumn === 0 ? ' (off)' : ''}
              onChange={(value) => onChange('rulerColumn', value)}
            />
          </Section>

          <Section title="Analysis">
            <Toggle
              label="Analyse as you type"
              hint="Turn off to analyse only when you run"
              checked={preferences.liveAnalysis}
              onChange={(value) => onChange('liveAnalysis', value)}
            />
          </Section>

          <Section
            title="Execution limits"
            note="Requested, not granted: the server clamps every value to its own ceiling."
          >
            <Slider
              label="Time limit"
              value={preferences.wallSeconds}
              min={1}
              max={120}
              suffix="s"
              onChange={(value) => onChange('wallSeconds', value)}
            />
            <Slider
              label="Memory limit"
              value={preferences.memoryMb}
              min={16}
              max={2048}
              step={16}
              suffix=" MiB"
              onChange={(value) => onChange('memoryMb', value)}
            />
          </Section>

          <div className="border-t border-slate-800 pt-3">
            <button
              type="button"
              onClick={onReset}
              className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-halt/50 hover:text-halt"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h3>
      {note && <p className="mb-2 text-[10px] leading-relaxed text-slate-600">{note}</p>}
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block text-xs text-slate-300">{label}</span>
        {hint && <span className="block text-[10px] text-slate-600">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-slate-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </Row>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Row label={label}>
      <span className="flex shrink-0 items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-28 accent-indigo-500"
        />
        <span className="w-16 text-right font-mono text-[10px] text-slate-400">
          {value}
          {suffix}
        </span>
      </span>
    </Row>
  );
}
