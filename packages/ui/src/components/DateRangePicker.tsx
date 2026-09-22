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

const PRESETS: { key: Exclude<DateRangePreset, 'custom'>; label: string }[] = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

/** Presets + custom from/to, per PHASE 10's requirement. `onChange` always
 * receives a fully-formed `{from,to}` — callers never see an incomplete
 * custom range mid-edit. */
export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const [activePreset, setActivePreset] = useState<DateRangePreset>('30d');
  const [showCustom, setShowCustom] = useState(false);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {PRESETS.map((p) => (
        <Button
          key={p.key}
          type="button"
          size="sm"
          variant={activePreset === p.key ? 'primary' : 'outline'}
          onClick={() => {
            setActivePreset(p.key);
            setShowCustom(false);
            onChange(presetRange(p.key), p.key);
          }}
        >
          {p.label}
        </Button>
      ))}
      <Button
        type="button"
        size="sm"
        variant={activePreset === 'custom' ? 'primary' : 'outline'}
        onClick={() => {
          setActivePreset('custom');
          setShowCustom((s) => !s);
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
