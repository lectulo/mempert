// Compatibility facade for Telegram callers. Configuration is OUTBOUND_PROXY_URL only.
export {
  outboundFetch as telegramFetch,
  validateOutboundProxyUrl as validateTelegramProxyUrl,
  telegramClientOptions,
} from "./outboundproxy";
