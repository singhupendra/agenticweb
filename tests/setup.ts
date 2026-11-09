// Global test setup: deterministic env, no network/DB access in unit tests.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.LOG_LEVEL = "error";
