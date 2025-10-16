type PassedOptions = {
    env?: string;
    expiration?: number;
    defaultExpiration?: number;
    cacheGroupKey?: (hook: any) => string | number;
    cacheKey?: (hook: any) => string;
};
export declare function hashCode(s: string): string;
export declare function purgeGroup(client: any, group: string, keyPrefix?: string): Promise<void>;
declare const _default: {
    before(passedOptions?: PassedOptions): (hook: any) => any;
    after(passedOptions?: PassedOptions): (hook: any) => any;
    purge(passedOptions?: PassedOptions): (hook: any) => any;
};
export default _default;
