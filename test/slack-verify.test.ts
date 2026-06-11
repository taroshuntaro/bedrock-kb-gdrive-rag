import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../lambda/slack-bot/slack-verify';

const SECRET = 'test-signing-secret';
const NOW = 1_700_000_000;

// テスト用に Slack と同じ方式で正しい署名を生成するヘルパ
function sign(body: string, timestamp: number): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

test('正しい署名と新しいタイムスタンプなら検証に成功する', () => {
  const body = '{"type":"event_callback"}';
  expect(verifySlackSignature({
    signingSecret: SECRET, body,
    timestamp: String(NOW), signature: sign(body, NOW), nowEpochSec: NOW,
  })).toEqual({ ok: true });
});

test('ボディが改ざんされていれば失敗する', () => {
  expect(verifySlackSignature({
    signingSecret: SECRET, body: 'tampered',
    timestamp: String(NOW), signature: sign('original', NOW), nowEpochSec: NOW,
  })).toEqual({ ok: false, reason: '署名不一致' });
});

test('タイムスタンプが 5 分より古ければ失敗する(リプレイ対策)', () => {
  const body = '{}';
  const old = NOW - 301;
  expect(verifySlackSignature({
    signingSecret: SECRET, body,
    timestamp: String(old), signature: sign(body, old), nowEpochSec: NOW,
  })).toEqual({ ok: false, reason: 'タイムスタンプが許容範囲外' });
});

test('署名ヘッダやタイムスタンプが欠けていれば失敗する', () => {
  expect(verifySlackSignature({
    signingSecret: SECRET, body: '{}',
    timestamp: undefined, signature: undefined, nowEpochSec: NOW,
  })).toEqual({ ok: false, reason: 'ヘッダ不足' });
});
