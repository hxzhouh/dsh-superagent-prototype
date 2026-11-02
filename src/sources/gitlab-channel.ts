/** GitLab outbound channel: posts issue/MR notes and discussion replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabApi, gitlabPages } from './gitlab-read.ts'
import { GitlabDiscussionSchema, GitlabNoteSchema, type GitlabRef } from './gitlab-trigger.ts'

const FORBIDDEN = 403, NOT_FOUND = 404
const projectPath = (ref: GitlabRef): string => `projects/${ref.project.includes('/') ? encodeURIComponent(ref.project) : ref.project}`
const clientOf = (host: Pick<SourceContext, 'commands'>, address: Record<string, string>) =>
  ({ cli: host.commands.deployment.gitlab?.cli ?? '', host: address.host ?? '', project: address.project ?? '' })
/** True when GitLab permanently refuses the target: a locked/forbidden noteable, or a deleted one while the project remains readable. */
async function gone(host: Pick<SourceContext, 'commands'>, address: Record<string, string>, error: unknown): Promise<boolean> {
  if (!(error instanceof CliError)) return false
  if (error.code === FORBIDDEN) return true
  if (error.code !== NOT_FOUND) return false
  // A 404 can also mean the agent lost access to the whole project; keep that message for a retry and a person.
  const client = { cli: host.commands.deployment.gitlab?.cli ?? '', host: address.host ?? '', project: address.project ?? '' }
  if (!client.cli || !client.project) return true
  try { await gitlabApi(host.commands, client, z.unknown(), `${projectPath(client)}`); return true }
  catch { return false }
}
/** Lists the notes that can carry a previous copy of `marker`, including the notes of one discussion. */
async function existing(host: Pick<SourceContext, 'commands'>, address: Record<string, string>, marker: string): Promise<boolean> {
  const client = clientOf(host, address)
  const base = projectPath(client)
  const iid = Number(address.iid)
  if (address.discussionId) {
    const discussion = await gitlabApi(host.commands, client, GitlabDiscussionSchema,
      `${base}/merge_requests/${iid}/discussions/${encodeURIComponent(address.discussionId)}`)
    return discussion.notes.some(note => (note.body ?? '').includes(marker))
  }
  const path = `${base}/${address.kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}/${address.kind === 'issue' ? 'notes' : 'discussions'}`
  const items = address.kind === 'issue' ? await gitlabPages(host.commands, client, GitlabNoteSchema, path)
    : (await gitlabPages(host.commands, client, GitlabDiscussionSchema, path)).flatMap(discussion => discussion.notes)
  return items.some(note => (note.body ?? '').includes(marker))
}
/**
 * Posts a note with an embedded HTML marker so a retry cannot create a duplicate. A discussion reply goes to its
 * discussion; a conversation reply goes to the Issue or MR notes endpoint.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { address } = message.channel
  const iid = Number(address.iid)
  if (!address.host || !address.project || !iid) throw new Error('Missing GitLab reply target')
  const client = clientOf(host, address)
  const base = projectPath(client)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    if (await existing(host, address, marker)) return 'sent'
    const path = address.discussionId
      ? `${base}/merge_requests/${iid}/discussions/${encodeURIComponent(address.discussionId)}/notes`
      : `${base}/${address.kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}/notes`
    await gitlabApi(host.commands, client, z.unknown(), path, '--method', 'POST', '--raw-field', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (await gone(host, address, error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const kind = address.kind === 'issue' ? 'issues' : 'merge_requests'
  const url = address.url ?? (address.host && address.project ? `https://${address.host}/${address.project}/-/${kind}/${address.iid}` : '')
  const discussion = address.discussionId ? { zh: ' 的讨论', en: ' discussion' } : { zh: '', en: '' }
  const number = `${address.kind === 'issue' ? '#' : '!'}${address.iid}`
  return { url, label: { zh: `GitLab ${number}${discussion.zh}`, en: `GitLab ${number}${discussion.en}` } }
}
