/** GitLab Source kind for self-hosted instances: configuration, polling loops, MR tracking and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Thread, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { CliError, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabApi, gitlabPages, gitlabThreadContext, type GitlabClient } from './gitlab-read.ts'
import { claimMergeRequest, mergeRequestEndNotices, mergeRequestsOf, observeMergeRequest, readMergeRequest, GITLAB_PROJECT } from './gitlab-pull.ts'
import { GitlabDiscussionSchema, GitlabIssueSchema, GitlabMergeRequestSchema, GitlabNoteSchema, GitlabPipelineSchema, SOURCE,
  gitlabPage, gitlabThread, gitlabThreadId, gitlabThreadRef, issueTrigger, mentions,
  mergeRequestTrigger, noteTrigger, pipelineTrigger, type GitlabIssue, type GitlabMergeRequest, type GitlabNote, type GitlabPipeline, type GitlabRef }
  from './gitlab-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

export { SOURCE, gitlabAddress, gitlabThread, gitlabThreadId, gitlabThreadRef, issueTrigger, mergeRequestTrigger, noteTrigger, pipelineTrigger } from './gitlab-trigger.ts'
export { mergeRequestEndNotices, mergeRequestsOf, claimMergeRequest, observeMergeRequest, readMergeRequest } from './gitlab-pull.ts'
export { readGitlab, gitlabThreadContext } from './gitlab-read.ts'
export { sendGitlab, gitlabLink } from './gitlab-channel.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false), observeComments: z.boolean().default(false),
  observePipelines: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', merge_requests: 'observeMergeRequests', comments: 'observeComments', pipelines: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
/** Map a Trigger's Source metadata to its admission row and receiving switch. */
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true || meta.kind === 'pipeline') return 'pipelines'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'merge_request') return 'merge_requests'
  return meta.kind === 'note' ? 'comments' : undefined
}
const sameProject = (a: string, b: string): boolean => sameName(a, b)
const local = (value: string | undefined): boolean => !!value && value.trim() !== ''
/** The CLI, instance and project a polling round reads through. */
export const clientOf = (config: Pick<GitlabConfig, 'cli' | 'host' | 'project'>): GitlabClient => ({ cli: config.cli, host: config.host, project: config.project })
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '自建 GitLab 实例中的一个项目：接收 Issue、合并请求及其评论，跟踪合并请求状态和流水线。',
    en: 'One project on a self-hosted GitLab instance: receives Issues, merge requests and their comments, and tracks merge request state and pipelines.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '([A-Za-z0-9-]+\\.)*[A-Za-z0-9-]+(:[0-9]{1,5})?', label: { zh: '实例地址', en: 'Instance host' },
      hint: { zh: '只写主机名或主机名:端口，不带 https:// 或路径，例如 gitlab.example.com。', en: 'A hostname or host:port only, without https:// or a path, such as gitlab.example.com.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*', label: { zh: '项目', en: 'Project' },
      hint: { zh: '写作 命名空间/项目，例如 platform/widgets。保存时检查智能体账号能否读取并推送。', en: 'A namespace/project path, such as platform/widgets. Saving checks that the agent account can read and push.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GITLAB_HOST 和独立配置登录智能体账号的 glab 包装脚本。执行器以 glab 调用它。', en: 'A command name or absolute path, usually a glab wrapper signed in as the agent account through GITLAB_HOST and its own config. The Executor calls it as glab.' } },
    { key: 'account', type: 'fact', label: { zh: '当前账号', en: 'Current account' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也接收，由策略的接收表决定是否成为候选；未打开时仍接收 @ 了智能体的 Issue。', en: 'New Issues that do not mention the agent are received too, and the Policy admission table decides whether they become candidates; Issues that mention the agent are received either way.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也接收，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论也接收；未打开时仍接收 @ 了智能体的评论。', en: 'Comments without a mention are received too; comments that mention the agent are received either way.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch\'s pipelines' },
      hint: { zh: '默认分支的流水线状态变化会接收，由策略的接收表决定是否成为候选。合并请求的流水线变化在订阅后总会跟踪。', en: 'Default-branch pipeline changes are received and the admission table decides whether they become candidates. A subscribed merge request always tracks its own pipeline.' } },
  ],
  facts: (deployment: Deployment | undefined): Record<string, Localized | string> => deployment?.gitlab
    ? { account: { zh: `@${deployment.gitlab.login}`, en: `@${deployment.gitlab.login}` },
      project: { zh: deployment.gitlab.project, en: deployment.gitlab.project } } : {},
  // The Source listens only to the configured instance and project; a stored Mandate from elsewhere stops listening.
  scope: ({ meta }, config) => {
    if (meta.host !== undefined && String(meta.host) !== config.host) return { listened: false, reason: 'gitlab_instance_not_allowed' }
    if (meta.project !== undefined && !sameProject(String(meta.project), config.project)) return { listened: false, reason: 'gitlab_project_not_allowed' }
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { allowed: (address, config) => sameProject(address.project ?? '', config.project) && address.host === config.host,
    send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const text = query.trim()
    const mr = /^!(\d+)$/.exec(text)?.[1] ?? /\/-\/merge_requests\/(\d+)/.exec(text)?.[1]
    const issue = /^#(\d+)$/.exec(text)?.[1] ?? /\/-\/issues\/(\d+)/.exec(text)?.[1]
    const bare = /^(\d+)$/.exec(text)?.[1]
    const ids = mr ? [`${SOURCE}:mr:${mr}`] : issue ? [`${SOURCE}:issue:${issue}`] : bare ? [`${SOURCE}:issue:${bare}`, `${SOURCE}:mr:${bare}`] : []
    return { threads: ids, terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict())
        .refine(users => new Set(users.map(user => user.id.toLowerCase())).size === users.length, 'Duplicate usernames').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id.toLowerCase())).size === bots.length, 'Duplicate bot usernames').optional() }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        hint: { zh: '名单里的机器人账号的评论在来源接收时成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。', en: 'A listed bot\'s comments become inferred candidates when the Source receives them; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] },
    ],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merge_requests', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'pipelines', label: { zh: '默认分支流水线', en: 'Default branch pipelines' }, note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '自建 GitLab 实例的主机名。glab 和 git 都以它访问项目', en: 'Hostname of the self-hosted GitLab instance. glab and git use it for this project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的 GitLab 项目，命名空间/项目。智能体在这里开的 MR 绑定到工单', en: 'The GitLab project this Source watches, namespace/project. An MR the agent opens here binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，且只用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ISSUE_IID', description: { zh: '接下工单的 Issue 编号；工单不是从 GitLab Issue 来的时为空', en: 'IID of the Issue that started the ticket; empty when the ticket did not start on a GitLab Issue' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_IID', description: { zh: '接下工单的合并请求编号；不是 MR 时为空', en: 'IID of the merge request that started the ticket; empty when it was not an MR' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR 的 head 引用 refs/merge-requests/<编号>/head；不是 MR 时为空', en: 'Head ref refs/merge-requests/<iid>/head of the MR that started the ticket; empty when it was not an MR' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const fromGitlab = trigger?.source === SOURCE
      const kind = fromGitlab ? trigger?.meta.noteable ?? trigger?.meta.kind : undefined
      const iid = fromGitlab ? Number(trigger?.meta.iid) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_HOST: gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.noreply ?? '',
        DSH_SUPERAGENT_GITLAB_ISSUE_IID: kind === 'issue' ? String(iid) : '', DSH_SUPERAGENT_GITLAB_MR_IID: trigger?.meta.isPr === true && iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: trigger?.meta.isPr === true && iid ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections end the DSH process; a failure escaping polling becomes this Source's health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health after `failures` consecutive polls, or undefined so a single interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown) {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined; failures: string[]; tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, failures: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const projectPath = (client: GitlabClient): string => GITLAB_PROJECT(client)
const configured = (config: GitlabConfig): boolean => local(config.host) && local(config.project) && local(config.cli)
/** Poll one project-wide Issue or merge request stream and its notes; each item fails independently. */
async function pollStream(ctx: SourceContext, round: Round, id: 'issues' | 'merge_requests'): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)!
  const client = clientOf(config)
  const stored = ctx.state.get(KV.gitlab.stream(id))
  const observedNow = id === 'issues' ? config.observeIssues : config.observeMergeRequests
  // Turning the receive-all switch on starts a new observation window, as the GitHub Source does; turning it off keeps the
  // position for mentions, which are received either way.
  const started = observedNow && !stored?.observed ? round.started : stored?.started ?? round.started
  const horizon = new Date(Date.parse(round.started) - POLL_HORIZON_MS).toISOString()
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), Date.parse(horizon))).toISOString()
  const path = `${projectPath(client)}/${id}?state=all&scope=all&order_by=updated_at&sort=asc&updated_after=${encodeURIComponent(since)}`
  const items = id === 'issues' ? await gitlabPages(ctx.commands.withSignal(round.signal), client, GitlabIssueSchema, path, round.tally)
    : await gitlabPages(ctx.commands.withSignal(round.signal), client, GitlabMergeRequestSchema, path, round.tally)
  const { login } = ctx.deployment.gitlab ?? { login: '' }
  let incomplete = false
  // A deleted or forbidden noteable is gone for good; any other read failure keeps the cursor so the next poll retries it.
  const permanentlyGone = (error: unknown): boolean => error instanceof CliError && [403, 410].includes(error.code ?? 0)
  for (const item of items) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const kind = id === 'issues' ? 'issue' as const : 'merge_request' as const
    const text = `${item.title}\n\n${item.description ?? ''}`
    // Allow a few seconds of clock skew between this host and the GitLab instance.
    const created = Date.parse(item.created_at) >= Date.parse(started) - 5000
    const observed = id === 'issues' ? config.observeIssues : config.observeMergeRequests
    // The agent's own description is not an event, but its notes and merge request state still are.
    if (!sameName(item.author.username, login) && created && (observed || mentions(text, login))) {
      const trigger = id === 'issues' ? issueTrigger(refOf(config), item, login) : mergeRequestTrigger(refOf(config), item as GitlabMergeRequest, login)
      await ctx.receive(trigger)
      nameThread(ctx, trigger, item.title, id === 'merge_requests')
    }
    if (id === 'merge_requests') {
      try { await observeMergeRequest(ctx, client, item as GitlabMergeRequest) }
      catch (error) {
        if (!stopped(ctx, round) && !permanentlyGone(error)) round.failures.push(`!${item.iid}: ${String(error)}`)
        if (!permanentlyGone(error)) incomplete = true
      }
    }
    // A note can be the only mention in an update, so read it even when the description is not received.
    try { await ingestNotes(ctx, round, client, kind, item, config.observeComments) }
    catch (error) {
      if (!stopped(ctx, round) && !permanentlyGone(error)) round.failures.push(`${kind === 'issue' ? '#' : '!'}${item.iid} notes: ${String(error)}`)
      if (!permanentlyGone(error)) incomplete = true
    }
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? item.created_at)).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  // Do not skip an unread note or merge request state: keep the old cursor so the next round reads it again.
  const next = incomplete ? since : Date.parse(moved) > Date.parse(since) ? moved : since
  ctx.state.set(KV.gitlab.stream(id), { since: next, started, observed: observedNow })
}
const refOf = (config: Pick<GitlabConfig, 'host' | 'project'>): GitlabRef => ({ host: config.host, project: config.project })
function nameThread(ctx: SourceContext, trigger: Trigger, title: string, mr: boolean): void {
  const kind = mr ? 'merge_request' : 'issue'
  ctx.threads.patch(gitlabThread(kind, Number(trigger.meta.iid)), { iid: Number(trigger.meta.iid), isPr: mr, title,
    ...trigger.url ? { url: trigger.url } : {} })
  ctx.threads.describe(gitlabThread(kind, Number(trigger.meta.iid)), { label: `${mr ? '!' : '#'}${trigger.meta.iid} ${title}`,
    facts: { number: { value: `${mr ? '!' : '#'}${trigger.meta.iid}` } } })
}
/** Reads the notes of an Issue or the discussions of an MR and receives the ones that address the agent, all when observed, or all on a subscribed Thread. */
async function ingestNotes(ctx: SourceContext, round: Round, client: GitlabClient, kind: 'issue' | 'merge_request',
  noteable: { iid: number; web_url?: string; title?: string }, observeAll: boolean): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)!
  const subscribed = !!ctx.threads.get(gitlabThread(kind, noteable.iid))?.subscriptions.length
  const { login } = ctx.deployment.gitlab ?? { login: '' }
  const commands = ctx.commands.withSignal(round.signal)
  const accept = (note: GitlabNote): boolean => !note.system && !sameName(note.author.username, login)
    && (observeAll || subscribed || mentions(note.body ?? '', login))
  if (kind === 'issue') {
    const notes = await gitlabPages(commands, client, GitlabNoteSchema,
      `${projectPath(client)}/issues/${noteable.iid}/notes?sort=asc&order_by=created_at`, round.tally)
    for (const note of notes) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (!accept(note)) continue
      const trigger = noteTrigger(refOf(config), { kind, iid: noteable.iid, ...noteable.web_url ? { web_url: noteable.web_url } : {} }, note, login)
      await ctx.receive(trigger)
      nameThread(ctx, trigger, noteable.title ?? '', false)
    }
    return
  }
  const discussions = await gitlabPages(commands, client, GitlabDiscussionSchema,
    `${projectPath(client)}/merge_requests/${noteable.iid}/discussions?order_by=created_at`, round.tally)
  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (!accept(note)) continue
      const trigger = noteTrigger(refOf(config), { kind, iid: noteable.iid, ...noteable.web_url ? { web_url: noteable.web_url } : {} }, note, login,
        discussion.individual_note ? undefined : discussion.id)
      await ctx.receive(trigger)
      nameThread(ctx, trigger, noteable.title ?? '', true)
    }
  }
}
/** Polls subscribed GitLab Threads independently, including MR state and pipeline changes. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const client = clientOf(config)
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    const ref = gitlabThreadRef(thread.ref.id)
    if (!ref) return
    try {
      const item = ref.kind === 'issue'
        ? await gitlabApi(ctx.commands.withSignal(round.signal), client, GitlabIssueSchema, `${projectPath(client)}/issues/${ref.iid}`)
        : await gitlabApi(ctx.commands.withSignal(round.signal), client, GitlabMergeRequestSchema, `${projectPath(client)}/merge_requests/${ref.iid}`)
      await ingestNotes(ctx, round, client, ref.kind, item, true)
      if (ref.kind === 'merge_request') {
        const mr = { ...item as GitlabMergeRequest, iid: ref.iid }
        await observeMergeRequest(ctx, client, mr)
        await pollMergeRequestPipeline(ctx, round, client, mr)
      }
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (!stopped(ctx, round)) round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  })
}
/** Reads the latest pipeline of each open ticket's merge requests and reports a status change. */
export async function pollTicketPipelines(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const client = clientOf(config)
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try {
      const mr = await readMergeRequest(ctx.commands, client, iid, round.signal)
      await observeMergeRequest(ctx, client, mr)
      await pollMergeRequestPipeline(ctx, round, client, mr)
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`!${iid}: ${String(error)}`) }
  }
}
async function pollMergeRequestPipeline(ctx: SourceContext, round: Round, client: GitlabClient, mr: GitlabMergeRequest): Promise<void> {
  const pipelines = await gitlabApi(ctx.commands.withSignal(round.signal), client, z.array(GitlabPipelineSchema),
    `${projectPath(client)}/merge_requests/${mr.iid}/pipelines?order_by=id&sort=desc&per_page=1`)
  const pipeline = pipelines[0]
  if (!pipeline) return
  const previous = ctx.state.get(KV.gitlab.ci(mr.iid))
  if (previous?.pipeline === pipeline.id && previous.status === pipeline.status) return
  if (previous) {
    await ctx.receive(pipelineTrigger(refOf(ctx.config<GitlabConfig>(SOURCE)!), pipeline, pipelineSummary(pipeline, `MR !${mr.iid}`),
      { kind: 'merge_request', iid: mr.iid, ...mr.web_url ? { webUrl: mr.web_url } : {} }))
  }
  ctx.state.set(KV.gitlab.ci(mr.iid), { pipeline: pipeline.id, status: pipeline.status })
}
/** Polls the default branch's latest pipeline and receives a Trigger on each status change after a baseline. */
export async function pollBranchPipelines(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const client = clientOf(config)
  const project = await gitlabApi(ctx.commands.withSignal(round.signal), client, z.looseObject({ default_branch: z.string().nullish() }), projectPath(client))
  const branch = project.default_branch ?? 'main'
  const pipelines = await gitlabApi(ctx.commands.withSignal(round.signal), client, z.array(GitlabPipelineSchema),
    `${projectPath(client)}/pipelines?ref=${encodeURIComponent(branch)}&order_by=id&sort=desc&per_page=1`)
  const pipeline = pipelines[0]
  if (!pipeline) return
  const previous = ctx.state.get(KV.gitlab.branchPipeline)
  if (previous && (previous.pipeline !== pipeline.id || previous.status !== pipeline.status)) {
    await ctx.receive(pipelineTrigger(refOf(config), pipeline, pipelineSummary(pipeline, branch), { kind: 'branch' }))
  }
  ctx.state.set(KV.gitlab.branchPipeline, { pipeline: pipeline.id, status: pipeline.status })
}
export function pipelineSummary(pipeline: GitlabPipeline, where: string): string {
  return `GitLab pipeline #${pipeline.id} ${pipeline.status} on ${where} at ${pipeline.sha.slice(0, 7)}\nRead ${pipeline.web_url ?? 'the pipeline'} for every job.`
}
/** One polling round: project Issues, merge requests, then subscribed Threads and the pipelines of open tickets. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config || !configured(config)) { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  const round = newRound(signal)
  await pollStream(ctx, round, 'issues')
  await pollStream(ctx, round, 'merge_requests')
  await pollThreads(ctx, signal, round)
  await pollTicketPipelines(ctx, signal, round)
  const observed = ctx.config<GitlabConfig>(SOURCE)
  if (observed?.observePipelines) await pollBranchPipelines(ctx, signal, round).catch((error: unknown) => {
    if (!stopped(ctx, round)) round.failures.push(`pipelines: ${String(error)}`)
  })
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.report('gitlab', { state: 'ready', detail: `${round.tally.skipped} unreadable items skipped; next poll ≥ ${observed?.pollSeconds ?? 60}s`, at: round.started })
}
/** Re-exported for tests and callers that need a project's noteable URL. */
export const mergeRequestPage = (ref: GitlabRef, iid: number): string => gitlabPage(ref, 'merge_request', iid)
