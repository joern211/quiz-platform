import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppError, describeInternal, wireErrorToAppError } from './appError.js';
import { CoreRuleError } from './runtimePrimitives.js';

afterEach(() => vi.restoreAllMocks());

describe('error contract: nothing free-form or secret reaches the wire or the diagnostic line', () => {
  it('keeps typed codes and drops messages of unknown errors (they can embed arguments, paths or tokens)', () => {
    expect(describeInternal(new CoreRuleError('RESULT_REVIEW_REQUIRED'))).toEqual({ name: 'CoreRuleError', code: 'RESULT_REVIEW_REQUIRED', message: 'RESULT_REVIEW_REQUIRED' });
    const database = Object.assign(new Error('Invalid `prisma.participation.create()` invocation: rejoinToken: "tok-secret-123"'), { code: 'P2002' });
    expect(describeInternal(database)).toEqual({ name: 'Error', code: 'P2002' });
    expect(JSON.stringify(describeInternal(new Error('/srv/app/.env SESSION_SECRET=abc')))).not.toMatch(/srv|SECRET|abc/);
    expect(describeInternal({ rejoinToken: 'x' })).toEqual({ type: 'object' });
  });

  it('maps validation text to a stable key and never echoes free text as messageKey', () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a); }); vi.spyOn(console, 'error').mockImplementation((...a) => { logged.push(a); });
    expect(wireErrorToAppError('VALIDATION_ERROR: Expected \'A\' | \'B\', received \'my-secret-answer\'')).toMatchObject({ code: 'INVALID_PAYLOAD', messageKey: 'INVALID_PAYLOAD' });
    expect(buildAppError('INTERNAL_ERROR', 'SELECT * FROM x WHERE token = abc', {})).toMatchObject({ messageKey: 'INTERNAL_ERROR' });
    expect(JSON.stringify(logged)).not.toMatch(/my-secret-answer|SELECT|token = abc/);
  });

  it('logs unexpected failures at error level under the trace id of the answer, with the sanitised description', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(String(line)); });
    const error = wireErrorToAppError('INTERNAL_ERROR', { internalDetail: new Error('password=hunter2'), context: { action: 'result:command' } });
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', messageKey: 'INTERNAL_ERROR' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(error.traceId); expect(lines[0]).toContain('result:command'); expect(lines[0]).toContain('"name":"Error"');
    expect(lines[0]).not.toContain('hunter2');
  });
});
