"""场景模板 —— 每个场景驱动不同的 AI 提示词、卡片模板和回忆开关。"""

SCENARIOS = {
    "museum": {
        "key": "museum",
        "name": "博物馆 / 展览",
        "icon": "landmark",
        "recall_enabled": False,
        "focus_prompt": "展品的名称、年代、材质、历史背景，以及它为什么打动人。每张卡聚焦一件展品或一个主题。",
        "card_hint": "一张展品照片 + 客观介绍 + 个人感受",
        "minutes_per_material": 3,
        "accent": "#B45309",
    },
    "enterprise": {
        "key": "enterprise",
        "name": "企业参访",
        "icon": "building-2",
        "recall_enabled": True,
        "focus_prompt": "企业的核心业务、技术亮点、竞争壁垒，以及对参访者的启发。提炼出真正值得长期记住的洞察，而非宣传话术。",
        "card_hint": "一个核心洞察 + 客观事实 + 个人启发",
        "minutes_per_material": 8,
        "accent": "#0F766E",
    },
    "meeting": {
        "key": "meeting",
        "name": "会议 / 讨论",
        "icon": "users",
        "recall_enabled": True,
        "focus_prompt": "议题、关键决议、行动项、不同立场，以及我自己的判断。避免流水账，只留有决策价值的内容。",
        "card_hint": "一个议题 + 决议/行动项 + 我的立场",
        "minutes_per_material": 6,
        "accent": "#7C3AED",
    },
    "class": {
        "key": "class",
        "name": "课程 / 讲座",
        "icon": "book-open",
        "recall_enabled": True,
        "focus_prompt": "核心知识点、关键例题、易错点、与已有知识的联系。按知识点而非按时间整理。",
        "card_hint": "一个知识点 + 简明解释 + 易错/联系",
        "minutes_per_material": 5,
        "accent": "#2563EB",
    },
    "travel": {
        "key": "travel",
 "name": "旅行 / 行走",
        "icon": "map-pin",
        "recall_enabled": False,
        "focus_prompt": "地点、人物、一个具体的细节、当下的感受。旅行记忆的价值在于细节和情绪，而非攻略。",
        "card_hint": "一张照片 + 地点/场景 + 一个细节或感受",
        "minutes_per_material": 2,
        "accent": "#DB2777",
    },
    "custom": {
        "key": "custom",
        "name": "自定义",
        "icon": "sparkles",
        "recall_enabled": False,
        "focus_prompt": "用户自行判断哪些值得留存。AI 按通用标准筛选：信息密度、独特性、对用户的长远价值。",
        "card_hint": "自由格式",
        "minutes_per_material": 4,
        "accent": "#525252",
    },
}

SCENARIO_LIST = list(SCENARIOS.values())


def get_scenario(key):
    return SCENARIOS.get(key, SCENARIOS["custom"])
