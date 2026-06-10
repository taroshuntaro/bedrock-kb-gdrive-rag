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
