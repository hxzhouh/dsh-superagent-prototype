/** Read-only GitLab project, issue, merge request, discussion and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'
import type { Trigger } from '../core/index.ts'
import { GitlabDiscussionSchema, GitlabIssueSchema, GitlabMergeRequestSchema, GitlabNoteSchema, GitlabPipelineSchema,
  isHumanGitlabUser, notePlace, type GitlabDiscussion, type GitlabIssue, type GitlabMergeRequest, type GitlabNote } from './gitlab-trigger.ts'

/** The stored account and instance a GitLab read uses; configuration supplies the same values. */
export interface GitlabClient { cli: string; host: string; project: string }
const safePath = (path: string): string => {
  if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error('GitLab calls must stay inside the configured project')
  return path
}
/** Runs `glab api` on the configured instance and parses its JSON answer; `glab` takes the instance as `--hostname`. */
export async function gitlabApi<T>(commands: Commands, client: GitlabClient, schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> {
  const output = await commands.run(client.cli, ['api', '--hostname', client.host, safePath(path), ...flags])
  return schema.parse(JSON.parse(output))
}
/** Runs `glab api` and returns its raw output, for repository files that are not JSON. */
export async function gitlabRaw(commands: Commands, client: GitlabClient, path: string, ...flags: string[]): Promise<string> {
  return commands.run(client.cli, ['api', '--hostname', client.host, safePath(path), ...flags])
}
/** Reads every page of a GitLab list, stopping at a short page and skipping unreadable items. */
export async function gitlabPages<T>(commands: Commands, client: GitlabClient, item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?'
  const items: T[] = []
  for (let page = 1; page <= 20; page++) {
    const values = await gitlabApi(commands, client, z.array(z.unknown()), `${path}${separator}per_page=100&page=${page}`)
    items.push(...validItems(item, values, tally))
    if (values.length < 100) break
  }
  return items
}
const paths = (project: string): string => `projects/${project.includes('/') ? encodeURIComponent(project) : project}`
const noteText = (note: GitlabNote): string => [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n')
const message = (note: GitlabNote, replyTo?: number): ContextMessage =>
  ({ id: String(note.id), from: note.author.username, at: note.created_at, text: noteText(note), ...!isHumanGitlabUser(note.author) ? { bot: true as const } : {},
    ...note.position?.new_path ?? note.position?.old_path ? { path: note.position?.new_path ?? note.position?.old_path,
      line: note.position?.new_line ?? note.position?.old_line ?? undefined } : {}, ...replyTo ? { reply_to: String(replyTo) } : {} })
/** Reads an Issue's description and one page of its notes. */
async function issuePage(commands: Commands, client: GitlabClient, iid: number, page: number, tally?: Tally) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const issue = await gitlabApi(commands, client, GitlabIssueSchema, `${paths(client.project)}/issues/${iid}`)
    messages.push({ id: String(issue.iid), from: issue.author.username, at: issue.created_at, text: `${issue.title}\n\n${issue.description ?? ''}`,
      ...isHumanGitlabUser(issue.author) ? {} : { bot: true as const }, ...issue.web_url ? { url: issue.web_url } : {} })
  }
  const notes = await gitlabPages(commands, client, GitlabNoteSchema, `${paths(client.project)}/issues/${iid}/notes?sort=asc&order_by=created_at`, tally)
  const offset = (page - 1) * 100
  const pageNotes = notes.slice(offset, offset + 100)
  messages.push(...pageNotes.filter(note => !note.system).map(note => message(note)))
  return { messages, next: notes.length > offset + 100 ? String(page + 1) : null, ...tally?.skipped ? { skipped: tally.skipped } : {} }
}
/** Flattens one page of an MR's discussions into messages, marking the first note of each discussion as the reply root. */
async function discussionPage(commands: Commands, client: GitlabClient, iid: number, page: number, tally?: Tally) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const mr = await gitlabApi(commands, client, GitlabMergeRequestSchema, `${paths(client.project)}/merge_requests/${iid}`)
    messages.push({ id: String(mr.iid), from: mr.author.username, at: mr.created_at, text: `${mr.title}\n\n${mr.description ?? ''}`,
      ...isHumanGitlabUser(mr.author) ? {} : { bot: true as const }, ...mr.web_url ? { url: mr.web_url } : {} })
  }
  const discussions = await gitlabPages(commands, client, GitlabDiscussionSchema,
    `${paths(client.project)}/merge_requests/${iid}/discussions?order_by=created_at`, tally)
  const offset = (page - 1) * 100
  for (const discussion of discussions.slice(offset, offset + 100)) {
    const notes = discussion.notes.filter(note => !note.system)
    const root = notes[0]
    for (const note of notes) messages.push(message(note, root && note.id !== root.id ? root.id : undefined))
  }
  return { messages, next: discussions.length > offset + 100 ? String(page + 1) : null, ...tally?.skipped ? { skipped: tally.skipped } : {} }
}
/** Reads a page of one MR discussion, such as an inline review thread. */
export async function readDiscussion(commands: Commands, client: GitlabClient, iid: number, discussionId: string, tally?: Tally): Promise<ContextPart> {
  const discussions = await gitlabPages(commands, client, GitlabDiscussionSchema, `${paths(client.project)}/merge_requests/${iid}/discussions`, tally)
  const discussion = discussions.find(item => item.id === discussionId)
  if (!discussion) throw new Error('No discussion of this merge request has that id')
  const notes = discussion.notes.filter(note => !note.system)
  const root = notes[0]
  const messages = notes.map(note => message(note, root && note.id !== root.id ? root.id : undefined))
  return { messages, body: { status: 'discussion', discussion_id: discussionId, messages }, status: 'discussion' }
}
/** Reads a non-hidden repository file or directory from the default branch through the GitLab repository tree API. */
export async function readGitlabPath(commands: Commands, client: GitlabClient, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  // GitLab requires a ref; read the project's default branch rather than assuming `main`.
  const project = await gitlabApi(commands, client, z.looseObject({ default_branch: z.string().nullish() }), paths(client.project))
  const ref = encodeURIComponent(project.default_branch ?? 'main')
  const encoded = parts.map(encodeURIComponent).join('%2F')
  if (kind === 'file') return gitlabRaw(commands, client, `${paths(client.project)}/repository/files/${encoded}/raw?ref=${ref}`)
  const listed = await gitlabPages(commands, client, z.looseObject({ name: z.string(), type: z.string() }),
    `${paths(client.project)}/repository/tree?path=${encodeURIComponent(parts.join('/'))}&ref=${ref}`)
  return listed.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
/** Reads an Issue or MR, a page of comments or discussions, a discussion, or pipeline status as compact messages. */
export async function readGitlab(commands: Commands, client: GitlabClient, resource: string): Promise<unknown> {
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussions|pipelines)(?:\/([^/]+))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, or append /notes/<page>, /discussions/<page|id> or /pipelines')
  const [, kind, number, section, page = '1'] = match
  const iid = Number(number)
  const base = `${paths(client.project)}/${kind}/${iid}`
  if (!section) {
    const item = kind === 'issues' ? await gitlabApi(commands, client, GitlabIssueSchema, base)
      : await gitlabApi(commands, client, GitlabMergeRequestSchema, base)
    const labels = item.labels?.map(label => typeof label === 'string' ? label : label.name)
    return { iid: item.iid, title: item.title, state: item.state, author: item.author.username, url: item.web_url,
      ...labels?.length ? { labels } : {}, ...kind === 'merge_requests' && 'source_branch' in item ? { head: item.source_branch, base: item.target_branch } : {} }
  }
  if (section === 'pipelines') {
    return gitlabPages(commands, client, GitlabPipelineSchema, `${base}/pipelines`)
  }
  if (section === 'discussions') {
    if (!/^\d+$/.test(page)) return readDiscussion(commands, client, iid, page)
    if (kind === 'issues') throw new Error('Discussions belong to a merge request')
    const body = await discussionPage(commands, client, iid, Number(page))
    return body
  }
  if (kind === 'merge_requests') {
    const body = await discussionPage(commands, client, iid, Number(page))
    return body
  }
  return issuePage(commands, client, iid, Number(page))
}
/**
 * Context reader for a GitLab Trigger: the whole discussion of a diff note, or an Issue/MR's description and comment pages.
 * A pipeline Trigger carries its own summary because it has no conversation.
 */
export const gitlabThreadContext: ThreadContext<GitlabClient> = {
  messageId: trigger => String(trigger.meta.noteId ?? trigger.url ?? ''),
  read: async (commands, trigger, part: ContextPartName, cursor, config) => {
    if (trigger.meta.kind === 'pipeline') {
      const item = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [item], body: { status: 'pipeline', messages: [item] }, status: 'pipeline' }
    }
    const iid = Number(trigger.meta.iid)
    const kind = trigger.meta.noteable === 'issue' ? 'issue' : 'merge_request'
    if (trigger.meta.discussionId) return readDiscussion(commands, config, iid, String(trigger.meta.discussionId))
    const page = Number(cursor ?? '1')
    const body = kind === 'issue' ? await issuePage(commands, config, iid, page) : await discussionPage(commands, config, iid, page)
    return { messages: body.messages, ...body.next ? { next: body.next } : {}, body }
  },
}
