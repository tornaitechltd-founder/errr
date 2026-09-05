import { test, expect } from '../../support/fixtures.js';
import { ACCOUNT_SETTINGS, loginViaUi } from '../../support/ui.js';

/**
 * The route table in App.jsx and the two guards around it, plus the session
 * teardown that apiClient's 401 interceptor drives.
 *
 * Deliberately NOT about forms: `login.ui.spec.js` and `signup.ui.spec.js`
 * own the credential and registration paths. Everything here is a question of
 * "where does the browser end up", so every URL assertion uses the
 * auto-retrying `toHaveURL` - reading `page.url()` once scores a redirect that
 * has not happened yet as a pass.
 */

/** ProtectedRoute bounces first, so RecordingDetails never resolves this id. */
const UNREACHABLE_RECORDING_ID = '0123456789abcdef01234567';

/** AuthContext's forced-logout toast, verbatim (the separator is an en dash). */
const SESSION_EXPIRED_TOAST = 'Session expired \u2013 please log in again';

/** EmailVerificationPage's error state. */
const VERIFY_FAILED = 'Verification Failed';
const NO_TOKEN_MESSAGE = 'No verification token provided.';

/** Matches `/^[a-zA-Z0-9._-]{10,256}$/`, so the page will actually call the API. */
const WELL_FORMED_UNKNOWN_TOKEN = 'not-a-real-verification-token-0000';

/** LandingPage's hero, which is what `/` renders for an anonymous visitor. */
const LANDING_HERO = /AI notes for every client call/;

/**
 * `loginViaUi` always starts at a bare `/login`; the deep-link tests need the
 * query string, which is the whole thing under test.
 */
async function signInWithReturnTo(page, rawReturnTo, email, password) {
    await page.goto(`/login?returnTo=${encodeURIComponent(rawReturnTo)}`);
    await page.fill('#login-email', email);
    await page.fill('#login-password', password);

    const response = page.waitForResponse(
        (res) => res.url().includes('/api/public/auth/login') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /sign in/i }).click();
    return response;
}

