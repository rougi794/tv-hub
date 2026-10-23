# مجلد أيقونات التطبيقات

ضع هنا صور الأيقونات المخصصة لعناصر "التطبيقات". الملفات داخل هذا المجلد تُنسخ تلقائياً إلى `dist/icons/` عند تشغيل `npm run build`.

## الاستخدام

في `public/data/quicklinks.json`، أضف حقل `iconUrl` يشير إلى الملف:

```json
{
  "type": "app",
  "label": "YouTube",
  "pkg": "com.google.android.youtube.tv",
  "icon": "youtube",
  "iconUrl": "/icons/youtube.png"
}
```

## التوصيات

- **الصيغة**: PNG شفافة أو SVG.
- **الحجم**: 128×128 بكسل (يُعرض ضمن مربع 40×40 على الواجهة).
- **التسمية**: استخدم نفس قيمة `icon` لتكون متوافقة (مثل `youtube.png`, `shahid.png`).
- **بدون `iconUrl`**: تُستخدم أيقونات `lucide-react` تلقائياً مع ألوان العلامة (Youtube حمراء، Shahid زرقاء، إلخ).

## أمثلة على الأسماء المُستخدَمة حالياً في `quicklinks.json`

- `youtube.png` — YouTube
- `shahid.png` — Shahid
- `aljazeera.png` — الجزيرة
- `playstore.png` — Google Play
- `google.png` — Google
- `matches.png` — مباريات اليوم
