# dotenv2types

**Paste a `.env` → typed `env.ts` with Zod schema + `.env.example` with comments. No signup. LLM-named.**

Live: **https://dotenv2types.vercel.app/**

Stop writing the same 30-line Zod schema every time you start a new
TypeScript project. Paste your raw `.env`, get back three files:

- **`env.ts`** — Zod schema + `EnvSchema.parse(process.env)` + inferred `Env` type
- **`types.ts`** — types-only `Env` shape (use this if you don't want Zod)
- **`.env.example`** — same keys with placeholder values and AI-written comments,
  grouped by service (`# [Stripe]`, `# [Database]`, …)

Type inference is value-shape + key-name driven: URLs become `z.string().url()`,
`true`/`false` becomes `z.coerce.boolean()`, ports/timeouts become
`z.coerce.number().int().positive()`, keys with `KEY|SECRET|TOKEN|PASSWORD`
get `.min(1)` and a `<your-placeholder>` in `.env.example`.

## Examples

### 1. Basic — server config

Input:

```env
DATABASE_URL=postgres://localhost/db
PORT=8080
DEBUG=true
```

Output `env.ts`:

```ts
import { z } from "zod";

const EnvSchema = z.object({
  // [Database]
  DATABASE_URL: z.string().url(), // Postgres connection string.
  // [Server]
  PORT: z.coerce.number().int().positive().default(8080), // HTTP port the server binds to.
  DEBUG: z.coerce.boolean().default(false),               // Enable verbose logs.
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
```

### 2. Mixed — Stripe + JSON feature flags

Input:

```env
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_SECRET_KEY=sk_test_xxx
FEATURE_FLAGS={"darkMode":true,"beta":false}
```

Output `.env.example`:

```env
# [Stripe]
STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxx          # Stripe publishable key — safe to ship to clients.
STRIPE_SECRET_KEY=<your-stripe-secret-key>           # Stripe secret key — server-only, never expose.

# [Feature flags]
FEATURE_FLAGS={"darkMode":false,"beta":false}        # JSON blob of feature toggles.
```

### 3. Commented .env — comments preserved

Input:

```env
# Database connection
DATABASE_URL=postgres://localhost/db

# Server config
PORT=8080
# Set true to enable verbose logs
DEBUG=false
```

Output `types.ts`:

```ts
export type Env = {
  // [Database]
  DATABASE_URL: string;   // Postgres connection string.
  // [Server]
  PORT: number;           // HTTP port the server binds to.
  DEBUG: boolean;         // Enable verbose logs.
};
```

## How it works

Astro + Vercel serverless. Your `.env` goes to a Claude Haiku 4.5 endpoint
that runs a single inference and returns `{schema, types, example}`. Nothing
is stored. 20 generations / hour / IP, 50 KB max per request.

## Why not just write the Zod schema by hand?

You can. Most people don't. The 30-key Zod schema is the chore that gets
deferred to "later" — by then the codebase is full of `process.env.X!`
non-null assertions and the day something goes missing in production
you spend an hour debugging the wrong key. dotenv2types is the
five-second version of doing it right on day one.

## Sister project

[**jsontosdk**](https://github.com/SolvoHQ/jsontosdk) — paste a JSON sample,
get production-ready TypeScript interfaces + a Zod schema. Same wedge shape,
different input.

## License

MIT — see [LICENSE](./LICENSE).
