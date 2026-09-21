import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../lib/cn.js';

import { IconButton } from './IconButton.js';

export interface CopyFieldProps {
  value: string;
  label?: string;
  mono?: boolean;
  className?: string;
}

/** Read-only value with a copy button — license keys, recovery codes, IDs.
 * Never editable; that's what makes it safe to select-all + copy without a
 * confirmation step. */
export function CopyField({ value, label, mono = true, className }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — fall back to a
      // manual-select affordance rather than silently doing nothing.
      const el = document.createElement('textarea');
      el.value = value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && <span className="text-xs font-medium text-[--sl-fg-muted]">{label}</span>}
      <div className="flex items-center gap-2 rounded-[--sl-radius-sm] border border-[--sl-border] bg-[--sl-ground] py-1 pl-3 pr-1.5">
        <span
          data-testid="copy-field-value"
          className={cn(
            'flex-1 select-all truncate text-sm text-[--sl-fg]',
            mono && 'font-mono tabular-nums',
          )}
        >
          {value}
        </span>
        <IconButton
          size="sm"
          label={copied ? 'Copied' : 'Copy to clipboard'}
          icon={
            copied ? <Check className="size-4 text-[--sl-positive]" /> : <Copy className="size-4" />
          }
          onClick={handleCopy}
        />
      </div>
    </div>
  );
}
