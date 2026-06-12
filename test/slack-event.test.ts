import { decideEvent } from '../lambda/slack-bot/slack-event';

test('url_verification は challenge を返す', () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
  expect(decideEvent(body, undefined)).toEqual({ action: 'challenge', challenge: 'abc123' });
});

test('再送ヘッダ付きは無視する(二重応答防止)', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'app_mention', text: '<@U111> hi', channel: 'C1', ts: '1.0' },
  });
  expect(decideEvent(body, '1')).toMatchObject({ action: 'ignore' });
});

test('メンションはメンション文字列を除去してスレッド返信で回答する', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'app_mention', text: '<@U111> 経費精算の締め日は?', channel: 'C1', ts: '123.45' },
  });
  expect(decideEvent(body, undefined)).toEqual({
    action: 'answer', question: '経費精算の締め日は?', channel: 'C1', threadTs: '123.45',
  });
});

test('既存スレッド内のメンションは thread_ts を引き継ぐ', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'app_mention', text: '<@U111> 続き', channel: 'C1', ts: '2.0', thread_ts: '1.0' },
  });
  expect(decideEvent(body, undefined)).toMatchObject({ action: 'answer', threadTs: '1.0' });
});

test('DM はスレッドなしの通常返信で回答する', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'message', channel_type: 'im', text: '締め日は?', channel: 'D1', ts: '9.9' },
  });
  expect(decideEvent(body, undefined)).toEqual({ action: 'answer', question: '締め日は?', channel: 'D1' });
});

test('bot 自身の発言は無視する(ループ防止)', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'message', channel_type: 'im', text: '回答です', channel: 'D1', bot_id: 'B1' },
  });
  expect(decideEvent(body, undefined)).toMatchObject({ action: 'ignore' });
});

test('メンション除去後に質問が空なら無視する', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'app_mention', text: '<@U111>', channel: 'C1', ts: '1.0' },
  });
  expect(decideEvent(body, undefined)).toMatchObject({ action: 'ignore' });
});

test('壊れた JSON は無視する', () => {
  expect(decideEvent('not-json', undefined)).toMatchObject({ action: 'ignore' });
});

test('DM のサブタイプ付きメッセージ(編集等)は無視する', () => {
  const body = JSON.stringify({
    type: 'event_callback',
    event: { type: 'message', channel_type: 'im', text: '編集後', channel: 'D1', subtype: 'message_changed' },
  });
  expect(decideEvent(body, undefined)).toMatchObject({ action: 'ignore' });
});
