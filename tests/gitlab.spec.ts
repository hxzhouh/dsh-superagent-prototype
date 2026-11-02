import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { resolveGitlabDeployment, type Probe } from '../src/deployment.ts'
import { apply as applyGitlab, gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { gitlabThreadContext } from '../src/sources/gitlab-read.ts'
import { gitlabAddress, gitlabThread, issueTrigger, mergeRequestTrigger, noteTrigger, pipelineTrigger } from '../src/sources/gitlab-trigger.ts'
import { pipelineSummary } from '../src/sources/gitlab.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabChannel } from '../src/sources/gitlab-trigger.ts'
import { claimMergeRequest, mergeRequestEndNotices, observeMergeRequest } from '../src/sources/gitlab-pull.ts'
import { writeEnvironment, workerBin, workerGitConfig } from '../src/infra/environment.ts'

const HOST = 'gitlab.example.com'
const PROJECT = 'acme/widgets'
const AGENT = 'agent-bot'
const REF = { host: HOST, project: PROJECT }
it('accepts its empty default configuration when it is saved and read back', () => {
  const initial = gitlabKind.schema.parse({})
  expect(gitlabKind.schema.parse(initial)).toEqual(initial)
  expect(gitlabKind.schema.safeParse({ host: 'https://gitlab.example.com' }).success).toBe(false)
})
const now = (): string => new Date().toISOString()
const issue = (overrides: Record<string, unknown> = {}) => ({ id: 1, iid: 7, title: 'Login fails', description: 'Please look', state: 'opened',
  created_at: now(), updated_at: now(), web_url: `https://${HOST}/${PROJECT}/-/issues/7`, author: { id: 1, username: 'carol' }, ...overrides })
const mr = (overrides: Record<string, unknown> = {}) => ({ id: 2, iid: 12, title: 'Fix login', description: 'A fix', state: 'opened',
  created_at: now(), updated_at: now(), web_url: `https://${HOST}/${PROJECT}/-/merge_requests/12`, author: { id: 1, username: 'carol' },
  source_branch: 'fix/login', target_branch: 'main', sha: 'abcdef0123456789', ...overrides })
const sourceTriggerId = key('gitlab-mr', HOST, PROJECT, '12')
const note = (overrides: Record<string, unknown> = {}) => ({ id: 100, body: 'Please fix this', author: { id: 1, username: 'carol' }, created_at: now(),
  updated_at: now(), system: false, ...overrides })
const discussion = (notes: unknown[], overrides: Record<string, unknown> = {}) => ({ id: 'd1', individual_note: false, notes, ...overrides })

function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { gitlab: { allowed: [{ id: 'carol' }] } } },
    sources: { gitlab: { enabled: true, config: { host: HOST, project: PROJECT, cli: 'glab', ...config } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const deployment = testDeployment({ repository: PROJECT, github: undefined,
    gitlab: { cli: '/bin/glab', host: HOST, project: PROJECT, login: AGENT, noreply: `${AGENT}@users.noreply.host` } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(deps, gitlabKind)
  return { ...deps, ctx, store, engine, commands, receive, health: board.all }
}
/** Route `glab api` calls by the project-relative path. */
function gitlab(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    const path = args[3]!.replace(/^projects\/acme%2Fwidgets\//, '').replace(/^projects\/acme%2Fwidgets$/, 'project')
    reads.push(path)
    const base = path.split('?')[0]!
    const route = routes[base]
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return JSON.stringify(args.includes('--method') ? {} : value ?? [])
  })
  return reads
}

describe('GitLab translation', () => {
  it('uses one stable id per Issue and MR and keeps their IID spaces apart', () => {
    const first = issueTrigger(REF, issue() as never, AGENT)
    expect(first).toMatchObject({ id: key('gitlab-issue', HOST, PROJECT, '7'), source: 'gitlab',
      threads: [{ source: 'gitlab', id: 'issue:7' }], actor: { source: 'gitlab', id: 'carol' }, human: true,
      channel: { source: 'gitlab', thread: 'gitlab:issue:7', address: { host: HOST, project: PROJECT, kind: 'issue', iid: '7' } },
      meta: { host: HOST, project: PROJECT, kind: 'issue', iid: 7 } })
    // A later poll of the same Issue produces the same Trigger, not a second one.
    expect(issueTrigger(REF, issue({ updated_at: '2027-01-01T00:00:00Z' }) as never, AGENT).id).toBe(first.id)
    const pull = mergeRequestTrigger(REF, mr() as never, AGENT)
    expect(pull).toMatchObject({ id: key('gitlab-mr', HOST, PROJECT, '12'), threads: [{ source: 'gitlab', id: 'mr:12' }],
      meta: { kind: 'merge_request', iid: 12, isPr: true, prAuthor: 'carol' } })
    expect(pull.threads[0]!.id).not.toBe(first.threads[0]!.id)
    expect(gitlabThread('issue', 7)).toBe('gitlab:issue:7')
    expect(gitlabThread('merge_request', 7)).toBe('gitlab:mr:7')
  })
  it('marks mentions and bots, and routes a discussion reply to its discussion id', () => {
    const mentioned = issueTrigger(REF, issue({ description: 'Hi @agent-bot' }) as never, AGENT)
    expect(mentioned.addressed).toBe('mention')
    const bot = noteTrigger(REF, { kind: 'merge_request', iid: 12, web_url: mr().web_url }, note({ author: { id: 9, username: 'review-bot', bot: true } }) as never,
      AGENT, 'd1')
    expect(bot).toMatchObject({ human: false, channel: { address: { kind: 'merge_request', iid: '12', discussionId: 'd1' } },
      meta: { noteable: 'merge_request', discussionId: 'd1', noteId: 100 } })
    const diff = noteTrigger(REF, { kind: 'merge_request', iid: 12 }, note({ id: 101, position: { new_path: 'src/a.ts', new_line: 4 }, type: 'DiffNote' }) as never,
      AGENT, 'd1')
    expect(diff.text).toContain('src/a.ts:4')
    expect(gitlabAddress(`https://${HOST}/${PROJECT}/-/merge_requests/12#note_101`, REF)).toMatchObject({ kind: 'merge_request', iid: 12 })
    expect(gitlabAddress(`https://other.example/${PROJECT}/-/merge_requests/12`, REF)).toBeUndefined()
  })
})

  it('gives each pipeline status a distinct id on the MR thread and a stable summary', () => {
    const failed = pipelineTrigger(REF, { id: 9, status: 'failed', sha: 'abcdef0123456789' }, pipelineSummary({ id: 9, status: 'failed', sha: 'abcdef0123456789' }, 'MR !12'),
      { kind: 'merge_request', iid: 12 })
    const passed = pipelineTrigger(REF, { id: 9, status: 'passed', sha: 'abcdef0123456789' }, pipelineSummary({ id: 9, status: 'passed', sha: 'abcdef0123456789' }, 'MR !12'),
      { kind: 'merge_request', iid: 12 })
    expect(failed.threads).toEqual([{ source: 'gitlab', id: 'mr:12' }])
    expect(failed.meta).toMatchObject({ kind: 'pipeline', ci: true, iid: 12, pipelineId: 9 })
    expect(failed.id).not.toBe(passed.id)
    expect(failed.text).toContain('GitLab pipeline #9 failed on MR !12')
  })
describe('GitLab Source scope and policy', () => {
  it('listens only to the configured instance and project, and observes rows only when switched on', () => {
    const config = { host: HOST, project: PROJECT, cli: 'glab', observeIssues: true, observeComments: true }
    expect(gitlabKind.scope!({ meta: { host: HOST, project: PROJECT, kind: 'issue' } }, config as never)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { host: HOST, project: 'other/repo', kind: 'issue' } }, config as never)).toEqual({ listened: false, reason: 'gitlab_project_not_allowed' })
    expect(gitlabKind.scope!({ meta: { host: 'other.example', project: PROJECT, kind: 'issue' } }, config as never)).toEqual({ listened: false, reason: 'gitlab_instance_not_allowed' })
    expect(gitlabKind.scope!({ meta: { host: HOST, project: PROJECT, kind: 'note' } }, { ...config, observeComments: false } as never))
      .toEqual({ listened: true, observed: false, row: 'comments' })
    const rows = gitlabKind.policy!.rows!({ host: HOST, project: PROJECT, cli: 'glab', observeComments: true })
    expect(rows.map(row => row.id)).toEqual(['issues', 'merge_requests', 'comments', 'pipelines'])
    expect(rows.find(row => row.id === 'comments')!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
    expect(rows.find(row => row.id === 'pipelines')!.cells.unlistedUnaddressed).toBe(false)
  })
  it('gates a listed mention as explicit and an observed unaddressed note as inferred', () => {
    const h = host({}, { observeComments: true })
    const policy = settingsPolicy(h.store.settings(), h.sources)
    const mentioned = issueTrigger(REF, issue({ description: 'Hi @carol, please look' }) as never, AGENT)
    // The issue mention is by carol and addressed to the agent when the agent's username is in the text; build one for the gate.
    const addressed = issueTrigger(REF, issue({ description: 'Hi @agent-bot, please look' }) as never, AGENT)
    expect(policy.gate(addressed, h.store.threads.get('gitlab:issue:7') ?? { key: '', ref: { source: 'gitlab', id: '' }, createdAt: '', subscriptions: [],
      correlated: [], pending: [], meta: {} }, [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', source: 'gitlab' } })
    expect(mentioned.addressed).toBeUndefined()
    const noteValue = noteTrigger(REF, { kind: 'issue', iid: 7 }, note({ body: 'and the header' }) as never, AGENT)
    expect(policy.gate(noteValue, { key: 'gitlab:issue:7', ref: { source: 'gitlab', id: 'issue:7' }, createdAt: '', subscriptions: [],
      correlated: [], pending: [], meta: {} }, [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', row: 'comments' } })
    h.store.close()
  })
  it('builds declarations and values from the resolved GitLab account', () => {
    const trigger = mergeRequestTrigger(REF, mr() as never, AGENT)
    const values = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: { cli: 'glab', host: HOST, project: PROJECT, login: AGENT,
      noreply: `${AGENT}@users.noreply.${HOST}` }, github: undefined }), config: {} as never, trigger })
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITLAB_HOST: HOST, DSH_SUPERAGENT_GITLAB_PROJECT: PROJECT, DSH_SUPERAGENT_GITLAB_ACCOUNT: AGENT,
      DSH_SUPERAGENT_GITLAB_MR_IID: '12', DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/12/head' })
  })
})

describe('GitLab polling', () => {
  it('admits only explicit unmarked requests from the shared account when enabled', async () => {
    const run = async (enabled: boolean) => {
      const h = host({}, { allowSelfRequests: enabled, observeIssues: true, observeComments: true })
      const self = { id: 2, username: AGENT, bot: false }
      h.ctx.state.set(KV.gitlab.selfRequests, { since: '2026-01-01T00:00:00.000Z', host: HOST, project: PROJECT })
      gitlab(h, {
        issues: [issue({ author: self, description: '@agent-bot fix this' })],
        'issues/7/notes': [
          note({ id: 101, author: self, body: '@agent-bot please follow up' }),
          note({ id: 102, author: self, body: '@agent-bot done\n\n<!-- dsh-superagent:reply-1 -->' }),
          note({ id: 103, author: self, body: 'ordinary message' }),
          note({ id: 104, author: self, system: true, body: '@agent-bot system' }),
          note({ id: 105, author: self, body: '@agent-bot old request', created_at: '2025-01-01T00:00:00.000Z' }),
        ],
        merge_requests: [mr({ author: self, description: '@agent-bot review this' })],
        'merge_requests/12/discussions': [discussion([note({ id: 201, author: self, body: '@agent-bot inspect this' })])],
        'merge_requests/12/pipelines': [],
      })
      await pollRound(h.ctx, new AbortController().signal)
      await pollRound(h.ctx, new AbortController().signal)
      const saved = h.store.read.recentTriggers(0, 20)
      h.store.close()
      return saved
    }
    expect(await run(false)).toHaveLength(0)
    const saved = await run(true)
    expect(saved).toHaveLength(4)
    expect(saved.every(trigger => trigger.human && trigger.addressed === 'mention')).toBe(true)
    expect(saved.some(trigger => [102, 103, 105].includes(Number(trigger.meta.noteId)))).toBe(false)
  })
  it('still requires an allowed-list entry for a shared-account request', () => {
    const h = host({}, { allowSelfRequests: true })
    const trigger = { ...issueTrigger(REF, issue({ author: { id: 2, username: AGENT }, description: '@agent-bot fix this' }) as never, AGENT), human: true }
    const thread = { key: 'gitlab:issue:7', ref: { source: 'gitlab', id: 'issue:7' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
    expect(settingsPolicy(h.store.settings(), h.sources).gate(trigger, thread, [])).toMatchObject({ admissible: false })
    const settings = h.store.settings()
    settings.policy.sources.gitlab = { allowed: [{ id: AGENT }], admission: {} }
    h.store.saveSettings(settings)
    expect(settingsPolicy(h.store.settings(), h.sources).gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
    h.store.close()
  })
  it('does not turn historical self-mentions into new work when enabled', async () => {
    const h = host({}, { allowSelfRequests: true })
    const self = { id: 2, username: AGENT }
    gitlab(h, { issues: [issue()], 'issues/7/notes': [note({ author: self, body: '@agent-bot old request', created_at: '2025-01-01T00:00:00Z' })], merge_requests: [] })
    await pollRound(h.ctx, new AbortController().signal)
    expect(h.store.read.recentTriggers(0, 20)).toHaveLength(0)
    expect(h.ctx.state.get(KV.gitlab.selfRequests)?.since).toBeTruthy()
    h.store.close()
  })
  it('stores a mentioning note once, skips the agent and system notes, and leaves an unobserved description out', async () => {
    const h = host()
    gitlab(h, {
      issues: [issue()],
      'issues/7/notes': [note({ id: 100, body: '@agent-bot please fix this' }), note({ id: 101, author: { id: 2, username: AGENT } }), note({ id: 102, system: true, body: 'changed' })],
      merge_requests: [mr()],
      'merge_requests/12/discussions': [discussion([note({ id: 200, body: 'MR note' })])],
      'merge_requests/12/pipelines': [],
    })
    await pollRound(h.ctx, new AbortController().signal)
    const saved = h.store.read.recentTriggers(0, 20)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.threads).toEqual([{ source: 'gitlab', id: 'issue:7' }])
    expect(saved[0]!.meta).toMatchObject({ kind: 'note', noteId: 100, noteable: 'issue' })
    expect(saved[0]).toMatchObject({ source: 'gitlab', actor: { id: 'carol' }, addressed: 'mention' })
    expect((h.store.get(KV.gitlab.stream('issues')) as { since: string }).since).toBeTruthy()
    // The next round returns the same note; Engine deduplication keeps one Trigger.
    const before = h.store.read.recentTriggers(0, 20).length
    await pollRound(h.ctx, new AbortController().signal)
    expect(h.store.read.recentTriggers(0, 20)).toHaveLength(before)
    h.store.close()
  })
  it('receives a new Issue only when the switch is on, and reads its notes even then', async () => {
    const h = host({}, { observeIssues: true, observeComments: true })
    gitlab(h, { issues: [issue({ description: 'No mention here' })], 'issues/7/notes': [], merge_requests: [],
      'merge_requests/12/pipelines': [] })
    await pollRound(h.ctx, new AbortController().signal)
    expect(h.store.read.recentTriggers(0, 10).map(trigger => trigger.source)).toEqual(['gitlab'])
    expect(h.store.read.recentTriggers(0, 10)[0]!.meta.kind).toBe('issue')
    h.store.close()
  })
  it('keeps the project cursor when a note read fails, so the next round retries it', async () => {
    const h = host()
    gitlab(h, { issues: [issue({ description: '@agent-bot please look' })], 'issues/7/notes': [], merge_requests: [], 'merge_requests/12/pipelines': [] })
    await pollRound(h.ctx, new AbortController().signal)
    const before = (h.store.get(KV.gitlab.stream('issues')) as { since: string }).since
    vi.restoreAllMocks()
    gitlab(h, { issues: [issue({ description: '@agent-bot please look' })], merge_requests: [], 'merge_requests/12/pipelines': [],
      'issues/7/notes': () => { throw commandError({ stderr: 'glab: Server Error (HTTP 500)', code: 1 }) } })
    await expect(pollRound(h.ctx, new AbortController().signal)).rejects.toThrow('GitLab reads failed')
    expect((h.store.get(KV.gitlab.stream('issues')) as { since: string }).since).toBe(before)
    h.store.close()
  })
  it('reads a discussion for an inline note through the Source Thread context', async () => {
    const h = host()
    gitlab(h, { 'merge_requests/12/discussions': [discussion([note({ id: 300, body: 'root', position: { new_path: 'src/a.ts', new_line: 2 } }),
      note({ id: 301, body: 'reply' })])] })
    const trigger = noteTrigger(REF, { kind: 'merge_request', iid: 12 }, note({ id: 301, body: 'reply' }) as never, AGENT, 'd1')
    const part = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, { cli: 'glab', host: HOST, project: PROJECT })
    expect(part.messages.map(message => message.text)).toEqual(['src/a.ts:2\n\nroot', 'reply'])
    expect(part.messages[1]!.reply_to).toBe('300')
    h.store.close()
  })
})

describe('GitLab channel', () => {
  it('posts once with a stable marker and answers gone for a deleted target while the project remains readable', async () => {
    const h = host()
    const message = { id: 'reply-1', channel: gitlabChannel(REF, 'issue', 7), text: 'Done', kind: 'reply' as const }
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify([]))
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(run).toHaveBeenCalledWith('/bin/glab', ['api', '--hostname', HOST, `projects/acme%2Fwidgets/issues/7/notes`,
      '--method', 'POST', '--raw-field', expect.stringContaining('<!-- dsh-superagent:reply-1 -->')])
    // A prior note with the marker is found, so a retry sends nothing.
    run.mockClear()
    run.mockImplementation(async (_program, args) => args.includes('--method') ? '{}' : JSON.stringify([{ id: 1, body: 'Done\n\n<!-- dsh-superagent:reply-1 -->',
      created_at: now(), author: { id: 2, username: AGENT } }]))
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(run.mock.calls.some(([, args]) => args.includes('--method'))).toBe(false)
    // A 404 from the note endpoint while the project is readable drops the message permanently.
    run.mockReset()
    run.mockImplementation(async (_program, args) => {
      if (args.includes('--method')) throw commandError({ stderr: 'glab: 404 Not Found', code: 1 })
      if (args[3] === 'projects/acme%2Fwidgets') return '{}'
      return JSON.stringify([])
    })
    expect(await sendGitlab(h.ctx, message)).toBe('gone')
    // A 404 from a project the agent cannot read is retryable, not dropped.
    run.mockReset()
    run.mockImplementation(async (_program, args) => {
      if (args.includes('--method')) throw commandError({ stderr: 'glab: 404 Not Found', code: 1 })
      throw commandError({ stderr: 'glab: 404 Not Found', code: 1 })
    })
    await expect(sendGitlab(h.ctx, message)).rejects.toThrow('404')
    h.store.close()
  })
})

describe('GitLab merge request tracking', () => {
  const ticket = (): Ticket => ({ id: 'ticket', title: 'T', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' as const },
    actor: { source: 'gitlab', id: 'carol' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    origin: { triggerId: sourceTriggerId, triggerIds: [] }, execution: { name: 'fix-login', directory: '/w', assignment: '' }, follows: [] })
  it('binds a source MR to its ticket once, and closes the followed thread on merge', async () => {
    const h = host()
    const source = mergeRequestTrigger(REF, mr() as never, AGENT)
    h.store.triggers.save(source)
    h.store.tickets.save(ticket())
    expect(h.store.triggers.get(sourceTriggerId)).toMatchObject({ source: 'gitlab', meta: { isPr: true, iid: 12 } })
    const claim = claimMergeRequest(h.ctx, { cli: 'glab', host: HOST, project: PROJECT }, 'ticket', { ...mr(), iid: 12 } as never)
    expect(claim).toBeUndefined()
    expect(h.store.tickets.get('ticket')!.follows).toEqual([{ thread: 'gitlab:mr:12', own: false }])
    expect(await observeMergeRequest(h.ctx, { cli: 'glab', host: HOST, project: PROJECT },
      { ...mr(), state: 'merged', merged_at: now() } as never)).toBe(true)
    expect(h.store.tickets.get('ticket')!.ended?.outcome).toBe('merged')
    const notice = mergeRequestEndNotices(h.store.tickets.get('ticket')!, 'Please fix', REF)
    expect(notice).toEqual([])
    h.store.close()
  })
  it('names the MR in a terminal notice for a chat channel', async () => {
    const ticketValue = { ...ticket(), ended: { at: now(), by: 'executor' as const, reason: 'merged' as const, outcome: 'merged' as const },
      channels: [{ source: 'feishu', thread: 'feishu:oc:om', address: { chatId: 'oc', messageId: 'om' } }],
      follows: [{ thread: 'gitlab:mr:12', own: true, closed: { at: now(), outcome: 'merged' as const } }] }
    const notice = mergeRequestEndNotices(ticketValue as never, 'Please fix', REF)
    expect(notice).toHaveLength(1)
    expect(notice[0]!.text).toContain('MR !12')
    expect(notice[0]!.text).toContain(`https://${HOST}/${PROJECT}/-/merge_requests/12`)
  })
})

describe('GitLab plugin', () => {
  it('registers the kind, reports setup-pending health, and unregisters on disposal', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-plugin-')), 'db.sqlite'))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    const deployment = testDeployment({ github: undefined, gitlab: { cli: '/bin/glab', host: HOST, project: PROJECT, login: AGENT,
      noreply: `${AGENT}@users.noreply.${HOST}` } })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const deps: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() } as never,
      outbox: { send: vi.fn() }, commands, sources, deployment, ready: Promise.resolve(), configured: () => false,
      receive: vi.fn() }
    const value = { ...deps, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
    const disposers: (() => unknown)[] = []
    applyGitlab({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.gitlab).toMatchObject({ state: 'paused', code: 'setupPending' }))
    expect(sources.kind('gitlab')).toBe(gitlabKind)
    for (const dispose of disposers) await dispose()
    expect(sources.kind('gitlab')).toBeUndefined()
    store.close()
  })
})

