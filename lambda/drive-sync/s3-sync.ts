export interface DriveEntry {
  fileId: string;
  key: string;
  modifiedTime: string; // ISO8601
}
export interface S3Entry {
  key: string;
  modifiedTime: string; // S3 メタデータに保存した Drive の modifiedTime
}
export interface SyncDiff {
  uploads: DriveEntry[];
  deletes: string[];
  hasChanges: boolean;
}

export function diffSync(drive: DriveEntry[], s3: S3Entry[]): SyncDiff {
  const s3ByKey = new Map(s3.map((e) => [e.key, e]));
  const uploads: DriveEntry[] = [];
  for (const d of drive) {
    const existing = s3ByKey.get(d.key);
    if (!existing || Date.parse(d.modifiedTime) > Date.parse(existing.modifiedTime)) {
      uploads.push(d);
    }
  }
  const driveKeys = new Set(drive.map((d) => d.key));
  const deletes = s3.map((e) => e.key).filter((k) => !driveKeys.has(k));
  return { uploads, deletes, hasChanges: uploads.length > 0 || deletes.length > 0 };
}

export interface UploadOutcome {
  uploaded: number; // 実際にアップロードした件数
  skipped: number; // コンテンツが取得できず転送しなかった件数
  failures: { fileId: string; key: string; error: string }[];
}

// 各アップロードをエラー隔離しながら実行する。
// 1 件の失敗(例: export 上限超過)で全体を止めず、後続を継続して失敗を記録する。
// uploadOne は転送したら true、コンテンツ無しでスキップしたら false を返す。
export async function runUploads(
  uploads: DriveEntry[],
  uploadOne: (entry: DriveEntry) => Promise<boolean>,
): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { uploaded: 0, skipped: 0, failures: [] };
  for (const up of uploads) {
    try {
      if (await uploadOne(up)) outcome.uploaded += 1;
      else outcome.skipped += 1;
    } catch (e) {
      outcome.failures.push({ fileId: up.fileId, key: up.key, error: (e as Error).message });
    }
  }
  return outcome;
}
