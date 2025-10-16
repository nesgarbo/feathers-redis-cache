type Options = {
    errorLogger?: (...args: any[]) => void;
    retryInterval?: number;
    lazyConnect?: boolean;
    maxRetryDelay?: number;
    baseRetryDelay?: number;
};
declare const _default: (options?: Options) => () => void;
export default _default;
