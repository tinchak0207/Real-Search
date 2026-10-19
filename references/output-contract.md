# Output contract

All intermediate files live in `out/` (gitignored). The agent may add fields, but must not rename the ones below.

## Posts

`out/posts.json`

```json
{
  "posts": [
    {
      "id": "123",
      "url": "https://www.threads.com/@user/post/CODE",
      "author": {"username": "user", "full_name": null},
      "text": "post body",
      "posted_at": "2026-10-20T00:00:00.000Z",
      "likes": 12,
      "reply_count": 3
    }
  ]
}
```

`scripts/threads.mjs search` already emits this shape. Keep the original fields so `replies` can use `id` and `url`.

## Accounts input for Jev

`out/accounts.json`

```json
[
  {
    "username": "alice",
    "full_name": null,
    "comment_text": "the comment that mentioned the product",
    "posts": [
      {"text": "recent profile post 1"},
      {"text": "recent profile post 2"}
    ]
  }
]
```

Limit `posts` to the 8 most recent profile posts. `comment_text` is the evidence for relevance; `posts` is the evidence for ad classification.

## Jev account verdict

```json
{
  "username": "alice",
  "is_ad_user": false,
  "ad_probability": 0.31,
  "relevance_probability": 0.88,
  "account_type": "real_person",
  "commercial_probability": 0.22,
  "post_diversity": "diverse",
  "type_confidence": 0.9,
  "escalated": false,
  "error": null
}
```

Decision rule: exclude when `is_ad_user === true`, `account_type in {brand,bot}`, or (`post_diversity === "narrow"` and `commercial_probability >= 0.65`). `marketer` alone is corroborating, not sufficient.

## Evidence for synthesis

`out/evidence.json`

```json
{
  "query": "油痘肌化地雷妆需要的大全套",
  "intent": {
    "summary": "油痘肌想化地雷妆，需要从底妆到卸妆的全套产品",
    "goal": "地雷妆全套",
    "constraints": ["油痘肌", "控油"],
    "aspects": ["风格", "底妆", "遮瑕", "定妆", "眼妆", "腮红", "唇妆", "卸妆"],
    "missed_aspects": ["卸妆"],
    "exclude": []
  },
  "recommendations": [
    {
      "comment_id": "456",
      "username": "alice",
      "product": "倩碧",
      "product_type": "brand",
      "conditions": ["油痘肌"],
      "comment_text": "油痘肌用倩碧这个真的可以",
      "parent_text": "求油痘肌底妆推荐"
    }
  ],
  "reviewers": [
    {
      "username": "alice",
      "recent_posts": ["post text 1", "post text 2"],
      "post_diversity": "diverse",
      "commercial_probability": 0.2
    }
  ],
  "excluded_accounts": [
    {
      "username": "seller01",
      "account_type": "marketer",
      "ad_probability": 0.82,
      "commercial_probability": 0.9,
      "post_diversity": "narrow",
      "recent_posts": ["product post 1", "product post 2"],
      "promo_post_count": 5,
      "comment_samples": ["这个我有渠道，私信"]
    }
  ]
}
```

Rules:

- `product` must appear verbatim in `comment_text` or `parent_text`.
- `username` must come from the collected comments.
- `conditions` must appear in the comment or parent post.
- `recent_posts` must be actual profile posts; never synthesize topics.
- `missed_aspects` are aspects with no evidence. The writer must omit them.

## Final answer

Plain text, simplified Chinese, no markdown headings:

```text
推荐<product A>，<condition>可以用<product B>。
理由：
1. <username>说<specific experience>；ta的主页有<2-4 real topics>等内容，应该是真人。
2. ...
帮你排除了我怀疑是广告的：<username><checkable evidence>，疑似广告号。
```

If there are no recommendations, say so and report which aspects returned no evidence. Do not fill the gap with generic advice.
