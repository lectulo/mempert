import type { Api } from "grammy";
import { batchEnabled } from "./batchmode";
import { sha256hex } from "./cache";
import type { Role } from "./db";
import type { Env } from "./env";
import { publicWebAppUrl } from "./telegramurl";
import { t, type Key, type Lang } from "./i18n";

export const BATCH_COMMANDS = ["batch", "batch_finish", "batch_cancel", "batch_status", "batch_retry"];
const userCommands = (batch: boolean) => ["start", "help", "feed", "pair", "stats", "settings", /* "key", */ "batch_zip", ...(batch ? BATCH_COMMANDS : []), "export", "delete", "delete_all", "channels", "e621", "mcp", "subscribe", "balance", "paysupport", "terms", "about"];
const adminCommands = (batch: boolean) => [...userCommands(batch), "grant", "revoke", "users"];

const list = (names: string[], lang: Lang) =>
  names.map((command) => ({ command, description: t(lang, `cmd_${command}` as Key) }));

/** Shows admin commands in an admin's chat menu, or resets the menu to the default one. */
export async function setCommandScope(env: Env, api: Api, chatId: number, role: Role, lang: string | null) {
  const scope = { type: "chat", chat_id: chatId } as const;
  if (role === "admin") await api.setMyCommands(list(adminCommands(batchEnabled(env)), lang === "ru" ? "ru" : "en"), { scope });
  else await api.deleteMyCommands({ scope });
}

/** Sets bot command menus when the command list or texts changed since the last sync. */
export async function syncCommands(env: Env, api: Api) {
  const batch = batchEnabled(env);
  const user = userCommands(batch);
  const admin = adminCommands(batch);
  const appUrl = `${env.PUBLIC_URL.replace(/\/$/, "")}/`;
  const webApp = publicWebAppUrl(env);
  const about = (lang: Lang) => [t(lang, "bot_description"), t(lang, "bot_short_description")];
  const hash = await sha256hex(JSON.stringify([list(admin, "en"), list(admin, "ru"), appUrl, about("en"), about("ru")]));
  const old = await env.DB.prepare("SELECT value FROM meta WHERE key = 'commands_hash'").first<string>("value");
  if (old === hash) return false;

  await api.setChatMenuButton({ menu_button: webApp
    ? { type: "web_app", text: "Open App", web_app: { url: appUrl } }
    : { type: "commands" } });
  await api.setMyCommands(list(user, "en"));
  await api.setMyCommands(list(user, "ru"), { language_code: "ru" });
  for (const lang of ["en", "ru"] as const) {
    const language_code = lang === "ru" ? "ru" : undefined;
    const [description, short_description] = about(lang);
    await api.setMyDescription(description, { language_code });
    await api.setMyShortDescription(short_description, { language_code });
  }
  const { results } = await env.DB.prepare("SELECT id, lang FROM users WHERE role = 'admin'").all<{
    id: number;
    lang: string | null;
  }>();
  for (const a of results) await setCommandScope(env, api, a.id, "admin", a.lang).catch(console.error);

  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('commands_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(hash)
    .run();
  return true;
}
