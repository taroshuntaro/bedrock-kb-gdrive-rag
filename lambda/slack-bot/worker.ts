// =============================================================================
// Slack への応答ハンドラ(SDK 呼び出し層)。
// 受信 Lambda から非同期起動され、Knowledge Base の検索 + 回答生成
// (RetrieveAndGenerate)を実行して Slack に返信する。
// 非同期起動の自動リトライは 0 に設定するため、エラー通知はここで 1 回だけ行う。
// =============================================================================
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  BedrockAgentRuntimeClient, RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { formatAnswer } from './answer-format';

// 受信 Lambda から渡される処理依頼
export interface WorkerPayload {
  question: string;  // ユーザーの質問(メンション除去済み)
  channel: string;   // 返信先チャンネル(DM 含む)
  threadTs?: string; // スレッド返信する場合の thread_ts(DM では未指定)
}

// 回答生成プロンプト($search_results$ は KB が検索結果を埋め込むプレースホルダ)
const PROMPT_TEMPLATE = `あなたは Google Drive のドキュメントに基づいて質問に答えるアシスタントです。
以下の検索結果だけを根拠に、日本語で簡潔に回答してください。
検索結果に答えが無い場合は、推測せず「ナレッジベースに該当する情報が見つかりませんでした」と答えてください。

検索結果:
$search_results$
`;

// AWS SDK クライアント(コールドスタート時に 1 度だけ生成して再利用)
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const secrets = new SecretsManagerClient({ region });
const bedrock = new BedrockAgentRuntimeClient({ region });

// Slack bot token のキャッシュ(コールドスタート後は再利用)
let cachedBotToken: string | undefined;

// Secrets Manager から bot token を取得する(JSON の botToken キー)
async function getBotToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken;
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SLACK_SECRET_ARN! }));
  const json = JSON.parse(out.SecretString ?? '{}') as { botToken?: string };
  if (!json.botToken) throw new Error('Slack シークレットに botToken がありません');
  cachedBotToken = json.botToken;
  return json.botToken;
}

// Slack へメッセージを投稿する(threadTs があればスレッド返信)
async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${await getBotToken()}`,
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`chat.postMessage 失敗: ${data.error}`);
}

// KB を検索して回答を生成し、引用元の S3 URI 一覧と共に返す
async function queryKnowledgeBase(question: string): Promise<{ answer: string; s3Uris: string[] }> {
  const res = await bedrock.send(new RetrieveAndGenerateCommand({
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID!,
        modelArn: process.env.GENERATION_PROFILE_ARN!,
        generationConfiguration: {
          promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
        },
      },
    },
  }));
  // citations から引用元の S3 URI を抽出する(メッセージ整形は純ロジック側で行う)
  const s3Uris = (res.citations ?? [])
    .flatMap((c) => c.retrievedReferences ?? [])
    .map((r) => r.location?.s3Location?.uri)
    .filter((u): u is string => typeof u === 'string');
  return { answer: res.output?.text ?? '回答を生成できませんでした。', s3Uris };
}

// ハンドラ本体。失敗時はエラーメッセージを 1 回だけ投稿し、それも失敗したらログのみ。
export async function handler(event: WorkerPayload): Promise<void> {
  try {
    const { answer, s3Uris } = await queryKnowledgeBase(event.question);
    await postMessage(event.channel, formatAnswer(answer, s3Uris), event.threadTs);
  } catch (e) {
    console.error(`応答処理に失敗: ${(e as Error).message}`);
    try {
      await postMessage(event.channel, 'エラーが発生しました。時間をおいて再度お試しください。', event.threadTs);
    } catch (e2) {
      console.error(`エラーメッセージの投稿にも失敗: ${(e2 as Error).message}`);
    }
  }
}
