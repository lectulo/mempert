import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { albumZip } from "./albumzip";
import { albumMemes } from "./channels";
import type { Meme } from "./db";
import type { Env } from "./env";
import { esc, langOf, t, type Key, type Lang } from "./i18n";
import { cachedMedia, extOf, memeMedia, mediaResponse, toDataUrl } from "./media";
import { CSS } from "./uploadpage";
import { fileFits } from "./webapp";

const base = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
const mimeOf = (m: Meme) => m.mime ?? (m.kind === "photo" ? "image/jpeg" : "video/mp4");
const pageUrl = (env: Env, m: Meme) => `${base(env)}/s/${m.share_id}`;
const fileUrl = (env: Env, m: Meme) => (fileFits(m) ? `${base(env)}/d/${m.share_id}.${extOf(mimeOf(m))}` : null);
const titleOf = (m: Meme, lang: Lang) => m.title ?? t(lang, `share_${m.kind}`);

/** Public links of a meme; the first call makes the meme public (gives it a share id). */
export async function shareLinks(env: Env, meme: Meme) {
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("base64url");
  meme.share_id = await env.DB.prepare("UPDATE memes SET share_id = COALESCE(share_id, ?) WHERE id = ? RETURNING share_id")
    .bind(sid, meme.id)
    .first<string>("share_id");
  return { page: pageUrl(env, meme), file: fileUrl(env, meme) };
}

/** GET /s/<sid> (page), /s/<sid>/og.png (preview image), /s/<sid>/zip (all pages of a comic), /d/<sid>.<ext> (file) — public, no login. */
export async function handleShare(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [, route, name = "", sub] = new URL(req.url).pathname.split("/");
  const sid = route === "d" ? name.split(".")[0] : name;
  // The meme is looked up before the edge cache, so a deleted meme is gone at once.
  const meme = sid ? await env.DB.prepare("SELECT * FROM memes WHERE share_id = ?").bind(sid).first<Meme>() : null;
  const kind = route === "d" && !sub ? "file" : route === "s" && !sub ? "page" : route === "s" && sub === "og.png" ? "og" : null;
  if (meme && route === "s" && sub === "zip") {
    const pages = await comicPages(env, meme);
    return pages.length ? albumZip(env, pages.filter(fileFits), titleOf(meme, "en"), meme.porn ? { "X-Robots-Tag": "noindex" } : {}) : new Response("Not found", { status: 404 });
  }
  if (!meme || !kind || (kind === "file" && !fileFits(meme))) return new Response("Not found", { status: 404 });
  if (kind === "page") return page(env, meme, langOf({ language_code: req.headers.get("Accept-Language") ?? undefined }), await comicPages(env, meme));
  return cachedMedia(req, ctx, async () => {
    if (kind === "og") return ogImage(env, meme);
    const response = await mediaResponse(env, meme, "file", req).catch(() => null);
    if (response && meme.porn) response.headers.set("X-Robots-Tag", "noindex");
    return response;
  }, kind === "og" ? 86400 : 3600);
}

/** All pages of the comic whose cover is `m` (each one gets a share id: a public cover makes the comic public); empty otherwise. */
async function comicPages(env: Env, m: Meme) {
  const pages = await albumMemes(env.DB, m.id);
  if (pages[0]?.album_layout !== "comic" || pages[0].id !== m.id) return [];
  // One query for all pages without a share id (a big comic has hundreds).
  const ids = pages.filter((p) => !p.share_id).map((p) => p.id);
  if (ids.length) {
    const { results } = await env.DB.prepare(
      "UPDATE memes SET share_id = COALESCE(share_id, lower(hex(randomblob(6)))) WHERE id IN (SELECT value FROM json_each(?)) RETURNING id, share_id",
    )
      .bind(JSON.stringify(ids))
      .all<{ id: string; share_id: string }>();
    const sid = new Map(results.map((r) => [r.id, r.share_id]));
    for (const p of pages) p.share_id ??= sid.get(p.id) ?? null;
  }
  return pages;
}

