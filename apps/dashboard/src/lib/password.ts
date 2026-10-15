// Strong random passwords for accounts an admin creates (`/admin/users`'s
// "Create account" dialog). Uses the Web Crypto CSPRNG with rejection
// sampling, so every character of the alphabet is equally likely.

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%*-_=+?';
// Look-alikes (l/I/1, O/0) are left out: the admin may have to read the
// password out to someone.
const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;
const CLASSES = [LOWER, UPPER, DIGITS, SYMBOLS];

function randomIndex(max: number): number {
  // Largest multiple of `max` that fits in a byte; anything above it is
  // redrawn so `% max` stays unbiased.
  const limit = 256 - (256 % max);
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    if (byte[0]! < limit) return byte[0]! % max;
  }
}

/** A random password of `length` characters (default 20) containing at
 * least one lowercase letter, uppercase letter, digit and symbol, which is
 * well inside `@sl/shared`'s `passwordSchema` (12+ chars, a letter and a
 * digit). */
export function generatePassword(length = 20): string {
  if (length < CLASSES.length) throw new Error('Password length is too short.');
  for (;;) {
    let password = '';
    for (let i = 0; i < length; i += 1) password += ALPHABET[randomIndex(ALPHABET.length)];
    if (CLASSES.every((chars) => [...password].some((c) => chars.includes(c)))) return password;
  }
}
