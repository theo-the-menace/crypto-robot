import { execFileSync, spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';

try { loadEnvFile('.env'); } catch {}

const apiUrl = (process.env.CRYPTO_AGENT_REMOTE_API_URL || '').replace(/\/$/, '');
if (apiUrl) {
  try {
    const response = await fetch(`${apiUrl}/api/status`, { signal: AbortSignal.timeout(5_000) });
    console.log(`Remote CryptoAgent API: ${response.ok ? 'healthy' : `HTTP ${response.status}`}`);
  } catch (error) {
    console.warn(`Remote CryptoAgent API unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
  }
}

for (const port of [8888, 8889]) {
  try {
    const pids = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
  } catch {}
}

const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: false });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
