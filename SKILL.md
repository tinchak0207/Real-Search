---
name: threads-experience
description: Search Threads (threads.com) for real-user product experiences and turn them into ad-filtered recommendations. Use when the user asks for genuine reviews, recommendations, or comparisons from Threads, especially Chinese consumer topics (skincare, makeup, travel, housing, tech). Filters suspected ad/marketing accounts by inspecting each commenter's profile, then writes a result-first answer with evidence and exclusions.
---

# Threads Experience

Turn a natural-language need into an evidence-backed answer from Threads commenters, with suspected ad accounts removed.

The agent owns the loop. Scripts only fetch data and call models. Do not run a hidden fixed pipeline: inspect intermediate results and decide the next step.

## Setup

1. Copy `.env.example` to `.env` and fill:
   - `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` for any OpenAI-compatible model.
   - One of `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` for Jev.
   - Optional `JEV_COMMAND` if `jev-use` is not on PATH.
2. Verify:
   ```bash
   mkdir -p out
   node scripts/llm.mjs --help
   node scripts/jev.mjs status
   node scripts/threads.mjs search "洗面奶" --limit 2
   ```
3. Keep `.env` out of git. Never print keys.

## Loop

### 1. Understand the request deeply

```bash
node scripts/llm.mjs intent --query "<user request>"
```

Read `goal`, `constraints`, `aspects`, and `groups`. Check:
- `aspects` covers what the user actually needs, not just literal words.
- Each `group.primary` is a short searchable term; `alternatives` are concrete product words.
- Brand and category are split. Negations are in `exclude`, not keywords.
- For "全套/一整套/流程" requests, expect multiple aspects. If the model returned one vague term, fix the groups before searching.

### 2. Search per aspect

```bash
node scripts/threads.mjs search "<primary>" --limit 6
```

- If `count` is 0, try the group's `alternatives` in order.
- Treat 0 as a real result, not an error. Many Chinese terms return 0 on Threads anonymous search.
- Keep 6-8 posts total. Prefer one post per aspect; do not let one aspect fill every slot.
- Ignore posts that only match a keyword but are unrelated to the goal.

Optional second pass: write the selected posts to `out/posts.json` and let the agent re-rank by goal relevance.

### 3. Read comments

```bash
node scripts/threads.mjs replies --input out/posts.json --posts 6 --limit 15
```

Keep comments that contain a concrete product, brand, routine, price, channel, or first-hand experience. Drop pure "蹲/同求/表情" comments.

### 4. Inspect commenters

Build `out/users.json` with one row per commenter:

```json
[{"username": "alice", "comment_text": "用的至本洗面奶，还行"}]
```

Then fetch profiles:

```bash
node scripts/threads.mjs profiles --input out/users.json --limit 8
```

The profile posts are the main evidence for ad detection. Eight posts is the minimum useful sample.

### 5. Filter suspected ads with Jev

Build `out/accounts.json`:

```json
[{"username": "alice", "comment_text": "...", "posts": [{"text": "..."}]}]
```

Run:

```bash
node scripts/jev.mjs accounts --input out/accounts.json --query "<request>"
```

Apply this decision rule, in order:

1. `account_type` is `brand` or `bot` → exclude.
2. `is_ad_user === true` → exclude.
3. `post_diversity === "narrow"` and `commercial_probability >= 0.65` → exclude.
4. Otherwise keep, even if Jev is uncertain.

Sophisticated ads hide a few daily posts among product posts. Judge the profile's main line: if almost all posts are one category, or most posts sell something, exclude. Diverse real life (food, travel, work, moods, pets, friends) is the counter-signal. A few fake daily posts do not exonerate a product-heavy profile.

If Jev is unavailable, still run the loop and mark accounts `unjudged`; do not silently call them real.

### 6. Extract products and evidence

From non-ad comments only, extract explicit brands/products. Require the product string to appear verbatim in the comment. Keep:

- `comment_id`, `username`, `product`, `comment_text`, `parent_text`, `conditions` (skin type, budget, scenario).
- `reviewers`: each username's actual recent posts, `post_diversity`, `commercial_probability`.
- `excluded_accounts`: username, actual recent post topics, promo count, Jev probability/type.

Use `references/output-contract.md` for the exact shape.

### 7. Write the answer

```bash
node scripts/llm.mjs synthesize --query "<request>" --evidence out/evidence.json
```

Or write it yourself with the same rules from `prompts/synthesize.md`.

Output order (inverted pyramid):

```text
推荐<product/condition>。
理由：
1. <username>说<具体体验>；ta的主页有<真实主题>等内容，应该是真人。
...
帮你排除了我怀疑是广告的：<username><证据>，疑似广告号。
```

Rules:
- Recommendations must fall inside `intent.aspects`. If an aspect has no evidence (`missed_aspects`), omit it; never invent a product.
- Cover multiple aspects when evidence supports it; at most two products per aspect.
- Add conditions only when the comment/parent post states them.
- Every reason cites a real username and a real profile topic. If no profile posts, say so.
- Every excluded account cites checkable facts, not field names.
- No prices, links, or purchase channels unless literally in the evidence.

## Failure handling

- `llm_unconfigured` → tell the user which env var is missing.
- `jev_unconfigured` → continue with `unjudged`, state the limitation.
- `search_results_not_found` after retries → Threads throttled; wait and retry once, then reduce keyword count.
- All keywords 0 → do not fabricate. Report the empty result and suggest broader terms.
- Rate limits → sequential requests, 150ms+ gaps, retry with backoff.

## Files

- `prompts/intent.md` — deep intent planner (goal, aspects, groups, alternatives).
- `prompts/synthesize.md` — result-first synthesis and ad-reason wording.
- `references/output-contract.md` — JSON shapes and validation rules.
- `scripts/threads.mjs` — anonymous search, replies, profiles.
- `scripts/jev.mjs` — account/post/entity judging via `jev-use`.
- `scripts/llm.mjs` — OpenAI-compatible chat, intent, synthesis.
