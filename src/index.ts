/**
 * Kairo: the TypeScript backend framework with built-in AI model support.
 * https://github.com/BrowserlessAPI/kairo
 */
export { createApp } from "./app.ts";
export type { App, AppConfig, AuthConfig, CorsConfig, Middleware, MiddlewareContext, RequestOptions, RouteSource, Logger } from "./app.ts";

export { route, isRoute } from "./route.ts";
export type { Register, Context, RouteDef, RouteOptions, Auth, Method, ToolOptions, AppUser, AppDb } from "./route.ts";

export { t, Schema, ObjectSchema, ArraySchema, ValidationError, toJSONSchema } from "./schema.ts";
export type { Infer, InferInput, Issue, JSONSchema, ParseResult, Shape, AnySchema } from "./schema.ts";

export { model, Model, columnName } from "./model.ts";
export type { Row, CreateInput, UpdateInput, AnyModel } from "./model.ts";

export { memory } from "./db/memory.ts";
export { createDb, Table } from "./db/table.ts";
export type { Db, Where, OrderBy, FindManyOptions } from "./db/table.ts";
export type { Adapter, Condition, Query, DbRecord } from "./db/types.ts";
export { planMigration, applyMigrations } from "./db/migrate.ts";
export type { Migration, MigrationPlan, MigrationSnapshot } from "./db/migrate.ts";

export { createAI, cosineSimilarity, extractJson, openai, openaiCompatible, anthropic, gemini, ollama, mockProvider, ProviderError } from "./ai/index.ts";
export type { AI, AIConfig, GenerateOptions, GenerateResult, StreamResult, Usage, Pricing, Provider, ProviderRequest, Message } from "./ai/index.ts";

export { bearer, hashToken, createToken, hashPassword, verifyPassword, safeEqual } from "./auth.ts";
export { env, setEnv } from "./env.ts";
export { KairoError, httpError, notFound, forbidden, badRequest, docsUrl } from "./errors.ts";
export { serve } from "./serve.ts";
export { KAIRO_VERSION } from "./describe.ts";
export type { AppDescription } from "./describe.ts";
