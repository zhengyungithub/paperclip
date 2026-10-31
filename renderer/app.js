/* Paperclip 渲染进程 */
const api = window.paperclip;

const els = {
  body: document.body,
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  rail: document.getElementById('rail'),
  railCount: document.getElementById('railCount'),
  tabs: document.getElementById('tabs'),
  selectToggle: document.getElementById('selectToggle'),
  selectAll: document.getElementById('selectAll'),
  selectDone: document.getElementById('selectDone'),
  selectbar: document.getElementById('selectbar'),
  selCount: document.getElementById('selCount'),
  mergeBtn: document.getElementById('mergeBtn'),
  cancelSelect: document.getElementById('cancelSelect'),
  sizes: document.getElementById('sizes'),
  autoLaunch: document.getElementById('autoLaunch'),
  clearAll: document.getElementById('clearAll'),
  clearUnpinned: document.getElementById('clearUnpinned'),
  minimize: document.getElementById('minimize'),
  quit: document.getElementById('quit'),
  toast: document.getElementById('toast'),
  head: document.getElementById('head')
};

const PIN_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5h6l-.9 5.2 3.2 3.1v1.9H6.7v-1.9l3.2-3.1L9 4.5Z"/><path d="M12 14.7V20"/></svg>`;
const PIN_ICON_FILLED = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M9 4.5h6l-.9 5.2 3.2 3.1v1.9H6.7v-1.9l3.2-3.1L9 4.5Z"/><path d="M12 14.7V20" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>`;
const CROSS_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

const ui = {
  items: [],
  filter: 'all',
  selectMode: false,
  selected: new Set(),
  fontSize: 'm',
  autoLaunch: false,
  expanded: true
};

let toastTimer = null;
let collapseTimer = null;
let pointerInside = false;
let flashId = null;
let flashTimer = null;
let pendingClear = null;
let pendingClearTimer = null;

/* ------------------------------------------------------------------ 初始化 */

async function init() {
  bindEvents();
  try {
    const initial = await api.getState();
    applyState(initial, false);
  } catch (err) {
    console.error(err);
  }
  api.onState((payload) => applyState(payload, true));
  api.onExpanded((value) => {
    ui.expanded = !!value;
    if (ui.expanded) {
      cancelCollapse();
      // 唤起后一段时间没操作就自动隐藏
      scheduleCollapse(9000);
    }
  });
  scheduleCollapse(9000);
}

function applyState(payload, isUpdate) {
  if (!payload) return;
  ui.items = payload.items || [];
  ui.expanded = payload.expanded !== false;

  if (payload.settings) {
    ui.fontSize = payload.settings.fontSize || 'm';
    ui.autoLaunch = !!payload.settings.autoLaunch;
  }

  // 已经选中的条目要是被删掉了，同步清理
  const alive = new Set(ui.items.map((item) => item.id));
  ui.selected.forEach((id) => {
    if (!alive.has(id)) ui.selected.delete(id);
  });

  if (payload.reason === 'capture' && payload.newId) {
    const item = ui.items.find((entry) => entry.id === payload.newId);
    if (item) {
      const matches =
        ui.filter === 'all' || (ui.filter === 'text' && item.type === 'text') ||
        (ui.filter === 'image' && item.type === 'image');
      if (!matches) ui.filter = 'all';

      flashId = item.id;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashId = null;
      }, 1200);

      if (!pointerInside && !ui.selectMode) scheduleCollapse(4500);
    }
  }

  if (isUpdate) cancelCollapseIfHover();

  els.body.className = 'size-' + ui.fontSize;
  render();
  if (payload.reason === 'capture') els.list.scrollTop = 0;
}

/* ------------------------------------------------------------------ 渲染 */

function visibleItems() {
  if (ui.filter === 'text') return ui.items.filter((item) => item.type === 'text');
  if (ui.filter === 'image') return ui.items.filter((item) => item.type === 'image');
  return ui.items;
}

function selectedTextIds() {
  return ui.items
    .filter((item) => item.type === 'text' && ui.selected.has(item.id))
    .map((item) => item.id);
}

function render() {
  const items = visibleItems();

  els.count.textContent = `${items.length} 条`;
  els.railCount.textContent = ui.items.length > 99 ? '99+' : String(ui.items.length);

  Array.from(els.tabs.children).forEach((tab) => {
    tab.classList.toggle('is-on', tab.dataset.filter === ui.filter);
  });

  els.selectToggle.classList.toggle('hidden', ui.selectMode);
  els.selectAll.classList.toggle('hidden', !ui.selectMode);
  els.selectDone.classList.toggle('hidden', !ui.selectMode);
  els.selectbar.classList.toggle('hidden', !ui.selectMode);

  const selectedCount = selectedTextIds().length;
  els.selCount.textContent = String(selectedCount);
  els.mergeBtn.disabled = selectedCount === 0;

  if (ui.selectMode) {
    const texts = visibleItems().filter((item) => item.type === 'text');
    const allSelected = texts.length > 0 && texts.every((item) => ui.selected.has(item.id));
    els.selectAll.textContent = allSelected ? '取消全选' : '全选';
  }

  Array.from(els.sizes.children).forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.size === ui.fontSize);
  });
  els.autoLaunch.checked = ui.autoLaunch;

  renderList(items);
}

