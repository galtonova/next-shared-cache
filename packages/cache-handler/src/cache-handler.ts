import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import type {
    CacheHandlerParametersGet,
    CacheHandlerParametersRevalidateTag,
    CacheHandlerParametersSet,
    CacheHandlerValue,
    FileSystemCacheContext,
    IncrementalCachedPageValue,
    LifespanParameters,
    CacheHandler as NextCacheHandler,
    PrerenderManifest,
    Revalidate,
} from '@neshca/next-common';

import { createValidatedAgeEstimationFunction } from './helpers/create-validated-age-estimation-function';
import { getTagsFromPageData } from './helpers/get-tags-from-page-data';

export type { CacheHandlerValue };

/**
 * Represents an internal Next.js metadata for a `get` method.
 * This metadata is available in the `get` method of the cache handler.
 *
 * @since 1.1.0
 */
type HandlerGetMeta = {
    /**
     * An array of tags that are implicitly associated with the cache entry.
     *
     * @since 1.1.0
     */
    implicitTags: string[];
};

/**
 * Represents a cache Handler.
 *
 * @since 1.0.0
 */
export type Handler = {
    /**
     * A descriptive name for the cache Handler.
     *
     * @since 1.0.0
     */
    name: string;
    /**
     * Retrieves the value associated with the given key from the cache.
     *
     * @param key - The unique string identifier for the cache entry.
     *
     * @param meta - The metadata object for the `get` method. See {@link HandlerGetMeta}.
     *
     * @returns A Promise that resolves to the cached value (if found), `null` or `undefined` if the entry is not found.
     *
     * @example
     * ### With auto expiration
     *
     * If your cache store supports time based key eviction, the `get` method is straightforward.
     *
     * ```js
     *  const handler = {
     *    async get(key) {
     *      const cacheValue = await cacheStore.get(key);
     *
     *      if (!cacheValue) {
     *          return null;
     *      }
     *
     *      return cacheValue;
     *   }
     * }
     * ```
     *
     * ### Without auto expiration
     *
     * If your cache store does not support time based key eviction,
     * you can implement the `delete` method to remove the cache entry when it becomes expired.
     *
     * ```js
     *  const handler = {
     *    async get(key) {
     *      const cacheValue = await cacheStore.get(key);
     *
     *      if (!cacheValue) {
     *          return null;
     *      }
     *
     *      return cacheValue;
     *    },
     *    async delete(key) {
     *      await cacheStore.delete(key);
     *    }
     * }
     * ```
     *
     * @since 1.0.0
     */
    get: (key: string, meta: HandlerGetMeta) => Promise<CacheHandlerValue | null | undefined>;
    /**
     * Sets or updates a value in the cache store.
     *
     * @param key - The unique string identifier for the cache entry.
     *
     * @param value - The value to be stored in the cache. See {@link CacheHandlerValue}.
     *
     * @returns A Promise that resolves when the value has been successfully set in the cache.
     *
     * @remarks
     *
     * Read more about the `lifespan` parameter: {@link LifespanParameters}.
     *
     * ### LifespanParameters
     * If no `revalidate` option or `revalidate: false` is set in your [`getStaticProps`](https://nextjs.org/docs/pages/api-reference/functions/get-static-props#revalidate)
     * the `lifespan` parameter will be `null` and you should consider the cache entry as always fresh and never stale.
     *
     * Use the absolute time (`expireAt`) to set and expiration time for the cache entry in your cache store to be in sync with the file system cache.
     *
     * @since 1.0.0
     */
    set: (key: string, value: CacheHandlerValue) => Promise<void>;
    /**
     * Deletes all cache entries that are associated with the specified tag.
     * See [fetch `options.next.tags` and `revalidateTag`](https://nextjs.org/docs/app/building-your-application/caching#fetch-optionsnexttags-and-revalidatetag)
     *
     * @param tag - A string representing the cache tag associated with the data you want to revalidate.
     * Must be less than or equal to 256 characters. This value is case-sensitive.
     *
     * @since 1.0.0
     */
    revalidateTag: (tag: string) => Promise<void>;
    /**
     * Deletes the cache entry associated with the given key from the cache store.
     * This method is optional and supposed to be used only when the cache store does not support time based key eviction.
     * This method will be automatically called by the `CacheHandler` class when the retrieved cache entry is stale.
     *
     * @param key - The unique string identifier for the cache entry.
     *
     * @returns A Promise that resolves when the cache entry has been successfully deleted.
     *
     * @since 1.0.0
     */
    delete?: (key: string) => Promise<void>;
};

