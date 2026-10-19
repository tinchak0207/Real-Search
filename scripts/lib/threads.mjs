const BASE = 'https://www.threads.com';

// 未登录访问时，Threads 只有在请求头看起来像一次正常的浏览器导航时
// 才会返回带搜索结果的 SSR 页面；Accept: */* 会退化成空壳。
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, { timeout = 25000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
        redirect: 'follow',
      });
      const html = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(600 * (attempt + 1) + Math.random() * 300);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function* jsonBlocks(html) {
  const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) {
    const text = match[1];
    if (text.length < 40) continue;
    try {
      yield JSON.parse(text);
    } catch {
      // 非 JSON 的 script 块直接跳过
    }
  }
}

function findSearchResults(root, out, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 60) return;
  if (Array.isArray(root)) {
    for (const value of root) findSearchResults(value, out, depth + 1);
    return;
  }
  const results = root.searchResults;
  if (results && typeof results === 'object' && Array.isArray(results.edges)) {
    out.push(results);
  }
  for (const value of Object.values(root)) findSearchResults(value, out, depth + 1);
}

function walkThreadItems(root, posts, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 60) return;
  if (Array.isArray(root)) {
    for (const value of root) walkThreadItems(value, posts, depth + 1);
    return;
  }
  if (Array.isArray(root.thread_items)) {
    for (const item of root.thread_items) addPost(item?.post, posts);
  }
  for (const value of Object.values(root)) walkThreadItems(value, posts, depth + 1);
}

function textOfPost(post) {
  const fragments = post?.text_post_app_info?.text_fragments?.fragments;
  if (Array.isArray(fragments)) {
    return fragments
      .map((f) => f?.plaintext ?? f?.text ?? '')
      .join('')
      .trim();
  }
  return (post?.caption?.text ?? '').trim();
}