function renderList(items) {
  els.list.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.textContent = 'PAPERCLIP';
    const line = document.createElement('p');
    line.textContent =
      ui.filter === 'image'
        ? '还没有截图'
        : ui.filter === 'text'
          ? '还没有文字记录'
          : '复制点什么，就留在这里';
    const hint = document.createElement('span');
    hint.textContent = '文字和图片都会自动记下';
    empty.append(mark, line, hint);
    els.list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(createCard(item)));
  els.list.appendChild(fragment);
}

function createCard(item) {
  const card = document.createElement('article');
  card.dataset.id = item.id;
  card.className = 'item';
  if (item.pinned) card.classList.add('pinned');
  if (ui.selected.has(item.id)) card.classList.add('is-selected');
  if (flashId === item.id) card.classList.add('is-new');

  const selectable = ui.selectMode && item.type === 'text';
  if (selectable) {
    card.classList.add('has-check');
    const check = document.createElement('span');
    check.className = 'check';
    card.appendChild(check);
  }

  if (item.type === 'text') {
    const preview = document.createElement('p');
    preview.className = 'preview';
    preview.textContent = item.preview || '';
    card.appendChild(preview);
  } else {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = item.thumb;
    img.alt = '剪贴板图片';
    img.draggable = false;
    card.appendChild(img);
  }

  const foot = document.createElement('div');
  foot.className = 'item-foot';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(item.time);
  foot.appendChild(time);

  if (item.pinned) {
    const flag = document.createElement('span');
    flag.className = 'pin-flag';
    flag.textContent = '置顶';
    foot.appendChild(flag);
  }

  const right = document.createElement('div');
  right.className = 'item-foot-right';

  const tools = document.createElement('div');
  tools.className = 'tools';

  const pinBtn = document.createElement('button');
  pinBtn.className = 'tool pin' + (item.pinned ? ' pinned' : '');
  pinBtn.dataset.act = 'pin';
  pinBtn.title = item.pinned ? '取消置顶' : '置顶';
  pinBtn.innerHTML = item.pinned ? PIN_ICON_FILLED : PIN_ICON;

  const delBtn = document.createElement('button');
  delBtn.className = 'tool del';
  delBtn.dataset.act = 'delete';
  delBtn.title = '删除这条';
  delBtn.innerHTML = CROSS_ICON;

  tools.append(pinBtn, delBtn);
  right.appendChild(tools);
  foot.appendChild(right);
  card.appendChild(foot);

  return card;
}

