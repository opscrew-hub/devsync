# Fixing a security finding

How DevSync turns one of the dashboard's security findings into a task (story 5, R-10). The host's
side is `ModuleHost.finding` and the manifest's `findingAction` (see [host.md](host.md), "Security
findings").

## The flow

1. The dashboard shows **Fix with DevSync** in a security finding's details when DevSync is on for
   the project, also on a finding marked "Not a problem". The button opens the project's DevSync tab
   with `?finding=<fingerprint>`.
2. The tab reads the finding through DevSync's own route, `GET /findings?fingerprint=`, which checks
   the fingerprint's format (1–128 characters of `A–Z a–z 0–9 . _ : / -`), calls `host.finding` and
   parses its answer. The host gives the finding already redacted and cut to its limits, never the
   match itself; a resolved finding, or another project's, answers null: "This finding is resolved or
   isn't this project's. Open it again from the project's security findings."
3. The route also answers the task already linked to the finding: the one created from the same
   fingerprint, else an open task (not Done) created from a finding with the same rule and file,
   since the fingerprint includes the line and changes when code above it moves.
4. With a linked task, the tab opens it. Without one, it opens **New task** prefilled:
   - title: "Fix: " and the finding's title, cut to DevSync's title limit;
   - description: the finding's description, where it is (`file:line`), its severity and rule, and
     its remediation;
   - acceptance criteria: "The next security scan no longer reports <rule> at <file>."

   A finding marked "Not a problem" shows that above the form (false positive or accepted risk).
   The person edits the text and creates the task, or closes the dialog.
5. Creating it sends the fingerprint with the task. The server reads the finding again through
   `host.finding` (it never trusts the browser's copy of the rule or file) and stores the
   fingerprint, rule and file on the task. Members who may not write tasks see the finding and a
   disabled **Create**, as everywhere else.

From there the task follows DevSync's usual flow: Ready, claimed by an agent, or a managed run whose
exact text an Approver approves.

## Not in the first version

- Marking a task fixed when a scan no longer reports its finding: it needs a "finding resolved" fact
  from the host, which the dashboard may add later.

## Tasks

- [x] **F1, the finding's task** (`packages/**`, `package.json`'s `opscrewModule`, `docs/host.md`,
  `docs/requirements.md`'s Data, `README.md`). The manifest's
  `"findingAction": { "label": "Fix with DevSync" }`; the host interface's copy: `finding` and its
  `Finding` type (the dashboard's `ModuleFinding`), `fakeHost()`'s findings; the task table's
  `finding_fingerprint`, `finding_rule`, `finding_file` (nullable; a migration); `Finding` and the
  route's answer in `@devsync/schemas`; `GET /findings?fingerprint=` (any member; 400 for a bad
  fingerprint before calling the host; 404 with the text above for null), the linked task as in step
  3; `TaskInput`'s optional `finding: { fingerprint }`, re-read on create (404 when gone); the
  project tab's `?finding=` handling as in step 4, clearing `finding` from the address once the task
  is open or the dialog closed; tests for each rule above. Built on the branch `finding-action`,
  merged to `main` only once the dashboard's side is deployed.
