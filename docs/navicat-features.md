# DbNest 重构 · Navicat 风格开发功能清单

> 目标：界面与交互**完全照搬 Navicat Premium（浅色默认主题）**，功能除 ER 图外全部实现。
> 后端 IPC 链路（types → ipc-channels → services → ipc → preload → vite-env → api）已具备，本清单聚焦**界面重构 + 功能补全**。
> 标记：✅ 已完成 / 🔧 重构中 / 🆕 新增 / ⏳ 待做

---

## A. 连接管理（Connection）
- ✅ A1 连接导航器：连接分组（文件夹）、连接、库/模式、对象类型分组（表/视图/函数/事件/查询/用户）树形展示
- 🆕 A2 新建连接向导：MySQL / PostgreSQL / Oracle / Redis / MariaDB（类型图标 + 高级/SSL/SSH 隧道页）
- ✅ A3 编辑 / 复制 / 删除连接
- 🆕 A4 打开/关闭连接、连接着色、最近使用
- ✅ A5 连接状态指示灯

## B. 对象浏览（Object Navigator）
- 🔧 B1 对象列表（主区网格）：名称 / 类型 / 记录数 / 注释
- 🆕 B2 对象过滤与排序、分组计数徽标
- 🆕 B3 右键菜单：设计 / 打开数据 / 新建 / 删除 / 重命名 / 截断 / 清空

## C. 表（Table）
- 🔧 C1 数据网格 Grid View：分页、排序、列筛选、行内编辑、新增/删除行、批量提交
- 🆕 C2 表单视图 Form View
- 🔧 C3 表设计器 Design Table：列 / 索引 / 外键 / 触发器 / SQL 预览（方言合成 DDL）
- 🆕 C4 新建表向导
- 🆕 C5 表信息 / 注释面板

## D. 视图（View）
- 🔧 D1 视图设计（SQL 编辑 + 保存重建）
- 🔧 D2 视图数据预览

## E. 函数 / 存储过程（Function / Procedure）
- 🔧 E1 函数/过程设计（源码查看 + 保存）
- 🆕 E2 运行函数（参数输入 + 结果）

## F. 序列（Sequence，PG / Oracle）
- 🔧 F1 序列信息（当前值/上下限/步长）+ 下一个值

## G. 事件（Event，MySQL）
- 🆕 G1 事件设计（调度表达式）

## H. 用户与权限（User / Role）
- 🔧 H1 用户列表：PG 角色 / MySQL 用户 / Oracle 用户（可登录 / 超级用户 / 锁定 / 口令过期）
- 🔧 H2 用户设计：新建 / 删除 / 赋权（按方言差异化字段）

## I. 查询（Query）
- 🔧 I1 SQL 编辑器：语法高亮、自动补全占位、多标签
- 🔧 I2 查询结果：Result / Status / Messages / History；分页、排序、导出 CSV
- 🆕 I3 查询历史持久化

## J. 数据（Data Tools）
- 🆕 J1 导入 / 导出向导（CSV / SQL）
- ✅ J2 数据传输（库到库，已有 TransferScreen）
- ✅ J3 结构同步 / 数据同步对比（已有 SchemaDiffScreen）

## K. 备份 / 还原（Backup）
- 🆕 K1 备份与还原（转储 SQL / 恢复）

## L. 工具（Tools）
- 🆕 L1 命令列界面 Console（SQL 控制台）
- 🆕 L2 历史日志
- 🆕 L3 服务器监控（连接变量 / 状态）

## M. Redis
- 🔧 M1 Key 浏览器（按类型过滤 chips + 计数）
- 🔧 M2 值编辑（按类型写回：string/hash/list/set/zset）
- 🔧 M3 重命名 / 设置 TTL（含永久）/ 删除

## N. 界面与主题
- 🆕 N1 Navicat 风格菜单栏（文件 / 编辑 / 视图 / 工具 / 窗口 / 帮助）
- 🆕 N2 Navicat 风格工具栏（新建连接 / 新建查询 / 用户 / 备份 / 传输 / 导入 / 导出 等图标）
- 🆕 N3 浅色默认主题（Navicat 经典蓝灰 + 蓝色强调）
- 🆕 N4 底部信息 / 输出面板（表：信息 / DDL；查询：结果 / 状态 / 消息 / 历史）

---

## 实现顺序（本轮）
1. N3 浅色主题 token + 全局样式重制
2. A1/B 连接导航器重构（Navicat 对象分组）
3. N1/N2 菜单栏 + 工具栏 + N4 底部面板
4. C 表（Grid/Form/Design）+ D/E/F/G/H 对象标签
5. I 查询（编辑器 + 结果分页）
6. M Redis 浏览器增强
7. J2/J3/K/L 接入菜单（复用/新增向导）
8. 构建验证（tsc + build:main + vite build）
