#!/usr/bin/env node
import { readFileSync } from 'node:fs';

try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch {
  // .env is optional; users may export variables instead.
}

const {
  jevBackendName,
  jevConfigured,
  judgeCommenters,
  judgeEntityCandidates,
  judgePosts,
} = await import('./lib/jev.mjs');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') args.input = argv[++i];
    else if (arg === '--profiles') args.profiles = argv[++i];
    else if (arg === '--query') args.query = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args._.push(arg);
  }
  return args;
}

function readJson(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function asText(value) {
  return typeof value === 'string' ? value : String(value?.text ?? '');
}

function normalizeAccounts(data) {
  const rows = Array.isArray(data) ? data : data.accounts;
  if (!Array.isArray(rows)) throw new Error('input must be an array or {accounts:[...]}');
  return rows.map((row) => {
    const comments = Array.isArray(row.comments) ? row.comments : [];
    return {
      username: String(row.username ?? ''),
      full_name: row.full_name ?? null,
      comment_text:
        row.comment_text ??
        comments.map(asText).filter(Boolean).join('\n') ??
        '',
      posts: (row.posts ?? []).map((post) =>
        typeof post === 'string' ? { text: post } : { ...post, text: asText(post) },
      ),
    };
  });
}

function normalizePosts(data) {
  const rows = Array.isArray(data) ? data : data.posts;
  if (!Array.isArray(rows)) throw new Error('input must be an array or {posts:[...]}');
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || !command) {
    console.log(`Usage:
  node scripts/jev.mjs status
  node scripts/jev.mjs accounts --input out/accounts.json --query "洗面奶"
  node scripts/jev.mjs posts --input out/posts.json [--profiles out/profiles.json] --query "洗面奶"
  node scripts/jev.mjs entities --input out/candidates.json --query "洗面奶"

Requires the jev-use CLI on PATH (or JEV_COMMAND) and one of:
TYPESAFE_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY.`);
    process.exit(args.help ? 0 : 1);
  }

  if (command === 'status') {
    console.log(
      JSON.stringify({
        configured: jevConfigured(),
        backend: jevBackendName(),
        command: process.env.JEV_COMMAND || 'jev-use',
      }),
    );
    return;
  }

  if (command === 'accounts') {
    if (!args.input) throw new Error('missing --input accounts.json');
    const users = normalizeAccounts(readJson(args.input));
    const result = await judgeCommenters(users, { query: args.query ?? '' });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          backend: result.backend,
          error: result.error,
          results: users.map((user, index) => ({
            username: user.username,
            ...(result.results[index] ?? {}),
          })),
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === 'posts') {
    if (!args.input) throw new Error('missing --input posts.json');
    const posts = normalizePosts(readJson(args.input));
    const authorContext = new Map();
    if (args.profiles) {
      const profiles = readJson(args.profiles);
      for (const user of profiles.users ?? []) {
        authorContext.set(
          String(user.username).toLowerCase(),
          (user.posts ?? []).map((post) => ({ text: asText(post) })),
        );
      }
    }
    const result = await judgePosts(posts, { authorContext, query: args.query ?? '' });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          backend: result.backend,
          error: result.error,
          results: result.results.map((verdict, index) => ({
            post_id: posts[index]?.id ?? null,
            ...verdict,
          })),
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === 'entities') {
    if (!args.input) throw new Error('missing --input candidates.json');
    const data = readJson(args.input);
    const candidates = Array.isArray(data) ? data : data.candidates;
    if (!Array.isArray(candidates)) {
      throw new Error('input must be an array or {candidates:[...]}');
    }
    const result = await judgeEntityCandidates(candidates, { query: args.query ?? '' });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          backend: result.backend,
          error: result.error,
          results: candidates.map((candidate, index) => ({
            name: candidate.name,
            ...(result.results[index] ?? {}),
          })),
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 2;
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
  process.exit(1);
});
