import { test, expect, expectStatus } from '../../support/fixtures.js';
import { createRecording } from '../../support/recordings.js';

/**
 * Soft delete -> trash -> restore / erase. The status codes are not
 * interchangeable: DELETE answers 204 with no body, restore answers 200 with
 * the refreshed DTO, and emptying the bin answers 200 with { erased: n }.
 */
const trashOf = (api) => api.json(api.get('/api/v1/recordings/trash'), 200);

const listing = (api) => api.json(api.get('/api/v1/recordings'), 200);

test.describe('Recording > Trash', () => {
    test('delete moves to trash and restore brings it back', async ({ newUser }) => {
        const api = await newUser('recorder');
        const { id } = await createRecording(api, 'Weekly standups');

        await expectStatus(await api.delete(`/api/v1/recordings/${id}`), 204);

        const [trashed] = await trashOf(api);
        expect(trashed.id).toBe(id);
        expect(trashed.group).toBe('Weekly standups');
        // The UI counts down the 30-day purge window from this.
        expect(trashed.deletedAt).toBeTruthy();

        // A soft-deleted recording must disappear from the main listing, or the
        // dashboard shows rows the user thinks they deleted.
        expect((await listing(api)).map((rec) => rec.id)).not.toContain(id);
        // ...and the detail endpoint treats it as gone, not merely forbidden.
        const gone = await api.get(`/api/v1/recordings/${id}`);
        expect(gone.status()).toBe(404);
        expect((await gone.json()).message).toBe(`Recording not found with ID: ${id}`);

        const restored = await api.json(api.post(`/api/v1/recordings/${id}/restore`), 200);
        expect(restored.id).toBe(id);
        // restore() unsets deletedAt entirely, so a restored recording is
        // indistinguishable from one that was never deleted.
        expect(restored.deletedAt).toBeNull();
        expect((await listing(api)).map((rec) => rec.id)).toContain(id);
        expect(await trashOf(api)).toHaveLength(0);
    });

    test('deleting an already-trashed recording is a 404', async ({ newUser }) => {
        const api = await newUser('recorder');
        const { id } = await createRecording(api);

        await expectStatus(await api.delete(`/api/v1/recordings/${id}`), 204);
        // softDelete goes through requireOwnedBy, which refuses to see a deleted
        // recording at all.
        expect((await api.delete(`/api/v1/recordings/${id}`)).status()).toBe(404);
    });

    test('restoring an active recording is an idempotent no-op', async ({ newUser }) => {
        const api = await newUser('recorder');
        const { id } = await createRecording(api, 'E2E group', 'Untouched');

        const restored = await api.json(api.post(`/api/v1/recordings/${id}/restore`), 200);
        expect(restored.title).toBe('Untouched');
        expect(restored.deletedAt).toBeNull();
        expect((await listing(api)).map((rec) => rec.id)).toContain(id);
    });

    test('delete forever works straight from the active list', async ({ newUser }) => {
        const api = await newUser('recorder');
        const { id } = await createRecording(api);

        // No trash detour required - requireOwnedByIncludingDeleted tolerates both.
        await expectStatus(await api.delete(`/api/v1/recordings/${id}/forever`), 204);
        expect((await api.get(`/api/v1/recordings/${id}`)).status()).toBe(404);
        expect(await listing(api)).toHaveLength(0);
        expect(await trashOf(api)).toHaveLength(0);
    });

    test('permanent delete is irreversible', async ({ newUser }) => {
        const api = await newUser('recorder');
        const { id } = await createRecording(api);

        await expectStatus(await api.delete(`/api/v1/recordings/${id}`), 204);
        await expectStatus(await api.delete(`/api/v1/recordings/${id}/forever`), 204);

        expect((await api.get(`/api/v1/recordings/${id}`)).status()).toBe(404);
        expect(await trashOf(api)).toHaveLength(0);
        // Nothing left to restore either.
        expect((await api.post(`/api/v1/recordings/${id}/restore`)).status()).toBe(404);
    });

    test('emptying the trash reports how many recordings it erased', async ({ newUser }) => {
        const api = await newUser('recorder');
        const first = await createRecording(api);
        const second = await createRecording(api);
        const kept = await createRecording(api);

        await expectStatus(await api.delete(`/api/v1/recordings/${first.id}`), 204);
        await expectStatus(await api.delete(`/api/v1/recordings/${second.id}`), 204);

        const emptied = await api.json(api.delete('/api/v1/recordings/trash'), 200);
        // The count drives the confirmation toast, so it has to be exact.
        expect(emptied).toEqual({ erased: 2 });
        expect(await trashOf(api)).toHaveLength(0);
        // The active recording is untouched.
        expect((await listing(api)).map((rec) => rec.id)).toEqual([kept.id]);

        expect(await api.json(api.delete('/api/v1/recordings/trash'), 200)).toEqual({ erased: 0 });
    });

    test('the trash listing is org-scoped but emptying it is not', async ({ newUser }) => {
        const api = await newUser('recorder');
        const personal = await api.activeOrg();
        const { id: personalRecording } = await createRecording(api, 'Personal notes');
        await expectStatus(await api.delete(`/api/v1/recordings/${personalRecording}`), 204);

        const business = await api.json(
            api.post('/api/v1/organizations', { data: { name: 'Naplo E2E Trash Scope' } }),
            200,
            201,
        );

        await api.activate(business.id);
        const { id: businessRecording } = await createRecording(api, 'Client calls');
        await expectStatus(await api.delete(`/api/v1/recordings/${businessRecording}`), 204);

        // getTrash filters on the JWT's active org...
        expect((await trashOf(api)).map((rec) => rec.id)).toEqual([businessRecording]);

        // ...but emptyTrash only filters on the user, so it takes the other
        // tenant's bin with it.
        expect(await api.json(api.delete('/api/v1/recordings/trash'), 200)).toEqual({ erased: 2 });

        await api.activate(personal.id);
        expect(await trashOf(api)).toHaveLength(0);
        expect((await api.get(`/api/v1/recordings/${personalRecording}`)).status()).toBe(404);
    });

    test('one users empty-trash cannot reach another users bin', async ({ newUser }) => {
        const owner = await newUser('recorder');
        const { id } = await createRecording(owner);
        await expectStatus(await owner.delete(`/api/v1/recordings/${id}`), 204);

        const stranger = await newUser('stranger');
        expect(await stranger.json(stranger.delete('/api/v1/recordings/trash'), 200)).toEqual({
            erased: 0,
        });
        expect((await trashOf(owner)).map((rec) => rec.id)).toEqual([id]);
    });
});
