export type Store = { all<T>(sql: string): Promise<T[]>; run(sql: string, ...args: unknown[]): Promise<void> };
/** A fresh migrated in-memory store for one test. */
export declare function testStore(): Promise<Store>;
