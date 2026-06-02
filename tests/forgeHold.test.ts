import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForgeHoldRegistry, ForgeHoldDeps, Semaphore, ConcurrencyLimiter } from '../src/forgeHold';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

test('A: overlapping same-model batch collapses to exactly one /ensure + one /release', async () => {
    let ensures = 0, releases = 0;
    const deps: ForgeHoldDeps = {
        ensure: async (_u, m) => { ensures++; return { baseUrl: 'b', model: m, backend: 'llamacpp' }; },
        release: async () => { releases++; return true; },
    };
    const reg = new ForgeHoldRegistry(deps);

    // 4 concurrent acquirers for the same model — they overlap.
    const holds = await Promise.all(
        Array.from({ length: 4 }, () => reg.acquire('http://forge', 'gemma')),
    );
    assert.equal(ensures, 1, 'ensure called once for the whole batch');
    assert.equal(reg.activeCount('http://forge', 'gemma'), 4);

    // Release the first three — count stays >= 1, so no Forge /release yet.
    await holds[0].release();
    await holds[1].release();
    await holds[2].release();
    assert.equal(releases, 0, 'no release while siblings are still in flight');
    assert.equal(reg.activeCount('http://forge', 'gemma'), 1);

    // Last one out fires the single /release.
    await holds[3].release();
    assert.equal(releases, 1, 'release called once when the last holder leaves');
    assert.equal(reg.activeCount('http://forge', 'gemma'), 0);
});

test('A: all acquirers receive the same resolved endpoint', async () => {
    const reg = new ForgeHoldRegistry({
        ensure: async (_u, m) => ({ baseUrl: 'http://x/v1', model: m, backend: 'ollama' }),
        release: async () => true,
    });
    const [h1, h2] = await Promise.all([reg.acquire('u', 'm'), reg.acquire('u', 'm')]);
    assert.deepEqual(h1.resolved, { backend: 'ollama', model: 'm', baseUrl: 'http://x/v1' });
    assert.deepEqual(h1.resolved, h2.resolved);
    await h1.release(); await h2.release();
});

test('A: release is idempotent (safe to call twice in a finally)', async () => {
    let releases = 0;
    const reg = new ForgeHoldRegistry({
        ensure: async (_u, m) => ({ baseUrl: 'b', model: m, backend: 'llamacpp' }),
        release: async () => { releases++; return true; },
    });
    const h = await reg.acquire('u', 'm');
    await h.release();
    await h.release();
    assert.equal(releases, 1, 'double release fires Forge /release only once');
});

test('A: sequential (non-overlapping) dispatch re-ensures per use', async () => {
    let ensures = 0, releases = 0;
    const reg = new ForgeHoldRegistry({
        ensure: async (_u, m) => { ensures++; return { baseUrl: 'b', model: m, backend: 'llamacpp' }; },
        release: async () => { releases++; return true; },
    });
    const a = await reg.acquire('u', 'm'); await a.release();
    const b = await reg.acquire('u', 'm'); await b.release();
    assert.equal(ensures, 2);
    assert.equal(releases, 2);
});

test('A: a failed /ensure backs the acquirer out — no phantom hold leaks', async () => {
    let releases = 0;
    const reg = new ForgeHoldRegistry({
        ensure: async () => { throw new Error('502 load error'); },
        release: async () => { releases++; return true; },
    });
    await assert.rejects(() => reg.acquire('u', 'm'), /502 load error/);
    assert.equal(reg.activeCount('u', 'm'), 0, 'no leaked hold after a failed ensure');
    assert.equal(releases, 0, 'a never-ensured hold is never released');
});

test('A: onReleaseUnconfirmed fires when Forge does not confirm the release', async () => {
    let warned = 0;
    const reg = new ForgeHoldRegistry({
        ensure: async (_u, m) => ({ baseUrl: 'b', model: m, backend: 'llamacpp' }),
        release: async () => false, // not confirmed
    });
    const h = await reg.acquire('u', 'm', () => { warned++; });
    await h.release();
    assert.equal(warned, 1);
});

test('A: distinct models are held independently', async () => {
    let ensures = 0;
    const reg = new ForgeHoldRegistry({
        ensure: async (_u, m) => { ensures++; return { baseUrl: 'b', model: m, backend: 'llamacpp' }; },
        release: async () => true,
    });
    const a = await reg.acquire('u', 'alpha');
    const b = await reg.acquire('u', 'beta');
    assert.equal(ensures, 2);
    assert.equal(reg.activeCount('u', 'alpha'), 1);
    assert.equal(reg.activeCount('u', 'beta'), 1);
    await a.release(); await b.release();
});

test('C: Semaphore never exceeds its limit and queues the rest', async () => {
    const limit = 2;
    const sem = new Semaphore(limit);
    let live = 0, peak = 0, completed = 0;

    const work = async () => {
        const rel = await sem.acquire();
        live++; peak = Math.max(peak, live);
        await tick();
        live--; completed++;
        rel();
    };

    await Promise.all(Array.from({ length: 6 }, work));
    assert.equal(peak, limit, 'in-flight never exceeded the slot count');
    assert.equal(completed, 6, 'every queued task eventually ran');
});

test('C: a slot freed in the same tick is handed off, not double-claimed', async () => {
    const sem = new Semaphore(1);
    const rel1 = await sem.acquire();
    let secondGotIt = false;
    const p = sem.acquire().then(rel => { secondGotIt = true; return rel; });
    // The second acquire must be queued (limit 1, slot held).
    await tick();
    assert.equal(secondGotIt, false);
    rel1();
    const rel2 = await p;
    assert.equal(secondGotIt, true);
    rel2();
});

test('C: ConcurrencyLimiter caps each key independently', async () => {
    const lim = new ConcurrencyLimiter(1);
    const a1 = await lim.acquire('alpha');
    let alphaSecond = false, betaFirst = false;
    const ap = lim.acquire('alpha').then(r => { alphaSecond = true; return r; });
    const bp = lim.acquire('beta').then(r => { betaFirst = true; return r; });
    await tick();
    assert.equal(alphaSecond, false, 'second alpha is queued behind the first');
    assert.equal(betaFirst, true, 'a different key is not blocked by alpha');
    a1();
    (await ap)();
    (await bp)();
});
