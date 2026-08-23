import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completeWithOverseasStrategy } from '../gmail-provider-router.mjs';

const root = resolve(process.cwd(), 'data', 'news');
const cacheFile = resolve(root, 'socialdata-x.json');
const queries = [
  ['White House', 'from:WhiteHouse -filter:replies'],
  ['White House Press Secretary', 'from:PressSec -filter:replies'],
  ['Donald Trump', 'from:realDonaldTrump -filter:replies'],
  ['Crypto X', '(bitcoin OR cryptocurrency OR "digital assets" OR stablecoin) -filter:replies'],
];
const readCache = async () => { try { return JSON.parse(await readFile(cacheFile, 'utf8')); } catch { return {}; } };
const saveCache = async (cache) => { await mkdir(root, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 }); };
async function search(query) { const key = String(process.env.SOCIALDATA_API_KEY || '').trim(); if (!key) return []; const response = await fetch(`https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}&type=Latest`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`SocialData returned ${response.status}`); const body = await response.json(); return body.tweets || body.data || []; }
async function score(item) { const raw = await completeWithOverseasStrategy({ content: `只返回0到100的整数，评估这条X消息对比特币、以太坊和整体加密市场的重要性。0-29无关，30-59一般政治或行业信息，60-74有潜在关联但影响有限，75-89明显影响主要资产或行业，90-94重大监管、ETF、交易所或政策事件，95-100国家级数字资产政策或系统性事件。普通政治宣传、重复转发、价格评论和未证实传闻不要高分。作者：${item.author}\n正文：${item.text}`, model: process.env.SOCIALDATA_RELEVANCE_MODEL || 'gpt-5.6-luna' }); const value = Number(String(raw).match(/\b(?:100|[1-9]?\d)\b/)?.[0]); if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid SocialData relevance score.'); return value; }
export async function collectSocialData({ onRelevant } = {}) { const cache = await readCache(); let discovered = 0; let relevant = 0; let processed = 0; for (const [source, query] of queries) { let tweets; try { tweets = await search(query); } catch (error) { console.warn('SocialData unavailable', source, error.message); continue; } for (const tweet of tweets.slice(0, 10)) { if (processed >= 20) break; const id = String(tweet.id_str || tweet.id || ''); if (!id || cache[id]) continue; processed += 1; discovered += 1; try { const author = tweet.user?.screen_name || tweet.user?.screenName || source; const text = String(tweet.full_text || tweet.text || '').trim(); const sourceUrl = `https://x.com/${author}/status/${id}`; const item = { id, source, sourceUrl, title: text.split(/\n+/)[0].slice(0, 180) || source, content: text, excerpt: text.slice(0, 2_500), publishedAt: Date.parse(tweet.tweet_created_at || tweet.created_at) || Date.now(), collectedAt: Date.now(), impactScore: await score({ author, text }) }; cache[id] = item; await saveCache(cache); if (item.impactScore >= 75 && onRelevant) { relevant += 1; await onRelevant(item); } } catch (error) { cache[id] = { id, source, error: error.message, collectedAt: Date.now() }; await saveCache(cache); } } } return { discovered, relevant, cached: Object.keys(cache).length }; }
