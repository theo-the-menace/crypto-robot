const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cryptoAgent', {
  notify: (title, body) => ipcRenderer.send('news-notification', { title: String(title), body: String(body) }),
});
