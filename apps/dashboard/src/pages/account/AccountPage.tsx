// /account: the customer's "My account" page, inside the website's header
// and footer (routes/SiteLayout.tsx). One page, five sections, in the order
// a customer needs them: what they have, the download, how to pay, where
// they're signed in, and how they sign in.
import { PaymentHistory, PayWithPayPal, SubmitPayment } from '@/components/account/BuyPass.js';
import { DevicesCard } from '@/components/account/DevicesCard.js';
import { PassSummary } from '@/components/account/PassSummary.js';
import {
  ChangePasswordCard,
  DeleteAccountCard,
  EmailCard,
  TwoFactorCard,
} from '@/components/account/Security.js';
import { ExtensionDownloadCard } from '@/components/ExtensionDownload.js';
import { useWsGateway } from '@/hooks/useWsGateway.js';
import { useAuthStore } from '@/stores/auth.js';

interface AccountSectionProps {
  id: string;
  index: number;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}

function AccountSection({ id, index, title, description, children }: AccountSectionProps) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-24">
      <div className="mb-4">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-gold">
          {String(index).padStart(2, '0')}
        </p>
        <h2 id={headingId} className="mt-1 text-xl font-bold tracking-tight text-ink sm:text-2xl">
          {title}
        </h2>
        {description && <p className="mt-2 text-sm text-ink-2">{description}</p>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function AccountPage() {
  const email = useAuthStore((s) => s.user?.email);
  // Live updates while the page is open: a pass approved by an admin shows
  // up without a reload, and a revoked session signs this tab out.
  useWsGateway();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-12">
      <header>
        <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-gold">
          Account
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">My account</h1>
        {email && (
          <p className="mt-3 text-ink-2">
            Signed in as <span className="text-ink">{email}</span>
          </p>
        )}
      </header>

      <AccountSection id="pass" index={1} title="Your pass">
        <PassSummary />
      </AccountSection>

      <AccountSection
        id="extension"
        index={2}
        title="Get the extension"
        description="The Chrome extension works in the EA FC web app. Download it here and load it in Chrome."
      >
        <ExtensionDownloadCard headless />
      </AccountSection>

      <AccountSection
        id="buy"
        index={3}
        title="Buy or renew"
        description={
          <>
            Passes are one-off payments and don't renew. Refunds are only available within 24 hours
            of purchase, see the{' '}
            <a
              href="/refund-policy"
              className="text-gold underline underline-offset-2 hover:text-gold/80"
            >
              Refund Policy
            </a>
            .
          </>
        }
      >
        <PayWithPayPal />
        <SubmitPayment />
        <PaymentHistory />
      </AccountSection>

      <AccountSection
        id="devices"
        index={4}
        title="Devices"
        description="Browsers signed in to your account. Your plan sets how many you can use; revoke one you no longer use to free a slot."
      >
        <DevicesCard />
      </AccountSection>

      <AccountSection id="security" index={5} title="Account and security">
        <EmailCard />
        <ChangePasswordCard />
        <TwoFactorCard />
        <DeleteAccountCard />
      </AccountSection>
    </div>
  );
}

export default AccountPage;
