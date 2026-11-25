import { autoRetry } from "@grammyjs/auto-retry";
import { Api, BotError, GrammyError, HttpError } from "grammy";
import { telegramClientOptions } from "./telegramproxy";

// On 429 Telegram returns retry_after: wait for it instead of failing (up to a minute).
export const retryOn429 = () => autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 });

// Use only static labels at call sites. grammY errors can contain bot tokens,
// signed media URLs and user content in their descriptions, payloads or causes.
export function logTelegramFailure(operation: string, failure: unknown) {
  const error = failure instanceof BotError ? failure.error : failure;
  if (error instanceof GrammyError && Number.isInteger(error.error_code)) {
    console.error(operation, "Telegram API error", error.error_code);
  } else {
    console.error(operation, error instanceof HttpError ? "Telegram transport error" : "unexpected error");
  }
}

export function botApi(token: string) {
  const api = new Api(token, telegramClientOptions());
  api.config.use(retryOn429());
  return api;
}
