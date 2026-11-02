# 009 Self-hosted GitLab

This guide configures a privately deployed GitLab instance as a Source. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md).

The GitLab Source is a polling Source, like GitHub's. It does not require an inbound webhook, a public URL, or a GitLab application registration. The agent reads and writes through a `glab` wrapper signed in only as the agent account.

## Scope

Supported:

- One project per GitLab Source instance, on one self-hosted instance. Issues and merge requests have separate IID sequences.
- New Issues, new merge requests, notes and diff discussions, mentions, subscribed Threads, merge request state, and pipelines of subscribed merge requests and the default branch.
- Issue comments and merge request notes, including replies to a diff discussion and their resolution.
- Authorization by GitLab username, bot accounts, the admission table, and Tickets resumed by a person's note.
- Merge request binding, replies, merge or close detection, and terminal notices to non-GitLab conversations.

Not implemented:

- Inbound GitLab webhooks. Detection waits for the next poll. A comment that does not change the Issue or merge request `updated_at` in a way GitLab reports may wait for the next subscribed-Thread poll.
- GitLab To-Dos as a separate event stream; project Issue and merge request updates are the stream.
- Approvals, approval rules, merge trains and protected-branch policy. Prompts and repository instructions still govern who may approve or merge.
- Mapping one person between GitHub, GitLab and Feishu. Each Source's allowed list uses its own usernames.
- Automatic creation of the GitLab project, account, token or `glab` configuration. Those are operator steps.

## Prerequisites

- GitLab 15.10 or later is recommended because the Source uses `updated_after` on the project Issues and merge requests APIs. Older releases can still work if they ignore that parameter, but polling becomes more expensive.
- `glab` 1.40 or later, signed in to the self-hosted instance as the agent account.
- The agent account is a project member with the **Developer** role or higher.
- The project path, for example `platform/widgets`, and the instance host, for example `gitlab.example.com`. Do not include `https://` or a trailing path.

## Accounts

Create a dedicated GitLab account for the agent. Do not use a person's account: every note, branch and merge request appears under the account the CLI uses.

Create a `glab` configuration directory and sign in to the self-hosted instance:

```sh
mkdir -p ~/.config/glab-agent
cat > ~/.local/bin/glab-agent <<'SH'
#!/bin/sh
export GITLAB_HOST="gitlab.example.com"
export GLAB_CONFIG_DIR="$HOME/.config/glab-agent"
exec glab "$@"
SH
chmod +x ~/.local/bin/glab-agent
glab-agent auth login --hostname gitlab.example.com
glab-agent api --hostname gitlab.example.com user
```

The last command prints the agent's username. dsh-superagent reads the same endpoint, then reads the project to confirm the account can push. A token created for the account needs the `api`, `read_repository` and `write_repository` scopes; the Source never asks for the token itself.

Git also uses the wrapper. Setup writes a credential helper for `https://<host>` that calls `glab-agent auth git-credential`, so a clone or fetch over HTTPS acts as the same account. SSH remotes are rewritten to HTTPS for that host. The wrapper must not prompt interactively; `GIT_TERMINAL_PROMPT=0` is set for workers.

## Enable the Source

The bundle inserts `dsh-superagent-gitlab` disabled. Enable it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-superagent-gitlab
  name: dsh-superagent/gitlab-watch
  disabled: false
