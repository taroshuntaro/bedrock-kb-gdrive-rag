import { buildKey, RemoteFile } from '../lambda/drive-sync/drive-client';

function file(name: string): RemoteFile {
  return { fileId: 'fid', name, mimeType: 'application/pdf', modifiedTime: '2026-06-10T00:00:00Z', path: '' };
}

test('キーは <fileId>/<ファイル名> 形式になる', () => {
  expect(buildKey(file('report.pdf'))).toBe('fid/report.pdf');
});

test('export 時は拡張子を付与する', () => {
  expect(buildKey(file('売上集計'), 'csv')).toBe('fid/売上集計.csv');
});

test('ファイル名の / はキー階層を壊さないようサニタイズする', () => {
  expect(buildKey(file('2026/Q1 売上.pdf'))).toBe('fid/2026_Q1 売上.pdf');
});

test('export 時もファイル名の / をサニタイズしてから拡張子を付ける', () => {
  expect(buildKey(file('a/b/c'), 'pdf')).toBe('fid/a_b_c.pdf');
});
