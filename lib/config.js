// dsh-sekaisync-connect —— Cordis Config（schemastery schema）。
//
// 这是本插件配置的**唯一权威 schema**。DSH 的 Loader 用它校验 profile 行里的 config，
// Settings 服务用它投影出可编辑表单（.volatile() 字段），config-editor 用它持久化。
// 这与手写 config.local.json 的本质区别在于：写入目标是 profile 的 cordis.patch.yml，
// 由框架管理——升级不被覆盖、写后热加载、并发写入串行化、非法值写前即被拒。
//
// 哪些字段 volatile：只有面板要改的两个路径（store / root）可在线编辑。
// python 是**可执行文件路径**，刻意不 volatile——把它暴露成可编辑表单等于把
// 「任意程序执行」放到网页上；它仍只由随包 config.json / SEKAISYNC_PYTHON 指定。
// externalPort 同样只读。
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  store: z.string().default('').volatile(),
  root: z.string().default('').volatile(),
  // python / externalPort 的 schema 默认故意留空字符串：这样「用户没在 profile 行里写」
  // 与「用户写了空值」在 apply() 里同形，loadConfig() 才不会用 schema 默认值去遮蔽
  // config.local.json / 环境变量里的同名键。真正的运行时兜底（'python' / 8787）留在
  // loadConfig() 内部，位于文件层之下。
  python: z.string().default(''),
  externalPort: z.number().min(0).max(65535).default(0),
})

/** 面板在线可编辑的字段（与 .volatile() 保持一致，供 save 的 allowlist 复用）。 */
export const VOLATILE_FIELDS = ['store', 'root']