```

After `pnpm build` and a restart, **Settings → Sources** shows the GitLab card.

| Field | Meaning |
| --- | --- |
| `host` | Instance hostname, optionally with a port. No scheme, no path |
| `project` | Project path `namespace/project` |
| `cli` | Command name or absolute path of the `glab` wrapper |
| `useSsh` | Use the operating-system user's SSH key for Git operations; off by default. Confirm the SSH identity is the agent account |
| `observeIssues` | Receive new Issues that do not mention the agent; the admission table then decides candidacy |
| `observeMergeRequests` | Receive new merge requests that do not mention the agent |
| `observeComments` | Receive notes and discussions that do not mention the agent |
| `observePipelines` | Receive default-branch pipeline status changes |
| `allowSelfRequests` | Allow the agent account's explicit self-mentions to become requests; off by default |
| `pollSeconds` | Poll interval, 30 to 3600 seconds; default 60 |
| `failuresBeforeError` | Consecutive failed polls before the Source health turns `error`; default 3 |

A new Issue or merge request that mentions the agent is received even with every switch off. A note that mentions the agent is received the same way. With a switch on, the admission table decides whether an unaddressed event becomes an explicit request, an inferred candidate, or nothing.

## Policy and authorization

Under **Eval → On each Source → GitLab**, add the GitLab usernames that may originate work. The list is case-insensitive. Bot usernames may go in the bots list; their notes can only become inferred candidates.

The admission rows are:

| Row | Receives |
| --- | --- |
| `issues` | New Issues, observed only when `observeIssues` is on |
| `merge_requests` | New merge requests, observed only when `observeMergeRequests` is on |
| `comments` | Notes and discussions, observed only when `observeComments` is on |
| `pipelines` | Default-branch pipelines, observed only when `observePipelines` is on |

An allowed sender's mention is explicit in every mode. A follow-up on a Thread with a Ticket follows the usual rules in [002 Authorization](002-authorization.md): an allowed sender is explicit, anyone else is inferred, and inferred work needs `auto` mode and a matched rule. Pipeline triggers have no sender and use the last admission cell.

For a shared human/agent account, enable `allowSelfRequests`, add that username to the GitLab allowed list, and explicitly mention it in each request or follow-up. The first poll after enabling establishes the starting point: send requests only after that poll, and do not rely on older comments or edits to them. Host-generated replies carry a `dsh-superagent` marker and are ignored, as are unaddressed messages by that account. The account alone cannot distinguish a person from the worker: direct `glab` posts without the host marker that mention the shared account may be mistaken for a request. Workers must not mention their own account in posts. Use a separate agent account when this risk is unacceptable.

The Source listens only to the configured host and project. A Ticket whose Mandate records a different project or host stops listening, so its Mandate fails revalidation before it resumes. This prevents a later project change from silently redirecting an old Ticket.

## Events and deduplication

A poll round reads:

1. Project Issues updated since the Issues cursor, oldest first.
2. Project merge requests updated since the merge request cursor, oldest first.
3. Notes of each updated Issue, and discussions of each updated merge request.
4. Threads a Ticket subscribes to, including their notes, merge request state and pipeline.
5. Pipelines of open Tickets' merge requests, and the default branch when `observePipelines` is on.

Trigger IDs are stable:

- Issue: `gitlab-issue` with host, project and IID.
- Merge request: `gitlab-mr` with host, project and IID.
- Note: `gitlab-note` with host, project, Issue/MR, IID, note ID and its `updated_at`.
- Pipeline: `gitlab-pipeline` with project, pipeline ID and status.

`Engine.receive` records duplicates and creates no second Ticket. A poll interrupted before its cursor advances re-reads the same items safely. Cursors are kept in `KV.gitlab.stream`; the Source does not advance a cursor until the items it covers were handed to `receive`.

The agent's own notes are filtered before intake unless `allowSelfRequests` accepts an explicit self-mention; system notes are filtered. A bot is marked `human: false` from GitLab's `bot` flag or a username ending in `-bot`/`_bot`.

## Replying and merge request tracking

Replies go through the GitLab Channel. A note carries an HTML marker, `<!-- dsh-superagent:<message id> -->`; before posting, the Channel reads the same conversation or discussion and reuses an existing marked note. A retry therefore cannot duplicate a reply. A discussion reply uses `POST .../merge_requests/<iid>/discussions/<discussion-id>/notes`, not a new top-level note.

`sendGitlab` returns `gone` for a locked/forbidden target, or for a 404 while the project itself is still readable. A 404 from the project is retried, because it can mean temporary loss of access to a private project.

A merge request binds to a Ticket in either of two ways:

- It is the merge request that started the Ticket (the Ticket's origin Trigger has that IID).
- The agent opened it from a branch whose last path segment is the Ticket's `DSH_SUPERAGENT_NAME`.

Binding follows the merge request's Thread `gitlab:mr:<iid>`; a merge or close reports the close to the Engine and the Ticket ends by the ordinary rules. A merge request cannot belong to two open Tickets. The report tool's `pr_number` field carries the merge request IID for GitLab Tickets.

When a Ticket ends merged or closed, `mergeRequestEndNotices` sends one terminal notice to its non-GitLab conversations, such as a Feishu thread. The GitLab merge request itself already shows the outcome, so it receives no duplicate notice.

## Working directory

The prepare command receives the GitLab environment and can create a worktree per Ticket:

```sh
git -C /home/me/src/widgets fetch --no-tags "https://$DSH_SUPERAGENT_GITLAB_HOST/$DSH_SUPERAGENT_GITLAB_PROJECT.git" \
  "${DSH_SUPERAGENT_GITLAB_MR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" \
  "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

The Source declares these variables:

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_GITLAB_HOST` | Instance hostname |
| `DSH_SUPERAGENT_GITLAB_PROJECT` | Canonical project path |
| `DSH_SUPERAGENT_GITLAB_ACCOUNT` | Agent username |
| `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL` | `<username>@users.noreply.<host>` |
| `DSH_SUPERAGENT_GITLAB_ISSUE_IID` | Origin Issue IID, or empty |
| `DSH_SUPERAGENT_GITLAB_MR_IID` | Origin or reported merge request IID, or empty |
| `DSH_SUPERAGENT_GITLAB_MR_HEAD` | `refs/merge-requests/<iid>/head`, or empty |

Workers use `glab`, not a personal token or `curl`. The worker preset shims `glab` to the configured wrapper; by default GitLab SSH URLs are rewritten to HTTPS. The git configuration has no commit identity: the worker sets the author from the Delivery requirements prompt section or from the agent account and its commit email.

When `useSsh` is enabled, GitLab HTTPS URLs are instead rewritten to SSH for fetch and push. The worker uses the operating-system user's SSH keys and configuration, not the `glab` credential helper; verify the SSH identity belongs to the intended GitLab agent. The GitLab API still uses the `glab` wrapper.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `The GitLab Source names no instance host.` | Set `host` on the GitLab card |
| `The GitLab Source names no project.` | Set `project` on the GitLab card |
| `The agent GitLab CLI is not set.` | Set `cli` to the wrapper |
| `The agent GitLab CLI was not found.` | Use an absolute path or a command on `PATH` |
| `The agent GitLab CLI cannot read its account on …` | Run `glab-agent auth login --hostname …` and check the token scopes |
| `@… cannot read …` | Add the account to the project with at least Reporter |
| `@… cannot push to …; a Developer role or higher is required.` | Raise the project role to Developer or higher |
| A Source health error names a failed GitLab read | Run the same `glab api --hostname …` command as the operator; the detail is the CLI's own message |
| A mention added by editing an old Issue description is not received | Post a new note mentioning the agent; the Source tracks Issue creation and notes, not later body edits |
| No pipeline notices | Enable `observePipelines` for the default branch; a subscribed merge request tracks its own pipeline without that switch |

Never paste a token into the panel, a prompt or a Ticket. The Source and the workers read no credential: the wrapper owns it.
