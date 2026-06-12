import { formatAnswer } from '../lambda/slack-bot/answer-format';

test('参照元を Drive リンク付きで回答末尾に並べる', () => {
  const out = formatAnswer('回答本文', ['s3://bucket/FILE1/規程.pdf']);
  expect(out).toBe('回答本文\n\n*参照元*\n• <https://drive.google.com/file/d/FILE1/view|規程.pdf>');
});

test('同じファイルの引用は 1 件にまとめる', () => {
  const out = formatAnswer('A', ['s3://b/F1/a.pdf', 's3://b/F1/a.pdf', 's3://b/F2/b.csv']);
  expect(out).toContain('file/d/F1/');
  expect(out).toContain('file/d/F2/');
  expect(out.split('•')).toHaveLength(3); // 箇条書きは 2 件
});

test('参照元は最大 5 件まで', () => {
  const uris = Array.from({ length: 7 }, (_, i) => `s3://b/F${i}/f${i}.pdf`);
  const out = formatAnswer('A', uris);
  expect(out.split('•')).toHaveLength(6); // 箇条書きは 5 件
});

test('参照元が無ければ本文のみを返す', () => {
  expect(formatAnswer('本文', [])).toBe('本文');
});

test('キー階層を持たない不正な S3 URI は読み飛ばす', () => {
  expect(formatAnswer('本文', ['s3://bucket-only'])).toBe('本文');
});
