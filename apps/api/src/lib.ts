/**
 * Side-effect-free export surface of @tennis-manager/api — what other
 * apps (the worker) import to reuse the Drizzle adapters, schema, and
 * composition helpers. The server entry point is index.ts, which is
 * only ever executed directly (npm start), never imported: importing
 * THIS module must not open sockets or touch the database.
 */
export * as schema from './db/schema';
export { createDb, Db } from './db/client';
export { buildDependencies, CompositionOptions, Dependencies } from './composition';
export { buildApp, AppOptions } from './app';
export { DrizzlePlayerRepository } from './adapters/outbound/DrizzlePlayerRepository';
export { DrizzleTournamentRepository } from './adapters/outbound/DrizzleTournamentRepository';
export { DrizzleGameWorldRepository } from './adapters/outbound/DrizzleGameWorldRepository';
export { DrizzlePlayerRankingRepository } from './adapters/outbound/DrizzlePlayerRankingRepository';
export { DrizzleRosterDashboardQuery } from './adapters/outbound/DrizzleRosterDashboardQuery';
export { StripeBillingAdapter, StripeBillingConfig } from './adapters/outbound/StripeBillingAdapter';
export { FilesystemMatchLogStore } from './adapters/outbound/FilesystemMatchLogStore';
export { LoggingEventPublisher } from './adapters/outbound/LoggingEventPublisher';
export { MathRandomSource } from './adapters/outbound/MathRandomSource';
