// The website's header and footer around every customer-facing SPA page:
// sign in, sign up, password reset, email verification and /account. The
// landing page (index.html) and the legal pages are static HTML with the
// same header and footer; links to them are plain <a href>, since the SPA
// doesn't serve them.
import { Link, Outlet } from '@tanstack/react-router';

import { useLogout } from '@/lib/logout.js';
import { ACCOUNT_PATH, homePathFor } from '@/routes/access.js';
import { useAuthStore } from '@/stores/auth.js';

import s from './SiteLayout.module.css';

const SITE_NAV = [
  { href: '/#safety', label: 'Safety' },
  { href: '/#features', label: 'Features' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#install', label: 'Install' },
  { href: '/#faq', label: 'FAQ' },
];

/** The Nova Trade mark, the same artwork as public/favicon.svg. */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="nt-nova-g" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#b1ffff" />
          <stop offset=".17" stopColor="#f2fcfc" />
          <stop offset=".65" stopColor="#f1f0ff" />
          <stop offset="1" stopColor="#e2d6ff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="#151d29" />
      <path
        d="M16 5.5Q16.8 15.2 26.5 16Q16.8 16.8 16 26.5Q15.2 16.8 5.5 16Q15.2 15.2 16 5.5Z"
        transform="rotate(45 16 16)"
        fill="#9d8cff"
      />
      <path
        d="M16 3.8Q17.4 14.6 28.2 16Q17.4 17.4 16 28.2Q14.6 17.4 3.8 16Q14.6 14.6 16 3.8Z"
        fill="url(#nt-nova-g)"
      />
      <circle cx="16" cy="16" r="2.4" fill="#ffffff" />
    </svg>
  );
}

export function SiteLayout() {
  // Public pages never fetch the session themselves (a 401 there would
  // bounce /register to /login), so a fresh visit to /login reads as signed
  // out until a guarded page such as /account has loaded it.
  const signedIn = useAuthStore((st) => st.status === 'authenticated');
  const admin = useAuthStore((st) => st.admin);
  const logout = useLogout();
  const adminHome = admin ? homePathFor(admin) : null;

  return (
    <div className={s.site}>
      <a className={s.skipLink} href="#main">
        Skip to content
      </a>

      <header className={s.header}>
        <div className={s.wrap}>
          <a className={s.brand} href="/" aria-label="Nova Trade home">
            <BrandMark />
            <span className={s.brandName}>
              <strong>Nova Trade</strong>
              <small>AI Powered</small>
            </span>
          </a>
          <nav className={s.nav} aria-label="Main">
            {SITE_NAV.map((item) => (
              <a key={item.href} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className={s.actions}>
            {signedIn ? (
              <>
                {adminHome && (
                  <Link to={adminHome} className={`${s.textLink} ${s.hideOnPhone}`}>
                    Admin
                  </Link>
                )}
                <Link to={ACCOUNT_PATH} className={s.textLink}>
                  My account
                </Link>
                <button
                  type="button"
                  className={`${s.btn} ${s.btnGhost}`}
                  onClick={() => void logout()}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className={s.textLink}>
                  Sign in
                </Link>
                <Link to="/register" className={`${s.btn} ${s.btnPrimary} ${s.hideOnPhone}`}>
                  Start free trial
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main" className={s.main}>
        <div className={s.wrap}>
          <Outlet />
        </div>
      </main>

      <footer className={s.footer}>
        <div className={s.wrap}>
          <div className={s.footerLegal}>
            <strong>Nova Trade</strong>
            <span>Not affiliated with Electronic Arts Inc.</span>
            <span>© {new Date().getFullYear()} Nova Trade</span>
          </div>
          <ul className={s.footerLinks}>
            <li>
              <a href="/terms">Terms</a>
            </li>
            <li>
              <a href="/refund-policy">Refund Policy</a>
            </li>
            <li>
              {signedIn ? (
                <Link to={ACCOUNT_PATH}>My account</Link>
              ) : (
                <Link to="/login">Sign in</Link>
              )}
            </li>
            {/* Mirrors index.html's DISCORD_INVITE slot; swap in the invite link here too. */}
            <li>
              <span className={s.soon}>Discord (coming soon)</span>
            </li>
          </ul>
        </div>
      </footer>
    </div>
  );
}

/** Narrow centred column for the sign-in and sign-up cards. */
export function AuthColumn() {
  return (
    <div className="mx-auto w-full max-w-sm">
      <Outlet />
    </div>
  );
}
