import { beforeEach, expect, it, vi } from 'vitest'
import { executorTools } from '../src/app/tools/executor.ts'

vi.mock('../src/sources/github-pull.ts', () => ({ readPull: vi.fn(), claimPull: vi.fn() }))
vi.mock('../src/sources/gitlab-pull.ts', () => ({ readMergeRequest: vi.fn(), claimMergeRequest: vi.fn() }))
import { readPull } from '../src/sources/github-pull.ts'
import { readMergeRequest } from '../src/sources/gitlab-pull.ts'

beforeEach(() => { vi.resetAllMocks() })

function harness(githubEnabled: boolean, gitlabEnabled: boolean, follows: { thread: string; own: boolean }[] = []) {
  const ticket = { id: 't1', origin: { triggerId: 'trigger' }, follows, channels: [], assignments: [], inputs: [], undelivered: [] }
  const github = { config: () => githubEnabled ? {} : undefined, deployment: { github: { cli: 'gh' } }, commands: {} }
  const gitlab = { config: () => gitlabEnabled ? { cli: 'glab', host: 'gitlab.example.com', project: 'org/repo' } : undefined,
    deployment: { gitlab: { cli: 'glab' } }, commands: {} }
  const host = { github, gitlab, store: { tickets: { get: () => ticket }, triggers: { get: () => ({ source: 'feishu' }) },
    atomic: (fn: () => unknown) => fn() }, engine: { report: () => ticket }, sessions: { relay: vi.fn() } }
  const report = executorTools(host as never, ticket as never).find(tool => tool.name === 'orchestrator_report')!
  const run = (args: Record<string, unknown>) => report.execute(args as never, new AbortController().signal)
  return { run }
}

it('uses enabled GitLab for a Feishu ticket even when disabled GitHub account details remain', async () => {
  vi.mocked(readMergeRequest).mockResolvedValue({ iid: 809 } as never)
  const { run } = harness(false, true)
  await run({ state: 'progress', summary: 'MR created', pr_number: 809 })
  expect(readMergeRequest).toHaveBeenCalledOnce()
  expect(readPull).not.toHaveBeenCalled()
})

it('requires an explicit forge when both are enabled and no forge is bound', async () => {
  const { run } = harness(true, true)
  await expect(run({ state: 'progress', summary: 'created', pr_number: 809 })).rejects.toThrow('Specify forge')
  expect(readPull).not.toHaveBeenCalled()
  expect(readMergeRequest).not.toHaveBeenCalled()
  vi.mocked(readMergeRequest).mockResolvedValue({ iid: 809 } as never)
  await run({ state: 'progress', summary: 'created', pr_number: 809, forge: 'gitlab' })
  expect(readMergeRequest).toHaveBeenCalledOnce()
})

it('retains an existing GitLab binding and rejects switching to GitHub', async () => {
  vi.mocked(readMergeRequest).mockResolvedValue({ iid: 809 } as never)
  const { run } = harness(true, true, [{ thread: 'gitlab:mr:809', own: true }])
  await run({ state: 'progress', summary: 'update', pr_number: 809 })
  await expect(run({ state: 'progress', summary: 'update', pr_number: 809, forge: 'github' })).rejects.toThrow('existing PR or MR')
  expect(readPull).not.toHaveBeenCalled()
})
