export interface Command<TPayload = unknown> {
  readonly kind: string;
  readonly payload: TPayload;
}

export interface CommandHandler<TCommand extends Command, TResult = void> {
  execute(command: TCommand): Promise<TResult>;
}

export type CommandResult<T> = {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
};
