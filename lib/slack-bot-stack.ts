import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { NAME_PREFIX, GENERATION_PROFILE_ID, GENERATION_MODEL_ID, RERANK_MODEL_ID } from './config';

// スタックのデプロイ時パラメータ(コアの KnowledgeBaseStack の出力を受け取る)
export interface SlackBotStackProps extends StackProps {
  readonly knowledgeBaseId: string;  // 検索対象の Knowledge Base ID
  readonly knowledgeBaseArn: string; // IAM 許可に使う KB の ARN
  readonly rerankEnabled: boolean;   // リランクの有効・無効(-c rerank 由来)
}

// =============================================================================
// Slack から Knowledge Base へ質問できる bot 一式(利用パターン 1 号)。
// 受信 Lambda(Function URL、3 秒制約内の応答)と応答 Lambda(KB 検索 + Slack 返信)
// の 2 段構成。コアとは独立に `cdk deploy SlackBotStack` で選択デプロイできる。
// =============================================================================
export class SlackBotStack extends Stack {
  constructor(scope: Construct, id: string, props: SlackBotStackProps) {
    super(scope, id, props);

    // --- Slack 認証情報(signingSecret / botToken)を保持する Secret ---
    // 箱だけ作成し、実際の値はデプロイ後に手動で投入する(SA キーと同じ運用)。
    const slackSecret = new secretsmanager.Secret(this, 'SlackSecret', {
      secretName: `${NAME_PREFIX}-slack-bot`,
      description: 'Slack bot の signingSecret / botToken(値はデプロイ後に手動投入)',
    });

    // 回答生成に使う推論プロファイル(日本ジオ CRIS)の ARN
    const profileArn =
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${GENERATION_PROFILE_ID}`;
    // リランクモデル(Cohere Rerank 3.5)の ARN。東京リージョン内で完結。
    const rerankModelArn =
      `arn:aws:bedrock:${this.region}::foundation-model/${RERANK_MODEL_ID}`;

    // --- 応答 Lambda(KB 検索 → 回答整形 → Slack 投稿) ---
    // 非同期起動の自動リトライは 0 に固定する(失敗時の二重投稿防止。
    // エラー通知はハンドラ内で 1 回だけ行う)。
    const workerFn = new lambdaNode.NodejsFunction(this, 'SlackWorkerFunction', {
      entry: path.join(__dirname, '../lambda/slack-bot/worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(60),
      memorySize: 512,
      retryAttempts: 0,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        GENERATION_PROFILE_ARN: profileArn,
        SLACK_SECRET_ARN: slackSecret.secretArn,
        RERANK_ENABLED: String(props.rerankEnabled),
        RERANK_MODEL_ARN: rerankModelArn,
      },
      bundling: { minify: true, target: 'node24' },
    });
    slackSecret.grantRead(workerFn);
    // KB の検索・回答生成を許可
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [props.knowledgeBaseArn],
    }));
    // 推論プロファイル経由のモデル呼び出しを許可。CRIS は東京⇔大阪へルーティング
    // されるため、基盤モデル側はリージョンをワイルドカードにする必要がある。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:GetInferenceProfile'],
      resources: [
        profileArn,
        `arn:aws:bedrock:*::foundation-model/${GENERATION_MODEL_ID}`,
      ],
    }));
    // リランク有効時のみ、呼び出し側にもリランクモデル呼び出し権限を付与する(最小権限)。
    if (props.rerankEnabled) {
      workerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:Rerank', 'bedrock:InvokeModel'],
        resources: [rerankModelArn],
      }));
    }

    // --- 受信 Lambda(署名検証 → 応答 Lambda の非同期起動) ---
    // 公開エンドポイントのため reserved concurrency で同時実行を絞り、
    // 万一の大量リクエスト時の課金上限を抑える。
    // 注意: 予約はアカウントの同時実行プールから確保される。新規アカウント等で
    // 同時実行クォータが小さいと unreserved 最低 100 を割ってデプロイに失敗しうる。
    const receiverFn = new lambdaNode.NodejsFunction(this, 'SlackReceiverFunction', {
      entry: path.join(__dirname, '../lambda/slack-bot/receiver.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environment: {
        WORKER_FUNCTION_NAME: workerFn.functionName,
        SLACK_SECRET_ARN: slackSecret.secretArn,
      },
      bundling: { minify: true, target: 'node24' },
    });
    slackSecret.grantRead(receiverFn);
    workerFn.grantInvoke(receiverFn);

    // --- Slack の Events Request URL になる Function URL(認可は署名検証で担保) ---
    const fnUrl = receiverFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // --- デプロイ後に参照する値を出力 ---
    new CfnOutput(this, 'SlackEventsUrl', { value: fnUrl.url });
    new CfnOutput(this, 'SlackSecretArn', { value: slackSecret.secretArn });
  }
}
