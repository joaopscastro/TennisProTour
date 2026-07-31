import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Matches the docker-compose.yml Postgres at the repo root.
    url: process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager',
  },
});
