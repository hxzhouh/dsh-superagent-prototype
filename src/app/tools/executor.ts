/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import { claimMergeRequest, readMergeRequest } from '../../sources/gitlab-pull.ts'
import { clientOf, type GitlabConfig } from '../../sources/gitlab.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** GitLab Source context whose merge-request rules govern claiming a reported MR. */
  readonly gitlab: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR or GitLab MR: its source one, or one by the deployment's forge account from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        forge: z.enum(['github', 'gitlab']).optional().describe('For a Feishu ticket when both sources are enabled, specify which forge owns pr_number.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const origin = host.store.triggers.get(current.origin.triggerId)
        const gitlabConfig = host.gitlab.config<GitlabConfig>('gitlab')
        const githubEnabled = !!host.github.config('github') && !!host.github.deployment.github
        const gitlabEnabled = !!gitlabConfig && !!host.gitlab.deployment.gitlab
        const sourceForge = origin?.source === 'gitlab' || origin?.source === 'github' ? origin.source : undefined
        const followed = new Set((current.follows ?? []).filter(item => !item.closed && item.own)
          .map(item => item.thread.startsWith('gitlab:mr:') ? 'gitlab' : item.thread.startsWith('github:') ? 'github' : undefined)
          .filter((item): item is 'github' | 'gitlab' => !!item))
        if (args.forge && sourceForge && args.forge !== sourceForge) throw new Error('The forge does not match the source of this ticket')
        if (args.forge && followed.size === 1 && !followed.has(args.forge)) throw new Error('The forge does not match the ticket’s existing PR or MR')
        const forge = sourceForge ?? args.forge ?? (followed.size === 1 ? [...followed][0] : undefined)
          ?? (gitlabEnabled && !githubEnabled ? 'gitlab' : githubEnabled && !gitlabEnabled ? 'github' : undefined)
        if (args.pr_number != null && !forge) throw new Error('Specify forge as github or gitlab for this ticket before reporting pr_number')
        const useGitlab = forge === 'gitlab'
        const mergeRequest = args.pr_number != null && useGitlab && gitlabEnabled && gitlabConfig
          ? await readMergeRequest(host.gitlab.commands, clientOf(gitlabConfig), args.pr_number, signal) : undefined
        const pull = args.pr_number != null && !useGitlab && githubEnabled
          ? await readPull(host.github, args.pr_number, signal) : undefined
        if (args.pr_number != null && !mergeRequest && !pull) throw new Error('Provide pr_number only for a ticket from GitHub or GitLab with that Source configured')
        // Claim the PR or MR, record the report, and queue the relay atomically so a rejected claim or invalid report leaves no partial state.
        return host.store.atomic(() => {
          const refused = mergeRequest ? claimMergeRequest(host.gitlab, clientOf(gitlabConfig!), ticketId, mergeRequest) : pull ? claimPull(host.github, ticketId, pull) : undefined
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