describe('GitLab deployment and environment', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })
  it('resolves the instance and canonical project, refusing a role below Developer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gitlab-deploy-'))
    const program = (body: string) => { const file = join(dir, 'glab'); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
    const probe: Probe = async argv => new Promise((resolve, reject) => {
      import('node:child_process').then(({ execFile }) => execFile(argv[0]!, argv.slice(1), { env: { PATH: dir } },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)))
    })
    program(`case "$*" in\n  "api --hostname gitlab.example.com user") echo '{"id":7,"username":"agent-bot"}' ;;\n  "api --hostname gitlab.example.com projects/acme%2Fwidgets") echo '{"path_with_namespace":"acme/widgets","permissions":{"project_access":{"access_level":30}}}' ;;\n  *) exit 1 ;;\nesac`)
    const account = await resolveGitlabDeployment(testDeployment(), { host: HOST, project: 'acme/widgets', cli: join(dir, 'glab') }, probe, dir)
    expect(account).toMatchObject({ host: HOST, project: PROJECT, login: AGENT })
    expect(account.repository).toBe(PROJECT)
    program(`case "$*" in\n  "api --hostname gitlab.example.com user") echo '{"id":7,"username":"agent-bot"}' ;;\n  "api --hostname gitlab.example.com projects/acme%2Fwidgets") echo '{"path_with_namespace":"acme/widgets","permissions":{"project_access":{"access_level":20}}}' ;;\n  *) exit 1 ;;\nesac`)
    await expect(resolveGitlabDeployment(testDeployment(), { host: HOST, project: PROJECT, cli: join(dir, 'glab') }, probe, dir))
      .rejects.toMatchObject({ code: 'gitlabProjectReadOnly' })
  })
  it('writes a glab shim and a credential helper for the self-hosted host', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gitlab-env-'))
    mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
    const deployment = testDeployment({ stateDir: join(dir, 'state'), github: undefined,
      gitlab: { cli: '/opt/agent-glab', host: HOST, project: PROJECT, login: AGENT, noreply: `${AGENT}@users.noreply.${HOST}` }, feishu: undefined })
    await writeEnvironment(deployment, [])
    expect(readdirSync(workerBin(join(dir, 'state'))).sort()).toEqual(['gh', 'glab', 'lark-cli'])
    expect(readFileSync(workerGitConfig(join(dir, 'state')), 'utf8')).toContain(`credential "https://${HOST}"`)
    expect(readFileSync(join(workerBin(join(dir, 'state')), 'glab'), 'utf8')).toContain('/opt/agent-glab')
  })
})
