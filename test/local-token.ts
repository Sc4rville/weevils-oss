// The local token every test file's weevils trusts (test/setup-env.ts configures server/http.ts with it).
export const TEST_LOCAL_TOKEN = '7e'.repeat(32)
/** The header a local caller (weevils-cli, weevils-update) sends. */
export const LOCAL = { 'x-weevils-local': TEST_LOCAL_TOKEN } as const
