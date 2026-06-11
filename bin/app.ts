#!/usr/bin/env node
// =============================================================================
// CDK アプリのエントリポイント。
// CLI コンテキスト(-c)からパラメータを受け取り、KnowledgeBaseStack を生成する。
// =============================================================================
import { App } from 'aws-cdk-lib';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

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

// スタックを ap-northeast-1 に生成
new KnowledgeBaseStack(app, 'KnowledgeBaseStack', {
  env: { region: 'ap-northeast-1' },
  driveFolderId,
  scheduleRate,
  scheduleEnabled,
});
