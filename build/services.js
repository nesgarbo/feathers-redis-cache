import { purgeGroup, hashCode } from './hooks.js';
const { DISABLE_REDIS_CACHE } = process.env;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_REQUEST = 400;
const DEFAULT_PREFIX = 'frc_';
function getKeyPrefix(app) {
    const cfg = app.get('redis') || {};
    const p = cfg.keyPrefix ?? cfg.prefix ?? DEFAULT_PREFIX;
    return typeof p === 'string' ? p : DEFAULT_PREFIX;
}
function stripPrefix(key, prefix) {
    return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}
function ensureClient(app) {
    const client = app.get('redisClient');
    if (!client) {
        return { error: { message: 'Redis unavailable', status: HTTP_SERVER_ERROR } };
    }
    return { client };
}
function ok(message, status = HTTP_OK) {
    return { message, status };
}
function fail(message, status = HTTP_SERVER_ERROR) {
    return { message, status };
}
class ServiceClearSingle {
    async setup(app) { this.app = app; }
    async find(params) {
        const { client, error } = ensureClient(this.app);
        if (error)
            return error;
        const keyPrefix = getKeyPrefix(this.app);
        const target = String(params?.query?.target ?? '');
        if (!target)
            return fail('You must provide key', HTTP_BAD_REQUEST);
        const logicalKey = stripPrefix(target, keyPrefix);
        try {
            const exists = await client.get(logicalKey);
            if (!exists)
                return ok(`cache already cleared for key ${target}`, HTTP_NO_CONTENT);
            const del = typeof client.unlink === 'function' ? client.unlink.bind(client) : client.del.bind(client);
            const deleted = await del(logicalKey);
            if (!deleted)
                return ok(`cache already cleared for key ${target}`, HTTP_NO_CONTENT);
            return ok(`cache cleared for key ${target}`);
        }
        catch (err) {
            return fail('something went wrong: ' + (err?.message ?? String(err)));
        }
    }
}
class ServiceClearGroup {
    async setup(app) { this.app = app; }
    async find(params) {
        const { client, error } = ensureClient(this.app);
        if (error)
            return error;
        const keyPrefix = getKeyPrefix(this.app);
        const target = String(params?.query?.target ?? '').trim();
        if (!target)
            return fail('Target is required', HTTP_BAD_REQUEST);
        const group = /^[\-]?\d+$/.test(target) ? target : hashCode(`group-${target}`);
        try {
            await purgeGroup(client, group, keyPrefix);
            return ok(`cache cleared for group ${target}`);
        }
        catch (err) {
            return fail(err?.message ?? 'Unknown error');
        }
    }
}
class ServiceClearAll {
    async setup(app) { this.app = app; }
    async find() {
        const { client, error } = ensureClient(this.app);
        if (error)
            return error;
        const keyPrefix = getKeyPrefix(this.app);
        try {
            await purgeGroup(client, '', keyPrefix);
            return ok('cache cleared');
        }
        catch (err) {
            return fail(err?.message ?? 'Unknown error');
        }
    }
}
class ServiceFlushDb {
    async setup(app) { this.app = app; }
    async find() {
        const { client, error } = ensureClient(this.app);
        if (error)
            return error;
        try {
            await client.flushdb();
            return ok('Cache cleared');
        }
        catch (err) {
            return fail(err?.message ?? 'Unknown error');
        }
    }
}
export default function registerCacheMaintenance(options = {}) {
    const pathPrefix = options.pathPrefix || '/cache';
    return function register(app) {
        const a = app ?? this;
        if (DISABLE_REDIS_CACHE === 'true')
            return;
        a.use(`${pathPrefix}/clear/single`, new ServiceClearSingle());
        a.use(`${pathPrefix}/clear/group`, new ServiceClearGroup());
        a.use(`${pathPrefix}/clear/all`, new ServiceClearAll());
        a.use(`${pathPrefix}/flushdb`, new ServiceFlushDb());
    };
}
//# sourceMappingURL=services.js.map