// Media loads when near the screen; its size keeps the page from jumping. Comic animations play only on screen (data-play).
const pageMedia = (env: Env, m: Meme, title: string, comic = false) => {
  const file = fileUrl(env, m);
  const size = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : "";
  const lazy = ` loading="lazy" decoding="async"`;
  return !file
    ? `<img src="${pageUrl(env, m)}/og.png" alt="${title}"${lazy}>`
    : m.kind === "photo" || m.mime === "image/gif" // an imported GIF file plays only as an image
      ? `<img src="${file}" alt="${title}"${size}${lazy}>`
      : `<video src="${file}" controls playsinline preload="none"${size}${m.kind === "animation" ? `${comic ? " data-play" : " autoplay"} loop muted` : ""}></video>`;
};

function page(env: Env, m: Meme, lang: Lang, pages: Meme[] = []) {
  const s = (key: Key) => esc(t(lang, key));
  const title = attr(titleOf(m, lang));
  const file = fileUrl(env, m);
  const og = `${pageUrl(env, m)}/og.png`;
  const porn = [m, ...pages].some((x) => x.porn); // 18+ gate: the media loads only after a click, no preview for link bots
  const texts = (x: Meme): [Key, string | null][] => [
    ["share_text", x.ocr_text],
    ["share_speech", x.speech_text],
    ["share_description", x.description],
    ["share_context", x.meme_context],
    ["share_meaning", x.cultural_meaning],
  ];
  const html_ = (list: [Key, string | null][]) =>
    list
      .filter(([, value]) => value)
      .map(([key, value]) => `<div class="cf-stack" data-gap="sm"><h2 class="cf-heading cf-heading--4">${s(key)}</h2><p class="cf-text pre">${esc(value!)}</p></div>`)
      .join("\n      ");
  const download = (x: Meme) => (fileUrl(env, x) ? `<div><a class="cf-button" href="${fileUrl(env, x)}" download>${s("share_download")}</a></div>` : "");
  // A comic: every page with its own texts and download under it; the texts at the bottom are of the whole comic
  const media = pages.length
    ? pages
        .map((p, i) => {
          const name = [t(lang, "share_page", { n: i + 1 }), p.title].filter(Boolean).join(" · ");
          return `<div class="stage">${pageMedia(env, p, title, true)}</div><details class="cf-stack"><summary class="cf-text cf-text--muted">${esc(name)}</summary>${html_(texts(p))}${download(p)}</details>`;
        })
        .join("")
    : pageMedia(env, m, title);
  const sections: [Key, string | null][] = [
    ...(pages.length ? [] : texts(m)),
    ["share_source", m.source],
    ["share_saved", m.saved_at ? new Date(m.saved_at * 1000).toLocaleString(lang) : null],
  ];
  const tags = [...new Set((pages.length ? pages : [m]).flatMap((x) => (x.tags ? x.tags.split("\n").filter(Boolean) : [])))];
  const video = !porn && file && m.kind !== "photo" ? `<meta property="og:video" content="${file}"><meta property="og:video:type" content="${attr(mimeOf(m))}">` : "";
  const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title}</title>
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="memereserve">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${attr((m.description ?? m.caption ?? "").slice(0, 200))}">
  <meta property="og:url" content="${pageUrl(env, m)}">
  ${porn ? "" : `<meta property="og:image" content="${og}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">`}
  ${video}
  <link rel="stylesheet" href="${CSS}">
  <style>.stage{display:grid;place-items:center;background:#09090b;border-radius:var(--cf-radius-lg);overflow:hidden}.stage img,.stage video{max-inline-size:100%;block-size:auto;max-block-size:80vh;object-fit:contain}.pre{white-space:pre-wrap}.comic{gap:4px}.comic img{inline-size:100%;max-block-size:none}</style>
</head>
<body>
  <main class="cf-container cf-container--narrow cf-section">
    <div class="cf-stack">
      <h1 class="cf-heading cf-heading--2">${title}</h1>
      ${pages.length ? `<p class="cf-text cf-text--muted">${esc(t(lang, "share_pages", { n: pages.length }))}</p>` : ""}
      <div class="${pages.length ? "cf-stack comic" : "stage"}" id="stage">${
        porn ? `<template id="media">${media}</template><button class="cf-button" id="show">${lang === "ru" ? "18+ — показать" : "18+ — show"}</button>` : media
      }</div>
      ${pages.length ? `<script>var io=new IntersectionObserver((es)=>es.forEach((e)=>e.isIntersecting?e.target.play().catch(()=>{}):e.target.pause()));var watch=()=>document.querySelectorAll("video[data-play]").forEach((v)=>io.observe(v));watch()</script>` : ""}
      ${porn ? `<script>show.onclick=()=>(stage.replaceChildren(media.content),self.watch?.())</script>` : ""}
      ${tags.length ? `<div class="cf-inline">${tags.map((tag) => `<span class="cf-tag">#${esc(tag)}</span>`).join(" ")}</div>` : ""}
      ${html_(sections)}
      ${pages.length ? `<div><a class="cf-button" href="${pageUrl(env, m)}/zip" download>${s("share_download_all")}</a></div>` : download(m)}
      <p class="cf-text cf-text--muted cf-text--sm"><a href="${base(env)}/bot">${s("share_footer")}</a></p>
    </div>
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// Keep the native package external to Bun's server bundle: its platform .node file
// is resolved from node_modules at runtime, not embedded as Workers WASM.
const requireNative = createRequire(import.meta.url);
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Conservative line wrapping for the fixed-size preview card (Latin and Cyrillic). */
function titleLines(title: string) {
  const words = title.replace(/\s+/g, " ").trim().match(/\S{1,17}/gu) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > 17) { lines.push(line); line = ""; }
    line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).map((line, i) => i === 3 && lines.length > 4 ? line.slice(0, 16) + "…" : line);
}

