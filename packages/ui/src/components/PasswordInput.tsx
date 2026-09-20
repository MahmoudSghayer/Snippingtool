import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState } from 'react';

import { cn } from '../lib/cn.js';

import { Input, type InputProps } from './Input.js';

export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { className, ...props },
  ref,
) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={visible ? 'text' : 'password'} className={cn('pr-10', className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-[--sl-fg-muted] hover:text-[--sl-fg]"
      >
        {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
});
