# 体素搭建小世界

一个基于 Three.js 的 3D 体素沙盒建造游戏。

## 玩法

- 在 12×12（可选 16×16 / 24×24）的网格世界中自由放置建筑
- 17 种建筑类型：小木屋、石头小屋、中型木屋、大房子、面包房、作坊、市集摊位、水井、长椅、路灯、农田、花坛、小树、中树、大树、栅栏、稻草人
- 放置房屋后自动生成 NPC 村民，村民会外出活动
- 完整的昼夜循环，窗户和路灯在夜间发光
- 多世界存档管理，支持导入/导出 JSON
- 撤销/重做，拆除建筑，地面涂色，铭牌改名（支持 emoji）
- 3 种世界模板：空白平地 / 海滨 / 小岛，带沙滩和水波动画
- 首次进入自动弹出新手引导，按 P 键可随时重新打开

## 运行

```bash
npm install
npx vite
```

打开 `http://localhost:5173`

## Docker 部署

```bash
docker build -t voxel-world .
docker run -p 3000:3000 voxel-world
```

打开 `http://localhost:3000`

NPM 安装使用阿里云镜像源 `registry.npmmirror.com`。

## 快捷键

| 按键 | 功能 |
|------|------|
| E | 重选上次建筑 |
| R | 旋转建筑朝向 |
| H | 隐藏/显示 UI |
| N | 寻路调试视图 |
| P | 重新打开新手教程 |
| Ctrl+Z | 撤销 |
| Ctrl+Y | 重做 |
| Esc | 取消选择 |

## 技术栈

- **Three.js** — 3D 渲染引擎
- **TypeScript** — 类型安全
- **Vite** — 开发与构建
- **IndexedDB** — 世界存档存储
- **Web Audio API** — 程序化音效
- **Docker** — 容器化部署

## 项目结构

```
src/
├── main.ts          # 主入口、渲染循环、UI、新手引导
├── buildings.ts     # 17 种建筑模型工厂（含铭牌）
├── placement.ts     # 网格系统、占位管理、地块类型
├── npc.ts           # NPC 生成、状态机、A* 寻路
├── storage.ts       # IndexedDB 世界 CRUD
└── sound.ts         # 程序化音效
```
