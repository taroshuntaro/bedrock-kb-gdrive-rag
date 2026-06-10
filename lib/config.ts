export const REGION = 'ap-northeast-1';
export const NAME_PREFIX = 'bedrock-kb-gdrive';

export const EMBEDDING_MODEL_ARN =
  `arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0`;
export const EMBEDDING_DIMENSION = 1024;
export const VECTOR_DATA_TYPE = 'float32';
export const VECTOR_DISTANCE_METRIC = 'cosine';

export const CHUNK_MAX_TOKENS = 300;
export const CHUNK_OVERLAP_PERCENT = 20;

// Bedrock KB が S3 Vectors に書き込む本文系メタデータキー(フィルタ非対象にする)
export const NON_FILTERABLE_METADATA_KEYS = [
  'AMAZON_BEDROCK_TEXT',
  'AMAZON_BEDROCK_METADATA',
];

export const DEFAULT_SCHEDULE_RATE = 'rate(1 day)';
