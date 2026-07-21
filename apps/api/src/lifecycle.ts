export interface StartServerOptions {
  listen(): Promise<unknown>;
  close(): Promise<unknown>;
  onListenError(error: unknown): void;
  onCloseError?(error: unknown): void;
}

export async function startServer(options: StartServerOptions): Promise<void> {
  try {
    await options.listen();
  } catch (error) {
    options.onListenError(error);
    const [closeResult] = await Promise.allSettled([options.close()]);
    if (closeResult?.status === "rejected") options.onCloseError?.(closeResult.reason);
    throw error;
  }
}
