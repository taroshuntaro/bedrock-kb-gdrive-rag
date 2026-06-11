// =============================================================================
// Slack リクエストの署名検証を行う純ロジック層。
// HMAC-SHA256 による署名比較に加え、タイムスタンプの新しさを確認して
// リプレイ攻撃を防ぐ。SDK 呼び出しは一切含まない。
// =============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';

// 検証結果(失敗時は理由を持つ)
export type VerifyResult = { ok: true } | { ok: false; reason: string };

// 許容する時刻ずれ(秒)。これを超えるリクエストはリプレイ攻撃とみなす
const MAX_CLOCK_SKEW_SEC = 300;

// Slack の署名仕様(v0)に従い、リクエストの正当性を検証する
export function verifySlackSignature(params: {
  signingSecret: string;          // Slack アプリの signing secret
  body: string;                   // 生のリクエストボディ(JSON 解析前)
  timestamp: string | undefined;  // x-slack-request-timestamp ヘッダ
  signature: string | undefined;  // x-slack-signature ヘッダ
  nowEpochSec?: number;           // テスト用に現在時刻(epoch 秒)を注入可能
}): VerifyResult {
  const { signingSecret, body, timestamp, signature } = params;
  // 必須ヘッダの存在チェック
  if (!timestamp || !signature) return { ok: false, reason: 'ヘッダ不足' };
  // タイムスタンプ窓チェック(±5 分)
  const now = params.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'タイムスタンプが許容範囲外' };
  }
  // HMAC-SHA256 で署名を再計算して比較(タイミング攻撃対策に timingSafeEqual を使う)
  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: '署名不一致' };
  }
  return { ok: true };
}
