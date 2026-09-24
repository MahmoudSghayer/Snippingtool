import { zodResolver } from '@hookform/resolvers/zod';
import {
  isPurchasablePlan,
  paypalPaymentUrl,
  paypalTransactionIdSchema,
  PLAN_CATALOGUE,
  type PaymentClaimStatus,
  type PlanCatalogueEntry,
  type PlanDto,
} from '@sl/shared';
import { Badge, Button, formatCurrencyFromCents, FormField, Input, Select, Textarea } from '@sl/ui';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, apiErrorMessage } from '@/api/client.js';

// --- Catalogue helpers ---------------------------------------------------

/** The catalogue entry for a plan code, or null for the trial and for any
 * code the catalogue doesn't know (neither can be bought). */
export function catalogueEntry(code: string): PlanCatalogueEntry | null {
  return Object.hasOwn(PLAN_CATALOGUE, code)
    ? PLAN_CATALOGUE[code as keyof typeof PLAN_CATALOGUE]
    : null;
}

/** Plans to show as cards: every catalogued plan that isn't retired. */
export function shownPlans(plans: readonly PlanDto[]): PlanDto[] {
  return plans.filter((p) => {
    const entry = catalogueEntry(p.code);
    return entry !== null && entry.availability !== 'retired';
  });
}

export function purchasablePlans(plans: readonly PlanDto[]): PlanDto[] {
  return plans.filter((p) => isPurchasablePlan(p.code));
}

export function passLengthLabel(entry: PlanCatalogueEntry): string {
  return entry.passDays === null ? 'Until the next FC release' : `${entry.passDays}-day pass`;
}

export function paypalUrlForPlan(plan: Pick<PlanDto, 'priceCents' | 'currency'>): string {
  return paypalPaymentUrl(plan.priceCents, plan.currency);
}

// --- Status chip ---------------------------------------------------------

const STATUS_LABEL: Record<PaymentClaimStatus, string> = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_TONE = {
  pending: 'warning',
  approved: 'positive',
  rejected: 'negative',
} as const satisfies Record<PaymentClaimStatus, string>;

export function PaymentClaimStatusBadge({ status }: { status: PaymentClaimStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

// --- Step 2: submit a transaction ID -------------------------------------

export const paymentClaimFormSchema = z.object({
  planCode: z.string().min(1, 'Choose the plan you paid for.'),
  paypalTransactionId: paypalTransactionIdSchema,
  note: z.string().trim().max(500, 'Keep the note under 500 characters.'),
});
type PaymentClaimFormInput = z.input<typeof paymentClaimFormSchema>;
type PaymentClaimFormOutput = z.output<typeof paymentClaimFormSchema>;

export interface PaymentClaimFormProps {
  /** Plans that can be bought right now (`purchasablePlans`). */
  plans: readonly PlanDto[];
  /** Called after the API accepts the claim, e.g. to refresh the list. */
  onSubmitted?: () => void;
}

export function PaymentClaimForm({ plans, onSubmitted }: PaymentClaimFormProps) {
  const form = useForm<PaymentClaimFormInput, unknown, PaymentClaimFormOutput>({
    resolver: zodResolver(paymentClaimFormSchema),
    defaultValues: {
      planCode: plans.length === 1 ? plans[0]!.code : '',
      paypalTransactionId: '',
      note: '',
    },
  });
  const errors = form.formState.errors;

  const mutation = useMutation({
    mutationFn: async (values: PaymentClaimFormOutput) => {
      const { data, error } = await api.POST('/api/v1/payment-claims', {
        body: {
          planCode: values.planCode,
          paypalTransactionId: values.paypalTransactionId,
          ...(values.note ? { note: values.note } : {}),
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Payment submitted', {
        description: 'We check payments by hand, usually within a few hours.',
      });
      form.reset({ planCode: form.getValues('planCode'), paypalTransactionId: '', note: '' });
      onSubmitted?.();
    },
    onError: (error) =>
      toast.error('Couldn’t submit your payment', { description: apiErrorMessage(error) }),
  });

  if (plans.length === 0) {
    return <p className="text-sm text-ink-2">No plan can be bought right now.</p>;
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Plan you paid for" error={errors.planCode?.message}>
          <Controller
            control={form.control}
            name="planCode"
            render={({ field }) => (
              <Select
                aria-label="Plan you paid for"
                value={field.value}
                onValueChange={field.onChange}
                invalid={!!errors.planCode}
                placeholder="Choose a plan"
                options={plans.map((p) => ({
                  value: p.code,
                  label: `${p.name} (${formatCurrencyFromCents(p.priceCents, p.currency.toUpperCase())})`,
                }))}
              />
            )}
          />
        </FormField>
        <FormField
          label="PayPal transaction ID"
          htmlFor="claim-txn"
          hint="17 letters and numbers, from your PayPal receipt."
          error={errors.paypalTransactionId?.message}
        >
          <Input
            id="claim-txn"
            className="font-mono uppercase"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            placeholder="8XY12345AB678901C"
            aria-invalid={errors.paypalTransactionId ? true : undefined}
            {...form.register('paypalTransactionId')}
          />
        </FormField>
      </div>
      <FormField label="Note (optional)" htmlFor="claim-note" error={errors.note?.message}>
        <Textarea
          id="claim-note"
          rows={2}
          maxLength={500}
          placeholder="Anything that helps us find your payment, e.g. the PayPal email you paid from."
          {...form.register('note')}
        />
      </FormField>
      <Button type="submit" className="w-fit" loading={mutation.isPending}>
        Submit transaction ID
      </Button>
    </form>
  );
}
