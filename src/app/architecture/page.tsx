import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowLeft,
  Boxes,
  Cloud,
  Database,
  Disc3,
  FolderKanban,
  Headphones,
  KeyRound,
  Music2,
  RadioTower,
  Repeat2,
  ServerCog,
  ShieldCheck,
  Workflow,
} from 'lucide-react'

export const metadata: Metadata = {
  title: '架构说明 | XMusic',
  description: 'XMusic 当前架构图、核心模块和基础数据流说明。',
}

const moduleGroups = [
  {
    title: '入口层',
    items: ['管理台 UI', 'Emby 兼容网关', '同源播放器代理', '账号与配置 API'],
  },
  {
    title: '领域层',
    items: ['QQ Music 适配', 'Emby 上游代理', '播放地址解析', '虚拟媒体映射'],
  },
  {
    title: '后台层',
    items: ['SQLite 任务队列', '缓存写入与清理', '标签整理', 'Emby 增量同步'],
  },
  {
    title: '存储层',
    items: ['账号与会话', '收藏与播放记录', '缓存文件', '最终音乐库'],
  },
]

const flows = [
  ['登录', 'QQ 扫码或 Cookie 导入后，XMusic 建立本地账号，绑定或创建受限的上游 Emby 用户。'],
  ['浏览', '播放器访问根路径的 Emby 风格接口，网关把上游 Emby 真实音乐和 QQ 虚拟内容合并成统一列表。'],
  ['播放', '虚拟歌曲请求先查本地缓存，未命中时通过 LX 源解析 QQ 音频地址，并边播边写入缓存。'],
  ['归档', '后台任务完成下载、标签、封面、歌词和路径整理后，可触发上游 Emby 扫描并建立远端映射。'],
]

const guarantees = [
  '浏览器不会接触 LX 源脚本地址、上游 Emby API Key 等服务端凭据。',
  '播放器侧只使用 XMusic 生成或维护的本地 Emby 账号密码。',
  '上游 Emby 账号默认限制在音乐库内，关闭频道、远程控制和共享设备控制。',
  'QQ 虚拟 ID 在收藏、歌单、专辑等入口保持稳定，减少客户端重复曲目。',
]

export default function ArchitecturePage() {
  return (
    <main className="architecture-page">
      <section className="architecture-shell">
        <header className="architecture-hero">
          <div>
            <p className="eyebrow">XMusic Architecture</p>
            <h1>QQ 音乐到 Emby 的私有网关架构</h1>
            <p>
              当前架构把 Next.js 路由层、领域适配层、SQLite 持久化和后台任务拆开，
              用根路径提供 Emby 兼容网关，同时保留管理台、播放器代理和运维 API。
            </p>
          </div>
          <Link className="secondary-button" href="/">
            <ArrowLeft size={16} />
            返回首页
          </Link>
        </header>

        <section className="architecture-map" aria-label="XMusic 架构图">
          <div className="architecture-lane clients">
            <h2>客户端</h2>
            <div className="architecture-node primary">
              <Headphones size={24} />
              <strong>ampcast / Emby 客户端</strong>
              <span>浏览、搜索、播放、收藏</span>
            </div>
            <div className="architecture-node">
              <FolderKanban size={24} />
              <strong>管理台</strong>
              <span>登录、配置、任务、状态</span>
            </div>
          </div>

          <div className="architecture-connector" aria-hidden="true">
            <span>HTTP / Emby API</span>
          </div>

          <div className="architecture-lane app">
            <h2>Next.js 应用</h2>
            <div className="architecture-stack">
              <div className="architecture-node primary wide">
                <ServerCog size={24} />
                <strong>路由与网关层</strong>
                <span>App Router 页面、API Routes、根路径 Emby 兼容 catch-all</span>
              </div>
              <div className="architecture-node wide">
                <Boxes size={24} />
                <strong>领域服务层</strong>
                <span>QQ、Emby、播放解析、缓存、账号、收藏、历史</span>
              </div>
              <div className="architecture-node wide">
                <Workflow size={24} />
                <strong>后台任务层</strong>
                <span>缓存完成、标签整理、资源清理、Emby 同步</span>
              </div>
            </div>
          </div>

          <div className="architecture-connector split" aria-hidden="true">
            <span>私有 API / 文件 / 队列</span>
          </div>

          <div className="architecture-lane dependencies">
            <h2>依赖与存储</h2>
            <div className="architecture-node">
              <Music2 size={24} />
              <strong>QQ Music</strong>
              <span>登录态、歌单、收藏、历史、元数据</span>
            </div>
            <div className="architecture-node">
              <RadioTower size={24} />
              <strong>LX 源脚本</strong>
              <span>服务端解析可播放音频地址</span>
            </div>
            <div className="architecture-node">
              <Cloud size={24} />
              <strong>上游 Emby</strong>
              <span>真实曲库、受限用户、扫描与映射</span>
            </div>
            <div className="architecture-node">
              <Database size={24} />
              <strong>SQLite + data/</strong>
              <span>账号、任务、缓存、资源、最终音乐库</span>
            </div>
          </div>
        </section>

        <section className="architecture-section">
          <div className="section-head">
            <h2>模块边界</h2>
          </div>
          <div className="architecture-module-grid">
            {moduleGroups.map(group => (
              <article className="architecture-card" key={group.title}>
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map(item => <li key={item}>{item}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="architecture-section">
          <div className="section-head">
            <h2>核心数据流</h2>
          </div>
          <div className="architecture-flow-list">
            {flows.map(([title, text], index) => (
              <article className="architecture-flow" key={title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="architecture-section two-column">
          <article className="architecture-card">
            <div className="architecture-card-title">
              <ShieldCheck size={22} />
              <h2>安全边界</h2>
            </div>
            <ul>
              {guarantees.map(item => <li key={item}>{item}</li>)}
            </ul>
          </article>
          <article className="architecture-card">
            <div className="architecture-card-title">
              <Repeat2 size={22} />
              <h2>运行模型</h2>
            </div>
            <p>
              Web 服务负责同步请求、网关响应和管理 UI；worker 负责轮询 SQLite 任务队列。
              两者共享数据库与 data 目录，因此 Docker Compose 和本地开发都保持同一套文件布局。
            </p>
          </article>
        </section>

        <section className="architecture-section">
          <div className="architecture-callout">
            <Disc3 size={22} />
            <p>
              近期重构后的关键变化是服务根路径成为正式 Emby 网关，QQ 虚拟内容与上游 Emby
              真实内容在 XMusic 内部合并，播放器不需要感知两套来源。
            </p>
            <KeyRound size={22} />
          </div>
        </section>
      </section>
    </main>
  )
}
