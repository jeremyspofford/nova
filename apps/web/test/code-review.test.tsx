import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReviewFindingView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { emitCode, openSession } from './code-helpers.tsx';
import { codeChange } from './fakes-m5-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const SID = 'cs-review';

const finding = (over: Partial<ReviewFindingView>): ReviewFindingView => ({
  id: `f-${over.title ?? 'x'}`,
  path: 'src/total.ts',
  line: 2,
  severity: 'warn',
  title: 'Magic number',
  reasoning: 'The 3 has no name.',
  fix: null,
  ...over,
});

const FINDINGS = [
  finding({ title: 'Off by one', severity: 'error', line: 2, fix: 'const total = sum(1, 2);' }),
  finding({ title: 'Magic number', severity: 'warn', line: 2 }),
  finding({
    title: 'Missing docs',
    severity: 'info',
    path: 'README.md',
    line: null,
    fix: 'Add a usage section.',
  }),
];

describe('Code review card (FR-069)', () => {
  it('runs a review and groups the findings by file with severity in words', async () => {
    const { hub, s } = await openSession(
      { id: SID },
      {
        code: {
          changes: [codeChange(SID, { id: 'ch-total' })],
          nextReview: { status: 'done', findings: FINDINGS },
        },
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(hub.api.startReview).toHaveBeenCalledWith(SID));
    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true');
    const card = await screen.findByRole('article', { name: 'Code review' });
    expect(within(card).getByText('3 findings: 1 error, 1 warning, 1 note.')).toBeTruthy();
    const files = within(card)
      .getAllByRole('heading', { level: 4 })
      .map((h) => h.textContent);
    expect(files).toEqual(['src/total.ts', 'README.md']);
    const total = within(card).getByRole('region', { name: 'src/total.ts' });
    const items = within(total).getAllByRole('listitem');
    expect(items[0]!.textContent).toMatch(/Error.*Off by one.*Line 2/);
    expect(items[1]!.textContent).toMatch(/Warning.*Magic number/);
    expect(within(items[1]!).getByText('The 3 has no name.')).toBeTruthy();
    expect(within(items[1]!).queryByRole('button', { name: /Apply fix/ })).toBeNull();

    // Findings also show in the diff at their line.
    await userEvent.click(screen.getByRole('tab', { name: 'Diff (1)' }));
    const diff = screen.getByRole('region', { name: 'Diff' });
    expect(within(diff).getByText('Off by one')).toBeTruthy();
    expect(within(diff).getAllByText(/Review Error/)).toHaveLength(1);

    // Apply fix on a changed line goes back to the agent as a comment there.
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Apply fix: Off by one' }));
    await waitFor(() =>
      expect(hub.api.addComments).toHaveBeenCalledWith(SID, {
        comments: [
          {
            changeId: 'ch-total',
            line: 2,
            side: 'new',
            body: 'Apply the fix the code review suggested for “Off by one”:\n\n```\nconst total = sum(1, 2);\n```',
          },
        ],
        submit: true,
      }),
    );
    expect(
      await within(card).findByRole('button', { name: 'Fix sent: Off by one' }),
    ).toHaveProperty('disabled', true);
    // A finding on a file without a change goes to the session's thread as a message.
    await userEvent.click(within(card).getByRole('button', { name: 'Apply fix: Missing docs' }));
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(s.threadId, {
        text: 'README.md: Apply the fix the code review suggested for “Missing docs”:\n\n```\nAdd a usage section.\n```',
      }),
    );
  });

  it('waits for a running review, says when there are no findings, and reports failures', async () => {
    const { hub } = await openSession(
      { id: SID },
      { code: { nextReview: { status: 'running', findings: [] } } },
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('heading', { name: 'No review yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText('Reviewing the changes…')).toBeTruthy();
    // The Hub finishes it; the completion event (or the poll) picks it up.
    const r = hub.state.m5code.reviews[0]!;
    hub.state.m5code.reviews = [{ ...r, status: 'done', findings: [] }];
    emitCode('code.review.completed', { sessionId: SID, findings: 0 });
    expect(await screen.findByText('No findings.')).toBeTruthy();

    hub.state.failNext.startReview = new ApiError(409, {
      code: 'capability_missing',
      message: 'No model is available for review',
      retryable: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    expect(await screen.findByText('No model is available for review')).toBeTruthy();
    hub.state.m5code.nextReview = { status: 'failed', findings: [] };
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    expect(await screen.findByText(/The review failed/)).toBeTruthy();
  });

  it('polls a running review until it is done', async () => {
    const { hub } = await openSession(
      { id: SID },
      { code: { nextReview: { status: 'running', findings: [] } } },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByText('Reviewing the changes…');
    const r = hub.state.m5code.reviews[0]!;
    hub.state.m5code.reviews = [{ ...r, status: 'done', findings: [finding({})] }];
    expect(await screen.findByText('1 finding: 1 warning.')).toBeTruthy();
    expect(hub.api.getReview).toHaveBeenCalledWith(SID, r.id);
  });
});

describe('Commit dialog (FR-070, FR-211)', () => {
  it('commits on the current branch, accepting pending changes, and says when hooks did not run', async () => {
    const { hub, s } = await openSession(
      { id: SID, repo: { root: '/home/me/app', branch: 'feature/x', head: 'abc', dirty: true } },
      {
        code: {
          changes: [codeChange(SID)],
          commitExtra: { hooksRan: false },
        },
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Commit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' });
    expect(within(dialog).getByText('Commits to feature/x.')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'New branch' })).toBeNull();
    const commit = within(dialog).getByRole('button', { name: 'Commit' });
    expect(commit).toHaveProperty('disabled', true);
    const pending = within(dialog).getByRole('checkbox', {
      name: 'Accept the pending changes and include them',
    });
    expect(pending).toHaveProperty('checked', true);
    expect(within(dialog).getByText(/1 hunk still waits for a decision/)).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole('textbox', { name: 'Commit message' }),
    );
    await userEvent.type(document.activeElement as HTMLElement, 'Fix the total');
    await userEvent.click(commit);
    await waitFor(() =>
      expect(hub.api.commit).toHaveBeenCalledWith(s.id, {
        message: 'Fix the total',
        acceptPending: true,
      }),
    );
    const done = await screen.findByRole('dialog', { name: 'Committed' });
    expect(within(done).getByText(/Committed 1 file to feature\/x as/)).toBeTruthy();
    expect(within(done).getByText('9f8e7d6')).toBeTruthy();
    expect(within(done).getByText(/hooks did not run for this commit/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(done).getByRole('button', { name: 'Done' })),
    );
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The header follows the commit: no uncommitted changes now.
    await waitFor(() => expect(screen.getByText('feature/x')).toBeTruthy());
  });

  it('moves a commit on the default branch to a suggested nova/ branch', async () => {
    const { hub, s } = await openSession({
      id: SID,
      repo: { root: '/home/me/app', branch: 'main', head: 'abc', dirty: true },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Commit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' });
    expect(within(dialog).getByText(/You are on main, the default branch/)).toBeTruthy();
    const branch = within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'New branch' });
    expect(branch.value).toBe('nova/fix-the-flaky-test');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Commit message' }),
      'Handle empty input',
    );
    expect(branch.value).toBe('nova/handle-empty-input');
    // The default branch itself is refused.
    await userEvent.clear(branch);
    await userEvent.type(branch, 'main');
    expect(within(dialog).getByText('Choose a branch other than main.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Commit' })).toHaveProperty('disabled', true);
    await userEvent.clear(branch);
    await userEvent.type(branch, 'nova/empty-input');
    hub.state.failNext.commit = new ApiError(409, {
      code: 'conflict',
      message: 'Secrets found in the staged changes',
      retryable: false,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    expect(await within(dialog).findByText('Secrets found in the staged changes')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    await waitFor(() =>
      expect(hub.api.commit).toHaveBeenLastCalledWith(s.id, {
        message: 'Handle empty input',
        branch: 'nova/empty-input',
      }),
    );
    const done = await screen.findByRole('dialog', { name: 'Committed' });
    expect(within(done).getByText(/to nova\/empty-input as/)).toBeTruthy();
    expect(within(done).queryByText(/hooks did not run/)).toBeNull();
  });

  it('offers no commit outside a Git repository', async () => {
    await openSession({ id: SID, repo: null });
    expect(screen.getByRole('button', { name: 'Commit…' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Not a Git repository')).toBeTruthy();
  });
});
