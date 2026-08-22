import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'data', 'market', 'messages.json');
const read = async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; } };
const save = async (items) => { await mkdir(resolve(process.cwd(), 'data', 'market'), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(items, null, 2), { mode: 0o600 }); await rename(tmp, file); };

export class MarketMessageStore {
  constructor() { this.streams = new Set(); }
  async list(limit = 100) { return (await read()).slice(-Math.min(500, Math.max(1, limit))).reverse(); }
  subscribe(response) { this.streams.add(response); return () => this.streams.delete(response); }
  async add(message) {
    const items = await read();
    if (items.some((item) => item.id === message.id || (message.sourceMessageId && item.sourceMessageId === message.sourceMessageId))) return null;
    const item = { id: randomUUID(), createdAt: Date.now(), ...message };
    await save([...items, item].slice(-2000));
    const event = `event: market-message\ndata: ${JSON.stringify(item)}\n\n`;
    for (const response of this.streams) response.write(event);
    return item;
  }
}
