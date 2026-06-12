// =============================================================================
// Slack Events API の受信ハンドラ(SDK 呼び出し層)。
// 署名検証 → イベント判定(純ロジック)→ 応答 Lambda の非同期起動だけを行い、
// Slack の 3 秒制約内に必ず応答を返す。重い処理は worker.ts に委譲する。
// 再送はすべて弾く方針のため、起動失敗時も 500 にせずログのみで 200 を返す。
// なおシークレット取得失敗時は 500 を返し、Slack の再送を自然な回復手段として使う。
// =============================================================================
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { verifySlackSignature } from './slack-verify';
import { decideEvent } from './slack-event';
import type { WorkerPayload } from './worker';

// Lambda Function URL(payload v2.0)のイベントのうち、本処理で使う部分だけの型
interface FunctionUrlEvent {
  headers: Record<string, string | undefined>; // ヘッダ名は小文字に正規化されている
  body?: string;
  isBase64Encoded?: boolean;
}

// Function URL へ返す HTTP レスポンス
interface HttpResponse {
  statusCode: number;
  body?: string;
}

// AWS SDK クライアント(コールドスタート時に 1 度だけ生成して再利用)
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const secrets = new SecretsManagerClient({ region });
const lambdaClient = new LambdaClient({ region });

// signing secret のキャッシュ(コールドスタート後は再利用)
let cachedSigningSecret: string | undefined;

// Secrets Manager から signing secret を取得する(JSON の signingSecret キー)
async function getSigningSecret(): Promise<string> {
  if (cachedSigningSecret) return cachedSigningSecret;
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SLACK_SECRET_ARN! }));
  const json = JSON.parse(out.SecretString ?? '{}') as { signingSecret?: string };
  if (!json.signingSecret) throw new Error('Slack シークレットに signingSecret がありません');
  cachedSigningSecret = json.signingSecret;
  return json.signingSecret;
}

// ハンドラ本体。3 秒制約内に必ず 200/401 を返す。
export async function handler(event: FunctionUrlEvent): Promise<HttpResponse> {
  // 生ボディを復元する(署名検証は加工前のボディに対して行う必要がある)
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  // 署名検証(HMAC + タイムスタンプ窓)。NG は 401 で終了
  const verify = verifySlackSignature({
    signingSecret: await getSigningSecret(),
    body,
    timestamp: event.headers['x-slack-request-timestamp'],
    signature: event.headers['x-slack-signature'],
  });
  if (!verify.ok) {
    console.warn(`署名検証 NG: ${verify.reason}`);
    return { statusCode: 401 };
  }

  // イベント判定(challenge / 無視 / 回答)
  const decision = decideEvent(body, event.headers['x-slack-retry-num']);
  // challenge は JSON でラップして返す(Function URL のデフォルト Content-Type が
  // application/json のため、生文字列ではなく JSON 形式に整合させる)
  if (decision.action === 'challenge') {
    return { statusCode: 200, body: JSON.stringify({ challenge: decision.challenge }) };
  }
  if (decision.action === 'ignore') {
    console.log(`無視: ${decision.reason}`);
    return { statusCode: 200 };
  }

  // 応答 Lambda を非同期起動(失敗してもログのみ。既知の制約として無応答になりうる)
  const payload: WorkerPayload = {
    question: decision.question,
    channel: decision.channel,
    threadTs: decision.threadTs,
  };
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.WORKER_FUNCTION_NAME!,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }));
  } catch (e) {
    console.error(`応答 Lambda の起動失敗: ${(e as Error).message}`);
  }
  return { statusCode: 200 };
}
