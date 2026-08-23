import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completeWithOverseasStrategy } from '../gmail-provider-router.mjs';

const root = resolve(process.cwd(), 'data', 'news');
const cacheFile = resolve(root, 'government.json');
const sources = [
  ['White House', 'https://www.whitehouse.gov/remarks/'], ['White House', 'https://www.whitehouse.gov/briefing-room/'], ['White House', 'https://www.whitehouse.gov/presidential-actions/'], ['White House', 'https://www.whitehouse.gov/videos/'],
  ['U.S. Treasury', 'https://home.treasury.gov/news/press-releases'], ['SEC', 'https://www.sec.gov/news/press-releases'], ['CFTC', 'https://www.cftc.gov/PressRoom/PressReleases'], ['Federal Reserve', 'https://www.federalreserve.gov/newsevents/pressreleases.htm'], ['Federal Register', 'https://www.federalregister.gov/documents/search?conditions%5Bterm%5D=cryptocurrency'],
];
const fetchPage = async (url) => (await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'CryptoAgent/1.0 news collector' } })).text();
const clean = (value) => String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#039;/gi, "'").replace(/&#8217;/gi, "'").replace(/\s+/g, ' ').trim();
const readCache = async () => { try { return JSON.parse(await readFile(cacheFile, 'utf8')); } catch { return {}; } };
const saveCache = async (cache) => { await mkdir(root, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 }); };
const linksFrom = (html, sourceUrl) => { const host = new URL(sourceUrl).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return [...String(html).matchAll(new RegExp(`href=["'](https?:\\/\\/(?:www\\.)?${host}\\/[^"'?#]+\\/?)["']`, 'gi'))].map((match) => match[1]); };
const meta = (html, name) => String(html).match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`, 'i'))?.[1] || '';
const scorePrompt = (item) => `只返回0到100的整数，评估这条美国白宫消息对比特币、以太坊和整体加密货币市场的重要性。0-29完全无关，30-59一般宏观关联，60-74有加密关联但影响有限，75-89明显可能影响加密市场，90-94重大数字资产政策或市场事件，95-100国家级储备、重大行政命令、全面监管或系统性事件。普通总统礼节活动、外交、民生和一般讲话不要高分。标题：${item.title}\n开头：${item.excerpt}`;
const analysisPrompt = (item) => `你是一位资深的加密货币政策与市场分析师。只返回Markdown，不要JSON或代码围栏。第一行使用简短中文标题，格式为# 标题。随后包括：事件概述、对加密市场的直接影响、政策和机构机制、BTC/ETH/稳定币可能反应、2到3个进攻型研究或对冲思路、风险提示。严格区分网页明确事实与推测，不要臆造。原始来源：${item.url}\n网页标题：${item.title}\n网页内容：${item.content.slice(0, 30_000)}`;
async function score(item) { const raw = await completeWithOverseasStrategy({ content: scorePrompt(item), model: process.env.WHITEHOUSE_RELEVANCE_MODEL || 'gpt-5.6-luna' }); const value = Number(String(raw).match(/\b(?:100|[1-9]?\d)\b/)?.[0]); if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid White House relevance score.'); return value; }
export async function collectWhiteHouse({ onRelevant } = {}) {
  const cache = await readCache(); let discovered = 0; let relevant = 0; let processed = 0;
  for (const [source, page] of sources) {
    let html; try { html = await fetchPage(page); } catch (error) { console.warn('White House source unavailable', page, error.message); continue; }
    for (const url of [...new Set(linksFrom(html, page))].slice(0, 20)) {
      if (processed >= 20) break;
      if (cache[url] && !cache[url].error) continue;
      discovered += 1;
      try {
        processed += 1;
        const detail = await fetchPage(url); const title = clean(meta(detail, 'og:title')) || clean(detail.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || url; const content = clean(detail); const item = { id: url, source, sourceUrl: url, title, content, excerpt: content.slice(0, 2_500), publishedAt: Date.now(), collectedAt: Date.now(), impactScore: await score({ title, excerpt: content.slice(0, 2_500) }) };
        cache[url] = item; await saveCache(cache);
        if (item.impactScore >= 75 && onRelevant) { relevant += 1; await onRelevant(item); }
      } catch (error) { cache[url] = { id: url, source: 'White House', sourceUrl: url, error: error.message, collectedAt: Date.now() }; await saveCache(cache); }
    }
  }
  return { discovered, relevant, cached: Object.keys(cache).length };
}
