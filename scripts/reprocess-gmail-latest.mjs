import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isCmeMessage, processGmailMessage } from '../server/gmail-pipeline.mjs';
import { MarketMessageStore } from '../server/market-message-store.mjs';

const gmailFile = resolve(process.cwd(), 'data/gmail/messages.json');
const marketFile = resolve(process.cwd(), 'data/market/messages.json');
const messages = JSON.parse(await readFile(gmailFile, 'utf8'))
  .filter(isCmeMessage)
  .sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))
  .slice(0, 5);

await mkdir(resolve(process.cwd(), 'data/market'), { recursive: true });
const tmp = `${marketFile}.${process.pid}.tmp`;
await writeFile(tmp, '[]', { mode: 0o600 });
await rename(tmp, marketFile);

const store = new MarketMessageStore();
for (const message of messages) {
  console.log(JSON.stringify({ event: 'gmail_reprocess_start', id: message.id, subject: message.subject }));
  const result = await processGmailMessage(message, store);
  console.log(JSON.stringify({ event: 'gmail_reprocess_done', id: message.id, result }));
}
console.log(JSON.stringify({ event: 'gmail_reprocess_complete', selected: messages.length }));
