import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from 'styled-components';

import MigrateToYml from './index';
// The real theme: a hand-rolled partial breaks the moment a styled component in
// this tree reads a key the mock forgot.
import themes from 'themes/index';

const theme = themes.light;

const BRU_COLLECTION = {
  uid: 'collection-uid',
  name: 'GSB Sample',
  pathname: '/tmp/gsb-sample',
  format: 'bru'
};

const renderComponent = (collection = BRU_COLLECTION) =>
  render(
    <ThemeProvider theme={theme}>
      <MigrateToYml collection={collection} />
    </ThemeProvider>
  );

describe('MigrateToYml', () => {
  let ipcListeners;
  let invoke;

  beforeEach(() => {
    ipcListeners = {};
    invoke = jest.fn().mockResolvedValue({ status: 'migrated', converted: 6, total: 6, notTrashed: [] });
    window.ipcRenderer = {
      invoke,
      on: (channel, handler) => {
        ipcListeners[channel] = handler;
        return () => delete ipcListeners[channel];
      }
    };
  });

  afterEach(() => {
    delete window.ipcRenderer;
  });

  it('is not offered on a collection that is already yml', () => {
    const { container } = renderComponent({ ...BRU_COLLECTION, format: 'yml' });
    expect(container).toBeEmptyDOMElement();
  });

  // This is a rare, deliberate, whole-collection rewrite. It must not sit in
  // the Overview tab as a button anyone can hit while reading.
  it('keeps the action behind a collapsed Advanced section', async () => {
    renderComponent();

    expect(screen.queryByTestId('migrate-collection-to-yml-btn')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));

    expect(screen.getByTestId('migrate-collection-to-yml-btn')).toBeInTheDocument();
  });

  it('does not start anything until the confirmation is accepted', async () => {
    renderComponent();

    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));

    // the confirmation names what happens and where the originals end up
    const modal = screen.getByTestId('migrate-collection-to-yml-modal');
    expect(modal).toHaveTextContent('GSB Sample');
    expect(modal).toHaveTextContent(/Write a .*\.yml.* copy next to each original/i);
    expect(modal).toHaveTextContent(/Nothing is removed at this stage/i);
    expect(modal).toHaveTextContent(/compare it to the original/i);
    expect(modal).toHaveTextContent(/Gridman.s Trash/i);
    expect(modal).toHaveTextContent(/not deleted/i);
    expect(modal).toHaveTextContent(/restore any of them from the Trash panel/i);

    // nothing has been invoked while the confirmation is up
    expect(invoke).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls[0][0]).toBe('renderer:migrate-collection-to-yml');
    expect(invoke.mock.calls[0][1]).toMatchObject({
      collectionPathname: BRU_COLLECTION.pathname,
      collectionUid: BRU_COLLECTION.uid
    });
    expect(invoke.mock.calls[0][1].migrationUid).toBeTruthy();
  });

  it('renders progress for its own migration and can cancel while converting', async () => {
    let resolveMigration;
    invoke = jest.fn((channel) => {
      if (channel === 'renderer:migrate-collection-to-yml') {
        return new Promise((resolve) => {
          resolveMigration = resolve;
        });
      }
      return Promise.resolve(true);
    });
    window.ipcRenderer.invoke = invoke;

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const { migrationUid } = invoke.mock.calls[0][1];

    act(() => {
      ipcListeners['main:collection-yml-migration-progress']({
        migrationUid,
        phase: 'converting',
        processed: 3,
        total: 12,
        relativePath: 'پوشهٔ فارسی/درخواست.bru'
      });
    });

    expect(screen.getByTestId('migrate-collection-to-yml-progress')).toHaveTextContent('Converting and verifying 3 of 12');
    expect(screen.getByText('پوشهٔ فارسی/درخواست.bru')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-cancel-btn'));
    expect(invoke).toHaveBeenCalledWith('renderer:cancel-collection-yml-migration', { migrationUid });

    // ...but once the commit starts, cancelling is refused
    act(() => {
      ipcListeners['main:collection-yml-migration-progress']({
        migrationUid,
        phase: 'committing',
        processed: 12,
        total: 12
      });
    });
    expect(screen.getByTestId('migrate-collection-to-yml-cancel-btn')).toBeDisabled();

    await act(async () => {
      resolveMigration({ status: 'cancelled', converted: 0, total: 12 });
    });
  });

  it('ignores progress belonging to another migration', async () => {
    let resolveMigration;
    window.ipcRenderer.invoke = jest.fn(() => new Promise((resolve) => {
      resolveMigration = resolve;
    }));

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    await waitFor(() => expect(window.ipcRenderer.invoke).toHaveBeenCalled());

    act(() => {
      ipcListeners['main:collection-yml-migration-progress']({
        migrationUid: 'someone-elses-migration',
        phase: 'converting',
        processed: 9,
        total: 9,
        relativePath: 'not-ours.bru'
      });
    });

    expect(screen.queryByText('not-ours.bru')).not.toBeInTheDocument();

    await act(async () => {
      resolveMigration({ status: 'cancelled', converted: 0, total: 9 });
    });
  });

  it('reports an abort with the file and the differences that caused it', async () => {
    window.ipcRenderer.invoke = jest.fn().mockResolvedValue({
      status: 'aborted',
      converted: 0,
      total: 6,
      failedRelativePath: 'auth/token.bru',
      reason: '"auth/token.bru" does not survive the conversion: request.auth (…)',
      differences: [{ path: 'request.auth', expected: '{"basic":{"password":"do-not-lose-me"}}', actual: 'absent' }]
    });

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const aborted = await screen.findByTestId('migrate-collection-to-yml-aborted');
    expect(aborted).toHaveTextContent('the collection is untouched');
    expect(aborted).toHaveTextContent('auth/token.bru');
    expect(aborted).toHaveTextContent('request.auth');
    expect(aborted).toHaveTextContent('do-not-lose-me');
  });

  // The migration reports rollbackFailures for exactly one reason: to let the
  // UI withdraw "the collection is untouched" when it is not true. Printing the
  // claim anyway leaves .yml files in a collection the user believes is
  // unchanged — and the next attempt refuses on them.
  it('withdraws the untouched claim when the rollback could not remove every copy', async () => {
    window.ipcRenderer.invoke = jest.fn().mockResolvedValue({
      status: 'aborted',
      converted: 0,
      total: 6,
      reason: '"auth/token.bru" does not survive the conversion',
      rollbackFailures: [
        { pathname: '/tmp/gsb-sample/auth/token.yml', message: 'EPERM: operation not permitted, unlink' }
      ]
    });

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const aborted = await screen.findByTestId('migrate-collection-to-yml-aborted');
    expect(aborted).not.toHaveTextContent('the collection is untouched');
    // it names the file that is still there, where it is, and why
    const leftovers = screen.getByTestId('migrate-collection-to-yml-rollback-failures');
    expect(leftovers).toHaveTextContent('/tmp/gsb-sample/auth/token.yml');
    expect(leftovers).toHaveTextContent('EPERM');
    expect(leftovers).toHaveTextContent(/delete these by hand/i);
  });

  it('withdraws the untouched claim on a cancel whose rollback failed too', async () => {
    window.ipcRenderer.invoke = jest.fn().mockResolvedValue({
      status: 'cancelled',
      converted: 0,
      total: 6,
      rollbackFailures: [{ pathname: '/tmp/gsb-sample/locked.yml', message: 'EBUSY: resource busy or locked' }]
    });

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const cancelled = await screen.findByTestId('migrate-collection-to-yml-cancelled');
    expect(cancelled).not.toHaveTextContent('the collection is untouched');
    expect(screen.getByTestId('migrate-collection-to-yml-rollback-failures')).toHaveTextContent(
      '/tmp/gsb-sample/locked.yml'
    );
    expect(screen.getByTestId('migrate-collection-to-yml-rollback-failures')).toHaveTextContent('EBUSY');
  });

  // ...and the claim is still made when it IS true, so the fix above is not
  // just "delete the sentence".
  it('still reports an untouched collection when the rollback succeeded', async () => {
    window.ipcRenderer.invoke = jest.fn().mockResolvedValue({
      status: 'cancelled',
      converted: 0,
      total: 6,
      rollbackFailures: []
    });

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const cancelled = await screen.findByTestId('migrate-collection-to-yml-cancelled');
    expect(cancelled).toHaveTextContent('the collection is untouched');
    expect(screen.queryByTestId('migrate-collection-to-yml-rollback-failures')).not.toBeInTheDocument();
  });

  // One of these per file is possible — a read-only tree, a share that went
  // away mid-commit — and this panel lives in the settings tab of a collection
  // with 11,000 files in it.
  it('counts the files it does not list instead of rendering thousands of rows', async () => {
    const notTrashed = Array.from({ length: 25 }, (_unused, index) => ({
      pathname: `/tmp/gsb-sample/locked-${index}.bru`,
      message: 'EBUSY'
    }));
    window.ipcRenderer.invoke = jest.fn().mockResolvedValue({
      status: 'migrated',
      converted: 60,
      total: 60,
      notTrashed
    });

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const done = await screen.findByTestId('migrate-collection-to-yml-done');
    expect(done).toHaveTextContent('/tmp/gsb-sample/locked-0.bru');
    expect(done).toHaveTextContent('/tmp/gsb-sample/locked-19.bru');
    expect(done).not.toHaveTextContent('/tmp/gsb-sample/locked-20.bru');
    expect(done).toHaveTextContent('and 5 more');
    // the count itself is never truncated
    expect(done).toHaveTextContent(/25 original files could not be moved to Trash/i);
  });

  it('tells the user where the originals went and that a reopen is needed', async () => {
    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const done = await screen.findByTestId('migrate-collection-to-yml-done');
    expect(done).toHaveTextContent('Converted 6 files');
    expect(done).toHaveTextContent(/originals are in Trash/i);
    expect(done).toHaveTextContent(/Reopen this collection/i);
  });

  // A failed move does NOT prove the original is still where it was: app-trash
  // copies before it removes, and a removal that fails half way leaves the copy
  // in Trash as the only complete one (movePathWithRetry's partiallyMovedError,
  // sourceIntact: false). Telling the user those files are "still on disk next
  // to their .yml replacements" points them at the truncated one and away from
  // the good copy.
  it('warns about originals that could not be moved to Trash without guessing where they are', async () => {
    window.ipcRenderer.invoke = jest.fn().mockResolvedValue({
      status: 'migrated',
      converted: 6,
      total: 6,
      notTrashed: [
        {
          pathname: '/tmp/gsb-sample/locked.bru',
          message:
            '"locked.bru" was copied to "/trash/payload/locked.bru", but the original could not be removed '
            + '(it is open in another program) and is now incomplete. The copy has been kept — do not delete it.'
        }
      ]
    });

    renderComponent();
    await userEvent.click(screen.getByTestId('collection-settings-advanced-toggle'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-btn'));
    await userEvent.click(screen.getByTestId('migrate-collection-to-yml-modal-submit-btn'));

    const done = await screen.findByTestId('migrate-collection-to-yml-done');
    expect(done).toHaveTextContent(/1 original file could not be moved to Trash/i);
    expect(done).toHaveTextContent(/Nothing was lost/i);
    // the claim that cannot be made
    expect(done).not.toHaveTextContent(/still on disk next to their .yml replacements/i);
    expect(done).not.toHaveTextContent(/remove them by hand when you can/i);
    // what is said instead: the file, and the reason, which is the only thing
    // that distinguishes "still in the collection" from "only copy is in Trash"
    expect(done).toHaveTextContent('/tmp/gsb-sample/locked.bru');
    expect(done).toHaveTextContent(/do not delete it/i);
    expect(done).toHaveTextContent(/do not delete anything before reading these/i);
  });
});
