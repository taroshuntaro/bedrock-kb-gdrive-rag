import { shouldStartIngestion } from '../lambda/drive-sync/index';

test('差分があり実行中ジョブが無ければ起動する', () => {
  expect(shouldStartIngestion(true, [])).toBe(true);
});

test('差分が無ければ起動しない', () => {
  expect(shouldStartIngestion(false, [])).toBe(false);
});

test('実行中ジョブ(IN_PROGRESS)があれば起動しない', () => {
  expect(shouldStartIngestion(true, ['IN_PROGRESS'])).toBe(false);
});

test('STARTING のジョブがあれば起動しない', () => {
  expect(shouldStartIngestion(true, ['COMPLETE', 'STARTING'])).toBe(false);
});

test('完了済みジョブだけなら起動する', () => {
  expect(shouldStartIngestion(true, ['COMPLETE', 'FAILED'])).toBe(true);
});
