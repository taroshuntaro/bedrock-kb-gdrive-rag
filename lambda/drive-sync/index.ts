// =============================================================================
// Drive → S3 同期 Lambda のエントリポイント。
// 1. Secret からサービスアカウント鍵を取得し Drive を列挙
// 2. S3 の現状と突き合わせて差分を算出
// 3. アップロード/削除を反映
// 4. 実反映があり、かつ実行中ジョブが無ければ Bedrock の ingestion を起動
// =============================================================================
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  BedrockAgentClient, StartIngestionJobCommand, ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { createDrive, listFolderRecursive, fetchContent, buildKey } from './drive-client';
import { resolveDownload } from './mime';
import { diffSync, runUploads, DriveEntry, S3Entry } from './s3-sync';

// 「実行中」とみなす ingestion ジョブのステータス(二重起動防止に使用)
const ACTIVE_STATUSES = ['STARTING', 'IN_PROGRESS'];
const ACTIVE_STATUS_SET = new Set(ACTIVE_STATUSES);

// ガード: 差分があり、実行中(STARTING/IN_PROGRESS)ジョブが無い時のみ true
export function shouldStartIngestion(hasChanges: boolean, jobStatuses: string[]): boolean {
  if (!hasChanges) return false;
  return !jobStatuses.some((s) => ACTIVE_STATUS_SET.has(s));
}

// AWS SDK クライアント(コールドスタート時に 1 度だけ生成して再利用)
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const s3 = new S3Client({ region });
const bedrock = new BedrockAgentClient({ region });
const secrets = new SecretsManagerClient({ region });

// S3 オブジェクトに Drive の更新時刻を保存するメタデータキー(差分判定に使用)
const MODIFIED_META = 'drive-modified-time';

// Secrets Manager からサービスアカウント JSON 文字列を取得する
async function getServiceAccountJson(secretArn: string): Promise<string> {
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!out.SecretString) throw new Error('SA シークレットが空です');
  return out.SecretString;
}

// バケット内の全オブジェクトをページングしながら列挙し、各オブジェクトの
// メタデータから Drive 更新時刻を取り出して S3Entry の一覧を組み立てる
async function listS3(bucket: string): Promise<S3Entry[]> {
  const entries: S3Entry[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: o.Key! }));
      entries.push({ key: o.Key!, modifiedTime: head.Metadata?.[MODIFIED_META] ?? '1970-01-01T00:00:00Z' });
    }
    token = res.NextContinuationToken;
  } while (token);
  return entries;
}

// Lambda ハンドラ本体。Drive と S3 を同期し、必要なら ingestion を起動する。
export async function handler(): Promise<{ uploaded: number; deleted: number; failed: number; ingestion: boolean }> {
  // 実行に必要な設定はすべて環境変数(CDK スタックで注入)から取得
  const bucket = process.env.DOCS_BUCKET!;
  const folderId = process.env.DRIVE_FOLDER_ID!;
  const kbId = process.env.KNOWLEDGE_BASE_ID!;
  const dataSourceId = process.env.DATA_SOURCE_ID!;
  const secretArn = process.env.SA_SECRET_ARN!;

  // Drive クライアントを生成し、対象フォルダ配下を再帰列挙
  const drive = createDrive(await getServiceAccountJson(secretArn));
  const remote = await listFolderRecursive(drive, folderId);

  // Drive 側の想定 S3 キー一覧(skip 対象は除外、export は拡張子付与)
  const driveEntries: DriveEntry[] = [];
  for (const f of remote) {
    const plan = resolveDownload(f.mimeType);
    if (plan.mode === 'skip') continue;
    const ext = plan.mode === 'export' ? plan.extension : undefined;
    driveEntries.push({ fileId: f.fileId, key: buildKey(f, ext), modifiedTime: f.modifiedTime });
  }

  // S3 の現状を取得し、Drive 側の想定一覧と突き合わせて差分を算出
  const s3Entries = await listS3(bucket);
  const diff = diffSync(driveEntries, s3Entries);

  // アップロード(1 件の失敗で全体を止めず、後続を継続して失敗を記録する)
  const upload = await runUploads(diff.uploads, async (up) => {
    const file = remote.find((r) => r.fileId === up.fileId)!;
    const content = await fetchContent(drive, file);
    if (!content) return false;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: up.key, Body: content.body,
      Metadata: { [MODIFIED_META]: up.modifiedTime, 'drive-file-id': file.fileId, 'drive-path': encodeURIComponent(file.path) },
    }));
    return true;
  });
  for (const f of upload.failures) {
    console.error(`アップロード失敗: key=${f.key} fileId=${f.fileId} error=${f.error}`);
  }

  // 削除(個別にエラー隔離。1 件の失敗で ingestion をブロックしない)
  let deleted = 0;
  for (const key of diff.deletes) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      deleted += 1;
    } catch (e) {
      console.error(`削除失敗: key=${key} error=${(e as Error).message}`);
    }
  }

  // 実際に S3 へ反映できた変更だけを ingestion 起動の根拠にする
  const hasChanges = upload.uploaded > 0 || deleted > 0;

  // ingestion ガード: アクティブ(STARTING/IN_PROGRESS)ジョブのみを絞り込み取得。
  // STATUS フィルタは複数値を OR で扱うため、履歴が増えても定数コストで判定できる。
  const statuses: string[] = [];
  let jobToken: string | undefined;
  do {
    const jobs = await bedrock.send(new ListIngestionJobsCommand({
      knowledgeBaseId: kbId, dataSourceId, nextToken: jobToken,
      filters: [{ attribute: 'STATUS', operator: 'EQ', values: ACTIVE_STATUSES }],
    }));
    for (const j of jobs.ingestionJobSummaries ?? []) {
      statuses.push(j.status as string);
    }
    jobToken = jobs.nextToken;
  } while (jobToken);
  let ingestion = false;
  if (shouldStartIngestion(hasChanges, statuses)) {
    await bedrock.send(new StartIngestionJobCommand({ knowledgeBaseId: kbId, dataSourceId }));
    ingestion = true;
  }
  return { uploaded: upload.uploaded, deleted, failed: upload.failures.length, ingestion };
}