/** A real PNG response using native resvg; exported for offline renderer checks. */
export function renderOgCard(title: string, tags: string[], host: string, src: string | null, fallback: string) {
  const { Resvg } = requireNative("@resvg/resvg-js") as typeof import("@resvg/resvg-js");
  const lines = titleLines(title);
  let x = 630, y = 100 + lines.length * 64;
  const badges = tags.slice(0, 4).map(tag => {
    const label = "#" + tag.slice(0, 27), width = Math.min(522, label.length * 17 + 36);
    if (x + width > 1152) { x = 630; y += 55; }
    if (y > 460) return "";
    const badge = `<rect x="${x}" y="${y}" width="${width}" height="42" rx="21" fill="#082f49"/><text x="${x + 18}" y="${y + 29}" font-size="26" fill="#38bdf8">${xml(label)}</text>`;
    x += width + 12;
    return badge;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
    <defs><clipPath id="preview"><rect x="48" y="48" width="534" height="534" rx="24"/></clipPath><clipPath id="details"><rect x="630" y="48" width="522" height="534"/></clipPath></defs>
    <rect width="1200" height="630" fill="#18181b"/>
    <rect x="48" y="48" width="534" height="534" rx="24" fill="#09090b" stroke="#3f3f46"/>
    <g font-family="Manrope" fill="#e4e4e7">
      ${src ? `<image x="48" y="48" width="534" height="534" preserveAspectRatio="xMidYMid meet" clip-path="url(#preview)" xlink:href="${xml(src)}"/>` : `<text x="315" y="330" text-anchor="middle" font-size="40" fill="#a1a1aa">${xml(fallback)}</text>`}
      <g clip-path="url(#details)">
        ${lines.map((line, i) => `<text x="630" y="${100 + i * 64}" font-size="56" font-weight="700">${xml(line)}</text>`).join("")}
        ${badges}
        <text x="630" y="538" font-size="40" font-weight="700" fill="#38bdf8">memereserve</text>
        <text x="630" y="578" font-size="26" fill="#a1a1aa">${xml(host)}</text>
      </g>
    </g>
  </svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: false, defaultFontFamily: "Manrope", fontFiles: [
    resolve("analyze/fonts/Manrope-Medium.ttf"), resolve("analyze/fonts/Manrope-Bold.ttf"),
  ] } }).render().asPng();
  return new Response(Uint8Array.from(png), { headers: { "Content-Type": "image/png" } });
}

/** 1200×630 preview card in the memereserve design (dark design-system tokens). */
async function ogImage(env: Env, m: Meme) {
  const preview = await memeMedia(env, m, "preview").catch(() => null);
  const src = preview && /^image\/(jpeg|png)$/.test(preview.mime) ? toDataUrl(preview) : null;
  const tags = (m.tags ?? "").split("\n").filter(Boolean).slice(0, 4);
  const title = titleOf(m, "en");
  return renderOgCard(title, tags, new URL(env.PUBLIC_URL).host, src, t("en", `share_${m.kind}`));
}
