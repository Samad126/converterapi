/**
 * The one place ag-psd's runtime is configured.
 *
 * ag-psd needs a canvas implementation registered before it will decode a
 * single pixel, and the obvious reading of that is "install node-canvas". That
 * is not what it needs. The only call it makes into the factory on the path we
 * use is `createImageData(width, height)` for 8-bit RGBA pixels
 * (`createImageDataBitDepth` in ag-psd's reader, `channels === 4`), because
 * that is the one depth it does not build itself. Everything else it allocates
 * directly. A plain object with a `Uint8ClampedArray` in it is a complete
 * substitute, so this service gets PSD support with no native module, no
 * compiler in the image, and nothing to rebuild on a new Node major.
 *
 * Registering a `createCanvas` that THROWS is the point rather than a
 * formality. With `useImageData: true` - which is how this service reads, see
 * `psd-layers.ts` - ag-psd never needs a canvas. Anything that reaches for one
 * is an assumption we got wrong, and a loud failure at that moment is far
 * better than a silently premultiplied image: a canvas stores colour
 * premultiplied by alpha, so round-tripping pixel data through one corrupts
 * every semi-transparent pixel. ag-psd's own documentation recommends
 * `useImageData` for exactly this reason.
 *
 * `initializeCanvas` mutates module-global state, so it must happen exactly
 * once and before any read. Importing this module is what does it; importing
 * `ag-psd` directly anywhere else would bypass it. Both readers and writers
 * come through here (`writePsd` may not need the factory, but it needs the
 * same package, and splitting the import would make the setup easy to miss).
 */
import { initializeCanvas } from 'ag-psd';

initializeCanvas(
  () => {
    throw new Error(
      'ag-psd tried to create a canvas; this service reads PSDs with useImageData and must never need one',
    );
  },
  (width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }),
);

export { readPsd, writePsd } from 'ag-psd';

export type { Layer, Psd } from 'ag-psd';
