import { spawn } from 'node:child_process';

// Jev 是本机已安装的 jev-use（TypeSafe System One 模型）。
// 判定在 jev-use 进程里完成，这里只负责把贴文组织成一批 noul/choice 问题。
const CREDENTIAL_ENV = ['JEV_BACKEND', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY'];
const JEV_COMMAND = process.env.JEV_COMMAND || 'jev-use';

export function jevConfigured() {
  return CREDENTIAL_ENV.some((name) => Boolean(process.env[name]));
}

export function jevBackendName() {
  if (!jevConfigured()) return 'unconfigured';
  if (process.env.JEV_BACKEND) return process.env.JEV_BACKEND;
  if (process.env.TYPESAFE_API_KEY) return 'typesafe';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.AI_GATEWAY_API_KEY) return 'vercel';
  return 'unknown';
}

function runJev(payload, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(JEV_COMMAND, ['judge'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('jev-use timeout'));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // jev-use 用 exit code 3 表示“有 verdict 需要升级确认”，JSON 仍然有效。
      if (code !== 0 && code !== 3) {
        reject(new Error(stderr.trim() || `jev-use exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`jev-use returned non-JSON: ${stdout.slice(0, 200)}`));
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildPayload(posts, authorContext, query) {
  const state =
    `搜索需求: ${query}\n\n` +
    posts
    .map((post, index) => {
      const lines = [
        `[p${index}]`,
        `作者: @${post.author.username}${post.author.full_name ? ` (${post.author.full_name})` : ''}`,
        `发布: ${post.posted_at ?? 'unknown'}`,
        `互动: 赞 ${post.likes} / 评论 ${post.reply_count} / 转发 ${post.reposts}`,
        `是否回复: ${post.is_reply ? '是' : '否'}`,
        `正文:\n${truncate(post.text, 1200)}`,
      ];
      const recent = authorContext.get(post.author.username.toLowerCase());
      if (recent?.length) {
        lines.push(
          `作者近期贴文:\n${recent
            .slice(0, 3)
            .map((item) => `- ${truncate(item.text.replace(/\s+/g, ' '), 300)}`)
            .join('\n')}`,
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const questions = [];
  posts.forEach((_, index) => {
    questions.push({
      id: `p${index}_ad`,
      type: 'noul',
      question:
        `贴文 p${index} 是否属于商业广告、付费推广或软性营销？` +
        '以“个人体验分享”为包装、带购买链接/优惠码/私信领券/品牌合作/明显代购引流的内容也算广告。',
    });
    questions.push({
      id: `p${index}_relevant`,
      type: 'noul',
      question:
        `贴文 p${index} 是否与上面的搜索需求相关，并且包含真实用户的体验、推荐或具体信息？` +
        '只是碰巧出现关键词、但内容与需求无关的（段子、新闻、纯提问）不算相关。',
    });
    questions.push({
      id: `p${index}_type`,
      type: 'choice',
      question: `贴文 p${index} 的内容性质是什么？`,
      options: {
        genuine: '发布者本人真实使用体验或自发分享',
        ad: '商业广告或软性推广',
        question: '求推荐、提问或求助',
        other: '其他',
      },
    });
  });

  return { state, questions };
}

function mapVerdicts({ ad, type, relevance }) {
  const adProbability = typeof ad?.answer === 'number' ? ad.answer : null;
  const relevanceProbability =
    typeof relevance?.answer === 'number' ? relevance.answer : null;
  const typeAdProbability =
    type?.answer === 'ad' ? Number(type.confidence ?? type.distribution?.ad ?? 0) : 0;

  let isAd = null;
  if (adProbability != null) {
    isAd = adProbability >= 0.5 || typeAdProbability >= 0.5;
  } else if (type?.answer) {
    isAd = type.answer === 'ad';
  }

  return {
    is_ad: isAd,
    ad_probability: adProbability,
    relevance_probability: relevanceProbability,
    experience_probability: type?.distribution?.genuine ?? null,
    content_type: type?.answer ?? null,
    type_confidence: type?.confidence ?? null,
    confidence_from: ad?.confidenceFrom ?? type?.confidenceFrom ?? null,
    escalated: Boolean(ad?.escalate || type?.escalate || relevance?.escalate),
    error: null,
  };
}

const EMPTY = {
  is_ad: null,
  ad_probability: null,
  relevance_probability: null,
  experience_probability: null,
  content_type: null,
  type_confidence: null,
  confidence_from: null,
  escalated: false,
  error: null,
};

export async function judgePosts(posts, { authorContext = new Map(), chunkSize = 10, query = '' } = {}) {
  if (!posts.length) return { ok: true, status: 'empty', results: [] };
  if (!jevConfigured()) {
    return {
      ok: false,
      status: 'unconfigured',
      error: '未找到 Jev 凭证：设置 TYPESAFE_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY 之一',
      results: posts.map(() => ({ ...EMPTY, error: 'jev_unconfigured' })),
    };
  }

  const chunks = [];
  for (let i = 0; i < posts.length; i += chunkSize) {
    chunks.push({ start: i, items: posts.slice(i, i + chunkSize) });
  }

  const settled = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const payload = buildPayload(chunk.items, authorContext, query);
        const output = await runJev(payload);
        const verdicts = Array.isArray(output?.verdicts) ? output.verdicts : [];
        const results = chunk.items.map((_, index) => {
          const find = (name) =>
            verdicts.find((verdict) => verdict.id === `p${index}_${name}`);
          return mapVerdicts({
            ad: find('ad'),
            type: find('type'),
            relevance: find('relevant'),
          });
        });
        return { ok: true, results, backend: output?.backend ?? jevBackendName() };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? error),
          results: chunk.items.map(() => ({ ...EMPTY, error: 'jev_failed' })),
        };
      }
    }),
  );

  const results = settled.flatMap((chunk) => chunk.results);
  const failed = settled.find((chunk) => !chunk.ok);
  return {
    ok: settled.every((chunk) => chunk.ok),
    status: settled.every((chunk) => chunk.ok) ? 'ok' : 'partial',
    backend: settled.find((chunk) => chunk.backend)?.backend ?? jevBackendName(),
    error: failed?.error ?? null,
    results,
  };
}

// ---- 以“人”为单位判定：评论者是不是广告/营销账号 ----

const EMPTY_ACCOUNT = {
  is_ad_user: null,
  ad_probability: null,
  relevance_probability: null,
  account_type: null,
  type_confidence: null,
  commercial_probability: null,
  post_diversity: null,
  confidence_from: null,
  escalated: false,
  error: null,
};

const AD_ACCOUNT_TYPES = new Set(['marketer', 'brand', 'bot']);

function buildCommenterPayload(users, query) {
  const state =
    `搜索需求: ${query}\n` +
    '下面是 Threads 评论区的用户。请根据“TA 在这条帖子下的评论”与“TA 近期自己发的贴文”判断账号性质。\n' +
    '重点看主页的“主题宽度”和“商业内容占比”，不要只看有没有生活贴。\n' +
    '广告号会伪装：主页里夹几条吃饭、自拍、日常，但其余大量贴文都在推产品，或者几乎全是同一品类（例如全是护肤品推荐）。几条日常贴不能洗白一个产品推广为主的主页。\n\n' +
    users
      .map((user, index) => {
        const posts = user.posts?.length
          ? user.posts
              .slice(0, 8)
              .map((post) => `  - ${truncate(post.text.replace(/\s+/g, ' '), 400)}`)
              .join('\n')
          : '  （没有抓到近期贴文）';
        return [
          `[u${index}] @${user.username}${user.full_name ? ` (${user.full_name})` : ''}`,
          `TA 在这条帖子下的评论: ${truncate(user.comment_text, 600)}`,
          `TA 的近期贴文（共抓到 ${user.posts?.length ?? 0} 条，按时间倒序）:`,
          posts,
        ].join('\n');
      })
      .join('\n\n');

  const questions = [];
  users.forEach((_, index) => {
    questions.push({
      id: `u${index}_ad`,
      type: 'noul',
      question:
        `用户 u${index} 是否是广告/营销账号？` +
        '广告号特征：几乎所有贴文都围绕产品/购物/优惠/购买链接；或者贴文几乎全是同一品类（如全是洗面奶、护肤品、代购），即使夹了几条日常；日常贴像填充物，商业内容占主导；评论本身直接推荐产品并带渠道/价格/链接。' +
        '真实用户特征：主页主题丰富多样（工作、吃饭、旅行、情绪、宠物、朋友、吐槽等），产品提及只是偶尔出现，不是主页主线。' +
        '不要因为主页里有几条生活贴就判成真实用户；看整体主题宽度和商业内容占比。普通用户偶尔分享自己买的产品、提问或闲聊不算广告账号。',
    });
    questions.push({
      id: `u${index}_commercial`,
      type: 'noul',
      question:
        `用户 u${index} 的近期贴文中，商业推广/产品种草/带货内容是否占主导（超过一半，或明显多于生活内容）？` +
        '只看比例和主线，不要被少量日常贴干扰。',
    });
    questions.push({
      id: `u${index}_diversity`,
      type: 'choice',
      question: `用户 u${index} 的近期贴文主题宽度如何？`,
      options: {
        diverse: '主题丰富多样，生活内容为主',
        mixed: '生活与产品内容混合，没有明显偏向',
        narrow: '几乎全是同一品类/产品/推广内容',
        unknown: '贴文太少，看不出来',
      },
    });
    questions.push({
      id: `u${index}_type`,
      type: 'choice',
      question: `用户 u${index} 属于哪类账号？`,
      options: {
        real_person: '普通真实用户',
        marketer: '营销/带货账号',
        brand: '品牌或商家官方号',
        bot: '机器人/刷量/批量账号',
        other: '其他',
      },
    });
    questions.push({
      id: `u${index}_relevant`,
      type: 'noul',
      question:
        `用户 u${index} 的这条评论是否提供了与搜索需求相关的真实使用经验、具体推荐或有用信息？` +
        '只是附和、表情、+1、蹲一个、纯提问不算。',
    });
  });

  return { state, questions };
}

function mapAccountVerdicts({ ad, commercial, diversity, type, relevance }) {
  const adProbability = typeof ad?.answer === 'number' ? ad.answer : null;
  const relevanceProbability =
    typeof relevance?.answer === 'number' ? relevance.answer : null;
  const commercialProbability =
    typeof commercial?.answer === 'number' ? commercial.answer : null;
  const postDiversity = diversity?.answer ?? null;
  const accountType = type?.answer ?? null;

  const narrowAndCommercial =
    (commercialProbability ?? 0) >= 0.65 && postDiversity === 'narrow';

  let isAdUser = null;
  if (adProbability != null) {
    isAdUser =
      adProbability >= 0.5 ||
      AD_ACCOUNT_TYPES.has(accountType) ||
      narrowAndCommercial;
  } else if (accountType || commercialProbability != null) {
    isAdUser = AD_ACCOUNT_TYPES.has(accountType) || narrowAndCommercial;
  }

  return {
    is_ad_user: isAdUser,
    ad_probability: adProbability,
    relevance_probability: relevanceProbability,
    account_type: accountType,
    type_confidence: type?.confidence ?? null,
    commercial_probability: commercialProbability,
    post_diversity: postDiversity,
    confidence_from:
      ad?.confidenceFrom ?? commercial?.confidenceFrom ?? type?.confidenceFrom ?? null,
    escalated: Boolean(ad?.escalate || commercial?.escalate || type?.escalate || relevance?.escalate),
    error: null,
  };
}

export async function judgeCommenters(users, { chunkSize = 8, query = '' } = {}) {
  if (!users.length) return { ok: true, status: 'empty', results: [] };
  if (!jevConfigured()) {
    return {
      ok: false,
      status: 'unconfigured',
      error: '未找到 Jev 凭证：设置 TYPESAFE_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY 之一',
      results: users.map(() => ({ ...EMPTY_ACCOUNT, error: 'jev_unconfigured' })),
    };
  }

  const chunks = [];
  for (let i = 0; i < users.length; i += chunkSize) {
    chunks.push(users.slice(i, i + chunkSize));
  }

  const settled = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const output = await runJev(buildCommenterPayload(chunk, query));
        const verdicts = Array.isArray(output?.verdicts) ? output.verdicts : [];
        const results = chunk.map((_, index) => {
          const find = (name) =>
            verdicts.find((verdict) => verdict.id === `u${index}_${name}`);
          return mapAccountVerdicts({
            ad: find('ad'),
            commercial: find('commercial'),
            diversity: find('diversity'),
            type: find('type'),
            relevance: find('relevant'),
          });
        });
        return { ok: true, results, backend: output?.backend ?? jevBackendName() };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? error),
          results: chunk.map(() => ({ ...EMPTY_ACCOUNT, error: 'jev_failed' })),
        };
      }
    }),
  );

  const results = settled.flatMap((chunk) => chunk.results);
  const failed = settled.find((chunk) => !chunk.ok);
  return {
    ok: settled.every((chunk) => chunk.ok),
    status: settled.every((chunk) => chunk.ok) ? 'ok' : 'partial',
    backend: settled.find((chunk) => chunk.backend)?.backend ?? jevBackendName(),
    error: failed?.error ?? null,
    results,
  };
}

// ---- 候选词判定：这个词是不是具体的品牌/产品/型号 ----

const EMPTY_CANDIDATE = {
  is_entity: null,
  entity_probability: null,
  type: null,
  type_confidence: null,
  confidence_from: null,
  escalated: false,
  error: null,
};

const ENTITY_TYPES = new Set(['brand', 'product', 'series']);

function buildEntityPayload(candidates, query) {
  const state =
    `搜索需求: ${query}\n` +
    '下面是评论里反复出现的候选片段。请判断每个候选是不是用户在指代的具体产品、品牌、型号或产品系列。\n' +
    '普通词、品类词（洗面奶/面膜）、功效词（补水/抗老）、口语词都不算。\n\n' +
    candidates
      .map((candidate, index) =>
        [
          `[c${index}] 候选: ${candidate.name}`,
          `出现: ${candidate.df} 条评论 / ${candidate.count} 次`,
          '上下文:',
          ...candidate.contexts.map((context) => `  - ${truncate(context, 160)}`),
        ].join('\n'),
      )
      .join('\n\n');

  const questions = [];
  candidates.forEach((_, index) => {
    questions.push({
      id: `c${index}_entity`,
      type: 'noul',
      question:
        `候选「${candidates[index].name}」是否是用户在指代的具体产品、品牌、型号或产品系列？` +
        '它是答案里应该出现的那种专有名称吗？',
    });
    questions.push({
      id: `c${index}_type`,
      type: 'choice',
      question: `候选「${candidates[index].name}」属于哪一类名称？`,
      options: {
        brand: '品牌名（如 至本、科颜氏）',
        product: '具体产品/型号（如 金盏花洁面、B5）',
        series: '产品系列（如 红石榴系列）',
        ingredient: '成分名（如 烟酰胺、水杨酸）',
        generic: '普通词/品类词/功效词',
        other: '其他',
      },
    });
  });

  return { state, questions };
}

function mapCandidateVerdicts({ entity, type }) {
  const probability = typeof entity?.answer === 'number' ? entity.answer : null;
  const candidateType = type?.answer ?? null;

  let isEntity = null;
  if (probability != null) {
    // 0.7：把「直男福」这类口语片段挡在答案外，同时保留 0.73 左右的真实品牌。
    isEntity = probability >= 0.7 && ENTITY_TYPES.has(candidateType);
  } else if (candidateType) {
    isEntity = ENTITY_TYPES.has(candidateType);
  }

  return {
    is_entity: isEntity,
    entity_probability: probability,
    type: candidateType,
    type_confidence: type?.confidence ?? null,
    confidence_from: entity?.confidenceFrom ?? type?.confidenceFrom ?? null,
    escalated: Boolean(entity?.escalate || type?.escalate),
    error: null,
  };
}

export async function judgeEntityCandidates(candidates, { chunkSize = 16, query = '' } = {}) {
  if (!candidates.length) return { ok: true, status: 'empty', results: [] };
  if (!jevConfigured()) {
    return {
      ok: false,
      status: 'unconfigured',
      error: '未找到 Jev 凭证：设置 TYPESAFE_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY 之一',
      results: candidates.map(() => ({ ...EMPTY_CANDIDATE, error: 'jev_unconfigured' })),
    };
  }

  const chunks = [];
  for (let i = 0; i < candidates.length; i += chunkSize) {
    chunks.push(candidates.slice(i, i + chunkSize));
  }

  const settled = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const output = await runJev(buildEntityPayload(chunk, query));
        const verdicts = Array.isArray(output?.verdicts) ? output.verdicts : [];
        const results = chunk.map((_, index) => {
          const find = (name) =>
            verdicts.find((verdict) => verdict.id === `c${index}_${name}`);
          return mapCandidateVerdicts({ entity: find('entity'), type: find('type') });
        });
        return { ok: true, results, backend: output?.backend ?? jevBackendName() };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? error),
          results: chunk.map(() => ({ ...EMPTY_CANDIDATE, error: 'jev_failed' })),
        };
      }
    }),
  );

  const results = settled.flatMap((chunk) => chunk.results);
  const failed = settled.find((chunk) => !chunk.ok);
  return {
    ok: settled.every((chunk) => chunk.ok),
    status: settled.every((chunk) => chunk.ok) ? 'ok' : 'partial',
    backend: settled.find((chunk) => chunk.backend)?.backend ?? jevBackendName(),
    error: failed?.error ?? null,
    results,
  };
}
