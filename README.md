# 体素搭建小世界

一个基于 Three.js 的 3D 体素沙盒建造游戏。

## 玩法

- 在 12×12（可选 16×16 / 24×24）的网格世界中自由放置建筑
- 17 种建筑类型：小木屋、石头小屋、中型木屋、大房子、面包房、作坊、市集摊位、水井、长椅、路灯、农田、花坛、小树、中树、大树、栅栏、稻草人
- 放置房屋后自动生成 NPC 村民，村民会外出活动
- 完整的昼夜循环，窗户和路灯在夜间发光
- 多世界存档管理，支持导入/导出 JSON
- 撤销/重做，拆除建筑，地面涂色

## 运行

```bash
npm install
npx vite
```

打开 `http://localhost:5173`

## 技术栈

- **Three.js** — 3D 渲染引擎
- **TypeScript** — 类型安全
- **Vite** — 开发与构建
- **IndexedDB** — 世界存档存储
- **Web Audio API** — 程序化音效

## 项目结构

```
src/
├── main.ts          # 主入口、渲染循环、UI
├── buildings.ts     # 17 种建筑模型工厂
├── placement.ts     # 网格系统、占位管理
├── npc.ts           # NPC 生成、状态机、A* 寻路
├── storage.ts       # IndexedDB 世界 CRUD
└── sound.ts         # 程序化音效
```
