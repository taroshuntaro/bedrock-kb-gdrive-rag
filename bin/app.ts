#!/usr/bin/env node
// =============================================================================
// CDK アプリのエントリポイント。
// CLI コンテキスト(-c)からパラメータを受け取り、
// コアの KnowledgeBaseStack と利用パターンのスタックを生成する。
// =============================================================================
import { App } from 'aws-cdk-lib';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';
import { SlackBotStack } from '../lib/slack-bot-stack';

const app = new App();

// 同期対象の Drive フォルダ ID(必須。未指定ならデプロイを中止)
const driveFolderId = app.node.tryGetContext('driveFolderId') ?? '';
if (!driveFolderId) {
  throw new Error(
    'driveFolderId が未指定です。`-c driveFolderId=<DriveのフォルダID>` を付けて実行してください。',
  );
}
// 同期スケジュール(EventBridge の rate/cron 式)と有効・無効フラグ(任意)
const scheduleRate = app.node.tryGetContext('scheduleRate') ?? 'rate(1 day)';
const scheduleEnabled = String(app.node.tryGetContext('scheduleEnabled') ?? 'true') === 'true';
// リランクの有効・無効(任意・デフォルト有効)。SlackBotStack の検索精度に影響する。
const rerankEnabled = String(app.node.tryGetContext('rerank') ?? 'true') === 'true';

// スタックを ap-northeast-1 に生成
const kbStack = new KnowledgeBaseStack(app, 'KnowledgeBaseStack', {
  env: { region: 'ap-northeast-1' },
  driveFolderId,
  scheduleRate,
  scheduleEnabled,
});

// 利用パターン 1 号: Slack bot(使いたい利用者だけが `cdk deploy SlackBotStack` でデプロイする)
new SlackBotStack(app, 'SlackBotStack', {
  env: { region: 'ap-northeast-1' },
  knowledgeBaseId: kbStack.knowledgeBase.attrKnowledgeBaseId,
  knowledgeBaseArn: kbStack.knowledgeBase.attrKnowledgeBaseArn,
  rerankEnabled,
});