test.describe('Auth > Routing (browser)', () => {
    for (const path of ['/dashboard', '/trash', `/recordings/${UNREACHABLE_RECORDING_ID}`]) {
        test(`an anonymous visitor asking for ${path} is sent to the landing page`, async ({
                                                                                               page,
                                                                                           }) => {
            await page.goto(path);

            // ProtectedRoute renders <Navigate to="/" replace/>. It is NOT /login,
            // and it carries no returnTo – the deep link is simply lost.
            await expect(page).toHaveURL('/');
            await expect(page.getByRole('heading', { level: 1, name: LANDING_HERO })).toBeVisible();
            await expect(page.locator(ACCOUNT_SETTINGS)).toHaveCount(0);
        });
    }

    test('a signed-in user cannot go back to the login or register pages', async ({
                                                                                      page,
                                                                                      createAccount,
                                                                                  }) => {
        const { email, password } = await createAccount('routing-public');

        expect((await loginViaUi(page, email, password)).status()).toBe(200);
        await expect(page).toHaveURL('/dashboard');

        for (const path of ['/login', '/register']) {
            await page.goto(path);
            // PublicRoute renders <Navigate to="/dashboard" replace/>.
            await expect(page).toHaveURL('/dashboard');
        }
    });

    test('a relative returnTo lands the user where the deep link started', async ({
                                                                                      page,
                                                                                      createAccount,
                                                                                  }) => {
        const { email, password } = await createAccount('routing-return');

        expect((await signInWithReturnTo(page, '/trash', email, password)).status()).toBe(200);

        await expect(page).toHaveURL('/trash');
        await expect(page.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
    });

    test('an off-site returnTo is refused and falls back to the dashboard', async ({
                                                                                       page,
                                                                                       context,
                                                                                       createAccount,
                                                                                   }) => {
        const { email, password } = await createAccount('routing-redirect');

        // A transient bounce through the attacker's host would still hand them
        // the referrer, so the end-state URL alone is not the whole assertion.
        const visited = [];
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) visited.push(frame.url());
        });

        // `//example.com` is the interesting one: it survives a naive
        // startsWith('/') check and the browser reads it as a protocol-relative
        // absolute URL. The absolute form is the control.
        for (const hostile of ['//example.com', 'https://example.com/evil']) {
            // Back to anonymous, or PublicRoute would send the second attempt
            // straight to /dashboard without ever exercising the guard.
            await context.clearCookies();

            expect((await signInWithReturnTo(page, hostile, email, password)).status()).toBe(200);
            await expect(page).toHaveURL('/dashboard');
        }

        // Origin only: the /login URLs under test carry the hostile host in
        // their own query string, so a substring match never passes.
        const origins = visited.map((url) => new URL(url).origin);
        expect(origins.filter((origin) => origin.includes('example.com'))).toEqual([]);
    });

    test('a 401 mid-session signs the user out and says so', async ({
                                                                        page,
                                                                        context,
                                                                        createAccount,
                                                                    }) => {
        const { email, password } = await createAccount('routing-401');

        expect((await loginViaUi(page, email, password)).status()).toBe(200);
        await expect(page).toHaveURL('/dashboard');

        // Losing the jwt cookie is what an expiry looks like to the SPA: the
        // next call it makes by itself comes back 401.
        await context.clearCookies();

        const refused = page.waitForResponse((res) =>
            res.url().includes('/api/v1/recordings/trash'),
        );
        await page.getByRole('link', { name: 'Trash' }).click();

        // Asserted first: notify.info gives the toast 3500ms and then it is gone.
        await expect(page.getByText(SESSION_EXPIRED_TOAST)).toBeVisible();
        expect((await refused).status()).toBe(401);

        // apiClient dispatches auth:logout, AuthContext clears the user, and
        // ProtectedRoute takes them back from there.
        await expect(page).toHaveURL('/');
        await expect(page.locator(ACCOUNT_SETTINGS)).toHaveCount(0);
    });

    for (const path of ['/pending-claim', '/pending-departure', '/pending-deletion']) {
        test(`${path} visited directly bounces back to the login page`, async ({ page }) => {
            // All three read the credentials LoginPage hands them in router
            // state; a reloaded or bookmarked tab has none, and each answers
            // with <Navigate to="/login" replace/> rather than rendering half a
            // form it cannot submit.
            await page.goto(path);

            await expect(page).toHaveURL('/login');
            await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
        });
    }

    test('an unknown path redirects to the landing page', async ({ page }) => {
        await page.goto('/definitely-not-a-route');

        // <Route path="*" element={<Navigate to="/" replace />} />
        await expect(page).toHaveURL('/');
        await expect(page.getByRole('heading', { level: 1, name: LANDING_HERO })).toBeVisible();
    });

    test('/verify without a token refuses without calling the API', async ({ page }) => {
        const verifyCalls = [];
        page.on('request', (req) => {
            if (req.url().includes('/api/public/verify-email')) verifyCalls.push(req.url());
        });

        await page.goto('/verify');

        await expect(page.getByRole('heading', { name: VERIFY_FAILED })).toBeVisible();
        await expect(page.getByText(NO_TOKEN_MESSAGE)).toBeVisible();
        expect(verifyCalls).toEqual([]);
    });

    test('/verify with a malformed token refuses without calling the API', async ({ page }) => {
        const verifyCalls = [];
        page.on('request', (req) => {
            if (req.url().includes('/api/public/verify-email')) verifyCalls.push(req.url());
        });

        // `short` is under the 10-character floor; `nope!!!!!!!!` is long enough
        // but carries a character the token alphabet does not allow. Both must
        // be rejected client-side - a token is a single-use secret and echoing
        // arbitrary query junk at the server is how you turn a typo into a probe.
        for (const token of ['short', 'nope!!!!!!!!']) {
            await page.goto(`/verify?token=${encodeURIComponent(token)}`);

            await expect(page.getByRole('heading', { name: VERIFY_FAILED })).toBeVisible();
            await expect(page.getByText(NO_TOKEN_MESSAGE)).toBeVisible();
        }

        expect(verifyCalls).toEqual([]);
    });

    test('/verify with a well-formed but unknown token shows the failure state', async ({
                                                                                            page,
                                                                                        }) => {
        const rejected = page.waitForResponse((res) =>
            res.url().includes('/api/public/verify-email'),
        );

        await page.goto(`/verify?token=${WELL_FORMED_UNKNOWN_TOKEN}`);

        // The inverse control for the two tests above: this shape passes the
        // client-side guard, so the refusal has to come from the server.
        expect((await rejected).status()).toBe(400);
        await expect(page.getByRole('heading', { name: VERIFY_FAILED })).toBeVisible();
        // The rendered message is not asserted: the page reads `data.error`,
        // which ErrorResponseBuilder fills with the reason phrase, not the
        // explanation. See the bug note in the review for this file.
        await expect(
            page.getByRole('button', { name: 'Resend Verification Email' }),
        ).toBeVisible();
    });

    test('the marketing routes render for an anonymous visitor', async ({ page }) => {
        const pages = [
            ['/privacy', 'Privacy Policy'],
            ['/terms', 'Terms of Service'],
            ['/about', 'About Naplo'],
            ['/onboarding', 'Want a 15-minute walkthrough?'],
            ['/download', 'Download Naplo'],
        ];

        for (const [path, heading] of pages) {
            await page.goto(path);

            // None of these sit inside PublicRoute, so they must neither redirect
            // nor blank out behind the ErrorBoundary.
            await expect(page).toHaveURL(path);
            await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        }
    });
});
