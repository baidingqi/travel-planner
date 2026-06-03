/**
 * app.js — 旅行规划助手 前端逻辑
 *
 * 功能：表单交互、API 调用编排、页面切换、历史管理
 */

// ============================================================
// 全局状态
// ============================================================

const state = {
  departure: '',
  destination: '',
  travelMode: '',
  startDate: '',
  endDate: '',
  selectedTypes: [],
  currentItinerary: null,
  currentDayIndex: 0,
  activeTab: 'plan',
  isSaved: false
};

// ============================================================
// DOM 元素引用
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================================
// 页面导航
// ============================================================

function showPage(name) {
  $$('.page').forEach(p => p.classList.remove('active'));
  const page = $(`#page-${name}`);
  if (page) page.classList.add('active');
  state.activeTab = name;

  // 更新导航高亮
  $$('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === (name === 'history' ? 'history' : 'plan'));
  });

  if (name === 'history') renderHistory();
}

// 导航标签点击
$$('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab === 'history' ? 'history' : 'plan';
    if (target === 'plan' && state.currentItinerary && $('#page-itinerary').classList.contains('active')) {
      // 如果正在看行程，留在行程页
      showPage('itinerary');
    } else {
      showPage(target);
    }
  });
});

// ============================================================
// 城市输入自动补全
// ============================================================

let suggestTimer = null;

