const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, nativeTheme } = require('electron');
const { fork } = require('node:child_process');
const { createServer } = require('node:http');
const { existsSync, readFileSync, createReadStream } = require('node:fs');
const { extname, join, resolve } = require('node:path');

app.setName('CryptoAgent');

let mainWindow;
let quitting = false;
let apiProcess;
let staticServer;
let tray;
let widgetWindow;

function loadLocalEnv() {
  const candidates = [
    process.env.CRYPTO_AGENT_ENV_FILE,
    join(app.getPath('userData'), '.env'),
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '../.env'),
  ].filter(Boolean);
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function startApi() {
  if (process.env.CRYPTO_AGENT_DEV_SERVER === '1') return;
  loadLocalEnv();
  const serverPath = join(__dirname, '../server/index.mjs');
  apiProcess = fork(serverPath, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CRYPTO_AGENT_API_PORT: '5451' }, silent: true });
}

function startStaticServer() {
  if (process.env.CRYPTO_AGENT_DEV_SERVER === '1') return Promise.resolve();
  const root = join(__dirname, '../dist');
  staticServer = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      const proxy = require('node:http').request({ hostname: '127.0.0.1', port: 5451, path: request.url, method: request.method, headers: request.headers }, (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(response);
      });
      proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local API unavailable.'); });
      request.pipe(proxy); return;
    }
    const requested = request.url === '/' ? '/index.html' : request.url?.split('?')[0];
    const safePath = requested?.replaceAll('..', '') || '/index.html';
    const file = join(root, safePath);
    if (!file.startsWith(root) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(response);
  });
  return new Promise((resolveServer) => staticServer.listen(5450, '127.0.0.1', resolveServer));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'CryptoAgent',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101214' : '#f4f5f6',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') },
  });
  // Keep macOS trackpad pinch inside the chart instead of zooming the whole Electron page.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.loadURL('http://127.0.0.1:5450');
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createWidget() {
  widgetWindow = new BrowserWindow({ width: 380, height: 245, resizable: false, show: false, alwaysOnTop: true, title: 'CryptoAgent K 线', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') } });
  widgetWindow.webContents.setVisualZoomLevelLimits(1, 1);
  widgetWindow.loadURL('http://127.0.0.1:5450/?widget=1');
  widgetWindow.on('closed', () => { widgetWindow = null; });
}

function toggleWidget() {
  if (!widgetWindow) return;
  if (widgetWindow.isVisible()) widgetWindow.hide(); else widgetWindow.show();
}

app.whenReady().then(async () => {
  startApi();
  await startStaticServer();
  createWindow();
  createWidget();
  const trayIcon = nativeImage.createFromDataURL('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M2 13.5 6.5 9l3 2.5L16 5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('CryptoAgent');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示 CryptoAgent', click: () => mainWindow?.show() }, { label: '显示 K 线', click: toggleWidget }, { type: 'separator' }, { label: '退出', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', toggleWidget);
  ipcMain.on('news-notification', (_event, payload) => {
    if (!payload?.title || !Notification.isSupported()) return;
    new Notification({ title: payload.title, body: payload.body || '' }).show();
  });
  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => { quitting = true; tray?.destroy(); widgetWindow?.close(); apiProcess?.kill(); staticServer?.close(); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
