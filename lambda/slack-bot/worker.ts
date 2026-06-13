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
import type { KnowledgeBaseRetrievalConfiguration } from '@aws-sdk/client-bedrock-agent-runtime';
import { formatAnswer } from './answer-format';

// 受信 Lambda から渡される処理依頼
export interface WorkerPayload {
  question: string;  // ユーザーの質問(メンション除去済み)
  channel: string;   // 返信先チャンネル(DM 含む)
  threadTs?: string; // スレッド返信する場合の thread_ts(DM では未指定)
}

// 回答生成プロンプト。RAG のベストプラクティスに沿った構成:
// 1. 長文コンテキスト($search_results$)を上部・指示を下部に置き、Claude が根拠を参照しやすくする
// 2. <search_results> / <instructions> の XML タグで境界を明確化(Claude はタグ境界を強く認識する)
// 3. 検索結果のみを根拠とし推測を禁じてハルシネーションを抑制
// 4. 出力を Slack mrkdwn に最適化(## 見出し禁止・強調は * 1つ・箇条書きは • / -)し表示崩れを防ぐ
// $search_results$ は KB が検索結果を埋め込むプレースホルダ。
// $output_format_instructions$ は引用マーカーの出力指示が展開されるプレースホルダで、
// これが無いと citations の retrievedReferences が空になり参照元の Drive リンクを組み立てられない。
export const PROMPT_TEMPLATE = `あなたは Google Drive 上の社内ドキュメントに基づいて質問に答えるアシスタントです。
以下の検索結果だけを根拠に、日本語で回答してください。

<search_results>
$search_results$
</search_results>

<instructions>
根拠の扱い:
- 検索結果に書かれている内容だけを根拠にしてください。検索結果に無い情報は推測・補完せず、含めないでください。
- 検索結果に答えが含まれていない場合は、「ナレッジベースに該当する情報が見つかりませんでした」とだけ答えてください。

回答スタイル:
- 結論・要点を先に述べ、必要に応じて箇条書きで整理してください。
- 手順や段階があるものは番号付きで示してください。
- 中程度の詳しさにとどめ、冗長な前置きや繰り返しは避けてください。

書式(Slack 表示用。通常の Markdown とは異なります):
- 見出し記法(# や ##)は使わないでください。
- 強調したい語は *語* のようにアスタリスク1つで囲んでください(**語** は使わない)。
- 箇条書きの行頭は「• 」または「- 」を使ってください。
- ファイル名・コード・専門用語は \`バッククォート\` で囲んでください。
</instructions>

$output_format_instructions$
`;

// 検索取得件数(チャンクが 300 トークンと小さいため文脈量を確保する)
// リランク無効時: 素のベクトル類似度順をそのまま生成へ渡す
const RETRIEVAL_RESULTS = 8;
// リランク有効時: 多めに取得(RERANK_FETCH_RESULTS)→ リランクで上位(RERANK_TOP_N)に絞る
const RERANK_FETCH_RESULTS = 20;
const RERANK_TOP_N = 8;

// rerankEnabled に応じて KB の検索設定を組み立てる純関数(副作用なし=モック不要でテスト可能)。
// 無効時は取得件数のみ、有効時は多めに取得して Cohere リランカーで上位に絞る設定を返す。
export function buildRetrievalConfiguration(
  rerankEnabled: boolean,
  rerankModelArn: string,
): KnowledgeBaseRetrievalConfiguration {
  // 無効時: 取得件数のみ指定(リランク設定は付けない)
  if (!rerankEnabled) {
    return { vectorSearchConfiguration: { numberOfResults: RETRIEVAL_RESULTS } };
  }
  // 有効時: 多めに取得 → Cohere Rerank で numberOfRerankedResults 件に絞る
  return {
    vectorSearchConfiguration: {
      numberOfResults: RERANK_FETCH_RESULTS,
      rerankingConfiguration: {
        type: 'BEDROCK_RERANKING_MODEL',
        bedrockRerankingConfiguration: {
          numberOfRerankedResults: RERANK_TOP_N,
          modelConfiguration: { modelArn: rerankModelArn },
        },
      },
    },
  };
}

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
  // Slack 障害時の 5xx は非 JSON ボディのことがあるため、JSON 解析前に HTTP エラーを弾く
  if (!res.ok) throw new Error(`Slack API HTTP エラー: ${res.status}`);
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
