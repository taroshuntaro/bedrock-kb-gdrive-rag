import { google, drive_v3 } from 'googleapis';
import { resolveDownload } from './mime';

export interface RemoteFile {
  fileId: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  path: string; // フォルダ階層を '/' 連結したもの(末尾にファイル名は含めない)
}

export function createDrive(serviceAccountJson: string): drive_v3.Drive {
  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error(`サービスアカウント JSON のパースに失敗しました: ${(e as Error).message}`);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds as any,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// フォルダ配下を再帰列挙(サブフォルダも辿る)
export async function listFolderRecursive(
  drive: drive_v3.Drive,
  folderId: string,
  parentPath = '',
): Promise<RemoteFile[]> {
  const results: RemoteFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const childPath = parentPath ? `${parentPath}/${f.name}` : f.name!;
        results.push(...(await listFolderRecursive(drive, f.id!, childPath)));
      } else {
        results.push({
          fileId: f.id!,
          name: f.name!,
          mimeType: f.mimeType!,
          modifiedTime: f.modifiedTime ?? new Date(0).toISOString(),
          path: parentPath,
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return results;
}

// 1 ファイルをバイト列で取得(direct か export)
export async function fetchContent(
  drive: drive_v3.Drive,
  file: RemoteFile,
): Promise<{ body: Buffer; extension?: string } | null> {
  const plan = resolveDownload(file.mimeType);
  if (plan.mode === 'skip') return null;
  if (plan.mode === 'export') {
    const res = await drive.files.export(
      { fileId: file.fileId, mimeType: plan.exportMimeType },
      { responseType: 'arraybuffer' },
    );
    return { body: Buffer.from(res.data as unknown as ArrayBuffer), extension: plan.extension };
  }
  const res = await drive.files.get(
    { fileId: file.fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return { body: Buffer.from(res.data as unknown as ArrayBuffer) };
}

// S3 オブジェクトキー: fileId を起点に安定化。export 時は拡張子を付け替え。
export function buildKey(file: RemoteFile, extension?: string): string {
  const base = extension ? `${file.name}.${extension}` : file.name;
  return `${file.fileId}/${base}`;
}
