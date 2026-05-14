import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const prerender = false;

const MAX_BYTES = 50 * 1024;
const MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = `You convert a raw .env file into three production-grade outputs for a TypeScript project: a Zod-validated env.ts module, a types-only .ts file, and a documented .env.example.

You receive .env content as plain text (KEY=VALUE lines plus possible # comments and blank lines). You return JSON only.

INFER TYPES from value shape AND key naming:
- Value looks like a URL (starts with http://, https://, postgres://, redis://, mysql://, mongodb://, smtp://, ws://, etc.) → \`z.string().url()\`
- Value is "true"/"false" (case-insensitive) OR key contains DEBUG / ENABLE / DISABLE / FEATURE / FLAG → \`z.coerce.boolean()\`
- Value is a bare integer or float OR key contains PORT / TIMEOUT / LIMIT / MAX / MIN / SIZE / COUNT / RETRIES → \`z.coerce.number().int().positive()\` (use .int() only when integer; drop .positive() if a negative is plausible)
- Value looks like JSON (\`{...}\` or \`[...]\`) → \`z.string().transform((s) => JSON.parse(s))\`
- Value or comment explicitly enumerates options (e.g. \`# one of: dev, staging, prod\`) → \`z.enum(["dev", "staging", "prod"])\`
- Otherwise → \`z.string()\`

SECRETS: if the key matches /KEY|SECRET|TOKEN|PASSWORD|API|PRIVATE/i, add \`.min(1)\` to its schema. In the .env.example file, do NOT echo the secret-shaped value — replace with a placeholder like \`<your-stripe-secret-key>\` (lowercased, words derived from the key). Non-secret values may keep a redacted-but-realistic example (e.g. \`postgres://user:pass@localhost:5432/dbname\` for DATABASE_URL).

GROUPING: detect service prefix from the key (STRIPE_*, DATABASE_* / DB_* / POSTGRES_*, AUTH_* / NEXTAUTH_*, NEXT_PUBLIC_*, AWS_*, REDIS_*, SMTP_* / EMAIL_*, SENTRY_*, etc.). Group keys with the same prefix together in all three outputs, with a comment header. In env.ts and types.ts use \`// [Service]\` comments inside the object literal. In .env.example use \`# [Service]\` section headers.

DESCRIPTIONS: for every key, write a one-line trailing comment explaining what it's for (inferred from the key name + value shape). Keep comments terse; one short sentence. Examples:
- DATABASE_URL=... → \`// Postgres connection string (driver://user:pass@host:port/dbname).\`
- STRIPE_WEBHOOK_SECRET=... → \`// Stripe webhook signing secret — verify event payloads.\`
- PORT=... → \`// HTTP port the server binds to.\`

REQUIRED vs OPTIONAL: by default required. Mark optional via \`.optional()\` only if (a) the input line has an inline or preceding \`# optional\` comment, or (b) the value is empty (e.g. \`FOO=\`). For boolean / number values where a default is reasonable, you MAY add \`.default(...)\` (e.g. PORT → \`.default(8080)\`, DEBUG → \`.default(false)\`).

OUTPUT 1 — \`schema\` (env.ts):
- Starts with \`import { z } from "zod";\`
- Then \`const EnvSchema = z.object({ ... });\` with grouped + commented keys
- Then \`export const env = EnvSchema.parse(process.env);\`
- Then \`export type Env = z.infer<typeof EnvSchema>;\`
- One trailing newline only

OUTPUT 2 — \`types\` (types-only .ts):
- Pure \`export type Env = { ... }\` declaration with grouped + commented keys, no Zod, no runtime
- Inline comments on each field (same wording as schema where possible)
- TypeScript primitive types: \`string\`, \`number\`, \`boolean\`, or specific union literals for enums. JSON-shaped values become \`unknown\` (or a richer type if obvious from the value).
- One trailing newline only

OUTPUT 3 — \`example\` (.env.example):
- Same keys in the same order as the input
- Section comment headers like \`# [Stripe]\` before each group
- Per-key trailing comment matching the description in schema/types
- Secret-shaped keys → placeholder like \`<your-stripe-secret-key>\` (no real-looking value)
- Non-secret keys → a generic example value (e.g. \`postgres://user:pass@localhost:5432/dbname\`, \`8080\`, \`true\`)
- Preserve any \`# free-text comment\` blocks the user wrote, repositioned with their related key

OUTPUT FORMAT: JSON only. No markdown fences. No commentary outside the JSON. Exact shape:
{"schema": "<env.ts source as a single string>", "types": "<types-only .ts source as a single string>", "example": "<.env.example source as a single string>"}

Each string must be valid file contents (real newlines encoded as \\n inside the JSON). No \`any\`. No leading explanation. Output nothing but the JSON object.`;

type Out = { schema: string; types: string; example: string };

export const POST: APIRoute = async ({ request }) => {
  return await respond(await parseRequest(request));
};

async function parseRequest(request: Request): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; env: string; ip: string }
> {
  const ip = getClientIp(request.headers);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, status: 400, error: 'Body must be JSON.' };
  }
  if (!body || typeof body !== 'object' || typeof (body as any).env !== 'string') {
    return { ok: false, status: 400, error: 'Expected {"env": "<.env content as string>"}.' };
  }
  const env = (body as any).env as string;
  const bytes = new TextEncoder().encode(env).length;
  if (bytes === 0) return { ok: false, status: 400, error: '.env input is empty.' };
  if (bytes > MAX_BYTES) {
    return { ok: false, status: 413, error: `.env exceeds 50 KB (${bytes} bytes).` };
  }
  if (!env.includes('=')) {
    return { ok: false, status: 400, error: 'No KEY=VALUE lines found — does this look like a .env file?' };
  }
  return { ok: true, env, ip };
}

async function respond(
  parsed:
    | { ok: false; status: number; error: string }
    | { ok: true; env: string; ip: string },
): Promise<Response> {
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }
  const rl = rateLimit(parsed.ip);
  if (!rl.ok) {
    const mins = Math.ceil(rl.resetIn / 60000);
    return Response.json(
      { error: `You've hit 20 generations / hour. Try again in ~${mins}m.` },
      { status: 429 },
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC;
  if (!apiKey) {
    return Response.json(
      { error: 'Server misconfigured: ANTHROPIC key missing.' },
      { status: 500 },
    );
  }
  try {
    const out = await runClaude(apiKey, parsed.env);
    return Response.json(out, {
      headers: { 'x-ratelimit-remaining': String(rl.remaining) },
    });
  } catch (e: any) {
    const msg = e?.message || 'LLM call failed';
    return Response.json({ error: msg }, { status: 502 });
  }
}

async function runClaude(apiKey: string, env: string): Promise<Out> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: '.env content:\n\n```\n' + env + '\n```\n\nReturn only the JSON object as specified.',
      },
    ],
  });
  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in model response.');
  }
  const raw = textBlock.text.trim();
  const parsed = extractJson(raw);
  if (
    !parsed ||
    typeof parsed.schema !== 'string' ||
    typeof parsed.types !== 'string' ||
    typeof parsed.example !== 'string'
  ) {
    throw new Error('Model returned malformed payload.');
  }
  return {
    schema: parsed.schema.trim(),
    types: parsed.types.trim(),
    example: parsed.example.trim(),
  };
}

function extractJson(text: string): { schema?: unknown; types?: unknown; example?: unknown } | null {
  // Tolerate ```json fences even though we tell the model not to use them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Last-ditch: find first { and last }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
