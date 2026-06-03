/**
 * server.js — 旅行规划助手 Web 服务
 *
 * 启动方式: node server.js
 * 默认端口: 3000
 * 浏览器打开: http://localhost:3000
 *
 * 功能：
 * 1. 托管前端静态页面
 * 2. 代理高德地图 API 请求（浏览器有跨域限制）
 * 3. 代理 Web 搜索请求
 * 4. 运行行程生成算法
 */

const express = require('express');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// 解析 JSON 请求体
app.use(express.json());

// 托管前端静态文件（index.html, app.js, style.css）
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 工具函数
// ============================================================

/** 高德 API Key — 在这里填写你的 Key */
const AMAP_KEY = process.env.AMAP_KEY || 'b338b76d3522322ee6571a370a9013c7';

/** 简单内存缓存 */
const cache = new Map();
function getCache(key) {
  const item = cache.get(key);
  if (item && Date.now() < item.expires) return item.value;
  if (item) cache.delete(key);
  return null;
}
function setCache(key, value, ttlMs = 3600000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

/** HTTP GET 请求（带超时和重试） */
async function httpGet(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// API 1: 城市搜索建议
// ============================================================

app.get('/api/city-suggest', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword || !keyword.trim()) return res.json({ suggestions: [] });

  const cached = getCache(`city_${keyword}`);
  if (cached) return res.json(cached);

  try {
    const data = await httpGet(
      `https://restapi.amap.com/v3/assistant/inputtips?key=${AMAP_KEY}&keywords=${encodeURIComponent(keyword)}&datatype=all`
    );
    const suggestions = (data.tips || [])
      .filter(t => /市|省|区|县/.test(t.name + (t.district || '')))
      .map(t => ({ name: t.name, adcode: t.adcode || '', district: t.district || '' }))
      .slice(0, 10);

    const result = { suggestions };
    setCache(`city_${keyword}`, result, 30 * 60 * 1000);
    res.json(result);
  } catch (e) {
    res.json({ suggestions: [] });
  }
});

// ============================================================
// API 2: 搜索景点
// ============================================================

/** 用户偏好类型 → 高德分类代码 */
const TYPE_MAP = {
  nature:    '风景名胜|公园广场|植物园|海滩',
  history:   '博物馆|文物古迹|历史遗迹|名人故居|寺庙',
  food:      '中餐厅|特色/地方风味餐厅|美食街',
  shopping:  '购物中心|商业街|特色商业街',
  entertain: '休闲娱乐|影剧院|游乐园',
  family:    '动物园|水族馆|游乐园|公园广场|博物馆',
  outdoor:   '国家级景点|风景名胜|运动场馆'
};

