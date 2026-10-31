const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// 基本常量
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 380;   // 面板完整宽度
const RAIL_WIDTH = 46;     // 收起后留在屏幕边的宽度
const SLIDE_MS = 260;      // 滑出 / 收回动画时长
const POLL_MS = 700;       // 剪贴板轮询间隔
const MAX_ITEMS = 200;     // 最多保留的记录条数
const MAX_IMAGES = 80;     // 图片最多保留数量
const HOTKEY = 'Alt+Shift+V'; // 随时唤起 / 收起面板

const isDev = !app.isPackaged;

let win = null;
let dataDir = '';
let imagesDir = '';
let storeFile = '';
let history = [];
let settings = { fontSize: 'm', autoLaunch: false, y: null };
let expanded = false; // false = 整窗隐藏，屏幕上完全看不到
let slideTimer = null;
let pollTimer = null;
let lastHash = '';
let ignoreNextPoll = false;
let dragStartBounds = null;
let saveTimer = null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// 本地存储
// ---------------------------------------------------------------------------

function loadStore() {
  dataDir = app.getPath('userData');
  imagesDir = path.join(dataDir, 'images');
  storeFile = path.join(dataDir, 'paperclip.json');
  try {
    fs.mkdirSync(imagesDir, { recursive: true });
  } catch (_) {}

  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    if (Array.isArray(raw.history)) history = raw.history;
    if (raw.settings) {
      settings = Object.assign(settings, raw.settings);
    }
  } catch (_) {
    history = [];
  }

  // 丢掉已经丢失图片文件的记录
  history = history.filter((item) => {
    if (!item || !item.id || !item.hash) return false;
    if (item.type === 'image') {
      return !!item.file && fs.existsSync(path.join(imagesDir, item.file));
    }
    return item.type === 'text' && typeof item.text === 'string';
  });
}

function persistNow() {
  const data = { settings, history };
  const tmp = storeFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, storeFile);
  } catch (err) {
    console.error('[paperclip] persist failed', err);
  }
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 250);
}

// ---------------------------------------------------------------------------
// 记录增删
// ---------------------------------------------------------------------------

function sortedHistory() {
  return history.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.time - a.time;
  });
}

function trimHistory() {
  // 非置顶记录超量时，从最旧的开始丢
  let unpinned = history.filter((i) => !i.pinned).sort((a, b) => a.time - b.time);
  let over = unpinned.length - MAX_ITEMS;
  let imageCount = history.filter((i) => i.type === 'image').length;

  if (imageCount > MAX_IMAGES) {
    const oldImages = unpinned.filter((i) => i.type === 'image');
    while (imageCount > MAX_IMAGES && oldImages.length) {
      const victim = oldImages.shift();
      removeItem(victim.id, false);
      imageCount -= 1;
    }
  }
  while (over > 0 && unpinned.length) {
    const victim = unpinned.shift();
    removeItem(victim.id, false);
    over -= 1;
  }
  persist();
}

function removeItem(id, withPersist = true) {
  const index = history.findIndex((i) => i.id === id);
  if (index === -1) return false;
  const item = history[index];
  history.splice(index, 1);
  deleteItemFiles(item);
  if (withPersist) persist();
  return true;
}

