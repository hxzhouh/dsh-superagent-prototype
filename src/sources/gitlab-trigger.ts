/** Normalizes GitLab issues, merge requests and notes into domain Triggers on self-hosted instances. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** A GitLab instance and project path; both are part of every Thread id and Channel address. */
export interface GitlabRef { host: string; project: string }
export type GitlabNoteable = 'issue' | 'merge_request'
/** Thread id inside the Source, distinguishing issues from merge requests because their IIDs count separately. */
export const gitlabThreadId = (kind: GitlabNoteable, iid: number): string => `${kind === 'issue' ? 'issue' : 'mr'}:${iid}`
export const gitlabThread = (kind: GitlabNoteable, iid: number): string => `${SOURCE}:${gitlabThreadId(kind, iid)}`
/** Splits a Thread id such as `gitlab:mr:12` or `mr:12` into its kind and IID. */
export function gitlabThreadRef(id: string): { kind: GitlabNoteable; iid: number } | undefined {
  const match = /^(?:gitlab:)?(issue|mr):([1-9]\d*)$/.exec(id)
  return match ? { kind: match[1] === 'issue' ? 'issue' : 'merge_request', iid: Number(match[2]) } : undefined
}
export const gitlabPage = (ref: GitlabRef, kind: GitlabNoteable, iid: number): string =>
  `https://${ref.host}/${ref.project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}`
/** Channel address for a noteable's conversation or one of its discussion threads. */
export const gitlabChannel = (ref: GitlabRef, kind: GitlabNoteable, iid: number, extra: { discussionId?: string; noteId?: number; url?: string } = {}): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThread(kind, iid), address: { host: ref.host, project: ref.project, kind, iid: String(iid),
    ...extra.discussionId ? { discussionId: extra.discussionId } : {}, ...extra.noteId ? { noteId: String(extra.noteId) } : {},
    ...extra.url ? { url: extra.url } : {} } })
/** Parses a GitLab issue, merge request or note URL on the configured instance and project. */
export function gitlabAddress(url: string, ref: GitlabRef): { kind: GitlabNoteable; iid: number; discussionId?: string; noteId?: number } | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (!sameName(parsed.host, ref.host)) return undefined
  const match = /^\/(.+?)\/-\/(issues|merge_requests)\/(\d+)(?:\/(?:diffs|discussions)\/)?(?:[^/]+\/)?(?:#(?:note_|discussion_)?([\w-]+))?$/
    .exec(parsed.pathname)
  if (!match || !sameName(decodeURIComponent(match[1]!), ref.project)) return undefined
  const note = /^#(?:note_|discussion_)?([\w-]+)$/.exec(parsed.hash)
  return { kind: match[2] === 'issues' ? 'issue' : 'merge_request', iid: Number(match[3]),
    ...note ? /^\d+$/.test(note[1]!) ? { noteId: Number(note[1]) } : { discussionId: note[1]! } : {} }
}
/** GitLab returns an inactive account as a ghost-like user; keep an id so the actor is never empty. */
export const GitlabUserSchema = z.looseObject({ id: z.number().int().optional(), username: z.string(),
  name: z.string().optional(), bot: z.boolean().optional() })
export type GitlabUser = z.infer<typeof GitlabUserSchema>
export const GitlabIssueSchema = z.looseObject({
  id: z.number(), iid: z.number().int().positive(), project_id: z.number().optional(), title: z.string(), description: z.string().nullish(),
  state: z.string(), created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string().optional(), author: GitlabUserSchema,
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).optional(), user_notes_count: z.number().optional(),
})
export type GitlabIssue = z.infer<typeof GitlabIssueSchema>
export const GitlabMergeRequestSchema = GitlabIssueSchema.extend({
  source_branch: z.string().optional(), target_branch: z.string().optional(), sha: z.string().optional(), source_project_id: z.number().int().optional(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  head_pipeline: z.looseObject({ id: z.number(), status: z.string(), sha: z.string().optional(), web_url: z.string().optional() }).nullish(),
})
export type GitlabMergeRequest = z.infer<typeof GitlabMergeRequestSchema>
export const GitlabNoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: GitlabUserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().default(false), noteable_type: z.string().optional(), noteable_iid: z.number().int().optional(),
  type: z.string().nullish(), resolvable: z.boolean().optional(), resolved: z.boolean().optional(),
  position: z.looseObject({ new_path: z.string().optional(), old_path: z.string().optional(), new_line: z.number().nullish(),
    old_line: z.number().nullish() }).nullish(),
})
export type GitlabNote = z.infer<typeof GitlabNoteSchema>
export const GitlabDiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().optional(), notes: z.array(GitlabNoteSchema) })
export type GitlabDiscussion = z.infer<typeof GitlabDiscussionSchema>
export const GitlabPipelineSchema = z.looseObject({ id: z.number(), iid: z.number().optional(), status: z.string(), sha: z.string(),
  ref: z.string().optional(), web_url: z.string().optional(), updated_at: z.string().optional(), created_at: z.string().optional() })
