/**
 * License key format, generation and validation — pure logic, no I/O, no
 * database or crypto-library dependency, so it can run identically in
 * `apps/api` (issuance/validation) and any future offline tooling.
 *
 * Format: `SL-XXXX-XXXX-XXXX-XXXX` — a 3-char literal prefix ("SL-") followed
 * by 16 Crockford base32 characters split into four 4-char blocks joined by
 * hyphens. Of those 16 characters, the **first 14 are payload** (random,
 * carry no structure of their own — the full entitlement lives in Postgres,
 * keyed by the key's hash) and the **last 2 are a checksum** computed from
 * the first 14, so a mistyped or corrupted key is rejected client-side
 * (extension `POST /licenses/validate` and any support-desk manual entry)
 * before it ever reaches the database.
 *
 * Crockford base32 (RFC-ish, see https://www.crockford.com/base32.html)
 * drops `I`, `L`, `O`, `U` from the alphabet to avoid visual confusion with
 * `1`, `1`, `0` and profanity respectively, and defines canonical
 * case-insensitive decoding of the excluded look-alikes (`normalise` below
 * implements exactly that remapping) — which is why this format was chosen
 * for a key humans read off a screen and type into a support ticket.
 *
 * See `docs/05-subscriptions.md` ("License key format + checksum algorithm")
 * for the full write-up this file implements.
 */

/** The 32 symbols of Crockford base32, in value order 0–31. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const PAYLOAD_LENGTH = 14;
const CHECKSUM_LENGTH = 2;
const TOTAL_DATA_LENGTH = PAYLOAD_LENGTH + CHECKSUM_LENGTH; // 16
const BLOCK_SIZE = 4;
const KEY_PREFIX = 'SL';

/** `generate` needs enough random bits to fill 14 base32 characters (5 bits
 * each = 70 bits); 9 bytes (72 bits) is the smallest whole-byte count that
 * covers it, with the last 2 bits discarded. */
export const LICENSE_KEY_RANDOM_BYTES = 9;

function charValue(char: string): number {
  return CROCKFORD_ALPHABET.indexOf(char);
}

/**
 * Crockford's canonical remap for characters that are visually ambiguous
 * with a digit, applied during normalisation before validation so a human
 * who typed `O` for `0` or `I`/`L` for `1` still gets a working key.
 * `U` has no digit-like meaning and Crockford deliberately leaves it
 * unmapped (excluded from the alphabet, rejected outright) to keep the
 * format free of a common profanity substring.
 */
const AMBIGUOUS_CHAR_MAP: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  L: '1',
};

/**
 * Encodes up to `count` 5-bit groups read from `bytes` (most-significant-bit
 * first) as Crockford base32 characters. Any bits beyond `count * 5` are
 * ignored (see `LICENSE_KEY_RANDOM_BYTES`).
 */
function bytesToBase32(bytes: Uint8Array, count: number): string {
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let byteIndex = 0;
  let out = '';

  while (out.length < count) {
    if (bitsInBuffer < 5) {
      const nextByte = byteIndex < bytes.length ? bytes[byteIndex]! : 0;
      bitBuffer = (bitBuffer << 8) | nextByte;
      bitsInBuffer += 8;
      byteIndex += 1;
    }
    const shift = bitsInBuffer - 5;
    const index = (bitBuffer >> shift) & 0b11111;
    out += CROCKFORD_ALPHABET[index];
    bitsInBuffer -= 5;
  }

  return out;
}

/**
 * Checksum algorithm: a position-weighted sum of the 14 payload characters'
 * numeric values (weights 1..14, so transposing two characters almost always
 * changes the result), taken mod 1024 (10 bits) and encoded as two more
 * Crockford base32 characters. This is a lightweight error-detecting code
 * (catches essentially all single-character substitutions and the large
 * majority of adjacent transpositions) — it is **not** a cryptographic MAC
 * and must never be treated as proof a key was issued by this server; that
 * guarantee comes from the `key_hash` lookup in Postgres, not this checksum.
 */
