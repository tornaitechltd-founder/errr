import { test, expect, expectStatus } from '../../support/fixtures.js';
import { createRecording } from '../../support/recordings.js';
import { ACCOUNT_SETTINGS, loginViaUi } from '../../support/ui.js';

/**
 * The browser half of the trash bin. `recording/trash.api.spec.js` already
 * pins the endpoints, so this file only asserts what the API cannot:
 *
 * - the retention countdown, which is pure client arithmetic in `Trash.jsx`
 *   (`daysRemaining` over `deletedAt`, `RETENTION_DAYS = 30`). The server
 *   never sends a "days left" figure, so nothing else in the suite can catch
 *   an off-by-one or a broken pluralisation here.
 * - the two confirmation gates. Neither uses `window.confirm` - "delete
 *   forever" is component state (`confirmingForeverId`) rendered as an inline
 *   Confirm/Cancel pair, and "empty trash" is a Modal (`role="dialog"`).
 *   `answerDialog` would therefore hang, and Playwright's default
 *   auto-dismissal would have hidden a broken gate rather than failing.
 */

const GROUP = 'E2E trash';
const EMPTY_STATE = 'Trash is empty. Deleted recordings will appear here.';
const TRASH_PATH = '/api/v1/recordings/trash';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What the dashboard's delete button does: create, then soft-delete (204, no body). */
async function trashRecording(api, title) {
    const { id } = await createRecording(api, GROUP, title);
    await expectStatus(await api.delete(`/api/v1/recordings/${id}`), 204);
    return id;
}

/** The `<li>` for one trashed recording. The list is the only `<ul>` on the page. */
const rowFor = (page, title) => page.locator('li').filter({ hasText: title });

async function openTrash(page, email, password) {
    await expectStatus(await loginViaUi(page, email, password), 200);
    // Settle on the dashboard before navigating away, so the SPA's post-login
    // redirect cannot race the goto below.
    await expect(page.locator('nav').locator(ACCOUNT_SETTINGS)).toBeVisible();
    await page.goto('/trash');
    await expect(page.getByRole('heading', { name: 'Trash', level: 1 })).toBeVisible();
}

