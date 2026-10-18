import { useState } from 'react';

import { cn } from '../lib/cn.js';

import { Button } from './Button.js';
import { Input } from './Input.js';

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export type DateRangePreset = '7d' | '30d' | '90d' | 'custom';

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange, preset: DateRangePreset) => void;
  /** The preset buttons to offer, in order (default: 7d, 30d, 90d) — e.g.
   * leave out 90d for a page whose API caps the range shorter. */
  presets?: readonly Exclude<DateRangePreset, 'custom'>[];
  /** Overrides which button shows as selected; `null` selects none, for a
   * page whose own control picked the current range. Omit to let the
   * picker track the user's last choice. */
  activePreset?: DateRangePreset | null;
  className?: string;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function presetRange(preset: Exclude<DateRangePreset, 'custom'>): DateRange {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[preset];
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: toDateString(from), to: toDateString(to) };
}

const ALL_PRESETS: readonly Exclude<DateRangePreset, 'custom'>[] = ['7d', '30d', '90d'];

/** The preset whose range `value` is (today's 7/30/90 days), else custom. */
function presetFor(
  value: DateRange,
  presets: readonly Exclude<DateRangePreset, 'custom'>[],
): DateRangePreset {
  return (
    presets.find((p) => {
      const range = presetRange(p);
      return range.from === value.from && range.to === value.to;
    }) ?? 'custom'
  );
}

/** Presets + custom from/to, per PHASE 10's requirement. `onChange` always
 * receives a fully-formed `{from,to}` — callers never see an incomplete
 * custom range mid-edit. */
export function DateRangePicker({
  value,
  onChange,
  presets = ALL_PRESETS,
  activePreset: activePresetOverride,
  className,
}: DateRangePickerProps) {
  const [chosenPreset, setChosenPreset] = useState<DateRangePreset>(() =>
    presetFor(value, presets),
  );
  const [showCustom, setShowCustom] = useState(false);
  const activePreset = activePresetOverride === undefined ? chosenPreset : activePresetOverride;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {presets.map((p) => (
        <Button
          key={p}
          type="button"
          size="sm"
          variant={activePreset === p ? 'primary' : 'outline'}
          onClick={() => {
            setChosenPreset(p);
            setShowCustom(false);
            onChange(presetRange(p), p);
          }}
        >
          {p}
        </Button>
      ))}
      <Button
        type="button"
        size="sm"
        variant={activePreset === 'custom' ? 'primary' : 'outline'}
        onClick={() => {
          setChosenPreset('custom');
          setShowCustom((s) => !s);
          // Tell the page the custom range is now the active one, so a page
          // that overrides the selection (activePreset) can drop its own.
          onChange(value, 'custom');
        }}
      >
        Custom
      </Button>
      {showCustom && (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={value.from}
            max={value.to}
            aria-label="From date"
            className="w-40"
            onChange={(e) => onChange({ from: e.target.value, to: value.to }, 'custom')}
          />
          <span className="text-(--sl-fg-muted)">–</span>
          <Input
            type="date"
            value={value.to}
            min={value.from}
            aria-label="To date"
            className="w-40"
            onChange={(e) => onChange({ from: value.from, to: e.target.value }, 'custom')}
          />
        </div>
      )}
    </div>
  );
}

export function defaultDateRange(preset: Exclude<DateRangePreset, 'custom'> = '30d'): DateRange {
  return presetRange(preset);
}
