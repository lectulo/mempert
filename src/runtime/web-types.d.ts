// Preserve the application's existing typed JSON calls while using Bun's Web APIs.
interface Body { json<T = unknown>(): Promise<T>; }
interface Request { json<T = unknown>(): Promise<T>; }
interface Response { json<T = unknown>(): Promise<T>; }