export function computeChecksum(payload: string): string {
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new Error(
      `computeChecksum expects a ${PAYLOAD_LENGTH}-character payload, got ${payload.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const value = charValue(payload[i]!);
    if (value < 0) {
      throw new Error(`computeChecksum: invalid Crockford base32 character "${payload[i]}"`);
    }
    sum += value * (i + 1);
  }
  const checksumValue = sum % 1024; // 10 bits -> 2 base32 chars
  const high = (checksumValue >> 5) & 0b11111;
  const low = checksumValue & 0b11111;
  return CROCKFORD_ALPHABET[high]! + CROCKFORD_ALPHABET[low]!;
}

function formatWithDashes(dataChars: string): string {
  const blocks: string[] = [];
  for (let i = 0; i < dataChars.length; i += BLOCK_SIZE) {
    blocks.push(dataChars.slice(i, i + BLOCK_SIZE));
  }
  return `${KEY_PREFIX}-${blocks.join('-')}`;
}

/**
 * Generates a new license key from caller-supplied randomness (so this
 * platform-agnostic package never imports `node:crypto` itself — the caller,
 * typically `apps/api`'s licenses module, passes `crypto.randomBytes(9)`).
 *
 * @param randomBytes Exactly `LICENSE_KEY_RANDOM_BYTES` (9) cryptographically
 *   random bytes.
 * @returns The full key, e.g. `SL-9F2K-QRTX-0M7C-HZ3B`.
 */
export function generateLicenseKey(randomBytes: Uint8Array): string {
  if (randomBytes.length !== LICENSE_KEY_RANDOM_BYTES) {
    throw new Error(
      `generateLicenseKey expects ${LICENSE_KEY_RANDOM_BYTES} random bytes, got ${randomBytes.length}`,
    );
  }
  const payload = bytesToBase32(randomBytes, PAYLOAD_LENGTH);
  const checksum = computeChecksum(payload);
  return formatWithDashes(payload + checksum);
}

/**
 * Normalises arbitrary user/extension input into the canonical
 * `SL-XXXX-XXXX-XXXX-XXXX` form: trims whitespace, upper-cases, strips a
 * leading `SL-`/`SL` prefix and all internal hyphens/whitespace, remaps
 * Crockford's ambiguous characters (`O`→`0`, `I`/`L`→`1`), then re-inserts
 * dashes every 4 characters.
 *
 * Returns `null` (never throws) when the input can't be normalised into a
 * well-formed 16-character Crockford base32 string — e.g. wrong length after
 * stripping, or a character outside the alphabet (including `U`, which is
 * deliberately never remapped).
 */
export function normaliseLicenseKey(input: string): string | null {
  if (typeof input !== 'string') return null;

  let cleaned = input.trim().toUpperCase();
  if (cleaned.startsWith(`${KEY_PREFIX}-`)) {
    cleaned = cleaned.slice(KEY_PREFIX.length + 1);
  } else if (cleaned.startsWith(KEY_PREFIX)) {
    cleaned = cleaned.slice(KEY_PREFIX.length);
  }
  // Strip every hyphen and any remaining whitespace (people paste keys with
  // inconsistent spacing/dashing all the time).
  cleaned = cleaned.replace(/[\s-]/g, '');

  if (cleaned.length !== TOTAL_DATA_LENGTH) return null;

  let remapped = '';
  for (const char of cleaned) {
    const mapped = AMBIGUOUS_CHAR_MAP[char] ?? char;
    if (charValue(mapped) < 0) return null;
    remapped += mapped;
  }

  return formatWithDashes(remapped);
}

export interface LicenseKeyValidation {
  valid: boolean;
  /** The canonical `SL-XXXX-XXXX-XXXX-XXXX` form, present whenever the input
   * normalised to a well-formed key — even if the checksum then failed, so
   * callers can log/display the canonical attempt. */
  normalised: string | null;
  /** Present only when normalisation succeeded but the checksum did not
   * match — distinguishes "garbage input" from "a real key, mistyped". */
  reason?: 'MALFORMED' | 'CHECKSUM_MISMATCH';
}

/**
 * Normalises and fully validates a license key's *format* — length,
 * alphabet, and checksum. This says nothing about whether the key was ever
 * issued, is still active, or belongs to the caller; that is a database
 * lookup by `key_hash` in `apps/api`'s licenses module
 * (`POST /licenses/validate`), which should only be attempted once this
 * returns `valid: true`.
 */
export function validateLicenseKeyFormat(input: string): LicenseKeyValidation {
  const normalised = normaliseLicenseKey(input);
  if (!normalised) {
    return { valid: false, normalised: null, reason: 'MALFORMED' };
  }

  const dataChars = normalised.slice(KEY_PREFIX.length + 1).replace(/-/g, '');
  const payload = dataChars.slice(0, PAYLOAD_LENGTH);
  const checksum = dataChars.slice(PAYLOAD_LENGTH);
  const expectedChecksum = computeChecksum(payload);

  if (checksum !== expectedChecksum) {
    return { valid: false, normalised, reason: 'CHECKSUM_MISMATCH' };
  }

  return { valid: true, normalised };
}
