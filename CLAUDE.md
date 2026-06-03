# 旅行规划助手 — 项目速览

## 是什么
智能旅游攻略生成 Web 应用。输入出发地/目的地/日期/偏好 → 自动搜索景点 → 生成每日行程方案。

## 启动
```bash
cd C:\Users\lenovo\travel
node server.js
# 浏览器打开 http://localhost:3000
```

## 文件结构（仅4个文件）
```
travel/
├── server.js      # Express 后端（全部逻辑）
├── public/
│   ├── index.html # 前端页面（4个 section：表单/加载/行程/历史）
│   ├── app.js     # 前端逻辑（表单交互、API调用、渲染）
│   └── style.css  # 样式
├── package.json   # 依赖 express
└── node_modules/
```

## server.js 架构（360行）
- **端口**: 3000
- **高德 Key**: 第32行 `AMAP_KEY`，当前值 `b338b76d3522322ee6571a370a9013c7`
- **缓存**: 内存 Map（POI 1h、路线 6h、城市 30min）
- **4个 API 端点**：
  | 端点 | 方法 | 功能 | 调用的高德API |
  |------|------|------|---------------|
  | `/api/city-suggest?keyword=` | GET | 城市自动补全 | inputtips |
  | `/api/search-poi?city=&types=` | GET | 搜索景点 | place/text |
  | `/api/route-info?origin=&destination=&mode=` | GET | 城际路线 | geocode + direction |
  | `/api/generate-itinerary` | POST | 生成行程 | 纯本地算法 |
- **行程算法**（5步）：评分 → 地理聚类(3km) → 分配到天 → 贪心路径优化 → 添午餐/交通
- **兜底策略**: API失败返回空数据，不阻塞流程

## 前端状态机
`plan` →（提交）→ `loading` →（完成）→ `itinerary`
可切换到 `history`（localStorage 存储）

## 数据流
```
表单提交 → 并行(searchPOI + routeInfo) → generateItinerary → 按天时间线展示
```

## 注意事项
- 高德 Key 必须为「Web服务」类型，否则所有数据 API 返回空
- 免费额度 3000次/天，缓存策略确保够用
- 无数据库，收藏存 localStorage
