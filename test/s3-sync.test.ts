import { diffSync, DriveEntry, S3Entry } from '../lambda/drive-sync/s3-sync';

const drive: DriveEntry[] = [
  { fileId: 'a', key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
  { fileId: 'b', key: 'b/sheet.csv', modifiedTime: '2026-06-10T00:00:00Z' },
];

test('S3 に無いファイルは upload', () => {
  const r = diffSync(drive, []);
  expect(r.uploads.map((u) => u.fileId).sort()).toEqual(['a', 'b']);
  expect(r.deletes).toEqual([]);
});

test('modifiedTime が新しいものだけ upload', () => {
  const s3: S3Entry[] = [
    { key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'b/sheet.csv', modifiedTime: '2026-06-09T00:00:00Z' },
  ];
  const r = diffSync(drive, s3);
  expect(r.uploads.map((u) => u.fileId)).toEqual(['b']);
  expect(r.deletes).toEqual([]);
});

test('Drive に無い S3 オブジェクトは delete', () => {
  const s3: S3Entry[] = [
    { key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'b/sheet.csv', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'old/removed.pdf', modifiedTime: '2026-06-01T00:00:00Z' },
  ];
  const r = diffSync(drive, s3);
  expect(r.uploads).toEqual([]);
  expect(r.deletes).toEqual(['old/removed.pdf']);
});

test('変更が一切無ければ uploads も deletes も空', () => {
  const s3: S3Entry[] = [
    { key: 'a/doc.pdf', modifiedTime: '2026-06-10T00:00:00Z' },
    { key: 'b/sheet.csv', modifiedTime: '2026-06-10T00:00:00Z' },
  ];
  const r = diffSync(drive, s3);
  expect(r.uploads).toEqual([]);
  expect(r.deletes).toEqual([]);
  expect(r.hasChanges).toBe(false);
});
