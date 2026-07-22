/**
 * Подписанные ссылки на фотографии визитов.
 *
 * Тег <img> не умеет слать заголовок с админ-токеном, а bucket намеренно закрыт:
 * снимки клиентов не должны открываться всем, кто угадает адрес. Поэтому список фото
 * отдаётся уже с подписью и сроком годности, а сам файл проверяет подпись и отдаётся
 * без токена.
 *
 * Класть админ-токен прямо в адрес нельзя — он утечёт в историю браузера,
 * логи и заголовок Referer.
 */

const PREFIX = "r2:";                 // так помечаем файлы в своём хранилище
const TTL_SECONDS = 24 * 60 * 60;     // сутки: панель успеет поработать, ссылка из логов протухнет

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(mac).slice(0, 32);
}

/** Сравнение без утечки времени: обычное === выдаёт позицию первого несовпадения. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const isStoredPhoto = (url) => typeof url === "string" && url.startsWith(PREFIX);
export const toStoredPhoto = (key) => PREFIX + key;
export const storedKey = (url) => String(url).slice(PREFIX.length);

/**
 * Превращает «r2:visits/12/abc.jpg» в абсолютную ссылку с подписью.
 * Внешние ссылки (фото, перенесённые из Bumpix) возвращаются как есть.
 */
export async function presentPhotoUrl(photoUrl, request, env) {
  if (!isStoredPhoto(photoUrl)) return photoUrl;
  const key = storedKey(photoUrl);
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const sig = await sign(`${key}|${exp}`, env.ADMIN_TOKEN);
  return `${new URL(request.url).origin}/api/photos/${key}?exp=${exp}&sig=${sig}`;
}

/** Проставляет подписанные ссылки во всех записях списка (поле photo_url). */
export async function presentPhotos(rows, request, env) {
  return Promise.all(
    rows.map(async (r) => ({ ...r, photo_url: await presentPhotoUrl(r.photo_url, request, env) }))
  );
}

export async function isSignatureValid(key, exp, sig, env) {
  if (!exp || !sig) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  return safeEqual(sig, await sign(`${key}|${exp}`, env.ADMIN_TOKEN));
}
