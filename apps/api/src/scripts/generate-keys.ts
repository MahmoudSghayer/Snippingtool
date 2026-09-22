#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script */
// Generates an Ed25519 keypair for JWT_PRIVATE_KEY/JWT_PUBLIC_KEY, and a
// second one for ENTITLEMENT_SIGNING_KEY/ENTITLEMENT_PUBLIC_KEY. Prints
// .env-ready lines (PEM, with literal `\n` escapes so they paste as a single
// line into a .env file) — copy them into apps/api/.env.

import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

async function printKeypair(label: string, privateVar: string, publicVar: string) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const spki = await exportSPKI(publicKey);
  console.log(`\n# ${label}`);
  console.log(`${privateVar}="${pkcs8.trim().replace(/\n/g, '\\n')}"`);
  console.log(`${publicVar}="${spki.trim().replace(/\n/g, '\\n')}"`);
}

async function main() {
  console.log(
    'Generated Ed25519 keypairs — paste into apps/api/.env (values are PEM with \\n escapes).',
  );
  await printKeypair('JWT signing (access tokens, EdDSA)', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY');
  await printKeypair(
    'Entitlement blob signing',
    'ENTITLEMENT_SIGNING_KEY',
    'ENTITLEMENT_PUBLIC_KEY',
  );
}

main();