app.get('/api/search-poi', async (req, res) => {
  const { city, types = '', keyword = '景点' } = req.query;

  if (!city) return res.json({ pois: [] });

  const typeKeys = types ? types.split(',') : [];
  const amapTypes = typeKeys.length > 0
    ? typeKeys.map(k => TYPE_MAP[k] || '').filter(Boolean).join('|')
    : Object.values(TYPE_MAP).join('|');

  const cacheKey = `poi_${city}_${amapTypes}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await httpGet(
      `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&keywords=${encodeURIComponent(keyword)}&types=${encodeURIComponent(amapTypes)}&city=${encodeURIComponent(city)}&citylimit=true&offset=15&extensions=all`
    );

    const pois = (data.pois || []).map(poi => {
      let typeKey = 'other';
      for (const [k, v] of Object.entries(TYPE_MAP)) {
        if (v.split('|').some(t => (poi.type || '').includes(t))) { typeKey = k; break; }
      }
      return {
        id: poi.id || '',
        name: poi.name || '未知',
        type: typeKey,
        rating: parseFloat((poi.biz_ext?.rating) || 0),
        address: poi.address || '',
        tel: poi.tel || '',
        lnglat: poi.location || '',
        location: poi.location ? {
          lng: parseFloat(poi.location.split(',')[0]),
          lat: parseFloat(poi.location.split(',')[1])
        } : null,
        photos: (poi.photos || []).slice(0, 3).map(p => ({ url: p.url || '' })),
        cost: poi.biz_ext?.cost || ''
      };
    });

    const result = { pois, total: data.count || pois.length };
    setCache(cacheKey, result, 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    res.json({ pois: [], total: 0 });
  }
});

// ============================================================
// API 3: 路线信息
// ============================================================

app.get('/api/route-info', async (req, res) => {
  const { origin, destination, mode = 'drive' } = req.query;
  if (!origin || !destination) return res.json({ intercity: { distance: 0, duration: 0, costEstimate: { min: 0, max: 0 } } });

  const cacheKey = `route_${origin}_${destination}_${mode}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    // 地理编码获取坐标
    const [geo1, geo2] = await Promise.all([
      httpGet(`https://restapi.amap.com/v3/geocode/geo?key=${AMAP_KEY}&address=${encodeURIComponent(origin)}&city=${encodeURIComponent(origin)}`),
      httpGet(`https://restapi.amap.com/v3/geocode/geo?key=${AMAP_KEY}&address=${encodeURIComponent(destination)}&city=${encodeURIComponent(destination)}`)
    ]);

    const coord1 = geo1.geocodes?.[0]?.location;
    const coord2 = geo2.geocodes?.[0]?.location;

    let intercity = { distance: 0, duration: 0, mode, costEstimate: { min: 500, max: 1500 } };

    if (mode === 'drive' && coord1 && coord2) {
      const drive = await httpGet(
        `https://restapi.amap.com/v3/direction/driving?key=${AMAP_KEY}&origin=${coord1}&destination=${coord2}&extensions=base`
      );
      if (drive.route?.paths?.[0]) {
        const p = drive.route.paths[0];
        intercity.distance = Math.round(p.distance / 1000);
        intercity.duration = Math.round(p.duration / 60);
        intercity.costEstimate = { min: Math.round(intercity.distance * 0.8), max: Math.round(intercity.distance * 1.2) };
      }
    } else if (coord1 && coord2) {
      // 飞行/火车：用直线距离估算
      const [lng1, lat1] = coord1.split(',').map(Number);
      const [lng2, lat2] = coord2.split(',').map(Number);
      const dist = haversine(lat1, lng1, lat2, lng2);
      intercity.distance = Math.round(dist);
      if (mode === 'flight') {
        intercity.duration = Math.round(dist / 800 * 60 + 90);
        intercity.costEstimate = { min: Math.round(dist * 0.5), max: Math.round(dist * 1.2) };
      } else {
        intercity.duration = Math.round(dist / 300 * 60);
        intercity.costEstimate = { min: Math.round(dist * 0.3), max: Math.round(dist * 0.6) };
      }
    }

    const result = { intercity, intracity: { matrix: [] } };
    setCache(cacheKey, result, 6 * 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    res.json({ intercity: { distance: 0, duration: 0, mode, costEstimate: { min: 0, max: 0 } } });
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// API 4: 生成行程（核心算法）
// ============================================================

app.post('/api/generate-itinerary', (req, res) => {
  const { formData, attractions, transport } = req.body;

  if (!attractions || attractions.length === 0) {
    return res.json({ error: '未找到景点，请调整条件重试' });
  }

  const { startDate, endDate, departure, destination, travelMode } = formData;

  // 计算总天数
  const start = new Date(startDate.replace(/-/g, '/'));
  const end = new Date(endDate.replace(/-/g, '/'));
  const totalDays = Math.max(1, Math.ceil((end - start) / 86400000) + 1);

  // 1. 评分
  const travelMonth = start.getMonth() + 1;
  const preferredTypes = formData.types || [];
  const scored = attractions.map(a => {
    let score = 0;
    if (preferredTypes.includes(a.type)) score += 30;
    score += Math.min((a.rating || 0) * 4, 20);
    score += Math.random() * 20; // 热度占位
    score += 10; // 季节基础分
    score += Math.min((a.address ? 5 : 0) + (a.tel ? 5 : 0), 10);
    return { ...a, score: Math.round(score) };
  }).sort((a, b) => b.score - a.score);

  // 取前 N 个
  const topN = scored.slice(0, Math.max(totalDays * 3, 5));

  // 2. 按地理聚类
  const CLUSTER_RADIUS = 3;
  const clusters = [];
  const assigned = new Set();

  topN.forEach((a, i) => {
    if (assigned.has(i)) return;
    const cluster = { id: clusters.length, members: [i] };
    assigned.add(i);
    if (a.location) {
      topN.forEach((b, j) => {
        if (i !== j && !assigned.has(j) && b.location && a.location) {
          const d = haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
          if (d <= CLUSTER_RADIUS) { cluster.members.push(j); assigned.add(j); }
        }
      });
    }
    clusters.push(cluster);
  });

  topN.forEach((a, i) => { if (!assigned.has(i)) clusters.push({ id: clusters.length, members: [i] }); });

  // 3. 分配到天
  const days = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push({
      dayNumber: i + 1,
      date: fmtDate(d),
      weekday: ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()],
      activities: [],
      daySummary: { totalActivities: 0, note: '' }
    });
  }

  let dayIdx = 0;
  for (const cluster of clusters) {
    if (dayIdx >= totalDays) break;
    for (const memberIdx of cluster.members) {
      if (days[dayIdx].activities.length >= 4) { dayIdx++; if (dayIdx >= totalDays) break; }
      const a = topN[memberIdx];
      days[dayIdx].activities.push({
        type: 'activity',
        time: ['09:00','10:30','14:00','16:00'][days[dayIdx].activities.length] || '09:00',
        title: a.name,
        duration: 120,
        attraction: {
          ...a,
          openingHours: a.openingHours || '',
          ticketPrice: a.cost || '',
          bestSeason: '',
          tips: a.rating >= 4.5 ? '高评分景点，建议预留充足时间' : ''
        }
      });
      days[dayIdx].daySummary.totalActivities++;
    }
    if (days[dayIdx] && days[dayIdx].activities.length >= 3) dayIdx++;
  }

  // 4. 添加午餐和备注
  days.forEach((day, i) => {
    if (day.activities.length >= 2) {
      day.activities.splice(2, 0, { type: 'meal', time: '12:00', title: '午餐时间', detail: '建议品尝当地美食', duration: 90 });
    }
    if (i === 0) day.daySummary.note = '出发日：安顿后开始游览';
    if (i === totalDays - 1) day.daySummary.note = '返程日：预留时间前往车站/机场';
  });

  // 5. 添加第一天交通
  if (days.length > 0) {
    const intercity = transport?.intercity || {};
    days[0].activities.unshift({
      type: 'transport',
      time: '08:00',
      title: `${departure || '出发地'} → ${destination || '目的地'}`,
      detail: `${travelMode === 'flight' ? '✈️' : travelMode === 'train' ? '🚄' : '🚗'} 约${intercity.distance || '?'}公里 · ${Math.round((intercity.duration || 0) / 60)}小时`,
      duration: intercity.duration || 120,
      icon: travelMode || 'drive'
    });
  }

  const costEstimate = {
    min: Math.round((transport?.intercity?.costEstimate?.min || 500) + days.length * 400),
    max: Math.round((transport?.intercity?.costEstimate?.max || 1500) + days.length * 600)
  };

  res.json({
    tripSummary: {
      departureCity: departure || '出发地',
      destinationCity: destination || '目的地',
      travelMode: travelMode || 'drive',
      startDate, endDate, totalDays, totalNights: totalDays - 1,
      costEstimate
    },
    days
  });
});

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================
// 启动服务
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIP = iface.address;
        break;
      }
    }
  }
  console.log(`\n🌍 旅行规划助手已启动！`);
  console.log(`   本机访问: http://localhost:${PORT}`);
  console.log(`   局域网访问: http://${lanIP}:${PORT}\n`);
  if (!AMAP_KEY) {
    console.warn('⚠️  未设置高德API Key！请在 server.js 中设置 AMAP_KEY');
    console.warn('   否则景点搜索功能不可用\n');
  }
});