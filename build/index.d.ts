import client from './client.js';
import services from './services.js';
import hooks from './hooks.js';
export { client, services, hooks };
declare const _default: {
    client: (options?: {
        errorLogger?: (...args: any[]) => void;
        retryInterval?: number;
        lazyConnect?: boolean;
        maxRetryDelay?: number;
        baseRetryDelay?: number;
    }) => () => void;
    services: typeof services;
    hooks: {
        before(passedOptions?: {
            env?: string;
            expiration?: number;
            defaultExpiration?: number;
            cacheGroupKey?: (hook: any) => string | number;
            cacheKey?: (hook: any) => string;
        }): (hook: any) => any;
        after(passedOptions?: {
            env?: string;
            expiration?: number;
            defaultExpiration?: number;
            cacheGroupKey?: (hook: any) => string | number;
            cacheKey?: (hook: any) => string;
        }): (hook: any) => any;
        purge(passedOptions?: {
            env?: string;
            expiration?: number;
            defaultExpiration?: number;
            cacheGroupKey?: (hook: any) => string | number;
            cacheKey?: (hook: any) => string;
        }): (hook: any) => any;
    };
};
export default _default;
