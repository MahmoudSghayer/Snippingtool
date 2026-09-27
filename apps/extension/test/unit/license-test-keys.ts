// Test-only Ed25519 keypair for the entitlement blob (not a test file
// itself). The public half is baked into the test build as
// `VITE_LICENSE_PUBLIC_KEY` (vitest.config.ts), exactly as a real build bakes
// in the API's `ENTITLEMENT_PUBLIC_KEY`; this private half never signs
// anything outside these tests.
//
// `signBlob()` produces what `apps/api/src/lib/entitlements.ts` produces:
// jose's compact JWS, `base64url({"alg":"EdDSA"}).base64url(claims).base64url(sig)`,
// with the Ed25519 signature over the ASCII `header.payload`. The
// `API_SIGNED_*` fixtures below were not made by this helper: they were
// printed by the API's own `DefaultEntitlementProvider.signEntitlementBlob()`
// (jose) with the private key below, so the extension is tested against
// the server's real output, not only against its own idea of it.

export const TEST_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAh0+wT0NW0GyjaaZGmHy7w4D7eZrMxwukv8+wiTdc7c8=\n-----END PUBLIC KEY-----';
const TEST_PRIVATE_KEY_PKCS8_B64 = 'MC4CAQAwBQYDK2VwBCIEILSWQ6alA0vfvU5Hgi10VZNnLIJLkWQgtTlKzFH8w9m4';

export const FIXTURE_USER_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_DEVICE_ID = '11111111-1111-4111-8111-111111111111';
/** `iat` of both API-signed fixtures (seconds); `exp` is `iat` + 26h. */
export const API_SIGNED_IAT = 1_790_151_219;
export const API_SIGNED_EXP = 1_790_244_819;
/** Signed with `killSwitchActive: false`; snapshot features `['assist.ranker']`. */
export const API_SIGNED_BLOB =
  'eyJhbGciOiJFZERTQSJ9.eyJzbmFwc2hvdCI6eyJwbGFuIjoicHJvIiwicGxhbk5hbWUiOiJQcm8iLCJzdGF0dXMiOiJhY3RpdmUiLCJmZWF0dXJlcyI6WyJhc3Npc3QucmFua2VyIl0sImRldmljZUxpbWl0IjoyLCJleHBpcmVzQXQiOm51bGwsImN1cnJlbnRQZXJpb2RFbmQiOm51bGwsImxpY2Vuc2UiOm51bGx9LCJkZXZpY2VJZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsImtpbGxTd2l0Y2hBY3RpdmUiOmZhbHNlLCJzdWIiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJpYXQiOjE3OTAxNTEyMTksImV4cCI6MTc5MDI0NDgxOX0.Hi296MSb3HsENeKenHrCybnThQHGAXEVg3wUXHgp_Cfs0pJfS-SAOKe7k-kazo_W9gN4qPyo46OUsIvgIG8qBA';
/** The same snapshot signed without the kill-switch claim, as every blob
 * issued before the claim existed was. */
export const API_SIGNED_LEGACY_BLOB =
  'eyJhbGciOiJFZERTQSJ9.eyJzbmFwc2hvdCI6eyJwbGFuIjoicHJvIiwicGxhbk5hbWUiOiJQcm8iLCJzdGF0dXMiOiJhY3RpdmUiLCJmZWF0dXJlcyI6WyJhc3Npc3QucmFua2VyIl0sImRldmljZUxpbWl0IjoyLCJleHBpcmVzQXQiOm51bGwsImN1cnJlbnRQZXJpb2RFbmQiOm51bGwsImxpY2Vuc2UiOm51bGx9LCJkZXZpY2VJZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInN1YiI6IjIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiIsImlhdCI6MTc5MDE1MTIxOSwiZXhwIjoxNzkwMjQ0ODE5fQ.mdMh5rMCEE9vaOawYzn5xzHPCCeL8jkvRh9mcPgf0qS0ZsTf5CnmPvPqxFv1uXiFVSk_LHVinRntB4zY5TWcDA';

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlJson(value: unknown): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function testPrivateKey(): Promise<CryptoKey> {
  const der = Uint8Array.from(atob(TEST_PRIVATE_KEY_PKCS8_B64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

export interface ClaimsInput {
  features: string[];
  killSwitchActive?: boolean;
  /** seconds */
  iat: number;
  /** seconds; defaults to iat + 26h like the API */
  exp?: number;
}

export function claimsFor({ features, killSwitchActive, iat, exp }: ClaimsInput): Record<string, unknown> {
  return {
    snapshot: { plan: 'pro', planName: 'Pro', status: 'active', features, deviceLimit: 2, expiresAt: null, currentPeriodEnd: null, license: null },
    deviceId: FIXTURE_DEVICE_ID,
    ...(killSwitchActive === undefined ? {} : { killSwitchActive }),
    sub: FIXTURE_USER_ID,
    iat,
    exp: exp ?? iat + 26 * 60 * 60,
  };
}

/** Signs `claims` the way jose's `SignJWT(...).sign(ed25519Key)` does. Pass
 * `key` to sign with some other key (a forger's). */
export async function signBlob(claims: Record<string, unknown>, key?: CryptoKey): Promise<string> {
  const signingInput = `${b64urlJson({ alg: 'EdDSA' })}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign('Ed25519', key ?? (await testPrivateKey()), new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
}
