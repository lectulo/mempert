import { autoRetry } from "@grammyjs/auto-retry";
import { Api } from "grammy";
import { telegramClientOptions } from "./telegramproxy";

// On 429 Telegram returns retry_after: wait for it instead of failing (up to a minute).
export const retryOn429 = () => autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 });

export function botApi(token: string) {
  const api = new Api(token, telegramClientOptions());
  api.config.use(retryOn429());
  return api;
}
