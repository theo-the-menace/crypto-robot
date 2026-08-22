import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.CRYPTO_AGENT_API_PORT || 8889);
  const apiTarget = env.CRYPTO_AGENT_API_URL || `http://127.0.0.1:${apiPort}`;
  const dashboardUrl = env.VITE_DASHBOARD_API_URL || 'http://43.163.91.179:8888';
  const dashboardToken = env.VITE_DASHBOARD_TOKEN || '';
  return { plugins: [react()], optimizeDeps: { entries: ['index.html'] }, define: { __DASHBOARD_API_URL__: JSON.stringify(dashboardUrl), __DASHBOARD_TOKEN__: JSON.stringify(dashboardToken) }, server: { port: Number(env.CRYPTO_AGENT_WEB_PORT || 8888), strictPort: true, proxy: { '/api': { target: apiTarget, changeOrigin: true, secure: false } } } };
});
