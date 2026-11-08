# Astryx 界面组件渐进迁移

## 第一批范围

使用固定版本 `@astryxdesign/core`、`@astryxdesign/theme-neutral`、`@astryxdesign/cli` 0.7.11，配合 StyleX 0.19.0。采用预编译 CSS，无需新增 Babel 或 StyleX 构建插件。

视觉保持 Ledger 的纸白、墨色、靛蓝与现有任务主从布局。任务列表承担浏览与选择，详情承担状态与操作，表单承担编辑；沿用轻量的筛选展开、弹窗进场与减少动态效果设置。

- 全局 `UiProvider` 提供主题、跟随系统的深浅模式和简体中文组件文案。
- `src/design/astryx.css` 将 Astryx 语义变量映射到现有 Ledger 变量，覆盖主题边界及弹层。
- 全部任务、每日清单的项目筛选；任务搜索和状态筛选；页面和详情的主要操作按钮。
- 新建任务、更新进展、安排任务日期的文本字段、选择控件、按钮和弹窗。
- 日期和进度字段保留原生控件与原有校验。任务列表行、业务状态标识、草稿、证据引用和版本校验继续使用现有实现。

## 后续迁移约定

1. 按完整工作流迁移，每一批都同时检查空状态、错误、加载、禁用、中文输入、键盘操作和深浅主题。
2. 直接使用 Astryx 的公开组件 API，按组件子路径导入。表单用 `containerClassName` 和 `controlClassName` 指定样式目标，避免把旧 `.button` 类叠到 Astryx Button 上。
3. 通用原生元素样式放入 `ledger-native` 层，顺序为 `reset → ledger-native → astryx-base → astryx-theme`；领域布局样式继续保留。旧容器选择器不得修改 `.astryx-field` 内部输入框。
4. 新表单可使用 `FormDialog`。它保留提交期间禁止关闭及卸载后的焦点恢复。现有支持嵌套帮助/结果的旧 Dialog 暂不整体替换；迁移时需同时验证嵌套流程。
5. Astryx 字段的 `isRequired` 不能代替提交校验，文本长度需显式限制。选择控件与文本字段需要显式传入草稿未就绪/提交中的禁用状态。
6. 保留业务处理、草稿持久化、幂等请求 ID、冲突校验与证据关系，不在 UI 迁移中改动 Rust/SQLite 接口。

组件文档：`npm run astryx -- component Button`、`npm run astryx -- component Selector`、`npm run astryx -- component Dialog`。无需执行会改写代理配置的 CLI 初始化。

## 验证

使用独立测试工作区和真实本地 Rust 进程，浏览器验收记录及截图保存在 `output/playwright/astryx/`。桌面冒烟检查使用独立数据目录，验证 macOS Tauri 窗口中创建项目、打开任务表单、键盘选择执行方式与保存任务。

构建命令：`npm run build`。引入组件库后当前入口包触发 Vite 的 500 kB 提示；本批不额外合并延迟加载的页面或强制将所有 Astryx 组件放入一个入口包，后续可按使用范围继续评估体积。

本批结果：生产构建通过；12 项工作流断言通过；布局与键盘检查通过（包括连续 22 次 Tab 焦点约束）；展开高级字段后的桌面/390px 窄屏、深浅模式四种组合通过。检查中修复了条件挂载弹窗的焦点恢复，以及旧样式造成的字段双重焦点框。主要页面冒烟检查无未捕获的浏览器错误。详情见 `output/playwright/astryx/acceptance.json`。
