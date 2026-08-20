/**
 * Transfers bitmap ownership to the caller only after the operation succeeds.
 * A bitmap created for a failing route or pipeline is closed at its creation
 * boundary, while successful diagnostic callers remain free to render it.
 */
export async function transferBitmapOnSuccess<T>(
  create: () => Promise<ImageBitmap>,
  operation: (bitmap: ImageBitmap) => Promise<T>,
): Promise<T> {
  const bitmap = await create();
  let transferred = false;
  try {
    const result = await operation(bitmap);
    transferred = true;
    return result;
  } finally {
    if (!transferred) bitmap.close();
  }
}
