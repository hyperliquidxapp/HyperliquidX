import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const sparklePublicKey = 'ytzEZOr2mxU9BUYYK/9qdGYdiwzHn7kxwsEHOSCtN8A=';

export function validateSparkleMetadata(sparkle, version) {
  if (!sparkle || Object.keys(sparkle).some(key => !['bundleVersion', 'edSignature'].includes(key)) ||
      !sparkle.bundleVersion?.startsWith(`${version}.`) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(sparkle.bundleVersion) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(sparkle.edSignature || '') ||
      Buffer.from(sparkle.edSignature, 'base64').length !== 64) {
    throw new Error('Invalid Sparkle bundle version or EdDSA signature');
  }
  return sparkle;
}

export async function verifySparkleArchive(file, signature, publicKey = sparklePublicKey) {
  const rawKey = Buffer.from(publicKey, 'base64');
  if (rawKey.length !== 32) throw new Error('Invalid Sparkle public key');
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
    format: 'der', type: 'spki',
  });
  if (!verify(null, await readFile(file), key, Buffer.from(signature, 'base64'))) {
    throw new Error('Sparkle archive signature verification failed');
  }
}
