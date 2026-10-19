# threads-experience

一个开源的 Agent Skill：把 Threads 上真实用户的评论区经验，变成**过滤掉广告号**的购买建议。

不是 SaaS，不是网站。它只提供 **prompt + helper 脚本**，由你自己的 Agent（Claude Code / Codex / ZCode / 其他支持 Skill 的 Agent）来跑完整循环。你自带 LLM 和 Jev 的 API Key。

```text
用户需求
  ↓  DeepSeek/任意 LLM 做深层意图拆解（目标、约束、环节、搜索分组）
Threads 搜索（每个环节一组，主词搜不到自动换同义词）
  ↓
帖子评论区 → 评论者 → 每个评论者的主页贴文
  ↓  Jev 判断账号是不是广告/营销号
只保留真实用户
  ↓
LLM 写结论：推荐在前，理由在后，广告号单独列出
```

## 它解决什么问题

- 搜索结果里全是帖子，没有结论。
- 广告号伪装得很好：主页夹几条吃饭、自拍、日常，其余全是同一品类或产品推广。
- 一句“油痘肌化地雷妆需要的大全套”，直接把 `大全套` 丢进搜索是 0 结果；需要拆成风格、底妆、遮瑕、定妆、眼妆、腮红、唇妆、卸妆，再给每个环节找 Threads 上真正能搜到的词。
- 结论必须能核对：每个推荐都对应真实 username、真实评论、真实主页主题。

## 安装

```bash
git clone https://github.com/<you>/threads-experience.git
```

放到你的 Agent 会扫描的 skills 目录：

| Agent | 目录 |
|---|---|
| Claude Code（个人） | `~/.claude/skills/threads-experience` |
| Claude Code（项目） | `.claude/skills/threads-experience` |
| Codex / ZCode | `~/.agents/skills/threads-experience` |

例如：

```bash
ln -s "$PWD/threads-experience" ~/.agents/skills/threads-experience
```

不需要 `npm install`。要求 Node.js 20+。

## 配置

```bash
cp .env.example .env
```

填三样东西：

1. **LLM**：任何 OpenAI 兼容接口
   - `LLM_BASE_URL`
   - `LLM_MODEL`
   - `LLM_API_KEY`
2. **Jev**：`jev-use` CLI 的凭证，三选一
   - `TYPESAFE_API_KEY`
   - `OPENROUTER_API_KEY`
   - `AI_GATEWAY_API_KEY`
3. 如果 `jev-use` 不在 PATH：`JEV_COMMAND=/path/to/jev-use`

验证：

```bash
mkdir -p out
node scripts/threads.mjs search "洗面奶" --limit 2
node scripts/llm.mjs intent --query "油痘肌化地雷妆需要的大全套"
node scripts/jev.mjs status
```

`.env` 已在 `.gitignore` 里。不要把 Key 提交到仓库，也不要在输出里打印 Key。

## 使用

对你的 Agent 说：

> 用 threads-experience 搜「油痘肌化地雷妆需要的大全套」，只要真实用户，过滤广告，结论放最前面。

Agent 会按 `SKILL.md` 的循环执行，中间产物落在 `out/`：

```text
out/posts.json        选中的帖子
out/comments.json     评论区
out/users.json        评论者 + 评论
out/profiles.json     评论者主页贴文
out/accounts.json     喂给 Jev 的账号证据
out/verdicts.json     Jev 判定
out/evidence.json     写结论用的证据包
```

也可以手动跑单独步骤：

```bash
# 深层意图：目标 / 约束 / 环节 / 搜索分组
node scripts/llm.mjs intent --query "油痘肌化地雷妆需要的大全套"

# 搜索一个词（0 条是常态，换同义词）
node scripts/threads.mjs search "散粉" --limit 6

# 抓评论
node scripts/threads.mjs replies --input out/posts.json --posts 6 --limit 15

# 抓评论者主页
node scripts/threads.mjs profiles --input out/users.json --limit 8

# Jev 判断账号
node scripts/jev.mjs accounts --input out/accounts.json --query "油痘肌化地雷妆需要的大全套"

# 写结论
node scripts/llm.mjs synthesize --query "油痘肌化地雷妆需要的大全套" --evidence out/evidence.json
```

## 广告过滤规则

Jev 对每个账号回答 5 个问题：是否广告、商业内容是否占主导、主页主题宽度、账号类型、评论是否相关。

最终判定（按顺序）：

1. 账号类型是 `brand` 或 `bot` → 排除。
2. `is_ad_user === true` → 排除。
3. 主页主题 `narrow` 且商业内容概率 `>= 0.65` → 排除。
4. 其余保留。

重点不是“有没有生活贴”，而是**主页主线**：

- 广告号：几乎全是产品/购物/优惠；或者几乎全是同一品类；几条日常只是填充。
- 真实用户：工作、吃饭、旅行、情绪、宠物、朋友、吐槽等主题占主导，产品只是偶尔出现。

## 深层意图，而不是关键词复读

`prompts/intent.md` 让模型先回答：

- 用户真正要完成的事是什么？
- 哪些是隐含环节？（“全套” = 底妆/遮瑕/定妆/眼妆/腮红/唇妆/卸妆）
- 哪些约束会改变推荐？（油痘肌、控油、不闷痘、平价）
- 每个环节在 Threads 上更可能命中的具体词是什么？（定妆→散粉/蜜粉，眼妆→眼影/睫毛膏）

输出结构化计划：

```json
{
  "goal": "地雷妆全套",
  "constraints": ["油痘肌", "控油", "不闷痘"],
  "aspects": ["风格", "底妆", "遮瑕", "定妆", "眼妆", "腮红", "唇妆", "卸妆"],
  "missed_aspects": [],
  "groups": [
    {"aspect": "风格", "primary": "地雷系", "alternatives": ["地雷妆"]},
    {"aspect": "定妆", "primary": "散粉", "alternatives": ["蜜粉", "粉饼"]}
  ]
}
```

Agent 按 `groups` 逐个搜，`primary` 为 0 时试 `alternatives`。没有证据的环节进入 `missed_aspects`，写结论时直接省略，不编产品。

## 已知限制

- Threads 匿名搜索是**整串匹配**，很多常见中文词返回 0 条；这不是 bug，所以必须准备同义词。
- 需要公网访问 `threads.com`；频繁请求会触发限流，脚本会重试，但仍应控制节奏。
- 只看公开帖子/评论/主页，不登录、不碰私信。
- Jev 是概率判定，不是绝对真相；结论里对不确定账号会写“建议复核”。
- LLM 可能编造。`references/output-contract.md` 要求本地校验 username、产品原文、comment_id；校验不过就丢弃该句。

## 目录

```text
SKILL.md                       Agent 执行说明
prompts/intent.md              深层意图拆解
prompts/synthesize.md          结论写作（倒金字塔 + 广告理由）
references/output-contract.md  JSON 结构与校验规则
scripts/threads.mjs            搜索 / 评论 / 主页
scripts/jev.mjs                账号 / 帖子 / 实体判定
scripts/llm.mjs                意图 / 结论 / 通用 chat
scripts/lib/                   无依赖实现
```

## License

MIT。使用本项目时请遵守 Threads 的服务条款和当地法律，只处理公开内容，不要用于骚扰、批量抓取隐私或规避平台限制。
