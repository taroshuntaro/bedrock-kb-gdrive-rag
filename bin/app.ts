#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

const app = new App();

const driveFolderId = app.node.tryGetContext('driveFolderId') ?? '';
const scheduleRate = app.node.tryGetContext('scheduleRate') ?? 'rate(1 day)';
const scheduleEnabled = String(app.node.tryGetContext('scheduleEnabled') ?? 'true') === 'true';

new KnowledgeBaseStack(app, 'KnowledgeBaseStack', {
  env: { region: 'ap-northeast-1' },
  driveFolderId,
  scheduleRate,
  scheduleEnabled,
});
