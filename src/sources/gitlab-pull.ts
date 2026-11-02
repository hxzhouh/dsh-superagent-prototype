/** Merge request binding, lifecycle observation and terminal notifications for the GitLab Source. */
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { GitlabClient } from './gitlab-read.ts'
import { gitlabApi } from './gitlab-read.ts'
import { GitlabMergeRequestSchema, gitlabPage, type GitlabMergeRequest } from './gitlab-trigger.ts'

export const GITLAB_PROJECT = (client: Pick<GitlabClient, 'project'>): string => `projects/${client.project.includes('/') ? encodeURIComponent(client.project) : client.project}`
/** Reads one MR, including its author, branches and pipeline state. */
export const readMergeRequest = async (commands: SourceContext['commands'], client: GitlabClient, iid: number, signal?: AbortSignal): Promise<GitlabMergeRequest & { iid: number }> =>
  ({ ...await gitlabApi(commands.withSignal(signal), client, GitlabMergeRequestSchema, `${GITLAB_PROJECT(client)}/merge_requests/${iid}`), iid })
const mrNumber = (thread: string): number | undefined => {
  const match = /^gitlab:mr:([1-9]\d*)$/.exec(thread)
  return match ? Number(match[1]) : undefined
}
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** A branch belongs to a ticket when its last path segment is the ticket's short name. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/**
 * Binds an MR to a ticket when it is the ticket's origin MR or an agent-authored MR on the ticket's branch.
 * Returns a refusal, or undefined when bound or already closed.
 */
export function claimMergeRequest(ctx: SourceContext, client: GitlabClient, ticketId: string, mr: GitlabMergeRequest, signal?: AbortSignal): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === 'gitlab' && source.meta.isPr === true && Number(source.meta.iid) === mr.iid
  const account = ctx.deployment.gitlab
  const opened = !!account && sameName(mr.author.username, account.login) && ticketBranch(ticket, mr.source_branch ?? '')
    && (!account.projectId || !mr.source_project_id || mr.source_project_id === account.projectId)
  if (!started && !opened) return `The merge request does not belong to this ticket: use the source MR or an MR by ${account?.login ?? 'the agent account'} from a branch whose last path segment is DSH_SUPERAGENT_NAME`
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'The merge request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `gitlab:mr:${mr.iid}`)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, client, ticketId, mr, opened)
  void signal
  return undefined
}
/** Reconciles a polled MR's merged/closed state with its bound ticket and records auto-merge facts. */
export async function observeMergeRequest(ctx: SourceContext, client: GitlabClient, mr: GitlabMergeRequest): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed'
  if (ended) closeMergeRequest(ctx, client, mr)
  else {
    const account = ctx.deployment.gitlab
    const candidates = account && sameName(mr.author.username, account.login) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch ?? '')) : []
    const ticket = candidates.length === 1 ? candidates[0] : undefined
    const reopened = ticket?.follows?.some(item => item.thread === `gitlab:mr:${mr.iid}` && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(iid => iid === mr.iid))) claimMergeRequest(ctx, client, ticket.id, mr)
  }
  ctx.threads.describe(`gitlab:mr:${mr.iid}`, { facts: { ci: mr.head_pipeline ? { label: 'CI', value: mr.head_pipeline.status,
    ...['failed', 'canceled'].includes(mr.head_pipeline.status) ? { problem: true } : {} } : null } })
  return ended
}
function bind(ctx: SourceContext, client: GitlabClient, ticketId: string, mr: GitlabMergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: 'gitlab', id: `mr:${mr.iid}` }, own)
    ctx.threads.patch(`gitlab:mr:${mr.iid}`, { iid: mr.iid, isPr: true, ...mr.web_url ? { url: mr.web_url } : {}, prAuthor: mr.author.username })
  })
  void client
}
function closeMergeRequest(ctx: SourceContext, client: GitlabClient, mr: GitlabMergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: 'gitlab', id: `mr:${mr.iid}` }, mr.state === 'merged' ? 'merged' : 'closed', at)
  void client
}
/** Reports a merged or closed MR once to the ticket's non-GitLab conversations. */
export function mergeRequestEndNotices(ticket: Ticket, request: string, client: Pick<GitlabClient, 'host' | 'project'>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = mrNumber(follow.thread)!
  const ref = { host: client.host, project: client.project }
  const url = gitlabPage(ref, 'merge_request', iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== 'gitlab').map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
