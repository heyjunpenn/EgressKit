# Issue tracker: GitHub

Issues and specs for this repository live in the GitHub Issues tracker for
`heyjunpenn/EgressKit`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: use `gh issue list` with the appropriate `--label`, `--state`,
  and JSON fields.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**:
  `gh issue edit <number> --add-label "..."` or
  `gh issue edit <number> --remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; when commands run inside this clone,
`gh` resolves `heyjunpenn/EgressKit` automatically.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Set this to `yes` only if the repository later decides to treat external pull
requests as feature requests.

When enabled, PRs use the corresponding `gh pr` commands. External PR triage
keeps authors with an association of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
or `NONE`, and excludes `OWNER`, `MEMBER`, and `COLLABORATOR`.

GitHub shares one number space across Issues and pull requests. If a bare
reference such as `#42` is ambiguous, try `gh pr view 42` and then fall back to
`gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create an Issue in `heyjunpenn/EgressKit`.

## When a skill says “fetch the relevant ticket”

Run:

`gh issue view <number> --comments`

## Blocking relationships

Use GitHub native Issue dependencies when available.

To add a blocker, resolve the blocker’s numeric database ID:

`gh api repos/heyjunpenn/EgressKit/issues/<blocker> --jq .id`

Then add the dependency:

`gh api --method POST repos/heyjunpenn/EgressKit/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-database-id>`

The database ID is not the visible Issue number and not the GraphQL node ID.

If native dependencies are unavailable, add a `Blocked by` section containing
references such as `#12` to the blocked Issue’s body. A ticket is unblocked only
after every referenced blocker is closed.

## Frontier

The frontier consists of open, unassigned Issues whose blockers are all closed.

When selecting the next ticket:

1. List open Issues.
2. Exclude Issues with open blockers.
3. Exclude Issues already assigned.
4. Follow the dependency order encoded by the tracker.
5. Claim the selected Issue by assigning it to the current GitHub user.
