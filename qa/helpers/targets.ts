// Target resolution for the QA audit harness. QA_TARGET picks the base URLs
// and the credential source. `prod` points at the live Vercel dashboard
// (which rewrites /api/* to the production API); `local` points at the
// production-mode stack stood up on this machine.
//
// Credentials are read from the environment only — never hardcoded. On prod
// the owner supplies QA_USER1_*, QA_USER2_*, QA_ADMIN_* as environment
// secrets; on local they default to the seeded accounts.

export type TargetName = 'prod' | 'local';

export interface Creds {
  email: string;
  password: string;
}

export interface Target {
  name: TargetName;
  /** Dashboard origin a browser loads. API is reached under `${web}/api/v1`. */
  web: string;
  /** Direct API origin (bypassing the SPA host), for raw request checks. */
  api: string;
  user1?: Creds;
  user2?: Creds;
  admin?: Creds & { totpSecret?: string };
}

const TARGET = (process.env.QA_TARGET ?? 'local') as TargetName;

function creds(email?: string, password?: string): Creds | undefined {
  return email && password ? { email, password } : undefined;
}

export function resolveTarget(): Target {
  if (TARGET === 'prod') {
    return {
      name: 'prod',
      web: process.env.QA_WEB ?? 'https://snippingtool-eta.vercel.app',
      api: process.env.QA_API ?? 'https://api.46.62.142.29.sslip.io',
      user1: creds(process.env.QA_USER1_EMAIL, process.env.QA_USER1_PASSWORD),
      user2: creds(process.env.QA_USER2_EMAIL, process.env.QA_USER2_PASSWORD),
      admin: process.env.QA_ADMIN_EMAIL
        ? {
            email: process.env.QA_ADMIN_EMAIL,
            password: process.env.QA_ADMIN_PASSWORD ?? '',
            totpSecret: process.env.QA_ADMIN_TOTP_SECRET,
          }
        : undefined,
    };
  }
  return {
    name: 'local',
    web: process.env.QA_WEB ?? 'http://localhost:8080',
    api: process.env.QA_API ?? 'http://localhost:3000',
    user1: creds(
      process.env.QA_USER1_EMAIL ?? 'dev@sniperledger.local',
      process.env.QA_USER1_PASSWORD ?? 'dev-password-123',
    ),
    user2: creds(process.env.QA_USER2_EMAIL, process.env.QA_USER2_PASSWORD),
    admin: {
      email: process.env.QA_ADMIN_EMAIL ?? 'qa-admin@novatrade.local',
      password: process.env.QA_ADMIN_PASSWORD ?? '',
      totpSecret: process.env.QA_ADMIN_TOTP_SECRET,
    },
  };
}

export const target = resolveTarget();
export const isProd = target.name === 'prod';