test.describe('Recordings > Trash (browser)', () => {
    test('tells a user with nothing deleted that the bin is empty', async ({
                                                                               page,
                                                                               createAccount,
                                                                           }) => {
        const { email, password } = await createAccount('trash');

        await openTrash(page, email, password);

        await expect(page.getByText(EMPTY_STATE)).toBeVisible();
        await expect(page.locator('li')).toHaveCount(0);
        // The banner is where RETENTION_DAYS surfaces to the user, and the
        // component's own docs require it to stay in step with the privacy
        // policy and TrashAutoPurgeJob - so assert the number, not the prose.
        await expect(page.locator('strong')).toHaveText('30 days');
        await expect(page.getByText(/kept here for 30 days, then permanently erased/)).toBeVisible();
        // No bulk action offered when there is nothing to erase.
        await expect(page.getByRole('button', { name: 'Empty trash' })).toHaveCount(0);
    });

    test('lists a soft-deleted recording and counts it in the header', async ({
                                                                                  page,
                                                                                  createAccount,
                                                                              }) => {
        const { email, password, api } = await createAccount('trash');
        await trashRecording(api, 'Quarterly planning call');

        await openTrash(page, email, password);

        await expect(
            page.getByRole('heading', { name: '1 recording in trash', level: 2 }),
        ).toBeVisible();

        const row = rowFor(page, 'Quarterly planning call');
        await expect(row).toHaveCount(1);
        await expect(row.getByText('Quarterly planning call', { exact: true })).toBeVisible();
        await expect(row.getByText(`Group: ${GROUP}`, { exact: true })).toBeVisible();
        // formatDeletedAt renders a locale timestamp, so only the label is
        // safe to assert - the value depends on the browser's locale and TZ.
        await expect(row.getByText(/^Deleted: \S/)).toBeVisible();
        await expect(row.getByRole('button', { name: 'Restore' })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Delete forever' })).toBeVisible();

        // The count and its pluralisation are rendered, not fetched.
        await trashRecording(api, 'Vendor sync');
        await page.reload();
        await expect(
            page.getByRole('heading', { name: '2 recordings in trash', level: 2 }),
        ).toBeVisible();
    });

    test('restores a recording back onto the dashboard and out of the bin', async ({
                                                                                       page,
                                                                                       createAccount,
                                                                                   }) => {
        const { email, password, api } = await createAccount('trash');
        await trashRecording(api, 'Design review');

        await openTrash(page, email, password);
        const row = rowFor(page, 'Design review');
        await expect(row).toHaveCount(1);

        const restored = page.waitForResponse(
            (res) =>
                /\/api\/v1\/recordings\/[^/]+\/restore$/.test(res.url()) &&
                res.request().method() === 'POST',
        );

        await row.getByRole('button', { name: 'Restore' }).click();
        expect((await restored).status()).toBe(200);

        // Side one: gone from trash, which is the cache invalidation working.
        await expect(page.getByText(EMPTY_STATE)).toBeVisible();
        await expect(rowFor(page, 'Design review')).toHaveCount(0);

        // Side two: back on the dashboard. RecordingCard renders the title as
        // a link to the recording.
        await page.goto('/dashboard');
        await expect(page.getByRole('link', { name: 'Design review' })).toBeVisible();
    });

    test('erases a recording forever only after a second confirmation', async ({
                                                                                   page,
                                                                                   createAccount,
                                                                               }) => {
        const { email, password, api } = await createAccount('trash');
        await trashRecording(api, 'Budget walkthrough');

        await openTrash(page, email, password);
        const row = rowFor(page, 'Budget walkthrough');

        // Stage one swaps the button for a Confirm/Cancel pair. It is local
        // state only - no request, and nothing erased.
        await row.getByRole('button', { name: 'Delete forever' }).click();
        await expect(row.getByRole('button', { name: 'Confirm' })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Delete forever' })).toHaveCount(0);
        await expect(row.getByText('Budget walkthrough', { exact: true })).toBeVisible();

        // Cancel has to be a real escape hatch, not a second confirm.
        await row.getByRole('button', { name: 'Cancel' }).click();
        await expect(row.getByRole('button', { name: 'Delete forever' })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Confirm' })).toHaveCount(0);

        await row.getByRole('button', { name: 'Delete forever' }).click();
        const erased = page.waitForResponse(
            (res) =>
                /\/api\/v1\/recordings\/[^/]+\/forever$/.test(res.url()) &&
                res.request().method() === 'DELETE',
        );

        await row.getByRole('button', { name: 'Confirm' }).click();
        expect((await erased).status()).toBe(204);

        await expect(page.getByText(EMPTY_STATE)).toBeVisible();

        // Re-read from the server: an optimistic list that never refetched
        // would also look empty until the next load.
        await page.reload();
        await expect(page.getByText(EMPTY_STATE)).toBeVisible();
        await expect(rowFor(page, 'Budget walkthrough')).toHaveCount(0);
    });

    test('empties the whole bin after a dialog that quotes the count', async ({
                                                                                  page,
                                                                                  createAccount,
                                                                              }) => {
        const { email, password, api } = await createAccount('trash');
        await trashRecording(api, 'Onboarding kickoff');
        await trashRecording(api, 'Retro notes');

        await openTrash(page, email, password);
        await expect(
            page.getByRole('heading', { name: '2 recordings in trash', level: 2 }),
        ).toBeVisible();

        // The Modal renders outside <main>, so scoping the trigger this way
        // keeps it unambiguous once the panel adds a second "Empty trash".
        await page.locator('main').getByRole('button', { name: 'Empty trash?' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'Empty trash' })).toBeVisible();
        // Tolerant on the whitespace around the plural "s" only, because that
        // suffix sits on its own JSX line; the count itself is asserted exactly.
        await expect(
            dialog.getByText(/This will permanently erase 2 recording\s*s\. This cannot be undone\./),
        ).toBeVisible();

        const emptied = page.waitForResponse(
            (res) => res.url().endsWith(TRASH_PATH) && res.request().method() === 'DELETE',
        );

        await dialog.getByRole('button', { name: 'Empty trash' }).click();
        expect((await emptied).status()).toBe(200);

        await expect(dialog).toHaveCount(0);
        await expect(page.getByText(EMPTY_STATE)).toBeVisible();
        await expect(page.locator('li')).toHaveCount(0);
    });

    test('counts down the full retention window on a just-deleted recording', async ({
                                                                                         page,
                                                                                         createAccount,
                                                                                     }) => {
        const { email, password, api } = await createAccount('trash');
        await trashRecording(api, 'Partner briefing');

        await openTrash(page, email, password);

        // daysRemaining(now) === RETENTION_DAYS, and the server sends no such
        // field - this number exists nowhere but the browser.
        const countdown = rowFor(page, 'Partner briefing').getByText('30 days left', {
            exact: true,
        });

        await expect(countdown).toBeVisible();
        await expect(countdown).toHaveClass(/text-gray-500/);
        await expect(countdown).not.toHaveClass(/text-red-600/);
    });

    test('turns the countdown red as the retention window runs out', async ({
                                                                                page,
                                                                                createAccount,
                                                                            }) => {
        const { email, password, api } = await createAccount('trash');
        await trashRecording(api, 'Legacy migration call');
        await trashRecording(api, 'Archived standup');

        // Nothing in the API can backdate a soft delete, so ageing `deletedAt`
        // in flight is the only way to reach the low-retention branches. The
        // rest of the row is the server's own payload, untouched.
        const ages = new Map([
            ['Legacy migration call', 29],
            ['Archived standup', 31],
        ]);

        await page.route(
            (url) => url.pathname === TRASH_PATH,
            async (route) => {
                if (route.request().method() !== 'GET') return route.continue();
                const response = await route.fetch();
                const rows = await response.json();
                await route.fulfill({
                    status: response.status(),
                    contentType: 'application/json',
                    body: JSON.stringify(
                        rows.map((rec) =>
                            ages.has(rec.title)
                                ? {
                                    ...rec,
                                    deletedAt: new Date(
                                        Date.now() - ages.get(rec.title) * MS_PER_DAY,
                                    ).toISOString(),
                                }
                                : rec,
                        ),
                    ),
                });
            },
        );

        await openTrash(page, email, password);

        // 30 - floor(29) = 1, and the singular is its own branch.
        const lastDay = rowFor(page, 'Legacy migration call').getByText('1 day left', {
            exact: true,
        });

        await expect(lastDay).toBeVisible();
        await expect(lastDay).toHaveClass(/text-red-600/);

        // Past the window daysRemaining clamps to 0 and the copy changes
        // entirely - the row must never render "-1 days left".
        const overdue = rowFor(page, 'Archived standup').getByText('Will be erased shortly', {
            exact: true,
        });

        await expect(overdue).toBeVisible();
        await expect(overdue).toHaveClass(/text-red-600/);
    });
});
