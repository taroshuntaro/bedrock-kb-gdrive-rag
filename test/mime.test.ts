import { resolveDownload } from '../lambda/drive-sync/mime';

test('Google ドキュメントは PDF にエクスポート', () => {
  expect(resolveDownload('application/vnd.google-apps.document')).toEqual({
    mode: 'export', exportMimeType: 'application/pdf', extension: 'pdf',
  });
});

test('Google スプレッドシートは CSV にエクスポート', () => {
  expect(resolveDownload('application/vnd.google-apps.spreadsheet')).toEqual({
    mode: 'export', exportMimeType: 'text/csv', extension: 'csv',
  });
});

test('Google スライドは PDF にエクスポート', () => {
  expect(resolveDownload('application/vnd.google-apps.presentation')).toEqual({
    mode: 'export', exportMimeType: 'application/pdf', extension: 'pdf',
  });
});

test('通常の PDF はそのまま取得', () => {
  expect(resolveDownload('application/pdf')).toEqual({ mode: 'direct' });
});

test('Google フォルダなど未対応ネイティブ形式は skip', () => {
  expect(resolveDownload('application/vnd.google-apps.folder')).toEqual({ mode: 'skip' });
});
