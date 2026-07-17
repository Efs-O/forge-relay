import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopGuard } from '../src/toolLoopGuard';

test('tool loop guard stops a third identical call and ignores JSON key order', () => {
    const guard = new ToolLoopGuard();
    guard.beforeCall('read_file', { path: 'a', extra: 1 });
    guard.afterCall('same');
    guard.beforeCall('read_file', { extra: 1, path: 'a' });
    guard.afterCall('same');
    assert.throws(() => guard.beforeCall('read_file', { path: 'a', extra: 1 }), /tool loop detected/i);
});

test('tool loop guard stops an alternating cycle before its third A call', () => {
    const guard = new ToolLoopGuard();
    guard.beforeCall('read_file', { path: 'a' });
    guard.afterCall('A');
    guard.beforeCall('read_file', { path: 'b' });
    guard.afterCall('B');
    guard.beforeCall('read_file', { path: 'a' });
    guard.afterCall('A');
    guard.beforeCall('read_file', { path: 'b' });
    guard.afterCall('B');
    assert.throws(() => guard.beforeCall('read_file', { path: 'a' }), /alternating cycle/i);
});

test('tool loop guard allows repeated polling when results change', () => {
    const guard = new ToolLoopGuard();
    guard.beforeCall('get_status', {}); guard.afterCall('loading');
    guard.beforeCall('get_status', {}); guard.afterCall('ready');
    assert.doesNotThrow(() => guard.beforeCall('get_status', {}));
});