function formatTime(ts) {
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

/* ------------------------------------------------------------------ 交互 */

function bindEvents() {
  // 分类
  els.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    if (ui.filter === tab.dataset.filter) return;
    ui.filter = tab.dataset.filter;
    ui.selected.clear();
    render();
  });

  // 记录点击：复制 / 选择
  els.list.addEventListener('click', async (event) => {
    const card = event.target.closest('.item');
    if (!card) return;

    const action = event.target.closest('[data-act]');
    if (action) {
      event.stopPropagation();
      const id = card.dataset.id;
      if (action.dataset.act === 'pin') {
        const res = await api.togglePin(id);
        if (res && res.ok) toast(res.pinned ? '已置顶，下次复制也不会被挤下去' : '已取消置顶');
      } else if (action.dataset.act === 'delete') {
        await api.removeItem(id);
        ui.selected.delete(id);
        toast('已删除');
      }
      return;
    }

    const item = ui.items.find((entry) => entry.id === card.dataset.id);
    if (!item) return;

    if (ui.selectMode) {
      if (item.type !== 'text') {
        toast('图片请单独点按复制');
        return;
      }
      if (ui.selected.has(item.id)) ui.selected.delete(item.id);
      else ui.selected.add(item.id);
      render();
      return;
    }

    const res = await api.copyItem(item.id);
    if (!res || !res.ok) {
      toast('复制失败，请重试');
      return;
    }
    toast(item.type === 'image' ? '已复制图片 · 回到原处 Ctrl+V' : '已复制 · 回到原处 Ctrl+V 粘贴');
    scheduleCollapse(850);
  });

  // 多选
  els.selectToggle.addEventListener('click', () => {
    ui.selectMode = true;
    ui.selected.clear();
    cancelCollapse();
    render();
  });

  els.selectAll.addEventListener('click', () => {
    const texts = visibleItems().filter((item) => item.type === 'text');
    const allSelected = texts.every((item) => ui.selected.has(item.id));
    if (allSelected) ui.selected.clear();
    else texts.forEach((item) => ui.selected.add(item.id));
    render();
  });

  els.selectDone.addEventListener('click', exitSelectMode);
  els.cancelSelect.addEventListener('click', exitSelectMode);

  els.mergeBtn.addEventListener('click', async () => {
    const ids = selectedTextIds();
    if (!ids.length) return;
    const res = await api.mergeCopy(ids);
    if (!res || !res.ok) {
      toast('合并复制失败');
      return;
    }
    toast(`已合并复制 ${res.count} 条 · 带编号`);
    exitSelectMode();
    scheduleCollapse(900);
  });

  // 字号
  els.sizes.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    ui.fontSize = btn.dataset.size;
    els.body.className = 'size-' + ui.fontSize;
    render();
    api.setFontSize(ui.fontSize);
  });

  // 开机启动
  els.autoLaunch.addEventListener('change', async () => {
    const enabled = els.autoLaunch.checked;
    ui.autoLaunch = enabled;
    const res = await api.setAutoLaunch(enabled);
    toast(enabled ? '已设为开机启动' : '已关闭开机启动');
    if (!res || !res.ok) els.autoLaunch.checked = !enabled;
  });

  // 清空（需要点两次确认）
  els.clearAll.addEventListener('click', () => armClear(els.clearAll, 'all', '清空全部'));
  els.clearUnpinned.addEventListener('click', () =>
    armClear(els.clearUnpinned, 'unpinned', '清除未置顶')
  );

  els.minimize.addEventListener('click', () => {
    api.setExpanded(false);
  });

  els.quit.addEventListener('click', () => {
    api.quit();
  });

  // 书脊：点一下就整窗隐藏，再按 Alt+Shift+V 唤起
  els.rail.addEventListener('click', () => {
    api.toggleExpanded().then((res) => {
      if (res && res.expanded) cancelCollapse();
    });
  });

  document.documentElement.addEventListener('mouseenter', () => {
    pointerInside = true;
    cancelCollapse();
  });

  document.documentElement.addEventListener('mouseleave', () => {
    pointerInside = false;
    if (!ui.selectMode) scheduleCollapse(1300);
  });

  // 拖动：只调整纵向位置
  els.head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return;

    const startY = event.screenY;
    let active = true;
    els.head.setPointerCapture(event.pointerId);
    api.dragStart();

    const onMove = (moveEvent) => {
      if (!active) return;
      api.dragMove(moveEvent.screenY - startY);
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      api.dragEnd();
      els.head.removeEventListener('pointermove', onMove);
      els.head.removeEventListener('pointerup', onEnd);
      els.head.removeEventListener('pointercancel', onEnd);
    };

    els.head.addEventListener('pointermove', onMove);
    els.head.addEventListener('pointerup', onEnd);
    els.head.addEventListener('pointercancel', onEnd);
  });

  document.addEventListener('dragstart', (event) => event.preventDefault());
  document.addEventListener('contextmenu', (event) => event.preventDefault());
}

function exitSelectMode() {
  ui.selectMode = false;
  ui.selected.clear();
  render();
  if (!pointerInside) scheduleCollapse(1300);
}

/* ------------------------------------------------------------------ 辅助 */

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, 1900);
}

function scheduleCollapse(ms) {
  if (ui.selectMode) return;
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (ui.selectMode) return;
    api.setExpanded(false);
  }, ms);
}

function cancelCollapse() {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
}

function cancelCollapseIfHover() {
  if (pointerInside) cancelCollapse();
}

function armClear(button, scope, originalLabel) {
  if (pendingClear === scope) {
    resetClearArming();
    api.clearHistory(scope).then((res) => {
      ui.selected.clear();
      const count = res && res.removed ? res.removed : 0;
      toast(scope === 'all' ? `已清空 ${count} 条记录` : `已清除 ${count} 条未置顶`);
    });
    return;
  }

  resetClearArming();
  pendingClear = scope;
  button.dataset.original = originalLabel;
  button.textContent = '再点一次确认';
  button.classList.add('arming');
  pendingClearTimer = setTimeout(resetClearArming, 3200);
}

function resetClearArming() {
  if (pendingClearTimer) {
    clearTimeout(pendingClearTimer);
    pendingClearTimer = null;
  }
  if (pendingClear) {
    const button = pendingClear === 'all' ? els.clearAll : els.clearUnpinned;
    button.textContent = button.dataset.original || '清空';
    button.classList.remove('arming');
  }
  pendingClear = null;
}

init();
