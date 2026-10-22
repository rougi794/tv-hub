package com.kidstv.home;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Keeps photos at most MAX px on their long side, so the TV never decodes a 12-megapixel picture for the
 * full-screen view (the kids TV has 2 GB and little free memory right after a cold boot).
 * The EXIF orientation is applied to the pixels (the new JPEG has no EXIF), so the photo stays upright.
 * Only JPEG is scaled; other formats and anything unreadable are left as they are.
 */
final class PhotoScale {
    static final int MAX = 1920;
    private PhotoScale() { }

    static void limit(File f) {
        if (!ImageMeta.isJpeg(f)) return;
        File tmp = new File(f.getParentFile(), "." + f.getName() + ".scaled");
        Bitmap src = null, out = null;
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getPath(), o);
            int w = o.outWidth, h = o.outHeight, longSide = Math.max(w, h);
            if (w <= 0 || h <= 0 || longSide <= MAX) return;
            // decode at a power-of-two reduction while it stays sharp enough (>= 1440 px), then scale the rest
            int sample = 1;
            while (longSide / (sample * 2) >= 1440) sample *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            src = BitmapFactory.decodeFile(f.getPath(), o);
            if (src == null) return;
            float scale = Math.min(1f, MAX / (float) Math.max(src.getWidth(), src.getHeight()));
            Matrix m = orientationMatrix(ImageMeta.orientation(f));
            m.postScale(scale, scale);
            out = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
            try (FileOutputStream fo = new FileOutputStream(tmp)) {
                if (!out.compress(Bitmap.CompressFormat.JPEG, 88, fo)) { tmp.delete(); return; }
            }
            if (tmp.length() > 0 && (tmp.renameTo(f) || (f.delete() && tmp.renameTo(f)))) {
                android.util.Log.i(HomeActivity.TAG, "photo scaled " + w + "x" + h + " -> " + out.getWidth() + "x" + out.getHeight() + ": " + f.getName());
            }
        } catch (Throwable e) {                               // OutOfMemoryError included: keep the original
            android.util.Log.w(HomeActivity.TAG, "photo not scaled: " + f.getName() + " " + e.getClass().getSimpleName());
        } finally {
            tmp.delete();
            if (out != null && out != src) out.recycle();
            if (src != null) src.recycle();
        }
    }

    /** Same mapping as androidx ExifInterface: the transform that shows the photo upright. */
    private static Matrix orientationMatrix(int o) {
        Matrix m = new Matrix();
        switch (o) {
            case 2: m.setScale(-1, 1); break;
            case 3: m.setRotate(180); break;
            case 4: m.setScale(1, -1); break;
            case 5: m.setRotate(90); m.postScale(-1, 1); break;
            case 6: m.setRotate(90); break;
            case 7: m.setRotate(-90); m.postScale(-1, 1); break;
            case 8: m.setRotate(-90); break;
            default: break;
        }
        return m;
    }
}
