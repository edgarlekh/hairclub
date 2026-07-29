/**
 * Аккаунты сотрудниц: хеширование паролей и разрешения.
 * Пароль нигде не хранится в открытом виде — только PBKDF2-отпечаток с солью.
 */

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// PBKDF2-SHA256, 100k итераций — медленно подбирать, быстро проверять один раз
export async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  const { hash } = await hashPassword(password, saltHex);
  // Сравнение постоянного времени, чтобы не утекала длина совпадения
  if (hash.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

// Права по умолчанию для новой сотрудницы. Отчёты салона не входят сюда никогда.
export const DEFAULT_PERMS = {
  scope: "own",   // 'own' — только свои записи, 'all' — всех мастеров
  edit: true,     // записывать и менять записи
  phone: true,    // видеть телефон клиента в своей записи
  prices: false,  // видеть суммы в записях
  revenue: false, // видеть свою выручку
  schedule: false,// редактировать свой график
  visit: true,    // заполнять формулу, фото до/после, материалы
};

export function parsePerms(json) {
  let p = {};
  try { p = json ? JSON.parse(json) : {}; } catch { p = {}; }
  return { ...DEFAULT_PERMS, ...p };
}

/**
 * Определяем, кто обращается к API.
 * Владелица — по мастер-ключу ADMIN_TOKEN. Сотрудница — по токену сессии из staff_accounts.
 */
export async function resolveAuth(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!token) return null;
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    return { role: "owner" };
  }
  const acc = await env.DB
    .prepare("SELECT id, employee_id, role, permissions, active FROM staff_accounts WHERE token = ?")
    .bind(token)
    .first();
  if (!acc || !acc.active) return null;
  return {
    role: acc.role || "staff",
    accountId: acc.id,
    employeeId: acc.employee_id,
    perms: parsePerms(acc.permissions),
  };
}
