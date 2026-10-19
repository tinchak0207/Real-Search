#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, cleanList, loadEnv, parseJsonLoose } from './lib/llm.mjs';

loadEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--query') args.query = argv[++i];
    else if (arg === '--evidence') args.evidence = argv[++i];
    else if (arg === '--system') args.system = argv[++i];
    else if (arg === '--user') args.user = argv[++i];
    else if (arg === '--max-tokens') args.maxTokens = Number(argv[++i]);
    else if (arg === '--temperature') args.temperature = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args._.push(arg);
  }
  return args;
}

function readText(path) {
  if (path === '-') return readFileSync(0, 'utf8');
  return readFileSync(path, 'utf8');
}

function normalizeIntent(parsed, query) {
  const intent = String(parsed?.intent ?? query).replace(/\s+/g, ' ').trim().slice(0, 160);
  const goal = String(parsed?.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const constraints = cleanList(parsed?.constraints, 5, 12);
  const aspects = cleanList(parsed?.aspects, 8, 12);
  const exclude = cleanList(parsed?.exclude, 5, 12);
  const groups = Array.isArray(parsed?.groups)
    ? parsed.groups
        .slice(0, 8)
        .map((group) => ({
          aspect: String(group?.aspect ?? '').replace(/\s+/g, ' ').trim().slice(0, 12),
          primary: String(group?.primary ?? '').normalize('NFKC').trim(),
          alternatives: cleanList(group?.alternatives, 3, 20),
        }))
        .filter((group) => group.primary.length >= 2 && group.primary.length <= 20)
    : [];
  const keywords = [];
  const seen = new Set();
  for (const item of Array.isArray(parsed?.keywords) ? parsed.keywords : []) {
    if (typeof item !== 'string') continue;
    const keyword = item
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .replace(/^[，,。.!！?？；;：:]+|[，,。.!！?？；;：:]+$/g, '')
      .trim();
    if (keyword.length < 2 || keyword.length > 20) continue;
    if (exclude.some((word) => keyword.includes(word))) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= 6) break;
  }
  if (!keywords.length) {
    for (const group of groups) {
      const key = group.primary.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      keywords.push(group.primary);
      if (keywords.length >= 6) break;
    }
  }
  return { status: 'ok', intent, goal, constraints, aspects, exclude, keywords, groups };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    console.log(`Usage:
  node scripts/llm.mjs intent --query "油痘肌化地雷妆需要的大全套"
  node scripts/llm.mjs synthesize --query "..." --evidence out/evidence.json
  node scripts/llm.mjs chat --system "..." --user "..." [--max-tokens 3200]

Env: LLM_BASE_URL, LLM_MODEL, LLM_API_KEY`);
    process.exit(args.help ? 0 : 1);
  }

  if (command === 'intent') {
    if (!args.query) throw new Error('missing --query');
    const template = readFileSync(join(ROOT, 'prompts', 'intent.md'), 'utf8');
    const prompt = template.replace('{{QUERY}}', args.query);
    let lastError;
    for (const maxTokens of [1800, 3000]) {
      try {
        const { content } = await chat(
          [
            { role: 'system', content: '你是 Threads 搜索意图规划器，只输出 JSON。' },
            { role: 'user', content: prompt },
          ],
          { maxTokens, temperature: 0.1 },
        );
        const parsed = normalizeIntent(parseJsonLoose(content), args.query);
        if (!parsed.keywords.length) throw new Error('intent_no_keywords');
        console.log(JSON.stringify(parsed, null, 2));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  if (command === 'synthesize') {
    if (!args.query) throw new Error('missing --query');
    if (!args.evidence) throw new Error('missing --evidence (path or - for stdin)');
    const evidence = readText(args.evidence).trim();
    const template = readFileSync(join(ROOT, 'prompts', 'synthesize.md'), 'utf8');
    const prompt = template
      .replace('{{QUERY}}', args.query)
      .replace('{{EVIDENCE}}', evidence);
    let lastError;
    for (const maxTokens of [6000, 8000]) {
      try {
        const { content, model } = await chat(
          [
            {
              role: 'system',
              content:
                '你是中文消费经验编辑。只根据 evidence 写作，绝不编造用户名、产品、功效、价格或经历。',
            },
            { role: 'user', content: prompt },
          ],
          { maxTokens, temperature: 0.3 },
        );
        console.log(content);
        if (process.env.SHOW_META === '1') console.error(`model=${model}`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  if (command === 'chat') {
    if (!args.system || !args.user) throw new Error('missing --system/--user');
    const { content } = await chat(
      [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      {
        maxTokens: Number.isFinite(args.maxTokens) ? args.maxTokens : 3200,
        temperature: Number.isFinite(args.temperature) ? args.temperature : 0.3,
      },
    );
    console.log(content);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
  process.exit(1);
});
