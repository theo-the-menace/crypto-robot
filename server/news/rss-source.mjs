import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completeWithOverseasStrategy } from '../gmail-provider-router.mjs';

const root = resolve(process.cwd(), 'data', 'news');
const cacheFile = resolve(root, 'crypto-rss.json');
const feeds = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Bitcoin Optech', 'https://bitcoinops.org/feed.xml'],
];
const readCache = async () => { try { return JSON.parse(await readFile(cacheFile, 'utf8')); } catch { return {}; } };
const saveCache = async (cache) => { await mkdir(root, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 }); };
const decode = (value) => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const tag = (block, name) => decode(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]);
const itemsFrom = (xml) => [...String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => { const block = match[0]; const link = tag(block, 'link') || block.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || ''; return { title: tag(block, 'title'), sourceUrl: link, content: tag(block, 'content:encoded') || tag(block, 'content') || tag(block, 'description') || tag(block, 'summary'), publishedAt: Date.parse(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated')) || Date.now() }; }).filter((item) => item.title && item.sourceUrl);
const scorePrompt = (item) => `只返回0到100的整数，评估这条加密货币新闻对比特币、以太坊和整体加密市场的重要性。0-29无关或营销，30-59一般行业消息，60-74有市场关联但影响有限，75-89明显影响某个主要资产或行业，90-94重大监管、ETF、交易所或机构事件，95-100系统性危机、国家级政策或极重大市场事件。普通价格评论、空投、项目宣传和未证实传闻不要高分。标题：${item.title}\n开头：${item.excerpt}`;
async function score(item) { const raw = await completeWithOverseasStrategy({ content: scorePrompt(item), model: process.env.CRYPTO_NEWS_RELEVANCE_MODEL || 'gpt-5.6-luna' }); const value = Number(String(raw).match(/\b(?:100|[1-9]?\d)\b/)?.[0]); if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid crypto news relevance score.'); return value; }
export async function collectCryptoRss({ onRelevant } = {}) {
  const cache = await readCache(); let discovered = 0; let relevant = 0; let processed = 0;
  for (const [source, feed] of feeds) {
    let xml; try { xml = await (await fetch(feed, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'CryptoAgent/1.0 RSS collector' } })).text(); } catch (error) { console.warn('Crypto RSS unavailable', source, error.message); continue; }
    for (const entry of itemsFrom(xml).slice(0, 20)) {
      if (processed >= 20) break;
      const id = `${source}:${entry.sourceUrl}`; if (cache[id] && !cache[id].error) continue; discovered += 1;
      try { processed += 1; const item = { id, source, sourceUrl: entry.sourceUrl, title: entry.title, content: entry.content, excerpt: entry.content.slice(0, 2_500), publishedAt: entry.publishedAt, collectedAt: Date.now(), impactScore: await score({ title: entry.title, excerpt: entry.content.slice(0, 2_500) }) }; cache[id] = item; await saveCache(cache); if (item.impactScore >= 75 && onRelevant) { relevant += 1; await onRelevant(item); } } catch (error) { cache[id] = { id, source, sourceUrl: entry.sourceUrl, error: error.message, collectedAt: Date.now() }; await saveCache(cache); }
    }
  }
  return { discovered, relevant, cached: Object.keys(cache).length };
}
