/**
 * A utility for cleaning up AbortableOperations, to help simplify common
 * patterns and reduce code duplication.
 *
 */

import { IAbortableOperation } from '../../externs/shaka/abortable';
import { ArrayUtils } from './array_utils';
import { IDestroyable } from './i_destroyable';

export class OperationManager implements IDestroyable {
  operations_: IAbortableOperation[] = [];

  manage(operation: IAbortableOperation) {
    operation.finally(() => {
      ArrayUtils.remove(this.operations_, operation);
    });
    this.operations_.push(operation);
  }

  destroy(): Promise<any> {
    const cleanup = [];
    for (const op of this.operations_) {
      // Catch and ignore any failures.  This silences error logs in the
      // JavaScript console about uncaught Promise failures.
      op.promise.catch(() => {});

      // Now abort the operation.
      cleanup.push(op.abort());
    }

    this.operations_ = [];
    return Promise.all(cleanup);
  }
}
