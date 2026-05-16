# 3dwebgame Project Instructions

## Subagent Code Review

每次编写或修改代码后，必须新建一个 subagent 对改动进行查错审查（review）。Subagent 需要检查：
- 逻辑错误（空指针、未定义变量、类型错误）
- 运行时潜在问题（内存泄漏、未清理的资源）
- 边界情况处理
- 与现有代码的一致性

审查完成后，将发现的问题汇总报告。

## Art Style Reference

所有颜色、材质、光照、后处理参数必须与 `style-preview-v2.html` 保持一致。

## Build

- `npx vite build` — 生产构建
- `npx vite` — 开发服务器

## 文档同步

每完成一个功能后，必须立即更新以下文档：
- `F:\Obsidian\MyDoc\3dwebgame\体素搭建小世界-策划案.md` — 将对应阶段的任务勾选为 `[x]`
- `C:\Users\74432\.claude\projects\D--code-Claude-Playground-3dwebgame\memory\progress.md` — 更新进度状态和 Phase 完成数
