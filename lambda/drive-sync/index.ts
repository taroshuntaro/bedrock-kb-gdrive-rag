import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  BedrockAgentClient, StartIngestionJobCommand, ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { createDrive, listFolderRecursive, fetchContent, buildKey } from './drive-client';
import { resolveDownload } from './mime';
import { diffSync, DriveEntry, S3Entry } from './s3-sync';

const ACTIVE_STATUSES = new Set(['STARTING', 'IN_PROGRESS']);

// ガード: 差分があり、実行中(STARTING/IN_PROGRESS)ジョブが無い時のみ true
export function shouldStartIngestion(hasChanges: boolean, jobStatuses: string[]): boolean {
  if (!hasChanges) return false;
  return !jobStatuses.some((s) => ACTIVE_STATUSES.has(s));
}

const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const s3 = new S3Client({ region });
const bedrock = new BedrockAgentClient({ region });
const secrets = new SecretsManagerClient({ region });

const MODIFIED_META = 'drive-modified-time';

async function getServiceAccountJson(secretArn: string): Promise<string> {
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!out.SecretString) throw new Error('SA シークレットが空です');
  return out.SecretString;
}

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

export async function handler(): Promise<{ uploaded: number; deleted: number; ingestion: boolean }> {
  const bucket = process.env.DOCS_BUCKET!;
  const folderId = process.env.DRIVE_FOLDER_ID!;
  const kbId = process.env.KNOWLEDGE_BASE_ID!;
  const dataSourceId = process.env.DATA_SOURCE_ID!;
  const secretArn = process.env.SA_SECRET_ARN!;

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

  const s3Entries = await listS3(bucket);
  const diff = diffSync(driveEntries, s3Entries);

  // アップロード
  for (const up of diff.uploads) {
    const file = remote.find((r) => r.fileId === up.fileId)!;
    const content = await fetchContent(drive, file);
    if (!content) continue;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: up.key, Body: content.body,
      Metadata: { [MODIFIED_META]: up.modifiedTime, 'drive-file-id': file.fileId, 'drive-path': file.path },
    }));
  }
  // 削除
  for (const key of diff.deletes) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  // ingestion ガード(全ページのジョブ状態を収集)
  const statuses: string[] = [];
  let jobToken: string | undefined;
  do {
    const jobs = await bedrock.send(new ListIngestionJobsCommand({
      knowledgeBaseId: kbId, dataSourceId, nextToken: jobToken,
    }));
    for (const j of jobs.ingestionJobSummaries ?? []) {
      statuses.push(j.status as string);
    }
    jobToken = jobs.nextToken;
  } while (jobToken);
  let ingestion = false;
  if (shouldStartIngestion(diff.hasChanges, statuses)) {
    await bedrock.send(new StartIngestionJobCommand({ knowledgeBaseId: kbId, dataSourceId }));
    ingestion = true;
  }
  return { uploaded: diff.uploads.length, deleted: diff.deletes.length, ingestion };
}
