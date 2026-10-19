#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  fetchAuthorPosts,
  fetchReplies,
  searchKeyword,
} from './lib/threads.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--posts') args.posts = Number(argv[++i]);
    else if (arg === '--input') args.input = argv[++i];
    else if (arg === '--serp') args.serp = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args._.push(arg);
  }
  return args;
}

function readJson(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || !command) {
    console.log(`Usage:
  node scripts/threads.mjs search "洗面奶" [--limit 6] [--serp default|tags]
  node scripts/threads.mjs replies --input out/posts.json [--posts 6] [--limit 15]
  node scripts/threads.mjs profile <username> [--limit 8]
  node scripts/threads.mjs profiles --input out/users.json [--limit 8]

All commands print JSON to stdout. No login or API key required.`);
    process.exit(args.help ? 0 : 1);
  }

  if (command === 'search') {
    const keyword = args._.slice(1).join(' ').trim();
    if (!keyword) throw new Error('missing keyword');
    const result = await searchKeyword(keyword, { serpType: args.serp || 'default' });
    console.log(
      JSON.stringify(
        {
          keyword,
          count: result.posts.length,
          posts: result.posts.slice(0, args.limit ?? 6),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'replies') {
    if (!args.input) throw new Error('missing --input posts.json');
    const data = readJson(args.input);
    const posts = Array.isArray(data) ? data : data.posts;
    if (!Array.isArray(posts)) throw new Error('input must be an array or {posts:[...]}');
    const selected = posts.slice(0, args.posts ?? 6);
    const comments = [];
    for (let i = 0; i < selected.length; i += 2) {
      const batch = selected.slice(i, i + 2);
      const results = await Promise.all(
        batch.map(async (post) => {
          try {
            return { post, replies: await fetchReplies(post, { limit: args.limit ?? 15 }) };
          } catch (error) {
            return { post, replies: [], error: String(error?.message ?? error) };
          }
        }),
      );
      for (const item of results) {
        for (const reply of item.replies) {
          comments.push({
            ...reply,
            parent_post_id: item.post.id,
            parent_url: item.post.url,
            parent_text: item.post.text,
            parent_author: item.post.author,
          });
        }
      }
      await sleep(150);
    }
    console.log(JSON.stringify({ comments }, null, 2));
    return;
  }

  if (command === 'profile') {
    const username = args._[1];
    if (!username) throw new Error('missing username');
    const posts = await fetchAuthorPosts(username, { limit: args.limit ?? 8 });
    console.log(JSON.stringify({ username, count: posts.length, posts }, null, 2));
    return;
  }

  if (command === 'profiles') {
    if (!args.input) throw new Error('missing --input users.json');
    const data = readJson(args.input);
    const rows = Array.isArray(data) ? data : data.users;
    if (!Array.isArray(rows)) throw new Error('input must be an array or {users:[...]}');
    const users = [];
    for (const row of rows) {
      const username = typeof row === 'string' ? row : row?.username;
      if (!username) continue;
      try {
        const posts = await fetchAuthorPosts(username, { limit: args.limit ?? 8 });
        users.push({ username, count: posts.length, posts });
      } catch (error) {
        users.push({
          username,
          count: 0,
          posts: [],
          error: String(error?.message ?? error),
        });
      }
      await sleep(150);
    }
    console.log(JSON.stringify({ users }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
  process.exit(1);
});