/**
 * Represents the parameters for Time-to-Live (TTL) configuration.
 *
 * @since 1.0.0
 */
export type TTLParameters = {
    /**
     * The time in seconds for when the cache entry becomes stale.
     *
     * @default 31536000 // 1 year
     *
     * @since 1.0.0
     */
    defaultStaleAge: number;
    /**
     * Estimates the expiration age based on the stale age.
     *
     * @param staleAge - The stale age in seconds.
     * After the stale age, the cache entry is considered stale, can be served from the cache, and should be revalidated.
     * Revalidation is handled by the `CacheHandler` class.
     *
     * @default (staleAge) => staleAge
     *
     * @returns The expiration age in seconds.
     *
     * @since 1.0.0
     */
    estimateExpireAge(staleAge: number): number;
};

/**
 * Configuration options for the {@link CacheHandler}.
 *
 * @since 1.0.0
 */
export type CacheHandlerConfig = {
    /**
     * An array of cache instances that conform to the Handler interface.
     * Multiple caches can be used to implement various caching strategies or layers.
     *
     * @since 1.0.0
     */
    handlers: (Handler | undefined | null)[];
    /**
     * Time-to-live (TTL) options for the cache entries.
     *
     * @since 1.0.0
     */
    ttl?: Partial<TTLParameters>;
};

/**
 * Contextual information provided during cache creation, including server directory paths and environment mode.
 *
 * @since 1.0.0
 */
export type CacheCreationContext = {
    /**
     * The absolute path to the Next.js server directory.
     *
     * @since 1.0.0
     */
    serverDistDir: string;
    /**
     * Indicates if the Next.js application is running in development mode.
     * When in development mode, caching behavior might differ.
     *
     * @since 1.0.0
     */
    dev?: boolean;
    /**
     * The unique identifier for the current build of the Next.js application.
     * This build ID is generated during the `next build` process and is used
     * to ensure consistency across multiple instances of the application,
     * especially when running in containerized environments. It helps in
     * identifying which version of the application is being served.
     *
     * https://nextjs.org/docs/pages/building-your-application/deploying#build-cache
     *
     * @example
     * ```js
     * // cache-handler.mjs
     * CacheHandler.onCreation(async ({ buildId }) => {
     *   let redisHandler;
     *
     *   if (buildId) {
     *     await client.connect();
     *
     *     redisHandler = await createRedisHandler({
     *       client,
     *       keyPrefix: `${buildId}:`,
     *     });
     *   }
     *
     *   const localHandler = createLruHandler();
     *
     *   return {
     *     handlers: [redisHandler, localHandler],
     *   };
     * });
     * ```
     *
     * @since 1.0.0
     */
    buildId?: string;
};

/**
 * Represents a hook function that is called during the build and on start of the application.
 *
 * @param context - The {@link CacheCreationContext} object, providing contextual information about the cache creation environment,
 * such as server directory paths and whether the application is running in development mode.
 *
 * @returns Either a {@link CacheHandlerConfig} object or a Promise that resolves to a {@link CacheHandlerConfig},
 * specifying how the cache should be configured.
 *
 * @since 1.0.0
 */
export type OnCreationHook = (context: CacheCreationContext) => Promise<CacheHandlerConfig> | CacheHandlerConfig;

export class CacheHandler implements NextCacheHandler {
    /**
     * Provides a descriptive name for the CacheHandler class.
     *
     * The name includes the number of handlers and whether file system caching is used.
     * If the cache handler is not configured yet, it will return a string indicating so.
     *
     * This property is primarily intended for debugging purposes
     * and its visibility is controlled by the `NEXT_PRIVATE_DEBUG_CACHE` environment variable.
     *
     * @returns A string describing the cache handler configuration.
     *
     * @example
     * ```js
     * // cache-handler.mjs
     * CacheHandler.onCreation(async () => {
     *   const redisHandler = await createRedisHandler({
     *    client,
     *   });
     *
     *   const localHandler = createLruHandler();
     *
     *   return {
     *     handlers: [redisHandler, localHandler],
     *   };
     * });
     *
     * // after the Next.js called the onCreation hook
     * console.log(CacheHandler.name);
     * // Output: "@neshca/cache-handler with 2 Handlers"
     * ```
     */
    static get name(): string {
        if (CacheHandler.#cacheListLength === undefined) {
            return '@neshca/cache-handler is not configured yet';
        }

        return `@neshca/cache-handler with ${CacheHandler.#cacheListLength} Handler${
            CacheHandler.#cacheListLength > 1 ? 's' : ''
        }`;
    }

