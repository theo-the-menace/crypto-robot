const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

export function telegramConfigured() { return Boolean(token && chatId); }

function impactLabel(score) {
  if (score >= 95) return '极重大';
  if (score >= 90) return '重大';
  if (score >= 85) return '高关注';
  if (score >= 80) return '重要';
  return '关注';
}

export async function sendTelegramNews(item) {
  if (!telegramConfigured() || !item?.id) return { skipped: true, reason: 'not-configured' };
  const score = Number(item.impactScore || 0);
  if (score < 75) return { skipped: true, reason: 'below-threshold' };
  const text = `【${impactLabel(score)} ${score}/100】${item.source || 'News'}\n${item.title || 'Market update'}\n${new Date(Number(item.publishedAt)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}\n\n${String(item.content || '').slice(0, 3_700)}`;
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Telegram send failed (${response.status}).`);
  return { sent: true };
}
