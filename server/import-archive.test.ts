import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { openValidatedArchive } from './import-archive.ts';

async function fixture(bytes: Buffer, run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-import-archive-'));
  const path = join(directory, 'test.zip');
  try { await writeFile(path, bytes); await run(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('archive validates bytes before Excel loading, rejecting corrupted CRCs', async () => {
  const zip = new JSZip(); zip.file('sheet.xml', '<sheet>valid text</sheet>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  await fixture(bytes, async path => {
    const archive = await openValidatedArchive(path);
    try { await archive.verifyAll(); assert.equal((await archive.read('sheet.xml', 100)).toString(), '<sheet>valid text</sheet>'); }
    finally { archive.close(); }
  });
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.indexOf(Buffer.from('<sheet>')) + 7] ^= 1;
  await fixture(corrupted, async path => {
    const archive = await openValidatedArchive(path);
    try { await assert.rejects(archive.verifyAll(), /校验失败/); }
    finally { archive.close(); }
  });
});

test('archive rejects duplicate case-folded names, traversal and Unix symlinks', async () => {
  const duplicate = new JSZip(); duplicate.file('image.jpg', 'one'); duplicate.file('IMAGE.JPG', 'two');
  const traversal = new JSZip(); traversal.file('../outside.txt', 'no');
  const symlink = new JSZip(); symlink.file('link', 'outside.txt', { unixPermissions: 0o120777 });
  for (const zip of [duplicate, traversal, symlink]) {
    await fixture(await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }), async path => { await assert.rejects(openValidatedArchive(path), /压缩包/); });
  }
});

test('archive enforces entry, expanded and read limits before buffering', async () => {
  const zip = new JSZip(); zip.file('a.txt', 'a'.repeat(128)); zip.file('b.txt', 'b'.repeat(128));
  await fixture(await zip.generateAsync({ type: 'nodebuffer' }), async path => {
    await assert.rejects(openValidatedArchive(path, { maxEntries: 1 }), /数量/);
    await assert.rejects(openValidatedArchive(path, { maxExpandedBytes: 200 }), /大小/);
    await assert.rejects(openValidatedArchive(path, { maxEntryBytes: 100 }), /大小/);
    const archive = await openValidatedArchive(path);
    try { await assert.rejects(archive.read('a.txt', 100), /大小/); }
    finally { archive.close(); }
  });
});

test('exclusive extraction never removes a pre-existing destination on failure', async () => {
  const zip = new JSZip(); zip.file('a.txt', 'archive content');
  await fixture(await zip.generateAsync({ type: 'nodebuffer' }), async path => {
    const destination = join(dirname(path), 'existing.txt');
    await writeFile(destination, 'keep existing file');
    const archive = await openValidatedArchive(path);
    try {
      await assert.rejects(archive.extract('a.txt', destination, 100), /无法解压/);
      assert.equal(await readFile(destination, 'utf8'), 'keep existing file');
    } finally { archive.close(); }
  });
});