    static #context: FileSystemCacheContext;

    static #mergedHandler: Omit<Handler, 'name'>;

    static #cacheListLength: number;

    static #debug = typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== 'undefined';

    // Default stale age is 1 year in seconds
    static #defaultStaleAge = 60 * 60 * 24 * 365;

    static #estimateExpireAge: (staleAge: number) => number;

    static #fallbackFalseRoutes = new Set<string>();

    static #onCreationHook: OnCreationHook;

    static #serverDistDir: string;

    static async #readPagesRouterPage(cacheKey: string): Promise<CacheHandlerValue | null> {
        let cacheHandlerValue: CacheHandlerValue | null = null;
        let pageHtmlHandle: fsPromises.FileHandle | null = null;

        try {
            const pageHtmlPath = path.join(CacheHandler.#serverDistDir, 'pages', `${cacheKey}.html`);
            const pageDataPath = path.join(CacheHandler.#serverDistDir, 'pages', `${cacheKey}.json`);

            pageHtmlHandle = await fsPromises.open(pageHtmlPath, 'r');

            const [pageHtmlFile, { mtimeMs }, pageDataFile] = await Promise.all([
                pageHtmlHandle.readFile('utf-8'),
                pageHtmlHandle.stat(),
                fsPromises.readFile(pageDataPath, 'utf-8'),
            ]);

            const pageData = JSON.parse(pageDataFile) as object;

            cacheHandlerValue = {
                lastModified: mtimeMs,
                lifespan: null,
                tags: [],
                value: {
                    kind: 'PAGE',
                    html: pageHtmlFile,
                    pageData,
                    postponed: undefined,
                    headers: undefined,
                    status: undefined,
                },
            };
        } catch (_) {
            cacheHandlerValue = null;
        } finally {
            await pageHtmlHandle?.close();
        }

        return cacheHandlerValue;
    }

    static async #writePagesRouterPage(cacheKey: string, pageData: IncrementalCachedPageValue): Promise<boolean> {
        try {
            const pageHtmlPath = path.join(CacheHandler.#serverDistDir, 'pages', `${cacheKey}.html`);
            const pageDataPath = path.join(CacheHandler.#serverDistDir, 'pages', `${cacheKey}.json`);

            await fsPromises.mkdir(path.dirname(pageHtmlPath), { recursive: true });

            await Promise.all([
                fsPromises.writeFile(pageHtmlPath, pageData.html),
                fsPromises.writeFile(pageDataPath, JSON.stringify(pageData.pageData)),
            ]);

            return true;
        } catch (_error) {
            return false;
        }
    }

    /**
     * Returns the cache control parameters based on the last modified timestamp and revalidate option.
     *
     * @param lastModified The last modified timestamp in milliseconds.
     *
     * @param revalidate The revalidate option, representing the maximum age of stale data in seconds.
     *
     * @returns The cache control parameters including expire age, expire at, last modified at, stale age, stale at and revalidate.
     *
     * @remarks
     * - `lastModifiedAt` is the Unix timestamp (in seconds) for when the cache entry was last modified.
     * - `staleAge` is the time in seconds which equals to the `revalidate` option from Next.js pages.
     * If page has no `revalidate` option, it will be set to 1 year.
     * - `expireAge` is the time in seconds for when the cache entry becomes expired.
     * - `staleAt` is the Unix timestamp (in seconds) for when the cache entry becomes stale.
     * - `expireAt` is the Unix timestamp (in seconds) for when the cache entry must be removed from the cache.
     * - `revalidate` is the value from Next.js revalidate option.
     * May be false if the page has no revalidate option or the revalidate option is set to false.
     */
    static #getLifespanParameters(lastModified: number, revalidate?: Revalidate): LifespanParameters {
        const lastModifiedAt = Math.floor(lastModified / 1000);
        const staleAge = revalidate || CacheHandler.#defaultStaleAge;
        const staleAt = lastModifiedAt + staleAge;
        const expireAge = CacheHandler.#estimateExpireAge(staleAge);
        const expireAt = lastModifiedAt + expireAge;

        return { expireAge, expireAt, lastModifiedAt, revalidate, staleAge, staleAt };
    }

    /**
     * Registers a hook to be called during the creation of an CacheHandler instance.
     * This method allows for custom cache configurations to be applied at the time of cache instantiation.
     *
     * The provided {@link OnCreationHook} function can perform initialization tasks, modify cache settings,
     * or integrate additional logic into the cache creation process. This function can either return a {@link CacheHandlerConfig}
     * object directly for synchronous operations, or a `Promise` that resolves to a {@link CacheHandlerConfig} for asynchronous operations.
     *
     * Usage of this method is typically for advanced scenarios where default caching behavior needs to be altered
     * or extended based on specific application requirements or environmental conditions.
     *
     * @param onCreationHook - The {@link OnCreationHook} function to be called during cache creation.
     *
     * @since 1.0.0
     */
    static onCreation(onCreationHook: OnCreationHook): void {
        CacheHandler.#onCreationHook = onCreationHook;
    }

    static async #configureCacheHandler(): Promise<void> {
        if (CacheHandler.#mergedHandler) {
            return;
        }

        const { serverDistDir, dev } = CacheHandler.#context;

        let buildId: string | undefined;

        try {
            buildId = await fsPromises.readFile(path.join(serverDistDir, '..', 'BUILD_ID'), 'utf-8');
        } catch (_error) {
            buildId = undefined;
        }
        // Retrieve cache configuration by invoking the onCreation hook with the provided context
        const config = CacheHandler.#onCreationHook({ serverDistDir, dev, buildId });

        // Wait for the cache configuration to be resolved
        const { handlers, ttl = {} } = await config;

        const { defaultStaleAge, estimateExpireAge } = ttl;

        if (typeof defaultStaleAge === 'number') {
            CacheHandler.#defaultStaleAge = Math.floor(defaultStaleAge);
        }

        CacheHandler.#estimateExpireAge = createValidatedAgeEstimationFunction(estimateExpireAge);

        CacheHandler.#serverDistDir = serverDistDir;

        // Notify the user that the cache is not used in development mode
        if (dev) {
            console.warn('Next.js does not use the cache in development mode. Use production mode to enable caching.');
        }

        try {
            const prerenderManifestData = await fsPromises.readFile(
                path.join(serverDistDir, '..', 'prerender-manifest.json'),
                'utf-8',
            );

            const prerenderManifest = JSON.parse(prerenderManifestData) as PrerenderManifest;

            for (const [route, { srcRoute, dataRoute }] of Object.entries(prerenderManifest.routes)) {
                const isPagesRouter = dataRoute?.endsWith('.json');

                if (isPagesRouter && prerenderManifest.dynamicRoutes[srcRoute || '']?.fallback === false) {
                    CacheHandler.#fallbackFalseRoutes.add(route);
                }
            }
        } catch (_error) {}

        const handlersList: Handler[] = handlers.filter((handler): handler is Handler => Boolean(handler));

        CacheHandler.#cacheListLength = handlersList.length;

        CacheHandler.#mergedHandler = {
            async get(key, meta) {
                for await (const handler of handlersList) {
                    try {
                        let cacheHandlerValue = await handler.get(key, meta);

                        if (
                            cacheHandlerValue?.lifespan &&
                            cacheHandlerValue.lifespan.expireAt < Math.floor(Date.now() / 1000)
                        ) {
                            cacheHandlerValue = null;
                            await handler.delete?.(key).catch((deleteError) => {
                                if (CacheHandler.#debug) {
                                    console.warn(
                                        `Handler "${handler.name}" failed to delete value for key "${key}".`,
                                        deleteError,
                                    );
                                }
                            });
                        }

                        if (CacheHandler.#debug) {
                            console.info(`get from "${handler.name}"`, key, Boolean(cacheHandlerValue));
                        }

                        return cacheHandlerValue;
                    } catch (error) {
                        if (CacheHandler.#debug) {
                            console.warn(`Handler "${handler.name}" failed to get value for key "${key}".`, error);
                        }
                    }
                }

                return null;
            },
            async set(key, cacheHandlerValue) {
                await Promise.all(
                    handlersList.map((handler) => {
                        try {
                            return handler.set(key, {
                                lastModified: cacheHandlerValue.lastModified,
                                lifespan: cacheHandlerValue.lifespan,
                                tags: cacheHandlerValue.tags,
                                value: cacheHandlerValue.value,
                                age: cacheHandlerValue.age,
                                cacheState: cacheHandlerValue.cacheState,
                            });
                        } catch (error) {
                            if (CacheHandler.#debug) {
                                console.warn(`Handler "${handler.name}" failed to set value for key "${key}".`, error);
                            }
                        }

                        return Promise.resolve();
                    }),
                );
            },
            async revalidateTag(tag) {
                await Promise.all(
                    handlersList.map((handler) => {
                        try {
                            return handler.revalidateTag(tag);
                        } catch (error) {
                            if (CacheHandler.#debug) {
                                console.warn(`Handler "${handler.name}" failed to revalidate tag "${tag}".`, error);
                            }
                        }

                        return Promise.resolve();
                    }),
                );
            },
        };
    }

    private constructor(context: FileSystemCacheContext) {
        CacheHandler.#context = context;
    }

    async get(
        cacheKey: CacheHandlerParametersGet[0],
        ctx: CacheHandlerParametersGet[1] = {},
    ): Promise<CacheHandlerValue | null> {
        await CacheHandler.#configureCacheHandler();

        const { tags = [], kindHint, softTags = [] } = ctx;

        let cachedData: CacheHandlerValue | null | undefined = await CacheHandler.#mergedHandler.get(cacheKey, {
            implicitTags: softTags,
        });

        if (cachedData?.value?.kind === 'ROUTE') {
            cachedData.value.body = Buffer.from(cachedData.value.body as unknown as string, 'base64');
        }

        if (!cachedData && CacheHandler.#fallbackFalseRoutes.has(cacheKey)) {
            cachedData = await CacheHandler.#readPagesRouterPage(cacheKey);

            if (CacheHandler.#debug) {
                console.info('get from file system', cacheKey, tags, kindHint, 'got any value', Boolean(cachedData));
            }

            // if we have a value from the file system, we should set it to the cache store
            if (cachedData) {
                await CacheHandler.#mergedHandler.set(cacheKey, cachedData);
            }
        }

        return cachedData ?? null;
    }

    async set(
        cacheKey: CacheHandlerParametersSet[0],
        incrementalCacheValue: CacheHandlerParametersSet[1],
        ctx: CacheHandlerParametersSet[2],
    ): Promise<void> {
        await CacheHandler.#configureCacheHandler();

        const { revalidate, tags = [] } = ctx;

        const lastModified = Date.now();

        const hasFallbackFalse = CacheHandler.#fallbackFalseRoutes.has(cacheKey);

        const lifespan = hasFallbackFalse ? null : CacheHandler.#getLifespanParameters(lastModified, revalidate);

        let cacheHandlerValueTags = tags;

        let value = incrementalCacheValue;

        switch (value?.kind) {
            case 'PAGE': {
                cacheHandlerValueTags = getTagsFromPageData(value);
                break;
            }
            case 'ROUTE': {
                // create a new object to avoid mutating the original value
                value = {
                    // replace the body with a base64 encoded string to save space
                    body: value.body.toString('base64') as unknown as Buffer,
                    headers: value.headers,
                    kind: value.kind,
                    status: value.status,
                };

                break;
            }
            default: {
                break;
            }
        }

        const cacheHandlerValue: CacheHandlerValue = {
            lastModified,
            lifespan,
            tags: Object.freeze(cacheHandlerValueTags),
            value,
        };

        await CacheHandler.#mergedHandler.set(cacheKey, cacheHandlerValue);

        if (CacheHandler.#debug) {
            console.info('set to external cache store', cacheKey);
        }

        if (hasFallbackFalse && cacheHandlerValue.value?.kind === 'PAGE') {
            const wasWritten = await CacheHandler.#writePagesRouterPage(cacheKey, cacheHandlerValue.value);

            if (CacheHandler.#debug && !wasWritten) {
                console.warn('Unable to write to the file system', cacheKey);
            }

            if (CacheHandler.#debug && wasWritten) {
                console.info('set to file system', cacheKey);
            }
        }
    }

    async revalidateTag(tag: CacheHandlerParametersRevalidateTag[0]): Promise<void> {
        await CacheHandler.#configureCacheHandler();

        const tags = typeof tag === 'string' ? [tag] : tag;

        if (CacheHandler.#debug) {
            console.info('revalidateTag', tag);
        }

        for (const tag of tags) {
            await CacheHandler.#mergedHandler.revalidateTag(tag);
        }

        if (CacheHandler.#debug) {
            console.info('updated external revalidated tags');
        }
    }

    resetRequestCache(): void {
        // not implemented yet
    }
}
