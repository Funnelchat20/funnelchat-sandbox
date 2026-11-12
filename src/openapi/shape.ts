/**
 * The operations of the spec without a handler of their own answer «shape only»: the request is validated like any
 * other (key, route, path, query, body, with the same errors), and the answer is the success status the spec gives
 * with a body that fits its response schema, marked `X-Sandbox-Simulated: shape-only`. The body is the spec's example
 * of the response when it has one that fits, or one built from the schema (`example.ts`); it is always the same for
 * the same operation, whatever the request says. Nothing is stored and nothing is emitted: creating a board does not
 * keep it.
 */
import { exampleFor } from './example.js';
import { successResponse, type IndexedOperation } from './spec.js';
import { conforms } from './validate.js';

/** The header that marks an answer made up from the spec. Only the shape-only answers carry it. */
export const SIMULATED_HEADER = 'X-Sandbox-Simulated';
export const SHAPE_ONLY = 'shape-only';

export interface ShapeOnlyAnswer {
  status: number;
  /** `undefined` for a `204` or a success without a JSON body. */
  body: unknown;
  /** Where the body comes from: the spec's example of the response, built from its schema, or no body. */
  source: 'example' | 'schema' | 'none';
  /** Whether the body fits the response schema. Built from the schema it always should: `false` is a gap to fix here. */
  fits: boolean;
}

const answers = new WeakMap<IndexedOperation, ShapeOnlyAnswer>();

function build(op: IndexedOperation): ShapeOnlyAnswer {
  const { status, schema, example } = successResponse(op.operation);
  if (status === 204) return { status, body: undefined, source: 'none', fits: true };
  if (example !== undefined && (!schema || conforms(schema, example))) return { status, body: example, source: 'example', fits: true };
  if (!schema) return { status, body: undefined, source: 'none', fits: true };
  const body = exampleFor(schema);
  return { status, body, source: 'schema', fits: conforms(schema, body) };
}

/** The answer of an operation without a handler: built the first time, the same ever after. */
export function shapeOnlyAnswer(op: IndexedOperation): ShapeOnlyAnswer {
  let answer = answers.get(op);
  if (!answer) {
    answer = build(op);
    answers.set(op, answer);
  }
  return answer;
}
