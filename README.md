# 在场 — AI 记忆工坊

> AI 接管"记"的负担，把你还给当下。

一款 AI 驱动的个人记忆留存工具。在信息过载的日常场景中（逛展、参访、开会、上课、旅行），用户随手拍下的照片、录下的语音、敲下的文字，都可以导入工具。AI 自动判断哪些值得长期保存，以"记忆卡片"的形式归档，形成可回溯的个人记忆库。

**主题六：AI + 智能认知** — 用创意形式表达对人和 AI 关系的思考。

## 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. （可选）配置 API Key
cp .env.example .env
# 编辑 .env 填入 DASHSCOPE_API_KEY（留空则使用预生成模式）

# 3. 启动
python main.py

# 4. 打开浏览器
# 访问 http://127.0.0.1:8000
```

## 核心功能

### 1. 采集提炼
- 选择场景类型（博物馆 / 企业参访 / 会议 / 上课 / 旅行 / 自定义）
- 上传图片、录音、文字备注
- 填写个性化方向（可选）：告诉 AI 你想重点记住什么
- AI 自动筛选值得留存的内容，生成记忆卡片（客观总结 + 个人归因 + 标签）

### 2. 记忆库
- 所有卡片按时间倒序排列
- 按场景类型筛选
- 点击卡片查看详情、编辑、删除

### 3. 认知账单
- 记忆卡片总数
- AI 替你整理的时间（分钟）
- 已处理素材数
- 回忆完成率
- 按场景分布可视化

### 4. 回忆挑战（场景级开关）
- 基于间隔重复算法（遗忘曲线：1天 / 3天 / 7天 / 14天 / 30天）
- 企业参访 / 会议 / 上课默认开启
- 博物馆 / 旅行默认关闭
- 每次回忆后根据难度调整下次间隔

## 技术架构

```
前端  HTML / CSS / 原生 JS（无框架依赖）
  ↕  HTTP / Fetch
后端  Python FastAPI
  ├── 素材上传与分类
  ├── 通义千问 Vision / OpenAI GPT-4V 多模态分析
  ├── 记忆卡片 CRUD
  ├── 间隔重复回忆调度
  └── 认知账单统计
  ↕
存储  SQLite（零配置，data/memory.db）
```

## 配置 API Key（可选）

不配置也能完整演示（使用预生成模式）。配置后可获得真实的 AI 图片理解和文本提炼能力。

### 通义千问 Vision
1. 访问 https://dashscope.console.aliyun.com/ 申请 API Key
2. 填入 `.env` 文件：`DASHSCOPE_API_KEY=sk-...`

### OpenAI 兼容接口
```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

## 替换真实素材

### 替换照片
将真实参访照片放入 `static/uploads/` 目录，然后在记忆库中编辑对应卡片的图片路径。

### 替换种子数据
编辑 `seed.py` 中的 `SEED_CARDS` 列表，修改标题、摘要、个人归因等内容。删除 `data/memory.db` 后重启即可重新生成。

## 项目结构

```
├── main.py          # FastAPI 后端（API + 静态文件托管）
├── llm.py           # LLM 集成（通义千问 / OpenAI / 预生成回退）
├── memory.py        # SQLite 数据层（CRUD + 回忆调度 + 账单）
├── scenarios.py     # 6 种场景模板
├── seed.py          # 真实参访种子数据
├── requirements.txt
├── .env.example
├── static/
│   ├── index.html   # 前端页面
│   ├── styles.css   # 样式
│   ├── app.js       # 交互逻辑
│   ├── assets/      # 静态资源
│   └── uploads/     # 用户上传文件
└── data/
    └── memory.db    # SQLite 数据库（自动生成）
```

## AI 使用披露

### 讨论层面
使用 ChatGPT / DeepSeek / 通义千问讨论产品形态、交互逻辑、核心主张。前后共约 3-4 轮迭代，从最初的"记忆卡片工具"逐步深化为"在场 vs 记录"的认知悖论表达。

### 制作层面
- 网页框架由 AI 编程工具（Codex）生成
- 素材分析能力基于通义千问 Vision 多模态 API
- 回忆调度算法基于艾宾浩斯遗忘曲线的间隔重复原理

## License
MIT