export type GitlabPipeline = z.infer<typeof GitlabPipelineSchema>
/** GitLab marks automation as bot accounts; usernames ending in `_bot` are a legacy convention. */
export const isHumanGitlabUser = (user: Pick<GitlabUser, 'username' | 'bot'>): boolean => user.bot !== true && !/(?:^|[-_])bot$/i.test(user.username)
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_.-])@${escapeRegExp(username)}(?![A-Za-z0-9_.-])`, 'i').test(text)
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanGitlabUser(user) && !sameName(user.username, agent) })
const labelNames = (issue: GitlabIssue): string[] | undefined => issue.labels?.map(label => typeof label === 'string' ? label : label.name)
const descriptionText = (item: GitlabIssue): string => `${item.title}\n\n${item.description ?? ''}`
/** Builds a Trigger for a new or updated Issue; its stable id keeps a re-poll from creating another Trigger. */
export function issueTrigger(ref: GitlabRef, issue: GitlabIssue, agent: string): Trigger {
  const text = descriptionText(issue)
  return { id: key('gitlab-issue', ref.host, ref.project, String(issue.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('issue', issue.iid) }], ...author(issue.author, agent),
    at: issue.created_at, text, ...(mentions(text, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, 'issue', issue.iid, { url: issue.web_url }), ...(issue.web_url ? { url: issue.web_url } : {}),
    meta: { host: ref.host, project: ref.project, kind: 'issue', iid: issue.iid, number: issue.iid, isPr: false, ...labelNames(issue) ? { labels: labelNames(issue) } : {} } }
}
/** Builds a Trigger for a new or updated merge request. */
export function mergeRequestTrigger(ref: GitlabRef, mr: GitlabMergeRequest, agent: string): Trigger {
  const text = descriptionText(mr)
  return { id: key('gitlab-mr', ref.host, ref.project, String(mr.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('merge_request', mr.iid) }], ...author(mr.author, agent),
    at: mr.created_at, text, ...(mentions(text, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, 'merge_request', mr.iid, { url: mr.web_url }), ...(mr.web_url ? { url: mr.web_url } : {}),
    meta: { host: ref.host, project: ref.project, kind: 'merge_request', iid: mr.iid, number: mr.iid, isPr: true, prAuthor: mr.author.username,
      ...mr.source_branch ? { sourceBranch: mr.source_branch } : {}, ...mr.target_branch ? { targetBranch: mr.target_branch } : {} } }
}
/** Formats a note's file and line preface for a diff note. */
export function notePlace(note: GitlabNote): string {
  const path = note.position?.new_path ?? note.position?.old_path
  const line = note.position?.new_line ?? note.position?.old_line
  return path ? `${path}${line != null ? `:${line}` : ''}` : ''
}
/** Builds a Trigger for a note or a diff discussion reply; `discussionId` routes replies to the right GitLab discussion. */
export function noteTrigger(ref: GitlabRef, noteable: { kind: GitlabNoteable; iid: number; web_url?: string }, note: GitlabNote,
  agent: string, discussionId?: string): Trigger {
  const at = note.updated_at ?? note.created_at
  const text = [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n')
  const kind = noteable.kind
  const replyTo = (note as { reply_to?: number }).reply_to
  return { id: key('gitlab-note', ref.host, ref.project, kind, String(noteable.iid), String(note.id), at), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId(kind, noteable.iid) }], ...author(note.author, agent), at, text,
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, kind, noteable.iid, { ...discussionId ? { discussionId } : {}, noteId: note.id,
      ...noteable.web_url ? { url: noteable.web_url } : {} }),
    ...(noteable.web_url ? { url: `${noteable.web_url}#note_${note.id}` } : {}),
    meta: { host: ref.host, project: ref.project, kind: 'note', noteable: kind, iid: noteable.iid, number: noteable.iid, isPr: kind === 'merge_request',
      noteId: note.id, ...discussionId ? { discussionId } : {}, ...replyTo ? { replyTo } : {},
      ...note.position?.new_path ?? note.position?.old_path ? { path: note.position?.new_path ?? note.position?.old_path,
        line: note.position?.new_line ?? note.position?.old_line ?? null } : {} } }
}
/** A stable pipeline Trigger id: the pipeline id and status make each transition a distinct Trigger. */
export function pipelineTrigger(ref: GitlabRef, pipeline: GitlabPipeline, summary: string, extra: { kind: 'branch' | 'merge_request'; iid?: number; webUrl?: string }): Trigger {
  const thread = extra.kind === 'branch' ? `pipeline:${pipeline.ref ?? 'default'}` : gitlabThreadId('merge_request', extra.iid!)
  return { id: key('gitlab-pipeline', ref.host, ref.project, String(pipeline.id), pipeline.status), source: SOURCE,
    threads: [{ source: SOURCE, id: thread }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary,
    ...extra.kind === 'merge_request' && extra.iid ? { channel: gitlabChannel(ref, 'merge_request', extra.iid, { url: extra.webUrl }),
      meta: { host: ref.host, project: ref.project, kind: 'pipeline', iid: extra.iid, number: extra.iid, isPr: true, ci: true, pipelineId: pipeline.id, status: pipeline.status } }
      : { meta: { host: ref.host, project: ref.project, kind: 'pipeline', ci: true, branch: pipeline.ref, pipelineId: pipeline.id, status: pipeline.status } },
    ...(pipeline.web_url ?? extra.webUrl) ? { url: pipeline.web_url ?? extra.webUrl } : {} }
}
