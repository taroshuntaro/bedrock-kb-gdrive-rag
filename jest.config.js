module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // ts-jest を transpile-only にして、node16 解決下での型チェックによる
    // メモリ枯渇(googleapis/aws-sdk の巨大な型グラフ)を回避する。
    // 型安全は別途 `npx tsc --noEmit` で担保する。
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
};