function toIso(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function addPost(post, posts) {
  if (!post || typeof post !== 'object') return;
  const id = String(post.pk ?? post.id ?? '');
  const username = post.user?.username;
  if (!id || !username || posts.has(id)) return;

  const text = textOfPost(post);
  if (!text) return;

  const info = post.text_post_app_info ?? {};
  const number = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  posts.set(id, {
    id,
    code: post.code ?? null,
    url: post.code ? `${BASE}/@${username}/post/${post.code}` : null,
    author: {
      username,
      full_name: post.user?.full_name ?? null,
      verified: Boolean(post.user?.is_verified),
      avatar: post.user?.profile_pic_url ?? null,
    },
    text,
    posted_at: toIso(post.taken_at),
    likes: number(post.like_count ?? info.like_count),
    reply_count: number(info.direct_reply_count),
    reposts: number(info.repost_count),
    quotes: number(info.quote_count),
    shares: number(info.reshare_count),
    is_reply: Boolean(info.is_reply),
  });
}

export function extractSearchPosts(html) {
  const results = [];
  for (const block of jsonBlocks(html)) findSearchResults(block, results);

  const posts = new Map();
  let pageInfo = null;
  for (const result of results) {
    pageInfo = result.page_info ?? pageInfo;
    walkThreadItems(result.edges, posts);
  }
  return { posts: [...posts.values()], pageInfo, found: results.length > 0 };
}

export function extractProfilePosts(html, username) {
  const posts = new Map();
  for (const block of jsonBlocks(html)) walkThreadItems(block, posts);
  const wanted = username.toLowerCase();
  return [...posts.values()].filter(
    (post) => post.author.username.toLowerCase() === wanted,
  );
}

export async function searchKeyword(keyword, { serpType = 'default' } = {}) {
  const url = `${BASE}/search?q=${encodeURIComponent(keyword)}&serp_type=${encodeURIComponent(serpType)}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const html = await fetchHtml(url, { retries: 0 });
    const { posts, pageInfo, found } = extractSearchPosts(html);
    // 真正的 0 结果页仍带 searchResults 与 page_info；完全没有这段 JSON
    // 通常是被限流后退回的壳页面，值得重试。
    if (found) return { keyword, posts, pageInfo, found };
    lastError = new Error('search_results_not_found');
    await sleep(800 * (attempt + 1) + Math.random() * 300);
  }
  throw lastError;
}

const authorCache = new Map();
const AUTHOR_CACHE_TTL = 10 * 60 * 1000;

export async function fetchAuthorPosts(username, { limit = 3, timeout = 20000 } = {}) {
  const key = username.toLowerCase();
  const cached = authorCache.get(key);
  if (cached && Date.now() - cached.at < AUTHOR_CACHE_TTL) {
    return cached.posts.slice(0, limit);
  }
  const html = await fetchHtml(`${BASE}/@${encodeURIComponent(username)}`, { timeout, retries: 1 });
  const posts = extractProfilePosts(html, username);
  authorCache.set(key, { at: Date.now(), posts });
  return posts.slice(0, limit);
}

// ---- 帖子回复（帖子详情页只有首屏主体走 SSR，回复由 GraphQL 拉取） ----

const REPLY_DOC_ID = '29200133479591970';
const REPLY_PROVIDED_VARIABLES = {
  __relay_internal__pv__BarcelonaHasBestOfThreadsrelayprovider: true,
  __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasMetaAiContentAttachmentsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasMWRLocationConsumptionrelayprovider: false,
  __relay_internal__pv__BarcelonaShouldFetchPostAuthorFullNamerelayprovider: false,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasLiveChatMessagingrelayprovider: false,
  __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
  __relay_internal__pv__BarcelonaMessagingHasMetaAIBotrelayprovider: false,
  __relay_internal__pv__BarcelonaGenAIRepliesEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
  __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
  __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityEmojiUpdateCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityEntityCardrelayprovider: false,
  __relay_internal__pv__BarcelonaHasScorecardCommunityrelayprovider: false,
  __relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider: false,
  __relay_internal__pv__BarcelonaHasStitchedAttachmentrelayprovider: false,
  __relay_internal__pv__BarcelonaHasNewspaperLinkStylerelayprovider: false,
  __relay_internal__pv__BarcelonaHasMessagingrelayprovider: false,
  __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldFulfillLightboxQueryrelayprovider: true,
  __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
  __relay_internal__pv__BarcelonaHasUnseenRepliesrelayprovider: false,
  __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: true,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCustomLikesConsumptionrelayprovider: false,
  __relay_internal__pv__BarcelonaHasViewerRepliedrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPrivateRepliesDeprecationrelayprovider: false,
  __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider: false,
  __relay_internal__pv__BarcelonaHasGhostPostProductionrelayprovider: false,
  __relay_internal__pv__BarcelonaHasPodcastTranscriptConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPodcastV2Consumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasNewsletterLinkPreviewrelayprovider: false,
  __relay_internal__pv__BarcelonaHasPublicViewCountShareCardrelayprovider: false,
  __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: false,
  __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
  __relay_internal__pv__BarcelonaHasPermalinkIndentationrelayprovider: false,
};

let session = null;
const SESSION_TTL = 10 * 60 * 1000;

async function getSession() {
  if (session && Date.now() - session.at < SESSION_TTL) return session;
  const res = await fetch(`${BASE}/`, { headers: BROWSER_HEADERS, redirect: 'follow' });
  const html = await res.text();
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const csrf = setCookies
    .map((cookie) => cookie.split(';')[0])
    .find((cookie) => cookie.startsWith('csrftoken='))
    ?.split('=')[1];
  const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  if (!csrf || !lsd) throw new Error('threads_session_bootstrap_failed');
  session = {
    at: Date.now(),
    csrf,
    lsd,
    igDid: crypto.randomUUID().toUpperCase(),
    webSessionId: `${Math.random().toString(36).slice(2, 8)}:${Math.random().toString(36).slice(2, 8)}:${Math.random().toString(36).slice(2, 8)}`,
  };
  return session;
}

function collectPostNodes(root, posts, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 40) return;
  if (Array.isArray(root)) {
    for (const value of root) collectPostNodes(value, posts, depth + 1);
    return;
  }
  if (root.pk && root.user?.username && root.text_post_app_info) addPost(root, posts);
  for (const value of Object.values(root)) collectPostNodes(value, posts, depth + 1);
}

export async function fetchReplies(post, { limit = 20, timeout = 20000 } = {}) {
  if (!post?.id || !post?.url) return [];
  const session = await getSession();
  const variables = {
    after: null,
    filterType: null,
    first: limit,
    postID: String(post.id),
    sortOrder: 'TOP',
    ...REPLY_PROVIDED_VARIABLES,
  };
  const body = new URLSearchParams({
    lsd: session.lsd,
    doc_id: REPLY_DOC_ID,
    variables: JSON.stringify(variables),
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'BarcelonaPostPageDirectRepliesRefetchQuery',
    server_timestamps: 'true',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let text;
  try {
    const res = await fetch(`${BASE}/api/graphql`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: '*/*',
        'accept-language': BROWSER_HEADERS['accept-language'],
        'x-ig-app-id': '238260118697367',
        'x-fb-lsd': session.lsd,
        'x-csrftoken': session.csrf,
        'x-fb-friendly-name': 'BarcelonaPostPageDirectRepliesRefetchQuery',
        'x-asbd-id': '359341',
        'x-web-session-id': session.webSessionId,
        cookie: `csrftoken=${session.csrf}; ig_did=${session.igDid}`,
        referer: post.url,
        'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': BROWSER_HEADERS['user-agent'],
      },
      body,
    });
    text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }

  if (!text.trim().startsWith('{')) throw new Error('replies_not_json');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('replies_invalid_json');
  }

  const posts = new Map();
  collectPostNodes(parsed?.data, posts);
  return [...posts.values()].filter((reply) => reply.id !== String(post.id));
}

