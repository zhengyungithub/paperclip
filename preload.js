const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperclip', {
  getState: () => ipcRenderer.invoke('state:get'),
  copyItem: (id) => ipcRenderer.invoke('item:copy', id),
  mergeCopy: (ids) => ipcRenderer.invoke('items:merge', ids),
  togglePin: (id) => ipcRenderer.invoke('item:pin', id),
  removeItem: (id) => ipcRenderer.invoke('item:delete', id),
  clearHistory: (scope) => ipcRenderer.invoke('history:clear', scope),
  setFontSize: (size) => ipcRenderer.invoke('settings:font', size),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('settings:autoLaunch', enabled),
  setExpanded: (value) => ipcRenderer.invoke('ui:set-expanded', value),
  toggleExpanded: () => ipcRenderer.invoke('ui:toggle'),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  dragMove: (dy) => ipcRenderer.send('window:drag-move', dy),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },
  onExpanded: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ui:expanded', listener);
    return () => ipcRenderer.removeListener('ui:expanded', listener);
  }
});
