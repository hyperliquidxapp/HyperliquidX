import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSparkleMetadata, verifySparkleArchive } from './sparkle-signature.mjs';

test('Sparkle metadata requires a matching release and a full 64-byte signature', () => {
  const signed = { bundleVersion: '0.1.11.42', edSignature: Buffer.alloc(64, 1).toString('base64') };
  assert.equal(validateSparkleMetadata(signed, '0.1.11'), signed);
  for (const change of [{bundleVersion:'0.1.10.42'}, {bundleVersion:'0.1.11'},
    {edSignature:'invalid'}, {edSignature:Buffer.alloc(32).toString('base64')}, {secret:'forbidden'}]) {
    assert.throws(() => validateSparkleMetadata({...signed,...change}, '0.1.11'));
  }
});

test('Ed25519 archive verification rejects corruption and signatures from another key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle-signature-test-'));
  try {
    const file = join(directory,'installer.dmg');
    const bytes = Buffer.from('Installer bytes with signatures');
    await writeFile(file, bytes);
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
    const signature = sign(null,bytes,keys.privateKey).toString('base64');
    await verifySparkleArchive(file,signature,publicKey);
    await assert.rejects(verifySparkleArchive(file,Buffer.alloc(64).toString('base64'),publicKey));
    await writeFile(file,Buffer.from('Corrupt installer'));
    await assert.rejects(verifySparkleArchive(file,signature,publicKey));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