function deleteItemFiles(item) {
  if (item.type !== 'image') return;
  [item.file, item.thumb].forEach((name) => {
    if (!name) return;
    try {
      const p = path.join(imagesDir, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
  });
}

function readClipboardSnapshot() {
  try {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const size = img.getSize();
      if (size.width >= 4 && size.height >= 4) {
        const bitmap = img.toBitmap();
        return {
          type: 'image',
          hash: 'i' + sha1(size.width + 'x' + size.height + ':' + sha1(bitmap)),
          image: img,
          width: size.width,
          height: size.height
        };
      }
    }
    const text = clipboard.readText();
    if (text && text.trim()) {
      return { type: 'text', hash: 't' + sha1(text), text };
    }
  } catch (_) {}
  return null;
}

function storeImage(snapshot) {
  const id = newId();
  const file = id + '.png';
  const png = snapshot.image.toPNG();
  fs.writeFileSync(path.join(imagesDir, file), png);

  let thumb = file;
  if (snapshot.width > 560) {
    const resized = snapshot.image.resize({ width: 480, quality: 'good' });
    thumb = id + '_thumb.png';
    fs.writeFileSync(path.join(imagesDir, thumb), resized.toPNG());
  }

  return {
    id,
    type: 'image',
    hash: snapshot.hash,
    file,
    thumb,
    width: snapshot.width,
    height: snapshot.height,
    time: Date.now(),
    pinned: false
  };
}

function addTextItem(snapshot) {
  const existing = history.find((i) => i.hash === snapshot.hash);
  if (existing) {
    existing.time = Date.now();
    persist();
    return existing;
  }
  const item = {
    id: newId(),
    type: 'text',
    hash: snapshot.hash,
    text: snapshot.text,
    time: Date.now(),
    pinned: false
  };
  history.push(item);
  trimHistory();
  persist();
  return item;
}

function addImageItem(snapshot) {
  const existing = history.find((i) => i.hash === snapshot.hash);
  if (existing) {
    existing.time = Date.now();
    persist();
    return existing;
  }
  const item = storeImage(snapshot);
  history.push(item);
  trimHistory();
  persist();
  return item;
}

// ---------------------------------------------------------------------------
// 窗口位置 / 滑出收起
// ---------------------------------------------------------------------------

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function expandedX() {
  const area = workArea();
  return area.x + area.width - PANEL_WIDTH;
}

function collapsedX() {
  const area = workArea();
  return area.x + area.width - RAIL_WIDTH;
}

function defaultY(height) {
  const area = workArea();
  return area.y + Math.round((area.height - height) / 2);
}

function slideTo(targetX, targetWidth, nextExpanded) {
  if (!win) return;
  const bounds = win.getBounds();
  expanded = nextExpanded;
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('ui:expanded', expanded);
  }

  if (slideTimer) {
    clearInterval(slideTimer);
    slideTimer = null;
  }

  const fromX = bounds.x;
  const fromWidth = bounds.width;
  const deltaX = targetX - fromX;
  const deltaWidth = targetWidth - fromWidth;

  if (Math.abs(deltaX) < 2 && Math.abs(deltaWidth) < 2) {
    win.setBounds({
      x: targetX,
      y: bounds.y,
      width: targetWidth,
      height: bounds.height
    });
    return;
  }

  const startedAt = Date.now();
  slideTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(slideTimer);
      slideTimer = null;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / SLIDE_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    win.setBounds({
      x: Math.round(fromX + deltaX * eased),
      y: bounds.y,
      width: Math.round(fromWidth + deltaWidth * eased),
      height: bounds.height
    });
    if (progress >= 1) {
      clearInterval(slideTimer);
      slideTimer = null;
    }
  }, 8);
}

function collapseWindow() {
  if (!expanded) return;
  slideTo(collapsedX(), RAIL_WIDTH, false);
  // 滑回贴边后整窗隐藏：不需要时屏幕右侧什么都不留
  setTimeout(() => {
    if (win && !win.isDestroyed() && !expanded) win.hide();
  }, SLIDE_MS + 20);
}

function expandWindow() {
  if (expanded) return;
  const bounds = win ? win.getBounds() : null;
  if (win && !win.isDestroyed() && !win.isVisible() && bounds) {
    // 从贴边位置滑出，再展开到完整面板
    win.setBounds({ x: collapsedX(), y: bounds.y, width: RAIL_WIDTH, height: bounds.height });
    win.showInactive();
  }
  slideTo(expandedX(), PANEL_WIDTH, true);
}

function toggleWindow() {
  if (expanded) collapseWindow();
  else expandWindow();
}

// ---------------------------------------------------------------------------
// 数据 -> 渲染进程
// ---------------------------------------------------------------------------

function serialize(item) {
  const base = {
    id: item.id,
    type: item.type,
    time: item.time,
    pinned: !!item.pinned
  };
  if (item.type === 'text') {
    base.preview = item.text.length > 600 ? item.text.slice(0, 600) : item.text;
    base.chars = item.text.length;
  } else {
    const thumbFile = item.thumb || item.file;
    base.thumb = pathToFileURL(path.join(imagesDir, thumbFile)).href;
    base.width = item.width;
    base.height = item.height;
  }
  return base;
}

function statePayload(reason = null, newIdValue = null) {
  return {
    items: sortedHistory().map(serialize),
    settings: {
      fontSize: settings.fontSize,
      autoLaunch: !!settings.autoLaunch
    },
    expanded,
    reason,
    newId: newIdValue
  };
}

function pushState(reason = null, newIdValue = null) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state:update', statePayload(reason, newIdValue));
}

// ---------------------------------------------------------------------------
// 剪贴板监听
// ---------------------------------------------------------------------------

function startWatching() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    let snapshot = null;
    try {
      snapshot = readClipboardSnapshot();
    } catch (_) {
      return;
    }
    // 自己写入剪贴板的记录不要再重复收进来
    if (ignoreNextPoll) {
      ignoreNextPoll = false;
      lastHash = snapshot ? snapshot.hash : '';
      return;
    }
    if (!snapshot) return;
    if (snapshot.hash === lastHash) return;
    lastHash = snapshot.hash;

    let item = null;
    try {
      item = snapshot.type === 'image' ? addImageItem(snapshot) : addTextItem(snapshot);
    } catch (err) {
      console.error('[paperclip] capture failed', err);
      return;
    }
    if (!item) return;

    // 有新复制也不自动弹出面板，只默默记下；按快捷键再查看
    pushState('capture', item.id);
  }, POLL_MS);
}

