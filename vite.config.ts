import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.CRYPTO_AGENT_API_PORT || 8889);
const dashboardUrl = process.env.VITE_DASHBOARD_API_URL || 'http://43.163.91.179:8888';
const dashboardToken = process.env.VITE_DASHBOARD_TOKEN || '';
export default defineConfig({ plugins: [react()], optimizeDeps: { entries: ['index.html'] }, define: { __DASHBOARD_API_URL__: JSON.stringify(dashboardUrl), __DASHBOARD_TOKEN__: JSON.stringify(dashboardToken) }, server: { port: Number(process.env.CRYPTO_AGENT_WEB_PORT || 8888), strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } } });
