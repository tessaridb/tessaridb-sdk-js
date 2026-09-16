/**
 * Filters — the `WHERE` tree (§4.3 of the rendering contract).
 *
 * A conjunction and a disjunction are fully parenthesised and a bare comparison
 * is not. The parentheses are not an aid to reading: a builder does not depend on
 * the node's parser and so does not get to assume how `AND` and `OR` associate.
 * Writing them all makes the tree the caller built the tree that runs.
 */

import type { Value } from '../value.ts';
import { type Binder, name } from './grammar.ts';

export type Operator = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

const SYMBOL: Record<Operator, string> = {
  eq: '=',
  ne: '!=',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
};

export type Filter =
  | {
      readonly kind: 'compare';
      readonly field: string;
      readonly op: Operator;
      readonly value: Value;
    }
  | { readonly kind: 'and'; readonly left: Filter; readonly right: Filter }
  | { readonly kind: 'or'; readonly left: Filter; readonly right: Filter };

/** `field <op> $pN`. The field is a name and is checked here, where it is given. */
export function compare(field: string, op: Operator, value: Value): Filter {
  return { kind: 'compare', field: name('a field', field), op, value };
}

export function and(left: Filter, right: Filter): Filter {
  return { kind: 'and', left, right };
}

export function or(left: Filter, right: Filter): Filter {
  return { kind: 'or', left, right };
}

/**
 * Renders the tree, binding values depth-first and left to right.
 *
 * Binding happens during the walk rather than in a pass before it, so a
 * comparison's parameter number is fixed by its position in the text a reader
 * sees — which is what makes the numbering reproducible across languages.
 */
export function renderFilter(filter: Filter, binder: Binder): string {
  switch (filter.kind) {
    case 'compare':
      return `${filter.field} ${SYMBOL[filter.op]} ${binder.bind(filter.value)}`;
    case 'and':
      return `(${renderFilter(filter.left, binder)} AND ${renderFilter(filter.right, binder)})`;
    case 'or':
      return `(${renderFilter(filter.left, binder)} OR ${renderFilter(filter.right, binder)})`;
  }
}
