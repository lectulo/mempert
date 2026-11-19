import { env } from "cloudflare:test";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { BATCH_COMMANDS, syncCommands } from "../src/botcommands";

describe("syncCommands", () => {
  it("sets menus once and skips when nothing changed", async () => {
    await env.DB.prepare("INSERT INTO users (id, role, lang) VALUES (5, 'admin', 'ru')").run();
    const api = {
      setMyCommands: vi.fn(async (..._args: Parameters<Api["setMyCommands"]>) => true),
      deleteMyCommands: vi.fn(async () => true),
      setChatMenuButton: vi.fn(async () => true),
      setMyDescription: vi.fn(async () => true),
      setMyShortDescription: vi.fn(async () => true),
    };
    expect(await syncCommands(env, api as unknown as Api)).toBe(true);
    expect(api.setMyCommands).toHaveBeenCalledTimes(3);
    expect(api.setMyDescription).toHaveBeenCalledWith(expect.stringContaining("Нажмите «Начать»"), { language_code: "ru" });
    expect(api.setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: "web_app", text: "Open App", web_app: { url: expect.stringMatching(/^https:\/\/[^/]+\/$/) } },
    });
    expect(api.setMyCommands).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ command: "grant", description: "Дать доступ" }]),
      { scope: { type: "chat", chat_id: 5 } },
    );
    expect(await syncCommands(env, api as unknown as Api)).toBe(false);
    expect(api.setMyCommands).toHaveBeenCalledTimes(3);

    const disabled = { ...env, BATCH_ENABLED: "false" };
    expect(await syncCommands(disabled, api as unknown as Api)).toBe(true);
    expect(api.setMyCommands).toHaveBeenCalledTimes(6);
    for (const index of [0, 1, 2]) {
      const [enabledCommands] = api.setMyCommands.mock.calls[index];
      const [disabledCommands] = api.setMyCommands.mock.calls[index + 3];
      expect(enabledCommands.map(({ command }) => command)).toEqual(expect.arrayContaining([...BATCH_COMMANDS, "batch_zip"]));
      expect(disabledCommands).toEqual(enabledCommands.filter(({ command }) => !BATCH_COMMANDS.includes(command)));
      expect(disabledCommands.map(({ command }) => command)).toContain("batch_zip");
    }
    expect(api.setMyDescription).toHaveBeenNthCalledWith(3, expect.stringContaining("Import ZIP archives"), { language_code: undefined });
    expect(api.setMyDescription).toHaveBeenNthCalledWith(4, expect.stringContaining("Импортируйте ZIP-архивы"), { language_code: "ru" });
    expect(await syncCommands(disabled, api as unknown as Api)).toBe(false);
    expect(await syncCommands(env, api as unknown as Api)).toBe(true);
  });
});