function setupCityInput(inputId, suggestId) {
  const input = $(`#${inputId}`);
  const suggestBox = $(`#${suggestId}`);

  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const val = input.value.trim();
    if (!val) { suggestBox.innerHTML = ''; suggestBox.style.display = 'none'; return; }

    suggestTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/city-suggest?keyword=${encodeURIComponent(val)}`);
        const data = await res.json();
        if (data.suggestions && data.suggestions.length > 0) {
          suggestBox.innerHTML = data.suggestions.map(s =>
            `<div class="suggest-item" data-name="${s.name}">${s.name}<small>${s.district || ''}</small></div>`
          ).join('');
          suggestBox.style.display = 'block';
        } else {
          suggestBox.style.display = 'none';
        }
      } catch (e) { suggestBox.style.display = 'none'; }
    }, 300);
  });

  suggestBox.addEventListener('click', (e) => {
    const item = e.target.closest('.suggest-item');
    if (item) {
      input.value = item.dataset.name;
      suggestBox.style.display = 'none';
      if (inputId === 'departure') state.departure = item.dataset.name;
      else state.destination = item.dataset.name;
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { suggestBox.style.display = 'none'; }, 200);
  });
}

setupCityInput('departure', 'depSuggestions');
setupCityInput('destination', 'destSuggestions');

// 热门城市点击
$$('.hot-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    const targetInput = document.activeElement === $('#departure') ? 'departure' : 'destination';
    if (!$('#departure').value) {
      $('#departure').value = tag.dataset.city;
      state.departure = tag.dataset.city;
    } else {
      $('#destination').value = tag.dataset.city;
      state.destination = tag.dataset.city;
    }
  });
});

// 交换按钮
$('#swapBtn').addEventListener('click', () => {
  const depVal = $('#departure').value;
  const destVal = $('#destination').value;
  $('#departure').value = destVal;
  $('#destination').value = depVal;
  state.departure = destVal;
  state.destination = destVal;
});

// ============================================================
// 出行方式选择
// ============================================================

$$('#modeGroup .mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#modeGroup .mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.travelMode = btn.dataset.mode;
  });
});

// ============================================================
// 日期选择
// ============================================================

const today = new Date().toISOString().split('T')[0];
$('#startDate').setAttribute('min', today);
$('#endDate').setAttribute('min', today);

$('#startDate').addEventListener('change', () => {
  state.startDate = $('#startDate').value;
  $('#endDate').setAttribute('min', state.startDate);
  updateTripDays();
});

$('#endDate').addEventListener('change', () => {
  state.endDate = $('#endDate').value;
  updateTripDays();
});

function updateTripDays() {
  if (state.startDate && state.endDate) {
    const s = new Date(state.startDate);
    const e = new Date(state.endDate);
    const days = Math.max(1, Math.ceil((e - s) / 86400000) + 1);
    $('#tripDays').style.display = 'block';
    $('#daysNum').textContent = days;
    $('#nightsNum').textContent = days - 1;
  }
}

// ============================================================
// 景点类型选择
// ============================================================

$$('#typeTags .type-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    tag.classList.toggle('active');
    state.selectedTypes = [...$$('#typeTags .type-tag.active')].map(t => t.dataset.type);
  });
});

// ============================================================
// 生成行程
// ============================================================

$('#btnGenerate').addEventListener('click', async () => {
  // 收集表单数据
  state.departure = $('#departure').value.trim();
  state.destination = $('#destination').value.trim();
  if (!state.travelMode) state.travelMode = [...$$('#modeGroup .mode-btn.active')].map(b => b.dataset.mode)[0] || 'drive';

  // 校验
  const errorEl = $('#formError');
  if (!state.departure) return showError('请选择出发城市');
  if (!state.destination) return showError('请选择目的城市');
  if (state.departure === state.destination) return showError('出发地和目的地不能相同');
  if (!state.startDate) return showError('请选择出发日期');
  if (!state.endDate) return showError('请选择返回日期');
  if (state.selectedTypes.length === 0) return showError('请至少选择一种景点类型');
  errorEl.style.display = 'none';

  // 进入加载页
  showPage('loading');
  updateStep('poi', 'running', '◉');
  $('#loadingTitle').textContent = '正在搜索目的地景点...';

  try {
    // 并行：搜索景点 + 路线
    const [poiRes, routeRes] = await Promise.all([
      fetch(`/api/search-poi?city=${encodeURIComponent(state.destination)}&types=${state.selectedTypes.join(',')}`),
      fetch(`/api/route-info?origin=${encodeURIComponent(state.departure)}&destination=${encodeURIComponent(state.destination)}&mode=${state.travelMode}`)
    ]);

    const poiData = await poiRes.json();
    const routeData = await routeRes.json();
    const attractions = poiData.pois || [];

    if (attractions.length === 0) {
      showPage('plan');
      return showError(`未在${state.destination}找到匹配景点，请调整条件`);
    }

    updateStep('poi', 'done', '✓');
    updateStep('route', 'done', '✓');
    updateStep('generate', 'running', '◉');
    $('#loadingTitle').textContent = '正在智能生成行程方案...';

    // 生成行程
    const genRes = await fetch('/api/generate-itinerary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formData: {
          departure: state.departure,
          destination: state.destination,
          travelMode: state.travelMode,
          startDate: state.startDate,
          endDate: state.endDate,
          types: state.selectedTypes
        },
        attractions,
        transport: routeData
      })
    });

    const itinerary = await genRes.json();
    if (itinerary.error) throw new Error(itinerary.error);

    state.currentItinerary = itinerary;
    state.currentDayIndex = 0;
    state.isSaved = false;

    updateStep('generate', 'done', '✓');
    $('#loadingTitle').textContent = '✨ 行程生成完毕！';

    setTimeout(() => {
      renderItinerary();
      showPage('itinerary');
    }, 600);

  } catch (err) {
    console.error('生成失败:', err);
    showPage('plan');
    showError(err.message || '行程生成失败，请检查网络后重试');
  }
});

function showError(msg) {
  const el = $('#formError');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function updateStep(step, status, icon) {
  const el = $(`.step[data-step="${step}"]`);
  if (el) {
    el.textContent = `${icon} ${el.textContent.replace(/[○◉✓✕]/, '').trim()}`;
    el.className = `step ${status}`;
  }
}

// ============================================================
// 渲染行程
// ============================================================

function renderItinerary() {
  const it = state.currentItinerary;
  if (!it) return;

  // 摘要卡片
  const s = it.tripSummary;
  $('#summaryCard').innerHTML = `
    <div class="summary-route">
      <strong>${s.departureCity}</strong>
      <span class="mode-icon">${s.travelMode === 'flight' ? '✈️' : s.travelMode === 'train' ? '🚄' : '🚗'}</span>
      <strong>${s.destinationCity}</strong>
    </div>
    <div class="summary-meta">
      <span>📅 ${s.startDate} ~ ${s.endDate}</span>
      <span>📊 ${s.totalDays}天${s.totalNights}晚</span>
      ${s.costEstimate ? `<span>💰 ¥${s.costEstimate.min}-${s.costEstimate.max}</span>` : ''}
    </div>
  `;

  // 天数 Tab
  const days = it.days || [];
  $('#dayTabs').innerHTML = days.map((d, i) =>
    `<button class="day-tab ${i === 0 ? 'active' : ''}" data-day="${i}">
      第${d.dayNumber}天<br><small>${d.date}</small>
    </button>`
  ).join('');

  $$('#dayTabs .day-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.currentDayIndex = parseInt(tab.dataset.day);
      renderDay();
      $$('#dayTabs .day-tab').forEach(t => t.classList.toggle('active', t.dataset.day == state.currentDayIndex));
    });
  });

  renderDay();
}

function renderDay() {
  const days = state.currentItinerary.days || [];
  const day = days[state.currentDayIndex];
  if (!day) return;

  let html = '';

  // 日摘要
  if (day.daySummary?.note) {
    html += `<div class="day-note">📋 ${day.daySummary.note}</div>`;
  }

  // 时间线
  day.activities.forEach((act, idx) => {
    const isLast = idx === day.activities.length - 1;

    if (act.type === 'transport') {
      html += `
        <div class="tl-item">
          <div class="tl-left"><span class="tl-time">${act.time}</span><span class="tl-dot transport"></span>${isLast ? '' : '<span class="tl-line"></span>'}</div>
          <div class="tl-right"><div class="tl-card transport-card">
            <span class="tl-icon">${act.icon === 'flight' ? '✈️' : act.icon === 'train' ? '🚄' : '🚗'}</span>
            <div><strong>${act.title}</strong><br><small>${act.detail || ''}</small></div>
          </div></div>
        </div>`;
    } else if (act.type === 'meal') {
      html += `
        <div class="tl-item">
          <div class="tl-left"><span class="tl-time">${act.time}</span><span class="tl-dot meal"></span>${isLast ? '' : '<span class="tl-line"></span>'}</div>
          <div class="tl-right"><div class="tl-card meal-card">
            🍽️ <strong>${act.title}</strong> <small>${act.detail || ''}</small>
          </div></div>
        </div>`;
    } else if (act.type === 'activity' && act.attraction) {
      const a = act.attraction;
      html += `
        <div class="tl-item">
          <div class="tl-left"><span class="tl-time">${act.time}</span><span class="tl-dot activity"></span>${isLast ? '' : '<span class="tl-line"></span>'}</div>
          <div class="tl-right"><div class="tl-card activity-card">
            <div class="act-header">
              <strong>${a.name}</strong>
              ${a.rating > 0 ? `<span class="rating">⭐ ${a.rating.toFixed(1)}</span>` : ''}
            </div>
            <div class="act-meta">
              ${a.address ? `<span>📍 ${a.address}</span>` : ''}
              ${a.openingHours ? `<span>🕐 ${a.openingHours}</span>` : ''}
              ${a.ticketPrice ? `<span>🎫 ${a.ticketPrice}</span>` : ''}
            </div>
            ${a.tips ? `<div class="act-tips">💡 ${a.tips}</div>` : ''}
          </div></div>
        </div>`;
    }
  });

  $('#dayContent').innerHTML = html;
}

// ============================================================
// 操作按钮
// ============================================================

$('#btnRegenerate').addEventListener('click', () => showPage('plan'));

$('#btnSave').addEventListener('click', () => {
  if (!state.currentItinerary) return;

  const saved = JSON.parse(localStorage.getItem('travel_saved') || '[]');
  const it = state.currentItinerary;

  if (state.isSaved) {
    // 取消保存
    const filtered = saved.filter(item => item.id !== it.id);
    localStorage.setItem('travel_saved', JSON.stringify(filtered));
    state.isSaved = false;
    $('#btnSave').textContent = '🤍 收藏行程';
    alert('已取消收藏');
  } else {
    it.id = 'trip_' + Date.now();
    it.savedAt = new Date().toISOString();
    saved.unshift(it);
    if (saved.length > 50) saved.length = 50;
    localStorage.setItem('travel_saved', JSON.stringify(saved));
    state.isSaved = true;
    $('#btnSave').textContent = '❤️ 已收藏';
    alert('已收藏！');
  }
});

// ============================================================
// 历史页面
// ============================================================

function renderHistory() {
  const saved = JSON.parse(localStorage.getItem('travel_saved') || '[]');
  const el = $('#historyList');

  if (saved.length === 0) {
    el.innerHTML = '<div class="empty-state">📭 还没有保存的行程<br><small>生成行程后点击"收藏"即可保存</small></div>';
    return;
  }

  el.innerHTML = saved.map(trip => {
    const s = trip.tripSummary || {};
    return `
      <div class="history-card" data-id="${trip.id}">
        <div class="hc-main">
          <div class="hc-route">${s.departureCity || '?'} → ${s.destinationCity || '?'}</div>
          <div class="hc-meta">📅 ${s.startDate || ''} ~ ${s.endDate || ''} · ${s.totalDays || '?'}天</div>
        </div>
        <button class="hc-view" data-id="${trip.id}">查看</button>
        <button class="hc-del" data-id="${trip.id}">🗑️</button>
      </div>`;
  }).join('');

  // 查看按钮
  $$('.hc-view').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const trip = saved.find(t => t.id === id);
      if (trip) {
        state.currentItinerary = trip;
        state.isSaved = true;
        state.currentDayIndex = 0;
        renderItinerary();
        showPage('itinerary');
        $('#btnSave').textContent = '❤️ 已收藏';
      }
    });
  });

  // 删除按钮
  $$('.hc-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('确定要删除这条行程吗？')) return;
      const id = btn.dataset.id;
      const filtered = saved.filter(t => t.id !== id);
      localStorage.setItem('travel_saved', JSON.stringify(filtered));
      renderHistory();
    });
  });
}

// ============================================================
// 初始化
// ============================================================

console.log('🌍 旅行规划助手已就绪');
console.log('   API 地址: http://localhost:3000');
