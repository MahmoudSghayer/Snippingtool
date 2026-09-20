import { Button, FormField, Modal, Textarea } from '@sl/ui';
import { useState } from 'react';


import type { ReactNode } from 'react';

export interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: (reason: string) => void;
  extraFields?: ReactNode;
}

/** Every admin mutation in `docs/05-subscriptions.md`/`docs/03-api.md`
 * requires a non-empty `reason` (enforced by `adminActionRequestSchema`
 * server-side) — this is the one dialog every admin action in the dashboard
 * confirms through, so the requirement is never silently worked around by a
 * page that forgets to ask. */
export function ReasonDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', destructive, loading, onConfirm, extraFields }: ReasonDialogProps) {
  const [reason, setReason] = useState('');

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setReason('');
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'primary'} disabled={reason.trim().length === 0} loading={loading} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {extraFields}
        <FormField label="Reason" htmlFor="reason-dialog-reason" hint="Recorded in the audit log.">
          <Textarea id="reason-dialog-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
        </FormField>
      </div>
    </Modal>
  );
}
