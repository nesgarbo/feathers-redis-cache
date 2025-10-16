import { logger } from './logger.js';
const { DISABLE_REDIS_CACHE, ENABLE_REDIS_CACHE_LOGGER } = process.env;
const HTTP_SERVER_ERROR = 500;
const defaults = {
    defaultExpiration: 3600 * 24,
};
function stableStringify(obj) {
    const seen = new WeakSet();
    const normalize = (value) => {
        if (value === null)
            return null;
        const t = typeof value;
        if (t === 'bigint')
            return value.toString();
        if (t === 'number' || t === 'string' || t === 'boolean')
            return value;
        if (t === 'undefined' || t === 'function')
            return undefined;
        if (value instanceof Date)
            return value.toISOString();
        if (Array.isArray(value)) {
            let changed = false;
            const out = new Array(value.length);
            for (let i = 0; i < value.length; i++) {
                const v = normalize(value[i]);
                if (v !== value[i])
                    changed = true;
                out[i] = v;
            }
            return changed ? out.filter(v => v !== undefined) : out;
        }
        if (t === 'object') {
            if (seen.has(value))
                return '[Circular]';
            seen.add(value);
            const keys = Object.keys(value).sort();
            const out = {};
            for (const k of keys) {
                const v = normalize(value[k]);
                if (v !== undefined)
                    out[k] = v;
            }
            seen.delete(value);
            return out;
        }
        return String(value);
    };
    return JSON.stringify(normalize(obj));
}
export function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return String(h);
}
function humanizeSeconds(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60)
        return secs ? `${mins}m ${secs}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return remM ? `${hrs}h ${remM}m` : `${hrs}h`;
}
function makeKeys(hook, opts) {
    const paginateTag = hook.params?.paginate === false ? 'disabled' : 'enabled';
    const basePath = `pagination-hook:${paginateTag}::${hook.path}${hook.id != null ? `/${hook.id}` : ''}`;
    const q = hook.params?.query;
    const qStr = q && Object.keys(q).length ? stableStringify(q) : '';
    const raw = qStr ? `${basePath}?${qStr}` : basePath;
    const groupSeed = typeof opts.cacheGroupKey === 'function'
        ? `group-${opts.cacheGroupKey(hook)}`
        : `group-${hook.path || 'general'}`;
    const group = hashCode(groupSeed);
    const key = typeof opts.cacheKey === 'function'
        ? `${group}${opts.cacheKey(hook)}`
        : `${group}${hashCode(raw)}`;
    return { group, key };
}
export async function purgeGroup(client, group, keyPrefix = 'frc_') {
    let cursor = '0';
    const match = `${keyPrefix}${group}*`;
    const batchSize = 1000;
    do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', batchSize);
        cursor = nextCursor;
        if (Array.isArray(keys) && keys.length) {
            const pipe = client.pipeline();
            for (const k of keys)
                pipe.unlink(k);
            await pipe.exec();
        }
    } while (cursor !== '0');
}
export default {
    before(passedOptions = {}) {
        if (DISABLE_REDIS_CACHE === 'true')
            return (hook) => hook;
        return async function beforeHook(hook) {
            if (hook?.params?.$skipCacheHook)
                return hook;
            const client = hook.app.get('redisClient');
            if (!client)
                return hook;
            const options = { ...defaults, ...passedOptions };
            const { group, key } = makeKeys(hook, options);
            hook.params || (hook.params = {});
            hook.params.cacheKey = key;
            hook.params.cacheGroup = group;
            const reply = await client.get(key);
            if (!reply)
                return hook;
            let data;
            try {
                data = JSON.parse(reply);
            }
            catch {
                return hook;
            }
            if (!data || !data.expiresOn || data.cache == null)
                return hook;
            hook.result = data.cache;
            hook.params.$skipCacheHook = true;
            if (options.env !== 'test' && ENABLE_REDIS_CACHE_LOGGER === 'true') {
                logger.info(`[redis] returning cached value for ${key}.`);
                logger.info(`> Expires on ${new Date(data.expiresOn).toISOString()}.`);
            }
            return hook;
        };
    },
    after(passedOptions = {}) {
        if (DISABLE_REDIS_CACHE === 'true')
            return (hook) => hook;
        return async function afterHook(hook) {
            if (hook?.params?.$skipCacheHook)
                return hook;
            if (hook?.result == null)
                return hook;
            const client = hook.app.get('redisClient');
            if (!client)
                return hook;
            const options = { ...defaults, ...passedOptions };
            const duration = options.expiration ?? options.defaultExpiration;
            const cacheKey = hook.params?.cacheKey;
            if (!cacheKey)
                return hook;
            const expiresOn = new Date(Date.now() + duration * 1000).toISOString();
            await client.set(cacheKey, JSON.stringify({ cache: hook.result, expiresOn }), 'EX', duration);
            if (options.env !== 'test' && ENABLE_REDIS_CACHE_LOGGER === 'true') {
                logger.info(`[redis] added ${cacheKey} to the cache.`);
                logger.info(`> Expires in ${humanizeSeconds(duration)}.`);
            }
            return hook;
        };
    },
    purge(passedOptions = {}) {
        if (DISABLE_REDIS_CACHE === 'true')
            return (hook) => hook;
        return async function purgeHook(hook) {
            const client = hook.app.get('redisClient');
            if (!client) {
                return { message: 'Redis unavailable', status: HTTP_SERVER_ERROR };
            }
            const options = { ...defaults, ...passedOptions };
            const appRedisCfg = hook.app.get('redis') || {};
            const keyPrefix = appRedisCfg.keyPrefix ?? 'frc_';
            const { group } = makeKeys(hook, options);
            purgeGroup(client, group, keyPrefix).catch((err) => logger.error({ message: err?.message ?? String(err), status: HTTP_SERVER_ERROR }));
            return hook;
        };
    },
};
//# sourceMappingURL=hooks.js.map