export type OperationQueue = <T>(operation: () => Promise<T>) => Promise<T>;

export function createOperationQueue(): OperationQueue {
    let operationTail = Promise.resolve();

    return <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operationTail.then(operation, operation);
        operationTail = result.then(() => undefined, () => undefined);
        return result;
    };
}