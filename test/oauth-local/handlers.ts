// This entrypoint is bundled only into this test's scratch directory.
export { default as OAuthProvider } from "@cloudflare/workers-oauth-provider";
export { oauthOptions, handleAuthorize } from "../../src/oauth";
export { handleApp } from "../../src/webapp";
