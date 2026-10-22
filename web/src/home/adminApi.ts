// Phone admin <-> TV (TV Hub AdminServer, port 8080). Logging in gives an HttpOnly session cookie that the browser
// sends by itself; the password is only sent to log in or to change it (AUDIT S4/S5). The TV refuses files outside
// its allow-list. A 401 (session expired) raises "admin:expired" so the page returns to the login screen.

const expired = () => window.dispatchEvent(new CustomEvent('admin:expired'));

export const fetchJson = async <T,>(url: string, fallback: T): Promise<T> => {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 401) expired();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (error) {
    console.warn(`Failed to load ${url}`, error);
    return fallback;
  }
};

/** Arabic-Indic / Persian digits (common on Arabic phone keyboards) become 0-9; spaces around are dropped. */
export const normalizeSecret = (v: string): string =>
  v.trim().replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));

/**
 * Passwords travel in request headers, which browsers refuse for non-Latin characters (the request then fails
 * before it leaves the phone). Values are therefore sent URI-encoded; the TV decodes them (AdminServer.secret).
 */
const encodeHeaders = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, encodeURIComponent(normalizeSecret(v))]));

/** The session cookie does the authentication; kept so callers stay unchanged. */
export const authHeaders = (): Record<string, string> => ({});

export const postJson = async <T,>(url: string, headers: Record<string, string>): Promise<T> => {
  const res = await fetch(url, { method: 'POST', headers: encodeHeaders(headers), cache: 'no-store' });
  return (await res.json()) as T;
};

// Writes one file on the TV: data/*.json, today_images/ or user_icons/ (the TV refuses anything else).
export const uploadToServer = async (folder: string, file: File | Blob, filename: string) => {
  const dir = folder.replace(/^\/+/, '');
  const res = await fetch(`/api/file/write?${new URLSearchParams({ dir, name: filename })}`, {
    method: 'POST',
    headers: authHeaders(),
    body: file,
  });
  if (res.status === 401) { expired(); throw new Error('401'); }
  const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !result.ok) throw new Error(result.error ? `رفض التلفزيون الملف (${result.error})` : `تعذر حفظ الملف (${res.status})`);
};

export const writeJsonToServer = async (folder: string, filename: string, payload: unknown) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  await uploadToServer(folder, blob, filename);
};

export const deleteServerFile = async (folder: string, filename: string) => {
  const dir = folder.replace(/^\/+/, '');
  const res = await fetch(`/api/file/delete?${new URLSearchParams({ dir, name: filename })}`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (res.status === 401) { expired(); throw new Error('401'); }
  if (!res.ok) throw new Error(`تعذر حذف الملف (${res.status})`);
};

export const appIcon = (pkg: string) => `/api/hub/icon?pkg=${encodeURIComponent(pkg)}`;

export const imageExtension = (file: File) => {
  const byType: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  if (byType[file.type]) return byType[file.type];
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext && ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : '';
};

export const buildImageName = (file: File) => {
  const ext = imageExtension(file);
  if (!ext) return '';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const random = Math.random().toString(16).slice(2, 10);
  return `${stamp}_${random}.${ext}`;
};

export const simpleServerWriteHint = 'تأكد أن الهاتف على نفس شبكة التلفزيون، وأن التلفزيون يعرض واجهة TV Hub.';

/**
 * The home TV (TCL) freezes TV Hub while another app is in front, so its phone page does not answer until the TV
 * is back on the TV Hub screen (AUDIT-3 U1).
 */
export const TV_UNREACHABLE = 'تعذر الاتصال بالتلفزيون. تأكد أن الهاتف على نفس الشبكة، وأن التلفزيون يعرض واجهة TV Hub (وليس داخل تطبيق آخر)، ثم أعد المحاولة.';

export const friendlyServerError = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : '';
  if (/^401$/.test(message)) return 'انتهت الجلسة أو تغيّرت كلمة المرور. سجّل الخروج ثم الدخول من جديد.';
  if (error instanceof TypeError) return TV_UNREACHABLE;            // fetch could not reach the TV at all
  return message || fallback;
};

/** GET with the admin password; resolves to `fallback` on any failure. */
export const fetchAuthed = async <T,>(url: string, fallback: T): Promise<T> => {
  try {
    const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
    if (res.status === 401) expired();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
};

/** POST a body with the admin password; throws on refusal. */
export const postAuthed = async (url: string, body: BodyInit): Promise<void> => {
  const res = await fetch(url, { method: 'POST', headers: authHeaders(), body });
  if (res.status === 401) { expired(); throw new Error('401'); }
  const result = (await res.json().catch(() => ({}))) as { ok?: boolean };
  if (!res.ok || !result.ok) throw new Error(`تعذر الحفظ (${res.status})`);
};

/** The TV wants the phone admin password typed again for this action (AUDIT-3 S3). */
export class NeedPassword extends Error {}

/**
 * POST JSON with the session; resolves to the TV's JSON answer (its "error" text is thrown when ok is false).
 * `adminPass`: the phone admin password, for actions the TV confirms with it.
 */
export const postAuthedJson = async <T,>(url: string, payload: unknown, adminPass?: string): Promise<T> => {
  const headers = { ...authHeaders(), 'Content-Type': 'application/json', ...(adminPass ? encodeHeaders({ 'X-Admin-Pass': adminPass }) : {}) };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (res.status === 401) { expired(); throw new Error('401'); }
  const result = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string; needPass?: boolean };
  if (result.needPass) throw new NeedPassword(result.error || 'كلمة المرور مطلوبة');
  if (!res.ok || !result.ok) throw new Error(result.error || `تعذر الحفظ (${res.status})`);
  return result;
};

/**
 * Every picture is redrawn before upload: this drops its metadata (EXIF: GPS position of the photo, camera, date)
 * and scales large photos down to 1920 px. Photos become JPEG; PNG icons stay PNG (transparency).
 * The TV also removes JPEG metadata on its side (ImageMeta.java).
 */
export const prepareImage = (file: File, maxSide = 1920): Promise<File> => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const png = file.type === 'image/png';
    const base = file.name.replace(/\.\w+$/, '');
    c.toBlob((b) => (b ? resolve(new File([b], base + (png ? '.png' : '.jpg'), { type: png ? 'image/png' : 'image/jpeg' }))
      : reject(new Error('تعذر تجهيز الصورة'))), png ? 'image/png' : 'image/jpeg', 0.88);
  };
  // never upload a file we could not redraw: it would keep its metadata
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذر قراءة الصورة')); };
  img.src = url;
});
