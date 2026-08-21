import { execFileSync, spawn } from 'node:child_process';

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