function writeClipboard(item) {
  lastHash = item.hash;
  ignoreNextPoll = true;
  if (item.type === 'text') {
    clipboard.writeText(item.text);
  } else {
    const image = nativeImage.createFromPath(path.join(imagesDir, item.file));
    clipboard.writeImage(image);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('state:get', () => statePayload());

  ipcMain.handle('item:copy', (_event, id) => {
    const item = history.find((i) => i.id === id);
    if (!item) return { ok: false };
    try {
      writeClipboard(item);
    } catch (_) {
      return { ok: false };
    }
    return { ok: true };
  });

  ipcMain.handle('items:merge', (_event, ids) => {
    const picked = (ids || [])
      .map((id) => history.find((i) => i.id === id))
      .filter((i) => i && i.type === 'text');
    if (!picked.length) return { ok: false, count: 0 };
    const merged = picked.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
    lastHash = 't' + sha1(merged);
    ignoreNextPoll = true;
    clipboard.writeText(merged);
    return { ok: true, count: picked.length };
  });

  ipcMain.handle('item:pin', (_event, id) => {
    const item = history.find((i) => i.id === id);
    if (!item) return { ok: false };
    item.pinned = !item.pinned;
    persist();
    pushState('pin');
    return { ok: true, pinned: item.pinned };
  });

  ipcMain.handle('item:delete', (_event, id) => {
    const removed = removeItem(id);
    if (removed) pushState('delete');
    return { ok: removed };
  });

  ipcMain.handle('history:clear', (_event, scope) => {
    const targets = history.filter((item) => (scope === 'unpinned' ? !item.pinned : true));
    targets.forEach((item) => {
      deleteItemFiles(item);
      const index = history.indexOf(item);
      if (index > -1) history.splice(index, 1);
    });
    persist();
    pushState('clear');
    return { ok: true, removed: targets.length };
  });

  ipcMain.handle('settings:font', (_event, size) => {
    if (!['s', 'm', 'l'].includes(size)) return { ok: false };
    settings.fontSize = size;
    persist();
    pushState('settings');
    return { ok: true };
  });

  ipcMain.handle('settings:autoLaunch', (_event, enabled) => {
    settings.autoLaunch = !!enabled;
    try {
      if (app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: !!enabled });
      } else {
        app.setLoginItemSettings({
          openAtLogin: !!enabled,
          path: process.execPath,
          args: [path.resolve(app.getAppPath())]
        });
      }
    } catch (_) {}
    persist();
    pushState('settings');
    return { ok: true };
  });

  ipcMain.handle('ui:set-expanded', (_event, wantExpanded) => {
    if (wantExpanded) expandWindow();
    else collapseWindow();
    return { ok: true, expanded };
  });

  ipcMain.handle('ui:toggle', () => {
    toggleWindow();
    return { ok: true, expanded };
  });

  ipcMain.on('window:drag-start', () => {
    if (win && !win.isDestroyed()) dragStartBounds = win.getBounds();
  });

  ipcMain.on('window:drag-move', (_event, dy) => {
    if (!dragStartBounds || !win || win.isDestroyed()) return;
    const area = workArea();
    const y = clamp(
      dragStartBounds.y + Math.round(dy || 0),
      area.y,
      area.y + area.height - dragStartBounds.height
    );
    win.setBounds({ x: win.getBounds().x, y, width: PANEL_WIDTH, height: dragStartBounds.height });
  });

  ipcMain.on('window:drag-end', () => {
    if (win && !win.isDestroyed()) {
      settings.y = win.getBounds().y;
      persist();
    }
    dragStartBounds = null;
  });

  ipcMain.handle('app:quit', () => {
    persistNow();
    app.quit();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function createWindow() {
  const area = workArea();
  const height = clamp(area.height - 96, 460, 820);
  const y = clamp(
    typeof settings.y === 'number' ? settings.y : defaultY(height),
    area.y,
    area.y + area.height - height
  );

  win = new BrowserWindow({
    width: PANEL_WIDTH,
    height,
    x: expandedX(),
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    // 启动时不出现，按 Alt+Shift+V 才唤起
    win.webContents.send('ui:expanded', expanded);
  });

  win.on('closed', () => {
    win = null;
  });

  if (isDev) {
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      console.error('[paperclip] page failed to load', code, description);
    });
  }

  if (isDev && process.env.PAPERCLIP_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    expandWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.paperclip.app');
    loadStore();
    registerIpc();
    createWindow();

    // 启动时不把当前剪贴板内容当成"新复制"
    const initial = readClipboardSnapshot();
    if (initial) lastHash = initial.hash;

    startWatching();

    const registered = globalShortcut.register(HOTKEY, () => {
      toggleWindow();
    });
    if (!registered) {
      console.error(`[paperclip] 快捷键 ${HOTKEY} 注册失败，可能已被其他软件占用`);
    }

    screen.on('display-metrics-changed', () => {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const area = workArea();
      const height = clamp(area.height - 96, 460, 820);
      win.setBounds({
        x: expanded ? expandedX() : collapsedX(),
        y: clamp(bounds.y, area.y, area.y + area.height - height),
        width: expanded ? PANEL_WIDTH : RAIL_WIDTH,
        height
      });
    });

    app.on('activate', () => {
      if (win) expandWindow();
    });
  });

  app.on('before-quit', () => {
    persistNow();
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
