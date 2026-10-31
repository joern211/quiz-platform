import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { serializeLogMeta } from './safeError.js';

afterEach(() => vi.restoreAllMocks());
const SECRET = 'SYNTHETIC_SECRET_do_not_log';
const leaky = () => Object.assign(new Error(`failed with ${SECRET}`), {
  code: 'P2002', meta: { args: { rejoinToken: SECRET, answer: SECRET } }, response: { body: SECRET }, cause: Object.assign(new Error(SECRET), { meta: { secret: SECRET } }), stack: `stack ${SECRET}`,
});

describe('log lines never carry raw error objects or their nested fields', () => {
  it('describes errors at any depth, under any key, and drops message, stack, meta, response and cause', () => {
    const line = serializeLogMeta({ error: leaky(), err: leaky(), nested: { list: [leaky()], inner: { whatever: leaky() } }, context: { action: 'reveal' } });
    expect(line).not.toContain(SECRET);
    expect(JSON.parse(line)).toMatchObject({ error: { name: 'Error', code: 'P2002' }, nested: { list: [{ name: 'Error' }], inner: { whatever: { name: 'Error' } } }, context: { action: 'reveal' } });
  });

  it('does not trust non-Error values under error-named keys and survives unserialisable metadata', () => {
    expect(serializeLogMeta({ error: { meta: { rejoinToken: SECRET } }, err: { response: SECRET } })).not.toContain(SECRET);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => serializeLogMeta({ circular })).not.toThrow();
  });

  it('applies to every logger level, so call sites that pass { error } stay safe', () => {
    const lines: string[] = [];
    for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    logger.info('a', { error: leaky() }); logger.warn('b', { err: leaky() }); logger.error('c', { error: leaky(), traceId: 't-1' });
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines[2]).toContain('t-1');
  });
});
