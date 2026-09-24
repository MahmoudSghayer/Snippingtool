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

/** The landing page's logo mark, copied from index.html. */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#151d1a" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="#ddb35c" strokeWidth="2" />
      <path
        d="M16 3.5v5M16 23.5v5M3.5 16h5M23.5 16h5"
        stroke="#ddb35c"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.75" fill="#6fbf9b" />
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
