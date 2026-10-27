/** Explicit projection even for INVALID drafts: never forward arbitrary option metadata. */
export function previewContentPayload(gameSlug: string, payload: Record<string, unknown>, reveal: boolean) {
  const string = (v: unknown) => typeof v === 'string' ? v : '';
  return gameSlug === 'wissensduell' ? { prompt: string(payload.prompt), category: string(payload.category),
    options: Array.isArray(payload.options) ? payload.options.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object').map(o => ({ id: string(o.id), text: string(o.text), ...(typeof o.label === 'string' ? { label: o.label } : {}) })) : [],
    ...(reveal ? { correctOptionId: string(payload.correctOptionId), explanation: string(payload.explanation) } : {}) }
    : { question: string(payload.question), category: string(payload.category), value: typeof payload.value === 'number' ? payload.value : 0,
      ...(reveal ? { answer: string(payload.answer) } : {}) };
}
